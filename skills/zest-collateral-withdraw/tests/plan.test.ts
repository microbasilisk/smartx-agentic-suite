import { describe, expect, test } from "bun:test";
import { Cl, cvToHex, type ClarityValue } from "@stacks/transactions";

import {
  Blocked, REVIEWED_MARKETS, ZEST_ASSETS, ZEST_DEPLOYER, ZEST_MARKET_VAULT,
  readPosition, readWithdrawPlan, withdrawInstruction, type ReadOnly,
} from "../zest-collateral-withdraw.ts";

// The owner's position and the USDCx vault as read on mainnet, 16 September 2026.
const OWNER = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";
const MARKET = `${ZEST_DEPLOYER}.v0-8-market`;
const USDC_VAULT = `${ZEST_DEPLOYER}.v0-vault-usdc`;
const STX_VAULT = `${ZEST_DEPLOYER}.v0-vault-stx`;

interface World {
  impl: string;
  position: ClarityValue | "unreadable";
  marketPaused: boolean;
  vaultPaused: boolean;
  assets: bigint;
  available: bigint;
}

function world(over: Partial<World> = {}): World {
  return {
    impl: MARKET,
    position: Cl.ok(Cl.tuple({
      account: Cl.principal(OWNER),
      collateral: Cl.list([Cl.tuple({ aid: Cl.uint(7), amount: Cl.uint(4987928) })]),
      debt: Cl.list([]),
      id: Cl.uint(1244), "last-borrow-block": Cl.uint(0), "last-update": Cl.uint(1789596153), mask: Cl.uint(128),
    })),
    marketPaused: false,
    vaultPaused: false,
    assets: 5000001n,
    available: 4020685375146n,
    ...over,
  };
}

function reader(w: World, calls: string[] = []): ReadOnly {
  return async (contract, fn) => {
    calls.push(`${contract}.${fn}`);
    const ok = (cv: ClarityValue) => ({ okay: true, result: cvToHex(cv) });
    if (contract === ZEST_MARKET_VAULT && fn === "get-impl") {
      const [a, n] = w.impl.split(".") as [string, string];
      return ok(Cl.contractPrincipal(a, n));
    }
    if (contract === ZEST_MARKET_VAULT && fn === "get-position") {
      return w.position === "unreadable" ? { okay: false, cause: "boom" } : ok(w.position);
    }
    if (contract === ZEST_MARKET_VAULT && fn === "get-pause-states") {
      return ok(Cl.ok(Cl.tuple({ "collateral-add": Cl.bool(false), "collateral-remove": Cl.bool(w.marketPaused), "debt-add": Cl.bool(false), "debt-remove": Cl.bool(false) })));
    }
    if (fn === "get-pause-states") return ok(Cl.ok(Cl.tuple({ deposit: Cl.bool(false), redeem: Cl.bool(w.vaultPaused) })));
    if (fn === "convert-to-assets") return ok(Cl.ok(Cl.uint(w.assets)));
    if (fn === "get-available-assets") return ok(Cl.uint(w.available));
    return { okay: false, cause: `unexpected ${contract}.${fn}` };
  };
}

async function blockedCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Blocked) return e.code;
    throw e;
  }
  return "built";
}

