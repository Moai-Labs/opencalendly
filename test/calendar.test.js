"use strict";

// The external calendar feed: ICS parsing into busy intervals, feed fetching
// (with the private-network guard) and the cached reader.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const calendarfeed = require("../lib/calendarfeed");
const time = require("../lib/time");

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

test("garbage input is rejected, not read as an empty calendar", () => {
  // An HTML error page or any text without a VCALENDAR envelope must not be
  // mistaken for a successfully parsed, empty calendar.
  assert.throws(() => calendarfeed.busyFromIcs("<html>not a calendar</html>", { zone: "UTC", ...window() }), /not an iCalendar feed/);
  assert.throws(() => calendarfeed.busyFromIcs("", { zone: "UTC", ...window() }), /not an iCalendar feed/);
  // A valid envelope with no events is a real empty calendar.
  const empty = calendarfeed.busyFromIcs(ics(), { zone: "UTC", ...window() });
  assert.equal(empty.busy.length, 0);
  assert.equal(empty.approximate, false);
});

test("a VEVENT without DTSTART gives no busy time and does not break the read", () => {
  const text = ics(...event(["UID:20@t", "DTEND:20300101T103000Z"]), ...event(["UID:21@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-02T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T10:00:00Z")]);
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
  const readFeed = async () => {
    hits++;
    if (hits >= 3) {
      return ics(...event(["UID:y@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"]));
    }
    throw new Error("boom");
  };
  const reader = calendarfeed.createFeedReader({ readFeed, errorCacheMs: 10 });
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

// --- review round 1: address classification, fetch hardening, expansion ------

test("private addresses of every shape are classified, not public", () => {
  const privateOnes = [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "::ffff:10.0.0.1",
    "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "::0.0.0.1",
    "not-an-address", "010.1.1.1", "1.2.3", "1.2.3.4.5", "256.1.1.1",
  ];
  for (const ip of privateOnes) assert.equal(calendarfeed.ipIsPublic(ip), false, `${ip} must not count as public`);
  const publicOnes = ["8.8.8.8", "172.32.0.1", "100.128.0.1", "203.0.113.9", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "[::ffff:808:808]"];
  for (const ip of publicOnes) assert.equal(calendarfeed.ipIsPublic(ip), true, `${ip} must count as public`);
});

test("host resolution classifies IP literals (bracketed and mapped) and DNS answers", async () => {
  await assert.rejects(() => calendarfeed.resolveFeedHost("127.0.0.1", {}), /not a public address/);
  await assert.rejects(() => calendarfeed.resolveFeedHost("[::1]", {}), /not a public address/);
  await assert.rejects(() => calendarfeed.resolveFeedHost("[::ffff:7f00:1]", {}), /not a public address/);
  await assert.rejects(() => calendarfeed.resolveFeedHost("host.test", { lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }] }), /not a public address/);
  await assert.rejects(() => calendarfeed.resolveFeedHost("host.test", { lookupImpl: async () => [{ address: "::ffff:10.0.0.5", family: 6 }] }), /not a public address/);
  const good = await calendarfeed.resolveFeedHost("host.test", {
    lookupImpl: async () => [{ address: "203.0.113.9", family: 4 }, { address: "2606:4700::1111", family: 6 }],
  });
  assert.deepEqual(good, ["203.0.113.9", "2606:4700::1111"]);
});

test("IPv6 loopback and mapped literals are refused before any connection", async () => {
  for (const host of ["[::1]:9", "[::ffff:127.0.0.1]:9", "[::ffff:7f00:1]:9"]) {
    await assert.rejects(() => calendarfeed.fetchFeedText(`http://${host}/feed.ics`, {}), /not a public address/);
  }
});

test("a DNS name resolving private addresses is refused", async () => {
  await assert.rejects(
    () => calendarfeed.fetchFeedText("http://internal.example/feed.ics", { lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }] }),
    /not a public address/
  );
});

