# Source ledger

- https://developers.circle.com/stablecoins/usdc-contract-addresses — fetched 2026-10-27. Base Sepolia testnet USDC contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; page states testnet tokens carry no financial value.
- https://sepolia.base.org (JSON-RPC, eth_call to that contract) — fetched 2026-10-27. Live verification: `symbol()` → "USDC", `name()` → "USDC", `decimals()` → 6. Confirms both the contract address and the RPC endpoint used by the payment verifier.
- ERC-20 `Transfer(address,address,uint256)` topic0 `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` — web search 2026-10-27, consistent across sources (tronorigin.io/learn/event-logs-and-token-transfers/, developer.nodit.io/en/api/webhook-log/, sqd.dev/learn/trc20-vs-erc20/, explorer.testnet.rootstock.io event example). Standard event signature hash, used to filter transfer logs in the verifier.

## 2026-10-27 (step 4, post 31)

- https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics — fetched 2026-10-27. A real Google Calendar iCal feed ("Holidays in United States", 317 VEVENTs, folded DESCRIPTION lines, all events TRANSP:TRANSPARENT and single-dated 2021 entries). Used to verify the feed reader against real Google output: fetch, line unfolding, X-WR-CALNAME parsing and window filtering all behave; 0 busy intervals in the coming days is correct because this feed marks every event transparent (holidays are informational, not busy time).
- USDC decimals 6 and the Base Sepolia USDC contract were verified live on 2026-10-27 during step 3 (see the paid-tier context record); re-verified nothing new this session.
