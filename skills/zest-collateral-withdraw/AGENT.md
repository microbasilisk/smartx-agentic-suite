---
name: zest-collateral-withdraw-agent
skill: zest-collateral-withdraw
description: "Plans a whole Zest collateral withdraw in one coin for the wallet's owner to sign."
---

# Agent Behavior - Zest Collateral Withdraw

This skill never signs. It hands the person an unsigned transaction to sign in their own wallet.

## Decision order

1. `status --wallet <address>` to see which coins the wallet holds as Zest collateral and whether
   it has a loan. Stop on `blocked` or `error` and say why. A coin missing from `withdrawable`
   cannot be withdrawn here: say why. (`doctor` checks the market and the collateral pause, both of which `plan` checks again.)
2. Confirm the person asked, in their own words, to take ALL of that coin out of Zest. This skill
   withdraws a whole position only.
3. `plan --wallet <address> --asset <coin>`. Relay `blocked` reasons plainly. On `success`, the
   transaction in `data.instructions[0]` is what the person reviews and signs.

## Guardrails

- Never choose the coin for the person; take it from what they asked.
- A wallet with a Zest loan is refused. Do not suggest a workaround that moves the loan.
- Never describe the withdraw as earning or claiming: it takes the coin out of Zest.
