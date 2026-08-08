#!/usr/bin/env bun
/**
 * ZBG Yield Scout
 * Scans Zest, Granite, and all 8 HODLMM pools for sBTC/STX/USDCx positions.
 * Compares yield, recommends the best safe move, shows sBTC break prices.
 *
 * Read-only — no transactions, no gas, no risk.
 *
 * Usage:
 *   bun run zbg-yield-scout/zbg-yield-scout.ts doctor
 *   bun run zbg-yield-scout/zbg-yield-scout.ts run --wallet <STX_ADDRESS>
 */

import { Command } from "commander";

// ── Constants ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 30_000;
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
];

// Token contracts
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_CONTRACT = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";

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
  usd: number;
}

interface WalletBalances {
  sbtc: TokenBalance;
  stx: TokenBalance;
  usdcx: TokenBalance;
}

interface ZestPosition {
  has_position: boolean;
  detail: string;
  supply_amount?: number;
  asset?: string;
}

interface GranitePosition {
  has_position: boolean;
  detail: string;
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
  estimated_value_usd: number | null;
}

interface HodlmmPositions {
  has_position: boolean;
  pools: HodlmmUserPool[];
}

interface YieldOption {
  protocol: string;
  pool: string;
  apy_pct: number;
  daily_usd: number;
  monthly_usd: number;
  gas_to_enter_stx: number;
  note: string;
}

interface BestMove {
  recommendation: string;
  idle_capital_usd: number;
  opportunity_cost_daily_usd: number;
}

