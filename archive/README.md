# Archive

Work that was built, shipped and then set aside. It is kept here rather than deleted, because a record that only shows the wins is a record you cannot trust.

Nothing in this directory should be run. Each entry explains what it was for and why it stopped being part of the active suite.

## `hodlmm-tenure-protector`

**Status: deprecated, flawed premise.**

The skill attempted to correlate Bitcoin L1 block timing with toxic order flow risk against L2 liquidity positions, on the theory that L1 tenure boundaries create a predictable window where LP positions are exposed to stale-price arbitrage.

The premise did not hold up. The correlation the skill was built on was not strong enough to act on, and a gate that fires on a weak signal is worse than no gate at all, because it produces confident-looking output with nothing behind it.

It is archived rather than fixed because the problem is the hypothesis, not the implementation. Submitted as bff-skills#125, closed.

## `zbg-alpha-engine`

**Status: superseded.**

A four protocol yield executor covering Zest, Bitflow and Granite. Development hit a blocking bug in the Granite integration, and rather than patch around it the skill was rebuilt from the ground up as `stacks-alpha-engine`, which is in the active suite and merged into the AIBTC registry.

The successor covers the same ground with correct Granite handling, a proper post-condition model and a multi gate safety pipeline. Shipping both would present two skills that claim the same job, where one is known to be wrong.

Submitted as bff-skills#196, closed. Superseded by bff-skills#485.
