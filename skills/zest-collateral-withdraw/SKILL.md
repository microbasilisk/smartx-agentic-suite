---
name: zest-collateral-withdraw
description: "Plans the withdraw of a whole Zest V2 collateral position in one coin as an unsigned transaction the wallet's owner signs. Never signs."
metadata:
  author: "cliqueengagements"
  author-agent: "Micro Basilisk (Agent 77), SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY | bc1qzh2z92dlvccxq5w756qppzz8fymhgrt2dv8cf5"
  user-invocable: "false"
  arguments: "doctor | status | plan"
  entry: "zest-collateral-withdraw/zest-collateral-withdraw.ts"
  requires: ""
  tags: "defi, write, mainnet-only, l2"
---

# Zest Collateral Withdraw

## What it does

Takes all of one coin (STX, sBTC or USDCx) that a wallet holds as collateral on Zest V2 back to that
wallet, in one transaction: `collateral-remove-redeem` on Zest's current market. The collateral
shares leave the collateral record and are redeemed for the coin in the same call.

`plan` prints that transaction unsigned, for the wallet's owner to review and sign in their own
wallet. There is no command that signs or broadcasts.

## When it refuses

- Zest's `v0-market-vault.get-impl` names a market this skill has not been checked against
  (today only `v0-8-market`). A write through any other market aborts.
- The account has any loan. Zest then checks fresh Pyth prices before letting collateral out,
  and this skill passes no price proof (`price-feeds none`).
- The wallet holds none of that coin as collateral.
- Zest has paused collateral removal, or the vault has paused redeeming.
- The vault's free balance is less than the withdraw (the rest is lent out).
- Any read fails. Nothing is assumed.

## Safety

- Deny mode. Nothing may leave the wallet.
- `v0-market-vault` sends at least the shares to the market, and the market at least the shares
  (the vault burns them from it).
- The vault sends at least the coin the shares redeem for at the time of planning. That value only
  grows with interest, and the same floor is passed as `min-underlying`, so the vault aborts below it.
- The receiver is the caller, the wallet that signs.

## Commands

- `doctor [--wallet <SP...>]`: checks Zest's current market is the reviewed one and whether
  collateral removal is paused.
- `status --wallet <SP...>`: the wallet's Zest collateral in STX, sBTC and USDCx, its loan count, and
  which coins this skill can withdraw.
- `plan --wallet <SP...> --asset <stx|sbtc|usdcx>`: the unsigned withdraw of all of that coin, in
  `data.instructions[0]`, with the conditions it carries summarised in `data.safety`.

Output is JSON with `status` of `success`, `blocked` (with `error.code`, `error.message`,
`error.next`) or `error`.
