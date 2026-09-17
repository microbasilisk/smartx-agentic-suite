/**
 * The pool quote: price and active bin mix, from reads recorded on mainnet on 17 September 2026.
 *
 * Run: bun test skills/stacks-alpha-engine/tests/pool-quote.test.ts
 *
 * The recorded reads (fixtures/pool-quote-2026-09-17.json) are the raw Hiro answers for three pools chosen for
 * their decimals: dlmm_3 STX (6) and USDCx (6), dlmm_1 sBTC (8) and USDCx (6), dlmm_6 STX (6) and sBTC (8). Every
 * expected figure is worked out here from the decoded raw values, not copied from the quote's output, and the
 * fee free pair is checked by replaying the core's own `add-liquidity` fee arithmetic.
 */

import { describe, expect, test } from "bun:test";
import { hexToCV } from "@stacks/transactions";

import recorded from "./fixtures/pool-quote-2026-09-17.json" with { type: "json" };
import { QuoteError, atomicToDecimal, quotePool, type QuotePool, type QuoteRead } from "../pool-quote.ts";

const STX_TRAIT = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";
const TRAITS: Record<string, string> = {
  stx: STX_TRAIT,
  sbtc: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  usdcx: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
};
const traitFor = (t: string) => TRAITS[t] ?? t;
const TOKENS = { stx: { symbol: "STX", decimals: 6 }, sbtc: { symbol: "sBTC", decimals: 8 }, usdcx: { symbol: "USDCx", decimals: 6 } };
const POOLS: Record<string, QuotePool> = {
  dlmm_1: { id: 1, contract: recorded.pools.dlmm_1, name: "sBTC-USDCx-10bps", tokenX: "sbtc", tokenY: "usdcx" },
  dlmm_3: { id: 3, contract: recorded.pools.dlmm_3, name: "STX-USDCx-10bps", tokenX: "stx", tokenY: "usdcx" },
  dlmm_6: { id: 6, contract: recorded.pools.dlmm_6, name: "STX-sBTC-15bps", tokenX: "stx", tokenY: "sbtc" },
};
const NOW = new Date(recorded.recorded_at);
const HEIGHT = recorded.info.stacks_tip_height;

type Call = { contract: string; fn: string; args: string[]; response: { okay: boolean; result?: string } };
const calls = recorded.calls as Call[];

/** Answers from the recording, matched on contract, function AND arguments, so a wrong bin or price arg misses. */
function reader(bend: (c: Call) => Call | null = (c) => c): QuoteRead {
  return async (contract, fn, args) => {
    const hit = calls.find((c) => c.contract === contract && c.fn === fn && JSON.stringify(c.args) === JSON.stringify(args));
    if (!hit) throw new Error(`no recorded answer for ${fn}`);
    const out = bend(structuredClone(hit));
    if (!out) return { okay: false };
    return out.response;
  };
}

/** The decoded raw values for one pool, to derive expectations independently of the quote. */
function raw(id: keyof typeof POOLS) {
  // Recorded in order for each pool: its record, its active bin, then the core's price for that bin.
  const at = calls.findIndex((c) => c.contract === POOLS[id]!.contract && c.fn === "get-pool-for-add");
  const [recCall, balCall, priceCall] = [calls[at]!, calls[at + 1]!, calls[at + 2]!];
  expect([recCall.fn, balCall.fn, priceCall.fn]).toEqual(["get-pool-for-add", "get-bin-balances", "get-bin-price"]);
  const rec = (hexToCV(recCall.response.result!) as any).value.value;
  const bal = (hexToCV(balCall.response.result!) as any).value.value;
  const price = BigInt((hexToCV(priceCall.response.result!) as any).value.value);
  return {
    signed: BigInt(rec["active-bin-id"].value),
    x: BigInt(bal["x-balance"].value), y: BigInt(bal["y-balance"].value), shares: BigInt(bal["bin-shares"].value),
    price,
    feeX: BigInt(rec["x-protocol-fee"].value) + BigInt(rec["x-provider-fee"].value) + BigInt(rec["x-variable-fee"].value),
    feeY: BigInt(rec["y-protocol-fee"].value) + BigInt(rec["y-provider-fee"].value) + BigInt(rec["y-variable-fee"].value),
  };
}

