/**
 * The move plan's arithmetic and rules, checked against a real mainnet move.
 *
 * Run from the suite root: `bun test skills/hodlmm-move-liquidity`.
 *
 * `move-9cbe5903.json` holds the core's own print events for the agent wallet's move of 12 April
 * (tx 0x9cbe5903...d939, five legs, sBTC/USDCx pool): each leg's amounts, bin price, shares minted and
 * the bins' balances after it. The bins' starting state is rebuilt from the first leg that touches
 * each bin, and `simulateMove` must mint exactly the shares the chain minted, leg by leg, including
 * legs whose destination is the bin an earlier leg just left.
 */

import { describe, expect, test } from "bun:test";
import { Cl, cvToHex } from "@stacks/transactions";

import fixture from "./move-9cbe5903.json" with { type: "json" };
import {
  CORE, MAX_MOVE_BINS, MoveBlocked, ROUTER, SPREAD, legsFor, liquidityValue, moveInstruction, planMove, simulateMove,
  type BinState, type Leg, type ReadOnly,
} from "../move-plan.ts";

type Printed = Record<string, string>;
const legsPrinted = fixture.legs as Printed[];
const n = (s: string) => BigInt(s);

function blocked(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MoveBlocked) return e.code;
    throw e;
  }
  return "built";
}

describe("the arithmetic reproduces a real move", () => {
  // Starting state of every bin, from the first leg that touches it.
  const bins = new Map<number, BinState>();
  const prices = new Map<number, bigint>();
  for (const l of legsPrinted) {
    const from = Number(l["unsigned-from-bin-id"]), to = Number(l["unsigned-to-bin-id"]);
    const x = n(l["x-amount"]!) + n(l["x-amount-fees-liquidity"]!), y = n(l["y-amount"]!) + n(l["y-amount-fees-liquidity"]!);
    if (!bins.has(from)) {
      bins.set(from, { x: n(l["updated-x-balance-a"]!) + x, y: n(l["updated-y-balance-a"]!) + y, shares: n(l["updated-bin-shares-a"]!) + n(l.amount!) });
    }
    if (!bins.has(to)) {
      bins.set(to, { x: n(l["updated-x-balance-b"]!) - x, y: n(l["updated-y-balance-b"]!) - y, shares: n(l["updated-bin-shares-b"]!) - n(l.dlp!) - n(l["burn-amount"]!) });
    }
    prices.set(to, n(l["bin-price"]!));
  }
  const legs: Leg[] = legsPrinted.map((l) => ({ from: Number(l["unsigned-from-bin-id"]), to: Number(l["unsigned-to-bin-id"]), amount: n(l.amount!) }));

  test("every leg mints exactly what the chain minted, and every fee in it was 0", () => {
    for (const l of legsPrinted) {
      expect(l["x-amount-fees-liquidity"]).toBe("0");
      expect(l["y-amount-fees-liquidity"]).toBe("0");
      expect(l["burn-amount"]).toBe("0");
    }
    const sim = simulateMove(legs, bins, prices);
    expect(sim.map((s) => s.dlp.toString())).toEqual(legsPrinted.map((l) => l.dlp));
    expect(fixture.result).toBe(`(ok (list ${legsPrinted.map((l) => `u${l.dlp}`).join(" ")}))`);
    // min-dlp would have let every leg through, sits strictly under what minted, and half a percent under is never zero.
    for (const s of sim) {
      expect(s.minDlp < s.dlp).toBe(true);
      expect(s.minDlp * 1000n).toBeGreaterThanOrEqual(s.dlp * 995n - 1000n);
    }
  });

  test("a leg moving into a bin with shares but no value, or no shares, is refused", () => {
    const empty = new Map(bins);
    empty.set(legs[0]!.to, { x: 0n, y: 0n, shares: 5n });
    expect(blocked(() => simulateMove(legs, empty, prices))).toBe("EMPTY_DESTINATION");
    empty.set(legs[0]!.to, { x: 10n, y: 10n, shares: 0n });
    expect(blocked(() => simulateMove(legs, empty, prices))).toBe("EMPTY_DESTINATION");
  });

  test("a leg that moves nothing, or more shares than the bin holds, is refused", () => {
    expect(blocked(() => simulateMove([{ ...legs[0]!, amount: 0n }], bins, prices))).toBe("BAD_LEG");
    const from = bins.get(legs[0]!.from)!;
    expect(blocked(() => simulateMove([{ ...legs[0]!, amount: from.shares + 1n }], bins, prices))).toBe("BAD_LEG");
    const dust = new Map(bins);
    dust.set(legs[0]!.from, { x: 1n, y: 0n, shares: 1_000_000n });
    expect(blocked(() => simulateMove([{ ...legs[0]!, amount: 1n }], dust, prices))).toBe("DUST");
  });

  test("a destination where whole-share rounding would lose more than 1 percent is refused by the claim check", () => {
    // Bin 2 holds 300 (in Y units) over 3 shares. Moving 190 in mints floor(190 x 3 / 300) = 1 share,
    // which can claim back only 490 / 4 = 122, under 99 percent of 190.
    const small = new Map<number, BinState>([[1, { x: 190n, y: 0n, shares: 190n }], [2, { x: 0n, y: 300n, shares: 3n }]]);
    const price = new Map([[2, 100_000_000n]]);
    expect(blocked(() => simulateMove([{ from: 1, to: 2, amount: 190n }], small, price))).toBe("POOR_DESTINATION");
    // The same move into a deep bin rounds away nothing that matters.
    const deep = new Map<number, BinState>([[1, { x: 190n, y: 0n, shares: 190n }], [2, { x: 0n, y: 300_000_000n, shares: 3_000_000_000n }]]);
    expect(blocked(() => simulateMove([{ from: 1, to: 2, amount: 190n }], deep, price))).toBe("built");
    expect(liquidityValue(190n, 0n, 100_000_000n)).toBe(19_000_000_000n);
  });
});

