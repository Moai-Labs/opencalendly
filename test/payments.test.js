"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { verifyTestPayment, TRANSFER_TOPIC, isTxHash } = require("../lib/payments");

const RECIPIENT = "0x2f50aa285c060f4a579f2c0256e8b7a754b1205d";
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const HASH = "0x" + "ab".repeat(32);

function transferLog({ to = RECIPIENT, from = "0x" + "11".repeat(20), amount = 8_000_123n, token = TOKEN } = {}) {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      "0x" + "00".repeat(12) + from.slice(2).toLowerCase(),
      "0x" + "00".repeat(12) + to.slice(2).toLowerCase(),
    ],
    data: "0x" + amount.toString(16),
  };
}

function stubRpc(receipt) {
  const calls = [];
  return {
    calls,
    rpcCall: async (method, params) => {
      calls.push({ method, params });
      return receipt;
    },
  };
}

test("a valid exact-amount transfer to the recipient verifies", async () => {
  const { rpcCall } = stubRpc({ status: "0x1", blockNumber: "0x10", logs: [transferLog()] });
  const verdict = await verifyTestPayment({ rpcCall, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n });
  assert.deepStrictEqual(verdict, { ok: true, blockNumber: "16" });
});

test("recipient, token contract, amount and status must all match", async () => {
  const cases = [
    { logs: [transferLog({ to: "0x1111111111111111111111111111111111111111" })], code: "no_matching_transfer" },
    { logs: [transferLog({ token: "0x2222222222222222222222222222222222222222" })], code: "no_matching_transfer" },
    { logs: [transferLog({ amount: 8_000_124n })], code: "no_matching_transfer" },
    { logs: [], code: "no_matching_transfer" },
    { status: "0x0", logs: [transferLog()] }, // reverted
  ];
  for (const receipt of cases) {
    const { rpcCall } = stubRpc(receipt.status ? receipt : { status: "0x1", logs: receipt.logs });
    const verdict = await verifyTestPayment({ rpcCall, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(verdict.code, receipt.code || "failed");
  }
});

test("a pending transaction has no receipt and is reported honestly", async () => {
  const { rpcCall } = stubRpc(null);
  const verdict = await verifyTestPayment({ rpcCall, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n });
  assert.deepStrictEqual(verdict, { ok: false, code: "not_found" });
});

test("an RPC failure is an rpc_error, never a silent pass", async () => {
  const verdict = await verifyTestPayment({
    rpcCall: async () => { throw new Error("connection refused"); },
    txHash: HASH,
    recipient: RECIPIENT,
    token: TOKEN,
    expectedAmountMinor: 8_000_123n,
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, "rpc_error");
});

test("malformed input is rejected before any RPC call", async () => {
  for (const bad of ["", "0x1234", "nothex", HASH.slice(0, 65), HASH + "0"]) {
    assert.strictEqual(isTxHash(bad), false, bad);
  }
  assert.strictEqual(isTxHash(HASH), true);
  let called = false;
  const verdict = await verifyTestPayment({
    rpcCall: async () => { called = true; return null; },
    txHash: "nothex",
    recipient: RECIPIENT,
    token: TOKEN,
    expectedAmountMinor: 8_000_123n,
  });
  assert.strictEqual(verdict.code, "bad_input");
  assert.strictEqual(called, false);
});

test("address comparison is case-insensitive; other events on the token are ignored", async () => {
  const checksummed = { ...transferLog(), address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
  const { rpcCall } = stubRpc({ status: "0x1", logs: [{ address: TOKEN, topics: ["0xother", "0x1", "0x" + "00".repeat(12) + RECIPIENT.slice(2)], data: "0x1" }, checksummed] });
  const verdict = await verifyTestPayment({ rpcCall, txHash: HASH, recipient: RECIPIENT.toUpperCase(), token: TOKEN, expectedAmountMinor: 8_000_123n });
  assert.strictEqual(verdict.ok, true);
});

test("the transfer's sender must match the intent's declared address", async () => {
  const declared = "0x" + "aa".repeat(20);
  // Exact amount, right recipient, wrong sender: no match.
  const wrongSender = { status: "0x1", logs: [transferLog({ from: "0x" + "bb".repeat(20) })] };
  const { rpcCall } = stubRpc(wrongSender);
  const verdict = await verifyTestPayment({
    rpcCall, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n, fromAddress: declared,
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, "no_matching_transfer");
  // The same transfer verifies once the declared address matches.
  const { rpcCall: rpcCall2 } = stubRpc({ status: "0x1", logs: [transferLog({ from: declared })] });
  const ok = await verifyTestPayment({
    rpcCall: rpcCall2, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n, fromAddress: declared,
  });
  assert.deepStrictEqual(ok, { ok: true, blockNumber: "0" });
  // Sender comparison is case-insensitive, like the recipient's.
  const checksummed = "0x" + "Aa".repeat(20);
  const { rpcCall: rpcCall3 } = stubRpc({ status: "0x1", logs: [transferLog({ from: declared })] });
  const ok2 = await verifyTestPayment({
    rpcCall: rpcCall3, txHash: HASH, recipient: RECIPIENT, token: TOKEN, expectedAmountMinor: 8_000_123n, fromAddress: checksummed,
  });
  assert.strictEqual(ok2.ok, true);
});