/** `dlmm-core-v-1-1` add-liquidity, lines 1590 to 1625: the fee on each side for a deposit into the active bin. */
function coreFees(bin: { x: bigint; y: bigint; shares: bigint }, price: bigint, xAmount: bigint, yAmount: bigint, feeX: bigint, feeY: bigint) {
  const value = price * xAmount + yAmount * 100_000_000n;
  const binValue = price * bin.x + bin.y * 100_000_000n;
  const sqrti = (n: bigint) => { if (n < 2n) return n; let r = n, s = (r + 1n) / 2n; while (s < r) { r = s; s = (r + n / r) / 2n; } return r; };
  const dlp = bin.shares === 0n || binValue === 0n ? sqrti(value) : (value * bin.shares) / binValue;
  if (dlp === 0n) return { x: 0n, y: 0n };
  const xW = (dlp * (bin.x + xAmount)) / (bin.shares + dlp);
  const yW = (dlp * (bin.y + yAmount)) / (bin.shares + dlp);
  const fx = yW > yAmount && xAmount > xW ? ((xAmount - xW) * feeX) / 10_000n : 0n;
  const fy = xW > xAmount && yAmount > yW ? ((yAmount - yW) * feeY) / 10_000n : 0n;
  return { x: fx > xAmount ? xAmount : fx, y: fy > yAmount ? yAmount : fy };
}

/** A decimal string back to smallest units. */
function toAtomic(s: string, places: number): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole!) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0").slice(0, places) || "0");
}

const quote = (id: keyof typeof POOLS, read: QuoteRead = reader()) => quotePool(POOLS[id]!, TOKENS, traitFor, read, HEIGHT, NOW);

