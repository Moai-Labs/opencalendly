"use strict";

const test = require("node:test");
const assert = require("node:assert");
const plans = require("../lib/plans");

const DAY = 24 * 3600 * 1000;

test("free tier: one event type; paid tier: three", () => {
  const now = Date.now();
  const free = {};
  const paid = { paidUntil: now + DAY };
  assert.strictEqual(plans.eventTypeLimit(free, now), 1);
  assert.strictEqual(plans.eventTypeLimit(paid, now), 3);
});

test("paid status expires the moment paidUntil passes", () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(plans.isPaid({ paidUntil: now + 1 }, now), true);
  assert.strictEqual(plans.isPaid({ paidUntil: now }, now), false);
  assert.strictEqual(plans.isPaid({}, now), false);
});

test("a grant extends from the later of now and the current expiry", () => {
  const now = 1_000_000_000_000;
  // From free: 30 days from now.
  assert.strictEqual(plans.grantUntil(0, now), now + 30 * DAY);
  // With 5 days left: 30 days from the current expiry, not from now.
  assert.strictEqual(plans.grantUntil(now + 5 * DAY, now), now + 35 * DAY);
  // An expired subscription starts fresh from now.
  assert.strictEqual(plans.grantUntil(now - DAY, now), now + 30 * DAY);
});

test("the price is exactly 8.000000 test-USDC for every payment", () => {
  assert.strictEqual(plans.PRICE_MINOR, 8_000_000n);
  assert.strictEqual(plans.fmtAmount(plans.PRICE_MINOR), "8.000000");
  // An intent always carries the same exact amount.
  const intent = plans.newIntent("org-1", "0x" + "11".repeat(20));
  assert.strictEqual(BigInt(intent.amountMinor), plans.PRICE_MINOR);
  assert.ok(intent.id.length >= 32, "an intent id is unguessable");
  assert.ok(Number(intent.expiresAt) > intent.createdAt, "an intent expires");
});

test("a declared sending address looks like an address", () => {
  assert.strictEqual(plans.addressIsValid("0x" + "11".repeat(20)), true);
  assert.strictEqual(plans.addressIsValid("0X" + "11".repeat(20).toUpperCase()), true);
  assert.strictEqual(plans.addressIsValid("0x1234"), false);
  assert.strictEqual(plans.addressIsValid("not an address"), false);
  assert.strictEqual(plans.addressIsValid(""), false);
});

test("on the free tier only the first event type stays bookable; paid unlocks all", () => {
  const now = Date.now();
  const types = [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 2 }, { id: "c", createdAt: 3 }];
  // Free: the extra types are paused, not deleted.
  assert.deepStrictEqual(plans.activeEventTypes({ eventTypes: types }, now), [types[0]]);
  // Paid: all three are bookable again, in creation order.
  assert.deepStrictEqual(plans.activeEventTypes({ eventTypes: types, paidUntil: now + DAY }, now), types);
  // A one-type organizer is unaffected either way.
  assert.deepStrictEqual(plans.activeEventTypes({ eventTypes: [types[0]] }, now), [types[0]]);
});
