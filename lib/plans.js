// The paid tier. One event type and unlimited bookings are free; a payment
// buys up to three event types and removes OpenCalendly branding from the
// organizer's public pages for 30 days per payment.
//
// Payments in this build are TEST payments only: test-USDC on a public
// testnet, labelled as test everywhere the product shows them. They are not
// revenue and never count toward any demand target. Real payment collection
// needs an approved payment route, which does not exist yet.
"use strict";

const crypto = require("node:crypto");

const PRICE_USD = 8;
// USDC uses 6 decimals; the price is 8.000000 test-USDC.
const PRICE_MINOR = 8_000_000n;
const TOKEN_DECIMALS = 6;
// Each verified payment extends paid access by 30 days, stacking on any
// time already granted.
const GRANT_MS = 30 * 24 * 3600 * 1000;

// Event types per tier: 1 on the free tier, up to 3 while paid. The limit is
// enforced when event types are created; existing ones keep working if a
// subscription expires rather than silently disappearing on anyone.
const FREE_EVENT_TYPES = 1;
const PAID_EVENT_TYPES = 3;

function isPaid(organizer, nowMs = Date.now()) {
  return Number(organizer.paidUntil) > nowMs;
}

function eventTypeLimit(organizer, nowMs = Date.now()) {
  return isPaid(organizer, nowMs) ? PAID_EVENT_TYPES : FREE_EVENT_TYPES;
}

// paidUntil only ever moves forward: a new payment extends from whichever is
// later, the current expiry or now.
function grantUntil(existingPaidUntil, nowMs = Date.now()) {
  const base = Math.max(Number(existingPaidUntil) || 0, nowMs);
  return base + GRANT_MS;
}

// Each payment request carries a unique reference 1..999999 encoded in the
// amount itself (8.000000 + ref/1e6 test-USDC). The exact amount ties the
// on-chain transfer to one upgrade request, so a transaction cannot be
// replayed for a different request.
const REF_MAX = 999_999;

function refIsValid(ref) {
  return Number.isInteger(ref) && ref >= 1 && ref <= REF_MAX;
}

function newRef() {
  return 1 + (crypto.randomInt(REF_MAX));
}

function amountForRef(ref) {
  if (!refIsValid(ref)) return null;
  return PRICE_MINOR + BigInt(ref);
}

// 8000123 -> "8.000123"
function fmtAmount(minor) {
  const n = BigInt(minor);
  const whole = n / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (n % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, "0");
  return `${whole}.${frac}`;
}

module.exports = {
  PRICE_USD,
  PRICE_MINOR,
  TOKEN_DECIMALS,
  GRANT_MS,
  FREE_EVENT_TYPES,
  PAID_EVENT_TYPES,
  isPaid,
  eventTypeLimit,
  grantUntil,
  refIsValid,
  newRef,
  amountForRef,
  fmtAmount,
};
