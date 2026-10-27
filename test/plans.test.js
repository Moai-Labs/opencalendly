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

test("payment references encode the exact amount", () => {
  assert.strictEqual(plans.amountForRef(1), 8_000_001n);
  assert.strictEqual(plans.amountForRef(999_999), 8_999_999n);
  assert.strictEqual(plans.amountForRef(0), null);
  assert.strictEqual(plans.amountForRef(1_000_000), null);
  assert.strictEqual(plans.amountForRef(1.5), null);
  assert.ok(plans.refIsValid(plans.newRef()));
  assert.strictEqual(plans.fmtAmount(8_000_000n), "8.000000");
  assert.strictEqual(plans.fmtAmount(8_000_123n), "8.000123");
  assert.strictEqual(plans.fmtAmount(8_999_999n), "8.999999");
});
