#!/usr/bin/env bun
/**
 * Stacks Alpha Engine
 * Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM (Bitflow DLMM).
 * Scans ALL relevant tokens (sBTC, STX, USDCx, USDh, sUSDh, aeUSDC), reads positions
 * across 4 protocols, compares yield options (direct + swap-then-deploy), verifies sBTC
 * reserve integrity via BIP-341 P2TR derivation, checks market safety gates, then
 * executes deploy/withdraw/rebalance/migrate/emergency operations.
 *
 * Architecture:
 *   SCOUT    -> wallet scan (7 tokens), positions (4 protocols), yields, break prices
 *   RESERVE  -> sBTC Proof-of-Reserve (P2TR derivation, BTC balance, GREEN/YELLOW/RED)
 *   GUARDIAN -> slippage, volume, gas, cooldown, relay health, price source gates
 *   EXECUTOR -> deploy, withdraw, rebalance, migrate, emergency
 *
 * Safety: every write runs Scout -> Reserve -> Guardian -> Executor. The single exception is `emergency`, which bypasses both gates deliberately.
 *
 * Protocols & tokens:
 *   Zest: supply/withdraw sBTC; borrow/repay USDh  (MCP native zest_supply/withdraw/borrow/repay)
 *   Hermetica: stake USDh -> sUSDh                       (call_contract staking-v1-1)
 *   Granite: deposit aeUSDC to LP                      (call_contract liquidity-provider-v1)
 *   HODLMM: LP in sBTC/STX/USDCx/USDh/aeUSDC pools   (Bitflow skill)
 *
 * Usage:
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts doctor
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts scan --wallet <STX_ADDRESS>
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts deploy --wallet <SP...> --protocol hermetica --token usdh --amount 1000000
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts withdraw --wallet <SP...> --protocol zest --token sbtc
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts rebalance --wallet <SP...> --pool-id dlmm_1
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts migrate --wallet <SP...> --from zest --to hermetica --amount 1000000
 *   bun run stacks-alpha-engine/stacks-alpha-engine.ts emergency --wallet <SP...>
 */

import { createHash } from "crypto";
import { Command }    from "commander";
import { homedir }    from "os";
import { join }       from "path";
import { readFileSync, writeFileSync } from "fs";
import * as ecc       from "tiny-secp256k1";

// == Constants ================================================================
const FETCH_TIMEOUT_MS    = 30_000;
/**
 * Where the Stacks reads go.
 *
 * Overridable because of a limit measured on 2026-09-12, and because of the rule
 * that shaped the fix. One deposit makes 46 requests to this host, counted with
 * a tally on every outbound call. Hiro allows 50 A MINUTE without a key and 500
 * with one, so a single deposit consumes 92% of the anonymous budget and the app
 * adds its own reads on top. It fails by a hair, every time.
 *
 * The obvious repair, hand this skill an API key, is refused by the app on
 * purpose. Its runner hands every skill a scrubbed environment because "a skill
 * is somebody else's code running on our machine, and everything it can read it
 * can also print", and it names a credential it deliberately withholds. That
 * rule does not distinguish this repo's skills from a stranger's, and spending it
 * to save an afternoon is how a rule stops meaning anything.
 *
 * So the skill is told an ADDRESS instead, which is not a credential and carries
 * nothing worth printing. Whoever runs it can put an authenticated hop in front
 * of Hiro and keep the key on their own side. Unset, this is exactly the public
 * host it has always used, so a caller that sets nothing is unaffected.
 *
 * The second reason is testing: with this hardcoded, nothing could point the
 * engine at a stub chain. The app has had `HIRO_API` for its own reads for that
 * reason, and this is the same name so an operator learns one thing, not two.
 */
const HIRO_API            = process.env.HIRO_API || "https://api.mainnet.hiro.so";
const TENERO_API          = "https://api.tenero.io";
const BITFLOW_API         = "https://bff.bitflowapis.finance";
const MEMPOOL_API         = "https://mempool.space/api";

// Guardian thresholds
const MIN_24H_VOLUME_USD  = 10_000;
const MAX_SLIPPAGE_PCT    = 0.5;
const MAX_GAS_STX         = 50;
// The transaction size the gas estimate assumes. It was a bare 3600 sitting in the
// arithmetic, which made the STX figure look measured when only the RATE is. The
// rate itself comes from Hiro's TRANSFER fee estimate, not a contract call one,
// which is why the row says so.
//
// THIS NUMBER DISAGREES WITH THE KB AND NOTHING RECORDS WHY. The private KB's fee
// guidance and its pre-push checklist both say "rate times a byte budget" with
// about 500 bytes for a typical swap, and `smartx-app/src/plan/fee.ts` uses 500.
// 3600 is 7.2 times that. A multi-bin add-liquidity IS larger than a swap, so a
// bigger budget is arguable, but nobody wrote down the argument or measured a real
// transaction, and this unexplained 7.2x is precisely what produced a user-facing
// fee figure six times too high before it was caught.
//
// It is left at 3600 rather than changed to 500 on a guess: this figure feeds only
// the ranking divisor and this gate's own cap, never a fee anybody pays, so moving
// it silently changes how options are ranked for no verified reason. Measuring an
// actual add-liquidity transaction and reconciling the two is a Phase 8 item.
const GAS_ASSUMED_TX_BYTES = 3600;
// THIS FILE DOES NOT KNOW WHAT SMARTX CHARGES, and it used to say that it did.
//
// A constant here named SMARTX_MIN_FEE_STX = 0.25 was multiplied against
// GAS_ASSUMED_TX_BYTES and rendered as "expect about N STX". The real fee is set
// in `smartx-app/src/plan/fee.ts` as `max(rate * 500 bytes, 250_000 microSTX)`.
// The byte budget there is 500, not 3600, so the row overstated the fee by up to
// 7.2 times: at a rate of 418 it said 1.50 STX where the user pays 0.25 STX.
//
// Worse, an earlier comment here said the network estimate sits below the 0.25
// floor "in every ordinary case", and a later edit called that wrong on the
// strength of sampling the 3600 byte figure. In fee terms the floor binds until
// the rate exceeds 500 microSTX per byte.
//
// Do not read a fixed answer out of that either. Rates sampled on 2026-08-28 ran
// 6, 32, 105, 147, 188, 253, 293, 418 and 585 microSTX per byte within a few
// hours. Most are below 500 and at least one is above, so the floor USUALLY binds
// and sometimes does not. A previous version of this comment said "every one of
// them", and the next sample refuted it the same day. This is a volatile,
// congestion driven number: state what was sampled and when, never a rule.
//
// The lesson is the one this project already wrote down: check a hard number
// against its source before publishing it. The source was one file in the sibling
// repo. Restating those two constants here would recreate the same split, two
// places answering one question and drifting apart, so the row now reports only
// what this file measured and says plainly that the fee is set elsewhere.
const COOLDOWN_HOURS      = 4;
const PRICE_SCALE         = 1e8;
const BIN_PRICE_SCALE     = 1e6;  // HODLMM bin price precision
const STATE_FILE          = join(homedir(), ".stacks-alpha-engine-state.json");

// PoR thresholds
const THRESHOLD_GREEN     = 0.999;
const THRESHOLD_YELLOW    = 0.995;
const ROTATION_THRESHOLD  = 0.50;

// -- Token contracts ----------------------------------------------------------
const SBTC_TOKEN          = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX_TOKEN         = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const AEUSDC_TOKEN        = "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc";
const USDH_TOKEN          = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1";
const SUSDH_TOKEN         = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.susdh-token-v1";
const SBTC_REGISTRY       = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_REGISTRY_NAME  = "sbtc-registry";

// -- Protocol contracts -------------------------------------------------------
// Zest v2
const ZEST_VAULT_SBTC     = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc";
// Zest V2, read on mainnet 2026-09-13. `v0-assets` lists each coin at an even id
// and its vault's share token at the next odd id. A deposit through `v0-4-market`
// moves those shares into `v0-market-vault` as collateral, so the wallet's own
// share balance reads zero for somebody who has supplied: reading only the wallet
// told a holder of 1.56 sBTC they had nothing on Zest. Both places are read.
const ZEST_DEPLOYER       = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const ZEST_MARKET_VAULT   = `${ZEST_DEPLOYER}.v0-market-vault`;
export const ZEST_ASSETS: ReadonlyArray<{ symbol: string; shareAid: number; vault: string; decimals: number }> = [
  { symbol: "STX",      shareAid: 1,  vault: `${ZEST_DEPLOYER}.v0-vault-stx`,      decimals: 6 },
  { symbol: "sBTC",     shareAid: 3,  vault: ZEST_VAULT_SBTC,                      decimals: 8 },
  { symbol: "stSTX",    shareAid: 5,  vault: `${ZEST_DEPLOYER}.v0-vault-ststx`,    decimals: 6 },
  { symbol: "USDCx",    shareAid: 7,  vault: `${ZEST_DEPLOYER}.v0-vault-usdc`,     decimals: 6 },
  { symbol: "USDh",     shareAid: 9,  vault: `${ZEST_DEPLOYER}.v0-vault-usdh`,     decimals: 8 },
  { symbol: "stSTXbtc", shareAid: 11, vault: `${ZEST_DEPLOYER}.v0-vault-ststxbtc`, decimals: 6 },
];
/** What `v0-market-vault.get-position` returns for an address Zest has never seen: "none", not a failure. */
const ZEST_ERR_NO_ACCOUNT = 600006n;
const MAX_U128            = (1n << 128n) - 1n;

// Hermetica
const HERMETICA           = "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG";
const HERMETICA_STAKING   = `${HERMETICA}.staking-v1-1`;
const HERMETICA_SILO      = `${HERMETICA}.staking-silo-v1-1`;

// Granite
const GRANITE_STATE       = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const GRANITE_IR          = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.linear-kinked-ir-v1";
const GRANITE_LP          = "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS.liquidity-provider-v1";

// Bitflow DLMM swap router
const DLMM_SWAP_ROUTER    = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
/**
 * The trait a DLMM pool binds for STX, which is NOT the string "stx".
 *
 * STX is not a fungible token contract, so `TOKENS.stx.contract` is the literal
 * "stx", which is fine for a balance lookup and useless as a trait argument: a
 * caller turning it into a principal throws, and a caller that somehow did not
 * would abort anyway, because `dlmm-core` asserts
 * `(is-eq (contract-of x-token-trait) x-token)` and the pool binds this wrapper.
 * Read from `get-pool` on dlmm_3 and dlmm_6.
 *
 * The wrapper's own `transfer` performs a real `stx-transfer?`, so a post
 * condition on this side is still an `stx` condition and not a token one.
 */
const STX_TOKEN_TRAIT     = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";

/** The trait argument a pool expects for a token, which STX spells differently. */
function traitFor(token: string): string {
  return token === "stx" ? STX_TOKEN_TRAIT : (TOKENS[token]?.contract ?? token);
}
const DLMM_SWAP_ROUTER_NAME = "dlmm-swap-router-v-1-1";

// HODLMM
const DLMM_CORE           = "SP1PFR4V08H1RAZXREBGFFQ59WB739XM8VVGTFSEA.dlmm-core-v-1-1";
const HODLMM_POOLS: PoolDef[] = [
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

// Token metadata for yield calculations
interface TokenMeta { symbol: string; contract: string; decimals: number; ftSuffix: string }
const TOKENS: Record<string, TokenMeta> = {
  sbtc:   { symbol: "sBTC",   contract: SBTC_TOKEN,   decimals: 8, ftSuffix: "::sbtc-token" },
  stx:    { symbol: "STX",    contract: "stx",        decimals: 6, ftSuffix: "" },
  // ftSuffix is the Clarity asset name, which is the argument to `define-fungible-token`
  // in the token contract, NOT the contract name and NOT the ticker. Every entry below was
  // read from the deployed contract source on 2026-08-12. Four of these six were previously
  // wrong, and a post-condition naming an asset that does not exist covers nothing, so the
  // transaction aborts with abort_by_post_condition. That is not hypothetical: mainnet tx
  // 0x778632893965126456fe95a974c66fdb8962df58a2fe4dbea1e7a675b8de6da0 is a Granite deposit
  // that used the old "bridged-usdc" spelling and aborted exactly that way.
  // Case matters: aeUSDC is capitalised on chain.
  usdcx:  { symbol: "USDCx",  contract: USDCX_TOKEN,  decimals: 6, ftSuffix: "::usdcx-token" },
  usdh:   { symbol: "USDh",   contract: USDH_TOKEN,   decimals: 8, ftSuffix: "::usdh" },
  susdh:  { symbol: "sUSDh",  contract: SUSDH_TOKEN,  decimals: 8, ftSuffix: "::susdh" },
  aeusdc: { symbol: "aeUSDC", contract: AEUSDC_TOKEN, decimals: 6, ftSuffix: "::aeUSDC" },
};

// Reverse lookup: token contract principal → TokenMeta. Used to derive asset_name + decimals
// from on-chain route data (xToken/yToken/xForY) when building DLMM swap post-conditions.
const TOKENS_BY_CONTRACT: Record<string, TokenMeta> = Object.fromEntries(
  Object.values(TOKENS).filter(t => t.contract !== "stx").map(t => [t.contract, t]),
);

// == Types ====================================================================
interface PoolDef { id: number; contract: string; name: string; tokenX: string; tokenY: string }
interface TokenBalance {
  amount: number; usd: number;
  /**
   * The balance in the token's smallest unit, exactly as Hiro returned it. Every balance
   * check reads this, never `amount`, which is a float for display (KB: amounts are
   * integers end to end, never a float round trip).
   */
  atomic: string;
}
interface WalletBalances {
  sbtc: TokenBalance; stx: TokenBalance; usdcx: TokenBalance;
  usdh: TokenBalance; susdh: TokenBalance; aeusdc: TokenBalance;
}

/**
 * Which of the reads behind `balances` and `prices` actually returned.
 *
 * A FAILED READ AND A GENUINE ZERO ARE NOT THE SAME FACT and this file used to
 * publish them as the same number. Every upstream read in the scout is wrapped
 * in `.catch(() => null)`, and a null Hiro response then flows into
 * `BigInt(... ?? "0")`, so a rate-limited balance read produces a wallet of
 * exactly zero of everything. A production audit provoked it with a Hiro HTTP
 * 429 and the report told the holder of $3.93 that they had "Wallet Total $0"
 * and "No yield opportunities available for your current holdings". Both
 * sentences are false, and false in the direction that makes a person act:
 * somebody who believes their wallet is empty goes looking for what went wrong
 * with their money.
 *
 * The count of `data_sources` cannot stand in for this. There are eight sources
 * and only four are needed for the old "ok", so the one read that carries the
 * person's own money can fail while the run still calls itself healthy: an
 * observed failure run kept SEVEN sources and reported `status: "ok"` with
 * `hiro-balances` quietly absent from the list. `smartx-app/server.ts` records
 * the same trap against the sibling skill and notes that no server-side check
 * can see it, because the only evidence was that one string missing from an
 * array. So the scout states it in a field instead of leaving it to be inferred.
 *
 * These flags describe the READ, never the value. A wallet that truly holds
 * nothing still reads `balances: true` with every amount at 0, and still renders
 * as $0, because an empty wallet is a real and common state that a person is
 * entitled to see stated plainly.
 *
 * Prices are split from balances because they fail independently and lie
 * differently: a dead price feed leaves the AMOUNTS correct and zeroes only the
 * USD column. A price of 0 counts as unavailable rather than as a quote, since
 * no token here is ever genuinely worth nothing; that is what a schema change or
 * an empty body looks like coming out of `?? 0`.
 */
interface ScoutAvailability {
  /** The Hiro address-balances read returned. False means every amount is unknown, NOT zero. */
  balances: boolean;
  /** A usable sBTC price came back. False means the sBTC USD column is unknown. */
  price_sbtc: boolean;
  /** A usable STX price came back. False means the STX USD column is unknown. */
  price_stx: boolean;
  /** Plain names of the reads that did not return, for a person to read directly. */
  unavailable: string[];
}

interface ZestHolding { asset: string; shares: string; amount: number }
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
  /**
   * The coins this wallet owes Zest. Supplied coins backing a loan cannot all be
   * withdrawn, so a withdraw of "max" against them fails on chain.
   */
  debt?: string[];
  /** The sBTC vault's live supply rate. Absent, never 0, when it could not be read. */
  supply_apy_pct?: number;
  utilization_pct?: number;
  /**
   * The STX and USDCx vaults' live supply rates, for their own deposit rows (later item 1):
   * a deposit is weighed against ITS vault's rate, never the sBTC vault's. A rate that could
   * not be read is absent, so that coin has no row and its deposit is refused for no rate.
   */
  other_rates?: { STX?: { supply_apy_pct: number; utilization_pct: number }; USDCx?: { supply_apy_pct: number; utilization_pct: number } };
}
interface GranitePosition {
  has_position: boolean; detail: string;
  supply_apy_pct?: number; borrow_apr_pct?: number; utilization_pct?: number;
  accepted_token: string; // "aeUSDC", NOT sBTC
  lp_shares?: string; // raw share count from on-chain position
}
interface HermeticaPosition {
  has_position: boolean; detail: string;
  susdh_balance: number; exchange_rate: number; apy_estimate_pct: number;
  staking_enabled: boolean;
}
interface HodlmmUserPool {
  pool_id: number; name: string; in_range: boolean; active_bin: number;
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
  has_position: boolean; pools: HodlmmUserPool[];
  /**
   * Pools whose position could not be read, so whether the wallet holds anything there is
   * unknown. Never folded into "no position": missing from `pools` for that reason it would
   * read as nothing held, and a withdraw or rebalance there would be refused as empty.
   */
  unread: { pool_id: number; name: string }[];
}

type YieldTier = "deploy_now" | "swap_first" | "acquire_to_unlock";

interface YieldOption {
  tier: YieldTier;
  protocol: string; pool: string; token_needed: string; apy_pct: number;
  /**
   * The pool's two tokens, separately, for the protocols that hold two.
   *
   * `token_needed` already carries them, but joined as `sBTC/USDCx`, which is a
   * SENTENCE about the pair rather than a pair. A caller staging a two sided
   * deposit has to know which token each of the person's two amounts belongs
   * to, and splitting a display string to find out is the same mistake this
   * file already carries a scar for: matching on the pool NAME once described
   * the highest APY pool while building instructions for a different one, 377.87%
   * reported against a pool scored 140.4%. `pool_id` was added for that reason,
   * and these are added for the same one.
   *
   * Lower case symbols, matching what `--token` and `--counter-amount` expect,
   * so a caller never has to case-fold a display string to build a command.
   *
   * Absent for the single asset protocols, and the absence is meaningful: it is
   * how a caller knows there is no second side to ask about.
   */
  token_x?: string; token_y?: string;
  /**
   * The router's own pool id, `dlmm_N`, for the protocols that have more than
   * one pool. Absent for the single-pool protocols.
   *
   * Carried because `pool` is a display NAME and `--pool-id` is an id, so there
   * was no way to tell which option a deploy actually targeted. Matching on the
   * protocol alone described the highest-APY pool while building instructions
   * for a different one: 377.87% reported against a pool scored 140.4%.
   */
  /**
   * What the slippage and volume gates concluded about THIS option's pool.
   *
   * Three states, not two, for the same reason those gates have three: a boolean
   * makes "nobody measured this" indistinguishable from "measured and it failed",
   * and only one of those is a reason to avoid the pool. Only the top actionable
   * option is measured per run, so `not-measured` is the common case and it is
   * not a criticism of the pool.
   */
  gates?: "passed" | "failed" | "not-measured";
  /**
   * Which sides of the pair the wallet holds, or `single` for unpaired products.
   *
   * REQUIRED. Optional, it could be dropped from the HODLMM push with the suite
   * green, and then every wallet holding one side was told it held neither,
   * because the sentence falls back to that. A test cannot reach the push site,
   * which does network reads; the compiler can.
   */
  sides: OptionSides;
  pool_id?: string;
  daily_usd: number; monthly_usd: number; gas_to_enter_stx: number;
  swap_cost_note: string | null; note: string;
  ytg_ratio: number;       // 7d projected yield / gas cost in USD (>3 = profitable); set by post-processing
  ytg_profitable: boolean; // true if 7d yield > 3x gas cost; set by post-processing
}

interface BreakPrices {
  hodlmm_range_exit_low_usd: number | null; hodlmm_range_exit_high_usd: number | null;
  current_sbtc_price_usd: number;
}

// PoR types
type PorSignal = "GREEN" | "YELLOW" | "RED" | "DATA_UNAVAILABLE";
interface ReserveResult {
  signal: PorSignal; reserve_ratio: number | null; score: number;
  sbtc_circulating: number; btc_reserve: number; signer_address: string;
  recommendation: string; error?: string;
}

// Guardian types
/**
 * What a gate actually concluded.
 *
 * `unknown` is the one that was missing, and its absence was the defect. A check
 * that could not run reported `ok: true` with a value of `0`, which the report
 * printed as `0% (max 0.5%)`: the most reassuring number the gate can produce,
 * generated by the gate not running. A reader could not tell it from a pool
 * tracking the market perfectly.
 *
 * `not-applicable` is separate from `unknown` on purpose. The slippage and volume
 * gates are properties of a HODLMM pool, so a Zest supply or a Hermetica stake
 * with no swap leg has no pool for them to measure. That is not a failure to
 * check, and it must not block.
 */
type GateStatus = "pass" | "fail" | "unknown" | "not-applicable";

/** A gate measured against one HODLMM pool, and honest about which. */
interface PoolGate {
  /** Safe to proceed on this gate. False for both `fail` and `unknown`. */
  ok: boolean;
  status: GateStatus;
  /** Null whenever nothing was measured. Never a stand-in zero. */
  value: number | null;
  pool_id: string | null;
  pool_name: string | null;
  /** How the number was obtained, or in plain words why it was not. */
  source: string;
}

interface GuardianResult {
  can_proceed: boolean; refusals: string[];
  slippage: PoolGate;
  volume: PoolGate;
  gas: { ok: boolean; status: GateStatus; estimated_stx: number | null; source: string };
  cooldown: { ok: boolean; remaining_hours: number };
  prices: { ok: boolean; detail: string };
}

// Scout result
interface ScoutResult {
  status: "ok" | "degraded" | "error";
  wallet: string;
  /**
   * Read availability for `balances` and `prices`. Read this BEFORE reading a
   * zero out of either: see `ScoutAvailability`.
   */
  available: ScoutAvailability;
  balances: WalletBalances;
  prices: { sbtc: number; stx: number; usdcx: number; usdh: number; aeusdc: number };
  positions: { zest: ZestPosition; hermetica: HermeticaPosition; granite: GranitePosition; hodlmm: HodlmmPositions };
  options: YieldOption[];
  /**
   * Both are null, not 0, when the balance read failed. Zero is a claim about
   * somebody's money and a run that could not read it has not earned the right
   * to make that claim.
   *
   * The two do NOT share one condition, and saying they did was wrong: a dead
   * price feed on a token the person actually holds leaves the amounts correct
   * but makes any dollar TOTAL an understatement, so `idle_capital_usd` also
   * goes null there while `opportunity_cost_daily_usd` stays a number. Written
   * out because a consumer reading "null when the balance read failed" would
   * conclude that `available.balances === true` guarantees a number here, and
   * would then meet a null on a Tenero outage.
   */
  best_move: { recommendation: string; idle_capital_usd: number | null; opportunity_cost_daily_usd: number | null };
  break_prices: BreakPrices;
  data_sources: string[];
}

// Engine output
const DISCLAIMER = "Data-driven yield analysis for informational purposes only. Not financial advice. Past yields do not guarantee future returns. Smart contract risk, impermanent loss, and peg failure are real possibilities. Verify on-chain data independently before acting.";

interface EngineResult {
  /**
   * `degraded` means the run finished but at least one read behind the answer did
   * not return, so part of what is printed is unknown rather than measured. It is
   * a separate outcome from `error` (nothing came back) and from `refused` (a
   * gate ruled against the operation).
   *
   * The top-level status must be derived from the payload's own inner status, not
   * asserted as a constant. `scan` used to hardcode `"ok"` here while
   * `scout.status` next to it said `"degraded"`, which is the same bug the
   * project already recorded once about exit codes: a status field has to read
   * what actually happened. Consumers gate on this string, so a constant "ok"
   * silently promotes an unknown into a fact for every one of them.
   *
   * `preview` was missing from this union while two `return` statements below
   * emitted it, so the type describing the skill's own output did not admit the
   * answer every dry run without `--confirm` gets. Added here
   * rather than left as a standing type error, because this union is the thing a
   * consumer reads to learn what statuses it must handle.
   */
  status: "ok" | "degraded" | "preview" | "refused" | "partial" | "error";
  command: string; disclaimer: string;
  scout?: ScoutResult; reserve?: ReserveResult; guardian?: GuardianResult;
  action?: { description: string; txids?: string[]; details?: Record<string, unknown> };
  refusal_reasons?: string[]; error?: string;
}

// `symbol` is optional because it is used only in a message, never in arithmetic.
// It was read off `tokenX` without being declared, which `tsc --noEmit --strict`
// reports as TS2339 and nobody had run. The live endpoint does return it.
interface BitflowPoolData { poolId: string; poolStatus?: boolean; tvlUsd: number; volumeUsd1d: number; apr24h: number; tokens?: { tokenX: { priceUsd: number; decimals: number; symbol?: string }; tokenY: { priceUsd: number; decimals: number; symbol?: string } } }

/**
 * Whether Bitflow marks a pool active. A pool paused upstream still returns volume
 * and a bin price, so without this both gates pass and a deposit is built (KB pool
 * eligibility). A row with no status is not active: the field is the only signal.
 */
export function poolIsLive(row: { poolStatus?: unknown } | null | undefined): boolean {
  return row?.poolStatus === true;
}

// == Bitflow pools cache (fetched once per run, reused across scout/yield/guardian) ==
let _poolsCache: BitflowPoolData[] | null = null;
let _poolsCacheTs = 0;
/**
 * When each pools answer was fetched, keyed by the answer itself. Gates run concurrently
 * and can refresh the cache, so the module timestamp may belong to a newer answer than the
 * one a gate is holding; this cannot.
 */
const _poolsReadAt = new WeakMap<BitflowPoolData[], number>();
const POOLS_CACHE_TTL_MS = 60_000; // 1 minute
/** The most two compared prices may be apart in time (KB matched freshness). */
export const MATCHED_FRESHNESS_MS = 30_000;

async function fetchBitflowPools(maxAgeMs: number = POOLS_CACHE_TTL_MS): Promise<BitflowPoolData[]> {
  if (_poolsCache && (Date.now() - _poolsCacheTs) < maxAgeMs) return _poolsCache;
  const pd = await fetchJson<{ data?: BitflowPoolData[] }>(`${BITFLOW_API}/api/app/v1/pools`);
  _poolsCache = pd.data ?? [];
  _poolsCacheTs = Date.now();
  _poolsReadAt.set(_poolsCache, _poolsCacheTs);
  return _poolsCache;
}

// == Fetch helpers =============================================================
// == Asking upstream without shutting ourselves out ===========================
//
// MEASURED 2026-09-12, and this is the whole reason the code below exists. A
// deposit of 10 USDh into Hermetica was refused three times running, always the
// same way: the sBTC reserve check came back DATA_UNAVAILABLE on an HTTP 429
// from Hiro, and the slippage and gas gates failed beside it. The engine's own
// rule turns an unreadable safety check into a refusal, so nothing unsafe
// happened. But nothing could be deposited either, and the cause was ours.
//
// Hiro was NOT rate limiting the machine. Three direct calls from the same box
// answered 200 while this was failing, and the limit header read
// `x-ratelimit-limit-second: 20` with 18 of 20 remaining. The engine was
// shutting itself out: `runGates` fans out across four protocols at once and
// each of those fans out again, so one question becomes twenty-odd reads in the
// same instant, against a limit of twenty a second.
//
// That makes it deterministic rather than unlucky, which is why waiting never
// helped and why three attempts failed identically.
//
// This is not the first time. The header comment on this file records an audit
// where a Hiro 429 rendered a wallet holding $3.93 as "Wallet Total $0". That
// was fixed at the DISPLAY, so a failed read now says UNKNOWN instead of zero.
// The cause was never fixed. Same root, second symptom.
//
// Two things are added, both here at the single door every read goes through,
// so no call site changes:
//
//   1. A minimum gap between request STARTS. Spacing is the right shape because
//      the limit counts requests per second, which a concurrency cap does not
//      bound: five in flight against a fast endpoint is still fifty a second.
//      The gap is global rather than per host. Hiro is the one with the limit we
//      hit, but Tenero, Bitflow and mempool.space have their own and this engine
//      bursts at all four; one number is also one thing for a reviewer to check.
//      70ms allows about 14 a second, under 20 with room for the app's own reads
//      against the same API from the same address.
//
//   2. A retry, on the statuses that mean "ask me again" and on nothing else.
//
// WHAT MUST NOT CHANGE, and the tests pin it: a read that genuinely fails still
// THROWS. Callers depend on that. Several wrap this in `.catch(() => null)` and
// the report renders UNKNOWN from it, which is the distinction that stops a
// failed read being told to a person as a zero balance. A retry that returned
// something plausible instead of throwing would put that defect back, in the
// worst possible place.

/** Minimum spacing between the START of one upstream request and the next. */
const REQUEST_GAP_MS = 70;

/**
 * Statuses worth asking again about.
 *
 * 429 is the measured one. The 5xx three are transient by definition. Nothing
 * else is here on purpose: a 400 or a 404 means the request was wrong, and
 * asking again three times only makes the same mistake more slowly.
 */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/** Attempts in total, not retries after the first. Three means at most two waits. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRY_CEILING_MS = 4_000;

/**
 * When the next request may start, as an epoch milliseconds figure.
 *
 * Module level and mutable, which is safe here because a skill is a CLI that
 * runs once and exits. `nextRequestAt` is claimed SYNCHRONOUSLY, before any
 * await, so two callers racing into `waitForSlot` cannot be handed the same
 * slot: the second reads the value the first already moved.
 */
let nextRequestAt = 0;

/**
 * How long one attempt may take. `FETCH_TIMEOUT_MS` in every real run.
 *
 * Mutable only so a test can reach the abort branch, which otherwise needs a
 * 30 second wait. A review found that branch untested: the case that claimed to
 * cover it threw a lookalike error without any controller aborting, so it
 * exercised the error NAME and never the signal.
 */
let requestTimeoutMs: number = FETCH_TIMEOUT_MS;

/** Test seam. Nothing in the skill calls these; a test resets state between cases. */
export function resetRequestPacing(timeoutMs: number = FETCH_TIMEOUT_MS): void {
  nextRequestAt = 0;
  requestTimeoutMs = timeoutMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + REQUEST_GAP_MS;
  const wait = at - now;
  if (wait > 0) await sleep(wait);
}

