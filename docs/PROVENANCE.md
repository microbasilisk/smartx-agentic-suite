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

**`hodlmm-inventory-balancer`, criterion-met inventory correction.**
Transaction [`0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8`](https://explorer.hiro.so/txid/0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8?chain=mainnet), verified 2026-08-08. A single corrective swap on the `dlmm_1` sBTC/USDCx pool, submitted as part of bff-skills#494.

| Field | Value |
|---|---|
| Status | success |
| Contract | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1` |
| Function | `swap-simple-multi` |
| Block | 7,697,621 at 2026-04-22T04:54:59Z |
| Post-conditions | 2, in `allow` mode: sender sends at most 6,468 `sbtc-token`, pool sends at least 4,993,915 `usdcx-token` |
| Settled | 6,468 sats sBTC out, 5,004,174 micro-USDCx in |

The post-condition envelope pins both the send and the receive side, which is the property the skill was reviewed on.

**`hermetica-yield-rotator`, silo claim leg.**
Transaction [`0xe1f1598b6355f9b7fbe54599ed11e0609a7d1af46265feb0c88482e145902cc5`](https://explorer.hiro.so/txid/0xe1f1598b6355f9b7fbe54599ed11e0609a7d1af46265feb0c88482e145902cc5?chain=mainnet), verified 2026-08-08. Closes the leveraged yield cycle by redeeming USDh from the Hermetica silo after the 7 day cooldown.

| Field | Value |
|---|---|
| Status | success |
| Contract | `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-silo-v1-1` |
| Function | `withdraw` |
| Block | 7,789,631 at 2026-04-29T17:27:21Z |

**Multi-transaction proof run.** On 2026-04-22 a mainnet cycle exercised the write paths across the **Zest, Granite and Hermetica** skills, surfacing the Granite post-condition bugs documented in [SAFETY.md](SAFETY.md). Nine transactions are cited as proofs; the full window from block 7,702,816 to 7,703,650 contains 13 transactions including the deliberate failures, and cost 39,272 micro-STX in total, about $0.009 at the STX price on the day.

| Leg | Transaction | Result |
|---|---|---|
| Granite redeem, pre-fix | `0x5780062068` | `abort_by_post_condition`, bug evidence |
| Granite redeem, pre-fix | `0x60e2f84b83` | `abort_by_post_condition`, bug evidence |
| Granite redeem, post-fix | `0xd4aa0c4ed5` | success, validates the 3 post-condition fix |
| Zest sBTC withdraw | `0x016c3996f9` | success |
| Zest sBTC supply | `0x315a6d54c5` | success |
| Zest USDh borrow | `0x2b465aae05` | success |
| Zest USDh repay | `0xd3b46ae74b` | success |
| Zest non-USDh borrow | `0xb65535453a`, `0x0bfa434424`, `0xe388a8bdb9` | all `(err none)`, evidence for the USDh-only restriction |
| Hermetica unstake | `0x7834cd325b` | success, opens silo claim u2157 |

The earlier description of this run named HODLMM rather than Zest and put total gas at $0.045. Both were corrected on 2026-08-08 after pulling every transaction from the Hiro API. The only DLMM transaction in the window, `0x721c7c8776`, was a mid-session gas top-up swap, not a HODLMM liquidity write.

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
