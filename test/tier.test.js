"use strict";

// The paid tier, end to end: limits, expiry, labelling, and server-side
// verification of test payments bound to payment intents. The RPC is stubbed;
// the payment itself is test-USDC on a testnet and is not revenue.

process.env.PAY_TEST_ADDRESS = "0x2f50aa285c060f4a579f2c0256e8b7a754b1205d";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { TRANSFER_TOPIC } = require("../lib/payments");

const RECIPIENT = "0x2f50aa285c060f4a579f2c0256e8b7a754b1205d";
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const DAY = 24 * 3600 * 1000;
const PRICE = 8_000_000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-tier-"));
}

const open = new Set();
test.after(() => Promise.all([...open].map((c) => c.close())));

async function start(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  // The RPC handler is swappable per test so no test ever touches the network.
  let rpcHandler = opts.rpcHandler || (async () => null);
  const app = createApp({ dataDir, mailConfig: null, rpcCall: (method, params) => rpcHandler(method, params) });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const ctx = {
    app,
    store: app.store,
    base: `http://127.0.0.1:${port}`,
    dataDir,
    setRpc: (fn) => (rpcHandler = fn),
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

async function signup(ctx, name = "Ada") {
  const res = await post(`${ctx.base}/signup`, {
    name,
    email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2)}@example.com`,
    password: "correct horse battery",
    timezone: "UTC",
  });
  assert.strictEqual(res.status, 303);
  const cookie = cookieOf(res);
  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie } })).text();
  const slug = dash.match(/\/b\/([a-z0-9]+)<\/span>/)[1];
  return { cookie, slug };
}

// A receipt for a transfer of `amountMinor` test-USDC from `from` to us.
function receiptFor(amountMinor, from = "0x" + "11".repeat(20)) {
  return {
    status: "0x1",
    logs: [{
      address: TOKEN,
      topics: [
        TRANSFER_TOPIC,
        "0x" + "00".repeat(12) + from.slice(2).toLowerCase(),
        "0x" + "00".repeat(12) + RECIPIENT.slice(2),
      ],
      data: "0x" + BigInt(amountMinor).toString(16),
    }],
  };
}

// Walk the two-step upgrade: declare a sending wallet, receive the payment
// instructions, have the stubbed chain confirm an exact-8.000000 transfer from
// that wallet, submit the transaction hash.
async function payFor30Days(ctx, org, { from = "0x" + "11".repeat(20), tx = "0x" + "cd".repeat(32) } = {}) {
  const entry = await (await fetch(`${ctx.base}/upgrade`, { headers: { cookie: org.cookie } })).text();
  assert.ok(entry.toLowerCase().includes("test"), "the upgrade page is labelled test");
  const step1 = await post(`${ctx.base}/upgrade`, { sender: from }, { cookie: org.cookie });
  assert.strictEqual(step1.status, 303, "declaring a sender issues an intent");
  const instructionsUrl = step1.headers.get("location");
  assert.match(instructionsUrl, /^\/upgrade\/[0-9a-f]+$/);
  const page = await (await fetch(`${ctx.base}${instructionsUrl}`, { headers: { cookie: org.cookie } })).text();
  assert.ok(page.includes("8.000000"), "the price is exactly 8.000000 test-USDC, the $8 offer");
  assert.ok(page.includes(from), "the instructions name the declared sending address");
  assert.ok(page.includes(RECIPIENT), "the page names the recipient");
  assert.ok(page.toLowerCase().includes("test"), "the payment instructions are labelled test");
  const intentId = instructionsUrl.split("/")[2];
  ctx.setRpc(async () => receiptFor(PRICE, from));
  const res = await post(`${ctx.base}/upgrade/${intentId}`, { tx }, { cookie: org.cookie });
  return { res, intentId, from, tx };
}

// The create-event-type form fields, Monday 09:00-17:00 UTC.
function typeFields(name, duration = 30) {
  const fields = { event_name: name, duration: String(duration), timezone: "UTC" };
  fields.d1_s = "09:00";
  fields.d1_e = "17:00";
  return fields;
}

test("a free organizer is stopped at one event type, server-side", async () => {
  const ctx = await start();
  const org = await signup(ctx);
  // The second event type is refused even when posted directly.
  const denied = await post(`${ctx.base}/event-types`, typeFields("Second call"), { cookie: org.cookie });
  assert.strictEqual(denied.status, 403);
  const deniedHtml = await denied.text();
  assert.ok(deniedHtml.includes("limit"), "the refusal names the plan limit");
  assert.ok(deniedHtml.includes("/upgrade"), "the refusal points at upgrading");
  const state = ctx.store.state.organizers[0];
  assert.strictEqual(state.eventTypes.length, 1);
  await ctx.close();
});

test("the tier limit holds under concurrent additions, at the store and over HTTP", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Race");
  // Two simultaneous adds on the free limit: the store serializes them and the
  // limit is checked inside the lock, so both are refused.
  const freeResults = await Promise.all([
    ctx.store.addEventType(ctx.store.state.organizers[0].id, { name: "A", durationMinutes: 30 }),
    ctx.store.addEventType(ctx.store.state.organizers[0].id, { name: "B", durationMinutes: 30 }),
  ]);
  assert.strictEqual(freeResults.filter((r) => r.ok).length, 0, "both refused at the free limit");
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 1);

  // Pay, add up to the paid limit of three, then race two more: exactly the
  // ones that fit inside the lock succeed, none slips past it.
  await payFor30Days(ctx, org);
  await post(`${ctx.base}/event-types`, typeFields("Second"), { cookie: org.cookie });
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 2);
  const race = await Promise.all([
    post(`${ctx.base}/event-types`, typeFields("Third"), { cookie: org.cookie }),
    post(`${ctx.base}/event-types`, typeFields("Fourth"), { cookie: org.cookie }),
    post(`${ctx.base}/event-types`, typeFields("Fifth"), { cookie: org.cookie }),
  ]);
  assert.deepStrictEqual(race.map((r) => r.status).sort(), [303, 403, 403], "only one of the three concurrent adds fits under the limit");
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 3);
  await ctx.close();
});

test("a verified test payment grants 30 days, unlocks three event types, and removes branding", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Pia");
  const { res } = await payFor30Days(ctx, org);
  assert.strictEqual(res.status, 303, "verified payment redirects to the dashboard");
  assert.match(res.headers.get("location"), /upgraded=1/);

  // The grant is recorded with the transaction and the intent, and paid access
  // lasts 30 days.
  const org1 = ctx.store.state.organizers[0];
  assert.strictEqual(ctx.store.state.payments.length, 1);
  assert.strictEqual(ctx.store.state.intents[0].consumedAt !== null, true, "the intent is consumed");
  assert.strictEqual(ctx.store.state.intents[0].txHash, ctx.store.state.payments[0].txHash);
  assert.ok(Math.abs(org1.paidUntil - (Date.now() + 30 * DAY)) < 5000, "paid for 30 days");

  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  assert.ok(dash.includes("not revenue"), "the dashboard says test payments are not revenue");

  // Up to three event types, then the limit again.
  for (const name of ["Second", "Third"]) {
    const ok = await post(`${ctx.base}/event-types`, typeFields(name), { cookie: org.cookie });
    assert.strictEqual(ok.status, 303, `${name} event type accepted while paid`);
  }
  const fourth = await post(`${ctx.base}/event-types`, typeFields("Fourth"), { cookie: org.cookie });
  assert.strictEqual(fourth.status, 403);
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 3);

  // A paid organizer's public pages carry no OpenCalendly branding.
  const page = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(!page.includes("OpenCalendly"), "branding removed from the paid booking page");
  await ctx.close();
});

test("one account cannot redeem another's payment: the intent binds sender and owner", async () => {
  const ctx = await start();
  const alice = await signup(ctx, "Alice");
  const bob = await signup(ctx, "Bob");

  // Alice declares her wallet and pays from it; the chain confirms the transfer.
  const aliceFrom = "0x" + "aa".repeat(20);
  const hash = "0x" + "b7".repeat(32);
  const paid = await payFor30Days(ctx, alice, { from: aliceFrom, tx: hash });
  // Simulate the real order of events: the transfer exists only once Alice
  // actually pays, so the RPC only starts answering after her instructions.
  ctx.setRpc(async () => receiptFor(PRICE, aliceFrom));
  assert.strictEqual(paid.res.status, 303);
  const aliceIntentId = paid.intentId;

  // Bob cannot redeem Alice's transaction under his own intent: the transfer's
  // sender is Alice's declared address, not Bob's.
  const bobFrom = "0x" + "bb".repeat(20);
  const bobIntent = await post(`${ctx.base}/upgrade`, { sender: bobFrom }, { cookie: bob.cookie });
  assert.strictEqual(bobIntent.status, 303);
  const bobIntentId = bobIntent.headers.get("location").split("/")[2];
  ctx.setRpc(async () => receiptFor(PRICE, aliceFrom));
  const stolen = await post(`${ctx.base}/upgrade/${bobIntentId}`, { tx: hash }, { cookie: bob.cookie });
  assert.strictEqual(stolen.status, 400, "Bob's redemption of Alice's transfer is refused");
  assert.ok((await stolen.text()).includes("declared address"), "the refusal explains the sender binding");
  assert.strictEqual(ctx.store.state.payments.length, 1, "nothing was granted to Bob");
  assert.strictEqual(ctx.store.state.intents.find((i) => i.id === bobIntentId).consumedAt, null, "Bob's intent is untouched");

  // Bob cannot even reach Alice's intent page, let alone consume it: intents
  // belong to the account that created them.
  const foreignGet = await fetch(`${ctx.base}/upgrade/${aliceIntentId}`, { headers: { cookie: bob.cookie }, redirect: "manual" });
  assert.strictEqual(foreignGet.status, 404);
  const foreignPost = await post(`${ctx.base}/upgrade/${aliceIntentId}`, { tx: "0x" + "11".repeat(32) }, { cookie: bob.cookie });
  assert.strictEqual(foreignPost.status, 404);

  // Alice's own redemption still works — her payment is hers alone.
  const aliceSecond = "0x" + "c9".repeat(32);
  const again = await payFor30Days(ctx, alice, { from: aliceFrom, tx: aliceSecond });
  assert.strictEqual(again.res.status, 303);
  assert.strictEqual(ctx.store.state.payments.length, 2);
  await ctx.close();
});

test("the same transaction cannot be redeemed twice, and wrong payments are refused honestly", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Rex");
  const from = "0x" + "11".repeat(20);

  // Wrong amount: refused with an honest message, nothing granted.
  ctx.setRpc(async () => receiptFor(PRICE + 5_000_000, from));
  let intentId;
  {
    const step1 = await post(`${ctx.base}/upgrade`, { sender: from }, { cookie: org.cookie });
    intentId = step1.headers.get("location").split("/")[2];
    const wrongAmount = await post(`${ctx.base}/upgrade/${intentId}`, { tx: "0x" + "aa".repeat(32) }, { cookie: org.cookie });
    assert.strictEqual(wrongAmount.status, 400);
    assert.ok((await wrongAmount.text()).includes("exactly"));
  }

  // No receipt yet (pending): reported, not pretended.
  ctx.setRpc(async () => null);
  const pending = await post(`${ctx.base}/upgrade/${intentId}`, { tx: "0x" + "aa".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(pending.status, 400);
  assert.ok((await pending.text()).includes("confirmed"));

  // A valid payment goes through...
  const hash = "0x" + "bb".repeat(32);
  ctx.setRpc(async () => receiptFor(PRICE, from));
  const paid = await post(`${ctx.base}/upgrade/${intentId}`, { tx: hash }, { cookie: org.cookie });
  assert.strictEqual(paid.status, 303);

  // ...and the same hash cannot grant again — not through the intent (it is
  // consumed) and not through a fresh one (the hash is spent).
  const second = await post(`${ctx.base}/upgrade`, { sender: from }, { cookie: org.cookie });
  const secondIntentId = second.headers.get("location").split("/")[2];
  ctx.setRpc(async () => receiptFor(PRICE, from));
  const replay = await post(`${ctx.base}/upgrade/${secondIntentId}`, { tx: hash }, { cookie: org.cookie });
  assert.strictEqual(replay.status, 400);
  assert.ok((await replay.text()).includes("already been used"));
  assert.strictEqual(ctx.store.state.payments.length, 1);

  // A spent intent cannot be reused with a new hash either.
  ctx.setRpc(async () => receiptFor(PRICE, from));
  const reuse = await post(`${ctx.base}/upgrade/${intentId}`, { tx: "0x" + "ee".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(reuse.status, 410);
  assert.strictEqual(ctx.store.state.payments.length, 1);

  // A valid-looking hash that never happened changes nothing.
  ctx.setRpc(async () => null);
  const fabricated = await post(`${ctx.base}/upgrade/${secondIntentId}`, { tx: "0x" + "ee".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(fabricated.status, 400);
  assert.strictEqual(ctx.store.state.payments.length, 1);
  await ctx.close();
});

test("a stale sending address (transfer from a different wallet than declared) is refused", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Sid");
  const declared = "0x" + "11".repeat(20);
  const step1 = await post(`${ctx.base}/upgrade`, { sender: declared }, { cookie: org.cookie });
  const intentId = step1.headers.get("location").split("/")[2];
  // The transfer is real and exact, but came from another wallet.
  ctx.setRpc(async () => receiptFor(PRICE, "0x" + "99".repeat(20)));
  const res = await post(`${ctx.base}/upgrade/${intentId}`, { tx: "0x" + "aa".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(ctx.store.state.payments.length, 0);
  await ctx.close();
});

test("without a configured recipient the upgrade page offers nothing fake", async () => {
  const saved = process.env.PAY_TEST_ADDRESS;
  delete process.env.PAY_TEST_ADDRESS;
  delete require.cache[require.resolve("../lib/app")];
  const freshApp = require("../lib/app");
  const dataDir = tmpDir();
  const app = freshApp.createApp({ dataDir, mailConfig: null });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const signupRes = await post(`${base}/signup`, { name: "N", email: `n-${Date.now()}@example.com`, password: "correct horse battery", timezone: "UTC" });
    const cookie = cookieOf(signupRes);
    const page = await (await fetch(`${base}/upgrade`, { headers: { cookie } })).text();
    assert.ok(page.includes("not configured"), "the page says test payments are not configured");
    const attempt = await post(`${base}/upgrade`, { sender: "0x" + "11".repeat(20) }, { cookie });
    assert.strictEqual(attempt.status, 400);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    process.env.PAY_TEST_ADDRESS = saved;
    delete require.cache[require.resolve("../lib/app")];
  }
});

test("multiple event types: the public page lists them, bookings record which one, wrong ids fail", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Multi");
  // Pay via a stub so the organizer can have three types.
  const { res: paid } = await payFor30Days(ctx, org);
  assert.strictEqual(paid.status, 303);
  await post(`${ctx.base}/event-types`, typeFields("Long session", 60), { cookie: org.cookie });

  // The public page lists every type.
  const list = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(list.includes("30 minute meeting"), "the first type is listed");
  assert.ok(list.includes("Long session"), "the second type is listed");
  const ids = ctx.store.state.organizers[0].eventTypes.map((t) => t.id);

  // An unknown event type id is a clean 404.
  assert.strictEqual((await fetch(`${ctx.base}/b/${org.slug}?e=nope`)).status, 404);

  // Book on the 60-minute type via its id; the booking records it and uses its duration.
  const typePage = await (await fetch(`${ctx.base}/b/${org.slug}?e=${ids[1]}`)).text();
  const newUrl = typePage.match(/href="(\/b\/[a-z0-9]+\/new\?start=[^"]+)"/)[1].replace(/&/g, "&");
  const formPage = await (await fetch(`${ctx.base}${newUrl}`)).text();
  assert.ok(formPage.includes("Long session"), "the booking form names the chosen type");
  const startIso = formPage.match(/name="start" value="([^"]+)"/)[1];
  const eventId = formPage.match(/name="e" value="([^"]+)"/)[1];
  assert.strictEqual(eventId, ids[1]);
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "UTC", e: eventId, guest_name: "Gwen", guest_email: "gwen@example.com",
  });
  assert.strictEqual(bookRes.status, 303);
  const booking = ctx.store.state.bookings[0];
  assert.strictEqual(booking.eventTypeId, ids[1]);
  assert.strictEqual(booking.endMs - booking.startMs, 60 * 60000, "the 60-minute type's duration applies");
  await ctx.close();
});

test("after expiry the extra types stop being bookable everywhere, and a new payment revives them", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Old");
  await payFor30Days(ctx, org);
  await post(`${ctx.base}/event-types`, typeFields("Second type"), { cookie: org.cookie });
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 2);

  // Time passes: the grant expires. The types remain as data...
  ctx.store.state.organizers[0].paidUntil = Date.now() - 1000;
  const denied = await post(`${ctx.base}/event-types`, typeFields("Third type"), { cookie: org.cookie });
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 2, "expiry deletes nothing");

  // ...but only the first stays bookable: the picker does not list the extra,
  // a direct link to it 404s, and a forged booking POST is refused.
  const public_page = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(public_page.includes("OpenCalendly"), "branding returns after expiry");
  assert.ok(!public_page.includes("Second type"), "the paused type is not listed");
  assert.ok(public_page.includes("30 minute meeting"), "the first type is still bookable");
  const secondId = ctx.store.state.organizers[0].eventTypes[1].id;
  assert.strictEqual((await fetch(`${ctx.base}/b/${org.slug}?e=${secondId}`)).status, 404, "a direct link to a paused type is refused");
  const firstType = ctx.store.state.organizers[0].eventTypes[0];
  const typePage = await (await fetch(`${ctx.base}/b/${org.slug}?e=${firstType.id}`)).text();
  const newUrl = typePage.match(/href="(\/b\/[a-z0-9]+\/new\?start=[^"]+)"/)[1];
  const formPage = await (await fetch(`${ctx.base}${newUrl}`)).text();
  const startIso = formPage.match(/name="start" value="([^"]+)"/)[1];
  const smuggled = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "UTC", e: secondId, guest_name: "Sid", guest_email: "sid@example.com",
  });
  assert.strictEqual(smuggled.status, 404, "the booking POST refuses a paused type");
  assert.strictEqual(ctx.store.state.bookings.length, 0);

  // The dashboard says what happened instead of pretending.
  const dash = await (await fetch(`${ctx.base}/dashboard`, { headers: { cookie: org.cookie } })).text();
  assert.ok(dash.includes("paused"), "the dashboard marks paused types");

  // A new payment revives the paused type; its settings survived. A fresh
  // transaction hash, since the first payment's hash is spent.
  await payFor30Days(ctx, org, { tx: "0x" + "ef".repeat(32) });
  const revived = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(revived.includes("Second type"), "the paused type is bookable again after renewal");
  assert.ok(!revived.includes("OpenCalendly"), "branding is gone again");
  const again = await post(`${ctx.base}/event-types`, typeFields("Third type"), { cookie: org.cookie });
  assert.strictEqual(again.status, 303, "the renewed grant allows the third type again");
  await ctx.close();
});

test("deleting an event type never rewrites the bookings that reference it", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Del");
  await payFor30Days(ctx, org);
  await post(`${ctx.base}/event-types`, typeFields("Long session", 60), { cookie: org.cookie });
  const types = ctx.store.state.organizers[0].eventTypes;
  const longId = types[1].id;

  // Book on "Long session", then delete the type.
  const typePage = await (await fetch(`${ctx.base}/b/${org.slug}?e=${longId}`)).text();
  const newUrl = typePage.match(/href="(\/b\/[a-z0-9]+\/new\?start=[^"]+)"/)[1];
  const formPage = await (await fetch(`${ctx.base}${newUrl}`)).text();
  const startIso = formPage.match(/name="start" value="([^"]+)"/)[1];
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "UTC", e: longId, guest_name: "Gwen", guest_email: "gwen@example.com",
  });
  assert.strictEqual(bookRes.status, 303);
  const confirmedUrl = bookRes.headers.get("location");
  const booking = ctx.store.state.bookings[0];

  await post(`${ctx.base}/event-types/${longId}/delete`, {}, { cookie: org.cookie });
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 1);

  // The confirmation page and the calendar file still describe the event that
  // was booked — neither falls back to the surviving type's name.
  const confirmed = await (await fetch(`${ctx.base}${confirmedUrl}`)).text();
  assert.ok(confirmed.includes("Long session"), "the confirmation keeps the booked event's name");
  const ics = await (await fetch(`${ctx.base}/cal/${booking.id}.ics`)).text();
  assert.ok(ics.includes("Long session"), "the calendar file keeps the booked event's name");
  assert.ok(!ics.includes("30 minute meeting"), "no other event type is substituted");

  // The reschedule page and the cancellation email describe the same event.
  const reschedule = await (await fetch(`${ctx.base}/b/${org.slug}/reschedule/${booking.id}`)).text();
  assert.ok(reschedule.includes("Long session"), "rescheduling keeps the booked event's name");
  await ctx.close();
});

test("tier expiry pauses a type for new bookings but never holds a guest's own booking hostage", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Life");
  await payFor30Days(ctx, org);
  await post(`${ctx.base}/event-types`, typeFields("Second type"), { cookie: org.cookie });
  const secondId = ctx.store.state.organizers[0].eventTypes[1].id;

  // A guest books the (then paid-only) second type.
  const typePage = await (await fetch(`${ctx.base}/b/${org.slug}?e=${secondId}`)).text();
  const newUrl = typePage.match(/href="(\/b\/[a-z0-9]+\/new\?start=[^"]+)"/)[1];
  const formPage = await (await fetch(`${ctx.base}${newUrl}`)).text();
  const startIso = formPage.match(/name="start" value="([^"]+)"/)[1];
  const bookRes = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "UTC", e: secondId, guest_name: "Gwen", guest_email: "gwen@example.com",
  });
  assert.strictEqual(bookRes.status, 303);
  const booking = ctx.store.state.bookings[0];

  // The grant expires. The type is paused for new bookings...
  ctx.store.state.organizers[0].paidUntil = Date.now() - 1000;
  const smuggled = await post(`${ctx.base}/b/${org.slug}/book`, {
    start: startIso, tz: "UTC", e: secondId, guest_name: "Sid", guest_email: "sid@example.com",
  });
  assert.strictEqual(smuggled.status, 404, "expiry still refuses new bookings on the paused type");

  // ...but Step 2's guest lifecycle keeps working on the booking that exists:
  // rescheduling moves it, and cancelling ends it. Expiry must not strand a
  // guest with a booking they can neither move nor leave.
  const reschedulePage = await (await fetch(`${ctx.base}/b/${org.slug}/reschedule/${booking.id}`)).text();
  assert.strictEqual(
    (await fetch(`${ctx.base}/b/${org.slug}/reschedule/${booking.id}`)).status,
    200,
    "the reschedule page still renders for a paused type's booking"
  );
  assert.ok(reschedulePage.includes("Second type"), "the reschedule page keeps the booked event's name");
  const moved = Date.parse(startIso) + 30 * 60000; // the next slot in the same window
  const rescheduled = await post(`${ctx.base}/b/${org.slug}/reschedule/${booking.id}`, {
    start: new Date(moved).toISOString(), tz: "UTC",
  });
  assert.strictEqual(rescheduled.status, 303, "the guest can still reschedule a paused type's booking");
  assert.strictEqual(ctx.store.state.bookings[0].startMs, moved);

  const cancelled = await post(`${ctx.base}/b/${org.slug}/cancel/${booking.id}`, {});
  assert.strictEqual(cancelled.status, 303, "the guest can still cancel a paused type's booking");
  assert.strictEqual(ctx.store.state.bookings[0].status, "cancelled");
  assert.strictEqual(ctx.store.state.bookings.filter((b) => b.status !== "cancelled").length, 0);
  await ctx.close();
});

test("a malformed path is a 400 and the server lives on", async () => {
  const ctx = await start();
  const bad = await fetch(`${ctx.base}/b/%ZZ`, { redirect: "manual" });
  assert.strictEqual(bad.status, 400, "unparseable input is a bad request, not a crash");
  const fine = await fetch(`${ctx.base}/healthz`);
  assert.strictEqual(fine.status, 200, "the server still answers after the malformed request");
  await ctx.close();
});

test("the last event type cannot be deleted; an unknown one 404s", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Del");
  const onlyId = ctx.store.state.organizers[0].eventTypes[0].id;
  const refused = await post(`${ctx.base}/event-types/${onlyId}/delete`, {}, { cookie: org.cookie });
  assert.strictEqual(refused.status, 303);
  assert.match(refused.headers.get("location"), /error=/);
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 1);
  const missing = await post(`${ctx.base}/event-types/deadbeef/delete`, {}, { cookie: org.cookie });
  assert.strictEqual(missing.status, 303);
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 1);
  await ctx.close();
});

test("a state file from before event types restores with the event migrated and bookings snapshotted", async () => {
  const dataDir = tmpDir();
  // A Step 1-shaped state: one organizer with a single `event`, one booking.
  const legacy = {
    meta: { version: 1, sessionSecret: "s".repeat(64) },
    organizers: [{
      id: "abc123", name: "Legacy", email: "legacy@example.com", passwordHash: "00", salt: "00",
      slug: "legacyslug", timezone: "UTC",
      event: { name: "Intro call", durationMinutes: 30, availability: { 1: [{ s: "09:00", e: "17:00" }] } },
      createdAt: 1700000000000,
    }],
    bookings: [{ id: "bk1", organizerId: "abc123", startMs: 1700000000000 + 86400000, endMs: 1700000000000 + 86400000 + 1800000, guestName: "Old Guest", guestEmail: "old@example.com", guestNote: "", createdAt: 1700000000000 }],
    outbox: [],
  };
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify(legacy));
  const ctx = await start({ dataDir });
  const organizer = ctx.store.state.organizers[0];
  assert.strictEqual(organizer.eventTypes.length, 1, "the single event became one event type");
  assert.strictEqual(organizer.eventTypes[0].name, "Intro call");
  assert.strictEqual(organizer.event, undefined, "no dual source of truth");
  // The legacy booking carries the migrated type's id and a snapshot, so its
  // pages no longer depend on whichever type happens to be first.
  assert.strictEqual(ctx.store.state.bookings[0].eventTypeId, organizer.eventTypes[0].id);
  assert.strictEqual(ctx.store.state.bookings[0].eventType.name, "Intro call");
  // The migrated organizer still serves bookings with the restored availability.
  const page = await (await fetch(`${ctx.base}/b/legacyslug`)).text();
  assert.ok(page.includes("Intro call"));
  assert.ok(page.includes("Legacy"));
  await ctx.close();
});