/**
 * How long to wait before asking again.
 *
 * The server's own `Retry-After` wins when it sends one, because it knows when
 * its window resets and we are guessing. It is capped anyway: a server asking
 * for two minutes is not something to honour inside one person's request, and
 * the caller is better served by a refusal it can explain.
 */
/**
 * The wait when nobody told us one: exponential, jittered, capped.
 *
 * Its own function, returning a plain number, so the CATCH path can call it
 * without a null it can never receive. Review round two found that guard sitting
 * there dead, kept alive only because the compiler makes you handle
 * `number | null`. A non-null assertion would have been the other way out, and
 * the wrong one: it is a promise the compiler cannot check, and it becomes a real
 * bug the first time somebody passes a header on that path.
 */
function backoffMs(attempt: number, jitter = Math.random()): number {
  const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
  // Jitter so four gates that failed together do not all come back together.
  return Math.min(backoff, RETRY_CEILING_MS) + Math.floor(jitter * 100);
}

export function retryWaitMs(attempt: number, retryAfter: string | null, jitter = Math.random()): number | null {
  // The emptiness check is not defensive noise: `Number("")` is 0, which is
  // finite and not negative, so a header present but blank asked for a wait of
  // zero and turned the backoff off entirely. A test caught it.
  if (retryAfter !== null && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // NULL, not a capped wait. A server saying "come back in 60 seconds" is
      // telling us this run cannot succeed. Silently capping at 4s then asking
      // twice more spends 8 seconds of a person's request to arrive at the same
      // refusal, later and with a vaguer reason. Refusing now is faster and the
      // report can say what the server actually asked for. Review's suggestion.
      return seconds * 1000 > RETRY_CEILING_MS ? null : seconds * 1000;
    }
  }
  return backoffMs(attempt, jitter);
}

async function fetchJson<T>(url: string, opts: RequestInit = {}): Promise<T> {
  let lastError: Error = new Error(`no request was made for ${url}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        ...opts, signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "bff-skills/stacks-alpha-engine", ...(opts.headers as Record<string, string> ?? {}) },
      });
    } catch (e) {
      // Cleared BEFORE any sleep below, not in a `finally`. A review pointed out
      // the finally ran after the backoff, leaving the timer armed through it.
      // It could not misfire on a live request, because the fetch had already
      // settled and `aborted` is read before the wait, but a reader should not
      // have to work that out.
      clearTimeout(timer);
      lastError = e instanceof Error ? e : new Error(String(e));
      // A timeout is not the server asking us to wait. Retrying it would spend
      // three timeouts where the caller budgeted for one, and this engine runs
      // inside a request a person is waiting on.
      //
      // The name is checked as well as the signal, because the signal only
      // catches OUR controller. An abort arriving any other way is still an
      // abort, and a test that threw one without touching the controller
      // retried it three times, which is the behaviour this line forbids.
      const aborted = controller.signal.aborted || lastError.name === "AbortError";
      if (aborted || attempt === MAX_ATTEMPTS) throw lastError;
      await sleep(backoffMs(attempt));
      continue;
    }
    clearTimeout(timer);

    // Parsing happens outside every retry decision on purpose: a body this
    // cannot read will not read differently the second time, and hiding a parse
    // bug behind three attempts makes it harder to find, not less likely.
    if (res.ok) return await res.json() as T;

    // The header is read BEFORE the attempt check, so a server that named a wait
    // is quoted whether it said so on the first attempt or the last. Round two
    // caught the old order losing the figure on the final pass, which made the
    // same refusal read two different ways depending on when it arrived.
    const retryAfter = res.headers.get("retry-after");
    const asked = retryAfter !== null && retryAfter.trim() !== ""
      ? `, and it asked for ${retryAfter}s before retrying`
      : "";
    lastError = new Error(`HTTP ${res.status} from ${url}${asked}`);
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastError;
    // Null means the server named a wait longer than this run can spend. Refuse
    // now rather than sleep to the ceiling and ask twice more for one answer.
    const wait = retryWaitMs(attempt, retryAfter);
    if (wait === null) throw lastError;
    await sleep(wait);
  }

  throw lastError;
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// == Clarity hex parsing (big-endian) =========================================
function parseUint128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "01");
  if (idx === -1) return 0n;
  return BigInt("0x" + clean.slice(idx + 2, idx + 34));
}

function parseInt128Hex(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const idx = findTypePrefix(clean, "00");
  if (idx === -1) return 0n;
  const val = BigInt("0x" + clean.slice(idx + 2, idx + 34));
  const max = (1n << 127n) - 1n;
  return val > max ? val - (1n << 128n) : val;
}

function findTypePrefix(hex: string, tb: string): number {
  if (hex.startsWith("07")) {
    if (hex.substring(2, 4) === tb) return 2;
    if (hex.substring(2, 4) === "0a" && hex.substring(4, 6) === tb) return 4;
  }
  if (hex.substring(0, 2) === tb) return 0;
  return -1;
}

type ClarityValue = bigint | boolean | null | string | ClarityValue[] | { [k: string]: ClarityValue } | { _err: ClarityValue };

function parseClarityValue(hex: string, pos = 0): { value: ClarityValue; end: number } {
  const type = hex.substring(pos, pos + 2);
  pos += 2;
  switch (type) {
    case "01": { const v = BigInt("0x" + hex.substring(pos, pos + 32)); return { value: v, end: pos + 32 }; }
    case "00": { const r = BigInt("0x" + hex.substring(pos, pos + 32)); const m = (1n << 127n) - 1n; return { value: r > m ? r - (1n << 128n) : r, end: pos + 32 }; }
    case "03": return { value: true, end: pos };
    case "04": return { value: false, end: pos };
    case "09": return { value: null, end: pos };
    case "0a": case "07": return parseClarityValue(hex, pos);
    case "08": { const i = parseClarityValue(hex, pos); return { value: { _err: i.value }, end: i.end }; }
    case "0c": {
      const n = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const o: Record<string, ClarityValue> = {};
      for (let i = 0; i < n; i++) {
        const nl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2;
        const nm = Buffer.from(hex.substring(pos, pos + nl * 2), "hex").toString("ascii"); pos += nl * 2;
        const v = parseClarityValue(hex, pos); o[nm] = v.value; pos = v.end;
      }
      return { value: o, end: pos };
    }
    case "0b": {
      const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8;
      const a: ClarityValue[] = [];
      for (let i = 0; i < l; i++) { const v = parseClarityValue(hex, pos); a.push(v.value); pos = v.end; }
      return { value: a, end: pos };
    }
    case "05": return { value: `principal:${hex.substring(pos, pos + 42)}`, end: pos + 42 };
    case "06": { pos += 42; const cl = parseInt(hex.substring(pos, pos + 2), 16); pos += 2 + cl * 2; return { value: "contract-principal", end: pos }; }
    case "0d": case "0e": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; const s = Buffer.from(hex.substring(pos, pos + l * 2), "hex").toString(type === "0d" ? "ascii" : "utf8"); return { value: s, end: pos + l * 2 }; }
    case "02": { const l = parseInt(hex.substring(pos, pos + 8), 16); pos += 8; return { value: `0x${hex.substring(pos, pos + l * 2)}`, end: pos + l * 2 }; }
    default: return { value: null, end: pos };
  }
}

function parseClarityHex(hex: string): ClarityValue {
  return parseClarityValue(hex.startsWith("0x") ? hex.slice(2) : hex).value;
}

// == Stacks address encoding ==================================================
const C32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function c32Decode(addr: string): { version: number; hash160: string } {
  const w = addr.slice(1);
  const version = C32.indexOf(w[0].toUpperCase());
  let n = 0n;
  for (const c of w.slice(1)) n = n * 32n + BigInt(C32.indexOf(c.toUpperCase()));
  let hex = n.toString(16);
  while (hex.length < 48) hex = "0" + hex;
  return { version, hash160: hex.slice(0, 40) };
}

function cvPrincipal(p: string): string {
  const { version, hash160 } = c32Decode(p);
  return "0x05" + version.toString(16).padStart(2, "0") + hash160;
}

function cvUint(n: number | bigint): string {
  return "0x01" + BigInt(n).toString(16).padStart(32, "0");
}

// == Hiro contract read =======================================================
async function callReadOnly(
  contractId: string, fn: string, args: string[] = [],
  sender = "SP219TWC8G12CSX5AB093127NC82KYQWEH8ADD1AY"
): Promise<{ okay: boolean; result?: string }> {
  const [addr, name] = contractId.split(".");
  return fetchJson(`${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, arguments: args }),
  });
}

export type ReadOnlyCall = (contractId: string, fn: string, args?: string[]) => Promise<{ okay: boolean; result?: string }>;

/** One uint read, or a thrown error naming what could not be read. Never a stand-in zero. */
async function readUint(read: ReadOnlyCall, contractId: string, fn: string, args: string[] = []): Promise<bigint> {
  const r = await read(contractId, fn, args);
  const v = r.okay && r.result ? parseClarityHex(r.result) : undefined;
  if (typeof v !== "bigint") throw new Error(`${contractId.split(".")[1]}.${fn} could not be read`);
  return v;
}

/**
 * Two decimals, except that a real rate under 0.01% keeps two significant figures.
 * Rounding to two places turned Zest sBTC's 0.001% into 0%, and the deploy check
 * then refused every Zest deposit as paying nothing.
 */
export function roundRate(pct: number): number {
  return pct === 0 || pct >= 0.01 ? round(pct, 2) : Number(pct.toPrecision(2));
}

/**
 * Zest V2 supply APY in percent, from the vault's own three reads, all basis
 * points and already annual: the borrow rate, times utilization, times the share
 * lenders keep after the vault's fee reserve. Null when a read is out of range.
 *
 * The reserve differs per vault (sBTC and STX 10%, USDC 50%, USDh 99.99% on
 * 2026-09-13), so it is read, never assumed: a fixed 10% put USDh at 0.82% against
 * a real 0.00009%, and USDC at 1.46% against 0.81%.
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

// == Bech32m (BIP-350) ========================================================
const B32C = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const B32M = 0x2bc830a3;

function b32mPolymod(v: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let c = 1;
  for (const x of v) { const b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; }
  return c;
}

function b32mHrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0, bits = 0;
  const r: number[] = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; r.push((acc >> bits) & max); } }
  if (bits > 0) r.push((acc << (to - bits)) & max);
  return r;
}

function bech32mEncode(hrp: string, data: number[]): string {
  const exp = b32mHrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const poly = b32mPolymod(exp) ^ B32M;
  const cs = Array.from({ length: 6 }, (_, i) => (poly >> (5 * (5 - i))) & 31);
  return hrp + "1" + [...data, ...cs].map(d => B32C[d]).join("");
}

function tapTaggedHash(tag: string, data: Uint8Array): Buffer {
  const th = createHash("sha256").update(tag).digest();
  return createHash("sha256").update(th).update(th).update(data).digest();
}

function xOnlyPubkeyToP2TR(xHex: string): string {
  if (xHex.length !== 64) throw new Error(`Expected 32-byte x-only pubkey, got ${xHex.length / 2} bytes`);
  const xBytes = Buffer.from(xHex, "hex");
  const tweak = tapTaggedHash("TapTweak", xBytes);
  const tweaked = ecc.xOnlyPointAddTweak(xBytes, tweak);
  if (!tweaked) throw new Error("Taproot key tweak failed");
  return bech32mEncode("bc", [1, ...convertBits(tweaked.xOnlyPubkey, 8, 5)]);
}

// BIP-350 test vectors
const BECH32M_TEST_VECTORS: Array<{ hrp: string; data: number[]; expected: string }> = [
  { hrp: "bc", data: [1, ...convertBits(Buffer.from("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"), 8, 5)], expected: "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0" },
];

function verifyBech32mTestVectors(): { pass: boolean; detail: string } {
  for (const tv of BECH32M_TEST_VECTORS) {
    const result = bech32mEncode(tv.hrp, tv.data);
    if (result !== tv.expected) return { pass: false, detail: `Expected ${tv.expected}, got ${result}` };
  }
  return { pass: true, detail: `${BECH32M_TEST_VECTORS.length} vectors passed` };
}

// =============================================================================
// ==  SCOUT MODULE
// =============================================================================

async function scoutWallet(wallet: string): Promise<ScoutResult> {
  if (!/^SP[A-Z0-9]{30,}$/i.test(wallet)) {
    throw new Error("Invalid wallet address: must be Stacks mainnet (SP...)");
  }

  const allSources: string[] = [];

  // -- Balances + prices ------------------------------------------------------
  const [hiroBalance, teneroSbtc, teneroStx] = await Promise.all([
    fetchJson<Record<string, unknown>>(`${HIRO_API}/extended/v1/address/${wallet}/balances`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_TOKEN}`).catch(() => null),
    fetchJson<Record<string, unknown>>(`${TENERO_API}/v1/stacks/tokens/stx`).catch(() => null),
  ]);
  if (hiroBalance) allSources.push("hiro-balances");
  if (teneroSbtc) allSources.push("tenero-sbtc-price");
  if (teneroStx) allSources.push("tenero-stx-price");

  // Whether the balance read RETURNED, recorded before any of its values are
  // touched. Everything below this line reads a zero out of a null response
  // without being able to tell the difference, so the difference is captured
  // here and carried on the result. See `ScoutAvailability`.
  const balancesAvailable = hiroBalance !== null;

  const stxMicro = BigInt(((hiroBalance as Record<string, Record<string, string>>)?.stx?.balance) ?? "0");
  const ft = (hiroBalance as Record<string, Record<string, Record<string, string>>>)?.fungible_tokens ?? {};

  function ftBalance(contractPrefix: string): bigint {
    const key = Object.keys(ft).find(k => k.startsWith(contractPrefix));
    return BigInt(ft[key ?? ""]?.balance ?? "0");
  }

  const sbtcSats    = ftBalance(SBTC_TOKEN);
  const usdcxMicro  = ftBalance(USDCX_TOKEN);
  const aeUsdcMicro = ftBalance(AEUSDC_TOKEN);
  const usdhSats    = ftBalance(USDH_TOKEN);
  const susdhSats   = ftBalance(SUSDH_TOKEN);

  // Prices
  const sd = (teneroSbtc as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const sbtcPrice = (sd?.price_usd as number) ?? ((sd?.price as Record<string, number>)?.current_price) ?? 0;
  const xd = (teneroStx as Record<string, Record<string, unknown>>)?.data as Record<string, unknown> | undefined;
  const stxPrice = (xd?.price_usd as number) ?? ((xd?.price as Record<string, number>)?.current_price) ?? 0;

  // A price of 0 is treated as "did not return", not as a quote. Both prices are
  // read through `?? 0`, so a dead feed, an empty body and a renamed field all
  // arrive here as the number zero, and neither of these two tokens is ever
  // genuinely worth nothing. Judging the VALUE rather than the response object
  // catches the schema-change case that a null check alone would miss.
  const priceSbtcAvailable = sbtcPrice > 0;
  const priceStxAvailable = stxPrice > 0;

  const unavailable: string[] = [];
  if (!balancesAvailable)   unavailable.push("wallet balances (Hiro)");
  if (!priceSbtcAvailable)  unavailable.push("sBTC price (Tenero)");
  if (!priceStxAvailable)   unavailable.push("STX price (Tenero)");
  const available: ScoutAvailability = {
    balances: balancesAvailable,
    price_sbtc: priceSbtcAvailable,
    price_stx: priceStxAvailable,
    unavailable,
  };

  // Stablecoins pegged at $1
  const usdhPrice = 1.0;
  const aeUsdcPrice = 1.0;
  const usdcxPrice = 1.0;

  const sbtcAmt    = Number(sbtcSats) / 1e8;
  const stxAmt     = Number(stxMicro) / 1e6;
  const usdcxAmt   = Number(usdcxMicro) / 1e6;
  const usdhAmt    = Number(usdhSats) / 1e8;
  const susdhAmt   = Number(susdhSats) / 1e8;
  const aeUsdcAmt  = Number(aeUsdcMicro) / 1e6;

  const balances: WalletBalances = {
    sbtc:   { amount: round(sbtcAmt, 8),   usd: round(sbtcAmt * sbtcPrice, 2),   atomic: sbtcSats.toString() },
    stx:    { amount: round(stxAmt, 6),     usd: round(stxAmt * stxPrice, 2),     atomic: stxMicro.toString() },
    usdcx:  { amount: round(usdcxAmt, 6),   usd: round(usdcxAmt * usdcxPrice, 2), atomic: usdcxMicro.toString() },
    usdh:   { amount: round(usdhAmt, 8),    usd: round(usdhAmt * usdhPrice, 2),   atomic: usdhSats.toString() },
    susdh:  { amount: round(susdhAmt, 8),   usd: round(susdhAmt * usdhPrice, 2),  atomic: susdhSats.toString() },
    aeusdc: { amount: round(aeUsdcAmt, 6),  usd: round(aeUsdcAmt * aeUsdcPrice, 2), atomic: aeUsdcMicro.toString() },
  };
  const prices = { sbtc: round(sbtcPrice, 2), stx: round(stxPrice, 4), usdcx: 1.0, usdh: 1.0, aeusdc: 1.0 };

  // -- Positions in parallel --------------------------------------------------
  const [zest, hermetica, granite, hodlmm] = await Promise.all([
    // A balance reply without its token map is passed as null, not as an empty
    // map, so Zest reads as unknown rather than as a wallet with no shares.
    scoutZest(wallet, callReadOnly, (hiroBalance as Record<string, unknown> | null)?.fungible_tokens
      ? (ft as unknown as Record<string, { balance: string }>)
      : null),
    scoutHermetica(wallet), scoutGranite(wallet), scoutHodlmm(wallet),
  ]);
  allSources.push(...zest.sources, ...hermetica.sources, ...granite.sources, ...hodlmm.sources);
  // HODLMM positions priced from what they hold, from prices that were actually read.
  hodlmm.positions = priceHodlmmHoldings(hodlmm.positions, {
    sbtc: priceSbtcAvailable ? prices.sbtc : null,
    stx: priceStxAvailable ? prices.stx : null,
    usdcx: 1, aeusdc: 1, usdh: 1,
  });

  // -- Fix Hermetica has_position from wallet sUSDh balance -------------------
  if (balances.susdh.amount > 0) {
    hermetica.position.has_position = true;
    hermetica.position.susdh_balance = balances.susdh.amount;
    hermetica.position.detail = `${balances.susdh.amount} sUSDh staked (rate: ${hermetica.position.exchange_rate})`;
  }

  // -- Yield options (3-tier) -------------------------------------------------
  const { options, sources: optSrc } = await getYieldOptions(balances, prices, granite.position, hermetica.position, zest.position);
  allSources.push(...optSrc);

  // -- Best move --------------------------------------------------------------
  const walletUsd = balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd + balances.usdh.usd + balances.susdh.usd + balances.aeusdc.usd;
  const move = bestMove(options);
  const bestOpt = move.best;
  let recommendation = "No yield opportunities available for your current holdings.";
  let opportunityCost: number | null = 0;
  let idleCapital: number | null = round(walletUsd, 2);

  // A holding whose price did not come back, where the person actually holds
  // some. The AMOUNT is known and correct; only its dollar value is missing, so
  // any total that silently drops it understates what they have.
  const unpricedHolding = (!priceSbtcAvailable && balances.sbtc.amount > 0)
    || (!priceStxAvailable && balances.stx.amount > 0);

  const outOfRange = hodlmm.positions.pools.filter(p => !p.in_range);
  if (outOfRange.length > 0) {
    recommendation = `WARNING: ${outOfRange.length} HODLMM position(s) OUT OF RANGE (${outOfRange.map(p => p.name).join(", ")}). Consider rebalancing.`;
    opportunityCost = bestOpt?.daily_usd ?? 0;
  // No wallet-size cutoff here. This branch used to require `walletUsd > 10`,
  // which meant the headline verdict a person reads FIRST still told a small
  // holder there was nothing for them, even after the deploy gate stopped
  // refusing: a $3.93 wallet got two HODLMM pools at 377% and 298% APY in
  // `options` and "No yield opportunities available for your current holdings"
  // in `best_move`. Missing that copy is how a fix looks done and is not.
  } else if (bestOpt && bestOpt.apy_pct > 0 && walletUsd > 0) {
    // The option's OWN daily figure, not one recomputed from the whole wallet.
    //
    // This multiplied the entire wallet by the pool's APY while the options table
    // multiplied only what can actually be paired. On a live wallet the two named
    // the same pool on the same screen at $0.0831 and $0.0119 a day, a factor of
    // seven, and the bigger one was the headline. A reader takes "missed" as what
    // deploying would give them.
    opportunityCost = move.dailyUsd;
    recommendation = verdictLine(bestOpt, opportunityCost);
  }

  // The headline is overwritten LAST when the balance read failed, because every
  // branch above computes from `balances` and every one of those numbers is a
  // zero this run invented. "No yield opportunities available for your current
  // holdings" is the worst of them: it is a ruling ABOUT their holdings, printed
  // by a run that never saw their holdings, and it reads as a considered answer
  // rather than as a missing one.
  //
  // The position reads are separate calls and survive a balance failure, so an
  // out-of-range warning that DID come off chain is kept and attributed, instead
  // of being thrown away with the unknown numbers.
  if (!balancesAvailable) {
    const positionNote = outOfRange.length > 0
      ? ` Your deployed positions did read: ${outOfRange.length} HODLMM position(s) OUT OF RANGE (${outOfRange.map(p => p.name).join(", ")}).`
      : "";
    recommendation = `Could not read your wallet balances this run, so what you hold is UNKNOWN, not zero. Nothing in this report states how much you have. Did not respond: ${unavailable.join(", ")}. Run the scan again.${positionNote}`;
    idleCapital = null;
    opportunityCost = null;
  } else if (unpricedHolding) {
    // Amounts are real here, only the dollar conversion is missing, so the
    // recommendation stands and the total is what has to stop claiming precision.
    recommendation = `${recommendation} Dollar values are incomplete: ${unavailable.join(", ")} did not respond, and you hold some of what could not be priced.`;
    idleCapital = null;
  }

  // -- Break prices -----------------------------------------------------------
  const { breakPrices, sources: bpSrc } = await getBreakPrices(hodlmm.positions, prices.sbtc);
  allSources.push(...bpSrc);

  // A COUNT OF SOURCES IS NOT A TEST OF THE ONE THAT MATTERS. There are eight
  // sources here and four satisfied the old test, so the read carrying the
  // person's own balances could fail while the other seven kept the run calling
  // itself "ok": that is not a hypothetical, it is what a failure run printed,
  // with `hiro-balances` missing from `data_sources` as the only trace. Any read
  // whose absence changes a number a person acts on now flips the status by name
  // rather than by arithmetic, and the count is kept as an additional, weaker
  // condition rather than as the whole test.
  const status = scanStatus({ balancesAvailable, priceSbtcAvailable, priceStxAvailable, zest: zest.position, sourceCount: allSources.length, hodlmm: hodlmm.positions });

  return {
    status,
    wallet, available, balances, prices,
    positions: { zest: zest.position, hermetica: hermetica.position, granite: granite.position, hodlmm: hodlmm.positions },
    options,
    best_move: { recommendation, idle_capital_usd: idleCapital, opportunity_cost_daily_usd: opportunityCost },
    break_prices: breakPrices,
    data_sources: [...new Set(allSources)],
  };
}

// -- Scout: Zest --------------------------------------------------------------
/**
 * "degraded" whenever a read that changes a number a person acts on did not
 * return: the balances, either price, the Zest position, Zest's rate, or a
 * HODLMM pool's position. The
 * source count stays as a weaker extra condition.
 */
export function scanStatus(r: {
  balancesAvailable: boolean; priceSbtcAvailable: boolean; priceStxAvailable: boolean;
  zest: ZestPosition; sourceCount: number; hodlmm: HodlmmPositions;
}): "ok" | "degraded" {
  return (!r.balancesAvailable || !r.priceSbtcAvailable || !r.priceStxAvailable
    || r.zest.state === "unknown" || r.zest.supply_apy_pct === undefined || r.sourceCount < 4
    || (r.hodlmm.unread ?? []).length > 0)
    ? "degraded"
    : "ok";
}

export async function scoutZest(
  wallet: string, read: ReadOnlyCall = callReadOnly, walletTokens?: Record<string, { balance: string }> | null,
): Promise<{ position: ZestPosition; sources: string[] }> {
  const [position, rate, stxRate, usdcRate] = await Promise.all([
    readZestPosition(wallet, read, walletTokens),
    readZestSupplyRate(ZEST_VAULT_SBTC, read),
    readZestSupplyRate(`${ZEST_DEPLOYER}.v0-vault-stx`, read),
    readZestSupplyRate(`${ZEST_DEPLOYER}.v0-vault-usdc`, read),
  ]);
  const sources: string[] = [];
  if (position.state !== "unknown") sources.push("zest-v2-position");
  if (rate) sources.push("zest-apy-live");
  const other_rates = { ...(stxRate ? { STX: stxRate } : {}), ...(usdcRate ? { USDCx: usdcRate } : {}) };
  const withOthers = Object.keys(other_rates).length > 0 ? { ...position, other_rates } : position;
  return { position: rate ? { ...withOthers, ...rate } : withOthers, sources };
}

// -- Zest V2 deposits a person signs ---------------------------------------------
//
// Later item 1 (smartx-app docs/PLAN-zest-writes.md, reviewed by Fable 2026-09-16).
// A Zest deposit is `<market>.supply-collateral-add(ft, amount, min-shares, price-feeds)`,
// where the market is the contract `v0-market-vault` accepts now (v0-8-market on
// 2026-09-16, read with `get-impl`; see ZEST_REVIEWED_MARKETS). SmartX cannot supply a fresh Pyth price proof (Hermes needs a paid key
// since 2026-08-26), so it passes `none`, and builds only where Zest reads no price at
// all (market source, `collateral-add`):
//   - the account is new to Zest (`get-position` errs u600006), or
//   - its position mask is empty (nothing supplied, nothing owed), or
//   - it tops up the asset it already holds, and owes nothing.
// On v0-4-market a tracked account adding a DIFFERENT asset resolved prices before the
// debt check; v0-8-market reads prices only when the account has debt. Adding a second
// coin is still refused, as a proof set choice (no signed deposit has done it), and so is
// any debt: the owner's first signed test has no loan. Each is one condition to relax later.

export interface ZestDepositAsset {
  /** The token word the person typed, lowercase. */
  readonly token: "stx" | "sbtc" | "usdcx";
  readonly symbol: string;
  /** The `ft` argument: the underlying token contract (wSTX for STX). */
  readonly underlying: string;
  /** The Clarity asset name a post-condition must spell; null for native STX. */
  readonly assetName: string | null;
  readonly vault: string;
  /** The vault share token's asset id in `v0-assets`, and its bit in the position mask. */
  readonly shareAid: number;
  readonly decimals: number;
}

/**
 * The Zest market contracts SmartX has read and checked a deposit against.
 *
 * Zest upgrades its market by deploying a new contract and pointing `v0-market-vault`'s `impl` at
 * it; the old one still answers every read, and a write through it aborts with ERR-AUTH (u600001).
 * The owner's first signed deposit, through `v0-4-market`, aborted exactly that way on 2026-09-16
 * (tx 0xe65a82d1...78fc). So the market is read from the vault at build time, and a deposit is
 * built only when it is one of these, each reviewed for the no price rule above; a new upgrade is
 * refused in plain words until someone reads it.
 */
export const ZEST_REVIEWED_MARKETS: readonly string[] = [`${ZEST_DEPLOYER}.v0-8-market`];

/**
 * A contract principal as Clarity hex, to compare `get-impl` exactly. That read returns the bare
 * principal (`(var-get impl)`), not wrapped in `(ok ...)`, read live on 2026-09-16.
 */
