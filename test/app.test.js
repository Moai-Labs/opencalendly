"use strict";

// End-to-end tests: the whole booking flow over real HTTP on a loopback port.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const views = require("../lib/views");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-app-"));
}

const open = new Set();
test.after(() => Promise.all([...open].map((c) => c.close())));

async function start(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const app = createApp({ dataDir, mailConfig: null });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    app,
    store: app.store,
    base,
    dataDir,
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
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

// Sign up an organizer and return { slug, cookie, timezone }.
async function signup(ctx, { timezone = "UTC", name = "Ada" } = {}) {
  const res = await post(`${ctx.base}/signup`, {
    name,
    email: `ada-${Math.random().toString(36).slice(2)}@example.com`,
    password: "correct horse battery",
    timezone,
  });
  assert.strictEqual(res.status, 303, "signup redirects to the dashboard");
  const cookie = cookieOf(res);
  assert.match(cookie, /^oc_session=/);
  const dash = await fetch(`${ctx.base}/dashboard`, { headers: { cookie }, redirect: "manual" });
  const html = await dash.text();
  const shareMatch = html.match(/(http:\/\/[\w.:-]+)\/b\/([a-z0-9]+)<\/span>/);
  assert.ok(shareMatch, "dashboard shows the share link");
  return { cookie, slug: shareMatch[2], baseUrl: shareMatch[1], timezone };
}

// The ISO start of the first open slot on the booking page.
async function firstSlotStart(ctx, slug, tz = "UTC") {
  const res = await fetch(`${ctx.base}/b/${slug}?tz=${encodeURIComponent(tz)}`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  const match = html.match(/\/b\/[a-z0-9]+\/new\?start=([^&"]+)/);
  assert.ok(match, "booking page lists an open slot");
  return decodeURIComponent(match[1]);
}

test("a guest books a slot without an account and gets confirmation, both time zones shown", async () => {
  const ctx = await start();
  const org = await signup(ctx, { timezone: "Europe/Berlin" });

  // Availability form: Mon 09:00-17:00 Berlin time only.
  const fields = { event_name: "Intro call", duration: "30", timezone: "Europe/Berlin" };
  for (let dow = 1; dow <= 7; dow++) {
    if (dow === 1) {
      fields[`d${dow}_s`] = "09:00";
      fields[`d${dow}_e`] = "17:00";
    }
  }
  const saved = await post(`${ctx.base}/availability`, fields, { cookie: org.cookie });
  assert.strictEqual(saved.status, 303);

  // The public page shows both zones beside every slot.
  const page = await fetch(`${ctx.base}/b/${org.slug}?tz=America/New_York`);
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes("Europe/Berlin"), "organizer zone shown");
  assert.ok(pageHtml.includes("America/New_York"), "guest zone shown");
  assert.ok(pageHtml.includes("do not check external calendars"), "the external-calendar note is shown");

  const startIso = await firstSlotStart(ctx, org.slug, "America/New_York");
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso,
    tz: "America/New_York",
    guest_name: "Grace Guest",
    guest_email: "grace@example.com",
    guest_note: "Looking forward to it",
  });
  assert.strictEqual(bookRes.status, 303, "booking succeeds");
  const confirmUrl = bookRes.headers.get("location");
  assert.match(confirmUrl, /\/b\/[a-z0-9]+\/confirmed\/[0-9a-f]+/);

  const confirm = await fetch(`${ctx.base}${confirmUrl}`);
  const confirmHtml = await confirm.text();
  assert.ok(confirmHtml.includes("Grace Guest"), "confirmation names the guest");
  assert.ok(confirmHtml.includes("America/New_York"), "confirmation shows the guest zone");
  assert.ok(confirmHtml.includes("Europe/Berlin"), "confirmation shows the organizer zone");
  assert.ok(confirmHtml.includes("/cal/"), "calendar file linked from the confirmation");

  // The slot is gone from the public page now.
  const after = await (await fetch(`${ctx.base}/b/${org.slug}?tz=UTC`)).text();
  assert.ok(!after.includes(`start=${encodeURIComponent(startIso)}`), "booked slot no longer offered");

  // Emails are queued honestly, not pretended.
  const queued = ctx.store.state.outbox;
  assert.strictEqual(queued.length, 2);
  assert.ok(queued.some((e) => e.to === "grace@example.com" && e.status === "queued" && e.text.includes("external calendars")));
  assert.ok(queued.some((e) => e.subject.startsWith("New booking")));

  // The organizer sees the booking on the dashboard.
  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  assert.ok(dash.includes("Grace Guest"));
  assert.ok(dash.includes("queued"), "dashboard reports the queued email");
});

test("the same slot cannot be booked twice, even by simultaneous requests", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const startIso = await firstSlotStart(ctx, org.slug);

  const attempts = await Promise.all([
    post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "One", guest_email: "one@example.com" }),
    post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "Two", guest_email: "two@example.com" }),
  ]);
  const statuses = attempts.map((r) => r.status).sort();
  assert.deepStrictEqual(statuses, [303, 409], "exactly one booking wins; the other is told the slot is gone");
  const conflictBody = await (await attempts.find((r) => r.status === 409)).text();
  assert.ok(conflictBody.includes("just taken"));
  assert.strictEqual(ctx.store.state.bookings.length, 1);
});

