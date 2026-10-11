import { z } from 'zod';
import { AppError, audit } from '@merces/core';
import { withTransaction } from '@merces/db';
import { CURVE_TERMS_ZEROS, DEFAULTS, INDEXING_RULE_CODE, NON_REVEAL_CHARGE_BOUNDS, NON_REVEAL_CHARGE_SETTING, amendDigest, currencyCodeOf, keyUsable, normaliseAddress, randomFieldSalt, rateUnits, recoverSigner, seriesTermsViolations, termsCommitment, type BoundedTerms, type ChainPort, type SeriesState, type SeriesTerms, type SigningRequest, type UnsignedTx } from '@merces/domain';
import { PARAMETER_BOUNDS, U64_MAX, WAD, ratePerUnit, wadFromDecimal, wadToDecimal } from '@merces/math';
import { isEligible, type Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { invalidAttestorSignature, requestFor, signingDomainOf } from '../signing-requests.ts';

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
  routerPublicConsent: z.boolean().default(false),
  fxPairId: z.string().regex(/^0x[0-9a-f]{64}$/).nullable().default(null),
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
  windowCommitDuration: z.number().int().nonnegative().default(DEFAULTS.windowCommitDuration),
  windowRevealDuration: z.number().int().nonnegative().default(DEFAULTS.windowRevealDuration),
  windowFeeBps: z.number().int().nonnegative().default(DEFAULTS.windowFeeBps),
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

/** An attestor key: a secp256k1 key's 20-byte address, any case (stored lowercase). */
const attestorKeySchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'an attestor key: a secp256k1 key\'s 20-byte address (0x + 40 hex)').transform((a) => a.toLowerCase());
/** A u64 nonce as a canonical decimal string (`SeriesState.nonces`). */
const nonceSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/, 'a nonce: a u64 as a decimal string').refine((x) => BigInt(x) <= U64_MAX, 'out of the u64 range');
/**
 * A 65-byte secp256k1 signature `r ‖ s ‖ v`, 0x hex in any case (stored lowercase). Shape only (S4 D8): a non-canonical
 * one recovers to nobody and is refused 422 with Stage 1's error name, as the chain would refuse it.
 */
const signature65Schema = z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'a 65-byte signature (0x + 130 hex)').transform((x) => x.toLowerCase());
/** The query of `GET /attestor/amendments/{amendmentId}/message`: the attestor key that will sign (S4 WP11). */
export const amendmentMessageQuerySchema = z.object({ attestor: attestorKeySchema }).strict();
/**
 * An attestor's decision on an amendment (S4 WP11). An approval carries the attestor key's Stage 1 AMEND signature over
 * the series' amendment nonce, the new terms commitment and the new cap multiple, made on the attestor's own device from
 * `GET .../message` and posted as the attestor tool prints it (`attestation: {signer, signature, digest?}`), with the
 * nonce it signed (`amendmentNonce`, the request's `fields.amendmentNonce`). A rejection needs no signature: the key the
 * attestor acts with and a code.
 */