export function cvContractPrincipal(contract: string): string {
  const [addr, name] = contract.split(".") as [string, string];
  const { version, hash160 } = c32Decode(addr);
  const nameHex = Array.from(new TextEncoder().encode(name)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "0x06" + version.toString(16).padStart(2, "0") + hash160 + name.length.toString(16).padStart(2, "0") + nameHex;
}
const ZEST_EGROUP = `${ZEST_DEPLOYER}.v0-egroup`;
const ZEST_ASSET_REGISTRY = `${ZEST_DEPLOYER}.v0-assets`;

/** The assets SmartX builds Zest deposits for, each checked on chain 2026-09-16. */
export const ZEST_DEPOSIT_ASSETS: readonly ZestDepositAsset[] = [
  { token: "stx", symbol: "STX", underlying: `${ZEST_DEPLOYER}.wstx`, assetName: null, vault: `${ZEST_DEPLOYER}.v0-vault-stx`, shareAid: 1, decimals: 6 },
  { token: "sbtc", symbol: "sBTC", underlying: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", assetName: "sbtc-token", vault: ZEST_VAULT_SBTC, shareAid: 3, decimals: 8 },
  { token: "usdcx", symbol: "USDCx", underlying: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", assetName: "usdcx-token", vault: `${ZEST_DEPLOYER}.v0-vault-usdc`, shareAid: 7, decimals: 6 },
];

/** Everything read before a Zest deposit is built. */
export interface ZestDepositPlan {
  readonly asset: ZestDepositAsset;
  /** The market the vault accepts right now (`v0-market-vault.get-impl`), one SmartX has reviewed. */
  readonly market: string;
  /** Shares the vault would mint for the amount now (`convert-to-shares`, rounded down). */
  readonly previewShares: bigint;
}

/** The floor on shares: 99.5% of the preview, since shares per asset fall as interest accrues. */
export function zestMinShares(preview: bigint): bigint {
  return (preview * 9950n) / 10000n;
}

/** The ceiling on shares leaving the wallet: 101% of the preview, rounded up, so loose shares stay put. */
export function zestMaxShares(preview: bigint): bigint {
  return (preview * 10100n + 9999n) / 10000n;
}

/**
 * Which case of the no price rule a position is in, from `get-position`'s parsed answer.
 * Pure, so each case is tested with no network.
 */
export function zestDepositCase(
  position: ClarityValue | undefined, shareAid: number,
): { ok: true; newCollateral: boolean; mask: bigint } | { ok: false; refusal: string } {
  if (position && typeof position === "object" && !Array.isArray(position) && "_err" in position) {
    if (position._err === ZEST_ERR_NO_ACCOUNT) return { ok: true, newCollateral: true, mask: 0n };
    return { ok: false, refusal: `Zest could not read this account (error ${String(position._err)}), so no deposit is built.` };
  }
  const mask = position && typeof position === "object" && !Array.isArray(position)
    ? (position as Record<string, ClarityValue>).mask : undefined;
  if (typeof mask !== "bigint") return { ok: false, refusal: "Zest's record of this account could not be read, so no deposit is built." };
  const debtBits = mask >> 64n;
  if (debtBits !== 0n) {
    return { ok: false, refusal: "This wallet has a Zest loan. SmartX has not yet proved a Zest deposit on an account with a loan, so it does not build one." };
  }
  const bit = 1n << BigInt(shareAid);
  if (mask === 0n) return { ok: true, newCollateral: true, mask };
  if ((mask & bit) !== 0n) return { ok: true, newCollateral: false, mask };
  return {
    ok: false,
    refusal: "This wallet already supplies a different coin on Zest. SmartX has not yet proved a Zest deposit that adds a second coin, so it does not build one.",
  };
}

/**
 * The reads before a Zest deposit, or the plain reason it is refused. Every read that fails
 * refuses: an unread pause, cap or position is unknown, never assumed fine.
 */
export async function readZestDepositPlan(
  wallet: string, token: string, amount: number, read: ReadOnlyCall = callReadOnly,
): Promise<{ plan: ZestDepositPlan; refusal: null } | { plan: null; refusal: string }> {
  const asset = ZEST_DEPOSIT_ASSETS.find((a) => a.token === token);
  if (!asset) return { plan: null, refusal: `SmartX builds Zest deposits for ${ZEST_DEPOSIT_ASSETS.map((a) => a.symbol).join(", ")} only.` };
  const refuse = (why: string) => ({ plan: null, refusal: why } as const);
  try {
    const impl = await read(ZEST_MARKET_VAULT, "get-impl", []);
    if (!impl.okay || !impl.result) return refuse("Zest's current market contract could not be read, so no deposit is built. Try again.");
    const market = ZEST_REVIEWED_MARKETS.find((m) => cvContractPrincipal(m) === impl.result!.toLowerCase());
    if (!market) {
      return refuse("Zest has moved its deposits to a market contract SmartX has not checked yet, so it does not build one. This needs a SmartX update first.");
    }
    const pos = await read(ZEST_MARKET_VAULT, "get-position", [cvPrincipal(wallet), cvUint(MAX_U128)]);
    if (!pos.okay || !pos.result) return refuse("Zest's record of this account could not be read, so no deposit is built. Try again.");
    const which = zestDepositCase(parseClarityHex(pos.result), asset.shareAid);
    if (!which.ok) return refuse(which.refusal);

    const [vaultPause, marketPause, status, cap, held, preview] = await Promise.all([
      read(asset.vault, "get-pause-states", []),
      read(ZEST_MARKET_VAULT, "get-pause-states", []),
      read(ZEST_ASSET_REGISTRY, "get-status", [cvUint(asset.shareAid)]),
      readUint(read, asset.vault, "get-cap-supply"),
      readUint(read, asset.vault, "get-assets"),
      readUint(read, asset.vault, "convert-to-shares", [cvUint(amount)]),
    ]);
    const tuple = (r: { okay: boolean; result?: string }): Record<string, ClarityValue> | null => {
      const v = r.okay && r.result ? parseClarityHex(r.result) : undefined;
      return v && typeof v === "object" && !Array.isArray(v) && !("_err" in v) ? v as Record<string, ClarityValue> : null;
    };
    const vp = tuple(vaultPause), mp = tuple(marketPause), st = tuple(status);
    if (!vp || typeof vp.deposit !== "boolean") return refuse(`Zest's ${asset.symbol} vault pause state could not be read, so no deposit is built.`);
    if (vp.deposit) return refuse(`Zest has paused deposits into its ${asset.symbol} vault.`);
    if (!mp || typeof mp["collateral-add"] !== "boolean") return refuse("Zest's collateral pause state could not be read, so no deposit is built.");
    if (mp["collateral-add"]) return refuse("Zest has paused adding collateral.");
    if (!st || typeof st.collateral !== "boolean") return refuse(`Zest's settings for ${asset.symbol} could not be read, so no deposit is built.`);
    if (!st.collateral) return refuse(`Zest does not accept ${asset.symbol} shares as collateral right now.`);
    if (held + BigInt(amount) > cap) return refuse(`Zest's ${asset.symbol} vault is at its supply cap, so a deposit of this size would be refused.`);
    if (preview <= 0n || zestMinShares(preview) <= 0n) return refuse(`That amount is too small for Zest's ${asset.symbol} vault: it would mint no shares.`);

    if (which.newCollateral) {
      const egroup = await read(ZEST_EGROUP, "resolve", [cvUint(which.mask | (1n << BigInt(asset.shareAid)))]);
      const g = egroup.okay && egroup.result ? parseClarityHex(egroup.result) : undefined;
      if (g === undefined) return refuse("Zest's collateral group rules could not be read, so no deposit is built.");
      if (g && typeof g === "object" && !Array.isArray(g) && "_err" in g) return refuse(`Zest does not allow ${asset.symbol} as collateral for this account.`);
    }
    return { plan: { asset, market, previewShares: preview }, refusal: null };
  } catch (e: unknown) {
    return refuse(`A Zest read failed (${e instanceof Error ? e.message : String(e)}), so no deposit is built. Try again.`);
  }
}

/** The unsigned Zest deposit, with the conditions the chain enforces under deny. */
export function buildZestDeposit(wallet: string, amount: number, plan: ZestDepositPlan): ExecuteInstruction {
  const { asset } = plan;
  const min = zestMinShares(plan.previewShares);
  const max = zestMaxShares(plan.previewShares);
  const conditions = asset.assetName === null
    ? [
      // One STX condition on the wallet: exactly the amount. `wstx.transfer` is a bare stx-transfer.
      { type: "stx", principal: wallet, conditionCode: "eq", amount: String(amount) },
      { type: "ft", principal: wallet, asset: asset.vault, assetName: "zft", conditionCode: "gte", amount: min.toString() },
      { type: "ft", principal: wallet, asset: asset.vault, assetName: "zft", conditionCode: "lte", amount: max.toString() },
      // The market moves exactly the amount into the vault. `gte`, because SmartX refuses
      // an upper bound on any principal but the person.
      { type: "stx", principal: plan.market, conditionCode: "gte", amount: String(amount) },
    ]
    : [
      { type: "ft", principal: wallet, asset: asset.underlying, assetName: asset.assetName, conditionCode: "eq", amount: String(amount) },
      { type: "ft", principal: wallet, asset: asset.vault, assetName: "zft", conditionCode: "gte", amount: min.toString() },
      { type: "ft", principal: wallet, asset: asset.vault, assetName: "zft", conditionCode: "lte", amount: max.toString() },
      { type: "ft", principal: plan.market, asset: asset.underlying, assetName: asset.assetName, conditionCode: "gte", amount: String(amount) },
    ];
  const [contractAddress, contractName] = plan.market.split(".") as [string, string];
  return {
    tool: "call_contract",
    params: {
      contractAddress, contractName,
      functionName: "supply-collateral-add",
      functionArgs: [
        { type: "principal", value: asset.underlying },
        { type: "uint", value: String(amount) },
        { type: "uint", value: min.toString() },
        // No price proof: this build is only reached where Zest reads no price.
        { type: "none" },
      ],
      postConditionMode: "deny",
      postConditions: conditions,
    },
    description: `Supply ${humanAmount(BigInt(amount), asset.decimals)} ${asset.symbol} to Zest v2 as collateral`,
  };
}

// -- Scout: Hermetica ---------------------------------------------------------
async function scoutHermetica(wallet: string): Promise<{ position: HermeticaPosition; sources: string[] }> {
  const sources: string[] = [];
  try {
    // Read exchange rate (USDh per sUSDh) and staking status
    const [rateResult, enabledResult] = await Promise.all([
      callReadOnly(HERMETICA_STAKING, "get-usdh-per-susdh", []),
      // staking-v1-1 doesn't have an explicit "is-enabled" but stake will fail if paused
      // We just read the rate as proof the contract is live
      Promise.resolve({ okay: true }),
    ]);
    sources.push("hermetica-staking");

    const RATE_SCALE = 1e8; // exchange rate precision: Hermetica usdh-base = (pow u10 u8)
    let exchangeRate = 1.0;
    if (rateResult.okay && rateResult.result) {
      const raw = parseUint128Hex(rateResult.result);
      exchangeRate = Number(raw) / RATE_SCALE;
    }

    // Annualize APY from exchange rate drift using staking-v1-1 deployment date.
    // staking-v1-1 deployed at burn block 914980 (Sept 16 2025). The exchange rate
    // reflects cumulative yield since then: we must annualize, not report raw.
    const STAKING_V1_1_DEPLOY_TS = 1758041467; // burn_block_time of deploy tx
    const nowTs = Math.floor(Date.now() / 1000);
    const daysSinceDeploy = Math.max(1, (nowTs - STAKING_V1_1_DEPLOY_TS) / 86400);
    const apyEstimate = exchangeRate > 1.0
      ? round((Math.pow(exchangeRate, 365 / daysSinceDeploy) - 1) * 100, 2)
      : 0;

    // Check user's sUSDh balance from wallet scan (already read in hiroBalance)
    // We just report the rate here; balance comes from the wallet scan
    return {
      position: {
        has_position: false, // will be overridden if susdhSats > 0
        detail: `Exchange rate: ${round(exchangeRate, 6)} USDh/sUSDh`,
        susdh_balance: 0,
        exchange_rate: round(exchangeRate, 6),
        apy_estimate_pct: apyEstimate,
        staking_enabled: enabledResult.okay,
      },
      sources,
    };
  } catch {
    return {
      position: { has_position: false, detail: "Hermetica read failed", susdh_balance: 0, exchange_rate: 1, apy_estimate_pct: 0, staking_enabled: false },
      sources,
    };
  }
}

// -- Scout: Granite -----------------------------------------------------------
async function scoutGranite(wallet: string): Promise<{ position: GranitePosition; sources: string[] }> {
  const sources: string[] = [];
  const IR_SCALE = 1e12;
  try {
    const [lpResult, debtResult, irResult, userPos] = await Promise.all([
      callReadOnly(GRANITE_STATE, "get-lp-params", []),
      callReadOnly(GRANITE_STATE, "get-debt-params", []),
      callReadOnly(GRANITE_IR, "get-ir-params", []),
      callReadOnly(GRANITE_STATE, "get-user-position", [cvPrincipal(wallet)]),
    ]);
    sources.push("granite-on-chain");

    let supplyApy = 0, borrowApr = 0, utilization = 0;

    if (lpResult.okay && lpResult.result && debtResult.okay && debtResult.result) {
      const lp = parseClarityHex(lpResult.result) as Record<string, ClarityValue>;
      const debt = parseClarityHex(debtResult.result) as Record<string, ClarityValue>;
      const totalAssets = typeof lp["total-assets"] === "bigint" ? lp["total-assets"] : 0n;
      const openInterest = typeof debt["open-interest"] === "bigint" ? debt["open-interest"] : 0n;
      if (totalAssets > 0n) utilization = Number((openInterest * 10000n) / totalAssets) / 100;
    }

    if (irResult.okay && irResult.result) {
      const ir = parseClarityHex(irResult.result) as Record<string, ClarityValue>;
      const baseIr = Number(typeof ir["base-ir"] === "bigint" ? ir["base-ir"] : 0n) / IR_SCALE;
      const slope1 = Number(typeof ir["ir-slope-1"] === "bigint" ? ir["ir-slope-1"] : 0n) / IR_SCALE;
      const slope2 = Number(typeof ir["ir-slope-2"] === "bigint" ? ir["ir-slope-2"] : 0n) / IR_SCALE;
      const kink = Number(typeof ir["utilization-kink"] === "bigint" ? ir["utilization-kink"] : 0n) / IR_SCALE;
      const u = utilization / 100;
      if (kink > 0) {
        borrowApr = u <= kink
          ? (baseIr + slope1 * (u / kink)) * 100
          : (baseIr + slope1 + slope2 * ((u - kink) / (1 - kink))) * 100;
      }
      supplyApy = borrowApr * (utilization / 100);
    }

    let hasPosition = false;
    let lpShares = 0n;
    if (userPos.okay && userPos.result) {
      const parsed = parseClarityHex(userPos.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const shares = (parsed as Record<string, ClarityValue>)["shares"] ?? (parsed as Record<string, ClarityValue>)["lp-shares"];
        if (typeof shares === "bigint" && shares > 0n) {
          hasPosition = true;
          lpShares = shares;
        }
      }
    }

    return {
      position: {
        has_position: hasPosition,
        detail: hasPosition ? `Active aeUSDC supply on Granite LP (${lpShares} shares)` : "No aeUSDC supply on Granite LP",
        supply_apy_pct: round(supplyApy, 2), borrow_apr_pct: round(borrowApr, 2),
        utilization_pct: round(utilization, 2),
        accepted_token: "aeUSDC",
        lp_shares: lpShares.toString(),
      }, sources,
    };
  } catch {
    return { position: { has_position: false, detail: "Granite read failed", supply_apy_pct: 0, borrow_apr_pct: 0, utilization_pct: 0, accepted_token: "aeUSDC" }, sources };
  }
}

// -- Scout: HODLMM ------------------------------------------------------------
/**
 * The most bins one position is valued across. Beyond it the value is unknown, never partial.
 *
 * Sized to Hiro's budget, not to positions: 50 reads a minute without a key, and each bin costs
 * two. A whole scan of a wallet with no positions made 23 Hiro requests on 14 September (21 of
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
  const dx = TOKENS[pool.tokenX]?.decimals;
  const dy = TOKENS[pool.tokenY]?.decimals;
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
    const field = (k: string) => (tuple && typeof tuple === "object" && !Array.isArray(tuple) ? (tuple as Record<string, ClarityValue>)[k] : undefined);
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

export async function scoutHodlmm(
  wallet: string,
  read: ReadOnlyCall = (contractId, fn, args) => callReadOnly(contractId, fn, args ?? [], wallet),
): Promise<{ positions: HodlmmPositions; sources: string[] }> {
  const sources: string[] = [];
  const userPools: HodlmmUserPool[] = [];
  const unread: HodlmmPositions["unread"] = [];
  for (const pool of HODLMM_POOLS) {
    try {
      // The wallet's shares first, so a pool it does not hold costs one read, not three. The bin
      // list used to come first, and it answers ok for a wallet with no bins, so review counted
      // about 36 reads for a scan with no positions against Hiro's 50 a minute.
      // Only a zero that was READ skips the pool: a wallet with no position gets `(ok u0)` from
      // the 8 pools read on 14 September, so a failed read leaves the position unknown.
      const ovr = await read(pool.contract, "get-overall-balance", [cvPrincipal(wallet)]);
      if (!ovr.okay || !ovr.result) { unread.push({ pool_id: pool.id, name: pool.name }); continue; }
      const dlpShares = parseUint128Hex(ovr.result);
      if (dlpShares === 0n) continue;
      const [ubr, abr] = await Promise.all([
        read(pool.contract, "get-user-bins", [cvPrincipal(wallet)]),
        read(pool.contract, "get-active-bin-id", []),
      ]);
      // Shares are held, so a failed bin list or active bin leaves the position unknown too. The
      // active bin used to fall back to bin 500 and could call a position out of range.
      if (!ubr.okay || !abr.okay || !abr.result) { unread.push({ pool_id: pool.id, name: pool.name }); continue; }
      const activeBin = 500 + Number(parseInt128Hex(abr.result));

      const userBinIds = parseUserBinList(ubr.result ?? "");
      const inRange = userBinIds.includes(activeBin);
      // What the shares hold, bin by bin. Priced by the scan once prices are read.
      const holdings = await readHodlmmHoldings(pool, wallet, userBinIds, read);

      sources.push(`hodlmm-pool-${pool.id}`);
      userPools.push({
        pool_id: pool.id, name: pool.name, in_range: inRange, active_bin: activeBin,
        user_bins: userBinIds.length > 0 ? { min: Math.min(...userBinIds), max: Math.max(...userBinIds), count: userBinIds.length } : null,
        dlp_shares: dlpShares.toString(), holdings, estimated_value_usd: null,
      });
    } catch {
      // A read that threw (Hiro still refusing after its retries): unknown, never "no position".
      unread.push({ pool_id: pool.id, name: pool.name });
    }
  }
  return { positions: { has_position: userPools.length > 0, pools: userPools, unread }, sources };
}

function parseUserBinList(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bins: number[] = [];
  let pos = 0;
  if (clean.startsWith("07")) pos = 2;
  if (clean.substring(pos, pos + 2) !== "0b") return bins;
  pos += 2;
  const len = parseInt(clean.substring(pos, pos + 8), 16);
  pos += 8;
  for (let i = 0; i < len; i++) {
    if (pos + 34 > clean.length) break;
    if (clean.substring(pos, pos + 2) !== "01") { pos += 34; continue; }
    pos += 2;
    bins.push(Number(BigInt("0x" + clean.substring(pos, pos + 32))));
    pos += 32;
  }
  return bins;
}

// -- Yield Options (3-tier) ---------------------------------------------------
/**
 * Which tier a HODLMM option belongs in, and how much of it the wallet can fund.
 *
 * Pure and exported so the decisions can be tested. They used to sit inline inside
 * `getYieldOptions`, which does network reads in the same function, so no case
 * could reach them: reverting the whole two sided tiering change left all 203
 * cases green.
 *
 * Entry is TWO SIDED. Holding one token of a pair is not readiness, because the
 * contract permits both amounts only at the active bin, X non zero at or above it
 * and Y at or below. A one sided deposit therefore sits outside the earning range
 * and does not earn the pool fee APY printed beside it, which is what
 * `hodlmm-bin-guardian` exists to flag. Measured 2026-08-28: a wallet holding
 * 14.879089 STX and nothing else was offered four pools as deploy_now at 600.16%,
 * 366.38%, 185.18% and 4.44% with a daily dollar figure on each.
 */
/**
 * What the Gates column may say about a pool, from the two gate results.
 *
 * A FAIL on either wins, and it must. Requiring both to have returned before
 * saying anything meant one gate measuring a real failure while the other could
 * not be read collapsed to "not measured": the column told a reader nobody had
 * looked at a pool that had just been measured and found too thin to trade in.
 * Not a corner case. A pool's 24h volume can be a permanent fail against the
 * floor while a slippage read sits behind a rate limited endpoint.
 */
/**
 * Write each option's gate result onto it, for the pool this run measured.
 *
 * Exported because the loop this replaces could be deleted with the suite AND the
 * typecheck green: it lived inside the CLI action, which nothing can reach. With
 * it gone every row read "not measured", including the one pool that HAD been
 * measured and failed, which is the fault the marking exists to prevent.
 *
 * Options not naming the measured pool are left alone, keeping the
 * "not-measured" they were built with, which is true of them: one pool is
 * measured per run.
 */
export function applyGateResults(
  options: YieldOption[],
  guardian: { slippage: { pool_id: string | null; status: GateStatus }; volume: { status: GateStatus } },
): void {
  const pool = guardian.slippage.pool_id;
  if (!pool) return;
  for (const o of options) {
    if (o.pool_id === pool) o.gates = markOptionGates(guardian.slippage.status, guardian.volume.status);
  }
}

export function markOptionGates(slippage: GateStatus, volume: GateStatus): "passed" | "failed" | "not-measured" {
  if (slippage === "fail" || volume === "fail") return "failed";
  if (slippage === "pass" && volume === "pass") return "passed";
  return "not-measured";
}

/**
 * The option the headline verdict should name, and what it actually earns.
 *
 * Pure and exported because both of its decisions were live defects that no test
 * could reach: they sat inside `scoutWallet`, which does network reads.
 *
 * **Any actionable tier, not deploy-now alone.** Reading the deploy-now tier only
 * was correct while holding one side of a pair counted as deploy-now, and broke
 * the moment two sided entry made such a wallet swap-first. A STX only wallet then
 * had no deploy-now option at all, and the headline fell through to "No yield
 * opportunities available for your current holdings", printed eight lines under a
 * table of seven of them, four marked profitable.
 *
 * **The option's OWN daily figure, not one recomputed from the whole wallet.** The
 * verdict multiplied the entire wallet by the pool's APY while the options table
 * multiplied only what can be paired. On a live wallet the two named the same pool
 * on the same screen at $0.0831 and $0.0119 a day, and the larger was the headline.
 * A reader takes "missed" as what deploying would give them.
 */
export function bestMove(options: YieldOption[]): {
  best: YieldOption | undefined; needsSwap: boolean; dailyUsd: number;
} {
  // An option earning nothing is not an opportunity, and skipping it here rather
  // than after the choice is the difference between a headline and silence.
  //
  // Zest sBTC supply is `deploy_now` at 0% whenever utilisation is genuinely zero
  // OR its rate read failed, and any deploy_now used to win outright. So a wallet
  // was shown "No yield opportunities available for your current holdings" above a
  // 600% row, which is round one's first blocker returning through a second door.
  const live = options.filter(o => o.apy_pct > 0);
  const deployNow = live.find(o => o.tier === "deploy_now");
  const best = deployNow ?? live.find(o => o.tier === "swap_first");
  return { best, needsSwap: !deployNow && !!best, dailyUsd: best?.daily_usd ?? 0 };
}

/**
 * The headline sentence for an option, true of THAT option.
 *
 * The wording used to be chosen from the tier, which asserted the same thing about
 * every wallet in it. Two wallets land in `swap_first` holding one side or neither,
 * and Hermetica staking and Granite lending land there with no two sides at all,
 * so "once both sides are in the pool, because you hold one side" was printed over
 * wallets holding neither and over products with no pair.
 */
/**
 * How an option's gate result reads in the report.
 *
 * Exported because turning a failed gate into the word "passed" in the table a
 * person reads was invisible to the whole suite: this lived inside `renderReport`,
 * which is not exported.
 */
/**
 * Does the swap-first table need the sentence about both sides of a pair?
 *
 * Only when a paired pool is actually in it. That table also carries Hermetica
 * staking and Granite lending, which have no pair and no active bin, and the
 * sentence was printed over those too. Exported because `renderReport` is not, so
 * making the sentence unconditional again was invisible to the whole suite.
 */
export function swapTableNeedsPairNote(rows: YieldOption[]): boolean {
  return rows.some(o => o.sides !== "single");
}

export function gateCellFor(o: YieldOption): string {
  if (o.gates === "passed") return "passed";
  if (o.gates === "failed") return "**FAILED**";
  return "not measured";
}

export function verdictLine(o: YieldOption, dailyUsd: number): string {
  const head = `Best option: ${o.protocol} ${o.pool} (${o.token_needed}) at ${o.apy_pct}% APY`;
  if (o.tier !== "swap_first") return `${head} (~$${dailyUsd}/day missed).`;
  if (o.sides === "single") {
    return `${head}, about $${dailyUsd}/day once you hold ${o.token_needed}. You do not hold it yet, so a swap comes first.`;
  }
  if (o.sides === "one") {
    return `${head}, about $${dailyUsd}/day once both sides are in the pool. You hold one side, so swapping part of it comes first.`;
  }
  return `${head}, about $${dailyUsd}/day once both sides are in the pool. You hold neither side, so swapping into both comes first.`;
}

/**
 * How much of a paired pool the wallet already holds. Not a tier: two wallets in
 * `swap_first` can hold one side or neither, and the sentence a person reads is
 * only true of one of them.
 *
 * `single` is for products that have no two sides at all, Zest supply, Hermetica
 * staking, Granite lending. A headline promising "both sides in the pool" was
 * printed over those too.
 */
export type OptionSides = "both" | "one" | "neither" | "single";

export function sizeHodlmmOption(
  xUsd: number, yUsd: number, totalUsd: number, xSymbol: string, ySymbol: string,
  /**
   * How much of each side is actually held. Readiness is decided from these and
   * the position is SIZED from the dollar values, because the two answer different
   * questions and one of them stops working when a price feed does.
   *
   * Deciding readiness from `usd` was a regression: `usd` is `amount * price`
   * rounded to two decimals, so a failed price read makes a real holding look
   * absent, and a holding worth under half a cent does too. A wallet holding both
   * sides was then told "You hold one side, so swapping part of it comes first",
   * which is a false statement about their own wallet, and it advised swapping
   * money that did not need swapping. The old code read amounts; this restores
   * that and keeps the dollar values for sizing.
   *
   * REQUIRED, with no default falling back to the dollar values. A default made
   * the regression silently re-enterable: deleting the two arguments at the call
   * site restored the bug with every case still green. Required, the compiler
   * catches it, and `tsc` is in the gate.
   */
  xAmount: number, yAmount: number,
): { tier: YieldTier; capUsd: number; swapNote: string | null; sides: OptionSides } {
  const hasX = xAmount > 0;
  const hasY = yAmount > 0;

  if (hasX && hasY) {
    // The smaller side bounds what can be paired, so `Math.max` described a
    // position the wallet cannot fund. The doubling assumes a roughly even split
    // by value across bins around the active one, which is a ranking figure and
    // not a promise.
    return { tier: "deploy_now", capUsd: Math.min(xUsd, yUsd) * 2, swapNote: null, sides: "both" };
  }
  if (hasX || hasY) {
    // Swapping half of one side into the other preserves the total, less fees, so
    // the pair is worth about what is held.
    const held = hasX ? xSymbol : ySymbol;
    const needed = hasX ? ySymbol : xSymbol;
    return {
      tier: "swap_first",
      capUsd: Math.max(xUsd, yUsd),
      swapNote: `Swap part of your ${held} to ${needed} on Bitflow, then deposit both at the active bin`,
      sides: "one",
    };
  }
  if (totalUsd > 0) {
    // Holding SOMETHING swappable is the question, not holding ten dollars of it.
    //
    // The full value, not half. Half was right under a one sided model, where only
    // one swap happened. Under two sided entry someone holding $100 of an
    // unrelated token swaps $50 into each side and ends with $100 in the pool, so
    // halving understated it by about two times and disagreed with the one side
    // branch above, which is the same operation.
    return {
      tier: "swap_first",
      capUsd: totalUsd,
      swapNote: `Swap into ${xSymbol} and ${ySymbol} on Bitflow, then deposit both at the active bin`,
      sides: "neither",
    };
  }
  return { tier: "acquire_to_unlock", capUsd: 0, swapNote: null, sides: "neither" };
}

/**
 * The engine's Zest row, from the rate the scout already read. No rate, no row:
 * a 0% row is a claim that lending there pays nothing and sorts last by
 * construction, and `rateRefusal` refuses a Zest deposit that has no row. The
 * rate is not read a second time here: the same three Hiro calls twice in one
 * scan is load that makes a throttled, and so missing, rate more likely.
 */
export function zestYieldOptions(balances: WalletBalances, zest: ZestPosition): YieldOption[] {
  // STX and USDCx rows, each on its own vault's rate, only for a coin the wallet holds.
  const others: YieldOption[] = [];
  for (const [symbol, key] of [["STX", "stx"], ["USDCx", "usdcx"]] as const) {
    const r = zest.other_rates?.[symbol];
    const held = (balances as unknown as Record<string, TokenBalance | undefined>)[key];
    if (!r) continue;
    // A coin the wallet does not hold still gets its row, as sBTC does, so a deposit of it is
    // refused for the true reason (no balance) and never as "the rate could not be read".
    if (!held || !(held.amount > 0)) {
      others.push({ sides: "single" as OptionSides, tier: "acquire_to_unlock", protocol: "Zest", pool: `${symbol} Supply (v2)`, token_needed: symbol, apy_pct: r.supply_apy_pct, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.03, swap_cost_note: null, note: `Need ${symbol}.`, ytg_ratio: 0, ytg_profitable: false });
      continue;
    }
    const d = round((held.usd * r.supply_apy_pct / 100) / 365, 4);
    others.push({ sides: "single" as OptionSides, tier: "deploy_now", protocol: "Zest", pool: `${symbol} Supply (v2)`, token_needed: symbol, apy_pct: r.supply_apy_pct, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.03, swap_cost_note: null, note: `Lending, ${round(r.utilization_pct, 1)}% utilization.`, ytg_ratio: 0, ytg_profitable: false });
  }
  if (zest.supply_apy_pct === undefined || zest.utilization_pct === undefined) return others;
  const supplyApy = zest.supply_apy_pct;
  const utilPct = zest.utilization_pct;
  if (balances.sbtc.amount > 0) {
    const d = round((balances.sbtc.usd * supplyApy / 100) / 365, 4);
    return [{ sides: "single" as OptionSides, tier: "deploy_now", protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC", apy_pct: supplyApy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.03, swap_cost_note: null, note: supplyApy > 0 ? `Lending, ${round(utilPct, 1)}% utilization.` : `0% utilization, APY rises when borrowers arrive.`, ytg_ratio: 0, ytg_profitable: false }, ...others];
  }
  return [{ sides: "single" as OptionSides, tier: "acquire_to_unlock", protocol: "Zest", pool: "sBTC Supply (v2)", token_needed: "sBTC", apy_pct: supplyApy, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.03, swap_cost_note: null, note: `Need sBTC. Get via: Bitflow swap or sBTC bridge.`, ytg_ratio: 0, ytg_profitable: false }, ...others];
}

async function getYieldOptions(
  balances: WalletBalances,
  prices: { sbtc: number; stx: number; usdcx: number; usdh: number; aeusdc: number },
  granite: GranitePosition,
  hermetica: HermeticaPosition,
  zest: ZestPosition,
): Promise<{ options: YieldOption[]; sources: string[] }> {
  const sources: string[] = [];
  const options: YieldOption[] = [];

  // Helper: compute daily USD from capital and APY
  const dailyUsd = (capitalUsd: number, apyPct: number) => round((capitalUsd * apyPct / 100) / 365, 4);

  // --- Tier 1: Deploy Now (user holds the token) ---

  // Zest sBTC supply, from the rate the scout already read.
  options.push(...zestYieldOptions(balances, zest));

  // Hermetica USDh staking
  if (hermetica.staking_enabled) {
    const apyRaw = hermetica.apy_estimate_pct;
    const apy = apyRaw > 0 ? apyRaw : 5.0; // estimated, no live exchange rate data
    if (balances.usdh.amount > 0) {
      const d = dailyUsd(balances.usdh.usd, apy);
      const apyNote = apyRaw > 0 ? "" : " (estimated, no live rate data)";
      options.push({ sides: "single" as OptionSides, tier: "deploy_now", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.02, swap_cost_note: null, note: `Stake USDh -> sUSDh. Rate: ${hermetica.exchange_rate} USDh/sUSDh. 7-day unstake cooldown.${apyNote}`, ytg_ratio: 0, ytg_profitable: false });
    } else if (balances.usdcx.amount > 0) {
      // Swap path available: USDCx is the only coin with a single pool route to USDh
      // (the USDh/USDCx pool). An sBTC holder used to be told to swap sBTC to USDh, a
      // route the builder does not have.
      const swapFrom = "USDCx";
      const cap = balances.usdcx.usd;
      const d = dailyUsd(cap, apy);
      options.push({ sides: "single" as OptionSides, tier: "swap_first", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.1, swap_cost_note: `Swap ${swapFrom} -> USDh on Bitflow (~0.1-0.3% fee + gas)`, note: `Then stake USDh -> sUSDh. 7-day unstake cooldown.`, ytg_ratio: 0, ytg_profitable: false });
    } else {
      options.push({ sides: "single" as OptionSides, tier: "acquire_to_unlock", protocol: "Hermetica", pool: "USDh Staking (sUSDh)", token_needed: "USDh", apy_pct: apy, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.02, swap_cost_note: null, note: `Need USDh. Get via: a Bitflow swap from USDCx (the one pool that holds USDh), or acquire USDh directly.`, ytg_ratio: 0, ytg_profitable: false });
    }
  }

  // Granite aeUSDC LP deposit
  if (granite.supply_apy_pct && granite.supply_apy_pct > 0) {
    if (balances.aeusdc.amount > 0) {
      const d = dailyUsd(balances.aeusdc.usd, granite.supply_apy_pct);
      options.push({ sides: "single" as OptionSides, tier: "deploy_now", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.05, swap_cost_note: null, note: `Lending, ${granite.utilization_pct}% util, ${granite.borrow_apr_pct}% borrow APR.`, ytg_ratio: 0, ytg_profitable: false });
    } else if (balances.usdcx.amount > 0) {
      const d = dailyUsd(balances.usdcx.usd, granite.supply_apy_pct);
      options.push({ sides: "single" as OptionSides, tier: "swap_first", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: d, monthly_usd: round(d * 30, 2), gas_to_enter_stx: 0.1, swap_cost_note: "Swap USDCx -> aeUSDC on Bitflow (~0.01% fee, stablecoin pair)", note: `Then deposit aeUSDC to Granite LP.`, ytg_ratio: 0, ytg_profitable: false });
    } else {
      options.push({ sides: "single" as OptionSides, tier: "acquire_to_unlock", protocol: "Granite", pool: "aeUSDC Lending LP", token_needed: "aeUSDC", apy_pct: granite.supply_apy_pct, daily_usd: 0, monthly_usd: 0, gas_to_enter_stx: 0.05, swap_cost_note: null, note: `Need aeUSDC. Get via: Bitflow swap or bridge from Ethereum USDC.`, ytg_ratio: 0, ytg_profitable: false });
    }
  }

  // HODLMM pools
  try {
    const pools = await fetchBitflowPools();
    if (pools.length > 0) {
      sources.push("bitflow-hodlmm-apr");
      for (const bp of pools) {
        if (bp.apr24h <= 0 || !poolIsLive(bp)) continue;
        const def = HODLMM_POOLS.find(p => `dlmm_${p.id}` === bp.poolId);
        if (!def) continue;

        // Determine which token the user needs for this pool
        const tokenXMeta = TOKENS[def.tokenX];
        const tokenYMeta = TOKENS[def.tokenY];
        if (!tokenXMeta || !tokenYMeta) continue;

        const bx = (balances as unknown as Record<string, TokenBalance>)[def.tokenX];
        const by = (balances as unknown as Record<string, TokenBalance>)[def.tokenY];
        const sized = sizeHodlmmOption(
          bx?.usd ?? 0, by?.usd ?? 0,
          balances.sbtc.usd + balances.stx.usd + balances.usdcx.usd + balances.usdh.usd + balances.aeusdc.usd,
          tokenXMeta.symbol, tokenYMeta.symbol,
          bx?.amount ?? 0, by?.amount ?? 0,
        );
        const { tier, capUsd, swapNote } = sized;

        const d = dailyUsd(capUsd, bp.apr24h);
        // Only ONE pool is gated per run, the one being recommended, so every other
        // option carries no slippage or volume measurement at all. Saying so on the
        // option is the difference between "this passed" and "nobody looked".
        // Without it three pools sat beside the recommended one looking equally
        // ready while nothing had been measured for them.
        options.push({
          gates: "not-measured",
          sides: sized.sides,
          tier, protocol: "HODLMM", pool: def.name, pool_id: bp.poolId,
          token_needed: `${tokenXMeta.symbol}/${tokenYMeta.symbol}`,
          // The same two symbols the line above joins, kept apart and lower
          // cased, so a caller staging both sides reads them rather than
          // splitting a display string.
          token_x: def.tokenX, token_y: def.tokenY,
          apy_pct: round(bp.apr24h, 2), daily_usd: d, monthly_usd: round(d * 30, 2),
          gas_to_enter_stx: 0.05, swap_cost_note: swapNote,
          note: `Fee-based LP. TVL: $${Math.round(bp.tvlUsd).toLocaleString()}.`,
          ytg_ratio: 0, ytg_profitable: false,
        });
      }
    }
  } catch { /* unavailable */ }

  // YTG (Yield-to-Gas) profit gate: 7d projected yield must exceed 3x gas cost
  const stxPriceUsd = prices.stx;
  for (const opt of options) {
    const gasUsd = opt.gas_to_enter_stx * stxPriceUsd;
    const yield7d = opt.daily_usd * 7;
    opt.ytg_ratio = gasUsd > 0 ? round(yield7d / gasUsd, 2) : 0;
    opt.ytg_profitable = yield7d > gasUsd * 3;
  }

  // Sort: deploy_now first, then swap_first, then acquire_to_unlock; within each tier by APY desc
  const tierOrder: Record<YieldTier, number> = { deploy_now: 0, swap_first: 1, acquire_to_unlock: 2 };
  options.sort((a, b) => {
    const td = tierOrder[a.tier] - tierOrder[b.tier];
    return td !== 0 ? td : b.apy_pct - a.apy_pct;
  });

  return { options, sources };
}

// -- Break prices -------------------------------------------------------------
async function getBreakPrices(hodlmm: HodlmmPositions, sbtcPrice: number): Promise<{ breakPrices: BreakPrices; sources: string[] }> {
  const sources: string[] = [];
  let rangeLow: number | null = null, rangeHigh: number | null = null;
  const sbtcPool = hodlmm.pools.find(p => p.name.includes("sBTC") && p.user_bins);
  if (sbtcPool?.user_bins) {
    try {
      const poolContract = HODLMM_POOLS.find(p => p.id === sbtcPool.pool_id)?.contract;
      if (poolContract) {
        const pd = await callReadOnly(poolContract, "get-pool", []);
        if (pd.okay && pd.result) {
          const pp = parseClarityHex(pd.result) as Record<string, ClarityValue>;
          const initPrice = typeof pp["initial-price"] === "bigint" ? pp["initial-price"] : 0n;
          const binStep = typeof pp["bin-step"] === "bigint" ? pp["bin-step"] : 0n;
          if (initPrice > 0n && binStep > 0n) {
            const lowS = sbtcPool.user_bins.min - 500;
            const highS = sbtcPool.user_bins.max - 500;
            const toInt128 = (v: number) => `0x00${BigInt(v >= 0 ? v : (1n << 128n) + BigInt(v)).toString(16).padStart(32, "0")}`;
            const [lr, hr] = await Promise.all([
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(lowS)]),
              callReadOnly(DLMM_CORE, "get-bin-price", [cvUint(initPrice), cvUint(binStep), toInt128(highS)]),
            ]);
            if (lr.okay && lr.result) { rangeLow = round(Number(parseUint128Hex(lr.result)) / BIN_PRICE_SCALE, 2); sources.push("hodlmm-bin-price-low"); }
            if (hr.okay && hr.result) { rangeHigh = round(Number(parseUint128Hex(hr.result)) / BIN_PRICE_SCALE, 2); sources.push("hodlmm-bin-price-high"); }
          }
        }
      }
    } catch { /* skip */ }
  }
  return { breakPrices: { hodlmm_range_exit_low_usd: rangeLow, hodlmm_range_exit_high_usd: rangeHigh, current_sbtc_price_usd: sbtcPrice }, sources };
}

// =============================================================================
// ==  RESERVE (PoR) MODULE
// =============================================================================

/** The P2TR vector both the reserve check's self-test and `doctor` use: G, tweaked, as a mainnet address. */
const P2TR_SELF_TEST = {
  xOnlyHex: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  expected: "bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9",
} as const;

/**
 * The address derivation's own test vectors, run before any address is derived.
 *
 * The reserve check derives the sBTC signer's Bitcoin address and reads its balance.
 * A broken encoder would derive a wrong address, read some other balance, and could
 * report the reserve backed. These checks used to run only in `doctor`, whose message
 * says the engine "will not operate" when they fail, while `scan` and `deploy` never
 * ran them. They are pure and cheap, so every reserve check now runs them first.
 */
export function cryptoSelfTest(
  vectors: () => { pass: boolean; detail: string } = verifyBech32mTestVectors,
  derive: (xHex: string) => string = xOnlyPubkeyToP2TR,
): { ok: boolean; detail: string } {
  const tv = vectors();
  if (!tv.pass) return { ok: false, detail: `BIP-350 Bech32m test vectors failed: ${tv.detail}` };
  const { xOnlyHex, expected } = P2TR_SELF_TEST;
  try {
    const addr = derive(xOnlyHex);
    return addr === expected
      ? { ok: true, detail: "Bech32m vectors and G point -> tweaked P2TR pass" }
      : { ok: false, detail: `P2TR derivation self-test expected ${expected}, got ${addr}` };
  } catch (e: unknown) {
    return { ok: false, detail: `P2TR derivation self-test threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A reserve answer for a run whose address derivation failed its own tests: never a reading. */
export function selfTestFailedReserve(detail: string): ReserveResult {
  return {
    signal: "DATA_UNAVAILABLE", reserve_ratio: null, score: 0,
    sbtc_circulating: 0, btc_reserve: 0, signer_address: "",
    recommendation: "The engine's address self-tests failed, so the reserve cannot be checked. Treat as RED: do not proceed.",
    error: detail,
  };
}

async function checkReserve(): Promise<ReserveResult> {
  const selfTest = cryptoSelfTest();
  if (!selfTest.ok) return selfTestFailedReserve(selfTest.detail);
  try {
    const pubkeyRes = await callReadOnly(
      `${SBTC_REGISTRY}.${SBTC_REGISTRY_NAME}`, "get-current-aggregate-pubkey", [], SBTC_REGISTRY
    );
    if (!pubkeyRes.okay || !pubkeyRes.result) throw new Error("sbtc-registry returned no aggregate pubkey");
    const hex = pubkeyRes.result.replace(/^0x/, "");
    const compressedPubkey = hex.slice(10);
    if (compressedPubkey.length !== 66) throw new Error(`Expected 33-byte pubkey, got ${compressedPubkey.length / 2}`);

    const xOnlyHex = compressedPubkey.slice(2);
    const signerAddress = xOnlyPubkeyToP2TR(xOnlyHex);

    const [addrInfo, supplyRes] = await Promise.all([
      fetchJson<Record<string, Record<string, number>>>(`${MEMPOOL_API}/address/${signerAddress}`),
      callReadOnly(`${SBTC_TOKEN.split("::")[0]}`, "get-total-supply", [], SBTC_REGISTRY),
    ]);

    const funded = addrInfo?.chain_stats?.funded_txo_sum ?? 0;
    const spent = addrInfo?.chain_stats?.spent_txo_sum ?? 0;
    const btcReserve = (funded - spent) / 1e8;

    let sbtcCirculating = 0;
    if (supplyRes.okay && supplyRes.result) {
      const supplyRaw = parseUint128Hex(supplyRes.result);
      sbtcCirculating = Number(supplyRaw) / 1e8;
    }

    const reserveRatio = sbtcCirculating > 0 ? btcReserve / sbtcCirculating : 0;

    if (reserveRatio < ROTATION_THRESHOLD) {
      return {
        signal: "DATA_UNAVAILABLE", reserve_ratio: round(reserveRatio, 6), score: 0,
        sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4),
        signer_address: signerAddress,
        recommendation: `Reserve ratio ${(reserveRatio * 100).toFixed(1)}%, likely signer key rotation in progress.`,
      };
    }

    let signal: PorSignal;
    if (reserveRatio >= THRESHOLD_GREEN) signal = "GREEN";
    else if (reserveRatio >= THRESHOLD_YELLOW) signal = "YELLOW";
    else signal = "RED";

    let score = 100;
    if (reserveRatio < 0.995) score -= 30;
    else if (reserveRatio < 0.999) score -= 15;
    score = Math.max(0, score);

    const recommendation = signal === "GREEN"
      ? "sBTC fully backed. Safe to proceed."
      : signal === "YELLOW"
      ? "sBTC reserve slightly below threshold. Read-only operations only."
      : "sBTC reserve critically low. Emergency withdrawal recommended.";

    return { signal, reserve_ratio: round(reserveRatio, 6), score, sbtc_circulating: round(sbtcCirculating, 4), btc_reserve: round(btcReserve, 4), signer_address: signerAddress, recommendation };
  } catch (err: unknown) {
    return {
      signal: "DATA_UNAVAILABLE", reserve_ratio: null, score: 0,
      sbtc_circulating: 0, btc_reserve: 0, signer_address: "",
      recommendation: "Reserve check failed. Treat as RED: do not proceed.",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// ==  GUARDIAN MODULE
// =============================================================================

interface EngineState { last_rebalance_at?: string }

function readState(): EngineState {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function writeState(state: EngineState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * The reads the guardian makes, so a test can force them to fail.
 *
 * **Extracting `classifySlippage` was not enough and the review proved it.**
 * Replacing the entire call to it inside `checkGuardian` with a hardcoded
 * `{ ok: true, status: "pass", value: 0 }` left all 165 cases green: the exact
 * `PASS | 0%` for a check that never ran that this phase exists to delete. The
 * acceptance control was proving a pure function nothing was asserted to call.
 *
 * The roadmap's test is "a slippage check that cannot run reports unknown, never
 * a pass, proved by a control that forces the failure". The check a person meets
 * is this function, so the failure has to be forced HERE.
 */
export type GuardianReads = {
  fetchPools: () => Promise<BitflowPoolData[] | null>;
  /** When this pools answer from `fetchPools` was fetched (ms since epoch), or null if unknown. */
  poolsReadAt: (pools: BitflowPoolData[]) => number | null;
  readActiveBin: (contract: string) => Promise<{ okay: boolean; result?: string }>;
  fetchBins: (poolId: string) => Promise<BinsResponse>;
  fetchFeeRate: () => Promise<number | { transfer_fee_estimate?: number }>;
};

/** What the engine actually does. Overridden only by tests. */
export const liveGuardianReads: GuardianReads = {
  // The market price in this answer is compared with a bin price read seconds later, so a
  // cached answer older than 20s is fetched again rather than carried toward the 30s limit.
  fetchPools: () => fetchBitflowPools(20_000).catch(() => null),
  poolsReadAt: (pools) => _poolsReadAt.get(pools) ?? null,
  readActiveBin: (contract) => callReadOnly(contract, "get-active-bin-id", []),
  fetchBins: (poolId) => fetchJson<BinsResponse>(`${BITFLOW_API}/api/quotes/v1/bins/${poolId}`),
  fetchFeeRate: () => fetchJson<number | { transfer_fee_estimate?: number }>(`${HIRO_API}/v2/fees/transfer`),
};

export async function checkGuardian(
  scout: ScoutResult,
  opts: {
    targetPoolId?: string | null;
    /**
     * What "not applicable" applies TO, in the caller's own words.
     *
     * Without it these two rows say "no HODLMM pool is involved", which is a claim
     * about the whole run. From `scan` that claim can be false: the rows describe
     * only the single top-ranked option, and when that option is a Zest, Hermetica
     * or Granite one, the same report can list HODLMM pools as deployable
     * underneath. A reader acting on one of those was reading a green table that
     * measured nothing about it.
     *
     * The caller that knows the scope supplies it. Callers that gate a single
     * named operation pass nothing and get the generic wording, which is true for
     * them.
     */
    notApplicableScope?: string | null;
    /** The same, for the volume row. Separate because each names its own gate. */
    notApplicableVolumeScope?: string | null;
  } = {},
  reads: GuardianReads = liveGuardianReads,
): Promise<GuardianResult> {
  const refusals: string[] = [];

  // The pool these two gates measure, or null when the operation touches none.
  //
  // It used to default to `dlmm_1` and `scan` passed nothing, so the Safety Gates
  // table always described the sBTC/USDCx pool whatever pool it recommended.
  // Measured on 2026-08-28: the report recommended `dlmm_4` and printed
  // "24h Volume PASS $508,489", which is dlmm_1's figure. dlmm_4 did $5,729, below
  // this file's own $10,000 floor. The table printed a pass for a pool that would
  // have failed its own gate.
  const targetPoolId = opts.targetPoolId ?? null;
  const targetPoolDef = targetPoolId
    ? HODLMM_POOLS.find(p => `dlmm_${p.id}` === targetPoolId) ?? null
    : null;
  const poolName = targetPoolDef?.name ?? null;

  // What the two pool gates say when there is no pool to measure.
  //
  // These are WHOLE sentences and nothing is appended to them. An earlier version
  // took a fragment from the caller and glued ", so pool slippage does not apply
  // to it" onto the end. When `scan` supplied a fragment ending in a warning, the
  // glued clause attached to the warning instead of to the subject, so the cell
  // finished by saying slippage did not apply to the very pools it was warning
  // were unmeasured. It was the last thing on the line, and it is rendered to
  // users verbatim.
  const naSlippage = opts.notApplicableScope
    ?? "no HODLMM pool is involved in this operation, so pool slippage does not apply to it";
  const naVolume = opts.notApplicableVolumeScope
    ?? "no HODLMM pool is involved in this operation, so pool volume does not apply to it";

  /** A gate that had no pool to measure. Not a failure, and never blocking. */
  const notApplicable = (why: string): PoolGate => ({
    ok: true, status: "not-applicable", value: null,
    pool_id: null, pool_name: null, source: why,
  });

  /** A gate that had a pool and could not measure it. Always blocking. */
  const unknown = (why: string): PoolGate => ({
    ok: false, status: "unknown", value: null,
    pool_id: targetPoolId, pool_name: poolName, source: why,
  });

  // 1. Price source gate
  const pricesOk = scout.prices.sbtc > 0 && scout.prices.stx > 0;
  if (!pricesOk) refusals.push("Price data unavailable: cannot calculate USD values safely");

  const guardianPools = targetPoolId
    ? await reads.fetchPools()
    : [];
  const poolsReadAt = guardianPools && targetPoolId ? reads.poolsReadAt(guardianPools) : null;

  // 2. Slippage: the HODLMM active bin price against the market price.
  //
  // Every route out of this that is not a measurement now says so. There were
  // seven ways to reach `ok: true` without measuring anything, and all seven
  // reported a percentage of 0.
  const slippage: PoolGate = await (async (): Promise<PoolGate> => {
    const targetPool = targetPoolId && guardianPools
      ? guardianPools.find(p => p.poolId === targetPoolId) ?? null
      : null;

    let activeBinOkay = false;
    let bins: BinsResponse | null = null;
    let readError: string | null = null;
    let binsReadAt: number | null = null;

    // The reads run only when the cheap checks would not already decide, which is
    // the same order as before: no pool, unknown pool, dead endpoint, pool absent
    // and missing token metadata all settle without touching the network.
    if (targetPoolId && targetPoolDef && guardianPools && targetPool && targetPool.tokens) {
      try {
        const abr = await reads.readActiveBin(targetPoolDef.contract);
        activeBinOkay = Boolean(abr.okay && abr.result);
        if (activeBinOkay) {
          bins = await reads.fetchBins(targetPoolId);
          binsReadAt = Date.now();
        }
      } catch (e) {
        readError = (e as Error).message;
      }
    }

    const { gate, refusal } = classifySlippage({
      targetPoolId, knownPool: targetPoolDef !== null, poolName,
      pools: guardianPools, targetPool, activeBinOkay, bins, readError,
      poolsReadAt, binsReadAt,
      notApplicableText: naSlippage,
    });
    if (refusal) refusals.push(refusal);
    return gate;
  })();
  // The refusal for both the unknown and the over-cap case is produced by
  // `classifySlippage` and pushed at the call site above. It used to be pushed
  // here as well, which would have listed the same reason twice.

  // 3. Volume, on the same pool. This gate already failed closed, which is why the
  //    two disagreed on the same failed fetch; now they agree.
  const volume: PoolGate = (() => {
    if (!targetPoolId) return notApplicable(naVolume);
    if (guardianPools === null) return unknown("the Bitflow pools endpoint did not answer");
    const targetPool = guardianPools.find(p => p.poolId === targetPoolId);
    if (!targetPool) return unknown(`${targetPoolId} was not in the pools the endpoint returned`);
    const usd = targetPool.volumeUsd1d;
    if (typeof usd !== "number" || !Number.isFinite(usd)) return unknown(`${targetPoolId} came back without a 24h volume figure`);
    const ok = usd >= MIN_24H_VOLUME_USD;
    if (!ok) refusals.push(`24h volume $${Math.round(usd)} on ${targetPoolId} < $${MIN_24H_VOLUME_USD} minimum`);
    return {
      ok, status: ok ? "pass" : "fail", value: round(usd, 2),
      pool_id: targetPoolId, pool_name: poolName, source: "bitflow-app-pools-volumeUsd1d",
    };
  })();
  if (volume.status === "unknown") {
    refusals.push(`24h volume could not be measured on ${targetPoolId}: ${volume.source}.`);
  }

  // 4. Gas. Same treatment: a failed estimate is not a cheap transaction.
  let gas: GuardianResult["gas"];
  try {
    // `/v2/fees/transfer` answers with a BARE NUMBER, the fee rate in microSTX per
    // byte. It is not an object, so `fees.transfer_fee_estimate` has always been
    // undefined and the old `?? 6` meant this gate never measured anything: it
    // reported a hardcoded 6 as though it were an estimate, for every run. Found
    // by curling the endpoint while checking why it now says unknown.
    const fees = await reads.fetchFeeRate();
    const estimate = typeof fees === "number" ? fees : fees?.transfer_fee_estimate;
    // A rate of 0 is not a cheap network, it is a response that carried no rate:
    // a schema change, an empty numeric field, a proxy placeholder. Without this,
    // `0` passes both checks below, `ok` becomes true, and the table prints
    // `PASS | 0 STX`, which is the exact "a check that did not run reported a
    // pass" defect this phase exists to remove. This file already applies the
    // same rule to prices, where a zero counts as "did not return" because no
    // token here is ever genuinely worth nothing.
    if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate <= 0) {
      throw new Error("the response carried no usable fee rate");
    }
    // Four decimals, not two. The live rate is single digit microSTX per byte, so
    // a real cost of 0.0072 STX rounded to two places renders as "0 STX", which
    // tells a person gas is free. It is not.
    const gasStx = round(estimate * GAS_ASSUMED_TX_BYTES / 1e6, 4);
    const ok = gasStx <= MAX_GAS_STX;
    if (!ok) refusals.push(`Estimated gas ${gasStx} STX > ${MAX_GAS_STX} STX cap`);
    gas = { ok, status: ok ? "pass" : "fail", estimated_stx: gasStx, source: `hiro-v2-fees-transfer, microSTX per byte times an assumed ${GAS_ASSUMED_TX_BYTES} byte transaction` };
  } catch (e) {
    gas = { ok: false, status: "unknown", estimated_stx: null, source: `the fee estimate failed: ${(e as Error).message}` };
    refusals.push(`Gas could not be estimated: ${gas.source}. Refusing rather than assuming it is affordable.`);
  }

  // 5. Cooldown
  const state = readState();
  let cooldownOk = true;
  let cooldownRemaining = 0;
  if (state.last_rebalance_at) {
    const elapsed = (Date.now() - new Date(state.last_rebalance_at).getTime()) / 3_600_000;
    cooldownRemaining = round(Math.max(0, COOLDOWN_HOURS - elapsed), 2);
    cooldownOk = cooldownRemaining === 0;
    if (!cooldownOk) refusals.push(`Cooldown: ${cooldownRemaining}h remaining`);
  }

  // Note: relay health is checked at MCP runtime layer, not duplicated here.
  // Guardian gates: slippage, volume, gas, cooldown, prices (5 gates).

  return {
    can_proceed: refusals.length === 0, refusals,
    slippage, volume, gas,
    cooldown: { ok: cooldownOk, remaining_hours: cooldownRemaining },
    prices: { ok: pricesOk, detail: pricesOk ? "all prices live" : "missing price data" },
  };
}

// =============================================================================
// ==  EXECUTOR MODULE
// =============================================================================
// Outputs INSTRUCTIONS for the agent runtime to execute via MCP.
// The engine does not hold private keys or sign transactions.

type Protocol = "zest" | "hermetica" | "granite" | "hodlmm";

interface ExecuteInstruction {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

// -- Bitflow DLMM swap routes ---------------------------------------------------
// Maps (tokenIn, tokenOut) to the DLMM pool and direction for swap-simple-multi.
// Each route is a single-hop swap through a known Bitflow DLMM pool.
interface DlmmSwapRoute {
  pool: string;          // pool contract principal
  xToken: string;        // x-token-trait principal (the pool's X token contract)
  yToken: string;        // y-token-trait principal (the pool's Y token contract)
  xForY: boolean;        // true = selling X for Y, false = selling Y for X
  inputSymbol: string;   // symbol of the input token (key into TOKENS)
  outputSymbol: string;  // symbol of the output token (key into TOKENS)
}

function getDlmmSwapRoute(tokenIn: string, tokenOut: string): DlmmSwapRoute | null {
  // A route is ONE pool that holds both coins (the owner's single path rule). These two
  // pools hold USDCx, not STX: accepting "stx" here built a swap whose condition spends
  // USDCx while the person named STX and the balance check read STX (BUILD-ORDER stage 5,
  // item 21). With no route, the deposit is refused as a build of only notes.
  // USDCx → aeUSDC (pool: aeUSDC/USDCx, selling Y for X)
  if (tokenIn === "usdcx" && tokenOut === "aeusdc") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-aeusdc-usdcx-v-1-bps-1",
      xToken: AEUSDC_TOKEN, yToken: USDCX_TOKEN, xForY: false,
      inputSymbol: tokenIn, outputSymbol: tokenOut,
    };
  }
  // USDCx → USDh (pool: USDh/USDCx, selling Y for X)
  if (tokenIn === "usdcx" && tokenOut === "usdh") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-usdh-usdcx-v-1-bps-1",
      xToken: USDH_TOKEN, yToken: USDCX_TOKEN, xForY: false,
      inputSymbol: tokenIn, outputSymbol: tokenOut,
    };
  }
  // sBTC → USDCx (pool: sBTC/USDCx 10bps, selling X for Y)
  if (tokenIn === "sbtc" && tokenOut === "usdcx") {
    return {
      pool: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10",
      xToken: SBTC_TOKEN, yToken: USDCX_TOKEN, xForY: true,
      inputSymbol: tokenIn, outputSymbol: tokenOut,
    };
  }
  return null;
}

// Default slippage by pair volatility profile.
// Stable-stable pairs use tight tolerance; volatile pairs need more room.
function defaultSlippagePct(route: DlmmSwapRoute): number {
  const stable = [USDCX_TOKEN, AEUSDC_TOKEN, USDH_TOKEN];
  const bothStable = stable.includes(route.xToken) && stable.includes(route.yToken);
  return bothStable ? 0.5 : 3;
}

/**
 * A token balance back in its smallest unit, recovered exactly.
 *
 * **`Math.floor` here loses a satoshi, and the engine then states a balance that
 * is not the person's balance.** `scout.balances[x].amount` is a float made by
 * dividing an exact integer by a power of ten and rounding to that many places.
 * Multiplying back lands a hair under on the values that cannot be represented
 * exactly, and flooring turns the hair into a whole unit: measured, 155 of 2,001
 * sampled sBTC balances failed to round trip, and 123456789 sats read back as
 * 123456788.
 *
 * The visible consequence is a refusal nobody can act on. Deposit your exact full
 * balance and you are told "you hold 123456788 and named 123456789", where the
 * number the engine quotes as yours is wrong and typing it would still fail.
 *
 * `Math.round` recovered the integer, because the float is always within half a
 * unit of it. That was a patch on a float; since 16 September the exact figure Hiro
 * returned is carried beside the float (`TokenBalance.atomic`) and read here, so there
 * is no round trip at all (KB: amounts are integers end to end).
 */
export function atomicOf(balance: { atomic?: unknown } | undefined): bigint {
  // A balance without its exact figure is not read as a zero that could pass a guard
  // silently in either direction: it is a programming error, and it says so.
  if (balance === undefined) return 0n;
  if (typeof balance.atomic !== "string" || !/^[0-9]+$/.test(balance.atomic)) {
    throw new Error("a wallet balance arrived without its exact smallest unit figure");
  }
  return BigInt(balance.atomic);
}

/**
 * An atomic integer as the token amount a person recognises.
 *
 * The other direction from `atomicOf`, and done in BigInt rather than
 * by dividing a float, because this one is read by somebody deciding whether to
 * sign. A deposit line printed "at most 100000000 USDh" for one USDh, which is
 * a false statement about their money by a factor of a hundred million, and
 * float division would trade that error for a quieter one at eight decimals.
 *
 * Trailing zeros are trimmed so a whole number reads as "1" and not "1.00000000".
 */
function humanAmount(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const rest = atomic % scale;
  if (rest === 0n) return whole.toString();
  const frac = rest.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${frac}`;
}

type BinsResponse = { bins?: Array<{ bin_id: number; price?: string }>; active_bin_id?: number };

/**
 * Everything the slippage gate needs once its reads are done, so the DECIDING is
 * separable from the FETCHING.
 */
export type SlippageReads = {
  targetPoolId: string | null;
  /** Whether `targetPoolId` names a pool in this engine's table. */
  knownPool: boolean;
  poolName: string | null;
  /** Null when the pools endpoint did not answer. */
  pools: BitflowPoolData[] | null;
  /** The row for `targetPoolId` in `pools`, or null if it was absent. */
  targetPool: BitflowPoolData | null;
  /** Whether the contract returned an active bin. */
  activeBinOkay: boolean;
  /** The bins payload, or null if it was never fetched. */
  bins: BinsResponse | null;
  /** The message from a throw during the reads, or null. */
  readError: string | null;
  /** When the pools answer (the market price) was fetched, ms since epoch, or null. */
  poolsReadAt: number | null;
  /** When the bins answer (the bin price) arrived, ms since epoch, or null. */
  binsReadAt: number | null;
  /** The whole sentence to use when no pool is involved. */
  notApplicableText: string;
};

/**
 * The slippage verdict, and the refusal it produces if any.
 *
 * **Extracted so the phase's own acceptance test can exist.** The build plan
 * requires "a slippage check that cannot run reports unknown, never a pass,
 * proved by a control that forces the failure". There are nine ways for this
 * check to fail to measure anything, none of them reachable from outside while
 * the decision sat inside a closure around live `fetch` calls. A gate nobody can
 * force cannot be proved to fail closed, and this whole phase exists because
 * seven of those nine routes used to report a PASS with a percentage of 0.
 *
 * Pure. No network, no clock, no module state. Every route is a control.
 */
export function classifySlippage(r: SlippageReads): { gate: PoolGate; refusal: string | null } {
  const notApplicable = (why: string): { gate: PoolGate; refusal: null } => ({
    gate: { ok: true, status: "not-applicable", value: null, pool_id: null, pool_name: null, source: why },
    refusal: null,
  });
  const unknown = (why: string): { gate: PoolGate; refusal: string } => ({
    gate: { ok: false, status: "unknown", value: null, pool_id: r.targetPoolId, pool_name: r.poolName, source: why },
    refusal: `Slippage could not be measured on ${r.targetPoolId}: ${why}. Refusing rather than reporting a pass for a check that did not run.`,
  });

  if (!r.targetPoolId) return notApplicable(r.notApplicableText);
  if (!r.knownPool) return unknown(`${r.targetPoolId} is not a pool this engine knows`);
  if (r.pools === null) return unknown("the Bitflow pools endpoint did not answer");
  if (!r.targetPool) return unknown(`${r.targetPoolId} was not in the pools the endpoint returned`);
  if (!poolIsLive(r.targetPool)) return unknown(`${r.targetPoolId} is not marked active on Bitflow (paused, or no status returned)`);
  if (!r.targetPool.tokens) return unknown(`${r.targetPoolId} came back without token metadata, so decimals are unknown`);
  if (r.readError !== null) return unknown(`the slippage read failed: ${r.readError}`);
  if (!r.activeBinOkay) return unknown("the pool contract did not return its active bin");
  if (r.bins === null) return unknown("the bins endpoint returned nothing");
  // Matched freshness (KB, and the upstream recipe): the two prices compared must be read
  // within 30 seconds of each other, not merely each be recent. The market price came from a
  // one minute cache while the bin price was fresh, so a fast move could read a real 0.9%
  // divergence as 0.3% and pass.
  if (r.poolsReadAt === null || r.binsReadAt === null) return unknown("the time either price was read is not known, so they cannot be compared");
  const apartMs = Math.abs(r.binsReadAt - r.poolsReadAt);
  if (apartMs > MATCHED_FRESHNESS_MS) return unknown(`the market price and the bin price were read ${Math.round(apartMs / 1000)} seconds apart, more than ${MATCHED_FRESHNESS_MS / 1000}`);

  const activeBinId = r.bins.active_bin_id ?? 0;
  const activeBinData = r.bins.bins?.find(b => b.bin_id === activeBinId);
  if (!activeBinData?.price) return unknown(`no price for active bin ${activeBinId} on ${r.targetPoolId}`);

  const binPrice = parseFloat(activeBinData.price);
  if (!Number.isFinite(binPrice)) return unknown(`the active bin price on ${r.targetPoolId} was not a number`);

  const marketPrice = r.targetPool.tokens.tokenX.priceUsd;
  if (!(marketPrice > 0)) return unknown(`no market price for ${r.targetPool.tokens.tokenX.symbol ?? "tokenX"}, so divergence cannot be computed`);

  // THE BIN PRICE IS DENOMINATED IN Y, AND THE MARKET PRICE IS IN USD. Converting
  // between them needs Y's own price, and leaving it out compares two different
  // units as though they were the same number.
  //
  // It was invisible for as long as the gate only ever measured dlmm_1, and for
  // seven of the eight pools in the table, because they quote against USDCx at
  // exactly $1.00 so the conversion is a multiplication by one. `dlmm_6`
  // (STX-sBTC) quotes against sBTC at about $79,416.
  //
  // Measured live on 2026-08-28: dlmm_6's active bin gives an X price of
  // 0.0000033481 in sBTC. Compared against STX's $0.267807 that reads as
  // **99.9987% divergence**, a fabricated number of exactly the class this phase
  // exists to delete. Multiplied by Y's price it is $0.265893, a real divergence
  // of 0.71%.
  //
  // The real divergence sits NEAR the cap and moves: measured at 0.71% one hour
  // and 0.244% the next, so the corrected gate refuses dlmm_6 sometimes and admits
  // it others, which is what a working gate looks like. The fabricated figure was
  // 99.99% every time. dlmm_6 is also the only one of the three highest APR pools
  // clearing the $10,000 volume floor, so for a STX or sBTC holder this was the
  // best venue available and the engine was telling them it was 99.99% out of
  // line.
  const quotePriceUsd = r.targetPool.tokens.tokenY.priceUsd;
  if (!(quotePriceUsd > 0)) return unknown(`no market price for ${r.targetPool.tokens.tokenY.symbol ?? "tokenY"}, the token this pool quotes in, so divergence cannot be computed`);

  const hodlmmPriceUsd = (binPrice / PRICE_SCALE)
    * Math.pow(10, r.targetPool.tokens.tokenX.decimals - r.targetPool.tokens.tokenY.decimals)
    * quotePriceUsd;
  const pct = round(Math.abs(hodlmmPriceUsd - marketPrice) / marketPrice * 100, 4);
  if (!Number.isFinite(pct)) return unknown(`divergence on ${r.targetPoolId} did not compute to a number`);

  const ok = pct <= MAX_SLIPPAGE_PCT;
  return {
    gate: {
      ok, status: ok ? "pass" : "fail", value: pct,
      pool_id: r.targetPoolId, pool_name: r.poolName,
      source: "bitflow-app-price-vs-hodlmm-active-bin",
    },
    refusal: ok ? null : `Slippage ${pct}% > ${MAX_SLIPPAGE_PCT}% cap on ${r.targetPoolId}`,
  };
}

/**
 * Whether a refusal should carry the line explaining that the gate is about the
 * pool being moved INTO, not the position being left.
 *
 * Extracted because the decision had no test: it lived inside `_runPipeline`,
 * which no case reaches, and a mutation restoring the "fires on any refusal"
 * defect left the whole suite green.
 *
 * It must be true wherever it appears. It is false unless a POOL gate is what
 * failed: `guardian.refusals` also carries price, gas and cooldown failures, and
 * none of those is about the destination.
 */
export function explainsDestinationPool(args: {
  command: string;
  from: string | undefined;
  targetPoolId: string | null;
  slippageStatus: GateStatus;
  volumeStatus: GateStatus;
}): boolean {
  const poolGateFailed = args.slippageStatus === "fail" || args.slippageStatus === "unknown"
    || args.volumeStatus === "fail" || args.volumeStatus === "unknown";
  return args.command === "migrate" && args.from === "hodlmm" && poolGateFailed && args.targetPoolId !== null;
}

/**
 * What `scan` hands the guardian: the pool to measure, and what to say when there
 * is none.
 *
 * **Extracted because Phase 1's headline item had no test.** Item p1-0 is "the
 * safety table measures the pool being recommended". Reverting this to the old
 * hardcoded `"dlmm_1"` left all 165 cases green, so the phase's first fix could
 * have been undone invisibly. That is the live defect of 2026-08-28, where the
 * report recommended dlmm_4 and printed dlmm_1's $508,489 volume as a pass while
 * dlmm_4 sat at $5,729 and 10.86% slippage.
 *
 * Pure, so the decision is forced directly.
 */
export function scanGuardianInput(options: YieldOption[]): {
  targetPoolId: string | null;
  notApplicableScope: string | null;
  notApplicableVolumeScope: string | null;
} {
  // The top ACTIONABLE option, which is the one being recommended, whichever tier
  // it landed in.
  //
  // This looked only at `deploy_now`. That was fine while holding one side of a
  // pair counted as deploy_now, and stopped being fine the moment two sided entry
  // made such a wallet `swap_first`: a STX only wallet then had no deploy_now
  // option at all, so nothing was measured and the safety table reported "no
  // HODLMM pool is involved" while the report recommended one. The gates matter
  // for the pool the person will end up in, and a swap first entry ends up in the
  // same pool.
  // The SAME answer the headline uses, from the same function.
  //
  // This ran its own tier preference and had no 0% filter, so with a 0% Zest
  // deploy-now row present the headline recommended a 600% HODLMM pool while this
  // picked Zest, whose `pool_id` is undefined, and measured nothing. The report
  // then said "the recommended option is Zest sBTC Supply, which touches no HODLMM
  // pool" seven sections under a headline recommending dlmm_4. Two functions
  // answering one question differently is the fault this phase keeps finding.
  const recommendedOpt = bestMove(options).best ?? null;
  const recommended = recommendedOpt?.pool_id ?? null;

  // The HODLMM options a reader can see and act on that these two gates did NOT
  // measure. Non-empty only when the top ranked option is not a HODLMM one, which
  // is exactly when the old wording claimed no HODLMM pool was involved while the
  // report listed HODLMM pools as ready to deploy into.
  const uncovered = recommended
    ? []
    : options.filter(o => (o.tier === "deploy_now" || o.tier === "swap_first") && o.pool_id).map(o => `${o.pool_id} (${o.pool})`);

  // Built ONLY when there is no pool to measure. Computing it unconditionally
  // produced "the recommended option is HODLMM sBTC-USDCx-10bps, which touches no
  // HODLMM pool" whenever the recommendation WAS a HODLMM pool.
  //
  // Each branch is a complete sentence, because nothing is appended to it.
  const scopeFor = (what: string): string | null => {
    if (recommended) return null;
    if (!recommendedOpt) {
      // Note the wording. `options` is also empty when the yield read failed, and
      // "there is nothing to deploy now" would be a claim about somebody's
      // opportunities derived from a read that did not return.
      return `no option was ranked first this run, so no pool was measured and pool ${what} does not apply`;
    }
    const head = `the recommended option is ${recommendedOpt.protocol} ${recommendedOpt.pool}, which touches no HODLMM pool, so pool ${what} does not apply to it`;
    return uncovered.length
      ? `${head}. WARNING: this row does NOT cover the HODLMM options listed above (${uncovered.join(", ")}), and nothing in this run measured them`
      : head;
  };

  return {
    targetPoolId: recommended,
    notApplicableScope: scopeFor("slippage"),
    notApplicableVolumeScope: scopeFor("volume"),
  };
}

/**
 * The yield option that describes THIS deploy, or undefined.
 *
 * Extracted from an inline expression in `_runPipeline` so it can be tested: a
 * mutation reverting the HODLMM rule below survived the suite because nothing
 * could reach the expression.
 *
 * The protocol-only fallback exists for zest, hermetica and granite, whose
 * options carry no `pool_id`. **It must never apply to HODLMM.** `--pool-id`
 * carries a commander default of "dlmm_1", so `poolWanted` is never unset on a
 * deploy and the "no pool was named" case the fallback was written for does not
 * arise. What it actually did was fire when the REQUESTED pool is missing from
 * the options, which happens when `getYieldOptions` skipped it for
 * `apr24h <= 0`. It then took the first HODLMM option in a list sorted by APY
 * descending, which is the highest yielding pool in the report. A deposit into a
 * pool earning nothing would have been described with another pool's headline
 * APY, and the 0% APY refusal that reads this would never fire, because it was
 * reading a different pool.
 *
 * Returning undefined is the honest answer: the caller then reports no economics
 * rather than somebody else's.
 */
/**
 * Why a deposit is refused for its rate, or null when the rate does not refuse it.
 *
 * A 0% row refuses unless forced, as it always has. A Zest deposit with NO row
 * refuses too: an unreadable Zest rate used to arrive as a 0% row and be refused
 * by the first rule, and it is now left out of the options instead, so without
 * the second rule the deposit would go ahead with no rate known at all.
 */
export function rateRefusal(protocol: string, targetOpt: YieldOption | undefined, force: boolean): string | null {
  if (force) return null;
  if (targetOpt && targetOpt.apy_pct === 0) return `${protocol} APY is 0%. Use --force to override.`;
  if (protocol === "zest" && !targetOpt) return "Zest's supply rate could not be read this run, so there is no yield to weigh this deposit against. Run the scan again.";
  return null;
}

export function selectTargetOption(
  options: YieldOption[], protocol: string, poolWanted: string | null,
  /** The coin being deposited. A Zest deposit is weighed against its own vault's row only. */
  token?: string,
): YieldOption | undefined {
  const exact = poolWanted
    ? options.find(o => o.protocol.toLowerCase() === protocol && o.pool_id === poolWanted)
    : undefined;
  if (exact) return exact;
  if (protocol === "hodlmm") return undefined;
  if (protocol === "zest" && token) {
    return options.find(o => o.protocol.toLowerCase() === "zest" && o.token_needed.toLowerCase() === token.toLowerCase());
  }
  return options.find(o => o.protocol.toLowerCase() === protocol);
}

/**
 * Which HODLMM pool an operation will actually touch, or null when none.
 *
 * It used to return `dlmm_1` for everything it did not recognise, so a Zest
 * withdraw was gated on the slippage and volume of a pool it never goes near.
 * A refusal computed from an unrelated venue is not protection, it is noise, and
 * a pass computed from one is worse: it reads as a check that happened.
 *
 * Null means "these two gates do not apply here", which the guardian reports as
 * exactly that rather than measuring something irrelevant.
 */
export function inferTargetPoolId(command: string, opts: Record<string, string>): string | null {
  const protocol = opts.protocol;
  const token = opts.token;
  if (command === "deploy") {
    // The pool follows the ROUTE, not merely "a token that is not the deposit token": only USDCx
    // has a route (16 September, item 21), so any other token builds no swap and is refused for
    // that reason, never for the volume of a pool it would not touch.
    if (protocol === "hermetica" && token === "usdcx") return "dlmm_8";  // USDh/USDCx swap pool
    if (protocol === "granite" && token === "usdcx") return "dlmm_7";  // aeUSDC/USDCx swap pool
    if (protocol === "hodlmm") return ((opts as Record<string, string>).poolId ?? "dlmm_1");  // honor --pool-id for HODLMM direct deploy
    return null;  // hermetica or granite already holding the right token, or zest: no pool leg
  }
  if (command === "migrate") {
    // Ask WHICH TOKEN, exactly as the deploy branch above does.
    //
    // This used to send every `--to hermetica` to dlmm_8 and every `--to granite`
    // to dlmm_7 without asking. Both defaults (usdh, aeusdc) build a DIRECT
    // deposit with no swap leg, so the gate measured a pool the transaction never
    // touches. On 2026-08-28 dlmm_7 ($7,337) and dlmm_8 ($3,487) were both under
    // the $10,000 volume floor, so both migrations were refused live, naming a
    // pool that appears nowhere in their instruction list, while the identical
    // deposit through `deploy` was allowed. Same money, same instruction,
    // opposite answer.
    //
    // `opts.token` is already lowercased by `_runPipeline`.
    //
    // Resolving the default cannot currently change the outcome, and saying so
    // matters: `inferToken` returns exactly the token that needs no swap for each
    // protocol, so the defaulted value always takes the same branch as no token at
    // all. A mutation deleting the default leaves every test green. It is kept
    // because it makes the judgement explicit and because it WOULD bite the moment
    // `inferToken` returns anything else, but it is not doing work today and must
    // not be read as a guard that is.
    const to = opts.to;
    const toToken = opts.token ?? (["zest", "hermetica", "granite", "hodlmm"].includes(to) ? inferToken(to as Protocol) : undefined);
    if (to === "hermetica" && toToken === "usdcx") return "dlmm_8";
    if (to === "granite" && toToken === "usdcx") return "dlmm_7";
    if (to === "hodlmm") return ((opts as Record<string, string>).poolId ?? "dlmm_1");
    return null;  // a direct deposit with no swap leg, or zest: no pool is touched
  }
  // `rebalance` is nothing BUT a HODLMM pool operation: it withdraws every
  // position in `--pool-id` and re-adds across eleven bins around the active bin.
  // It was returning null here, which switched both pool gates off for the one
  // command where the pool is named on the command line and is never in doubt.
  // A pool whose 24h volume had collapsed would have been re-entered with the
  // report stating that no HODLMM pool was involved.
  if (command === "rebalance") return ((opts as Record<string, string>).poolId ?? "dlmm_1");
  return null;
}

/**
 * Why the two pool gates do not apply, when they do not, in words a reader can
 * check.
 *
 * The gates cannot explain their own absence: the default sentence claims the
 * operation touches no HODLMM pool, which is false for a HODLMM exit. Whoever
 * knows the command supplies the reason, the same way `scan` supplies its own.
 *
 * Returns null when the gates DO apply, so a caller that passes this through
 * cannot accidentally attach an excuse to a gate that ran.
 */
export function poolGateScope(command: string, opts: Record<string, string>): string | null {
  if (inferTargetPoolId(command, opts) !== null) return null;
  // A HODLMM exit, by either route. `migrate --from hodlmm` withdraws every
  // position as its FIRST instruction, so the generic wording below, which says
  // the run "moves no HODLMM liquidity", was a false statement about a run whose
  // opening step is a HODLMM withdraw. It is rendered to users verbatim.
  const leavingHodlmm = (command === "withdraw" && opts.protocol === "hodlmm")
    || (command === "migrate" && opts.from === "hodlmm");
  if (leavingHodlmm) {
    // Deliberate, and narrower than an earlier version of this comment claimed.
    //
    // It said "leaving is always allowed". That is false: a migration OUT of
    // HODLMM can still be refused on the pool it moves INTO. The example that
    // comment used, `migrate --from hodlmm --to granite`, stopped being one the
    // round afterwards, when the gate learned to ask which token: with granite's
    // default aeusdc there is no swap leg and no pool at all. The live case is
    // `migrate --from hodlmm --to granite --token usdcx`, which does route through
    // dlmm_7, and dlmm_7 was under the volume floor on 2026-08-28.
    //
    // That refusal is correct. Withdrawing and then swapping at a bad rate is a
    // worse outcome than not starting, and a half done migration is the thing
    // this phase exists to prevent. What is true is narrower and is what this
    // sentence now says: the pool being LEFT is never the reason. A plain
    // `withdraw --protocol hodlmm` reaches this branch and is never gated at all.
    return `this is an exit from a HODLMM pool, and the pool being left is never the reason a run is blocked`;
  }
  if (command === "withdraw" || command === "migrate") {
    return `${command} from ${opts.protocol ?? opts.from ?? "this protocol"} moves no HODLMM liquidity, so pool slippage and volume do not apply to it`;
  }
  return null;
}

// Estimate expected swap output in output-token atomic units, given input amount + scout prices.
// Used by callers of buildDlmmSwapInstruction to derive the min-received guard correctly.
function expectedSwapOutput(
  inputAmount: number,
  inputSymbol: string,
  outputSymbol: string,
  prices: { sbtc: number; stx: number; usdcx: number; usdh: number; aeusdc: number },
): number {
  const inputMeta = TOKENS[inputSymbol];
  const outputMeta = TOKENS[outputSymbol];
  if (!inputMeta || !outputMeta) return 0;
  const priceMap = prices as Record<string, number>;
  const inputPrice = priceMap[inputSymbol] ?? (["usdcx","usdh","aeusdc","susdh"].includes(inputSymbol) ? 1 : 0);
  const outputPrice = priceMap[outputSymbol] ?? (["usdcx","usdh","aeusdc","susdh"].includes(outputSymbol) ? 1 : 0);
  if (inputPrice <= 0 || outputPrice <= 0) return 0;
  const inputUsd = (inputAmount / Math.pow(10, inputMeta.decimals)) * inputPrice;
  const expectedOutUnits = inputUsd / outputPrice;
  return Math.floor(expectedOutUnits * Math.pow(10, outputMeta.decimals));
}

// Build a call_contract instruction for a Bitflow DLMM swap.
// Uses swap-simple-multi with a single swap in the list.
//
// Safety pattern (matches sibling skill bff-skills#494 commit 02d10989 + knowledge-base.md
// line 438 "allow + sender-pin on routable fee flows, deny where unambiguous"):
//   - postConditionMode: "allow" with a dual-pin envelope
//   - 2-entry post-conditions: caller's max input (willSendLte) + pool's min output (willSendGte)
//   - min-received computed in OUTPUT-token atomic units (caller passes `expectedOut`)
//   - max-steps u230 (per macbotmini-eng's #339 audit (d))
//
// Rationale for Allow-not-Deny: @macbotmini-eng's #494 audit established that DLMM swap
// fees accrue inside dlmm-core's unclaimed-protocol-fees map and bin balances: they do
// NOT emit FT transfer events on the swap tx (verified on-chain against 0x134df5e1 /
// 0x5195822e / #494 proof tx 0xf4f49328). Under that verified fee flow, the pool-side
// willSendGte pin IS the receive-side fund-safety protection; Deny mode adds no further
// guarantee AND empirically over-constrains on stable-stable pools (tx 0x5986066a on
// dlmm_7 aborted with abort_by_post_condition under Deny+2PC while the same envelope
// shape works on dlmm_1 / dlmm_6 / dlmm_3 under Allow). KB line 438 explicitly scopes
// Deny to "unambiguous" cases like Granite redeem.
function buildDlmmSwapInstruction(
  route: DlmmSwapRoute,
  caller: string,
  amount: number,
  expectedOut: number,
  slippagePct?: number,
): ExecuteInstruction {
  slippagePct = slippagePct ?? defaultSlippagePct(route);
  // min-received is in OUTPUT-token atomic units (router arg expectation, verified against mainnet refs).
  const minReceived = Math.max(1, Math.floor(expectedOut * (1 - slippagePct / 100)));

  // Derive actual on-chain swap assets from route direction (single source of truth).
  const inputAsset = route.xForY ? route.xToken : route.yToken;
  const outputAsset = route.xForY ? route.yToken : route.xToken;
  const inputMeta = TOKENS_BY_CONTRACT[inputAsset];
  const outputMeta = TOKENS_BY_CONTRACT[outputAsset];

  // 2-entry post-condition envelope mirroring the author's mainnet pattern:
  //   PC[0] caller sends ≤ amount of input asset
  //   PC[1] pool sends ≥ minReceived of output asset (output sourced from pool reserves)
  const postConditions: Array<Record<string, unknown>> = [
    {
      type: "ft",
      principal: caller,
      asset: inputAsset,
      assetName: inputMeta?.ftSuffix.replace("::", "") ?? "",
      conditionCode: "lte",
      amount: String(amount),
    },
    {
      type: "ft",
      principal: route.pool,
      asset: outputAsset,
      assetName: outputMeta?.ftSuffix.replace("::", "") ?? "",
      conditionCode: "gte",
      amount: String(minReceived),
    },
  ];

  const inSym = inputMeta?.symbol ?? route.inputSymbol;
  const outSym = outputMeta?.symbol ?? route.outputSymbol;
  return {
    tool: "call_contract",
    params: {
      contractAddress: DLMM_SWAP_ROUTER,
      contractName: DLMM_SWAP_ROUTER_NAME,
      functionName: "swap-simple-multi",
      functionArgs: [{
        type: "list", value: [{
          type: "tuple", value: {
            amount: { type: "uint", value: String(amount) },
            "max-steps": { type: "uint", value: "230" },
            "min-received": { type: "uint", value: String(minReceived) },
            "pool-trait": { type: "principal", value: route.pool },
            "x-for-y": { type: "bool", value: route.xForY },
            "x-token-trait": { type: "principal", value: route.xToken },
            "y-token-trait": { type: "principal", value: route.yToken },
          },
        }],
      }],
      postConditionMode: "allow",
      postConditions,
      requires_residual_check: true,
      _note: "Agent runtime: read consumed-in from tx receipt before chained deploy step. If consumed-in < amount, surface residual to caller (max-steps may have capped fold).",
    },
    description: `Swap ${amount} ${inSym} to min ${minReceived} ${outSym} via Bitflow DLMM (allow mode with a dual pin, ${slippagePct}% slip)`,
  };
}

/**
 * An amount in a token's smallest unit, or null if the text is not one.
 *
 * THE ONE PARSER FOR EVERY AMOUNT THIS FILE ACCEPTS. There used to be two, and
 * they disagreed on the same text while both were reading money:
 *
 *   text      old --amount (parseInt)   old --counter-amount (Number)
 *   "1e6"     1                         1000000
 *   "0x10"    0                          16
 *   "12abc"   12                        rejected
 *   "1_000"   1                         rejected
 *
 * So `deploy --amount 1e6 --counter-amount 1e6`, one intent typed twice, produced
 * 1 and 1000000, and both numbers reached the bins and the signing preview.
 *
 * Digits only, deliberately. No exponent, no hex, no separators, no sign, no
 * decimal point: an atomic unit is a whole count, and every one of those forms is
 * a way for a typo to become a different amount of somebody's money. Rejected,
 * never coerced, because a silently coerced amount is the same failure as an
 * invented one.
 */
export function parseAtomicAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const t = String(raw).trim();
  if (!/^[0-9]+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * The caller's second amount, or null when they did not name one.
 *
 * Throws on text that is not an amount, so the caller can turn it into a
 * structured error. Uses the one parser above, so the two amounts on a single
 * command can never be read by two different rules again.
 */
function parseCounterAmount(opts: Record<string, string>): number | null {
  const raw = (opts as Record<string, string>).counterAmount;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseAtomicAmount(raw);
  if (n === null) {
    throw new Error(`--counter-amount must be a positive whole number of the token's smallest unit, digits only, got "${raw}"`);
  }
  return n;
}

/**
 * What the deploy builder produces.
 *
 * `refusal` is non-null when the builder decided nothing should be built.
 *
 * It exists because a refusal used to be pushed as an `info` instruction and
 * nothing else, and the pipeline then returned `status: "ok"` (or `"preview"`)
 * carrying that note. A run that deposited nothing announced itself as a success.
 *
 * The pipeline's own balance check reported the identical fact as
 * `status: "error"`. One fact, two statuses. Both now say `refused`, which is
 * what made that claim true rather than merely stated: correcting the channel
 * here while leaving the other side on `error` would have moved the mismatch
 * rather than closed it.
 *
 * Note which guard actually fires on a deploy. The pipeline checks the balance
 * for every protocol and reaches it first, so the builder's balance refusal is a
 * backstop on that path, not the thing a user meets. It is the only guard on any
 * path where the pipeline check is absent, and it is exercised directly by
 * `tests/deploy-guards.test.ts`.
 *
 * Only the two balance guards below use this channel. The five older paths that
 * push only `info` notes (no swap route or no price to Hermetica or Granite, an
 * unknown pool) are not converted to it; instead `nothingToDeposit` refuses any
 * build whose steps are all notes, in `deploy` and `migrate` alike (16 September,
 * counted as five, not the eight this comment used to say).
 */
export type DeployBuild = { instructions: ExecuteInstruction[]; refusal: string | null };

export function buildDeployInstructions(
  protocol: Protocol, amount: number, token: string, scout: ScoutResult,
  poolId: string = "dlmm_1",
  /**
   * The second side of a HODLMM deposit, in the counter token's atomic units.
   *
   * Null means one sided. There is no default and no fallback to a balance: a
   * second asset moves only when a caller names how much of it to move.
   */
  counterAmount: number | null = null,
  /**
   * True when the money being deposited is already sitting in the wallet, so a
   * balance read can answer "do they hold enough".
   *
   * FALSE for `migrate`, where the amount is still inside the source protocol and
   * arrives only after the withdraw leg in this same instruction list executes.
   *
   * A balance guard asked about money in flight does not fail safe, it fails
   * wrong: it reads the loose wallet balance, sees less than the amount, and
   * refuses the migration it was added to protect. Verified by reading the two
   * call sites: `deploy` sizes against a balance that is present now, `migrate`
   * against one that is not. A single guard cannot answer for both, so the caller
   * says which question it is asking.
   */
  fundsInWalletNow: boolean = true,
  /**
   * The reads a Zest deposit needs, made by the caller before this synchronous builder runs
   * (`readZestDepositPlan`). Without one there is no Zest deposit: a caller that did not
   * read the account's position, pauses, cap and share preview gets a refusal.
   */
  zestPlan: ZestDepositPlan | null = null,
): DeployBuild {
  const instructions: ExecuteInstruction[] = [];
  let refusal: string | null = null;
  const wallet = scout.wallet;

  switch (protocol) {
    case "zest":
      // A real transaction the person signs (later item 1). It used to push a
      // `zest_supply` tool name, which nobody holding no key can execute.
      if (!zestPlan || zestPlan.asset.token !== token) {
        refusal = "A Zest deposit is built only after its account, pause, cap and share reads, and those were not made for this request.";
        break;
      }
      instructions.push(buildZestDeposit(wallet, amount, zestPlan));
      break;

    case "hermetica": {
      // Hermetica staking-v1 is deactivated (HQ ERR_INACTIVE_CONTRACT u1006).
      // staking-v1-1 is the active contract. It takes an additional `affiliate` arg (optional buff 64).
      //
      // This call used to be built in "allow" mode, on the reasoning that the sUSDh mint
      // could not be covered by a post-condition so Deny would reject the transaction.
      // The premise is right and the conclusion was wrong. A mint is not a transfer, so
      // Deny never asks for it to be declared. Checked against the chain rather than
      // reasoned about. Re-measured 2026-08-28 over the 50 most recent calls to
      // staking-v1-1: 37 were `stake`, all 37 used deny, none used allow, and 36 of 37
      // succeeded. The single failure aborted with `(err u1)`, a contract level
      // rejection, not `abort_by_post_condition`. Reference transaction
      // 0x710afa899f46d6b3a3c1235b4522693cc47e799d723895574b6e8e09686dd098 carries the
      // uncovered susdh-token-v1::susdh mint event in a successful deny transaction.
      //
      // Deny is also the only mode this call can use here: SmartX's adapter permits Allow
      // only with a written justification plus a contract-level floor, and `stake` takes
      // (amount, affiliate) with no argument that could ever carry a floor.
      //
      // What Deny buys is a bound on the outflow, and nothing more. The sUSDh arrives by
      // mint with no sender principal, so there is no receive side to pin and the exchange
      // rate cannot be bounded by a post-condition. Do not describe this as rate-bounded.
      if (token === "usdh") {
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "stake",
            // `affiliate` is (optional (buff 64)) and we pass none. It must be written as a
            // tagged {"type":"none"}, not a bare null: the chain wants Clarity `none` (hex
            // 0x09), and a bare null is not a tagged value, so the adapter refuses it rather
            // than guess that null was meant to be `none`.
            functionArgs: [{ type: "uint", value: amount }, { type: "none" }],
            postConditionMode: "deny",
            // The one bound this call can carry: the caller sends at most `amount` USDh.
            postConditions: [
              { type: "ft", principal: wallet, asset: USDH_TOKEN, assetName: "usdh", conditionCode: "lte", amount },
            ],
          },
          description: `Stake ${amount} USDh into Hermetica sUSDh (earning yield)`,
        });
      } else {
        // Need to swap to USDh first via Bitflow DLMM router
        const swapRoute = getDlmmSwapRoute(token, "usdh");
        if (!swapRoute) {
          instructions.push({ tool: "info", params: {}, description: `No DLMM swap route from ${token} to USDh. Acquire USDh manually.` });
          break;
        }
        const expectedUsdh = expectedSwapOutput(amount, token, "usdh", scout.prices);
        if (expectedUsdh <= 0) {
          instructions.push({ tool: "info", params: {}, description: `Cannot swap ${token} → USDh: price feed unavailable to size min-received guard. Re-run after prices recover.` });
          break;
        }
        instructions.push(buildDlmmSwapInstruction(swapRoute, wallet, amount, expectedUsdh));
        // Step 2 amount depends on Step 1 swap output: use expected output as estimate
        // Agent must read swap tx result and substitute actual received amount before executing
        const hermeticaEstimate = String(expectedUsdh);
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "stake",
            // See the deny-mode note on the direct stake above. Same call, same reasoning.
            functionArgs: [{ type: "uint", value: hermeticaEstimate }, { type: "none" }],
            postConditionMode: "deny",
            postConditions: [
              { type: "ft", principal: wallet, asset: USDH_TOKEN, assetName: "usdh", conditionCode: "lte", amount: hermeticaEstimate },
            ],
            requires_substitution: true,
            _note: "SEQUENTIAL: execute after Step 1 confirms. Replace amount with actual swap output from tx receipt.",
          },
          description: `Step 2: Stake ~${hermeticaEstimate} USDh into Hermetica sUSDh (adjust amount from Step 1 output)`,
        });
      }
      break;
    }

    case "granite":
      // Granite LP accepts aeUSDC only
      // Deposit mints LP tokens back to the caller. This comment used to say the
      // mode "must be allow" because the mint is not covered by the outgoing
      // aeUSDC condition. The code below has used DENY for some time, and deny is
      // correct: it ignores mints, verified across 37 of 37 recent mainnet Hermetica
      // stakes, so only the outgoing asset needs a condition. SKILL.md carried the
      // same stale claim on a public repo.
      if (token === "aeusdc") {
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
            contractName: "liquidity-provider-v1",
            functionName: "deposit",
            functionArgs: [
              { type: "uint", value: amount },
              { type: "principal", value: wallet },
            ],
            // Deny, for the same reason as the Hermetica stake above: the LP token mint is
            // not a transfer, so Deny does not require it to be declared. Verified on chain,
            // reference transaction
            // 0x65f31fc4e9b6cc1f6d474b7a3bb8e6a0022897bdf06498c7d24ecb47e2725d3b is a
            // successful deny deposit carrying an uncovered state-v1::lp-token mint event.
            postConditionMode: "deny",
            postConditions: [
              { type: "ft", principal: wallet, asset: AEUSDC_TOKEN, assetName: "aeUSDC", conditionCode: "lte", amount },
            ],
          },
          description: `Deposit ${amount} aeUSDC to Granite lending pool`,
        });
      } else {
        // Need swap to aeUSDC first via Bitflow DLMM router
        const swapRoute = getDlmmSwapRoute(token, "aeusdc");
        if (!swapRoute) {
          instructions.push({ tool: "info", params: {}, description: `No DLMM swap route from ${token} to aeUSDC. Acquire aeUSDC manually.` });
          break;
        }
        const expectedAeusdc = expectedSwapOutput(amount, token, "aeusdc", scout.prices);
        if (expectedAeusdc <= 0) {
          instructions.push({ tool: "info", params: {}, description: `Cannot swap ${token} → aeUSDC: price feed unavailable to size min-received guard. Re-run after prices recover.` });
          break;
        }
        instructions.push(buildDlmmSwapInstruction(swapRoute, wallet, amount, expectedAeusdc));
        // Step 2 amount depends on Step 1 swap output: use expected output as estimate
        // Agent must read swap tx result and substitute actual received amount before executing
        const graniteEstimate = String(expectedAeusdc);
        instructions.push({
          tool: "call_contract",
          params: {
            contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
            contractName: "liquidity-provider-v1",
            functionName: "deposit",
            functionArgs: [
              { type: "uint", value: graniteEstimate },
              { type: "principal", value: wallet },
            ],
            // See the deny-mode note on the direct deposit above. Same call, same reasoning.
            postConditionMode: "deny",
            postConditions: [
              { type: "ft", principal: wallet, asset: AEUSDC_TOKEN, assetName: "aeUSDC", conditionCode: "lte", amount: graniteEstimate },
            ],
            requires_substitution: true,
            _note: "SEQUENTIAL: execute after Step 1 confirms. Replace amount with actual swap output from tx receipt.",
          },
          description: `Step 2: Deposit ~${graniteEstimate} aeUSDC to Granite lending pool (adjust amount from Step 1 output)`,
        });
      }
      break;

    case "hodlmm": {
      // Parametric on --pool-id (mirrors the rebalance path pattern). Resolves the
      // pool definition from HODLMM_POOLS and generalises bin construction to use
      // the chosen pool's tokenX/tokenY instead of the prior sbtc/usdcx hardcode.
      // Refuses if the caller's --token does not match either of the pool's tokens
      // (safety floor: prevents silent no-op deposits when the token is unrelated
      // to the pool).
      const pool = HODLMM_POOLS.find(p => `dlmm_${p.id}` === poolId);
      if (!pool) {
        instructions.push({
          tool: "info",
          params: {},
          description: `Unknown HODLMM pool ${poolId}. Known pools: ${HODLMM_POOLS.map(p => `dlmm_${p.id}`).join(", ")}.`,
        });
        break;
      }
      // A backstop now, not the front line: `deploy` and `migrate` both reject a
      // token that is not in the pool in Step 0. It refuses rather than noting,
      // because everything after it assumes the named token is one of the two, and
      // without a refusal `namedIsX` reads false for an unknown token and the Y
      // branch would deposit it as if it were the counter asset.
      //
      // It returns a refusal and not an `info` because it USED to return an info:
      // the run reported ok while depositing nothing, and a second copy of this
      // same test sat below it under a comment claiming it was "already refused
      // above". Neither was true and both survived three review rounds.
      if (token !== pool.tokenX && token !== pool.tokenY) {
        refusal = `HODLMM pool ${poolId} (${pool.name}) holds ${pool.tokenX} and ${pool.tokenY} only, and you named ${token}. Acquire ${pool.tokenX} or ${pool.tokenY} first, or choose a different --pool-id.`;
        break;
      }

      // Read atomic balances of the pool's two tokens from scout. `scout.balances`
      // is typed with fixed keys, so we cast through Record<string, …> to index by
      // the pool's token-symbol strings.
      const balances = scout.balances as unknown as Record<string, TokenBalance>;
      const xMeta = TOKENS[pool.tokenX];
      const yMeta = TOKENS[pool.tokenY];
      const xBalAtomic = atomicOf(balances[pool.tokenX]);
      const yBalAtomic = atomicOf(balances[pool.tokenY]);
      const hasX = xBalAtomic > 0n;
      const hasY = yBalAtomic > 0n;

      // Same limit as the named-amount guard below: this reads what is in the
      // wallet NOW. On a migrate both balances are legitimately zero until the
      // withdraw leg above executes, so asking it there refuses a correct
      // migration. It runs only where it can be answered.
      if (fundsInWalletNow && !hasX && !hasY) {
        refusal = `HODLMM deploy to ${poolId} (${pool.name}) requires ${pool.tokenX.toUpperCase()} and/or ${pool.tokenY.toUpperCase()} in wallet, neither present.`;
        break;
      }

      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];

      // NOTHING here may size an asset the caller did not name.
      //
      // All three branches used to fall back to the wallet balance of whichever
      // token was not named, and the caller's own number was silently joined by a
      // second one they never gave. Executed against a wallet holding 0.5 sBTC and
      // 5000 USDCx: naming 100,000 sats of sBTC produced
      // `{xAmount: "100000", yAmount: "5000000000"}`, the entire USDCx balance.
      // Reversed, naming one dollar of USDCx pulled in the whole 0.5 sBTC, about
      // $39,000. The one-sided branches were worse still: naming 999 units of a
      // token the wallet did not hold DISCARDED the 999 entirely and deposited the
      // whole balance of the counter token across five bins.
      //
      // AGENT.md line 27 puts the limit the other way round, as "cannot deploy
      // more than wallet balance of the target token". The rule below is the
      // stricter reading and the one the money requires: the named token is the
      // only one that moves, and a second side has to be named explicitly.
      //
      // An earlier version of this comment quoted AGENT.md as saying "never infer
      // an amount from wallet balance". That sentence is not in AGENT.md. The rule
      // is right and the citation was invented, which on a file where the comments
      // are the record is its own defect.
      const counterAtomic = counterAmount;

      // The "token is not in this pool" case is gone from here. It was unreachable
      // (the branch above tests the same condition and breaks), and its comment
      // said "already refused above", which was not true: the branch above pushes
      // an `info` and the run returns ok. A comment asserting a refusal that does
      // not happen hides the defect from the next reader, and it hid this one
      // through three review rounds. Both callers now reject a token that is not
      // in the pool in Step 0, before any of this runs.
      const namedIsX = token === pool.tokenX;

      // The named token has to be one the wallet actually holds enough of, WHERE
      // that question can be answered.
      //
      // An earlier version of this guard ran unconditionally, reasoning that
      // "`deploy` checks this before it gets here, `migrate` does not, so putting
      // the guard where the amounts are built means it does not matter which
      // caller remembered". It does matter, and that version broke `migrate`
      // outright: migrate's amount is money still inside the source protocol,
      // arriving from the withdraw leg queued above, so the loose wallet balance
      // is smaller than the amount by design. Every HODLMM migration larger than
      // the loose balance built no deposit at all and returned `ok`.
      //
      // Migrate is left ungated here rather than gated wrongly. The right guard
      // for it is "does the SOURCE position hold this much", which needs the four
      // protocol position shapes reconciled and is recorded as a Phase 8 item, not
      // improvised in this phase.
      const namedHeld = namedIsX ? xBalAtomic : yBalAtomic;
      if (fundsInWalletNow && BigInt(amount) > namedHeld) {
        refusal = `Insufficient ${token.toUpperCase()} for ${pool.name}: you hold ${namedHeld} and named ${amount}.`;
        break;
      }

      if (counterAtomic !== null) {
        // Both sides named. Only valid at the active bin, per the dlmm-core
        // invariants quoted below: both amounts non-zero is allowed there and
        // nowhere else.
        const counterHeld = namedIsX ? yBalAtomic : xBalAtomic;
        // `fundsInWalletNow` cannot be false here today: `migrate` is the only
        // caller that passes false and it always passes `counterAmount: null`, so
        // this branch is unreachable with the flag off. Kept for when a two sided
        // migrate lands (Phase 8), and flagged so nobody reads it as live.
        if (fundsInWalletNow && BigInt(counterAtomic) > counterHeld) {
          refusal = `--counter-amount ${counterAtomic} exceeds your ${(namedIsX ? pool.tokenY : pool.tokenX).toUpperCase()} balance of ${counterHeld}.`;
          break;
        }
        bins.push({
          activeBinOffset: 0,
          xAmount: String(namedIsX ? amount : counterAtomic),
          yAmount: String(namedIsX ? counterAtomic : amount),
        });
      } else {
        // One sided, spread over five bins. `Math.floor(amount / 5)` deposits
        // `5 * floor(amount / 5)`, so anything under 5 atomic units builds five
        // bins of "0": a real transaction, real gas, nothing moved, described as
        // "Add liquidity (5 bins)". Above 5 it quietly deposits up to 4 atomic
        // units less than the caller named. Both are the same rule this block is
        // titled for, pointed the other way: the named amount must not be resized
        // without saying so.
        const perBin = Math.floor(amount / 5);
        if (perBin === 0) {
          refusal = `${amount} is too small to spread across five bins in ${pool.name}: each bin would receive nothing. The minimum for a one sided deposit here is 5 in ${token.toUpperCase()}'s smallest unit.`;
          break;
        }
        const remainder = amount - perBin * 5;
        if (namedIsX) {
        // X only, and only the named amount. Per the dlmm-core-v-1-1 invariant:
        //   (asserts! (or (>= bin-id active-bin-id) (is-eq x-amount u0)) ERR_INVALID_X_AMOUNT)
        // X is allowed only at bins at or above the active bin.
          for (let i = 1; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: String(perBin), yAmount: "0" });
        } else {
          // Y only, and only the named amount.
          //   (asserts! (or (<= bin-id active-bin-id) (is-eq y-amount u0)) ERR_INVALID_Y_AMOUNT)
          for (let i = -5; i <= -1; i++) bins.push({ activeBinOffset: i, xAmount: "0", yAmount: String(perBin) });
        }
        if (remainder > 0) {
          instructions.push({
            tool: "info", params: {},
            description: `Depositing ${perBin * 5} of the ${amount} ${token.toUpperCase()} you named. Five equal bins cannot divide ${amount} exactly, so ${remainder} stays in your wallet.`,
          });
        }
      }

      // A one sided add is OUTSIDE the earning range, and saying nothing about
      // that is the same class of false claim as the rest of this phase.
      //
      // KB section 7, established from the `dlmm-core-v-1-1` invariants quoted
      // above: X may only be non-zero at or above the active bin and Y only at or
      // below it, so a one sided add is placed outside the active bin BY
      // CONSTRUCTION. Fees accrue where trades execute, which is the active bin.
      // `hodlmm-bin-guardian` exists to flag that condition and calls it "drifted
      // out of its earning range".
      //
      // So the pool's headline APY, which this report prints beside the option,
      // describes a position the person will not be holding. The entry model the
      // user set on 2026-08-25 is two sided only, and making one sided entry
      // unreachable is a Phase 8 item. Until then it says so plainly rather than
      // letting a yield figure stand unqualified.
      if (bins.length > 1) {
        instructions.push({
          tool: "info", params: {},
          description: `This is a ONE SIDED deposit, so it sits outside the active bin (${pool.name}). Trading fees accrue at the active bin, so this position earns nothing until the price moves into its range. The pool's headline APY does not describe it. Deposit both sides with --counter-amount to enter at the active bin.`,
        });
      }
      // A REAL contract call, not a tool name. `bitflow:add-liquidity-simple`
      // was a complete instruction for an agent holding its own key: something
      // in the same process read it, signed and broadcast. It is not an
      // instruction for anybody who has to hand a person unsigned bytes, and a
      // caller that never held a key could do nothing with it at all.
      //
      // Function: `add-relative-liquidity-same-multi`, which has EIGHT mainnet
      // successes from this project's wallet against `add-relative-liquidity-multi`'s
      // one, and is what `hodlmm-inventory-balancer` and the Bitflow service both
      // use. Its argument shape differs from the other's and is taken from that
      // working caller: the per-bin list first, then the pool and both token
      // traits as SEPARATE arguments rather than fields inside the tuple.
      //
      // `active-bin-tolerance` is none. A some-tuple aborts with
      // ERR_ACTIVE_BIN_TOLERANCE (u5008) when the active bin drifts between
      // building and inclusion, and on a high volume pool it can drift
      // arbitrarily far, so widening the tolerance does not fix it. Nothing here
      // is mid-cycle, and a person signing minutes later is the same race.
      const xTotal = bins.reduce((n, b) => n + BigInt(b.xAmount), 0n);
      const yTotal = bins.reduce((n, b) => n + BigInt(b.yAmount), 0n);
      // xMeta and yMeta are already in scope from the balance checks above, and
      // are the same two entries, so they are reused rather than shadowed.

      // DENY, which is what the roadmap asks for on this item, and the reason an
      // earlier draft gave for allow was borrowed from the wrong path.
      //
      // That draft said the router "emits per-bin fee transfers that vary with
      // pool config". True of the SWAP, and the dlmm_7 abort behind it was a
      // swap. `dlmm-core`'s `add-liquidity` emits exactly one transfer of
      // `x-amount`, one of `y-amount`, and pool token mints, with the fee kept
      // inside the bin balance and no transfer of its own. Mainnet tx
      // 0xa38348db shows five transfers matching five tuple amounts and nothing
      // else. Deny ignores mints, so deny bounds this call exactly.
      //
      // Which matters beyond tidiness: allow mode obliges the caller to write a
      // justification, and "two different assets may leave" is precisely what a
      // reader cannot be asked to accept on trust.
      //
      // ONE PIN PER SIDE THAT ACTUALLY MOVES, capping what may leave the signer.
      // That is the whole guarantee: whatever else the router does, it cannot
      // take more of either token than the amounts named here. A side of zero
      // gets no pin, because a condition on an asset that does not move is a
      // condition the chain will fail the transaction over.
      //
      // The receive side needs no pin: `min-dlp` in the tuple is the chain's own
      // floor on the shares minted, so it is already enforced by the contract.
      const addConditions: Array<Record<string, unknown>> = [];
      for (const [total, meta] of [[xTotal, xMeta], [yTotal, yMeta]] as const) {
        if (total <= 0n || !meta) continue;
        if (meta.contract === "stx") {
          // STX moves under its own kind of condition, not a fungible token one.
          addConditions.push({ type: "stx", principal: wallet, conditionCode: "lte", amount: String(total) });
        } else {
          // The asset NAME is the argument to `define-fungible-token` in the
          // token contract, not the contract name and not the ticker. A pin
          // naming an asset that does not exist covers nothing and the chain
          // aborts: mainnet tx 0x77863289... is a Granite deposit that died
          // exactly that way on the old "bridged-usdc" spelling.
          addConditions.push({
            type: "ft",
            principal: wallet,
            asset: meta.contract,
            assetName: meta.ftSuffix.replace("::", ""),
            conditionCode: "lte",
            amount: String(total),
          });
        }
      }

      instructions.push({
        tool: "call_contract",
        params: {
          contractAddress: DLMM_SWAP_ROUTER,
          contractName: "dlmm-liquidity-router-v-1-1",
          functionName: "add-relative-liquidity-same-multi",
          functionArgs: [
            {
              type: "list",
              value: bins.map((b) => ({
                type: "tuple",
                value: {
                  "active-bin-id-offset": { type: "int", value: b.activeBinOffset },
                  // 5% ceiling per side, the same one hodlmm-move-liquidity uses.
                  "max-x-liquidity-fee": { type: "uint", value: String((BigInt(b.xAmount) * 5n) / 100n) },
                  "max-y-liquidity-fee": { type: "uint", value: String((BigInt(b.yAmount) * 5n) / 100n) },
                  // Any positive share count means the deposit routed correctly.
                  "min-dlp": { type: "uint", value: "1" },
                  "x-amount": { type: "uint", value: b.xAmount },
                  "y-amount": { type: "uint", value: b.yAmount },
                },
              })),
            },
            { type: "principal", value: pool.contract },
            { type: "principal", value: traitFor(pool.tokenX) },
            { type: "principal", value: traitFor(pool.tokenY) },
            { type: "none" },
          ],
          postConditionMode: "deny",
          postConditions: addConditions,
        },
        // HUMAN units. This said "at most 100000000 USDh" for one USDh, a false
        // statement about somebody's money by a factor of a hundred million, on
        // the line they read before signing.
        description: `Add liquidity to HODLMM ${pool.name} (${bins.length} bin${bins.length === 1 ? "" : "s"}), `
          + `at most ${humanAmount(xTotal, xMeta?.decimals ?? 6)} ${xMeta?.symbol ?? pool.tokenX} `
          + `and ${humanAmount(yTotal, yMeta?.decimals ?? 6)} ${yMeta?.symbol ?? pool.tokenY} leaving your wallet`,
      });
      break;
    }
  }
  return { instructions, refusal };
}

