---
name: hodlmm-bin-guardian
description: "Monitors Bitflow HODLMM bins to keep LP positions in the active earning range. Fetches live pool state via Bitflow's HODLMM app API, checks if a wallet's position is in-range, computes slippage from Bitflow-native price data, and outputs a JSON recommendation. Read-only: rebalance actions require explicit human approval."
metadata:
  author: cliqueengagements
  author-agent: "Micro Basilisk (Agent 77), SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "true"
  arguments: "doctor | install-packs | run [--wallet <STX_ADDRESS>] [--pool-id <id>]"
  entry: "hodlmm-bin-guardian/hodlmm-bin-guardian.ts"
  requires: ""
  tags: "defi, read-only, mainnet-only, l2"
---

# HODLMM Bin Guardian

Monitors Bitflow HODLMM (DLMM) bins to keep LP positions in the active earning range.

## What it does

Fetches live Bitflow HODLMM pool state, the user's actual LP position bins (via wallet address), and compares the user's bin range against the active bin to determine if the position is earning fees. Volume, TVL, APR, and token prices are sourced directly from Bitflow's HODLMM app API, no external oracles. Slippage is measured as the deviation between the HODLMM active-bin price and Bitflow's own reported token price. Also checks estimated gas cost and cooldown before recommending REBALANCE.

## Why agents need it

HODLMM positions stop earning fees the moment the market price moves outside the deposited bin range. This skill gives an autonomous agent a reliable, safe-to-run check that surfaces out-of-range positions and flags them for human-approved rebalancing, without ever spending funds autonomously.

## Safety notes

- **Read-only.** No transactions are submitted.
- **Mainnet-only.** Bitflow HODLMM API does not support testnet.
- Refuses to recommend rebalance if 24h pool volume < $10,000 USD.
- Refuses to recommend rebalance if slippage > 0.5% (HODLMM bin price vs Bitflow app price).
- Any actual rebalance (add/withdraw liquidity) requires explicit human approval before execution.
- All price data sourced from Bitflow APIs only, no external oracles.

## Commands

### doctor

Checks all data sources: Bitflow HODLMM API, Bitflow Bins API, Bitflow App Pools API, and Hiro Stacks API.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
```

### install-packs

No additional packs required: uses Bitflow and Hiro public HTTP APIs directly.

```bash
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts install-packs
```

### run

Checks the LP position in the default sBTC HODLMM pool (dlmm_1) and outputs a recommendation.
Pass `--wallet` to enable the real in-range check against actual position bins.

```bash
# Full check with wallet (recommended)
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP1234...
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet SP1234... --pool-id dlmm_1

