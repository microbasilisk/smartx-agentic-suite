/**
 * The unsigned HODLMM move a wallet holder signs: plan it from the pool contract, with real limits.
 *
 * `move-liquidity-multi` on the DLMM liquidity router moves shares from bins the price has left into
 * bins beside the current price, inside the same pool. It transfers no coin: the core updates the
 * two bins' balances in place, burns the wallet's `pool-token` shares from the old bin and mints new
 * shares in the new one (and burns and re-mints the wallet's `pool-token-id` receipt for each bin it
 * touches). So it can run in deny mode with a condition on the shares burned and a `maybe-sent`
 * condition per receipt, and nothing else.
 *
 * Rules, from reading dlmm-core-v-1-1 `move-liquidity` and a review of the plan (17 September 2026):
 * - Only a position wholly on ONE side of the active bin moves: all bins above (they hold only the X
 *   coin) go to active+1 .. active+5, all bins below (only Y) go to active-5 .. active-1. A bin at the
 *   active bin holds both coins and cannot move; a position that straddles the price is in range.
 * - Never INTO the active bin: the core charges a liquidity fee only there, so both fee limits are 0.
 * - Never into an empty bin (no shares or no value): the core then mints shares by square root and
 *   sends a slice to the burn address, or dilutes into shares that are worth nothing.
 * - `min-dlp` is the shares the core will mint, simulated leg by leg in order, less half a percent;
 *   and each leg must be able to claim back at least 99 percent of the value moved.
 * - At most 10 held bins, so the reads fit Hiro's budget.
 */

import { Cl, ClarityType, cvToHex, hexToCV, type ClarityValue } from "@stacks/transactions";

export const ROUTER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-liquidity-router-v-1-1";
export const MOVE_FUNCTION = "move-liquidity-multi";
export const CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
export const CENTER_BIN_ID = 500;
export const PRICE_SCALE = 100_000_000n;
export const SPREAD = 5;
export const MAX_MOVE_BINS = 10;
/** min-dlp = expected shares x 995 / 1000. */
export const MIN_DLP_KEEP_PER_MILLE = 995n;
/** Each leg must be able to claim back at least this share of the value it moved. */
export const MIN_CLAIM_PER_MILLE = 990n;

export class MoveBlocked extends Error {
  constructor(readonly code: string, message: string, readonly next: string) {
    super(message);
  }
}

export interface BinState {
  x: bigint;
  y: bigint;
  shares: bigint;
}

export interface Leg {
  /** Unsigned bin ids, as the pool contract and the Bitflow API count them. */
  from: number;
  to: number;
  amount: bigint;
}

export interface SimulatedLeg extends Leg {
  x: bigint;
  y: bigint;
  value: bigint;
  dlp: bigint;
  minDlp: bigint;
  /** What the minted shares can claim back from the destination bin right after this leg. */
  claimable: bigint;
}

/** The core's `get-liquidity-value`: X rebased into Y units at the bin price. */
export function liquidityValue(x: bigint, y: bigint, price: bigint): bigint {
  return price * x + y * PRICE_SCALE;
}

/**
 * Run the legs through the core's `move-liquidity` arithmetic in order, for destinations that are
 * never the active bin (no fee) and never empty (no square root branch). Several legs can share a
 * from bin or a to bin; each sees the state the earlier legs left. Throws MoveBlocked when a leg
 * would move nothing, land in an empty bin, or claim back less than 99 percent of what it moved.
 */
