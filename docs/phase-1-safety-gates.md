# Phase 1: truth on the screen, landed after thirteen review rounds

`skills/stacks-alpha-engine/stacks-alpha-engine.ts` plus its docs, and a new
`skills/stacks-alpha-engine/tests/deploy-guards.test.ts`. Nothing is committed and
nothing is deployed.

**Read the roadmap before this file.** It is the specification for the whole build:
https://claude.ai/code/artifact/36bbc5fc-b655-4894-a994-a2f6291b3a00
Subagents cannot open artifacts; hand them
`smartx-app/docs/roadmap-snapshot-2026-08-28.md` instead.

## Where it stands

**203 test cases, all passing.** Typecheck clean unfiltered. No dashes anywhere.

Round counts: **9, 11, 4, 10, 9, 18, 12, and round eight's set.** Nearly every
round found defects caused by the previous round's fixes. Phase 0 took six rounds;
this has taken eight, and round eight found a live units bug in the slippage gate
that Phase 1's OWN first fix had exposed: the gate compared a price denominated in
the pool's quote token against a price in USD, which is a multiply by one for the
seven pools quoted in a dollar stablecoin and a factor of 79,416 for `dlmm_6`. It
printed 99.9987% divergence where the truth measured between 0.244% and 0.71%.

**Landed 2026-08-28 after eight rounds, without a ninth.**

The rule that ended it: **a round blocks only on a live path to user harm.** Money
moving that the user did not authorise, a false statement shown to a user, or a
wrong answer about whose money is whose. Everything else is recorded and carried.
An earlier gloss of mine, "until clean, three is not a ceiling", had no termination
condition and is what produced eight rounds where round seven was fixing wording in
a documentation file.

All three of the phase's acceptance tests were re-verified by running them before
the push, not by reading this file:

- the gate measures the pool it recommends: live scan recommended `dlmm_4` and both
  rows read `dlmm_4`, failing at 11.34% slippage and $5,729 volume
- a check that cannot run reports unknown: all ten non-measuring routes, four of
  them forced through the real `checkGuardian`
- the counter token is never filled from a balance: verified in both directions,
  and both sides named explicitly still works

203 cases pass, typecheck clean with `@types/node` and `@types/bun` present.

## The phase's three items, against the roadmap's own acceptance tests

1. **The safety table measures the pool being recommended.** Done, and now guarded.
   Verified live: the report recommends `dlmm_4` and both rows read `dlmm_4`, which
   correctly fails on 10.86% slippage and $5,729 volume.
