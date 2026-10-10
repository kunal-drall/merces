import { pidAt } from '@merces/math';
import { nextExpectedPid } from '@merces/simulator';
import { periodIdOf } from '../codec.ts';
import { direct, shim, type TranslatorTable } from './types.ts';

/**
 * Treasury releases, payments, claims and burns.
 *
 * - `claim_release`: `drawRelease` (direct).
 * - `pay` (SH-PAY-1): Stage 1's `pay` names neither period nor amount; `payIn` takes the open due period (else the
 *   next expected period, amendments: never null) and the amount the chain shows due for it now (accrual included),
 *   0 when it shows nothing, so the chain itself decides NothingDue.
 * - `claim`: `claimPayout` (direct since S3 WP3; was shim SH-CLM-1 while `claimPayout` also paid the tail and the final
 *   share), Stage 1's body (SIM:1268-1282): the net payout only, a Retired balance burned, zeros emitted.
 * - `burn_retired`: `burnRetired{holder}` (direct since S3; was shim SH-BRN-1, the S1 list burn crank sent for one holder), Stage 1's
 *   body (SIM:624-636). Stage 1's op carries no actor (anyone may send it), so the runner submits it as the keeper.
 */
export const moneyOps: TranslatorTable = {
  claim_release: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'drawRelease', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  pay: (ctx, c) =>
    shim('SH-PAY-1', async () => {
      const b = ctx.seriesBook(c.series);
      const s = ctx.seriesState(c.series);
      // before settlement there is no ledger clock: name the current quarter and let the chain refuse it
      const pid = s.ledger.openDuePeriod ?? (s.ledger.firstPeriod === null ? pidAt(BigInt(ctx.now())) : nextExpectedPid(s));
      const periodId = periodIdOf(pid);
      const period = await ctx.chain.getPeriod(b.seriesId, periodId);
      const due = period ? BigInt(period.paymentDue) - BigInt(period.paid) : 0n;
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'payIn', seriesId: b.seriesId, periodId, amount: (due > 0n ? due : 0n).toString() });
    }),

  claim: (ctx, c) =>
    direct(async () => {
      await ctx.send(ctx.actors.wallet(c.actor), { kind: 'claimPayout', seriesId: ctx.seriesBook(c.series).seriesId });
    }),

  burn_retired: (ctx, c) =>
    direct(async () => {
      await ctx.submit({ kind: 'burnRetired', seriesId: ctx.seriesBook(c.series).seriesId, holder: ctx.actors.address(c.holder) }, 'keeper');
    }),
};
