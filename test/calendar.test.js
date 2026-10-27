"use strict";

// The external calendar feed: ICS parsing into busy intervals, feed fetching
// (with the private-network guard) and the cached reader.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const calendarfeed = require("../lib/calendarfeed");

function ics(...body) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...body, "END:VCALENDAR"].join("\r\n") + "\r\n";
}

function event(lines) {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
}

// A window that comfortably covers any "now" the tests use.
function window() {
  const now = Date.now();
  return { fromMs: now - 48 * 3600 * 1000, toMs: now + 30 * 24 * 3600 * 1000 };
}

function starts(busy) {
  return busy.map((b) => b.startMs);
}

test("a simple UTC event becomes one busy interval", () => {
  const text = ics(...event(["UID:1@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"]));
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...window() });
  // Use an event far out; feed windows in the reader are shorter, but
  // busyFromIcs itself honours the window it is given.
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  const { busy: b2 } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(busy.length, 0); // outside the default window
  assert.equal(b2.length, 1);
  assert.equal(b2[0].startMs, Date.parse("2030-01-01T10:00:00Z"));
  assert.equal(b2[0].endMs, Date.parse("2030-01-01T10:30:00Z"));
});

test("a TZID event resolves to the right UTC instant", () => {
  const text = ics(...event(["UID:2@t", "DTSTART;TZID=Europe/Berlin:20300101T140000", "DTEND;TZID=Europe/Berlin:20300101T150000"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(busy.length, 1);
  // Berlin is UTC+1 in January: 14:00 local is 13:00 UTC.
  assert.equal(busy[0].startMs, Date.parse("2030-01-01T13:00:00Z"));
  assert.equal(busy[0].endMs, Date.parse("2030-01-01T14:00:00Z"));
});

test("an all-day event blocks its whole day in the organizer's zone", () => {
  const text = ics(...event(["UID:3@t", "DTSTART;VALUE=DATE:20300101"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-03T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(busy.length, 1);
  assert.equal(busy[0].startMs, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(busy[0].endMs, Date.parse("2030-01-02T00:00:00Z"));
});

test("transparent and cancelled events block nothing", () => {
  const base = ["DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"];
  const transparent = ics(...event(["UID:4@t", ...base, "TRANSP:TRANSPARENT"]));
  const cancelled = ics(...event(["UID:5@t", ...base, "STATUS:CANCELLED"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  assert.equal(calendarfeed.busyFromIcs(transparent, { zone: "UTC", ...w }).busy.length, 0);
  assert.equal(calendarfeed.busyFromIcs(cancelled, { zone: "UTC", ...w }).busy.length, 0);
});

test("folded lines parse correctly", () => {
  const text = ics(...event(["UID:6@t", "DTSTART:20300101T1\r\n 00000Z", "DTEND:20300101T103000Z"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(busy.length, 1);
  assert.equal(busy[0].startMs, Date.parse("2030-01-01T10:00:00Z"));
});

test("a DAILY rule with COUNT expands to three days", () => {
  const text = ics(...event(["UID:7@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=DAILY;COUNT=3"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-10T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-01T09:00:00Z"),
    Date.parse("2030-01-02T09:00:00Z"),
    Date.parse("2030-01-03T09:00:00Z"),
  ]);
});

test("a WEEKLY rule with BYDAY lands only on those days", () => {
  // 2030-01-01 is a Tuesday; MO,WE means Wed 2nd, Mon 7th, Wed 9th...
  const text = ics(...event(["UID:8@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-09T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-02T10:00:00Z"),
    Date.parse("2030-01-07T10:00:00Z"),
  ]);
});

test("INTERVAL=2 weeks skips alternate weeks", () => {
  const text = ics(...event(["UID:9@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-31T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-01T10:00:00Z"),
    Date.parse("2030-01-15T10:00:00Z"),
    Date.parse("2030-01-29T10:00:00Z"),
  ]);
});

test("EXDATE removes one occurrence", () => {
  const text = ics(
    ...event([
      "UID:10@t",
      "DTSTART:20300101T090000Z",
      "DTEND:20300101T093000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE:20300102T090000Z",
    ])
  );
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-10T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T09:00:00Z"), Date.parse("2030-01-03T09:00:00Z")]);
});

test("a cancelled instance override removes one occurrence; a moved one relocates it", () => {
  const master = event([
    "UID:11@t",
    "DTSTART:20300101T090000Z",
    "DTEND:20300101T093000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
  ]);
  const cancelledInstance = event([
    "UID:11@t",
    "RECURRENCE-ID:20300102T090000Z",
    "DTSTART:20300102T090000Z",
    "DTEND:20300102T093000Z",
    "STATUS:CANCELLED",
  ]);
  const movedInstance = event([
    "UID:11@t",
    "RECURRENCE-ID:20300103T090000Z",
    "DTSTART:20300103T140000Z",
    "DTEND:20300103T143000Z",
  ]);
  const text = ics(...master, ...cancelledInstance, ...movedInstance);
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-10T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T09:00:00Z"), Date.parse("2030-01-03T14:00:00Z")]);
});

test("an unsupported rule keeps its first occurrence and is marked approximate", () => {
  const text = ics(...event(["UID:12@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=DAILY;BYSETPOS=1;COUNT=5"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-10T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, true);
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T09:00:00Z")]);
});

test("a monthly rule repeats on the same day of the month", () => {
  const text = ics(...event(["UID:13@t", "DTSTART:20300110T090000Z", "DTEND:20300110T093000Z", "RRULE:FREQ=MONTHLY"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-04-01T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-10T09:00:00Z"),
    Date.parse("2030-02-10T09:00:00Z"),
    Date.parse("2030-03-10T09:00:00Z"),
  ]);
});

test("the nth-weekday monthly rule lands on the right day", () => {
  // second Monday of January 2030 is the 14th
  const text = ics(...event(["UID:14@t", "DTSTART:20300114T090000Z", "DTEND:20300114T093000Z", "RRULE:FREQ=MONTHLY;BYDAY=2MO"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-03-01T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-14T09:00:00Z"), Date.parse("2030-02-11T09:00:00Z")]);
});

test("a rule running for years before the window still expands into it", () => {
  // 400 weekly Mondays from 2021 — COUNT must be honoured by occurrence
  // index, not by walking day by day from a long-past DTSTART.
  const text = ics(...event(["UID:16@t", "DTSTART:20210104T090000Z", "DTEND:20210104T093000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=400"]));
  const w = { fromMs: Date.now() - 48 * 3600 * 1000, toMs: Date.now() + 30 * 24 * 3600 * 1000 };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.ok(busy.length >= 1);
  for (const b of busy) {
    const d = new Date(b.startMs);
    assert.equal(d.getUTCDay(), 1, "every occurrence is a Monday");
    assert.equal(d.getUTCHours(), 9);
    assert.equal(b.endMs - b.startMs, 30 * 60000);
  }
});

test("DURATION is honoured when DTEND is absent", () => {
  const text = ics(...event(["UID:15@t", "DTSTART:20300101T090000Z", "DURATION:PT1H30M"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(busy[0].endMs, Date.parse("2030-01-01T10:30:00Z"));
});

test("garbage input yields no busy times", () => {
  const { busy, approximate } = calendarfeed.busyFromIcs("<html>not a calendar</html>", {
    zone: "UTC",
    ...window(),
  });
  assert.equal(busy.length, 0);
  assert.equal(approximate, false);
});

test("feed URL validation", () => {
  assert.equal(calendarfeed.feedUrlIsValid("https://calendar.google.com/ical/x/basic.ics"), true);
  assert.equal(calendarfeed.feedUrlIsValid("http://example.com/feed.ics"), true);
  assert.equal(calendarfeed.feedUrlIsValid("ftp://example.com/f.ics"), false);
  assert.equal(calendarfeed.feedUrlIsValid("https://user:pass@example.com/f.ics"), false);
  assert.equal(calendarfeed.feedUrlIsValid("javascript:alert(1)"), false);
  assert.equal(calendarfeed.feedUrlIsValid("   "), false);
  assert.equal(calendarfeed.feedUrlIsValid("https://" + "a".repeat(2100) + ".com/f.ics"), false);
});

test("the feed address is masked to its host", () => {
  assert.equal(
    calendarfeed.maskedFeedUrl("https://calendar.google.com/ical/secrettoken/basic.ics"),
    "https://calendar.google.com/…"
  );
});

test("private hosts are refused by default and allowed for tests", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(ics(...event(["UID:x@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/feed.ics`;
  try {
    await assert.rejects(() => calendarfeed.fetchFeedText(url, { fetchImpl: fetch }), /not a public address/);
    const text = await calendarfeed.fetchFeedText(url, { fetchImpl: fetch, allowPrivate: true });
    assert.ok(text.includes("BEGIN:VEVENT"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("an http error is reported, not swallowed", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(503);
    res.end("down");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/feed.ics`;
  try {
    await assert.rejects(() => calendarfeed.fetchFeedText(url, { fetchImpl: fetch, allowPrivate: true }), /503/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("the reader caches good reads and retries failures", async () => {
  let hits = 0;
  const fetchImpl = async () => {
    hits++;
    if (hits >= 3) {
      return new Response(
        ics(...event(["UID:y@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"])),
        { status: 200 }
      );
    }
    return new Response("boom", { status: 500 });
  };
  const reader = calendarfeed.createFeedReader({ allowPrivate: true, fetchImpl, errorCacheMs: 10 });
  const url = "https://example.invalid/feed.ics";
  const first = await reader.read(url, 60000);
  assert.equal(first.ok, false);
  const again = await reader.read(url, 60000); // fresh failure: served from cache
  assert.equal(again.ok, false);
  assert.equal(hits, 1);
  await new Promise((r) => setTimeout(r, 20));
  const retried = await reader.read(url, 60000); // failure stale: refetch, still failing
  assert.equal(retried.ok, false);
  assert.equal(hits, 2);
  await new Promise((r) => setTimeout(r, 20));
  const good = await reader.read(url, 60000); // provider back up
  assert.equal(good.ok, true);
  assert.equal(hits, 3);
  const cached = await reader.read(url, 60000); // fresh success: no fetch
  assert.equal(cached.ok, true);
  assert.equal(hits, 3);
  const staleForbidden = await reader.read(url, 0); // maxAge 0 forces a refetch
  assert.equal(staleForbidden.ok, true);
  assert.equal(hits, 4);
});
