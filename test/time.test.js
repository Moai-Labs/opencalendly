"use strict";

const test = require("node:test");
const assert = require("node:assert");
const time = require("../lib/time");

test("wallMinutesToUtcMs converts wall time to UTC in a fixed zone", () => {
  // Berlin in winter is UTC+1.
  assert.strictEqual(time.wallMinutesToUtcMs("Europe/Berlin", "2026-01-15", 9 * 60), Date.UTC(2026, 0, 15, 8, 0));
  // Berlin in summer is UTC+2.
  assert.strictEqual(time.wallMinutesToUtcMs("Europe/Berlin", "2026-07-15", 9 * 60), Date.UTC(2026, 6, 15, 7, 0));
  // New York in winter is UTC-5.
  assert.strictEqual(time.wallMinutesToUtcMs("America/New_York", "2026-01-15", 9 * 60), Date.UTC(2026, 0, 15, 14, 0));
});

test("wallMinutesToUtcMs handles the DST spring-forward day", () => {
  // 2026-03-08: US clocks jump 02:00 -> 03:00. Nine in the morning is EDT (UTC-4).
  assert.strictEqual(time.wallMinutesToUtcMs("America/New_York", "2026-03-08", 9 * 60), Date.UTC(2026, 2, 8, 13, 0));
});

test("wallMinutesToUtcMs accepts minutes beyond midnight (24:00 windows)", () => {
  // 1440 minutes = next local midnight.
  assert.strictEqual(time.wallMinutesToUtcMs("UTC", "2026-06-01", 1440), Date.UTC(2026, 5, 2, 0, 0));
  assert.strictEqual(time.wallMinutesToUtcMs("Europe/Berlin", "2026-01-15", 1440), Date.UTC(2026, 0, 15, 23, 0));
});

test("localDate round-trips with wallMinutesToUtcMs", () => {
  for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
    for (const minutes of [0, 540, 1439]) {
      const ms = time.wallMinutesToUtcMs(zone, "2026-11-03", minutes);
      assert.strictEqual(time.localDate(zone, ms), "2026-11-03", `${zone} ${minutes}`);
    }
  }
});

test("isoDow maps Monday..Sunday to 1..7", () => {
  // Computed the same way the calendar works, not hardcoded from memory.
  const expected = (dateStr) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  };
  for (let i = 0; i < 14; i++) {
    const dateStr = time.addDays("2026-10-27", i);
    assert.strictEqual(time.isoDow(dateStr), expected(dateStr), dateStr);
  }
});

test("addDays crosses month and year boundaries", () => {
  assert.strictEqual(time.addDays("2026-10-31", 1), "2026-11-01");
  assert.strictEqual(time.addDays("2026-12-31", 1), "2027-01-01");
  assert.strictEqual(time.addDays("2026-03-01", -1), "2026-02-28");
});

test("parseHm accepts HH:MM and 24:00, rejects the rest", () => {
  assert.strictEqual(time.parseHm("09:00"), 540);
  assert.strictEqual(time.parseHm("9:30"), 570);
  assert.strictEqual(time.parseHm("24:00"), 1440);
  assert.strictEqual(time.parseHm("24:30"), null);
  assert.strictEqual(time.parseHm("25:00"), null);
  assert.strictEqual(time.parseHm("ab:cd"), null);
  assert.strictEqual(time.parseHm(""), null);
  assert.strictEqual(time.parseHm(null), null);
});

test("formatMinutes is the inverse of parseHm for clock times", () => {
  for (const min of [0, 540, 959]) {
    assert.strictEqual(time.parseHm(time.formatMinutes(min)), min);
  }
  // 1440 ("24:00") is an end-of-day marker; as a clock face it renders as 00:00.
  assert.strictEqual(time.formatMinutes(1440), "00:00");
});

test("isValidZone accepts real zones and rejects junk", () => {
  assert.strictEqual(time.isValidZone("Europe/Berlin"), true);
  assert.strictEqual(time.isValidZone("UTC"), true);
  assert.strictEqual(time.isValidZone("Not/AZone"), false);
  assert.strictEqual(time.isValidZone(""), false);
  assert.strictEqual(time.isValidZone(undefined), false);
  assert.strictEqual(time.isValidZone("../../etc/passwd"), false);
});

test("offsetLabel reads the offset at an instant", () => {
  const winter = Date.UTC(2026, 0, 15, 12, 0);
  const summer = Date.UTC(2026, 6, 15, 12, 0);
  assert.strictEqual(time.offsetLabel("Europe/Berlin", winter), "UTC+01:00");
  assert.strictEqual(time.offsetLabel("Europe/Berlin", summer), "UTC+02:00");
  assert.strictEqual(time.offsetLabel("Asia/Kolkata", winter), "UTC+05:30");
  assert.strictEqual(time.offsetLabel("America/New_York", winter), "UTC-05:00");
});

test("describeInZone renders date, clock and zone", () => {
  const ms = Date.UTC(2026, 10, 3, 14, 30);
  assert.strictEqual(time.describeInZone(ms, "Europe/Berlin"), "2026-11-03 15:30 (Europe/Berlin)");
  assert.strictEqual(time.describeInZone(ms, "UTC"), "2026-11-03 14:30 (UTC)");
});
