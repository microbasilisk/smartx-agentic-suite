#!/usr/bin/env bun
/**
 * hodlmm-position-exit — pure-exit skill for HODLMM concentrated-liquidity
 * positions on Bitflow.
 *
 * Withdraws user DLP from one or more bins back to the wallet as raw X/Y
 * token balances. Does NOT rebalance, redeploy, or rotate to another protocol
 * — exit-to-wallet only. Writes to chain via
 *   dlmm-liquidity-router-v-1-1::withdraw-liquidity-same-multi
 *
 * Password policy: interactive-only. No --password flag, no env-var fallback.
 * Write operations require a TTY; autonomous loops cannot sign.
 *
 * Commands:
 *   doctor   — reachability + wallet + router sanity
 *   status   — list the user's bins in a pool with token balances
 *   plan     — classify a proposed withdraw (dry-run, no tx)
 *   withdraw — execute the withdraw (requires --confirm)
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

// Router v-1-1 — same deployer and router our #494 3-leg tx succeeded against
// (mainnet tx 0349cbb0… on 2026-04-17, ratio 14.58%→27.05% X). Verified via
// Hiro contract interface read 2026-04-19: withdraw-liquidity-same-multi is a
// public function taking (positions-list, x-trait, y-trait, min-x-total, min-y-total).
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

// API bins are unsigned (0..1000). The router contract uses signed bin IDs
// centered at 500 (0 in contract space). Convert before building Clarity args.
const CENTER_BIN_ID = 500;

// Router `withdraw-liquidity-same-multi` list cap is 326. Leave headroom for
// the caller; chunk at 320 so a bad off-by-one in future router updates doesn't
// silently push us over the cap.
const CHUNK_SIZE = 320;

// 4-hour shared cooldown matches hodlmm-move-liquidity and
// hodlmm-inventory-balancer so a user running the whole HODLMM suite can rely
// on a single rate limit across all write skills.
const COOLDOWN_MS = 4 * 60 * 60 * 1000;

const FETCH_TIMEOUT = 30_000;
const DEFAULT_SLIPPAGE_BPS = 500; // 5% per-bin floor
const MIN_POSITION_USD_DEFAULT = 0.5; // position must be ≥ $0.50 to execute

const STATE_FILE = path.join(os.homedir(), ".hodlmm-position-exit-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface PoolMetaWithPrices extends PoolMeta {
  token_x_usd: number | null;
  token_y_usd: number | null;
}

type BinSelector =
  | { kind: "list"; binIds: number[] }
  | { kind: "all" }
  | { kind: "inactive-only" };

interface ExpectedOut {
  bin_id: number;
  amount_dlp: string;
  expected_x: string;
  expected_y: string;
  min_x: string;
  min_y: string;
}

interface CooldownState {
  [poolId: string]: { last_exit_at: string };
}

// ─── Pure logic helpers ───────────────────────────────────────────────────────

function parseBinSelector(raw: {
  bins?: string;
  all?: boolean;
  inactiveOnly?: boolean;
}): BinSelector {
  const explicit = raw.bins && raw.bins.trim().length > 0;
  const flags = [explicit, raw.all, raw.inactiveOnly].filter(Boolean).length;
  if (flags === 0) {
    throw new Error(
      "Must specify one of: --bins <csv>, --all, or --inactive-only"
    );
  }
  if (flags > 1) {
    throw new Error(
      "--bins, --all, and --inactive-only are mutually exclusive; pass exactly one"
    );
  }
  if (explicit) {
    const binIds = raw
      .bins!.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const n = parseInt(s, 10);
        if (!Number.isFinite(n)) throw new Error(`Invalid bin id: ${s}`);
        return n;
      });
    if (binIds.length === 0) {
      throw new Error("--bins passed but no valid ids");
    }
    return { kind: "list", binIds };
  }
  if (raw.all) return { kind: "all" };
  return { kind: "inactive-only" };
}

function resolveBins(
  userBins: UserBin[],
  activeBin: number,
  selector: BinSelector
): { selected: UserBin[]; missing: number[] } {
  if (selector.kind === "all") {
    return { selected: userBins.slice(), missing: [] };
  }
  if (selector.kind === "inactive-only") {
    return {
      selected: userBins.filter((b) => b.bin_id !== activeBin),
      missing: [],
    };
  }
  const held = new Map(userBins.map((b) => [b.bin_id, b]));
  const selected: UserBin[] = [];
  const missing: number[] = [];
  for (const id of selector.binIds) {
    const b = held.get(id);
    if (b) selected.push(b);
    else missing.push(id);
  }
  return { selected, missing };
}

function toContractBinId(apiBinId: number): number {
  return apiBinId - CENTER_BIN_ID;
}

function expectedAndSlippage(
  bin: UserBin,
  poolBin: { reserve_x: string; reserve_y: string; liquidity: string } | undefined,
  slippageBps: number
): ExpectedOut {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps out of range [0, 10000]: ${slippageBps}`);
  }
  const userDlp = BigInt(bin.liquidity);
  let expectedX = BigInt(bin.reserve_x || "0");
  let expectedY = BigInt(bin.reserve_y || "0");
  if (expectedX === 0n && expectedY === 0n && poolBin) {
    const poolDlp = BigInt(poolBin.liquidity || "0");
    if (poolDlp > 0n) {
      expectedX = (userDlp * BigInt(poolBin.reserve_x || "0")) / poolDlp;
      expectedY = (userDlp * BigInt(poolBin.reserve_y || "0")) / poolDlp;
    }
  }
  const scale = BigInt(10_000 - slippageBps);
  const minX = (expectedX * scale) / 10_000n;
  const minY = (expectedY * scale) / 10_000n;
  return {
    bin_id: bin.bin_id,
    amount_dlp: userDlp.toString(),
    expected_x: expectedX.toString(),
    expected_y: expectedY.toString(),
    min_x: minX.toString(),
    min_y: minY.toString(),
  };
}

function aggregateTotals(plans: ExpectedOut[]): {
  expected_x_total: string;
  expected_y_total: string;
  min_x_total: string;
  min_y_total: string;
  dlp_total: string;
} {
  let ex = 0n;
  let ey = 0n;
  let mx = 0n;
  let my = 0n;
  let dlp = 0n;
  for (const p of plans) {
    ex += BigInt(p.expected_x);
    ey += BigInt(p.expected_y);
    mx += BigInt(p.min_x);
    my += BigInt(p.min_y);
    dlp += BigInt(p.amount_dlp);
  }
  return {
    expected_x_total: ex.toString(),
    expected_y_total: ey.toString(),
    min_x_total: mx.toString(),
    min_y_total: my.toString(),
    dlp_total: dlp.toString(),
  };
}

function chunkPlans(plans: ExpectedOut[], chunkSize = CHUNK_SIZE): ExpectedOut[][] {
  if (chunkSize < 1) throw new Error("chunkSize must be >= 1");
  const out: ExpectedOut[][] = [];
  for (let i = 0; i < plans.length; i += chunkSize) {
    out.push(plans.slice(i, i + chunkSize));
  }
  return out;
}

function estimateUsdValue(
  totals: { expected_x_total: string; expected_y_total: string },
  pool: Pick<PoolMeta, "token_x_decimals" | "token_y_decimals">,
  prices: { x_usd: number | null; y_usd: number | null }
): { usd_x: number; usd_y: number; usd_total: number } {
  const xAmount = Number(BigInt(totals.expected_x_total)) / 10 ** pool.token_x_decimals;
  const yAmount = Number(BigInt(totals.expected_y_total)) / 10 ** pool.token_y_decimals;
  const usdX = prices.x_usd != null ? xAmount * prices.x_usd : 0;
  const usdY = prices.y_usd != null ? yAmount * prices.y_usd : 0;
  return { usd_x: usdX, usd_y: usdY, usd_total: usdX + usdY };
}

function isPlausibleStxAddress(raw: string): boolean {
  return /^SP[0-9A-HJ-NP-Z]{25,41}$/i.test(raw.trim());
}

// ─── Interactive password prompt (TTY-only) ──────────────────────────────────

/**
 * Prompt the user for their wallet password interactively. Echo is suppressed
 * so the password never appears in the terminal, shell history, `ps` output,
 * or logs. Fails loudly if stdin is not a TTY — write operations require a
 * human at the keyboard, by policy. No --password flag, no env-var fallback.
 */
