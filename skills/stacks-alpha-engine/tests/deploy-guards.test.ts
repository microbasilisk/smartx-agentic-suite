/**
 * The guards that decide whether a HODLMM deposit is built, and with whose money.
 *
 * Run it from a checkout that has the suite dependencies installed:
 *   bun run skills/stacks-alpha-engine/tests/deploy-guards.test.ts
 * Exit code 0 means every case passed. There is no runner in this repo yet, so
 * this file is its own runner.
 *
 * It imports the SHIPPED engine, not a copy. An earlier version of this file
 * tested a duplicate with exports bolted on, which would have kept passing after
 * the real file drifted away from it.
 *
 * Every case asserts the REASON for a refusal, never only that one happened. A
 * mutation run on 2026-08-28 proved why: deleting the "neither token present"
 * guard still left the case refusing, because a different guard caught it for a
 * different reason. Only the reason assertion noticed. All seven mutations of
 * these guards are killed by these cases, with no survivors.
 */
import { sizeHodlmmOption, markOptionGates, bestMove, verdictLine, gateCellFor, swapTableNeedsPairNote, applyGateResults, buildDeployInstructions, parseAtomicAmount, inferTargetPoolId, poolGateScope, selectTargetOption, classifySlippage, explainsDestinationPool, checkGuardian, scanGuardianInput, buildWithdrawInstructions, liveGuardianReads } from "../stacks-alpha-engine.ts";

// sbtc has 8 decimals, usdcx has 6. `amount` in balances is HUMAN units.
const WALLET = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";
/** A wallet holding the USDh/USDCx pair, for the dlmm_8 cases. */
const scoutUsdh = (usdhAtomic: number, usdcxAtomic: number) => ({
  wallet: WALLET,
  balances: {
    usdh:  { amount: usdhAtomic / 1e8, usd: 0 },
    usdcx: { amount: usdcxAtomic / 1e6, usd: 0 },
  },
  prices: { sbtc: 78000, stx: 0.5, usdcx: 1, usdh: 1, aeusdc: 1 },
}) as never;

const scout = (sbtcAtomic: number, usdcxAtomic: number, stxAtomic = 0) => ({
  wallet: "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
  balances: {
    sbtc:  { amount: sbtcAtomic / 1e8, usd: 0 },
    usdcx: { amount: usdcxAtomic / 1e6, usd: 0 },
    stx:   { amount: stxAtomic / 1e6, usd: 0 },
  },
  prices: { sbtc: 78000, stx: 0.5, usdcx: 1, usdh: 1, aeusdc: 1 },
}) as never;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail: string) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};
/**
 * Did a deposit get BUILT?
 *
 * Looks for a real contract call to the add function, not a tool name. Until
 * 2026-09-12 this deposit emitted `bitflow:add-liquidity-simple`, which was a
 * complete instruction only for an agent holding its own key: something in the
 * same process read it, signed and broadcast. A caller that has to hand a
 * person unsigned bytes could do nothing with it, which is why the shape
 * changed and why these cases now read the call.
 */
const hasAddLiq = (b: { instructions: Array<{ tool: string; params?: Record<string, unknown> }> }) =>
  b.instructions.some(i => i.tool === "call_contract"
    && (i.params as Record<string, unknown> | undefined)?.functionName === "add-relative-liquidity-same-multi");

/**
 * The bins of a built deposit, or an empty array.
 *
 * Never throws. Five places used to do `find(...)` and dereference `.params`
 * straight after, so a regression that stopped a deposit being built killed the
 * whole file with a TypeError before the next case ran. The exit code was still
 * non-zero, so a mutation was technically caught, but the output was a stack
 * trace and every later case went unreported: two regressions at once would show
 * as one.
 */
const binsOf = (b: { instructions: Array<{ tool: string; params?: Record<string, unknown> }> }) => {
  type Bin = { activeBinOffset: number; xAmount: string; yAmount: string };
  const empty: Bin[] = [];
  const liq = b.instructions.find(i => i.tool === "call_contract"
    && (i.params as Record<string, unknown> | undefined)?.functionName === "add-relative-liquidity-same-multi");
  const args = (liq?.params as Record<string, unknown> | undefined)?.functionArgs;
  if (!Array.isArray(args) || args.length === 0) return empty;
  const list = (args[0] as Record<string, unknown>)?.value;
  if (!Array.isArray(list)) return empty;
  // Read back into the SAME shape the cases below already assert on, so every
  // property they prove survives the change of instruction unchanged. The
  // amounts are what they always were; only where they are written moved.
  return list.map((t) => {
    const v = ((t as Record<string, unknown>)?.value ?? {}) as Record<string, { value?: unknown }>;
    return {
      activeBinOffset: Number(v["active-bin-id-offset"]?.value ?? 0),
      xAmount: String(v["x-amount"]?.value ?? "0"),
      yAmount: String(v["y-amount"]?.value ?? "0"),
    };
  }) as Bin[];
};

/** The post-conditions on a built deposit, or an empty array. */
const pinsOf = (b: { instructions: Array<{ tool: string; params?: Record<string, unknown> }> }) => {
  const liq = b.instructions.find(i => i.tool === "call_contract"
    && (i.params as Record<string, unknown> | undefined)?.functionName === "add-relative-liquidity-same-multi");
  const pcs = (liq?.params as Record<string, unknown> | undefined)?.postConditions;
  return Array.isArray(pcs) ? pcs as Array<Record<string, unknown>> : [];
};

/** Every description on a build, so a note can be looked for by its words. */
const notes = (b: { instructions: Array<{ description?: string }> }) =>
  b.instructions.map(i => i.description ?? "");

console.log("\n== F1: the wallet-balance guards must run for deploy and NOT for migrate ==");

// A. deploy, wallet empty. The guard can be answered, so it must refuse.
{
  const b = buildDeployInstructions("hodlmm" as never, 100000, "sbtc", scout(0, 0), "dlmm_1", null, true);
  check("A deploy with an empty wallet refuses", b.refusal !== null, `refusal=${b.refusal}`);
  check("A refuses for the RIGHT reason (neither token present)",
    !!b.refusal && b.refusal.includes("neither present"), `refusal=${b.refusal}`);
  check("A builds no deposit", !hasAddLiq(b), JSON.stringify(b.instructions));
}

// B. migrate, wallet empty. The money is in flight, so the guard must not fire.
{
  const b = buildDeployInstructions("hodlmm" as never, 100000, "sbtc", scout(0, 0), "dlmm_1", null, false);
  check("B migrate with an empty wallet does NOT refuse", b.refusal === null, `refusal=${b.refusal}`);
  check("B builds the deposit", hasAddLiq(b), JSON.stringify(b.instructions.map(i => i.tool)));
}

// C. deploy, holds less than named.
{
  const b = buildDeployInstructions("hodlmm" as never, 1000000, "sbtc", scout(50000, 0), "dlmm_1", null, true);
  check("C deploy naming more than held refuses", b.refusal !== null, `refusal=${b.refusal}`);
  check("C refuses for the RIGHT reason (insufficient, with both figures)",
    !!b.refusal && b.refusal.includes("you hold 50000 and named 1000000"), `refusal=${b.refusal}`);
  check("C builds no deposit", !hasAddLiq(b), JSON.stringify(b.instructions));
}

// D. migrate, same numbers. This is the regression: it must build.
{
  const b = buildDeployInstructions("hodlmm" as never, 1000000, "sbtc", scout(50000, 0), "dlmm_1", null, false);
  check("D migrate naming more than the loose balance does NOT refuse", b.refusal === null, `refusal=${b.refusal}`);
  check("D builds the deposit", hasAddLiq(b), JSON.stringify(b.instructions.map(i => i.tool)));
  const bins = binsOf(b) as Array<{ xAmount: string; yAmount: string }>;
  const totalX = bins.reduce((a, x) => a + Number(x.xAmount), 0);
  check("D deposits the amount the caller named, not a balance", totalX === 1000000, `totalX=${totalX}`);
  check("D never sizes the counter side", bins.every(x => x.yAmount === "0"), JSON.stringify(bins));
}

console.log("\n== F8: five bins of zero, and the silent truncation ==");

// E. under five atomic units.
{
  const b = buildDeployInstructions("hodlmm" as never, 4, "sbtc", scout(1000, 0), "dlmm_1", null, true);
  check("E an amount under 5 refuses", b.refusal !== null, `refusal=${b.refusal}`);
  check("E refuses for the RIGHT reason (too small for five bins)",
    !!b.refusal && b.refusal.includes("too small to spread across five bins"), `refusal=${b.refusal}`);
  check("E builds no deposit of five empty bins", !hasAddLiq(b), JSON.stringify(b.instructions));
}

// F. a remainder must be disclosed, not silently dropped.
{
  const b = buildDeployInstructions("hodlmm" as never, 12, "sbtc", scout(1000, 0), "dlmm_1", null, true);
  check("F an inexact amount still builds", hasAddLiq(b) && b.refusal === null, `refusal=${b.refusal}`);
  // Looked up by its WORDS, not by being the first `info`. It was the first only
  // because the remainder note happens to be pushed before the one sided note;
  // swapping those two pushes would have made this case silently assert the wrong
  // instruction.
  check("F the shortfall is stated in words",
    notes(b).some(d => d.includes("2 stays in your wallet")), JSON.stringify(notes(b)));
}

console.log("\n== F2: the counter side ==");

// G. counter amount beyond the balance, on deploy.
{
  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 999999, true);
  check("G a counter amount beyond the balance refuses", b.refusal !== null, `refusal=${b.refusal}`);
  check("G refuses for the RIGHT reason (names the counter token and the balance)",
    !!b.refusal && b.refusal.includes("exceeds your USDCX balance of 5000"), `refusal=${b.refusal}`);
}

// H. both sides named and affordable: exactly the two numbers given.
{
  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 2000, true);
  check("H both sides named builds without refusing", b.refusal === null && hasAddLiq(b), `refusal=${b.refusal}`);
  const bins = binsOf(b) as Array<{ xAmount: string; yAmount: string }>;
  check("H carries exactly the two amounts the caller named",
    bins.length === 1 && bins[0].xAmount === "1000" && bins[0].yAmount === "2000", JSON.stringify(bins));
}


