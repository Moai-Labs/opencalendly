"use strict";

// End-to-end: an organizer connects an external calendar feed and the booking
// page reflects its busy times — pages, booking POST, reschedule, honesty
// when the feed cannot be read, and disconnecting.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const time = require("../lib/time");
const { createApp } = require("../lib/app");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-calf-"));
}

const open = new Set();
test.after(() => Promise.all([...open].map((c) => c.close())));

async function start(opts = {}) {
  const app = createApp({
    dataDir: tmpDir(),
    mailConfig: null,
    allowPrivateFeeds: true, // the test feed serves from loopback
    feedMaxAgeMs: 200, // so tests can see the failure path without waiting a minute
    ...opts,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    app,
    store: app.store,
    base,
    close: () => {
      open.delete(ctx);
      return new Promise((resolve) => app.server.close(resolve));
    },
  };
  open.add(ctx);
  return ctx;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

async function post(url, fields, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form(fields),
    redirect: "manual",
  });
}

function cookieOf(res) {
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function signup(ctx, { timezone = "UTC", slug } = {}) {
  const res = await post(`${ctx.base}/signup`, { name: "Ada", email: `${slug || "ada"}@example.com`, password: "longenough", timezone });
  assert.equal(res.status, 303);
  return { cookie: cookieOf(res), slug: (await store_get(ctx, res)).slug };
}

// The slug is random; find it from the store via the signed-in organizer.
function store_get(ctx, res) {
  return new Promise((resolve) => {
    ctx.app.store.write(() => {}).then(() => {
      const organizer = ctx.store.state.organizers.find((o) => o.email.endsWith("@example.com"));
      resolve(organizer);
    });
  });
}

// The feed server: a stateful ICS source the tests can flip between answers.
function feedServer(initialIcs) {
  let body = initialIcs;
  let status = 200;
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (status !== 200) {
      res.writeHead(status);
      res.end("down");
      return;
    }
    res.writeHead(200, { "content-type": "text/calendar" });
    res.end(body);
  });
  return {
    hits: () => hits,
    set: (newBody, newStatus = 200) => {
      body = newBody;
      status = newStatus;
    },
    listen: async () => {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}/basic.ics`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// A weekday (Mon–Fri) 4–13 days out, within the 14-day booking window.
function weekdayAhead() {
  const now = Date.now();
  for (let add = 4; add <= 13; add++) {
    const dateStr = time.localDate("UTC", now + add * 86400000);
    const dow = time.isoDow(dateStr);
    if (dow >= 1 && dow <= 5) return dateStr;
  }
  throw new Error("no weekday found");
}

function icsFor(dateStr) {
  const compact = dateStr.replace(/-/g, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "X-WR-CALNAME:Ada's calendar",
    "BEGIN:VEVENT",
    "UID:flow@t",
    `DTSTART:${compact}T100000Z`,
    `DTEND:${compact}T103000Z`,
    "SUMMARY:Existing meeting",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

async function get(ctx, url, headers = {}) {
  return fetch(url, { headers, redirect: "manual" });
}

test("a connected feed hides busy times and the pages say so honestly", async () => {
  const ctx = await start();
  const feed = feedServer(icsFor(weekdayAhead()));
  const feedUrl = await feed.listen();
  try {
    const { cookie } = await signup(ctx, { slug: "ada" });
    const organizer = () => ctx.store.state.organizers.find((o) => o.email.endsWith("@example.com"));

    // Connect: invalid input first, then a good address.
    const bad = await post(`${ctx.base}/dashboard/calendar`, { url: "not a url" }, { cookie });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /not a calendar feed address/);
    assert.equal(organizer().calendar, null);

    // A feed that does not read is never saved.
    feed.set(icsFor(weekdayAhead()), 503);
    const broken = await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    assert.equal(broken.status, 400);
    assert.match(await broken.text(), /could not be read/);
    assert.equal(organizer().calendar, null);

    feed.set(icsFor(weekdayAhead()), 200);
    const ok = await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    assert.equal(ok.status, 303);
    assert.ok(organizer().calendar.url === feedUrl);

    // The dashboard shows the connection without leaking the secret address.
    const dash = await get(ctx, `${ctx.base}/dashboard`, { cookie });
    const dashHtml = await dash.text();
    assert.match(dashHtml, /Connected/);
    assert.match(dashHtml, /Ada&#39;s calendar|Ada's calendar/);
    assert.match(dashHtml, /127\.0\.0\.1:\d+\/…/);
    assert.ok(!dashHtml.includes(feedUrl), "the full secret feed address must not be shown");

    // The public booking page hides the busy 10:00 slot and says it checked.
    const busyDate = weekdayAhead();
    const page = await get(ctx, `${ctx.base}/b/${organizer().slug}?date=${busyDate}`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    const busyStartMs = time.wallMinutesToUtcMs("UTC", busyDate, 600);
    assert.ok(!pageHtml.includes(encodeURIComponent(new Date(busyStartMs).toISOString())), "the busy slot must not be offered");
    assert.match(pageHtml, /external calendar shows busy are already hidden/);
    assert.match(pageHtml, /checked just now/);

    // Booking the busy slot directly is refused.
    const bookedBusy = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(busyStartMs).toISOString(),
      tz: "UTC",
      guest_name: "Ghost",
      guest_email: "ghost@example.com",
    });
    assert.equal(bookedBusy.status, 409);

    // Booking a free slot works, and the confirmation says the calendar was checked.
    const freeStartMs = busyStartMs + 90 * 60000; // 11:30 UTC
    const booked = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(freeStartMs).toISOString(),
      tz: "UTC",
      guest_name: "Greta",
      guest_email: "greta@example.com",
    });
    assert.equal(booked.status, 303);
    const confirmed = await get(ctx, new URL(booked.headers.get("location"), ctx.base).href);
    assert.match(await confirmed.text(), /were hidden when this booking was made/);

    // When the feed goes down, the page says so instead of pretending.
    feed.set(icsFor(weekdayAhead()), 503);
    await new Promise((r) => setTimeout(r, 250)); // past the 200 ms cache window
    const down = await get(ctx, `${ctx.base}/b/${organizer().slug}?date=${weekdayAhead()}`);
    const downHtml = await down.text();
    assert.match(downHtml, /could not be checked just now/);
    // Manual availability is still shown (09:00 slot exists on a weekday).
    const nineMs = time.wallMinutesToUtcMs("UTC", weekdayAhead(), 540);
    assert.ok(downHtml.includes(encodeURIComponent(new Date(nineMs).toISOString())));

    // Disconnecting restores the plain note.
    const off = await post(`${ctx.base}/dashboard/calendar/disconnect`, {}, { cookie });
    assert.equal(off.status, 303);
    const afterOff = await get(ctx, `${ctx.base}/dashboard`, { cookie });
    const afterOffHtml = await afterOff.text();
    assert.match(afterOffHtml, /Connect one external calendar/);
    assert.equal(organizer().calendar, null);
    const plainPage = await get(ctx, `${ctx.base}/b/${organizer().slug}`);
    assert.match(await plainPage.text(), /We do not check external calendars/);

    // The busy slot is bookable again for a fresh guest once disconnected.
    const rebook = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(busyStartMs).toISOString(),
      tz: "UTC",
      guest_name: "Later",
      guest_email: "later@example.com",
    });
    assert.equal(rebook.status, 303);
  } finally {
    await feed.close();
    await ctx.close();
  }
});

test("the feed cache means one page view costs one fetch", async () => {
  const ctx = await start();
  const feed = feedServer(icsFor(weekdayAhead()));
  const feedUrl = await feed.listen();
  try {
    const { cookie } = await signup(ctx, { slug: "cache" });
    await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    const before = feed.hits();
    await get(ctx, `${ctx.base}/b/${ctx.store.state.organizers[0].slug}`);
    await get(ctx, `${ctx.base}/b/${ctx.store.state.organizers[0].slug}`);
    assert.ok(feed.hits() - before <= 1, `expected at most one fetch, saw ${feed.hits() - before}`);
  } finally {
    await feed.close();
    await ctx.close();
  }
});

test("rescheduling skips busy times from the feed too", async () => {
  const ctx = await start();
  const feed = feedServer(icsFor(weekdayAhead()));
  const feedUrl = await feed.listen();
  try {
    const { cookie } = await signup(ctx, { slug: "move" });
    const organizer = () => ctx.store.state.organizers.find((o) => o.email.endsWith("@example.com"));
    await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    const busyStartMs = time.wallMinutesToUtcMs("UTC", weekdayAhead(), 600);
    const freeStartMs = busyStartMs + 90 * 60000;
    const booked = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(freeStartMs).toISOString(),
      tz: "UTC",
      guest_name: "Greta",
      guest_email: "greta@example.com",
    });
    const confirmedUrl = new URL(booked.headers.get("location"), ctx.base);
    const bookingId = confirmedUrl.pathname.split("/").pop();

    // The reschedule page offers no busy 10:00 slot.
    const reschedPage = await get(ctx, `${ctx.base}/b/${organizer().slug}/reschedule/${bookingId}?date=${weekdayAhead()}`);
    const reschedHtml = await reschedPage.text();
    assert.ok(!reschedHtml.includes(encodeURIComponent(new Date(busyStartMs).toISOString())));

    // And POSTing to it is refused.
    const reschedBusy = await post(`${ctx.base}/b/${organizer().slug}/reschedule/${bookingId}`, {
      start: new Date(busyStartMs).toISOString(),
      tz: "UTC",
    });
    assert.equal(reschedBusy.status, 409);
  } finally {
    await feed.close();
    await ctx.close();
  }
});

test("export carries the connection; deletion removes it", async () => {
  const ctx = await start();
  const feed = feedServer(icsFor(weekdayAhead()));
  const feedUrl = await feed.listen();
  try {
    const { cookie } = await signup(ctx, { slug: "data" });
    const organizer = () => ctx.store.state.organizers.find((o) => o.email.endsWith("@example.com"));
    await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    const exp = await get(ctx, `${ctx.base}/dashboard/export`, { cookie });
    const exported = JSON.parse(await exp.text());
    assert.equal(exported.organizer.calendar.url, feedUrl);

    await post(`${ctx.base}/dashboard/delete`, { password: "longenough" }, { cookie });
    assert.ok(!ctx.store.state.organizers.some((o) => o.email.endsWith("@example.com")));
    assert.ok(!ctx.store.state.bookings.some((b) => Object.values(b).includes(feedUrl)), "the feed address must leave with the organizer");
  } finally {
    await feed.close();
    await ctx.close();
  }
});

test("the recorded check outcome follows the booking, not the current connection", async () => {
  const ctx = await start({ feedRecheckMs: 200 }); // the booking POST re-check must see the broken feed quickly
  const feed = feedServer(icsFor(weekdayAhead()));
  const feedUrl = await feed.listen();
  try {
    const { cookie } = await signup(ctx, { slug: "truth" });
    const organizer = () => ctx.store.state.organizers.find((o) => o.email.endsWith("@example.com"));

    // Connect while the feed is readable, then break it.
    const nineMs = time.wallMinutesToUtcMs("UTC", weekdayAhead(), 540);
    const connected = await post(`${ctx.base}/dashboard/calendar`, { url: feedUrl }, { cookie });
    assert.equal(connected.status, 303);

    // Booked while the feed was down: files and emails must say the check
    // failed, never that times were checked.
    feed.set(icsFor(weekdayAhead()), 503);
    await new Promise((r) => setTimeout(r, 250)); // past the booking re-check window
    const down = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(nineMs).toISOString(),
      tz: "UTC",
      guest_name: "Dana",
      guest_email: "dana@example.com",
    });
    assert.equal(down.status, 303);
    const downId = new URL(down.headers.get("location"), ctx.base).pathname.split("/").pop();
    const downIcs = (await (await get(ctx, `${ctx.base}/cal/${downId}.ics`)).text()).replace(/\r\n /g, "");
    assert.match(downIcs, /could not be checked/);

    // Booked while the feed was readable: the check that ran is on record.
    feed.set(icsFor(weekdayAhead()), 200);
    await new Promise((r) => setTimeout(r, 250)); // past the 200 ms cache window
    const up = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(nineMs + 30 * 60000).toISOString(), // 09:30, outside the feed's 10:00 block
      tz: "UTC",
      guest_name: "Evan",
      guest_email: "evan@example.com",
    });
    assert.equal(up.status, 303);
    const upId = new URL(up.headers.get("location"), ctx.base).pathname.split("/").pop();
    const upIcs = (await (await get(ctx, `${ctx.base}/cal/${upId}.ics`)).text()).replace(/\r\n /g, "");
    assert.match(upIcs, /times were checked against the organizer's external calendar/);

    // Disconnecting later cannot rewrite history: Dana's file still says the
    // check failed, Evan's still says it ran.
    await post(`${ctx.base}/dashboard/calendar/disconnect`, {}, { cookie });
    assert.equal(organizer().calendar, null);
    assert.match((await (await get(ctx, `${ctx.base}/cal/${downId}.ics`)).text()).replace(/\r\n /g, ""), /could not be checked/);
    assert.match((await (await get(ctx, `${ctx.base}/cal/${upId}.ics`)).text()).replace(/\r\n /g, ""), /times were checked against the organizer's external calendar/);

    // A booking made with no connection says so.
    const later = await post(`${ctx.base}/b/${organizer().slug}/book`, {
      start: new Date(nineMs + 60 * 60000).toISOString(), // 10:00? no: 09:00+60min; free slot after disconnect
      tz: "UTC",
      guest_name: "Fay",
      guest_email: "fay@example.com",
    });
    assert.equal(later.status, 303);
    const laterId = new URL(later.headers.get("location"), ctx.base).pathname.split("/").pop();
    assert.match((await (await get(ctx, `${ctx.base}/cal/${laterId}.ics`)).text()).replace(/\r\n /g, ""), /does not check the organizer's external calendars/);

    // A reschedule records the check it actually ran: with no connection, the
    // booking's claim becomes "not checked" for the new time.
    const resched = await post(`${ctx.base}/b/${organizer().slug}/reschedule/${upId}`, {
      start: new Date(nineMs + 90 * 60000).toISOString(),
      tz: "UTC",
    });
    assert.equal(resched.status, 303);
    assert.match((await (await get(ctx, `${ctx.base}/cal/${upId}.ics`)).text()).replace(/\r\n /g, ""), /does not check the organizer's external calendars/);
  } finally {
    await feed.close();
    await ctx.close();
  }
});
