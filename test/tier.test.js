"use strict";

// The paid tier, end to end: limits, labelling, and server-side verification
// of test payments. The RPC is stubbed; the payment itself is test-USDC on a
// testnet and is not revenue.

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

// A valid receipt for the exact amount the upgrade page asked for.
function receiptFor(amountMinor) {
  return {
    status: "0x1",
    logs: [{
      address: TOKEN,
      topics: [
        TRANSFER_TOPIC,
        "0x" + "00".repeat(12) + "1111111111111111111111111111111111111111",
        "0x" + "00".repeat(12) + RECIPIENT.slice(2),
      ],
      data: "0x" + amountMinor.toString(16),
    }],
  };
}

// Walk the upgrade page and pay: parse the reference the page issued, have the
// stubbed chain confirm a transfer of that exact amount, submit the hash.
async function payFor30Days(ctx, org) {
  const page = await (await fetch(`${ctx.base}/upgrade`, { headers: { cookie: org.cookie } })).text();
  const ref = Number(page.match(/name="ref" value="(\d+)"/)[1]);
  const amountMinor = 8_000_000 + ref;
  assert.ok(page.includes("8." + String(ref).padStart(6, "0")), "page asks for the exact amount with the reference");
  assert.ok(page.toLowerCase().includes("test"), "the payment page is labelled test");
  assert.ok(page.includes(RECIPIENT), "the page names the recipient");
  ctx.setRpc(async () => receiptFor(amountMinor));
  const res = await post(`${ctx.base}/upgrade`, { ref: String(ref), tx: "0x" + "cd".repeat(32) }, { cookie: org.cookie });
  return { res, ref, amountMinor };
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

test("a verified test payment grants 30 days, unlocks three event types, and removes branding", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Pia");
  const { res, ref, amountMinor } = await payFor30Days(ctx, org);
  assert.strictEqual(res.status, 303, "verified payment redirects to the dashboard");
  assert.match(res.headers.get("location"), /upgraded=1/);

  // The grant is recorded with the transaction, and paid access lasts 30 days.
  const org1 = ctx.store.state.organizers[0];
  assert.strictEqual(ctx.store.state.payments.length, 1);
  assert.ok(Math.abs(org1.paidUntil - (Date.now() + 30 * DAY)) < 5000, "paid for 30 days");
  assert.strictEqual(ctx.store.state.payments[0].ref, ref);

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

  // A paid organizer's public page carries no OpenCalendly branding.
  const page = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(!page.includes("OpenCalendly"), "branding removed from the paid booking page");
  await ctx.close();
});

test("the same transaction cannot be redeemed twice, and wrong payments are refused honestly", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Rex");

  // Wrong amount: refused with an honest message, nothing granted.
  ctx.setRpc(async () => receiptFor(8_000_000 + 5_000_000));
  const wrongAmount = await post(`${ctx.base}/upgrade`, { ref: "1", tx: "0x" + "aa".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(wrongAmount.status, 400);
  assert.ok((await wrongAmount.text()).includes("exact amount"));

  // No receipt yet (pending): reported, not pretended.
  ctx.setRpc(async () => null);
  const pending = await post(`${ctx.base}/upgrade`, { ref: "1", tx: "0x" + "aa".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(pending.status, 400);
  assert.ok((await pending.text()).includes("confirmed"));

  // A valid payment goes through...
  const hash = "0x" + "bb".repeat(32);
  ctx.setRpc(async () => receiptFor(8_000_001)); // ref 1
  const paid = await post(`${ctx.base}/upgrade`, { ref: "1", tx: hash }, { cookie: org.cookie });
  assert.strictEqual(paid.status, 303);
  // ...and the same hash cannot grant again, for anyone.
  const org2 = await signup(ctx, "Sue");
  const replay = await post(`${ctx.base}/upgrade`, { ref: "1", tx: hash }, { cookie: org2.cookie });
  assert.strictEqual(replay.status, 400);
  assert.ok((await replay.text()).includes("already been used"));
  assert.strictEqual(ctx.store.state.payments.length, 1);
  // And a valid-looking hash that never happened changes nothing.
  ctx.setRpc(async () => null);
  const fabricated = await post(`${ctx.base}/upgrade`, { ref: "2", tx: "0x" + "ee".repeat(32) }, { cookie: org.cookie });
  assert.strictEqual(fabricated.status, 400);
  assert.strictEqual(ctx.store.state.payments.length, 1);
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
    const attempt = await post(`${base}/upgrade`, { ref: "1", tx: "0x" + "aa".repeat(32) }, { cookie });
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

  // The public page now lists both event types.
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

test("an expired test subscription drops the tier back to free limits, without touching existing types", async () => {
  const ctx = await start();
  const org = await signup(ctx, "Old");
  await payFor30Days(ctx, org);
  await post(`${ctx.base}/event-types`, typeFields("Second type"), { cookie: org.cookie });
  assert.strictEqual(ctx.store.state.organizers[0].eventTypes.length, 2);

  // Time passes: the grant expires.
  ctx.store.state.organizers[0].paidUntil = Date.now() - 1000;
  const denied = await post(`${ctx.base}/event-types`, typeFields("Third type"), { cookie: org.cookie });
  assert.strictEqual(denied.status, 403);
  // Existing event types keep working; nothing disappears on anyone.
  const list = await (await fetch(`${ctx.base}/b/${org.slug}`)).text();
  assert.ok(list.includes("Second type"), "existing types survive expiry");
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

test("a state file from before event types restores with the event migrated", async () => {
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
  // The migrated organizer still serves bookings with the restored availability.
  const page = await (await fetch(`${ctx.base}/b/legacyslug`)).text();
  assert.ok(page.includes("Intro call"));
  assert.ok(page.includes("Legacy"));
  await ctx.close();
});