// ============================================================================
// Added after review round two, which found the cases above never once ran the
// Y-only branch, never asserted a single bin offset, and never exercised the
// small-amount guard on the migrate path.
// ============================================================================

console.log("\n== The Y-only branch, which had zero coverage ==");

// dlmm_1 is sBTC-USDCx, so usdcx is tokenY. Every case above named sbtc, so
// `namedIsX` was true in all eight and this whole branch was unreached.
{
  const b = buildDeployInstructions("hodlmm" as never, 5000, "usdcx", scout(0, 100000), "dlmm_1", null, true);
  check("I a Y-only deposit builds", b.refusal === null && hasAddLiq(b), `refusal=${b.refusal}`);
  const bins = binsOf(b) as Array<{ activeBinOffset: number; xAmount: string; yAmount: string }>;
  check("I puts the money on the Y side", bins.every(x => x.xAmount === "0" && x.yAmount === "1000"), JSON.stringify(bins));
  // The dlmm-core invariant: y is allowed only at bins at or below the active bin.
  //   (asserts! (or (<= bin-id active-bin-id) (is-eq y-amount u0)) ERR_INVALID_Y_AMOUNT)
  check("I uses offsets -5..-1, which the Clarity invariant requires for Y",
    JSON.stringify(bins.map(x => x.activeBinOffset)) === "[-5,-4,-3,-2,-1]",
    JSON.stringify(bins.map(x => x.activeBinOffset)));
  check("I deposits the named amount, not the balance",
    bins.reduce((a, x) => a + Number(x.yAmount), 0) === 5000, JSON.stringify(bins));
}

// Y-named, insufficient. Proves the guard reads the Y balance and not the X one.
{
  const b = buildDeployInstructions("hodlmm" as never, 200000, "usdcx", scout(9999999, 5000), "dlmm_1", null, true);
  check("J a Y-only deposit is measured against the Y balance", b.refusal !== null, `refusal=${b.refusal}`);
  check("J names the Y token and the Y balance, not the X one",
    !!b.refusal && b.refusal.includes("you hold 5000 and named 200000"), `refusal=${b.refusal}`);
}

// Y-named with a counter side: the counter token must be X, not Y again.
{
  const b = buildDeployInstructions("hodlmm" as never, 5000, "usdcx", scout(100, 100000), "dlmm_1", 999999, true);
  check("K the counter side of a Y-named deposit is the X token",
    !!b.refusal && b.refusal.includes("exceeds your SBTC balance of 100"), `refusal=${b.refusal}`);
}

console.log("\n== The X offsets, which nothing asserted ==");

{
  const b = buildDeployInstructions("hodlmm" as never, 5000, "sbtc", scout(100000, 0), "dlmm_1", null, true);
  const bins = binsOf(b) as Array<{ activeBinOffset: number; xAmount: string; yAmount: string }>;
  // (asserts! (or (>= bin-id active-bin-id) (is-eq x-amount u0)) ERR_INVALID_X_AMOUNT)
  check("L uses offsets 1..5, which the Clarity invariant requires for X",
    JSON.stringify(bins.map(x => x.activeBinOffset)) === "[1,2,3,4,5]",
    JSON.stringify(bins.map(x => x.activeBinOffset)));
  check("L puts nothing on the Y side", bins.every(x => x.yAmount === "0"), JSON.stringify(bins));
}

{
  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 2000, true);
  const bins = binsOf(b) as Array<{ activeBinOffset: number }>;
  // Both amounts non-zero is legal at the active bin and nowhere else.
  check("M a two sided deposit sits on the active bin alone",
    JSON.stringify(bins.map(x => x.activeBinOffset)) === "[0]", JSON.stringify(bins));
}

console.log("\n== The small-amount guard on the migrate path ==");

// This is the one refusal that must still fire when the balance guards are off,
// because it is about the arithmetic of five bins, not about anybody's balance.
{
  const b = buildDeployInstructions("hodlmm" as never, 4, "sbtc", scout(0, 0), "dlmm_1", null, false);
  check("N migrate still refuses an amount too small for five bins", b.refusal !== null, `refusal=${b.refusal}`);
  check("N refuses for the RIGHT reason", !!b.refusal && b.refusal.includes("too small to spread across five bins"), `refusal=${b.refusal}`);
  check("N builds no deposit of five empty bins", !hasAddLiq(b), JSON.stringify(b.instructions));
}

console.log("\n== One parser for every amount ==");

// The two parsers that used to read these disagreed, and both were reading money.
for (const [text, want] of [
  ["1000", 1000], ["1", 1], [" 42 ", 42],
  ["1e6", null], ["0x10", null], ["12abc", null], ["1_000", null],
  ["1000.0", null], ["-5", null], ["0", null], ["", null], ["  ", null],
] as Array<[string, number | null]>) {
  const got = parseAtomicAmount(text);
  check(`O parseAtomicAmount(${JSON.stringify(text)}) is ${want === null ? "rejected" : want}`,
    got === want, `got ${got}`);
}


console.log("\n== Which pool the two safety gates measure ==");

// Review round two caught this with a mutation, not with reading: the critical
// fix of that round had no test at all, so setting `rebalance` back to null left
// every case green. `rebalance` is a pure HODLMM pool write, it takes --pool-id,
// and switching its gates off means re-entering a pool nothing measured.
{
  check("P rebalance gates on the pool it was given",
    inferTargetPoolId("rebalance", { poolId: "dlmm_4" }) === "dlmm_4",
    String(inferTargetPoolId("rebalance", { poolId: "dlmm_4" })));
  check("P rebalance gates on dlmm_1 by default, matching its --pool-id default",
    inferTargetPoolId("rebalance", {}) === "dlmm_1",
    String(inferTargetPoolId("rebalance", {})));
  check("P a HODLMM deploy gates on its pool",
    inferTargetPoolId("deploy", { protocol: "hodlmm", poolId: "dlmm_7" }) === "dlmm_7",
    String(inferTargetPoolId("deploy", { protocol: "hodlmm", poolId: "dlmm_7" })));
  check("P a migrate into HODLMM gates on its pool",
    inferTargetPoolId("migrate", { to: "hodlmm", poolId: "dlmm_3" }) === "dlmm_3",
    String(inferTargetPoolId("migrate", { to: "hodlmm", poolId: "dlmm_3" })));
  check("P a deploy that swaps into hermetica gates on the swap pool",
    inferTargetPoolId("deploy", { protocol: "hermetica", token: "sbtc" }) === "dlmm_8",
    String(inferTargetPoolId("deploy", { protocol: "hermetica", token: "sbtc" })));
  check("P a zest deploy has no pool leg",
    inferTargetPoolId("deploy", { protocol: "zest", token: "sbtc" }) === null,
    String(inferTargetPoolId("deploy", { protocol: "zest", token: "sbtc" })));
}

// A gate that ran must never carry an excuse for not running.
{
  check("Q no excuse is offered when the gates DO apply",
    poolGateScope("rebalance", { poolId: "dlmm_4" }) === null,
    String(poolGateScope("rebalance", { poolId: "dlmm_4" })));
  check("Q a HODLMM exit says it is an exit, and does not claim no pool is involved",
    (poolGateScope("withdraw", { protocol: "hodlmm" }) ?? "").includes("exit from a HODLMM pool"),
    String(poolGateScope("withdraw", { protocol: "hodlmm" })));
  check("Q a HODLMM exit never claims the operation touches no HODLMM pool",
    !(poolGateScope("withdraw", { protocol: "hodlmm" }) ?? "").includes("no HODLMM"),
    String(poolGateScope("withdraw", { protocol: "hodlmm" })));
}


console.log("\n== Leaving a pool is not the same as never touching one ==");

// Round three: the exit wording covered `withdraw --protocol hodlmm` and missed
// `migrate --from hodlmm`, whose FIRST instruction is a HODLMM withdraw. The
// generic sentence it fell through to told the user the run moved no HODLMM
// liquidity. Case Q asserted the right thing about the wrong branch.
{
  const m = poolGateScope("migrate", { from: "hodlmm", to: "zest" }) ?? "";
  check("R a migrate OUT of HODLMM is described as an exit", m.includes("exit from a HODLMM pool"), m);
  check("R a migrate OUT of HODLMM never claims it moves no HODLMM liquidity",
    !m.includes("moves no HODLMM liquidity"), m);
  // Whether a migrate INTO granite or hermetica touches a pool depends on the
  // TOKEN, not the destination. With the default token there is no swap leg.
  //
  // An earlier version of this case asserted null here and was GREEN BECAUSE OF A
  // DEFECT: the gate was aimed at dlmm_7 for every `--to granite` regardless of
  // token, so two of the four destinations were refused live on a pool their
  // instruction list never mentions. Fixing that turned this case red, which is
  // the case earning its keep.
  const gDefault = poolGateScope("migrate", { from: "zest", to: "granite" }) ?? "";
  check("R a migrate INTO granite with its default token touches no pool",
    gDefault.includes("moves no HODLMM liquidity"), gDefault);
  check("R a migrate INTO granite that must SWAP first is gated, with no excuse",
    poolGateScope("migrate", { from: "zest", to: "granite", token: "usdcx" }) === null,
    String(poolGateScope("migrate", { from: "zest", to: "granite", token: "usdcx" })));
  const z = poolGateScope("migrate", { from: "granite", to: "zest" }) ?? "";
  check("R a migrate with no HODLMM leg at either end says so",
    z.includes("moves no HODLMM liquidity"), z);
}

console.log("\n== One spelling of a token, decided once ==");