export function simulateMove(
  legs: readonly Leg[],
  bins: ReadonlyMap<number, BinState>,
  prices: ReadonlyMap<number, bigint>,
): SimulatedLeg[] {
  const state = new Map<number, BinState>();
  const read = (bin: number): BinState => {
    const s = state.get(bin) ?? bins.get(bin);
    if (!s) throw new MoveBlocked("READ_FAILED", `Bin ${bin} was not read.`, "Try again in a moment.");
    return { ...s };
  };
  const out: SimulatedLeg[] = [];
  for (const leg of legs) {
    const a = read(leg.from);
    if (a.shares === 0n || leg.amount <= 0n || leg.amount > a.shares) {
      throw new MoveBlocked("BAD_LEG", `Bin ${leg.from} does not hold ${leg.amount} shares to move.`, "Read the position again.");
    }
    const x = (leg.amount * a.x) / a.shares;
    const y = (leg.amount * a.y) / a.shares;
    if (x + y === 0n) {
      throw new MoveBlocked("DUST", `Moving ${leg.amount} shares out of bin ${leg.from} moves nothing.`, "Take the position out with a withdraw instead.");
    }
    const price = prices.get(leg.to);
    if (price === undefined || price <= 0n) throw new MoveBlocked("READ_FAILED", `The price of bin ${leg.to} was not read.`, "Try again in a moment.");
    const b = read(leg.to);
    const value = liquidityValue(x, y, price);
    const valueB = liquidityValue(b.x, b.y, price);
    if (b.shares === 0n || valueB === 0n) {
      throw new MoveBlocked("EMPTY_DESTINATION", `Bin ${leg.to} is empty, and SmartX does not move into an empty bin.`, "Try again later.");
    }
    const dlp = (value * b.shares) / valueB;
    if (dlp === 0n) throw new MoveBlocked("DUST", `Bin ${leg.to} would mint no shares for this move.`, "Take the position out with a withdraw instead.");
    const afterA: BinState = { x: a.x - x, y: a.y - y, shares: a.shares - leg.amount };
    const afterB: BinState = { x: b.x + x, y: b.y + y, shares: b.shares + dlp };
    state.set(leg.from, afterA);
    state.set(leg.to, afterB);
    const claimable = (dlp * liquidityValue(afterB.x, afterB.y, price)) / afterB.shares;
    if (claimable * 1000n < value * MIN_CLAIM_PER_MILLE) {
      throw new MoveBlocked(
        "POOR_DESTINATION",
        `Moving into bin ${leg.to} would leave a claim worth less than 99 percent of what moved.`,
        "Try again later.",
      );
    }
    const minDlp = (dlp * MIN_DLP_KEEP_PER_MILLE) / 1000n;
    out.push({ ...leg, x, y, value, dlp, minDlp: minDlp > 0n ? minDlp : 1n, claimable });
  }
  return out;
}

/**
 * Which side the position is on and where it goes, or MoveBlocked. `held` maps each unsigned bin the
 * wallet holds to its shares. Every share of every bin moves, split evenly over the destinations (the
 * remainder to the last), so the whole position recentres.
 */
export function legsFor(held: ReadonlyMap<number, bigint>, activeBin: number): { side: "above" | "below"; legs: Leg[]; to: number[] } {
  const ids = [...held.keys()].sort((a, b) => a - b);
  if (ids.length === 0) throw new MoveBlocked("NO_POSITION", "This wallet holds no shares in this pool.", "Read the wallet's positions first.");
  if (ids.length > MAX_MOVE_BINS) {
    throw new MoveBlocked("TOO_MANY_BINS", `This position is spread over ${ids.length} bins, more than one move takes (${MAX_MOVE_BINS}).`, "Take it out with a withdraw instead.");
  }
  const above = ids.every((b) => b > activeBin);
  const below = ids.every((b) => b < activeBin);
  if (!above && !below) {
    throw new MoveBlocked(
      "COVERS_PRICE",
      "This position already covers the current price, or holds the bin the price is in, so there is nothing to move back into range.",
      "Nothing to do while it is in range.",
    );
  }
  const to = above
    ? Array.from({ length: SPREAD }, (_, i) => activeBin + 1 + i)
    : Array.from({ length: SPREAD }, (_, i) => activeBin - SPREAD + i);
  const legs: Leg[] = [];
  for (const from of ids) {
    const shares = held.get(from)!;
    if (shares <= 0n) continue;
    const n = BigInt(to.length);
    const each = shares / n;
    if (each === 0n) {
      legs.push({ from, to: to[0]!, amount: shares });
      continue;
    }
    to.forEach((dest, i) => legs.push({ from, to: dest, amount: i === to.length - 1 ? shares - each * (n - 1n) : each }));
  }
  if (legs.some((l) => ids.includes(l.to))) {
    throw new MoveBlocked(
      "ALREADY_BESIDE_PRICE",
      "Part of this position already sits in the bins right beside the current price, so a move would gain little.",
      "Nothing to do for now.",
    );
  }
  return { side: above ? "above" : "below", legs, to };
}

