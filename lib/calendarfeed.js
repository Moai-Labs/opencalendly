// Read-only busy times from one external calendar per organizer. The
// organizer pastes their calendar's own iCal feed (Google Calendar calls it
// the "secret address in iCal format"); this module fetches it, parses the
// VEVENTs and returns the busy intervals of the coming days. Nothing is ever
// written back: this is strictly a read.
//
// The feed address is a secret (anyone with it can read the calendar), so it
// is stored once, never shown in full and never logged.
//
// Fetching is hardened because the address is organizer-supplied: hosts are
// resolved to addresses first, every address is checked against private
// network space (IPv4 and IPv6 literals, including IPv4-mapped forms), and
// the connection is then made to exactly those validated addresses — DNS
// cannot be rebound between validation and connection. Every redirect hop is
// re-resolved and re-checked, and the body is counted as it streams so an
// oversized feed is cut off instead of buffered.
//
// Parsing covers what Google's feeds actually emit: folded lines, UTC and
// TZID times, all-day events, DURATION, TRANSP, STATUS, RRULE (DAILY, WEEKLY
// with BYDAY and WKST, MONTHLY plain and BYDAY, YEARLY, with INTERVAL, COUNT,
// UNTIL), EXDATE and RECURRENCE-ID overrides. Occurrences are selected by
// overlap with the window, not by start time, so multi-day events and moved
// instances still show. Expansion is bounded both by jumping to the window
// where every period yields a candidate and by a hard step budget: a rule
// that would outgrow the budget stops and marks the result approximate
// instead of monopolizing the server. Rarely-used rule parts keep only the
// first occurrence and mark the result approximate — callers say so honestly.
"use strict";

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const time = require("./time");

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
// A single event may consume at most this many expansion steps; beyond it the
// result is marked approximate rather than blocking the server's event loop.
const MAX_RULE_STEPS = 200000;

// --- feed URLs ---------------------------------------------------------------

// Is this something we are willing to fetch? Absolute http(s) URL, no
// embedded credentials, bounded length. The host check against private
// addresses happens at fetch time (DNS may resolve differently).
function feedUrlIsValid(raw) {
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (text.length === 0 || text.length > 2000) return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  return true;
}

// The feed URL is a secret, so the dashboard shows the host only.
function maskedFeedUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    return `${url.protocol}//${url.host}/…`;
  } catch {
    return "(calendar feed)";
  }
}

// --- address classification ----------------------------------------------------

// A dotted-quad IPv4 address in canonical decimal form, as octets, or null.
// Anything else — octal or hexadecimal pieces, wrong arity, values over 255 —
// fails closed: we do not classify what we cannot read.
function parseIpv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  if (parts.some((n, i) => String(n) !== m[i + 1])) return null; // "010.0.0.1" is not canonical
  return parts;
}

function ipv4IsPublic(parts) {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false; // this-host, private, loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast and reserved
  return true;
}

