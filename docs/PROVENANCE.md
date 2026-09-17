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

[aibtcdev/skills#415](https://github.com/aibtcdev/skills/pull/415) is **open, not
merged**, opened 2026-08-29. It corrects the HODLMM entry tiering: a wallet
holding one side of a pair was tiered `deploy_now` and given the pool's full APY
with a daily figure, when `dlmm-core-v-1-1` places a one sided deposit outside the
active bin and therefore outside the range where fees accrue. The size was also
taken from the larger side rather than being bounded by the smaller one. 18 lines
in, 3 out.

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

**`hodlmm-inventory-balancer`, three leg rebalance.** A criterion-met inventory correction on the `dlmm_1` pool, submitted as part of bff-skills#494. Three sequential transactions on 2026-04-18, each waiting for on-chain confirmation before the next, all verified 2026-08-08.

| Leg | Transaction | Function | Block, time |
|---|---|---|---|
| 1. Withdraw slice | [`0x89315a8b93…`](https://explorer.hiro.so/txid/0x89315a8b935b3e4db32ad753b77af4bf853f28dc5b04ca6aa25d7cca9fc1cf8a?chain=mainnet) | `withdraw-relative-liquidity-same-multi` | 7,641,869 at 03:15:29Z |
| 2. Corrective swap | [`0x5195822ee3…`](https://explorer.hiro.so/txid/0x5195822ee36c9658ed0e17659a4fd80218da9aeb703f03ee4ee758d5a7f0d3c8?chain=mainnet) | `swap-simple-multi` | 7,641,891 at 03:18:34Z |
| 3. Redeposit | [`0x135f490ca3…`](https://explorer.hiro.so/txid/0x135f490ca3f7b2862c3bd2eb33124bcd99e9ce2d93331865ad1dfd2065d6f53c?chain=mainnet) | `add-relative-liquidity-same-multi` | 7,641,905 at 03:20:57Z |

All three succeeded on `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD`. The position moved from 0% X and 100% Y, a 50% deviation, to 49.95% X and 50.05% Y, a deviation of 0.05%, well inside the plus or minus 5% band.

A separate proof swap, [`0xf4f4932800…`](https://explorer.hiro.so/txid/0xf4f4932800a80234845a8d199556ad9c0ff4aa99874a95c819c13779b164cbc8?chain=mainnet) at block 7,697,621 on 2026-04-22, demonstrates the post-condition envelope the skill was reviewed on: two conditions pinning both sides, sender sends at most 6,468 `sbtc-token` and the pool sends at least 4,993,915 `usdcx-token`, settling 6,468 sats for 5,004,174 micro-USDCx.

The withdraw and redeposit legs carry no post-conditions, which is deliberate. Those router calls move liquidity across many bins, so enumerating every asset movement is impractical and fragile. The bound on those legs is enforced at the contract level instead, through `min-dlp` at 95% of input and a maximum fee of 5%, with a sender-side `willSendLte` cap on the swap leg.

**`hermetica-yield-rotator`, silo claim leg.**
Transaction [`0xe1f1598b6355f9b7fbe54599ed11e0609a7d1af46265feb0c88482e145902cc5`](https://explorer.hiro.so/txid/0xe1f1598b6355f9b7fbe54599ed11e0609a7d1af46265feb0c88482e145902cc5?chain=mainnet), verified 2026-08-08. Closes the leveraged yield cycle by redeeming USDh from the Hermetica silo after the 7 day cooldown.

| Field | Value |
|---|---|
| Status | success |
| Contract | `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.staking-silo-v1-1` |
| Function | `withdraw` |
| Block | 7,789,631 at 2026-04-29T17:27:21Z |

**`zest-collateral-withdraw`, a whole Zest collateral position back to the wallet.**
Transaction [`0xca780dea38b16a7c4a719060ec58c8d345397dbe989b90162332f2697cc8b2ff`](https://explorer.hiro.so/txid/0xca780dea38b16a7c4a719060ec58c8d345397dbe989b90162332f2697cc8b2ff?chain=mainnet), verified 2026-09-17. Planned by the skill, checked by SmartX at signing, and signed by the owner in their own wallet, closing a round trip that opened with a 5 USDCx Zest deposit through SmartX ([`0xab4d1392...231a`](https://explorer.hiro.so/txid/0xab4d13928311991db7bedc2ac0f7c9918361701018fa5ac1cfa285ffc938231a?chain=mainnet), 2026-09-16).

| Field | Value |
|---|---|
| Status | success, `(ok u5000012)` |
| Contract | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market` |
| Function | `collateral-remove-redeem` |
| Sender | `SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF` |
| Post-conditions | deny mode: `v0-market-vault` and the market each send at least 4,987,928 zft, `v0-vault-usdc` sends at least 5,000,012 usdcx-token |
| Block | 9,006,569 at 2026-09-17T00:43:35Z |

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