// -- Chain reads ------------------------------------------------------------------

export type ReadOnly = (contract: string, fn: string, args: string[]) => Promise<{ okay: boolean; result?: string }>;

async function readCv(read: ReadOnly, contract: string, fn: string, args: ClarityValue[], what: string): Promise<ClarityValue> {
  const r = await read(contract, fn, args.map(cvToHex));
  if (!r.okay || !r.result) throw new MoveBlocked("READ_FAILED", `${what} could not be read (${contract}.${fn}).`, "Try again in a moment.");
  const cv = hexToCV(r.result);
  if (cv.type === ClarityType.ResponseErr) throw new MoveBlocked("READ_FAILED", `${what} returned an error.`, "Try again in a moment.");
  return cv.type === ClarityType.ResponseOk ? cv.value : cv;
}

function uintOf(cv: ClarityValue | undefined, what: string): bigint {
  if (cv?.type !== ClarityType.UInt) throw new MoveBlocked("READ_FAILED", `${what} was not a number.`, "Try again in a moment.");
  return BigInt(cv.value);
}

function tupleOf(cv: ClarityValue, what: string): Record<string, ClarityValue> {
  if (cv.type !== ClarityType.Tuple) throw new MoveBlocked("READ_FAILED", `${what} was not a record.`, "Try again in a moment.");
  return cv.value;
}

function principalOf(cv: ClarityValue | undefined, what: string): string {
  if (cv?.type === ClarityType.PrincipalContract || cv?.type === ClarityType.PrincipalStandard) return cv.value;
  throw new MoveBlocked("READ_FAILED", `${what} was not a principal.`, "Try again in a moment.");
}

export interface PoolFacts {
  pool: string;
  xToken: string;
  yToken: string;
  activeBin: number;
  initialPrice: bigint;
  binStep: bigint;
}

/** The pool's own record, the one the core reads for a move. The core address must be the core this plan simulates. */
export async function readPool(read: ReadOnly, pool: string): Promise<PoolFacts> {
  const t = tupleOf(await readCv(read, pool, "get-pool-for-add", [], "The pool"), "The pool");
  if (principalOf(t["core-address"], "The pool's core") !== CORE) {
    throw new MoveBlocked("UNREVIEWED_CORE", "This pool is managed by a core contract SmartX has not been checked against.", "Update this skill first.");
  }
  const active = t["active-bin-id"];
  if (active?.type !== ClarityType.Int) throw new MoveBlocked("READ_FAILED", "The pool's active bin was not a number.", "Try again in a moment.");
  return {
    pool,
    xToken: principalOf(t["x-token"], "The pool's X coin"),
    yToken: principalOf(t["y-token"], "The pool's Y coin"),
    activeBin: Number(BigInt(active.value)) + CENTER_BIN_ID,
    initialPrice: uintOf(t["initial-price"], "The pool's initial price"),
    binStep: uintOf(t["bin-step"], "The pool's bin step"),
  };
}

/** The wallet's shares per unsigned bin, from the pool contract. */
export async function readHeld(read: ReadOnly, pool: string, wallet: string): Promise<Map<number, bigint>> {
  const list = await readCv(read, pool, "get-user-bins", [Cl.principal(wallet)], "The wallet's bins");
  if (list.type !== ClarityType.List) throw new MoveBlocked("READ_FAILED", "The wallet's bins were not a list.", "Try again in a moment.");
  const ids = list.value.map((v) => Number(uintOf(v, "A bin id")));
  if (ids.length > MAX_MOVE_BINS) {
    throw new MoveBlocked("TOO_MANY_BINS", `This position is spread over ${ids.length} bins, more than one move takes (${MAX_MOVE_BINS}).`, "Take it out with a withdraw instead.");
  }
  const held = new Map<number, bigint>();
  for (const id of ids) {
    const shares = uintOf(await readCv(read, pool, "get-balance", [Cl.uint(id), Cl.principal(wallet)], `Shares in bin ${id}`), `Shares in bin ${id}`);
    if (shares > 0n) held.set(id, shares);
  }
  return held;
}