// Round three, reproduced at the command line: `--token SBTC` passed migrate's
// Step 0 (which lowercased to validate) and then failed the builder's comparison
// against lowercase pool names, so the withdraw was built, the deposit was not,
// and the run reported no refusal.
{
  // The builder is the side that compares. Given the normalised token it builds;
  // given the raw one it does not. This pins the contract the pipeline relies on.
  const lower = buildDeployInstructions("hodlmm" as never, 100000, "sbtc", scout(0, 0), "dlmm_1", null, false);
  check("S the builder accepts the normalised spelling", hasAddLiq(lower), JSON.stringify(lower.instructions.map(i => i.tool)));
  const upper = buildDeployInstructions("hodlmm" as never, 100000, "SBTC", scout(0, 0), "dlmm_1", null, false);
  check("S the builder does NOT accept an un-normalised spelling, so the pipeline must normalise",
    !hasAddLiq(upper), JSON.stringify(upper.instructions.map(i => i.tool)));
}

// The same casing bug was live in the gate targeting: "USDh" !== "usdh" sent a
// hermetica deploy that already held USDh to a swap pool it never touches.
{
  check("T a hermetica deploy already holding usdh has no swap pool leg",
    inferTargetPoolId("deploy", { protocol: "hermetica", token: "usdh" }) === null,
    String(inferTargetPoolId("deploy", { protocol: "hermetica", token: "usdh" })));
  check("T a hermetica deploy holding another token gates on the swap pool",
    inferTargetPoolId("deploy", { protocol: "hermetica", token: "sbtc" }) === "dlmm_8",
    String(inferTargetPoolId("deploy", { protocol: "hermetica", token: "sbtc" })));
}

console.log("\n== The parser at its edges ==");

{
  check("U parseAtomicAmount(undefined) is rejected", parseAtomicAmount(undefined) === null, String(parseAtomicAmount(undefined)));
  check("U parseAtomicAmount(null) is rejected", parseAtomicAmount(null) === null, String(parseAtomicAmount(null)));
  // 2^53, the first integer that cannot be represented exactly.
  check("U an amount above the safe integer range is rejected",
    parseAtomicAmount("9007199254740993") === null, String(parseAtomicAmount("9007199254740993")));
  check("U the largest safe integer is accepted",
    parseAtomicAmount("9007199254740991") === 9007199254740991, String(parseAtomicAmount("9007199254740991")));
  check("U a leading plus is rejected", parseAtomicAmount("+5") === null, String(parseAtomicAmount("+5")));
}


console.log("\n== The pipeline normalises the token, not each command ==");

// The cases above prove the BUILDER needs a normalised token. This one proves the
// pipeline actually hands it one, which is a different claim and was the defect.
//
// It has to run the CLI, because the normalisation is the first line of
// `_runPipeline` and no unit call reaches it. It stays deterministic by asserting
// only on a Step 0 outcome, which is decided before any network call:
// `deploy`'s Step 0 rejects a token the protocol does not accept, and "SBTC" is
// not in zest's list while "sbtc" is. Delete the normalisation and this command
// fails instantly with that exact message. Keep it and Step 0 passes and the run
// moves on to the network, which is why a timeout counts as a pass here.
//
// The first version of this case asserted `!out.includes("does not accept SBTC")`,
// a NEGATIVE over subprocess output, and review round four proved it green in two
// situations where it should have been red: an 8 second timeout (the real run is
// network bound and takes about 4), and the engine file renamed so nothing ran at
// all. A control that passes when the thing under test is absent is worse than no
// control, which this project has written down once already.
//
// So it asserts a POSITIVE string instead, on a token no protocol accepts, which
// Step 0 rejects with no network call at all. The message quotes the token back.
// With the normalisation it reads "xbtc"; without it, "XBTC"; and if the
// subprocess did not run, neither appears and the case fails.
const enginePath = new URL("../stacks-alpha-engine.ts", import.meta.url).pathname;
{
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", enginePath,
          "deploy", "--wallet", "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
          "--protocol", "zest", "--token", "XBTC", "--amount", "100"],
    timeout: 20000,
    stdout: "pipe", stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  check("V the subprocess actually ran and said something", out.length > 0 && proc.exitCode !== null,
    `exit=${proc.exitCode} len=${out.length}`);
  check("V the pipeline lowercases --token before Step 0 reads it",
    out.includes("does not accept xbtc"), out.slice(0, 300));
  check("V and the original casing does not survive to the message",
    !out.includes("does not accept XBTC"), out.slice(0, 300));
}

// Round four: `deploy` never got the pool/token check `migrate` was given, so
// naming a token the pool does not hold built one `info` and returned ok.
{
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", enginePath,
          "deploy", "--wallet", "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
          "--protocol", "hodlmm", "--token", "stx", "--pool-id", "dlmm_1", "--amount", "1000000"],
    timeout: 20000,
    stdout: "pipe", stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  check("W deploy refuses a token the chosen pool does not hold, before any network call",
    out.includes("is not in sBTC-USDCx-10bps"), out.slice(0, 300));
  check("W and does not report it as a preview", !out.includes('"status": "preview"'), out.slice(0, 300));
}

// Round three added migrate protocol validation; nothing covered it.
{
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", enginePath,
          "migrate", "--wallet", "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
          "--from", "zest", "--to", "foo", "--amount", "1000"],
    timeout: 20000,
    stdout: "pipe", stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  check("X an unknown --to is a structured error naming the valid choices",
    // The engine prints JSON, so the quotes around the bad value arrive escaped.
    // Matching the unescaped form failed here first, which is the assertion being
    // specific enough to be worth having.
    out.includes("Invalid --to protocol") && out.includes("foo")
      && out.includes("zest, hermetica, granite, hodlmm") && out.includes("disclaimer"),
    out.slice(0, 300));
  check("X and not a raw runtime crash", !out.includes("is not an object"), out.slice(0, 300));
}


// An unknown --pool-id had no case: a mutation deleting its check survived the
// suite. Without it the pool lookup returns undefined and the token check below
// reads `.tokenX` off nothing.
{
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", enginePath,
          "deploy", "--wallet", "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
          "--protocol", "hodlmm", "--token", "sbtc", "--pool-id", "dlmm_99", "--amount", "1000000"],
    timeout: 20000,
    stdout: "pipe", stderr: "pipe",
  });
  const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  check("Y an unknown --pool-id is refused by name, before any network call",
    out.includes("Unknown --pool-id") && out.includes("dlmm_99"), out.slice(0, 300));
  check("Y and does not crash reading a pool that is not there",
    !out.includes("undefined is not an object"), out.slice(0, 300));
}


console.log("\n== A gate must measure a pool the transaction actually touches ==");

// dlmm_7 and dlmm_8 are the swap pools. They belong in the verdict only when the
// move actually routes through them.
{
  check("Z1 migrate to granite with the default token: no pool",
    inferTargetPoolId("migrate", { to: "granite" }) === null,
    String(inferTargetPoolId("migrate", { to: "granite" })));
  check("Z1 migrate to granite holding usdcx: gated on the swap pool",
    inferTargetPoolId("migrate", { to: "granite", token: "usdcx" }) === "dlmm_7",
    String(inferTargetPoolId("migrate", { to: "granite", token: "usdcx" })));
  check("Z1 migrate to hermetica with the default token: no pool",
    inferTargetPoolId("migrate", { to: "hermetica" }) === null,
    String(inferTargetPoolId("migrate", { to: "hermetica" })));
  check("Z1 migrate to hermetica holding sbtc: gated on the swap pool",
    inferTargetPoolId("migrate", { to: "hermetica", token: "sbtc" }) === "dlmm_8",
    String(inferTargetPoolId("migrate", { to: "hermetica", token: "sbtc" })));
  // The same question, asked of deploy, must get the same answer.
  check("Z1 deploy and migrate agree for the same destination and token",
    inferTargetPoolId("deploy", { protocol: "granite", token: "usdcx" })
      === inferTargetPoolId("migrate", { to: "granite", token: "usdcx" }),
    `${inferTargetPoolId("deploy", { protocol: "granite", token: "usdcx" })} vs ${inferTargetPoolId("migrate", { to: "granite", token: "usdcx" })}`);
  check("Z1 and agree for the default token too",
    inferTargetPoolId("deploy", { protocol: "granite", token: "aeusdc" })
      === inferTargetPoolId("migrate", { to: "granite" }),
    `${inferTargetPoolId("deploy", { protocol: "granite", token: "aeusdc" })} vs ${inferTargetPoolId("migrate", { to: "granite" })}`);
}

console.log("\n== A one sided deposit says it earns nothing where it sits ==");

// KB section 7: X may only be non-zero at or above the active bin and Y only at
// or below, so a one sided add is outside the active bin BY CONSTRUCTION, and
// fees accrue at the active bin. The pool's headline APY does not describe it.
{
  const one = buildDeployInstructions("hodlmm" as never, 5000, "sbtc", scout(100000, 0), "dlmm_1", null, true);
  const note = one.instructions.find(i => i.tool === "info") as never as { description: string } | undefined;
  check("Z2 a one sided deposit warns that it is outside the earning range",
    !!note && note.description.includes("ONE SIDED") && note.description.includes("earns nothing"),
    JSON.stringify(one.instructions.map(i => (i as never as { description: string }).description)));
  const both = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 2000, true);
  check("Z2 a two sided deposit carries no such warning, because it sits AT the active bin",
    !both.instructions.some(i => ((i as never as { description: string }).description ?? "").includes("ONE SIDED")),
    JSON.stringify(both.instructions.map(i => (i as never as { description: string }).description)));
}

console.log("\n== Step 0, on both commands, answering the same questions ==");

