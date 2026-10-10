import { CURVE_UNIT_SCALE } from '@merces/math';
import type { SeriesTerms } from './events.ts';

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

/** What `curveBuyerNotice` fills into `CURVE_BUYER_NOTICE`: figures from the curve's own read (`CurveState`). */
export interface CurveNoticeFigures {
  /** the trading fee every trade pays, bps (`CurveState.tradingFeeBps`; 100 = 1%) */
  tradingFeeBps: number;
  /** X, the quote the curve must take in to fill, stablecoin base units with 6 decimals (`CurveState.migrationQuoteThreshold`) */
  target: string | bigint;
  /** Meteora's migration fee, percent of X (`CurveState.migrationFeePercentage`); the partner's share funds the treasury */
  migrationFeePercentage: number;
}

/**
 * The buyer notice for a curve raise (owner direction, S3 amendments H2 and M1), with `{fee}`, `{target}` and
 * `{migrationFee}` left for `curveBuyerNotice` to fill. Every fact is Stage 1's (curve mode, SPEC §9; CURVE_MODE.md;
 * PROCEEDS_OPTIONS.md):
 *  - the buyer pays into Meteora's pool, not to Merces; nobody can take that money out before the curve fills, and
 *    Merces cannot repay it (the DBC quote vault; `collect_curve_proceeds` withdraws only after completion);
 *  - selling back into the curve is the only exit before then; nothing refunds a buyer (no cancel, no failure);
 *  - there is no deadline, and a curve that never fills pays the issuer nothing (the treasury of an uncompleted curve
 *    stays 0);
 *  - every trade pays the trading fee, most of it to Merces (the partner, 80% with no creator share) and the rest to
 *    Meteora, and it is never returned, even when the curve never fills (`claim_trading_fee` at any time);
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
  '- Every trade pays a trading fee ({fee}%): most of it goes to Merces, the rest to Meteora. It is never returned, even if the curve never fills.',
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

/** `CURVE_BUYER_NOTICE` with the curve's own figures: its trading fee, its target and Meteora's migration fee. */
export function curveBuyerNotice(f: CurveNoticeFigures): string {
  return CURVE_BUYER_NOTICE
    .replace('{fee}', percentOfBps(f.tradingFeeBps))
    .replace('{target}', sixDecimals(BigInt(f.target)))
    .replace('{migrationFee}', String(f.migrationFeePercentage));
}
