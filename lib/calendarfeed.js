// Read-only busy times from one external calendar per organizer. The
// organizer pastes their calendar's own iCal feed (Google Calendar calls it
// the "secret address in iCal format"); this module fetches it, parses the
// VEVENTs and returns the busy intervals of the coming days. Nothing is ever
// written back: this is strictly a read.
//
// The feed address is a secret (anyone with it can read the calendar), so it
// is stored once, never shown in full and never logged.
//
// Parsing covers what Google's feeds actually emit: folded lines, UTC and
// TZID times, all-day events, DURATION, TRANSP, STATUS, RRULE (DAILY, WEEKLY
// with BYDAY, MONTHLY, YEARLY, with INTERVAL, COUNT, UNTIL), EXDATE and
// RECURRENCE-ID overrides. Rarely used rule parts fall back to the first
// occurrence and mark the result approximate — callers say so honestly.
"use strict";

const dns = require("node:dns");
const time = require("./time");

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

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

function ipIsPublic(ip) {
  if (ip.includes(".") && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return false;
    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return false;
    if (low.startsWith("::ffff:")) return ipIsPublic(low.slice(7));
    return true;
  }
  return false;
}

// Refuse to fetch hosts that resolve inside private or link-local space: the
// feed URL is organizer-supplied, and the server must not become a probe of
// its own network. Tests fetch from loopback and pass allowPrivate.
async function assertPublicHost(hostname, allowPrivate) {
  if (allowPrivate) return;
  const addresses = hostname.match(/^\d+\.\d+\.\d+\.\d+$/) || hostname.includes(":")
    ? [{ address: hostname }]
    : await dns.promises.lookup(hostname, { all: true });
  for (const { address } of addresses) {
    if (!ipIsPublic(address)) {
      throw new Error("feed host is not a public address");
    }
  }
}

// Fetch the feed text, following at most a few redirects and re-checking
// every hop's host, so a public URL cannot bounce us into an internal one.
async function fetchFeedText(url, { allowPrivate = false, timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = 3, fetchImpl = fetch } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const target = new URL(current);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("only http and https feeds are fetched");
    }
    await assertPublicHost(target.hostname, allowPrivate);
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/calendar, text/plain, */*" },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (res.body && res.body.cancel) res.body.cancel();
      if (!location) throw new Error(`redirect without a location (http ${res.status})`);
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`the feed server answered http ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_FEED_BYTES) {
      throw new Error("the feed is too large to read");
    }
    return text;
  }
  throw new Error("too many redirects");
}

// --- ICS parsing --------------------------------------------------------------

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
  let current = null;
  for (const line of lines) {
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
  return { calendarName, events };
}

// RRULE: the parts this module expands, plus whether anything unsupported
// showed up (the caller then keeps only the first occurrence and says so).
function parseRrule(value) {
  const rule = { freq: null, interval: 1, count: null, until: null, byday: [], approximate: false };
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
    else if (key === "WKST") { /* week start; our weekly maths aligns on DTSTART's week */ }
    else rule.approximate = true; // BYMONTH, BYSETPOS, ... unsupported
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