async function promptPasswordInteractive(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Wallet password must be entered interactively. This command requires a TTY — " +
        "pipes, background jobs, Docker cron, and non-interactive runners are not supported. " +
        "Run this skill attached to a terminal."
    );
  }
  process.stderr.write("Wallet password: ");
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (value: string): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done(buf);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          reject(new Error("Password entry aborted"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ─── Output + logging ─────────────────────────────────────────────────────────

function out(status: string, action: string, data: unknown, error: string | null = null): void {
  console.log(
    JSON.stringify(
      { status, action, data, error },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2
    )
  );
}

function log(...args: unknown[]): void {
  process.stderr.write(`[position-exit] ${args.join(" ")}\n`);
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// 404 = valid empty state (wallet has no position in the pool). Non-404 errors
// still throw.
async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Bitflow reads ────────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMetaWithPrices[]> {
  // Bitflow App pools endpoint migrated to camelCase + nested tokens.tokenX/tokenY
  // shape (Apr 2026). Old snake_case flat fields are kept as fallbacks.
  const raw = await fetchJson<{ data?: unknown[]; pools?: unknown[]; [k: string]: unknown }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const list = (raw.data ?? raw.pools ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  return list.map((p) => {
    const tokens = (p.tokens ?? {}) as { tokenX?: Record<string, unknown>; tokenY?: Record<string, unknown> };
    const tx = tokens.tokenX ?? {};
    const ty = tokens.tokenY ?? {};
    const parsePrice = (t: Record<string, unknown>): number | null => {
      const n = Number(t.priceUsd);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
      pool_id: String(p.poolId ?? p.pool_id ?? ""),
      pool_contract: String(p.poolContract ?? p.pool_token ?? ""),
      token_x: String(tx.contract ?? p.token_x ?? ""),
      token_y: String(ty.contract ?? p.token_y ?? ""),
      token_x_symbol: String(tx.symbol ?? p.token_x_symbol ?? "?"),
      token_y_symbol: String(ty.symbol ?? p.token_y_symbol ?? "?"),
      token_x_decimals: Number(tx.decimals ?? p.token_x_decimals ?? 8),
      token_y_decimals: Number(ty.decimals ?? p.token_y_decimals ?? 6),
      active_bin: Number(p.activeBin ?? p.active_bin ?? 0),
      bin_step: Number(p.binStep ?? p.bin_step ?? 0),
      token_x_usd: parsePrice(tx),
      token_y_usd: parsePrice(ty),
    };
  });
}

async function fetchPoolBins(poolId: string): Promise<{
  active_bin_id: number;
  bins: Array<{ bin_id: number; reserve_x: string; reserve_y: string; price: string; liquidity: string }>;
}> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins };
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  // User positions endpoint returns DLP shares only — no per-bin reserves.
  // expectedAndSlippage falls back to pool reserves + DLP share math when
  // reserve_x/reserve_y are "0", which is the expected path here.
  // 404 = wallet has no position in the pool. Return empty.
  const raw = await fetchJsonOrNull<Record<string, unknown>>(
    `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
  );
  if (raw === null) return [];
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")) > 0n)
    .map((b) => ({
      bin_id: Number(b.bin_id ?? b.binId),
      liquidity: String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
      reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`
  );
  const nextNonce = data.possible_next_nonce;
  if (nextNonce !== undefined && nextNonce !== null) return BigInt(Number(nextNonce));
  const lastExec = data.last_executed_tx_nonce;
  if (lastExec !== undefined && lastExec !== null) return BigInt(Number(lastExec) + 1);
  return 0n;
}

async function fetchMempoolDepth(wallet: string): Promise<number> {
  // Guardrail: abort if the sender has pending txs. Prevents the stuck-pending
  // class where a withdraw appears to succeed but blocks the next write on the
  // same nonce.
  try {
    const raw = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/address/${wallet}/mempool`
    );
    const results = (raw.results ?? []) as unknown[];
    return Array.isArray(results) ? results.length : 0;
  } catch {
    return 0;
  }
}

// ─── Wallet loader ────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (!fs.existsSync(WALLETS_FILE)) {
    throw new Error(
      "No wallet found. Install via: npx @aibtc/mcp-server@latest --install"
    );
  }
  const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  const activeWallet = (walletsJson.wallets ?? [])[0];
  if (!activeWallet?.id) throw new Error("No active wallet registered");

  const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
  if (!fs.existsSync(keystorePath)) throw new Error(`Keystore missing: ${keystorePath}`);

  const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
  const enc = keystore.encrypted;
  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (enc?.ciphertext) {
    const { scryptSync, createDecipheriv } = await import("crypto");
    const salt = Buffer.from(enc.salt, "base64");
    const iv = Buffer.from(enc.iv, "base64");
    const authTag = Buffer.from(enc.authTag, "base64");
    const ciphertext = Buffer.from(enc.ciphertext, "base64");
    const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
      N: enc.scryptParams?.N ?? 16384,
      r: enc.scryptParams?.r ?? 8,
      p: enc.scryptParams?.p ?? 1,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8").trim();
    const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
    const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
    return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
  }
  const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
  if (legacyEnc) {
    const { decryptMnemonic } = await import("@stacks/encryption" as string);
    const mnemonic = await decryptMnemonic(legacyEnc, password);
    const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
    const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
    return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
  }
  throw new Error("Keystore format unrecognized");
}

// ─── Cooldown state ───────────────────────────────────────────────────────────

function loadState(): CooldownState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as CooldownState;
  } catch {
    return {};
  }
}

function saveState(state: CooldownState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cooldownRemainingMs(state: CooldownState, poolId: string): number {
  const entry = state[poolId];
  if (!entry) return 0;
  const elapsed = Date.now() - new Date(entry.last_exit_at).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

// ─── On-chain execution ───────────────────────────────────────────────────────

async function executeWithdraw(
  privateKey: string,
  pool: PoolMeta,
  plans: ExpectedOut[],
  aggregate: { min_x_total: string; min_y_total: string },
  nonce: bigint
): Promise<string> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const [poolAddr, poolName] = pool.pool_contract.split(".");
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");

  const positionsList = plans.map((p) =>
    tupleCV({
      amount: uintCV(BigInt(p.amount_dlp)),
      "bin-id": intCV(toContractBinId(p.bin_id)),
      "min-x-amount": uintCV(BigInt(p.min_x)),
      "min-y-amount": uintCV(BigInt(p.min_y)),
      "pool-trait": contractPrincipalCV(poolAddr, poolName),
    })
  );

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "withdraw-liquidity-same-multi",
    functionArgs: [
      listCV(positionsList),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      uintCV(BigInt(aggregate.min_x_total)),
      uintCV(BigInt(aggregate.min_y_total)),
    ],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditions: [],
    // Slippage enforcement: the router's `min-x-amount-total` + `min-y-amount-total`
    // args are the authoritative slippage gate (contract-level revert on violation,
    // equivalent to ERR_MINIMUM_RECEIVED). DLP burn is internal bin-level
    // accounting — not a SIP-010 FT — so there is no sender-side token outflow
    // to pin with post-conditions. Same precedent as merged `hodlmm-move-liquidity`
    // (aibtcdev/skills PR #317) which uses Allow for its equivalent DLP
    // mint-and-burn flow. Tightening to Deny would require asserting every
    // internal principal-to-principal token flow the router emits — tested
    // against mainnet tx `be20b594…` (successful, 11-bin exit, 2026-04-19).
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 50000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(
      `Withdraw broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`
    );
  }
  return result.txid as string;
}

// ─── Plan builder ─────────────────────────────────────────────────────────────

interface PlanOptions {
  pool: string;
  address: string;
  bins?: string;
  all?: boolean;
  inactiveOnly?: boolean;
  slippageBps: string;
  minPositionUsd: string;
}

interface PlanVerdict {
  pool: PoolMetaWithPrices;
  active_bin: number;
  selected_bins: number[];
  missing_bins: number[];
  plans: ExpectedOut[];
  chunks: ExpectedOut[][];
  aggregate: ReturnType<typeof aggregateTotals>;
  usd: ReturnType<typeof estimateUsdValue>;
  cooldown_remaining_ms: number;
  slippage_bps: number;
  min_position_usd: number;
  blockers: string[];
  safe_to_broadcast: boolean;
}

async function buildPlan(opts: PlanOptions): Promise<PlanVerdict> {
  if (!isPlausibleStxAddress(opts.address)) {
    throw new Error(`Invalid STX address: ${opts.address}`);
  }
  const slippageBps = parseInt(opts.slippageBps, 10);
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("--slippage-bps must be an integer in [0, 10000]");
  }
  const minPositionUsd = parseFloat(opts.minPositionUsd);
  if (!Number.isFinite(minPositionUsd) || minPositionUsd < 0) {
    throw new Error("--min-position-usd must be a non-negative number");
  }
  const selector = parseBinSelector({
    bins: opts.bins,
    all: opts.all,
    inactiveOnly: opts.inactiveOnly,
  });

  const [pools, poolBins, userBins] = await Promise.all([
    fetchPools(),
    fetchPoolBins(opts.pool),
    fetchUserPositions(opts.pool, opts.address),
  ]);
  const pool = pools.find((p) => p.pool_id === opts.pool);
  if (!pool) throw new Error(`Pool not found: ${opts.pool}`);

  const { selected, missing } = resolveBins(userBins, poolBins.active_bin_id, selector);
  const poolBinMap = new Map(poolBins.bins.map((b) => [b.bin_id, b]));
  const plans = selected.map((b) =>
    expectedAndSlippage(b, poolBinMap.get(b.bin_id), slippageBps)
  );
  const aggregate = aggregateTotals(plans);
  const chunks = chunkPlans(plans);

  const usd = estimateUsdValue(aggregate, pool, {
    x_usd: pool.token_x_usd,
    y_usd: pool.token_y_usd,
  });
  const cooldown = cooldownRemainingMs(loadState(), opts.pool);

  const blockers: string[] = [];
  if (plans.length === 0) blockers.push("No bins selected — nothing to exit");
  if (missing.length > 0) blockers.push(`Unknown bins for this position: ${missing.join(",")}`);
  if (chunks.length === 0) blockers.push("Empty chunk plan");
  if (cooldown > 0) {
    blockers.push(`Pool cooldown: ${Math.round(cooldown / 60_000)}m remaining`);
  }
  if (usd.usd_total > 0 && usd.usd_total < minPositionUsd) {
    blockers.push(`Position value $${usd.usd_total.toFixed(2)} < floor $${minPositionUsd}`);
  }
  if (chunks.some((c) => c.length > CHUNK_SIZE)) {
    blockers.push(`One or more chunks exceed safety cap ${CHUNK_SIZE}`);
  }

  return {
    pool,
    active_bin: poolBins.active_bin_id,
    selected_bins: selected.map((b) => b.bin_id),
    missing_bins: missing,
    plans,
    chunks,
    aggregate,
    usd,
    cooldown_remaining_ms: cooldown,
    slippage_bps: slippageBps,
    min_position_usd: minPositionUsd,
    blockers,
    safe_to_broadcast: blockers.length === 0,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function buildProgram(): Command {
  const program = new Command();
  program
    .name("hodlmm-position-exit")
    .description(
      "Pure-exit skill for HODLMM concentrated-liquidity positions. Withdraws user DLP from selected bins back to the wallet — no rebalance, no redeploy, no cross-protocol rotation."
    )
    .version("0.1.0");

  program
    .command("doctor")
    .description("Reachability + wallet + router sanity check. No writes.")
    .option("--wallet <address>", "STX address to test balance/nonce reads against")
    .action(async (opts: { wallet?: string }) => {
      const checks: Record<string, { ok: boolean; detail: string }> = {};
      try {
        const pools = await fetchPools();
        checks.bitflow_pools = {
          ok: pools.length > 0,
          detail: `${pools.length} HODLMM pools`,
        };
      } catch (e) {
        checks.bitflow_pools = { ok: false, detail: (e as Error).message };
      }
      try {
        const data = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/dlmm_1`);
        checks.bitflow_bins = { ok: !!data.active_bin_id, detail: `active_bin=${data.active_bin_id}` };
      } catch (e) {
        checks.bitflow_bins = { ok: false, detail: (e as Error).message };
      }
      try {
        const info = await fetchJson<Record<string, unknown>>(`${HIRO_API}/v2/info`);
        checks.hiro_api = {
          ok: !!info.stacks_tip_height,
          detail: `tip=${info.stacks_tip_height}`,
        };
      } catch (e) {
        checks.hiro_api = { ok: false, detail: (e as Error).message };
      }
      try {
        const url = `${HIRO_API}/v2/contracts/interface/${ROUTER_ADDR}/${ROUTER_NAME}`;
        const iface = await fetchJson<Record<string, unknown>>(url);
        const fns = ((iface.functions ?? []) as Array<{ name: string }>).map((f) => f.name);
        const hasWithdraw = fns.includes("withdraw-liquidity-same-multi");
        checks.router_contract = {
          ok: hasWithdraw,
          detail: hasWithdraw
            ? `${ROUTER_ADDR}.${ROUTER_NAME}`
            : `withdraw-liquidity-same-multi missing from ${ROUTER_NAME}`,
        };
      } catch (e) {
        checks.router_contract = { ok: false, detail: (e as Error).message };
      }
      if (opts.wallet) {
        try {
          const nonce = await fetchNonce(opts.wallet);
          const mempool = await fetchMempoolDepth(opts.wallet);
          checks.wallet = {
            ok: true,
            detail: `nonce=${nonce}, mempool_depth=${mempool}`,
          };
        } catch (e) {
          checks.wallet = { ok: false, detail: (e as Error).message };
        }
      }
      const allOk = Object.values(checks).every((c) => c.ok);
      out(allOk ? "ok" : "degraded", "doctor", { checks });
    });

  program
    .command("status")
    .description("List the wallet's bins in a HODLMM pool with token balances. Read-only.")
    .requiredOption("--pool <id>", "Bitflow pool id (e.g. dlmm_1)")
    .requiredOption("--address <stx>", "STX address of the position holder")
    .action(async (opts: { pool: string; address: string }) => {
      if (!isPlausibleStxAddress(opts.address)) {
        out("error", "status", null, `Invalid STX address: ${opts.address}`);
        process.exit(1);
      }
      try {
        const [pools, poolBins, userBins] = await Promise.all([
          fetchPools(),
          fetchPoolBins(opts.pool),
          fetchUserPositions(opts.pool, opts.address),
        ]);
        const pool = pools.find((p) => p.pool_id === opts.pool);
        if (!pool) {
          out("error", "status", null, `Pool not found: ${opts.pool}`);
          process.exit(1);
        }
        const poolBinMap = new Map(poolBins.bins.map((b) => [b.bin_id, b]));
        const bins = userBins.map((b) => {
          const exp = expectedAndSlippage(b, poolBinMap.get(b.bin_id), 0);
          return {
            bin_id: b.bin_id,
            is_active: b.bin_id === poolBins.active_bin_id,
            dlp: b.liquidity,
            expected_x: exp.expected_x,
            expected_y: exp.expected_y,
            price: b.price,
          };
        });
        const totals = aggregateTotals(
          userBins.map((b) => expectedAndSlippage(b, poolBinMap.get(b.bin_id), 0))
        );
        out("ok", "status", {
          pool: pool.pool_id,
          pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
          active_bin: poolBins.active_bin_id,
          bin_count: bins.length,
          bins,
          totals: {
            dlp: totals.dlp_total,
            expected_x: totals.expected_x_total,
            expected_y: totals.expected_y_total,
          },
        });
      } catch (e) {
        out("error", "status", null, (e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("plan")
    .description(
      "Dry-run: classify a proposed withdraw against the wallet's current position. Emits per-bin expected X/Y, aggregate min-out (post-slippage), tx-chunk plan, and triple-gate verdict. Does not sign or broadcast."
    )
    .requiredOption("--pool <id>", "Bitflow pool id")
    .requiredOption("--address <stx>", "STX address of the position holder")
    .option("--bins <csv>", "Comma-separated bin ids to exit (mutually exclusive with --all / --inactive-only)")
    .option("--all", "Exit every bin in the position")
    .option("--inactive-only", "Exit every bin except the active one")
    .option("--slippage-bps <n>", "Per-bin slippage floor in basis points (500 = 5%)", String(DEFAULT_SLIPPAGE_BPS))
    .option(
      "--min-position-usd <n>",
      "Gate: reject the plan if total position value < this USD floor",
      String(MIN_POSITION_USD_DEFAULT)
    )
    .action(async (opts: PlanOptions) => {
      try {
        const verdict = await buildPlan(opts);
        out(verdict.safe_to_broadcast ? "ok" : "blocked", "plan", verdict);
      } catch (e) {
        out("error", "plan", null, (e as Error).message);
        process.exit(1);
      }
    });

  interface WithdrawOptions extends PlanOptions {
    confirm?: boolean;
  }

  program
    .command("withdraw")
    .description(
      "Execute the withdraw on mainnet. Requires --confirm. Triple-gated: (1) plan verdict must be safe_to_broadcast, (2) position USD ≥ --min-position-usd, (3) --confirm flag. Mempool depth + 4h cooldown additionally enforced. Password entered interactively — no flag, no env var, no stored credential paths."
    )
    .requiredOption("--pool <id>", "Bitflow pool id")
    .requiredOption("--address <stx>", "STX address (must match wallet)")
    .option("--bins <csv>", "Comma-separated bin ids")
    .option("--all", "Exit every bin")
    .option("--inactive-only", "Exit every bin except the active one")
    .option("--slippage-bps <n>", "Per-bin slippage floor bps", String(DEFAULT_SLIPPAGE_BPS))
    .option("--min-position-usd <n>", "Min position USD gate", String(MIN_POSITION_USD_DEFAULT))
    .option("--confirm", "Required to broadcast. Without it the command exits at the plan stage.")
    .action(async (opts: WithdrawOptions) => {
      try {
        const verdict = await buildPlan(opts);
        if (!verdict.safe_to_broadcast) {
          out("blocked", "withdraw", verdict);
          process.exit(1);
        }
        if (!opts.confirm) {
          out("dry-run", "withdraw", { ...verdict, note: "Pass --confirm to broadcast" });
          return;
        }
        // Show the user the write they're about to authorize, then prompt for
        // the password. Explicit amount confirmation is the second half of the
        // wallet-safety policy: user sees what will move BEFORE entering the
        // password, and the password is collected only once the plan is on-screen.
        process.stderr.write(
          [
            "",
            "══ CONFIRM WITHDRAWAL ══",
            `  pool:        ${verdict.pool.pool_id} (${verdict.pool.token_x_symbol}/${verdict.pool.token_y_symbol})`,
            `  bins:        ${verdict.selected_bins.length} (${verdict.selected_bins.join(",")})`,
            `  expected:    ${verdict.aggregate.expected_x_total} ${verdict.pool.token_x_symbol} (raw) + ${verdict.aggregate.expected_y_total} ${verdict.pool.token_y_symbol} (raw)`,
            `  min-out:     ${verdict.aggregate.min_x_total} / ${verdict.aggregate.min_y_total} (${verdict.slippage_bps} bps slippage floor)`,
            `  usd:         ~$${verdict.usd.usd_total.toFixed(2)}`,
            `  chunks:      ${verdict.chunks.length} tx`,
            `  wallet:      ${opts.address}`,
            "",
            "Enter your wallet password to sign. Password will not be echoed.",
            "",
          ].join("\n")
        );
        const password = await promptPasswordInteractive();
        if (password.length === 0) {
          out("error", "withdraw", null, "Empty password — aborted");
          process.exit(1);
        }
        const { stxPrivateKey, stxAddress } = await getWalletKeys(password);
        if (stxAddress !== opts.address) {
          out("error", "withdraw", null, `Wallet address ${stxAddress} != --address ${opts.address}`);
          process.exit(1);
        }
        const mempool = await fetchMempoolDepth(stxAddress);
        if (mempool > 0) {
          out(
            "blocked",
            "withdraw",
            { ...verdict, mempool_depth: mempool },
            `Mempool has ${mempool} pending tx(s) on sender; aborting per depth guard`
          );
          process.exit(1);
        }
        let nonce = await fetchNonce(stxAddress);
        const txids: string[] = [];
        for (let i = 0; i < verdict.chunks.length; i++) {
          const chunk = verdict.chunks[i];
          log(`Broadcasting chunk ${i + 1}/${verdict.chunks.length} (${chunk.length} bins)`);
          const txid = await executeWithdraw(
            stxPrivateKey,
            verdict.pool,
            chunk,
            verdict.aggregate,
            nonce
          );
          txids.push(txid);
          nonce += 1n;
        }
        const state = loadState();
        state[opts.pool] = { last_exit_at: new Date().toISOString() };
        saveState(state);
        out("broadcast", "withdraw", {
          pool: opts.pool,
          bin_count: verdict.selected_bins.length,
          chunk_count: verdict.chunks.length,
          txids: txids.map((t) => ({ txid: t, explorer: `${EXPLORER}/0x${t}?chain=mainnet` })),
          aggregate: verdict.aggregate,
        });
      } catch (e) {
        out("error", "withdraw", null, (e as Error).message);
        process.exit(1);
      }
    });

  return program;
}

// Entry-point guard so the file can be imported (tests, sibling skills) without
// Commander calling process.exit on the host test-runner's argv.
if (import.meta.main) {
  buildProgram().parse(process.argv);
}
