import { z } from 'zod';
import { AppError, audit } from '@merces/core';
import { DEFAULTS, normaliseAddress, randomSalt, termsCommitment, type SeriesTerms, type UnsignedTx } from '@merces/domain';
import { WAD, ratePerUnit, wadFromDecimal, wadToDecimal } from '@merces/math';
import { isEligible, type Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E4 — terms vault and disclosure.
 * Public terms are validated against bounds and defaults (C4) and the threshold floor (R34, E9). The private
 * terms (θ, r, currency, indexing rule, salt) are encrypted at rest and disclosed only to the issuer and to
 * eligible backers, with every access logged. Clients can recompute the commitment (POST /terms/commitment).
 */

export const publicTermsSchema = z.object({
  stablecoin: z.enum(['USDC', 'USDG']),
  unitsOffered: z.string().regex(/^\d+$/),
  reservePrice: z.string().regex(/^\d+$/),
  minimumRaise: z.string().regex(/^\d+$/),
  /** decimal, e.g. "2.5" */
  capMultiple: z.string().regex(/^\d+(\.\d+)?$/).default(wadToDecimal(DEFAULTS.capMultipleWad)),
  lockupSeconds: z.number().int().nonnegative().default(DEFAULTS.lockupSeconds),
  releaseSchedule: z.array(z.object({ afterSeconds: z.number().int().nonnegative(), bps: z.number().int().positive() })).min(1).default([{ afterSeconds: 0, bps: 5000 }, { afterSeconds: 90 * 86_400, bps: 2500 }, { afterSeconds: 180 * 86_400, bps: 2500 }]),
  hurdle: z.string().regex(/^\d+(\.\d+)?$/).default(wadToDecimal(DEFAULTS.hurdleWad)),
  payoutMultipleK: z.number().int().positive().default(DEFAULTS.payoutMultipleK),
  tierFlags: z.object({ tier1: z.boolean(), tier2: z.boolean(), tier3: z.boolean(), tier4: z.boolean().default(false) }),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  raiseStyle: z.enum(['sealed', 'curve']).default('sealed'),
  country: z.string().length(2),
});

export const privateTermsSchema = z.object({
  /** annual threshold θ in reporting-currency base units (6 decimals) */
  threshold: z.string().regex(/^\d+$/),
  /** total share rate as a decimal, e.g. "0.10" */
  shareRate: z.string().regex(/^0?\.\d+$|^1(\.0+)?$/),
  indexingRule: z.enum(['cpi-annual', 'none']).default('cpi-annual'),
});

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export class TermsService {
  constructor(private readonly ctx: ServiceContext) {}

  async thresholdFloor(country: string, currency: string, year: number): Promise<{ floor: bigint; placeholder: boolean; source: string } | null> {
    const r = await this.ctx.pool.query<{ median_full_time_income: string; currency: string; placeholder: boolean; source: string }>('select median_full_time_income, currency, placeholder, source from threshold_data where country = $1 and year = $2', [country, year]);
    const row = r.rows[0] ?? (await this.ctx.pool.query<{ median_full_time_income: string; currency: string; placeholder: boolean; source: string }>('select median_full_time_income, currency, placeholder, source from threshold_data where country = $1 order by year desc limit 1', [country])).rows[0];
    if (!row) return null;
    if (row.currency !== currency) return null; // no conversion of the floor: the issuer reports in the local currency or goes through tier 3 (A-REP-4)
    return { floor: BigInt(row.median_full_time_income), placeholder: row.placeholder, source: row.source };
  }

  /** Validate public and private terms together. Returns issues (empty = valid) and the derived onchain terms. */
  async validate(chain: string, pub: z.infer<typeof publicTermsSchema>, priv: z.infer<typeof privateTermsSchema> | null, year: number): Promise<{ issues: ValidationIssue[]; derived: { capMultipleWad: string; hurdleWad: string; ratePerUnitWad: string | null; thresholdFloor: string | null; floorPlaceholder: boolean } }> {
    const issues: ValidationIssue[] = [];
    const port = this.ctx.chains.chains.get(chain);
    if (!port) issues.push({ field: 'chain', code: 'unknown-chain', message: `unknown chain ${chain}` });
    const info = port ? await port.info() : null;
    if (info && !info.stablecoins[pub.stablecoin]) issues.push({ field: 'stablecoin', code: 'not-on-chain', message: `${pub.stablecoin} is not available on ${chain}` });
    if (pub.raiseStyle === 'curve' && info?.family !== 'solana') issues.push({ field: 'raiseStyle', code: 'curve-solana-only', message: 'curve-mode raises exist on Solana only' });
    const capWad = wadFromDecimal(pub.capMultiple);
    if (capWad < DEFAULTS.capMultipleMinWad || capWad > DEFAULTS.capMultipleMaxWad) issues.push({ field: 'capMultiple', code: 'out-of-bounds', message: 'cap multiple must be between 2.0 and 3.0' });
    const bps = pub.releaseSchedule.reduce((a, t) => a + t.bps, 0);
    if (bps !== 10_000) issues.push({ field: 'releaseSchedule', code: 'bps-sum', message: 'release schedule must sum to 10000 bps' });
    const units = BigInt(pub.unitsOffered);
    if (units <= 0n) issues.push({ field: 'unitsOffered', code: 'positive', message: 'units offered must be positive' });
    if (BigInt(pub.reservePrice) <= 0n) issues.push({ field: 'reservePrice', code: 'positive', message: 'reserve price must be positive' });
    if (BigInt(pub.minimumRaise) > units * BigInt(pub.reservePrice)) issues.push({ field: 'minimumRaise', code: 'unreachable', message: 'minimum raise exceeds units × reserve price' });
    if (pub.tierFlags.tier4) issues.push({ field: 'tierFlags.tier4', code: 'switched-off', message: 'tier 4 self-attestation is switched off' });
    if (!pub.tierFlags.tier1 && !pub.tierFlags.tier2 && !pub.tierFlags.tier3) issues.push({ field: 'tierFlags', code: 'none', message: 'at least one verification tier is required' });
    let ratePerUnitWad: string | null = null;
    let floorStr: string | null = null;
    let floorPlaceholder = false;
    const floor = await this.thresholdFloor(pub.country, pub.reportingCurrency, year);
    if (floor) {
      floorStr = floor.floor.toString();
      floorPlaceholder = floor.placeholder;
    }
    if (priv) {
      const r = units > 0n ? ratePerUnit(wadFromDecimal(priv.shareRate), units) : 0n;
      ratePerUnitWad = r.toString();
      if (r <= 0n) issues.push({ field: 'shareRate', code: 'positive', message: 'share rate must be positive' });
      if (wadFromDecimal(priv.shareRate) > WAD) issues.push({ field: 'shareRate', code: 'max', message: 'share rate cannot exceed 100%' });
      if (!floor) issues.push({ field: 'threshold', code: 'no-floor-data', message: `no median-income data for ${pub.country} in ${pub.reportingCurrency}; the floor cannot be checked (ask Kunal for sources)` });
      else if (BigInt(priv.threshold) < floor.floor) issues.push({ field: 'threshold', code: 'below-floor', message: `threshold must be at least the local median full-time income (${floor.floor} ${pub.reportingCurrency} base units)` });
    }
    return { issues, derived: { capMultipleWad: capWad.toString(), hurdleWad: wadFromDecimal(pub.hurdle).toString(), ratePerUnitWad, thresholdFloor: floorStr, floorPlaceholder } };
  }

  async createDraft(session: Session, chain: string, issuer: string): Promise<Record<string, unknown>> {
    const port = this.ctx.chains.chains.get(chain);
    if (!port) throw AppError.badRequest('unknown chain');
    const addr = normaliseAddress(issuer, port.family);
    if (!session.wallets.some((w) => w.chain === chain && w.address === addr)) throw AppError.forbidden('issuer wallet must be linked to your account');
    const elig = await this.ctx.pool.query("select 1 from eligibility where chain = $1 and wallet = $2 and kind = 'issuer' and revoked_at is null", [chain, addr]);
    if (!elig.rowCount && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not an approved issuer');
    const draftId = this.ctx.newId('draft');
    await this.ctx.pool.query('insert into series_drafts (draft_id, account_id, chain, issuer, public_terms) values ($1,$2,$3,$4,$5)', [draftId, session.accountId, chain, addr, '{}']);
    return this.getDraft(draftId, session);
  }

  async getDraft(draftId: string, session: Session): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from series_drafts where draft_id = $1', [draftId]);
    const d = r.rows[0];
    if (!d) throw AppError.notFound('draft');
    if (d.account_id !== session.accountId && !session.roles.includes('admin')) throw AppError.forbidden();
    return { draftId, accountId: d.account_id, chain: d.chain, issuer: d.issuer, state: d.state, publicTerms: d.public_terms, termsCommitment: d.terms_commitment, contractHash: d.contract_hash, seriesId: d.series_id, createdAt: d.created_at, updatedAt: d.updated_at };
  }

  async listDrafts(session: Session): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select draft_id from series_drafts where account_id = $1 order by created_at', [session.accountId]);
    return Promise.all(r.rows.map((x) => this.getDraft(x.draft_id, session)));
  }

  /** Set public + private terms: validate, encrypt the private half, store the commitment. */
  async setTerms(draftId: string, session: Session, pub: z.infer<typeof publicTermsSchema>, priv: z.infer<typeof privateTermsSchema>): Promise<Record<string, unknown>> {
    const d = await this.getDraft(draftId, session);
    if (!['draft', 'terms_set'].includes(String(d.state))) throw AppError.conflict(`draft is ${d.state}; terms are locked once the contract is signed`);
    const year = new Date(this.ctx.wallClock() * 1000).getUTCFullYear();
    const { issues, derived } = await this.validate(String(d.chain), pub, priv, year);
    if (issues.length) throw AppError.unprocessable('terms invalid', { issues });
    const salt = randomSalt();
    const commitment = termsCommitment({ threshold: priv.threshold, ratePerUnitWad: derived.ratePerUnitWad!, reportingCurrency: pub.reportingCurrency, indexingRule: priv.indexingRule, salt });
    const privatePayload = JSON.stringify({ threshold: priv.threshold, shareRate: priv.shareRate, ratePerUnitWad: derived.ratePerUnitWad, reportingCurrency: pub.reportingCurrency, indexingRule: priv.indexingRule, salt });
    const ciphertext = this.ctx.vault.encrypt(privatePayload, `terms:${draftId}`);
    // the indexing rule is a public rule name (the commitment hides θ and r, not the rule), so it is kept as metadata for the yearly indexing run (E9)
    const publicStored = { ...pub, indexingRule: priv.indexingRule, capMultipleWad: derived.capMultipleWad, capMultipleDecimal: pub.capMultiple, hurdleWad: derived.hurdleWad, thresholdFloor: derived.thresholdFloor, floorPlaceholder: derived.floorPlaceholder };
    await this.ctx.pool.query("update series_drafts set public_terms = $2, terms_commitment = $3, state = 'terms_set', updated_at = now() where draft_id = $1", [draftId, JSON.stringify(publicStored), commitment]);
    await this.ctx.pool.query('insert into terms_vault (draft_id, ciphertext, key_id, commitment, version) values ($1,$2,$3,$4,1) on conflict (draft_id) do update set ciphertext = excluded.ciphertext, key_id = excluded.key_id, commitment = excluded.commitment, version = terms_vault.version + 1', [draftId, ciphertext, this.ctx.vault.keyId, commitment]);
    return this.getDraft(draftId, session);
  }

  /** Disclosure: the issuer (own draft/series) or an eligible backer. Every access is logged. */
  async disclose(params: { draftId?: string; seriesId?: string }, session: Session, purpose: string): Promise<Record<string, unknown>> {
    const r = params.seriesId
      ? await this.ctx.pool.query('select v.*, d.account_id, d.chain, d.issuer from terms_vault v join series_drafts d on d.draft_id = v.draft_id where v.series_id = $1', [params.seriesId])
      : await this.ctx.pool.query('select v.*, d.account_id, d.chain, d.issuer from terms_vault v join series_drafts d on d.draft_id = v.draft_id where v.draft_id = $1', [params.draftId]);
    const v = r.rows[0];
    if (!v) throw AppError.notFound('terms');
    // The private terms are the issuer's and the eligible backers' (Part B): there is no admin bypass. Operators
    // read nothing beyond the commitment; the attestor review path (R33) is the only other reader and is audited.
    const isIssuer = v.account_id === session.accountId;
    if (!isIssuer) {
      if (!params.seriesId) throw AppError.forbidden('drafts are visible to the issuer only');
      if (!(await isEligible(this.ctx, session))) throw AppError.forbidden('terms are disclosed to eligible backers only');
    }
    const plain = JSON.parse(this.ctx.vault.decrypt(v.ciphertext, `terms:${v.draft_id}`)) as Record<string, string>;
    await this.ctx.pool.query('insert into terms_access_log (draft_id, series_id, account_id, purpose, version) values ($1,$2,$3,$4,$5)', [v.draft_id, v.series_id ?? params.seriesId ?? null, session.accountId, purpose, v.version]);
    return { draftId: v.draft_id, seriesId: v.series_id ?? params.seriesId ?? null, version: v.version, commitment: v.commitment, terms: plain, recompute: 'POST /terms/commitment with these fields must equal `commitment`' };
  }

  async accessLog(seriesId: string): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select at, account_id, purpose, version from terms_access_log where series_id = $1 order by at desc limit 500', [seriesId]);
    return r.rows.map((x) => ({ at: x.at, accountId: x.account_id, purpose: x.purpose, version: x.version }));
  }

  /** Build the unsigned createSeries transaction. Requires a signed contract (hash anchored) and set terms. */
  async buildCreateSeries(draftId: string, session: Session): Promise<{ tx: UnsignedTx; terms: SeriesTerms }> {
    const d = await this.ctx.pool.query('select * from series_drafts where draft_id = $1', [draftId]);
    const draft = d.rows[0];
    if (!draft) throw AppError.notFound('draft');
    if (draft.account_id !== session.accountId) throw AppError.forbidden();
    if (draft.state !== 'contract_signed') throw AppError.conflict(`draft is ${draft.state}; the HEU contract and the Autonomy Charter must be signed before a raise can be created`);
    const chain = this.ctx.chains.get(draft.chain);
    const info = await chain.info();
    const p = draft.public_terms as z.infer<typeof publicTermsSchema> & { capMultipleWad: string; hurdleWad: string };
    const coin = info.stablecoins[p.stablecoin];
    if (!coin) throw AppError.unprocessable('stablecoin no longer available on chain');
    const terms: SeriesTerms = {
      stablecoin: p.stablecoin, stablecoinMint: coin.mint, unitsOffered: p.unitsOffered, reservePrice: p.reservePrice, minimumRaise: p.minimumRaise, capMultipleWad: p.capMultipleWad, lockupSeconds: p.lockupSeconds,
      releaseSchedule: p.releaseSchedule, auctionFeeBps: DEFAULTS.auctionFeeBps, payoutFeeBps: DEFAULTS.payoutFeeBps, hurdleWad: p.hurdleWad, payoutMultipleK: p.payoutMultipleK, walletCapBps: DEFAULTS.walletCapBps,
      dueDays: DEFAULTS.dueDays, graceDays: DEFAULTS.graceDays, formalNoticeDays: DEFAULTS.formalNoticeDays, contractHash: draft.contract_hash, termsCommitment: draft.terms_commitment, tierFlags: p.tierFlags, reportingCurrency: p.reportingCurrency, raiseStyle: p.raiseStyle,
    };
    const tx = await chain.build({ kind: 'createSeries', terms }, draft.issuer);
    return { tx, terms };
  }

  /** After the user signed and sent createSeries: link the draft to the series by matching the contract hash and commitment in the read model. */
  async linkCreated(draftId: string, session: Session): Promise<Record<string, unknown>> {
    const d = await this.getDraft(draftId, session);
    if (d.seriesId) return d;
    const r = await this.ctx.pool.query<{ series_id: string }>('select series_id from series where chain = $1 and issuer = $2 and contract_hash = $3 and terms_commitment = $4', [d.chain, d.issuer, d.contractHash, d.termsCommitment]);
    const seriesId = r.rows[0]?.series_id;
    if (!seriesId) {
      // the simulator answers immediately; a live chain may need the indexer to catch up
      const live = await this.ctx.chains.get(String(d.chain)).listSeries();
      const found = live.find((s) => s.issuer === d.issuer && s.terms.contractHash === d.contractHash && s.terms.termsCommitment === d.termsCommitment);
      if (!found) throw AppError.conflict('no series with this draft\'s contract hash and commitment has been indexed yet');
      return this.markCreated(draftId, found.seriesId, session);
    }
    return this.markCreated(draftId, seriesId, session);
  }
  private async markCreated(draftId: string, seriesId: string, session: Session): Promise<Record<string, unknown>> {
    await this.ctx.pool.query("update series_drafts set series_id = $2, state = 'created', updated_at = now() where draft_id = $1", [draftId, seriesId]);
    await this.ctx.pool.query('update terms_vault set series_id = $2 where draft_id = $1', [draftId, seriesId]);
    return this.getDraft(draftId, session);
  }

  // ---- yearly inflation amendment (C4, R34)
  async prepareInflationAmendment(seriesId: string, session: Session, year: number): Promise<Record<string, unknown>> {
    const v = await this.ctx.pool.query('select v.*, d.account_id, d.chain, d.issuer, d.public_terms from terms_vault v join series_drafts d on d.draft_id = v.draft_id where v.series_id = $1', [seriesId]);
    const row = v.rows[0];
    if (!row) throw AppError.notFound('terms');
    if (row.account_id !== session.accountId) throw AppError.forbidden();
    const plain = JSON.parse(this.ctx.vault.decrypt(row.ciphertext, `terms:${row.draft_id}`)) as Record<string, string>;
    if (plain.indexingRule === 'none') throw AppError.conflict('this series has no indexing rule');
    const country = (row.public_terms as { country: string }).country;
    const idx = await this.ctx.pool.query<{ inflation_index_bps: number; placeholder: boolean; source: string }>('select inflation_index_bps, placeholder, source from threshold_data where country = $1 and year = $2', [country, year]);
    const ix = idx.rows[0];
    if (!ix) throw AppError.unprocessable(`no inflation index for ${country} ${year}`);
    const series = await this.ctx.chains.get(row.chain).getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    const newThreshold = (BigInt(plain.threshold!) * BigInt(10_000 + ix.inflation_index_bps)) / 10_000n;
    const salt = randomSalt();
    const newCommitment = termsCommitment({ threshold: newThreshold, ratePerUnitWad: plain.ratePerUnitWad!, reportingCurrency: plain.reportingCurrency!, indexingRule: plain.indexingRule!, salt });
    const amendmentId = this.ctx.newId('amend');
    const newPlain = { ...plain, threshold: newThreshold.toString(), salt, indexedYear: year };
    await this.ctx.pool.query(
      'insert into terms_amendments (amendment_id, series_id, draft_id, kind, new_commitment, new_cap_multiple_wad, ciphertext, version, rationale_code) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [amendmentId, seriesId, row.draft_id, 'inflation-index', newCommitment, series.terms.capMultipleWad, this.ctx.vault.encrypt(JSON.stringify(newPlain), `terms:${row.draft_id}`), Number(row.version) + 1, `cpi-${year}-${ix.inflation_index_bps}bps`],
    );
    return { amendmentId, seriesId, kind: 'inflation-index', year, inflationBps: ix.inflation_index_bps, placeholderIndex: ix.placeholder, newCommitment, state: 'proposed', note: 'A registered attestor must attest the amendment is issuer-favourable (θ rises → owed falls); then build the amendTerms transaction with the attestor as co-signer.' };
  }

  async listAmendments(seriesId: string): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select amendment_id, kind, new_commitment, new_cap_multiple_wad, version, state, attestor, rationale_code, created_at, applied_at from terms_amendments where series_id = $1 order by created_at', [seriesId]);
    return r.rows.map((x) => ({ amendmentId: x.amendment_id, kind: x.kind, newCommitment: x.new_commitment, newCapMultipleWad: x.new_cap_multiple_wad, version: x.version, state: x.state, attestor: x.attestor, rationaleCode: x.rationale_code, createdAt: x.created_at, appliedAt: x.applied_at }));
  }

  /** Attestor review: the attestor reads old and new private terms and attests favourability (θ non-decreasing, r non-increasing, cap non-increasing). */
  async attestAmendment(amendmentId: string, attestor: Session, attestorWallet: string, approve: boolean): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select a.*, v.ciphertext as old_ciphertext, v.draft_id as vdraft from terms_amendments a join terms_vault v on v.series_id = a.series_id where a.amendment_id = $1', [amendmentId]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('amendment');
    if (a.state !== 'proposed') throw AppError.conflict(`amendment is ${a.state}`);
    const oldT = JSON.parse(this.ctx.vault.decrypt(a.old_ciphertext, `terms:${a.vdraft}`)) as Record<string, string>;
    const newT = JSON.parse(this.ctx.vault.decrypt(a.ciphertext, `terms:${a.draft_id}`)) as Record<string, string>;
    const favourable = BigInt(newT.threshold!) >= BigInt(oldT.threshold!) && BigInt(newT.ratePerUnitWad!) <= BigInt(oldT.ratePerUnitWad!);
    if (approve && !favourable) throw AppError.unprocessable('amendment is not issuer-favourable; refusing to attest');
    await this.ctx.pool.query('update terms_amendments set state = $2, attestor = $3 where amendment_id = $1', [amendmentId, approve ? 'attested' : 'rejected', attestorWallet]);
    await audit(this.ctx.pool, { actor: attestor.accountId, actorRole: 'attestor', action: approve ? 'amendment.attest' : 'amendment.reject', target: amendmentId, detail: { favourable } });
    return { amendmentId, state: approve ? 'attested' : 'rejected', favourable };
  }

  async buildAmendTerms(amendmentId: string, session: Session): Promise<{ tx: UnsignedTx }> {
    const r = await this.ctx.pool.query('select a.*, d.account_id, d.chain, d.issuer from terms_amendments a join series_drafts d on d.draft_id = a.draft_id where a.amendment_id = $1', [amendmentId]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('amendment');
    if (a.account_id !== session.accountId) throw AppError.forbidden();
    if (a.state !== 'attested') throw AppError.conflict(`amendment is ${a.state}; it needs an attestor first`);
    const tx = await this.ctx.chains.get(a.chain).build({ kind: 'amendTerms', seriesId: a.series_id, termsCommitment: a.new_commitment, capMultipleWad: a.new_cap_multiple_wad, attestor: a.attestor }, a.issuer, [a.attestor]);
    await this.ctx.pool.query("update terms_amendments set state = 'submitted' where amendment_id = $1", [amendmentId]);
    return { tx };
  }

  /** Called by the indexer-side reconciliation (or the client) once TermsAmended landed: rotate the vault to the new version. */
  async applyAmendment(amendmentId: string): Promise<void> {
    const r = await this.ctx.pool.query('select * from terms_amendments where amendment_id = $1', [amendmentId]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('amendment');
    const s = await this.ctx.pool.query<{ terms_commitment: string }>('select terms_commitment from series where series_id = $1', [a.series_id]);
    if (s.rows[0]?.terms_commitment !== a.new_commitment) throw AppError.conflict('the chain does not carry the new commitment yet');
    await this.ctx.pool.query('update terms_vault set ciphertext = $2, commitment = $3, version = $4 where series_id = $1', [a.series_id, a.ciphertext, a.new_commitment, a.version]);
    await this.ctx.pool.query("update terms_amendments set state = 'applied', applied_at = now() where amendment_id = $1", [amendmentId]);
  }
}
