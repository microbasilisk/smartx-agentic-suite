# Architecture

## Composition, not features

These skills are not fourteen separate tools. They are stages in one pipeline, and the interesting behaviour comes from what they feed each other.

The clearest example is `hodlmm-rebalance-arbiter`. On its own it does nothing: it reads no chain state and moves no capital. It consumes two independent signals, bin drift from `hodlmm-bin-guardian` and peg health from `sbtc-proof-of-reserve`, and collapses them into a single verdict of REBALANCE, BLOCKED or IN_RANGE. That verdict is what a write-capable skill acts on.

The same pattern repeats. `hodlmm-emergency-exit` composes peg safety with bin-range analysis to decide whether to pull everything out. `stacks-alpha-engine` runs proof-of-reserve verification as one stage of a multi gate pipeline before it will execute anything.

Signal producers stay separate from decision makers, and decision makers stay separate from executors. A bad signal cannot directly cause a transaction; it has to pass a gate that was written to distrust it.

## The pipeline

```
   SCAN                VERIFY             DECIDE            ACT
   ----                ------             ------            ---
zbg-yield-scout ---.
smart-yield-       |
  migrator --------+--> sbtc-proof-of- --+--> hodlmm-      --+--> hodlmm-move-
hodlmm-bin-        |      reserve        |    rebalance-     |      liquidity
  guardian --------'                     |    arbiter        |
                                         |                   +--> hodlmm-inventory-
                                         |                   |      balancer
                                         '--> sbtc-capital-  |
                                              allocator      +--> hodlmm-position-
                                              usdcx-yield-   |      exit
                                              optimizer      |
                                              hermetica-     '--> hodlmm-emergency-
                                              yield-rotator         exit
```

## Protocol coverage

| Protocol | What the suite reads and does |
|---|---|
| **Bitflow HODLMM** | Concentrated liquidity across bins. Pool state, active bin, position range, deposit, withdraw, atomic move, inventory rebalance |
| **Zest** | Lending supply and yield comparison. Borrow paths are USDh only, a constraint proven the hard way |
| **Hermetica** | USDh staking APY, stake, unstake, withdraw-claim, silo claim and cross protocol rotation |
| **Granite** | Yield scanning and LP position reads |
| **ALEX** | APY comparison for migration decisions |
| **sBTC** | Peg reserve verification against real BTC backing |
| **BNS** | On-chain `.btc` identity registration, transfer and management |

## Data sources

Skills read live state. There is no cached snapshot layer and no indexer of our own.

- **Hiro API** for Stacks chain state, contract reads and transaction status
- **Bitflow app API** for HODLMM pool state and native price data
- **Protocol contracts directly** through read-only calls where an API would lag or mislead

That last point is a deliberate correctness choice. The DLMM active bin identifier is signed on chain but presented unsigned with an offset by the API, and the Bitflow active-bin cache can lag reality. Skills that care about correctness cross-check on chain before broadcasting rather than trusting the convenience endpoint.

## Skill anatomy

Every skill directory holds four files.

| File | Audience | Purpose |
|---|---|---|
| `SKILL.md` | Agent | Machine-readable definition, the contract an agent loads |
| `AGENT.md` | Agent | Operating instructions, decision rules, thresholds |
| `README.md` | Human | Documentation with worked examples |
| `<name>.ts` | Runtime | TypeScript implementation with a CLI entry point |

The split matters. `SKILL.md` is what an agent reads to decide whether this skill is the right one for a request. `AGENT.md` is what it reads to operate the skill correctly once selected. Keeping them separate is what makes runtime skill selection possible rather than requiring every skill to be pre-wired.

## Relationship to SmartX

[SmartX](https://microbasilisk.github.io/SmartX/) is a non-custodial product where a user connects their own wallet, asks in plain language for something to be done with their capital, and signs any resulting transaction themselves. The agent never signs for the user.

This suite is where that product's competence comes from, and the plan-emitting skills described in [SAFETY.md](SAFETY.md) are the shape that model requires: a skill that constructs a transaction and stops, leaving the signature to whoever holds the keys.

The suite also stands alone. Nothing here depends on SmartX, and every skill runs directly from its own CLI.