// An IPv6 address as eight 16-bit groups, or null. Accepts the bracketed form
// a URL hostname gives ("[::1]"), a zone suffix ("fe80::1%eth0"), and an
// embedded IPv4 tail ("::ffff:1.2.3.4").
function parseIpv6(host) {
  let s = String(host || "").trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");
  if (pct !== -1) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  const tailV4 = parseIpv4(tail);
  if (tailV4) {
    const hi = ((tailV4[0] << 8) | tailV4[1]).toString(16);
    const lo = ((tailV4[2] << 8) | tailV4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - back.length;
  if (fill < 0) return null;
  const groups = [];
  for (const g of [...head, ...Array(fill).fill("0"), ...back]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

function ipv4OfTail(g) {
  return [(g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff, g[7] & 0xff];
}

function ipv6IsPublic(g) {
  if (g.every((n) => n === 0)) return false; // "::" unspecified
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff) return ipv4IsPublic(ipv4OfTail(g)); // IPv4-mapped
    if (g[5] === 0) return ipv4IsPublic(ipv4OfTail(g)); // IPv4-compatible (deprecated); covers "::1"
  }
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ipv4IsPublic(ipv4OfTail(g)); // NAT64 translation of an IPv4 address
  }
  if (g[0] === 0x2002) {
    return ipv4IsPublic([(g[1] >> 8) & 0xff, g[1] & 0xff, (g[2] >> 8) & 0xff, g[2] & 0xff]); // 6to4-embedded
  }
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation range
  return true;
}

// True only for addresses we are willing to connect to. Unclassifiable input
// is treated as not public.
function ipIsPublic(ip) {
  const v4 = parseIpv4(ip);
  if (v4) return ipv4IsPublic(v4);
  const v6 = parseIpv6(ip);
  if (v6) return ipv6IsPublic(v6);
  return false;
}

// Resolve a URL hostname to the addresses we are willing to connect to. IP
// literals are classified directly (a URL's hostname keeps brackets around
// IPv6, and may hide an IPv4 inside a mapped form); names go through DNS and
// every returned address is checked. The fetcher only ever connects to
// addresses this function returned, so DNS cannot be rebound between
// validation and connection. Tests inject `lookupImpl`.
async function resolveFeedHost(hostname, { allowPrivate = false, lookupImpl } = {}) {
  let host = String(hostname || "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  host = host.split("%")[0];
  if (parseIpv4(host) || parseIpv6(host)) {
    if (!allowPrivate && !ipIsPublic(host)) throw new Error("feed host is not a public address");
    return [host];
  }
  const lookup = lookupImpl || dns.promises.lookup;
  const found = await lookup(host, { all: true });
  const addresses = (Array.isArray(found) ? found : [found]).map((r) => r && r.address).filter(Boolean);
  if (!addresses.length) throw new Error("feed host could not be resolved");
  if (!allowPrivate) {
    for (const address of addresses) {
      if (!ipIsPublic(address)) throw new Error("feed host is not a public address");
    }
  }
  return addresses;
}

// --- fetching ------------------------------------------------------------------

// One HTTP exchange against one already-validated address. Resolves
// { text } for a readable 2xx body or { redirect } for a redirect; throws
// otherwise. The connection goes to `address` — no second DNS lookup — while
// TLS still verifies the hostname through `servername`. Body bytes are
// counted as they arrive and the exchange is cut off past MAX_FEED_BYTES.
function requestAt(target, address, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      req.destroy();
      fail(new Error("the feed server did not answer in time"));
    }, timeoutMs);
    const fail = (err) => {
      err.connectionLevel = true; // another validated address may be tried
      finish(err);
    };
    const req = mod.request(
      {
        host: address,
        port: target.port ? Number(target.port) : isHttps ? 443 : 80,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        servername: isHttps ? target.hostname.replace(/^\[/, "").replace(/\]$/, "") : undefined,
        headers: {
          host: target.host,
          accept: "text/calendar, text/plain, */*",
          "user-agent": "OpenCalendly feed reader (read-only)",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = res.headers.location;
          res.resume(); // drain and discard the redirect body
          if (!location) return finish(new Error(`redirect without a location (http ${status})`));
          let next;
          try {
            next = new URL(location, target).href;
          } catch {
            return finish(new Error("the feed server redirected to an invalid address"));
          }
          return finish(null, { redirect: next });
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return finish(new Error(`the feed server answered http ${status}`));
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_FEED_BYTES) {
            res.destroy();
            return finish(new Error("the feed is too large to read"));
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(null, { text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => fail(err));
      }
    );
    req.on("error", (err) => fail(err));
    req.end();
  });
}

// Try the exchange against each validated address in turn; a connection-level
// failure moves to the next address, a protocol answer does not.
async function requestVia(target, addresses, timeoutMs) {
  let last;
  for (const address of addresses) {
    try {
      return await requestAt(target, address, timeoutMs);
    } catch (err) {
      last = err;
      if (!err || !err.connectionLevel) throw err;
    }
  }
  throw last;
}

// Fetch the feed text: resolve and check the host, connect to a validated
// address, and follow at most a few redirects — every hop is resolved and
// re-checked, so a public URL cannot bounce us into an internal one.
async function fetchFeedText(urlString, opts = {}) {
  const { allowPrivate = false, timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = 3, lookupImpl } = opts;
  let current = String(urlString || "");
  for (let hop = 0; ; hop++) {
    if (hop > maxRedirects) throw new Error("too many redirects");
    let target;
    try {
      target = new URL(current);
    } catch {
      throw new Error("that feed address is not a valid URL");
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("only http and https feeds are fetched");
    }
    if (target.username || target.password) {
      throw new Error("feed addresses with embedded credentials are not fetched");
    }
    const addresses = await resolveFeedHost(target.hostname, { allowPrivate, lookupImpl });
    const out = await requestVia(target, addresses, timeoutMs);
    if (out.redirect) {
      current = out.redirect;
      continue;
    }
    return out.text;
  }
}

// --- ICS parsing ---------------------------------------------------------------

// RFC 5545 line folding: a CRLF followed by a space or tab continues the
// previous line.
function unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

// One property: NAME;PARAM=VALUE;...:value. The split at ":" and ";" respects
// quoted parameter values (a TZID may legally contain either).
function parseProp(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) { colon = i; break; }
  }
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = [];
  let current = "";
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ";" && !inQuotes) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  const name = parts.shift().trim().toUpperCase();
  if (!name) return null;
  const params = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