// Every candidate date a recurrence rule lands on, in order, each with its
// occurrence index (COUNT counts generated occurrences from DTSTART, so an
// event repeating for years before the window still needs the right index —
// stepping by the rule's own period makes that cheap).
function* ruleCandidates(rule, base, horizonWall) {
  const interval = rule.interval;
  if (rule.freq === "DAILY") {
    for (let k = 0; k <= Math.floor(daysBetween(base, horizonWall) / interval); k++) {
      yield { date: time.addDays(base, k * interval), index: k };
    }
    return;
  }
  if (rule.freq === "WEEKLY") {
    const dows = rule.byday.length
      ? rule.byday.map(parseBydayToken).filter((t) => t && t.ordinal === null).map((t) => t.dow).sort((a, b) => a - b)
      : [time.isoDow(base)];
    const baseWeekStart = time.addDays(base, -(time.isoDow(base) - 1)); // the week's Monday
    const weeks = Math.floor(daysBetween(baseWeekStart, horizonWall) / 7) + 1;
    let counter = 0;
    for (let w = 0; w < weeks; w++) {
      if (w % interval !== 0) continue;
      const weekStart = time.addDays(baseWeekStart, w * 7);
      for (const dow of dows) {
        const date = time.addDays(weekStart, dow - 1);
        if (daysBetween(base, date) < 0) continue; // before DTSTART
        yield { date, index: counter++ };
      }
    }
    return;
  }
  if (rule.freq === "MONTHLY") {
    for (let m = 0; m <= monthsBetween(base, horizonWall); m += interval) {
      if (rule.byday.length) {
        // ordinal BYDAY ("2MO", "-1FR"): the matching days of this month, in
        // date order
        const hits = [];
        const probe = addMonths(base.slice(0, 8) + "01", m);
        if (!probe) continue;
        const [y, mo] = probe.split("-").map(Number);
        const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        for (let day = 1; day <= lastDay; day++) {
          const date = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          if (monthsBetween(base, date) % interval !== 0) continue;
          if (rule.byday.some((token) => {
            const t = parseBydayToken(token);
            if (!t || t.ordinal === null) return false;
            if (t.ordinal < 0) {
              const back = (time.isoDow(`${y}-${String(mo).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`) - t.dow + 7) % 7;
              return day === lastDay - back + (t.ordinal + 1) * 7;
            }
            const firstDow = time.isoDow(`${y}-${String(mo).padStart(2, "0")}-01`);
            return day === 1 + ((t.dow - firstDow + 7) % 7) + (t.ordinal - 1) * 7;
          })) hits.push(date);
        }
        for (const date of hits) yield { date, index: -1 }; // COUNT with ordinal BYDAY is rare; index unused
        continue;
      }
      const date = addMonths(base, m);
      if (date) yield { date, index: m / interval };
    }
    return;
  }
  if (rule.freq === "YEARLY") {
    const baseYear = Number(base.slice(0, 4));
    for (let y = baseYear; y <= Number(horizonWall.slice(0, 4)); y += interval) {
      const date = `${y}-${base.slice(5)}`;
      // Feb 29 in a non-leap year simply does not exist.
      if (time.isoDow(date) && date.slice(5) === base.slice(5)) {
        const [ny, nm, nd] = date.split("-").map(Number);
        const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
        if (nd <= lastDay) yield { date, index: (y - baseYear) / interval };
      }
    }
  }
}

function untilMs(rule, zone) {
  if (!rule.until) return Infinity;
  const resolved = resolveStamp(rule.until, {}, zone);
  return resolved ? resolved.ms + (resolved.allDay ? 24 * 3600 * 1000 - 1 : 0) : Infinity;
}

// Every busy occasion of one event inside the window, as { startMs, endMs }.
function occasionsOf(event, fromMs, toMs, defaultZone) {
  const get = (name) => event.props.find((p) => p.name === name) || null;
  const dtStart = get("DTSTART");
  if (!dtStart) return [];
  const start = resolveStamp(dtStart.value, dtStart.params, defaultZone);
  if (!start) return [];

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

  const status = (get("STATUS") || { value: "" }).value.trim().toUpperCase();
  const transp = (get("TRANSP") || { value: "" }).value.trim().toUpperCase();
  const cancelled = status === "CANCELLED";
  const transparent = transp === "TRANSPARENT";

  // EXDATE: instants to skip (multiple values and multiple lines allowed).
  const exdates = new Set();
  for (const prop of event.props.filter((p) => p.name === "EXDATE")) {
    for (const piece of prop.value.split(",")) {
      const resolved = resolveStamp(piece, prop.params, start.zone);
      if (resolved) exdates.add(resolved.ms);
    }
  }

  const uid = (get("UID") || { value: "" }).value.trim();
  const recurrenceIdProp = get("RECURRENCE-ID");
  const recurrenceId = recurrenceIdProp ? resolveStamp(recurrenceIdProp.value, recurrenceIdProp.params, start.zone) : null;

  // An instance override (RECURRENCE-ID) is not itself an occasion; it
  // replaces or cancels one occurrence of its master.
  const isOverride = Boolean(recurrenceId && uid);
  const result = { occasions: [], approximate: false, isOverride, uid, recurrenceIdMs: recurrenceId ? recurrenceId.ms : null, cancelled };

  // An override with a UID exists only through its master: expanding the
  // master applies it. Emitting it here too would double-count its time.
  if (isOverride) return result;

  const rruleProp = get("RRULE");
  const addOccasion = (startMs, endMs) => {
    if (endMs > startMs) result.occasions.push({ startMs, endMs });
  };

  if (cancelled) return result; // a cancelled event blocks nothing

  if (transparent) return result; // marked "free" in the source calendar

  if (recurrenceIdProp && !uid) {
    // No UID to pair with a master; treat it standalone (busy at its own
    // time), which can only over-block, never silently double-book.
    addOccasion(start.ms, start.ms + durationMs);
    return result;
  }

  if (!rruleProp) {
    addOccasion(start.ms, start.ms + durationMs);
    return result;
  }

  const rule = parseRrule(rruleProp.value);
  // Combinations this module does not expand exactly keep their first
  // occurrence only, and the caller says so.
  if (rule.freq === "WEEKLY" && rule.byday.some((t) => { const p = parseBydayToken(t); return p && p.ordinal !== null; })) rule.approximate = true;
  if (rule.freq === "MONTHLY" && rule.byday.some((t) => { const p = parseBydayToken(t); return p && p.ordinal === null; })) rule.approximate = true;
  if (rule.freq === "MONTHLY" && rule.byday.length && rule.count !== null) rule.approximate = true;
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
  const horizonWall = time.localDate(zone, toMs);
  // Occurrences expand in wall time (so DST keeps the local hour) and are
  // emitted only inside the window; COUNT is honoured by occurrence index.
  for (const { date, index } of ruleCandidates(rule, base, horizonWall)) {
    if (rule.count !== null && index >= rule.count) break;
    const occStart = time.wallMinutesToUtcMs(zone, date, minutes) + secondsMs;
    if (occStart > Math.min(toMs, limit)) break;
    if (occStart >= fromMs && !exdates.has(occStart)) {
      let s = occStart;
      let e = occStart + durationMs;
      const override = uid && event.overrides && event.overrides.get(`${uid}|${occStart}`);
      if (override) {
        if (override.cancelled) s = null; // the instance was cancelled: no busy time
        else { s = override.startMs; e = override.startMs + override.durationMs; }
      }
      if (s !== null) addOccasion(s, e);
    }
  }
  return result;
}

