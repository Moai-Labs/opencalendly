"use strict";

const test = require("node:test");
const assert = require("node:assert");
const slots = require("../lib/slots");

function organizer(overrides = {}) {
  return {
    id: "org1",
    timezone: "UTC",
    event: {
      name: "30 minute meeting",
      durationMinutes: 30,
      availability: {
        "1": [{ s: "09:00", e: "17:00" }],
        "2": [{ s: "09:00", e: "17:00" }],
        "3": [{ s: "09:00", e: "17:00" }],
        "4": [{ s: "09:00", e: "17:00" }],
        "5": [{ s: "09:00", e: "17:00" }],
      },
    },
    ...overrides,
  };
}

test("slotsForDate generates duration-aligned slots inside the window", () => {
  const org = organizer({ timezone: "America/New_York", event: { name: "x", durationMinutes: 60, availability: { "3": [{ s: "09:00", e: "17:00" }] } } });
  const slotsOut = slots.slotsForDate(org, "2026-07-08"); // a Wednesday, all EDT (UTC-4)
  assert.strictEqual(slotsOut.length, 8);
  assert.strictEqual(slotsOut[0].startMs, Date.UTC(2026, 6, 8, 13, 0)); // 09:00 EDT
  assert.strictEqual(slotsOut[7].startMs, Date.UTC(2026, 6, 8, 20, 0)); // 16:00 EDT
  for (const s of slotsOut) assert.strictEqual(s.endMs - s.startMs, 60 * 60000);
});

test("slotsForDate leaves the window closed when it has no slots", () => {
  const org = organizer({ timezone: "UTC", event: { name: "x", durationMinutes: 60, availability: { "3": [{ s: "09:00", e: "11:30" }] } } });
  const slotsOut = slots.slotsForDate(org, "2026-07-08");
  assert.deepStrictEqual(
    slotsOut.map((s) => new Date(s.startMs).toISOString()),
    ["2026-07-08T09:00:00.000Z", "2026-07-08T10:00:00.000Z"]
  );
});

test("slotsForDate supports windows ending at 24:00", () => {
  const org = organizer({ timezone: "UTC", event: { name: "x", durationMinutes: 60, availability: { "3": [{ s: "22:00", e: "24:00" }] } } });
  const slotsOut = slots.slotsForDate(org, "2026-07-08");
  assert.deepStrictEqual(
    slotsOut.map((s) => new Date(s.startMs).toISOString()),
    ["2026-07-08T22:00:00.000Z", "2026-07-08T23:00:00.000Z"]
  );
});

test("slotsForDate returns nothing on closed days", () => {
  const org = organizer(); // Mon-Fri only
  assert.strictEqual(slots.slotsForDate(org, "2026-07-11").length, 0); // a Saturday
});

test("openSlots drops past slots, booked slots and empty days", () => {
  const org = organizer({ timezone: "UTC", event: { name: "x", durationMinutes: 60, availability: { "3": [{ s: "09:00", e: "12:00" }] } } });
  // A Wednesday far in the future, so no slot is in the past.
  const day0 = slots.slotsForDate(org, "2026-07-08");
  const now = Date.UTC(2026, 6, 7, 12, 0); // Tuesday noon UTC
  const bookings = [{ organizerId: "org1", startMs: day0[1].startMs, endMs: day0[1].endMs }];
  const open = slots.openSlots(org, bookings, now, 14);
  const wednesday = open.find((d) => d.date === "2026-07-08");
  assert.ok(wednesday, "the open day is listed");
  assert.strictEqual(wednesday.slots.length, 2); // 10:00 and 11:00; 09:00 is booked
  assert.ok(!wednesday.slots.some((s) => s.startMs === day0[1].startMs));
});

test("openSlots skips days entirely in the past", () => {
  const org = organizer({ timezone: "UTC" });
  const now = Date.UTC(2026, 6, 8, 20, 0); // Wednesday 20:00 UTC: the day's slots are gone
  const open = slots.openSlots(org, [], now, 3);
  assert.ok(!open.some((d) => d.date === "2026-07-08"));
  assert.ok(open.length > 0);
});

test("isRealOpenSlot accepts exactly one generated slot and rejects neighbours and junk", () => {
  const org = organizer({ timezone: "UTC", event: { name: "x", durationMinutes: 30, availability: { "3": [{ s: "09:00", e: "11:00" }] } } });
  const now = Date.UTC(2026, 6, 7, 12, 0);
  const good = Date.UTC(2026, 6, 8, 9, 30);
  assert.strictEqual(slots.isRealOpenSlot(org, [], good, now), true);
  // 09:15 is not a generated slot.
  assert.strictEqual(slots.isRealOpenSlot(org, [], Date.UTC(2026, 6, 8, 9, 15), now), false);
  // Outside the window.
  assert.strictEqual(slots.isRealOpenSlot(org, [], Date.UTC(2026, 6, 8, 12, 0), now), false);
  // Booked by an overlapping booking.
  const overlapping = [{ organizerId: "org1", startMs: Date.UTC(2026, 6, 8, 9, 0), endMs: Date.UTC(2026, 6, 8, 10, 0) }];
  assert.strictEqual(slots.isRealOpenSlot(org, overlapping, Date.UTC(2026, 6, 8, 9, 30), now), false);
  // Another organizer's booking does not block.
  const otherOrg = [{ organizerId: "org2", startMs: Date.UTC(2026, 6, 8, 9, 0), endMs: Date.UTC(2026, 6, 8, 10, 0) }];
  assert.strictEqual(slots.isRealOpenSlot(org, otherOrg, Date.UTC(2026, 6, 8, 9, 30), now), true);
});

test("normalizeWindows drops malformed rows and cross-window garbage", () => {
  const windows = slots.normalizeWindows({
    "1": [{ s: "09:00", e: "17:00" }, { s: "junk", e: "18:00" }, { s: "18:00", e: "09:00" }],
    "0": [{ s: "01:00", e: "02:00" }], // not a valid ISO weekday key
    "8": [{ s: "01:00", e: "02:00" }],
  });
  assert.deepStrictEqual(windows, { 1: [{ startMin: 540, endMin: 1020 }] });
});

test("defaultAvailability is Mon-Fri 09:00-17:00", () => {
  const a = slots.defaultAvailability();
  assert.strictEqual(Object.keys(a).length, 5);
  assert.deepStrictEqual(a["1"], [{ s: "09:00", e: "17:00" }]);
  assert.strictEqual(a["6"], undefined);
});
