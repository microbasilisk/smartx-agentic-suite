/**
 * The wiring: what the endpoint really sends, and what the skill decides from it.
 *
 * Run it from a checkout with the suite dependencies installed:
 *   bun run skills/hodlmm-bin-guardian/tests/reads-a-position.test.ts
 * Exit code 0 means every case passed. There is no runner in this repo yet, so
 * this file is its own runner, in the shape of the engine's test file.
 *
 * Why it exists. The sibling test drives the headline function only, and a
 * review proved that is not enough: the skill read `user_liquidity` while the
 * live endpoint sends `userLiquidity`, so every bin parsed as zero and a wallet
 * holding 232 bins was reported as holding nothing. All seven headline cases
 * still passed, because none of them touches the reading. These cases stub the
 * network with the shapes the endpoints actually return and assert what a
 * person is told.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Before the skill is imported: it reads a cooldown state file from HOME, and
// this machine has one. Inside its four hour window the alarm case answers HOLD
// instead of REBALANCE, so the test would have asserted nothing on some runs.
process.env.HOME = mkdtempSync(`${tmpdir()}/guardian-test-`);

const { runGuardian } = await import("../hodlmm-bin-guardian.ts");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail: string) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n        ${detail}`); }
};

/** Answer these URLs, and make any other URL a loud failure rather than a hang. */
function stubFetch(userBins: { status?: number; body?: unknown }, opts: { activeBinId?: unknown } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/positions/")) {
      return json(userBins.body ?? {}, userBins.status ?? 200);
    }
    if (url.includes("/api/quotes/v1/pools")) {
      return json({ pools: [{ pool_id: "dlmm_1", pool_name: "sBTC-USDCx-LP", token_x: "X", token_y: "Y", bin_step: 10, active_bin: 653 }] });
    }
    if (url.includes("/api/quotes/v1/bins/")) {
      // 67900000000 raw with 8 and 6 decimals is 67900 USD, matching the price
      // below, so the slippage gate passes and cannot colour these results.
      return json({ active_bin_id: "activeBinId" in opts ? opts.activeBinId : 653, bins: [{ bin_id: 653, price: "67900000000" }] });
    }
    if (url.includes("/api/app/v1/pools")) {
      return json({ data: [{ poolId: "dlmm_1", tvlUsd: 367777, volumeUsd1d: 1722441, apr24h: 166.19,
        tokens: { tokenX: { contract: "X", priceUsd: 67900, decimals: 8 }, tokenY: { contract: "Y", priceUsd: 1, decimals: 6 } } }] });
    }
    if (url.includes("/v2/fees/transfer")) return json(6);
    throw new Error(`unstubbed URL in test: ${url}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const WALLET = "SP1BXRXA0Z67MB6G31FP1R52ZX5GQTZ5008KZG77A";

async function guardian(userBins: { status?: number; body?: unknown }, opts: { activeBinId?: unknown } = {}) {
  const restore = stubFetch(userBins, opts);
  try { return await runGuardian(WALLET, "dlmm_1"); }
  finally { restore(); }
}

// The live shape, as measured on 11 September 2026: camelCase liquidity with
// numeric ids. One earlier run printed an id as the string "526" and later
// probes returned numbers, and the payload names more than one data source, so
// both spellings are read; the string case below is that unreproduced form. The
// 404 body is the live one too: `detail`, not `message`, which an earlier
// version of this file guessed wrong.
const holderCamel = { bins: [
  { bin_id: "652", price: "67800000000", userLiquidity: 228056485 },
  { bin_id: "653", price: "67900000000", userLiquidity: 251243853 },
  { bin_id: "654", price: "68000000000", userLiquidity: 363150745 },
] };

const r1 = await guardian({ body: holderCamel });
check("a real holder is seen, with the field name the endpoint actually sends",
  r1.data.has_position === true, JSON.stringify(r1.data));
check("string bin ids still match the numeric active bin, so it reads in range",
  r1.data.in_range === true && r1.action.startsWith("HOLD: position in range"), r1.action);

// The old spelling, in case the endpoint ever sends it again.
const r2 = await guardian({ body: { bins: [{ bin_id: 653, price: "67900000000", user_liquidity: "500" }] } });
check("the older snake_case spelling is still read",
  r2.data.has_position === true && r2.data.in_range === true, JSON.stringify(r2.data));

// Held bins that do not include the active one: the alarm must still fire.
const r3 = await guardian({ body: { bins: [{ bin_id: 500, userLiquidity: 100 }, { bin_id: 501, userLiquidity: 100 }] } });
check("a position that really is out of range still raises the alarm",
  r3.data.has_position === true && r3.data.in_range === false && r3.action.startsWith("REBALANCE:"), r3.action);

// A wallet whose bins are all empty: nothing there.
const r4 = await guardian({ body: { bins: [{ bin_id: 653, userLiquidity: 0 }, { bin_id: 654, userLiquidity: "0" }] } });
check("bins with no liquidity are no position, not an out of range one",
  r4.action.startsWith("NO POSITION:") && r4.data.has_position === false && r4.data.in_range === null, r4.action);

// The endpoint's own "this wallet has no bins here" answer.
const r5 = await guardian({ status: 404, body: { detail: `Pool dlmm_1 not found or user ${WALLET} has no pool bins` } });
check("a 404 from the position endpoint is no position",
  r5.action.startsWith("NO POSITION:") && r5.data.has_position === false, r5.action);

// The exact live payload, numbers throughout with the meta object the endpoint
// sends, so "the shapes the endpoints actually return" is literally true.
const r6 = await guardian({ body: { bins: [
  { bin_id: 652, price: 67800000000, userLiquidity: 228056485 },
  { bin_id: 653, price: 67900000000, userLiquidity: 251243853 },
], meta: { dataSource: "node_map_entry" } } });
check("the exact live shape, numeric ids and all, reads as a position in range",
  r6.data.has_position === true && r6.data.in_range === true, JSON.stringify(r6.data));

// A rename of the id field, the way the liquidity field was renamed in April.
const r7 = await guardian({ body: { bins: [
  { binId: 652, userLiquidity: 228056485 },
  { binId: 653, userLiquidity: 251243853 },
] } });
check("bins we hold whose ids we cannot read are NOT reported as holding nothing",
  r7.data.has_position === true && r7.data.in_range === null && r7.action.startsWith("CHECK:"), r7.action);
check("and it says plainly that the ids could not be read",
  r7.action.includes("could not be read"), r7.action);

// Values that are not ids must not become real bins: bin 0 exists in this pool,
// and "0x28d" is the active bin.
const r8 = await guardian({ body: { bins: [
  { bin_id: null, userLiquidity: 100 },
  { bin_id: "", userLiquidity: 100 },
  { bin_id: "0x28d", userLiquidity: 100 },
] } });
check("null, empty and hex ids are refused rather than turned into bins 0 and 653",
  r8.data.user_bin_range === null && r8.data.in_range === null && r8.action.startsWith("CHECK:"), r8.action);

// A holder whose bins surround the active one but hold none of it.
const r9 = await guardian({ body: { bins: [
  { bin_id: 600, userLiquidity: 100 },
  { bin_id: 700, userLiquidity: 100 },
] } });
check("a gap at the active bin says so, rather than claiming a range that contains it",
  r9.action.includes("holds none of your liquidity") && r9.action.includes("600 to 700"), r9.action);

// A shape this skill does not recognise is a read that FAILED. Returning an
// empty array made it "this wallet holds nothing", which is a claim about
// somebody's money that nobody measured.
let threw = "";
try { await guardian({ body: { data: { bins: [{ bin_id: 653, userLiquidity: 100 }] } } }); }
catch (e) { threw = (e as Error).message; }
check("an unrecognised response shape is refused, not read as an empty wallet",
  threw.includes("does not recognise"), threw || "(it did not throw)");

// The liquidity field renamed, the way userLiquidity itself was renamed.
const r10 = await guardian({ body: { bins: [
  { bin_id: 652, liquidityShares: 100 },
  { bin_id: 653, liquidityShares: 5 },
] } });
check("bins whose liquidity figure cannot be read are not an empty wallet either",
  r10.action.startsWith("CHECK:") && r10.data.has_position === null && r10.data.in_range === null, r10.action);

// A liquidity value that is not a number at all.
const r11 = await guardian({ body: { bins: [{ bin_id: 653, userLiquidity: { amount: "100" } }] } });
check("a liquidity value that is not a number is unreadable, not zero",
  r11.action.startsWith("CHECK:"), r11.action);

// One bin, so the sentence has to say "bin" rather than "1 bins".
const r12 = await guardian({ body: { bins: [{ bin_id: 653, userLiquidity: 0 }] } });
check("one empty bin reads as one bin",
  r12.action.includes("1 bin for this wallet") && !r12.action.includes("1 bins"), r12.action);

// A 404 that does NOT say "no pool bins" is the route being gone, which is the
// same class of change as the April field rename. Reported as "you hold
// nothing" it would be a confident lie to a holder.
let gone = "";
try { await guardian({ status: 404, body: { detail: "Not Found" } }); }
catch (e) { gone = (e as Error).message; }
check("a 404 that does not say the wallet has no bins is refused, not read as empty",
  gone.includes("without saying this wallet has no bins"), gone || "(it did not throw)");

// Everything downstream keys off the active bin, and bin 0 is a real bin in
// this pool, so an unreadable id must not quietly become one.
let noActive = "";
try {
  await guardian({ body: { bins: [{ bin_id: 653, userLiquidity: 100 }] } }, { activeBinId: undefined });
} catch (e) { noActive = (e as Error).message; }
check("an unreadable active bin id is refused, not turned into bin 0",
  noActive.includes("readable active bin id"), noActive || "(it did not throw)");

// An empty liquidity string is unreadable, not zero: Number("") is 0.
const r13 = await guardian({ body: { bins: [{ bin_id: 653, userLiquidity: "" }] } });
check("an empty liquidity value is unreadable, not a wallet holding nothing",
  r13.action.startsWith("CHECK:"), r13.action);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
