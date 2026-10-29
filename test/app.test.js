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
  assert.ok(pageHtml.includes("nothing external is checked"), "the external-calendar note is shown");

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
  assert.match(ics, /does not check the organizer's external calendars/);
  assert.match(ics, /UID:[0-9a-f]+@opencalendly/);
});

test("the calendar file speaks the guest's zone, not the organizer's", async () => {
  const ctx = await start();
  const org = await signup(ctx); // organizer stays in UTC
  const startIso = await firstSlotStart(ctx, org.slug);
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "America/New_York", guest_name: "Grace", guest_email: "grace@example.com",
  });
  assert.strictEqual(bookRes.status, 303);
  const id = bookRes.headers.get("location").match(/confirmed\/([0-9a-f]+)/)[1];
  const unfold = (t) => t.replace(/\r\n /g, "");

  // No tz on the link: the zone the guest booked in is used.
  const ics = unfold(await (await fetch(`${ctx.base}/cal/${id}.ics`)).text());
  assert.match(ics, /Your time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(America\/New_York\)/);
  assert.match(ics, /Organizer time: .+ \(UTC\)/);

  // An explicit tz on the link still wins over the stored zone.
  const forced = unfold(await (await fetch(`${ctx.base}/cal/${id}.ics?tz=Asia/Tokyo`)).text());
  assert.match(forced, /Your time: .+ \(Asia\/Tokyo\)/);

  await ctx.close();
});

