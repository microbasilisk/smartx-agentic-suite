#!/usr/bin/env bun
/**
 * HODLMM Bin Guardian
 * Monitors Bitflow HODLMM bins to keep LP positions in the active earning range.
 *
 * Self-contained: uses Bitflow public HTTP APIs + Hiro Stacks API only.
 *
 * Usage:
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts doctor
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet <STX_ADDRESS>
 *   bun run hodlmm-bin-guardian/hodlmm-bin-guardian.ts run --wallet <STX_ADDRESS> --pool-id dlmm_1
 *
 * Output: strict JSON { status, action, data, error }
 */

import { Command }  from "commander";
import { homedir }  from "os";
import { join }     from "path";
import { readFileSync } from "fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const MIN_24H_VOLUME_USD  = 10_000;
const MAX_SLIPPAGE_PCT    = 0.5;        // 0.5% max price deviation
const MAX_GAS_STX         = 50;         // max spend per rebalance in STX
const COOLDOWN_HOURS      = 4;
const PRICE_SCALE         = 1e8;        // Bitflow bin price scale factor
const FETCH_TIMEOUT_MS    = 30_000;
const STATE_FILE          = join(process.env.HOME ?? homedir(), ".hodlmm-guardian-state.json");

// ── API bases ──────────────────────────────────────────────────────────────────
const BITFLOW_HODLMM_API  = "https://bff.bitflowapis.finance";
const HIRO_API            = "https://api.mainnet.hiro.so";

// ── Types ──────────────────────────────────────────────────────────────────────
interface HodlmmPool {
  pool_id:          string;
  pool_name?:       string;
  pool_symbol?:     string;
  token_x:          string;
  token_y:          string;
  bin_step:         number;
  active_bin:       number;
  x_total_fee_bps?: string;
}

interface HodlmmBin {
  // Numbers here and strings there, from the same endpoint. Typed honestly so
  // the comparison has to convert rather than trusting the shape.
  bin_id:          number | string;
  price?:          string;
  reserve_x?:      string;
  reserve_y?:      string;
  liquidity?:      string;
  // BOTH spellings. Bitflow moved this field to camelCase in April 2026 and the
  // live endpoint returns `userLiquidity`, so reading only the old name parsed
  // every bin as zero: a wallet with 232 bins of liquidity looked empty. That
  // used to surface as a wrong REBALANCE; once "nothing there" became its own
  // answer it would have told a real holder they hold nothing, which is the
  // worse direction. Checked 12 September: hodlmm-position-exit reads both, but
  // hodlmm-emergency-exit and sbtc-capital-allocator still read only the old
  // name, so against today's endpoint they see every bin as zero. Their own fix,
  // not this one's.
  user_liquidity?: string | number;
  userLiquidity?:  string | number;
}

interface AppPoolToken {
  contract:  string;
  priceUsd:  number;
  decimals:  number;
}

interface AppPool {
  poolId:      string;
  tvlUsd:      number;
  volumeUsd1d: number;
  apr24h:      number;
  tokens: {
    tokenX: AppPoolToken;
    tokenY: AppPoolToken;
  };
}

interface AppPoolsResponse { data?: AppPool[] }
interface PoolsResponse    { pools?: HodlmmPool[] }
interface BinsResponse     { bins?: HodlmmBin[]; active_bin_id?: number }
interface UserPositionResponse {
  bins?:          HodlmmBin[];
  position_bins?: HodlmmBin[];
  positions?:     { bins?: HodlmmBin[] };
}

interface GuardianState { last_rebalance_at?: string }

interface CooldownResult {
  ok:                boolean;
  remaining_hours:   number;
  last_rebalance_at: string | null;
}

interface SlippageResult {
  ok:           boolean;
  pct:          number;
  pool_price:   number;
  market_price: number;
  source:       string;
}

interface GasResult {
  ok:            boolean;
  estimated_stx: number;
  limit_stx:     number;
}

interface UserBinRange {
  min:   number;
  max:   number;
  count: number;
  bins:  number[];
}

interface PoolStats {
  volume24hUsd:    number;
  liquidityUsd:    number;
  tokenXPriceUsd:  number;
  tokenXDecimals:  number;
  tokenYDecimals:  number;
  apr24h:          number;
}

// ── State helpers ──────────────────────────────────────────────────────────────
function readState(): GuardianState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as GuardianState;
  } catch {
    return {};
  }
}

