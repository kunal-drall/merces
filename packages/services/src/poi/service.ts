import { z } from 'zod';
import { AppError, enqueueOutbox, getFlag } from '@merces/core';
import { attestationSchema, expectedPrior, fieldToHex32, fxDigest, keyUsable, recoverSigner, reportDigest, reportPublicInputs, reportProofSchema, routerIncomeCommitment, type Attestation, type ChainPort, type SeriesState, type SignerKind, type UnsignedTx, type UserCommand } from '@merces/domain';
import { WAD, fromPid, parsePeriod, periodsBetween, projectDeadlines, statusParamsOf, toPid, yearOf } from '@merces/math';
import { SyntheticIncomeZkTls, SYNTHETIC_INCOME_NOTICE, assertSyntheticIncomeNetwork, SOURCE_DEFINITIONS, type IncomeSourceKind } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { censusFreshFor, curveRegularReport, reportUnits, requireCensusFor, requireCensusUnchanged } from '../curve-census.ts';

/**
 * E5 — ProofOfIncome service (tier 2 quarterly flow; tier 1 reconciliation; tier 3 arrives through E10).
 * The device does the private work (zkTLS session, commitment, proof, attestation from the verifier). This
 * service sees only what goes onchain: commitments, the payment, the proof and the signatures. It resolves
 * the FX basis, verifies the proof and every signature offchain, stores the report, and builds the
 * submitReport / payIn transactions for the issuer to sign. It tracks deadlines (C8).
 *
 * The signatures a report carries are Stage 1's (S4 WP6, WP9): tier 2 the report verifier key's REPORT signature (sent
 * by the device), tier 3 the attestor key's REPORT signature with tier 3 (stored with the signed tier-3 case, E10), the
 * FX fallback an attestor key's FX signature for this series (stored per series with the FX request, E10). The service
 * carries the stored ones itself and checks each against the chain's own reads; nobody co-signs the report.
 */

export const assembleSchema = z.object({
  /** optional: the device's assembled report names its series; it must be the series in the path */
  seriesId: z.string().optional(),
  periodId: z.string().regex(/^\d{4}Q[1-4]$/),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  source: z.string().min(1),
  paymentStable: z.string().regex(/^\d+$/),
  /** the income commitment this report chains from (Stage 1 prior chain; ZERO at a year start) */
  priorIncomeCommitment: z.string().regex(/^0x[0-9a-f]{64}$/),
  incomeCommitment: z.string().regex(/^0x[0-9a-f]{64}$/),
  proof: reportProofSchema,
  /**
   * Tier 2: the report verifier key's Stage 1 REPORT signature (`{signer, signature}`; S4 WP6), as the device received it
   * from the verifier (the `signer` and `signature` of its record). Tier 3: optional; the service carries the attestor's
   * signature stored with the signed case (S4 WP9), and one sent must be that one. The service recomputes the digest
   * itself from the chain's signing domain and the series key; null for tiers 1 and 4.
   */
  attestation: attestationSchema.nullable().default(null),
  liquidityEvent: z.boolean().default(false),
  // strict: a stray field (a witness, a year-to-date figure, a salt) is refused, never silently dropped or stored
}).strict();

export class ProofOfIncomeService {
  constructor(private readonly ctx: ServiceContext) {}

