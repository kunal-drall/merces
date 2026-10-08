import { z } from 'zod';
import { AppError, audit, enqueueOutbox } from '@merces/core';
import { fxAttestationMessage, normaliseAddress, type ChainPort, type SeriesState, type UnsignedTx } from '@merces/domain';
import { parsePeriod, periodFrom } from '@merces/math';
import { verifyWalletSignature } from '@merces/ports';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E10 — attestor service (R10, R16, R26, C8.5–6, C11.6).
 * Attestors are accounts with the `attestor` role whose wallets the chain has registered (`listAttestors`).
 * This service tracks the work that needs an attestor's signature and builds the transactions they sign:
 *  - hardship pauses: the issuer's reason and evidence reach the chosen attestor as END-TO-END ciphertext the
 *    server stores opaque and never decrypts; holders only ever see statuses and dates;
 *  - tier-3 cases: documents (E2E ciphertext) and the attestor's attested quarterly payment; the client-side
 *    prefill specification (R26 — the server extracts nothing); the annual true-up as amounts and a deadline;
 *  - FX fallback requests the keeper opened (C9): the attestor signs a rate client-side, the service stores it;
 *  - extinguishment (C11.6): one transaction with two distinct registered attestors as signers.
 * No income figure, document or reason is ever at rest or in a log. Decision fields are codes.
 * The backend never signs: every onchain action is returned as an UnsignedTx for the issuer or the attestor.
 */

const money = z.string().regex(/^\d+$/, 'money must be a non-negative integer string in base units');
const code = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a lowercase code such as insufficient-evidence');
const periodId = z.string().regex(/^\d{4}Q[1-4]$/);
const keyHint = z.string().max(200).nullable().default(null);
/** request bodies are capped at 2 MB by the gateway */
const ciphertext = z.string().min(1).max(1_900_000);

export const hardshipRequestSchema = z.object({ until: z.number().int().positive(), attestor: z.string().min(1).max(64), ciphertext, keyHint });
export const hardshipDecideSchema = z.object({ approve: z.boolean(), until: z.number().int().positive().optional(), decisionCode: code.optional() });
export const tier3OpenSchema = z.object({ attestor: z.string().min(1).max(64), documentsCiphertext: ciphertext, keyHint, estimatePaymentStable: money });
export const tier3SignSchema = z.object({ paymentStable: money, incomeCommitment: z.string().regex(/^0x[0-9a-f]{64}$/), liquidityEvent: z.boolean().default(false) });
export const tier3AnnualOpenSchema = z.object({ year: z.number().int().min(2026).max(2100), attestor: z.string().min(1).max(64), documentsCiphertext: ciphertext, keyHint });
export const tier3AnnualSignSchema = z.object({ totalPaymentStable: money });
export const fxSignSchema = z.object({ rateWad: z.string().regex(/^\d+$/), attestorWallet: z.string().min(1).max(64), sourceNote: code, signature: z.string().min(1).max(4096) });
export const extinguishSchema = z.object({ seriesId: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/), attestors: z.array(z.string().min(1).max(64)).length(2), evidenceCiphertext: ciphertext, keyHint });

/** Days the issuer has to settle an annual underpayment (C8: "true up within 60 days"). No accrual (A-C8-3). */
export const TRUE_UP_DAYS = 60;

const PLAINTEXT_WORDS = /reason|hardship|income|evidence|document|salary|diagnos|medical/i;

function parsesAsJsonObject(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    const v = JSON.parse(t) as unknown;
    return typeof v === 'object' && v !== null;
  } catch {
    return false;
  }
}

/**
 * The server cannot prove a blob is encrypted, but it refuses anything that is evidently not: plaintext,
 * JSON (with a `reason` field or otherwise) and base64-wrapped JSON. Real E2E ciphertext is base64/base64url/hex.
 */
export function assertOpaqueCiphertext(value: string, field: string): void {
  const v = value.trim();
  if (v.length < 24) throw AppError.unprocessable(`${field} is too short to be ciphertext`);
  if (parsesAsJsonObject(v)) throw AppError.unprocessable(`${field} is plaintext JSON; encrypt it end-to-end for the attestor`);
  if (!/^(0x[0-9a-fA-F]+|[A-Za-z0-9+/=_-]+)$/.test(v)) throw AppError.unprocessable(`${field} must be end-to-end ciphertext (base64, base64url or hex), not plaintext`);
  if (PLAINTEXT_WORDS.test(v)) throw AppError.unprocessable(`${field} looks like plaintext; encrypt it end-to-end for the attestor`);
  let decoded = '';
  try {
    decoded = Buffer.from(v.replace(/^0x/, ''), v.startsWith('0x') ? 'hex' : 'base64').toString('utf8');
  } catch {
    decoded = '';
  }
  if (decoded && (parsesAsJsonObject(decoded) || PLAINTEXT_WORDS.test(decoded))) throw AppError.unprocessable(`${field} is only encoded, not encrypted; encrypt it end-to-end for the attestor`);
}

