# SmartX Agentic Suite

**AI agent skills for Bitcoin DeFi on Stacks.**

Fifteen skills that read live on-chain state, evaluate capital decisions against explicit safety gates, and produce actionable plans across the sBTC, HODLMM, Zest, Hermetica and Granite ecosystems. Five have been merged into the official AIBTC skill registry. Five have write paths proven on Stacks mainnet with real capital, each resolving to a transaction you can look up in [docs/PROVENANCE.md](docs/PROVENANCE.md).

This is the skill layer that [SmartX](https://smartx.finance) runs on.

Built by **Micro Basilisk (Agent #77)**.

---

## Why this exists

Most DeFi tooling tells you what your position is worth. It does not tell you whether acting on that information is worth the gas.

Every skill here answers a capital question and refuses to answer it badly. A yield opportunity that costs more in gas than it returns in a week is not surfaced as an opportunity. A rebalance proposed while the sBTC peg is unhealthy is blocked, not flagged. The judgment is in the gates, not in the dashboard.

## The lifecycle

The skills compose into a full liquidity management pipeline. Each stage consumes the output of the one before it.

| Stage | Skill | What it decides |
|---|---|---|
| **Scan** | `zbg-yield-scout` | Where your sBTC, STX and USDCx sit across Zest, HODLMM and Granite, and what the best safe move is |
| **Scan** | `smart-yield-migrator` | Whether a cross protocol migration clears its own gas cost |
| **Verify** | `sbtc-proof-of-reserve` | Whether the sBTC peg is actually backed, scored 0 to 100 with a GREEN, YELLOW or RED verdict |
| **Monitor** | `hodlmm-bin-guardian` | Whether an LP position has drifted out of its earning range |
| **Decide** | `hodlmm-rebalance-arbiter` | Combines drift and peg health into one REBALANCE, BLOCKED or IN_RANGE verdict |
| **Allocate** | `sbtc-capital-allocator` | Whether capital goes to HODLMM or Zest, and whether to deploy as a lump sum or DCA |
| **Allocate** | `usdcx-yield-optimizer` | Which HODLMM or XYK venue earns most on USDCx, ranked over every pool the Bitflow API returns |
| **Rotate** | `hermetica-yield-rotator` | Whether the Hermetica USDh versus HODLMM differential justifies moving |
| **Execute** | `stacks-alpha-engine` | Four protocol yield execution with three tier mapping and a multi gate pipeline |
| **Execute** | `hodlmm-move-liquidity` | Withdraw from drifted bins and redeploy around the active bin |
| **Correct** | `hodlmm-inventory-balancer` | Restores token ratio after one sided swap flow, gated on a 4 hour per pool cooldown |
| **Exit** | `hodlmm-position-exit` | Pure withdrawal back to raw wallet balances, no redeploy |
| **Exit** | `hodlmm-emergency-exit` | Full withdrawal when peg and drift signals converge |
| **Exit** | `zest-collateral-withdraw` | Takes all of one coin out of Zest collateral, as an unsigned transaction the wallet holder signs |
| **Identity** | `bns-agent-manager` | On-chain `.btc` name registration, transfer and management |

## Safety model

Three ideas run through every skill. They are documented in full in [docs/SAFETY.md](docs/SAFETY.md).

**Yield to Gas.** No action is recommended unless projected return clears its gas cost by a defined multiple. On small positions, gas ratio binds long before win rate does. Several skills implement this gate directly and refuse to emit a plan that fails it.

**Fail closed.** When a data source is stale, a price is unavailable or a peg check cannot complete, skills block rather than proceed on incomplete information. A missing signal is treated as a bad signal.

**Explicit approval on write paths.** Read-only skills return analysis. Write-capable skills emit a command specification for review rather than firing on their own judgment. The suite is designed so that a human or a wallet holder stays in the loop on anything that moves value.

## Proven on mainnet

These are not simulations. The five skills whose write paths have executed on mainnet:

- **`hodlmm-position-exit`** executed a live mainnet exit on 2026-04-19 at block 7,663,125, calling `withdraw-liquidity-same-multi` on `dlmm-liquidity-router-v-1-1`. Status success. Transaction [`be20b594...632e9811`](https://explorer.hiro.so/txid/0xbe20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811?chain=mainnet).
- **`hodlmm-inventory-balancer`** completed a three leg criterion-met rebalance on `dlmm_1` on 2026-04-18, moving the position from a 50% deviation to 0.05%. The withdraw and redeposit legs carry no post-conditions by design, because those router calls move liquidity across many bins; the bound on them is enforced at the contract level through `min-dlp`. A separate proof swap, `0xf4f49328...`, is what demonstrates the post-condition envelope pinned on both the send and receive sides.
- **`hermetica-yield-rotator`** closed a full leveraged yield cycle end to end, including the silo claim path. Transaction `0xe1f1598b...` on 2026-04-29, `staking-silo-v1-1.withdraw`, status success.
- **`stacks-alpha-engine`** drove the multi-transaction proof run of 2026-04-22 across Zest, Granite and Hermetica, which is also what surfaced the Granite post-condition bugs documented in [docs/SAFETY.md](docs/SAFETY.md). Nine transactions are cited as proofs, including the deliberate failures kept as bug evidence.
- **`zest-collateral-withdraw`** planned a whole USDCx Zest position that the owner signed through SmartX in their own wallet on 2026-09-17 at block 9,006,569: `v0-8-market.collateral-remove-redeem` in deny mode, 5.000012 USDCx back. Transaction [`ca780dea...8cc8b2ff`](https://explorer.hiro.so/txid/0xca780dea38b16a7c4a719060ec58c8d345397dbe989b90162332f2697cc8b2ff?chain=mainnet).

Full record with pull request links in [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Registry status

Five skills are merged into the official [AIBTC skill registry](https://github.com/aibtcdev/skills): `hodlmm-bin-guardian`, `hermetica-yield-rotator`, `stacks-alpha-engine`, `hodlmm-move-liquidity` and `hodlmm-inventory-balancer`. The remainder are production-quality entries that were either not selected or superseded by later work in the same family.

## Repository layout

```
skills/     15 production skills, each with SKILL.md, AGENT.md, README.md and a TypeScript implementation
archive/    superseded and deprecated work, kept with a written explanation
docs/       architecture, safety model and provenance
```

## Using a skill

Each skill directory contains:

- `SKILL.md`, the machine-readable definition an agent loads
- `AGENT.md`, operating instructions and decision rules
- `README.md`, human documentation with worked examples
- a TypeScript implementation with a CLI entry point

Skills read live on-chain state through the Hiro API and protocol-native endpoints. Nothing here holds keys.

## Status and warranty

This is working software that moves real value on a live network. It is offered as open source under the MIT license, without warranty. Read the code and understand the gates before running any write path against your own capital.

Two different statuses apply to these skills and they are worth keeping apart. As standalone software, the write paths listed above have executed on mainnet. As a library inside [SmartX](https://smartx.finance), a path is labelled **live** only once it has been walked and signed through SmartX by a real wallet, and three paths from this suite have been: `stacks-alpha-engine`'s HODLMM two coin deposit and its Zest deposit, and `zest-collateral-withdraw`'s Zest withdraw. The fifteen do not all sit in the same place, and they are no longer the whole of SmartX's library: it also carries skills from the aibtc core registry and from the Bitflow developer, admitted on authorship and held in review until each has been run. The table below is about these fifteen only:

| Status in SmartX | Count | What it means |
|---|---:|---|
| Under review | 12 | Runs and reaches its data sources, correctness not yet validated against a real position |
| In conversion | 2 | Needs a caller parameter or a plan-emitting change before it can be offered. `hermetica-yield-rotator` and `hodlmm-inventory-balancer` |
| Out of scope | 1 | `bns-agent-manager`, identity rather than asset management |

Of the 12 under review, the console will select from **10**. `hodlmm-position-exit` and `hodlmm-move-liquidity` run, but they still sign for themselves, so SmartX does not offer them until they emit a plan for the wallet holder to sign instead. SmartX shows the status on every answer it returns.

### Which copy SmartX actually runs, updated 2026-09-11

Five of these are also merged upstream, and for two of them **SmartX now resolves
the upstream copy rather than the one in this repository**: `hermetica-yield-rotator`
and `hodlmm-inventory-balancer`.

The reason is worth stating plainly, because it was a real defect rather than a
preference. This repository was built as a public showcase and became the runtime
without anybody diffing it against upstream again. By the time it was measured,
SmartX was running `hodlmm-inventory-balancer` **371 lines shorter** than the copy
that was reviewed and merged, missing that entire review chain. The reviewed copy
is the upstream one, so upstream wins now.

`stacks-alpha-engine` is one exception and still resolves here, because this copy
carries engine work upstream does not have.

`hodlmm-bin-guardian` and `hodlmm-move-liquidity` were added to that exception on
2026-09-11. SmartX started reading a second library that day (for the Bitflow swap
skill), and both names exist there too, in copies 61 and 106 lines different from
these. Those registry copies would have started in place of the ones SmartX
actually measured when it vetted them, so these two are held here until the
registry copies are measured in turn.

`zest-collateral-withdraw` joined the pinned list on 2026-09-17, when it moved here
from our registry fork. It exists only in this repository now, so this copy is the
one SmartX runs.

This repository is therefore the showcase it was built to be, and the source of
truth for the skills it holds that the registries do not, rather than for all fifteen.

## Related

- [SmartX](https://smartx.finance), the non-custodial product this suite powers
- [AIBTC skill registry](https://github.com/aibtcdev/skills), the upstream library

## License

MIT. See [LICENSE](LICENSE).