export async function readBin(read: ReadOnly, pool: string, bin: number): Promise<BinState> {
  const t = tupleOf(await readCv(read, pool, "get-bin-balances", [Cl.uint(bin)], `Bin ${bin}`), `Bin ${bin}`);
  return { x: uintOf(t["x-balance"], `Bin ${bin}`), y: uintOf(t["y-balance"], `Bin ${bin}`), shares: uintOf(t["bin-shares"], `Bin ${bin}`) };
}

export async function readPrice(read: ReadOnly, facts: PoolFacts, bin: number): Promise<bigint> {
  return uintOf(
    await readCv(read, CORE, "get-bin-price", [Cl.uint(facts.initialPrice), Cl.uint(facts.binStep), Cl.int(bin - CENTER_BIN_ID)], `The price of bin ${bin}`),
    `The price of bin ${bin}`,
  );
}

export interface MovePlan {
  facts: PoolFacts;
  side: "above" | "below";
  held: Map<number, bigint>;
  legs: SimulatedLeg[];
}

/** Every read and every check for one pool, or MoveBlocked. */
export async function planMove(read: ReadOnly, pool: string, wallet: string): Promise<MovePlan> {
  const facts = await readPool(read, pool);
  const held = await readHeld(read, pool, wallet);
  const { side, legs } = legsFor(held, facts.activeBin);
  const bins = new Map<number, BinState>();
  const prices = new Map<number, bigint>();
  for (const bin of new Set([...legs.map((l) => l.from), ...legs.map((l) => l.to)])) bins.set(bin, await readBin(read, pool, bin));
  for (const bin of new Set(legs.map((l) => l.to))) prices.set(bin, await readPrice(read, facts, bin));
  // The coin a bin holds must be the side it sits on: above holds only X, below only Y.
  for (const from of held.keys()) {
    const b = bins.get(from)!;
    if ((side === "above" && b.y > 0n) || (side === "below" && b.x > 0n)) {
      throw new MoveBlocked("MIXED_BIN", `Bin ${from} holds both coins, so it cannot move to one side of the price.`, "Try again later.");
    }
  }
  return { facts, side, held, legs: simulateMove(legs, bins, prices) };
}

/** The unsigned transaction: deny mode, the shares burned exactly, a maybe-sent receipt per bin touched. */
export function moveInstruction(wallet: string, plan: MovePlan): Record<string, unknown> {
  const { facts, legs } = plan;
  const burned = legs.reduce((s, l) => s + l.amount, 0n);
  const touched = [...new Set([...legs.map((l) => l.from), ...legs.map((l) => l.to)])].sort((a, b) => a - b);
  const toBins = [...new Set(legs.map((l) => l.to))].sort((a, b) => a - b);
  return {
    tool: "call_contract",
    description: `Move your whole position in ${facts.pool.split(".")[1]} back beside the current price: bins ${toBins[0]} to ${toBins[toBins.length - 1]}`,
    params: {
      contractAddress: ROUTER.split(".")[0],
      contractName: ROUTER.split(".")[1],
      functionName: MOVE_FUNCTION,
      functionArgs: [
        {
          type: "list",
          value: legs.map((l) => ({
            type: "tuple",
            value: {
              "pool-trait": { type: "principal", value: facts.pool },
              "x-token-trait": { type: "principal", value: facts.xToken },
              "y-token-trait": { type: "principal", value: facts.yToken },
              "from-bin-id": { type: "int", value: String(l.from - CENTER_BIN_ID) },
              "to-bin-id": { type: "int", value: String(l.to - CENTER_BIN_ID) },
              amount: { type: "uint", value: l.amount.toString() },
              "min-dlp": { type: "uint", value: l.minDlp.toString() },
              "max-x-liquidity-fee": { type: "uint", value: "0" },
              "max-y-liquidity-fee": { type: "uint", value: "0" },
            },
          })),
        },
      ],
      postConditionMode: "deny",
      postConditions: [
        { type: "ft", principal: wallet, asset: facts.pool, assetName: "pool-token", conditionCode: "eq", amount: burned.toString() },
        ...touched.map((bin) => ({
          type: "nft", principal: wallet, asset: facts.pool, assetName: "pool-token-id", conditionCode: "maybe-sent",
          value: { type: "tuple", value: { "token-id": { type: "uint", value: String(bin) }, owner: { type: "principal", value: wallet } } },
        })),
      ],
    },
  };
}
