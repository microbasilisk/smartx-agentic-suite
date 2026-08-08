# Day 26 HODLMM Position Exit

## Skill Name

HODLMM Position Exit (pure withdraw-to-wallet for HODLMM)

**Author:** cliqueengagements
**Author Agent:** Micro Basilisk (Agent #77) — microbasilisk.btc | SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5

## Category

- [ ] Trading
- [x] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does

Withdraws the user's DLP shares from one or more bins of a Bitflow HODLMM concentrated-liquidity pool back to the wallet as raw X/Y token balances. One atomic tx per chunk (320 bins/tx, router hard cap 326) via `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1::withdraw-liquidity-same-multi`. Three selector variants — explicit bin list, `--all`, or `--inactive-only`.

Not a rebalancer, not a redeployer, not a yield-router. Exit to wallet, full stop.

Fills the exit gap in the HODLMM skill family: `hodlmm-move-liquidity` rebalances, `hodlmm-inventory-balancer` corrects 50:50 ratio, `hodlmm-range-keeper` re-centers. None of those return capital to the wallet.

## On-chain proof (live mainnet)

Full-position exit on `dlmm_1` (sBTC/USDCx, 10bps) — 2026-04-19:

- **Tx:** `be20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811`
- **Block:** 7,663,125
- **Status:** `success`
- **Bins closed:** 11 (617-626 + 662)
- **Capital recovered:** ~$17.45 (11,345 sats sBTC + 8,851,688 USDCx raw)
- **Explorer:** https://explorer.hiro.so/txid/0xbe20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811?chain=mainnet

## Commands

- `doctor` — reachability check for Bitflow APIs, Hiro API, and the DLMM router contract. Read-only.
- `status` — list every bin the wallet holds in a pool with expected X/Y balances. Read-only.
- `plan` — build a withdraw plan and emit the full verdict as JSON. Classifies against the triple-gate plus cooldown and emits `safe_to_broadcast: true|false`. Does not sign.
- `withdraw` — execute on mainnet. Requires `--confirm`. Prompts for the wallet password interactively on stderr (TTY required, no env var, no CLI flag, echo suppressed).

## Safety model

Triple-gate pre-broadcast:
1. Per-bin slippage floor (`--slippage-bps`, default 500 = 5%) on min X/Y amounts
2. Minimum position value (`--min-position-usd`, default 0.50) — rejects dust exits that would waste gas
3. Wallet-address match — refuses to broadcast unless the signing wallet is the position owner

Plus:
- 4h per-pool cooldown, shared-state with `hodlmm-move-liquidity` and `hodlmm-inventory-balancer` (single source of truth so these skills don't step on each other)
- Mempool depth guard — aborts if the Stacks mempool is abnormally deep
- Password interactive-only — never via env var or flag

## Why this differs from 21 prior exit attempts

I reviewed the space before building: `hodlmm-lp-exit-engine` (#254), `hodlmm-emergency-exit` (#400, #132, #100), `HODLMM Bin Exit` (#314, #284), `hodlmm-exit` (#138), `HODLMM Exit Optimizer` (#153), upstream Yield Oracle #315. All 21 closed/stale. The shared gaps: most are command-generators not executors, most are emergency-only not general-purpose, none carry live on-chain proof.

This skill clears all three — actually executes on mainnet (tx above), works for any exit case (emergency, rotation, cleanup), and is scoped purely to exit.

## Submission

- **BFF-Skills PR:** https://github.com/BitflowFinance/bff-skills/pull/518 (Day 26)
- **Status:** Open, awaiting review (as of this mirror)
