import { createPublicKey, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { AppError, enqueueOutbox, getFlag } from '@merces/core';
import { attestationMessage, reportPublicInputs, reportProofSchema, verifierAttestationSchema, type UnsignedTx, type UserCommand } from '@merces/domain';
import { WAD, deadlinesFor, parsePeriod, periodStanding, periodsBetween } from '@merces/math';
import { SOURCE_DEFINITIONS, type IncomeSourceKind } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E5 — ProofOfIncome service (tier 2 quarterly flow; tier 1 reconciliation; tier 3 arrives through E10).
 * The device does the private work (zkTLS session, commitment, proof, attestation from the verifier). This
 * service sees only what goes onchain: commitments, the payment, the proof and the attestation. It resolves
 * the FX basis, verifies the proof and the attestation offchain, stores the report, and builds the
 * submitReport / payIn transactions for the issuer to sign. It tracks deadlines (C8).
 */

export const assembleSchema = z.object({
  periodId: z.string().regex(/^\d{4}Q[1-4]$/),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  source: z.string().min(1),
  paymentStable: z.string().regex(/^\d+$/),
  incomeCommitment: z.string().regex(/^0x[0-9a-f]{64}$/),
  proof: reportProofSchema,
  attestation: verifierAttestationSchema.nullable().default(null),
  /** attestor-signed fallback rate when the accumulator is flagged */
  attestorRate: z.object({ attestor: z.string(), rateWad: z.string().regex(/^\d+$/) }).nullable().default(null),
  /** tier 3: the attestor who will co-sign */
  attestor: z.string().nullable().default(null),
  liquidityEvent: z.boolean().default(false),
});

export class ProofOfIncomeService {
  constructor(private readonly ctx: ServiceContext) {}

  private async seriesForIssuer(seriesId: string, session: Session) {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === s.issuer) && !session.roles.includes('admin')) throw AppError.forbidden('not the issuer of this series');
    return { chain, series: s };
  }

  /** The issuer's reporting schedule: every reportable quarter with deadlines, standing and what is still needed. */
  async schedule(seriesId: string, session: Session): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    const now = await chain.now();
    const live = await chain.listPeriods(seriesId);
    const reports = await this.ctx.pool.query('select period_id, report_id, state, tier, source from reports where series_id = $1 and state <> $2 order by created_at', [seriesId, 'superseded']);
    const byPeriod = new Map(reports.rows.map((r) => [r.period_id, r]));
    const current = parsePeriodSafe(now);
    const upcoming = series.settledAt !== null && current && current.end > now ? { periodId: current.id, endsAt: current.end, dueAt: deadlinesFor(current, { dueDays: series.terms.dueDays, graceDays: series.terms.graceDays, formalNoticeDays: series.terms.formalNoticeDays }).dueAt } : null;
    return {
      seriesId, status: series.status, now, reportingCurrency: series.terms.reportingCurrency, fxBasis: series.terms.reportingCurrency === 'USD' ? 'unity' : 'accumulator', tierFlags: series.terms.tierFlags,
      periods: live.map((p) => ({ ...p, report: byPeriod.get(p.periodId) ? { reportId: byPeriod.get(p.periodId)!.report_id, state: byPeriod.get(p.periodId)!.state } : null, nextStep: nextStep(p, byPeriod.get(p.periodId)?.state) })),
      upcoming,
    };
  }

  /** Start a zkTLS session for a source. The device completes it with the provider; the proof goes straight to the report verifier. */
  async createZkTlsSession(seriesId: string, session: Session, periodId: string, source: IncomeSourceKind): Promise<Record<string, unknown>> {
    const { series } = await this.seriesForIssuer(seriesId, session);
    if (!series.terms.tierFlags.tier2) throw AppError.conflict('tier 2 is not enabled for this series');
    const period = parsePeriod(periodId);
    const def = SOURCE_DEFINITIONS[source];
    const r = await this.ctx.zktls.createSession({ source, seriesId, periodId, coversUntil: period.end, year: period.year });
    await this.ctx.pool.query('insert into zktls_sessions (session_id, series_id, period_id, account_id, source, provider, request_url) values ($1,$2,$3,$4,$5,$6,$7) on conflict (session_id) do nothing', [r.sessionId, seriesId, periodId, session.accountId, source, this.ctx.zktls.provider, r.requestUrl]);
    return { ...r, provider: this.ctx.zktls.provider, source: def.name, verifier: { url: this.ctx.reportVerifierUrl, note: 'Send the zkTLS proof and your income salt directly to the report verifier; the API never receives income.' } };
  }

  async verifierInfo(): Promise<Record<string, unknown>> {
    const keys = await this.ctx.verifier.publicKey();
    return { url: this.ctx.reportVerifierUrl, keyId: keys.keyId, publicKeySpkiHex: keys.spkiHex, publicKeyRawHex: keys.rawHex };
  }

  /** Resolve the FX basis for a series/period (C9): unity, the accumulator average, or an attestor rate when flagged. */
  async resolveFx(seriesId: string, periodId: string): Promise<{ basis: 'unity' | 'accumulator' | 'attestor'; pair: string | null; fxAvgWad: string | null; reason: string | null }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.terms.reportingCurrency === 'USD') return { basis: 'unity', pair: null, fxAvgWad: WAD.toString(), reason: null };
    const pair = `${s.terms.reportingCurrency}/USD`;
    const q = await chain.getQuarterRate(pair, periodId);
    if (q && q.avgWad && !q.needsFallback) return { basis: 'accumulator', pair, fxAvgWad: q.avgWad, reason: null };
    return { basis: 'attestor', pair, fxAvgWad: null, reason: q?.fallbackReason ?? 'coverage' };
  }

  /** Verify the attestation signature against the keys the chain has registered. */
  private async verifyAttestation(seriesId: string, a: z.infer<typeof verifierAttestationSchema>): Promise<void> {
    const keys = await this.ctx.chainFor(seriesId).listVerifierKeys();
    const key = keys.find((k) => k.keyId === a.keyId);
    if (!key) throw AppError.unprocessable(`verifier key ${a.keyId} is not registered onchain`);
    const msg = attestationMessage({ seriesId: a.seriesId, periodId: a.periodId, incomeCommitment: a.incomeCommitment, tier: a.tier, source: a.source });
    let ok = false;
    try {
      ok = edVerify(null, Buffer.from(msg), createPublicKey({ key: Buffer.from(key.publicKey, 'hex'), format: 'der', type: 'spki' }), Buffer.from(a.signature.replace(/^0x/, ''), 'hex'));
    } catch {
      ok = false;
    }
    if (!ok) throw AppError.unprocessable('attestation signature does not verify');
  }

  /** Assemble: checks everything the chain will check, offchain, so the issuer never pays for a failing transaction. */
  async assemble(seriesId: string, session: Session, input: z.infer<typeof assembleSchema>): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    const now = await chain.now();
    const period = parsePeriod(input.periodId);
    if (period.end > now) throw AppError.conflict('the period has not ended');
    if (input.tier === 4 && !(await getFlag(this.ctx.pool, 'tier4'))) throw AppError.forbidden('tier 4 self-attestation is switched off');
    const tierOk = (input.tier === 1 && series.terms.tierFlags.tier1) || (input.tier === 2 && series.terms.tierFlags.tier2) || (input.tier === 3 && series.terms.tierFlags.tier3) || (input.tier === 4 && series.terms.tierFlags.tier4);
    if (!tierOk) throw AppError.unprocessable(`tier ${input.tier} is not enabled for this series`);
    const existing = await this.ctx.pool.query("select report_id, state from reports where series_id = $1 and period_id = $2 and state in ('accepted','paid')", [seriesId, input.periodId]);
    if (existing.rows[0]) throw AppError.conflict(`period already reported (${existing.rows[0].state})`);
    const fx = await this.resolveFx(seriesId, input.periodId);
    let fxAvgWad: string;
    if (fx.basis === 'attestor') {
      if (!input.attestorRate) throw AppError.unprocessable(`FX fallback is in force for ${fx.pair} ${input.periodId} (${fx.reason}); an attestor-signed rate is required`, { fx });
      fxAvgWad = input.attestorRate.rateWad;
    } else fxAvgWad = fx.fxAvgWad!;
    const units = series.redemption ? series.redemption.unitsAtRedemption : series.unitsOutstanding;
    const expectedInputs = reportPublicInputs({ termsCommitment: series.terms.termsCommitment, incomeCommitment: input.incomeCommitment, unitsOutstanding: units, paymentStable: input.paymentStable, fxAvgWad, periodId: input.periodId });
    if (expectedInputs.join(',') !== input.proof.publicInputs.join(',')) throw AppError.unprocessable('public inputs do not match the series terms, units, payment or FX basis', { expected: expectedInputs });
    if (input.proof.system !== this.ctx.proofVerifier.system) throw AppError.unprocessable(`proof system ${input.proof.system} is not accepted (verifier runs ${this.ctx.proofVerifier.system})`);
    if (!(await this.ctx.proofVerifier.verify(input.proof.proof, input.proof.publicInputs))) throw AppError.unprocessable('proof does not verify');
    if (input.tier === 2) {
      if (!input.attestation) throw AppError.unprocessable('tier 2 needs a report-verifier attestation');
      if (input.attestation.seriesId !== seriesId || input.attestation.periodId !== input.periodId || input.attestation.incomeCommitment !== input.incomeCommitment) throw AppError.unprocessable('attestation does not match the report');
      await this.verifyAttestation(seriesId, input.attestation);
    }
    if (input.tier === 3 && !input.attestor) throw AppError.unprocessable('tier 3 needs the attestor who will co-sign');
    const reportId = this.ctx.newId('rep');
    await this.ctx.pool.query("update reports set state = 'superseded', updated_at = now() where series_id = $1 and period_id = $2 and state in ('assembled','rejected')", [seriesId, input.periodId]);
    if (input.tier === 3) {
      const registered = await chain.listAttestors();
      if (!registered.includes(input.attestor!)) throw AppError.unprocessable('tier 3 attestor is not registered onchain');
    }
    await this.ctx.pool.query(
      'insert into reports (report_id, series_id, period_id, account_id, tier, source, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, pair, proof, attestation, attestor_rate, liquidity_event, verified_offchain, attestor) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17)',
      [reportId, seriesId, input.periodId, session.accountId, input.tier, input.source, input.paymentStable, input.incomeCommitment, series.terms.termsCommitment, fx.basis, fxAvgWad, fx.pair, JSON.stringify(input.proof), input.attestation ? JSON.stringify(input.attestation) : null, input.attestorRate ? JSON.stringify(input.attestorRate) : null, input.liquidityEvent, input.tier === 3 ? input.attestor : null],
    );
    return { ...(await this.getReport(reportId)), tx: (await this.buildSubmit(reportId, session)).tx };
  }

  async getReport(reportId: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    return { reportId: x.report_id, seriesId: x.series_id, periodId: x.period_id, tier: x.tier, source: x.source, state: x.state, attestor: x.attestor ?? null, paymentStable: x.payment_stable, incomeCommitment: x.income_commitment, termsCommitment: x.terms_commitment, fxBasis: x.fx_basis, fxAvgWad: x.fx_avg_wad, pair: x.pair, liquidityEvent: x.liquidity_event, verifiedOffchain: x.verified_offchain, submitTx: x.submit_tx, payinTx: x.payin_tx, createdAt: x.created_at };
  }

  async listReports(seriesId: string): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select report_id from reports where series_id = $1 order by period_id, created_at', [seriesId]);
    return Promise.all(r.rows.map((x) => this.getReport(x.report_id)));
  }

  async buildSubmit(reportId: string, session: Session): Promise<{ tx: UnsignedTx }> {
    const r = await this.ctx.pool.query('select * from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain, series } = await this.seriesForIssuer(x.series_id, session);
    const cmd: Extract<UserCommand, { kind: 'submitReport' }> = {
      kind: 'submitReport', seriesId: x.series_id, periodId: x.period_id, tier: x.tier, source: x.source, paymentStable: x.payment_stable, incomeCommitment: x.income_commitment, termsCommitment: x.terms_commitment,
      fxBasis: x.fx_basis, fxAvgWad: x.fx_avg_wad, pair: x.pair, attestorRate: x.attestor_rate ? { attestor: x.attestor_rate.attestor, rateWad: x.attestor_rate.rateWad, pair: x.pair } : null, proof: x.proof, attestation: x.attestation,
      attestor: x.tier === 3 ? (x.attestor ?? null) : null, liquidityEvent: x.liquidity_event,
    };
    const coSigners = [cmd.attestorRate?.attestor, cmd.attestor].filter((a): a is string => !!a);
    const tx = await chain.build(cmd, series.issuer, [...new Set(coSigners)]);
    return { tx };
  }

  /** After submitReport landed: record the tx and build payIn for the exact remaining amount the chain reports. */
  async markSubmitted(reportId: string, session: Session, txId: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select series_id, period_id from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain } = await this.seriesForIssuer(x.series_id, session);
    const p = await chain.getPeriod(x.series_id, x.period_id);
    const state = p?.reportAccepted ? (p.settled ? 'paid' : 'accepted') : 'submitted';
    await this.ctx.pool.query('update reports set state = $2, submit_tx = $3, updated_at = now() where report_id = $1', [reportId, state, txId]);
    return this.getReport(reportId);
  }

  async buildPayIn(reportId: string, session: Session): Promise<{ tx: UnsignedTx; amount: string; accrual: string }> {
    const r = await this.ctx.pool.query('select series_id, period_id from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain, series } = await this.seriesForIssuer(x.series_id, session);
    const p = await chain.getPeriod(x.series_id, x.period_id);
    if (!p || !p.reportAccepted) throw AppError.conflict('the chain has not accepted a report for this period yet');
    if (p.settled) throw AppError.conflict('period already paid');
    const amount = (BigInt(p.paymentDue) - BigInt(p.paid)).toString();
    const tx = await chain.build({ kind: 'payIn', seriesId: x.series_id, periodId: x.period_id, amount }, series.issuer);
    return { tx, amount, accrual: p.accrual };
  }

  async markPaid(reportId: string, session: Session, txId: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select series_id, period_id, account_id from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain } = await this.seriesForIssuer(x.series_id, session);
    const p = await chain.getPeriod(x.series_id, x.period_id);
    if (p?.settled) {
      await this.ctx.pool.query("update reports set state = 'paid', payin_tx = $2, updated_at = now() where report_id = $1", [reportId, txId]);
      await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'payout.available', seriesId: x.series_id, periodId: x.period_id });
    }
    return this.getReport(reportId);
  }

  /** Tier 1: receipts the router already posted for a period, so the report's remaining payment can be shown. */
  async splits(seriesId: string, session: Session, periodId: string): Promise<Record<string, unknown>> {
    const { chain } = await this.seriesForIssuer(seriesId, session);
    const p = await chain.getPeriod(seriesId, periodId);
    const rows = await this.ctx.pool.query("select seq, amount, wallet, block_time, tx_id from money_events where series_id = $1 and period_id = $2 and kind = 'split' order by seq", [seriesId, periodId]);
    return { seriesId, periodId, splitReceived: p?.splitReceived ?? '0', receipts: rows.rows.map((r) => ({ seq: Number(r.seq), amount: r.amount, router: r.wallet, at: Number(r.block_time), txId: r.tx_id })) };
  }

  /** Deadlines for the keeper's reminders (E7/E12): returns upcoming milestones for every unsettled period of a series. */
  async deadlines(seriesId: string): Promise<{ periodId: string; dueAt: number; graceEndsAt: number; formalNoticeAt: number; standing: string }[]> {
    const chain = this.ctx.chainFor(seriesId);
    const periods = await chain.listPeriods(seriesId);
    const now = await chain.now();
    return periods.filter((p) => !p.settled).map((p) => ({ periodId: p.periodId, dueAt: p.dueAt, graceEndsAt: p.graceEndsAt, formalNoticeAt: p.formalNoticeAt, standing: periodStanding({ dueAt: p.dueAt, graceEndsAt: p.graceEndsAt, formalNoticeAt: p.formalNoticeAt }, now, false) }));
  }
}

function parsePeriodSafe(ts: number) {
  try {
    return periodsBetween(ts, ts + 1)[0] ?? null;
  } catch {
    return null;
  }
}

function nextStep(p: { reportAccepted: boolean; settled: boolean; standing: string }, reportState: string | undefined): string {
  if (p.settled) return 'done';
  if (p.reportAccepted) return 'pay-in';
  if (reportState === 'assembled') return 'submit-report';
  if (p.standing === 'Deferred') return 'paused';
  return 'assemble-report';
}