test("fabricated or overlapping slot times are rejected", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const startIso = await firstSlotStart(ctx, org.slug);
  const startMs = Date.parse(startIso);

  // Mid-slot: real bookings only start on generated slot boundaries.
  const midSlot = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: new Date(startMs + 15 * 60000).toISOString(), tz: "UTC",
    guest_name: "Mid", guest_email: "mid@example.com",
  });
  assert.strictEqual(midSlot.status, 409);

  // In the past.
  const past = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), tz: "UTC",
    guest_name: "Past", guest_email: "past@example.com",
  });
  assert.strictEqual(past.status, 409);

  // A real slot, booked twice sequentially.
  assert.strictEqual((await post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "A", guest_email: "a@example.com" })).status, 303);
  assert.strictEqual((await post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "B", guest_email: "b@example.com" })).status, 409);
  assert.strictEqual(ctx.store.state.bookings.length, 1);
});

test("each booking has a calendar file with UTC times and the honest note", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const startIso = await firstSlotStart(ctx, org.slug);
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "Grace", guest_email: "grace@example.com" });
  assert.strictEqual(bookRes.status, 303);
  const match = bookRes.headers.get("location").match(/confirmed\/([0-9a-f]+)/);

  const icsRes = await fetch(`${ctx.base}/cal/${match[1]}.ics`);
  assert.strictEqual(icsRes.status, 200);
  assert.match(icsRes.headers.get("content-type"), /text\/calendar/);
  // Unfold the RFC 5545 line folding before matching phrases.
  const ics = (await icsRes.text()).replace(/\r\n /g, "");
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/m);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(ics, new RegExp(`DTSTART:${startIso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`));
  assert.match(ics, /external calendars are not checked/);
  assert.match(ics, /UID:[0-9a-f]+@opencalendly/);
});

test("state restores across a restart: bookings persist, logins survive, the booked slot stays gone", async () => {
  const dataDir = tmpDir();
  const ctx = await start({ dataDir });
  const org = await signup(ctx);
  const startIso = await firstSlotStart(ctx, org.slug);
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "Grace", guest_email: "grace@example.com" });
  assert.strictEqual(bookRes.status, 303);
  const bookingId = bookRes.headers.get("location").match(/confirmed\/([0-9a-f]+)/)[1];
  await ctx.close();

  const ctx2 = await start({ dataDir });
  assert.strictEqual(ctx2.store.state.organizers.length, 1);
  assert.strictEqual(ctx2.store.state.bookings.length, 1);
  assert.strictEqual(ctx2.store.findBooking(bookingId).guestName, "Grace");

  // The same session cookie still works (secret survived), and the dashboard lists the booking.
  const dashRes = await fetch(`${ctx2.base}/dashboard`, { headers: { cookie: org.cookie } });
  assert.strictEqual(dashRes.status, 200);
  const dash = await dashRes.text();
  assert.ok(dash.includes("Grace"));

  // The public page no longer offers the booked slot.
  const page = await (await fetch(`${ctx2.base}/b/${org.slug}?tz=UTC`)).text();
  assert.ok(!page.includes(`start=${encodeURIComponent(startIso)}`));

  // And the flow still works after restore: another slot can be booked.
  const startIso2 = await firstSlotStart(ctx2, org.slug);
  assert.notStrictEqual(startIso2, startIso);
  const again = await post(`${ctx2.base}/b/${org.slug}/book`, { start: startIso2, tz: "UTC", guest_name: "Ida", guest_email: "ida@example.com" });
  assert.strictEqual(again.status, 303);
});

test("organizer pages are private without a session", async () => {
  const ctx = await start();
  await signup(ctx);
  const dash = await fetch(`${ctx.base}/dashboard`, { redirect: "manual" });
  assert.strictEqual(dash.status, 303);
  assert.strictEqual(dash.headers.get("location"), "/login");
  const availability = await post(`${ctx.base}/availability`, { event_name: "x", duration: "30", timezone: "UTC" });
  assert.strictEqual(availability.status, 303);
  assert.strictEqual(availability.headers.get("location"), "/login");
});

test("wrong credentials are refused; a session is not guessable", async () => {
  const ctx = await start();
  await signup(ctx, { name: "Ada" });
  const bad = await post(`${ctx.base}/login`, { email: "someone@example.com", password: "nope" });
  assert.strictEqual(bad.status, 401);
  // A forged cookie value is not a session.
  const forged = await fetch(`${ctx.base}/dashboard`, { headers: { cookie: "oc_session=eyJpZCI6Inh9.fake" }, redirect: "manual" });
  assert.strictEqual(forged.status, 303);
});

test("unknown slugs, unknown pages and bad input fail cleanly", async () => {
  const ctx = await start();
  assert.strictEqual((await fetch(`${ctx.base}/b/nosuchslug`)).status, 404);
  assert.strictEqual((await fetch(`${ctx.base}/no/such/page`)).status, 404);
  assert.strictEqual((await fetch(`${ctx.base}/cal/deadbeef.ics`)).status, 404);
  // Signup with a weak password is refused.
  const weak = await post(`${ctx.base}/signup`, { name: "X", email: "x@example.com", password: "short", timezone: "UTC" });
  assert.strictEqual(weak.status, 400);
  // Booking with a broken email is refused.
  const org = await signup(ctx);
  const startIso = await firstSlotStart(ctx, org.slug);
  const badEmail = await post(`${ctx.base}/b/${org.slug}/book`, { start: startIso, tz: "UTC", guest_name: "G", guest_email: "not-an-email" });
  assert.strictEqual(badEmail.status, 400);
  // An invalid tz parameter falls back to the organizer's zone rather than crashing.
  const page = await fetch(`${ctx.base}/b/${org.slug}?tz=../etc/passwd`);
  assert.strictEqual(page.status, 200);
});

test("health endpoint responds", async () => {
  const ctx = await start();
  const res = await fetch(`${ctx.base}/healthz`);
  assert.strictEqual(res.status, 200);
});

