import { z } from 'zod';
import { AppError, audit } from '@merces/core';
import { withTransaction } from '@merces/db';
import { CURVE_TERMS_ZEROS, DEFAULTS, INDEXING_RULE_CODE, currencyCodeOf, normaliseAddress, randomFieldSalt, rateUnits, seriesTermsViolations, termsCommitment, type BoundedTerms, type SeriesTerms, type UnsignedTx } from '@merces/domain';
import { U64_MAX, WAD, ratePerUnit, wadFromDecimal, wadToDecimal } from '@merces/math';
import { isEligible, type Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E4 — terms vault and disclosure.
 * Public terms are validated against bounds and defaults (C4) and the threshold floor (R34, E9). The private
 * terms (θ, r, currency, indexing rule, salt) are encrypted at rest and disclosed only to the issuer and to
 * eligible backers, with every access logged. Clients can recompute the commitment (POST /terms/commitment).
 */

/** A WAD ratio as a decimal string: at most 18 places, which is all `wadFromDecimal` can represent. */
const WAD_DECIMAL = /^\d+(\.\d{1,18})?$/;
const WAD_DECIMAL_MESSAGE = 'a decimal with at most 18 places';

export const publicTermsSchema = z.object({
  stablecoin: z.enum(['USDC', 'USDG']),
  unitsOffered: z.string().regex(/^\d+$/),
  reservePrice: z.string().regex(/^\d+$/),
  minimumRaise: z.string().regex(/^\d+$/),
  /** decimal, e.g. "2.5"; at most 18 places (WAD) */
  capMultiple: z.string().regex(WAD_DECIMAL, WAD_DECIMAL_MESSAGE).default(wadToDecimal(DEFAULTS.capMultipleWad)),
  /**
   * Defaults by raise style (`lockupOf`): Stage 1's 18 months on a sealed raise, 0 on a curve raise, which has no
   * lockup (Stage 1 CurveTermsNotZero: any other value is a field issue).
   */
  lockupSeconds: z.number().int().nonnegative().optional(),
  releaseSchedule: z.array(z.object({ afterSeconds: z.number().int().nonnegative(), bps: z.number().int().positive() })).min(1).default([{ afterSeconds: 0, bps: 5000 }, { afterSeconds: 90 * 86_400, bps: 2500 }, { afterSeconds: 180 * 86_400, bps: 2500 }]),
  hurdle: z.string().regex(WAD_DECIMAL, WAD_DECIMAL_MESSAGE).default(wadToDecimal(DEFAULTS.hurdleWad)),
  payoutMultipleK: z.number().int().positive().default(DEFAULTS.payoutMultipleK),
  tierFlags: z.object({ tier1: z.boolean(), tier2: z.boolean(), tier3: z.boolean(), tier4: z.boolean().default(false) }),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  raiseStyle: z.enum(['sealed', 'curve']).default('sealed'),
  country: z.string().length(2),
});

export const privateTermsSchema = z.object({
  /** annual threshold θ in reporting-currency base units (6 decimals) */
  threshold: z.string().regex(/^\d+$/),
  /**
   * total share rate as a decimal in [0, 1], e.g. "0.10", with at most 18 places (WAD). The message names the rule,
   * never the value: the share rate is a private term (it sets r).
   */
  shareRate: z.string().regex(/^0?\.\d{1,18}$|^1(\.0{1,18})?$/, 'a decimal between 0 and 1 with at most 18 places'),
  indexingRule: z.enum(['cpi-annual', 'none']).default('cpi-annual'),
});

/** The terms commitment scheme the vault payload records (Stage 1, SPEC §1.5). */
export const TERMS_SCHEME = 'poseidon5-v1';

/** The fields `POST /terms/commitment` takes, as the vault payload stores them (decimal strings, the salt a field element). */
export interface DisclosedTermsFields {
  threshold: string;
  ratePerUnitWad: string;
  reportingCurrency: string;
  indexingRule: string;
  termsSalt: string;
}

/**
 * The private terms as the vault stores and discloses them (scheme `poseidon5-v1`): the opening of Stage 1's terms
 * commitment, with the codes the circuit takes (ISO-4217 numeric currency, indexing rule code) beside the names.
 * Everything an issuer's device needs to prove a report.
 */
export interface VaultTermsPayload extends DisclosedTermsFields {
  scheme: typeof TERMS_SCHEME;
  shareRate: string;
  currencyCode: number;
  indexingRuleCode: number;
}

export function vaultTermsPayload(f: DisclosedTermsFields & { shareRate: string }): VaultTermsPayload {
  return {
    scheme: TERMS_SCHEME, threshold: f.threshold, shareRate: f.shareRate, ratePerUnitWad: f.ratePerUnitWad, reportingCurrency: f.reportingCurrency, currencyCode: currencyCodeOf(f.reportingCurrency),
    indexingRule: f.indexingRule, indexingRuleCode: INDEXING_RULE_CODE[f.indexingRule as keyof typeof INDEXING_RULE_CODE], termsSalt: f.termsSalt,
  };
}

/** Whether a reporting currency has a code in Stage 1's terms commitment (`CURRENCY_CODES`). */
function isCommitmentCurrency(alpha: string): boolean {
  try {
    currencyCodeOf(alpha);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage 1's terms commitment of the disclosed fields. Throws a value-free `AppError` (422) when they cannot form one: a
 * currency Stage 1 does not list, an unknown indexing rule, θ or r out of the u64 range, a salt that is not a field
 * element (a terms record from before the Poseidon scheme).
 */
export function commitTerms(f: DisclosedTermsFields): string {
  if (f.indexingRule !== 'none' && f.indexingRule !== 'cpi-annual') throw AppError.unprocessable('unknown indexing rule');
  try {
    return termsCommitment({ theta: f.threshold, rWad: f.ratePerUnitWad, currency: f.reportingCurrency, indexingRule: f.indexingRule, termsSalt: f.termsSalt });
  } catch (e) {
    throw AppError.unprocessable(`the terms cannot form a commitment: ${(e as Error).message}`);
  }
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

/** The share rate as WAD, or null when it is not a decimal with at most 18 places. */
function shareRateWad(shareRate: string): bigint | null {
  try {
    return wadFromDecimal(shareRate);
  } catch {
    return null;
  }
}

/** The lockup a draft records: the issuer's, else the raise style's default (0 on a curve raise, which has none). */
export function lockupOf(pub: Pick<z.infer<typeof publicTermsSchema>, 'lockupSeconds' | 'raiseStyle'>): number {
  return pub.lockupSeconds ?? (pub.raiseStyle === 'curve' ? 0 : DEFAULTS.lockupSeconds);
}

/**
 * The terms `buildCreateSeries` fills in rather than the issuer: the fees, the wallet cap and the raise's own terms (its
 * phases and the non-reveal charge, 0 while held: a series' frozen charter keeps 0 after the hold is lifted). A curve
 * raise records Stage 1's zeros for the wallet cap and the raise durations (`CURVE_TERMS_ZEROS`): it has no auction and
 * no wallet cap at any stage (`CURVE_NO_CAP`).
 */
function filledTerms(raiseStyle: 'sealed' | 'curve'): Pick<SeriesTerms, 'auctionFeeBps' | 'payoutFeeBps' | 'walletCapBps' | 'nonRevealChargeBps' | 'commitDurationSeconds' | 'revealDurationSeconds' | 'dueDays' | 'graceDays' | 'formalNoticeDays'> {
  const curve = raiseStyle === 'curve';
  return {
    auctionFeeBps: DEFAULTS.auctionFeeBps, payoutFeeBps: DEFAULTS.payoutFeeBps,
    walletCapBps: curve ? CURVE_TERMS_ZEROS.walletCapBps : DEFAULTS.walletCapBps,
    nonRevealChargeBps: DEFAULTS.nonRevealChargeBps,
    commitDurationSeconds: curve ? CURVE_TERMS_ZEROS.commitDurationSeconds : DEFAULTS.commitDurationSeconds,
    revealDurationSeconds: curve ? CURVE_TERMS_ZEROS.revealDurationSeconds : DEFAULTS.revealDurationSeconds,
    dueDays: DEFAULTS.dueDays, graceDays: DEFAULTS.graceDays, formalNoticeDays: DEFAULTS.formalNoticeDays,
  };
}

/** The public-terms field a canonical terms field comes from, where the names differ (the others share the name). */
const PUBLIC_FIELD: Partial<Record<keyof SeriesTerms, string>> = { capMultipleWad: 'capMultiple', hurdleWad: 'hurdle' };

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
    const hurdleWad = wadFromDecimal(pub.hurdle);
    const units = BigInt(pub.unitsOffered);
    // Stage 1's create_series rules on the terms buildCreateSeries will send, with the terms it fills in, so a draft fails
    // here, per field, instead of at createSeries: a sealed raise's bounded parameters, units, reserve, minimum raise, a
    // wallet cap of at least one unit and the release schedule; a curve raise's units, reserve, threshold, zeros
    // (lockup, wallet cap, raise durations), USDC, schedule and bounds
    const onchain: BoundedTerms = {
      ...filledTerms(pub.raiseStyle),
      capMultipleWad: capWad.toString(), hurdleWad: hurdleWad.toString(), payoutMultipleK: pub.payoutMultipleK, lockupSeconds: lockupOf(pub), stablecoin: pub.stablecoin,
      unitsOffered: pub.unitsOffered, reservePrice: pub.reservePrice, minimumRaise: pub.minimumRaise, releaseSchedule: pub.releaseSchedule, raiseStyle: pub.raiseStyle,
    };
    for (const v of seriesTermsViolations(onchain)) issues.push({ field: PUBLIC_FIELD[v.field] ?? v.field, code: v.code, message: v.message });
    if (pub.tierFlags.tier4) issues.push({ field: 'tierFlags.tier4', code: 'switched-off', message: 'tier 4 self-attestation is switched off' });
    if (!isCommitmentCurrency(pub.reportingCurrency)) issues.push({ field: 'reportingCurrency', code: 'unsupported', message: `${pub.reportingCurrency} has no ISO-4217 numeric code in Stage 1's terms commitment` });
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
      // a caller that skipped the schema still gets a field issue: wadFromDecimal's error would end up a logged 500
      const share = shareRateWad(priv.shareRate);
      if (share === null) {
        issues.push({ field: 'shareRate', code: 'format', message: 'share rate must be a decimal between 0 and 1 with at most 18 places' });
      } else if (share > WAD) {
        // ratePerUnit enforces SPEC §1.5's r × units ≤ WAD and would refuse it: report the field instead
        issues.push({ field: 'shareRate', code: 'max', message: 'share rate cannot exceed 100%' });
      } else {
        // r is per accounting unit: per unit offered on a sealed raise, per base lamport on a curve (`rateUnits`: the
        // units offered × 10^6; Stage 1 registry lib.rs:594-600, B-C2)
        const r = units > 0n ? ratePerUnit(share, rateUnits({ unitsOffered: pub.unitsOffered, raiseStyle: pub.raiseStyle })) : 0n;
        ratePerUnitWad = r.toString();
        if (r <= 0n) issues.push({ field: 'shareRate', code: 'positive', message: 'share rate must be positive' });
      }
      // θ is a u64 input of Stage 1's circuit (SPEC §1.5)
      if (BigInt(priv.threshold) > U64_MAX) issues.push({ field: 'threshold', code: 'out-of-range', message: 'threshold must be below 2^64 base units' });
      if (!floor) issues.push({ field: 'threshold', code: 'no-floor-data', message: `no median-income data for ${pub.country} in ${pub.reportingCurrency}; the floor cannot be checked (ask Kunal for sources)` });
      else if (BigInt(priv.threshold) < floor.floor) issues.push({ field: 'threshold', code: 'below-floor', message: `threshold must be at least the local median full-time income (${floor.floor} ${pub.reportingCurrency} base units)` });
    }
    return { issues, derived: { capMultipleWad: capWad.toString(), hurdleWad: hurdleWad.toString(), ratePerUnitWad, thresholdFloor: floorStr, floorPlaceholder } };
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
    // Stage 1's terms commitment: Poseidon(5)(θ, r, ISO-4217 numeric currency, indexing rule code, field salt). The salt
    // is a field element, stored as a decimal string; `scheme` names the commitment for readers of the vault payload.
    const fields = { threshold: priv.threshold, ratePerUnitWad: derived.ratePerUnitWad!, reportingCurrency: pub.reportingCurrency, indexingRule: priv.indexingRule, termsSalt: randomFieldSalt().toString() };
    const commitment = commitTerms(fields);
    const privatePayload = JSON.stringify(vaultTermsPayload({ ...fields, shareRate: priv.shareRate }));
    const ciphertext = this.ctx.vault.encrypt(privatePayload, `terms:${draftId}`);
    // the indexing rule is a public rule name (the commitment hides θ and r, not the rule), so it is kept as metadata for the yearly indexing run (E9)
    const publicStored = { ...pub, lockupSeconds: lockupOf(pub), indexingRule: priv.indexingRule, capMultipleWad: derived.capMultipleWad, capMultipleDecimal: pub.capMultiple, hurdleWad: derived.hurdleWad, thresholdFloor: derived.thresholdFloor, floorPlaceholder: derived.floorPlaceholder };
    // the draft's commitment and the vault ciphertext must change together, or the stored terms stop matching the hash
    await withTransaction(this.ctx.pool, async (c) => {
      await c.query("update series_drafts set public_terms = $2, terms_commitment = $3, state = 'terms_set', updated_at = now() where draft_id = $1", [draftId, JSON.stringify(publicStored), commitment]);
      await c.query('insert into terms_vault (draft_id, ciphertext, key_id, commitment, version) values ($1,$2,$3,$4,1) on conflict (draft_id) do update set ciphertext = excluded.ciphertext, key_id = excluded.key_id, commitment = excluded.commitment, version = terms_vault.version + 1', [draftId, ciphertext, this.ctx.vault.keyId, commitment]);
    });
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
    // only Stage 1 (Poseidon) terms can be proven against: a draft whose vault payload predates the scheme is refused
    const vault = await this.ctx.pool.query<{ ciphertext: string }>('select ciphertext from terms_vault where draft_id = $1', [draftId]);
    const stored = vault.rows[0] ? (JSON.parse(this.ctx.vault.decrypt(vault.rows[0].ciphertext, `terms:${draftId}`)) as { scheme?: string }) : null;
    if (stored?.scheme !== TERMS_SCHEME) throw AppError.conflict(`the draft's terms predate the ${TERMS_SCHEME} commitment scheme and cannot be proven against; start a new draft`);
    const chain = this.ctx.chains.get(draft.chain);
    const info = await chain.info();
    const p = draft.public_terms as z.infer<typeof publicTermsSchema> & { capMultipleWad: string; hurdleWad: string };
    const coin = info.stablecoins[p.stablecoin];
    if (!coin) throw AppError.unprocessable('stablecoin no longer available on chain');
    // the fees, the wallet cap and the raise's own terms are filled in (Stage 1's 7-day commit and 2-day reveal on a
    // sealed raise; Stage 1's zeros on a curve raise, which has no auction and no wallet cap)
    const terms: SeriesTerms = {
      ...filledTerms(p.raiseStyle),
      stablecoin: p.stablecoin, stablecoinMint: coin.mint, unitsOffered: p.unitsOffered, reservePrice: p.reservePrice, minimumRaise: p.minimumRaise, capMultipleWad: p.capMultipleWad, lockupSeconds: lockupOf(p),
      releaseSchedule: p.releaseSchedule, hurdleWad: p.hurdleWad, payoutMultipleK: p.payoutMultipleK,
      contractHash: draft.contract_hash, termsCommitment: draft.terms_commitment, tierFlags: p.tierFlags, reportingCurrency: p.reportingCurrency, raiseStyle: p.raiseStyle,
    };
    const tx = await chain.build({ kind: 'createSeries', terms }, draft.issuer);
    return { tx, terms };
  }

  /** After the user signed and sent createSeries: link the draft to the series by matching the contract hash and commitment in the read model. */
  async linkCreated(draftId: string, session: Session): Promise<Record<string, unknown>> {
    const d = await this.getDraft(draftId, session);
    if (d.seriesId) {
      // repairs a vault row left unlinked by an earlier, non-atomic link (disclosure and indexing key on it)
      await this.ctx.pool.query('update terms_vault set series_id = $2 where draft_id = $1 and series_id is null', [draftId, d.seriesId]);
      return d;
    }
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
    // one transaction: a draft marked created with an unlinked vault would never be retried (linkCreated returns early)
    await withTransaction(this.ctx.pool, async (c) => {
      await c.query("update series_drafts set series_id = $2, state = 'created', updated_at = now() where draft_id = $1", [draftId, seriesId]);
      await c.query('update terms_vault set series_id = $2 where draft_id = $1', [draftId, seriesId]);
    });
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
    const fields = { threshold: newThreshold.toString(), ratePerUnitWad: plain.ratePerUnitWad!, reportingCurrency: plain.reportingCurrency!, indexingRule: plain.indexingRule!, termsSalt: randomFieldSalt().toString() };
    const newCommitment = commitTerms(fields);
    const amendmentId = this.ctx.newId('amend');
    const newPlain = { ...vaultTermsPayload({ ...fields, shareRate: plain.shareRate ?? '' }), indexedYear: year };
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
    const r = await this.ctx.pool.query('select a.*, v.ciphertext as old_ciphertext, v.draft_id as vdraft, d.chain from terms_amendments a join terms_vault v on v.series_id = a.series_id join series_drafts d on d.draft_id = a.draft_id where a.amendment_id = $1', [amendmentId]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('amendment');
    if (a.state !== 'proposed') throw AppError.conflict(`amendment is ${a.state}`);
    // A-M5-2: an attestor acts only with a wallet of theirs on the series' chain whose registration is onchain AND
    // indexed (the same registry every attestor path uses); the admin role does not stand in for it
    const port = this.ctx.chains.chains.get(a.chain);
    if (!port) throw AppError.unprocessable(`unknown chain ${a.chain}`);
    const wallet = normaliseAddress(attestorWallet, port.family);
    if (!attestor.wallets.some((w) => w.chain === a.chain && w.address === wallet)) throw AppError.forbidden(`attestor wallet must be linked to your account on ${a.chain}`);
    const indexed = await this.ctx.pool.query('select 1 from attestors where chain = $1 and attestor = $2 and active', [a.chain, wallet]);
    if (!indexed.rowCount) throw AppError.unprocessable(`${wallet} is not a registered attestor on ${a.chain}`);
    const oldT = JSON.parse(this.ctx.vault.decrypt(a.old_ciphertext, `terms:${a.vdraft}`)) as Record<string, string>;
    const newT = JSON.parse(this.ctx.vault.decrypt(a.ciphertext, `terms:${a.draft_id}`)) as Record<string, string>;
    const favourable = BigInt(newT.threshold!) >= BigInt(oldT.threshold!) && BigInt(newT.ratePerUnitWad!) <= BigInt(oldT.ratePerUnitWad!);
    if (approve && !favourable) throw AppError.unprocessable('amendment is not issuer-favourable; refusing to attest');
    const upd = await this.ctx.pool.query("update terms_amendments set state = $2, attestor = $3 where amendment_id = $1 and state = 'proposed'", [amendmentId, approve ? 'attested' : 'rejected', wallet]);
    if (!upd.rowCount) throw AppError.conflict('amendment was decided concurrently');
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
