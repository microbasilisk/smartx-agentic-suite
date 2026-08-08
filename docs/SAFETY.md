# Safety Model

Every skill in this suite is built to refuse. The value is not in what it will do, it is in what it declines to do when the numbers do not support acting.

## 1. Yield to Gas

**No action is recommended unless the projected return clears its own gas cost by a defined multiple.**

This is the gate that matters most on real positions. Gas ratio binds long before win rate does. A strategy that is right 70 percent of the time still loses money if each move costs more than it earns, and on smaller positions that is the normal case rather than the edge case.

Skills implementing a Yield-to-Gas gate directly: `smart-yield-migrator`, `usdcx-yield-optimizer`, `stacks-alpha-engine`.

The gate is a hard block, not a warning. A migration that fails Yield-to-Gas is not surfaced as a lower-ranked option; it is not surfaced at all.

## 2. Fail closed

**A missing signal is treated as a bad signal.**

When a price feed is stale, an API is unreachable, or a peg check cannot complete, skills block rather than proceed on partial information. Guardian logic in `stacks-alpha-engine` and the verdict path in `hodlmm-rebalance-arbiter` both default to the blocking outcome when an input is absent.

This is deliberate and it costs opportunities. It also means an agent operating unattended cannot be walked into a bad position by a degraded data source, which is the failure mode that actually destroys capital.

## 3. Peg verification before capital deployment

**`sbtc-proof-of-reserve` is the pre-flight check for anything touching sBTC.**

It derives the signer P2TR wallet from the Stacks registry, compares real on-chain BTC backing against circulating supply, and returns a 0 to 100 peg health score with a GREEN, YELLOW or RED verdict. Other skills consume that verdict rather than assuming the peg holds. `hodlmm-emergency-exit` composes it with bin drift to decide whether to withdraw entirely.

## 4. Post-conditions on write paths

Stacks post-conditions bound what a transaction is allowed to move, and the chain rejects anything outside those bounds regardless of what the contract does. This is the control that protects a position even when every other check has been passed and a human has already clicked approve.

The suite has real scar tissue here. Known traps documented across these skills include: the post-condition builder having no receive-side assertion, so receive-side pins must be anchored on the pool or sender principal; Granite redeem post-conditions failing on three independent axes (wrong principal, wrong asset name, wrong direction); and DLMM bin identifiers being signed on chain while the API presents them unsigned with an offset.

`hodlmm-inventory-balancer` ships with post-conditions pinned on both the send and receive legs, proven in a live three leg rebalance.

## 5. Cooldowns and slippage floors

Write-capable HODLMM skills enforce a 4 hour per pool cooldown, so a misfiring loop cannot churn a position. `hodlmm-position-exit` adds per-bin slippage floors, an aggregate minimum-out, and a mempool depth guard, and it prompts for a password interactively rather than accepting one from an environment variable or a command line flag.

## 6. Read-only by default, explicit approval on writes

Skills fall into two shapes.

**Analysis skills** return information and recommendations with nothing to sign: `zbg-yield-scout`, `sbtc-proof-of-reserve`, `hodlmm-bin-guardian`, `hodlmm-rebalance-arbiter`, `smart-yield-migrator`.

**Plan-emitting skills** produce an executable command specification for review rather than firing on their own judgment: `usdcx-yield-optimizer`, `hermetica-yield-rotator`, `hodlmm-emergency-exit`, among others.

That second shape matters beyond this repository. A skill that can construct a transaction without signing it is a skill that can run under a non-custodial model, where the person holding the keys signs and the agent never does. That is the design SmartX is built on.

A formal per-skill classification into read-only, plan-only and self-signing is in progress. Until it is published, treat the grouping above as descriptive of intent rather than an audited guarantee, and read the implementation before running any write path against your own capital.

## What this model does not cover

Two things are honestly out of scope today and are being addressed at the product layer rather than here.

**Upstream trust.** A skill resolved at runtime from a registry maintained by others puts those maintainers inside your trust boundary. Pinning to reviewed commit hashes is the mitigation, and it belongs to whatever runs the skill, not to the skill itself.

**Untrusted chain text.** Token names, memos and contract metadata are written by whoever deployed the contract. Any agent reading positions ingests that text. It must be treated as data to display, never as instructions to follow.