/**
 * The refusal for a deposit leg that built nothing a wallet can execute, or null.
 *
 * Five deploy paths (no swap route or no price to Hermetica or Granite, an unknown pool)
 * push only `info` notes, and `deploy` returned `ok` around them: a run that reads as a
 * deposit ready to sign when there is nothing to sign. The notes become the reasons.
 */
export function nothingToDeposit(protocol: string, build: DeployBuild): string[] | null {
  if (build.refusal) return [build.refusal];
  if (build.instructions.length === 0) return [`Nothing to deposit into ${protocol} was built.`];
  return build.instructions.every(s => s.tool === "info") ? build.instructions.map(s => s.description) : null;
}

/**
 * Why a withdraw leg built nothing a wallet can execute, or null when it built
 * something. A leg of only `info` steps, or no steps, moves no money.
 */
export function nothingToExecute(protocol: string, steps: ExecuteInstruction[]): string[] | null {
  if (steps.length === 0) return [`Nothing to withdraw from ${protocol}.`];
  return steps.every(s => s.tool === "info") ? steps.map(s => s.description) : null;
}

/**
 * The withdraw leg for `withdraw`, and the first half of `migrate`, or the
 * reasons it cannot be built. Both branches take their answer from here, so what
 * they refuse is tested as behaviour; only the line in `runPipeline` that returns
 * it is not, because that function needs a live scan.
 */