describe("which positions move, and where", () => {
  const held = (...entries: Array<[number, bigint]>) => new Map(entries);

  test("a position wholly above the price moves into the five bins just above it, split evenly, every share", () => {
    const { side, legs, to } = legsFor(held([499, 109_381_108n]), 408);
    expect(side).toBe("above");
    expect(to).toEqual([409, 410, 411, 412, 413]);
    expect(legs.map((l) => l.to)).toEqual(to);
    expect(legs.reduce((s, l) => s + l.amount, 0n)).toBe(109_381_108n);
    expect(legs.map((l) => l.amount)).toEqual([21_876_221n, 21_876_221n, 21_876_221n, 21_876_221n, 21_876_224n]);
  });

  test("a position wholly below moves into the five bins just below, never into the active bin", () => {
    const { side, to } = legsFor(held([300, 10n], [301, 10n]), 408);
    expect(side).toBe("below");
    expect(to).toEqual([403, 404, 405, 406, 407]);
    expect(to).not.toContain(408);
    expect(SPREAD).toBe(5);
  });

  test("a bin too small to split goes whole into the first destination", () => {
    const { legs } = legsFor(held([499, 3n]), 408);
    expect(legs).toEqual([{ from: 499, to: 409, amount: 3n }]);
  });

  const refusals: Array<[string, Map<number, bigint>, number, string]> = [
    ["no position", held(), 408, "NO_POSITION"],
    ["a position that straddles the price", held([400, 1n], [420, 1n]), 408, "COVERS_PRICE"],
    ["a position holding the active bin", held([408, 1n]), 408, "COVERS_PRICE"],
    ["a position already beside the price", held([410, 100n], [430, 100n]), 408, "ALREADY_BESIDE_PRICE"],
    ["more bins than one move takes", new Map(Array.from({ length: MAX_MOVE_BINS + 1 }, (_, i) => [500 + i, 100n] as [number, bigint])), 408, "TOO_MANY_BINS"],
  ];
  for (const [label, h, active, code] of refusals) {
    test(label, () => expect(blocked(() => legsFor(h, active))).toBe(code));
  }
});