  private async seriesForIssuer(seriesId: string, session: Session) {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === s.issuer) && !session.roles.includes('admin')) throw AppError.forbidden('not the issuer of this series');
    return { chain, series: s };
  }

  /**
   * The issuer's reporting schedule: every reportable quarter with deadlines, standing and what is still needed. The
   * deadlines and standings are the chain's (Stage 1's countdown in unpaused time from the period end: OnTime while
   * ≤ 30 days, InGrace while ≤ 45 days, formal notice at 90 days); the quarter still running gets its projected due
   * instant from `projectDeadlines` (a pause running now is counted; one approved later moves it).
   */
  async schedule(seriesId: string, session: Session): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    const now = await chain.now();
    const live = await chain.listPeriods(seriesId);
    const reports = await this.ctx.pool.query('select period_id, report_id, state, tier, source from reports where series_id = $1 and state <> $2 order by created_at', [seriesId, 'superseded']);
    const byPeriod = new Map(reports.rows.map((r) => [r.period_id, r]));
    const current = parsePeriodSafe(now);
    // every pause recorded so far ended before `now` < the period's end except the one running now, so it is the only
    // one that can count against the running quarter's countdown
    const running = series.pauses.current ? [{ start: BigInt(series.pauses.current.start), end: BigInt(series.pauses.current.end) }] : [];
    const upcoming = series.settledAt !== null && current && current.end > now
      ? { periodId: current.id, endsAt: current.end, dueAt: Number(projectDeadlines(toPid(current.id), running, BigInt(now), statusParamsOf(series.terms)).dueAt) }
      : null;
    return {
      seriesId, status: series.status, now, reportingCurrency: series.terms.reportingCurrency, fxBasis: !series.terms.fxPairId && series.terms.reportingCurrency === 'USD' ? 'unity' : 'accumulator', tierFlags: series.terms.tierFlags,
      periods: live.map((p) => {
        const step = nextStep(p, byPeriod.get(p.periodId)?.state);
        // a curve series' next report waits for a census taken after its period ended (S3 WP9)
        const census = step === 'assemble-report' && p.periodId === series.reporting.nextExpectedPeriod && !censusFreshFor(series, p.periodId);
        return { ...p, report: byPeriod.get(p.periodId) ? { reportId: byPeriod.get(p.periodId)!.report_id, state: byPeriod.get(p.periodId)!.state } : null, nextStep: census ? 'sync-curve-units' : step };
      }),
      upcoming,
    };
  }

  /** Start a zkTLS session for a source. The device completes it with the provider; the proof goes straight to the report verifier. */
  async createZkTlsSession(seriesId: string, session: Session, periodId: string, source: IncomeSourceKind): Promise<Record<string, unknown>> {
    const { series } = await this.seriesForIssuer(seriesId, session);
    if (!series.terms.tierFlags.tier2) throw AppError.conflict('tier 2 is not enabled for this series');
    const period = parsePeriod(periodId);
    if (this.ctx.zktls instanceof SyntheticIncomeZkTls) {
      const info = await this.ctx.chainFor(seriesId).info();
      if (!info.signing) throw AppError.forbidden('Synthetic income requires a verified testnet domain.');
      assertSyntheticIncomeNetwork(info.signing);
    }
    const def = SOURCE_DEFINITIONS[source];
    const r = await this.ctx.zktls.createSession({ source, seriesId, periodId, coversUntil: period.end, year: period.year });
    await this.ctx.pool.query('insert into zktls_sessions (session_id, series_id, period_id, account_id, source, provider, request_url) values ($1,$2,$3,$4,$5,$6,$7) on conflict (session_id) do nothing', [r.sessionId, seriesId, periodId, session.accountId, source, this.ctx.zktls.provider, r.requestUrl]);
    return { ...r, ...(this.ctx.zktls instanceof SyntheticIncomeZkTls ? {testOnly:true,notice:SYNTHETIC_INCOME_NOTICE} : {}), provider: this.ctx.zktls.provider, source: def.name, verifier: { url: this.ctx.reportVerifierUrl, note: 'Send the zkTLS proof and your income salt directly to the report verifier; the API never receives income.' } };
  }

  /**
   * The report verifier a device talks to (S4 WP6): its URL, the 20-byte address of its secp256k1 key (the address the
   * chains register as a verifier key) and the chains it signs for, each with the signing domain it holds. Public data.
   */
  async verifierInfo(): Promise<Record<string, unknown>> {
    const keys = await this.ctx.verifier.publicKey();
    return { url: this.ctx.reportVerifierUrl, address: keys.address, ...(keys.syntheticIncome ? {syntheticIncome:keys.syntheticIncome} : {}), chains: keys.chains.map((c) => ({ chain: c.chain, domain: c.domain })) };
  }

  /** Resolve the FX basis for a series/period (C9): unity, the accumulator average, or an attestor rate when flagged. */
  async resolveFx(seriesId: string, periodId: string): Promise<{ basis: 'unity' | 'accumulator' | 'attestor'; pair: string | null; fxAvgWad: string | null; reason: string | null }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (!s.terms.fxPairId && s.terms.reportingCurrency === 'USD') return { basis: 'unity', pair: null, fxAvgWad: WAD.toString(), reason: null };
    const pair = s.terms.fxPairId ?? `${s.terms.reportingCurrency}/USD`;
    const q = await chain.getQuarterRate(pair, periodId);
    if (q && q.avgWad && !q.needsFallback) return { basis: 'accumulator', pair, fxAvgWad: q.avgWad, reason: null };
    return { basis: 'attestor', pair, fxAvgWad: null, reason: q?.fallbackReason ?? 'coverage' };
  }

  /**
   * Tiers 2 and 3 (S4 WP6, WP9): the chain will accept the attestation only if Stage 1's REPORT message over its signing
   * domain and the series key, with the report's tier, recovers to the named signer and that signer is a key of the tier's
   * kind (the report verifier's for tier 2, an attestor's for tier 3) usable for the period (active, or revoked after the
   * period ended and within the 45-day grace). The FX fallback likewise: Stage 1's FX message over the series key, the
   * period and the report's rate, by an attestor key usable with the same grace (both chains; DIV-S1I-3). The service
   * checks exactly that, from the chain's own reads (`ChainInfo.signing`, `SeriesState.seriesKey`, `getSignerKey`), so the
   * issuer never pays for a failing transaction: 409 `signing-domain-unknown` when the chain has no signing domain yet (a
   * live adapter before S5), 422 with Stage 1's error name otherwise. It never signs anything.
   */
  private async verifySigned(chain: ChainPort, kind: SignerKind, digestOf: (ctx: { domain: string; seriesKey: string }) => string, series: SeriesState, periodId: string, a: Attestation, what: { name: string; message: string }): Promise<void> {
    const signing = (await chain.info()).signing;
    if (!signing) throw new AppError(409, 'Conflict', `the chain has no signing domain yet: the ${what.name} cannot be checked here`, { reason: 'signing-domain-unknown' });
    const stage1 = kind === 'verifier' ? 'InvalidVerifierSignature' : 'InvalidAttestorSignature';
    const digest = digestOf({ domain: signing.domain, seriesKey: series.seriesKey });
    const who = recoverSigner(digest, a.signature);
    if (who === null || who !== a.signer) throw AppError.unprocessable(`the ${what.name} is not ${what.message} on this chain`, { stage1 });
    const key = await chain.getSignerKey(kind, who);
    if (!key || !keyUsable(key, await chain.now(), { reportPeriod: periodId })) throw AppError.unprocessable(`the ${what.name}'s key is not ${kind === 'verifier' ? 'a verifier' : 'an attestor'} key usable on this chain for this quarter (not registered, or revoked before the quarter ended or more than 45 days ago)`, { stage1 });
  }

  private async verifyAttestation(chain: ChainPort, series: SeriesState, report: { periodId: string; priorIncomeCommitment: string; incomeCommitment: string; liquidityEvent: boolean; tier: 2 | 3 }, a: Attestation): Promise<void> {
    const what = report.tier === 2 ? { name: 'attestation', message: 'the report verifier\'s signature over this report' } : { name: 'tier-3 attestation', message: 'the attestor\'s signature over this report' };
    await this.verifySigned(chain, report.tier === 2 ? 'verifier' : 'attestor', (ctx) => reportDigest(ctx, report).digest, series, report.periodId, a, what);
  }

  /**
   * The FX fallback for this series and period (S4 WP9, D14): the attestor key's Stage 1 FX signature stored for this
   * series with the period's signed request, and the rate it signed. Null when none is stored yet.
   */
  private async storedFxFallback(chain: ChainPort, seriesId: string, pair: string, periodId: string): Promise<{ fxFallback: Attestation; rateWad: string } | null> {
    const r = await this.ctx.pool.query(
      "select s.signer, s.signature, s.rate_wad from fx_fallback_signatures s join fx_fallback_requests f on f.request_id = s.request_id where f.chain = $1 and f.pair = $2 and f.period_id = $3 and f.state = 'signed' and s.series_id = $4",
      [chain.chain, pair, periodId, seriesId],
    );
    const x = r.rows[0];
    return x ? { fxFallback: { signer: x.signer, signature: x.signature }, rateWad: String(x.rate_wad) } : null;
  }

  /**
   * The prior income commitment the chain will require for a period's report (SPEC §6.2 step 5), from the series'
   * public reporting ledger: the last accepted report's income commitment when it was the previous quarter of the same
   * year (`chained`), ZERO at a year start (`year-start`), or, on the series' first report outside Q1 (A25,
   * `first-report-outside-q1`), whatever the report supplies; the verifier attestation then binds it. Public data.
   */
  async reportingPrior(seriesId: string, periodId?: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const rep = s.reporting;
    const target = periodId ?? rep.nextExpectedPeriod;
    if (!target) throw AppError.conflict('the raise has not settled: no period is reportable yet');
    const pid = toPid(target);
    const pidOrNull = (p: string | null) => (p === null ? null : toPid(p));
    const ledger = { lastAcceptedPeriod: pidOrNull(rep.lastAcceptedPeriod), lastIncomePeriod: pidOrNull(rep.lastIncomePeriod), lastIncomeCommitment: rep.lastIncomeCommitment };
    const SUPPLIED = 'supplied';
    const prior = expectedPrior(ledger, pid, SUPPLIED);
    const rule = prior === SUPPLIED ? 'first-report-outside-q1' : ledger.lastIncomePeriod === pid - 1 && yearOf(pid - 1) === yearOf(pid) ? 'chained' : 'year-start';
    return {
      seriesId, periodId: target, nextExpectedPeriod: rep.nextExpectedPeriod, rule,
      expectedPriorIncomeCommitment: prior === SUPPLIED ? null : prior,
      acceptsSuppliedPrior: prior === SUPPLIED,
      chainedFrom: rule === 'chained' ? fromPid(pid - 1) : null,
      note: prior === SUPPLIED
        ? `The series' first report outside Q1: the chain accepts the prior as given. Supply the commitment of the year-to-date income at the start of ${target}; the report verifier signs it only with its own attestation of ${fromPid(pid - 1)} for that commitment.`
        : 'Prove the report against this prior.',
    };
  }

  /**
   * Assemble: checks everything the chain will check, offchain, so the issuer never pays for a failing transaction. On a
   * curve series that includes the census (S3 WP9): a regular report needs one taken after its period ended (409
   * CurveUnitsNotSynced with the sync step) and proves over it (409 `census-changed` otherwise).
   */
  async assemble(seriesId: string, session: Session, input: z.infer<typeof assembleSchema>): Promise<Record<string, unknown>> {
    if (input.seriesId !== undefined && input.seriesId !== seriesId) throw AppError.unprocessable('the report is for another series');
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    const now = await chain.now();
    const period = parsePeriod(input.periodId);
    if (period.end > now) throw AppError.conflict('the period has not ended');
    if (input.tier === 4 && !(await getFlag(this.ctx.pool, 'tier4'))) throw AppError.forbidden('tier 4 self-attestation is switched off');
    const tierOk = (input.tier === 1 && series.terms.tierFlags.tier1) || (input.tier === 2 && series.terms.tierFlags.tier2) || (input.tier === 3 && series.terms.tierFlags.tier3) || (input.tier === 4 && series.terms.tierFlags.tier4);
    if (!tierOk) throw AppError.unprocessable(`tier ${input.tier} is not enabled for this series`);
    const existing = await this.ctx.pool.query("select report_id, state from reports where series_id = $1 and period_id = $2 and state in ('accepted','paid')", [seriesId, input.periodId]);
    if (existing.rows[0]) throw AppError.conflict(`period already reported (${existing.rows[0].state})`);
    // Stage 1's ledger rules (SIM:1062-1072): reports are sequential, and the previous due must be paid first
    const rep = series.reporting;
    if (rep.nextExpectedPeriod === null) throw AppError.conflict('the raise has not settled');
    if (rep.nextExpectedPeriod !== input.periodId) throw new AppError(409, 'Conflict', `reports are sequential: the next report is for ${rep.nextExpectedPeriod}`, { stage1: 'WrongPeriod', nextExpectedPeriod: rep.nextExpectedPeriod });
    if (BigInt(rep.openDueAmount) > 0n) throw new AppError(409, 'Conflict', `the report for ${rep.openDuePeriod} is not paid yet`, { stage1: 'PaymentOutstanding', openDuePeriod: rep.openDuePeriod });
    // a curve series' regular report proves over a census taken after its period ended (Stage 1 CurveUnitsNotSynced;
    // S3 WP9, amendment H1): 409 with the sync step, and 409 `census-changed` for a proof over another count
    requireCensusFor(series, input.periodId);
    if (curveRegularReport(series)) requireCensusUnchanged(series, input.proof.publicInputs[1], 're-prove');
    const fx = await this.resolveFx(seriesId, input.periodId);
    let fxAvgWad: string;
    let fxFallback: Attestation | null = null;
    if (fx.basis === 'attestor') {
      // the attestor's FX signature for this series, stored with the period's request (E10, S4 WP9); its rate is the report's
      const stored = await this.storedFxFallback(chain, seriesId, fx.pair!, input.periodId);
      if (!stored) throw AppError.unprocessable(`FX fallback is in force for ${fx.pair} ${input.periodId} (${fx.reason}); an attestor's FX signature for this series is required (GET /series/${seriesId}/reporting/fx-fallback/${input.periodId})`, { fx });
      fxAvgWad = stored.rateWad;
      fxFallback = stored.fxFallback;
    } else fxAvgWad = fx.fxAvgWad!;
    const units = reportUnits(series);
    // the prior the chain will require (SPEC §6.2 step 5), from the series' reporting ledger
    const pidOrNull = (p: string | null) => (p === null ? null : toPid(p));
    const prior = expectedPrior({ lastAcceptedPeriod: pidOrNull(rep.lastAcceptedPeriod), lastIncomePeriod: pidOrNull(rep.lastIncomePeriod), lastIncomeCommitment: rep.lastIncomeCommitment }, toPid(input.periodId), input.priorIncomeCommitment);
    if (prior !== input.priorIncomeCommitment) throw AppError.unprocessable('the prior income commitment does not chain from the last accepted report', { expectedPrior: prior });
    if (input.tier === 1) {
      if (series.terms.tierFlags.tier2 || series.terms.tierFlags.tier3 || series.terms.tierFlags.tier4) throw AppError.unprocessable('tier 1 requires a pure tier-1 series',{stage1:'TierNotEnabled'});
      const router = await chain.getRouter(seriesId);
      const checkpoint = (periodId: string) => toPid(periodId) < toPid(rep.firstPeriod!) ? '0' : router?.checkpoints.find((c)=>c.periodId === periodId)?.ytdAtEnd;
      const ytd = checkpoint(input.periodId), before = toPid(input.periodId) % 4 === 0 ? '0' : checkpoint(fromPid(toPid(input.periodId)-1));
      if (ytd === undefined || before === undefined) throw AppError.conflict('close the router period before reporting',{stage1:'RouterPeriodNotClosed'});
      if (input.incomeCommitment !== routerIncomeCommitment(ytd) || prior !== routerIncomeCommitment(before)) throw AppError.unprocessable('report does not bind to router checkpoints',{stage1:'InvalidProof'});
    }
    let expectedInputs: string[];
    try {
      expectedInputs = reportPublicInputs({ termsCommitment: series.terms.termsCommitment, unitsOutstanding: units, fxAvgWad, priorIncomeCommitment: prior, incomeCommitment: input.incomeCommitment, paymentStable: input.paymentStable });
    } catch {
      throw AppError.unprocessable('the report does not fit the circuit: the series terms commitment is not a Poseidon commitment, or an amount is out of range');
    }
    if (expectedInputs.join(',') !== input.proof.publicInputs.join(',')) throw AppError.unprocessable('public inputs do not match the series terms, units, prior, payment or FX basis', { expected: expectedInputs });
    // Stage 1's Groth16 verifier (mock proofs only in a simulator-only process configured for them, H3)
    if (!this.ctx.proofVerifier.systems.includes(input.proof.system)) throw AppError.unprocessable(`proof system ${input.proof.system} is not accepted (this service verifies ${this.ctx.proofVerifier.systems.join(', ')})`);
    if (!(await this.ctx.proofVerifier.verify(input.proof.proof, input.proof.publicInputs))) throw AppError.unprocessable('proof does not verify');
    const fields = { periodId: input.periodId, priorIncomeCommitment: prior, incomeCommitment: input.incomeCommitment, liquidityEvent: input.liquidityEvent };
    let attestation: Attestation | null = null;
    if (input.tier === 2) {
      if (!input.attestation) throw AppError.unprocessable('tier 2 needs a report-verifier attestation');
      await this.verifyAttestation(chain, series, { ...fields, tier: 2 }, input.attestation);
      attestation = input.attestation;
    } else if (input.tier === 3) {
      // the attestor signed this quarter's case over the same commitments and liquidity flag on their own device (E10, M7):
      // Stage 1's REPORT signature with tier 3, stored with the case (S4 WP9); the report carries it
      const signed = await this.ctx.pool.query("select attestation from tier3_cases where series_id = $1 and period_id = $2 and state = 'signed' and income_commitment = $3 and prior_income_commitment = $4 and liquidity_event = $5 order by signed_at desc limit 1", [seriesId, input.periodId, input.incomeCommitment, prior, input.liquidityEvent]);
      const stored = pickAttestation(signed.rows[0]?.attestation);
      if (!stored) throw AppError.unprocessable('tier 3 needs the chosen attestor\'s signed case for this quarter over the same commitments and liquidity flag');
      if (input.attestation && (input.attestation.signer !== stored.signer || input.attestation.signature !== stored.signature)) throw AppError.unprocessable('the attestation is not the one the case\'s attestor signed');
      // the chain's registry decides (S4 D5): an active key, or one revoked after this period ended and still within
      // Stage 1's grace, may attest the quarter (forward-only revocation, SPEC §1.4)
      await this.verifyAttestation(chain, series, { ...fields, tier: 3 }, stored);
      attestation = stored;
    }
    // tiers 1 and 4 carry no attestation (both chains ignore one): nothing is stored for them
    if (fxFallback) await this.verifySigned(chain, 'attestor', (ctx) => fxDigest(ctx, { periodId: input.periodId, fxRateWad: fxAvgWad }).digest, series, input.periodId, fxFallback, { name: 'FX fallback', message: 'its attestor\'s signature over this series\' FX message for the period and rate' });
    const reportId = this.ctx.newId('rep');
    await this.ctx.pool.query("update reports set state = 'superseded', updated_at = now() where series_id = $1 and period_id = $2 and state in ('assembled','rejected')", [seriesId, input.periodId]);
    await this.ctx.pool.query(
      'insert into reports (report_id, series_id, period_id, account_id, tier, source, payment_stable, prior_income_commitment, income_commitment, terms_commitment, fx_basis, fx_avg_wad, pair, proof, attestation, fx_fallback, liquidity_event, verified_offchain) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)',
      [reportId, seriesId, input.periodId, session.accountId, input.tier, input.source, input.paymentStable, prior, input.incomeCommitment, series.terms.termsCommitment, fx.basis, fxAvgWad, fx.pair, JSON.stringify(input.proof), attestation ? JSON.stringify({ signer: attestation.signer, signature: attestation.signature }) : null, fxFallback ? JSON.stringify(fxFallback) : null, input.liquidityEvent],
    );
    return { ...(await this.getReport(reportId)), tx: (await this.buildSubmit(reportId, session)).tx };
  }

  /** `source` (which income provider) is shown to the issuer and admins only — never to holders (R20, B7). */
  async getReport(reportId: string, opts: { showSource?: boolean } = { showSource: true }): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    return { reportId: x.report_id, seriesId: x.series_id, periodId: x.period_id, tier: x.tier, source: opts.showSource ? x.source : undefined, state: x.state, attestor: x.tier === 3 ? (pickAttestation(x.attestation)?.signer ?? null) : null, fxFallbackSigner: pickAttestation(x.fx_fallback)?.signer ?? null, paymentStable: x.payment_stable, priorIncomeCommitment: x.prior_income_commitment ?? null, incomeCommitment: x.income_commitment, termsCommitment: x.terms_commitment, fxBasis: x.fx_basis, fxAvgWad: x.fx_avg_wad, pair: x.pair, liquidityEvent: x.liquidity_event, verifiedOffchain: x.verified_offchain, submitTx: x.submit_tx, payinTx: x.payin_tx, createdAt: x.created_at };
  }

  async listReports(seriesId: string, session: Session): Promise<Record<string, unknown>[]> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    const isIssuer = !!s && (session.wallets.some((w) => w.chain === chain.chain && w.address === s.issuer) || session.roles.includes('admin'));
    const r = await this.ctx.pool.query('select report_id from reports where series_id = $1 order by period_id, created_at', [seriesId]);
    return Promise.all(r.rows.map((x) => this.getReport(x.report_id, { showSource: isIssuer })));
  }

  /**
   * The unsigned `submitReport` of a stored report. On a curve series the chain binds the census when it accepts the
   * report, so a census older than the period's end is 409 CurveUnitsNotSynced (sync first) and a census that changed
   * since the report was assembled is 409 `census-changed` (prove again and re-assemble): the transaction would fail.
   */
  async buildSubmit(reportId: string, session: Session): Promise<{ tx: UnsignedTx }> {
    const r = await this.ctx.pool.query('select * from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain, series } = await this.seriesForIssuer(x.series_id, session);
    // a curve report's proof binds the census when the chain accepts it (Stage 1 income.rs:376-381): refused while the
    // census predates the period's end, and when it changed since the report was assembled (S3 WP9, amendment H1)
    if (series.terms.raiseStyle === 'curve') {
      requireCensusFor(series, x.period_id);
      requireCensusUnchanged(series, (x.proof as { publicInputs?: string[] }).publicInputs?.[1], 're-assemble');
    }
    // the prior has its own column; reports stored before it carry it as public input 3 of the proof
    const priorIncomeCommitment: string = x.prior_income_commitment ?? fieldToHex32(BigInt((x.proof as { publicInputs: string[] }).publicInputs[3]!));
    // the stored signatures go into the command as Stage 1 takes them (S4 WP6, WP9): nobody co-signs, the issuer sends it
    const cmd: Extract<UserCommand, { kind: 'submitReport' }> = {
      kind: 'submitReport', seriesId: x.series_id, periodId: x.period_id, tier: x.tier, paymentStable: x.payment_stable, priorIncomeCommitment, incomeCommitment: x.income_commitment,
      fxBasis: x.fx_basis, fxAvgWad: x.fx_avg_wad, pair: x.pair, fxFallback: x.fx_basis === 'attestor' ? storedAttestation(x.fx_fallback) : null, proof: x.proof,
      attestation: x.tier === 2 || x.tier === 3 ? storedAttestation(x.attestation) : null, liquidityEvent: x.liquidity_event,
    };
    const tx = await chain.build(cmd, series.issuer);
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

  /**
   * payIn for the series' open due (Stage 1 `pay`: one open due at a time, `openDuePeriod`), for the live amount the
   * chain will demand now: the open due plus Stage 1's lateness accrual to `now` on a regular period, the due as
   * reported on a tail period (the chain's period read). Accrual grows by whole late days, so a transaction built just
   * before a day boundary and sent after it is refused; build it again.
   */
  async buildPayIn(reportId: string, session: Session): Promise<{ tx: UnsignedTx; periodId: string; amount: string; accrual: string }> {
    const r = await this.ctx.pool.query('select series_id, period_id from reports where report_id = $1', [reportId]);
    const x = r.rows[0];
    if (!x) throw AppError.notFound('report');
    const { chain, series } = await this.seriesForIssuer(x.series_id, session);
    const p = await chain.getPeriod(x.series_id, x.period_id);
    if (!p || !p.reportAccepted) throw AppError.conflict('the chain has not accepted a report for this period yet');
    if (p.settled) throw AppError.conflict('period already paid');
    const rep = series.reporting;
    if (BigInt(rep.openDueAmount) === 0n || rep.openDuePeriod === null) throw new AppError(409, 'Conflict', 'nothing is due', { stage1: 'NothingDue' });
    // reports are sequential and each needs the previous due paid, so an unpaid accepted report is the open due
    if (rep.openDuePeriod !== x.period_id) throw new AppError(409, 'Conflict', `the open due is for ${rep.openDuePeriod}`, { openDuePeriod: rep.openDuePeriod });
    const amount = p.paymentDue;
    const tx = await chain.build({ kind: 'payIn', seriesId: x.series_id, periodId: rep.openDuePeriod, amount }, series.issuer);
    return { tx, periodId: rep.openDuePeriod, amount, accrual: p.accrual };
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

  /**
   * Deadlines for the keeper's reminders (E7/E12): the milestones of every unsettled period, as the chain reads them:
   * `dueAt` / `graceEndsAt` are the last OnTime / InGrace instants and `formalNoticeAt` the first formal-notice instant
   * (`projectDeadlines`), the standing is Stage 1's (`standingOf`).
   */
  async deadlines(seriesId: string): Promise<{ periodId: string; dueAt: number; graceEndsAt: number; formalNoticeAt: number; standing: string }[]> {
    const chain = this.ctx.chainFor(seriesId);
    const periods = await chain.listPeriods(seriesId);
    return periods.filter((p) => !p.settled).map((p) => ({ periodId: p.periodId, dueAt: p.dueAt, graceEndsAt: p.graceEndsAt, formalNoticeAt: p.formalNoticeAt, standing: p.standing }));
  }
}

/**
 * A stored signature as the command carries it: `{signer, signature}` (the tier-2 or tier-3 attestation, S4 WP6 and WP9;
 * the FX fallback, S4 WP9). A report assembled before them holds an ed25519 attestation v1, a co-signer or nothing,
 * which no chain accepts any more: 409 `attestation-superseded`, assemble the report again (the service carries the
 * stored signatures). Migrations 024 and 026 mark such reports `superseded`.
 */
function storedAttestation(a: unknown): Attestation {
  const parsed = attestationSchema.safeParse(a);
  if (!parsed.success) throw new AppError(409, 'Conflict', 'this report was assembled with an attestation or FX fallback the chains no longer accept: assemble it again', { reason: 'attestation-superseded' });
  return parsed.data;
}

/** `{signer, signature}` of a stored signature record (a tier-3 case's carries its digest too), or null. */
function pickAttestation(a: unknown): Attestation | null {
  const x = a as { signer?: unknown; signature?: unknown } | null;
  return x && typeof x.signer === 'string' && typeof x.signature === 'string' ? { signer: x.signer, signature: x.signature } : null;
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
