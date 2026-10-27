// Time zone helpers on the Node standard library. Everything instants-related is
// milliseconds since the epoch; "wall time" is a local date and minutes-from-midnight
// inside one IANA zone.
"use strict";

const fmtCache = new Map();

function partsFormatter(zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(zone, f);
  }
  return f;
}

// Is this a zone name Intl understands? ("UTC", "Europe/Berlin", "America/New_York", ...)
function isValidZone(zone) {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23" });
    return true;
  } catch {
    return false;
  }
}

// The wall-clock components of an instant inside a zone.
function zoneParts(zone, ms) {
  const o = {};
  for (const p of partsFormatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") o[p.type] = p.value;
  }
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour),
    minute: Number(o.minute),
    second: Number(o.second),
  };
}

// The offset of a zone from UTC, in milliseconds, at a given instant.
function zoneOffsetMs(zone, ms) {
  const p = zoneParts(zone, ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Convert a wall time (a local date plus minutes from local midnight, which may
// exceed 1440 for a window ending at "24:00") in a zone to a UTC instant.
// Two passes of offset lookup handle DST: an ambiguous local time resolves to the
// earlier instant, a skipped local time (spring-forward gap) shifts forward.
function wallMinutesToUtcMs(zone, dateStr, minutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60000;
  let off = zoneOffsetMs(zone, guess);
  let t = guess - off;
  off = zoneOffsetMs(zone, t);
  return guess - off;
}

// The local date ("YYYY-MM-DD") of an instant inside a zone.
function localDate(zone, ms) {
  const p = zoneParts(zone, ms);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ISO weekday of a plain local date: 1 = Monday ... 7 = Sunday. Pure calendar math.
function isoDow(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

// The local date n days after another local date.
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// "HH:MM" -> minutes from midnight. Returns null when malformed.
function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

// Minutes from midnight -> "HH:MM".
function formatMinutes(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// A short, unambiguous label for a zone at an instant, e.g. "UTC+05:30".
function offsetLabel(zone, ms) {
  const off = zoneOffsetMs(zone, ms);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 3600000)).padStart(2, "0")}:${String(Math.floor((a % 3600000) / 60000)).padStart(2, "0")}`;
}

// "2026-11-03 14:00 (Europe/Berlin)" from an instant, for emails and confirmations.
function describeInZone(ms, zone) {
  const p = zoneParts(zone, ms);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const clock = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${date} ${clock} (${zone})`;
}

module.exports = {
  isValidZone,
  zoneParts,
  zoneOffsetMs,
  wallMinutesToUtcMs,
  localDate,
  isoDow,
  addDays,
  parseHm,
  formatMinutes,
  offsetLabel,
  describeInZone,
};