{
  const run = (args: string[]) => {
    const proc = Bun.spawnSync({ cmd: ["bun", "run", enginePath, ...args], timeout: 20000, stdout: "pipe", stderr: "pipe" });
    return new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  };
  const W = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";

  const mUnknownPool = run(["migrate", "--wallet", W, "--from", "zest", "--to", "hodlmm", "--token", "sbtc", "--pool-id", "dlmm_99", "--amount", "1000"]);
  check("Z3 migrate refuses an unknown --pool-id, as deploy does",
    mUnknownPool.includes("Unknown --pool-id") && mUnknownPool.includes("dlmm_99"), mUnknownPool.slice(0, 250));

  const dDefaultToken = run(["deploy", "--wallet", W, "--protocol", "hodlmm", "--pool-id", "dlmm_5", "--amount", "1000000"]);
  check("Z3 deploy does not blame the caller for a token they never typed",
    dDefaultToken.includes("Name one with --token") && !dDefaultToken.includes("sbtc is not in"),
    dDefaultToken.slice(0, 250));
  check("Z3 and still names what that pool does hold",
    dDefaultToken.includes("stx") && dDefaultToken.includes("usdcx"), dDefaultToken.slice(0, 250));

  const dNamedToken = run(["deploy", "--wallet", W, "--protocol", "hodlmm", "--pool-id", "dlmm_5", "--token", "sbtc", "--amount", "1000000"]);
  check("Z3 but does blame them when they DID name it",
    dNamedToken.includes("sbtc is not in"), dNamedToken.slice(0, 250));
}


console.log("\n== The economics must describe the pool being deposited into ==");