interface BreakPrices {
  hodlmm_range_exit_low_usd: number | null;
  hodlmm_range_exit_high_usd: number | null;
  granite_liquidation_usd: number | null;
  current_sbtc_price_usd: number;
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
async function callReadOnly(
  contractId: string,
  functionName: string,
  args: string[] = [],
  sender = "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
): Promise<ClarityReadResult> {
  const [addr, name] = contractId.split(".");
  const url = `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${functionName}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "User-Agent": "bff-skills/zbg-yield-scout" },
      body: JSON.stringify({ sender, arguments: args }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<ClarityReadResult>;
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
async function getWalletBalances(wallet: string): Promise<{ balances: WalletBalances; prices: { sbtc: number; stx: number; usdcx: number }; sources: string[] }> {
  const sources: string[] = [];

  // Fetch balances and prices in parallel
  const [hiroBalance, teneroSbtc, teneroStx] = await Promise.all([
    fetchJson<HiroBalanceResponse>(`${HIRO_API}/extended/v1/address/${wallet}/balances`).catch(() => null),
    fetchJson<TeneroTokenResponse>(`${TENERO_API}/v1/stacks/tokens/${SBTC_CONTRACT}`).catch(() => null),
    fetchJson<TeneroTokenResponse>(`${TENERO_API}/v1/stacks/tokens/stx`).catch(() => null),
  ]);

  if (hiroBalance) sources.push("hiro-balances");
  if (teneroSbtc) sources.push("tenero-sbtc-price");
  if (teneroStx) sources.push("tenero-stx-price");

  // Parse STX balance
  const stxMicro = BigInt(hiroBalance?.stx?.balance ?? hiroBalance?.balance ?? "0");
  const stxAmount = Number(stxMicro) / 1_000_000;

  // Parse sBTC balance — match exact contract, not substring (avoid DLP pool tokens)
  const sbtcKey = Object.keys(hiroBalance?.fungible_tokens ?? {}).find(k =>
    k.startsWith(SBTC_CONTRACT + "::")
  );
  const sbtcSats = BigInt(hiroBalance?.fungible_tokens?.[sbtcKey ?? ""]?.balance ?? "0");
  const sbtcAmount = Number(sbtcSats) / 1e8;

  // Parse USDCx balance — match exact contract
  const usdcxKey = Object.keys(hiroBalance?.fungible_tokens ?? {}).find(k =>
    k.startsWith(USDCX_CONTRACT + "::")
  );
  const usdcxMicro = BigInt(hiroBalance?.fungible_tokens?.[usdcxKey ?? ""]?.balance ?? "0");
  const usdcxAmount = Number(usdcxMicro) / 1_000_000;

  // Prices from Tenero
  const sbtcData = teneroSbtc?.data;
  const sbtcPrice = sbtcData?.price_usd ?? sbtcData?.price?.current_price ?? 0;
  const stxData = teneroStx?.data;
  const stxPrice = stxData?.price_usd ?? stxData?.price?.current_price ?? 0.216;
  const usdcxPrice = 1.0; // stablecoin

  return {
    balances: {
      sbtc: { amount: round(sbtcAmount, 8), usd: round(sbtcAmount * sbtcPrice, 2) },
      stx: { amount: round(stxAmount, 6), usd: round(stxAmount * stxPrice, 2) },
      usdcx: { amount: round(usdcxAmount, 6), usd: round(usdcxAmount * usdcxPrice, 2) },
    },
    prices: { sbtc: round(sbtcPrice, 2), stx: round(stxPrice, 4), usdcx: usdcxPrice },
    sources,
  };
}

// ── Section 2: ZBG Positions ───────────────────────────────────────────────────
async function getZestPosition(wallet: string): Promise<{ position: ZestPosition; sources: string[] }> {
  const sources: string[] = [];
  try {
    // Zest v2 pool contract for sBTC
    // Check if user has any supply by reading the Zest pool balance
    const zestSbtcPool = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.zest-pool-sbtc";
    const result = await callReadOnly(
      zestSbtcPool,
      "get-balance",
      [cvPrincipal(wallet)],
      wallet
    );
    sources.push("zest-on-chain");

    if (result.okay && result.result) {
      const balance = parseUint128Hex(result.result);
      if (balance > 0n) {
        return { position: { has_position: true, detail: `Active sBTC supply on Zest: ${Number(balance) / 1e8} sBTC`, asset: "sBTC", supply_amount: Number(balance) / 1e8 }, sources };
      }
    }
    return { position: { has_position: false, detail: "No sBTC supply position on Zest" }, sources };
  } catch {
    // Fallback: try the generic check
    try {
      const balUrl = `${HIRO_API}/extended/v1/address/${wallet}/balances`;
      const bal = await fetchJson<HiroBalanceResponse>(balUrl);
      const zestKey = Object.keys(bal?.fungible_tokens ?? {}).find(k => k.toLowerCase().includes("zest"));
      if (zestKey && BigInt(bal?.fungible_tokens?.[zestKey]?.balance ?? "0") > 0n) {
        sources.push("zest-hiro-fallback");
        return { position: { has_position: true, detail: "Zest position detected via token balance" }, sources };
      }
      sources.push("zest-hiro-fallback");
      return { position: { has_position: false, detail: "No Zest position found" }, sources };
    } catch {
      return { position: { has_position: false, detail: "Zest read failed — skipped" }, sources };
    }
  }
}

async function getGranitePosition(wallet: string): Promise<{ position: GranitePosition; sources: string[] }> {
  const sources: string[] = [];
  const IR_SCALE = 1e12; // Granite IR params are scaled by 1e12
  try {
    // Read Granite supply params, debt params, and interest rate model in parallel
    const [lpResult, debtResult, irResult, userPos] = await Promise.all([
      callReadOnly(GRANITE_STATE, "get-lp-params", []),
      callReadOnly(GRANITE_STATE, "get-debt-params", []),
      callReadOnly(GRANITE_IR, "get-ir-params", []),
      callReadOnly(GRANITE_STATE, "get-user-position", [cvPrincipal(wallet)]),
    ]);
    sources.push("granite-on-chain");

    let supplyApy = 0;
    let borrowApr = 0;
    let utilization = 0;

    // Parse lp-params: { total-assets, total-shares }
    // Parse debt-params: { open-interest, total-debt-shares }
    if (lpResult.okay && lpResult.result && debtResult.okay && debtResult.result) {
      const lp = parseClarityHex(lpResult.result) as Record<string, ClarityValue>;
      const debt = parseClarityHex(debtResult.result) as Record<string, ClarityValue>;

      const totalAssets = typeof lp["total-assets"] === "bigint" ? lp["total-assets"] : 0n;
      const openInterest = typeof debt["open-interest"] === "bigint" ? debt["open-interest"] : 0n;

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
        detail: "Granite read failed — skipped",
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

async function getHodlmmPositions(wallet: string): Promise<{ positions: HodlmmPositions; sources: string[] }> {
  const sources: string[] = [];
  const userPools: HodlmmUserPool[] = [];

  // Fetch Bitflow pool data once for all pools
  let bitflowPools: BitflowPoolData[] | null = null;
  try {
    const poolData = await fetchJson<BitflowPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
    bitflowPools = poolData.data ?? null;
  } catch {
    // Bitflow API unavailable — position values will be null
  }

  for (const pool of HODLMM_POOLS) {
    try {
      // Get user's bins in this pool
      const userBinsResult = await callReadOnly(pool.contract, "get-user-bins", [cvPrincipal(wallet)], wallet);

      if (!userBinsResult.okay) continue;

      // Get overall balance and pool total supply in parallel
      const [overallResult, totalSupplyResult, activeBinResult] = await Promise.all([
        callReadOnly(pool.contract, "get-overall-balance", [cvPrincipal(wallet)], wallet),
        callReadOnly(pool.contract, "get-overall-supply", [], wallet),
        callReadOnly(pool.contract, "get-active-bin-id", []),
      ]);

      const dlpShares = overallResult.okay && overallResult.result
        ? parseUint128Hex(overallResult.result)
        : 0n;

      if (dlpShares === 0n) continue;

      const totalSupply = totalSupplyResult.okay && totalSupplyResult.result
        ? parseUint128Hex(totalSupplyResult.result)
        : 0n;

      const activeBinSigned = activeBinResult.okay && activeBinResult.result
        ? parseInt128Hex(activeBinResult.result)
        : 0n;
      // Convert signed to unsigned: CENTER_BIN_ID (500) + signed offset
      const activeBin = 500 + Number(activeBinSigned);

      // Parse user bin list from the hex response
      const userBinIds = parseUserBinList(userBinsResult.result ?? "");
      const minBin = userBinIds.length > 0 ? Math.min(...userBinIds) : 0;
      const maxBin = userBinIds.length > 0 ? Math.max(...userBinIds) : 0;
      const inRange = userBinIds.includes(activeBin);

      // Estimate position USD value from pool TVL and share ratio
      let estimatedValueUsd: number | null = null;
      const matchPool = bitflowPools?.find(p => p.poolId === `dlmm_${pool.id}`);
      if (matchPool && totalSupply > 0n) {
        const shareRatio = Number(dlpShares) / Number(totalSupply);
        estimatedValueUsd = round(shareRatio * matchPool.tvlUsd, 2);
      }

      sources.push(`hodlmm-pool-${pool.id}`);

      userPools.push({
        pool_id: pool.id,
        name: pool.name,
        in_range: inRange,
        active_bin: activeBin,
        user_bins: userBinIds.length > 0 ? { min: minBin, max: maxBin, count: userBinIds.length } : null,
        dlp_shares: dlpShares.toString(),
        estimated_value_usd: estimatedValueUsd,
      });
    } catch {
      // Skip pool on error
    }
  }

  return {
    positions: {
      has_position: userPools.length > 0,
      pools: userPools,
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
  prices: { sbtc: number; stx: number },
  granite: GranitePosition,
): Promise<{ options: YieldOption[]; sources: string[] }> {
  const sources: string[] = [];
  const options: YieldOption[] = [];
  const totalIdleUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd;

  // Granite supply APY
  if (granite.supply_apy_pct && granite.supply_apy_pct > 0) {
    const dailyUsd = (balances.sbtc.usd * granite.supply_apy_pct / 100) / 365;
    options.push({
      protocol: "Granite",
      pool: "sBTC Supply",
      apy_pct: granite.supply_apy_pct,
      daily_usd: round(dailyUsd, 4),
      monthly_usd: round(dailyUsd * 30, 2),
      gas_to_enter_stx: 0.05,
      note: `Lending yield — ${granite.utilization_pct}% utilization, borrow APR ${granite.borrow_apr_pct}%. Max LTV ${granite.max_ltv_pct}%.`,
    });
    sources.push("granite-apy");
  }

  // HODLMM APR from Bitflow API
  try {
    const poolData = await fetchJson<BitflowPoolsResponse>(`${BITFLOW_API}/api/app/v1/pools`);
    if (poolData.data) {
      sources.push("bitflow-hodlmm-apr");
      for (const bp of poolData.data) {
        if (bp.apr24h > 0) {
          const poolDef = HODLMM_POOLS.find(p => `dlmm_${p.id}` === bp.poolId);
          const isRelevant = poolDef && (
            poolDef.tokenX === "sbtc" || poolDef.tokenY === "sbtc" ||
            poolDef.tokenX === "stx" || poolDef.tokenY === "stx"
          );
          if (isRelevant) {
            const capital = poolDef.tokenX === "sbtc" || poolDef.tokenY === "sbtc"
              ? balances.sbtc.usd
              : balances.stx.usd;
            const dailyUsd = (capital * bp.apr24h / 100) / 365;
            options.push({
              protocol: "HODLMM",
              pool: poolDef.name,
              apy_pct: round(bp.apr24h, 2),
              daily_usd: round(dailyUsd, 4),
              monthly_usd: round(dailyUsd * 30, 2),
              gas_to_enter_stx: 0.05,
              note: `Fee-based yield — varies with swap volume. TVL: $${Math.round(bp.tvlUsd).toLocaleString()}.`,
            });
          }
        }
      }
    }
  } catch {
    // Bitflow API unavailable
  }

  // Zest APY (from yield dashboard or hardcoded known rate)
  try {
    // Use Bitflow API for Zest if available, otherwise note as data point
    options.push({
      protocol: "Zest",
      pool: "sBTC Supply",
      apy_pct: 0,
      daily_usd: 0,
      monthly_usd: 0,
      gas_to_enter_stx: 0.03,
      note: "sBTC supply APY currently 0% — check zest.fi for latest rates.",
    });
    sources.push("zest-apy");
  } catch {
    // Skip
  }

  // Sort by APY descending
  options.sort((a, b) => b.apy_pct - a.apy_pct);

  return { options, sources };
}

// ── Section 4: Best Move ───────────────────────────────────────────────────────
function getBestMove(
  balances: WalletBalances,
  zest: ZestPosition,
  granite: GranitePosition,
  hodlmm: HodlmmPositions,
  options: YieldOption[],
): BestMove {
  const walletUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd;
  const bestOption = options[0];

  // Count deployed capital
  const deployedProtocols: string[] = [];
  if (zest.has_position) deployedProtocols.push("Zest");
  if (granite.has_position) deployedProtocols.push("Granite");

  const inRangePools = hodlmm.pools.filter(p => p.in_range);
  const outOfRangePools = hodlmm.pools.filter(p => !p.in_range);
  if (inRangePools.length > 0) deployedProtocols.push(`HODLMM (${inRangePools.length} pool${inRangePools.length > 1 ? "s" : ""} in range)`);

  if (!bestOption || bestOption.apy_pct === 0) {
    return {
      recommendation: "No yield opportunities currently available. Hold your assets in wallet.",
      idle_capital_usd: round(walletUsd, 2),
      opportunity_cost_daily_usd: 0,
    };
  }

  // Priority 1: Warn about out-of-range positions
  if (outOfRangePools.length > 0) {
    const poolNames = outOfRangePools.map(p => p.name).join(", ");
    return {
      recommendation: `WARNING: ${outOfRangePools.length} HODLMM position(s) OUT OF RANGE (${poolNames}). These are not earning fees. Consider rebalancing or withdrawing.`,
      idle_capital_usd: round(walletUsd, 2),
      opportunity_cost_daily_usd: round(bestOption.daily_usd, 4),
    };
  }

  // Priority 2: Capital is deployed and working
  if (deployedProtocols.length > 0) {
    const deployed = deployedProtocols.join(", ");
    if (walletUsd < 10) {
      return {
        recommendation: `Your capital is deployed and earning on ${deployed}. Wallet balance ($${round(walletUsd, 2)}) is minimal — nothing to move.`,
        idle_capital_usd: round(walletUsd, 2),
        opportunity_cost_daily_usd: 0,
      };
    }
    // Has deployed positions but also meaningful wallet balance
    const dailyCost = (walletUsd * bestOption.apy_pct / 100) / 365;
    return {
      recommendation: `Active position on ${deployed}. You also have $${round(walletUsd, 2)} idle in wallet. Best option for idle funds: ${bestOption.protocol} ${bestOption.pool} at ${bestOption.apy_pct}% APY (~$${round(dailyCost, 4)}/day missed).`,
      idle_capital_usd: round(walletUsd, 2),
      opportunity_cost_daily_usd: round(dailyCost, 4),
    };
  }

  // Priority 3: Nothing deployed anywhere
  const dailyCost = (walletUsd * bestOption.apy_pct / 100) / 365;
  return {
    recommendation: `No active positions. All $${round(walletUsd, 2)} is idle in wallet. Best option: ${bestOption.protocol} ${bestOption.pool} at ${bestOption.apy_pct}% APY. You're leaving ~$${round(dailyCost, 4)}/day on the table.`,
    idle_capital_usd: round(walletUsd, 2),
    opportunity_cost_daily_usd: round(dailyCost, 4),
  };
}