export function withdrawLegOrRefusal(
  protocol: Protocol, scout: ScoutResult,
): { instructions: ExecuteInstruction[]; refusal: null } | { instructions: null; refusal: string[] } {
  // "Withdraw from HODLMM" means every pool. With a pool unread, a list built from the pools that
  // were read would take out part and report it done (review round three), so it is refused.
  const unread = protocol === "hodlmm" ? (scout.positions.hodlmm.unread ?? []) : [];
  if (unread.length > 0) {
    return { instructions: null, refusal: [`HODLMM ${unread.map(p => p.name).join(", ")} could not be read this run, so no HODLMM withdraw is built: it could leave that pool out. Run the scan again.`] };
  }
  const instructions = buildWithdrawInstructions(protocol, scout);
  const refusal = nothingToExecute(protocol, instructions);
  return refusal ? { instructions: null, refusal } : { instructions, refusal: null };
}

export function buildWithdrawInstructions(protocol: Protocol, scout: ScoutResult): ExecuteInstruction[] {
  const wallet = scout.wallet;
  switch (protocol) {
    case "zest": {
      // This withdraw is sBTC, "max". It used to be built whatever the scan saw,
      // so a wallet holding only STX, or sBTC locked behind a loan, got a step
      // describing money it could not withdraw. Now it is built only when it can work.
      const z = scout.positions.zest;
      if (z.state === "unknown") return [{ tool: "info", params: {}, description: "Zest could not be read this run, so no Zest withdraw is built. Run the scan again." }];
      if (!z.holdings?.some(h => h.asset === "sBTC")) return [{ tool: "info", params: {}, description: "No sBTC supply on Zest to withdraw" }];
      if (z.debt?.length) {
        // "May", not "would": Zest lets all of one collateral go when the rest
        // still covers the loan. This engine cannot size that, so it builds none.
        const onlyCollateral = (z.holdings ?? []).length === 1;
        return [{ tool: "info", params: {}, description: `A Zest loan in ${z.debt.join(", ")} stands against this position, so withdrawing all the sBTC may fail. This engine does not size a partial withdraw, so it builds none.${onlyCollateral ? " The sBTC is the only collateral, so the loan has to be repaid before all of it can come out." : ""}` }];
      }
      return [{ tool: "zest_withdraw", params: { asset: "sBTC", amount: "max" }, description: "Withdraw all sBTC from Zest v2" }];
    }

    case "hermetica": {
      // unstake sUSDh -> creates claim in silo -> withdraw after cooldown
      // staking-v1-1 is the active contract (staking-v1 is deactivated)
      // Unstake burns sUSDh and creates a claim: postConditionMode must be "allow"
      // SUPERSEDED, see the note twelve lines below: a burn IS attributed to a sender,
      // so deny is achievable here and allow is a defect rather than a requirement.
      const susdhSats = atomicOf(scout.balances.susdh);
      if (susdhSats <= 0n) return [{ tool: "info", params: {}, description: "No sUSDh position to withdraw" }];
      return [
        {
          tool: "call_contract",
          params: {
            contractAddress: HERMETICA,
            contractName: "staking-v1-1",
            functionName: "unstake",
            functionArgs: [{ type: "uint", value: susdhSats.toString() }],
            // STILL ALLOW, AND STILL WRONG, but wrong in a way that refuses rather than
            // misfires. Unlike the mint on `stake`, a burn IS attributed to a sender, so the
            // sUSDh burn is expressible as a sender-side post-condition and Deny is
            // achievable here. All 25 `unstake` calls in the last 100 transactions used deny
            // and succeeded, for example
            // 0x90b27bbfef9700ccdcef16f8a5e7c8c5417d5073a4b8f2da03b3513be240e968.
            //
            // Deny needs TWO post-conditions, not the one below:
            //   1. the caller sends <= amount of susdh-token-v1::susdh (the burn)
            //   2. staking-reserve-v1 sends <= amount-usdh of usdh-token-v1::usdh, the
            //      reserve paying the silo. Deny covers third-party transfers too.
            // The second needs amount-usdh = amount * ratio / 1e8 from get-usdh-per-susdh at
            // build time, which is real work and is not being guessed at here.
            //
            // Until that lands this instruction is refused by the SmartX adapter, which
            // permits Allow only with a written justification plus a contract-level floor.
            // An honest refusal is the correct failure while the amount is unknown.
            postConditionMode: "allow",
            postConditions: [
              { type: "ft", principal: wallet, asset: SUSDH_TOKEN, assetName: "susdh", conditionCode: "lte", amount: String(susdhSats) },
            ],
          },
          description: `Unstake ${susdhSats} sUSDh (creates claim in staking-silo)`,
        },
        {
          tool: "info",
          params: { note: "After 7-day cooldown, call staking-silo-v1-1.withdraw(claim-id) to receive USDh" },
          description: "NOTE: 7-day unstake cooldown. Run withdraw again after cooldown to claim USDh.",
        },
      ];
    }

    case "granite": {
      // Use actual LP shares from on-chain position, not hardcoded 0
      const granitePos = scout.positions.granite;
      const shares = granitePos.lp_shares ?? "0";
      if (shares === "0") return [{ tool: "info", params: {}, description: "No Granite LP position to withdraw" }];
      // Granite follows ERC-4626: redeem(shares) burns share count, returns aeUSDC.
      const sharesNum = BigInt(shares);
      // Upper cap shares*2 retained from prior KB bug #35 fix: catches a buggy pool
      // over-paying/draining while admitting long-held positions whose interest exceeded
      // the earlier +10% buffer.
      const expectedAeusdcCap = String(sharesNum * 2n);
      return [{
        tool: "call_contract",
        params: {
          contractAddress: "SP26NGV9AFZBX7XBDBS2C7EC7FCPSAV9PKREQNMVS",
          contractName: "liquidity-provider-v1", functionName: "redeem",
          functionArgs: [{ type: "uint", value: shares }, { type: "principal", value: wallet }],
          postConditionMode: "deny",
          // Post-condition anchoring per reference tx 0xd0bb0059b72e5f5d75a4dd1bedb12e44e32790567bc282184ca5309641a8f44f
          // and live proof tx 0xd4aa0c4ed51b0951e91bb6680e44bc01da36722525fa7b28c39d98219e3eeba9 (2026-04-22).
          // Stacks FT PCs track OUTFLOWS from the named principal. aeUSDC on Granite flows
          // OUT OF state-v1 (not liquidity-provider-v1; the latter is a controller wrapper),
          // and the asset_name on the token contract is "aeUSDC" (not "bridged-usdc"); the
          // wallet BURNS lp-token (asset defined on state-v1), receives aeUSDC. The prior
          // shape (lte on lp-v1, gte:1 on wallet for aeUSDC) aborted on-chain in both deny
          // (tx 0x5780062068…) and allow (tx 0x60e2f84b83…) modes because all three PC fields
          // bound to principals/assets that don't match the real FT flow.
          postConditions: [
            // Receive-side floor: state-v1 sends aeUSDC ≥ shares (a healthy pool pays ≥
            // shares worth of aeUSDC; anything less signals a buggy pool or oracle drift).
            {
              type: "ft", principal: GRANITE_STATE,
              asset: AEUSDC_TOKEN, assetName: "aeUSDC",
              conditionCode: "gte", amount: shares,
            },
            // Receive-side cap: state-v1 sends aeUSDC ≤ shares*2, defensive against a
            // buggy pool overpaying/draining. KB bug #35 intent preserved, re-anchored.
            {
              type: "ft", principal: GRANITE_STATE,
              asset: AEUSDC_TOKEN, assetName: "aeUSDC",
              conditionCode: "lte", amount: expectedAeusdcCap,
            },
            // Burn BAND: wallet sends exactly `shares` of lp-token (the redeem burn),
            // expressed as a floor and a ceiling at the same amount.
            //
            // The floor alone used to be the whole of it, and its comment claimed it
            // stopped a buggy call path burning MORE shares than requested. It cannot:
            // `gte` aborts when FEWER move and permits any larger amount. The comment
            // described an upper bound while the code wrote a lower one, so the
            // protection it named did not exist. Under deny mode, which is an
            // allow-list, naming lp-token here is also what makes lp-token movable at
            // all, so the floor was licensing an unbounded caller-side outflow.
            //
            // Both amounts are `shares` because ERC-4626 `redeem(shares)` burns exactly
            // the share count it is given. Live proof tx
            // 0xd4aa0c4ed51b0951e91bb6680e44bc01da36722525fa7b28c39d98219e3eeba9 passed
            // `shares` of u4936276 and its burn event is 4936276 exactly, so the
            // ceiling added here would have been satisfied on that transaction without
            // changing its outcome.
            {
              type: "ft", principal: wallet,
              asset: GRANITE_STATE, assetName: "lp-token",
              conditionCode: "gte", amount: shares,
            },
            {
              type: "ft", principal: wallet,
              asset: GRANITE_STATE, assetName: "lp-token",
              conditionCode: "lte", amount: shares,
            },
          ],
        },
        description: `Redeem ${shares} LP shares for aeUSDC from Granite lending pool`,
      }];
    }

    case "hodlmm": {
      // A pool that could not be read is not in this list. `withdrawLegOrRefusal` refuses a
      // withdraw that would leave it out; the emergency exit builds what it can and
      // `emergencyIncompleteNotes` says what is missing.
      const pools = scout.positions.hodlmm.pools;
      return pools.map(p => ({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId: `dlmm_${p.pool_id}`, positions: "all" },
        description: `Withdraw all liquidity from HODLMM ${p.name}`,
      }));
    }
  }
}