// Sorted by APY descending, as getYieldOptions emits them. dlmm_2 is the pool a
// caller asked for and it is ABSENT, which is what happens when the feed reports
// apr24h <= 0 and getYieldOptions skips it.
const opts2 = [
  { protocol: "HODLMM", pool_id: "dlmm_4", pool: "STX-USDCx-4bps", apy_pct: 600.16 },
  { protocol: "HODLMM", pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps", apy_pct: 30.15 },
  { protocol: "Granite", pool_id: null, pool: "aeUSDC Lending LP", apy_pct: 1.01 },
] as never;

{
  check("Z4 a HODLMM deploy into a pool that IS listed gets that pool's figures",
    (selectTargetOption(opts2, "hodlmm", "dlmm_1") as never as { pool_id: string } | undefined)?.pool_id === "dlmm_1",
    JSON.stringify(selectTargetOption(opts2, "hodlmm", "dlmm_1")));
  // The defect: this used to return dlmm_4, the highest APY pool in the list, and
  // report 600.16% for a deposit into a pool earning nothing.
  check("Z4 a HODLMM deploy into an UNLISTED pool gets nothing, not another pool's APY",
    selectTargetOption(opts2, "hodlmm", "dlmm_2") === undefined,
    JSON.stringify(selectTargetOption(opts2, "hodlmm", "dlmm_2")));
  check("Z4 and specifically not the highest yielding pool in the report",
    (selectTargetOption(opts2, "hodlmm", "dlmm_2") as never as { pool_id: string } | undefined)?.pool_id !== "dlmm_4",
    JSON.stringify(selectTargetOption(opts2, "hodlmm", "dlmm_2")));
  // The fallback is still load bearing for the protocols whose options carry no
  // pool_id at all.
  check("Z4 granite still resolves by protocol, because its option has no pool_id",
    (selectTargetOption(opts2, "granite", "dlmm_1") as never as { pool: string } | undefined)?.pool === "aeUSDC Lending LP",
    JSON.stringify(selectTargetOption(opts2, "granite", "dlmm_1")));
}


console.log("\n== FORCED FAILURE: a slippage check that cannot run never reports a pass ==");

// This is the build plan's own acceptance test for Phase 1, item two:
//   "A slippage check that cannot run reports unknown, never a pass.
//    Proved by a control that forces the failure."
//
// Every one of these is a route that USED to return ok:true with a percentage of
// 0. Each is forced here, not waited for.
{
  const pool = (over: Record<string, unknown> = {}) => ({
    poolId: "dlmm_1", tvlUsd: 1, volumeUsd1d: 1, apr24h: 1,
    tokens: { tokenX: { priceUsd: 78000, decimals: 8, symbol: "sBTC" }, tokenY: { priceUsd: 1, decimals: 6 } },
    ...over,
  }) as never;
  const base = {
    targetPoolId: "dlmm_1", knownPool: true, poolName: "sBTC-USDCx-10bps",
    pools: [pool()], targetPool: pool(), activeBinOkay: true,
    bins: { active_bin_id: 7, bins: [{ bin_id: 7, price: "1000000000" }] },
    readError: null, notApplicableText: "no pool here",
  } as never;
  const withF = (over: Record<string, unknown>) => classifySlippage({ ...(base as object), ...over } as never);

  // Each route carries the reason it must give. Asserting only "it refused" is not
  // enough and this suite proved it: two mutations deleting a guard SURVIVED,
  // because the next guard down caught the same input for a different reason. It
  // is the third time on this project that assert-the-refusal has hidden a
  // deleted guard, so every route below pins its own words.
  const routes: Array<[string, Record<string, unknown>, string]> = [
    ["the pool is not one this engine knows", { knownPool: false }, "is not a pool this engine knows"],
    ["the pools endpoint did not answer", { pools: null, targetPool: null }, "the Bitflow pools endpoint did not answer"],
    ["the pool was absent from the response", { targetPool: null }, "was not in the pools the endpoint returned"],
    ["the pool came back with no token metadata", { targetPool: pool({ tokens: undefined }) }, "came back without token metadata"],
    ["the read threw", { readError: "HTTP 429" }, "the slippage read failed: HTTP 429"],
    ["the contract returned no active bin", { activeBinOkay: false }, "did not return its active bin"],
    ["the bins endpoint returned nothing", { bins: null }, "the bins endpoint returned nothing"],
    ["no price on the active bin", { bins: { active_bin_id: 7, bins: [{ bin_id: 7 }] } }, "no price for active bin 7"],
    ["the active bin price was not a number", { bins: { active_bin_id: 7, bins: [{ bin_id: 7, price: "n/a" }] } }, "was not a number"],
    ["no market price to compare against", { targetPool: pool({ tokens: { tokenX: { priceUsd: 0, decimals: 8, symbol: "sBTC" }, tokenY: { priceUsd: 1, decimals: 6 } } }) }, "no market price for sBTC"],
  ];

  for (const [name, over, because] of routes) {
    const { gate, refusal } = withF(over);
    check(`AA ${name}: reports UNKNOWN`, gate.status === "unknown", `${gate.status} / ${gate.source}`);
    check(`AA ${name}: never reports ok`, gate.ok === false, String(gate.ok));
    check(`AA ${name}: reports no percentage`, gate.value === null, String(gate.value));
    check(`AA ${name}: blocks the write with a reason in words`,
      typeof refusal === "string" && refusal.includes("did not run"), String(refusal));
    check(`AA ${name}: for THAT reason, not another guard's`,
      String(gate.source).includes(because), `${gate.source}  (wanted: ${because})`);
  }

  // The positive controls. Without these the block above would pass with the
  // whole function replaced by "return unknown".
  const good = withF({});
  check("AA a check that CAN run reports a real measurement", good.gate.status === "pass" || good.gate.status === "fail",
    `${good.gate.status} / ${good.gate.value}`);
  check("AA and carries a percentage, not null", typeof good.gate.value === "number", String(good.gate.value));
  check("AA and names the pool it measured", good.gate.pool_id === "dlmm_1", String(good.gate.pool_id));

  // Over the cap: a real measurement that refuses.
  const wide = withF({ bins: { active_bin_id: 7, bins: [{ bin_id: 7, price: "2000000000" }] } });
  check("AA a divergence over the cap FAILS rather than reporting unknown", wide.gate.status === "fail", wide.gate.status);
  check("AA and its refusal names the cap and the pool",
    !!wide.refusal && wide.refusal.includes("cap on dlmm_1"), String(wide.refusal));
  check("AA and a failure is not dressed as a check that did not run",
    !!wide.refusal && !wide.refusal.includes("did not run"), String(wide.refusal));

  // No pool at all is NOT a failure, and must not block.
  const na = withF({ targetPoolId: null });
  check("AA no pool involved is not-applicable, not unknown", na.gate.status === "not-applicable", na.gate.status);
  check("AA and does not block the write", na.gate.ok === true && na.refusal === null, String(na.refusal));
}


console.log("\n== The refusal only explains the destination when that is the truth ==");

// This narrowing had ZERO coverage: a mutation restoring the "fires on any
// refusal" defect left all 94 cases green, because nothing reaches the pipeline.
const G = (over: Record<string, unknown> = {}) => explainsDestinationPool({
  command: "migrate", from: "hodlmm", targetPoolId: "dlmm_7",
  slippageStatus: "fail", volumeStatus: "pass", ...over,
} as never);

{
  check("AB a pool gate failure on a migrate out of HODLMM is explained", G() === true, String(G()));
  check("AB an unknown pool gate counts too", G({ slippageStatus: "unknown" }) === true, String(G({ slippageStatus: "unknown" })));
  check("AB a volume failure counts too",
    G({ slippageStatus: "pass", volumeStatus: "fail" }) === true, String(G({ slippageStatus: "pass", volumeStatus: "fail" })));
  // The defect: these were all being told the refusal was about the destination.
  check("AB a GAS failure is not explained as a destination problem",
    G({ slippageStatus: "pass", volumeStatus: "pass" }) === false,
    String(G({ slippageStatus: "pass", volumeStatus: "pass" })));
  check("AB not-applicable pool gates are not a pool failure",
    G({ slippageStatus: "not-applicable", volumeStatus: "not-applicable" }) === false,
    String(G({ slippageStatus: "not-applicable", volumeStatus: "not-applicable" })));
  check("AB with no destination pool there is nothing to name",
    G({ targetPoolId: null }) === false, String(G({ targetPoolId: null })));
  check("AB a migrate that is not leaving HODLMM is not explained this way",
    G({ from: "zest" }) === false, String(G({ from: "zest" })));
  check("AB and neither is a deploy", G({ command: "deploy" }) === false, String(G({ command: "deploy" })));
}

console.log("\n== The one sided warning fires on BOTH branches ==");

// Case Z2 only ever exercised the X branch, because it named sbtc on dlmm_1.
{
  const y = buildDeployInstructions("hodlmm" as never, 5000, "usdcx", scout(0, 100000), "dlmm_1", null, true);
  check("AC a Y-only deposit warns it is outside the earning range",
    notes(y).some(d => d.includes("ONE SIDED") && d.includes("earns nothing")), JSON.stringify(notes(y)));
  const x = buildDeployInstructions("hodlmm" as never, 5000, "sbtc", scout(100000, 0), "dlmm_1", null, true);
  check("AC an X-only deposit warns the same way",
    notes(x).some(d => d.includes("ONE SIDED") && d.includes("earns nothing")), JSON.stringify(notes(x)));
  check("AC both name the pool they are outside", 
    notes(y).some(d => d.includes("sBTC-USDCx-10bps")) && notes(x).some(d => d.includes("sBTC-USDCx-10bps")),
    JSON.stringify([notes(x), notes(y)]));
}

console.log("\n== A balance is stated exactly, to the smallest unit ==");

// 155 of 2,001 sampled sBTC balances failed to round trip through the float, and
// the refusal then quoted a balance that was not the person's.
{
  let wrong = 0;
  for (let i = 0; i < 2001; i++) {
    const sats = 100000000 + i * 61793;
    const b = buildDeployInstructions("hodlmm" as never, sats, "sbtc", scout(sats, 0), "dlmm_1", null, true);
    if (b.refusal !== null) wrong++;
  }
  check("AD depositing your exact balance is never refused as insufficient", wrong === 0, `${wrong} of 2001 refused`);
  // The specific value that read back one satoshi short.
  const one = buildDeployInstructions("hodlmm" as never, 123456789, "sbtc", scout(123456789, 0), "dlmm_1", null, true);
  check("AD 123456789 sats is not reported as 123456788", one.refusal === null, String(one.refusal));
}


console.log("\n== FORCED FAILURE, on the gate a user actually meets ==");

// Round seven: the AA block above proves `classifySlippage`, and NOTHING asserted
// that `checkGuardian` calls it. Replacing the whole call with a hardcoded
// `{ok: true, status: "pass", value: 0}` left all 165 cases green: verbatim the
// "PASS | 0%" for a check that never ran that this phase exists to delete.
//
// The roadmap's acceptance test is about the check a person meets, so the failure
// is forced through the real function here, with its reads injected.
const guardianScout = (over: Record<string, unknown> = {}) => ({
  wallet: "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
  status: "ok",
  available: { balances: true, prices: true, price_stx: true },
  balances: {
    sbtc: { amount: 1, usd: 78000 }, stx: { amount: 100, usd: 50 },
    usdcx: { amount: 100, usd: 100 }, usdh: { amount: 0, usd: 0 },
    susdh: { amount: 0, usd: 0 }, aeusdc: { amount: 0, usd: 0 },
  },
  prices: { sbtc: 78000, stx: 0.5, usdcx: 1, usdh: 1, aeusdc: 1 },
  positions: { zest: {}, hermetica: {}, granite: {}, hodlmm: { has_position: false, pools: [] } },
  options: [],
  ...over,
}) as never;

const deadReads = {
  fetchPools: async () => null,
  readActiveBin: async () => ({ okay: false }),
  fetchBins: async () => ({}),
  fetchFeeRate: async () => { throw new Error("HTTP 429"); },
} as never;

{
  const g = await checkGuardian(guardianScout(), { targetPoolId: "dlmm_1" }, deadReads);
  check("AE the real gate reports UNKNOWN when its reads fail", g.slippage.status === "unknown",
    `${g.slippage.status} / ${g.slippage.source}`);
  check("AE it never reports a pass", g.slippage.ok === false, String(g.slippage.ok));
  check("AE and never a percentage", g.slippage.value === null, String(g.slippage.value));
  check("AE the volume gate fails closed on the same dead endpoint", g.volume.status === "unknown", g.volume.status);
  check("AE the gas gate fails closed too", g.gas.status === "unknown", g.gas.status);
  check("AE and the WRITE IS BLOCKED", g.can_proceed === false, String(g.can_proceed));
  check("AE with a reason naming the pool", g.refusals.some(r => r.includes("dlmm_1")), JSON.stringify(g.refusals));
}

// The positive control. Without it, the block above passes with the gate
// hardcoded to "always unknown", which is its own kind of lie.
{
  const liveReads = {
    fetchPools: async () => ([{
      poolId: "dlmm_1", tvlUsd: 1, volumeUsd1d: 500000, apr24h: 1,
      tokens: { tokenX: { priceUsd: 78000, decimals: 8, symbol: "sBTC" }, tokenY: { priceUsd: 1, decimals: 6 } },
    }]),
    readActiveBin: async () => ({ okay: true, result: "0x07" }),
    fetchBins: async () => ({ active_bin_id: 7, bins: [{ bin_id: 7, price: "1000000000" }] }),
    fetchFeeRate: async () => 200,
  } as never;
  const g = await checkGuardian(guardianScout(), { targetPoolId: "dlmm_1" }, liveReads);
  check("AE a gate that CAN run measures and does not report unknown",
    g.slippage.status === "pass" || g.slippage.status === "fail", `${g.slippage.status} / ${g.slippage.value}`);
  check("AE the volume gate passes on real volume", g.volume.status === "pass", g.volume.status);
  check("AE and it names the pool it measured", g.slippage.pool_id === "dlmm_1", String(g.slippage.pool_id));
}

console.log("\n== The table measures the pool being RECOMMENDED ==");

// Phase 1 item one, which had no test at all: reverting it to the hardcoded
// "dlmm_1" left every case green.
{
  const opt = (over: Record<string, unknown>) => ({
    tier: "deploy_now", protocol: "HODLMM", pool: "x", pool_id: null, apy_pct: 1, ...over,
  }) as never;

  const hodlmmTop = scanGuardianInput([
    opt({ pool_id: "dlmm_4", pool: "STX-USDCx-4bps", apy_pct: 600 }),
    opt({ pool_id: "dlmm_1", pool: "sBTC-USDCx-10bps", apy_pct: 30 }),
  ]);
  check("AF the gate targets the recommended pool, not a default",
    hodlmmTop.targetPoolId === "dlmm_4", String(hodlmmTop.targetPoolId));
  check("AF and offers no not-applicable excuse when it measured something",
    hodlmmTop.notApplicableScope === null && hodlmmTop.notApplicableVolumeScope === null,
    JSON.stringify(hodlmmTop));

  const graniteTop = scanGuardianInput([
    opt({ protocol: "Granite", pool: "aeUSDC Lending LP", pool_id: null, apy_pct: 8 }),
    opt({ pool_id: "dlmm_7", pool: "aeUSDC-USDCx-1bps", apy_pct: 3 }),
  ]);
  check("AF a non-HODLMM recommendation measures no pool", graniteTop.targetPoolId === null,
    String(graniteTop.targetPoolId));
  check("AF and WARNS that the listed HODLMM options are uncovered",
    (graniteTop.notApplicableScope ?? "").includes("does NOT cover") && (graniteTop.notApplicableScope ?? "").includes("dlmm_7"),
    String(graniteTop.notApplicableScope));
  check("AF naming the option it does describe",
    (graniteTop.notApplicableScope ?? "").includes("Granite aeUSDC Lending LP"), String(graniteTop.notApplicableScope));
  check("AF and the volume row says volume, not slippage",
    (graniteTop.notApplicableVolumeScope ?? "").includes("pool volume"), String(graniteTop.notApplicableVolumeScope));

  const nothing = scanGuardianInput([]);
  check("AF with nothing to deploy it does not claim there is nothing to deploy",
    (nothing.notApplicableScope ?? "").includes("no option was ranked first"), String(nothing.notApplicableScope));
}


console.log("\n== Unstaking leaves nothing behind ==");

// The satoshi fix reached three of four sites. The Hermetica unstake amount was
// still floored off a float, on a token with the same 8 decimals, and a mutation
// reverting it survived every case. Consequence: the `lte` post-condition matches
// the short amount, so the transaction SUCCEEDS and a sliver of sUSDh is stranded
// while the report says the position was withdrawn.
{
  const hermScout = (susdhSats: number) => ({
    wallet: "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF",
    balances: {
      sbtc: { amount: 0, usd: 0 }, stx: { amount: 0, usd: 0 }, usdcx: { amount: 0, usd: 0 },
      usdh: { amount: 0, usd: 0 }, susdh: { amount: susdhSats / 1e8, usd: 0 }, aeusdc: { amount: 0, usd: 0 },
    },
    positions: { zest: {}, hermetica: {}, granite: {}, hodlmm: { has_position: false, pools: [] } },
    prices: { sbtc: 78000, stx: 0.5, usdcx: 1, usdh: 1, aeusdc: 1 },
  }) as never;

  // `value` on a uint arg is a raw number here and a string elsewhere in this file
  // (`shares` is a string, `susdhSats` and `amount` are numbers). Coerced rather
  // than assumed, because assuming a string is what made the first version of this
  // case report all 2,001 as short when only 155 were.
  const amountIn = (ins: Array<{ params?: Record<string, unknown> }>): string | null => {
    for (const i of ins) {
      const a = (i.params?.functionArgs as Array<{ type: string; value: unknown }> | undefined)?.[0];
      if (a && a.type === "uint") return String(a.value);
    }
    return null;
  };

  let wrong = 0;
  for (let i = 0; i < 2001; i++) {
    const sats = 100000000 + i * 61793;
    const got = amountIn(buildWithdrawInstructions("hermetica" as never, hermScout(sats)));
    if (got !== String(sats)) wrong++;
  }
  check("AG unstaking asks for the whole position, to the sub-unit", wrong === 0, `${wrong} of 2001 were short`);

  const exact = amountIn(buildWithdrawInstructions("hermetica" as never, hermScout(123456789)));
  check("AG 123456789 sUSDh sub-units is not asked for as 123456788", exact === "123456789", String(exact));
}


console.log("\n== The slippage gate compares two prices in the SAME units ==");

// Round eight, measured live: the bin price is denominated in Y, the market price
// is in USD. Seven of the eight pools quote against USDCx at exactly $1.00, so the
// missing conversion was a multiply by one and invisible. dlmm_6 quotes against
// sBTC at about $79,416, and the gate printed 99.9987% divergence for a pool whose
// real divergence is 0.71%.
{
  const slip = (over: Record<string, unknown>) => {
    const tp = { poolId: "p", tvlUsd: 1, volumeUsd1d: 1, apr24h: 1, ...over } as never;
    return classifySlippage({
      targetPoolId: "p", knownPool: true, poolName: "p",
      pools: [tp], targetPool: tp, activeBinOkay: true,
      bins: { active_bin_id: 7, bins: [{ bin_id: 7, price: String((over as never as { _bin: number })._bin) }] },
      readError: null, notApplicableText: "n/a",
    } as never);
  };

  // dlmm_6 shape, live figures. X = STX at $0.267807, Y = sBTC at $79,416.
  const stxSbtc = slip({
    _bin: 33481,
    tokens: { tokenX: { priceUsd: 0.267807, decimals: 6, symbol: "STX" },
              tokenY: { priceUsd: 79416.0, decimals: 8, symbol: "sBTC" } },
  });
  check("AH a pool quoted in a non-dollar token is measured, not fabricated",
    stxSbtc.gate.status === "fail" && (stxSbtc.gate.value ?? 0) < 1,
    `${stxSbtc.gate.status} / ${stxSbtc.gate.value}`);
  check("AH and it does NOT report the 99.99% the units error produced",
    (stxSbtc.gate.value ?? 0) < 5, String(stxSbtc.gate.value));
  // It still exceeds the cap. The fix corrects the NUMBER, not the verdict.
  check("AH the real divergence still exceeds the 0.5% cap, so the write is still refused",
    stxSbtc.gate.ok === false, String(stxSbtc.gate.ok));

  // dlmm_1 shape, live figures. Y is USDCx at exactly $1.00, so the conversion is
  // a multiply by one and this pool's verdict must be unchanged by the fix.
  const sbtcUsdcx = slip({
    _bin: 79480016548,
    tokens: { tokenX: { priceUsd: 79416.0, decimals: 8, symbol: "sBTC" },
              tokenY: { priceUsd: 1.0, decimals: 6, symbol: "USDCx" } },
  });
  check("AH a dollar-quoted pool is unaffected and still passes",
    sbtcUsdcx.gate.status === "pass" && (sbtcUsdcx.gate.value ?? 99) < 0.5,
    `${sbtcUsdcx.gate.status} / ${sbtcUsdcx.gate.value}`);

  // A quote token with no price cannot be converted, so the gate must not guess.
  const noQuotePrice = slip({
    _bin: 33481,
    tokens: { tokenX: { priceUsd: 0.267807, decimals: 6, symbol: "STX" },
              tokenY: { priceUsd: 0, decimals: 8, symbol: "sBTC" } },
  });
  check("AH an unpriced quote token reports UNKNOWN rather than a converted guess",
    noQuotePrice.gate.status === "unknown", `${noQuotePrice.gate.status} / ${noQuotePrice.gate.source}`);
  check("AH and says which token it could not price",
    String(noQuotePrice.gate.source).includes("sBTC") && String(noQuotePrice.gate.source).includes("quotes in"),
    String(noQuotePrice.gate.source));
}

console.log("\n== Phase 1 item 3, proved the way the roadmap asks ==");

// Round eight: no case held BOTH tokens and named one amount, so the historical
// balance fallback survived all 184 cases. The mutation the phase notes claimed
// killed 13 was a clumsier variant; the faithful one killed nothing.
// The roadmap's acceptance test is literally "naming one amount while holding the
// other token".
{
  const b = buildDeployInstructions("hodlmm" as never, 100000, "sbtc", scout(50000000, 5000000000), "dlmm_1", null, true);
  check("AI naming one amount while holding the other token builds", b.refusal === null && hasAddLiq(b), String(b.refusal));
  const bins = binsOf(b);
  check("AI the counter side is untouched, every bin",
    bins.length > 0 && bins.every(x => x.yAmount === "0"), JSON.stringify(bins));
  check("AI and the named side totals exactly what was named",
    bins.reduce((a, x) => a + Number(x.xAmount), 0) === 100000, JSON.stringify(bins));
  check("AI the wallet's 5,000,000,000 USDCx appears nowhere in the deposit",
    !JSON.stringify(bins).includes("5000000000"), JSON.stringify(bins));

  // The same, with the pair reversed, so the fallback cannot hide on the Y side.
  const y = buildDeployInstructions("hodlmm" as never, 2000000, "usdcx", scout(50000000, 5000000000), "dlmm_1", null, true);
  const ybins = binsOf(y);
  check("AI naming the Y token leaves the X side untouched",
    ybins.length > 0 && ybins.every(x => x.xAmount === "0"), JSON.stringify(ybins));
  check("AI and the wallet's 0.5 sBTC appears nowhere in it",
    !JSON.stringify(ybins).includes("50000000"), JSON.stringify(ybins));
}


console.log("\n== The seam itself, not just the function behind it ==");

// Round eight: the AE block only ever reached ONE of the eleven routes, because
// `deadReads` fails the pools fetch and everything short-circuits there. So the
// code translating reads into `SlippageReads` was untested, and hardcoding
// `activeBinOkay = true` survived every case. In production that turns a failed
// contract read into a MEASURED PASS, which is this phase's defect one layer up
// from where it was closed.
{
  const okPool = {
    poolId: "dlmm_1", tvlUsd: 1, volumeUsd1d: 500000, apr24h: 1,
    tokens: { tokenX: { priceUsd: 79416, decimals: 8, symbol: "sBTC" },
              tokenY: { priceUsd: 1, decimals: 6, symbol: "USDCx" } },
  };
  const reads = (over: Record<string, unknown>) => ({
    fetchPools: async () => [okPool],
    readActiveBin: async () => ({ okay: true, result: "0x07" }),
    fetchBins: async () => ({ active_bin_id: 7, bins: [{ bin_id: 7, price: "7948001654800" }] }),
    fetchFeeRate: async () => 200,
    ...over,
  }) as never;

  // The contract answers, but not with a bin. This is the route the surviving
  // mutation erased.
  {
    const g = await checkGuardian(guardianScout(), { targetPoolId: "dlmm_1" },
      reads({ readActiveBin: async () => ({ okay: false }) }));
    check("AJ a contract that returns no active bin reports UNKNOWN",
      g.slippage.status === "unknown", `${g.slippage.status} / ${g.slippage.source}`);
    check("AJ for THAT reason, not another guard's",
      String(g.slippage.source).includes("did not return its active bin"), String(g.slippage.source));
    check("AJ and it blocks the write", g.can_proceed === false, String(g.can_proceed));
  }

  // The bins endpoint throws after the contract answered.
  {
    const g = await checkGuardian(guardianScout(), { targetPoolId: "dlmm_1" },
      reads({ fetchBins: async () => { throw new Error("HTTP 503"); } }));
    check("AJ a bins fetch that throws reports UNKNOWN, carrying the message",
      g.slippage.status === "unknown" && String(g.slippage.source).includes("HTTP 503"),
      String(g.slippage.source));
  }

  // Everything answers, so it must MEASURE. Without this the block above passes
  // with the seam hardcoded to always fail.
  {
    const g = await checkGuardian(guardianScout(), { targetPoolId: "dlmm_1" }, reads({}));
    check("AJ when every read answers, the gate measures",
      g.slippage.status === "pass" || g.slippage.status === "fail",
      `${g.slippage.status} / ${g.slippage.value}`);
    check("AJ and carries a number", typeof g.slippage.value === "number", String(g.slippage.value));
  }

  // The production read object is otherwise never touched by any test.
  check("AJ liveGuardianReads supplies all four reads",
    typeof liveGuardianReads.fetchPools === "function"
      && typeof liveGuardianReads.readActiveBin === "function"
      && typeof liveGuardianReads.fetchBins === "function"
      && typeof liveGuardianReads.fetchFeeRate === "function",
    JSON.stringify(Object.keys(liveGuardianReads)));
}


// ---------------------------------------------------------------------------
// Two sided entry: which tier, and how much of it the wallet can fund.
//
// Every one of these guards survived a mutation run on 2026-08-28 with all 203
// cases green, because they sat inside `getYieldOptions`, which does network reads
// in the same function and so cannot be driven by a test. Reverting the entire
// tiering change was invisible. They live in `sizeHodlmmOption` now.
// ---------------------------------------------------------------------------

console.log("BA sizeHodlmmOption");

{
  const r = sizeHodlmmOption(100, 40, 140, "STX", "USDCx", 100, 40);
  check("BA both sides held is deploy_now", r.tier === "deploy_now", r.tier);
  // The SMALLER side bounds the pair. `Math.max` described a position the wallet
  // cannot fund: $100 of STX against $40 of USDCx cannot put $200 to work.
  check("BA both sides sized on the smaller side", r.capUsd === 80, String(r.capUsd));
  check("BA both sides need no swap note", r.swapNote === null, String(r.swapNote));
}

{
  const r = sizeHodlmmOption(100, 0, 100, "STX", "USDCx", 100, 0);
  // Holding ONE side is not readiness. A one sided deposit sits outside the active
  // bin and earns nothing until price reaches it, so the pool APY beside it would
  // describe money the person does not receive.
  check("BA one side held is swap_first, not deploy_now", r.tier === "swap_first", r.tier);
  check("BA one side keeps its full value", r.capUsd === 100, String(r.capUsd));
  check("BA one side names what to swap into", (r.swapNote ?? "").includes("STX to USDCx"), String(r.swapNote));
}

{
  const r = sizeHodlmmOption(0, 60, 60, "STX", "USDCx", 0, 60);
  check("BA the other side held is also swap_first", r.tier === "swap_first", r.tier);
  check("BA the other side names the reverse swap", (r.swapNote ?? "").includes("USDCx to STX"), String(r.swapNote));
}

{
  const r = sizeHodlmmOption(0, 0, 100, "STX", "USDCx", 0, 0);
  check("BA neither side but something swappable is swap_first", r.tier === "swap_first", r.tier);
  // The FULL value. Halving was right under a one sided model; under two sided
  // entry $100 becomes $50 into each side and $100 in the pool.
  check("BA neither side keeps the full value, not half", r.capUsd === 100, String(r.capUsd));
}

{
  const r = sizeHodlmmOption(0, 0, 0, "STX", "USDCx", 0, 0);
  check("BA an empty wallet unlocks nothing", r.tier === "acquire_to_unlock", r.tier);
  check("BA an empty wallet funds nothing", r.capUsd === 0, String(r.capUsd));
}

// ---------------------------------------------------------------------------
// What the Gates column may say. Three states, because two made "nobody measured
// this" indistinguishable from "measured and failed", and only one of those is a
// reason to avoid the pool.
// ---------------------------------------------------------------------------

console.log("BB markOptionGates");

check("BB both passing is passed", markOptionGates("pass", "pass") === "passed", markOptionGates("pass", "pass"));
check("BB both failing is failed", markOptionGates("fail", "fail") === "failed", markOptionGates("fail", "fail"));

// The live case that made this blocking: dlmm_4's 24h volume is a permanent fail
// against the floor, and its slippage read sat behind a rate limited endpoint. The
// column told the reader nobody had looked.
check("BB a real failure beats an unreadable sibling",
  markOptionGates("unknown", "fail") === "failed", markOptionGates("unknown", "fail"));
check("BB and in the other order too",
  markOptionGates("fail", "unknown") === "failed", markOptionGates("fail", "unknown"));

check("BB one unknown is not a pass",
  markOptionGates("unknown", "pass") === "not-measured", markOptionGates("unknown", "pass"));
check("BB both unknown is not measured",
  markOptionGates("unknown", "unknown") === "not-measured", markOptionGates("unknown", "unknown"));
check("BB a not-applicable gate never reads as passed",
  markOptionGates("not-applicable", "not-applicable") === "not-measured",
  markOptionGates("not-applicable", "not-applicable"));

console.log("BC bestMove");

{
  const opts: any[] = [
    { tier: "swap_first", pool: "STX-USDCx", apy_pct: 600, daily_usd: 0.0119 },
    { tier: "deploy_now", pool: "sBTC-USDCx", apy_pct: 120, daily_usd: 0.004 },
  ];
  const m = bestMove(opts);
  check("BC a deploy_now option wins even when ranked lower", m.best?.pool === "sBTC-USDCx", String(m.best?.pool));
  check("BC and it needs no swap", m.needsSwap === false, String(m.needsSwap));
}

{
  // The live case: a STX only wallet has no deploy_now option at all. Reading that
  // tier alone left the headline saying there was nothing to do, above seven rows.
  const opts: any[] = [
    { tier: "swap_first", pool: "STX-USDCx", apy_pct: 600, daily_usd: 0.0119 },
    { tier: "acquire_to_unlock", pool: "USDh", apy_pct: 27, daily_usd: 0 },
  ];
  const m = bestMove(opts);
  check("BC a swap_first option is still a recommendation", m.best?.pool === "STX-USDCx", String(m.best?.pool));
  check("BC and it is flagged as needing a swap", m.needsSwap === true, String(m.needsSwap));
  // The option's OWN figure. Recomputing from the whole wallet put $0.0831 beside
  // the same pool the table priced at $0.0119.
  check("BC the daily figure is the option's own", m.dailyUsd === 0.0119, String(m.dailyUsd));
}

{
  const m = bestMove([{ tier: "acquire_to_unlock", pool: "USDh", apy_pct: 27, daily_usd: 0 } as any]);
  check("BC nothing actionable recommends nothing", m.best === undefined, String(m.best));
  check("BC and earns nothing", m.dailyUsd === 0, String(m.dailyUsd));
}

console.log("BD verdictLine and gateCellFor");

const opt = (o: any) => o as any;

{
  // Round two, blocker one: the sentence was chosen from the TIER, so it told a
  // wallet holding neither side that it held one, and promised "both sides in the
  // pool" for products that have no pair.
  const one = verdictLine(opt({ protocol: "HODLMM", pool: "STX-USDCx", token_needed: "STX/USDCx", apy_pct: 600, tier: "swap_first", sides: "one" }), 0.06);
  check("BD holding one side says so", one.includes("You hold one side"), one);

  const neither = verdictLine(opt({ protocol: "HODLMM", pool: "sBTC-USDCx", token_needed: "sBTC/USDCx", apy_pct: 600, tier: "swap_first", sides: "neither" }), 0.24);
  check("BD holding neither side says THAT", neither.includes("You hold neither side"), neither);
  check("BD and never claims they hold one", !neither.includes("You hold one side"), neither);

  const single = verdictLine(opt({ protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: 5, tier: "swap_first", sides: "single" }), 0.0137);
  check("BD a single asset product never mentions both sides", !single.includes("both sides"), single);
  check("BD and names the token it needs", single.includes("USDh"), single);

  const now = verdictLine(opt({ protocol: "Zest", pool: "sBTC Supply", token_needed: "sBTC", apy_pct: 4, tier: "deploy_now", sides: "single" }), 0.01);
  check("BD a deploy_now option needs no swap sentence", !now.includes("comes first"), now);
}

{
  // Round two, blocker two: Zest supply is deploy_now at 0% whenever its rate read
  // fails, and any deploy_now used to win outright, silencing the headline above a
  // 600% row.
  const m = bestMove([
    opt({ tier: "deploy_now", pool: "Zest sBTC Supply", apy_pct: 0, daily_usd: 0 }),
    opt({ tier: "swap_first", pool: "STX-USDCx", apy_pct: 600, daily_usd: 1.64 }),
  ]);
  check("BD a 0% option never beats a real one", m.best?.pool === "STX-USDCx", String(m.best?.pool));
  check("BD and the swap flag follows the option chosen", m.needsSwap === true, String(m.needsSwap));
}

check("BD a failed gate reads as failed", gateCellFor(opt({ gates: "failed" })) === "**FAILED**", gateCellFor(opt({ gates: "failed" })));
check("BD a passed gate reads as passed", gateCellFor(opt({ gates: "passed" })) === "passed", gateCellFor(opt({ gates: "passed" })));
check("BD an unmeasured gate says so", gateCellFor(opt({ gates: "not-measured" })) === "not measured", gateCellFor(opt({ gates: "not-measured" })));
check("BD an absent gate is not a pass", gateCellFor(opt({})) === "not measured", gateCellFor(opt({})));

console.log("BE the wiring, not just the decisions");

{
  // Round three: deleting `sides: sized.sized` from the HODLMM push left every
  // wallet told "You hold neither side" with all 241 cases green. The decisions
  // were pinned and the value travelling between them was not.
  const sized = sizeHodlmmOption(100, 40, 140, "STX", "USDCx", 100, 40);
  const built = opt({ protocol: "HODLMM", pool: "STX-USDCx", token_needed: "STX/USDCx",
                      apy_pct: 600, daily_usd: 1, tier: sized.tier, sides: sized.sides });
  check("BE the sizing's sides reach the sentence", verdictLine(built, 1).includes("missed"), verdictLine(built, 1));

  const oneSided = sizeHodlmmOption(100, 0, 100, "STX", "USDCx", 100, 0);
  const built2 = opt({ protocol: "HODLMM", pool: "STX-USDCx", token_needed: "STX/USDCx",
                       apy_pct: 600, daily_usd: 1, tier: oneSided.tier, sides: oneSided.sides });
  check("BE a one sided wallet is told it holds one side",
    verdictLine(built2, 1).includes("You hold one side"), verdictLine(built2, 1));
}

{
  // Round three, blocker two: readiness must come from the AMOUNT held, not its
  // dollar value, or a dead price feed tells someone holding both sides that they
  // hold one and advises a swap they do not need.
  const pricesDown = sizeHodlmmOption(0, 10, 30, "sBTC", "USDCx", 0.5, 10);
  check("BE a dead price feed does not erase a holding", pricesDown.sides === "both", pricesDown.sides);
  const genuinelyAbsent = sizeHodlmmOption(0, 10, 30, "sBTC", "USDCx", 0, 10);
  check("BE and a token truly absent still reads as one side", genuinelyAbsent.sides === "one", genuinelyAbsent.sides);
}

{
  // Round three, blocker one: the headline and the safety table asked two different
  // functions which option was recommended, and disagreed in print.
  const opts: any[] = [
    opt({ tier: "deploy_now", protocol: "Zest", pool: "sBTC Supply (v2)", apy_pct: 0, daily_usd: 0, sides: "single" }),
    opt({ tier: "swap_first", protocol: "HODLMM", pool: "sBTC-USDCx-10bps", pool_id: "dlmm_4", apy_pct: 600, daily_usd: 1.6, sides: "one" }),
  ];
  check("BE the safety table gates the pool the headline names",
    scanGuardianInput(opts).targetPoolId === "dlmm_4", String(scanGuardianInput(opts).targetPoolId));
  check("BE which is the same option bestMove picked",
    bestMove(opts).best?.pool_id === scanGuardianInput(opts).targetPoolId, "mismatch");
}

check("BE a table of only single asset rows needs no pair sentence",
  swapTableNeedsPairNote([opt({ sides: "single" }), opt({ sides: "single" })]) === false, "true");
check("BE one paired row is enough to need it",
  swapTableNeedsPairNote([opt({ sides: "single" }), opt({ sides: "one" })]) === true, "false");

console.log("BF applyGateResults");

{
  // Round four: this loop could be deleted with the suite AND the typecheck green,
  // because it lived in the CLI action. With it gone every row read "not measured",
  // including the pool that had just been measured and failed.
  const opts: any[] = [
    opt({ pool_id: "dlmm_4", gates: "not-measured" }),
    opt({ pool_id: "dlmm_1", gates: "not-measured" }),
    opt({ gates: "not-measured" }),
  ];
  applyGateResults(opts, { slippage: { pool_id: "dlmm_4", status: "fail" }, volume: { status: "pass" } } as any);
  check("BF the measured pool carries its result", opts[0].gates === "failed", opts[0].gates);
  check("BF an unmeasured pool is left alone", opts[1].gates === "not-measured", opts[1].gates);
  check("BF and one with no pool id is untouched", opts[2].gates === "not-measured", opts[2].gates);
}

{
  const opts: any[] = [opt({ pool_id: "dlmm_4", gates: "not-measured" })];
  applyGateResults(opts, { slippage: { pool_id: null, status: "not-applicable" }, volume: { status: "not-applicable" } } as any);
  check("BF nothing measured leaves everything unmarked", opts[0].gates === "not-measured", opts[0].gates);
}

{
  const opts: any[] = [opt({ pool_id: "dlmm_4", gates: "not-measured" })];
  applyGateResults(opts, { slippage: { pool_id: "dlmm_4", status: "pass" }, volume: { status: "pass" } } as any);
  check("BF a genuine pass is recorded as one", opts[0].gates === "passed", opts[0].gates);
}


// == The limits on what may leave a signer's wallet ==========================
//
// This is the part with a history. Of 22 successful HODLMM writes from this
// project's wallet, EIGHTEEN ran allow mode with ZERO post-conditions, and SEVEN
// transactions died with `abort_by_post_condition` when conditions WERE
// attached. Nothing bounded the eighteen; the seven were bounded wrongly. The
// knowledge base's instruction is to treat every new condition as needing its
// own negative control, so each case below breaks the thing it claims.
console.log("\n== I: the sender pins on a two sided deposit ==");
{
  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 2000, true);
  const pins = pinsOf(b);
  check("I a two sided deposit carries one pin per side", pins.length === 2, JSON.stringify(pins));

  // Every pin caps the SIGNER, not the pool. A pin on somebody else's balance
  // bounds nothing the person cares about.
  check("I every pin is on the signer's own wallet",
    pins.length === 2 && pins.every(p => p.principal === WALLET), JSON.stringify(pins.map(p => p.principal)));

  // `lte`, not `gte`. A floor on what leaves is not a limit, it is permission:
  // "at least this much may go" is satisfied by everything.
  check("I every pin is a CAP, not a floor",
    pins.length === 2 && pins.every(p => p.conditionCode === "lte"), JSON.stringify(pins.map(p => p.conditionCode)));

  // The caps are the two amounts the caller named, and nothing larger. This is
  // the same property as "deposits the amount the caller named", asserted on
  // the thing the chain actually enforces rather than on the arguments.
  const amounts = pins.map(p => String(p.amount)).sort();
  check("I the caps are exactly the two amounts named", JSON.stringify(amounts) === JSON.stringify(["1000", "2000"]), JSON.stringify(amounts));

  // The asset NAME is the argument to define-fungible-token, not the ticker and
  // not the contract name. A pin naming an asset that does not exist covers
  // nothing and the chain aborts: mainnet tx 0x77863289 died exactly that way.
  const sbtcPin = pins.find(p => String(p.amount) === "1000");
  check("I the sBTC pin names the real asset", sbtcPin?.assetName === "sbtc-token", JSON.stringify(sbtcPin));
}