# Pool-only check (no position check: in_range will be null)
bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run
```

## Live terminal output

### doctor (all 4 sources reachable)

```json
{
  "status": "ok",
  "checks": [
    { "name": "Bitflow HODLMM API",      "ok": true, "detail": "8 pools found, dlmm_1 active bin: 504" },
    { "name": "Bitflow Bins API (dlmm_1)", "ok": true, "detail": "active_bin_id=504, 1001 bins" },
    { "name": "Bitflow App Pools API",   "ok": true, "detail": "dlmm_1 TVL: $77,142.99, vol_24h: $126,045, APR: 17.72%" },
    { "name": "Hiro Stacks API (fees)",  "ok": true, "detail": "2 µSTX/byte" }
  ],
  "message": "All data sources reachable. Ready to run."
}
```

### run --wallet (wallet holds no dlmm_1 position)

```json
{
  "status": "success",
  "action": "NO POSITION: The pool lists 221 bins for this wallet, all with zero liquidity. Nothing is in or out of range, and there is nothing to rebalance.",
  "data": {
    "in_range": null,
    "has_position": false,
    "active_bin": 656,
    "user_bin_range": null,
    "can_rebalance": true,
    "refusal_reasons": null,
    "slippage_ok": true,
    "slippage_pct": 0.1084,
    "bin_price_raw": 77363811477,
    "pool_price_usd": 77363.81,
    "market_price_usd": 77280,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0036,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": "2026-03-26T16:42:45.000Z",
    "volume_ok": true,
    "volume_24h_usd": 1696135,
    "liquidity_usd": 367280,
    "apr_24h_pct": 771.01,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 50,
    "position_note": "The pool lists 221 bins for this wallet, all with zero liquidity."
  },
  "error": null
}
```

### run --wallet (a real position, in range at the active bin)

```json
{
  "status": "success",
  "action": "HOLD: position in range at active bin 656. APR (24h): 771.01%.",
  "data": {
    "in_range": true,
    "has_position": true,
    "active_bin": 656,
    "user_bin_range": {
      "min": 526,
      "max": 766,
      "count": 232,
      "bins": [
        526,
        528,
        529,
        765,
        766
      ]
    },
    "can_rebalance": true,
    "refusal_reasons": null,
    "slippage_ok": true,
    "slippage_pct": 0.1084,
    "bin_price_raw": 77363811477,
    "pool_price_usd": 77363.81,
    "market_price_usd": 77280,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0072,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": "2026-03-26T16:42:45.000Z",
    "volume_ok": true,
    "volume_24h_usd": 1696135,
    "liquidity_usd": 367280,
    "apr_24h_pct": 771.01,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 50
  },
  "error": null
}
```

Captured on 12 September 2026 from wallet `SP1BXRXA...`, which held 232 bins at
that moment. The `bins` array is shortened here to five ids; the real answer
lists every one. A live position changes: the same wallet held 23 bins a few
hours later and the answer became the REBALANCE example below, so treat this as
what one real run said, not as what that command prints today.

### run --wallet (a position that surrounds the active bin without holding it)

```json
{
  "status": "success",
  "action": "REBALANCE: the active bin 656 holds none of your liquidity, though your position spans bins 528 to 766 (23 bins, with gaps). Fees accrue only in the active bin. Requires human approval.",
  "data": {
    "in_range": false,
    "has_position": true,
    "active_bin": 656,
    "user_bin_range": {
      "min": 528,
      "max": 766,
      "count": 23,
      "bins": [
        528,
        537,
        546,
        762,
        766
      ]
    },
    "can_rebalance": true,
    "refusal_reasons": null,
    "slippage_ok": true,
    "slippage_pct": 0.0282,
    "bin_price_raw": 77363811477,
    "pool_price_usd": 77363.81,
    "market_price_usd": 77342,
    "slippage_source": "bitflow-app-price-vs-hodlmm-active-bin",
    "gas_ok": true,
    "gas_estimated_stx": 0.0432,
    "cooldown_ok": true,
    "cooldown_remaining_h": 0,
    "last_rebalance_at": "2026-03-26T16:42:45.000Z",
    "volume_ok": true,
    "volume_24h_usd": 1706731,
    "liquidity_usd": 110262,
    "apr_24h_pct": 546.55,
    "pool_id": "dlmm_1",
    "pool_name": "sBTC-USDCx-LP",
    "fee_bps": 50
  },
  "error": null
}
```

Captured 12 September 2026, the same wallet as above a few hours later. The
active bin sits inside the span, so "out of range" would read as a
contradiction; what is true is that the bin earning fees right now holds none
of their liquidity. The `bins` array is shortened here to five ids.

## Output contract

All outputs are strict JSON to stdout.

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "error"` | Overall result |
| `action` | `string` | `HOLD`, `REBALANCE`, `CHECK`, or `NO POSITION` with reason |
| `data.in_range` | `boolean \| null` | `null` if no wallet provided, or the wallet holds no position |
| `data.has_position` | `boolean \| null` | Whether the wallet holds liquidity here. `null` when nobody could tell: no wallet given, or the bins came back in a shape whose liquidity figures could not be read |
| `data.active_bin` | `number` | Pool's current active bin ID |
| `data.user_bin_range` | `{min,max,count,bins} \| null` | User's liquidity bin range |
| `data.can_rebalance` | `boolean` | Whether all safety gates pass |
| `data.refusal_reasons` | `string[] \| null` | Why REBALANCE is blocked |
| `data.slippage_ok` | `boolean` | Whether price deviation is within cap |
| `data.slippage_pct` | `number` | `\|hodlmm_price − bitflow_price\| / bitflow_price × 100` |
| `data.bin_price_raw` | `number` | Raw active bin price from Bitflow bins API |
| `data.pool_price_usd` | `number \| null` | HODLMM derived USD price: `(bin_price_raw / 1e8) × 10^(xDec − yDec)` |
| `data.market_price_usd` | `number \| null` | Bitflow app reported token price in USD |
| `data.slippage_source` | `string` | Price source identifier |
| `data.gas_ok` | `boolean` | Whether estimated gas is within limit |
| `data.gas_estimated_stx` | `number` | Estimated STX for 2-txn rebalance |
| `data.cooldown_ok` | `boolean` | Whether cooldown has elapsed |
| `data.cooldown_remaining_h` | `number` | Hours until next rebalance allowed |
| `data.last_rebalance_at` | `string \| null` | ISO timestamp of last recorded rebalance |
| `data.volume_ok` | `boolean` | Whether 24h volume meets minimum |
| `data.volume_24h_usd` | `number` | 24h pool volume in USD |
| `data.liquidity_usd` | `number` | Pool TVL in USD |
| `data.apr_24h_pct` | `number` | 24h fee APR from Bitflow app API |
| `data.pool_id` | `string` | Pool identifier |
| `data.pool_name` | `string` | Human-readable pool name |
| `data.fee_bps` | `number` | Pool fee in basis points |
| `data.position_note` | `string?` | Present when position state needs explanation |