/**
 * What an emergency exit list is missing, as sentences appended to its description.
 *
 * Hermetica's stake is inferred from the wallet's sUSDh, so an unread balance
 * drops that leg. Zest gets the same treatment for the same reason: a position
 * that could not be read, a Zest coin this engine cannot withdraw, or sBTC held
 * as collateral for a loan is a missing leg, and a short list that does not say
 * so reads as a complete exit.
 */
export function emergencyIncompleteNotes(scout: ScoutResult): string {
  const zest = scout.positions.zest;
  const zestOther = (zest.holdings ?? []).filter(h => h.asset !== "sBTC");
  const zestSbtc = (zest.holdings ?? []).some(h => h.asset === "sBTC");
  const zestLoan = (zest.debt ?? []).join(", ");
  const hodlmmUnread = (scout.positions.hodlmm.unread ?? []).map(p => p.name);
  return [
    !scout.available.balances
      ? " INCOMPLETE: wallet balances could not be read, so any Hermetica stake is invisible to this run and its unstake leg may be missing. Check Hermetica by hand before relying on this list."
      : "",
    zest.state === "unknown"
      ? " INCOMPLETE: Zest could not be read, so any Zest supply is invisible to this run and its withdraw leg may be missing. Check Zest by hand before relying on this list."
      : "",
    zestOther.length > 0
      ? ` INCOMPLETE: Zest also holds ${zestOther.map(h => `${h.amount} ${h.asset}`).join(", ")}, and this engine can withdraw only sBTC from Zest, so that is not in this list.`
      : "",
    zestLoan
      ? ` INCOMPLETE: this wallet owes Zest ${zestLoan}, and this exit repays no loan.${zestSbtc ? " Withdrawing all the sBTC may fail while that loan stands, so the sBTC withdraw is not in this list either." : ""}`
      : "",
    hodlmmUnread.length > 0
      ? ` INCOMPLETE: HODLMM ${hodlmmUnread.join(", ")} could not be read, so a withdraw from ${hodlmmUnread.length === 1 ? "that pool" : "those pools"} may be missing. Check HODLMM by hand before relying on this list.`
      : "",
  ].join("");
}