console.log("\n== J: a side that does not move gets no pin ==");
{
  // One sided: only X moves. A condition on an asset that never transfers is
  // itself a reason for the chain to reject the transaction.
  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", null, true);
  const pins = pinsOf(b);
  check("J a one sided deposit carries exactly one pin", pins.length === 1, JSON.stringify(pins));
  check("J and it caps the side that actually moves",
    pins[0]?.conditionCode === "lte" && String(pins[0]?.amount) === "1000", JSON.stringify(pins));
}

console.log("\n== K: STX is not a fungible token ==");
{
  // dlmm_3 is STX/USDCx. STX moves under its own kind of condition, and a
  // fungible-token pin naming "stx" would cover nothing at all.
  const b = buildDeployInstructions("hodlmm" as never, 1000000, "stx", scout(100000, 5000, 9000000), "dlmm_3", 2000, true);
  const pins = pinsOf(b);
  const stxPin = pins.find(p => p.type === "stx");
  check("K the STX side is pinned as STX, not as a token", !!stxPin, JSON.stringify(pins));
  check("K and it is still a cap on the signer",
    stxPin?.conditionCode === "lte" && stxPin?.principal === WALLET, JSON.stringify(stxPin));
}


// == What would ABORT on chain, which the pin cases could not see ============
//
// A review ran four mutations that are each fatal on chain and left all 263
// cases green: min-dlp of zero (u1027), the add emitted in allow mode, the x
// and y traits swapped (ERR_INVALID_X_TOKEN), and the active-bin tolerance
// changed from none to a some-tuple (the u5008 drift race). The pins were
// proved and the CALL was not. An aborted transaction costs the person a fee
// and moves nothing, so each of those is pinned here.
console.log("\n== L: the call itself, not just its pins ==");
{
  const callOf = (b: { instructions: Array<{ tool: string; params?: Record<string, unknown> }> }) =>
    (b.instructions.find(i => i.tool === "call_contract"
      && (i.params as Record<string, unknown> | undefined)?.functionName === "add-relative-liquidity-same-multi")
      ?.params ?? {}) as Record<string, unknown>;

  const b = buildDeployInstructions("hodlmm" as never, 1000, "sbtc", scout(100000, 5000), "dlmm_1", 2000, true);
  const call = callOf(b);
  const args = call.functionArgs as Array<Record<string, unknown>>;

  // min-dlp of 0 aborts with u1027: the core requires shares minted above zero.
  const tuples = (args[0]?.value ?? []) as Array<{ value: Record<string, { value?: unknown }> }>;
  check("L every bin asks for more than zero shares",
    tuples.length > 0 && tuples.every(t => BigInt(String(t.value["min-dlp"]?.value ?? "0")) > 0n),
    JSON.stringify(tuples.map(t => t.value["min-dlp"]?.value)));

  // Deny, per the roadmap. `add-liquidity` emits one transfer per side and pool
  // token mints, and deny ignores mints, so deny bounds this call exactly. Allow
  // would also oblige the app to carry a written justification for two outflows.
  check("L the add is deny mode", call.postConditionMode === "deny", String(call.postConditionMode));

  // The traits are positional and the core asserts each against the pool's own
  // binding, so swapping them aborts with ERR_INVALID_X_TOKEN.
  check("L the x trait comes before the y trait, matching the pool",
    String((args[2] as { value?: unknown })?.value ?? "").includes("sbtc")
    && String((args[3] as { value?: unknown })?.value ?? "").includes("usdcx"),
    `${String((args[2] as { value?: unknown })?.value)} then ${String((args[3] as { value?: unknown })?.value)}`);

  // A some-tuple here aborts with u5008 when the active bin drifts between
  // building and inclusion, and a person signing minutes later IS that gap.
  check("L the active bin tolerance is none",
    (args[4] as { type?: string })?.type === "none", JSON.stringify(args[4]));

  // A pin naming the right asset name on the wrong CONTRACT covers nothing and
  // aborts. Only the name was checked before.
  const pins = pinsOf(b);
  const sbtcPin = pins.find(p => String(p.assetName) === "sbtc-token");
  check("L the sBTC pin names the real token CONTRACT, not the pool",
    typeof sbtcPin?.asset === "string" && (sbtcPin.asset as string).includes(".sbtc-token"),
    JSON.stringify(sbtcPin?.asset));
  const usdcxPin = pins.find(p => String(p.assetName) === "usdcx-token");
  check("L the USDCx pin is named too, and was not before",
    typeof usdcxPin?.asset === "string" && (usdcxPin.asset as string).includes(".usdcx"),
    JSON.stringify(usdcxPin?.asset));
}

