#!/usr/bin/env bun

/**
 * Takes a whole Zest V2 collateral position in one coin back to the wallet, as an
 * unsigned transaction for the wallet's owner to sign. This skill never signs.
 *
 * One call, `collateral-remove-redeem` on Zest's current market: the vault shares
 * held as collateral leave the collateral record and are redeemed for the coin in
 * the same transaction.
 *
 * Built only where Zest reads no price. `collateral-remove` resolves prices only
 * for an account that has a loan, and fresh Pyth prices need a paid key, so an
 * account with any loan is refused before building (`price-feeds none`).
 */

import { Command } from "commander";
import { Cl, ClarityType, cvToHex, hexToCV, type ClarityValue } from "@stacks/transactions";

/**
 * The Hiro host. `HIRO_API` wins when set, the name the engine uses, so a runner that points skills
 * at a keyed proxy spends that budget rather than the anonymous 50 reads a minute.
 */
const HIRO_API = process.env.HIRO_API || "https://api.hiro.so";
const FETCH_TIMEOUT_MS = 30_000;

export const ZEST_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
export const ZEST_MARKET_VAULT = `${ZEST_DEPLOYER}.v0-market-vault`;
/**
 * The market contracts this skill has read. `v0-market-vault.get-impl` names the
 * current one; a write through any other aborts with ERR-AUTH, and a market not
 * listed here has not been read, so it is refused rather than assumed to match.
 */
export const REVIEWED_MARKETS: readonly string[] = [`${ZEST_DEPLOYER}.v0-8-market`];
export const WITHDRAW_FUNCTION = "collateral-remove-redeem";
/** `get-position` fails with this for an account Zest has never tracked. */
const ERR_UNTRACKED = 600006n;
const MAX_U128 = (1n << 128n) - 1n;

export interface ZestAsset {
  token: "stx" | "sbtc" | "usdcx";
  symbol: string;
  /** The vault, whose `zft` shares are the collateral. */
  vault: string;
  /** The vault share token's asset id in Zest, the collateral's `aid`. */
  shareAid: number;
  /** The coin's contract and asset name, or null for native STX. */
  underlying: { contract: string; assetName: string } | null;
  decimals: number;
}