// Resolve one iCal date or date-time to a concrete instant. Returns
// { ms, allDay, wall: { dateStr, minutes, seconds }, zone } — wall time kept
// because recurring events expand in wall time, not instants. A floating
// time (no TZID, no Z) belongs to the calendar owner, for whom the
// organizer's zone is the best stand-in we have.
function resolveStamp(value, params, defaultZone) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(String(value || "").trim());
  if (!m) return null;
  const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) {
    // VALUE=DATE (or a bare date): an all-day event, from local midnight.
    const zone = time.isValidZone(defaultZone) ? defaultZone : "UTC";
    return { ms: time.wallMinutesToUtcMs(zone, dateStr, 0), allDay: true, wall: { dateStr, minutes: 0, seconds: 0 }, zone };
  }
  const minutes = Number(m[4]) * 60 + Number(m[5]);
  const seconds = Number(m[6]);
  if (m[7] === "Z") {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), seconds);
    return { ms, allDay: false, wall: { dateStr, minutes, seconds }, zone: "UTC" };
  }
  const zone = params.TZID && time.isValidZone(params.TZID) ? params.TZID : (time.isValidZone(defaultZone) ? defaultZone : "UTC");
  return { ms: time.wallMinutesToUtcMs(zone, dateStr, minutes) + seconds * 1000, allDay: false, wall: { dateStr, minutes, seconds }, zone };
}

// ISO 8601 duration as used by DURATION: P1D, PT1H30M, P2DT3H, PT45M...
function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value || "").trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const [, , w, d, h, min, s] = m;
  const ms = ((Number(w) || 0) * 7 * 86400 + (Number(d) || 0) * 86400 + (Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0)) * 1000;
  return sign * ms;
}

