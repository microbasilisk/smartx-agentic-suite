# Zest Collateral Withdraw

Takes all of one coin you hold as collateral on Zest V2 back to your wallet, as an unsigned transaction you sign in your own wallet. The skill never signs and holds no keys.

Built for [SmartX](https://smartx.finance), where it is the Zest withdraw a person asks for in plain words ("withdraw all my usdcx from zest").

## What it does

A Zest deposit made through the market leaves your coin in a Zest vault and holds the vault's shares (`zft`) for you as collateral. Taking it out is one call on Zest's current market, `collateral-remove-redeem`: the collateral record hands your shares to the market, the vault burns them there, and the vault pays the coin back to you.

`plan` reads everything that decides whether that call can work, sizes it from Zest's own contracts, and prints the transaction for you to review and sign. `status` shows what you hold on Zest. `doctor` checks Zest has not moved to a market this skill has not been checked against.

Coins: **STX, sBTC and USDCx.** Scope: **the whole position in one coin.** Part of a position is not built.

## Why agents need it

An agent that recommends depositing into Zest must also be able to get the person out again, without holding their key. The Zest skills in the aibtc registry are built for an agent acting with its own wallet; this one hands the unsigned transaction to the person instead, with limits the chain enforces.

## When it refuses, before anything is signed

| Code | When |
|---|---|
| `UNREVIEWED_MARKET` | `v0-market-vault.get-impl` names a market other than `v0-8-market`. Zest routes writes through its current market only, and a write through any other aborts (a Zest deposit through `v0-4-market` aborted with `ERR-AUTH u600001` on 16 September 2026). |
| `HAS_LOAN` | The account owes anything on Zest. Zest then reads fresh Pyth prices before letting collateral out, and this skill passes no price proof. |
| `NOTHING_TO_WITHDRAW` | The wallet holds none of that coin as collateral, or the shares redeem for nothing. |
| `PAUSED` | Zest has paused collateral removal, or the coin's vault has paused redeeming. |
| `INSUFFICIENT_LIQUIDITY` | The vault's free balance is below what the shares redeem for, because the rest is lent out. |
| `UNSUPPORTED_ASSET` | A coin other than STX, sBTC or USDCx. |
| `READ_FAILED` | Any read failed or came back in an unexpected shape. Nothing is assumed. |

## The transaction and its limits

`collateral-remove-redeem(vault, shares, min-underlying, none, none)` on `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market`, in **deny mode**, with exactly three post-conditions and **none on your wallet**, so nothing can leave it:

1. `v0-market-vault` sends at least the shares (`<vault>::zft`) to the market.
2. The market sends at least the shares (the vault burns them from the market, and a burn counts as a send).
3. The vault sends at least `min-underlying` of the coin to you (STX: a native `stx` condition, since the STX vault pays through `wstx`, a bare STX transfer).

`min-underlying` is exactly what the shares redeem for when planned. The read-only `convert-to-assets` uses the same preview `redeem` pays out with, and the value of a share never falls with time, so the transaction aborts only on a loss event in the vault, a pause, or missing liquidity. Receiver `none` means the coin goes to the caller, the wallet that signs.

## Commands

```bash
bun run skills/zest-collateral-withdraw/zest-collateral-withdraw.ts doctor --wallet <SP...>
bun run skills/zest-collateral-withdraw/zest-collateral-withdraw.ts status --wallet <SP...>
bun run skills/zest-collateral-withdraw/zest-collateral-withdraw.ts plan --wallet <SP...> --asset <stx|sbtc|usdcx>
```

Every command prints JSON: `{ "status": "success" | "blocked" | "error", "action", "data", "error" }`, with `error` holding `code`, `message` and `next` when not successful.

## Worked example

A wallet holding 5 USDCx on Zest as collateral (4,987,928 vault shares, no loan), planned on 16 September 2026:

```bash
bun run skills/zest-collateral-withdraw/zest-collateral-withdraw.ts plan --wallet SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF --asset usdcx
```

```json
{
  "status": "success",
  "action": "plan",
  "error": null,
  "data": {
    "wallet": "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
    "asset": "usdcx",
    "market": "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    "shares": "4987928",
    "underlying": "5000002",
    "sizedFrom": "Zest contracts (get-impl, get-position, get-pause-states, convert-to-assets, get-available-assets)",
    "safety": {
      "postConditionMode": "deny",
      "postconditions": [
        "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault sends >= 4987928 SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc::zft",
        "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market sends >= 4987928 SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc::zft",
        "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc sends >= 5000002 USDCx"
      ],
      "note": "Nothing may leave the wallet. These are exactly the conditions data.instructions[0] carries."
    },
    "instructions": [
      {
        "tool": "call_contract",
        "description": "Withdraw all your USDCx from Zest: at least 5.000002 USDCx back to your wallet",
        "params": {
          "contractAddress": "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7",
          "contractName": "v0-8-market",
          "functionName": "collateral-remove-redeem",
          "functionArgs": [
            { "type": "principal", "value": "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc" },
            { "type": "uint", "value": "4987928" },
            { "type": "uint", "value": "5000002" },
            { "type": "none" },
            { "type": "none" }
          ],
          "postConditionMode": "deny",
          "postConditions": ["... the three conditions above ..."],
          "delivers": ["SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token"]
        }
      }
    ]
  }
}
```

The same wallet after the withdraw, with nothing left to take out:

```json
{ "status": "blocked", "action": "plan", "data": {},
  "error": { "code": "NOTHING_TO_WITHDRAW", "message": "This wallet holds no USDCx collateral on Zest.", "next": "Read the wallet's Zest positions first." } }
```

## Proven on mainnet

Planned by this skill, checked by SmartX at signing, and signed by the owner in their own wallet:

| Field | Value |
|---|---|
| Transaction | [`0xca780dea38b16a7c4a719060ec58c8d345397dbe989b90162332f2697cc8b2ff`](https://explorer.hiro.so/txid/0xca780dea38b16a7c4a719060ec58c8d345397dbe989b90162332f2697cc8b2ff?chain=mainnet) |
| Status | success, `(ok u5000012)` |
| Block | 9,006,569 on 2026-09-17 |
| Call | `v0-8-market.collateral-remove-redeem(v0-vault-usdc, u4987928, u5000012, none, none)` |
| Post-condition mode | deny, the three conditions above, all held |
| What moved | 4,987,928 zft from `v0-market-vault` to the market, burned from the market, then 5.000012 USDCx from `v0-vault-usdc` to the wallet |

It closed a round trip that began with a 5 USDCx Zest deposit through SmartX ([`0xab4d1392...231a`](https://explorer.hiro.so/txid/0xab4d13928311991db7bedc2ac0f7c9918361701018fa5ac1cfa285ffc938231a?chain=mainnet), 16 September 2026).

## Tests

```bash
bun test skills/zest-collateral-withdraw
```

Nineteen cases against recorded chain reads: the owner's plan built exactly, the STX payout shape, the asset table against Zest's share ids, and every refusal above (an unreviewed or old market, an unreadable or untracked position, any loan, a coin not held, pauses, zero value, too little free in the vault, a record naming a coin twice), plus the market being checked before the position is read.

## Safety notes

- Never signs, never broadcasts, holds no key. There is no `run` command.
- Mainnet only. Reads through `HIRO_API` when set (SmartX points it at its keyed Hiro proxy), otherwise `https://api.hiro.so`.
- Refuses any account with a loan rather than guess a price.
- Refuses a Zest market it has not been checked against, so a Zest upgrade stops it instead of building a transaction that aborts.