console.log("\n== L2: the line the person reads before signing ==");
{
  // A survivor. Nothing checked the description, so it could say anything. It
  // DID say "at most 100000000 USDh" for one USDh, wrong by a factor of a
  // hundred million, on the sentence somebody reads to decide whether to sign.
  const b = buildDeployInstructions("hodlmm" as never, 100000000, "usdh", scoutUsdh(200000000, 5000000), "dlmm_8", 1000000, true);
  const line = notes(b).find(n => n.includes("Add liquidity")) ?? "";
  check("L2 the caps are shown in tokens, not in atomic units",
    line.includes("1 USDh") && line.includes("1 USDCx"), line);
  check("L2 and the raw atomic figure is NOT shown", !line.includes("100000000"), line);

  // A FRACTIONAL amount, because whole numbers hide the half of the conversion
  // that has to divide. Dropping the fraction entirely left the cases above
  // green, so 1.5 sBTC could have read as "1 sBTC".
  const f = buildDeployInstructions("hodlmm" as never, 150000000, "sbtc", scout(200000000, 5000000), "dlmm_1", 2500000, true);
  const fLine = notes(f).find(n => n.includes("Add liquidity")) ?? "";
  check("L2 a fractional cap keeps its fraction", fLine.includes("1.5 sBTC"), fLine);
  // And trailing zeros are trimmed, so a whole figure does not read as 1.00000000.
  check("L2 the counter cap reads as 2.5 and not 2.50000", fLine.includes("2.5 USDCx"), fLine);
}

console.log("\n== M: STX is a wrapper contract, not the word stx ==");
{
  // A review found this builds garbage today: TOKENS.stx.contract is the literal
  // "stx", and a caller turning that into a principal throws. Even if it did
  // not, the pool binds token-stx-v-1-2 and the core asserts the trait matches.
  const b = buildDeployInstructions("hodlmm" as never, 1000000, "stx", scout(100000, 5000, 9000000), "dlmm_3", 2000, true);
  const call = (b.instructions.find(i => i.tool === "call_contract")?.params ?? {}) as Record<string, unknown>;
  const args = (call.functionArgs ?? []) as Array<{ value?: unknown }>;
  const xTrait = String(args[2]?.value ?? "");
  check("M the STX side passes a real contract principal", xTrait.includes("."), xTrait);
  check("M and it is the wrapper the pool actually binds", xTrait.includes("token-stx-v-1-2"), xTrait);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
