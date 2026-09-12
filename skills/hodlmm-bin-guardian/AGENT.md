---
name: hodlmm-bin-guardian
skill: hodlmm-bin-guardian
description: "Autonomous LP range monitor for Bitflow HODLMM pools. Checks if a wallet's position is in the active earning bin and recommends HOLD or REBALANCE based on live Bitflow price data, gas estimates, and cooldown state. Read-only: all write actions require human approval."
---

# HODLMM Bin Guardian: Agent Safety Rules

## Decision order
- Maximum estimated gas per rebalance: **50 STX** (2 contract calls: withdraw + add)
- Slippage cap: **0.5%**, measured as deviation between HODLMM active-bin price and Bitflow app reported token price
- Cooldown between rebalances: **4 hours** (state tracked in `~/.hodlmm-guardian-state.json`)

## Guardrails
Before any gate is consulted: if the wallet holds no liquidity in this pool
(`has_position` false), the procedure ends at `NO POSITION`. There is nothing to
rebalance, and the four gates below say nothing about that. If the wallet holds
bins whose ids could not be read, the answer is `CHECK`, never `NO POSITION`. The
same applies when no bin carries a liquidity figure this skill can read: that is a
renamed or reshaped field, not an empty wallet. A response whose shape is not
recognised at all is an error, not an answer.

Refuse to recommend REBALANCE if ANY of the following are true:
1. **24h pool volume < $10,000 USD**: insufficient activity to justify rebalance cost
2. **Slippage > 0.5%**: HODLMM bin price deviates too far from Bitflow app token price
3. **Estimated gas > 50 STX**: transaction cost exceeds the spend limit
4. **Cooldown has not elapsed**: last rebalance was < 4 hours ago

## In-Range Check
The real in-range check requires a `--wallet` address. Without it, `in_range` is `null` and no REBALANCE recommendation is made.
When the wallet holds nothing in the pool, `in_range` is also `null`, `has_position` is `false`, and the action is `NO POSITION`. A missing position is not an out of range one.

When `--wallet` is provided:
- Fetches user's actual position bins from Bitflow: `/api/app/v1/users/{address}/positions/{poolId}/bins`
- Filters to bins where the bin's liquidity is above zero. The field is `userLiquidity`; the older `user_liquidity` spelling is still read.
- `in_range = true` if `active_bin_id` is ONE OF the user's liquidity bins, not merely
  inside their span: a position can surround the active bin and hold none of it, and
  fees accrue only in the active bin. The action says so in those words.
- Bin ids are read strictly (a number, or a string of digits). Anything else is not an
  id, and bins we hold whose ids cannot be read give `CHECK`, never `NO POSITION`.

## Autonomous Actions Allowed
- Fetch public API data (Bitflow HODLMM, Bitflow ticker, Hiro): always allowed
- Compute and output JSON recommendation: always allowed
- Read/write cooldown state file (`~/.hodlmm-guardian-state.json`): always allowed

## Actions Requiring Human Approval
- `add-liquidity-simple`: any transaction adding liquidity
- `withdraw-liquidity-simple`: any transaction withdrawing liquidity
- Any transaction spending STX or sBTC

## Output Contract
Always return strict JSON:
```json
{
  "status": "success | error",
  "action": "HOLD | REBALANCE | CHECK | NO POSITION | <error description>",
  "data": {
    "in_range": "boolean | null",
    "has_position": "boolean | null",
    "active_bin": "number",
    "user_bin_range": "{ min, max, count, bins } | null",
    "can_rebalance": "boolean",
    "refusal_reasons": "string[] | null",
    "slippage_ok": "boolean",
    "slippage_pct": "number",
    "bin_price_raw": "number",
    "pool_price_usd": "number | null",
    "market_price_usd": "number | null",
    "slippage_source": "string",
    "gas_ok": "boolean",
    "gas_estimated_stx": "number",
    "cooldown_ok": "boolean",
    "cooldown_remaining_h": "number",
    "last_rebalance_at": "string | null",
    "volume_ok": "boolean",
    "volume_24h_usd": "number",
    "liquidity_usd": "number",
    "apr_24h_pct": "number",
    "pool_id": "string",
    "pool_name": "string",
    "fee_bps": "number"
  },
  "error": "null | { code, message, next }"
}
```