export function buildEmergencyInstructions(scout: ScoutResult): ExecuteInstruction[] {
  const instructions: ExecuteInstruction[] = [];
  if (scout.positions.hodlmm.has_position) {
    instructions.push(...buildWithdrawInstructions("hodlmm", scout));
  }
  // The Zest leg withdraws all sBTC, so it is built only when sBTC is held and no
  // Zest loan stands against it. Anything else is named as missing by
  // `emergencyIncompleteNotes`, never covered by a step that would fail or would
  // describe money which is not there.
  if (scout.positions.zest.holdings?.some(h => h.asset === "sBTC") && !scout.positions.zest.debt?.length) {
    instructions.push(...buildWithdrawInstructions("zest", scout));
  }
  if (scout.positions.hermetica.has_position || scout.balances.susdh.amount > 0) {
    instructions.push(...buildWithdrawInstructions("hermetica", scout));
  }
  if (scout.positions.granite.has_position) {
    instructions.push(...buildWithdrawInstructions("granite", scout));
  }
  return instructions;
}

// =============================================================================
// ==  SAFETY PIPELINE
// =============================================================================

function withDisclaimer(result: Omit<EngineResult, "disclaimer">): EngineResult {
  return { ...result, disclaimer: DISCLAIMER };
}

async function runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<EngineResult> {
  return withDisclaimer(await _runPipeline(wallet, command, opts));
}

async function _runPipeline(wallet: string, command: string, opts: Record<string, string>): Promise<Omit<EngineResult, "disclaimer">> {
  // ONE spelling of the token, settled before anything reads it.
  //
  // Three places compared this string against lowercase names and disagreed about
  // whose job the lowercasing was. `migrate`'s Step 0 lowercased it to validate,
  // then handed the ORIGINAL to the builder, which compares against lowercase pool
  // token names. So `--token SBTC` passed validation, failed the pool comparison,
  // and landed in the branch that pushes a note and returns ok: the Zest withdraw
  // was built, no deposit was, and the run reported no refusal. Reproduced at the
  // command line before this line existed. `SBTC` and `USDh` are how this file's
  // own TOKENS table and SKILL.md spell them, so it was the ordinary spelling that
  // broke, not an exotic one.
  //
  // `inferTargetPoolId` had the same bug quietly: `token !== "usdh"` is true for
  // "USDh", so a hermetica deploy already holding USDh was gated on a swap pool it
  // never touches.
  if (typeof opts.token === "string") opts.token = opts.token.toLowerCase();
  // Step 0: Input validation, pure string/number checks only.
  // NOT a safety bypass: the full pipeline (Scout, PoR, Guardian, Executor; YTG is a
  // reported figure and no longer a stage)
  // still runs for every valid write request. This just catches obviously invalid input
  // (bad protocol name, zero amount, wrong token) before wasting 12+ API calls.
  if (command === "deploy") {
    const protocol = opts.protocol;
    if (!protocol || !["zest", "hermetica", "granite", "hodlmm"].includes(protocol)) {
      return { status: "error", command, error: "Invalid protocol. Use: zest, hermetica, granite, hodlmm" };
    }
    const amount = parseAtomicAmount(opts.amount);
    if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only (no decimal point, no exponent, no 0x)" };
    const token = opts.token ?? inferToken(protocol as Protocol);
    const validTokens: Record<string, string[]> = { zest: ["sbtc", "stx", "usdcx"], hermetica: ["usdh", "sbtc", "usdcx", "stx"], granite: ["aeusdc", "usdcx"], hodlmm: ["sbtc", "stx", "usdcx", "usdh", "aeusdc"] };
    if (!validTokens[protocol].includes(token)) {
      return { status: "error", command, error: `${protocol} does not accept ${token}. Valid: ${validTokens[protocol].join(", ")}` };
    }
    // The token has to be in the POOL, not merely on the protocol's list.
    //
    // `validTokens.hodlmm` accepts all five tokens because HODLMM as a whole does.
    // A single pool holds two. Without this, `deploy --protocol hodlmm --token stx
    // --pool-id dlmm_1` passed Step 0, reached the builder, hit its "token is not
    // in this pool" branch, and returned `preview` with one `info` instruction and
    // no deposit. With `--confirm` it returned `ok` and exit 0.
    //
    // Round three added exactly this check to `migrate` and did not mirror it
    // here, which is the same "widen one side, leave the other" mistake this
    // project has now made in three separate rounds. The two commands ask one
    // question and they answer it the same way.
    if (protocol === "hodlmm") {
      const dPool = HODLMM_POOLS.find(p => `dlmm_${p.id}` === ((opts as Record<string, string>).poolId ?? "dlmm_1"));
      if (!dPool) {
        return { status: "error", command, error: `Unknown --pool-id "${(opts as Record<string, string>).poolId}". Run 'scan' to see the pools this engine knows.` };
      }
      if (token !== dPool.tokenX && token !== dPool.tokenY) {
        // Say whether the caller named this token or inherited it. `token` is
        // `opts.token ?? inferToken(protocol)`, and `inferToken("hodlmm")` is
        // "sbtc", which is not in five of the eight pools. Blaming somebody for a
        // token they never typed is the plain-speaking rule broken by a message
        // that is otherwise correct.
        return {
          status: "error", command,
          error: opts.token
            ? `${token} is not in ${dPool.name}. That pool holds ${dPool.tokenX} and ${dPool.tokenY}.`
            : `${dPool.name} holds ${dPool.tokenX} and ${dPool.tokenY}. Name one with --token: the default of ${token} does not apply to this pool.`,
        };
      }
    }
    // Parsed HERE, in Step 0, and not at the build site. Parsing it later threw a
    // bare exception after a dozen network calls had already run, and the only
    // catcher is the top level `.catch`, which prints an error carrying no
    // `command` and no disclaimer, unlike every other validation failure in this
    // file. Same function, so the rule has one home and both places agree.
    try {
      parseCounterAmount(opts);
    } catch (e) {
      return { status: "error", command, error: (e as Error).message };
    }
  }
  if (command === "withdraw") {
    const protocol = opts.protocol;
    if (!protocol || !["zest", "hermetica", "granite", "hodlmm"].includes(protocol)) {
      return { status: "error", command, error: "Invalid protocol. Use: zest, hermetica, granite, hodlmm" };
    }
  }
  if (command === "borrow" || command === "repay") {
    // Zest v0 market is the only protocol exposing borrow/repay the skill wraps.
    // Other protocols (Hermetica stake-yield, Granite LP supply, HODLMM LP) have
    // no matching MCP surface for debt operations: intentionally excluded.
    const protocol = opts.protocol;
    if (!protocol || protocol !== "zest") {
      return { status: "error", command, error: "Invalid protocol. Only zest supports borrow/repay." };
    }
    const amount = parseAtomicAmount(opts.amount);
    if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only (no decimal point, no exponent, no 0x)" };
    const token = (opts.token ?? "usdh").toLowerCase();
    // USDh is the only asset for which zest_borrow via MCP succeeds on v0-4-market.borrow.
    // Empirical probes (2026-04-22) on the same wallet + collateral returned
    // abort_by_response (err none) for USDCx, wSTX, stSTX: likely an upstream MCP
    // routing gap around borrow-helper-v2-1-7 (Pyth oracle fee wrapper). Refusing
    // non-USDh saves gas rather than broadcasting a known-failing tx.
    const validTokens_borrowRepay: Record<string, string[]> = { zest: ["usdh"] };
    if (!validTokens_borrowRepay[protocol].includes(token)) {
      return { status: "error", command, error: `${protocol} ${command} does not accept ${token}. Valid: ${validTokens_borrowRepay[protocol].join(", ")}` };
    }
  }
  if (command === "migrate") {
    if (!opts.from || !opts.to || opts.from === opts.to) {
      return { status: "error", command, error: "Specify --from and --to (different protocols)" };
    }
    // Both ends checked against the list before anything derives from them.
    // `inferToken` has no default branch and returns undefined for a protocol
    // outside the four, so the token check below used to call `.toLowerCase()` on
    // undefined and throw a raw runtime message with no command and no
    // disclaimer, which is the failure Step 0 exists to prevent.
    const migrateProtocols = ["zest", "hermetica", "granite", "hodlmm"];
    for (const [flag, value] of [["--from", opts.from], ["--to", opts.to]] as Array<[string, string]>) {
      if (!migrateProtocols.includes(value)) {
        return { status: "error", command, error: `Invalid ${flag} protocol "${value}". Use: ${migrateProtocols.join(", ")}` };
      }
    }
    // --amount is required. Earlier versions defaulted to the wallet sBTC balance, which
    // silently produced zero-amount deploys when migrating from stablecoin protocols
    // (hermetica/granite) on wallets without sBTC. Force the caller to be explicit.
    const parsedAmt = parseAtomicAmount(opts.amount);
    if (parsedAmt === null) {
      return { status: "error", command, error: "migrate requires --amount, a positive whole number of the target token's smallest unit, digits only. Run 'scan' to inspect current positions." };
    }
    // The target protocol has to accept the token, the same check `deploy` makes.
    // Without it `migrate --to hodlmm --token usdh --pool-id dlmm_1` withdrew the
    // source position and then hit the builder's "token is not in this pool"
    // branch, which pushes a note and returns `ok`: the money left the source
    // protocol, landed in the wallet, and the run reported success.
    const migrateTo = opts.to as string;
    const migrateToken = (opts.token ?? inferToken(migrateTo as Protocol)).toLowerCase();
    const migrateValid: Record<string, string[]> = { zest: ["sbtc"], hermetica: ["usdh", "sbtc", "usdcx", "stx"], granite: ["aeusdc", "usdcx"], hodlmm: ["sbtc", "stx", "usdcx", "usdh", "aeusdc"] };
    if (!migrateValid[migrateTo]?.includes(migrateToken)) {
      return { status: "error", command, error: `${migrateTo} does not accept ${migrateToken}. Valid: ${(migrateValid[migrateTo] ?? []).join(", ")}` };
    }
    if (migrateTo === "hodlmm") {
      const mPoolId = ((opts as Record<string, string>).poolId ?? "dlmm_1");
      const mPool = HODLMM_POOLS.find(p => `dlmm_${p.id}` === mPoolId);
      // `if (mPool && ...)` skipped the whole check when the pool was unknown, so
      // migrate never produced the error deploy produces and a typo was caught
      // much later, by the guardian, reported as a slippage MEASUREMENT failure.
      // dlmm_9 through dlmm_13 are real Bitflow pools this engine does not carry,
      // so the typo is ordinary. Added to `deploy` a round before this and not
      // here, in the round whose own comment complained about exactly that.
      if (!mPool) {
        return { status: "error", command, error: `Unknown --pool-id "${mPoolId}". Run 'scan' to see the pools this engine knows.` };
      }
      if (migrateToken !== mPool.tokenX && migrateToken !== mPool.tokenY) {
        return { status: "error", command, error: `${migrateToken} is not in ${mPool.name}. That pool holds ${mPool.tokenX} and ${mPool.tokenY}.` };
      }
    }
  }

  // Step 1: Scout
  let scout: ScoutResult;
  try {
    scout = await scoutWallet(wallet);
  } catch (err: unknown) {
    return { status: "error", command, error: `Scout failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 1b: refuse to BUILD a transaction out of a balance nobody read.
  //
  // The zero that the scout invents on a failed read does not stop at the report.
  // It reaches the builders: a Hermetica withdrawal takes its unstake amount from
  // `scout.balances.susdh.amount`, and the HODLMM deploy sizes both legs off the
  // same object. A rate-limited read therefore produces an unstake of nothing
  // described as "No sUSDh position to withdraw", which is a false statement
  // about somebody's stake, and the deploy path refuses with "Insufficient
  // balance: have 0", which names the wrong reason for the right refusal.
  //
  // Nothing here was ever at risk of moving the wrong amount of money, because
  // every one of those paths fails downward, to zero or to a refusal. What was at
  // risk was the person believing the reason. Refusing by name costs no working
  // path: today every one of these commands already fails on an unread balance,
  // just without saying why.
  //
  // `emergency` is deliberately exempt. It is the escape hatch and it already
  // bypasses the guardian and the reserve gates on purpose, so it must not
  // acquire a new way to say no. It gets a warning attached instead, below.
  if (command !== "emergency" && !scout.available.balances) {
    return {
      status: "refused", command, scout,
      refusal_reasons: [
        `Wallet balances could not be read this run (${scout.available.unavailable.join(", ")}), so your holdings are unknown rather than zero. Refusing to build a transaction sized against a balance nobody read.`,
      ],
      action: { description: "Write refused. Run the command again; if it keeps failing, the upstream data source is down." },
    };
  }

  // Step 2: Reserve check
  const reserve = await checkReserve();

  // --confirm gate for emergency too
  const confirmed = opts.confirm === "true" || opts.confirm === "";

  // Emergency bypasses guardian
  if (command === "emergency") {
    const instructions = buildEmergencyInstructions(scout);
    // An emergency exit built on an unread balance is INCOMPLETE, not wrong. The
    // Hermetica leg is the one that suffers: whether a stake exists is inferred
    // from the wallet's sUSDh, so on a failed read that leg is silently dropped
    // and the operation count comes back short. Saying so is the whole fix here.
    // The alternative, refusing, would take the escape hatch away on exactly the
    // day somebody needs it, and three of the four legs still build correctly
    // from position reads that did return.
    const incomplete = emergencyIncompleteNotes(scout);
    if (!confirmed) {
      return {
        status: "preview", command, scout, reserve,
        action: {
          description: `[DRY RUN] EMERGENCY EXIT: ${instructions.length} operations, add --confirm to execute.${incomplete}`,
          details: { instructions },
        },
      };
    }
    return {
      status: incomplete ? "degraded" : "ok", command, scout, reserve,
      action: {
        description: `EMERGENCY EXIT: ${instructions.length} operations to withdraw all positions.${incomplete}`,
        details: { instructions },
      },
    };
  }

  // PoR RED or DATA_UNAVAILABLE -> refuse writes
  if (reserve.signal === "RED" || reserve.signal === "DATA_UNAVAILABLE") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: [`PoR signal: ${reserve.signal}, ${reserve.recommendation}`],
      action: { description: "Write refused. Run 'emergency' to withdraw all positions." },
    };
  }

  // PoR YELLOW -> refuse writes
  if (reserve.signal === "YELLOW") {
    return {
      status: "refused", command, scout, reserve,
      refusal_reasons: ["PoR signal: YELLOW, reserve below 99.9%. Read-only operations only."],
    };
  }

  // Step 3: Guardian check, gate against the pool this operation will actually touch
  // (not always dlmm_1) so slippage + volume reads measure the right liquidity venue.
  const targetPoolId = inferTargetPoolId(command, opts);
  const gateScope = poolGateScope(command, opts);
  const guardian = await checkGuardian(scout, {
    targetPoolId,
    notApplicableScope: gateScope && `${gateScope}`,
    notApplicableVolumeScope: gateScope && `${gateScope}`,
  });
  if (!guardian.can_proceed) {
    // A migration out of HODLMM can be refused on the pool it is moving INTO,
    // which names a pool the person never mentioned. Saying so helps.
    //
    // It only helps when it is TRUE, and the first version of this was not. It
    // fired on ANY guardian refusal, and `guardian.refusals` also carries price,
    // gas and cooldown failures, none of which is about the destination. It also
    // told the person that `withdraw` would get them out, which runs through this
    // same guardian and is refused by the same gas or price failure. Telling
    // somebody trying to exit a position that there is a way out, when there is
    // not, is worse than saying nothing.
    //
    // So it appears only when a POOL gate is the thing that failed, and it no
    // longer promises that another command will work.
    const leavingHodlmmHere = explainsDestinationPool({
      command, from: opts.from, targetPoolId,
      slippageStatus: guardian.slippage.status, volumeStatus: guardian.volume.status,
    });
    return {
      status: "refused", command, scout, reserve, guardian,
      refusal_reasons: leavingHodlmmHere
        ? [...guardian.refusals,
           `That gate is about ${targetPoolId}, the pool this move would go THROUGH, not the position you are leaving.`]
        : guardian.refusals,
    };
  }

  // Step 4: Execute
  let instructions: ExecuteInstruction[] = [];
  /**
 * What this action is projected to earn, and what entering it costs.
 *
 * Carried on the result so the console can show a person the arithmetic and let
 * them decide. Replaces a refusal that made the decision for them, and made it
 * on the one input that is none of the product's business: how much they have.
 */
let economics: {
  apy_pct: number; amount_usd: number; yield_7d_usd: number; yield_30d_usd: number;
  gas_estimate_stx: number; ytg_ratio_for_wallet: number; note: string;
} | null = null;
  let description = "";

  switch (command) {
    case "deploy": {
      // Input already validated in Step 0 above
      const protocol = opts.protocol as Protocol;
      const token = opts.token ?? inferToken(protocol);
      const amount = parseAtomicAmount(opts.amount);
      if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only" };

      // Check 0% APY
      // Matched on the POOL as well as the protocol where one was named. HODLMM
      // offers several pools with wildly different APYs, and matching on protocol
      // alone described the highest-APY pool while the instructions built for the
      // one actually requested: a review measured 377.87% reported against a pool
      // scored 140.4%. Falls back to the protocol match when no pool is named, so
      // the 0% APY check below behaves as it always did.
      const poolWanted = (opts as Record<string, string>).poolId;
      const targetOpt = selectTargetOption(scout.options, protocol, poolWanted, token);
      const noRate = rateRefusal(protocol, targetOpt, Boolean(opts.force));
      if (noRate) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: [noRate] };
      }

      // Yield against gas: this INFORMS, it does not block. See the note on
      // `economics` below for why that changed.
      //
      // It used to return `refused` here whenever 7d yield came in under 3x the
      // gas estimate. Read as a safety gate that is reasonable. It is not one.
      // The test is capital x APY x 7/365 > 3 x gas, and of those terms only
      // capital varies with the person: gas is a per-protocol constant and APY
      // belongs to the market. Solve it for capital and the gate is a plain
      // dollar threshold on the human, roughly $17 on the cheapest route. A $4
      // deposit is not less safe than a $4,000 one. The post-conditions bound
      // both identically. What the refusal actually protected somebody from was
      // a POOR RETURN, and that is a judgement only they can make about their
      // own money.
      //
      // So the arithmetic still runs and now travels with the result instead of
      // ending it.
      if (targetOpt) {
        // Projected from the amount BEING DEPLOYED, not from the whole wallet.
        // `targetOpt.daily_usd` is a ranking figure computed over everything the
        // person holds, and attaching it to one transaction was measured at
        // roughly 400x too high: a 0.001 STX deploy was shown a seven day yield
        // of $0.2849, the whole wallet's number. A projection on a signing
        // preview has to describe the thing being signed, or it is worse than no
        // projection at all.
        // `scout.prices`, not a bare `prices`, and the arithmetic written out
        // rather than borrowed. Both names existed only inside the scout and the
        // option builder, so this block referenced two identifiers that are not
        // in scope here: the deploy path threw "prices is not defined" the moment
        // it cleared the gates, which is the SIGNING path. It shipped, masked by
        // a reserve feed that happened to be refusing every write that day.
        //
        // It typechecked in my hands because I filtered the compiler output and
        // never looked for these two names. The lesson is the same one this
        // codebase keeps relearning: a filtered check is not a check.
        const meta = TOKENS[token];
        const priceUsd = (scout.prices as unknown as Record<string, number>)[token] ?? 0;
        const amountUsd = meta ? (amount / Math.pow(10, meta.decimals)) * priceUsd : 0;
        const dailyForThis = amountUsd > 0
          ? round((amountUsd * targetOpt.apy_pct / 100) / 365, 4)
          : 0;
        economics = {
          apy_pct: targetOpt.apy_pct,
          amount_usd: round(amountUsd, 4),
          yield_7d_usd: round(dailyForThis * 7, 4),
          yield_30d_usd: round(dailyForThis * 30, 4),
          gas_estimate_stx: targetOpt.gas_to_enter_stx,
          // The option's own ratio is a RANKING figure over the whole wallet, so
          // it is reported as that and not as a claim about this transaction.
          ytg_ratio_for_wallet: targetOpt.ytg_ratio,
          // The honest headline, and it is deliberately the unflattering one.
          // `gas_estimate_stx` is a DIVISOR this skill uses to rank options, not
          // the fee anybody pays: SmartX puts a real fee on the transaction, and
          // it is larger than any estimate in this file.
          //
          // The note says what the number is NOT and does not quote the real fee.
          // An earlier version named "its own floor of 0.25 STX" and reasoned
          // about multiples of it, which is precisely the duplication the header
          // at the top of this file says it removed: the fee lives in
          // `smartx-app/src/plan/fee.ts`, and a copy here is a second answer free
          // to drift from the first. This file measures a rate; it does not set a
          // fee.
          //
          // Whoever renders this must not let a small holder believe the entry is
          // cheaper than it is, which is the same disservice as refusing them,
          // wearing better manners.
          note: `Depositing about $${round(amountUsd, 4)} at ${targetOpt.apy_pct}% earns about $${round(dailyForThis * 7, 4)} in seven days. The ${targetOpt.gas_to_enter_stx} STX beside each option is a RANKING estimate, not the fee you pay: SmartX sets the transaction fee when it builds the transaction, and it is higher than this. Worth doing only if you plan to stay in. Your money, your call.`,
        };
      }

      // Balance check: refuse if requested amount exceeds wallet balance
      const tokenKey = token as keyof WalletBalances;
      if (scout.balances[tokenKey]) {
        const walletUnits = atomicOf(scout.balances[tokenKey]);
        if (BigInt(amount) > walletUnits) {
          // `refused`, not `error`. This is the SAME FACT the builder refuses on
          // for a HODLMM deposit, and the two used to report it as two different
          // statuses: `error` here, `refused` there. A caller reading the status
          // could not tell it was one situation.
          //
          // This check stays, and is not replaced by the builder's, because it
          // covers every protocol while the builder's covers the HODLMM branch
          // only. Deleting it would leave zest, hermetica and granite deploys with
          // no balance check at all. The builder's is a backstop that this one
          // reaches first on the deploy path, and that is deliberate: they answer
          // the same question the same way and neither is load bearing alone.
          return {
            status: "refused", command, scout, reserve, guardian,
            refusal_reasons: [`Insufficient ${token} balance: you hold ${walletUnits} and named ${amount}.`],
          };
        }
      }

      // The money is in the wallet already: this command's whole premise is that
      // the caller holds it, and Step 3 above checked the balance for the named
      // token. The builder's own guards can be answered here.
      // A Zest deposit's reads, made here because the builder is synchronous. A refusal
      // here is the plain reason, before anything is built.
      let zestPlan: ZestDepositPlan | null = null;
      if (protocol === "zest") {
        const zest = await readZestDepositPlan(wallet, token, amount);
        if (zest.refusal !== null) {
          return { status: "refused", command, scout, reserve, guardian, refusal_reasons: [zest.refusal] };
        }
        zestPlan = zest.plan;
      }
      const built = buildDeployInstructions(
        protocol, amount, token, scout,
        ((opts as Record<string, string>).poolId ?? "dlmm_1"),
        parseCounterAmount(opts),
        true,
        zestPlan,
      );
      const notBuilt = nothingToDeposit(protocol, built);
      if (notBuilt) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: notBuilt };
      }
      instructions = built.instructions;
      // In the coin's own units: this line is the headline a person reads above the step, and
      // "Deploy 5000000 usdcx" (atomic units) is what the owner saw on 2026-09-16.
      const deployMeta = TOKENS[token];
      const deployed = deployMeta ? `${humanAmount(BigInt(amount), deployMeta.decimals)} ${deployMeta.symbol}` : `${amount} ${token}`;
      description = `Deploy ${deployed} to ${protocol === "hodlmm" ? "HODLMM" : protocol.charAt(0).toUpperCase() + protocol.slice(1)}${protocol === "hodlmm" ? ` (${((opts as Record<string, string>).poolId ?? "dlmm_1")})` : ""}`;
      break;
    }

    case "withdraw": {
      // Input already validated in Step 0 above
      const protocol = opts.protocol as Protocol;
      // A leg of only `info` steps built nothing a wallet can execute, and
      // "ok, 1 instruction" around it reads as a withdraw that is ready.
      const leg = withdrawLegOrRefusal(protocol, scout);
      if (leg.instructions === null) return { status: "refused", command, scout, reserve, guardian, refusal_reasons: leg.refusal };
      instructions = leg.instructions;
      description = `Withdraw from ${protocol}`;
      break;
    }

    case "rebalance": {
      const poolId = ((opts as Record<string, string>).poolId ?? "dlmm_1");
      const poolNum = parseInt(poolId.replace("dlmm_", ""), 10);
      const pool = scout.positions.hodlmm.pools.find(p => p.pool_id === poolNum);
      if (!pool) {
        const unreadPool = (scout.positions.hodlmm.unread ?? []).some(p => p.pool_id === poolNum);
        return { status: "error", command, error: unreadPool ? `Pool ${poolId} could not be read this run, so its position is unknown. Run the scan again.` : `No position found in pool ${poolId}` };
      }
      if (pool.in_range) return { status: "ok", command, scout, reserve, guardian, action: { description: `Pool ${poolId} is IN RANGE at bin ${pool.active_bin}. No rebalance needed.` } };

      instructions.push({
        tool: "bitflow:withdraw-liquidity-simple",
        params: { poolId, positions: "all" },
        description: `Step 1: Withdraw all liquidity from ${pool.name}`,
      });
      const bins: Array<{ activeBinOffset: number; xAmount: string; yAmount: string }> = [];
      for (let i = -5; i <= 5; i++) bins.push({ activeBinOffset: i, xAmount: "auto", yAmount: "auto" });
      instructions.push({
        tool: "bitflow:add-liquidity-simple",
        params: { poolId, bins: JSON.stringify(bins) },
        description: `Step 2: Re-add liquidity centered on active bin ${pool.active_bin}`,
      });

      description = `Rebalance ${pool.name}: withdraw + re-add around bin ${pool.active_bin}`;
      break;
    }

    case "migrate": {
      // Input (including --amount > 0) already validated in Step 0 above
      const from = opts.from as Protocol;
      const to = opts.to as Protocol;
      // With no executable withdraw nothing arrives, and the deposit below is
      // sized to an amount the wallet may not hold: refuse rather than build half.
      const withdrawLeg = withdrawLegOrRefusal(from, scout);
      if (withdrawLeg.instructions === null) return { status: "refused", command, scout, reserve, guardian, refusal_reasons: withdrawLeg.refusal };
      instructions.push(...withdrawLeg.instructions);
      const token = opts.token ?? inferToken(to);
      const amount = parseAtomicAmount(opts.amount);
      if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only" };
      // `false`: the amount is inside `from` and arrives only when the withdraw
      // instructions queued on the line above execute. The wallet balance right
      // now is the wrong question, and answering it refused correct migrations.
      //
      // `null` for the second side, not `parseCounterAmount(opts)`. That call was
      // dead: `--counter-amount` is registered on `deploy` and not on `migrate`,
      // so commander rejects the flag before the pipeline runs and the call could
      // only ever return null. A two sided migrate needs the withdraw leg's actual
      // output to size against, which is Phase 8 work, so this says one sided
      // plainly instead of pretending to offer a choice.
      const migrateBuild = buildDeployInstructions(
        to, amount, token, scout,
        ((opts as Record<string, string>).poolId ?? "dlmm_1"),
        null,
        false,
      );
      // The same rule as `deploy`: a deposit leg of only notes is refused, never a
      // withdraw with nothing to put the money into.
      const migrateNotBuilt = nothingToDeposit(to, migrateBuild);
      if (migrateNotBuilt) {
        return { status: "refused", command, scout, reserve, guardian, refusal_reasons: migrateNotBuilt };
      }
      instructions.push(...migrateBuild.instructions);
      description = `Migrate from ${from} to ${to}`;
      break;
    }

    case "borrow": {
      // Input already validated in Step 0 (zest-only, USDh-only, positive amount).
      // Borrow is the debt-issuance leg of the leveraged-yield pattern. No YTG gate
      // applies: the earn leg (Hermetica stake of the borrowed USDh) is where YTG
      // is evaluated on its own `deploy` call.
      const token = (opts.token ?? "usdh").toUpperCase();
      const amount = parseAtomicAmount(opts.amount);
      if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only" };
      instructions.push({
        tool: "zest_borrow",
        params: { asset: token, amount: String(amount) },
        description: `Borrow ${amount} ${token} from Zest v2 against existing collateral`,
      });
      description = `Borrow ${amount} ${token} from Zest`;
      break;
    }

    case "repay": {
      // Input already validated in Step 0.
      const token = (opts.token ?? "usdh").toUpperCase();
      const amount = parseAtomicAmount(opts.amount);
      if (amount === null) return { status: "error", command, error: "Amount must be a positive whole number in the token's smallest unit, digits only" };
      instructions.push({
        tool: "zest_repay",
        params: { asset: token, amount: String(amount) },
        description: `Repay ${amount} ${token} debt to Zest v2`,
      });
      description = `Repay ${amount} ${token} to Zest`;
      break;
    }
  }

  if (!confirmed) {
    return {
      status: "preview", command, scout, reserve, guardian,
      action: {
        description: `[DRY RUN] ${description}, add --confirm to execute`,
        details: { instructions, instruction_count: instructions.length, economics },
      },
    };
  }

  // Stamp rebalance cooldown only on actual execution, never on preview
  if (command === "rebalance") {
    writeState({ ...readState(), last_rebalance_at: new Date().toISOString() });
  }

  return {
    status: "ok", command, scout, reserve, guardian,
    action: { description, details: { instructions, instruction_count: instructions.length, economics } },
  };
}

function inferToken(protocol: Protocol): string {
  switch (protocol) {
    case "zest": return "sbtc";
    case "hermetica": return "usdh";
    case "granite": return "aeusdc";
    case "hodlmm": return "sbtc";
  }
}

// =============================================================================
// ==  DOCTOR COMMAND
// =============================================================================

async function runDoctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Bech32m test vectors
  const tv = verifyBech32mTestVectors();
  checks.push({ name: "BIP-350 Bech32m Test Vectors", ok: tv.pass, detail: tv.detail });

  // 2. P2TR derivation self-test
  try {
    const addr = xOnlyPubkeyToP2TR(P2TR_SELF_TEST.xOnlyHex);
    const expected = P2TR_SELF_TEST.expected;
    checks.push({ name: "P2TR Derivation Self-Test", ok: addr === expected, detail: addr === expected ? "G point -> tweaked P2TR pass" : `Expected ${expected}, got ${addr}` });
  } catch (e: unknown) {
    checks.push({ name: "P2TR Derivation Self-Test", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Hiro Stacks API
  try {
    const info = await fetchJson<{ stacks_tip_height: number; burn_block_height: number }>(`${HIRO_API}/v2/info`);
    checks.push({ name: "Hiro Stacks API", ok: true, detail: `tip: ${info.stacks_tip_height}, burn: ${info.burn_block_height}` });
  } catch (e: unknown) { checks.push({ name: "Hiro Stacks API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 4. Tenero Price Oracle
  try {
    const t = await fetchJson<Record<string, Record<string, unknown>>>(`${TENERO_API}/v1/stacks/tokens/${SBTC_TOKEN}`);
    const d = t?.data as Record<string, unknown> | undefined;
    const p = (d?.price_usd as number) ?? 0;
    checks.push({ name: "Tenero Price Oracle", ok: p > 0, detail: `sBTC: $${round(p, 2)}` });
  } catch (e: unknown) { checks.push({ name: "Tenero Price Oracle", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 5. Bitflow HODLMM API
  try {
    const pools = await fetchBitflowPools();
    checks.push({ name: "Bitflow HODLMM API", ok: pools.length > 0, detail: `${pools.length} pools` });
  } catch (e: unknown) { checks.push({ name: "Bitflow HODLMM API", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 6. mempool.space
  try {
    const fees = await fetchJson<{ fastestFee: number }>(`${MEMPOOL_API}/v1/fees/recommended`);
    checks.push({ name: "mempool.space", ok: !!fees.fastestFee, detail: `${fees.fastestFee} sat/vB` });
  } catch (e: unknown) { checks.push({ name: "mempool.space", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 7. sBTC Proof of Reserve
  try {
    const r = await checkReserve();
    checks.push({ name: "sBTC Proof of Reserve", ok: r.signal === "GREEN", detail: `${r.signal}, ratio ${r.reserve_ratio ?? "N/A"}, ${round(r.btc_reserve, 2)} BTC backing ${round(r.sbtc_circulating, 2)} sBTC` });
  } catch (e: unknown) { checks.push({ name: "sBTC Proof of Reserve", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 8. Zest v2 vault
  try {
    const ur = await callReadOnly(ZEST_VAULT_SBTC, "get-utilization", []);
    checks.push({ name: "Zest v2 sBTC Vault", ok: ur.okay, detail: ur.okay ? "utilization readable" : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Zest v2 sBTC Vault", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 9. Hermetica staking
  try {
    const rr = await callReadOnly(HERMETICA_STAKING, "get-usdh-per-susdh", []);
    const rate = rr.okay && rr.result ? Number(parseUint128Hex(rr.result)) / 1e8 : 0;
    checks.push({ name: "Hermetica Staking", ok: rr.okay && rate > 0, detail: `exchange rate: ${round(rate, 6)} USDh/sUSDh` });
  } catch (e: unknown) { checks.push({ name: "Hermetica Staking", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 10. Granite Protocol
  try {
    const lp = await callReadOnly(GRANITE_STATE, "get-lp-params", []);
    checks.push({ name: "Granite Protocol (aeUSDC LP)", ok: lp.okay, detail: lp.okay ? "get-lp-params readable" : "read failed" });
  } catch (e: unknown) { checks.push({ name: "Granite Protocol (aeUSDC LP)", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  // 11. HODLMM Pool Contract
  try {
    const ab = await callReadOnly(HODLMM_POOLS[0].contract, "get-active-bin-id", []);
    const bin = ab.okay && ab.result ? 500 + Number(parseInt128Hex(ab.result)) : 0;
    checks.push({ name: "HODLMM Pool Contracts", ok: ab.okay, detail: `active bin: ${bin}` });
  } catch (e: unknown) { checks.push({ name: "HODLMM Pool Contracts", ok: false, detail: e instanceof Error ? e.message : String(e) }); }

  const allOk = checks.every(c => c.ok);
  const cryptoOk = checks.slice(0, 2).every(c => c.ok);

  console.log(JSON.stringify({
    status: allOk ? "ok" : cryptoOk ? "degraded" : "critical",
    checks,
    message: !cryptoOk
      ? "CRITICAL: Cryptographic self-tests failed. Engine will not operate."
      : allOk
      ? `All ${checks.length} checks passed. Engine ready.`
      : "Some data sources unavailable, engine may operate in degraded mode.",
  }, null, 2));

  if (!cryptoOk) process.exit(2);
  if (!allOk) process.exit(1);
}

// =============================================================================
// ==  RENDERED REPORT
// =============================================================================

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/**
 * The HODLMM report row that is not a position: UNKNOWN naming each pool that could not be
 * read, or Idle when every pool was read and none is held. A pool that could not be read is
 * never counted as idle. Null when positions were read and no pool failed.
 */
export function hodlmmQuietRow(h: HodlmmPositions): string | null {
  const unread = h.unread ?? [];
  if (unread.length > 0) return `| HODLMM     | **UNKNOWN** | Could not read ${unread.map(p => p.name).join(", ")}, so a position there is not known either way |`;
  return h.has_position ? null : `| HODLMM     | Idle | No positions across ${HODLMM_POOLS.length} pools |`;
}

function renderReport(scout: ScoutResult, reserve: ReserveResult, guardian: GuardianResult): string {
  const L: string[] = [];

  L.push("");
  L.push("Stacks Alpha Engine: Full Report");
  L.push(`Wallet: ${scout.wallet}`);
  L.push("");

  // Section 1: What You Have
  //
  // THIS TABLE IS WHERE THE ZERO GETS TOLD TO A PERSON. It used to print
  // `amount` and `usd` straight out of the scout, which cannot tell a wallet
  // that holds nothing apart from a wallet nobody managed to read: both arrive
  // as 0. During a production audit a Hiro 429 rendered here as six zero rows
  // and "Wallet Total $0" over a real $3.93, and there is no worse thing this
  // report can say. An empty wallet is disappointing; a wallet reported empty
  // that is not sends somebody looking for stolen money.
  //
  // So the cells now render UNKNOWN when the read failed, and still render 0
  // when the read succeeded and the answer was zero. The distinction is the
  // scout's `available` flags, which describe the RESPONSE and never the value,
  // so a genuinely empty wallet is untouched by all of this.
  const avail = scout.available;
  // Amounts come from one read, dollar values from that read plus a price. They
  // fail apart: a dead price feed leaves "14.879089 STX" correct and only its
  // dollar column unknown, so the two columns are judged separately rather than
  // blanking a number that is actually in hand.
  const amt = (n: number) => avail.balances ? String(n) : "unknown";
  // A missing price does not make every dollar cell unknown. NONE of something
  // is worth $0 whatever it trades at, so a zero holding still prints an exact
  // $0 through a dead feed. Hiding a figure that IS known is a smaller failure
  // than inventing one, but it is still a failure, and it would have left this
  // table saying "unknown" beside a total the same run stated exactly.
  const usd = (b: TokenBalance, priced: boolean) =>
    avail.balances && (priced || b.amount === 0) ? `$${b.usd}` : "unknown";
  L.push("## 1. What You Have (available in wallet)");
  L.push("");
  L.push("| Token   | Amount             | USD      |");
  L.push("|---------|--------------------|---------:|");
  L.push(`| sBTC    | ${pad(amt(scout.balances.sbtc.amount), 18)} | ${usd(scout.balances.sbtc, avail.price_sbtc)} |`);
  L.push(`| STX     | ${pad(amt(scout.balances.stx.amount), 18)} | ${usd(scout.balances.stx, avail.price_stx)} |`);
  // The four stablecoins are pegged at $1 in this file rather than quoted, so
  // their dollar column depends on the balance read alone and survives a dead
  // price feed.
  L.push(`| USDCx   | ${pad(amt(scout.balances.usdcx.amount), 18)} | ${usd(scout.balances.usdcx, true)} |`);
  L.push(`| USDh    | ${pad(amt(scout.balances.usdh.amount), 18)} | ${usd(scout.balances.usdh, true)} |`);
  L.push(`| sUSDh   | ${pad(amt(scout.balances.susdh.amount), 18)} | ${usd(scout.balances.susdh, true)} |`);
  L.push(`| aeUSDC  | ${pad(amt(scout.balances.aeusdc.amount), 18)} | ${usd(scout.balances.aeusdc, true)} |`);
  // The total is the line a person reads first and remembers, so it is the line
  // held to the strictest test. It prints a figure only when every component of
  // it was measured. A missing price on a token they hold NONE of leaves the sum
  // exact, so that case still shows the number instead of hiding a good answer.
  const walletUsd = round(scout.balances.sbtc.usd + scout.balances.stx.usd + scout.balances.usdcx.usd + scout.balances.usdh.usd + scout.balances.susdh.usd + scout.balances.aeusdc.usd, 2);
  const totalKnown = avail.balances
    && (avail.price_sbtc || scout.balances.sbtc.amount === 0)
    && (avail.price_stx || scout.balances.stx.amount === 0);
  L.push(`| **Wallet Total** |              | ${totalKnown ? `**$${walletUsd}**` : "**unknown**"} |`);
  L.push("");
  if (avail.unavailable.length > 0) {
    L.push(`> **Some reads did not return this run: ${avail.unavailable.join(", ")}.** Every cell above marked "unknown" is exactly that: unknown. It is NOT zero, and it is not a statement about what you hold. Run the scan again.`);
    L.push("");
  }

  // Section 2: Positions (4 protocols)
  L.push("## 2. Positions (deployed capital)");
  L.push("");
  L.push("| Protocol   | Status     | Detail |");
  L.push("|------------|------------|--------|");

  const z = scout.positions.zest;
  L.push(`| Zest       | ${z.state === "unknown" ? "**UNKNOWN**" : z.has_position ? "**ACTIVE**" : "Idle"} | ${z.detail} |`);

  const herm = scout.positions.hermetica;
  // Hermetica is the one protocol whose position is inferred from a WALLET
  // balance rather than from a position read, because a stake shows up as sUSDh
  // held. That makes this row depend on the same read as section 1, so when that
  // read fails the honest answer is "unknown", not "Idle". Printing Idle here
  // would tell somebody their stake is gone.
  const hermStaked = scout.balances.susdh.amount > 0;
  const hermDetail = !avail.balances
    ? `Position unknown: the wallet read failed, so a sUSDh stake could not be seen either way (rate: ${herm.exchange_rate})`
    : hermStaked
    ? `${scout.balances.susdh.amount} sUSDh staked (rate: ${herm.exchange_rate})`
    : herm.detail;
  L.push(`| Hermetica  | ${!avail.balances ? "**UNKNOWN**" : hermStaked ? "**ACTIVE**" : "Idle"} | ${hermDetail} |`);

  const g = scout.positions.granite;
  L.push(`| Granite    | ${g.has_position ? "**ACTIVE**" : "Idle"} | ${g.detail} (accepts: ${g.accepted_token}) |`);

  const h = scout.positions.hodlmm;
  let deployedUsd = 0;
  if (h.has_position) {
    for (const p of h.pools) {
      const rangeTag = p.in_range ? "IN RANGE" : "**OUT OF RANGE**";
      const binStr = p.user_bins ? `${p.user_bins.count} bins (${p.user_bins.min}-${p.user_bins.max})` : "no bins";
      const valueStr = p.estimated_value_usd !== null ? `$${p.estimated_value_usd}` : "-";
      if (p.estimated_value_usd) deployedUsd += p.estimated_value_usd;
      L.push(`| HODLMM     | **ACTIVE** | ${p.name} ${rangeTag} bin ${p.active_bin}, ${binStr}, ${valueStr} |`);
    }
  }
  const quiet = hodlmmQuietRow(h);
  if (quiet) L.push(quiet);
  L.push("");

  // Section 3: sBTC Reserve Status
  L.push("## 3. sBTC Reserve Status (Proof of Reserve)");
  L.push("");
  L.push(`| Check | Value |`);
  L.push(`|-------|------:|`);
  L.push(`| Signal | **${reserve.signal}** |`);
  L.push(`| Reserve ratio | ${reserve.reserve_ratio ?? "N/A"} |`);
  L.push(`| BTC in vault | ${reserve.btc_reserve} BTC |`);
  L.push(`| sBTC circulating | ${reserve.sbtc_circulating} sBTC |`);
  L.push(`| Verdict | ${reserve.recommendation} |`);
  L.push("");

  // Section 4: Yield Options (3-tier)
  L.push("## 4. Yield Options");
  L.push("");
  // The three tiers are sorted by what the wallet holds, so a failed balance read
  // sorts every option as though the wallet were empty and pushes real, already
  // fundable moves into "acquire to unlock". The APYs below are still live market
  // reads and worth showing; which tier each one landed in is not trustworthy
  // this run, and saying so beats quietly presenting a mis-sorted table.
  if (!avail.balances) {
    L.push("> **The wallet read failed, so these are sorted against an unknown balance.** The APY figures are live. Which tier an option landed in is not: an option you could fund today may be listed under \"acquire to unlock\" because this run could not see what you hold.");
    L.push("");
  }

  const deployNow = scout.options.filter(o => o.tier === "deploy_now");
  const swapFirst = scout.options.filter(o => o.tier === "swap_first");
  const acquire = scout.options.filter(o => o.tier === "acquire_to_unlock");

  // The gates column, so a reader can tell a pool that passed from one nobody
  // measured. Only the top actionable option is measured per run, and without
  // saying so the rest read as equally checked.

  if (deployNow.length > 0) {
    L.push("### You can deploy now");
    L.push("| # | Protocol | Pool | Token | APY | Daily | Monthly | YTG | Gates | Note |");
    L.push("|---|----------|------|-------|----:|------:|--------:|----:|-------|------|");
    deployNow.forEach((o, i) => {
      const ytg = o.ytg_profitable ? `${o.ytg_ratio}x` : `**${o.ytg_ratio}x**`;
      L.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | $${o.daily_usd} | $${o.monthly_usd} | ${ytg} | ${gateCellFor(o)} | ${o.note} |`);
    });
    L.push("");
    L.push("_YTG = Yield-to-Gas ratio (7d projected yield / gas cost to enter). Below 3x means the fee to enter is large next to a week of yield. It is shown so you can weigh it, and it does not stop you._");
    L.push("");
  }

  if (swapFirst.length > 0) {
    L.push("### Swap first, then deploy");
    L.push("| # | Protocol | Pool | Token | APY | YTG | Gates | Swap | Note |");
    L.push("|---|----------|------|-------|----:|----:|-------|------|------|");
    swapFirst.forEach((o, i) => {
      const ytg = o.ytg_profitable ? `${o.ytg_ratio}x` : `**${o.ytg_ratio}x**`;
      L.push(`| ${i + 1} | ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | ${ytg} | ${gateCellFor(o)} | ${o.swap_cost_note ?? "-"} | ${o.note} |`);
    });
    L.push("");
    if (swapTableNeedsPairNote(swapFirst)) {
      // Conditional, because this table also holds Hermetica staking and Granite
      // lending, which have no pair and no active bin. The sentence was printed
      // over those too.
      L.push("_For the paired pools above, the APY is what a position at the active bin earns. Getting there needs both sides, which is what the swap is for: a one sided deposit sits outside the active bin and earns nothing until price reaches it._");
    }
    L.push("");
  }

  if (acquire.length > 0) {
    L.push("### Acquire to unlock");
    L.push("| Protocol | Pool | Token needed | APY | How to get |");
    L.push("|----------|------|-------------|----:|------------|");
    acquire.forEach(o => {
      L.push(`| ${o.protocol} | ${o.pool} | ${o.token_needed} | ${o.apy_pct}% | ${o.note} |`);
    });
    L.push("");
  }

  // Section 5: Best Move + YTG Verdict
  L.push("## 5. Verdict");
  L.push("");
  L.push(`> ${scout.best_move.recommendation}`);
  L.push("");
  const profitable = scout.options.filter(o => o.ytg_profitable && o.tier !== "acquire_to_unlock");
  const unprofitable = scout.options.filter(o => !o.ytg_profitable && o.tier !== "acquire_to_unlock");
  if (profitable.length > 0 && unprofitable.length > 0) {
    L.push(`**YTG verdict:** ${profitable.length} option${profitable.length > 1 ? "s" : ""} profitable (yield > 3x gas), ${unprofitable.length} where the entry fee is large next to a week of yield.`);
  } else if (profitable.length > 0) {
    L.push(`**YTG verdict:** All ${profitable.length} options are profitable, gas cost is negligible relative to yield.`);
  } else if (unprofitable.length > 0) {
    L.push(`**YTG verdict:** On every option the entry fee is large next to a week of yield. Worth doing only if you plan to stay in. Your money, your call.`);
  }
  L.push("");

  // Section 6: Break Prices
  const bp = scout.break_prices;
  L.push("## 6. Break Prices");
  L.push("");
  L.push("| Trigger | sBTC Price |");
  L.push("|---------|----------:|");
  if (bp.hodlmm_range_exit_low_usd) L.push(`| HODLMM range exit (low) | **$${bp.hodlmm_range_exit_low_usd.toLocaleString()}** |`);
  // The last unguarded zero in the report. `getBreakPrices` is handed
  // `prices.sbtc`, which is 0 when the Tenero read fails, and passes it straight
  // through, so a run that printed "unknown" for sBTC in section 1 and named the
  // dead price feed in its own footer still stated down here that Bitcoin is
  // worth nothing. The two range rows above were already guarded; this one was
  // not. A break price is the number somebody sets an alarm against, so it is
  // the last place a placeholder should be allowed to read as a quote.
  L.push(`| Current sBTC price | ${avail.price_sbtc ? `$${bp.current_sbtc_price_usd.toLocaleString()}` : "unknown"} |`);
  if (bp.hodlmm_range_exit_high_usd) L.push(`| HODLMM range exit (high) | **$${bp.hodlmm_range_exit_high_usd.toLocaleString()}** |`);
  L.push("");

  // Section 7: Safety Gates
  L.push("## 7. Safety Gates");
  L.push("");
  L.push(`| Gate | Status | Detail |`);
  L.push(`|------|--------|--------|`);
  L.push(`| PoR Reserve | ${reserve.signal === "GREEN" ? "PASS" : "**FAIL**"} | ${reserve.signal} |`);
  // A gate reports which pool it measured, on a pass as much as on a failure. The
  // venue used to be recorded only inside a refusal string, so it was named
  // exactly when the gate failed and unrecorded when a reader was about to act on
  // the number, which is backwards.
  const gateCell = (g: PoolGate): string => {
    if (g.status === "not-applicable") return "n/a";
    if (g.status === "unknown") return "**UNKNOWN**";
    return g.ok ? "PASS" : "**FAIL**";
  };
  const poolSuffix = (g: PoolGate): string =>
    g.pool_id ? ` on ${g.pool_id}${g.pool_name ? ` (${g.pool_name})` : ""}` : "";

  L.push(`| Slippage | ${gateCell(guardian.slippage)} | ${
    guardian.slippage.status === "pass" || guardian.slippage.status === "fail"
      ? `${guardian.slippage.value}% (max ${MAX_SLIPPAGE_PCT}%)${poolSuffix(guardian.slippage)}`
      : `not measured: ${guardian.slippage.source}`
  } |`);
  L.push(`| 24h Volume | ${gateCell(guardian.volume)} | ${
    guardian.volume.status === "pass" || guardian.volume.status === "fail"
      // `?? 0` is unreachable today: this branch runs only on pass or fail, and
      // `value` is non-null in both. It stays as a type narrowing, NOT as a
      // fallback, and it must never become one. Formatting an unmeasured volume
      // as `$0` would print a definite figure for a number nobody read.
      ? `$${Math.round(guardian.volume.value ?? 0).toLocaleString()} (min $${MIN_24H_VOLUME_USD.toLocaleString()})${poolSuffix(guardian.volume)}`
      : `not measured: ${guardian.volume.source}`
  } |`);
  // This row used to print the network estimate alone, as `0.0216 STX (max 50)`,
  // which reads as the price of entry. It is not. This file says so about the same
  // number a few hundred lines up: the estimate is a DIVISOR used to rank options,
  // "whoever renders this must show the fee actually charged, or a small holder is
  // told it costs less than it does". This is a renderer, so it says both, names
  // the byte assumption behind the estimate, and admits what the gate can catch.
  // The cap is a 50 STX TOTAL on this file's own 3600 byte figure. Rates measured
  // on 2026-08-28 ran 6 to 585 microSTX per byte, which is 0.02 to 2.11 STX on
  // that figure, so the cap trips on a runaway rate or on nothing: saying "PASS"
  // without admitting that is a check pretending to be tighter than it is. (An
  // earlier version of this line said "0.02 and 1.50", a maximum from a sample set
  // the 585 reading had already superseded twenty lines up. Two comments about one
  // measurement, disagreeing.) The row does not quote a fee, because the fee is
  // not set here.
  L.push(`| Gas | ${guardian.gas.status === "unknown" ? "**UNKNOWN**" : guardian.gas.ok ? "PASS" : "**FAIL**"} | ${
    guardian.gas.estimated_stx === null
      ? `not measured: ${guardian.gas.source}`
      : `${guardian.gas.estimated_stx} STX, from Hiro's TRANSFER fee rate applied to an assumed ${GAS_ASSUMED_TX_BYTES} byte call. This is the figure the gate checks, NOT the fee you pay: SmartX sets that separately when it builds the transaction. This gate only catches a TOTAL above ${MAX_GAS_STX} STX, or a read that failed.`
  } |`);
  L.push(`| Cooldown | ${guardian.cooldown.ok ? "PASS" : "**FAIL**"} | ${guardian.cooldown.remaining_hours > 0 ? `${guardian.cooldown.remaining_hours}h remaining` : "Ready"} |`);
  L.push(`| Prices | ${guardian.prices.ok ? "PASS" : "**FAIL**"} | ${guardian.prices.detail} |`);
  // THE VERDICT ROW USED TO ASK THE SECOND GATE AND SKIP THE FIRST. It read
  // `guardian.can_proceed` alone, and the guardian is not the gate that decides
  // this: `_runPipeline` checks the reserve BEFORE the guardian and returns
  // `status: "refused"` on RED, on DATA_UNAVAILABLE and on YELLOW, so on a
  // non-GREEN reserve the guardian never runs at all and its `can_proceed`
  // describes a check that was not reached. The audit caught the table printing
  // `PoR Reserve | **FAIL**` and, two rows down, `Can execute writes? | YES |
  // All gates pass`, which is the table contradicting itself on the same screen.
  //
  // The code was right and the money was safe throughout. It is the REPORT that
  // was wrong, and a safety table that a person catches lying about a refusal is
  // worth nothing to them on the day it says a write is fine.
  //
  // Non-GREEN is the test, not RED, because YELLOW refuses too. That is exactly
  // the condition the PoR row above already prints as FAIL, so the two rows now
  // agree by construction.
  // THERE ARE THREE GATES IN FRONT OF A WRITE, NOT TWO, and this row has to ask
  // all of them. The unreadable-balance refusal added to `_runPipeline` runs
  // FIRST, ahead of the reserve, and a first draft of this fix forgot it: on a
  // Hiro rate-limit with a healthy reserve and a passing guardian, the same page
  // printed "Wallet Total unknown" in section 1 and "Can execute writes? YES"
  // down here. That is this very defect reopened one gate to the left, which is
  // what a verdict assembled from a hand-picked subset of the gates will always
  // eventually do. The rule the row now follows: every condition that can return
  // `refused` before the executor is named here, in the order the pipeline hits
  // them, so the reason a person reads is the reason they would actually get.
  const balancesBlockWrites = !avail.balances;
  const porBlocksWrites = reserve.signal !== "GREEN";
  const canWrite = !balancesBlockWrites && !porBlocksWrites && guardian.can_proceed;
  const writeBlockers = [
    ...(balancesBlockWrites ? [`Wallet balances could not be read (${avail.unavailable.join(", ")}): writes are refused before the reserve and guardian gates are reached, because the instruction builders size a transaction from those numbers. 'emergency' withdrawal is still available.`] : []),
    ...(porBlocksWrites ? [`PoR signal ${reserve.signal}: writes are refused before the guardian gates are reached. 'emergency' withdrawal is still available.`] : []),
    ...guardian.refusals,
  ];
  L.push(`| **Can execute writes?** | **${canWrite ? "YES" : "NO"}** | ${writeBlockers.length > 0 ? writeBlockers.join("; ") : "All gates pass"} |`);
  L.push("");

  L.push("---");
  // The footer names the reads that FAILED, not just the count that worked. A
  // count of successes is what let a run print "8 live reads" while the one read
  // holding the person's balances was missing from the list.
  const missing = avail.unavailable.length > 0 ? ` | Did not return: ${avail.unavailable.join(", ")}` : "";
  L.push(`Data sources: ${scout.data_sources.length} live reads | Status: ${scout.status}${missing} | Engine: stacks-alpha-engine v2.0.0`);
  L.push("");

  return L.join("\n");
}

