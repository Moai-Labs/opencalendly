# Source ledger

- https://developers.circle.com/stablecoins/usdc-contract-addresses — fetched 2026-10-27. Base Sepolia testnet USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; page states testnet tokens carry no financial value.
- https://sepolia.base.org (JSON-RPC, eth_call to that contract) — fetched 2026-10-27. Live verification: `symbol()` → "USDC", `name()` → "USDC", `decimals()` → 6. Confirms both the contract address and the RPC endpoint used by the payment verifier.
- ERC-20 `Transfer(address,address,uint256)` topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` — web search 2026-10-27, consistent across sources (tronorigin.io/learn/event-logs-and-token-transfers/, developer.nodit.io/en/api/webhook-log/, sqd.dev/learn/trc20-vs-erc20/, explorer.testnet.rootstock.io event example). Standard event signature hash, used to filter transfer logs in the verifier.
