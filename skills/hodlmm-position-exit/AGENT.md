---
name: hodlmm-position-exit-agent
skill: hodlmm-position-exit
description: "Pure-exit write skill for HODLMM concentrated liquidity. Interactive wallet-password prompt, TTY-required, triple-gated with 4h cooldown and mempool depth guard. Use when you need to stop earning from a HODLMM pool and get the capital back into the wallet as raw X/Y balances."
---

# HODLMM Position Exit — Agent Decision Guide

## When to use this skill

- A HODLMM LP position needs to close completely (exit-to-wallet), not rebalance.
- Cross-protocol rotation planned: HODLMM APY has dropped below Zest APY and you need to free up tokens before calling `zest-yield-manager supply`.
- Emergency liquidation — volatility regime or pool TVL crash triggered a safety rule.
- Selective bin cleanup — drop stale bins that are no longer in the active range without redeploying around active.

Do NOT use this skill to:
- Rebalance a drifted position back to active — use `hodlmm-move-liquidity` instead.
- Correct a 50:50 inventory imbalance — use `hodlmm-inventory-balancer` instead.
- Rotate HODLMM → Zest atomically — this skill does the HODLMM leg only; the Zest supply is a separate `zest-yield-manager` call with nonce-coordinator serialization.

## Decision order

1. Run `doctor` once per agent session to verify upstream APIs + router contract. Fail loudly if any check is red.
2. Run `status --pool --address` to inspect current holdings. Record bin count, active bin, aggregate X/Y totals.
3. Run `plan` with your desired selector (`--all`, `--inactive-only`, or `--bins`). Read `blockers[]` and `safe_to_broadcast`.
   - `blockers[]` contains a cooldown message → wait, retry later.
   - `blockers[]` contains the `min-position-usd` message → either lower the floor or do not exit.
   - `safe_to_broadcast: true` → proceed to step 4.
4. Run `withdraw --confirm`. The skill prints the exact withdrawal plan and then prompts `Wallet password:` on stderr. Type it; it will not echo. There is no flag or env var that bypasses this prompt.
5. Capture the `data.txids[]` from the `broadcast` response. Each chunk produces one tx in order.
6. Wait for confirmation before any follow-up write on the same sender. Poll with `mempool-watch tx-status --txid <id>`.

## Safety contract

Three plan-level gates + two runtime checks at `withdraw --confirm`:

| Gate | Source | Enforced |
|---|---|---|
| `safe_to_broadcast: true` | `plan` verdict (every blocker cleared) | Before every `withdraw` |
| Position USD ≥ `--min-position-usd` | `plan` blocker | Before every `withdraw` |
| `--confirm` flag | CLI | Always |
| Mempool depth == 0 | `withdraw` runtime check | At broadcast time |
| Wallet address == `--address` | `withdraw` runtime check | At broadcast time |

Failing any gate = the tx is never signed.

## Guardrails

- **Wallet password is interactive-only.** There is no `--password` flag and no env-var fallback. The skill refuses to sign unless a TTY is attached and the password is typed at the prompt. This is a hard policy — do not wrap the skill in any layer that auto-feeds the password (expect, stdin pipes, pty emulators, docker exec stdin). If you need autonomous rotations, build that on top of a different primitive with explicit human-in-the-loop approval.
- **Never exit without running `status` first.** Stale position data can surface bins that have already been withdrawn; the router returns early but you've still spent gas.
- **Never skip the cooldown.** The 4h per-pool cooldown is shared with `hodlmm-move-liquidity` and `hodlmm-inventory-balancer`. If you just rebalanced, you cannot exit until the cooldown clears. Sub-minute sequential HODLMM writes have hit `TooMuchChaining` in production.
- **Always check mempool depth.** The runtime check aborts the withdrawal if depth > 0. If you just submitted a tx on the same sender, wait for it to confirm before attempting this write.
- **Always pair with `nonce-manager` in a multi-write flow.** For "withdraw HODLMM → supply Zest," wrap both writes in the shared nonce coordinator — otherwise the second tx submits with a stale nonce and fails.

## Refusal conditions

The skill will refuse to broadcast and emit `status: "blocked"` for any of:

