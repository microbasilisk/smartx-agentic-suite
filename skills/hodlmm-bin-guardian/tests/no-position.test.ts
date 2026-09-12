/**
 * A wallet with nothing in the pool must never be told to rebalance.
 *
 * Run it from a checkout with the suite dependencies installed:
 *   bun run skills/hodlmm-bin-guardian/tests/no-position.test.ts
 * Exit code 0 means every case passed. There is no runner in this repo yet, so
 * this file is its own runner, in the shape of the engine's test file.
 *
 * It imports the SHIPPED skill, not a copy, so it cannot keep passing after the
 * real file drifts. Every case asserts the WORD the person reads, because the
 * defect was not a crash: the skill reported success while its headline said
 * REBALANCE and its own detail line said no position was found.
 */
import { actionLine } from "../hodlmm-bin-guardian.ts";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail: string) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};

// The live shape that produced the wrong headline: every gate passing, the
// pool fine, and the wallet holding nothing in it.
const gatesPass = { canRebalance: true, activeBinId: 653, apr24h: 166.19, refusals: [] as string[], userBinRange: null };

const noneFound = actionLine({
  ...gatesPass, noPosition: true, inRange: null,
  positionNote: "No position found for SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY in pool dlmm_1.",
});
check("no position found says so, with every gate passing",
  noneFound.startsWith("NO POSITION:"), noneFound);
check("no position found never says REBALANCE",
  !noneFound.includes("REBALANCE"), noneFound);

const emptyBins = actionLine({
  ...gatesPass, noPosition: true, inRange: null,
  positionNote: "The pool lists 221 bins for this wallet, all with zero liquidity.",
});
check("a position record with no liquidity is also nothing to rebalance",
  emptyBins.startsWith("NO POSITION:") && !emptyBins.includes("REBALANCE"), emptyBins);

const noWallet = actionLine({
  ...gatesPass, noPosition: false, inRange: null,
  positionNote: "No wallet provided: in-range check skipped. Pass --wallet <STX_ADDRESS>.",
});
check("no wallet is not the same as no position: we could not look",
  noWallet.startsWith("CHECK:"), noWallet);

const inRange = actionLine({ ...gatesPass, noPosition: false, inRange: true });
check("a position in range holds", inRange.startsWith("HOLD: position in range"), inRange);

const drifted = actionLine({
  ...gatesPass, noPosition: false, inRange: false,
  userBinRange: { min: 640, max: 650, count: 11, bins: [640, 650] },
});
check("a REAL out of range position still raises the alarm",
  drifted.startsWith("REBALANCE:") && drifted.includes("position bins 640-650"), drifted);

const blocked = actionLine({
  ...gatesPass, noPosition: false, inRange: false, canRebalance: false,
  refusals: ["24h volume $1,000 < $10,000 minimum"],
});
check("out of range with a gate refusing holds, and says which gate",
  blocked.startsWith("HOLD:") && blocked.includes("24h volume"), blocked);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
