/**
 * A HODLMM pool as it stands at one moment: its price, and the mix of coins its active bin holds.
 *
 * A two coin deposit lands in the active bin, and `dlmm-core-v-1-1` `add-liquidity` (source lines 1590 to
 * 1625) charges a liquidity fee only there, only on the side a deposit holds too much of compared with the
 * bin's own mix. So two different numbers matter to someone about to deposit:
 * - the PRICE says what one coin is worth in the other (`get-bin-price`, `price / 1e8` of Y atomic per X atomic);
 * - the bin's MIX (its X and Y balances) says which pair goes in with no fee. It is often far from the price:
 *   on 17 September dlmm_3's bin held about 52 STX per USDCx while the price was about 4 STX per USDCx.
 * The fee is not an extra transfer: it stays in the bin and the depositor gets fewer shares.
 *
 * Read only. It names no wallet, builds nothing and signs nothing. Every figure comes from a read made in this
 * run; a read that fails is an error, never a stand-in.
 */

import { Cl, cvToHex, hexToCV, type ClarityValue } from "@stacks/transactions";

export const QUOTE_CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
export const QUOTE_CENTER_BIN = 500n;
export const QUOTE_PRICE_SCALE = 100_000_000n;

export interface QuotePool { id: number; contract: string; name: string; tokenX: string; tokenY: string }
export interface QuoteToken { symbol: string; decimals: number }
/** The trait principal the pool records for a token symbol (STX spells it as a wrapper). */
export type TraitFor = (token: string) => string;
export type QuoteRead = (contractId: string, fn: string, args: string[]) => Promise<{ okay: boolean; result?: string }>;

export class QuoteError extends Error {
  constructor(readonly status: "blocked" | "error", message: string) { super(message); }
}

