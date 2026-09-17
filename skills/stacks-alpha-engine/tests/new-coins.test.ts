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
  test("contract, asset name and 6 decimals for each coin, and HODLMM deploys accept all three", () => {
    expect(src).toContain('const STSTX_TOKEN         = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token";');
    expect(src).toContain('const ZEST_TOKEN          = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zest-token";');
    expect(src).toContain('const LEO_TOKEN           = "SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token";');
    expect(src).toContain('ststx:  { symbol: "stSTX",  contract: STSTX_TOKEN,  decimals: 6, ftSuffix: "::ststx" },');
    expect(src).toContain('zest:   { symbol: "ZEST",   contract: ZEST_TOKEN,   decimals: 6, ftSuffix: "::zest" },');
    expect(src).toContain('leo:    { symbol: "LEO",    contract: LEO_TOKEN,    decimals: 6, ftSuffix: "::leo" },');
    // Only the coins of pools this skill lists: ZEST and LEO joined with their pools (part 2, 17 September).
    expect(src).toContain('hodlmm: ["sbtc", "stx", "usdcx", "usdh", "aeusdc", "ststx", "zest", "leo"] };');
  });
});

describe("the stSTX pool, where STX is the second coin", () => {
  test("a two coin deposit naming STX first puts STX on the Y side and stSTX on X, with one condition each", async () => {
    const { buildDeployInstructions } = await import("../stacks-alpha-engine.ts");
    const scout = {
      wallet: W,
      balances: {
        stx:   { amount: 50, usd: 0, atomic: "50000000" },
        ststx: { amount: 40, usd: 0, atomic: "40000000" },
      },
      prices: { sbtc: 78000, stx: 0.25, usdcx: 1, usdh: 1, aeusdc: 1, ststx: 0.29, zest: 0.128, leo: 0.0001 },
    } as never;
    // 12 STX named, with 10 stSTX as the counter amount.
    const b = buildDeployInstructions("hodlmm" as never, 12_000_000, "stx", scout, "dlmm_10", 10_000_000, true);
    expect(b.refusal ?? null).toBeNull();
    const call = b.instructions.find((i) => i.tool === "call_contract")!;
    const p = call.params as Record<string, any>;
    const [bins, pool, xTrait, yTrait] = p.functionArgs;
    expect(pool.value).toBe("SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-ststx-stx-v-1-bps-1");
    expect(xTrait.value).toBe("SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token");
    expect(yTrait.value).toBe("SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2");
    expect(bins.value).toHaveLength(1);
    expect(bins.value[0].value["active-bin-id-offset"].value).toBe(0);
    expect(bins.value[0].value["x-amount"].value).toBe("10000000");
    expect(bins.value[0].value["y-amount"].value).toBe("12000000");
    expect(p.postConditionMode).toBe("deny");
    expect(p.postConditions).toEqual([
      { type: "ft", principal: W, asset: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token", assetName: "ststx", conditionCode: "lte", amount: "10000000" },
      { type: "stx", principal: W, conditionCode: "lte", amount: "12000000" },
    ]);
    expect(call.description).toContain("at most 10 stSTX and 12 STX leaving your wallet");
  });

  test("a wallet holding stSTX is not told it holds none", async () => {
    const { buildDeployInstructions } = await import("../stacks-alpha-engine.ts");
    const scout = { wallet: W, balances: { stx: { amount: 0, usd: 0, atomic: "0" }, ststx: { amount: 3, usd: 0, atomic: "3000000" } }, prices: {} } as never;
    const b = buildDeployInstructions("hodlmm" as never, 5_000_000, "ststx", scout, "dlmm_10", null, true);
    expect(String(b.refusal ?? "")).toContain("you hold 3000000 and named 5000000");
  });
});

describe("a pool too quiet for the volume check is listed, never offered as enterable", () => {
  test("the floor is the guardian's own: 10,000 dollars of 24 hour volume, and not a number is not clear", async () => {
    const { clearsVolumeFloor } = await import("../stacks-alpha-engine.ts");
    expect(clearsVolumeFloor(10_000)).toBe(true);
    expect(clearsVolumeFloor(61_873.29)).toBe(true);
    for (const v of [9_999.99, 249, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "12000", null, undefined]) {
      expect(clearsVolumeFloor(v), String(v)).toBe(false);
    }
  });

  test("the option row carries the flag, the volume and the reason from the same floor", () => {
    const src = require("node:fs").readFileSync(engine, "utf8") as string;
    expect(src).toContain("enterable: clearsVolumeFloor(bp.volumeUsd1d),");
    expect(src).toContain("is under the $${MIN_24H_VOLUME_USD.toLocaleString()} the safety check requires.");
    expect(src).toContain("const ok = clearsVolumeFloor(usd);");
  });
});

describe("the ZEST and LEO pools", () => {
  const scoutWith = (coin: "zest" | "leo", atomic: string) => ({
    wallet: W,
    balances: { stx: { amount: 50, usd: 0, atomic: "50000000" }, [coin]: { amount: Number(atomic) / 1e6, usd: 0, atomic } },
    prices: { sbtc: 78000, stx: 0.25, usdcx: 1, usdh: 1, aeusdc: 1, ststx: 0.29, zest: 0.128, leo: 0.0001 },
  }) as never;

  test("a two coin ZEST deposit into the v2 pool caps ZEST under its own asset name and STX as STX", async () => {
    const { buildDeployInstructions } = await import("../stacks-alpha-engine.ts");
    const b = buildDeployInstructions("hodlmm" as never, 30_000_000, "zest", scoutWith("zest", "40000000"), "dlmm_11", 5_000_000, true);
    expect(b.refusal ?? null).toBeNull();
    const p = b.instructions.find((i) => i.tool === "call_contract")!.params as Record<string, any>;
    expect(p.functionArgs[1].value).toBe("SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-zest-stx-v-2-bps-50");
    expect(p.functionArgs[2].value).toBe("SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zest-token");
    expect(p.postConditions).toEqual([
      { type: "ft", principal: W, asset: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.zest-token", assetName: "zest", conditionCode: "lte", amount: "30000000" },
      { type: "stx", principal: W, conditionCode: "lte", amount: "5000000" },
    ]);
  });

  test("LEO's pool builds with LEO's asset name, and the v1 and v2 ZEST pools are distinct", async () => {
    const { buildDeployInstructions } = await import("../stacks-alpha-engine.ts");
    const leo = buildDeployInstructions("hodlmm" as never, 5_000_000, "stx", scoutWith("leo", "900000000000"), "dlmm_13", 800_000_000_000, true);
    const p = leo.instructions.find((i) => i.tool === "call_contract")!.params as Record<string, any>;
    expect(p.postConditions[0]).toMatchObject({ asset: "SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token", assetName: "leo", amount: "800000000000" });
    const v1 = buildDeployInstructions("hodlmm" as never, 30_000_000, "zest", scoutWith("zest", "40000000"), "dlmm_9", 5_000_000, true);
    expect((v1.instructions.find((i) => i.tool === "call_contract")!.params as Record<string, any>).functionArgs[1].value)
      .toBe("SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-zest-stx-v-1-bps-50");
  });

  test("dlmm_12, the ZEST pool stuck at the lowest bin, is never listed", async () => {
    const src = require("node:fs").readFileSync(engine, "utf8") as string;
    expect(src).not.toContain("dlmm-pool-zest-stx-v-3-bps-50\"");
    expect(src).not.toMatch(/\{ id: 12,/);
  });
});
