import { z } from 'zod';
import { AppError, audit, enqueueOutbox } from '@merces/core';
import {
  ChainError, E2E_REFUSAL_TEXT, E2E_TIER3_OPENING, PAUSE_APPROVAL_MESSAGE, expectedPrior, extinguishDigest, fxDigest, hex32ToField, keyUsable, noPauseApprovable, parseE2eEnvelope, pauseApprovalRefusal, pauseDigest,
  readsAsText, recoverSigner, reportDigest, reportProofSchema, type ChainPort, type PauseApprovalRule, type SeriesState, type SigningRequest, type UnsignedTx,
} from '@merces/domain';
import { U64_MAX, parsePeriod, periodFrom, toPid } from '@merces/math';
import { withTransaction } from '@merces/db';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { curveRegularReport, reportUnits, requireCensusFor, requireCensusUnchanged } from '../curve-census.ts';
import { invalidAttestorSignature, requestFor, signingDomainOf } from '../signing-requests.ts';

/**
 * E10 — attestor service (R10, R16, R26, C8.5–6, C11.6).
 * An attestor is a secp256k1 key, its 20-byte address on every chain (S4 D4, WP7), linked to an account by the key's
 * own EIP-191 proof (`account_signer_keys`). An account acts as attestor on a chain through a linked key that the chain
 * has registered (`getSignerKey('attestor', …)`) and the indexer shows active there (`attestors`), read live on every
 * request (A-M5-2). Work is addressed to a key; nobody else's key or chain stands in for it.
 * This service tracks the work that needs an attestor's signature and builds the transactions they sign:
 *  - hardship pauses: the issuer's reason and evidence reach the chosen attestor as END-TO-END ciphertext the
 *    server stores opaque and never decrypts; holders only ever see statuses and dates; the attestor's own device signs
 *    Stage 1's PAUSE message over the series' live pause nonce (S4 WP10), and the keeper relays it (`approve_pause` is
 *    permissionless); the issuer can withdraw its request (`build-withdraw`);
 *  - tier-3 cases: the issuer's device proves the report; the documents and the income opening reach the attestor
 *    as E2E ciphertext (M7); the attestor's own device signs Stage 1's REPORT message with tier 3 over the commitments
 *    (S4 WP9), which the API hands it as a signing request; the client-side prefill specification (R26 — the server
 *    extracts nothing); the annual true-up as amounts and a deadline;
 *  - FX fallback requests the keeper opened (C9): the attestor's device signs Stage 1's FX message for the rate once per
 *    affected series (the message binds the series key; S4 WP9, D14), the service checks and stores the signatures;
 *  - extinguishment (C11.6): two attestor keys held by two different accounts (S4 D15) each sign Stage 1's
 *    EXTINGUISH message over the series' live extinguish nonce on their own devices (S4 WP12); once both are in, the
 *    keeper relays `extinguish` (permissionless).
 * No income figure, document or reason is ever at rest or in a log. Decision fields are codes.
 * The backend never signs (S4 D2, no custody): it builds signing requests from the chain's own reads (`ChainInfo.signing`,
 * `SeriesState.seriesKey`, `SeriesState.nonces`), which the attestor's device rebuilds and checks before it signs, and it
 * recovers and checks every signature it is sent. Every onchain action is returned as an UnsignedTx for the issuer, except
 * a checked pause approval and a checked pair of extinguishment signatures, which the keeper relays (S4 D3: keepers send
 * only permissionless commands).
 */

const money = z.string().regex(/^\d+$/, 'money must be a non-negative integer string in base units');
const code = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a lowercase code such as insufficient-evidence');
const periodId = z.string().regex(/^\d{4}Q[1-4]$/);
const keyHint = z.string().max(200).nullable().default(null);
/** request bodies are capped at 2 MB by the gateway */
const ciphertext = z.string().min(1).max(1_900_000);

/** An attestor key: a secp256k1 key's 20-byte address, any case; the canonical form is lowercase (S4 D4, WP7). */
const attestorKey = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'an attestor key: a secp256k1 key\'s 20-byte address (0x + 40 hex)').transform((a) => a.toLowerCase());

export const hardshipRequestSchema = z.object({ until: z.number().int().positive(), attestor: attestorKey, ciphertext, keyHint });
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
/**
 * A pause end (unix seconds) as a canonical decimal string: what Stage 1's PAUSE message and `approve_pause` take. Beyond
 * u64 is refused 422 AmountOutOfRange (as the chain refuses it first), not by the schema.
 */
const pauseEnd = z.string().regex(/^(0|[1-9]\d{0,77})$/, 'a pause end: unix seconds as a decimal string');
/** A u64 nonce as a canonical decimal string (`SeriesState.nonces`). */
const nonce = z.string().regex(/^(0|[1-9]\d{0,19})$/, 'a nonce: a u64 as a decimal string').refine((x) => BigInt(x) <= U64_MAX, 'out of the u64 range');
/**
 * A 65-byte secp256k1 signature `r ‖ s ‖ v`, 0x hex in any case (stored lowercase). Shape only (S4 D8): a non-canonical
 * one recovers to nobody and is refused 422 with Stage 1's error name, as the chain would refuse it.
 */
const signature65 = z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'a 65-byte signature (0x + 130 hex)').transform((x) => x.toLowerCase());
/** The query of `GET /attestor/hardship/{hardshipId}/message`: the end the attestor's PAUSE signature will bind. */
export const hardshipMessageQuerySchema = z.object({ pauseEnd }).strict();
/**
 * A hardship decision (S4 WP10). An approval carries the request's attestor key's Stage 1 PAUSE signature over the
 * series' pause nonce and `pauseEnd`, made on the attestor's own device from `GET .../message` and posted as the
 * attestor tool prints it (`attestation: {signer, signature, digest?}`), with the nonce it signed (`pauseNonce`, the
 * request's `fields.pauseNonce`). The keeper relays it. A rejection needs no signature: a code only.
 */
export const hardshipDecideSchema = z.discriminatedUnion('approve', [
  z.object({ approve: z.literal(true), pauseEnd, pauseNonce: nonce, attestation: z.object({ signer: attestorKey, signature: signature65, digest: hex32.optional() }).strict() }).strict(),
  z.object({ approve: z.literal(false), decisionCode: code.optional() }).strict(),
]);
/**
 * Tier 3 (critique M7). The issuer's device proves the report; the attestor checks the income commitment against the
 * documents with the opening (year-to-date figure and salt, and the prior's), which the issuer's device seals end to
 * end for the attestor in a merces-e2e v1 envelope (`openingCiphertext`, opaque here; anything that does not parse as
 * one is refused). The attestor's signature carries the commitments, the proof and the attestation only: never a
 * figure, a salt or an opening.
 */
export const tier3OpenSchema = z.object({ attestor: attestorKey, documentsCiphertext: ciphertext, openingCiphertext: ciphertext, keyHint, estimatePaymentStable: money }).strict();
/** The query of `GET /attestor/tier3/{caseId}/message`: the fields the attestor's REPORT signature will bind. */
export const tier3MessageQuerySchema = z.object({ priorIncomeCommitment: hex32, incomeCommitment: hex32, liquidityEvent: z.enum(['true', 'false']).transform((v) => v === 'true') }).strict();
export const tier3SignSchema = z.object({
  priorIncomeCommitment: hex32,
  incomeCommitment: hex32,
  liquidityEvent: z.boolean(),
  /** the issuer's proof (Stage 1 Groth16; the payment is its public input 5) */
  proof: reportProofSchema,
  /**
   * The case attestor key's Stage 1 REPORT signature with tier 3 over the chain's signing domain, the series key and these
   * fields (S4 WP9), as the attestor tool returns it (`merces-attestor sign`); its `digest`, when sent, must be the
   * message's. The service recomputes the digest from the chain's own reads and recovers the signer.
   */
  attestation: z.object({ signer: attestorKey, signature: signature65, digest: hex32.optional() }).strict(),
}).strict();
export const tier3AnnualOpenSchema = z.object({ year: z.number().int().min(2026).max(2100), attestor: attestorKey, documentsCiphertext: ciphertext, keyHint });
export const tier3AnnualSignSchema = z.object({ totalPaymentStable: money });
/** A positive u64 rate (WAD) as a canonical decimal string: what Stage 1's FX message signs (`fx_avg_wad`). */
const rateWad = z.string().regex(/^[1-9]\d{0,19}$/, 'a positive integer (WAD)').refine((x) => BigInt(x) <= U64_MAX, 'out of the u64 range');
/** The query of `GET /attestor/fx-requests/{requestId}/messages`: the rate, and the key (optional when the caller holds one). */
export const fxMessagesQuerySchema = z.object({ rateWad, attestor: attestorKey.optional() }).strict();
/**
 * An FX fallback signed per series (S4 WP9, D14): the key's Stage 1 FX signature over each affected series' key, the
 * period and `rateWad`, made on the attestor's device from `GET .../messages`.
 */
export const fxSignSchema = z.object({
  rateWad,
  signer: attestorKey,
  sourceNote: code,
  signatures: z.array(z.object({ seriesId: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/), signature: signature65 }).strict()).min(1).max(500),
}).strict();
/**
 * Opening an extinguishment (S4 WP12): `attestor` is the caller's own key, `coAttestor` a second attestor key held by
 * another account (S4 D15), and the evidence is E2E ciphertext for them. No signature yet: each named key signs the
 * request's EXTINGUISH message afterwards (`GET .../message`, `POST .../sign`).
 */
export const extinguishSchema = z.object({ seriesId: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9]+$/), attestor: attestorKey, coAttestor: attestorKey, evidenceCiphertext: ciphertext, keyHint }).strict();
/** The query of `GET /attestor/extinguish/{requestId}/message`: the named key to sign (optional when the caller holds one that has not signed). */
export const extinguishMessageQuerySchema = z.object({ attestor: attestorKey.optional() }).strict();
/**
 * One named key's EXTINGUISH signature (S4 WP12), made on its own device from `GET .../message` and posted as the
 * attestor tool prints it, with the nonce it signed (the request's `fields.extinguishNonce`).
 */
export const extinguishSignSchema = z.object({ extinguishNonce: nonce, attestation: z.object({ signer: attestorKey, signature: signature65, digest: hex32.optional() }).strict() }).strict();