describe("the plan reads the pool, and the transaction is deny mode with nothing but shares and receipts", () => {
  const POOL = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10";
  const WALLET = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";
  const X = "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx";
  const Y = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

  function chain(over: { core?: string; active?: number; userBins?: number[]; bin499?: BinState; destEmpty?: boolean } = {}): ReadOnly {
    const ok = (cv: Parameters<typeof cvToHex>[0]) => ({ okay: true, result: cvToHex(cv) });
    return async (contract, fn, args) => {
      if (contract === POOL && fn === "get-pool-for-add") {
        return ok(Cl.ok(Cl.tuple({
          "core-address": Cl.principal(over.core ?? CORE), "active-bin-id": Cl.int((over.active ?? 408) - 500),
          "x-token": Cl.principal(X), "y-token": Cl.principal(Y), "initial-price": Cl.uint(25_000_000), "bin-step": Cl.uint(10),
        })));
      }
      if (contract === POOL && fn === "get-user-bins") return ok(Cl.ok(Cl.list((over.userBins ?? [499]).map((b) => Cl.uint(b)))));
      if (contract === POOL && fn === "get-balance") return ok(Cl.ok(Cl.uint(109_381_108)));
      if (contract === POOL && fn === "get-bin-balances") {
        const id = Number(BigInt(`0x${args[0]!.slice(4)}`));
        const s = id === 499 ? (over.bin499 ?? { x: 28_252_176n, y: 0n, shares: 109_381_108n })
          : over.destEmpty ? { x: 0n, y: 0n, shares: 0n } : { x: 50_000_000n, y: 0n, shares: 2_000_000_000n };
        return ok(Cl.ok(Cl.tuple({ "x-balance": Cl.uint(s.x), "y-balance": Cl.uint(s.y), "bin-shares": Cl.uint(s.shares) })));
      }
      if (contract === CORE && fn === "get-bin-price") return ok(Cl.ok(Cl.uint(25_000_000)));
      return { okay: false };
    };
  }

  async function code(p: Promise<unknown>): Promise<string> {
    try { await p; } catch (e) { if (e instanceof MoveBlocked) return e.code; throw e; }
    return "built";
  }

  test("a clean position plans a deny mode move: shares burned exactly, a maybe-sent receipt per bin touched, fees 0", async () => {
    const plan = await planMove(chain(), POOL, WALLET);
    const i = moveInstruction(WALLET, plan) as { params: Record<string, any> };
    expect(`${i.params.contractAddress}.${i.params.contractName}`).toBe(ROUTER);
    expect(i.params.functionName).toBe("move-liquidity-multi");
    expect(i.params.postConditionMode).toBe("deny");
    const tuples = i.params.functionArgs[0].value.map((t: any) => t.value);
    expect(tuples.length).toBe(5);
    for (const t of tuples) {
      expect(t["pool-trait"].value).toBe(POOL);
      expect(t["x-token-trait"].value).toBe(X);
      expect(t["y-token-trait"].value).toBe(Y);
      expect(t["from-bin-id"]).toEqual({ type: "int", value: "-1" });
      expect(Number(t["to-bin-id"].value)).toBeGreaterThan(-92);
      expect(t["max-x-liquidity-fee"].value).toBe("0");
      expect(t["max-y-liquidity-fee"].value).toBe("0");
      expect(BigInt(t["min-dlp"].value)).toBeGreaterThan(0n);
    }
    const pcs = i.params.postConditions;
    expect(pcs[0]).toEqual({ type: "ft", principal: WALLET, asset: POOL, assetName: "pool-token", conditionCode: "eq", amount: "109381108" });
    expect(pcs.slice(1).map((p: any) => [p.type, p.conditionCode, p.principal, p.value.value["token-id"].value, p.value.value.owner.value]))
      .toEqual([409, 410, 411, 412, 413, 499].map((b) => ["nft", "maybe-sent", WALLET, String(b), WALLET]));
    expect(JSON.stringify(pcs)).not.toContain('"stx"');
  });

  test("an unchecked core, an empty destination, or a bin holding the wrong coin is refused", async () => {
    expect(await code(planMove(chain({ core: "SP000000000000000000002Q6VF78.other-core" }), POOL, WALLET))).toBe("UNREVIEWED_CORE");
    expect(await code(planMove(chain({ destEmpty: true }), POOL, WALLET))).toBe("EMPTY_DESTINATION");
    expect(await code(planMove(chain({ bin499: { x: 28_252_176n, y: 5n, shares: 109_381_108n } }), POOL, WALLET))).toBe("MIXED_BIN");
    // A bin below the price holding the X coin is not a bin a one-sided move can take.
    expect(await code(planMove(chain({ userBins: [400] }), POOL, WALLET))).toBe("MIXED_BIN");
  });
});
