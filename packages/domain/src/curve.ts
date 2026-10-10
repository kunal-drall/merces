import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { CURVE_UNIT_SCALE, WAD } from '@merces/math';
import type { SeriesTerms } from './events.ts';
import type { CurveState } from './state.ts';

/**
 * Curve mode in the chain-neutral model (Stage 1 SPEC §9, CURVE_MODE.md).
 *
 * A curve series' unit mint has 6 decimals: one whole unit is 10^6 base lamports, the series' accounting unit (Stage 1
 * `Ledger.unit_scale`, merces-common `curve.rs:15-16` `CURVE_UNIT_SCALE`). Units outstanding, weights, stakes, tenders
 * and the vault's per-unit WAD figures are per accounting unit; prices (the issue price, the cap, `P_redeem`) stay per
 * whole unit. A sealed-bid series has scale 1.
 */

/** Accounting units per whole unit, as the reads carry it: "1" (sealed bid) or "1000000" (curve, base lamports). */
export type UnitScale = '1' | '1000000';

/** The unit scale a raise style implies (Stage 1 sets `unit_scale` when the series is created and never changes it). */
export function unitScaleOf(raiseStyle: SeriesTerms['raiseStyle']): bigint {
  return raiseStyle === 'curve' ? CURVE_UNIT_SCALE : 1n;
}

/**
 * Accounting units the terms' `r` is per (Stage 1 registry `create_series`, lib.rs:594-600; B-C2): the units offered for a
 * sealed-bid series, the units offered × 10^6 base lamports for a curve series, so `r = ratePerUnit(share, rateUnits)`
 * and `r × rateUnits ≤ WAD`. `unitsOffered` itself stays in whole units on every series.
 */
export function rateUnits(terms: Pick<SeriesTerms, 'unitsOffered' | 'raiseStyle'>): bigint {
  return BigInt(terms.unitsOffered) * unitScaleOf(terms.raiseStyle);
}

/**
 * The terms a curve series records as 0 (Stage 1 registry `create_series`, lib.rs:465-480, CurveTermsNotZero; SPEC §9):
 * a curve raise has no auction (no commit or reveal phase), no lockup and no wallet cap. Stage 1 also zeroes the window
 * durations, which are not canonical terms yet (S5). Stage 1 checks its parameter bounds on the protocol defaults for
 * these fields instead (lib.rs:517-540), so a curve series' zeros are never bounded.
 */
export const CURVE_ZERO_TERMS = ['lockupSeconds', 'walletCapBps', 'commitDurationSeconds', 'revealDurationSeconds'] as const satisfies readonly (keyof SeriesTerms)[];

/** The curve series' values for `CURVE_ZERO_TERMS`, to spread into curve terms. */
export const CURVE_TERMS_ZEROS: { readonly [K in (typeof CURVE_ZERO_TERMS)[number]]: 0 } = { lockupSeconds: 0, walletCapBps: 0, commitDurationSeconds: 0, revealDurationSeconds: 0 };

/**
 * The one "no cap" statement (owner direction, S1 review; applied in S3): every API read, notice and document that
 * speaks of a curve raise's cap says this, and nothing else. Stage 1 stores a curve series' wallet cap as 0 and enforces
 * none, in either phase (registry CurveTermsNotZero; the DBC base mint has no transfer hook, freeze authority or
 * permanent delegate). Reads that carry it set `noCap: true` and `noCapStatement` to this text.
 */
export const CURVE_NO_CAP =
  'No cap: a curve raise has no wallet cap at any stage. Any wallet can hold any number of units, before and after the curve fills, and there is no limit on how many units a wallet buys or sells.';

/**
 * A per-unit WAD figure (`paidPerUnitWad`, a tail's `tailPaidPerUnitWad`: per accounting unit) as base units of the
 * stablecoin per WHOLE unit, floored: `floor(wad × unitScale / WAD)` (`paidPerUnitWad / WAD` at scale 1; a curve
 * series' WAD figures are per base lamport, 10^6 to a whole unit). For display; Stage 1's own checks round the paid
 * amount up (`capRemainingScaled`).
 */
export function perWholeUnit(wad: bigint | string, unitScale: bigint | string): bigint {
  return (BigInt(wad) * BigInt(unitScale)) / WAD;
}