function checkCooldown(): CooldownResult {
  const state     = readState();
  if (!state.last_rebalance_at) {
    return { ok: true, remaining_hours: 0, last_rebalance_at: null };
  }
  const elapsed   = (Date.now() - new Date(state.last_rebalance_at).getTime()) / 3_600_000;
  const remaining = Math.max(0, COOLDOWN_HOURS - elapsed);
  return {
    ok:                remaining === 0,
    remaining_hours:   parseFloat(remaining.toFixed(2)),
    last_rebalance_at: state.last_rebalance_at,
  };
}

// ── Fetch helpers ──────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-guardian" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A bin id, or null when the value is not one.
 *
 * Strict on purpose. `Number()` alone accepts things that are not ids and turns
 * them into real bins: `null` and `""` become bin 0, which exists in this pool,
 * and `"0x28d"` becomes 653, which is the active bin. A wrong id is worse than
 * no id, because it silently moves the edges of somebody's position.
 *
 * Strings are accepted because one run printed `"526"` where later probes
 * returned 526, and the payload names more than one data source, so the two
 * spellings can both be real.
 */
function binIdOf(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

async function fetchPools(): Promise<HodlmmPool[]> {
  const data = await fetchJson<PoolsResponse>(`${BITFLOW_HODLMM_API}/api/quotes/v1/pools`);
  return data.pools ?? [];
}

async function fetchPoolBins(poolId: string): Promise<{
  active_bin_id: number;
  priceByBinId:  Map<number, number>;
}> {
  const data = await fetchJson<BinsResponse>(`${BITFLOW_HODLMM_API}/api/quotes/v1/bins/${poolId}`);
  // Through the same strict reader as the user's bins. Keyed by a string id the
  // Map would miss every numeric lookup, the active bin's price would read 0,
  // and every rebalance would be refused for "slippage 100%".
  const priceByBinId = new Map<number, number>(
    (data.bins ?? [])
      .map((b) => [binIdOf(b.bin_id), parseFloat(b.price ?? "0")] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== null)
      .map(([id, price]) => [id, price])
  );
  return { active_bin_id: binIdOf(data.active_bin_id) ?? 0, priceByBinId };
}

async function fetchUserPositionBins(address: string, poolId: string): Promise<HodlmmBin[] | null> {
  const url = `${BITFLOW_HODLMM_API}/api/app/v1/users/${address}/positions/${poolId}/bins`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/hodlmm-bin-guardian" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching user position`);
    const data = await res.json() as UserPositionResponse;
    if (Array.isArray(data?.bins))            return data.bins;
    if (Array.isArray(data?.position_bins))   return data.position_bins;
    if (Array.isArray(data?.positions?.bins)) return data.positions?.bins ?? [];
    throw new Error(
      "the positions endpoint answered in a shape this skill does not recognise, so whether " +
      "this wallet holds anything here is unknown",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch pool stats from Bitflow app API: volume, TVL, APR, token prices, decimals.
 * Uses /api/app/v1/pools which is the HODLMM-native stats endpoint.
 */
async function fetchPoolStats(pool: HodlmmPool): Promise<PoolStats> {
  try {
    const data  = await fetchJson<AppPoolsResponse>(`${BITFLOW_HODLMM_API}/api/app/v1/pools`);
    const match = data.data?.find((p) => p.poolId === pool.pool_id);
    if (!match) return { volume24hUsd: 0, liquidityUsd: 0, tokenXPriceUsd: 0, tokenXDecimals: 8, tokenYDecimals: 6, apr24h: 0 };
    return {
      volume24hUsd:   match.volumeUsd1d,
      liquidityUsd:   match.tvlUsd,
      tokenXPriceUsd: match.tokens.tokenX.priceUsd,
      tokenXDecimals: match.tokens.tokenX.decimals,
      tokenYDecimals: match.tokens.tokenY.decimals,
      apr24h:         match.apr24h,
    };
  } catch {
    return { volume24hUsd: 0, liquidityUsd: 0, tokenXPriceUsd: 0, tokenXDecimals: 8, tokenYDecimals: 6, apr24h: 0 };
  }
}

/**
 * Compare HODLMM active-bin price vs Bitflow app pool token price.
 * Fully Bitflow-native, no external oracles.
 */
function checkSlippage(
  activeBinPrice: number,
  xDecimals:      number,
  yDecimals:      number,
  tokenXPriceUsd: number,
): SlippageResult {
  if (!tokenXPriceUsd) {
    return { ok: true, pct: 0, pool_price: 0, market_price: 0, source: "bitflow-price-unavailable" };
  }

  // HODLMM bin price in USD: (raw / 1e8) * 10^(xDec - yDec)
  const hodlmmPriceUsd = parseFloat(
    ((activeBinPrice / PRICE_SCALE) * Math.pow(10, xDecimals - yDecimals)).toFixed(2)
  );
  const pct = Math.abs(hodlmmPriceUsd - tokenXPriceUsd) / tokenXPriceUsd * 100;

  return {
    ok:           pct <= MAX_SLIPPAGE_PCT,
    pct:          parseFloat(pct.toFixed(4)),
    pool_price:   hodlmmPriceUsd,
    market_price: parseFloat(tokenXPriceUsd.toFixed(2)),
    source:       "bitflow-app-price-vs-hodlmm-active-bin",
  };
}

async function checkGas(): Promise<GasResult> {
  let feeUstx = 0;
  try {
    const raw        = await fetchJson<number>(`${HIRO_API}/v2/fees/transfer`);
    const feePerByte = typeof raw === "number" ? raw : 6;
    // 500 bytes × 2 txns × 3x contract-call multiplier × 1.2 safety buffer
    feeUstx = feePerByte * 500 * 2 * 3 * 1.2;
  } catch {
    feeUstx = 6 * 500 * 2 * 3 * 1.2;
  }
  const estimatedStx = feeUstx / 1_000_000;
  return {
    ok:            estimatedStx <= MAX_GAS_STX,
    estimated_stx: parseFloat(estimatedStx.toFixed(6)),
    limit_stx:     MAX_GAS_STX,
  };
}

// ── Core logic ─────────────────────────────────────────────────────────────────
/**
 * The one line a person reads first, decided in one place.
 *
 * Lifted out of the check so a test can reach it without the network. A wallet
 * holding NO position in the pool used to be told "REBALANCE: position out of
 * range", because a missing position left `inRange` false while every gate
 * passed, and the branch that fires on false-plus-gates-pass is the rebalance
 * one. The detail line underneath said "no position found" at the same time.
 * Seen on a live SmartX wallet holding no HODLMM liquidity, 11 September.
 *
 * The order of the branches IS the rule: whether anything is there at all comes
 * before whether it is in range, which comes before whether a move is allowed.
 */
export function actionLine(a: {
  noPosition:   boolean;
  inRange:      boolean | null;
  canRebalance: boolean;
  positionNote?: string;
  activeBinId:  number;
  apr24h:       number;
  refusals:     readonly string[];
  userBinRange: UserBinRange | null;
}): string {
  if (a.noPosition) {
    return `NO POSITION: ${a.positionNote} Nothing is in or out of range, and there is nothing to rebalance.`;
  }
  if (a.inRange === null) return `CHECK: ${a.positionNote}`;
  if (a.inRange) {
    return `HOLD: position in range at active bin ${a.activeBinId}. APR (24h): ${a.apr24h.toFixed(2)}%.`;
  }
  if (!a.canRebalance) {
    return `HOLD: position out of range but rebalance blocked: ${a.refusals.join("; ")}.`;
  }
  if (a.userBinRange && a.activeBinId >= a.userBinRange.min && a.activeBinId <= a.userBinRange.max) {
    // "Out of range" while quoting a range that contains the active bin reads
    // as a contradiction, and it is the common case: a position spanning
    // hundreds of bins with a gap exactly at the active one. Say the true
    // thing, which is that the bin earning fees right now holds none of their
    // liquidity.
    return `REBALANCE: the active bin ${a.activeBinId} holds none of your liquidity, though your position spans bins ${a.userBinRange.min} to ${a.userBinRange.max} (${a.userBinRange.count} bins, with gaps). Fees accrue only in the active bin. Requires human approval.`;
  }
  return `REBALANCE: position out of range (active bin ${a.activeBinId}${a.userBinRange ? `, position bins ${a.userBinRange.min}-${a.userBinRange.max}` : ""}). Requires human approval.`;
}

/**
 * Exported so a test can drive the WHOLE check with the network stubbed.
 *
 * The headline test reaches `actionLine` only, and a review proved that is not
 * enough: reading the wrong field name for a bin's liquidity made every bin
 * parse as zero, so a wallet holding 232 bins was reported as holding nothing,
 * and all seven headline cases still passed. What that test could not see is
 * the wiring between the endpoint's shape and the decision.
 */
export async function runGuardian(wallet?: string, poolId?: string): Promise<{
  status: "success" | "error";
  action: string;
  data:   Record<string, unknown>;
  error:  { code: string; message: string; next: string } | null;
}> {
  if (wallet && !/^SP[A-Z0-9]{30,}$/.test(wallet)) {
    return {
      status: "error", action: "Validation failed", data: {},
      error:  { code: "INVALID_WALLET", message: "Wallet must be a valid Stacks mainnet address (SP...)", next: "Pass a valid --wallet address" },
    };
  }
  if (poolId && !/^[a-zA-Z0-9_-]+$/.test(poolId)) {
    return {
      status: "error", action: "Validation failed", data: {},
      error:  { code: "INVALID_POOL_ID", message: "pool-id must be alphanumeric (e.g. dlmm_1)", next: "Pass a valid --pool-id" },
    };
  }

  const pools     = await fetchPools();
  const sbtcPools = pools.filter((p) =>
    p.token_x.toLowerCase().includes("sbtc") || p.token_y.toLowerCase().includes("sbtc")
  );

  let pool: HodlmmPool | undefined;
  if (poolId) {
    pool = pools.find((p) => p.pool_id === poolId);
  } else {
    pool = sbtcPools.find((p) => p.pool_id === "dlmm_1") ?? sbtcPools[0];
  }
  if (!pool) {
    return {
      status: "error", action: "Pool not found", data: {},
      error:  { code: "POOL_NOT_FOUND", message: `No pool found for id: ${poolId ?? "default"}`, next: "Run doctor to list available pools" },
    };
  }

  // Fetch bins, pool stats, gas, cooldown in parallel
  const [binsData, poolStats, gasResult, cooldownResult] = await Promise.all([
    fetchPoolBins(pool.pool_id),
    fetchPoolStats(pool),
    checkGas(),
    Promise.resolve(checkCooldown()),
  ]);

  const { active_bin_id, priceByBinId } = binsData;

  // ── In-range check ───────────────────────────────────────────────────────────
  let inRange: boolean | null = null;
  let userBinRange: UserBinRange | null = null;
  let positionNote: string | undefined;
  // "We looked and there is nothing" is not "we could not look", and neither is
  // "out of range". Without this a wallet holding NO position in the pool was
  // told REBALANCE: a missing position set inRange to false, and false with the
  // checks passing is the rebalance branch. Seen on a live SmartX wallet holding
  // no HODLMM liquidity, 11 September.
  let noPosition = false;
  // Three states, not two: they hold something, they hold nothing, or nobody
  // looked. Derived from `noPosition` it could only say two of them, and a read
  // that FAILED would have been reported as holding nothing.
  let hasPosition: boolean | null = null;

  if (wallet) {
    const userBins = await fetchUserPositionBins(wallet, pool.pool_id);
    if (userBins === null) {
      noPosition   = true;
      hasPosition  = false;
      positionNote = `No position found for ${wallet} in pool ${pool.pool_id}.`;
    } else {
      const liquidityOf = (b: HodlmmBin): { known: boolean; amount: number } => {
        const raw = b.userLiquidity ?? b.user_liquidity;
        if (raw === undefined || raw === null) return { known: false, amount: 0 };
        const amount = typeof raw === "number" ? raw : Number(raw);
        return Number.isFinite(amount) ? { known: true, amount } : { known: false, amount: 0 };
      };
      const readable = userBins.map(liquidityOf);
      const anyKnown = readable.some((r) => r.known);
      const activeBins = userBins.filter((_, i) => readable[i]!.known && readable[i]!.amount > 0);
      // Number(), because this endpoint has answered with bin ids as numbers
      // (526) and as strings ("526"). `includes` compares with ===, so a string
      // id can never equal the numeric active bin, and a holder whose bins
      // surround the active one is reported OUT of range: a rebalance alarm on
      // a position that is earning fine. Anything unparseable is dropped rather
      // than becoming NaN, which would silently shrink the range.
      const read     = activeBins.map((b) => binIdOf(b.bin_id));
      const binIds   = read.filter((n): n is number => n !== null).sort((a, z) => a - z);
      const unreadable = read.length - binIds.length;

      if (userBins.length > 0 && !anyKnown) {
        // Not one bin carried a liquidity figure this skill could read. Live
        // data carries `userLiquidity` on every bin even when it is zero, so
        // this is what a renamed or reshaped field looks like, and it must not
        // be reported as an empty wallet.
        hasPosition  = null;
        inRange      = null;
        positionNote = `The pool listed ${userBins.length} ${userBins.length === 1 ? "bin" : "bins"} for this wallet, but none carried a liquidity figure this skill could read, so whether anything is held here is unknown.`;
      } else if (activeBins.length > 0 && unreadable > 0) {
        // Bins with liquidity whose ids we could not read. That is a read that
        // FAILED, and it must not be reported as an empty wallet: the same
        // rename that moved `user_liquidity` to `userLiquidity` could move
        // `bin_id`, and then every holder would be told they hold nothing. Say
        // we could not tell, which is what is true.
        hasPosition  = true;
        inRange      = null;
        positionNote = `This wallet holds liquidity in ${activeBins.length} bins here, but ${unreadable} of their ids could not be read, so whether the active bin is one of them is unknown.`;
      } else if (binIds.length > 0) {
        hasPosition  = true;
        inRange      = binIds.includes(Number(active_bin_id));
        userBinRange = { min: binIds[0], max: binIds[binIds.length - 1], count: binIds.length, bins: binIds };
      } else {
        noPosition   = true;
        hasPosition  = false;
        inRange      = null;
        // What the endpoint actually said, rather than an inference about
        // whether they ever held one.
        positionNote = `The pool lists ${userBins.length} ${userBins.length === 1 ? "bin" : "bins"} for this wallet, all with zero liquidity.`;
      }
    }
  } else {
    positionNote = "No wallet provided: in-range check skipped. Pass --wallet <STX_ADDRESS>.";
  }

  // ── Slippage check ───────────────────────────────────────────────────────────
  const activeBinRawPrice = priceByBinId.get(active_bin_id) ?? 0;
  const slippageResult    = checkSlippage(
    activeBinRawPrice,
    poolStats.tokenXDecimals,
    poolStats.tokenYDecimals,
    poolStats.tokenXPriceUsd,
  );

  // ── Volume / refusal checks ──────────────────────────────────────────────────
  const { volume24hUsd, liquidityUsd, apr24h } = poolStats;
  const volumeOk = isFinite(volume24hUsd) && volume24hUsd >= MIN_24H_VOLUME_USD;

  const refusals: string[] = [];
  if (!volumeOk)          refusals.push(`24h volume $${Math.round(volume24hUsd).toLocaleString()} < $${MIN_24H_VOLUME_USD.toLocaleString()} minimum`);
  if (!slippageResult.ok) refusals.push(`price slippage ${slippageResult.pct.toFixed(2)}% > ${MAX_SLIPPAGE_PCT}% cap`);
  if (!gasResult.ok)      refusals.push(`estimated gas ${gasResult.estimated_stx} STX > ${MAX_GAS_STX} STX limit`);
  if (!cooldownResult.ok) refusals.push(`cooldown: ${cooldownResult.remaining_hours}h remaining (${COOLDOWN_HOURS}h window)`);

  const canRebalance = refusals.length === 0;

  const action = actionLine({
    noPosition, inRange, canRebalance, positionNote,
    activeBinId: active_bin_id, apr24h, refusals, userBinRange,
  });

  return {
    status: "success",
    action,
    data: {
      // A missing position is not an out of range one, in the data either: a
      // reader that trusts this field rather than the sentence would draw the
      // same wrong conclusion the headline used to state. `in_range` answers
      // only when there IS a position, and `has_position` is null when no
      // wallet was given, because then nobody looked.
      in_range:             inRange,
      has_position:         hasPosition,
      active_bin:           active_bin_id,
      user_bin_range:       userBinRange,
      can_rebalance:        canRebalance,
      refusal_reasons:      refusals.length > 0 ? refusals : null,
      slippage_ok:          slippageResult.ok,
      slippage_pct:         slippageResult.pct,
      bin_price_raw:        activeBinRawPrice,
      pool_price_usd:       slippageResult.pool_price || null,
      market_price_usd:     slippageResult.market_price || null,
      slippage_source:      slippageResult.source,
      gas_ok:               gasResult.ok,
      gas_estimated_stx:    gasResult.estimated_stx,
      cooldown_ok:          cooldownResult.ok,
      cooldown_remaining_h: cooldownResult.remaining_hours,
      last_rebalance_at:    cooldownResult.last_rebalance_at,
      volume_ok:            volumeOk,
      volume_24h_usd:       Math.round(volume24hUsd),
      liquidity_usd:        Math.round(liquidityUsd),
      apr_24h_pct:          apr24h,
      pool_id:              pool.pool_id,
      pool_name:            pool.pool_name ?? pool.pool_symbol ?? pool.pool_id,
      fee_bps:              parseFloat(pool.x_total_fee_bps ?? "30"),
      ...(positionNote ? { position_note: positionNote } : {}),
    },
    error: null,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("hodlmm-bin-guardian")
  .description("Monitor Bitflow HODLMM bins and output LP health status")
  .version("2.1.0");

program
  .command("doctor")
  .description("Check all API dependencies for reachability")
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    try {
      const pools    = await fetchPools();
      const sbtcPool = pools.find((p) => p.pool_id === "dlmm_1");
      checks.push({
        name:   "Bitflow HODLMM API",
        ok:     pools.length > 0,
        detail: `${pools.length} pools found${sbtcPool ? `, dlmm_1 active bin: ${sbtcPool.active_bin}` : ""}`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const binsData = await fetchPoolBins("dlmm_1");
      checks.push({
        name:   "Bitflow Bins API (dlmm_1)",
        ok:     binsData.active_bin_id > 0,
        detail: `active_bin_id=${binsData.active_bin_id}, ${binsData.priceByBinId.size} bins`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow Bins API (dlmm_1)", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const data  = await fetchJson<AppPoolsResponse>(`${BITFLOW_HODLMM_API}/api/app/v1/pools`);
      const pool  = data.data?.find((p) => p.poolId === "dlmm_1");
      checks.push({
        name:   "Bitflow App Pools API",
        ok:     (data.data?.length ?? 0) > 0,
        detail: pool
          ? `dlmm_1 TVL: $${pool.tvlUsd.toLocaleString()}, vol_24h: $${Math.round(pool.volumeUsd1d).toLocaleString()}, APR: ${pool.apr24h.toFixed(2)}%`
          : `${data.data?.length ?? 0} pools found`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow App Pools API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const fee = await fetchJson<number>(`${HIRO_API}/v2/fees/transfer`);
      checks.push({
        name:   "Hiro Stacks API (fees)",
        ok:     fee > 0,
        detail: `${fee} µSTX/byte`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Hiro Stacks API (fees)", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    const allOk = checks.every((c) => c.ok);
    console.log(JSON.stringify({
      status:  allOk ? "ok" : "degraded",
      checks,
      message: allOk
        ? "All data sources reachable. Ready to run."
        : "One or more sources failed, output may be incomplete.",
    }, null, 2));
    if (!allOk) process.exit(1);
  });

program
  .command("install-packs")
  .description("No additional packs required: uses public HTTP APIs directly")
  .action(() => {
    console.log(JSON.stringify({
      status:  "ok",
      message: "No packs required. hodlmm-bin-guardian uses Bitflow and Hiro public APIs only.",
      data:    { requires: [] },
    }, null, 2));
  });

program
  .command("run")
  .description("Check HODLMM bin status for a wallet and output recommendation")
  .option("--wallet <address>", "Stacks wallet address (SP...) to check position for")
  .option("--pool-id <id>",     "Specific pool ID to check (default: dlmm_1)")
  .action(async (options: { wallet?: string; poolId?: string }) => {
    try {
      const result = await runGuardian(options.wallet, options.poolId);
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "error") process.exit(1);
    } catch (err: unknown) {
      console.error(JSON.stringify({
        status: "error",
        action: "Guardian run failed",
        data:   {},
        error:  { code: "RUN_ERROR", message: err instanceof Error ? err.message : String(err), next: "Run doctor to diagnose" },
      }, null, 2));
      process.exit(1);
    }
  });

// Only when this file IS the program, never when a test imports it. Without the
// guard, importing the skill ran the command line with the test runner's own
// arguments: the first test written against it printed this skill's usage and
// exited 1, so every case failed without a single assertion running, and a
// mutation "caught" by that failure was caught by nothing at all. The alpha
// engine guards its entry the same way.
if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
