/**
 * The coins of Bitflow's stSTX, ZEST and LEO pools, known to the engine before any of those pools is offered.
 *
 * Run: bun test skills/stacks-alpha-engine/tests/new-coins.test.ts
 *
 * Plain version: a wallet holding stSTX, ZEST or LEO used to read as holding none of them, because the engine's
 * balances had six fixed coins. These tests put the three coins in a stubbed wallet and check the scan reads the
 * exact amounts, prices them from Tenero (never pegged), says when a price is missing only if the wallet holds
 * some, and that the record for each coin names the asset the chain defines. The balances read goes to a local
 * stub through HIRO_API; Tenero is the real host, so prices are asserted as present and positive, not as values.
 */

import { describe, expect, test } from "bun:test";

import { teneroQuoteUsd } from "../stacks-alpha-engine.ts";

const engine = new URL("../stacks-alpha-engine.ts", import.meta.url).pathname;
const W = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";
const COINS = {
  "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token::ststx": "2500000",
  "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zest-token::zest": "7000000",
  "SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token::leo": "123456789",
};

async function scan(tokens: Record<string, string>): Promise<Record<string, any>> {
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.endsWith(`/address/${W}/balances`)) {
        return Response.json({ stx: { balance: "5000000", locked: "0" }, fungible_tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, { balance: v }])) });
      }
      if (u.pathname.includes("/call-read/")) return Response.json({ okay: true, result: "0x0700000000000000000000000000000000" });
      return Response.json({});
    },
  });
  try {
    const p = Bun.spawn(["bun", "run", engine, "scan", "--wallet", W], { env: { ...process.env, HIRO_API: `http://127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out);
  } finally {
    server.stop(true);
  }
}

describe("a wallet holding the three coins", () => {
  test("the scan reads each amount exactly, prices it from Tenero, and totals it", async () => {
    const j = await scan(COINS);
    const b = j.scout.balances;
    expect(b.ststx).toMatchObject({ atomic: "2500000", amount: 2.5 });
    expect(b.zest).toMatchObject({ atomic: "7000000", amount: 7 });
    expect(b.leo).toMatchObject({ atomic: "123456789", amount: 123.456789 });
    for (const k of ["ststx", "zest", "leo"]) {
      expect(j.scout.available[`price_${k}`], k).toBe(true);
      expect(j.scout.prices[k], k).toBeGreaterThan(0);
    }
    // Never pegged: LEO is about $0.0001, so a $1 peg would read over $100 here.
    expect(b.leo.usd).toBeLessThan(1);
    expect(j.rendered_report).toContain("| stSTX   | 2.5");
    expect(j.rendered_report).toContain("| ZEST    | 7");
    expect(j.rendered_report).toContain("| LEO     | 123.456789");
  }, 60_000);

  test("a wallet holding none of them reads 0 of each, and a missing price for them is not reported", async () => {
    const j = await scan({});
    for (const k of ["ststx", "zest", "leo"]) expect(j.scout.balances[k], k).toMatchObject({ atomic: "0", amount: 0, usd: 0 });
    expect(j.scout.available.unavailable.join(" ")).not.toMatch(/stSTX|ZEST|LEO/);
  }, 60_000);
});

describe("one coin's price from a Tenero answer", () => {
  test("price.current_price first, else price_usd, and anything else is no price", () => {
    expect(teneroQuoteUsd({ data: { price_usd: 0.000104, price: { current_price: 0.000102728 } } })).toBe(0.000102728);
    expect(teneroQuoteUsd({ data: { price_usd: 0.2927 } })).toBe(0.2927);
    for (const body of [null, {}, { data: {} }, { data: { price_usd: 0 } }, { data: { price: { current_price: -1 } } }, { data: { price_usd: "0.29" } }, { data: { price: { current_price: Number.NaN } } }]) {
      expect(teneroQuoteUsd(body), JSON.stringify(body)).toBe(0);
    }
  });
});

describe("the records name what the chain defines", () => {
  const src = require("node:fs").readFileSync(engine, "utf8") as string;
  test("contract, asset name and 6 decimals for each coin, and HODLMM deploys accept them", () => {
    expect(src).toContain('const STSTX_TOKEN         = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token";');
    expect(src).toContain('const ZEST_TOKEN          = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zest-token";');
    expect(src).toContain('const LEO_TOKEN           = "SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token";');
    expect(src).toContain('ststx:  { symbol: "stSTX",  contract: STSTX_TOKEN,  decimals: 6, ftSuffix: "::ststx" },');
    expect(src).toContain('zest:   { symbol: "ZEST",   contract: ZEST_TOKEN,   decimals: 6, ftSuffix: "::zest" },');
    expect(src).toContain('leo:    { symbol: "LEO",    contract: LEO_TOKEN,    decimals: 6, ftSuffix: "::leo" },');
    expect(src).toContain('hodlmm: ["sbtc", "stx", "usdcx", "usdh", "aeusdc", "ststx", "zest", "leo"] };');
  });
});
