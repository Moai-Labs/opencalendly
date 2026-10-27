// Availability and slot generation. Availability is per organizer: one event with a
// slot duration and one open window per weekday, in the organizer's time zone.
"use strict";

const time = require("./time");

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]; // index = isoDow - 1

// Slot durations the product offers. Validated on save.
const DURATION_ALLOWED = [15, 20, 30, 45, 60];

// Default availability for a new organizer: Mon-Fri 09:00-17:00 in their zone.
function defaultAvailability() {
  const a = {};
  for (let i = 0; i < 5; i++) a[String(i + 1)] = [{ s: "09:00", e: "17:00" }];
  return a;
}

// Normalize a windows object into { [isoDow]: [{startMin, endMin}] }, dropping
// malformed rows. startMin < endMin <= 1440 (plus 1440 for "24:00").
function normalizeWindows(avail) {
  const out = {};
  if (!avail || typeof avail !== "object") return out;
  for (const key of Object.keys(avail)) {
    const dow = Number(key);
    if (!Number.isInteger(dow) || dow < 1 || dow > 7) continue;
    const windows = [];
    for (const w of avail[key] || []) {
      const s = time.parseHm(w && w.s);
      const e = time.parseHm(w && w.e);
      if (s === null || e === null || e <= s) continue;
      windows.push({ startMin: s, endMin: e });
    }
    if (windows.length) out[dow] = windows;
  }
  return out;
}

// The open slots for one local date in the organizer's zone, before subtracting
// bookings. Each slot is { startMs, endMs }. Windows shorter than the slot
// duration produce no slots; slots are aligned to each window's start.
function slotsForDate(organizer, dateStr, nowMs) {
  const windows = normalizeWindows(organizer.event.availability)[time.isoDow(dateStr)] || [];
  const durationMs = organizer.event.durationMinutes * 60000;
  const zone = organizer.timezone;
  const slots = [];
  for (const w of windows) {
    const start0 = time.wallMinutesToUtcMs(zone, dateStr, w.startMin);
    const end = time.wallMinutesToUtcMs(zone, dateStr, w.endMin);
    for (let s = start0; s + durationMs <= end; s += durationMs) {
      slots.push({ startMs: s, endMs: s + durationMs });
    }
  }
  slots.sort((a, b) => a.startMs - b.startMs);
  return slots;
}

// Bookings that still hold their slot: cancelled ones do not.
function holdingBookings(organizer, bookings) {
  return bookings.filter(
    (b) =>
      b.organizerId === organizer.id &&
      b.status !== "cancelled" &&
      b.startMs + b.endMs > 0
  );
}

// Open slots across the next `days` days, minus bookings and past slots.
// Returns [{ date, slots: [{ startMs, endMs }] }] with only non-empty days kept.
function openSlots(organizer, bookings, nowMs, days = 14) {
  const zone = organizer.timezone;
  const first = time.localDate(zone, nowMs);
  const active = holdingBookings(organizer, bookings);
  const result = [];
  for (let i = 0; i < days; i++) {
    const dateStr = time.addDays(first, i);
    const daySlots = slotsForDate(organizer, dateStr, nowMs).filter(
      (slot) =>
        slot.endMs > nowMs &&
        !active.some((b) => b.startMs < slot.endMs && slot.startMs < b.endMs)
    );
    if (daySlots.length) result.push({ date: dateStr, slots: daySlots });
  }
  return result;
}

// Is `startMs` exactly a generated, still-open slot for this organizer?
// This is the cheap pre-check before the authoritative conflict test under the
// store lock; it guards against fabricated slot values.
function isRealOpenSlot(organizer, bookings, startMs, nowMs) {
  const zone = organizer.timezone;
  const dateStr = time.localDate(zone, startMs);
  const candidate = slotsForDate(organizer, dateStr, nowMs).find((s) => s.startMs === startMs);
  if (!candidate) return false;
  return !holdingBookings(organizer, bookings).some(
    (b) => b.startMs < candidate.endMs && candidate.startMs < b.endMs
  );
}

module.exports = { DAY_NAMES, DURATION_ALLOWED, defaultAvailability, normalizeWindows, slotsForDate, openSlots, isRealOpenSlot };