test("the dashboard's copy points the right way and states the calendar truth", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  // The link section sits above the bookings table, so the empty-table copy points up.
  assert.match(dash, /Your booking link is above/);
  assert.doesNotMatch(dash, /Share your link below/);
  // One truth about external calendars, organizer-facing.
  assert.match(dash, /No external calendar is connected, so nothing external is checked/);
  assert.match(dash, /checked only when one is connected/);
  assert.doesNotMatch(dash, /We do not check external calendars/);
  await ctx.close();
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


// --- Step 2: cancel, reschedule, export, delete ------------------------------

// Every open slot's ISO start, in page order.
async function slotStarts(ctx, slug, tz = "UTC") {
  const res = await fetch(`${ctx.base}/b/${slug}?tz=${encodeURIComponent(tz)}`);
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  const starts = [...text.matchAll(/\/b\/[a-z0-9]+\/new\?start=([^&"]+)/g)].map((m) => decodeURIComponent(m[1]));
  assert.ok(starts.length >= 3, "the page offers at least three slots");
  return starts;
}

// Book one slot for a guest; returns the booking id.
async function book(ctx, slug, startIso, guest = { name: "Grace Guest", email: "grace@example.com" }) {
  const res = await post(`${ctx.base}/b/${slug}/book`, {
    start: startIso, tz: "UTC", guest_name: guest.name, guest_email: guest.email,
  });
  assert.strictEqual(res.status, 303, "booking succeeds");
  const match = res.headers.get("location").match(/\/confirmed\/([0-9a-f]+)/);
  assert.ok(match);
  return match[1];
}

test("a guest cancels from their confirmation and the slot opens again", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const [taken] = await slotStarts(ctx, org.slug);
  const id = await book(ctx, org.slug, taken);

  // The confirmation page offers both actions.
  const confirmHtml = await (await fetch(`${ctx.base}/b/${org.slug}/confirmed/${id}`)).text();
  assert.ok(confirmHtml.includes(`/b/${org.slug}/cancel/${id}`), "cancel linked from the confirmation");
  assert.ok(confirmHtml.includes(`/b/${org.slug}/reschedule/${id}`), "reschedule linked from the confirmation");

  // The cancel link asks first.
  const ask = await fetch(`${ctx.base}/b/${org.slug}/cancel/${id}`);
  assert.strictEqual(ask.status, 200);
  assert.ok((await ask.text()).includes("Cancel this booking?"));

  const cancel = await post(`${ctx.base}/b/${org.slug}/cancel/${id}`, { tz: "UTC" });
  assert.strictEqual(cancel.status, 303);
  const gone = await (await fetch(`${ctx.base}/b/${org.slug}/cancelled/${id}`)).text();
  assert.ok(gone.includes("Booking cancelled"));

  // The confirmation link now tells the truth too.
  const confirmAfter = await (await fetch(`${ctx.base}/b/${org.slug}/confirmed/${id}`)).text();
  assert.ok(confirmAfter.includes("This booking was cancelled"));
  assert.ok(!confirmAfter.includes("/cancel/"), "a cancelled booking offers no further actions");

  // The freed slot is offered again, and the calendar file says cancelled.
  const page = await (await fetch(`${ctx.base}/b/${org.slug}?tz=UTC`)).text();
  assert.ok(page.includes(`start=${encodeURIComponent(taken)}`), "the freed slot is bookable again");
  const ics = await (await fetch(`${ctx.base}/cal/${id}.ics`)).text();
  assert.ok(ics.includes("STATUS:CANCELLED"));

  // Both sides are told.
  const queued = ctx.store.state.outbox.filter((e) => /cancelled/i.test(e.subject));
  assert.strictEqual(queued.length, 2);
  assert.ok(queued.some((e) => e.to === "grace@example.com" && e.text.includes("slot is free again")));
  assert.ok(queued.some((e) => e.to === ctx.store.findOrganizerBySlug(org.slug).email));

  // Cancelling twice stays calm instead of erroring.
  const again = await post(`${ctx.base}/b/${org.slug}/cancel/${id}`, { tz: "UTC" });
  assert.strictEqual(again.status, 303);
});

test("a guest reschedules; a slot another guest just took is refused with the picker shown", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const [first, second, third] = await slotStarts(ctx, org.slug);
  const id = await book(ctx, org.slug, first);
  await book(ctx, org.slug, second, { name: "Other Guest", email: "other@example.com" });

  const page = await fetch(`${ctx.base}/b/${org.slug}/reschedule/${id}?tz=UTC`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes("Move your booking"));

  // The target slot was just taken by the other guest.
  const clash = await post(`${ctx.base}/b/${org.slug}/reschedule/${id}`, { start: second, tz: "UTC" });
  assert.strictEqual(clash.status, 409);
  assert.ok((await clash.text()).includes("just taken"));
  assert.strictEqual(ctx.store.findBooking(id).startMs, Date.parse(first), "the booking did not move");

  // A free slot works; the old one opens up.
  const ok = await post(`${ctx.base}/b/${org.slug}/reschedule/${id}`, { start: third, tz: "UTC" });
  assert.strictEqual(ok.status, 303);
  assert.match(ok.headers.get("location"), /rescheduled=1/);
  const moved = await (await fetch(`${ctx.base}/b/${org.slug}/confirmed/${id}?tz=UTC&rescheduled=1`)).text();
  assert.ok(moved.includes("Booking moved"));
  const publicPage = await (await fetch(`${ctx.base}/b/${org.slug}?tz=UTC`)).text();
  assert.ok(publicPage.includes(`start=${encodeURIComponent(first)}`), "the old slot is bookable again");

  // Both sides are told, with the previous time included.
  const queued = ctx.store.state.outbox.filter((e) => /rescheduled/i.test(e.subject));
  assert.strictEqual(queued.length, 2);
  assert.ok(queued.every((e) => e.text.includes("Was:")), "both emails show the previous time");

  // Re-picking the slot the booking already holds is a calm no-op.
  const own = await post(`${ctx.base}/b/${org.slug}/reschedule/${id}`, { start: third, tz: "UTC" });
  assert.strictEqual(own.status, 303);

  // A cancelled booking cannot be rescheduled.
  await post(`${ctx.base}/b/${org.slug}/cancel/${id}`, { tz: "UTC" });
  const dead = await post(`${ctx.base}/b/${org.slug}/reschedule/${id}`, { start: third, tz: "UTC" });
  assert.strictEqual(dead.status, 409);
});

test("the reschedule race over HTTP: a reschedule and another guest's booking fight for one slot", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const [, a, b] = await slotStarts(ctx, org.slug);
  const id = await book(ctx, org.slug, a, { name: "One", email: "one@example.com" });

  const [bookRes, moveRes] = await Promise.all([
    post(`${ctx.base}/b/${org.slug}/book`, { start: b, tz: "UTC", guest_name: "Two", guest_email: "two@example.com" }),
    post(`${ctx.base}/b/${org.slug}/reschedule/${id}`, { start: b, tz: "UTC" }),
  ]);
  const statuses = [bookRes.status, moveRes.status].sort();
  assert.deepStrictEqual(statuses, [303, 409], "exactly one of the two requests wins");

  // Whatever won, exactly one active booking holds slot b.
  const target = Date.parse(b);
  const holders = ctx.store.state.bookings.filter(
    (x) => x.status !== "cancelled" && x.startMs < target + 30 * 60000 && target < x.endMs
  );
  assert.strictEqual(holders.length, 1);
  assert.strictEqual(ctx.store.findBooking(id).status, "confirmed", "the moving booking still exists");
});

test("organizer cancel, export and account deletion close the data loop", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  const [taken] = await slotStarts(ctx, org.slug);
  const id = await book(ctx, org.slug, taken);

  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  assert.ok(dash.includes("/dashboard/cancel/"), "the dashboard offers cancel");
  assert.ok(dash.includes("/dashboard/export"), "the dashboard offers export");
  assert.ok(dash.includes("/dashboard/delete"), "the dashboard offers deletion");

  const cancelled = await post(`${ctx.base}/dashboard/cancel/${id}`, {}, { cookie: org.cookie });
  assert.strictEqual(cancelled.status, 303);
  assert.strictEqual(ctx.store.findBooking(id).status, "cancelled");
  const dashAfter = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  assert.ok(!dashAfter.includes(`/dashboard/cancel/${id}`), "the cancelled booking leaves the upcoming list");

  // The export is the organizer's own data, without password material.
  const exportRes = await fetch(`${ctx.base}/dashboard/export`, { headers: { cookie: org.cookie } });
  assert.strictEqual(exportRes.status, 200);
  assert.match(exportRes.headers.get("content-disposition"), /attachment/);
  const exported = await exportRes.json();
  assert.strictEqual(exported.organizer.slug, org.slug);
  assert.strictEqual(exported.bookings.length, 1);
  assert.strictEqual(exported.bookings[0].status, "cancelled");
  assert.ok(!JSON.stringify(exported).includes("passwordHash"), "no password hash in the export");

  // Deletion asks for the password and refuses a wrong one.
  const deletePage = await fetch(`${ctx.base}/dashboard/delete`, { headers: { cookie: org.cookie } });
  assert.strictEqual(deletePage.status, 200);
  const wrong = await post(`${ctx.base}/dashboard/delete`, { password: "not the password" }, { cookie: org.cookie });
  assert.strictEqual(wrong.status, 401);
  assert.strictEqual(ctx.store.state.organizers.length, 1, "nothing was deleted");

  const right = await post(`${ctx.base}/dashboard/delete`, { password: "correct horse battery" }, { cookie: org.cookie });
  assert.strictEqual(right.status, 303);
  assert.match(right.headers.get("set-cookie"), /oc_session=;/, "the session is cleared");
  assert.strictEqual(ctx.store.state.organizers.length, 0);

  // The public page is gone, the guest's links answer honestly without data,
  // and the export route no longer exists for anyone.
  assert.strictEqual((await fetch(`${ctx.base}/b/${org.slug}`)).status, 404);
  const ghost = await (await fetch(`${ctx.base}/b/${org.slug}/confirmed/${id}`)).text();
  assert.ok(ghost.includes("Booking cancelled"));
  assert.ok(ghost.includes("account was deleted"), "the guest is told the data is gone");
  assert.ok(!ghost.includes("grace@example.com"), "the guest's own data is gone too");
  const exportGone = await fetch(`${ctx.base}/dashboard/export`, { headers: { cookie: org.cookie }, redirect: "manual" });
  assert.strictEqual(exportGone.status, 303, "the deleted organizer's session leads back to login");
});