/** `n / 10^places` written out exactly, trailing zeros dropped. */
export function atomicToDecimal(n: bigint, places: number): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const scale = 10n ** BigInt(places);
  const whole = abs / scale;
  const frac = places > 0 ? (abs % scale).toString().padStart(places, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** `num / den` to at most `places` decimal places, rounded down, trailing zeros dropped. */
export function ratioToDecimal(num: bigint, den: bigint, places = 18): string {
  return atomicToDecimal((num * 10n ** BigInt(places)) / den, places);
}

function field(t: Record<string, ClarityValue>, key: string): ClarityValue {
  const v = t[key];
  if (!v) throw new QuoteError("error", `the pool record has no ${key}`);
  return v;
}
function uintOf(v: ClarityValue, what: string): bigint {
  if (v.type !== "uint") throw new QuoteError("error", `${what} was not a number`);
  return BigInt(v.value);
}
function principalOf(v: ClarityValue, what: string): string {
  if (v.type !== "address" && v.type !== "contract") throw new QuoteError("error", `${what} was not a principal`);
  return v.value;
}

async function readOk(read: QuoteRead, contract: string, fn: string, args: string[]): Promise<ClarityValue> {
  let r: { okay: boolean; result?: string };
  try {
    r = await read(contract, fn, args);
  } catch (e) {
    throw new QuoteError("error", `${fn} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!r.okay || !r.result) throw new QuoteError("error", `${fn} could not be read`);
  const cv = hexToCV(r.result);
  if (cv.type === "err") throw new QuoteError("error", `${fn} returned an error`);
  return cv.type === "ok" ? cv.value : cv;
}

export interface PoolQuote {
  pool_id: string;
  pool_name: string;
  coins: { x: string; y: string };
  block_height: number;
  read_at: string;
  active_bin: number;
  price: { raw: string; y_per_x: string; x_per_y: string; says: string };
  active_bin_holds: { x: string; y: string; x_atomic: string; y_atomic: string; shares: string };
  fee_bps: { x: number; y: number };
  fee_free: {
    case: "both" | "only_x" | "only_y" | "empty";
    y_per_one_x: string | null;
    x_per_one_y: string | null;
    says: string;
  };
  notes: string[];
}

/**
 * Read one pool and describe it. `height` is the chain tip read BEFORE the pool, so the quote is never
 * labelled newer than the reads behind it.
 */
export async function quotePool(
  pool: QuotePool,
  tokens: Record<string, QuoteToken>,
  traitFor: TraitFor,
  read: QuoteRead,
  height: number,
  now: Date,
): Promise<PoolQuote> {
  const tx = tokens[pool.tokenX];
  const ty = tokens[pool.tokenY];
  if (!tx || !ty) throw new QuoteError("blocked", `SmartX has no decimals for ${pool.name}'s coins.`);

  const rec = await readOk(read, pool.contract, "get-pool-for-add", []);
  if (rec.type !== "tuple") throw new QuoteError("error", "the pool record was not in the expected shape");
  const t = rec.value;
  if (principalOf(field(t, "core-address"), "core-address") !== QUOTE_CORE) {
    throw new QuoteError("blocked", `${pool.name} is managed by a core contract SmartX has not been checked against.`);
  }
  if (principalOf(field(t, "x-token"), "x-token") !== traitFor(pool.tokenX) || principalOf(field(t, "y-token"), "y-token") !== traitFor(pool.tokenY)) {
    throw new QuoteError("blocked", `${pool.name} no longer holds the coins SmartX lists for it.`);
  }
  const active = field(t, "active-bin-id");
  if (active.type !== "int") throw new QuoteError("error", "active-bin-id was not a number");
  const signed = BigInt(active.value);
  const unsigned = signed + QUOTE_CENTER_BIN;
  const initialPrice = uintOf(field(t, "initial-price"), "initial-price");
  const binStep = uintOf(field(t, "bin-step"), "bin-step");
  const feeX = uintOf(field(t, "x-protocol-fee"), "x-protocol-fee") + uintOf(field(t, "x-provider-fee"), "x-provider-fee") + uintOf(field(t, "x-variable-fee"), "x-variable-fee");
  const feeY = uintOf(field(t, "y-protocol-fee"), "y-protocol-fee") + uintOf(field(t, "y-provider-fee"), "y-provider-fee") + uintOf(field(t, "y-variable-fee"), "y-variable-fee");

  const bal = await readOk(read, pool.contract, "get-bin-balances", [cvToHex(Cl.uint(unsigned))]);
  if (bal.type !== "tuple") throw new QuoteError("error", `bin ${unsigned} was not in the expected shape`);
  const x = uintOf(field(bal.value, "x-balance"), "x-balance");
  const y = uintOf(field(bal.value, "y-balance"), "y-balance");
  const shares = uintOf(field(bal.value, "bin-shares"), "bin-shares");

  const priceCv = await readOk(read, QUOTE_CORE, "get-bin-price", [cvToHex(Cl.uint(initialPrice)), cvToHex(Cl.uint(binStep)), cvToHex(Cl.int(signed))]);
  const price = uintOf(priceCv, "the bin price");
  if (price <= 0n) throw new QuoteError("error", "the bin price was zero");

  // Human Y per X = (price / 1e8) * 10^(dx - dy) = price * 10^dx / (1e8 * 10^dy).
  const pNum = price * 10n ** BigInt(tx.decimals);
  const pDen = QUOTE_PRICE_SCALE * 10n ** BigInt(ty.decimals);
  const yPerX = ratioToDecimal(pNum, pDen);
  const xPerY = ratioToDecimal(pDen, pNum);

  let feeFree: PoolQuote["fee_free"];
  // No shares, or shares with no coins behind them: the core mints by square root and the fee test cannot fire.
  if (shares === 0n || (x === 0n && y === 0n)) {
    feeFree = { case: "empty", y_per_one_x: null, x_per_one_y: null, says: `Bin ${unsigned} holds nothing right now, so no pair pays a liquidity fee there.` };
  } else if (x === 0n || y === 0n) {
    const has = x === 0n ? ty.symbol : tx.symbol;
    const lacks = x === 0n ? tx.symbol : ty.symbol;
    feeFree = {
      case: x === 0n ? "only_y" : "only_x", y_per_one_x: null, x_per_one_y: null,
      says: `Bin ${unsigned} holds only ${has} right now, so almost all of any ${lacks} in a deposit there is unmatched and pays the fee.`,
    };
  } else {
    // Counter per ONE whole unit of each coin, from the bin's own balances, rounded down to the coin's smallest
    // unit. Scaled up by the person, that rounding can leave a few smallest units unmatched: measured on the
    // recorded sBTC pool, at most 0.0000134 percent of the deposit across 1 to 1000 USDCx.
    const yPerOneX = atomicToDecimal((10n ** BigInt(tx.decimals) * y) / x, ty.decimals);
    const xPerOneY = atomicToDecimal((10n ** BigInt(ty.decimals) * x) / y, tx.decimals);
    // A ratio smaller than the coin's smallest unit floors to "0", which would read as "costs nothing". Said as a
    // bound instead: on LEO-STX the true figure is about 0.0000000011 STX for every 1 LEO (Fable's review, part 2).
    const said = (figure: string, coin: QuoteToken) => (figure === "0" ? `under ${atomicToDecimal(1n, coin.decimals)}` : figure);
    feeFree = {
      case: "both", y_per_one_x: yPerOneX, x_per_one_y: xPerOneY,
      says: `A pair matching bin ${unsigned}'s own mix pays no liquidity fee, apart from rounding worth far less than a hundredth of a percent: ${said(xPerOneY, tx)} ${tx.symbol} for every 1 ${ty.symbol}, which is ${said(yPerOneX, ty)} ${ty.symbol} for every 1 ${tx.symbol}.`,
    };
  }

  return {
    pool_id: `dlmm_${pool.id}`,
    pool_name: pool.name,
    coins: { x: tx.symbol, y: ty.symbol },
    block_height: height,
    read_at: now.toISOString(),
    active_bin: Number(unsigned),
    price: { raw: price.toString(), y_per_x: yPerX, x_per_y: xPerY, says: `1 ${tx.symbol} is worth ${yPerX} ${ty.symbol} at the pool's price.` },
    active_bin_holds: {
      x: atomicToDecimal(x, tx.decimals), y: atomicToDecimal(y, ty.decimals),
      x_atomic: x.toString(), y_atomic: y.toString(), shares: shares.toString(),
    },
    fee_bps: { x: Number(feeX), y: Number(feeY) },
    fee_free: feeFree,
    notes: [
      "The price says what a coin is worth. The bin's own mix decides the fee, and the two can be far apart.",
      `The part of a deposit that does not match the mix pays a fee of ${Number(feeX)} basis points when it is ${tx.symbol}, ${Number(feeY)} when it is ${ty.symbol}. The fee stays in the bin: you receive fewer shares, and no extra coins leave your wallet.`,
      "Read at the time above. Coins land in whichever bin is active when the transaction confirms, which can differ.",
    ],
  };
}
