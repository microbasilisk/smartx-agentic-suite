#!/usr/bin/env bun
/**
 * ZBG Yield Scout
 * Scans Zest, Granite, and the HODLMM pools of its pool list for sBTC/STX/USDCx positions.
 * Compares yield, recommends the best safe move, shows sBTC break prices.
 *
 * Read-only, no transactions, no gas, no risk.
 *
 * Usage:
 *   bun run zbg-yield-scout/zbg-yield-scout.ts doctor
 *   bun run zbg-yield-scout/zbg-yield-scout.ts run --wallet <STX_ADDRESS>
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 30_000;
/** The statuses that mean "ask again": throttled, or briefly unavailable. */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Minimum spacing between the START of one Hiro read and the next, the figure
 * stacks-alpha-engine uses: about 14 a second, under Hiro's burst limit.
 *
 * Measured 2026-09-13 on one wallet: reading Zest per coin brought a scan to
 * about 45 Hiro reads, fired together with Granite and HODLMM. Unspaced, 29 of
 * them came back 429 and the retries took the scan from 3.5s to 19s, and it
 * still ended with Zest unknown and Granite's rate unread. Spacing them costs
 * about three seconds and asks once.
 *
 * Module level, and claimed before any await so two callers cannot take the
 * same slot. Safe because a skill is a CLI that runs once and exits.
 */
const REQUEST_GAP_MS = 70;
let nextRequestAt = 0;

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + REQUEST_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
const HIRO_API = "https://api.mainnet.hiro.so";
const TENERO_API = "https://api.tenero.io";
const BITFLOW_API = "https://bff.bitflowapis.finance";

// Granite contracts (SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA)
const GRANITE_STATE = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const GRANITE_IR = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1";
const GRANITE_LIQUIDATOR = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.liquidator-v1";