## Data sources

| Source | Data | Endpoint |
|---|---|---|
| Bitflow HODLMM API | Pool list, active bin | `bff.bitflowapis.finance/api/quotes/v1/pools` |
| Bitflow Bins API | Per-bin prices (raw, for slippage) | `bff.bitflowapis.finance/api/quotes/v1/bins/{poolId}` |
| Bitflow App Pools API | TVL, 24h volume, APR, token prices, decimals | `bff.bitflowapis.finance/api/app/v1/pools` |
| Bitflow Position API | User's position bins | `bff.bitflowapis.finance/api/app/v1/users/{addr}/positions/{pool}/bins` |
| Hiro Stacks API | STX fee estimate | `api.mainnet.hiro.so/v2/fees/transfer` |

## v2 changelog (fixes from day-1 review)

### In-range check: was fake, now real

**Before:** `inRange = isFinite(pool.active_bin) && pool.active_bin > 0`, always `true`.

**After:** Real HTTP call to `GET /api/app/v1/users/{address}/positions/{poolId}/bins`. Filters bins whose liquidity is above zero (the field is `userLiquidity`, and the older `user_liquidity` spelling is still read), then checks whether `active_bin_id` is one of them. Bin ids are converted to numbers first: one run printed a string id where later probes returned numbers, and the payload names more than one data source, so both are read, and a string id never equals a numeric active bin.

### Slippage: was hardcoded, now live and fully Bitflow-native

**Before:** Constant value, always passed.

**After:** `(bin_price_raw / 1e8) × 10^(xDec − yDec)` vs Bitflow app API token price. No external oracles: all data from Bitflow endpoints.

### Gas estimate: was a made-up constant, now live

**Before:** `gas_estimated_stx: 0.006`, hardcoded.

**After:** `Hiro /v2/fees/transfer × 500 bytes × 2 txns × 3× contract multiplier × 1.2 safety buffer`.

### Cooldown: was not tracked, now persistent

**Before:** No state file, cooldown always passing.

**After:** Reads/writes `~/.hodlmm-guardian-state.json`. Returns `cooldown_remaining_h` on each run.

### Frontmatter: stale dependency removed

**Before:** `requires: [bitflow]`, referenced a non-existent dependency.

**After:** `requires: ""`, fully self-contained, all data from public HTTP APIs.