function parseIcs(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let calendarName = null;
  let sawCalendar = false;
  let current = null;
  for (const line of lines) {
    if (/^BEGIN:VCALENDAR$/i.test(line.trim())) sawCalendar = true;
    if (line === "BEGIN:VEVENT") {
      current = { props: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) {
      if (calendarName === null && /^X-WR-CALNAME/i.test(line)) {
        const prop = parseProp(line);
        if (prop) calendarName = prop.value.replace(/\\n/g, " ").replace(/\\,/g, ",").trim();
      }
      continue;
    }
    const prop = parseProp(line);
    if (prop) current.props.push(prop);
  }
  return { calendarName, events, sawCalendar };
}

// RRULE: the parts this module expands, plus whether anything unsupported
// showed up (the caller then keeps only the first occurrence and says so).
function parseRrule(value) {
  const rule = { freq: null, interval: 1, count: null, until: null, byday: [], wkst: 1, approximate: false };
  for (const part of String(value || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const val = part.slice(eq + 1).trim().toUpperCase();
    if (key === "FREQ") rule.freq = val;
    else if (key === "INTERVAL") rule.interval = Math.max(1, Number(val) || 1);
    else if (key === "COUNT") rule.count = Math.max(1, Number(val) || 1);
    else if (key === "UNTIL") rule.until = val;
    else if (key === "BYDAY") rule.byday = val.split(",").map((d) => d.trim()).filter(Boolean);
    else if (key === "WKST") {
      const t = parseBydayToken(val);
      if (t && t.ordinal === null) rule.wkst = t.dow;
    } else rule.approximate = true; // BYMONTH, BYSETPOS, ... unsupported
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) rule.approximate = true;
  return rule;
}

const BYDAY_DOW = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
function parseBydayToken(token) {
  // plain "MO" or ordinal "2MO" / "-1FR"
  const m = /^(-?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
  if (!m) return null;
  return { ordinal: m[1] ? Number(m[1]) : null, dow: BYDAY_DOW[m[2]] };
}

function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(toDate + "T00:00:00Z") - Date.parse(fromDate + "T00:00:00Z")) / 86400000);
}

function monthsBetween(fromDate, toDate) {
  return (Number(toDate.slice(0, 4)) - Number(fromDate.slice(0, 4))) * 12 + (Number(toDate.slice(5, 7)) - Number(fromDate.slice(5, 7)));
}