const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
const str = (x: unknown): string | null => (x === null || x === undefined ? null : String(x));

interface WalletRef {
  chain: string;
  address: string;
}

export class AttestorService {
  constructor(private readonly ctx: ServiceContext) {}

  // ------------------------------------------------------------------ helpers

  private chainOf(seriesId: string): ChainPort {
    const key = seriesId.slice(0, seriesId.indexOf(':'));
    if (!key || !this.ctx.chains.chains.has(key)) throw AppError.badRequest(`unknown chain in series id ${seriesId}`);
    return this.ctx.chains.get(key);
  }

  private async seriesForIssuer(seriesId: string, session: Session): Promise<{ chain: ChainPort; series: SeriesState }> {
    const chain = this.chainOf(seriesId);
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    if (!session.wallets.some((w) => w.chain === chain.chain && w.address === series.issuer) && !session.roles.includes('admin')) throw AppError.forbidden('not the issuer of this series');
    return { chain, series };
  }

  private async requireRegisteredAttestor(chain: ChainPort, attestor: string): Promise<void> {
    if (!(await chain.listAttestors()).includes(attestor)) throw AppError.unprocessable(`${attestor} is not a registered attestor on ${chain.chain}`);
  }

  /** The session's wallets that the chain has registered as attestors. */
  private async registeredWallets(session: Session): Promise<(WalletRef & { registeredOnchain: boolean })[]> {
    const out: (WalletRef & { registeredOnchain: boolean })[] = [];
    for (const w of session.wallets) {
      const chain = this.ctx.chains.chains.get(w.chain);
      const registeredOnchain = chain ? (await chain.listAttestors()).includes(w.address) : false;
      out.push({ chain: w.chain, address: w.address, registeredOnchain });
    }
    return out;
  }

  /** Work filters: a registered attestor sees work addressed to their wallets (or any attestor on their chains); an admin sees all. */
  private async scope(session: Session): Promise<{ addresses: string[] | null; chains: string[] | null; wallets: (WalletRef & { registeredOnchain: boolean })[] }> {
    const wallets = await this.registeredWallets(session);
    if (session.roles.includes('admin')) return { addresses: null, chains: null, wallets };
    const regs = wallets.filter((w) => w.registeredOnchain);
    return { addresses: regs.map((w) => w.address), chains: [...new Set(regs.map((w) => w.chain))], wallets };
  }

  private holdsWallet(session: Session, chain: string, address: string): boolean {
    return session.wallets.some((w) => w.chain === chain && w.address === address);
  }

  // ------------------------------------------------------------------ queue and profile

  async queue(session: Session): Promise<Record<string, unknown>> {
    const { addresses, chains } = await this.scope(session);
    const p = this.ctx.pool;
    const hardship = await p.query('select hardship_id, series_id, chain, attestor, requested_until, created_at from hardship_requests where state = $2 and ($1::text[] is null or attestor = any($1::text[])) order by created_at', [addresses, 'pending']);
    const tier3 = await p.query('select case_id, series_id, chain, period_id, attestor, estimate_payment_stable, created_at from tier3_cases where state = $2 and ($1::text[] is null or attestor = any($1::text[])) order by created_at', [addresses, 'open']);
    const annual = await p.query('select annual_id, series_id, chain, year, attestor, created_at from tier3_annual where state = $2 and ($1::text[] is null or attestor = any($1::text[])) order by created_at', [addresses, 'open']);
    const fx = await p.query('select request_id, chain, pair, period_id, reason, created_at from fx_fallback_requests where state = $2 and ($1::text[] is null or chain = any($1::text[])) order by created_at', [chains, 'open']);
    const amendments = await p.query('select a.amendment_id, a.series_id, s.chain, a.kind, a.version, a.rationale_code, a.created_at from terms_amendments a join series s on s.series_id = a.series_id where a.state = $2 and ($1::text[] is null or s.chain = any($1::text[])) order by a.created_at', [chains, 'proposed']);
    const ext = await p.query('select request_id, series_id, chain, attestors, created_at from extinguishment_requests where state = $2 and ($1::text[] is null or attestors && $1::text[]) order by created_at', [addresses, 'built']);
    return {
      hardship: hardship.rows.map((r) => ({ hardshipId: r.hardship_id, seriesId: r.series_id, chain: r.chain, attestor: r.attestor, requestedUntil: Number(r.requested_until), createdAt: r.created_at })),
      tier3: tier3.rows.map((r) => ({ caseId: r.case_id, seriesId: r.series_id, chain: r.chain, periodId: r.period_id, attestor: r.attestor, estimatePaymentStable: r.estimate_payment_stable, createdAt: r.created_at })),
      tier3Annual: annual.rows.map((r) => ({ annualId: r.annual_id, seriesId: r.series_id, chain: r.chain, year: r.year, attestor: r.attestor, createdAt: r.created_at })),
      fxRequests: fx.rows.map((r) => ({ requestId: r.request_id, chain: r.chain, pair: r.pair, periodId: r.period_id, reason: r.reason, createdAt: r.created_at })),
      amendments: amendments.rows.map((r) => ({ amendmentId: r.amendment_id, seriesId: r.series_id, chain: r.chain, kind: r.kind, version: r.version, rationaleCode: r.rationale_code, createdAt: r.created_at })),
      extinguishments: ext.rows.map((r) => ({ requestId: r.request_id, seriesId: r.series_id, chain: r.chain, attestors: r.attestors, createdAt: r.created_at })),
    };
  }