/**
 * A Stage 1 pause-approval refusal as an API error: Stage 1's name in `detail.stage1` and a message naming the rule and
 * the protocol bound, never a date. A running pause is a 409 (the series' state), the bounds a 422.
 */
function pauseRefusal(rule: PauseApprovalRule): AppError {
  return new AppError(rule === 'AlreadyPaused' ? 409 : 422, rule === 'AlreadyPaused' ? 'Conflict' : 'Unprocessable', PAUSE_APPROVAL_MESSAGE[rule], { stage1: rule });
}

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

/** File signatures of documents that were encoded instead of encrypted: PDF, ZIP (docx, xlsx), PNG, JPEG, gzip. */
const FILE_MAGIC = [Buffer.from('%PDF-'), Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0x1f, 0x8b, 0x08])];

/**
 * Every way the server can read the value as bytes: hex (bare, either case, or `0x`-prefixed) and base64 (Node's
 * decoder takes base64url too). A bare hex string is also valid base64, so both readings are checked.
 */
function decodings(v: string): Buffer[] {
  const out: Buffer[] = [];
  const hex = v.startsWith('0x') ? v.slice(2) : v;
  if (hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) out.push(Buffer.from(hex, 'hex'));
  if (!v.startsWith('0x')) out.push(Buffer.from(v, 'base64'));
  return out;
}

function encodedPlaintext(b: Buffer): boolean {
  const text = b.toString('utf8');
  return parsesAsJsonObject(text) || PLAINTEXT_WORDS.test(text) || readsAsText(b) || FILE_MAGIC.some((m) => b.subarray(0, m.length).equals(m));
}

/**
 * The server cannot prove a blob is encrypted, but it refuses anything that is evidently not: plaintext, JSON (with a
 * `reason` field or otherwise), and an encoding of either in hex, base64 or base64url (S1 review: bare hex was decoded
 * as base64 only, so hex-encoded plaintext passed), or of a document file. Real E2E ciphertext is base64/base64url/hex
 * and decodes to bytes that read as neither text nor a file. Messages name the field, never the value. A tier-3 opening
 * must be a merces-e2e v1 envelope instead (`assertTier3OpeningEnvelope`).
 */
export function assertOpaqueCiphertext(value: string, field: string): void {
  const v = value.trim();
  if (v.length < 24) throw AppError.unprocessable(`${field} is too short to be ciphertext`);
  if (parsesAsJsonObject(v)) throw AppError.unprocessable(`${field} is plaintext JSON; encrypt it end-to-end for the attestor`);
  if (!/^(0x[0-9a-fA-F]+|[A-Za-z0-9+/=_-]+)$/.test(v)) throw AppError.unprocessable(`${field} must be end-to-end ciphertext (base64, base64url or hex), not plaintext`);
  if (PLAINTEXT_WORDS.test(v)) throw AppError.unprocessable(`${field} looks like plaintext; encrypt it end-to-end for the attestor`);
  if (decodings(v).some(encodedPlaintext)) throw AppError.unprocessable(`${field} is only encoded, not encrypted; encrypt it end-to-end for the attestor`);
}

/**
 * A tier-3 opening carries two year-to-date figures and two salts, so the guess above is not enough (M7): it must be
 * a merces-e2e v1 envelope (`@merces/domain` `e2e-envelope.ts`: version byte, ephemeral X25519 public key, nonce,
 * AES-256-GCM ciphertext and tag, in canonical base64) of an opening's size, as `@merces/poi-device`
 * `sealTier3Opening` produces. Anything else is refused, whatever its encoding. The message gives the reason only.
 */
export function assertTier3OpeningEnvelope(value: string): void {
  const r = parseE2eEnvelope(value, E2E_TIER3_OPENING);
  if (!r.ok) throw AppError.unprocessable(`openingCiphertext must be a merces-e2e v1 envelope sealed for the attestor: ${E2E_REFUSAL_TEXT[r.code]}`, { field: 'openingCiphertext', code: `e2e-${r.code}` });
}

const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
const str = (x: unknown): string | null => (x === null || x === undefined ? null : String(x));

/** One linked key on one chain: whether the indexer shows it active there. */
interface KeyRef {
  chain: string;
  address: string;
  registeredOnchain: boolean;
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

  /**
   * The indexed onchain registry decides who is an attestor (A-M5-2): a key counts only while its registration is
   * indexed and active on that chain. Work can only be addressed to such a key, and every read or decision on an item
   * checks the addressed key itself on the item's chain, so another chain's registration never stands in for it.
   */
  private async activeIndexed(chain: string, address: string): Promise<boolean> {
    const r = await this.ctx.pool.query('select 1 from attestors where chain = $1 and attestor = $2 and active', [chain, address]);
    return !!r.rowCount;
  }

  private async requireRegisteredAttestor(chain: ChainPort, attestor: string): Promise<void> {
    if (!(await this.activeIndexed(chain.chain, attestor))) throw AppError.unprocessable(`${attestor} is not a registered attestor key on ${chain.chain}`);
  }

  /** Key `address` is linked to the session's account (its own EIP-191 proof; read live, never from the token). */
  private async linked(session: Session, address: string): Promise<boolean> {
    const r = await this.ctx.pool.query('select 1 from account_signer_keys where address = $1 and account_id = $2', [address, session.accountId]);
    return !!r.rowCount;
  }

  /** The session's account holds key `address` and the key is an active, indexed attestor on `chain` (A-M5-2). */
  private async actsAs(session: Session, chain: string, address: string): Promise<boolean> {
    return (await this.linked(session, address)) && (await this.activeIndexed(chain, address));
  }

  /** Every key linked to the session's account, on every chain of this deployment, with its indexed registration there. */
  private async registeredKeys(session: Session): Promise<KeyRef[]> {
    const r = await this.ctx.pool.query<{ address: string; chain: string; active: boolean | null }>(
      'select k.address, c.chain, t.active from account_signer_keys k cross join unnest($2::text[]) as c(chain) left join attestors t on t.chain = c.chain and t.attestor = k.address where k.account_id = $1 order by k.address, c.chain',
      [session.accountId, [...this.ctx.chains.chains.keys()]],
    );
    return r.rows.map((x) => ({ chain: x.chain, address: x.address, registeredOnchain: x.active === true }));
  }

  /**
   * Work filters: a registered attestor sees work addressed to one of their keys on a chain where that key is active
   * (`pairs`), and the unaddressed work (FX requests, amendments) of those chains; an admin sees all.
   */
  private async scope(session: Session): Promise<{ pairs: { chains: string[]; addresses: string[] } | null; chains: string[] | null; keys: KeyRef[] }> {
    const keys = await this.registeredKeys(session);
    if (session.roles.includes('admin')) return { pairs: null, chains: null, keys };
    const regs = keys.filter((k) => k.registeredOnchain);
    return { pairs: { chains: regs.map((k) => k.chain), addresses: regs.map((k) => k.address) }, chains: [...new Set(regs.map((k) => k.chain))], keys };
  }

  // ------------------------------------------------------------------ queue and profile

  async queue(session: Session): Promise<Record<string, unknown>> {
    const { pairs, chains } = await this.scope(session);
    const p = this.ctx.pool;
    // (chain, key) pairs where the key is linked and active: $1 chains, $2 keys (null for an admin: everything)
    const inPairs = (chainCol: string, keyCol: string) => `($1::text[] is null or (${chainCol}, ${keyCol}) in (select c, k from unnest($1::text[], $2::text[]) as t(c, k)))`;
    const pc = pairs?.chains ?? null;
    const pk = pairs?.addresses ?? null;
    const hardship = await p.query(`select hardship_id, series_id, chain, attestor, requested_until, created_at from hardship_requests where state = $3 and ${inPairs('chain', 'attestor')} order by created_at`, [pc, pk, 'pending']);
    const tier3 = await p.query(`select case_id, series_id, chain, period_id, attestor, estimate_payment_stable, created_at from tier3_cases where state = $3 and ${inPairs('chain', 'attestor')} order by created_at`, [pc, pk, 'open']);
    const annual = await p.query(`select annual_id, series_id, chain, year, attestor, created_at from tier3_annual where state = $3 and ${inPairs('chain', 'attestor')} order by created_at`, [pc, pk, 'open']);
    const fx = await p.query('select request_id, chain, pair, period_id, reason, created_at from fx_fallback_requests where state = $2 and ($1::text[] is null or chain = any($1::text[])) order by created_at', [chains, 'open']);
    const amendments = await p.query('select a.amendment_id, a.series_id, s.chain, a.kind, a.version, a.rationale_code, a.created_at from terms_amendments a join series s on s.series_id = a.series_id where a.state = $2 and ($1::text[] is null or s.chain = any($1::text[])) order by a.created_at', [chains, 'proposed']);
    // open extinguishments naming one of the caller's keys (collecting signatures, or ready and awaiting the relay)
    const ext = await p.query(`select request_id, series_id, chain, attestors, state, signatures, created_at from extinguishment_requests e where state = any($3::text[]) and ($1::text[] is null or exists (select 1 from unnest(e.attestors) as x(a) where ${inPairs('e.chain', 'x.a')})) order by created_at`, [pc, pk, ['collecting', 'ready']]);
    return {
      hardship: hardship.rows.map((r) => ({ hardshipId: r.hardship_id, seriesId: r.series_id, chain: r.chain, attestor: r.attestor, requestedUntil: Number(r.requested_until), createdAt: r.created_at })),
      tier3: tier3.rows.map((r) => ({ caseId: r.case_id, seriesId: r.series_id, chain: r.chain, periodId: r.period_id, attestor: r.attestor, estimatePaymentStable: r.estimate_payment_stable, createdAt: r.created_at })),
      tier3Annual: annual.rows.map((r) => ({ annualId: r.annual_id, seriesId: r.series_id, chain: r.chain, year: r.year, attestor: r.attestor, createdAt: r.created_at })),
      fxRequests: fx.rows.map((r) => ({ requestId: r.request_id, chain: r.chain, pair: r.pair, periodId: r.period_id, reason: r.reason, createdAt: r.created_at })),
      amendments: amendments.rows.map((r) => ({ amendmentId: r.amendment_id, seriesId: r.series_id, chain: r.chain, kind: r.kind, version: r.version, rationaleCode: r.rationale_code, createdAt: r.created_at })),
      extinguishments: ext.rows.map((r) => ({ requestId: r.request_id, seriesId: r.series_id, chain: r.chain, attestors: r.attestors, state: r.state, signers: signersOf(r.signatures), createdAt: r.created_at })),
    };
  }