describe("the recorded pools, read as the chain answered", () => {
  test("dlmm_3: the price and the bin's mix are two different numbers, and both are exact", async () => {
    const r = raw("dlmm_3");
    const q = await quote("dlmm_3");
    expect(q.active_bin).toBe(Number(r.signed + 500n));
    expect(q.block_height).toBe(HEIGHT);
    expect(q.read_at).toBe(NOW.toISOString());
    // STX and USDCx both carry 6 decimals, so the human price is price / 1e8.
    expect(q.price.y_per_x).toBe(atomicToDecimal(r.price, 8));
    expect(q.active_bin_holds).toEqual({ x: atomicToDecimal(r.x, 6), y: atomicToDecimal(r.y, 6), x_atomic: String(r.x), y_atomic: String(r.y), shares: String(r.shares) });
    expect(q.fee_bps).toEqual({ x: Number(r.feeX), y: Number(r.feeY) });
    expect(q.fee_free.case).toBe("both");
    expect(q.fee_free.x_per_one_y).toBe(atomicToDecimal((1_000_000n * r.x) / r.y, 6));
    expect(q.fee_free.y_per_one_x).toBe(atomicToDecimal((1_000_000n * r.y) / r.x, 6));
    // On this day the two ideas sat more than ten times apart: the fee free pair is not an equal value pair.
    expect(Number(q.fee_free.x_per_one_y) / Number(q.price.x_per_y)).toBeGreaterThan(10);
  });

  test("dlmm_1 (8 and 6 decimals) and dlmm_6 (6 and 8) scale the price the right way round", async () => {
    const one = raw("dlmm_1");
    const q1 = await quote("dlmm_1");
    // sBTC per USDCx: price / 1e8 * 10^(8 - 6).
    expect(q1.price.y_per_x).toBe(atomicToDecimal(one.price * 100n, 8));
    expect(q1.fee_free.y_per_one_x).toBe(atomicToDecimal((100_000_000n * one.y) / one.x, 6));
    expect(q1.fee_free.x_per_one_y).toBe(atomicToDecimal((1_000_000n * one.x) / one.y, 8));
    const six = raw("dlmm_6");
    const q6 = await quote("dlmm_6");
    // STX priced in sBTC: price / 1e8 * 10^(6 - 8), a figure far under one.
    expect(q6.price.y_per_x).toBe(atomicToDecimal(six.price, 10));
    expect(Number(q6.price.y_per_x)).toBeLessThan(0.001);
    expect(q6.fee_free.x_per_one_y).toBe(atomicToDecimal((100_000_000n * six.x) / six.y, 6));
  });

  test("a pair built from the quoted mix pays no fee beyond rounding, replayed through the core's own arithmetic", async () => {
    for (const id of ["dlmm_1", "dlmm_3", "dlmm_6"] as const) {
      const r = raw(id);
      const q = await quote(id);
      const dx = TOKENS[POOLS[id]!.tokenX as keyof typeof TOKENS].decimals;
      const dy = TOKENS[POOLS[id]!.tokenY as keyof typeof TOKENS].decimals;
      // Every whole count of the Y coin from 1 to 1000, with the X side taken from the quote's per unit figure
      // the way a person would scale it. The per unit figure is rounded to the coin's smallest unit, so a few
      // smallest units can go unmatched: the fee must stay under a millionth of the deposit's value (the quote
      // says "far less than a hundredth of a percent"). dlmm_3 and dlmm_6 recorded exactly 0.
      for (let n = 1n; n <= 1000n; n++) {
        const yAmount = n * 10n ** BigInt(dy);
        const xAmount = n * toAtomic(q.fee_free.x_per_one_y!, dx);
        const fees = coreFees(r, r.price, xAmount, yAmount, r.feeX, r.feeY);
        const feeValue = r.price * fees.x + fees.y * 100_000_000n;
        const depositValue = r.price * xAmount + yAmount * 100_000_000n;
        expect(feeValue * 1_000_000n <= depositValue, `${id} n=${n}`).toBe(true);
        if (id !== "dlmm_1") expect(fees.x + fees.y, `${id} n=${n}`).toBe(0n);
      }
      // And a one coin deposit of 1 percent of the bin's Y does pay, well above the rounding bound, so the
      // replay can see a fee at all and the bound is not trivially true.
      const oneSided = r.y / 100n;
      const uneven = coreFees(r, r.price, 0n, oneSided, r.feeX, r.feeY);
      expect(uneven.y, id).toBeGreaterThan(0n);
      expect(uneven.y * 100_000_000n * 1_000_000n > oneSided * 100_000_000n, id).toBe(true);
    }
  });

  test("a variable fee the pool's fee manager sets is part of the rate", async () => {
    // All three recorded pools carry a variable fee of 0; the core lets it be set (set-variable-fees).
    const hex = (n: bigint) => n.toString(16).padStart(32, "0");
    const name = (k: string) => k.length.toString(16).padStart(2, "0") + Buffer.from(k).toString("hex");
    const withVariable = reader((c) => {
      if (c.fn === "get-pool-for-add" && c.contract === POOLS.dlmm_3!.contract) {
        c.response.result = c.response.result!
          .replace(name("x-variable-fee") + "01" + hex(0n), name("x-variable-fee") + "01" + hex(7n))
          .replace(name("y-variable-fee") + "01" + hex(0n), name("y-variable-fee") + "01" + hex(11n));
      }
      return c;
    });
    const r = raw("dlmm_3");
    const q = await quote("dlmm_3", withVariable);
    expect(q.fee_bps).toEqual({ x: Number(r.feeX) + 7, y: Number(r.feeY) + 11 });
  });

  test("the notes say the fee stays in the bin and the coins land in whichever bin is active at confirmation", async () => {
    const q = await quote("dlmm_3");
    const all = q.notes.join(" ");
    expect(all).toContain("fewer shares");
    expect(all).toContain("no extra coins leave your wallet");
    expect(all).toContain("active when the transaction confirms");
  });
});