2. **A slippage check that cannot run reports unknown, never a pass, proved by a
   control that forces the failure.** Done, and stated precisely because an earlier
   version of this line overstated it by ten times.

   All ten non-measuring routes are forced through the PURE `classifySlippage`.
   **Four of the eleven outcomes are additionally forced through the real
   `checkGuardian`** with its reads injected: the dead pools endpoint, a contract
   that returns no active bin, a bins fetch that throws, and the measuring path.
   That distinction matters: hardcoding the whole `classifySlippage` call inside
   `checkGuardian` to a pass used to leave the suite green, and so did hardcoding
   `activeBinOkay = true`, which turns a failed contract read into a measurement.
   Both are now killed.

   **One known gap, stated rather than papered over:** `liveGuardianReads`'s own
   `.catch(() => null)` on the pools fetch is not test reachable, because forcing
   it needs the module's own network call to fail. Reverting it to `[]` survives
   the suite. The effect is a worse REASON on a dead endpoint ("not in the pools
   returned" instead of "the endpoint did not answer"), not a safety hole: both
   still block.
3. **The counter token amount is never filled from the balance, proved by naming
   one amount while holding the other token.** Done, and this item was NOT proved
   until round eight. No case held both tokens and named one amount, so the
   historical fallback survived all 184 cases untouched. The "kills 13 cases"
   claim previously here was measuring a clumsier mutant that broke the bin
   offsets; the faithful one killed nothing. Both directions of the pair are now
   pinned, and the faithful mutant dies.

## The four lessons this phase cost the most to learn

**1. Widen one side of a rule and you have made a new gap.** Three separate rounds
did it: a balance guard moved into a shared builder broke `migrate` outright, a
pool/token check was added to `migrate` and not `deploy`, and an unknown-pool-id
check was added to `deploy` and not `migrate` in the very round whose comment
complained about the pattern.

**2. A gate nobody can force cannot be proved to fail closed.** The acceptance
control for item 2 could not be written while the decision sat inside a closure
around live `fetch` calls. Extracting `classifySlippage` made it testable. **That
was not enough**: round seven replaced the whole call to it inside `checkGuardian`
with a hardcoded pass and all 165 cases stayed green, which is verbatim the
`PASS | 0%` this phase exists to delete. The reads are now injectable and the
failure is forced through the function a person's money actually passes through.

**3. The fix a round is proudest of is the one most likely to have no test.** Four
times now: the `rebalance` gate, the token normalisation, the option selector, and
the phase's own headline item, where reverting the recommended pool to the old
hardcoded `dlmm_1` was invisible to 165 cases.

**4. Assert the REASON, never just the refusal.** Three times. Most recently two
mutations survived the new forced-failure control because a different guard caught
the same input for a different reason.

## What is verified against what

- **The chain**, re-measured 2026-08-28: 37 recent Hermetica stakes, all deny,
  36 of 37 succeeded. Hiro's fee rate ran 6 to 585 microSTX per byte within hours.
  The Bitflow endpoint returns 17 pools; this engine addresses 8.
- **Upstream at `5b71650`**: our fork deliberately uses deny where upstream uses
  allow for Hermetica stake and Granite deposit. Upstream is internally consistent
  and wrong on chain; our fork is right and its doc was inherited stale.
- **The KB**: conformance table is in KB section 8 under Phase 1.

## Still open, and deliberately not fixed here

- **Hermetica `unstake` is still allow mode, and SmartX cannot sign it.** A burn IS
  attributed to a sender, so deny is achievable. Known defect, not design.
- **A residual gap in the uncovered-pools warning**: it appears only when no pool
  was measured, so a report measuring `dlmm_4` says nothing about other HODLMM
  options listed as deployable. The row does name the pool it measured, so item 1
  is still met.
- Nine Phase 8 items recorded in `smartx-app/docs/BUILD-ORDER.md`, including the
  per-action STX check the roadmap's entry ladder requires, BigInt amounts, dynamic
  pool eligibility, matched freshness, and the per-pool cooldown.

## Carried forward, judged against the harm threshold and found not to reach it

None of these moves money unasked, shows a user a false statement, or confuses
whose money is whose. Each is recorded rather than fixed here.

1. **`liveGuardianReads`'s own `.catch(() => null)` is not test reachable**, because
   forcing it needs the module's network call to fail. The effect is a worse REASON
   on a dead endpoint, "not in the pools returned" rather than "the endpoint did not
   answer". Both still block. A missing test over correct code.
2. **Hermetica `unstake` is still allow mode and SmartX cannot sign it.** Pre-dates
   this phase. A missing capability, not a false statement. Belongs with Phase 8.
3. **The uncovered-pools warning appears only when no pool was measured**, so a
   report measuring `dlmm_4` says nothing about other options listed as deployable.
   The row names the pool it measured, so the table is silent about the others
   rather than wrong about them, and the tier itself is about token holdings and not
   gates. Belongs with Phase 4, which labels each option by its rung.

## Before this was pushed

Round eight, because round seven called for fixes. Then commit and push, staging
by explicit path. **Never `Caddyfile` or `Caddyfile.bak-*`**: they are the LAB
site's live staging block, not this work.

## Pushing this cannot deploy anything

Production clones this repo at `SUITE_COMMIT`, pinned in
`smartx-app/docker-compose.yml` to `2c56269`. New commits here are invisible until
that pin moves and the image is rebuilt, which is a deploy and needs the user to
say so, that time.

---

# Part two, 2026-08-28: the tiering, and four more rounds

The three gate fixes above landed first. Then the report still carried a false
dollar figure, so the phase reopened for the thing its own heading promised.

## What a wallet holding only STX used to be told

Four pools under "You can deploy now", each with an APY and a daily figure. Every
one is a pair and the wallet holds one side, so the deposit those build is one
sided, which the contract's own invariants place outside the active bin and
therefore outside the earning range. `$0.0631 a day` was money the person would
not receive.

## What changed

- **Holding one side of a pair is not readiness.** It is `swap_first` now, with a
  note naming what to swap into. `deploy_now` means both sides held.
- **The size is bounded by the smaller side**, doubled, not the larger. The old
  figure described a position the wallet cannot fund.
- **Each option carries its own gate result**, three states: passed, failed, not
  measured. Two would have confused "nobody looked" with "measured and failed",
  which is the defect part one fixed one layer down.
- **The headline is written from the OPTION**, not from its tier, so it no longer
  tells a wallet holding neither side that it holds one, or promises "both sides in
  the pool" to Hermetica staking and Granite lending, which have no pair.
- **A zero yield option cannot silence the headline** by outranking a live one.
- **The safety table and the headline ask the same function** which option is
  recommended, so they cannot contradict each other in print.
- **Readiness is decided from the amount held, sized from its dollar value.** They
  are the same thing until a price feed fails, and then they are not.

## Rounds four and five, in one line each

Round four: a warning called swap-first pools "ready to deploy into" on a page
telling the reader to swap first. Round five: nothing blocked.

## The two lessons, which cost the thirteen rounds

**Write the sentence from the thing, not from its category.** Four separate rounds
found the same fault wearing different clothes: a claim about a group that was true
of only some of it. The gates covered "the recommendation". The column said "not
measured". The headline said "you hold one side". The warning said "ready to
deploy". Each fix was right and each left a sibling untouched.

**If a guard sits where a test cannot reach, move the guard, not the test.** Eleven
mutations survived round one because the decisions lived inside functions that do
network reads. The answer was to lift each into a pure exported function, and where
even that could not reach, to make removal a COMPILE ERROR: `sides` is required on
an option and the amounts are required parameters precisely so the regression
cannot re-enter quietly. Writing another unreachable test is how eight rounds
happened.

## Carried, recorded rather than fixed

None of these moves money, misstates whose money is whose, or shows a person
something false.

1. **The call site is still not held by anything.** Deleting the marking call
   leaves all 254 cases and the typecheck green, and the same is true of the gate
   cell, the pair note and the verdict line, because the renderer is not exported.
   One exported render wrapper with one case would cover all four at once. This is
   the round four defect class surviving one line up.
2. **Deploy and migrate payloads understate the gates**, because the marking pass
   runs only in `scan`. Never overstates, and those paths refuse anyway.
3. **`needsSwap` is dead in production**, consumed only by tests. The wording comes
   from the option's own sides instead.
4. The Gates column says "not measured" for unpaired products where the safety
   table three sections down says "not applicable". Two words for one fact.
5. Cosmetic: a double blank line when the pair note does not fire.