// The date `n` months after another date, or null when the month has no such
// day (January 31 + 1 month in a non-leap year, say).
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  if (d > lastDay) return null;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const pad2 = (n) => String(n).padStart(2, "0");

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Every candidate date a recurrence rule lands on, in order, each with its
// occurrence index. COUNT counts the occurrences the rule actually generates
// from DTSTART — months and years without the day (Feb 29th) do not count —
// so the index is kept over generated occurrences only, including those the
// window skips. Where every period yields exactly one candidate (plain DAILY,
// plain WEEKLY with no COUNT) the generator jumps to the window instead of
// walking from an old DTSTART; everywhere else the step budget bounds the
// work and, when it is exhausted, sets budget.limited so the caller can
// honestly mark the result approximate.
function* ruleCandidates(rule, base, fromWall, horizonWall, budget = { steps: 0 }) {
  const step = () => {
    if (++budget.steps > MAX_RULE_STEPS) {
      budget.limited = true;
      return false;
    }
    return true;
  };
  const interval = rule.interval;
  const hitsOf = rule.byday.map(parseBydayToken).filter(Boolean);

  if (rule.freq === "DAILY") {
    const dows = hitsOf.length && hitsOf.every((t) => t.ordinal === null) ? new Set(hitsOf.map((t) => t.dow)) : null;
    if (rule.byday.length && !dows) return; // ordinal tokens are meaningless for DAILY
    const span = Math.max(0, daysBetween(base, horizonWall));
    // Without BYDAY every period yields exactly one occurrence, so with no
    // COUNT the walk can start at the window; with COUNT the index must stay
    // absolute, which k already is.
    const k0 = dows || rule.count !== null ? 0 : Math.max(0, Math.floor(daysBetween(base, fromWall) / interval));
    let counter = 0;
    for (let k = k0; k * interval <= span; k++) {
      if (!step()) return;
      const date = time.addDays(base, k * interval);
      if (dows && !dows.has(time.isoDow(date))) continue;
      if (rule.count !== null && counter >= rule.count) return;
      if (date >= fromWall) yield { date, index: counter };
      counter++;
    }
    return;
  }

  if (rule.freq === "WEEKLY") {
    const dows = (hitsOf.length ? hitsOf.filter((t) => t.ordinal === null).map((t) => t.dow) : [time.isoDow(base)]).sort((a, b) => a - b);
    if (!dows.length) return;
    // The week's first day, per WKST: interval alignment and which days sit in
    // the same week both follow the week start the rule names (Monday only by
    // default).
    const baseWeekStart = time.addDays(base, -((time.isoDow(base) - rule.wkst + 7) % 7));
    const weeks = Math.floor(daysBetween(baseWeekStart, horizonWall) / 7) + 1;
    let counter = 0;
    for (let w = 0; w < weeks; w++) {
      if (!step()) return;
      if (w % interval !== 0) continue;
      const weekStart = time.addDays(baseWeekStart, w * 7);
      for (const dow of dows) {
        // Days sit in the WKST's week: Sunday lives at offset 0 of a
        // Sunday-anchored week, not six days in.
        const date = time.addDays(weekStart, (dow - rule.wkst + 7) % 7);
        if (daysBetween(base, date) < 0) continue; // before DTSTART
        if (rule.count !== null && counter >= rule.count) return;
        if (date >= fromWall) yield { date, index: counter };
        counter++;
      }
    }
    return;
  }

  if (rule.freq === "MONTHLY") {
    const lastMonth = Math.max(0, monthsBetween(base, horizonWall));
    let counter = 0;
    for (let m = 0; m <= lastMonth; m += interval) {
      if (!step()) return;
      const [by, bm] = [Number(base.slice(0, 4)), Number(base.slice(5, 7))];
      const total = by * 12 + (bm - 1) + m;
      const y = Math.floor(total / 12);
      const mo = (total % 12) + 1;
      const ym = `${y}-${pad2(mo)}`;
      const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const hits = new Set();
      for (const t of hitsOf) {
        if (t.ordinal === null) {
          // a plain weekday in MONTHLY: every matching day of the month
          for (let day = 1; day <= lastDay; day++) {
            if (!step()) return;
            const date = `${ym}-${pad2(day)}`;
            if (time.isoDow(date) === t.dow) hits.add(date);
          }
        } else if (t.ordinal < 0) {
          const back = (time.isoDow(`${ym}-${pad2(lastDay)}`) - t.dow + 7) % 7;
          const day = lastDay - back + (t.ordinal + 1) * 7;
          if (day >= 1 && day <= lastDay) hits.add(`${ym}-${pad2(day)}`);
        } else {
          const day = 1 + ((t.dow - time.isoDow(`${ym}-01`) + 7) % 7) + (t.ordinal - 1) * 7;
          if (day >= 1 && day <= lastDay) hits.add(`${ym}-${pad2(day)}`);
        }
      }
      if (!hitsOf.length) {
        const date = addMonths(base, m);
        if (date) hits.add(date); // a month without the day (Jan 31 + Feb) yields nothing
      }
      for (const date of [...hits].sort()) {
        if (daysBetween(base, date) < 0) continue; // never before DTSTART
        if (rule.count !== null && counter >= rule.count) return;
        if (date >= fromWall) yield { date, index: counter };
        counter++;
      }
    }
    return;
  }

  if (rule.freq === "YEARLY") {
    const baseYear = Number(base.slice(0, 4));
    const monthDay = base.slice(5);
    let counter = 0;
    for (let y = baseYear; y <= Number(horizonWall.slice(0, 4)); y++) {
      if (!step()) return;
      if ((y - baseYear) % interval !== 0) continue;
      if (monthDay === "02-29" && !isLeapYear(y)) continue; // the day does not exist: not an occurrence
      const date = `${y}-${monthDay}`;
      if (rule.count !== null && counter >= rule.count) return;
      if (date >= fromWall) yield { date, index: counter };
      counter++;
    }
  }
}