  async me(session: Session): Promise<Record<string, unknown>> {
    const { wallets } = await this.scope(session);
    const q = await this.queue(session);
    const count = (k: string) => (q[k] as unknown[]).length;
    return { accountId: session.accountId, roles: session.roles, wallets, openWork: { hardship: count('hardship'), tier3: count('tier3'), tier3Annual: count('tier3Annual'), fxRequests: count('fxRequests'), amendments: count('amendments'), extinguishments: count('extinguishments') } };
  }

  // ------------------------------------------------------------------ hardship (R16, C8)

  private async hardshipRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from hardship_requests where hardship_id = $1', [id]);
    const h = r.rows[0];
    if (!h) throw AppError.notFound('hardship request');
    return h;
  }

  /** The record as the issuer and the attestor see it (never holders). Ciphertext only when `withCiphertext`. */
  private hardshipView(h: Record<string, unknown>, withCiphertext: boolean): Record<string, unknown> {
    return {
      hardshipId: h.hardship_id, seriesId: h.series_id, chain: h.chain, attestor: h.attestor, state: h.state, requestedUntil: Number(h.requested_until), approvedUntil: num(h.approved_until),
      decisionCode: h.decision_code ?? null, keyHint: h.key_hint ?? null, createdAt: h.created_at, decidedAt: h.decided_at ?? null, ...(withCiphertext ? { ciphertext: h.ciphertext } : {}),
    };
  }

  /** Issuer: open a private hardship review and get the requestPause transaction to sign. */
  async requestHardship(seriesId: string, session: Session, input: z.infer<typeof hardshipRequestSchema>): Promise<Record<string, unknown> & { tx: UnsignedTx }> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    assertOpaqueCiphertext(input.ciphertext, 'ciphertext');
    const attestor = normaliseAddress(input.attestor, chain.family);
    await this.requireRegisteredAttestor(chain, attestor);
    const now = await chain.now();
    if (input.until <= now) throw AppError.unprocessable('the pause end must be in the future');
    if (series.phase !== 'Settled') throw AppError.conflict('the series has not settled');
    if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(series.status)) throw AppError.conflict(`cannot request a pause while ${series.status}`);
    const pending = await this.ctx.pool.query("select 1 from hardship_requests where series_id = $1 and state = 'pending'", [seriesId]);
    if (pending.rowCount) throw AppError.conflict('a hardship request is already pending for this series');
    const id = this.ctx.newId('hard');
    await this.ctx.pool.query(
      'insert into hardship_requests (hardship_id, series_id, chain, issuer, account_id, attestor, requested_until, ciphertext, key_hint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, seriesId, chain.chain, series.issuer, session.accountId, attestor, input.until, input.ciphertext, input.keyHint],
    );
    const tx = await chain.build({ kind: 'requestPause', seriesId, until: input.until }, series.issuer);
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'hardship.requested', seriesId, hardshipId: id, attestor });
    return { ...this.hardshipView(await this.hardshipRow(id), false), tx };
  }

  /** Attestor (the chosen one, or an admin): the ciphertext and the series' onchain pause state. */
  async getHardship(id: string, session: Session): Promise<Record<string, unknown>> {
    const h = await this.hardshipRow(id);
    if (!this.holdsWallet(session, String(h.chain), String(h.attestor)) && !session.roles.includes('admin')) throw AppError.forbidden('this request was addressed to another attestor');
    const series = await this.ctx.chains.get(String(h.chain)).getSeries(String(h.series_id));
    return { ...this.hardshipView(h, true), seriesStatus: series?.status ?? null, pause: series?.pause ?? null };
  }

  /** Attestor decision: approve (build approvePause for the attestor, until ≤ requested) or reject with a code. */
  async decideHardship(id: string, session: Session, input: z.infer<typeof hardshipDecideSchema>): Promise<Record<string, unknown> & { tx: UnsignedTx | null }> {
    const h = await this.hardshipRow(id);
    if (!this.holdsWallet(session, String(h.chain), String(h.attestor))) throw AppError.forbidden('only the chosen attestor can decide this request');
    if (h.state !== 'pending') throw AppError.conflict(`hardship request is ${h.state}`);
    const chain = this.ctx.chains.get(String(h.chain));
    const seriesId = String(h.series_id);
    if (!input.approve) {
      const decisionCode = input.decisionCode ?? 'declined';
      await this.ctx.pool.query("update hardship_requests set state = 'rejected', decision_code = $2, decided_by = $3, decided_at = now() where hardship_id = $1", [id, decisionCode, session.accountId]);
      await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'hardship.reject', target: id, detail: { seriesId, decisionCode } });
      await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'hardship.rejected', seriesId, hardshipId: id });
      return { ...this.hardshipView(await this.hardshipRow(id), false), tx: null };
    }
    const requested = Number(h.requested_until);
    const until = input.until ?? requested;
    if (until > requested) throw AppError.unprocessable('the approved end cannot be after the requested end');
    const now = await chain.now();
    if (until <= now) throw AppError.unprocessable('the approved end must be in the future');
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    if (!series.pause || series.pause.requestedUntil === null || series.pause.startedAt !== null) throw AppError.conflict('the issuer has not sent requestPause onchain yet (or the pause already started)');
    await this.ctx.pool.query("update hardship_requests set state = 'approved', approved_until = $2, decision_code = 'approved', decided_by = $3, decided_at = now() where hardship_id = $1", [id, until, session.accountId]);
    const tx = await chain.build({ kind: 'approvePause', seriesId, until }, String(h.attestor));
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'hardship.approve', target: id, detail: { seriesId, until } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'hardship.approved', seriesId, hardshipId: id, until });
    return { ...this.hardshipView(await this.hardshipRow(id), false), tx };
  }

  /** Holders and the issuer: statuses and dates only — never ciphertext, key hints or decision codes. */
  async hardshipStatus(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.chainOf(seriesId);
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    const r = await this.ctx.pool.query('select state, requested_until, approved_until, created_at, decided_at from hardship_requests where series_id = $1 order by created_at desc', [seriesId]);
    return {
      seriesId, seriesStatus: series.status, paused: series.status === 'Paused', pausedUntil: series.pause?.approvedUntil ?? null,
      requests: r.rows.map((x) => ({ state: x.state, requestedUntil: Number(x.requested_until), approvedUntil: num(x.approved_until), requestedAt: x.created_at, decidedAt: x.decided_at ?? null })),
    };
  }

  // ------------------------------------------------------------------ tier 3 (R10, R26)

  private async caseRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from tier3_cases where case_id = $1', [id]);
    const c = r.rows[0];
    if (!c) throw AppError.notFound('tier-3 case');
    return c;
  }

  private caseView(c: Record<string, unknown>, withCiphertext: boolean): Record<string, unknown> {
    return {
      caseId: c.case_id, seriesId: c.series_id, chain: c.chain, periodId: c.period_id, attestor: c.attestor, state: c.state, estimatePaymentStable: str(c.estimate_payment_stable), attestedPaymentStable: str(c.attested_payment_stable),
      incomeCommitment: c.income_commitment ?? null, liquidityEvent: c.liquidity_event, keyHint: c.key_hint ?? null, createdAt: c.created_at, signedAt: c.signed_at ?? null, ...(withCiphertext ? { documentsCiphertext: c.documents_ciphertext } : {}),
    };
  }

  private requireCaseAttestor(session: Session, c: Record<string, unknown>): void {
    if (!this.holdsWallet(session, String(c.chain), String(c.attestor)) && !session.roles.includes('admin')) throw AppError.forbidden('this case was addressed to another attestor');
  }

  /** Issuer: open a tier-3 case for a completed quarter with E2E-encrypted documents for the attestor and the issuer's own estimate. */
  async openTier3Case(seriesId: string, periodId: string, session: Session, input: z.infer<typeof tier3OpenSchema>): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    if (!series.terms.tierFlags.tier3) throw AppError.conflict('tier 3 is not enabled for this series');
    const period = parsePeriod(periodId);
    const now = await chain.now();
    if (period.end > now) throw AppError.conflict('the period has not ended');
    assertOpaqueCiphertext(input.documentsCiphertext, 'documentsCiphertext');
    const attestor = normaliseAddress(input.attestor, chain.family);
    await this.requireRegisteredAttestor(chain, attestor);
    const dup = await this.ctx.pool.query("select case_id, state from tier3_cases where series_id = $1 and period_id = $2 and state in ('open','signed')", [seriesId, periodId]);
    if (dup.rows[0]) throw AppError.conflict(`a tier-3 case for ${periodId} is already ${dup.rows[0].state} (${dup.rows[0].case_id})`);
    const id = this.ctx.newId('t3c');
    await this.ctx.pool.query(
      'insert into tier3_cases (case_id, series_id, chain, period_id, issuer, account_id, attestor, documents_ciphertext, key_hint, estimate_payment_stable) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, seriesId, chain.chain, periodId, series.issuer, session.accountId, attestor, input.documentsCiphertext, input.keyHint, input.estimatePaymentStable],
    );
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'tier3.case-opened', seriesId, periodId, caseId: id, attestor });
    return this.caseView(await this.caseRow(id), false);
  }

  async getTier3Case(id: string, session: Session): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    this.requireCaseAttestor(session, c);
    const series = await this.ctx.chains.get(String(c.chain)).getSeries(String(c.series_id));
    return { ...this.caseView(c, true), reportingCurrency: series?.terms.reportingCurrency ?? null, unitsOutstanding: series?.unitsOutstanding ?? null, termsCommitment: series?.terms.termsCommitment ?? null };
  }

  /**
   * R26 / Part J.5 default: extraction happens on the attestor's device. This is the specification of what to
   * pull from the decrypted documents and how to turn it into the attested payment. The server never sees a figure.
   */
  async prefillSpec(id: string, session: Session): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    this.requireCaseAttestor(session, c);
    const series = await this.ctx.chains.get(String(c.chain)).getSeries(String(c.series_id));
    const period = parsePeriod(String(c.period_id));
    const currency = series?.terms.reportingCurrency ?? 'USD';
    return {
      version: 'tier3-prefill/v0',
      extraction: 'client-side',
      caseId: id, seriesId: c.series_id, periodId: period.id,
      period: { start: period.start, end: period.end, year: period.year, quarter: period.quarter, coverage: 'calendar year to date through the period end' },
      currency, unit: 'currency base units (6 decimals)',
      note: 'Decrypt the documents on your device, extract these fields locally and compute the figures there. Send the API only the attested payment and the income commitment; never a figure or a document.',
      documents: [
        { kind: 'tax-return', forms: ['1040 Schedule C', '1040 Schedule E', '1040 Schedule 1', 'SA100/SA103 (UK)', 'local equivalent'], fields: [
          { name: 'grossReceipts', source: 'Schedule C line 1 (gross receipts or sales) or local equivalent', include: true },
          { name: 'royalties', source: 'Schedule E part I (royalties received) or local equivalent', include: true },
          { name: 'otherIncome', source: 'Schedule 1 line 8 (other income) when earned, not transfers', include: true },
        ] },
        { kind: 'w2', fields: [{ name: 'w2Wages', source: 'Box 1 (wages, tips, other compensation)', include: true }] },
        { kind: '1099', variants: ['1099-NEC', '1099-MISC', '1099-K'], fields: [
          { name: 'form1099Totals', source: '1099-NEC box 1 + 1099-MISC boxes 2/3 + 1099-K box 1a (deduplicate against grossReceipts)', include: true },
        ] },
        { kind: 'accounting-export', formats: ['csv', 'ofx', 'quickbooks', 'xero', 'freshbooks'], fields: [
          { name: 'grossReceipts', source: 'sum of income-category transactions dated within the coverage window', include: true },
          { name: 'refunds', source: 'refunds and chargebacks (subtract)', include: false },
        ] },
      ],
      output: {
        incomeYtd: `sum of included fields converted to ${currency} base units for ${period.year} through ${new Date(period.end * 1000).toISOString().slice(0, 10)}`,
        incomeYtdPrev: 'the same figure through the end of the previous quarter of the reporting year (0 in Q1)',
        paymentStable: 'quarterPayment(ratePerUnitWad, unitsOutstanding, incomeYtdPrev, incomeYtdNow, threshold, fxAvgWad) per C3 — the private terms are disclosed to you inside the ciphertext envelope',
        incomeCommitment: 'incomeCommitment({ seriesId, periodId, incomeYtd: incomeYtdNow, salt }) with the salt from the envelope',
        liquidityEvent: 'true when the documents show a sale of the business or equity (C3)',
      },
      next: `POST /attestor/tier3/${id}/sign with { paymentStable, incomeCommitment, liquidityEvent }`,
    };
  }

  /** Attestor: record the attested payment for the quarter; the issuer then assembles the tier-3 report (E5) with this attestor as co-signer. */
  async signTier3Case(id: string, session: Session, input: z.infer<typeof tier3SignSchema>): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    if (!this.holdsWallet(session, String(c.chain), String(c.attestor))) throw AppError.forbidden('only the chosen attestor can sign this case');
    if (c.state !== 'open') throw AppError.conflict(`tier-3 case is ${c.state}`);
    await this.ctx.pool.query("update tier3_cases set state = 'signed', attested_payment_stable = $2, income_commitment = $3, liquidity_event = $4, signed_at = now() where case_id = $1", [id, input.paymentStable, input.incomeCommitment, input.liquidityEvent]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'tier3.sign', target: id, detail: { seriesId: c.series_id, periodId: c.period_id, paymentStable: input.paymentStable, liquidityEvent: input.liquidityEvent } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'tier3.case-signed', seriesId: c.series_id, periodId: c.period_id, caseId: id });
    return this.caseView(await this.caseRow(id), false);
  }

  /** Issuer: every case and annual attestation of the series (amounts and states; no ciphertext). */
  async listTier3ForSeries(seriesId: string): Promise<Record<string, unknown>> {
    const cases = await this.ctx.pool.query('select * from tier3_cases where series_id = $1 order by period_id, created_at', [seriesId]);
    const annual = await this.ctx.pool.query('select * from tier3_annual where series_id = $1 order by year', [seriesId]);
    return { seriesId, cases: cases.rows.map((c) => this.caseView(c, false)), annual: annual.rows.map((a) => this.annualView(a, false)) };
  }

  private async annualRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from tier3_annual where annual_id = $1', [id]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('annual attestation');
    return a;
  }

  private annualView(a: Record<string, unknown>, withCiphertext: boolean): Record<string, unknown> {
    return {
      annualId: a.annual_id, seriesId: a.series_id, chain: a.chain, year: a.year, attestor: a.attestor, state: a.state, totalPaymentStable: str(a.total_payment_stable), estimatedPaymentStable: str(a.estimated_payment_stable),
      overpayment: str(a.overpayment), underpayment: str(a.underpayment), trueUpDueAt: num(a.trueup_due_at), creditPeriodId: a.credit_period_id ?? null, keyHint: a.key_hint ?? null, createdAt: a.created_at, signedAt: a.signed_at ?? null,
      ...(withCiphertext ? { documentsCiphertext: a.documents_ciphertext } : {}),
    };
  }

  /** Issuer: open the annual attestation for a completed year. */
  async openAnnual(seriesId: string, session: Session, input: z.infer<typeof tier3AnnualOpenSchema>): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    if (!series.terms.tierFlags.tier3) throw AppError.conflict('tier 3 is not enabled for this series');
    const now = await chain.now();
    if (periodFrom(input.year, 4).end > now) throw AppError.conflict(`${input.year} has not ended`);
    assertOpaqueCiphertext(input.documentsCiphertext, 'documentsCiphertext');
    const attestor = normaliseAddress(input.attestor, chain.family);
    await this.requireRegisteredAttestor(chain, attestor);
    const dup = await this.ctx.pool.query('select annual_id from tier3_annual where series_id = $1 and year = $2', [seriesId, input.year]);
    if (dup.rows[0]) throw AppError.conflict(`an annual attestation for ${input.year} already exists (${dup.rows[0].annual_id})`);
    const id = this.ctx.newId('t3a');
    await this.ctx.pool.query(
      'insert into tier3_annual (annual_id, series_id, chain, year, issuer, account_id, attestor, documents_ciphertext, key_hint) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, seriesId, chain.chain, input.year, series.issuer, session.accountId, attestor, input.documentsCiphertext, input.keyHint],
    );
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'tier3.annual-opened', seriesId, year: input.year, annualId: id, attestor });
    return this.annualView(await this.annualRow(id), false);
  }

  async getAnnual(id: string, session: Session): Promise<Record<string, unknown>> {
    const a = await this.annualRow(id);
    if (!this.holdsWallet(session, String(a.chain), String(a.attestor)) && !session.roles.includes('admin')) throw AppError.forbidden('this attestation was addressed to another attestor');
    return this.annualView(a, true);
  }

  /**
   * Attestor: the attested payment for the year against the sum of the year's accepted quarterly payments
   * (the share paid on estimate: paymentDue − accrual + split receipts, from the read model). Overpayment is a
   * credit to the next period; underpayment is due within 60 days with no accrual (A-C8-3). Amounts only.
   */
  async signAnnual(id: string, session: Session, input: z.infer<typeof tier3AnnualSignSchema>): Promise<Record<string, unknown>> {
    const a = await this.annualRow(id);
    if (!this.holdsWallet(session, String(a.chain), String(a.attestor))) throw AppError.forbidden('only the chosen attestor can sign this attestation');
    if (a.state !== 'open') throw AppError.conflict(`annual attestation is ${a.state}`);
    const seriesId = String(a.series_id);
    const year = Number(a.year);
    const est = await this.ctx.pool.query<{ total: string }>('select coalesce(sum(payment_due - accrual + split_received), 0)::text as total from periods where series_id = $1 and report_accepted and period_id like $2', [seriesId, `${year}Q%`]);
    const estimated = BigInt(est.rows[0]?.total ?? '0');
    const total = BigInt(input.totalPaymentStable);
    const overpayment = estimated > total ? estimated - total : 0n;
    const underpayment = total > estimated ? total - estimated : 0n;
    const now = await this.ctx.chains.get(String(a.chain)).now();
    const trueUpDueAt = underpayment > 0n ? now + TRUE_UP_DAYS * 86_400 : null;
    const creditPeriodId = overpayment > 0n ? periodFrom(year + 1, 1).id : null;
    await this.ctx.pool.query(
      "update tier3_annual set state = 'signed', total_payment_stable = $2, estimated_payment_stable = $3, overpayment = $4, underpayment = $5, trueup_due_at = $6, credit_period_id = $7, signed_at = now() where annual_id = $1",
      [id, total.toString(), estimated.toString(), overpayment.toString(), underpayment.toString(), trueUpDueAt, creditPeriodId],
    );
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'tier3.annual-sign', target: id, detail: { seriesId, year, totalPaymentStable: total.toString(), estimatedPaymentStable: estimated.toString(), overpayment: overpayment.toString(), underpayment: underpayment.toString(), trueUpDueAt } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'tier3.annual-signed', seriesId, year, annualId: id, outcome: underpayment > 0n ? 'underpayment' : overpayment > 0n ? 'overpayment' : 'settled', trueUpDueAt });
    return this.annualView(await this.annualRow(id), false);
  }

  // ------------------------------------------------------------------ FX fallback (C9)

  private fxView(r: Record<string, unknown>): Record<string, unknown> {
    return { requestId: r.request_id, chain: r.chain, pair: r.pair, periodId: r.period_id, reason: r.reason, state: r.state, attestor: r.attestor ?? null, rateWad: str(r.rate_wad), signature: r.signature ?? null, sourceNote: r.source_note ?? null, createdAt: r.created_at, signedAt: r.signed_at ?? null };
  }

  async listFxRequests(session: Session): Promise<Record<string, unknown>[]> {
    const { chains } = await this.scope(session);
    const r = await this.ctx.pool.query("select * from fx_fallback_requests where state = 'open' and ($1::text[] is null or chain = any($1::text[])) order by created_at", [chains]);
    return r.rows.map((x) => this.fxView(x));
  }

  /** The attestor signed fxAttestationMessage({pair, periodId, rateWad}) on their device; the service verifies and stores the rate. */
  async signFxRequest(id: string, session: Session, input: z.infer<typeof fxSignSchema>): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from fx_fallback_requests where request_id = $1', [id]);
    const req = r.rows[0];
    if (!req) throw AppError.notFound('fx fallback request');
    if (req.state !== 'open') throw AppError.conflict(`fx fallback request is ${req.state}`);
    const chain = this.ctx.chains.get(req.chain);
    const wallet = normaliseAddress(input.attestorWallet, chain.family);
    if (!this.holdsWallet(session, req.chain, wallet)) throw AppError.forbidden('attestor wallet must be linked to your account');
    await this.requireRegisteredAttestor(chain, wallet);
    if (BigInt(input.rateWad) <= 0n) throw AppError.unprocessable('rateWad must be positive');
    const message = new TextDecoder().decode(fxAttestationMessage({ pair: req.pair, periodId: req.period_id, rateWad: input.rateWad }));
    const ok = await verifyWalletSignature({ family: chain.family, address: wallet, message, signature: input.signature, allowSimulator: this.ctx.devMode || chain.mode === 'mock' });
    if (!ok) throw AppError.unprocessable('signature does not verify over the FX attestation message for this wallet');
    await this.ctx.pool.query("update fx_fallback_requests set state = 'signed', attestor = $2, rate_wad = $3, signature = $4, source_note = $5, signed_at = now() where request_id = $1", [id, wallet, input.rateWad, input.signature, input.sourceNote]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'fx.sign', target: id, detail: { chain: req.chain, pair: req.pair, periodId: req.period_id, rateWad: input.rateWad, sourceNote: input.sourceNote, attestor: wallet } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'fx.fallback-signed', chain: req.chain, pair: req.pair, periodId: req.period_id });
    return this.fxView((await this.ctx.pool.query('select * from fx_fallback_requests where request_id = $1', [id])).rows[0]);
  }

  /** Issuer: the signed fallback rate for the series' pair and period, in the shape E5's assemble takes as `attestorRate`. */
  async fxFallbackForSeries(seriesId: string, periodId: string): Promise<Record<string, unknown>> {
    const chain = this.chainOf(seriesId);
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    if (series.terms.reportingCurrency === 'USD') return { seriesId, periodId, pair: null, basis: 'unity', state: 'not-needed', attestorRate: null };
    const pair = `${series.terms.reportingCurrency}/USD`;
    const r = await this.ctx.pool.query('select * from fx_fallback_requests where chain = $1 and pair = $2 and period_id = $3', [chain.chain, pair, periodId]);
    const req = r.rows[0];
    if (!req) return { seriesId, periodId, pair, basis: 'accumulator', state: 'none', attestorRate: null };
    return {
      seriesId, periodId, pair, basis: 'attestor', state: req.state, requestId: req.request_id, reason: req.reason, sourceNote: req.source_note ?? null, signature: req.signature ?? null, signedAt: req.signed_at ?? null,
      attestorRate: req.state === 'signed' ? { attestor: req.attestor, rateWad: String(req.rate_wad) } : null,
    };
  }

  // ------------------------------------------------------------------ extinguishment (C11.6)

  private extView(e: Record<string, unknown>, withCiphertext: boolean): Record<string, unknown> {
    return { requestId: e.request_id, seriesId: e.series_id, chain: e.chain, attestors: e.attestors, state: e.state, keyHint: e.key_hint ?? null, requestedBy: e.requested_by, createdAt: e.created_at, ...(withCiphertext ? { evidenceCiphertext: e.evidence_ciphertext } : {}) };
  }

  /** Attestor: build the extinguish transaction with both attestors as signers (the first signs, the second co-signs). */
  async requestExtinguishment(session: Session, input: z.infer<typeof extinguishSchema>): Promise<Record<string, unknown> & { tx: UnsignedTx }> {
    const chain = this.chainOf(input.seriesId);
    const series = await chain.getSeries(input.seriesId);
    if (!series) throw AppError.notFound('series');
    if (series.status === 'Extinguished') throw AppError.conflict('series is already extinguished');
    const [a1, a2] = input.attestors.map((a) => normaliseAddress(a, chain.family)) as [string, string];
    if (a1 === a2) throw AppError.unprocessable('two distinct attestors are required');
    await this.requireRegisteredAttestor(chain, a1);
    await this.requireRegisteredAttestor(chain, a2);
    if (!this.holdsWallet(session, chain.chain, a1) && !this.holdsWallet(session, chain.chain, a2) && !session.roles.includes('admin')) throw AppError.forbidden('one of the attestors must be a wallet linked to your account');
    assertOpaqueCiphertext(input.evidenceCiphertext, 'evidenceCiphertext');
    const id = this.ctx.newId('ext');
    await this.ctx.pool.query('insert into extinguishment_requests (request_id, series_id, chain, attestors, requested_by, evidence_ciphertext, key_hint) values ($1,$2,$3,$4,$5,$6,$7)', [id, input.seriesId, chain.chain, [a1, a2], session.accountId, input.evidenceCiphertext, input.keyHint]);
    const tx = await chain.build({ kind: 'extinguish', seriesId: input.seriesId, attestors: [a1, a2] }, a1, [a2]);
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'extinguishment.request', target: id, detail: { seriesId: input.seriesId, attestors: [a1, a2] } });
    const row = (await this.ctx.pool.query('select * from extinguishment_requests where request_id = $1', [id])).rows[0];
    return { ...this.extView(row, false), tx };
  }

  async getExtinguishment(id: string, session: Session): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from extinguishment_requests where request_id = $1', [id]);
    const e = r.rows[0];
    if (!e) throw AppError.notFound('extinguishment request');
    const attestors = e.attestors as string[];
    if (!attestors.some((a) => this.holdsWallet(session, e.chain, a)) && !session.roles.includes('admin')) throw AppError.forbidden('this request names other attestors');
    const series = await this.ctx.chains.get(e.chain).getSeries(e.series_id);
    if (series?.status === 'Extinguished' && e.state === 'built') {
      await this.ctx.pool.query("update extinguishment_requests set state = 'sent' where request_id = $1", [id]);
      e.state = 'sent';
    }
    return { ...this.extView(e, true), seriesStatus: series?.status ?? null, extinguishedAt: series?.extinguishedAt ?? null };
  }
}
