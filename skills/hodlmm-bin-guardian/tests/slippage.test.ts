/**
 * The drift check's price comparison, for pools not quoted in a dollar coin.
 *
 * Run: bun test skills/hodlmm-bin-guardian/tests/slippage.test.ts
 *
 * Plain version: a HODLMM bin price says how much of the second coin one of the first is worth. It is only a dollar
 * figure after multiplying by the second coin's dollar price. Before 17 September 2026 this check skipped that, so the
 * stSTX/STX pool read about 300 percent out of line with the market while it was within a hundredth of a percent.
 * Figures are Bitflow's and the chain's own, read 17 September 2026.
 */

import { describe, expect, test } from "bun:test";

import { checkSlippage } from "../hodlmm-bin-guardian.ts";

describe("the bin price in dollars uses the quote coin's dollar price", () => {
  test("stSTX/STX (dlmm_10): 1.17677812 STX per stSTX at $0.2493 is $0.29337, in line with stSTX's $0.2934", () => {
    const r = checkSlippage(117_677_812, 6, 6, 0.2934, 0.2493);
    expect(r.source).toBe("bitflow-app-price-vs-hodlmm-active-bin");
    expect(r.pool_price).toBeCloseTo(0.293371, 5);
    expect(r.pct).toBeLessThan(0.1);
    expect(r.ok).toBe(true);
  });

  test("a dollar quoted pool is unchanged: sBTC/USDCx (dlmm_1) at 67,900 USDCx with USDCx at $1", () => {
    const r = checkSlippage(67_900_000_000, 8, 6, 67_900, 1);
    expect(r.pool_price).toBe(67_900);
    expect(r.pct).toBe(0);
  });

  test("STX/sBTC (dlmm_6): the negative decimal step and an sBTC price", () => {
    const r = checkSlippage(32_541, 6, 8, 0.2493, 76_600);
    expect(r.pool_price).toBeCloseTo(0.249264, 5);
    expect(r.pct).toBeLessThan(0.1);
  });

  test("a coin priced at a hundredth of a cent is not rounded to zero: LEO/STX", () => {
    const r = checkSlippage(41_292, 6, 6, 0.0001032, 0.2498);
    expect(r.pool_price).toBeGreaterThan(0);
    expect(r.pct).toBeLessThan(1);
  });

  test("a real divergence is still caught", () => {
    const r = checkSlippage(117_677_812, 6, 6, 0.40, 0.2493);
    expect(r.ok).toBe(false);
    expect(r.pct).toBeGreaterThan(20);
  });

  test("no price for either coin is 'unavailable', never a comparison against zero", () => {
    for (const [x, y] of [[0, 0.25], [0.29, 0], [Number.NaN, 0.25], [0.29, -1]]) {
      expect(checkSlippage(117_677_812, 6, 6, x!, y!).source, `${x} ${y}`).toBe("bitflow-price-unavailable");
    }
  });
});