function untilMs(rule, zone) {
  if (!rule.until) return Infinity;
  const resolved = resolveStamp(rule.until, {}, zone);
  return resolved ? resolved.ms + (resolved.allDay ? 24 * 3600 * 1000 - 1 : 0) : Infinity;
}

// Every busy occasion of one event inside the window, as { startMs, endMs }.
// Always returns the result object — never a bare array — so callers can
// spread `occasions` on every path.
function occasionsOf(event, fromMs, toMs, defaultZone) {
  const get = (name) => event.props.find((p) => p.name === name) || null;
  const uid = (get("UID") || { value: "" }).value.trim();
  const recurrenceIdProp = get("RECURRENCE-ID");
  const recurrenceId = recurrenceIdProp ? resolveStamp(recurrenceIdProp.value, recurrenceIdProp.params, defaultZone) : null;
  const status = (get("STATUS") || { value: "" }).value.trim().toUpperCase();
  const result = {
    occasions: [],
    approximate: false,
    isOverride: Boolean(recurrenceId && uid),
    uid,
    recurrenceIdMs: recurrenceId ? recurrenceId.ms : null,
    cancelled: status === "CANCELLED",
  };
  const dtStart = get("DTSTART");
  if (!dtStart) return result; // no start: no busy time (a cancelled instance may omit DTSTART)
  const start = resolveStamp(dtStart.value, dtStart.params, defaultZone);
  if (!start) return result;

  // Duration: DTEND wins, then DURATION, then the RFC defaults (all day =
  // one day; a timed event with neither has zero length and blocks nothing).
  let durationMs = 0;
  const dtEnd = get("DTEND");
  const durationProp = get("DURATION");
  if (dtEnd) {
    const end = resolveStamp(dtEnd.value, dtEnd.params, start.zone);
    if (end) durationMs = Math.max(0, end.ms - start.ms);
  } else if (durationProp) {
    const d = parseDuration(durationProp.value);
    if (d !== null && d > 0) durationMs = d;
  } else if (start.allDay) {
    durationMs = 24 * 3600 * 1000;
  }

  const transp = (get("TRANSP") || { value: "" }).value.trim().toUpperCase();
  const transparent = transp === "TRANSPARENT";

  // EXDATE: instants to skip (multiple values and multiple lines allowed).
  const exdates = new Set();
  for (const prop of event.props.filter((p) => p.name === "EXDATE")) {
    for (const piece of prop.value.split(",")) {
      const resolved = resolveStamp(piece, prop.params, start.zone);
      if (resolved) exdates.add(resolved.ms);
    }
  }

  // An instance override (RECURRENCE-ID) is not itself an occasion; it
  // replaces or cancels one occurrence of its master.
  if (result.isOverride) return result;

  const addOccasion = (startMs, endMs) => {
    if (endMs > startMs) result.occasions.push({ startMs, endMs });
  };

  if (result.cancelled) return result; // a cancelled event blocks nothing

  if (transparent) return result; // marked "free" in the source calendar

  if (recurrenceIdProp && !uid) {
    // No UID to pair with a master; treat it standalone (busy at its own
    // time), which can only over-block, never silently double-book.
    addOccasion(start.ms, start.ms + durationMs);
    return result;
  }

  if (!get("RRULE")) {
    addOccasion(start.ms, start.ms + durationMs);
    return result;
  }

  const rule = parseRrule(get("RRULE").value);
  // Combinations this module does not expand exactly keep their first
  // occurrence only, and the caller says so.
  if (rule.freq === "WEEKLY" && rule.byday.some((t) => { const p = parseBydayToken(t); return p && p.ordinal !== null; })) rule.approximate = true;
  if (rule.freq === "YEARLY" && rule.byday.length) rule.approximate = true; // weekday-of-year rules
  result.approximate = rule.approximate;
  if (rule.approximate) {
    // Keep the first occurrence only — and let the caller say so.
    addOccasion(start.ms, start.ms + durationMs);
    return result;
  }

  const zone = start.zone;
  const limit = untilMs(rule, zone);
  const base = start.wall.dateStr;
  const minutes = start.wall.minutes;
  const secondsMs = (start.wall.seconds || 0) * 1000;
  // Candidates expand in wall time; the window's wall dates carry a two-day
  // margin so a zone offset or a multi-day occurrence cannot fall between.
  const fromWall = time.addDays(time.localDate(zone, fromMs), -2);
  const horizonWall = time.localDate(zone, toMs + 2 * 86400000);
  const budget = { steps: 0 };
  const applied = new Set(); // occurrence starts whose override was applied

  for (const { date, index } of ruleCandidates(rule, base, fromWall, horizonWall, budget)) {
    if (rule.count !== null && index >= rule.count) break;
    const occStart = time.wallMinutesToUtcMs(zone, date, minutes) + secondsMs;
    if (occStart > Math.min(toMs, limit)) break;
    if (exdates.has(occStart)) continue;
    // Occurrences are selected by overlap with the window, not by start time:
    // a multi-day occurrence that began before the window is still busy in it.
    const occEnd = occStart + durationMs;
    const override = event.overrides && event.overrides.get(`${uid}|${occStart}`);
    if (override) {
      applied.add(occStart);
      if (!override.cancelled && override.startMs + override.durationMs > fromMs && override.startMs < toMs) {
        addOccasion(override.startMs, override.startMs + override.durationMs);
      }
    } else if (occEnd > fromMs && occStart < toMs) {
      addOccasion(occStart, occEnd);
    }
  }
  // Overrides whose original occurrence was never enumerated above — it lay
  // outside the window — but whose moved time is busy inside it.
  if (event.overrides) {
    for (const [key, override] of event.overrides) {
      if (override.cancelled) continue;
      const occStart = Number(key.slice(uid.length + 1));
      if (applied.has(occStart)) continue;
      if (override.startMs + override.durationMs > fromMs && override.startMs < toMs) {
        addOccasion(override.startMs, override.startMs + override.durationMs);
      }
    }
  }
  if (budget.limited) result.approximate = true;
  return result;
}

