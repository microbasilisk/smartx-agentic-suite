---
name: micro-basilisk
skill: zbg-yield-scout
description: "Reads wallet balances and positions across Zest, Bitflow (HODLMM), and Granite. Outputs yield comparison, best move recommendation, and sBTC break prices. Read-only — never submits transactions."
---

# ZBG Yield Scout — Agent Behavior

## Decision order

1. Read wallet balances (sBTC, STX, USDCx) and convert to USD via Tenero
2. Check Zest for active supply position
3. Check Granite for active supply/borrow position via on-chain reads
4. Scan all 8 HODLMM pool contracts for user bin positions
5. Fetch yield rates: Zest APY, Granite supply APR (derived from on-chain IR model), HODLMM fee APR
6. Compare yields, rank options, identify best move for idle capital
7. Calculate break prices: HODLMM bin range boundaries, Granite liquidation threshold
8. Output five-section JSON report

## Guardrails

1. **Read-only always.** This skill never submits transactions, never spends gas, never moves funds.
2. **No mock data.** Every number comes from a live on-chain read or API call. If a source fails, report degraded status — never substitute fake values. Exception: Zest sBTC supply APY is reported as 0% when no live rate is available, with a note directing users to check zest.fi.
3. **sBTC pricing, not BTC.** Break prices use on-chain sBTC price from Tenero, not BTC L1 price. sBTC can depeg from BTC during stress events — the break price must reflect what the protocol actually sees.
4. **Graceful empty positions.** If the wallet has no position on a protocol, report "no position" and still show yield options. The skill is equally useful for someone with zero DeFi exposure.
5. **BigInt for all Clarity values.** HODLMM bin balances and Granite params are uint128. Parse with BigInt from big-endian hex — never use JavaScript Number for on-chain values above 2^53.
6. **30-second timeout on all fetches.** AbortController on every HTTP call. Report which source timed out in degraded status.
7. **No financial advice.** "Best Safe Move" is a data-driven comparison, not investment advice. Output includes the data used to reach the recommendation so the user can verify.

## Autonomous actions allowed

- Fetch public API data (Hiro, Tenero, Bitflow) — always allowed
- Read on-chain contract state via `call_read_only_function` — always allowed
- Compute derived values (APY, break prices, opportunity cost) — always allowed
- Output JSON report to stdout — always allowed

## Actions never performed

- Submit any transaction
- Spend STX or sBTC
- Write to any contract
- Store or transmit wallet private keys
- Cache stale prices between runs

## Output contract

Always return strict JSON:

```json
{
  "status": "ok | degraded | error",
  "wallet": "SP...",
  "what_you_have": {
    "sbtc": { "amount": 0.00165382, "usd": 112.41 },
    "stx": { "amount": 39.58, "usd": 8.54 },
    "usdcx": { "amount": 0, "usd": 0 }
  },
  "zbg_positions": {
    "zest": { "has_position": false, "detail": "no supply position" },
    "granite": { "has_position": false, "detail": "no supply position" },
    "hodlmm": {
      "has_position": true,
      "pools": [
        {
          "pool_id": 1,
          "name": "sBTC-USDCx-10bps",
          "in_range": true,
          "active_bin": 510,
          "user_bins": { "min": 460, "max": 680, "count": 221 },
          "dlp_shares": "99661451",
          "estimated_value_usd": 110.50
        }
      ]
    }
  },
  "smart_options": [
    {
      "protocol": "HODLMM",
      "pool": "sBTC-USDCx-10bps",
      "apy_pct": 17.72,
      "daily_usd": 0.054,
      "monthly_usd": 1.65,
      "gas_to_enter_stx": 0.05,
      "note": "Fee-based yield — varies with swap volume"
    }
  ],
  "best_move": {
    "recommendation": "Your sBTC is already deployed in HODLMM earning 17.72% APR. Position is in range.",
    "idle_capital_usd": 8.54,
    "opportunity_cost_daily_usd": 0.001
  },
  "break_prices": {
    "hodlmm_range_exit_low_usd": 58000,
    "hodlmm_range_exit_high_usd": 82000,
    "granite_liquidation_usd": null,
    "current_sbtc_price_usd": 67987
  },
  "data_sources": ["hiro-balances", "tenero-sbtc-price", "tenero-stx-price", "zest-on-chain", "granite-on-chain", "hodlmm-pool-1", "granite-apy", "bitflow-hodlmm-apr", "zest-apy", "hodlmm-bin-price-low", "hodlmm-bin-price-high"],
  "error": null
}
```
