// Server-side verification of a TEST-USDC payment. The server asks a public
// JSON-RPC endpoint for the transaction receipt and looks for the ERC-20
// Transfer event itself; nothing about the payment is taken from the
// organizer's input except the transaction hash. The payment is real on a
// testnet (test-USDC, no value) but labelled test throughout the product.
//
// Both facts below were verified against the live network this build, not
// from memory (see sources.md):
//  - Base Sepolia USDC at 0x036CbD53842c5426634e7929541eC2318f3dCF7e answers
//    symbol() USDC, name() USDC, decimals() 6 via https://sepolia.base.org.
//  - topic0 of the standard ERC-20 Transfer(address,address,uint256) event is
//    0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef.
"use strict";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function jsonRpcCall(rpcUrl, method, params) {
  return fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC error: ${body.error.message || body.error}`);
    return body.result;
  });
}

function isTxHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

// topics[2] is the 32-byte left-padded recipient; take the low 20 bytes.
function topicAddress(topic) {
  return "0x" + String(topic || "").slice(-40);
}

// Verify one transaction moved exactly `expectedAmountMinor` of `token` from
// `fromAddress` to `recipient`. The sender must match the payment intent's
// declared address: that is what binds a transfer to one organizer's intent,
// since the amount alone is public and identical for every payment.
// `rpcCall` is injectable so tests can stub the chain; it has the
// signature (method, params) -> Promise<result>.
// Returns { ok: true, blockNumber } or { ok: false, code } with one of:
//   not_found (no receipt yet), failed (reverted), no_matching_transfer,
//   bad_input, rpc_error.
async function verifyTestPayment({ rpcCall, txHash, recipient, token, expectedAmountMinor, fromAddress }) {
  if (!isTxHash(txHash)) return { ok: false, code: "bad_input" };
  let receipt;
  try {
    receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
  } catch (err) {
    return { ok: false, code: "rpc_error", error: String(err.message || err).slice(0, 200) };
  }
  if (!receipt) return { ok: false, code: "not_found" };
  if (String(receipt.status || "").toLowerCase() !== "0x1") return { ok: false, code: "failed" };
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    if (!sameAddress(log.address, token)) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length !== 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (fromAddress && !sameAddress(topicAddress(topics[1]), fromAddress)) continue;
    if (!sameAddress(topicAddress(topics[2]), recipient)) continue;
    let amount;
    try {
      amount = BigInt(log.data);
    } catch {
      continue; // a malformed data field is not a Transfer we can trust
    }
    if (amount !== BigInt(expectedAmountMinor)) continue;
    let blockNumber = "0";
    try {
      blockNumber = BigInt(receipt.blockNumber || 0).toString(10);
    } catch {} // a non-numeric block number is odd but not a verification failure
    return { ok: true, blockNumber };
  }
  return { ok: false, code: "no_matching_transfer" };
}

module.exports = { TRANSFER_TOPIC, isTxHash, verifyTestPayment, jsonRpcCall };