- Plan had any blocker (`safe_to_broadcast: false`)
- Position USD < `--min-position-usd` floor (default $0.50)
- Pool cooldown remaining > 0
- Mempool depth > 0 on sender at broadcast time
- Unlocked wallet's address ≠ `--address`
- No bins selected by the selector (empty position or wrong `--bins`)
- One or more chunks exceed 320 bins (should be impossible given router cap; defense-in-depth)

The skill will refuse and emit `status: "error"` for any of:

- `--slippage-bps` outside `[0, 10000]`
- `--min-position-usd` negative
- `--address` fails bech32 shape check
- `--bins` contains non-integer values
- `--bins`, `--all`, `--inactive-only` combined
- No TTY attached at `withdraw --confirm`
- Empty password entered

## Error handling

| Error | Cause | Fix |
|---|---|---|
| `Pool not found: <id>` | Bitflow pools API drift or wrong pool id | Run `doctor`; check the pool id via `bitflow pools` |
| `Invalid STX address` | `--address` failed shape check | Verify SP prefix and length |
| `Wallet address ... != --address ...` | Unlocked wallet doesn't own the position | Switch to the correct wallet (`wallet switch`) before running withdraw |
| `Mempool has N pending tx(s)` | Depth guard aborted — sender has pending txs | Wait for the pending tx via `mempool-watch tx-status` |
| `Pool cooldown: Nm remaining` | 4h cooldown hasn't cleared | Wait or run against a different pool |
| `Position value $X < floor $Y` | Dust-exit protection | Either lower `--min-position-usd` or skip |
| `Wallet password must be entered interactively. This command requires a TTY` | No TTY attached | Run the skill from a real terminal, not a pipe/cron/container without `tty:true` |
| `Withdraw broadcast failed: ...` | Router rejected the tx | Read `reason`; common causes: insufficient DLP balance, slippage violation, stale bin data. Re-run `plan` against fresh data. |

## Output handling

- `status`: `totals.expected_x` / `totals.expected_y` estimate recoverable tokens. `bins[].is_active` flags the active bin (exiting it is legal but usually undesirable).
- `plan`: always check `safe_to_broadcast` first. `blockers[]` lists every reason the plan can't proceed. `usd.usd_total` uses pool-endpoint prices and can be 0 when pricing is temporarily unavailable.
- `withdraw --confirm`: `data.txids[]` is ordered — chunk 1 first. Each entry carries `txid` + `explorer` URL.

## Chaining with other skills

Pairs well with:

- `mempool-watch` — poll `tx-status --txid` to confirm each chunk.
- `nonce-manager` — wrap `withdraw` in `acquire` / `release` for multi-write flows.
- `zest-yield-manager` — after withdraw confirms, supply the recovered tokens to Zest (HODLMM → Zest rotation).
- `hodlmm-risk` — score the position first; `recommendation: "withdraw"` is a natural trigger to call this skill.

## Frequency

- **Interactive:** once per session when exit is needed.
- **Autonomous:** blocked by design. The TTY requirement prevents `withdraw` from firing without a human; `doctor`, `status`, and `plan` can run in any context.
- **Never inside a retry loop without backoff.** A failed withdrawal is usually stale data or cooldown; retrying immediately loses money to gas.

## Example flow (live 11-bin position, 2026-04-19)

```bash
# 1. Verify upstream
bun run skills/hodlmm-position-exit/hodlmm-position-exit.ts doctor \
  --wallet SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY

# 2. Inspect holdings
bun run skills/hodlmm-position-exit/hodlmm-position-exit.ts status \
  --pool dlmm_1 \
  --address SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY

# 3. Dry-run the exit
bun run skills/hodlmm-position-exit/hodlmm-position-exit.ts plan \
  --pool dlmm_1 \
  --address SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY \
  --all

# 4. Confirm safe_to_broadcast: true, then execute.
#    Skill prints the withdrawal plan + prompts "Wallet password:" on stderr.
bun run skills/hodlmm-position-exit/hodlmm-position-exit.ts withdraw \
  --pool dlmm_1 \
  --address SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY \
  --all \
  --confirm
# → Wallet password: (echo suppressed)
# → tx be20b594… → block 7,663,125 → tx_status: success
```