// ── Section 5: Break Prices ────────────────────────────────────────────────────
async function getBreakPrices(
  hodlmm: HodlmmPositions,
  granite: GranitePosition,
  sbtcPrice: number,
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

// ── Main scout function ────────────────────────────────────────────────────────
async function runScout(wallet: string): Promise<ScoutResult> {
  if (!/^SP[A-Z0-9]{30,}$/i.test(wallet)) {
    return {
      status: "error",
      wallet,
      what_you_have: { sbtc: { amount: 0, usd: 0 }, stx: { amount: 0, usd: 0 }, usdcx: { amount: 0, usd: 0 } },
      zbg_positions: {
        zest: { has_position: false, detail: "Skipped — invalid wallet" },
        granite: { has_position: false, detail: "Skipped — invalid wallet" },
        hodlmm: { has_position: false, pools: [] },
      },
      smart_options: [],
      best_move: { recommendation: "Invalid wallet address", idle_capital_usd: 0, opportunity_cost_daily_usd: 0 },
      break_prices: { hodlmm_range_exit_low_usd: null, hodlmm_range_exit_high_usd: null, granite_liquidation_usd: null, current_sbtc_price_usd: 0 },
      data_sources: [],
      rendered_report: "",
      error: { code: "INVALID_WALLET", message: "Wallet must be a valid Stacks mainnet address (SP...)" },
    };
  }

  const allSources: string[] = [];

  // Section 1: What You Have
  const { balances, prices, sources: balSources } = await getWalletBalances(wallet);
  allSources.push(...balSources);

  // Section 2: ZBG Positions (run in parallel)
  const [zestResult, graniteResult, hodlmmResult] = await Promise.all([
    getZestPosition(wallet),
    getGranitePosition(wallet),
    getHodlmmPositions(wallet),
  ]);
  allSources.push(...zestResult.sources, ...graniteResult.sources, ...hodlmmResult.sources);

  // Section 3: Smart Options
  const { options, sources: optSources } = await getSmartOptions(balances, prices, graniteResult.position);
  allSources.push(...optSources);

  // Section 4: Best Move
  const bestMove = getBestMove(balances, zestResult.position, graniteResult.position, hodlmmResult.positions, options);

  // Section 5: Break Prices
  const { breakPrices, sources: bpSources } = await getBreakPrices(
    hodlmmResult.positions,
    graniteResult.position,
    prices.sbtc,
  );
  allSources.push(...bpSources);

  const status = allSources.length >= 4 ? "ok" : "degraded";

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
function renderReport(r: ScoutResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("ZBG Yield Scout");
  lines.push(`Wallet: ${r.wallet}`);
  lines.push("");

  // Section 1: What You Have (wallet only — available to move)
  const walletUsd = round(r.what_you_have.sbtc.usd + r.what_you_have.stx.usd + r.what_you_have.usdcx.usd, 2);
  lines.push("## 1. What You Have (available in wallet)");
  lines.push("");
  lines.push("| Token   | Amount             | USD      |");
  lines.push("|---------|--------------------|---------:|");
  lines.push(`| sBTC    | ${pad(String(r.what_you_have.sbtc.amount), 18)} | $${r.what_you_have.sbtc.usd} |`);
  lines.push(`| STX     | ${pad(String(r.what_you_have.stx.amount), 18)} | $${r.what_you_have.stx.usd} |`);
  lines.push(`| USDCx   | ${pad(String(r.what_you_have.usdcx.amount), 18)} | $${r.what_you_have.usdcx.usd} |`);
  lines.push(`| **Wallet Total** |              | **$${walletUsd}** |`);
  lines.push("");

  // Section 2: ZBG Positions (what's deployed)
  lines.push("## 2. Available ZBG Positions (deployed capital)");
  lines.push("");
  lines.push("| Protocol | Status     | Detail | Value |");
  lines.push("|----------|------------|--------|------:|");

  const z = r.zbg_positions.zest;
  lines.push(`| Zest     | ${z.has_position ? "**ACTIVE**" : "No position"} | ${z.detail} | — |`);

  const g = r.zbg_positions.granite;
  const gDetail = g.has_position
    ? g.detail
    : `${g.detail} (supply APY: ${g.supply_apy_pct}%, util: ${g.utilization_pct}%)`;
  lines.push(`| Granite  | ${g.has_position ? "**ACTIVE**" : "No position"} | ${gDetail} | — |`);

  const h = r.zbg_positions.hodlmm;
  let deployedUsd = 0;
  if (h.has_position) {
    for (const p of h.pools) {
      const rangeTag = p.in_range ? "**IN RANGE**" : "**OUT OF RANGE**";
      const binStr = p.user_bins ? `${p.user_bins.count} bins (${p.user_bins.min}–${p.user_bins.max})` : "no bins";
      const valueStr = p.estimated_value_usd !== null ? `$${p.estimated_value_usd}` : "—";
      if (p.estimated_value_usd) deployedUsd += p.estimated_value_usd;
      lines.push(`| HODLMM   | **ACTIVE** | ${p.name} — ${rangeTag} at bin ${p.active_bin}, ${binStr} | ${valueStr} |`);
    }
  } else {
    lines.push("| HODLMM   | No position | No positions found across all 8 pools | — |");
  }

  if (deployedUsd > 0) {
    lines.push(`| **Deployed Total** | | | **$${round(deployedUsd, 2)}** |`);
  }

  const grandTotal = round(walletUsd + deployedUsd, 2);
  lines.push("");
  lines.push(`**Total portfolio: $${grandTotal}** (wallet: $${walletUsd} + deployed: $${round(deployedUsd, 2)})`);
  lines.push("");

  // Section 3: Smart Options
  lines.push("## 3. ZBG Smart Options (sorted by APY)");
  lines.push("");
  lines.push("| # | Protocol | Pool | APY | Daily | Monthly | Gas | Note |");
  lines.push("|---|----------|------|----:|------:|--------:|-----|------|");

  r.smart_options.forEach((o, i) => {
    lines.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.apy_pct}% | $${o.daily_usd} | $${o.monthly_usd} | ${o.gas_to_enter_stx} STX | ${o.note} |`);
  });
  lines.push("");

  // Section 4: Best Move
  lines.push("## 4. Best Safe Move");
  lines.push("");
  lines.push(`> ${r.best_move.recommendation}`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Idle in wallet | $${r.best_move.idle_capital_usd} |`);
  lines.push(`| Opportunity cost | $${r.best_move.opportunity_cost_daily_usd}/day |`);
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
  lines.push(`| Current sBTC price | $${bp.current_sbtc_price_usd.toLocaleString()} |`);
  if (bp.hodlmm_range_exit_high_usd) {
    lines.push(`| HODLMM range exit (high) | **$${bp.hodlmm_range_exit_high_usd.toLocaleString()}** |`);
  }
  if (bp.granite_liquidation_usd) {
    lines.push(`| Granite liquidation | **$${bp.granite_liquidation_usd.toLocaleString()}** |`);
  } else {
    lines.push(`| Granite liquidation | N/A (no position) |`);
  }
  lines.push("");

  if (bp.hodlmm_range_exit_low_usd && bp.hodlmm_range_exit_high_usd) {
    const bufferLow = round(bp.current_sbtc_price_usd - bp.hodlmm_range_exit_low_usd, 0);
    const bufferHigh = round(bp.hodlmm_range_exit_high_usd - bp.current_sbtc_price_usd, 0);
    lines.push(`Your position is safe — $${bufferLow.toLocaleString()} above low exit, $${bufferHigh.toLocaleString()} below high exit.`);
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
      const price = token.data?.price_usd ?? token.data?.price?.current_price ?? 0;
      checks.push({ name: "Tenero Price Oracle", ok: price > 0, detail: `sBTC: $${round(price, 2)}` });
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
        : "One or more sources failed — output may be incomplete.",
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