export const ZEST_ASSETS: readonly ZestAsset[] = [
  { token: "stx", symbol: "STX", vault: `${ZEST_DEPLOYER}.v0-vault-stx`, shareAid: 1, underlying: null, decimals: 6 },
  {
    token: "sbtc", symbol: "sBTC", vault: `${ZEST_DEPLOYER}.v0-vault-sbtc`, shareAid: 3,
    underlying: { contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", assetName: "sbtc-token" }, decimals: 8,
  },
  {
    token: "usdcx", symbol: "USDCx", vault: `${ZEST_DEPLOYER}.v0-vault-usdc`, shareAid: 7,
    underlying: { contract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", assetName: "usdcx-token" }, decimals: 6,
  },
];

/** A read-only call: contract id, function, hex encoded arguments. */
export type ReadOnly = (contract: string, fn: string, args: string[]) => Promise<{ okay: boolean; result?: string; cause?: string }>;

export class Blocked extends Error {
  constructor(readonly code: string, message: string, readonly next: string) {
    super(message);
  }
}

async function hiroRead(contract: string, fn: string, args: string[]): Promise<{ okay: boolean; result?: string; cause?: string }> {
  const [address, name] = contract.split(".") as [string, string];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${HIRO_API}/v2/contracts/call-read/${address}/${name}/${fn}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender: address, arguments: args }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from Hiro reading ${contract}.${fn}`);
    return (await response.json()) as { okay: boolean; result?: string; cause?: string };
  } finally {
    clearTimeout(timer);
  }
}

/** The decoded value of a read, or a Blocked naming what could not be read. */
async function readValue(read: ReadOnly, contract: string, fn: string, args: ClarityValue[], what: string): Promise<ClarityValue> {
  const r = await read(contract, fn, args.map(cvToHex));
  if (!r.okay || !r.result) throw new Blocked("READ_FAILED", `${what} could not be read (${contract}.${fn}).`, "Try again in a moment.");
  return hexToCV(r.result);
}

/** Unwraps `(ok v)`; a bare value passes through. `(err e)` is Blocked. */
function unwrapOk(cv: ClarityValue, what: string): ClarityValue {
  if (cv.type === ClarityType.ResponseOk) return cv.value;
  if (cv.type === ClarityType.ResponseErr) throw new Blocked("READ_FAILED", `${what} returned an error.`, "Try again in a moment.");
  return cv;
}

function asUint(cv: ClarityValue, what: string): bigint {
  const v = unwrapOk(cv, what);
  if (v.type !== ClarityType.UInt) throw new Blocked("READ_FAILED", `${what} was not a number.`, "Try again in a moment.");
  return BigInt(v.value);
}

function asTuple(cv: ClarityValue, what: string): Record<string, ClarityValue> {
  const v = unwrapOk(cv, what);
  if (v.type !== ClarityType.Tuple) throw new Blocked("READ_FAILED", `${what} was not a record.`, "Try again in a moment.");
  return v.value;
}

function asBool(record: Record<string, ClarityValue>, key: string, what: string): boolean {
  const v = record[key];
  if (v?.type === ClarityType.BoolTrue) return true;
  if (v?.type === ClarityType.BoolFalse) return false;
  throw new Blocked("READ_FAILED", `${what} did not say whether ${key} is paused.`, "Try again in a moment.");
}

/** The market Zest routes writes through today, when it is one this skill has read. */
export async function readReviewedMarket(read: ReadOnly): Promise<string> {
  const impl = await readValue(read, ZEST_MARKET_VAULT, "get-impl", [], "Zest's current market");
  const named = impl.type === ClarityType.PrincipalContract ? impl.value : null;
  const market = REVIEWED_MARKETS.find((m) => m === named);
  if (!market) {
    throw new Blocked(
      "UNREVIEWED_MARKET",
      `Zest routes writes through ${named ?? "a market that could not be read"}, which this skill has not been checked against.`,
      "Update this skill after reading the new market contract.",
    );
  }
  return market;
}

export interface ZestPosition {
  tracked: boolean;
  /** Shares held as collateral, by the share token's asset id. */
  collateral: Map<number, bigint>;
  /** How many coins the account owes. */
  loans: number;
}

/** The account's Zest record. An untracked account holds nothing. */
export async function readPosition(read: ReadOnly, wallet: string): Promise<ZestPosition> {
  const raw = await readValue(read, ZEST_MARKET_VAULT, "get-position", [Cl.principal(wallet), Cl.uint(MAX_U128)], "Zest's record of this account");
  if (raw.type === ClarityType.ResponseErr && raw.value.type === ClarityType.UInt && BigInt(raw.value.value) === ERR_UNTRACKED) {
    return { tracked: false, collateral: new Map(), loans: 0 };
  }
  const position = asTuple(raw, "Zest's record of this account");
  const collateral = position.collateral, debt = position.debt;
  if (collateral?.type !== ClarityType.List || debt?.type !== ClarityType.List) {
    throw new Blocked("READ_FAILED", "Zest's record of this account was not in the expected shape.", "Try again in a moment.");
  }
  const held = new Map<number, bigint>();
  for (const entry of collateral.value) {
    if (entry.type !== ClarityType.Tuple) throw new Blocked("READ_FAILED", "A collateral entry was not in the expected shape.", "Try again in a moment.");
    const aid = entry.value.aid, amount = entry.value.amount;
    if (aid?.type !== ClarityType.UInt || amount?.type !== ClarityType.UInt) {
      throw new Blocked("READ_FAILED", "A collateral entry was not in the expected shape.", "Try again in a moment.");
    }
    const id = Number(aid.value);
    if (held.has(id)) throw new Blocked("READ_FAILED", "Zest's record lists one coin twice.", "Try again in a moment.");
    held.set(id, BigInt(amount.value));
  }
  return { tracked: true, collateral: held, loans: debt.value.length };
}

export function assetFor(token: string): ZestAsset {
  const asset = ZEST_ASSETS.find((a) => a.token === token.toLowerCase());
  if (!asset) {
    throw new Blocked("UNSUPPORTED_ASSET", `This skill withdraws ${ZEST_ASSETS.map((a) => a.symbol).join(", ")} only.`, "Name one of those coins.");
  }
  return asset;
}

export interface WithdrawPlan {
  asset: ZestAsset;
  market: string;
  /** Every vault share the account holds as collateral in this coin. */
  shares: bigint;
  /** What those shares redeem for now. It only grows with interest, so it is the floor. */
  underlying: bigint;
}

/** The reads before a withdraw of the whole position in one coin, or Blocked with the reason. */
export async function readWithdrawPlan(read: ReadOnly, wallet: string, token: string): Promise<WithdrawPlan> {
  const asset = assetFor(token);
  const market = await readReviewedMarket(read);
  const position = await readPosition(read, wallet);
  const shares = position.collateral.get(asset.shareAid) ?? 0n;
  if (shares === 0n) {
    throw new Blocked("NOTHING_TO_WITHDRAW", `This wallet holds no ${asset.symbol} collateral on Zest.`, "Read the wallet's Zest positions first.");
  }
  if (position.loans > 0) {
    throw new Blocked(
      "HAS_LOAN",
      `This Zest account has a loan, so Zest checks fresh prices before letting collateral out, and this skill cannot supply them.`,
      "Repay the loan on Zest first, or withdraw on Zest's own site.",
    );
  }
  const [marketPause, vaultPause, underlying, available] = await Promise.all([
    readValue(read, ZEST_MARKET_VAULT, "get-pause-states", [], "Zest's collateral pause state"),
    readValue(read, asset.vault, "get-pause-states", [], `Zest's ${asset.symbol} vault pause state`),
    readValue(read, asset.vault, "convert-to-assets", [Cl.uint(shares)], `What the ${asset.symbol} shares redeem for`),
    readValue(read, asset.vault, "get-available-assets", [], `The ${asset.symbol} vault's free balance`),
  ]);
  if (asBool(asTuple(marketPause, "Zest's collateral pause state"), "collateral-remove", "Zest's collateral pause state")) {
    throw new Blocked("PAUSED", "Zest has paused taking collateral out.", "Try again once Zest resumes it.");
  }
  if (asBool(asTuple(vaultPause, `Zest's ${asset.symbol} vault pause state`), "redeem", `Zest's ${asset.symbol} vault pause state`)) {
    throw new Blocked("PAUSED", `Zest has paused redeeming from its ${asset.symbol} vault.`, "Try again once Zest resumes it.");
  }
  const out = asUint(underlying, `What the ${asset.symbol} shares redeem for`);
  if (out === 0n) throw new Blocked("NOTHING_TO_WITHDRAW", `These ${asset.symbol} shares redeem for nothing.`, "Nothing to withdraw.");
  const free = asUint(available, `The ${asset.symbol} vault's free balance`);
  if (free < out) {
    throw new Blocked(
      "INSUFFICIENT_LIQUIDITY",
      `Zest's ${asset.symbol} vault has ${free} free and this withdraw needs ${out}: the rest is lent out.`,
      "Try again later, when borrowers have repaid.",
    );
  }
  return { asset, market, shares, underlying: out };
}