  /** The account's linked keys with their registration flag on each chain, and the open work counts. */
  async me(session: Session): Promise<Record<string, unknown>> {
    const { keys } = await this.scope(session);
    const q = await this.queue(session);
    const count = (k: string) => (q[k] as unknown[]).length;
    return { accountId: session.accountId, roles: session.roles, keys, openWork: { hardship: count('hardship'), tier3: count('tier3'), tier3Annual: count('tier3Annual'), fxRequests: count('fxRequests'), amendments: count('amendments'), extinguishments: count('extinguishments') } };
  }

  // ------------------------------------------------------------------ hardship (R16, C8)

  private async hardshipRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from hardship_requests where hardship_id = $1', [id]);
    const h = r.rows[0];
    if (!h) throw AppError.notFound('hardship request');
    return h;
  }

  /**
   * The record as the issuer and the attestor see it (never holders). Ciphertext only when `withCiphertext` (the chosen
   * attestor's or an admin's view). The approval (the PAUSE signature the keeper relayed, S4 WP10) is shown with the
   * ciphertext and in the decision's own response; it is stored only once the chain accepted it, so it is public data
   * (an unrelayed PAUSE signature is never at rest: S4 amendment D2).
   */
  private hardshipView(h: Record<string, unknown>, withCiphertext: boolean, withApproval = withCiphertext): Record<string, unknown> {
    return {
      hardshipId: h.hardship_id, seriesId: h.series_id, chain: h.chain, attestor: h.attestor, state: h.state, requestedUntil: Number(h.requested_until), approvedUntil: num(h.approved_until),
      decisionCode: h.decision_code ?? null, keyHint: h.key_hint ?? null, createdAt: h.created_at, decidedAt: h.decided_at ?? null, pauseNonce: str(h.pause_nonce),
      ...(withApproval ? { approval: h.approval ?? null, relayTx: h.relay_tx ?? null } : {}),
      ...(withCiphertext ? { ciphertext: h.ciphertext } : {}),
    };
  }

  /** Issuer: open a private hardship review and get the requestPause transaction to sign. */
  async requestHardship(seriesId: string, session: Session, input: z.infer<typeof hardshipRequestSchema>): Promise<Record<string, unknown> & { tx: UnsignedTx }> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    assertOpaqueCiphertext(input.ciphertext, 'ciphertext');
    const attestor = input.attestor;
    await this.requireRegisteredAttestor(chain, attestor);
    const now = await chain.now();
    if (input.until <= now) throw AppError.unprocessable('the pause end must be in the future');
    if (series.phase !== 'Settled') throw AppError.conflict('the series has not settled');
    if (['Retired', 'Redeemed', 'Extinguished', 'Paused'].includes(series.status)) throw AppError.conflict(`cannot request a pause while ${series.status}`);
    // The requested end stays advisory (Stage 1's request_pause carries none; the attestor approves the actual end within
    // Stage 1's bounds). A request no approval could satisfy is refused before the issuer sends it: the series has used
    // all its pauses, or its cumulative limit leaves no time (S1 review).
    const exhausted = noPauseApprovable(series.pauses, now);
    if (exhausted) throw pauseRefusal(exhausted);
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

  /**
   * Issuer: the `withdrawPauseRequest` transaction (Stage 1 `withdraw_pause_request`, S4 WP10, D12) for the series' pending
   * onchain request, to sign and send. 409 PauseNotRequested when none is pending. Once it lands the pause nonce has
   * moved, so any PAUSE signature collected for the request is dead, and the indexer marks the pending hardship request
   * withdrawn (`PauseRequestWithdrawn`). Also how an issuer clears an onchain request whose hardship request was rejected.
   */
  async buildWithdrawPause(seriesId: string, session: Session): Promise<{ seriesId: string; pauseNonce: string; tx: UnsignedTx }> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    if (!series.pauses.requested) throw new AppError(409, 'Conflict', 'no pause request is pending onchain for this series', { stage1: 'PauseNotRequested' });
    const tx = await chain.build({ kind: 'withdrawPauseRequest', seriesId }, series.issuer);
    return { seriesId, pauseNonce: series.nonces.pause, tx };
  }

  /** Attestor (the chosen one, or an admin): the ciphertext and the series' onchain pause state. */
  async getHardship(id: string, session: Session): Promise<Record<string, unknown>> {
    const h = await this.hardshipRow(id);
    if (!(await this.actsAs(session, String(h.chain), String(h.attestor))) && !session.roles.includes('admin')) throw AppError.forbidden('this request was addressed to another attestor key, or that key is not linked to your account or not active on its chain');
    const series = await this.ctx.chains.get(String(h.chain)).getSeries(String(h.series_id));
    return { ...this.hardshipView(h, true), seriesStatus: series?.status ?? null, pause: series?.pause ?? null, pauses: series?.pauses ?? null, livePauseNonce: series?.nonces.pause ?? null };
  }

  /**
   * The checks an approval for `pauseEnd` must pass on the chain's pause record before anything is signed or relayed, in
   * Stage 1's spirit (range first, as the chains check it): a u64 end (422 AmountOutOfRange), at or before the requested
   * end (422), a request pending onchain (409 PauseNotRequested), then `pauseApprovalRefusal` (A-REV-23).
   */
  private async approvableHardship(h: Record<string, unknown>, pauseEndText: string): Promise<{ chain: ChainPort; series: SeriesState; now: number; until: number }> {
    const end = BigInt(pauseEndText);
    if (end > U64_MAX) throw AppError.unprocessable('the pause end is out of the u64 range', { stage1: 'AmountOutOfRange' });
    if (end > BigInt(Number(h.requested_until))) throw AppError.unprocessable('the approved end cannot be after the requested end');
    const until = Number(end);
    const chain = this.ctx.chains.get(String(h.chain));
    const [now, series] = await Promise.all([chain.now(), chain.getSeries(String(h.series_id))]);
    if (!series) throw AppError.notFound('series');
    // Stage 1's approve_pause, in its order (S4 D8; SIM:1284-1297), on the chain's pause record, before anything is signed
    // or recorded: a pending request onchain (PauseNotRequested), then pauseApprovalError (the end in the future, no
    // running pause, at most a year, two years in total, 16 pauses). A refusal leaves the request pending, so the attestor
    // can decide again with an end the chain accepts, or reject it (S1 review).
    if (!series.pauses.requested) throw new AppError(409, 'Conflict', 'the issuer has not sent requestPause onchain yet, or withdrew it', { stage1: 'PauseNotRequested' });
    const refusal = pauseApprovalRefusal(series.pauses, now, until);
    if (refusal) throw pauseRefusal(refusal);
    return { chain, series, now, until };
  }

  /**
   * Attestor (the request's key holder, or an admin): the signing request for the approval's PAUSE signature (S4 WP10,
   * D2): Stage 1's `MERCES_PAUSE_V1` over the chain's signing domain, the series key, the series' live pause nonce and
   * `pauseEnd`, for the request's key. Only for an end the chain would take now (`approvableHardship`). The device
   * rebuilds the message from the typed fields, warns that the signature cannot be recalled (anyone holding it can submit
   * it while the nonce stands), and signs; the API never signs. Public data only: the domain, the series key, the nonce
   * and the end.
   */
  async hardshipMessage(id: string, session: Session, q: z.infer<typeof hardshipMessageQuerySchema>): Promise<SigningRequest<'PAUSE'>> {
    const h = await this.hardshipRow(id);
    if (!(await this.actsAs(session, String(h.chain), String(h.attestor))) && !session.roles.includes('admin')) throw AppError.forbidden('this request was addressed to another attestor key, or that key is not linked to your account or not active on its chain');
    if (h.state !== 'pending') throw AppError.conflict(`hardship request is ${h.state}`);
    const { chain, series } = await this.approvableHardship(h, q.pauseEnd);
    return this.pauseRequestFor(chain, series, String(h.attestor), q.pauseEnd);
  }

  private async pauseRequestFor(chain: ChainPort, series: SeriesState, signer: string, pauseEndText: string): Promise<SigningRequest<'PAUSE'>> {
    const domain = await signingDomainOf(chain);
    return requestFor({ kind: 'PAUSE', chain: chain.chain, seriesId: series.seriesId, seriesKey: series.seriesKey, domain, signer, fields: { pauseNonce: series.nonces.pause, pauseEnd: pauseEndText } });
  }

  /**
   * Attestor decision (only the account holding the request's key, while the key is registered; A-M5-3).
   *
   * Reject: a code, no signature; the onchain request stays until the issuer withdraws it (`build-withdraw`).
   *
   * Approve (S4 WP10, D2, D3, D8): the key's Stage 1 PAUSE signature, made on its own device, relayed by the keeper
   * (`approve_pause` is permissionless). In order:
   *  1. the key acts for the caller and the request is pending;
   *  2. the end on the chain's pause record (`approvableHardship`: u64, ≤ the requested end, PauseNotRequested,
   *     `pauseApprovalRefusal`);
   *  3. the signature: the PAUSE message rebuilt here from the chain's domain and series key with the nonce the attestor
   *     signed (`pauseNonce`; a digest sent must equal it) recovers to the request's key, and the key is active on the
   *     chain (no grace for a PAUSE): 422 `detail.stage1` InvalidAttestorSignature otherwise;
   *  4. the nonce read again from the chain must still be the one signed: 409 `stale-nonce` with a fresh signing request
   *     (`detail.request`) otherwise (the issuer requested again or withdrew; the signature is dead on the chain);
   *  5. the keeper submits `approvePause` (`ChainPort.submit`), the row locked meanwhile. A chain refusal is returned with
   *     its canonical code and Stage 1's name and leaves the request pending (A-REV-23); nothing is recorded.
   * On success the row records `approval {signer, signature, digest, pauseNonce, pauseEnd}`, `pause_nonce` and the relay
   * transaction. The API never signs, and an unrelayed PAUSE signature is never stored (S4 amendment D2).
   */
  async decideHardship(id: string, session: Session, input: z.infer<typeof hardshipDecideSchema>): Promise<Record<string, unknown> & { relayTx: string | null }> {
    const h = await this.hardshipRow(id);
    if (!(await this.actsAs(session, String(h.chain), String(h.attestor)))) throw AppError.forbidden('only the account holding the chosen attestor key, while the key is registered, can decide this request');
    if (h.state !== 'pending') throw AppError.conflict(`hardship request is ${h.state}`);
    const seriesId = String(h.series_id);
    if (!input.approve) {
      const decisionCode = input.decisionCode ?? 'declined';
      const upd = await this.ctx.pool.query("update hardship_requests set state = 'rejected', decision_code = $2, decided_by = $3, decided_at = now() where hardship_id = $1 and state = 'pending'", [id, decisionCode, session.accountId]);
      if (!upd.rowCount) throw AppError.conflict('hardship request was decided concurrently');
      await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'hardship.reject', target: id, detail: { seriesId, decisionCode } });
      await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'hardship.rejected', seriesId, hardshipId: id });
      return { ...this.hardshipView(await this.hardshipRow(id), false), relayTx: null };
    }
    const attestor = String(h.attestor);
    const { chain, series, now, until } = await this.approvableHardship(h, input.pauseEnd);
    // Stage 1's PAUSE message, rebuilt here from the chain's own domain and series key (never the caller's digest)
    const domain = await signingDomainOf(chain);
    const { digest } = pauseDigest({ domain: domain.domain, seriesKey: series.seriesKey }, { pauseNonce: input.pauseNonce, pauseEnd: input.pauseEnd });
    if (input.attestation.digest !== undefined && input.attestation.digest !== digest) throw invalidAttestorSignature('the attestation\'s digest is not this request\'s PAUSE message on this chain (another series, chain, nonce or end)');
    if (input.attestation.signer !== attestor) throw invalidAttestorSignature('the approval must be signed by this request\'s attestor key');
    if (recoverSigner(digest, input.attestation.signature) !== attestor) throw invalidAttestorSignature('the signature does not recover to this request\'s attestor key over Stage 1\'s PAUSE message for this nonce and end on this chain');
    const key = await chain.getSignerKey('attestor', attestor);
    if (!key || !keyUsable(key, now)) throw invalidAttestorSignature('the attestor key is not active on this chain: a pause approval needs an active key');
    // the nonce read again: a re-request or a withdrawal since the signing request moved it, and the chain would take the
    // signature over no request
    const live = await chain.getSeries(seriesId);
    if (!live) throw AppError.notFound('series');
    if (live.nonces.pause !== input.pauseNonce) {
      const fresh = live.pauses.requested ? await this.pauseRequestFor(chain, live, attestor, input.pauseEnd) : null;
      throw new AppError(409, 'Conflict', 'the series\' pause nonce moved since this was signed (the issuer requested again or withdrew): the signature is dead; sign the fresh request', { reason: 'stale-nonce', livePauseNonce: live.nonces.pause, request: fresh });
    }
    const signature = input.attestation.signature;
    const approval = { signer: attestor, signature, digest, pauseNonce: input.pauseNonce, pauseEnd: input.pauseEnd };
    const relayTx = await withTransaction(this.ctx.pool, async (db) => {
      const locked = (await db.query('select state from hardship_requests where hardship_id = $1 for update', [id])).rows[0];
      if (!locked || locked.state !== 'pending') throw AppError.conflict(`hardship request is ${locked?.state ?? 'gone'}`);
      // the keeper relays the attestor's signature: approve_pause is permissionless (S4 D3); a chain refusal throws here
      // (its canonical code, Stage 1's name) and the transaction rolls back, leaving the request pending
      const res = await chain.submit({ kind: 'approvePause', seriesId, pauseEnd: input.pauseEnd, attestor, signature }, 'keeper');
      await db.query(
        "update hardship_requests set state = 'approved', approved_until = $2, decision_code = 'approved', decided_by = $3, decided_at = now(), pause_nonce = $4, approval = $5, relay_tx = $6 where hardship_id = $1",
        [id, until, session.accountId, input.pauseNonce, JSON.stringify(approval), res.txId],
      );
      await audit(db, { actor: session.accountId, actorRole: 'attestor', action: 'hardship.approve', target: id, detail: { seriesId, until, signer: attestor, pauseNonce: input.pauseNonce, digest, relayTx: res.txId } });
      await enqueueOutbox(db, 'notification', { kind: 'hardship.approved', seriesId, hardshipId: id, until });
      return res.txId;
    });
    return { ...this.hardshipView(await this.hardshipRow(id), false, true), relayTx };
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
      caseId: c.case_id, seriesId: c.series_id, chain: c.chain, periodId: c.period_id, attestor: c.attestor, state: c.state, decisionCode: c.decision_code ?? null, estimatePaymentStable: str(c.estimate_payment_stable), attestedPaymentStable: str(c.attested_payment_stable),
      priorIncomeCommitment: c.prior_income_commitment ?? null, incomeCommitment: c.income_commitment ?? null, liquidityEvent: c.liquidity_event, keyHint: c.key_hint ?? null, createdAt: c.created_at, signedAt: c.signed_at ?? null,
      attestation: caseAttestation(c.attestation),
      ...(withCiphertext ? { documentsCiphertext: c.documents_ciphertext, openingCiphertext: c.opening_ciphertext ?? null } : {}),
    };
  }

  private async requireCaseAttestor(session: Session, c: Record<string, unknown>): Promise<void> {
    if (!(await this.actsAs(session, String(c.chain), String(c.attestor))) && !session.roles.includes('admin')) throw AppError.forbidden('this case was addressed to another attestor key, or that key is not linked to your account or not active on its chain');
  }

  /**
   * Issuer: open a tier-3 case for a completed quarter with E2E-encrypted documents and income opening for the attestor,
   * and the issuer's own estimate. On a curve series the issuer's proof is over the curve's census, so the case opens
   * only once a census was taken after the period ended (409 CurveUnitsNotSynced with the sync step; S3 WP9).
   */
  async openTier3Case(seriesId: string, periodId: string, session: Session, input: z.infer<typeof tier3OpenSchema>): Promise<Record<string, unknown>> {
    const { chain, series } = await this.seriesForIssuer(seriesId, session);
    if (!series.terms.tierFlags.tier3) throw AppError.conflict('tier 3 is not enabled for this series');
    const period = parsePeriod(periodId);
    const now = await chain.now();
    if (period.end > now) throw AppError.conflict('the period has not ended');
    requireCensusFor(series, periodId);
    assertOpaqueCiphertext(input.documentsCiphertext, 'documentsCiphertext');
    assertTier3OpeningEnvelope(input.openingCiphertext);
    const attestor = input.attestor;
    await this.requireRegisteredAttestor(chain, attestor);
    const dup = await this.ctx.pool.query("select case_id, state from tier3_cases where series_id = $1 and period_id = $2 and state in ('open','signed')", [seriesId, periodId]);
    if (dup.rows[0]) throw AppError.conflict(`a tier-3 case for ${periodId} is already ${dup.rows[0].state} (${dup.rows[0].case_id})`);
    const id = this.ctx.newId('t3c');
    await this.ctx.pool.query(
      'insert into tier3_cases (case_id, series_id, chain, period_id, issuer, account_id, attestor, documents_ciphertext, opening_ciphertext, key_hint, estimate_payment_stable) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, seriesId, chain.chain, periodId, series.issuer, session.accountId, attestor, input.documentsCiphertext, input.openingCiphertext, input.keyHint, input.estimatePaymentStable],
    );
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'tier3.case-opened', seriesId, periodId, caseId: id, attestor });
    return this.caseView(await this.caseRow(id), false);
  }

  async getTier3Case(id: string, session: Session): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    await this.requireCaseAttestor(session, c);
    const series = await this.ctx.chains.get(String(c.chain)).getSeries(String(c.series_id));
    // the units the issuer's proof must be over (a curve series: its census, taken when `unitsSyncedAt` says)
    return { ...this.caseView(c, true), reportingCurrency: series?.terms.reportingCurrency ?? null, unitsOutstanding: series ? reportUnits(series) : null, unitsSyncedAt: series?.unitsSyncedAt ?? null, termsCommitment: series?.terms.termsCommitment ?? null };
  }

  /**
   * R26 / Part J.5 default: extraction happens on the attestor's device. This is the specification of what to
   * pull from the decrypted documents and how to turn it into the attested payment. The server never sees a figure.
   */
  async prefillSpec(id: string, session: Session): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    await this.requireCaseAttestor(session, c);
    const series = await this.ctx.chains.get(String(c.chain)).getSeries(String(c.series_id));
    const period = parsePeriod(String(c.period_id));
    const currency = series?.terms.reportingCurrency ?? 'USD';
    return {
      version: 'tier3-prefill/v1',
      extraction: 'client-side',
      caseId: id, seriesId: c.series_id, periodId: period.id,
      period: { start: period.start, end: period.end, year: period.year, quarter: period.quarter, coverage: 'calendar year to date through the period end' },
      currency, unit: 'currency base units (6 decimals)',
      termsCommitment: series?.terms.termsCommitment ?? null,
      note: 'Decrypt the documents and the income opening on your device, extract these fields locally and check the issuer\'s commitments and proof there. Send the API only the commitments, the proof and your signature; never a figure, a salt, an opening or a document.',
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
      opening: {
        ciphertext: 'openingCiphertext (GET /attestor/tier3/{caseId}): merces/tier3-opening/v1 {seriesId, periodId, incomeYtd, incomeSalt, priorIncomeYtd, priorSalt, priorIncomeCommitment, incomeCommitment}, sealed by the issuer\'s device for your X25519 key in a merces-e2e v1 envelope (purpose merces/tier3-opening/v1; @merces/poi-device openTier3Opening)',
      },
      checks: [
        `documented year-to-date income: the sum of included fields in ${currency} base units for ${period.year} through ${new Date(period.end * 1000).toISOString().slice(0, 10)}`,
        'Poseidon(2)(incomeYtd, incomeSalt) = incomeCommitment and Poseidon(2)(priorIncomeYtd, priorSalt) = priorIncomeCommitment (SPEC §1.5; ZERO = Poseidon(2)(0, 0) at a year start)',
        'incomeYtd = max(documented year-to-date income, priorIncomeYtd): the high-water rule (SPEC §1.5)',
        'priorIncomeCommitment is the one the chain expects (GET /series/{seriesId}/reporting/prior)',
        'the issuer\'s Groth16 proof verifies (GET /prover/artifacts) over [termsCommitment, units outstanding, FX average, priorIncomeCommitment, incomeCommitment, payment]; the payment is its public input 5',
      ],
      liquidityEvent: 'true when the documents show a sale of the business or equity (C3)',
      sign: `GET /attestor/tier3/${id}/message?priorIncomeCommitment&incomeCommitment&liquidityEvent returns Stage 1's MERCES_REPORT_V1 signing request with tier 3 for your key; sign it on your own device with the Merces attestor tool (merces-attestor sign), which rebuilds the message from its typed fields against your pinned networks before it signs`,
      next: `POST /attestor/tier3/${id}/sign with { priorIncomeCommitment, incomeCommitment, liquidityEvent, proof, attestation: { signer, signature, digest } }`,
    };
  }

  /**
   * Attestor (the case's key holder, or an admin): the signing request for the case's REPORT signature with tier 3 (S4
   * WP9, D2), over the chain's signing domain and the series key, for the commitments and liquidity flag the attestor
   * checked on their device. The prior must be the one the chain expects (422 otherwise, nothing to sign). The device
   * rebuilds the message from the typed fields before it signs; the API never signs. Public data only: commitments, the
   * period, the tier and the flag.
   */
  async tier3Message(id: string, session: Session, q: z.infer<typeof tier3MessageQuerySchema>): Promise<SigningRequest<'REPORT'>> {
    const c = await this.caseRow(id);
    await this.requireCaseAttestor(session, c);
    if (c.state !== 'open') throw AppError.conflict(`tier-3 case is ${c.state}`);
    const chain = this.ctx.chains.get(String(c.chain));
    const series = await chain.getSeries(String(c.series_id));
    if (!series) throw AppError.notFound('series');
    const periodId = String(c.period_id);
    const prior = this.expectedPriorFor(series, periodId, q.priorIncomeCommitment);
    if (prior !== q.priorIncomeCommitment) throw AppError.unprocessable('the prior income commitment does not chain from the last accepted report', { expectedPrior: prior });
    const domain = await signingDomainOf(chain);
    return requestFor({ kind: 'REPORT', chain: chain.chain, seriesId: series.seriesId, seriesKey: series.seriesKey, domain, signer: String(c.attestor), fields: { periodId, priorIncomeCommitment: q.priorIncomeCommitment, incomeCommitment: q.incomeCommitment, tier: 3, liquidityEvent: q.liquidityEvent } });
  }

  /** The prior the chain will require for `periodId` (SPEC §6.2 step 5) from the series' reporting ledger, or `supplied`. */
  private expectedPriorFor(series: SeriesState, periodId: string, supplied: string): string {
    const rep = series.reporting;
    const pidOrNull = (p: string | null) => (p === null ? null : toPid(p));
    return expectedPrior({ lastAcceptedPeriod: pidOrNull(rep.lastAcceptedPeriod), lastIncomePeriod: pidOrNull(rep.lastIncomePeriod), lastIncomeCommitment: rep.lastIncomeCommitment }, toPid(periodId), supplied);
  }

  /**
   * Attestor: sign the quarter's commitments and the issuer's proof; the issuer then assembles the tier-3 report (E5),
   * which carries this signature (S4 WP9; nobody co-signs). Checked here: the proof is over the series' live terms
   * commitment, its units and the prior the chain expects, and verifies; the attestation is Stage 1's REPORT signature
   * with tier 3 over the chain's signing domain and the series key (recomputed here from the chain's own reads), it
   * recovers to the case's attestor key, and that key is usable on the chain for the quarter (active, or revoked after the
   * quarter ended and within the 45-day grace): 422 `detail.stage1` InvalidAttestorSignature otherwise, as the chain would
   * refuse it. On a curve series the units are the census (S3 WP9): 409 CurveUnitsNotSynced while it predates the
   * period's end (sync first), 409 `census-changed` for a proof over another count (the issuer proves again).
   */
  async signTier3Case(id: string, session: Session, input: z.infer<typeof tier3SignSchema>): Promise<Record<string, unknown>> {
    const c = await this.caseRow(id);
    if (!(await this.actsAs(session, String(c.chain), String(c.attestor)))) throw AppError.forbidden('only the account holding the chosen attestor key, while the key is registered, can sign this case');
    if (c.state !== 'open') throw AppError.conflict(`tier-3 case is ${c.state}`);
    const chain = this.ctx.chains.get(String(c.chain));
    const series = await chain.getSeries(String(c.series_id));
    if (!series) throw AppError.notFound('series');
    const periodId = String(c.period_id);
    const prior = this.expectedPriorFor(series, periodId, input.priorIncomeCommitment);
    if (prior !== input.priorIncomeCommitment) throw AppError.unprocessable('the prior income commitment does not chain from the last accepted report', { expectedPrior: prior });
    const signals = input.proof.publicInputs;
    requireCensusFor(series, periodId);
    if (curveRegularReport(series)) requireCensusUnchanged(series, signals[1], 're-prove');
    const units = reportUnits(series);
    let bound = false;
    try {
      bound = signals[0] === hex32ToField(series.terms.termsCommitment).toString() && signals[1] === BigInt(units).toString() && signals[3] === hex32ToField(input.priorIncomeCommitment).toString() && signals[4] === hex32ToField(input.incomeCommitment).toString();
    } catch {
      bound = false;
    }
    if (!bound) throw AppError.unprocessable('the proof is not over this series\' terms commitment and units, or these commitments');
    if (!this.ctx.proofVerifier.systems.includes(input.proof.system)) throw AppError.unprocessable(`proof system ${input.proof.system} is not accepted`);
    if (!(await this.ctx.proofVerifier.verify(input.proof.proof, signals))) throw AppError.unprocessable('proof does not verify');
    // Stage 1's REPORT message with tier 3, rebuilt here from the chain's domain and series key (never the caller's digest)
    const domain = await signingDomainOf(chain);
    const { digest } = reportDigest({ domain: domain.domain, seriesKey: series.seriesKey }, { periodId, priorIncomeCommitment: input.priorIncomeCommitment, incomeCommitment: input.incomeCommitment, tier: 3, liquidityEvent: input.liquidityEvent });
    if (input.attestation.digest !== undefined && input.attestation.digest !== digest) throw invalidAttestorSignature('the attestation\'s digest is not this case\'s REPORT message on this chain (another series, chain, period, commitment, tier or liquidity flag)');
    const attestor = String(c.attestor);
    if (input.attestation.signer !== attestor) throw invalidAttestorSignature('the attestation must be signed by this case\'s attestor key');
    if (recoverSigner(digest, input.attestation.signature) !== attestor) throw invalidAttestorSignature('the signature does not recover to this case\'s attestor key over Stage 1\'s REPORT message for these fields on this chain');
    const key = await chain.getSignerKey('attestor', attestor);
    if (!key || !keyUsable(key, await chain.now(), { reportPeriod: periodId })) throw invalidAttestorSignature('the attestor key is not usable on this chain for this quarter');
    const paymentStable = signals[5]!;
    const attestation = { signer: attestor, signature: input.attestation.signature, digest };
    const upd = await this.ctx.pool.query(
      "update tier3_cases set state = 'signed', attested_payment_stable = $2, prior_income_commitment = $3, income_commitment = $4, liquidity_event = $5, proof = $6, attestation = $7, decision_code = null, signed_at = now() where case_id = $1 and state = 'open'",
      [id, paymentStable, input.priorIncomeCommitment, input.incomeCommitment, input.liquidityEvent, JSON.stringify(input.proof), JSON.stringify(attestation)],
    );
    if (!upd.rowCount) throw AppError.conflict('tier-3 case was signed concurrently');
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'tier3.sign', target: id, detail: { seriesId: c.series_id, periodId, paymentStable, liquidityEvent: input.liquidityEvent, signer: attestor, digest } });
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
      annualId: a.annual_id, seriesId: a.series_id, chain: a.chain, year: a.year, attestor: a.attestor, state: a.state, decisionCode: a.decision_code ?? null, totalPaymentStable: str(a.total_payment_stable), estimatedPaymentStable: str(a.estimated_payment_stable),
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
    const attestor = input.attestor;
    await this.requireRegisteredAttestor(chain, attestor);
    // one live attestation a year: a withdrawn one (superseded-s4, migration 025) no longer holds it
    const dup = await this.ctx.pool.query("select annual_id from tier3_annual where series_id = $1 and year = $2 and state <> 'withdrawn'", [seriesId, input.year]);
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
    if (!(await this.actsAs(session, String(a.chain), String(a.attestor))) && !session.roles.includes('admin')) throw AppError.forbidden('this attestation was addressed to another attestor key, or that key is not linked to your account or not active on its chain');
    return this.annualView(a, true);
  }

  /**
   * Attestor: the attested payment for the year against the sum of the year's accepted quarterly payments
   * (the share paid on estimate: paymentDue − accrual + split receipts, from the read model). Overpayment is a
   * credit to the next period; underpayment is due within 60 days with no accrual (A-C8-3). Amounts only.
   */
  async signAnnual(id: string, session: Session, input: z.infer<typeof tier3AnnualSignSchema>): Promise<Record<string, unknown>> {
    const a = await this.annualRow(id);
    if (!(await this.actsAs(session, String(a.chain), String(a.attestor)))) throw AppError.forbidden('only the account holding the chosen attestor key, while the key is registered, can sign this attestation');
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

  // ------------------------------------------------------------------ FX fallback (C9; Stage 1's FX signature, S4 WP9)

  private fxView(r: Record<string, unknown>): Record<string, unknown> {
    return { requestId: r.request_id, chain: r.chain, pair: r.pair, periodId: r.period_id, reason: r.reason, state: r.state, decisionCode: r.decision_code ?? null, attestor: r.attestor ?? null, rateWad: str(r.rate_wad), sourceNote: r.source_note ?? null, createdAt: r.created_at, signedAt: r.signed_at ?? null };
  }

  private async fxRequestRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from fx_fallback_requests where request_id = $1', [id]);
    if (!r.rows[0]) throw AppError.notFound('fx fallback request');
    return r.rows[0];
  }

  private async fxSignatures(requestId: string): Promise<{ seriesId: string; signer: string; rateWad: string; signature: string; digest: string; signedAt: unknown }[]> {
    const r = await this.ctx.pool.query('select series_id, signer, rate_wad, signature, digest, signed_at from fx_fallback_signatures where request_id = $1 order by series_id', [requestId]);
    return r.rows.map((x) => ({ seriesId: x.series_id, signer: x.signer, rateWad: String(x.rate_wad), signature: x.signature, digest: x.digest, signedAt: x.signed_at }));
  }

  /**
   * The series an FX fallback request covers (S4 D14): on the request's chain, reporting in the pair's base currency,
   * reporting since the period at the latest (settled, with a first period at or before it), not terminal (Retired and
   * Extinguished take no report; a Redeemed series still reports its tail), and without an accepted report for the period.
   * Each needs its own signature, because Stage 1's FX message binds the series key. Read from the indexed series.
   */
  private async fxAffectedSeries(req: Record<string, unknown>): Promise<string[]> {
    const base = String(req.pair).split('/')[0]!;
    const r = await this.ctx.pool.query<{ series_id: string }>(
      `select s.series_id from series s
        where s.chain = $1 and s.reporting_currency = $2 and s.first_period is not null and s.first_period <= $3 and s.status not in ('Retired', 'Extinguished')
          and not exists (select 1 from periods p where p.series_id = s.series_id and p.period_id = $3 and p.report_accepted)
        order by s.series_id`,
      [req.chain, base, req.period_id],
    );
    return r.rows.map((x) => x.series_id);
  }

  /** The covered series still without a signature for this request (all of them while it is open). */
  private async fxUnsigned(req: Record<string, unknown>): Promise<string[]> {
    const signed = new Set((await this.fxSignatures(String(req.request_id))).map((x) => x.seriesId));
    return (await this.fxAffectedSeries(req)).filter((x) => !signed.has(x));
  }

  async listFxRequests(session: Session): Promise<Record<string, unknown>[]> {
    const { chains } = await this.scope(session);
    const r = await this.ctx.pool.query("select * from fx_fallback_requests where state = 'open' and ($1::text[] is null or chain = any($1::text[])) order by created_at", [chains]);
    return r.rows.map((x) => this.fxView(x));
  }

  /**
   * The key an attestor signs an FX fallback with: `named` when given (linked to the caller and active on the chain, 403
   * otherwise), else the caller's one linked key active there (422 when there are several: name one).
   */
  private async fxSigner(session: Session, chain: string, named: string | undefined): Promise<string> {
    if (named !== undefined) {
      if (!(await this.actsAs(session, chain, named))) throw AppError.forbidden('the attestor key must be linked to your account and registered on the request\'s chain');
      return named;
    }
    const keys = (await this.registeredKeys(session)).filter((k) => k.chain === chain && k.registeredOnchain).map((k) => k.address);
    if (keys.length === 0) throw AppError.forbidden('none of your linked keys is a registered attestor on the request\'s chain');
    if (keys.length > 1) throw AppError.unprocessable('you hold several attestor keys on this chain: name one (attestor)', { keys });
    return keys[0]!;
  }

  /**
   * Attestor: the signing requests for an FX fallback rate (S4 WP9, D14): Stage 1's `MERCES_FX_V1` over the chain's signing
   * domain, each covered series' key, the period and `rateWad`, one per series still without a signature (all of them
   * while the request is open). Once a rate is signed it is the period's rate (409 `rate-fixed` for another one): later
   * requests only add the series that started reporting since. The device rebuilds each message before it signs.
   */
  async fxMessages(id: string, session: Session, q: z.infer<typeof fxMessagesQuerySchema>): Promise<Record<string, unknown>> {
    const req = await this.fxRequestRow(id);
    if (req.state !== 'open' && req.state !== 'signed') throw AppError.conflict(`fx fallback request is ${String(req.state)}`);
    if (req.state === 'signed' && String(req.rate_wad) !== q.rateWad) throw AppError.conflict('the period\'s fallback rate is already signed: sign the same rate for the remaining series', { reason: 'rate-fixed', rateWad: String(req.rate_wad) });
    const chain = this.ctx.chains.get(String(req.chain));
    const signer = await this.fxSigner(session, chain.chain, q.attestor);
    const domain = await signingDomainOf(chain);
    const requests: SigningRequest<'FX'>[] = [];
    for (const seriesId of await this.fxUnsigned(req)) {
      const series = await chain.getSeries(seriesId);
      if (!series) continue;
      requests.push(requestFor({ kind: 'FX', chain: chain.chain, seriesId, seriesKey: series.seriesKey, domain, signer, fields: { periodId: String(req.period_id), fxRateWad: q.rateWad } }));
    }
    return { ...this.fxView(req), signer, rateWad: q.rateWad, requests };
  }

  /**
   * Attestor: the FX fallback rate signed on the attestor's device, one Stage 1 FX signature per covered series (S4 WP9,
   * D14). The key must be linked to the caller's account and an active attestor on the request's chain. Each signature
   * must be for a covered series still without one and recover to the key over the message the service rebuilds from the
   * chain's own domain and series key (422 `detail.stage1` InvalidAttestorSignature otherwise, as the chain would refuse
   * it). An open request needs a signature for every covered series (422 `signatures-missing` with their ids: fetch the
   * messages again); a signed one takes the series added since, at the same rate. Stored in `fx_fallback_signatures`.
   */
  async signFxRequest(id: string, session: Session, input: z.infer<typeof fxSignSchema>): Promise<Record<string, unknown>> {
    const req = await this.fxRequestRow(id);
    if (req.state !== 'open' && req.state !== 'signed') throw AppError.conflict(`fx fallback request is ${String(req.state)}`);
    if (req.state === 'signed' && String(req.rate_wad) !== input.rateWad) throw AppError.conflict('the period\'s fallback rate is already signed: sign the same rate for the remaining series', { reason: 'rate-fixed', rateWad: String(req.rate_wad) });
    const chain = this.ctx.chains.get(String(req.chain));
    const key = input.signer;
    if (!(await this.linked(session, key))) throw AppError.forbidden('the attestor key must be linked to your account');
    await this.requireRegisteredAttestor(chain, key);
    const periodId = String(req.period_id);
    const onchain = await chain.getSignerKey('attestor', key);
    if (!onchain || !keyUsable(onchain, await chain.now(), { reportPeriod: periodId })) throw invalidAttestorSignature('the attestor key is not usable on this chain for this period');
    const domain = await signingDomainOf(chain);
    const already = new Set((await this.fxSignatures(id)).map((x) => x.seriesId));
    const unsigned = (await this.fxAffectedSeries(req)).filter((x) => !already.has(x));
    const seen = new Set<string>();
    for (const x of input.signatures) {
      if (seen.has(x.seriesId)) throw AppError.unprocessable('one signature per series', { reason: 'duplicate-series', seriesId: x.seriesId });
      seen.add(x.seriesId);
      if (already.has(x.seriesId)) throw AppError.conflict('the rate is already signed for this series', { reason: 'already-signed', seriesId: x.seriesId });
      if (!unsigned.includes(x.seriesId)) throw AppError.unprocessable('the request does not cover this series (another chain or currency, not reporting the period yet, terminal, or already reported)', { reason: 'series-not-covered', seriesId: x.seriesId });
    }
    if (req.state === 'open') {
      const missing = unsigned.filter((x) => !seen.has(x));
      if (missing.length) throw AppError.unprocessable('sign the rate for every series the request covers (GET the messages again)', { reason: 'signatures-missing', missing });
    }
    const rows: { seriesId: string; signature: string; digest: string }[] = [];
    for (const x of input.signatures) {
      const series = await chain.getSeries(x.seriesId);
      if (!series) throw AppError.notFound('series');
      const { digest } = fxDigest({ domain: domain.domain, seriesKey: series.seriesKey }, { periodId, fxRateWad: input.rateWad });
      if (recoverSigner(digest, x.signature) !== key) throw invalidAttestorSignature('the signature does not recover to the key over Stage 1\'s FX message for this series, period and rate on this chain', { seriesId: x.seriesId });
      rows.push({ seriesId: x.seriesId, signature: x.signature, digest });
    }
    await withTransaction(this.ctx.pool, async (db) => {
      const live = (await db.query('select state, rate_wad from fx_fallback_requests where request_id = $1 for update', [id])).rows[0];
      if (!live || live.state !== req.state || String(live.rate_wad) !== String(req.rate_wad)) throw AppError.conflict('fx fallback request was signed concurrently');
      for (const r of rows) {
        const ins = await db.query('insert into fx_fallback_signatures (request_id, chain, series_id, signer, rate_wad, signature, digest) values ($1,$2,$3,$4,$5,$6,$7) on conflict (request_id, series_id) do nothing', [id, chain.chain, r.seriesId, key, input.rateWad, r.signature, r.digest]);
        if (!ins.rowCount) throw AppError.conflict('fx fallback request was signed concurrently');
      }
      if (req.state === 'open') {
        await db.query("update fx_fallback_requests set state = 'signed', attestor = $2, rate_wad = $3, source_note = $4, decision_code = null, signed_at = now() where request_id = $1", [id, key, input.rateWad, input.sourceNote]);
      }
    });
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'fx.sign', target: id, detail: { chain: req.chain, pair: req.pair, periodId, rateWad: input.rateWad, sourceNote: input.sourceNote, attestor: key, seriesIds: rows.map((r) => r.seriesId) } });
    await enqueueOutbox(this.ctx.pool, 'notification', { kind: 'fx.fallback-signed', chain: req.chain, pair: req.pair, periodId });
    return { ...this.fxView(await this.fxRequestRow(id)), signatures: await this.fxSignatures(id) };
  }

  /**
   * Issuer: the FX fallback for the series' pair and period, as the report carries it (S4 WP9): the period's signed rate
   * and this series' own Stage 1 FX signature `fxFallback {signer, signature}`; the poi service carries the stored one into
   * the report. `seriesSigned` is false while the rate is signed but not yet for this series (a series that started
   * reporting after the attestor signed: the attestor adds it).
   */
  async fxFallbackForSeries(seriesId: string, periodId: string): Promise<Record<string, unknown>> {
    const chain = this.chainOf(seriesId);
    const series = await chain.getSeries(seriesId);
    if (!series) throw AppError.notFound('series');
    if (series.terms.reportingCurrency === 'USD') return { seriesId, periodId, pair: null, basis: 'unity', state: 'not-needed', rateWad: null, fxFallback: null };
    const pair = `${series.terms.reportingCurrency}/USD`;
    const r = await this.ctx.pool.query('select * from fx_fallback_requests where chain = $1 and pair = $2 and period_id = $3', [chain.chain, pair, periodId]);
    const req = r.rows[0];
    if (!req) return { seriesId, periodId, pair, basis: 'accumulator', state: 'none', rateWad: null, fxFallback: null };
    const sig = (await this.ctx.pool.query('select signer, rate_wad, signature, digest, signed_at from fx_fallback_signatures where request_id = $1 and series_id = $2', [req.request_id, seriesId])).rows[0];
    return {
      seriesId, periodId, pair, basis: 'attestor', state: req.state, decisionCode: req.decision_code ?? null, requestId: req.request_id, reason: req.reason, sourceNote: req.source_note ?? null, signedAt: req.signed_at ?? null,
      rateWad: req.state === 'signed' ? String(req.rate_wad) : null, seriesSigned: !!sig,
      fxFallback: sig ? { signer: sig.signer, signature: sig.signature } : null, digest: sig?.digest ?? null,
    };
  }

  // ------------------------------------------------------------------ extinguishment (C11.6, S4 WP12)

  private async extRow(id: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from extinguishment_requests where request_id = $1', [id]);
    const e = r.rows[0];
    if (!e) throw AppError.notFound('extinguishment request');
    return e;
  }

  /**
   * The record as the named attestors and admins see it (the evidence with `withCiphertext`). While signatures are
   * collected or wait for the relay the view names the keys that signed and the nonce, never a signature: an unrelayed
   * EXTINGUISH signature is a bearer authorisation (anyone holding both could extinguish the series), so no read, audit
   * row, notification or feed shows it (S4 amendment D2). Once relayed (`sent`) the signatures are public onchain data
   * and `withSignatures` shows them.
   */
  private extView(e: Record<string, unknown>, withCiphertext: boolean, withSignatures = withCiphertext): Record<string, unknown> {
    const sigs = signatureEntries(e.signatures);
    return {
      requestId: e.request_id, seriesId: e.series_id, chain: e.chain, attestors: e.attestors, state: e.state, decisionCode: e.decision_code ?? null, keyHint: e.key_hint ?? null, requestedBy: e.requested_by, createdAt: e.created_at,
      extinguishNonce: str(e.extinguish_nonce), signers: sigs.map((x) => x.signer), relayTx: e.relay_tx ?? null, relayError: e.relay_error ?? null,
      ...(withSignatures && e.state === 'sent' ? { signatures: sigs } : {}),
      ...(withCiphertext ? { evidenceCiphertext: e.evidence_ciphertext } : {}),
    };
  }

  /** The account a key is linked to (its own EIP-191 proof), or null. */
  private async accountOf(address: string): Promise<string | null> {
    const r = await this.ctx.pool.query<{ account_id: string }>('select account_id from account_signer_keys where address = $1', [address]);
    return r.rows[0]?.account_id ?? null;
  }

  /**
   * S4 D15 (ours, stricter than Stage 1, which checks keys only): the two named keys must be linked to two different
   * accounts, read live, so one person holding two attestor keys cannot extinguish a series alone. 409 `same-account`.
   */
  private async requireDistinctAccounts(e: Record<string, unknown>): Promise<void> {
    const [a, b] = e.attestors as [string, string];
    const [x, y] = await Promise.all([this.accountOf(a), this.accountOf(b)]);
    if (x !== null && x === y) throw AppError.conflict('both attestor keys of this request are linked to one account: an extinguishment needs two attestors holding their own keys', { reason: 'same-account' });
  }

  /**
   * Stage 1 extinguishes a settled raise whose mint is final and that is not extinguished yet (exit.rs:229-241;
   * MercesVault.sol:598-600), checked on the chain's read before anything is opened, signed or relayed: 409 with
   * Stage 1's name. An open raise or a curve before its completion cannot be extinguished.
   */
  private extinguishable(series: SeriesState): void {
    if (series.phase !== 'Settled') throw new AppError(409, 'Conflict', `only a settled raise can be extinguished (the raise is ${series.phase})`, { stage1: 'RaiseNotSettled' });
    if (!series.mintFinalized) throw new AppError(409, 'Conflict', 'the raise is still processing its bids (MintNotFinalized): it cannot be extinguished yet', { stage1: 'MintNotFinalized' });
    if (series.status === 'Extinguished') throw new AppError(409, 'Conflict', 'series is already extinguished', { stage1: 'TerminalStatus' });
  }

  private async extinguishRequestFor(chain: ChainPort, series: SeriesState, signer: string): Promise<SigningRequest<'EXTINGUISH'>> {
    const domain = await signingDomainOf(chain);
    return requestFor({ kind: 'EXTINGUISH', chain: chain.chain, seriesId: series.seriesId, seriesKey: series.seriesKey, domain, signer, fields: { extinguishNonce: series.nonces.extinguish } });
  }

  /**
   * Attestor: open an extinguishment request (S4 WP12; C11.6) naming the caller's own key (`attestor`, linked to the
   * caller's account and registered on the series' chain) and a second registered key held by another account
   * (`coAttestor`; S4 D15: 409 `same-account` when the caller's account holds it too, 422 when no account holds it, since
   * nobody could sign for it here). The evidence (death or permanent disability) is E2E ciphertext for the attestors. The
   * series must be one Stage 1 would extinguish now. One open request per series. Nothing is signed yet: each named key
   * signs the request's EXTINGUISH message on its own device (`extinguishMessage`, `signExtinguishment`).
   */
  async requestExtinguishment(session: Session, input: z.infer<typeof extinguishSchema>): Promise<Record<string, unknown>> {
    const chain = this.chainOf(input.seriesId);
    const series = await chain.getSeries(input.seriesId);
    if (!series) throw AppError.notFound('series');
    this.extinguishable(series);
    if (input.attestor === input.coAttestor) throw AppError.unprocessable('two distinct attestor keys are required', { stage1: 'SameAttestor' });
    if (!(await this.actsAs(session, chain.chain, input.attestor))) throw AppError.forbidden('`attestor` must be a key linked to your account and registered on the series\' chain');
    await this.requireRegisteredAttestor(chain, input.coAttestor);
    const coAccount = await this.accountOf(input.coAttestor);
    if (coAccount === session.accountId) throw AppError.conflict('the co-attestor key is linked to your own account: an extinguishment needs two attestors holding their own keys', { reason: 'same-account' });
    if (coAccount === null) throw AppError.unprocessable('the co-attestor key is not linked to any account: nobody could sign this request for it', { reason: 'co-attestor-not-linked' });
    assertOpaqueCiphertext(input.evidenceCiphertext, 'evidenceCiphertext');
    const id = this.ctx.newId('ext');
    const attestors = [input.attestor, input.coAttestor];
    try {
      await this.ctx.pool.query("insert into extinguishment_requests (request_id, series_id, chain, attestors, requested_by, evidence_ciphertext, key_hint, state) values ($1,$2,$3,$4,$5,$6,$7,'collecting')", [id, input.seriesId, chain.chain, attestors, session.accountId, input.evidenceCiphertext, input.keyHint]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw AppError.conflict('an extinguishment request is already open for this series');
      throw err;
    }
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'attestor', action: 'extinguishment.request', target: id, detail: { seriesId: input.seriesId, attestors } });
    return this.extView(await this.extRow(id), false);
  }

  async getExtinguishment(id: string, session: Session): Promise<Record<string, unknown>> {
    const e = await this.extRow(id);
    let named = false;
    for (const a of e.attestors as string[]) if (await this.actsAs(session, String(e.chain), a)) named = true;
    if (!named && !session.roles.includes('admin')) throw AppError.forbidden('this request names other attestor keys, or your key is not linked or not active on its chain');
    const series = await this.ctx.chains.get(String(e.chain)).getSeries(String(e.series_id));
    return { ...this.extView(e, true), seriesStatus: series?.status ?? null, extinguishedAt: series?.extinguishedAt ?? null, liveExtinguishNonce: series?.nonces.extinguish ?? null };
  }

  /**
   * Attestor (a named key's holder, or an admin reading it): the signing request for that key's EXTINGUISH signature
   * (S4 WP12, D2): Stage 1's `MERCES_EXTINGUISH_V1` over the chain's signing domain, the series key and the series' live
   * extinguish nonce. The key is `q.attestor`, or the caller's named key that has not signed yet. Only while the request
   * collects signatures, for a key that has not signed, for two keys of two accounts (409 `same-account`) and a series
   * Stage 1 would extinguish now. The device warns that the signature cannot be recalled (with the other key's it lets
   * anyone extinguish the series until the nonce moves or a key is revoked) and signs; the API never signs.
   */
  async extinguishMessage(id: string, session: Session, q: z.infer<typeof extinguishMessageQuerySchema>): Promise<SigningRequest<'EXTINGUISH'>> {
    const e = await this.extRow(id);
    const chainKey = String(e.chain);
    const attestors = e.attestors as string[];
    const signed = signatureEntries(e.signatures).map((x) => x.signer);
    let key: string | undefined = q.attestor;
    if (key !== undefined) {
      if (!attestors.includes(key)) throw AppError.unprocessable('this request does not name that key');
      if (!(await this.actsAs(session, chainKey, key)) && !session.roles.includes('admin')) throw AppError.forbidden('that key is not linked to your account or not active on the request\'s chain');
    } else {
      const mine: string[] = [];
      for (const a of attestors) if (await this.actsAs(session, chainKey, a)) mine.push(a);
      if (!mine.length) throw AppError.forbidden('this request names other attestor keys, or your key is not linked or not active on its chain');
      key = mine.find((a) => !signed.includes(a)) ?? mine[0]!;
    }
    if (e.state !== 'collecting') throw AppError.conflict(`extinguishment request is ${e.state}`);
    if (signed.includes(key)) throw AppError.conflict('this key has signed this request already', { reason: 'already-signed' });
    await this.requireDistinctAccounts(e);
    const chain = this.ctx.chains.get(chainKey);
    const series = await chain.getSeries(String(e.series_id));
    if (!series) throw AppError.notFound('series');
    this.extinguishable(series);
    return this.extinguishRequestFor(chain, series, key);
  }

  /**
   * Attestor: one named key's EXTINGUISH signature (only the account holding that key, while it is registered; an admin
   * never signs: A-M5-3). In order:
   *  1. the request is open and the key is one it names, acting for the caller; the two keys are held by two accounts
   *     (409 `same-account`, read live: S4 D15);
   *  2. the series is one Stage 1 would extinguish now (`extinguishable`);
   *  3. the signature: the EXTINGUISH message rebuilt here from the chain's domain and series key with the nonce the key
   *     signed (a digest sent must equal it) recovers to the key, and the key is active on the chain (no grace): 422
   *     `detail.stage1` InvalidAttestorSignature otherwise;
   *  4. the nonce read again must still be the one signed: 409 `stale-nonce` with a fresh signing request otherwise;
   *  5. the signature is stored with the request locked (a stored signature over an older nonce is dropped: it is dead);
   *     with both keys' signatures the request is `ready` and the keeper relays it at once (`relayExtinguishment`).
   * Posting a stored signature again on a ready request retries the relay. The audit names the signer, nonce and digest,
   * never the signature.
   */
  async signExtinguishment(id: string, session: Session, input: z.infer<typeof extinguishSignSchema>): Promise<Record<string, unknown> & { relayTx: string | null }> {
    const e = await this.extRow(id);
    const chainKey = String(e.chain);
    const seriesId = String(e.series_id);
    const attestors = e.attestors as string[];
    const key = input.attestation.signer;
    if (!attestors.includes(key) || !(await this.actsAs(session, chainKey, key))) throw AppError.forbidden('only the account holding one of the two named attestor keys, while the key is registered, signs this request');
    if (e.state !== 'collecting' && e.state !== 'ready') throw AppError.conflict(`extinguishment request is ${e.state}`);
    await this.requireDistinctAccounts(e);
    const chain = this.ctx.chains.get(chainKey);
    const [now, series] = await Promise.all([chain.now(), chain.getSeries(seriesId)]);
    if (!series) throw AppError.notFound('series');
    this.extinguishable(series);
    // Stage 1's EXTINGUISH message, rebuilt here from the chain's own domain and series key (never the caller's digest)
    const domain = await signingDomainOf(chain);
    const { digest } = extinguishDigest({ domain: domain.domain, seriesKey: series.seriesKey }, { extinguishNonce: input.extinguishNonce });
    if (input.attestation.digest !== undefined && input.attestation.digest !== digest) throw invalidAttestorSignature('the attestation\'s digest is not this series\' EXTINGUISH message on this chain (another series, chain or nonce)');
    if (recoverSigner(digest, input.attestation.signature) !== key) throw invalidAttestorSignature('the signature does not recover to the named key over Stage 1\'s EXTINGUISH message for this nonce on this chain');
    const k = await chain.getSignerKey('attestor', key);
    if (!k || !keyUsable(k, now)) throw invalidAttestorSignature('the attestor key is not active on this chain: an extinguishment needs active keys');
    if (series.nonces.extinguish !== input.extinguishNonce) {
      throw new AppError(409, 'Conflict', 'the series\' extinguish nonce moved since this was signed: the signature is dead; sign the fresh request', { reason: 'stale-nonce', liveExtinguishNonce: series.nonces.extinguish, request: await this.extinguishRequestFor(chain, series, key) });
    }
    const entry: ExtinguishSignature = { signer: key, signature: input.attestation.signature, digest };
    const state = await withTransaction(this.ctx.pool, async (db) => {
      const row = (await db.query('select state, signatures, extinguish_nonce from extinguishment_requests where request_id = $1 for update', [id])).rows[0];
      if (!row || (row.state !== 'collecting' && row.state !== 'ready')) throw AppError.conflict(`extinguishment request is ${row?.state ?? 'gone'}`);
      // a signature stored over another nonce is dead on the chain: dropped (the key signs again)
      const kept = row.extinguish_nonce !== null && String(row.extinguish_nonce) !== input.extinguishNonce ? [] : signatureEntries(row.signatures);
      const sigs = [...kept.filter((x) => x.signer !== key), entry].sort((x, y) => attestors.indexOf(x.signer) - attestors.indexOf(y.signer));
      const next = sigs.length === 2 ? 'ready' : 'collecting';
      await db.query('update extinguishment_requests set signatures = $2, extinguish_nonce = $3, state = $4, decision_code = null, relay_error = null where request_id = $1', [id, JSON.stringify(sigs), input.extinguishNonce, next]);
      await audit(db, { actor: session.accountId, actorRole: 'attestor', action: 'extinguishment.sign', target: id, detail: { seriesId, signer: key, extinguishNonce: input.extinguishNonce, digest } });
      return next;
    });
    if (state !== 'ready') return { ...this.extView(await this.extRow(id), false), relayTx: null };
    return this.relayExtinguishment(id, session);
  }

  /**
   * The keeper relays a ready request (S4 D3: `extinguish` is permissionless; keepers send only commands they checked),
   * the row locked. Both stored signatures are checked against the chain's reads first: the nonce they bind must be the
   * live one (else both are dead: dropped, the request collects again, 409 `stale-nonce`), and each key must still be an
   * active attestor (a key revoked since kills its signature: dropped, 409 `attestor-key-inactive` with Stage 1's
   * InvalidAttestorSignature). Then the keeper submits `extinguish{attestorA, signatureA, attestorB, signatureB}` in the
   * request's order: on success the request is `sent` with the relay transaction; a chain refusal leaves it `ready` with
   * the refusal's Stage 1 name (or canonical code) in `relay_error` and comes back with its canonical code (A-REV-23);
   * posting either stored signature again retries.
   */
  private async relayExtinguishment(id: string, session: Session): Promise<Record<string, unknown> & { relayTx: string }> {
    type Outcome = { relayTx: string } | { error: Error };
    const outcome = await withTransaction<Outcome>(this.ctx.pool, async (db) => {
      const row = (await db.query('select * from extinguishment_requests where request_id = $1 for update', [id])).rows[0];
      if (row?.state === 'sent') return { relayTx: String(row.relay_tx) }; // a concurrent relay landed
      if (!row || row.state !== 'ready') throw AppError.conflict(`extinguishment request is ${row?.state ?? 'gone'}`);
      const chain = this.ctx.chains.get(String(row.chain));
      const seriesId = String(row.series_id);
      const [now, series] = await Promise.all([chain.now(), chain.getSeries(seriesId)]);
      if (!series) throw AppError.notFound('series');
      const sigs = signatureEntries(row.signatures);
      if (String(row.extinguish_nonce) !== series.nonces.extinguish) {
        await db.query("update extinguishment_requests set signatures = '[]', extinguish_nonce = null, state = 'collecting', decision_code = 'stale-nonce', relay_error = null where request_id = $1", [id]);
        return { error: new AppError(409, 'Conflict', 'the series\' extinguish nonce moved since these were signed: both signatures are dead; both keys sign again', { reason: 'stale-nonce', liveExtinguishNonce: series.nonces.extinguish }) };
      }
      const dead: string[] = [];
      for (const x of sigs) {
        const k = await chain.getSignerKey('attestor', x.signer);
        if (!k || !keyUsable(k, now)) dead.push(x.signer);
      }
      if (dead.length) {
        const kept = sigs.filter((x) => !dead.includes(x.signer));
        await db.query("update extinguishment_requests set signatures = $2, extinguish_nonce = $3, state = 'collecting', decision_code = 'attestor-key-inactive', relay_error = null where request_id = $1", [id, JSON.stringify(kept), kept.length ? row.extinguish_nonce : null]);
        return { error: new AppError(409, 'Conflict', 'an attestor key of this request is no longer active on the chain: its signature is dead (an extinguishment needs active keys)', { reason: 'attestor-key-inactive', stage1: 'InvalidAttestorSignature', keys: dead }) };
      }
      const [a, b] = sigs as [ExtinguishSignature, ExtinguishSignature];
      try {
        // the keeper relays both signatures: extinguish is permissionless (S4 D3)
        const res = await chain.submit({ kind: 'extinguish', seriesId, attestorA: a.signer, signatureA: a.signature, attestorB: b.signer, signatureB: b.signature }, 'keeper');
        await db.query("update extinguishment_requests set state = 'sent', relay_tx = $2, relay_error = null, decision_code = 'extinguished' where request_id = $1", [id, res.txId]);
        await audit(db, { actor: session.accountId, actorRole: 'attestor', action: 'extinguishment.relay', target: id, detail: { seriesId, attestors: [a.signer, b.signer], extinguishNonce: String(row.extinguish_nonce), digest: a.digest, relayTx: res.txId } });
        return { relayTx: res.txId };
      } catch (err) {
        if (!(err instanceof ChainError)) throw err; // not a refusal: rolled back, the request stays ready as it was
        const name = typeof err.detail?.stage1 === 'string' ? err.detail.stage1 : err.code;
        await db.query('update extinguishment_requests set relay_error = $2 where request_id = $1', [id, name]);
        return { error: err };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return { ...this.extView(await this.extRow(id), false, true), relayTx: outcome.relayTx };
  }
}

/** One named key's stored Stage 1 EXTINGUISH signature (S4 WP12). */
interface ExtinguishSignature {
  signer: string;
  signature: string;
  digest: string;
}

/** The stored EXTINGUISH signatures of an extinguishment request (`signatures` jsonb), in the request's key order. */
function signatureEntries(x: unknown): ExtinguishSignature[] {
  if (!Array.isArray(x)) return [];
  return x.filter((s): s is ExtinguishSignature => !!s && typeof s.signer === 'string' && typeof s.signature === 'string' && typeof s.digest === 'string').map((s) => ({ signer: s.signer, signature: s.signature, digest: s.digest }));
}

/** The keys that have signed an extinguishment request (never their signatures). */
function signersOf(x: unknown): string[] {
  return signatureEntries(x).map((s) => s.signer);
}

/** A case's stored attestation as the API shows it: Stage 1's REPORT signature {signer, signature, digest} (S4 WP9), else null. */
function caseAttestation(a: unknown): { signer: string; signature: string; digest: string } | null {
  const x = a as { signer?: unknown; signature?: unknown; digest?: unknown } | null;
  if (!x || typeof x.signer !== 'string' || typeof x.signature !== 'string' || typeof x.digest !== 'string') return null;
  return { signer: x.signer, signature: x.signature, digest: x.digest };
}