describe("a bin that is empty, or holds one coin", () => {
  const withBalances = (x: bigint, y: bigint, shares: bigint): QuoteRead => async (contract, fn, args) => {
    if (fn !== "get-bin-balances") return reader()(contract, fn, args);
    const hex = (n: bigint) => n.toString(16).padStart(32, "0");
    // (ok (tuple (bin-shares uint) (x-balance uint) (y-balance uint))), keys in Clarity's sorted order.
    const key = (k: string) => (k.length.toString(16).padStart(2, "0")) + Buffer.from(k).toString("hex");
    const result = "0x07" + "0c" + "00000003" + key("bin-shares") + "01" + hex(shares) + key("x-balance") + "01" + hex(x) + key("y-balance") + "01" + hex(y);
    return { okay: true, result };
  };

  test("no shares: no pair pays a fee there, and no per unit figure is given", async () => {
    const q = await quote("dlmm_3", withBalances(0n, 0n, 0n));
    expect(q.fee_free).toMatchObject({ case: "empty", y_per_one_x: null, x_per_one_y: null });
  });

  test("shares with no coins behind them is empty too, not a bin of one coin", async () => {
    const q = await quote("dlmm_3", withBalances(0n, 0n, 5n));
    expect(q.fee_free.case).toBe("empty");
  });

  test("only STX in the bin: any USDCx is unmatched, and the replay agrees it pays", async () => {
    const q = await quote("dlmm_3", withBalances(1_000_000_000n, 0n, 1_000_000n));
    expect(q.fee_free).toMatchObject({ case: "only_x", y_per_one_x: null, x_per_one_y: null });
    expect(q.fee_free.says).toContain("holds only STX");
    expect(q.fee_free.says).toContain("any USDCx");
    const r = raw("dlmm_3");
    const fees = coreFees({ x: 1_000_000_000n, y: 0n, shares: 1_000_000n }, r.price, 10_000_000n, 1_000_000n, r.feeX, r.feeY);
    expect(fees.y).toBeGreaterThan(0n);
  });

  test("only USDCx in the bin says so the other way round", async () => {
    const q = await quote("dlmm_3", withBalances(0n, 1_000_000n, 1_000_000n));
    expect(q.fee_free.case).toBe("only_y");
    expect(q.fee_free.says).toContain("holds only USDCx");
    expect(q.fee_free.says).toContain("any STX");
  });
});

describe("it refuses rather than guess", () => {
  const refuses = async (read: QuoteRead, status: "blocked" | "error", words: string, pool: QuotePool = POOLS.dlmm_3!) => {
    const err = await quotePool(pool, TOKENS, traitFor, read, HEIGHT, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteError);
    expect((err as QuoteError).status).toBe(status);
    expect((err as QuoteError).message).toContain(words);
  };

  test("a read that fails, at each of the three reads", async () => {
    for (const fn of ["get-pool-for-add", "get-bin-balances", "get-bin-price"]) {
      await refuses(reader((c) => (c.fn === fn ? null : c)), "error", fn);
    }
    await refuses(async () => { throw new Error("nobody answered"); }, "error", "nobody answered");
  });

  test("a pool now run by another core, or holding other coins, is blocked", async () => {
    const coreHex = Buffer.from("dlmm-core-v-1-1").toString("hex");
    await refuses(reader((c) => {
      if (c.fn === "get-pool-for-add" && c.contract === POOLS.dlmm_3!.contract) c.response.result = c.response.result!.replace(coreHex, Buffer.from("dlmm-core-v-9-9").toString("hex"));
      return c;
    }), "blocked", "core contract");
    await refuses(reader(), "blocked", "no longer holds the coins", { ...POOLS.dlmm_3!, tokenX: "sbtc" });
  });

  test("a pool whose coins have no decimals in the list is blocked before any read", async () => {
    let asked = false;
    await refuses(async () => { asked = true; return { okay: false }; }, "blocked", "no decimals", { ...POOLS.dlmm_3!, tokenY: "zest" });
    expect(asked).toBe(false);
  });

  test("a price of zero is an error, never a quote", async () => {
    await refuses(reader((c) => {
      if (c.fn === "get-bin-price" && c.contract.endsWith("dlmm-core-v-1-1")) c.response.result = "0x07" + "01" + "0".repeat(32);
      return c;
    }), "error", "zero");
  });
});