describe("the recorded position plans the owner's withdraw", () => {
  test("all the USDCx shares, redeemed for at least what they are worth now, through the reviewed market", async () => {
    const plan = await readWithdrawPlan(reader(world()), OWNER, "usdcx");
    expect(plan.market).toBe(MARKET);
    expect(plan.shares).toBe(4987928n);
    expect(plan.underlying).toBe(5000001n);
    const i = withdrawInstruction(OWNER, plan) as { params: Record<string, any> };
    expect(i.params.contractAddress).toBe(ZEST_DEPLOYER);
    expect(i.params.contractName).toBe("v0-8-market");
    expect(i.params.functionName).toBe("collateral-remove-redeem");
    expect(i.params.functionArgs).toEqual([
      { type: "principal", value: USDC_VAULT }, { type: "uint", value: "4987928" }, { type: "uint", value: "5000001" },
      { type: "none" }, { type: "none" },
    ]);
    expect(i.params.postConditionMode).toBe("deny");
    expect(i.params.postConditions).toEqual([
      { type: "ft", principal: ZEST_MARKET_VAULT, asset: USDC_VAULT, assetName: "zft", conditionCode: "gte", amount: "4987928" },
      { type: "ft", principal: MARKET, asset: USDC_VAULT, assetName: "zft", conditionCode: "gte", amount: "4987928" },
      { type: "ft", principal: USDC_VAULT, asset: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", assetName: "usdcx-token", conditionCode: "gte", amount: "5000001" },
    ]);
    // Nothing names the wallet: under deny mode nothing may leave it.
    expect(JSON.stringify(i.params.postConditions)).not.toContain(OWNER);
  });

  test("STX pays out as native STX from its vault", async () => {
    const position = Cl.ok(Cl.tuple({ collateral: Cl.list([Cl.tuple({ aid: Cl.uint(1), amount: Cl.uint(900) })]), debt: Cl.list([]) }));
    const plan = await readWithdrawPlan(reader(world({ position, assets: 1000n })), OWNER, "STX");
    const i = withdrawInstruction(OWNER, plan) as { params: Record<string, any> };
    expect(i.params.functionArgs[0]).toEqual({ type: "principal", value: STX_VAULT });
    expect(i.params.postConditions[2]).toEqual({ type: "stx", principal: STX_VAULT, conditionCode: "gte", amount: "1000" });
  });

  test("the asset table matches the chain ids", () => {
    expect(ZEST_ASSETS.map((a) => [a.token, a.shareAid, a.vault.split(".")[1]])).toEqual([
      ["stx", 1, "v0-vault-stx"], ["sbtc", 3, "v0-vault-sbtc"], ["usdcx", 7, "v0-vault-usdc"],
    ]);
    expect(REVIEWED_MARKETS).toEqual([MARKET]);
  });
});

describe("every reason not to build is a refusal, never a guess", () => {
  const cases: Array<[string, Partial<World>, string, string]> = [
    ["an unreviewed market", { impl: `${ZEST_DEPLOYER}.v0-9-market` }, "usdcx", "UNREVIEWED_MARKET"],
    ["the old market", { impl: `${ZEST_DEPLOYER}.v0-4-market` }, "usdcx", "UNREVIEWED_MARKET"],
    ["an unreadable position", { position: "unreadable" }, "usdcx", "READ_FAILED"],
    ["an untracked account", { position: Cl.error(Cl.uint(600006)) }, "usdcx", "NOTHING_TO_WITHDRAW"],
    ["another error from the position read", { position: Cl.error(Cl.uint(600001)) }, "usdcx", "READ_FAILED"],
    ["a coin not held", {}, "sbtc", "NOTHING_TO_WITHDRAW"],
    ["a coin this skill does not build", {}, "usdh", "UNSUPPORTED_ASSET"],
    ["collateral removal paused", { marketPaused: true }, "usdcx", "PAUSED"],
    ["vault redeem paused", { vaultPaused: true }, "usdcx", "PAUSED"],
    ["shares worth nothing", { assets: 0n }, "usdcx", "NOTHING_TO_WITHDRAW"],
    ["too little free in the vault", { available: 5000000n }, "usdcx", "INSUFFICIENT_LIQUIDITY"],
    [
      "any loan",
      {
        position: Cl.ok(Cl.tuple({
          collateral: Cl.list([Cl.tuple({ aid: Cl.uint(7), amount: Cl.uint(4987928) })]),
          debt: Cl.list([Cl.tuple({ aid: Cl.uint(71), scaled: Cl.uint(1) })]),
        })),
      },
      "usdcx", "HAS_LOAN",
    ],
    [
      "a record listing one coin twice",
      {
        position: Cl.ok(Cl.tuple({
          collateral: Cl.list([Cl.tuple({ aid: Cl.uint(7), amount: Cl.uint(1) }), Cl.tuple({ aid: Cl.uint(7), amount: Cl.uint(2) })]),
          debt: Cl.list([]),
        })),
      },
      "usdcx", "READ_FAILED",
    ],
  ];
  for (const [label, over, token, code] of cases) {
    test(label, async () => {
      expect(await blockedCode(readWithdrawPlan(reader(world(over)), OWNER, token))).toBe(code);
    });
  }

  test("exactly the free balance is enough", async () => {
    expect(await blockedCode(readWithdrawPlan(reader(world({ available: 5000001n })), OWNER, "usdcx"))).toBe("built");
  });

  test("the market is checked before the position is read", async () => {
    const calls: string[] = [];
    await blockedCode(readWithdrawPlan(reader(world({ impl: `${ZEST_DEPLOYER}.v0-9-market` }), calls), OWNER, "usdcx"));
    expect(calls).toEqual([`${ZEST_MARKET_VAULT}.get-impl`]);
  });

  test("an untracked account reads as holding nothing", async () => {
    const p = await readPosition(reader(world({ position: Cl.error(Cl.uint(600006)) })), OWNER);
    expect(p).toEqual({ tracked: false, collateral: new Map(), loans: 0 });
  });
});