export const amendmentAttestSchema = z.discriminatedUnion('approve', [
  z.object({ approve: z.literal(true), amendmentNonce: nonceSchema, attestation: z.object({ signer: attestorKeySchema, signature: signature65Schema, digest: z.string().regex(/^0x[0-9a-f]{64}$/).optional() }).strict() }).strict(),
  z.object({ approve: z.literal(false), attestor: attestorKeySchema, decisionCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a lowercase code such as not-favourable').optional() }).strict(),
]);

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
 * The terms `buildCreateSeries` fills in rather than the issuer: the fees, the wallet cap and the raise's phases. A curve
 * raise records Stage 1's zeros for the wallet cap and the raise durations (`CURVE_TERMS_ZEROS`): it has no auction and
 * no wallet cap at any stage (`CURVE_NO_CAP`). The non-reveal charge is the owner's (`nonRevealChargeOf`).
 */
function filledTerms(raiseStyle: 'sealed' | 'curve'): Pick<SeriesTerms, 'auctionFeeBps' | 'payoutFeeBps' | 'walletCapBps' | 'commitDurationSeconds' | 'revealDurationSeconds' | 'dueDays' | 'graceDays' | 'formalNoticeDays'> {
  const curve = raiseStyle === 'curve';
  return {
    auctionFeeBps: DEFAULTS.auctionFeeBps, payoutFeeBps: DEFAULTS.payoutFeeBps,
    walletCapBps: curve ? CURVE_TERMS_ZEROS.walletCapBps : DEFAULTS.walletCapBps,
    commitDurationSeconds: curve ? CURVE_TERMS_ZEROS.commitDurationSeconds : DEFAULTS.commitDurationSeconds,
    revealDurationSeconds: curve ? CURVE_TERMS_ZEROS.revealDurationSeconds : DEFAULTS.revealDurationSeconds,
    dueDays: DEFAULTS.dueDays, graceDays: DEFAULTS.graceDays, formalNoticeDays: DEFAULTS.formalNoticeDays,
  };
}

/** The 409 a sealed raise gets while the owner's non-reveal charge is unset: it names the setting, never a value. */
export const NON_REVEAL_CHARGE_UNSET = `the non-reveal charge for new series is not set: a sealed-bid raise cannot be created until the operator sets ${NON_REVEAL_CHARGE_SETTING} (whole bps, ${NON_REVEAL_CHARGE_BOUNDS.min} to ${NON_REVEAL_CHARGE_BOUNDS.max}; the owner's decision)`;

/**
 * The non-reveal charge a new series records: the owner's setting (`ServiceContext.nonRevealChargeBps`), as Stage 1's
 * chains copy the protocol default into every series at creation (Solana `merces_registry` lib.rs:550, EVM
 * `MercesRegistry.sol:597`); issuers cannot choose it. With the setting unset a sealed raise is refused (409,
 * `NON_REVEAL_CHARGE_UNSET`), so no sealed series goes live without the owner's decision; a curve raise, which has no
 * bids to charge, uses the finalized registry default on a live network. Simulators retain zero when unset.
 */
export function nonRevealChargeOf(raiseStyle: 'sealed' | 'curve', setting: number | null, chainInfo?: { mode: string; protocolDefaults?: { nonRevealChargeBps: number } }): number {
  if (setting !== null) return setting;
  if (raiseStyle === 'sealed') throw AppError.conflict(NON_REVEAL_CHARGE_UNSET, { setting: NON_REVEAL_CHARGE_SETTING });
  if (chainInfo?.mode === 'live') {
    const value = chainInfo.protocolDefaults?.nonRevealChargeBps;
    if (value === undefined || !Number.isInteger(value) || value < NON_REVEAL_CHARGE_BOUNDS.min || value > NON_REVEAL_CHARGE_BOUNDS.max) throw AppError.conflict('the live registry non-reveal charge is unavailable; refresh before creating a curve');
    return value;
  }
  return 0;
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
  async validate(chain: string, input: z.input<typeof publicTermsSchema>, priv: z.infer<typeof privateTermsSchema> | null, year: number): Promise<{ issues: ValidationIssue[]; derived: { capMultipleWad: string; hurdleWad: string; ratePerUnitWad: string | null; thresholdFloor: string | null; floorPlaceholder: boolean } }> {
    const pub = publicTermsSchema.parse(input);
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
    // (lockup, wallet cap, raise durations), USDC, schedule and bounds. The owner's non-reveal charge is within Stage 1's
    // bounds by construction (checked at startup); while it is unset the draft is checked without it, and the build
    // refuses a sealed raise (409)
    const onchain: BoundedTerms = {
      ...filledTerms(pub.raiseStyle),
      windowCommitDuration: pub.windowCommitDuration, windowRevealDuration: pub.windowRevealDuration, windowFeeBps: pub.windowFeeBps,
      ...(this.ctx.nonRevealChargeBps !== null ? { nonRevealChargeBps: this.ctx.nonRevealChargeBps } : {}),
      capMultipleWad: capWad.toString(), hurdleWad: hurdleWad.toString(), payoutMultipleK: pub.payoutMultipleK, lockupSeconds: lockupOf(pub), stablecoin: pub.stablecoin,
      unitsOffered: pub.unitsOffered, reservePrice: pub.reservePrice, minimumRaise: pub.minimumRaise, releaseSchedule: pub.releaseSchedule, raiseStyle: pub.raiseStyle,
    };
    for (const v of seriesTermsViolations(onchain)) issues.push({ field: PUBLIC_FIELD[v.field] ?? v.field, code: v.code, message: v.message });
    if (pub.fxPairId && port && !(await port.getRateAccumulator(pub.fxPairId))) issues.push({ field: 'fxPairId', code: 'unknown-pair', message: 'select a registered FX pair on this chain' });
    if (pub.tierFlags.tier1 && !pub.routerPublicConsent) issues.push({field:'routerPublicConsent',code:'consent-required',message:'Tier 1 publishes your threshold, share rate and routed receipts onchain. Explicit issuer consent is required.'});
    if (pub.tierFlags.tier1 && pub.reportingCurrency !== 'USD') issues.push({field:'reportingCurrency',code:'router-stablecoin',message:'Tier-1 routing requires stablecoin-denominated income'});
    if (pub.tierFlags.tier1 && pub.fxPairId) issues.push({ field: 'fxPairId', code: 'tier1-fx', message: 'the income router requires stablecoin-denominated terms with no FX pair' });
    if (pub.reportingCurrency !== 'USD' && !pub.fxPairId) issues.push({ field: 'fxPairId', code: 'required', message: 'non-USD reporting requires a registered FX pair' });
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
  async setTerms(draftId: string, session: Session, input: z.input<typeof publicTermsSchema>, priv: z.infer<typeof privateTermsSchema>): Promise<Record<string, unknown>> {
    const pub = publicTermsSchema.parse(input);
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
    const stored = vault.rows[0] ? (JSON.parse(this.ctx.vault.decrypt(vault.rows[0].ciphertext, `terms:${draftId}`)) as Partial<VaultTermsPayload>) : null;
    if (stored?.scheme !== TERMS_SCHEME) throw AppError.conflict(`the draft's terms predate the ${TERMS_SCHEME} commitment scheme and cannot be proven against; start a new draft`);
    const chain = this.ctx.chains.get(draft.chain);
    const info = await chain.info();
    const p = { ...draft.public_terms, ...publicTermsSchema.parse(draft.public_terms) } as z.infer<typeof publicTermsSchema> & { capMultipleWad: string; hurdleWad: string };
    const validation = await this.validate(draft.chain, p, null, new Date((await chain.now()) * 1000).getUTCFullYear());
    if (validation.issues.length) throw AppError.unprocessable('the draft terms are no longer valid', { issues: validation.issues });
    const coin = info.stablecoins[p.stablecoin];
    if (!coin) throw AppError.unprocessable('stablecoin no longer available on chain');
    // the fees, the wallet cap and the raise's own terms are filled in (Stage 1's 7-day commit and 2-day reveal on a
    // sealed raise; Stage 1's zeros on a curve raise, which has no auction and no wallet cap), and the owner's non-reveal
    // charge (a sealed raise is refused while it is unset)
    const terms: SeriesTerms = {
      fxPairId: p.fxPairId,
      ...filledTerms(p.raiseStyle),
      windowCommitDuration: p.windowCommitDuration, windowRevealDuration: p.windowRevealDuration, windowFeeBps: p.windowFeeBps,
      nonRevealChargeBps: nonRevealChargeOf(p.raiseStyle, this.ctx.nonRevealChargeBps, info),
      stablecoin: p.stablecoin, stablecoinMint: coin.mint, unitsOffered: p.unitsOffered, reservePrice: p.reservePrice, minimumRaise: p.minimumRaise, capMultipleWad: p.capMultipleWad, lockupSeconds: lockupOf(p),
      releaseSchedule: p.releaseSchedule, hurdleWad: p.hurdleWad, payoutMultipleK: p.payoutMultipleK,
      contractHash: draft.contract_hash, termsCommitment: draft.terms_commitment, tierFlags: p.tierFlags, reportingCurrency: p.reportingCurrency, raiseStyle: p.raiseStyle,
    };
    if (p.tierFlags.tier1) terms.routerTerms = {theta:stored.threshold!,rWad:stored.ratePerUnitWad!,currencyCode:stored.currencyCode!,indexingRule:stored.indexingRuleCode!,termsSalt:stored.termsSalt!};
    const tx = await chain.build({ kind: 'createSeries', terms }, draft.issuer);
    return { tx, terms };
  }

  /** Anchor the signed draft contract after EVM creation. The series id comes from its confirmed receipt. */
  async buildContractHash(draftId:string,seriesId:string,session:Session):Promise<{tx:UnsignedTx}> {
    const d=await this.getDraft(draftId,session);
    if(d.state!=='contract_signed')throw AppError.conflict('the draft contract must be signed');
    const chain=this.ctx.chains.get(String(d.chain)),s=await chain.getSeries(seriesId);
    if(!s || s.issuer!==d.issuer || s.terms.termsCommitment!==d.termsCommitment)throw AppError.conflict('the series does not match this signed draft');
    if(s.phase!=='Draft')throw AppError.conflict('contract hash can only change before the raise opens');
    return {tx:await chain.build({kind:'setContractHash',seriesId,contractHash:String(d.contractHash)},s.issuer)};
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
    return { amendmentId, seriesId, kind: 'inflation-index', year, inflationBps: ix.inflation_index_bps, placeholderIndex: ix.placeholder, newCommitment, state: 'proposed', note: 'A registered attestor key reviews the amendment (θ rises → owed falls) and signs Stage 1\'s AMEND message for it on its own device (GET /attestor/amendments/{amendmentId}/message, then POST /attestor/amendments/{amendmentId}/attest); then build the amendTerms transaction, which carries that signature.' };
  }

  async listAmendments(seriesId: string): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select amendment_id, kind, new_commitment, new_cap_multiple_wad, version, state, decision_code, attestor, amendment_nonce::text, digest, rationale_code, created_at, applied_at from terms_amendments where series_id = $1 order by created_at', [seriesId]);
    // the AMEND signature itself is never listed: until the chain accepted it, it appears in the issuer's built
    // transaction only (S4 amendment D2)
    return r.rows.map((x) => ({ amendmentId: x.amendment_id, kind: x.kind, newCommitment: x.new_commitment, newCapMultipleWad: x.new_cap_multiple_wad, version: x.version, state: x.state, decisionCode: x.decision_code ?? null, attestor: x.attestor, amendmentNonce: x.amendment_nonce ?? null, digest: x.digest ?? null, rationaleCode: x.rationale_code, createdAt: x.created_at, appliedAt: x.applied_at }));
  }

  /** The amendment with the series' vault (the private terms it replaces) and the draft's chain and issuer. */
  private async amendmentRow(amendmentId: string): Promise<Record<string, any>> {
    const r = await this.ctx.pool.query('select a.*, a.amendment_nonce::text as amendment_nonce, v.ciphertext as old_ciphertext, v.draft_id as vdraft, d.chain, d.account_id, d.issuer from terms_amendments a join terms_vault v on v.series_id = a.series_id join series_drafts d on d.draft_id = a.draft_id where a.amendment_id = $1', [amendmentId]);
    const a = r.rows[0];
    if (!a) throw AppError.notFound('amendment');
    return a;
  }

  /**
   * An attestor acts only with a key linked to their account (its own EIP-191 proof, read live) whose registration on the
   * series' chain is onchain AND indexed (A-M5-2, S4 WP7; the same registry every attestor path uses); the admin role
   * does not stand in for it.
   */
  private async requireActingKey(chain: string, key: string, session: Session): Promise<void> {
    if (!this.ctx.chains.chains.get(chain)) throw AppError.unprocessable(`unknown chain ${chain}`);
    const linked = await this.ctx.pool.query('select 1 from account_signer_keys where address = $1 and account_id = $2', [key, session.accountId]);
    if (!linked.rowCount) throw AppError.forbidden('the attestor key must be linked to your account');
    const indexed = await this.ctx.pool.query('select 1 from attestors where chain = $1 and attestor = $2 and active', [chain, key]);
    if (!indexed.rowCount) throw AppError.unprocessable(`${key} is not a registered attestor key on ${chain}`);
  }

  /** Favourability on the private terms (the attestor's review): θ non-decreasing, r non-increasing. */
  private favourable(a: Record<string, any>): boolean {
    const oldT = JSON.parse(this.ctx.vault.decrypt(a.old_ciphertext, `terms:${a.vdraft}`)) as Record<string, string>;
    const newT = JSON.parse(this.ctx.vault.decrypt(a.ciphertext, `terms:${a.draft_id}`)) as Record<string, string>;
    return BigInt(newT.threshold!) >= BigInt(oldT.threshold!) && BigInt(newT.ratePerUnitWad!) <= BigInt(oldT.ratePerUnitWad!);
  }

  /**
   * What the chain's `amend_terms` would refuse besides the signature, on the live series (S4 D8, the EVM's order;
   * MercesRegistry.sol:643-650): a terminal series (409 AmendmentAfterTerminal), a cap beyond u64 (422
   * AmountOutOfRange), and a cap above the live one or outside [2, 3] (422 UnfavourableAmendment; the chain checks it
   * after the signature, the service before any signature is asked for or kept).
   */
  private async amendableOnChain(a: Record<string, any>): Promise<{ chain: ChainPort; series: SeriesState; now: number }> {
    const chain = this.ctx.chains.get(String(a.chain));
    const [now, series] = await Promise.all([chain.now(), chain.getSeries(String(a.series_id))]);
    if (!series) throw AppError.notFound('series');
    if (['Retired', 'Redeemed', 'Extinguished'].includes(series.status)) throw new AppError(409, 'Conflict', `the series is ${series.status}: its terms can no longer be amended`, { stage1: 'AmendmentAfterTerminal' });
    const cap = BigInt(a.new_cap_multiple_wad);
    if (cap > U64_MAX) throw AppError.unprocessable('the cap multiple is out of the u64 range', { stage1: 'AmountOutOfRange' });
    const b = PARAMETER_BOUNDS.capMultipleWad;
    if (cap > BigInt(series.terms.capMultipleWad) || cap < b.min || cap > b.max) throw AppError.unprocessable('the cap multiple may only decrease, within [2, 3]: another amendment changed the series\' cap since this one was proposed', { stage1: 'UnfavourableAmendment' });
    return { chain, series, now };
  }

  private async amendRequestFor(chain: ChainPort, series: SeriesState, signer: string, a: Record<string, any>): Promise<SigningRequest<'AMEND'>> {
    const domain = await signingDomainOf(chain);
    return requestFor({ kind: 'AMEND', chain: chain.chain, seriesId: series.seriesId, seriesKey: series.seriesKey, domain, signer, fields: { amendmentNonce: series.nonces.amendment, termsCommitment: String(a.new_commitment), capMultipleWad: String(a.new_cap_multiple_wad) } });
  }

  /**
   * Attestor (a key linked to the caller's account and active on the series' chain, or an admin, read only): the signing
   * request for the amendment's AMEND signature (S4 WP11, D2): Stage 1's `MERCES_AMEND_V1` over the chain's signing
   * domain, the series key, the series' live amendment nonce, the new terms commitment and the new cap multiple, for
   * `attestor`. Only for a proposed amendment that is issuer-favourable on the private terms (422) and that the chain
   * would take now (`amendableOnChain`). The device rebuilds the message from the typed fields and signs it; the API never
   * signs. Public data only: the domain, the series key, the nonce, the commitment and the cap.
   */
  async amendmentMessage(amendmentId: string, session: Session, attestorKey: string): Promise<SigningRequest<'AMEND'>> {
    const a = await this.amendmentRow(amendmentId);
    if (a.state !== 'proposed') throw AppError.conflict(`amendment is ${a.state}`);
    if (session.roles.includes('admin')) {
      if (!this.ctx.chains.chains.get(a.chain)) throw AppError.unprocessable(`unknown chain ${a.chain}`);
    } else await this.requireActingKey(a.chain, attestorKey, session);
    if (!this.favourable(a)) throw AppError.unprocessable('amendment is not issuer-favourable; refusing to attest');
    const { chain, series } = await this.amendableOnChain(a);
    return this.amendRequestFor(chain, series, attestorKey, a);
  }

  /**
   * Attestor decision on a proposed amendment (A-M5-3: only the account holding the key, while the key is registered).
   *
   * Reject: the acting key and a code, no signature.
   *
   * Approve (S4 WP11, D2, D8): the key's Stage 1 AMEND signature, made on its own device. In order:
   *  1. the amendment is proposed, and the key (`attestation.signer`) acts for the caller (`requireActingKey`);
   *  2. the attestor's review: the new private terms are issuer-favourable (θ rises, r does not; 422 otherwise);
   *  3. the chain's checks before the signature (`amendableOnChain`: AmendmentAfterTerminal, the cap's range and bounds);
   *  4. the signature: the AMEND message rebuilt here from the chain's domain and series key with the nonce the attestor
   *     signed (`amendmentNonce`; a digest sent must equal it) recovers to the key, and the key is active on the chain
   *     (no grace for an AMEND): 422 `detail.stage1` InvalidAttestorSignature otherwise;
   *  5. the nonce read again from the chain must still be the one signed: 409 `stale-nonce` with a fresh signing request
   *     (`detail.request`) otherwise (another amendment landed; the signature is dead on the chain).
   * The row records the key, the nonce, the digest and the signature (`attested`), for the issuer's `amendTerms`. The
   * signature is an authorisation only the issuer can use (`amend_terms` is the issuer's): until the chain accepts it, it
   * appears in the issuer's built transaction only, never in a list, the activity feed, a notification or the audit log
   * (S4 amendment D2); the response names the key, the nonce and the digest.
   */
  async attestAmendment(amendmentId: string, attestor: Session, input: z.infer<typeof amendmentAttestSchema>): Promise<Record<string, unknown>> {
    const a = await this.amendmentRow(amendmentId);
    if (a.state !== 'proposed') throw AppError.conflict(`amendment is ${a.state}`);
    const key = input.approve ? input.attestation.signer : input.attestor;
    await this.requireActingKey(a.chain, key, attestor);
    const favourable = this.favourable(a);
    if (!input.approve) {
      const decisionCode = input.decisionCode ?? 'declined';
      const upd = await this.ctx.pool.query("update terms_amendments set state = 'rejected', attestor = $2, decision_code = $3 where amendment_id = $1 and state = 'proposed'", [amendmentId, key, decisionCode]);
      if (!upd.rowCount) throw AppError.conflict('amendment was decided concurrently');
      await audit(this.ctx.pool, { actor: attestor.accountId, actorRole: 'attestor', action: 'amendment.reject', target: amendmentId, detail: { favourable, attestor: key, decisionCode } });
      return { amendmentId, state: 'rejected', favourable, attestor: key, decisionCode };
    }
    if (!favourable) throw AppError.unprocessable('amendment is not issuer-favourable; refusing to attest');
    const { chain, series, now } = await this.amendableOnChain(a);
    // Stage 1's AMEND message, rebuilt here from the chain's own domain and series key (never the caller's digest)
    const domain = await signingDomainOf(chain);
    const { digest } = amendDigest({ domain: domain.domain, seriesKey: series.seriesKey }, { amendmentNonce: input.amendmentNonce, termsCommitment: String(a.new_commitment), capMultipleWad: String(a.new_cap_multiple_wad) });
    if (input.attestation.digest !== undefined && input.attestation.digest !== digest) throw invalidAttestorSignature('the attestation\'s digest is not this amendment\'s AMEND message on this chain (another series, chain, nonce, commitment or cap)');
    if (recoverSigner(digest, input.attestation.signature) !== key) throw invalidAttestorSignature('the signature does not recover to the named attestor key over Stage 1\'s AMEND message for this nonce, commitment and cap on this chain');
    const k = await chain.getSignerKey('attestor', key);
    if (!k || !keyUsable(k, now)) throw invalidAttestorSignature('the attestor key is not active on this chain: an amendment needs an active key');
    // the nonce read again: another amendment landed since the signing request, and the chain would refuse the signature
    const again = await chain.getSeries(String(a.series_id));
    if (!again) throw AppError.notFound('series');
    if (again.nonces.amendment !== input.amendmentNonce) {
      const fresh = await this.amendRequestFor(chain, again, key, a).catch(() => null);
      throw new AppError(409, 'Conflict', 'the series\' amendment nonce moved since this was signed (another amendment landed): the signature is dead; sign the fresh request', { reason: 'stale-nonce', liveAmendmentNonce: again.nonces.amendment, request: fresh });
    }
    const upd = await this.ctx.pool.query(
      "update terms_amendments set state = 'attested', attestor = $2, amendment_nonce = $3, digest = $4, attestor_signature = $5, decision_code = null where amendment_id = $1 and state = 'proposed'",
      [amendmentId, key, input.amendmentNonce, digest, input.attestation.signature],
    );
    if (!upd.rowCount) throw AppError.conflict('amendment was decided concurrently');
    await audit(this.ctx.pool, { actor: attestor.accountId, actorRole: 'attestor', action: 'amendment.attest', target: amendmentId, detail: { favourable, signer: key, amendmentNonce: input.amendmentNonce, digest } });
    return { amendmentId, state: 'attested', favourable, attestor: key, amendmentNonce: input.amendmentNonce, digest };
  }

  /** An attested amendment whose signature died onchain goes back to awaiting an attestor (S4 WP11), with the reason. */
  private async backToProposed(amendmentId: string, reason: string): Promise<void> {
    await this.ctx.pool.query(
      "update terms_amendments set state = 'proposed', attestor = null, amendment_nonce = null, digest = null, attestor_signature = null, decision_code = $2 where amendment_id = $1 and state in ('attested', 'submitted')",
      [amendmentId, reason],
    );
  }

  /**
   * Issuer: Stage 1's `amendTerms` for an attested amendment, carrying the attestor key's AMEND signature (S4 WP11; nobody
   * co-signs). Built again while it is `submitted` and not yet amended onchain (an unsigned transaction is idempotent).
   * Before building it reads the chain: an amendment that already landed is 409 `already-amended` (apply it); a terminal
   * series is 409 AmendmentAfterTerminal; a nonce that moved since the signature (another amendment landed) is
   * 409 `stale-nonce`, and a key no longer active is 409 `attestor-key-inactive`: either way the signature is dead, and
   * the amendment goes back to awaiting an attestor (`proposed`, with the reason as its decision code).
   */
  async buildAmendTerms(amendmentId: string, session: Session): Promise<{ tx: UnsignedTx }> {
    const a = await this.amendmentRow(amendmentId);
    if (a.account_id !== session.accountId) throw AppError.forbidden();
    if (a.state !== 'attested' && a.state !== 'submitted') throw AppError.conflict(`amendment is ${a.state}; it needs an attestor first`);
    if (!a.attestor_signature || a.amendment_nonce === null) throw AppError.conflict('amendment has no AMEND signature: an attestor key must sign it first');
    const chain = this.ctx.chains.get(String(a.chain));
    const [now, series] = await Promise.all([chain.now(), chain.getSeries(String(a.series_id))]);
    if (!series) throw AppError.notFound('series');
    // an amendment that landed (the chain's live commitment, or an indexed TermsAmended carrying it) is never sent back
    const landed = series.terms.termsCommitment === a.new_commitment
      || !!(await this.ctx.pool.query("select 1 from events where series_id = $1 and type = 'TermsAmended' and payload->>'termsCommitment' = $2 limit 1", [a.series_id, a.new_commitment])).rowCount;
    if (landed) throw new AppError(409, 'Conflict', 'the chain already carries this amendment: apply it', { reason: 'already-amended' });
    if (['Retired', 'Redeemed', 'Extinguished'].includes(series.status)) throw new AppError(409, 'Conflict', `the series is ${series.status}: its terms can no longer be amended`, { stage1: 'AmendmentAfterTerminal' });
    if (series.nonces.amendment !== a.amendment_nonce) {
      await this.backToProposed(amendmentId, 'stale-nonce');
      throw new AppError(409, 'Conflict', 'another amendment landed since the attestor signed: the AMEND signature is dead; the amendment awaits an attestor again', { reason: 'stale-nonce', liveAmendmentNonce: series.nonces.amendment });
    }
    const k = await chain.getSignerKey('attestor', String(a.attestor));
    if (!k || !keyUsable(k, now)) {
      await this.backToProposed(amendmentId, 'attestor-key-inactive');
      throw new AppError(409, 'Conflict', 'the attestor key that signed is no longer active on this chain: the AMEND signature is dead; the amendment awaits an attestor again', { reason: 'attestor-key-inactive', stage1: 'InvalidAttestorSignature' });
    }
    const opening = series.terms.tierFlags.tier1 ? JSON.parse(this.ctx.vault.decrypt(String(a.ciphertext), `terms:${a.draft_id}`)) as VaultTermsPayload : null;
    const routerTerms = opening ? {theta:opening.threshold,rWad:opening.ratePerUnitWad,currencyCode:opening.currencyCode,indexingRule:opening.indexingRuleCode,termsSalt:opening.termsSalt} : undefined;
    const tx = await chain.build({ kind: 'amendTerms', ...(routerTerms ? {routerTerms} : {}), seriesId: String(a.series_id), termsCommitment: String(a.new_commitment), capMultipleWad: String(a.new_cap_multiple_wad), attestor: String(a.attestor), signature: String(a.attestor_signature) }, String(a.issuer));
    await this.ctx.pool.query("update terms_amendments set state = 'submitted' where amendment_id = $1 and state in ('attested', 'submitted')", [amendmentId]);
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