test("the connection uses the validated address; DNS cannot be rebound after validation", async () => {
  let hits = 0;
  let lookups = 0;
  const server = http.createServer((req, res) => {
    hits++; // a rebinding attack would land here
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(ics(...event(["UID:z@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    // Validation resolves to a public address; the loopback server is where a
    // rebinding resolver would send the actual connection instead.
    await assert.rejects(
      () =>
        calendarfeed.fetchFeedText("http://rebinds.test/feed.ics", {
          timeoutMs: 500,
          lookupImpl: async () => {
            lookups++;
            return [{ address: "192.0.2.10", family: 4 }];
          },
        }),
      /in time|refused|unreach|network/i
    );
    assert.equal(hits, 0, "nothing may connect to the private address");
    assert.equal(lookups, 1, "DNS is resolved once, at validation; the connection reuses that answer");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("an oversized feed is cut off while streaming, not buffered whole", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(3 * 1024 * 1024, 97)); // 3 MB, past the 2 MB cap
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/feed.ics`;
  try {
    await assert.rejects(() => calendarfeed.fetchFeedText(url, { allowPrivate: true }), /too large/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("redirects are followed and every hop is fetched through the same guard", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/one") {
      res.writeHead(302, { location: "/two" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(ics(...event(["UID:35@t", "DTSTART:20300101T100000Z", "DTEND:20300101T103000Z"])));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/one`;
  try {
    const text = await calendarfeed.fetchFeedText(url, { allowPrivate: true });
    assert.ok(text.includes("BEGIN:VEVENT"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("an HTML error page is a failed read, not an empty calendar", async () => {
  const reader = calendarfeed.createFeedReader({ readFeed: async () => "<html><body>rate limited</body></html>" });
  const res = await reader.read("https://example.invalid/feed.ics", 60000);
  assert.equal(res.ok, false);
  assert.match(res.error, /not an iCalendar feed/);
});

test("a cancelled instance without DTSTART still removes its occurrence", () => {
  const master = event(["UID:22@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=DAILY;COUNT=3"]);
  const cancelled = event(["UID:22@t", "RECURRENCE-ID:20300102T090000Z", "STATUS:CANCELLED"]);
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-10T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(ics(...master, ...cancelled), { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T09:00:00Z"), Date.parse("2030-01-03T09:00:00Z")]);
});

test("an occurrence that starts before the window but is busy inside it is not lost", () => {
  // A weekly event, 48 hours long: its Tuesday occurrence spans into
  // Wednesday and must still block Wednesday's hours, even though it started
  // before the window.
  const text = ics(...event(["UID:23@t", "DTSTART:20300101T100000Z", "DTEND:20300103T100000Z", "RRULE:FREQ=WEEKLY"]));
  const w = { fromMs: Date.parse("2030-01-02T00:00:00Z"), toMs: Date.parse("2030-01-04T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T10:00:00Z")]);
});

test("a recurring multi-day event starting far before the window still blocks it", () => {
  // A weekly 5-day occurrence beginning Sunday 2030-01-06. The window opens
  // Jan 9 — more than two days after the occurrence's start — yet the
  // occurrence is still busy Jan 9–10 and must be enumerated; a fixed
  // two-day lookback would miss it.
  const text = ics(...event(["UID:23b@t", "DTSTART:20300106T100000Z", "DTEND:20300111T100000Z", "RRULE:FREQ=WEEKLY"]));
  const w = { fromMs: Date.parse("2030-01-09T00:00:00Z"), toMs: Date.parse("2030-01-12T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-01-06T10:00:00Z")]);
  assert.equal(busy[0].endMs, Date.parse("2030-01-11T10:00:00Z"));
});

test("an instance moved into the window from an occurrence outside it is kept", () => {
  const master = event(["UID:24@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=DAILY"]);
  const moved = event(["UID:24@t", "RECURRENCE-ID:20300101T090000Z", "DTSTART:20300105T140000Z", "DTEND:20300105T143000Z"]);
  // The window starts Jan 4: the overridden occurrence was Jan 1, never
  // enumerated inside the window, yet its moved time must still appear.
  const w = { fromMs: Date.parse("2030-01-04T00:00:00Z"), toMs: Date.parse("2030-01-07T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(ics(...master, ...moved), { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-04T09:00:00Z"),
    Date.parse("2030-01-05T09:00:00Z"),
    Date.parse("2030-01-05T14:00:00Z"),
    Date.parse("2030-01-06T09:00:00Z"),
  ]);
});

test("a weekday-only daily rule lands only on those weekdays and counts real occurrences", () => {
  // 2030-01-01 is a Tuesday: MO,WE gives Wed 2nd, Mon 7th, Wed 9th for COUNT=3.
  const text = ics(...event(["UID:25@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=DAILY;BYDAY=MO,WE;COUNT=3"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-01-15T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-02T09:00:00Z"),
    Date.parse("2030-01-07T09:00:00Z"),
    Date.parse("2030-01-09T09:00:00Z"),
  ]);
});

test("WKST decides which weeks an interval-aligned weekly rule skips", () => {
  // DTSTART Monday 2030-01-07. With weeks starting Sunday (WKST=SU), the
  // Sunday of DTSTART's week is Jan 6, before DTSTART; the interval-2 weeks
  // then produce Sundays Jan 20 and Feb 3 — not Jan 13 and Jan 27, which a
  // Monday-anchored week would give.
  const text = ics(...event(["UID:26@t", "DTSTART:20300107T090000Z", "DTEND:20300107T093000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-02-10T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-07T09:00:00Z"),
    Date.parse("2030-01-20T09:00:00Z"),
    Date.parse("2030-01-21T09:00:00Z"),
    Date.parse("2030-02-03T09:00:00Z"),
    Date.parse("2030-02-04T09:00:00Z"),
  ]);
});

test("weekly candidates are ordered by WKST, so COUNT=1 picks Sunday over Monday", () => {
  // DTSTART Sunday 2030-01-06, WKST=SU, BYDAY=SU,MO, COUNT=1. Sunday sits at
  // offset 0 of a Sunday-anchored week and must be the one occurrence COUNT
  // keeps; Monday would be picked if candidates were ordered by weekday
  // number. The horizon also ends between Sunday and Monday, so the walk
  // must stop cleanly there without first emitting Monday.
  const text = ics(...event(["UID:26b@t", "DTSTART:20300106T090000Z", "DTEND:20300106T093000Z", "RRULE:FREQ=WEEKLY;BYDAY=SU,MO;WKST=SU;COUNT=1"]));
  const w = { fromMs: Date.parse("2030-01-05T00:00:00Z"), toMs: Date.parse("2030-01-07T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [Date.parse("2030-01-06T09:00:00Z")]);
});

test("a month-end rule with COUNT counts real occurrences, not elapsed months", () => {
  // From Jan 31 monthly, February has no 31st; COUNT=3 must count the dates
  // that exist, reaching May 31 — not stop at March.
  const text = ics(...event(["UID:27@t", "DTSTART:20300131T090000Z", "DTEND:20300131T093000Z", "RRULE:FREQ=MONTHLY;COUNT=3"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-08-01T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-31T09:00:00Z"),
    Date.parse("2030-03-31T09:00:00Z"),
    Date.parse("2030-05-31T09:00:00Z"),
  ]);
});

test("a leap-day rule with COUNT counts real occurrences, not elapsed years", () => {
  // COUNT=3 from 2024-02-29 yearly reaches 2032; counting elapsed years
  // would stop at 2030 and yield only two occurrences.
  const text = ics(...event(["UID:28@t", "DTSTART:20240229T090000Z", "DTEND:20240229T093000Z", "RRULE:FREQ=YEARLY;COUNT=3"]));
  const w = { fromMs: Date.parse("2024-01-01T00:00:00Z"), toMs: Date.parse("2034-01-01T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [
    Date.parse("2024-02-29T09:00:00Z"),
    Date.parse("2028-02-29T09:00:00Z"),
    Date.parse("2032-02-29T09:00:00Z"),
  ]);
});

test("a monthly rule on a plain weekday hits every such day of the month", () => {
  // FREQ=MONTHLY;BYDAY=MO means every Monday, not just the DTSTART weekday.
  const text = ics(...event(["UID:31@t", "DTSTART:20300107T090000Z", "DTEND:20300107T093000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-02-01T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, false);
  assert.deepEqual(starts(busy), [
    Date.parse("2030-01-07T09:00:00Z"),
    Date.parse("2030-01-14T09:00:00Z"),
    Date.parse("2030-01-21T09:00:00Z"),
    Date.parse("2030-01-28T09:00:00Z"),
  ]);
});

test("monthly ordinal expansion never emits a date before DTSTART", () => {
  // First Monday of each month from Jan 20: January's first Monday (Jan 7)
  // lies before DTSTART and must not appear.
  const text = ics(...event(["UID:29@t", "DTSTART:20300120T090000Z", "DTEND:20300120T093000Z", "RRULE:FREQ=MONTHLY;BYDAY=1MO"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2030-03-01T00:00:00Z") };
  const { busy } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.deepEqual(starts(busy), [Date.parse("2030-02-04T09:00:00Z")]);
});

test("a yearly weekday rule is marked approximate and keeps its first occurrence", () => {
  const text = ics(...event(["UID:30@t", "DTSTART:20300101T090000Z", "DTEND:20300101T093000Z", "RRULE:FREQ=YEARLY;BYDAY=MO"]));
  const w = { fromMs: Date.parse("2030-01-01T00:00:00Z"), toMs: Date.parse("2032-01-01T00:00:00Z") };
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...w });
  assert.equal(approximate, true);
  assert.deepEqual(starts(busy), [Date.parse("2030-01-01T09:00:00Z")]);
});

test("a pathological rule is cut off by the step budget and marked approximate", () => {
  // A daily rule with named weekdays cannot be fast-forwarded (the skipped
  // days make the occurrence index unpredictable), so from the year 1000 it
  // would walk hundreds of thousands of days; the step budget must stop it
  // and own up.
  const text = ics(...event(["UID:34@t", "DTSTART:10000101T090000Z", "DTEND:10000101T093000Z", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=999999999"]));
  const started = Date.now();
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...window() });
  // The budget stops the walk before it reaches the window: the honest
  // answer is "approximate", reported quickly, with whatever was derived.
  assert.equal(approximate, true);
  assert.ok(Date.now() - started < 2000, "expansion must not monopolize the server");
});

test("many old recurring events share one feed-wide budget and cannot each re-spend it", () => {
  // Forty daily rules from the year 1000: a per-event allowance would let
  // each walk 200,000 steps (eight million in all). The feed-wide budget
  // stops the parse long before that, marks the result approximate, and
  // returns quickly.
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push(...event([`UID:feed-${i}@t`, "DTSTART:10000101T090000Z", "DTEND:10000101T093000Z", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"]));
  }
  const text = ics(...events);
  const started = Date.now();
  const { approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...window() });
  assert.equal(approximate, true);
  assert.ok(Date.now() - started < 2000, "the feed budget must bound the whole parse");
});

test("a daily rule from years back with no COUNT jumps to the window cheaply", () => {
  const text = ics(...event(["UID:33@t", "DTSTART:20000101T090000Z", "DTEND:20000101T093000Z", "RRULE:FREQ=DAILY"]));
  const started = Date.now();
  const { busy, approximate } = calendarfeed.busyFromIcs(text, { zone: "UTC", ...window() });
  assert.equal(approximate, false);
  assert.ok(busy.length >= 1);
  assert.ok(Date.now() - started < 500, "a 26-year-old daily rule must not walk day by day");
});

test("the same feed read in two zones gets zone-correct intervals, not a shared cache", async () => {
  let hits = 0;
  const readFeed = async () => {
    hits++;
    const dateStr = time.localDate("UTC", Date.now() + 5 * 86400000);
    return ics(...event(["UID:32@t", `DTSTART;VALUE=DATE:${dateStr.replace(/-/g, "")}`]));
  };
  const reader = calendarfeed.createFeedReader({ readFeed });
  const url = "https://example.invalid/feed.ics";
  const first = await reader.read(url, 60000, { zone: "UTC" });
  const second = await reader.read(url, 60000, { zone: "Pacific/Kiritimati" }); // UTC+14, read inside the cache lifetime
  const third = await reader.read(url, 60000, { zone: "UTC" });
  assert.equal(hits, 2, "one fetch per zone, not one per URL");
  assert.notEqual(first.busy[0].startMs, second.busy[0].startMs, "an all-day event must start at that zone's midnight");
  const dateStr = time.localDate("UTC", Date.now() + 5 * 86400000);
  assert.equal(first.busy[0].startMs, time.wallMinutesToUtcMs("UTC", dateStr, 0));
  assert.equal(second.busy[0].startMs, time.wallMinutesToUtcMs("Pacific/Kiritimati", dateStr, 0));
  assert.equal(third.busy[0].startMs, first.busy[0].startMs);
});