// The whole feed: every event's occasions inside the window, with instance
// overrides applied. Returns { busy: [{startMs, endMs}], approximate, name }.
// Text without a VCALENDAR envelope (an HTML error page, say) throws, so a
// failed read is never mistaken for a successfully parsed empty calendar.
function busyFromIcs(text, { zone = "UTC", fromMs, toMs }) {
  const parsed = parseIcs(text);
  if (!parsed.sawCalendar) throw new Error("this is not an iCalendar feed");
  const events = parsed.events.map((event) => {
    const get = (name) => event.props.find((p) => p.name === name) || null;
    const uid = (get("UID") || { value: "" }).value.trim();
    return { ...event, uid };
  });
  // Attach each instance override to its master so expansion can apply it.
  // A cancelled instance may omit DTSTART entirely (RFC 5545): the
  // RECURRENCE-ID alone says which occurrence dies.
  for (const event of events) {
    const recProp = event.props.find((p) => p.name === "RECURRENCE-ID");
    if (!recProp || !event.uid) continue;
    const master = events.find((e) => e !== event && e.uid === event.uid && e.props.some((p) => p.name === "RRULE"));
    if (!master) continue;
    const rec = resolveStamp(recProp.value, recProp.params, zone);
    if (!rec) continue;
    const status = (event.props.find((p) => p.name === "STATUS") || { value: "" }).value.trim().toUpperCase();
    if (status === "CANCELLED") {
      master.overrides = master.overrides || new Map();
      master.overrides.set(`${event.uid}|${rec.ms}`, { startMs: rec.ms, durationMs: 0, cancelled: true });
      continue;
    }
    const startProp = event.props.find((p) => p.name === "DTSTART");
    const start = startProp ? resolveStamp(startProp.value, startProp.params, zone) : null;
    if (!start) continue;
    let durationMs = 0;
    const endProp = event.props.find((p) => p.name === "DTEND");
    const durationProp = event.props.find((p) => p.name === "DURATION");
    if (endProp) {
      const end = resolveStamp(endProp.value, endProp.params, zone);
      if (end) durationMs = Math.max(0, end.ms - start.ms);
    } else if (durationProp) {
      const d = parseDuration(durationProp.value);
      if (d !== null && d > 0) durationMs = d;
    } else if (start.allDay) {
      durationMs = 24 * 3600 * 1000;
    }
    master.overrides = master.overrides || new Map();
    master.overrides.set(`${event.uid}|${rec.ms}`, { startMs: start.ms, durationMs, cancelled: false });
  }

  const busy = [];
  let approximate = false;
  for (const event of events) {
    const res = occasionsOf(event, fromMs, toMs, zone);
    if (res.approximate) approximate = true;
    busy.push(...res.occasions);
  }
  const inWindow = busy.filter((b) => b.endMs > fromMs && b.startMs < toMs);
  inWindow.sort((a, b) => a.startMs - b.startMs);
  return { busy: inWindow, approximate, name: parsed.calendarName };
}

