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
// USDC uses 6 decimals; the price is exactly 8.000000 test-USDC — every
// payment is the same amount, so the offer is the $8 tier it claims to be.
const PRICE_MINOR = 8_000_000n;
const TOKEN_DECIMALS = 6;
// Each verified payment extends paid access by 30 days, stacking on any
// time already granted.
const GRANT_MS = 30 * 24 * 3600 * 1000;
// A payment intent is an instruction to pay from one declared address. It
// expires so stale instructions cannot be redeemed months later.
const INTENT_TTL_MS = 24 * 3600 * 1000;

// Event types per tier: 1 on the free tier, up to 3 while paid.
const FREE_EVENT_TYPES = 1;
const PAID_EVENT_TYPES = 3;

function isPaid(organizer, nowMs = Date.now()) {
  return Number(organizer.paidUntil) > nowMs;
}

function eventTypeLimit(organizer, nowMs = Date.now()) {
  return isPaid(organizer, nowMs) ? PAID_EVENT_TYPES : FREE_EVENT_TYPES;
}

// The types guests can actually book right now. On the free tier only the
// first-created type stays bookable: extra types are preserved as data (their
// settings and the bookings that reference them are intact) but they leave the
// public page, the picker and the booking routes, and they come back when a
// payment is verified again. Array order is creation order, so "the first" is
// deterministic.
function activeEventTypes(organizer, nowMs = Date.now()) {
  const list = (organizer && organizer.eventTypes) || [];
  if (isPaid(organizer, nowMs) || list.length <= FREE_EVENT_TYPES) return list;
  return list.slice(0, FREE_EVENT_TYPES);
}

// paidUntil only ever moves forward: a new payment extends from whichever is
// later, the current expiry or now.
function grantUntil(existingPaidUntil, nowMs = Date.now()) {
  const base = Math.max(Number(existingPaidUntil) || 0, nowMs);
  return base + GRANT_MS;
}

// A fresh payment intent: server-issued, bound to one organizer and one
// sending address. The organizer declares the wallet they will pay from; the
// server verifies that the on-chain transfer came from that address, of
// exactly PRICE_MINOR, to our recipient. The intent is what ties a transfer to
// an account — nothing about the amount or the hash alone does.
function newIntent(organizerId, senderAddress, nowMs = Date.now()) {
  return {
    id: crypto.randomBytes(16).toString("hex"),
    organizerId,
    senderAddress: String(senderAddress || "").toLowerCase(),
    amountMinor: PRICE_MINOR.toString(),
    createdAt: nowMs,
    expiresAt: nowMs + INTENT_TTL_MS,
    consumedAt: null,
    txHash: null,
  };
}

// 8000000 -> "8.000000"
function fmtAmount(minor) {
  const n = BigInt(minor);
  const whole = n / 10n ** BigInt(TOKEN_DECIMALS);
  const frac = (n % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, "0");
  return `${whole}.${frac}`;
}

// A declared sending address looks like an Ethereum address. Ownership is the
// organizer's promise — the server still checks the transfer's actual sender
// against it, which is what stops one account from redeeming another's
// transaction.
function addressIsValid(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

module.exports = {
  PRICE_USD,
  PRICE_MINOR,
  TOKEN_DECIMALS,
  GRANT_MS,
  INTENT_TTL_MS,
  FREE_EVENT_TYPES,
  PAID_EVENT_TYPES,
  isPaid,
  eventTypeLimit,
  activeEventTypes,
  grantUntil,
  newIntent,
  addressIsValid,
  fmtAmount,
};