/** How a curve's trading fee is split, in bps of the fee (summing to 10,000), as the pool's config holds it. */
export interface TradingFeeSplitBps {
  /** Meteora's protocol share (DBC `protocol_fee_percent`) */
  protocol: number;
  /** the partner's share: Merces' (the config's fee claimer) */
  partner: number;
  /** the creator's share: the issuer's (DBC `creator_trading_fee_percentage` of what the protocol leaves; 0 unless configured) */
  creator: number;
}

/**
 * What `curveBuyerNotice` and `curveBeforeYouBuy` fill in: figures from the series' curve config as the chain reads it
 * (`CurveState`: the DBC pool config in the simulator's stand-in, Meteora's PoolConfig account on a live chain). No
 * percentage in a notice is written down anywhere else (owner direction of 2026-10-10).
 */
export interface CurveNoticeFigures {
  /** the trading fee every trade pays, bps (`CurveState.tradingFeeBps`; 100 = 1%) */
  tradingFeeBps: number;
  /** its split among Meteora, Merces and the issuer (`CurveState.tradingFeeSplitBps`) */
  tradingFeeSplitBps: TradingFeeSplitBps;
  /** X, the quote the curve must take in to fill, stablecoin base units with 6 decimals (`CurveState.migrationQuoteThreshold`) */
  target: string | bigint;
  /** Meteora's migration fee, percent of X (`CurveState.migrationFeePercentage`); the partner's share funds the treasury */
  migrationFeePercentage: number;
}

/** The notice figures of a curve as the chain reads it. */
export function curveNoticeFigures(c: Pick<CurveState, 'tradingFeeBps' | 'tradingFeeSplitBps' | 'migrationQuoteThreshold' | 'migrationFeePercentage'>): CurveNoticeFigures {
  return { tradingFeeBps: c.tradingFeeBps, tradingFeeSplitBps: c.tradingFeeSplitBps, target: c.migrationQuoteThreshold, migrationFeePercentage: c.migrationFeePercentage };
}

/**
 * The buyer notice for a curve raise (owner direction, S3 amendments H2 and M1, and the owner's direction of
 * 2026-10-10: the trading fee and its split come from the series' curve config), with `{fee}`, `{mercesShare}`,
 * `{meteoraShare}`, `{issuerShare}`, `{target}` and `{migrationFee}` left for `curveBuyerNotice` to fill: it holds no
 * percentage of its own. Every fact is Stage 1's (curve mode, SPEC §9; CURVE_MODE.md; PROCEEDS_OPTIONS.md):
 *  - the buyer pays into Meteora's pool, not to Merces; nobody can take that money out before the curve fills, and
 *    Merces cannot repay it (the DBC quote vault; `collect_curve_proceeds` withdraws only after completion);
 *  - selling back into the curve is the only exit before then; nothing refunds a buyer (no cancel, no failure);
 *  - there is no deadline, and a curve that never fills pays the issuer nothing (the treasury of an uncompleted curve
 *    stays 0);
 *  - every trade pays the trading fee, split among Merces (the partner), Meteora (the protocol) and the issuer (the
 *    creator, 0 unless configured) as the pool's config says, and it is never returned, even when the curve never fills
 *    (`claim_trading_fee` at any time);
 *  - no cap (`CURVE_NO_CAP`);
 *  - only staked units earn, staking needs an approved (allowlisted) and registered wallet, and unstaking is always
 *    open (`stake_units`, `unstake_units`); a wallet never approved and registered cannot stake or tender and receives
 *    nothing, so selling is its only exit (`register_holder` needs the allowlist; `tender_units` the holder record);
 *  - the treasury receives the partner's migration fee (and any surplus) once the curve fills;
 *  - if the issuer stops paying, the series can be extinguished and the unvested treasury is shared among staked
 *    units, or tendered units after a redemption (`extinguish`, `claim_final`);
 *  - at a redemption staked units are reserved and wallet units share the rest (`wallet_tender_fits`).
 * The issuer is never said to "default": the notice says "stops paying".
 */
