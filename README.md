# SmartX Agentic Suite

**AI agent skills for Bitcoin DeFi on Stacks.**

Fourteen skills that read live on-chain state, evaluate capital decisions against explicit safety gates, and produce actionable plans across the sBTC, HODLMM, Zest, Hermetica and Granite ecosystems. Five have been merged into the official AIBTC skill registry. Four have write paths proven on Stacks mainnet with real capital, each resolving to a transaction you can look up in [docs/PROVENANCE.md](docs/PROVENANCE.md).

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
| **Allocate** | `usdcx-yield-optimizer` | Which of seven HODLMM pools and the XYK venues earns most on USDCx |
| **Rotate** | `hermetica-yield-rotator` | Whether the Hermetica USDh versus HODLMM differential justifies moving |
| **Execute** | `stacks-alpha-engine` | Four protocol yield execution with three tier mapping and a multi gate pipeline |
| **Execute** | `hodlmm-move-liquidity` | Withdraw from drifted bins and redeploy around the active bin |
| **Correct** | `hodlmm-inventory-balancer` | Restores token ratio after one sided swap flow, gated on a 4 hour per pool cooldown |
| **Exit** | `hodlmm-position-exit` | Pure withdrawal back to raw wallet balances, no redeploy |
| **Exit** | `hodlmm-emergency-exit` | Full withdrawal when peg and drift signals converge |
| **Identity** | `bns-agent-manager` | On-chain `.btc` name registration, transfer and management |

## Safety model

Three ideas run through every skill. They are documented in full in [docs/SAFETY.md](docs/SAFETY.md).

**Yield to Gas.** No action is recommended unless projected return clears its gas cost by a defined multiple. On small positions, gas ratio binds long before win rate does. Several skills implement this gate directly and refuse to emit a plan that fails it.

**Fail closed.** When a data source is stale, a price is unavailable or a peg check cannot complete, skills block rather than proceed on incomplete information. A missing signal is treated as a bad signal.

**Explicit approval on write paths.** Read-only skills return analysis. Write-capable skills emit a command specification for review rather than firing on their own judgment. The suite is designed so that a human or a wallet holder stays in the loop on anything that moves value.

## Proven on mainnet

These are not simulations. The four skills whose write paths have executed on mainnet:

- **`hodlmm-position-exit`** executed a live mainnet exit on 2026-04-19 at block 7,663,125, calling `withdraw-liquidity-same-multi` on `dlmm-liquidity-router-v-1-1`. Status success. Transaction [`be20b594...632e9811`](https://explorer.hiro.so/txid/0xbe20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811?chain=mainnet).
- **`hodlmm-inventory-balancer`** completed a three leg criterion-met rebalance on `dlmm_1` with post-conditions pinned on both send and receive sides.
- **`hermetica-yield-rotator`** closed a full leveraged yield cycle end to end, including the silo claim path.
- **`stacks-alpha-engine`** ships in the AIBTC registry with post-condition hardening, fail-closed guardian logic and corrected Granite and USDh paths.

Full record with pull request links in [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Registry status

Five skills are merged into the official [AIBTC skill registry](https://github.com/aibtcdev/skills): `hodlmm-bin-guardian`, `hermetica-yield-rotator`, `stacks-alpha-engine`, `hodlmm-move-liquidity` and `hodlmm-inventory-balancer`. The remainder are production-quality entries that were either not selected or superseded by later work in the same family.

## Repository layout

```
skills/     14 production skills, each with SKILL.md, AGENT.md, README.md and a TypeScript implementation
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

Two different statuses apply to these skills and they are worth keeping apart. As standalone software, the write paths listed above have executed on mainnet. As a library inside [SmartX](https://smartx.finance), all fourteen are listed **under review**: they run and reach their data sources, but they have not yet been re-validated against a real DeFi position under the product's own gates. SmartX shows that status on every answer it returns.

## Related

- [SmartX](https://smartx.finance), the non-custodial product this suite powers
- [AIBTC skill registry](https://github.com/aibtcdev/skills), the upstream library

## License

MIT. See [LICENSE](LICENSE).