// HODLMM core + pool contracts
const DLMM_CORE = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const HODLMM_POOLS: HodlmmPoolDef[] = [
  { id: 1, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10", name: "sBTC-USDCx-10bps", tokenX: "sbtc", tokenY: "usdcx" },
  { id: 2, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-1",  name: "sBTC-USDCx-1bps",  tokenX: "sbtc", tokenY: "usdcx" },
  { id: 3, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10",  name: "STX-USDCx-10bps",  tokenX: "stx",  tokenY: "usdcx" },
  { id: 4, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-4",   name: "STX-USDCx-4bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 5, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-1",   name: "STX-USDCx-1bps",   tokenX: "stx",  tokenY: "usdcx" },
  { id: 6, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-1-bps-15",   name: "STX-sBTC-15bps",   tokenX: "stx",  tokenY: "sbtc" },
  { id: 7, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1", name: "aeUSDC-USDCx-1bps", tokenX: "aeusdc", tokenY: "usdcx" },
  { id: 8, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",  name: "USDh-USDCx-1bps",  tokenX: "usdh", tokenY: "usdcx" },
  // Pools 14 to 17 are second and third pools for pairs already listed, with the same coins,
  // coin order and bin step as their twins and an identical contract interface (read from
  // chain 2026-09-16). The version stays in the name, so two pools are never one name.
  // Pools 9 to 13 hold ZEST, stSTX and LEO, coins this skill has no metadata or price for,
  // and are left out on purpose until that is decided (smartx-app docs/LATER.md).
  { id: 14, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-2-bps-10", name: "STX-USDCx-10bps-v2", tokenX: "stx",  tokenY: "usdcx" },
  { id: 15, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-2-bps-15",  name: "STX-sBTC-15bps-v2",  tokenX: "stx",  tokenY: "sbtc" },
  { id: 16, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-3-bps-15",  name: "STX-sBTC-15bps-v3",  tokenX: "stx",  tokenY: "sbtc" },
  { id: 17, contract: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-2-bps-10", name: "sBTC-USDCx-10bps-v2", tokenX: "sbtc", tokenY: "usdcx" },
];

// Token contracts
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_CONTRACT = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

// Zest V2, read on mainnet 2026-09-13. `v0-assets` lists each coin at an even id
// and its vault's share token at the next odd id. A deposit through `v0-4-market`
// moves those shares into `v0-market-vault` as collateral, so the wallet's own
// share balance reads zero for somebody who has supplied. Both places are read.
// This used to read `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.zest-pool-sbtc`, a
// contract that does not exist, so everybody was told they had no Zest position.
const ZEST_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const ZEST_MARKET_VAULT = `${ZEST_DEPLOYER}.v0-market-vault`;
/** `key` names the wallet balance this report holds for the coin, where it holds one. */
export const ZEST_ASSETS: ReadonlyArray<{ symbol: string; shareAid: number; vault: string; decimals: number; key?: keyof WalletBalances }> = [
  { symbol: "STX",      shareAid: 1,  vault: `${ZEST_DEPLOYER}.v0-vault-stx`,      decimals: 6, key: "stx" },
  { symbol: "sBTC",     shareAid: 3,  vault: `${ZEST_DEPLOYER}.v0-vault-sbtc`,     decimals: 8, key: "sbtc" },
  { symbol: "stSTX",    shareAid: 5,  vault: `${ZEST_DEPLOYER}.v0-vault-ststx`,    decimals: 6 },
  { symbol: "USDCx",    shareAid: 7,  vault: `${ZEST_DEPLOYER}.v0-vault-usdc`,     decimals: 6, key: "usdcx" },
  { symbol: "USDh",     shareAid: 9,  vault: `${ZEST_DEPLOYER}.v0-vault-usdh`,     decimals: 8 },
  { symbol: "stSTXbtc", shareAid: 11, vault: `${ZEST_DEPLOYER}.v0-vault-ststxbtc`, decimals: 6 },
];
/** What `v0-market-vault.get-position` returns for an address Zest has never seen: "none", not a failure. */
const ZEST_ERR_NO_ACCOUNT = 600006n;
const MAX_U128 = (1n << 128n) - 1n;

// ── Types ──────────────────────────────────────────────────────────────────────
interface HodlmmPoolDef {
  id: number;
  contract: string;
  name: string;
  tokenX: string;
  tokenY: string;
}

interface TokenBalance {
  amount: number;
  /** Dollar value from a price this run read, 0 for an empty balance, or null when no price was read. */
  usd: number | null;
}

interface WalletBalances {
  sbtc: TokenBalance;
  stx: TokenBalance;
  usdcx: TokenBalance;
}

interface ZestHolding {
  asset: string;
  shares: string;
  amount: number;
  /** Dollar value from a price this run actually read, or null. Never a guessed price. */
  value_usd?: number | null;
}

interface ZestPosition {
  has_position: boolean;
  /**
   * "unknown" when a read failed. Kept apart from "none" because "you have
   * nothing there" and "we could not look" are different answers about somebody's
   * money, and this row used to give the first one for both.
   */
  state: "held" | "none" | "unknown";
  detail: string;
  holdings?: ZestHolding[];
  /** The coins this wallet owes Zest. Supplied coins backing a loan cannot all be withdrawn. */
  debt?: string[];
}

interface GranitePosition {
  has_position: boolean;
  detail: string;
  /** False when any read behind the rate failed, so its 0 is not a measurement and it stays out of the ranking. */
  supply_rate_read?: boolean;
  supply_apy_pct?: number;
  borrow_apr_pct?: number;
  utilization_pct?: number;
  max_ltv_pct?: number;
  liquidation_ltv_pct?: number;
}

interface HodlmmUserPool {
  pool_id: number;
  name: string;
  in_range: boolean;
  active_bin: number;
  user_bins: { min: number; max: number; count: number } | null;
  dlp_shares: string;
  /**
   * The coins the wallet's shares hold, summed bin by bin from the pool contract, in whole
   * tokens. Null when a bin read failed, a token's decimals are unknown, or the position spans
   * more bins than are read, so a partial sum never passes for the whole position.
   */
  holdings: { token_x: string; amount_x: number; token_y: string; amount_y: number } | null;
  /**
   * `holdings` priced only from prices actually read. Null when a needed price or the holdings
   * are missing. It used to be the wallet's share of ALL the pool's shares times the pool's
   * whole TVL, but a HODLMM share only means something inside its own bin: it valued one bin
   * holding about 28 STX at $58.12 on 13 September and $59.19 on 14 September.
   */
  estimated_value_usd: number | null;
}

interface HodlmmPositions {
  has_position: boolean;
  pools: HodlmmUserPool[];
  /**
   * Pools whose position could not be read, so whether the wallet holds anything there is
   * unknown. Never folded into "no position": a pool missing from `pools` for that reason
   * would read as nothing held, and MB would refuse to withdraw from it.
   */
  unread: { pool_id: number; name: string }[];
}

interface YieldOption {
  protocol: string;
  pool: string;
  apy_pct: number;
  /** Null when the capital it is sized on has no dollar value this run. */
  daily_usd: number | null;
  monthly_usd: number | null;
  gas_to_enter_stx: number;
  note: string;
}

interface RankingMeasured {
  /** Protocols whose rates were read this run and are in the ranking. */
  protocols: string[];
  /** How many protocols this report covers. */
  out_of: number;
  /** Rates that could not be read, and so are left out rather than shown as 0%. */
  not_read: string[];
}

interface BestMove {
  recommendation: string;
  /** Null when something in the wallet has no price this run, so no total can be given. */
  idle_capital_usd: number | null;
  opportunity_cost_daily_usd: number | null;
}

interface BreakPrices {
  hodlmm_range_exit_low_usd: number | null;
  hodlmm_range_exit_high_usd: number | null;
  granite_liquidation_usd: number | null;
  current_sbtc_price_usd: number | null;
}

interface ScoutResult {
  status: "ok" | "degraded" | "error";
  wallet: string;
  what_you_have: WalletBalances;
  zbg_positions: {
    zest: ZestPosition;
    granite: GranitePosition;
    hodlmm: HodlmmPositions;
  };
  smart_options: YieldOption[];
  /** Which protocols the ranking above actually measured, so a short list says it is short. */
  ranking_measured: RankingMeasured;
  best_move: BestMove;
  break_prices: BreakPrices;
  data_sources: string[];
  rendered_report: string;
  error: { code: string; message: string } | null;
}

interface TeneroTokenData {
  price_usd: number;
  price?: { current_price: number };
  metrics?: Record<string, number>;
}

interface TeneroTokenResponse {
  statusCode: number;
  data: TeneroTokenData;
}

interface TeneroWalletData {
  rows: Array<{ token_address: string; balance: number; balance_value_usd: number }>;
}

interface TeneroWalletResponse {
  statusCode: number;
  data: TeneroWalletData;
}

interface HiroBalanceResponse {
  stx?: { balance: string };
  balance?: string;
  fungible_tokens?: Record<string, { balance: string }>;
}

interface ClarityReadResult {
  okay: boolean;
  result?: string;
}

interface BitflowPoolData {
  poolId: string;
  /** True only for a pool Bitflow marks active; a paused pool is not offered. */
  poolStatus?: boolean;
  tvlUsd: number;
  volumeUsd1d: number;
  apr24h: number;
}

interface BitflowPoolsResponse {
  data?: BitflowPoolData[];
}

// ── Fetch helper ───────────────────────────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "bff-skills/zbg-yield-scout" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

// ── Clarity hex parsing (big-endian) ───────────────────────────────────────────
function parseUint128Hex(hex: string): bigint {
  // Clarity uint128: 0x01 + 16 bytes big-endian
  // Find the uint prefix and read 16 bytes after it
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // Search for type byte 01 (uint) in response wrapper
  const idx = findTypePrefix(clean, "01");
  if (idx === -1) return 0n;
  const bytes = clean.slice(idx + 2, idx + 34); // 16 bytes = 32 hex chars
  return BigInt("0x" + bytes);
}

function parseInt128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  // int128 type prefix is 00
  const idx = findTypePrefix(clean, "00");
  if (idx === -1) return 0n;
  const bytes = clean.slice(idx + 2, idx + 34);
  const val = BigInt("0x" + bytes);
  // Two's complement for negative
  const maxPositive = (1n << 127n) - 1n;
  return val > maxPositive ? val - (1n << 128n) : val;
}

function findTypePrefix(hex: string, typebyte: string): number {
  // In Clarity response: 0x07 = ok wrapper, then type byte
  // Skip the response wrapper (0x07) and find the value type
  if (hex.startsWith("07")) {
    // ok response: 07 + type + value
    if (hex.substring(2, 4) === typebyte) return 2;
    // ok(some(value)): 07 + 0a (some) + type + value
    if (hex.substring(2, 4) === "0a" && hex.substring(4, 6) === typebyte) return 4;
  }
  // Direct type byte at start (unwrapped response)
  if (hex.substring(0, 2) === typebyte) return 0;
  return -1;
}

// ── Full Clarity value parser (big-endian) ─────────────────────────────────────
interface ClarityParsed {
  value: ClarityValue;
  end: number;
}

type ClarityValue = bigint | boolean | null | string | ClarityValue[] | { [key: string]: ClarityValue } | { _err: ClarityValue };

function parseClarityValue(hex: string, pos = 0): ClarityParsed {
  const type = hex.substring(pos, pos + 2);
  pos += 2;

  switch (type) {
    case "01": { // uint128
      const val = BigInt("0x" + hex.substring(pos, pos + 32));
      return { value: val, end: pos + 32 };
    }
    case "00": { // int128
      const raw = BigInt("0x" + hex.substring(pos, pos + 32));
      const max = (1n << 127n) - 1n;
      return { value: raw > max ? raw - (1n << 128n) : raw, end: pos + 32 };
    }
    case "03": return { value: true, end: pos };
    case "04": return { value: false, end: pos };
    case "09": return { value: null, end: pos };
    case "0a": { // some
      const inner = parseClarityValue(hex, pos);
      return { value: inner.value, end: inner.end };
    }
    case "07": { // ok response
      const inner = parseClarityValue(hex, pos);
      return { value: inner.value, end: inner.end };
    }
    case "08": { // err response
      const inner = parseClarityValue(hex, pos);
      return { value: { _err: inner.value }, end: inner.end };
    }
    case "0c": { // tuple
      const numFields = parseInt(hex.substring(pos, pos + 8), 16);
      pos += 8;
      const obj: Record<string, ClarityValue> = {};
      for (let i = 0; i < numFields; i++) {
        const nameLen = parseInt(hex.substring(pos, pos + 2), 16);
        pos += 2;
        const name = Buffer.from(hex.substring(pos, pos + nameLen * 2), "hex").toString("ascii");
        pos += nameLen * 2;
        const val = parseClarityValue(hex, pos);
        obj[name] = val.value;
        pos = val.end;
      }
      return { value: obj, end: pos };
    }
    case "0b": { // list
      const len = parseInt(hex.substring(pos, pos + 8), 16);
      pos += 8;
      const arr: ClarityValue[] = [];
      for (let i = 0; i < len; i++) {
        const val = parseClarityValue(hex, pos);
        arr.push(val.value);
        pos = val.end;
      }
      return { value: arr, end: pos };
    }
    case "05": { // standard principal
      return { value: `principal:${hex.substring(pos, pos + 42)}`, end: pos + 42 };
    }
    case "06": { // contract principal
      pos += 42; // version + hash160
      const cNameLen = parseInt(hex.substring(pos, pos + 2), 16);
      pos += 2;
      pos += cNameLen * 2;
      return { value: "contract-principal", end: pos };
    }
    case "0d": { // string-ascii
      const len = parseInt(hex.substring(pos, pos + 8), 16);
      pos += 8;
      const str = Buffer.from(hex.substring(pos, pos + len * 2), "hex").toString("ascii");
      return { value: str, end: pos + len * 2 };
    }
    case "0e": { // string-utf8
      const len = parseInt(hex.substring(pos, pos + 8), 16);
      pos += 8;
      const str = Buffer.from(hex.substring(pos, pos + len * 2), "hex").toString("utf8");
      return { value: str, end: pos + len * 2 };
    }
    case "02": { // buffer
      const len = parseInt(hex.substring(pos, pos + 8), 16);
      pos += 8;
      return { value: `0x${hex.substring(pos, pos + len * 2)}`, end: pos + len * 2 };
    }
    default:
      return { value: null, end: pos };
  }
}

function parseClarityHex(hex: string): ClarityValue {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return parseClarityValue(clean).value;
}

function cvGetField(obj: ClarityValue, field: string): ClarityValue | undefined {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && field in obj) {
    return (obj as Record<string, ClarityValue>)[field];
  }
  return undefined;
}

// ── Hiro contract read helper ──────────────────────────────────────────────────
export async function callReadOnly(
  contractId: string,
  functionName: string,
  args: string[] = [],
  sender = "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY",
  fetchImpl: typeof fetch = fetch,
): Promise<ClarityReadResult> {
  const [addr, name] = contractId.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${functionName}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Hiro throttles at 20 reads a second and 50 a minute, and a scan makes 25 to
    // 30 of these reads. A throttled or briefly unavailable read is asked again
    // a few times; any other failure, and one still failing after that, throws, so
    // the caller reports it as unknown, never as a zero.
    for (let attempt = 1; ; attempt++) {
      await waitForSlot();
      const res = await fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "User-Agent": "bff-skills/zbg-yield-scout" },
        body: JSON.stringify({ sender, arguments: args }),
      });
      if (RETRY_STATUSES.has(res.status) && attempt < 4) {
        const after = Number(res.headers.get("retry-after"));
        await new Promise((r) => setTimeout(r, after > 0 ? Math.min(after * 1000, 4000) : 400 * 2 ** (attempt - 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ClarityReadResult;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Clarity value encoders (big-endian)
function cvUint(n: number | bigint): string {
  const hex = BigInt(n).toString(16).padStart(32, "0");
  return "0x01" + hex;
}

// c32check alphabet used by Stacks addresses
const C32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function c32Decode(address: string): { version: number; hash160: string } {
  // Stacks addresses: 'S' prefix + version_char + c32(hash160 + checksum)
  const withoutPrefix = address.slice(1); // strip 'S'
  const version = C32_ALPHABET.indexOf(withoutPrefix[0].toUpperCase());
  const dataChars = withoutPrefix.slice(1);

  let n = 0n;
  for (const c of dataChars) {
    n = n * 32n + BigInt(C32_ALPHABET.indexOf(c.toUpperCase()));
  }
  let hex = n.toString(16);
  // hash160 (20 bytes) + checksum (4 bytes) = 24 bytes = 48 hex chars
  while (hex.length < 48) hex = "0" + hex;

  return { version, hash160: hex.slice(0, 40) };
}

function cvPrincipal(principal: string): string {
  // Standard principal CV: 0x05 + version(1 byte) + hash160(20 bytes)
  const { version, hash160 } = c32Decode(principal);
  return "0x05" + version.toString(16).padStart(2, "0") + hash160;
}

function cvContractPrincipal(contractId: string): string {
  // Contract principal CV: 0x06 + version(1) + hash160(20) + name_len(1) + name_bytes
  const [addr, name] = contractId.split(".");
  const { version, hash160 } = c32Decode(addr);
  const nameHex = Buffer.from(name).toString("hex");
  const nameLen = name.length.toString(16).padStart(2, "0");
  return "0x06" + version.toString(16).padStart(2, "0") + hash160 + nameLen + nameHex;
}

// ── Section 1: What You Have ───────────────────────────────────────────────────
/**
 * A price Tenero returned, or null. Never a typed stand-in: STX used to fall back
 * to $0.216 and sBTC to $0, and both then became dollar figures that looked read.
 */
export function readPrice(data: TeneroTokenData | undefined): number | null {
  const p = data?.price_usd ?? data?.price?.current_price;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/** An amount and its dollar value. An empty balance is worth $0 whatever the price; otherwise no price, no figure. */
export function tokenBalance(amount: number, price: number | null, decimals: number): TokenBalance {
  return { amount: round(amount, decimals), usd: amount === 0 ? 0 : price === null ? null : round(amount * price, 2) };
}

/** Every token's dollar value added up, or null if any held token has none. */
export function walletTotalUsd(balances: WalletBalances): number | null {
  const parts = [balances.sbtc.usd, balances.stx.usd, balances.usdcx.usd];
  return parts.some((v) => v === null) ? null : round(parts.reduce((a: number, v) => a + (v as number), 0), 2);
}

/** The coins that are held but have no dollar value this run, for saying so in words. */
export function unpricedTokens(balances: WalletBalances): string[] {
  return ([["sBTC", balances.sbtc], ["STX", balances.stx], ["USDCx", balances.usdcx]] as const)
    .filter(([, b]) => b.usd === null).map(([name]) => name);
}

type WalletRead = {
  balances: WalletBalances; prices: { sbtc: number | null; stx: number | null; usdcx: number }; sources: string[];
  /** Every fungible token the wallet holds, or null when the balance read failed. */
  fungibleTokens: Record<string, { balance: string }> | null;
};

async function getWalletBalances(wallet: string): Promise<WalletRead> {
  // Fetch balances and prices in parallel
  const [hiroBalance, teneroSbtc, teneroStx] = await Promise.all([
    fetchJson<HiroBalanceResponse>(`${HIRO_API}/extended/v1/address/${wallet}/balances`).catch(() => null),
    fetchJson<TeneroTokenResponse>(`${TENERO_API}/v1/stacks/tokens/${SBTC_CONTRACT}`).catch(() => null),
    fetchJson<TeneroTokenResponse>(`${TENERO_API}/v1/stacks/tokens/stx`).catch(() => null),
  ]);
  return walletFrom(hiroBalance, teneroSbtc, teneroStx);
}

/**
 * The wallet section built from the three answers, null for any that failed. Pure, so
 * a failed price read can be replayed: it must give a coin no dollar value, never a
 * typed price.
 */
export function walletFrom(
  hiroBalance: HiroBalanceResponse | null,
  teneroSbtc: TeneroTokenResponse | null,
  teneroStx: TeneroTokenResponse | null,
): WalletRead {
  const sources: string[] = [];
  if (hiroBalance) sources.push("hiro-balances");
  if (teneroSbtc) sources.push("tenero-sbtc-price");
  if (teneroStx) sources.push("tenero-stx-price");

  // Parse STX balance
  const stxMicro = BigInt(hiroBalance?.stx?.balance ?? hiroBalance?.balance ?? "0");
  const stxAmount = Number(stxMicro) / 1_000_000;

  // Parse sBTC balance: match exact contract, not substring (avoid DLP pool tokens)
  const sbtcKey = Object.keys(hiroBalance?.fungible_tokens ?? {}).find(k =>
    k.startsWith(SBTC_CONTRACT + "::")
  );
  const sbtcSats = BigInt(hiroBalance?.fungible_tokens?.[sbtcKey ?? ""]?.balance ?? "0");
  const sbtcAmount = Number(sbtcSats) / 1e8;

  // Parse USDCx balance: match exact contract
  const usdcxKey = Object.keys(hiroBalance?.fungible_tokens ?? {}).find(k =>
    k.startsWith(USDCX_CONTRACT + "::")
  );
  const usdcxMicro = BigInt(hiroBalance?.fungible_tokens?.[usdcxKey ?? ""]?.balance ?? "0");
  const usdcxAmount = Number(usdcxMicro) / 1_000_000;

  // Prices from Tenero, or null. No price read means no dollar figure.
  const sbtcPrice = readPrice(teneroSbtc?.data);
  const stxPrice = readPrice(teneroStx?.data);
  const usdcxPrice = 1.0; // stablecoin

  return {
    balances: {
      sbtc: tokenBalance(sbtcAmount, sbtcPrice, 8),
      stx: tokenBalance(stxAmount, stxPrice, 6),
      usdcx: tokenBalance(usdcxAmount, usdcxPrice, 6),
    },
    prices: { sbtc: sbtcPrice === null ? null : round(sbtcPrice, 2), stx: stxPrice === null ? null : round(stxPrice, 4), usdcx: usdcxPrice },
    sources,
    // A reply without the token map is not "holds nothing": null, so Zest reads
    // as unknown rather than as a wallet with no shares.
    fungibleTokens: hiroBalance?.fungible_tokens ?? null,
  };
}

// ── Section 2: ZBG Positions ───────────────────────────────────────────────────
export type ReadOnlyCall = (contractId: string, fn: string, args?: string[]) => Promise<ClarityReadResult>;

/** One uint read, or a thrown error naming what could not be read. Never a stand-in zero. */
async function readUint(read: ReadOnlyCall, contractId: string, fn: string, args: string[] = []): Promise<bigint> {
  const r = await read(contractId, fn, args);
  const v = r.okay && r.result ? parseClarityHex(r.result) : undefined;
  if (typeof v !== "bigint") throw new Error(`${contractId.split(".")[1]}.${fn} could not be read`);
  return v;
}

/** Two decimals, except that a real rate under 0.01% keeps two significant figures rather than reading as 0%. */
export function roundRate(pct: number): number {
  return pct === 0 || pct >= 0.01 ? round(pct, 2) : Number(pct.toPrecision(2));
}

/**
 * Zest V2 supply APY in percent, from the vault's own three reads, all basis
 * points and already annual: the borrow rate, times utilization, times the share
 * lenders keep after the vault's fee reserve. Null when a read is out of range.
 * The reserve differs per vault (10% for sBTC and STX, 50% for USDC on
 * 2026-09-13), so it is read, never assumed.
 */
export function zestSupplyApyPct(rateBps: bigint, utilBps: bigint, feeReserveBps: bigint): number | null {
  if (utilBps > 10000n || feeReserveBps > 10000n) return null;
  return (Number(rateBps) / 100) * (Number(utilBps) / 10000) * (Number(10000n - feeReserveBps) / 10000);
}

/** A vault's live supply rate, or null when any of its reads failed. */
export async function readZestSupplyRate(
  vault: string, read: ReadOnlyCall = callReadOnly,
): Promise<{ supply_apy_pct: number; utilization_pct: number } | null> {
  try {
    const [rate, util, fee] = await Promise.all([
      readUint(read, vault, "get-interest-rate"),
      readUint(read, vault, "get-utilization"),
      readUint(read, vault, "get-fee-reserve"),
    ]);
    const apy = zestSupplyApyPct(rate, util, fee);
    return apy === null ? null : { supply_apy_pct: roundRate(apy), utilization_pct: round(Number(util) / 100, 2) };
  } catch {
    return null;
  }
}

/**
 * What the wallet has supplied on Zest V2, per coin, in whole tokens.
 *
 * Shares are read from BOTH places they can sit: collateral in
 * `v0-market-vault` (where a `supply-collateral-add` deposit puts them) and the
 * wallet's own vault share balance. Each coin's shares are then converted by its
 * vault, so interest earned since the deposit is included. Any failed read makes
 * the answer "unknown"; only an untracked account or zero shares everywhere is
 * "none".
 */
export async function readZestPosition(
  wallet: string,
  read: ReadOnlyCall = callReadOnly,
  /**
   * The wallet's fungible token balances from a read the scan already made, or
   * null when that read failed. Omitted, each vault's share balance is read one
   * by one instead.
   */
  walletTokens?: Record<string, { balance: string }> | null,
): Promise<ZestPosition> {
  try {
    if (walletTokens === null) throw new Error("wallet balances could not be read, so Zest shares held in the wallet are unknown");
    // Shares held in the wallet itself are real: the sBTC vault had 582 holders on
    // 2026-09-13, most of them outside the market vault. Taken from the balance
    // read when one is passed, which saves six reads of Hiro's 50 a minute. Parsed
    // before any read starts, so a malformed balance cannot leave one unhandled.
    const fromBalances = walletTokens ? ZEST_ASSETS.map((a) => BigInt(walletTokens[`${a.vault}::zft`]?.balance ?? "0")) : null;
    const [pos, walletShares] = await Promise.all([
      read(ZEST_MARKET_VAULT, "get-position", [cvPrincipal(wallet), cvUint(MAX_U128)]),
      fromBalances
        ? Promise.resolve(fromBalances)
        : Promise.all(ZEST_ASSETS.map((a) => readUint(read, a.vault, "get-balance", [cvPrincipal(wallet)]))),
    ]);
    const shares = new Map<number, bigint>();
    const debt: string[] = [];
    const parsed = pos.okay && pos.result ? parseClarityHex(pos.result) : undefined;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "_err" in parsed) {
      if (parsed._err !== ZEST_ERR_NO_ACCOUNT) throw new Error(`v0-market-vault.get-position returned err ${String(parsed._err)}`);
    } else {
      const collateral = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, ClarityValue>).collateral
        : undefined;
      if (!Array.isArray(collateral)) throw new Error("v0-market-vault.get-position could not be read");
      for (const c of collateral) {
        const row = (c && typeof c === "object" && !Array.isArray(c) ? c : {}) as Record<string, ClarityValue>;
        const aid = row.aid, amount = row.amount;
        if (typeof aid !== "bigint" || typeof amount !== "bigint") throw new Error("v0-market-vault.get-position returned a collateral row that could not be parsed");
        if (!ZEST_ASSETS.some((a) => BigInt(a.shareAid) === aid)) throw new Error(`Zest holds collateral under asset id ${aid}, which this skill does not know`);
        shares.set(Number(aid), (shares.get(Number(aid)) ?? 0n) + amount);
      }
      // Debt is listed by the borrowed COIN's id, the even one below its vault's.
      const debtRows = (parsed as Record<string, ClarityValue>).debt;
      if (!Array.isArray(debtRows)) throw new Error("v0-market-vault.get-position returned no debt list");
      for (const d of debtRows) {
        const row = (d && typeof d === "object" && !Array.isArray(d) ? d : {}) as Record<string, ClarityValue>;
        const aid = row.aid, scaled = row.scaled;
        if (typeof aid !== "bigint" || typeof scaled !== "bigint") throw new Error("v0-market-vault.get-position returned a debt row that could not be parsed");
        if (scaled > 0n) debt.push(ZEST_ASSETS.find((a) => BigInt(a.shareAid - 1) === aid)?.symbol ?? `asset id ${aid}`);
      }
    }
    ZEST_ASSETS.forEach((a, i) => {
      const inWallet = walletShares[i]!;
      if (inWallet > 0n) shares.set(a.shareAid, (shares.get(a.shareAid) ?? 0n) + inWallet);
    });
    const held = ZEST_ASSETS.filter((a) => (shares.get(a.shareAid) ?? 0n) > 0n);
    const underlying = await Promise.all(held.map((a) => readUint(read, a.vault, "convert-to-assets", [cvUint(shares.get(a.shareAid)!)])));
    const holdings = held.map((a, i) => ({
      asset: a.symbol,
      shares: shares.get(a.shareAid)!.toString(),
      amount: Number(underlying[i]!) / 10 ** a.decimals,
    }));
    const loan = debt.join(", ");
    if (holdings.length === 0 && debt.length === 0) return { has_position: false, state: "none", detail: "No supply on Zest v2", holdings: [], debt };
    // A loan with nothing supplied (what a liquidation can leave) is still a
    // position: the wallet owes Zest, and "no position" would hide that.
    if (holdings.length === 0) return { has_position: true, state: "held", holdings, debt, detail: `Nothing supplied on Zest v2, but this wallet owes Zest ${loan}` };
    return {
      has_position: true, state: "held", holdings, debt,
      detail: `Supplied on Zest v2: ${holdings.map((h) => `${h.amount} ${h.asset}`).join(", ")}${debt.length > 0 ? `; a Zest loan in ${loan} stands against it` : ""}`,
    };
  } catch (e: unknown) {
    return {
      has_position: false, state: "unknown",
      detail: `Zest v2 could not be checked (${e instanceof Error ? e.message : String(e)}), so a position there is UNKNOWN, not absent`,
    };
  }
}

/** What a rate pays a day and a month on capital worth `usd`, or nulls when that capital has no dollar value. */
export function earnings(usd: number | null, apyPct: number): { daily_usd: number | null; monthly_usd: number | null } {
  if (usd === null) return { daily_usd: null, monthly_usd: null };
  const daily = (usd * apyPct / 100) / 365;
  return { daily_usd: round(daily, 4), monthly_usd: round(daily * 30, 2) };
}

/**
 * Zest's ranking rows, from rates already read. A rate that could not be read
 * gives no row and is named in `not_read` instead: a 0% row is a claim that
 * lending there pays nothing, and it sorts last by construction.
 */
export function zestOptions(
  balances: WalletBalances,
  rates: ReadonlyArray<{ asset: (typeof ZEST_ASSETS)[number]; rate: { supply_apy_pct: number; utilization_pct: number } | null }>,
): { options: YieldOption[]; not_read: string[]; measured: boolean } {
  const options: YieldOption[] = [];
  const notRead: string[] = [];
  for (const { asset, rate } of rates) {
    if (!rate || !asset.key) {
      notRead.push(`Zest ${asset.symbol} supply rate`);
      continue;
    }
    const { daily_usd, monthly_usd } = earnings(balances[asset.key].usd, rate.supply_apy_pct);
    options.push({
      protocol: "Zest",
      pool: `${asset.symbol} Supply`,
      apy_pct: rate.supply_apy_pct,
      daily_usd,
      monthly_usd,
      gas_to_enter_stx: 0.03,
      note: `Lending, ${rate.utilization_pct}% utilization. Lenders earn only while people borrow.`,
    });
  }
  return { options, not_read: notRead, measured: options.length > 0 };
}

/** Each Zest holding's dollar value where this run has a live price for the coin, else null. */
export function priceZestHoldings(
  position: ZestPosition,
  prices: { sbtc: number | null; stx: number | null; usdcx: number | null },
): ZestPosition {
  if (!position.holdings) return position;
  const price: Record<string, number | null> = { sBTC: prices.sbtc, STX: prices.stx, USDCx: prices.usdcx };
  return {
    ...position,
    holdings: position.holdings.map((h) => {
      const p = price[h.asset] ?? null;
      return { ...h, value_usd: p === null ? null : round(h.amount * p, 2) };
    }),
  };
}

async function getZestPosition(
  wallet: string, walletTokens: Record<string, { balance: string }> | null,
): Promise<{ position: ZestPosition; sources: string[] }> {
  const position = await readZestPosition(wallet, callReadOnly, walletTokens);
  return { position, sources: position.state === "unknown" ? [] : ["zest-v2-position"] };
}

export async function getGranitePosition(wallet: string, read: ReadOnlyCall = callReadOnly): Promise<{ position: GranitePosition; sources: string[] }> {
  const sources: string[] = [];
  const IR_SCALE = 1e12; // Granite IR params are scaled by 1e12
  try {
    // Read Granite supply params, debt params, and interest rate model in parallel
    const [lpResult, debtResult, irResult, userPos] = await Promise.all([
      read(GRANITE_STATE, "get-lp-params", []),
      read(GRANITE_STATE, "get-debt-params", []),
      read(GRANITE_IR, "get-ir-params", []),
      read(GRANITE_STATE, "get-user-position", [cvPrincipal(wallet)]),
    ]);
    sources.push("granite-on-chain");

    let supplyApy = 0;
    let borrowApr = 0;
    let utilization = 0;
    // Whether the fields behind the rate actually parsed. A field that does not
    // parse falls back to 0 below, and that 0 must not be ranked as a measurement.
    let lpParsed = false;
    let irParsed = false;

    // Parse lp-params: { total-assets, total-shares }
    // Parse debt-params: { open-interest, total-debt-shares }
    if (lpResult.okay && lpResult.result && debtResult.okay && debtResult.result) {
      const lp = parseClarityHex(lpResult.result) as Record<string, ClarityValue>;
      const debt = parseClarityHex(debtResult.result) as Record<string, ClarityValue>;

      const totalAssets = typeof lp["total-assets"] === "bigint" ? lp["total-assets"] : 0n;
      const openInterest = typeof debt["open-interest"] === "bigint" ? debt["open-interest"] : 0n;
      lpParsed = typeof lp["total-assets"] === "bigint" && typeof debt["open-interest"] === "bigint";

      if (totalAssets > 0n) {
        utilization = Number((openInterest * 10000n) / totalAssets) / 100;
      }
    }

    // Parse IR params: { base-ir, ir-slope-1, ir-slope-2, utilization-kink }
    if (irResult.okay && irResult.result) {
      const ir = parseClarityHex(irResult.result) as Record<string, ClarityValue>;
      const baseIr = Number(typeof ir["base-ir"] === "bigint" ? ir["base-ir"] : 0n) / IR_SCALE;
      const slope1 = Number(typeof ir["ir-slope-1"] === "bigint" ? ir["ir-slope-1"] : 0n) / IR_SCALE;
      const slope2 = Number(typeof ir["ir-slope-2"] === "bigint" ? ir["ir-slope-2"] : 0n) / IR_SCALE;
      const kink = Number(typeof ir["utilization-kink"] === "bigint" ? ir["utilization-kink"] : 0n) / IR_SCALE;
      irParsed = ["base-ir", "ir-slope-1", "ir-slope-2", "utilization-kink"].every((k) => typeof ir[k] === "bigint");

      // Kinked IR model: rate = base + slope1*(util/kink) if util <= kink
      //                        = base + slope1 + slope2*((util-kink)/(1-kink)) if util > kink
      const util = utilization / 100;
      if (kink > 0) {
        if (util <= kink) {
          borrowApr = (baseIr + slope1 * (util / kink)) * 100;
        } else {
          borrowApr = (baseIr + slope1 + slope2 * ((util - kink) / (1 - kink))) * 100;
        }
      }
      supplyApy = borrowApr * (utilization / 100);
    }

    // Check user position
    let hasPosition = false;
    if (userPos.okay && userPos.result) {
      const parsed = parseClarityHex(userPos.result);
      // If result is a tuple with non-zero shares, user has a position
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const shares = parsed["shares"] ?? parsed["lp-shares"] ?? parsed["supply-shares"];
        hasPosition = typeof shares === "bigint" && shares > 0n;
      }
    }

    return {
      position: {
        has_position: hasPosition,
        detail: hasPosition ? "Active supply position on Granite" : "No supply position on Granite",
        supply_rate_read: lpParsed && irParsed,
        supply_apy_pct: round(supplyApy, 2),
        borrow_apr_pct: round(borrowApr, 2),
        utilization_pct: round(utilization, 2),
        max_ltv_pct: 50,
        liquidation_ltv_pct: 65,
      },
      sources,
    };
  } catch {
    return {
      position: {
        has_position: false,
        detail: "Granite read failed, skipped",
        supply_apy_pct: 0,
        borrow_apr_pct: 0,
        utilization_pct: 0,
        max_ltv_pct: 50,
        liquidation_ltv_pct: 65,
      },
      sources,
    };
  }
}

/** Decimals of the coins HODLMM pools hold, read from each token contract. */
const HODLMM_DECIMALS: Record<string, number> = { stx: 6, sbtc: 8, usdcx: 6, aeusdc: 6, usdh: 8 };

/**
 * The most bins one position is valued across. Beyond it the value is unknown, never partial.
 *
 * Sized to Hiro's budget, not to positions: 50 reads a minute without a key, and each bin costs
 * two. A whole scan of a wallet with no positions made 24 Hiro requests on 14 September (23 of
 * them contract reads), so one position at 8 bins adds 18 and stays under 50. Review measured 20
 * bins at about 65, enough for Hiro to refuse the bin reads and the Zest rate reads after them.
 */
export const MAX_VALUED_BINS = 8;

/**
 * What a wallet's HODLMM shares hold, read bin by bin from the pool contract.
 *
 * For each bin the wallet is in: its shares (`get-balance`) over the bin's shares, times the
 * coins the bin holds (`get-bin-balances`). Integer arithmetic throughout, so no rounding
 * reaches the amount before the final conversion to whole tokens. Measured on 14 September:
 * the owner's wallet holds 109,381,108 of bin 499's 83,707,709,320 shares, and the bin holds
 * 21,620.96 STX and no USDCx, so the position is 28.25 STX.
 */
export async function readHodlmmHoldings(
  pool: { contract: string; tokenX: string; tokenY: string },
  wallet: string,
  binIds: number[],
  read: ReadOnlyCall,
): Promise<HodlmmUserPool["holdings"]> {
  const dx = HODLMM_DECIMALS[pool.tokenX];
  const dy = HODLMM_DECIMALS[pool.tokenY];
  if (dx === undefined || dy === undefined || binIds.length === 0 || binIds.length > MAX_VALUED_BINS) return null;
  let x = 0n;
  let y = 0n;
  for (const bin of binIds) {
    // A read that throws (Hiro still refusing after its retries) leaves the holdings unknown.
    // It must not escape: the caller's per-pool catch would drop the whole position, the wallet
    // would read as holding no HODLMM at all, and MB would refuse to withdraw from that pool.
    let balance: Awaited<ReturnType<ReadOnlyCall>>;
    let binRead: Awaited<ReturnType<ReadOnlyCall>>;
    try {
      [balance, binRead] = await Promise.all([
        read(pool.contract, "get-balance", [cvUint(bin), cvPrincipal(wallet)]),
        read(pool.contract, "get-bin-balances", [cvUint(bin)]),
      ]);
    } catch {
      return null;
    }
    if (!balance.okay || !balance.result || !binRead.okay || !binRead.result) return null;
    const shares = parseClarityHex(balance.result);
    const tuple = parseClarityHex(binRead.result);
    const field = (k: string) => cvGetField(tuple, k);
    const binShares = field("bin-shares");
    const xBalance = field("x-balance");
    const yBalance = field("y-balance");
    if (typeof shares !== "bigint" || typeof binShares !== "bigint" || typeof xBalance !== "bigint"
      || typeof yBalance !== "bigint" || binShares <= 0n) return null;
    x += (xBalance * shares) / binShares;
    y += (yBalance * shares) / binShares;
  }
  return {
    token_x: pool.tokenX, amount_x: round(Number(x) / 10 ** dx, dx),
    token_y: pool.tokenY, amount_y: round(Number(y) / 10 ** dy, dy),
  };
}

/**
 * Price each position's holdings from prices that were actually read. Stablecoins are passed
 * in at $1 by both callers, the same way both skills price wallet balances.
 *
 * A side holding nothing needs no price. A side holding something with no price read leaves
 * the value null: a guessed price would put a confident wrong figure in front of the person,
 * which is how the old pool-share estimate came to say $58 for a $7.60 position.
 */
export function priceHodlmmHoldings(positions: HodlmmPositions, prices: Record<string, number | null>): HodlmmPositions {
  return {
    ...positions,
    pools: positions.pools.map((p) => {
      const h = p.holdings;
      if (!h) return { ...p, estimated_value_usd: null };
      const side = (amount: number, token: string): number | null => {
        if (amount === 0) return 0;
        const price = prices[token];
        return typeof price === "number" && price > 0 ? amount * price : null;
      };
      const xUsd = side(h.amount_x, h.token_x);
      const yUsd = side(h.amount_y, h.token_y);
      return { ...p, estimated_value_usd: xUsd === null || yUsd === null ? null : round(xUsd + yUsd, 2) };
    }),
  };
}

export async function getHodlmmPositions(
  wallet: string,
  read: ReadOnlyCall = (contractId, fn, args) => callReadOnly(contractId, fn, args, wallet),
): Promise<{ positions: HodlmmPositions; sources: string[] }> {
  const sources: string[] = [];
  const userPools: HodlmmUserPool[] = [];
  const unread: HodlmmPositions["unread"] = [];

  for (const pool of HODLMM_POOLS) {
    try {
      // The wallet's shares first. Most wallets hold nothing in most pools, and the other
      // reads used to be made and thrown away for every such pool, against Hiro's 50 a minute.
      // Only a zero that was READ skips the pool. Measured 14 September, a wallet with no
      // position gets `(ok u0)` from all 8 pools, so a failed read is not a zero: the position
      // there is unknown, and the pool is named as unread rather than dropped.
      const overallResult = await read(pool.contract, "get-overall-balance", [cvPrincipal(wallet)]);
      if (!overallResult.okay || !overallResult.result) {
        unread.push({ pool_id: pool.id, name: pool.name });
        continue;
      }
      const dlpShares = parseUint128Hex(overallResult.result);
      if (dlpShares === 0n) continue;

      const [userBinsResult, activeBinResult] = await Promise.all([
        read(pool.contract, "get-user-bins", [cvPrincipal(wallet)]),
        read(pool.contract, "get-active-bin-id", []),
      ]);
      // Shares are held here, so a failed bin list leaves the position unknown too. So does a
      // failed active bin, which used to fall back to bin 500 and could call the position out
      // of range on a read that never came back.
      if (!userBinsResult.okay || !activeBinResult.okay || !activeBinResult.result) {
        unread.push({ pool_id: pool.id, name: pool.name });
        continue;
      }

      const activeBinSigned = parseInt128Hex(activeBinResult.result);
      // Convert signed to unsigned: CENTER_BIN_ID (500) + signed offset
      const activeBin = 500 + Number(activeBinSigned);

      const userBinIds = parseUserBinList(userBinsResult.result ?? "");
      const minBin = userBinIds.length > 0 ? Math.min(...userBinIds) : 0;
      const maxBin = userBinIds.length > 0 ? Math.max(...userBinIds) : 0;
      const inRange = userBinIds.includes(activeBin);

      // What the shares hold, bin by bin. Priced by the caller once prices are read.
      const holdings = await readHodlmmHoldings(pool, wallet, userBinIds, read);

      sources.push(`hodlmm-pool-${pool.id}`);

      userPools.push({
        pool_id: pool.id,
        name: pool.name,
        in_range: inRange,
        active_bin: activeBin,
        user_bins: userBinIds.length > 0 ? { min: minBin, max: maxBin, count: userBinIds.length } : null,
        dlp_shares: dlpShares.toString(),
        holdings,
        estimated_value_usd: null,
      });
    } catch {
      // A read that threw (Hiro still refusing after its retries): unknown, never "no position".
      unread.push({ pool_id: pool.id, name: pool.name });
    }
  }

  return {
    positions: {
      has_position: userPools.length > 0,
      pools: userPools,
      unread,
    },
    sources,
  };
}

function parseUserBinList(hex: string): number[] {
  // Response: 0x07 (ok) + 0x0b (list) + 4-byte length + items
  // Each item: 0x01 (uint) + 16 bytes big-endian
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bins: number[] = [];

  // Find list marker (0b) after ok wrapper (07)
  let pos = 0;
  if (clean.startsWith("07")) pos = 2;
  if (clean.substring(pos, pos + 2) !== "0b") return bins;
  pos += 2;

  // Read 4-byte list length
  const listLen = parseInt(clean.substring(pos, pos + 8), 16);
  pos += 8;

  for (let i = 0; i < listLen; i++) {
    if (pos + 34 > clean.length) break;
    const typeByte = clean.substring(pos, pos + 2);
    if (typeByte !== "01") { pos += 34; continue; } // skip non-uint
    pos += 2;
    const valHex = clean.substring(pos, pos + 32);
    const val = Number(BigInt("0x" + valHex));
    bins.push(val);
    pos += 32;
  }

  return bins;
}

// ── Section 3: Smart Options ───────────────────────────────────────────────────
async function getSmartOptions(
  balances: WalletBalances,
  granite: GranitePosition,
): Promise<{ options: YieldOption[]; sources: string[]; ranking: RankingMeasured }> {
  const sources: string[] = [];
  const options: YieldOption[] = [];
  const measured: string[] = [];
  const notRead: string[] = [];

  // Granite supply APY. A rate whose reads failed is left out, never ranked as 0%.
  if (granite.supply_rate_read) measured.push("Granite");
  else notRead.push("Granite supply rate");
  if (granite.supply_rate_read && granite.supply_apy_pct && granite.supply_apy_pct > 0) {
    options.push({
      protocol: "Granite",
      pool: "sBTC Supply",
      apy_pct: granite.supply_apy_pct,
      ...earnings(balances.sbtc.usd, granite.supply_apy_pct),
      gas_to_enter_stx: 0.05,
      note: `Lending yield, ${granite.utilization_pct}% utilization, borrow APR ${granite.borrow_apr_pct}%. Max LTV ${granite.max_ltv_pct}%.`,
    });
    sources.push("granite-apy");
  }

  // HODLMM APR from Bitflow API
  try {
    const poolData = await fetchJson<BitflowPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
    if (poolData.data) {
      sources.push("bitflow-hodlmm-apr");
      for (const bp of poolData.data) {
        // A pool Bitflow does not mark active (paused, or no status) is not offered.
        if (bp.apr24h > 0 && bp.poolStatus === true) {
          const poolDef = HODLMM_POOLS.find(p => `dlmm_${p.id}` === bp.poolId);
          const isRelevant = poolDef && (
            poolDef.tokenX === "sbtc" || poolDef.tokenY === "sbtc" ||
            poolDef.tokenX === "stx" || poolDef.tokenY === "stx"
          );
          if (isRelevant) {
            const capital = poolDef.tokenX === "sbtc" || poolDef.tokenY === "sbtc"
              ? balances.sbtc.usd
              : balances.stx.usd;
            options.push({
              protocol: "HODLMM",
              pool: poolDef.name,
              apy_pct: round(bp.apr24h, 2),
              ...earnings(capital, bp.apr24h),
              gas_to_enter_stx: 0.05,
              note: `Fee-based yield, varies with swap volume. TVL: $${Math.round(bp.tvlUsd).toLocaleString()}.`,
            });
          }
        }
      }
    }
  } catch {
    // Bitflow API unavailable
  }
  if (sources.includes("bitflow-hodlmm-apr")) measured.push("HODLMM");
  else notRead.push("HODLMM pool rates");

  // Zest supply, for the coins this report holds balances of. Each vault's rate is
  // read live, and one that could not be read is left out rather than listed as
  // 0%. This used to be a typed 0% with a note sending people to zest.fi, which
  // put Zest last in every ranking whatever it paid.
  const zestRates = await Promise.all(
    ZEST_ASSETS.filter((a) => a.key).map(async (asset) => ({ asset, rate: await readZestSupplyRate(asset.vault) })),
  );
  const zest = zestOptions(balances, zestRates);
  options.push(...zest.options);
  notRead.push(...zest.not_read);
  if (zest.measured) {
    sources.push("zest-apy-live");
    measured.push("Zest");
  }

  // Sort by APY descending
  options.sort((a, b) => b.apy_pct - a.apy_pct);

  return { options, sources, ranking: { protocols: measured, out_of: 3, not_read: notRead } };
}

// ── Section 4: Best Move ───────────────────────────────────────────────────────
export function getBestMove(
  balances: WalletBalances,
  zest: ZestPosition,
  granite: GranitePosition,
  hodlmm: HodlmmPositions,
  options: YieldOption[],
  ranking: RankingMeasured,
): BestMove {
  const walletUsd = walletTotalUsd(balances);
  const bestOption = options[0];
  // A wallet with a coin that has no price this run is never given a dollar total,
  // and never called "minimal": that would be a figure built on a guess.
  const unpriced = unpricedTokens(balances);
  const unvalued = walletUsd === null
    ? ` No price could be read for ${unpriced.join(" or ")}, so what is in the wallet is not valued.`
    : "";
  const dailyCostOf = (apyPct: number): number | null => walletUsd === null ? null : round((walletUsd * apyPct / 100) / 365, 4);

  // What this sentence could not see, said inside it: the recommendation is the
  // one line a person acts on, so it must not read as complete when a position
  // or a rate was missing from the run behind it.
  const zestUnknown = zest.state === "unknown" ? " Zest could not be checked, so any Zest position is not counted here." : "";
  const hodlmmUnread = (hodlmm.unread ?? []).map(p => p.name);
  const hodlmmUnknown = hodlmmUnread.length > 0
    ? ` HODLMM ${hodlmmUnread.join(", ")} could not be read, so any position there is not counted here.`
    : "";
  const partial = ranking.not_read.length > 0
    ? ` Some rates could not be read (${ranking.not_read.join(", ")}), so a better option may be missing.`
    : "";

  // Count deployed capital
  const deployedProtocols: string[] = [];
  // A Zest loan is named where Zest is: "earning" is not a fair word for supply
  // with a loan accruing against it, and a loan with nothing supplied earns nothing.
  const zestLoan = (zest.debt ?? []).join(", ");
  if (zest.has_position) {
    deployedProtocols.push(!zestLoan ? "Zest"
      : (zest.holdings ?? []).length > 0 ? `Zest (a loan in ${zestLoan} stands against it)`
      : `Zest (nothing supplied, a loan in ${zestLoan} is owed)`);
  }
  if (granite.has_position) deployedProtocols.push("Granite");

  const inRangePools = hodlmm.pools.filter(p => p.in_range);
  const outOfRangePools = hodlmm.pools.filter(p => !p.in_range);
  if (inRangePools.length > 0) deployedProtocols.push(`HODLMM (${inRangePools.length} pool${inRangePools.length > 1 ? "s" : ""} in range)`);

  if (!bestOption || bestOption.apy_pct === 0) {
    return {
      recommendation: `No yield opportunities currently available. Hold your assets in wallet.${unvalued}${zestUnknown}${hodlmmUnknown}${partial}`,
      idle_capital_usd: walletUsd,
      opportunity_cost_daily_usd: 0,
    };
  }

  // Priority 1: Warn about out-of-range positions
  if (outOfRangePools.length > 0) {
    const poolNames = outOfRangePools.map(p => p.name).join(", ");
    return {
      recommendation: `WARNING: ${outOfRangePools.length} HODLMM position(s) OUT OF RANGE (${poolNames}). These are not earning fees. Consider rebalancing or withdrawing.${unvalued}${zestUnknown}${hodlmmUnknown}${partial}`,
      idle_capital_usd: walletUsd,
      opportunity_cost_daily_usd: bestOption.daily_usd,
    };
  }

  // Priority 2: Capital is deployed and working
  if (deployedProtocols.length > 0) {
    const deployed = deployedProtocols.join(", ");
    if (walletUsd === null) {
      return {
        recommendation: `Your capital is ${zestLoan ? "deployed on" : "deployed and earning on"} ${deployed}.${unvalued} Best option for anything idle: ${bestOption.protocol} ${bestOption.pool} at ${bestOption.apy_pct}% APY.${zestUnknown}${hodlmmUnknown}${partial}`,
        idle_capital_usd: null,
        opportunity_cost_daily_usd: null,
      };
    }
    if (walletUsd < 10) {
      return {
        recommendation: `Your capital is ${zestLoan ? "deployed on" : "deployed and earning on"} ${deployed}. Wallet balance ($${walletUsd}) is minimal: nothing to move.${zestUnknown}${hodlmmUnknown}`,
        idle_capital_usd: walletUsd,
        opportunity_cost_daily_usd: 0,
      };
    }
    // Has deployed positions but also meaningful wallet balance
    const dailyCost = dailyCostOf(bestOption.apy_pct) as number;
    return {
      recommendation: `Active position on ${deployed}. You also have $${walletUsd} idle in wallet. Best option for idle funds: ${bestOption.protocol} ${bestOption.pool} at ${bestOption.apy_pct}% APY (~$${dailyCost}/day missed).${zestUnknown}${hodlmmUnknown}${partial}`,
      idle_capital_usd: walletUsd,
      opportunity_cost_daily_usd: dailyCost,
    };
  }

  // Priority 3: Nothing deployed anywhere that could be seen
  const dailyCost = dailyCostOf(bestOption.apy_pct);
  // "No active positions" is a claim about every protocol, so it is made only when each was read.
  // With no wallet value, the sentence naming the unpriced coin (`unvalued`) says it once, below.
  const inWallet = walletUsd === null ? "" : ` $${walletUsd} is in the wallet.`;
  const opening = zestUnknown
    ? `No active positions found on Granite or HODLMM, and Zest could not be checked.${inWallet}`
    : hodlmmUnknown
    ? `No active positions found in what could be read.${inWallet}`
    : walletUsd === null
    ? "No active positions. Everything is idle in the wallet."
    : `No active positions. All $${walletUsd} is idle in wallet.`;
  const missed = dailyCost === null ? "" : ` You're leaving ~$${dailyCost}/day on the table.`;
  return {
    recommendation: `${opening} Best option: ${bestOption.protocol} ${bestOption.pool} at ${bestOption.apy_pct}% APY.${missed}${unvalued}${hodlmmUnknown}${partial}`,
    idle_capital_usd: walletUsd,
    opportunity_cost_daily_usd: dailyCost,
  };
}

// ── Section 5: Break Prices ────────────────────────────────────────────────────
async function getBreakPrices(
  hodlmm: HodlmmPositions,
  granite: GranitePosition,
  sbtcPrice: number | null,
): Promise<{ breakPrices: BreakPrices; sources: string[] }> {
  const sources: string[] = [];
  let rangeLow: number | null = null;
  let rangeHigh: number | null = null;
  let graniteLiq: number | null = null;

  // HODLMM break prices from bin range
  const sbtcPool = hodlmm.pools.find(p => p.name.includes("sBTC"));
  if (sbtcPool && sbtcPool.user_bins) {
    try {
      // Get pool initial price and bin step
      const poolContract = HODLMM_POOLS.find(p => p.id === sbtcPool.pool_id)?.contract;
      if (poolContract) {
        const poolData = await callReadOnly(poolContract, "get-pool", []);
        if (poolData.okay && poolData.result) {
          const poolParsed = parseClarityHex(poolData.result) as Record<string, ClarityValue>;

          const initialPrice = typeof poolParsed["initial-price"] === "bigint" ? poolParsed["initial-price"] : 0n;
          const binStep = typeof poolParsed["bin-step"] === "bigint" ? poolParsed["bin-step"] : 0n;

          if (initialPrice > 0n && binStep > 0n) {
            // Get bin prices at range edges
            const lowBinSigned = sbtcPool.user_bins.min - 500; // Convert to signed
            const highBinSigned = sbtcPool.user_bins.max - 500;

            const [lowPriceResult, highPriceResult] = await Promise.all([
              callReadOnly(DLMM_CORE, "get-bin-price", [
                cvUint(initialPrice),
                cvUint(binStep),
                `0x00${BigInt(lowBinSigned >= 0 ? lowBinSigned : (1n << 128n) + BigInt(lowBinSigned)).toString(16).padStart(32, "0")}`,
              ]),
              callReadOnly(DLMM_CORE, "get-bin-price", [
                cvUint(initialPrice),
                cvUint(binStep),
                `0x00${BigInt(highBinSigned >= 0 ? highBinSigned : (1n << 128n) + BigInt(highBinSigned)).toString(16).padStart(32, "0")}`,
              ]),
            ]);

            if (lowPriceResult.okay && lowPriceResult.result) {
              const rawPrice = parseUint128Hex(lowPriceResult.result);
              // Price is in 1e8 scale, sBTC has 8 decimals, USDCx has 6
              // USD price = (rawPrice / 1e8) * 10^(8-6) = rawPrice / 1e6
              rangeLow = round(Number(rawPrice) / 1e6, 2);
              sources.push("hodlmm-bin-price-low");
            }

            if (highPriceResult.okay && highPriceResult.result) {
              const rawPrice = parseUint128Hex(highPriceResult.result);
              rangeHigh = round(Number(rawPrice) / 1e6, 2);
              sources.push("hodlmm-bin-price-high");
            }
          }
        }
      }
    } catch {
      // Break price calculation failed
    }
  }

  // Granite liquidation price
  if (granite.has_position && granite.liquidation_ltv_pct) {
    // Liquidation happens when: (debt_value / collateral_value) > liquidation_ltv
    // For supply-only (no borrow): no liquidation risk
    // For borrowers: liq_price = current_price * (current_ltv / liquidation_ltv)
    // Since we don't borrow, this is null
    graniteLiq = null;
  }

  return {
    breakPrices: {
      hodlmm_range_exit_low_usd: rangeLow,
      hodlmm_range_exit_high_usd: rangeHigh,
      granite_liquidation_usd: graniteLiq,
      current_sbtc_price_usd: sbtcPrice,
    },
    sources,
  };
}

/**
 * "degraded" whenever something a person would act on was not read: fewer than
 * four sources, a Zest position that is unknown, or a rate left out of the
 * ranking. The report must not call itself "ok" while part of it is missing.
 */
export function scoutStatus(sourceCount: number, zest: ZestPosition, ranking: RankingMeasured, hodlmm: HodlmmPositions): "ok" | "degraded" {
  // A HODLMM pool that could not be read is a position that is unknown, as an unread Zest is.
  return sourceCount >= 4 && zest.state !== "unknown" && ranking.not_read.length === 0 && (hodlmm.unread ?? []).length === 0
    ? "ok" : "degraded";
}

// ── Main scout function ────────────────────────────────────────────────────────
async function runScout(wallet: string): Promise<ScoutResult> {
  if (!/^SP[A-Z0-9]{30,}$/i.test(wallet)) {
    return {
      status: "error",
      wallet,
      what_you_have: { sbtc: { amount: 0, usd: null }, stx: { amount: 0, usd: null }, usdcx: { amount: 0, usd: null } },
      zbg_positions: {
        zest: { has_position: false, state: "unknown", detail: "Skipped, invalid wallet" },
        granite: { has_position: false, detail: "Skipped, invalid wallet" },
        hodlmm: { has_position: false, pools: [], unread: [] },
      },
      smart_options: [],
      ranking_measured: { protocols: [], out_of: 3, not_read: [] },
      best_move: { recommendation: "Invalid wallet address", idle_capital_usd: null, opportunity_cost_daily_usd: null },
      break_prices: { hodlmm_range_exit_low_usd: null, hodlmm_range_exit_high_usd: null, granite_liquidation_usd: null, current_sbtc_price_usd: null },
      data_sources: [],
      rendered_report: "",
      error: { code: "INVALID_WALLET", message: "Wallet must be a valid Stacks mainnet address (SP...)" },
    };
  }

  const allSources: string[] = [];

  // Section 1: What You Have
  const { balances, prices, sources: balSources, fungibleTokens } = await getWalletBalances(wallet);
  allSources.push(...balSources);

  // Section 2: ZBG Positions (run in parallel)
  const [zestResult, graniteResult, hodlmmResult] = await Promise.all([
    getZestPosition(wallet, fungibleTokens),
    getGranitePosition(wallet),
    getHodlmmPositions(wallet),
  ]);
  allSources.push(...zestResult.sources, ...graniteResult.sources, ...hodlmmResult.sources);
  // Valued only from a price that was actually read, which is all `prices` holds.
  zestResult.position = priceZestHoldings(zestResult.position, {
    sbtc: prices.sbtc,
    stx: prices.stx,
    usdcx: 1,
  });

  // HODLMM positions priced from what they hold, from prices actually read, as Zest is above.
  hodlmmResult.positions = priceHodlmmHoldings(hodlmmResult.positions, {
    sbtc: prices.sbtc,
    stx: prices.stx,
    usdcx: 1, aeusdc: 1, usdh: 1,
  });

  // Section 3: Smart Options
  const { options, sources: optSources, ranking } = await getSmartOptions(balances, graniteResult.position);
  allSources.push(...optSources);

  // Section 4: Best Move
  const bestMove = getBestMove(balances, zestResult.position, graniteResult.position, hodlmmResult.positions, options, ranking);

  // Section 5: Break Prices
  const { breakPrices, sources: bpSources } = await getBreakPrices(
    hodlmmResult.positions,
    graniteResult.position,
    prices.sbtc,
  );
  allSources.push(...bpSources);

  const status = scoutStatus(allSources.length, zestResult.position, ranking, hodlmmResult.positions);

  const result: ScoutResult = {
    status,
    wallet,
    what_you_have: balances,
    zbg_positions: {
      zest: zestResult.position,
      granite: graniteResult.position,
      hodlmm: hodlmmResult.positions,
    },
    smart_options: options,
    ranking_measured: ranking,
    best_move: bestMove,
    break_prices: breakPrices,
    data_sources: [...new Set(allSources)],
    rendered_report: "",
    error: null,
  };

  result.rendered_report = renderReport(result);
  return result;
}

// ── Utility ────────────────────────────────────────────────────────────────────
function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ── Human-readable renderer ────────────────────────────────────────────────────
/** "holds 28.252176 STX and 0 USDCx", or that the holdings are unknown. */
function hodlmmHeld(p: HodlmmUserPool): string {
  const label: Record<string, string> = { stx: "STX", sbtc: "sBTC", usdcx: "USDCx", aeusdc: "aeUSDC", usdh: "USDh" };
  const h = p.holdings;
  return h
    ? `holds ${h.amount_x} ${label[h.token_x] ?? h.token_x} and ${h.amount_y} ${label[h.token_y] ?? h.token_y}`
    : "holdings not read";
}

export function renderReport(r: ScoutResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("ZBG Yield Scout");
  lines.push(`Wallet: ${r.wallet}`);
  lines.push("");

  // Section 1: What You Have (wallet only, available to move)
  const walletUsd = walletTotalUsd(r.what_you_have);
  const dollars = (v: number | null): string => v === null ? "no price" : `$${v}`;
  lines.push("## 1. What You Have (available in wallet)");
  lines.push("");
  lines.push("| Token   | Amount             | USD      |");
  lines.push("|---------|--------------------|---------:|");
  lines.push(`| sBTC    | ${pad(String(r.what_you_have.sbtc.amount), 18)} | ${dollars(r.what_you_have.sbtc.usd)} |`);
  lines.push(`| STX     | ${pad(String(r.what_you_have.stx.amount), 18)} | ${dollars(r.what_you_have.stx.usd)} |`);
  lines.push(`| USDCx   | ${pad(String(r.what_you_have.usdcx.amount), 18)} | ${dollars(r.what_you_have.usdcx.usd)} |`);
  lines.push(`| **Wallet Total** |              | **${walletUsd === null ? `not valued, no price for ${unpricedTokens(r.what_you_have).join(" or ")}` : `$${walletUsd}`}** |`);
  lines.push("");

  // Section 2: ZBG Positions (what's deployed)
  lines.push("## 2. Available ZBG Positions (deployed capital)");
  lines.push("");
  lines.push("| Protocol | Status     | Detail | Value |");
  lines.push("|----------|------------|--------|------:|");

  const z = r.zbg_positions.zest;
  const zestPriced = (z.holdings ?? []).filter((h) => typeof h.value_usd === "number");
  const zestUnpriced = (z.holdings ?? []).filter((h) => typeof h.value_usd !== "number");
  const zestUsd = round(zestPriced.reduce((sum, h) => sum + (h.value_usd as number), 0), 2);
  const zestValue = zestPriced.length > 0 && zestUnpriced.length === 0 ? `$${zestUsd}` : "-";
  lines.push(`| Zest     | ${z.state === "unknown" ? "**UNKNOWN**" : z.has_position ? "**ACTIVE**" : "No position"} | ${z.detail} | ${zestValue} |`);

  const g = r.zbg_positions.granite;
  const gDetail = g.has_position
    ? g.detail
    : `${g.detail} (supply APY: ${g.supply_apy_pct}%, util: ${g.utilization_pct}%)`;
  lines.push(`| Granite  | ${g.has_position ? "**ACTIVE**" : "No position"} | ${gDetail} | - |`);

  const h = r.zbg_positions.hodlmm;
  // Zest is counted here too. The total used to sum HODLMM only, which was
  // harmless while no Zest position was ever seen and false once one was.
  let deployedUsd = zestUsd;
  if (h.has_position) {
    for (const p of h.pools) {
      const rangeTag = p.in_range ? "**IN RANGE**" : "**OUT OF RANGE**";
      const binStr = p.user_bins ? `${p.user_bins.count} bins (${p.user_bins.min}-${p.user_bins.max})` : "no bins";
      const valueStr = p.estimated_value_usd !== null ? `$${p.estimated_value_usd}` : "-";
      if (p.estimated_value_usd) deployedUsd += p.estimated_value_usd;
      lines.push(`| HODLMM   | **ACTIVE** | ${p.name}: ${rangeTag} at bin ${p.active_bin}, ${binStr}, ${hodlmmHeld(p)} | ${valueStr} |`);
    }
  }
  // A pool that could not be read is named, never counted as "no position" (the payload may
  // come from a run before `unread` existed, so it is read defensively).
  const hodlmmUnread = h.unread ?? [];
  if (hodlmmUnread.length > 0) {
    lines.push(`| HODLMM   | **UNKNOWN** | Could not read ${hodlmmUnread.map((p) => p.name).join(", ")}, so a position there is not known either way | - |`);
  } else if (!h.has_position) {
    lines.push(`| HODLMM   | No position | No positions found across all ${HODLMM_POOLS.length} pools | - |`);
  }

  if (deployedUsd > 0) {
    lines.push(`| **Deployed Total** | | | **$${round(deployedUsd, 2)}** |`);
  }

  lines.push("");
  const notCounted = [
    zestUnpriced.length > 0 ? `Not counted, no price: ${zestUnpriced.map((h) => `${h.amount} ${h.asset}`).join(", ")} on Zest.` : "",
    (z.debt ?? []).length > 0 ? `Not subtracted: the Zest loan in ${(z.debt ?? []).join(", ")}.` : "",
    // A position with no value is named, never silently left out of the totals above.
    h.pools.some((p) => p.estimated_value_usd === null)
      ? `Not counted, no value: HODLMM ${h.pools.filter((p) => p.estimated_value_usd === null)
        .map((p) => `${p.name} (${p.holdings ? `${hodlmmHeld(p)}, no price read for it`
          : p.user_bins && p.user_bins.count > MAX_VALUED_BINS ? `spans more than ${MAX_VALUED_BINS} bins, so it was not valued`
          : "its holdings could not be read"})`).join(", ")}.`
      : "",
    hodlmmUnread.length > 0 ? `Not counted, could not be read: HODLMM ${hodlmmUnread.map((p) => p.name).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  // No grand total when the wallet has no value: a total that silently drops a coin is a smaller, wrong number.
  lines.push(walletUsd === null
    ? `**Total portfolio: not valued** (wallet: no price for ${unpricedTokens(r.what_you_have).join(" or ")}; deployed: $${round(deployedUsd, 2)})${notCounted ? ` ${notCounted}` : ""}`
    : `**Total portfolio: $${round(walletUsd + deployedUsd, 2)}** (wallet: $${walletUsd} + deployed: $${round(deployedUsd, 2)})${notCounted ? ` ${notCounted}` : ""}`);
  lines.push("");

  // Section 3: Smart Options
  lines.push("## 3. ZBG Smart Options (sorted by APY)");
  lines.push("");
  lines.push("| # | Protocol | Pool | APY | Daily | Monthly | Gas | Note |");
  lines.push("|---|----------|------|----:|------:|--------:|-----|------|");

  r.smart_options.forEach((o, i) => {
    lines.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.apy_pct}% | ${dollars(o.daily_usd)} | ${dollars(o.monthly_usd)} | ${o.gas_to_enter_stx} STX | ${o.note} |`);
  });
  lines.push("");
  const m = r.ranking_measured;
  lines.push(`Compared ${m.protocols.length} of ${m.out_of} protocols${m.protocols.length > 0 ? `: ${m.protocols.join(", ")}` : ""}.` +
    (m.not_read.length > 0 ? ` Could not read, so left out rather than shown as 0%: ${m.not_read.join(", ")}.` : ""));
  lines.push("");

  // Section 4: Best Move
  lines.push("## 4. Best Safe Move");
  lines.push("");
  lines.push(`> ${r.best_move.recommendation}`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Idle in wallet | ${dollars(r.best_move.idle_capital_usd)} |`);
  lines.push(`| Opportunity cost | ${r.best_move.opportunity_cost_daily_usd === null ? "no price" : `$${r.best_move.opportunity_cost_daily_usd}/day`} |`);
  lines.push("");

  // Section 5: Break Prices
  lines.push("## 5. Break Prices");
  lines.push("");
  const bp = r.break_prices;
  lines.push("| Trigger | sBTC Price |");
  lines.push("|---------|----------:|");
  if (bp.hodlmm_range_exit_low_usd) {
    lines.push(`| HODLMM range exit (low) | **$${bp.hodlmm_range_exit_low_usd.toLocaleString()}** |`);
  }
  lines.push(`| Current sBTC price | ${bp.current_sbtc_price_usd === null ? "not read" : `$${bp.current_sbtc_price_usd.toLocaleString()}`} |`);
  if (bp.hodlmm_range_exit_high_usd) {
    lines.push(`| HODLMM range exit (high) | **$${bp.hodlmm_range_exit_high_usd.toLocaleString()}** |`);
  }
  if (bp.granite_liquidation_usd) {
    lines.push(`| Granite liquidation | **$${bp.granite_liquidation_usd.toLocaleString()}** |`);
  } else {
    lines.push(`| Granite liquidation | N/A (no position) |`);
  }
  lines.push("");

  if (bp.hodlmm_range_exit_low_usd && bp.hodlmm_range_exit_high_usd && bp.current_sbtc_price_usd !== null) {
    const bufferLow = round(bp.current_sbtc_price_usd - bp.hodlmm_range_exit_low_usd, 0);
    const bufferHigh = round(bp.hodlmm_range_exit_high_usd - bp.current_sbtc_price_usd, 0);
    lines.push(`Your position is safe: $${bufferLow.toLocaleString()} above low exit, $${bufferHigh.toLocaleString()} below high exit.`);
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push(`Data sources: ${r.data_sources.length} live reads | Status: ${r.status}`);
  lines.push("");

  return lines.join("\n");
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("zbg-yield-scout")
  .description("Scan Zest, Granite, and HODLMM for yield positions and recommendations")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check all data sources for reachability")
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    // Hiro API
    try {
      const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${HIRO_API}/v2/info`);
      checks.push({ name: "Hiro Stacks API", ok: true, detail: `tip: ${info.stacks_tip_height}, burn: ${info.burn_block_height}` });
    } catch (e: unknown) {
      checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // Tenero API
    try {
      const token = await fetchJson<TeneroTokenResponse>(`${TENERO_API}/v1/stacks/tokens/${SBTC_CONTRACT}`);
      const price = readPrice(token.data);
      checks.push({ name: "Tenero Price Oracle", ok: price !== null, detail: price === null ? "sBTC: no price returned" : `sBTC: $${round(price, 2)}` });
    } catch (e: unknown) {
      checks.push({ name: "Tenero Price Oracle", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // Granite on-chain
    try {
      const lp = await callReadOnly(GRANITE_STATE, "get-lp-params", []);
      checks.push({ name: "Granite Protocol (on-chain)", ok: lp.okay, detail: lp.okay ? "get-lp-params readable" : "read failed" });
    } catch (e: unknown) {
      checks.push({ name: "Granite Protocol (on-chain)", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // Zest V2 vaults (on-chain)
    const zestSbtc = ZEST_ASSETS.find((a) => a.symbol === "sBTC")!;
    const zestRate = await readZestSupplyRate(zestSbtc.vault);
    checks.push({
      name: "Zest V2 Vaults (on-chain)",
      ok: zestRate !== null,
      detail: zestRate ? `sBTC supply rate readable: ${zestRate.supply_apy_pct}% at ${zestRate.utilization_pct}% utilization` : "sBTC vault rate read failed",
    });

    // HODLMM pool contract
    try {
      const pool1 = HODLMM_POOLS[0];
      const activeBin = await callReadOnly(pool1.contract, "get-active-bin-id", []);
      const binVal = activeBin.okay && activeBin.result ? 500 + Number(parseInt128Hex(activeBin.result)) : 0;
      checks.push({ name: "HODLMM Pool Contracts", ok: activeBin.okay, detail: `sBTC-USDCx-10bps active bin: ${binVal}` });
    } catch (e: unknown) {
      checks.push({ name: "HODLMM Pool Contracts", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // Bitflow App API
    try {
      const poolData = await fetchJson<BitflowPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
      const count = poolData.data?.length ?? 0;
      const dlmm1 = poolData.data?.find(p => p.poolId === "dlmm_1");
      checks.push({
        name: "Bitflow HODLMM API",
        ok: count > 0,
        detail: dlmm1
          ? `dlmm_1 TVL: $${Math.round(dlmm1.tvlUsd).toLocaleString()}, APR: ${dlmm1.apr24h.toFixed(2)}%`
          : `${count} pools found`,
      });
    } catch (e: unknown) {
      checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    // DLMM Core bin price function
    try {
      // Test get-bin-price with known values
      const priceResult = await callReadOnly(DLMM_CORE, "get-bin-price", [
        cvUint(6700000000000n), // sample initial price
        cvUint(10),            // sample bin step
        "0x00" + "00000000000000000000000000000000", // bin 0
      ]);
      checks.push({ name: "DLMM Core (bin-price)", ok: priceResult.okay, detail: priceResult.okay ? "get-bin-price callable" : "read failed" });
    } catch (e: unknown) {
      checks.push({ name: "DLMM Core (bin-price)", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }

    const allOk = checks.every(c => c.ok);
    console.log(JSON.stringify({
      status: allOk ? "ok" : "degraded",
      checks,
      message: allOk
        ? "All 6 data sources reachable. Ready to scout."
        : "One or more sources failed, output may be incomplete.",
    }, null, 2));
    if (!allOk) process.exit(1);
  });

program
  .command("install-packs")
  .description("No additional packs required")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "No packs required. zbg-yield-scout uses Hiro, Tenero, and Bitflow public APIs only.",
      data: { requires: [] },
    }, null, 2));
  });

program
  .command("run")
  .description("Scan wallet across ZBG protocols and output yield report")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...) to scan")
  .option("--format <type>", "Output format: json (default) or text", "json")
  .action(async (options: { wallet: string; format: string }) => {
    try {
      const result = await runScout(options.wallet);
      if (options.format === "text") {
        console.log(renderReport(result));
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
      if (result.status === "error") process.exit(1);
    } catch (err: unknown) {
      console.error(JSON.stringify({
        status: "error",
        error: { code: "RUN_ERROR", message: err instanceof Error ? err.message : String(err) },
      }, null, 2));
      process.exit(1);
    }
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: { code: "FATAL", message: err instanceof Error ? err.message : String(err) } }));
    process.exit(1);
  });
}