describe("the command", () => {
  test("a pool id the skill does not list is blocked with the list, exit 1, before any read", () => {
    const engine = new URL("../stacks-alpha-engine.ts", import.meta.url).pathname;
    // An unroutable Hiro address: if the command read anything first it would fail as an error, not blocked.
    const run = Bun.spawnSync(["bun", "run", engine, "pool-quote", "--pool-id", "dlmm_12"], { env: { ...process.env, HIRO_API: "http://127.0.0.1:9" } });
    const out = JSON.parse(run.stdout.toString());
    expect(run.exitCode).toBe(1);
    expect(out).toMatchObject({ status: "blocked", command: "pool-quote" });
    expect(out.error).toContain("dlmm_3");
    expect(out.error).not.toContain("dlmm_12,");
  });

  test("a failed chain read is an error, exit 1, never a quote", () => {
    const engine = new URL("../stacks-alpha-engine.ts", import.meta.url).pathname;
    const run = Bun.spawnSync(["bun", "run", engine, "pool-quote", "--pool-id", "dlmm_3"], { env: { ...process.env, HIRO_API: "http://127.0.0.1:9" } });
    const out = JSON.parse(run.stdout.toString());
    expect(run.exitCode).toBe(1);
    expect(out.status).toBe("error");
    expect(out.data).toBeUndefined();
  });
});

describe("a ratio smaller than a coin's smallest unit", () => {
  test("is said as a bound, never as zero, so no coin reads as costing nothing", async () => {
    // LEO-STX shape: the active bin holds 116,097 LEO against 0.000127 STX (read 17 September 2026), so STX per
    // one LEO is about 0.0000000011, under a microSTX.
    const hex = (n: bigint) => n.toString(16).padStart(32, "0");
    const key = (k: string) => (k.length.toString(16).padStart(2, "0")) + Buffer.from(k).toString("hex");
    const balances = (x: bigint, y: bigint, shares: bigint): QuoteRead => async (contract, fn, args) => {
      if (fn !== "get-bin-balances") return reader()(contract, fn, args);
      return { okay: true, result: "0x07" + "0c" + "00000003" + key("bin-shares") + "01" + hex(shares) + key("x-balance") + "01" + hex(x) + key("y-balance") + "01" + hex(y) };
    };
    // The recorded pool's own two traits, renamed LEO and STX, so the record still matches and only the decimals
    // and the balances matter to the figures under test.
    const q = await quotePool({ ...POOLS.dlmm_3!, name: "LEO-STX-50bps", tokenX: "leo", tokenY: "ministx" },
      { leo: { symbol: "LEO", decimals: 6 }, ministx: { symbol: "STX", decimals: 6 } },
      (t) => (t === "leo" ? TRAITS.stx! : TRAITS.usdcx!),
      balances(116_097_000_000n, 127n, 1_000_000n), HEIGHT, NOW);
    expect(q.fee_free.y_per_one_x).toBe("0");
    expect(q.fee_free.says).toContain("under 0.000001 STX for every 1 LEO");
    expect(q.fee_free.says).not.toContain("0 STX for every 1 LEO");
    // The other direction is a real figure and is printed as one.
    expect(q.fee_free.says).toContain(`${q.fee_free.x_per_one_y} LEO for every 1 STX`);
  });
});