function human(amount: bigint, decimals: number): string {
  const whole = amount / 10n ** BigInt(decimals);
  const frac = (amount % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * The unsigned withdraw. Deny mode, and nothing may leave the wallet:
 * - `v0-market-vault` sends at least the shares (collateral out, to the market);
 * - the market sends at least the shares (the vault burns them from the market);
 * - the vault sends at least `underlying` of the coin (to the wallet, the caller).
 * `min-underlying` is the same floor, so the vault itself aborts below it.
 */
export function withdrawInstruction(wallet: string, plan: WithdrawPlan): Record<string, unknown> {
  const { asset, market, shares, underlying } = plan;
  const [contractAddress, contractName] = market.split(".") as [string, string];
  const shareCondition = (principal: string) => ({
    type: "ft", principal, asset: asset.vault, assetName: "zft", conditionCode: "gte", amount: shares.toString(),
  });
  const payout = asset.underlying === null
    ? { type: "stx", principal: asset.vault, conditionCode: "gte", amount: underlying.toString() }
    : { type: "ft", principal: asset.vault, asset: asset.underlying.contract, assetName: asset.underlying.assetName, conditionCode: "gte", amount: underlying.toString() };
  return {
    tool: "call_contract",
    description: `Withdraw all your ${asset.symbol} from Zest: at least ${human(underlying, asset.decimals)} ${asset.symbol} back to your wallet`,
    params: {
      contractAddress,
      contractName,
      functionName: WITHDRAW_FUNCTION,
      functionArgs: [
        { type: "principal", value: asset.vault },
        { type: "uint", value: shares.toString() },
        { type: "uint", value: underlying.toString() },
        // The receiver defaults to the caller, the wallet signing.
        { type: "none" },
        // No price proof: built only for an account with no loan, where Zest reads none.
        { type: "none" },
      ],
      postConditionMode: "deny",
      postConditions: [shareCondition(ZEST_MARKET_VAULT), shareCondition(market), payout],
      delivers: [asset.underlying === null ? "STX" : `${asset.underlying.contract}::${asset.underlying.assetName}`],
    },
  };
}

// -- CLI ---------------------------------------------------------------------

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function report(action: string, error: unknown): void {
  if (error instanceof Blocked) {
    print({ status: "blocked", action, data: {}, error: { code: error.code, message: error.message, next: error.next } });
    return;
  }
  print({ status: "error", action, data: {}, error: { code: "ERROR", message: error instanceof Error ? error.message : String(error), next: "Try again in a moment." } });
  process.exitCode = 1;
}

function requireWallet(wallet: unknown): string {
  if (typeof wallet !== "string" || !/^S[PM][0-9A-HJKMNP-TV-Z]{38,39}$/.test(wallet)) {
    throw new Blocked("BAD_WALLET", "--wallet must be a Stacks mainnet address.", "Pass the wallet's SP address.");
  }
  return wallet;
}

async function runDoctor(opts: { wallet?: string }): Promise<void> {
  try {
    if (opts.wallet !== undefined) requireWallet(opts.wallet);
    const market = await readReviewedMarket(hiroRead);
    const pause = asTuple(await readValue(hiroRead, ZEST_MARKET_VAULT, "get-pause-states", [], "Zest's collateral pause state"), "Zest's collateral pause state");
    print({
      status: "success", action: "doctor", error: null,
      data: { market, function: WITHDRAW_FUNCTION, collateralRemovePaused: asBool(pause, "collateral-remove", "Zest's collateral pause state"), signs: false },
    });
  } catch (error) {
    report("doctor", error);
  }
}

async function runStatus(opts: { wallet?: string }): Promise<void> {
  try {
    const wallet = requireWallet(opts.wallet);
    const position = await readPosition(hiroRead, wallet);
    const held = ZEST_ASSETS.filter((a) => (position.collateral.get(a.shareAid) ?? 0n) > 0n).map((a) => ({
      token: a.token, symbol: a.symbol, vault: a.vault, shares: position.collateral.get(a.shareAid)!,
    }));
    print({
      status: "success", action: "status", error: null,
      data: {
        wallet, tracked: position.tracked, loans: position.loans, collateral: held,
        otherCollateral: [...position.collateral.keys()].filter((aid) => !ZEST_ASSETS.some((a) => a.shareAid === aid)),
        withdrawable: position.loans === 0 ? held.map((h) => h.token) : [],
      },
    });
  } catch (error) {
    report("status", error);
  }
}

async function runPlan(opts: { wallet?: string; asset?: string }): Promise<void> {
  try {
    const wallet = requireWallet(opts.wallet);
    const plan = await readWithdrawPlan(hiroRead, wallet, String(opts.asset ?? ""));
    const instruction = withdrawInstruction(wallet, plan);
    print({
      status: "success", action: "plan", error: null,
      data: {
        wallet, asset: plan.asset.token, market: plan.market, shares: plan.shares, underlying: plan.underlying,
        sizedFrom: "Zest contracts (get-impl, get-position, get-pause-states, convert-to-assets, get-available-assets)",
        safety: {
          postConditionMode: "deny",
          postconditions: [
            `${ZEST_MARKET_VAULT} sends >= ${plan.shares} ${plan.asset.vault}::zft`,
            `${plan.market} sends >= ${plan.shares} ${plan.asset.vault}::zft`,
            `${plan.asset.vault} sends >= ${plan.underlying} ${plan.asset.symbol}`,
          ],
          note: "Nothing may leave the wallet. These are exactly the conditions data.instructions[0] carries.",
        },
        instructions: [instruction],
      },
    });
  } catch (error) {
    report("plan", error);
  }
}

if (import.meta.main) {
  const program = new Command();
  program
    .name("zest-collateral-withdraw")
    .description("Withdraw a whole Zest V2 collateral position in one coin, as an unsigned transaction. Never signs.");
  program.command("doctor").description("Check Zest's current market is one this skill has read").option("--wallet <address>", "Stacks wallet address").action(runDoctor);
  program.command("status").description("The wallet's Zest collateral and whether it can be withdrawn here").requiredOption("--wallet <address>", "Stacks wallet address").action(runStatus);
  program
    .command("plan")
    .description("Size the whole withdraw from Zest's contracts and print it unsigned; never signs or broadcasts")
    .requiredOption("--wallet <address>", "Stacks wallet address")
    .requiredOption("--asset <token>", "stx, sbtc or usdcx")
    .action(runPlan);
  program.parse();
}
