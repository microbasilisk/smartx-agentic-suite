# Provenance

Where these skills came from and how to verify the claims made about them.

## Origin

The suite was built over a 30 day open build in the AIBTC and Bitflow skills competition during March and April 2026. Skills were submitted publicly, reviewed by maintainers and competing agents, and either merged into the official registry or closed. Every pull request below is public and can be read in full, including the review threads and the rejections.

## Registry merges

Five skills were merged into the official [AIBTC skill registry](https://github.com/aibtcdev/skills) or the Bitflow staging repository that feeds it.

| Skill | Pull request | Registry |
|---|---|---|
| `hodlmm-bin-guardian` | [bff-skills#39](https://github.com/BitflowFinance/bff-skills/pull/39) | Merged |
| `hermetica-yield-rotator` | [bff-skills#56](https://github.com/BitflowFinance/bff-skills/pull/56) | Merged |
| `stacks-alpha-engine` | [bff-skills#485](https://github.com/BitflowFinance/bff-skills/pull/485) | Merged, upstream [aibtcdev/skills#339](https://github.com/aibtcdev/skills/pull/339) |
| `hodlmm-move-liquidity` | [bff-skills#231](https://github.com/BitflowFinance/bff-skills/pull/231) | Merged, registry [aibtcdev/skills#317](https://github.com/aibtcdev/skills/pull/317) |
| `hodlmm-inventory-balancer` | [bff-skills#494](https://github.com/BitflowFinance/bff-skills/pull/494) | Merged, independently validated |

Later hardening work on `stacks-alpha-engine` landed upstream through [aibtcdev/skills#367](https://github.com/aibtcdev/skills/pull/367) and [aibtcdev/skills#379](https://github.com/aibtcdev/skills/pull/379), covering post-condition fixes, fail-closed guardian logic, the corrected Granite path, USDh borrow handling and a stale-price guard.

## On-chain proof

**`hodlmm-position-exit`, live mainnet exit.**
Transaction [`be20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811`](https://explorer.hiro.so/txid/0xbe20b59464b94286cd6478483fcdf41b2eec21b2c496ed821aa004fd632e9811?chain=mainnet), verified 2026-08-08.

| Field | Value |
|---|---|
| Status | success |
| Type | contract call |
| Contract | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1` |
| Function | `withdraw-liquidity-same-multi` |
| Sender | `SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY` |
| Block | 7,663,125 at 2026-04-19T16:09:45Z |

**`hodlmm-inventory-balancer`, three leg rebalance.** Completed a criterion-met inventory correction on the `dlmm_1` pool with post-conditions pinned on both the send and receive legs, submitted as part of bff-skills#494.

**`hermetica-yield-rotator`, full leveraged cycle.** Closed an end to end leveraged yield cycle on mainnet including the Hermetica silo claim path, redeeming USDh at block 7,789,631.

**Multi-transaction proof run.** A nine transaction mainnet cycle exercised every write path across the HODLMM, Granite and Hermetica skills for roughly $0.045 in total gas, surfacing the Granite post-condition bugs documented in [SAFETY.md](SAFETY.md).

## Not selected

Nine skills were submitted and not merged. They are shipped here because the code is production quality and the analysis is sound, not because they won anything.

`smart-yield-migrator`, `sbtc-proof-of-reserve`, `hodlmm-emergency-exit`, `usdcx-yield-optimizer`, `hodlmm-rebalance-arbiter`, `zbg-yield-scout`, `sbtc-capital-allocator`, `bns-agent-manager`, `hodlmm-position-exit`.

Two of these carry more weight than their status suggests. `sbtc-proof-of-reserve` is consumed as a dependency by three other skills including two that were merged, so it is load-bearing regardless of its own outcome. `hodlmm-position-exit` holds the strongest on-chain proof in the entire suite.

## Archived

Two skills were removed from the active set rather than shipped. Both are kept in `archive/` with an explanation, because deleting work that did not pan out makes the record less trustworthy, not more. See [archive/README.md](../archive/README.md).

## Verifying any of this

Every claim above resolves to something public.

- Pull requests: open the linked GitHub URL, read the diff and the review thread
- Registry membership: search [aibtcdev/skills](https://github.com/aibtcdev/skills) for the skill name
- Transactions: paste the transaction hash into [explorer.hiro.so](https://explorer.hiro.so) or query the Hiro API directly

If a claim in this repository cannot be verified through one of those routes, treat it as an error and open an issue.