// =============================================================================
// ==  CLI
// =============================================================================

const program = new Command();

program
  .name("stacks-alpha-engine")
  .description("Cross-protocol yield executor for Zest, Hermetica, Granite, and HODLMM with sBTC reserve verification")
  .version("2.0.0");

program
  .command("doctor")
  .description("Run all self-tests: crypto vectors, data sources, on-chain reads, PoR verification")
  .action(runDoctor);

program
  .command("scan")
  .description("Full read-only scan: wallet, positions (4 protocols), yields (3-tier), break prices, PoR, safety gates")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--format <type>", "Output format: json (default) or text", "json")
  .action(async (opts: { wallet: string; format: string }) => {
    try {
      const scout = await scoutWallet(opts.wallet);
      const reserve = await checkReserve();
      // The pool this run is about to recommend, so the table describes the thing
      // it points at. `pool_id` is set only on HODLMM options, so a Hermetica,
      // Granite or Zest recommendation yields null and the two pool gates report
      // themselves as not applicable rather than measuring something unrelated.
      const guardian = await checkGuardian(scout, scanGuardianInput(scout.options));

      // Mark the one option this run actually measured. Every other option keeps
      // the `gates` it was built with, `not-measured`, which means "nobody looked"
      // and not "it failed". Without this, unmeasured pools sat beside the
      // recommended one reading as equally ready.
      applyGateResults(scout.options, guardian);

      // The top-level status is DERIVED from the scout's own, never asserted.
      // This line used to be the literal `"ok"`, printed directly above a
      // `scout.status` of `"degraded"` in the same object, so a run that had just
      // failed to read somebody's balances announced itself as healthy. The
      // project already recorded this rule once about exit codes: `ok` must read
      // the payload's own status. It applies just as much to a hardcoded string,
      // and more so, because consumers gate on this field and cannot see one
      // level down. `smartx-app`'s server treats `degraded` as "the skill could
      // not answer", which is the correct handling of a scan whose balances are
      // unknown: it shows the person that something failed instead of showing
      // them an invented empty wallet.
      const status = scout.status === "ok" ? "ok" : "degraded";
      if (opts.format === "text") {
        console.log(renderReport(scout, reserve, guardian));
      } else {
        console.log(JSON.stringify({ status, command: "scan", disclaimer: DISCLAIMER, scout, reserve, guardian, rendered_report: renderReport(scout, reserve, guardian) }, null, 2));
      }
    } catch (err: unknown) {
      console.error(JSON.stringify({ status: "error", command: "scan", error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }
  });

program
  .command("deploy")
  .description("Deploy capital to a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Target protocol: zest, hermetica, granite, hodlmm")
  .requiredOption("--amount <value>", "Amount in smallest unit (sats for sBTC, micro for stablecoins)")
  .option("--token <symbol>", "Token to deploy (default: inferred from protocol)")
  .option("--pool-id <id>", "HODLMM pool ID for protocol=hodlmm (default: dlmm_1). Ignored for other protocols.", "dlmm_1")
  .option("--counter-amount <value>", "Second side of a HODLMM deposit, in the counter token's smallest unit, digits only. Required to deposit both sides; without it the deposit is one sided. Never inferred from your balance. Ignored for zest, hermetica and granite, which take one asset.")
  .option("--force", "Override 0% APY refusal")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "deploy", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("withdraw")
  .description("Withdraw from a protocol (runs full safety pipeline first)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Source protocol: zest, hermetica, granite, hodlmm")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "withdraw", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("rebalance")
  .description("Withdraw out-of-range HODLMM bins and re-add centered on active bin")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--pool-id <id>", "HODLMM pool ID (default: dlmm_1)", "dlmm_1")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "rebalance", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("borrow")
  .description("Borrow a debt asset against existing Zest collateral (leveraged-yield leg)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Protocol: zest")
  .requiredOption("--token <symbol>", "Borrow asset (Zest: usdh)")
  .requiredOption("--amount <value>", "Amount in smallest unit (µUSDh for usdh; USDh has 8 decimals)")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "borrow", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("repay")
  .description("Repay a borrowed Zest debt asset")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--protocol <name>", "Protocol: zest")
  .requiredOption("--token <symbol>", "Repay asset (Zest: usdh)")
  .requiredOption("--amount <value>", "Amount in smallest unit (µUSDh for usdh)")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "repay", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("migrate")
  .description("Move capital from one protocol to another (withdraw + deploy)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .requiredOption("--from <protocol>", "Source protocol: zest, hermetica, granite, hodlmm")
  .requiredOption("--to <protocol>", "Target protocol: zest, hermetica, granite, hodlmm")
  .option("--token <symbol>", "Token to deploy into target (default: inferred)")
  .option("--amount <value>", "Amount in smallest unit (default: all)")
  .option("--pool-id <id>", "HODLMM pool ID when --to=hodlmm (default: dlmm_1). Ignored otherwise.", "dlmm_1")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "migrate", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("emergency")
  .description("Emergency withdrawal from ALL protocols (bypasses guardian gates)")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--confirm", "Execute the transaction (without this flag, outputs a dry-run preview)")
  .action(async (opts: Record<string, string>) => {
    const result = await runPipeline(opts.wallet, "emergency", opts);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "ok") process.exit(1);
  });

program
  .command("install-packs")
  .description("Check dependency requirements")
  .action(() => {
    console.log(JSON.stringify({
      status: "ok",
      message: "Requires: tiny-secp256k1 (BIP-341 EC point addition). All other operations use public APIs.",
      data: { requires: ["tiny-secp256k1"] },
    }, null, 2));
  });

if (import.meta.main) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(JSON.stringify({ status: "error", error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