export const CURVE_BUYER_NOTICE = [
  'Before you buy units of a curve raise.',
  "- You buy from Meteora's bonding curve, not from Merces or the issuer. The price is public and moves as people buy and sell.",
  '- Every trade pays a trading fee ({fee}%): {mercesShare}% of it goes to Merces, {meteoraShare}% to Meteora and {issuerShare}% to the issuer. It is never returned, even if the curve never fills.',
  "- Until the curve fills (its graduation), the USDC you pay, less the fee, sits in Meteora's pool, not with Merces, and Merces cannot repay it. Nobody can take it out: not Merces, not the issuer.",
  '- Before graduation the only way out is to sell your units back into the curve, at its price at that moment, less the fee. The raise cannot be cancelled and nobody refunds you.',
  '- There is no deadline. The curve fills only when buyers have paid in its full target ({target} USDC), and it may never fill. If the curve never fills, the issuer receives nothing.',
  `- ${CURVE_NO_CAP}`,
  '- Stake to earn. To earn, your wallet must be approved (allowlisted) and registered for this series, and you must stake your units in its stake vault. Unstaked units earn nothing. You can unstake at any time; what your staked units earned stays yours to claim.',
  '- A wallet that is not approved and registered cannot stake, cannot tender at a redemption and receives nothing from the series: it can only sell.',
  "- When the curve fills, the series treasury receives {migrationFee}% of the target (and any surplus above it) and releases it to the issuer on the series' schedule; the rest of the pool becomes trading liquidity.",
  '- If the issuer stops paying, payouts stop: the series shows as late, a formal notice follows, and the series can be extinguished. The unvested treasury is then shared among staked units, or among tendered units after a redemption.',
  '- At a redemption, staked units are reserved for their holders; units left in wallets share a limited quota, first come, first served.',
].join('\n');

/** A decimal figure of base units with 6 decimals, grouped by thousands (1000000000 → "1,000"). */
function sixDecimals(x: bigint): string {
  const whole = (x / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (x % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** A bps figure as a percentage (100 → "1", 125 → "1.25"). */
function percentOfBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * `CURVE_BUYER_NOTICE` with the curve's own figures: its trading fee and that fee's split among Merces, Meteora and the
 * issuer, its target and Meteora's migration fee. A split that does not sum to 10,000 bps of the fee is refused (a
 * notice never states shares that do not add up).
 */
export function curveBuyerNotice(f: CurveNoticeFigures): string {
  const { protocol, partner, creator } = f.tradingFeeSplitBps;
  if ([protocol, partner, creator].some((x) => !Number.isInteger(x) || x < 0) || protocol + partner + creator !== 10_000) throw new RangeError('the trading fee split must be whole bps summing to 10,000');
  return CURVE_BUYER_NOTICE
    .replace('{fee}', percentOfBps(f.tradingFeeBps))
    .replace('{mercesShare}', percentOfBps(partner))
    .replace('{meteoraShare}', percentOfBps(protocol))
    .replace('{issuerShare}', percentOfBps(creator))
    .replace('{target}', sixDecimals(BigInt(f.target)))
    .replace('{migrationFee}', String(f.migrationFeePercentage));
}

/**
 * The first statement before any buy on a curve (owner direction of 2026-10-10): shown before the buy action, not only
 * in the notice.
 */
export const CURVE_UNAPPROVED_EARN_NOTHING = 'Unapproved wallets earn nothing and cannot tender.';

/** What a buyer acknowledges before a curve buy: the statements, in order, and their version. */
export interface CurveBeforeYouBuy {
  /**
   * `byb1-` and the first 16 hex digits of SHA-256 over the statements (JSON): it changes with any statement, the
   * curve's figures included, so an acknowledgement covers exactly the statements shown
   */
  version: string;
  /** `CURVE_UNAPPROVED_EARN_NOTHING`, then every point of the buyer notice with the curve's figures */
  statements: string[];
}

/**
 * The statements a buyer acknowledges before a curve buy (owner direction of 2026-10-10): first "Unapproved wallets
 * earn nothing and cannot tender.", then the buyer notice's points with the curve's own figures. The pre-buy quote
 * returns them; `build-swap` builds a buy only with `acknowledged: true` for this `version`.
 */
export function curveBeforeYouBuy(f: CurveNoticeFigures): CurveBeforeYouBuy {
  const points = curveBuyerNotice(f).split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const statements = [CURVE_UNAPPROVED_EARN_NOTHING, ...points];
  return { version: `byb1-${bytesToHex(sha256(utf8ToBytes(JSON.stringify(statements)))).slice(0, 16)}`, statements };
}