// --- cached reading -----------------------------------------------------------

// One reader per app. Results are cached per URL *and* per parsing zone, so
// two organizers on one feed (or one organizer who changes zone) never
// receive intervals computed in another zone; failures are cached more
// briefly, so a provider outage shows an honest "check failed" without
// hammering it on every page view.
function createFeedReader(options = {}) {
  const { allowPrivate = false, readFeed = fetchFeedText, cacheMs = 60000, errorCacheMs = 15000 } = options;
  const cache = new Map(); // "url|zone" -> { at, result }

  // Returns { ok, busy, checkedAt, approximate, name } or { ok:false, error, checkedAt }.
  async function read(url, maxAgeMs = cacheMs, { zone = "UTC" } = {}) {
    const now = Date.now();
    const key = `${url}|${time.isValidZone(zone) ? zone : "UTC"}`;
    const cached = cache.get(key);
    // Strictly younger: a maxAge of 0 always refetches.
    if (cached && now - cached.at < maxAgeMs) return cached.result;
    const horizonFrom = now - 24 * 3600 * 1000;
    const horizonTo = now + 21 * 24 * 3600 * 1000;
    try {
      const text = await readFeed(url, { allowPrivate });
      const parsed = busyFromIcs(text, { zone, fromMs: horizonFrom, toMs: horizonTo });
      const result = {
        ok: true,
        busy: parsed.busy,
        approximate: parsed.approximate,
        name: parsed.name || "",
        checkedAt: now,
      };
      cache.set(key, { at: now, result });
      return result;
    } catch (err) {
      const result = { ok: false, error: String(err.message || err).slice(0, 200), checkedAt: now };
      cache.set(key, { at: now, result, error: true });
      return result;
    }
  }

  // Cached failure results must not stick: after errorCacheMs the next read
  // tries the provider again.
  return {
    read(url, maxAgeMs, opts) {
      const zone = opts && opts.zone ? opts.zone : "UTC";
      const key = `${url}|${time.isValidZone(zone) ? zone : "UTC"}`;
      const cached = cache.get(key);
      // A stale failure is retried after the short error window; a read that
      // demands fresh data (maxAge 0, the connect probe) retries immediately.
      if (cached && cached.error && (Date.now() - cached.at > errorCacheMs || maxAgeMs <= 0)) cache.delete(key);
      return read(url, maxAgeMs, opts);
    },
    clear() {
      cache.clear();
    },
  };
}

module.exports = {
  feedUrlIsValid,
  maskedFeedUrl,
  fetchFeedText,
  parseIcs,
  busyFromIcs,
  createFeedReader,
  ipIsPublic,
  resolveFeedHost,
};
