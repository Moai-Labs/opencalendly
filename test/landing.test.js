"use strict";

// The public landing page and the live demo it advertises: the seeded demo
// organizer's booking page must be bookable end-to-end, exactly like any
// organizer's page, and the landing page must never link a demo that is not
// there.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-landing-"));
}

const open = new Set();
test.after(() => Promise.all([...open].map((c) => c.close())));

async function start(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const app = createApp({ dataDir, mailConfig: null, ...opts });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const ctx = { app, store: app.store, base, dataDir, close: () => { open.delete(ctx); return new Promise((r) => app.server.close(r)); } };
  open.add(ctx);
  return ctx;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

async function post(url, fields) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
    redirect: "manual",
  });
}

// The ISO start of the first open slot on a booking page.
async function firstSlotStart(base, slug) {
  const res = await fetch(`${base}/b/${slug}?tz=UTC`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // The page's slot links escape the & before tz.
  const match = html.match(new RegExp(`/b/${slug}/new\\?start=([^&"]+)&amp;tz=UTC`));
  assert.ok(match, "the page offers a bookable slot");
  return decodeURIComponent(match[1]);
}

test("landing page advertises the live demo only when it exists", async () => {
  const ctx = await start({ seedDemo: true });
  const html = await (await fetch(`${ctx.base}/`)).text();
  assert.match(html, /Try it now — a live demo/);
  assert.match(html, /href="\/b\/demo"/);
  assert.match(html, /What this checks — and what it does not/);
  assert.match(html, /test-USDC/);
  assert.match(html, /href="\/signup"/);
  // One truth about external calendars, stated conditionally — never as an
  // unconditional "we check" or "we do not check".
  assert.match(html, /External calendars — checked only when connected/);
  assert.match(html, /With no calendar\s+connected, nothing external is checked/);
  assert.doesNotMatch(html, /read-only checking of one external calendar, which hides/);
  assert.doesNotMatch(html, /We do not check external calendars/);

  const noDemo = await start();
  const plain = await (await fetch(`${noDemo.base}/`)).text();
  assert.doesNotMatch(plain, /\/b\/demo/, "no demo link without a demo organizer");
  const alias = await fetch(`${noDemo.base}/demo`, { redirect: "manual" });
  assert.strictEqual(alias.status, 303);
  assert.strictEqual(alias.headers.get("location"), "/");
  await noDemo.close();
  await ctx.close();
});

test("the demo booking page is a real page with a demo banner", async () => {
  const ctx = await start({ seedDemo: true });
  const res = await fetch(`${ctx.base}/b/demo?tz=UTC`);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /This is the live demo/);
  assert.match(html, /Intro call/);
  assert.match(html, /UTC/);
  await ctx.close();
});

test("the /demo alias redirects to the demo booking page", async () => {
  const ctx = await start({ seedDemo: true });
  const res = await fetch(`${ctx.base}/demo`, { redirect: "manual" });
  assert.strictEqual(res.status, 303);
  assert.strictEqual(res.headers.get("location"), "/b/demo");
  await ctx.close();
});

test("a guest can book the demo end to end", async () => {
  const ctx = await start({ seedDemo: true });
  const slotStart = await firstSlotStart(ctx.base, "demo");
  const formPage = await (await fetch(`${ctx.base}/b/demo/new?start=${encodeURIComponent(slotStart)}&tz=UTC`)).text();
  assert.match(formPage, /This is the live demo/);
  const e = formPage.match(/name="e" value="([^"]+)"/);
  assert.ok(e, "the form carries the event type");
  const booked = await post(`${ctx.base}/b/demo/book`, {
    start: slotStart,
    tz: "UTC",
    e: e[1],
    guest_name: "Dana Guest",
    guest_email: "dana@example.com",
  });
  assert.strictEqual(booked.status, 303, "the demo booking is accepted");
  const confirmed = await (await fetch(`${ctx.base}${booked.headers.get("location")}`)).text();
  assert.match(confirmed, /Dana Guest/);
  assert.match(confirmed, /demo/, "the confirmation shows the demo page it belongs to");
  const icsMatch = confirmed.match(/\/cal\/[a-f0-9]+\.ics/);
  assert.ok(icsMatch, "the confirmation links a calendar file");
  assert.strictEqual((await fetch(`${ctx.base}${icsMatch[0]}`)).status, 200);
  // The slot is gone afterwards: a second booking of the same slot is refused.
  const again = await post(`${ctx.base}/b/demo/book`, {
    start: slotStart,
    tz: "UTC",
    e: e[1],
    guest_name: "Second Guest",
    guest_email: "second@example.com",
  });
  assert.strictEqual(again.status, 409, "double-booking the demo is refused");
  await ctx.close();
});

test("a restart does not seed a second demo organizer", async () => {
  const dataDir = tmpDir();
  const first = await start({ seedDemo: true, dataDir });
  await firstSlotStart(first.base, "demo"); // force a settled state
  await first.close();
  const second = await start({ seedDemo: true, dataDir });
  const demos = second.store.state.organizers.filter((o) => o.slug === "demo");
  assert.strictEqual(demos.length, 1, "the demo organizer survives restart without duplication");
  assert.strictEqual(demos[0].demo, true, "the demo flag persists");
  const html = await (await fetch(`${second.base}/`)).text();
  assert.match(html, /href="\/b\/demo"/);
  await second.close();
});
