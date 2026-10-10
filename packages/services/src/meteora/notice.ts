import { CURVE_BUYER_NOTICE, CURVE_NO_CAP, curveBuyerNotice, curveNoticeFigures, type CurveState } from '@merces/domain';

/**
 * What every curve read and builder of a series carries (owner directions; S3 amendments H2 and M1, WP7, WP12, the S3
 * review): "no cap" and the buyer notice. The curve's reads and builders are `GET /series/{id}/curve`, its quote and
 * position reads, and its configure, swap, stake, unstake, tender and census builders (`MeteoraService`,
 * `CurveStakingService`); the admin monitor, one keeper pass over every curve, is not a read of one curve and carries
 * neither.
 */

/**
 * "No cap" as every curve response carries it (owner direction; Stage 1 stores a curve series' wallet cap as 0): no
 * wallet cap object (`walletCap: null`), `noCap: true` and the one statement.
 */
export const NO_CAP = { walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP } as const;

/**
 * The buyer notice with the curve's own figures, read from the chain (its trading fee and that fee's split among
 * Merces, Meteora and the issuer from the pool's config, its target, Meteora's migration fee; owner direction of
 * 2026-10-10); the template without a curve.
 */
export function curveNotice(c: CurveState | null): string {
  return c ? curveBuyerNotice(curveNoticeFigures(c)) : CURVE_BUYER_NOTICE;
}

/** The fields "no cap" and the notice add to a curve response (OpenAPI `CurveNoCap`). */
export type CurveNoCapFields = { walletCap: null; noCap: true; noCapStatement: string; notice: string };

/** No cap and the buyer notice with the curve's figures, as one spread. */
export function curveNoCap(c: CurveState | null): CurveNoCapFields {
  return { ...NO_CAP, notice: curveNotice(c) };
}