// The whole feed: every event's occasions inside the window, with instance
// overrides applied. Returns { busy: [{startMs, endMs}], approximate, name }.
function busyFromIcs(text, { zone = "UTC", fromMs, toMs }) {
  const parsed = parseIcs(text);
  const events = parsed.events.map((event) => {
    const get = (name) => event.props.find((p) => p.name === name) || null;
    const uid = (get("UID") || { value: "" }).value.trim();
    return { ...event, uid };
  });
  // Attach each instance override to its master so expansion can apply it.
  for (const event of events) {
    const recProp = event.props.find((p) => p.name === "RECURRENCE-ID");
    if (!recProp || !event.uid) continue;
    const master = events.find((e) => e !== event && e.uid === event.uid && e.props.some((p) => p.name === "RRULE"));
    if (!master) continue;
    const rec = resolveStamp(recProp.value, recProp.params, zone);
    if (!rec) continue;
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
    const status = (event.props.find((p) => p.name === "STATUS") || { value: "" }).value.trim().toUpperCase();
    master.overrides = master.overrides || new Map();
    master.overrides.set(`${event.uid}|${rec.ms}`, { startMs: start.ms, durationMs, cancelled: status === "CANCELLED" });
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

// One reader per app. Results are cached per URL so a booking page never
// blocks on a slow provider more than once per maxAge window; failures are
// cached more briefly, so a provider outage shows an honest "check failed"
// without hammering it on every page view.
function createFeedReader(options = {}) {
  const { allowPrivate = false, fetchImpl = fetch, cacheMs = 60000, errorCacheMs = 15000 } = options;
  const cache = new Map(); // url -> { at, result }

  // Returns { ok, busy, checkedAt, approximate, name } or { ok:false, error, checkedAt }.
  async function read(url, maxAgeMs = cacheMs, { zone = "UTC" } = {}) {
    const now = Date.now();
    const cached = cache.get(url);
    if (cached && now - cached.at <= maxAgeMs) return cached.result;
    const horizonFrom = now - 24 * 3600 * 1000;
    const horizonTo = now + 21 * 24 * 3600 * 1000;
    try {
      const text = await fetchFeedText(url, { allowPrivate, fetchImpl });
      const parsed = busyFromIcs(text, { zone, fromMs: horizonFrom, toMs: horizonTo });
      const result = {
        ok: true,
        busy: parsed.busy,
        approximate: parsed.approximate,
        name: parsed.name || "",
        checkedAt: now,
      };
      cache.set(url, { at: now, result });
      return result;
    } catch (err) {
      const result = { ok: false, error: String(err.message || err).slice(0, 200), checkedAt: now };
      cache.set(url, { at: now, result, error: true });
      return result;
    }
  }

  // Cached failure results must not stick: after errorCacheMs the next read
  // tries the provider again.
  return {
    read(url, maxAgeMs, opts) {
      const cached = cache.get(url);
      // A stale failure is retried after the short error window; a read that
      // demands fresh data (maxAge 0, the connect probe) retries immediately.
      if (cached && cached.error && (Date.now() - cached.at > errorCacheMs || maxAgeMs <= 0)) cache.delete(url);
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
};
