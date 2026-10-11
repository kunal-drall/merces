import { z } from 'zod';
import {
  SigningError, ZERO_INCOME_COMMITMENT, assertLocalSigningNetwork, assertSigningNetwork, familyOfChainKind, incomeCommitment, parseSeriesId, recoverSigner, reportAttestationRecordSchema,
  reportDigest, seriesKeyOf, signerAddressSchema, signingDomain, signingDomainSchema, type ChainKey, type ChainPort, type ReportAttestationRecord, type SigningDomain,
} from '@merces/domain';
import { fromPid, parsePeriod, quarterIndex, toPid } from '@merces/math';
import type { KmsPort, ZkTlsPort, ZkTlsProof } from '@merces/ports';

const decimal = z.string().regex(/^\d{1,78}$/);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

/**
 * The attestation request a device sends (tier 2). The zkTLS proof carries the attested year-to-date figure (unless
 * the provider hashed it); the salt (a field element, decimal) lets the verifier recompute the Poseidon commitment the
 * device computed. A non-ZERO prior comes with its opening and with this verifier's attestation of the previous
 * quarter. All of it exists only in memory here. The chain is the series id's (`<chain>:<address>`): the verifier signs
 * under that chain's domain from its own table, never one a caller supplies.
 */
export const attestRequestSchema = z.object({
  seriesId: z.string(),
  periodId: z.string().regex(/^\d{4}Q[1-4]$/),
  /** tier 2 only: tier 1 is bound to the split router's checkpoints and tier 3 to an attestor, not to this verifier */
  tier: z.literal(2),
  source: z.enum(['stripe', 'deel', 'distrokid']),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  zktlsProof: z.unknown(),
  incomeSalt: decimal,
  incomeCommitment: hex32,
  /** the commitment the report chains from: ZERO (`Poseidon(0, 0)`) at a year start */
  priorIncomeCommitment: hex32,
  /** the opening of a non-ZERO prior (decimal strings); null (or 0/0) with ZERO */
  priorOpening: z.object({ incomeYtd: decimal, incomeSalt: decimal }).strict().nullable().default(null),
  /** this verifier's record of the previous quarter of the same year (`ReportAttestationRecord`), whose income commitment is the prior */
  priorAttestation: reportAttestationRecordSchema.nullable().default(null),
  /** the device's declaration (owner question 1: zkTLS data cannot show it; the verifier signs the declared flag) */
  liquidityEvent: z.boolean().default(false),
}).strict();
export type AttestRequest = z.input<typeof attestRequestSchema>;

export interface AttestResult {
  ok: true;
  /** the record: `{signer, signature}` goes into `submitReport.attestation`, the whole record into the device's chain */
  attestation: ReportAttestationRecord;
}

/** Refusal codes. A code never carries the figure, a salt or any payload. */
export type AttestFailureCode =
  | 'bad-proof'
  /** the proof is for another series or period, or the series' chain is not in this verifier's table */
  | 'wrong-context'
  | 'currency-mismatch'
  | 'commitment-mismatch'
  | 'hash-only-unsupported'
  | 'not-field'
  /** the prior is not ZERO in Q1, or its opening does not open it */
  | 'prior-mismatch'
  /** a non-ZERO prior without this verifier's valid attestation of the previous quarter */
  | 'prior-unattested';

export interface AttestFailure {
  ok: false;
  code: AttestFailureCode;
}

/** One chain this verifier signs for: its key and the signing domain the verifier holds for it (S4 D10). */
export interface VerifierChain {
  chain: ChainKey;
  domain: SigningDomain;
}

/**
 * An address this verifier signed with before a rotation, and when it was retired (unix seconds; S4 amendment D10).
 * A prior attestation by it is accepted only for a period that ended at or before `retiredAt` (forward-only, as Stage 1's
 * grace); a compromised key is never listed (RUNBOOK "Report verifier key").
 */
export interface PreviousVerifierAddress {
  address: string;
  retiredAt: number;
}

/** What `GET /keys` serves: the key's address and public key, the chains and domains it signs for, the retired addresses. */
export interface VerifierKeyInfo {
  /** the secp256k1 key's 20-byte address (lowercase), the address registered onchain as a verifier key */
  address: string;
  /** the uncompressed public key, `04 ‖ X ‖ Y`, hex without `0x` */
  publicKeyHex: string;
  chains: VerifierChain[];
  previous: PreviousVerifierAddress[];
}

export interface ReportVerifierPort {
  attest(req: AttestRequest): Promise<AttestResult | AttestFailure>;
  publicKey(): Promise<VerifierKeyInfo>;
}

export interface ReportVerifierConfig {
  /** the KMS key id of the verifier's secp256k1 key */
  keyId: string;
  /** the address pin (`REPORT_VERIFIER_ADDRESS`): the KMS key must have this address, else the verifier does not start */
  address?: string | null;
  /** retired addresses whose prior attestations stay acceptable, time-bounded (`REPORT_VERIFIER_PREVIOUS_ADDRESSES`) */
  previous?: readonly PreviousVerifierAddress[];
  /**
   * The chain table (`MERCES_VERIFIER_CHAINS`), or a loader for it (the in-process dev verifier reads each simulator's
   * `ChainInfo.signing`). Every domain must be on the signing allow-list and never a mainnet.
   */
  chains: readonly VerifierChain[] | (() => Promise<readonly VerifierChain[]>);
  /** accept the local dev ids (Solana localnet 104, EVM 31337): the simulator only (`MERCES_VERIFIER_DEV=true`, or a simulator-only process) */
  allowLocal?: boolean;
  /**
   * The key is a published development key (the dev seed, `MERCES_VERIFIER_DEV=true`): the table may hold the local ids
   * only, and any other domain, a testnet included, is refused at startup and at every signature (ground rule: dev and
   * test keys are refused when any chain is live). Implies `allowLocal`.
   */
  localOnly?: boolean;
}

/** A configuration the verifier refuses to start with. The message names no secret. */
export class VerifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierConfigError';
  }
}

interface Ready {
  address: string;
  publicKeyHex: string;
  chains: Map<ChainKey, SigningDomain>;
  previous: PreviousVerifierAddress[];
}

const tableEntrySchema = z.object({
  chain: z.string().regex(/^[a-z0-9-]+$/),
  family: z.enum(['solana', 'evm']),
  chainKind: z.union([z.literal(1), z.literal(2)]),
  chainId: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]),
  registry: z.string().min(1),
}).strict();

/**
 * The chain table from `MERCES_VERIFIER_CHAINS`: a JSON array of `{chain, family, chainKind, chainId, registry}` (the
 * registry as its chain-local address or its 32-byte form). The domain of each entry is computed here (Stage 1
 * `computeDomain`, `signingDomain`), never taken from the environment, and checked against the network allow-list when
 * the verifier starts.
 */
export function verifierChainsFromEnv(json: string | undefined): VerifierChain[] {
  if (!json || !json.trim()) throw new VerifierConfigError('MERCES_VERIFIER_CHAINS is not set: the verifier signs only for the chains it is configured with');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VerifierConfigError('MERCES_VERIFIER_CHAINS is not JSON');
  }
  const parsed = z.array(tableEntrySchema).min(1).safeParse(raw);
  if (!parsed.success) throw new VerifierConfigError('MERCES_VERIFIER_CHAINS must be a JSON array of {chain, family, chainKind, chainId, registry}');
  return parsed.data.map((e) => {
    if ((e.family === 'solana' ? 1 : 2) !== e.chainKind) throw new VerifierConfigError(`MERCES_VERIFIER_CHAINS: chain ${e.chain} has chainKind ${e.chainKind}, not its family's`);
    let domain: SigningDomain;
    try {
      domain = signingDomain(e.family, e.chainId, e.registry);
    } catch {
      throw new VerifierConfigError(`MERCES_VERIFIER_CHAINS: chain ${e.chain} has a malformed chain id or registry`);
    }
    return { chain: e.chain, domain };
  });
}

/**
 * The chain table of an in-process verifier in development and tests (S4 amendment D10): each chain's own signing
 * domain (`ChainInfo.signing`), the simulator's derived local domains among them (Solana localnet 104, EVM 31337, a
 * registry per chain key, which no operator writes by hand). A chain without one (a live adapter before S5) is left out.
 * Only a simulator-only process uses this (with `allowLocal`); the standalone verifier reads `MERCES_VERIFIER_CHAINS`
 * and never takes a domain from the API.
 */
export async function verifierChainsFromPorts(ports: Iterable<Pick<ChainPort, 'chain' | 'info'>>): Promise<VerifierChain[]> {
  const out: VerifierChain[] = [];
  for (const p of ports) {
    const signing = (await p.info()).signing;
    if (signing) out.push({ chain: p.chain, domain: signing });
  }
  return out;
}

/** `REPORT_VERIFIER_PREVIOUS_ADDRESSES`: a JSON array of `{address, retiredAt}` (empty or unset: none). */
export function previousAddressesFromEnv(json: string | undefined): PreviousVerifierAddress[] {
  if (!json || !json.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new VerifierConfigError('REPORT_VERIFIER_PREVIOUS_ADDRESSES is not JSON');
  }
  const parsed = z.array(z.object({ address: z.string(), retiredAt: z.number().int().positive() }).strict()).safeParse(raw);
  if (!parsed.success) throw new VerifierConfigError('REPORT_VERIFIER_PREVIOUS_ADDRESSES must be a JSON array of {address, retiredAt}');
  return parsed.data;
}

/**
 * The verifier core. It unavoidably sees the attested figure and the openings in memory; it must therefore:
 *  - keep no state beyond the signing key handle and its configuration,
 *  - never log a request body, a figure or a salt (callers log only the returned code),
 *  - sign only Stage 1's `MERCES_REPORT_V1` {domain, series key, period, prior and income commitments, tier 2, liquidity
 *    flag}, a digest it builds itself from its own chain table and the series id; the source is checked against the
 *    proof but never signed (B7). No route signs a digest a caller supplies.
 *
 * Its key is secp256k1 behind the KMS port (S4 D10; the algorithm is the KMS's configuration, never inferred). Before it
 * serves anything (`ready`) it checks every domain of its table against the signing allow-list (never mainnet; local
 * ids only with `allowLocal`; a dev key, `localOnly`, the local ids and nothing else) and the KMS key's address against
 * the pin. The standalone process reads all of it from its environment (`verifierSetupFromEnv`).
 *
 * What it checks, in order:
 *  0. the series' chain is in its table and the series id has a series key there (else `wrong-context`);
 *  1. the zkTLS proof verifies for this series and period, from the declared source;
 *  2. the figure is in the series' reporting currency (θ and the payment are in that currency; nothing onchain
 *     would catch a figure in another one, A-REP-4) and is a figure, not a hash;
 *  3. the prior (SPEC §6.2 step 5): ZERO is always allowed (it is the issuer's least favourable prior). A non-ZERO
 *     prior is refused in Q1, and otherwise needs its opening and this verifier's own attestation of the previous
 *     quarter of the same year with that income commitment, over this chain's domain, signed by its current address or
 *     by a previous one retired at or after that quarter's end. The chain checks a chained prior itself; for a series'
 *     first report outside Q1 (A25) it accepts the prior as given, and this binding is what authenticates it;
 *  4. the high-water rule (SPEC §1.5): the committed year-to-date figure is `max(attested, prior)`, so
 *     `incomeCommitment = Poseidon(2)(max(figure, priorYtd), incomeSalt)`.
 */
export class ReportVerifier implements ReportVerifierPort {
  private readying: Promise<Ready> | null = null;

  constructor(
    private readonly zktls: ZkTlsPort,
    private readonly kms: KmsPort,
    private readonly config: ReportVerifierConfig,
  ) {}

  /** A verifier that has passed its startup checks (`ready`): throws `VerifierConfigError` otherwise. */
  static async create(zktls: ZkTlsPort, kms: KmsPort, config: ReportVerifierConfig): Promise<ReportVerifier> {
    const v = new ReportVerifier(zktls, kms, config);
    await v.ready();
    return v;
  }

  /**
   * The startup checks, once: the chain table (each domain allow-listed, never mainnet, no chain twice), the KMS key's
   * address against the pin, and the previous addresses. A failure is remembered: the verifier never serves.
   */
  ready(): Promise<Ready> {
    this.readying ??= this.check();
    return this.readying;
  }

  private async check(): Promise<Ready> {
    const c = this.config;
    const table = typeof c.chains === 'function' ? await c.chains() : c.chains;
    const chains = new Map<ChainKey, SigningDomain>();
    for (const entry of table) {
      if (chains.has(entry.chain)) throw new VerifierConfigError(`the chain table names ${entry.chain} twice`);
      if (!signingDomainSchema.safeParse(entry.domain).success) throw new VerifierConfigError(`the chain table's domain for ${entry.chain} is malformed`);
      try {
        this.assertNetwork(entry.domain);
      } catch (e) {
        // the allow-list's own message: a mainnet named by its id, or a network not on the list (no secret in it)
        throw new VerifierConfigError(`chain ${entry.chain}: ${e instanceof SigningError ? e.message : 'the signing domain is refused'}`);
      }
      chains.set(entry.chain, { ...entry.domain });
    }
    let address: string;
    let publicKeyHex: string;
    try {
      address = await this.kms.signerAddress(c.keyId);
      ({ publicKeyHex } = await this.kms.publicKey(c.keyId));
    } catch {
      throw new VerifierConfigError(`the KMS has no secp256k1 key "${c.keyId}" (the verifier key is configured with its algorithm, secp256k1)`);
    }
    if (c.address !== undefined && c.address !== null) {
      if (!signerAddressSchema.safeParse(c.address.toLowerCase()).success) throw new VerifierConfigError('REPORT_VERIFIER_ADDRESS is not a 20-byte address');
      if (c.address.toLowerCase() !== address) throw new VerifierConfigError(`the KMS key's address ${address} is not REPORT_VERIFIER_ADDRESS: refusing to start`);
    }
    const previous: PreviousVerifierAddress[] = [];
    for (const p of c.previous ?? []) {
      const a = typeof p.address === 'string' ? p.address.toLowerCase() : '';
      if (!signerAddressSchema.safeParse(a).success || !Number.isSafeInteger(p.retiredAt) || p.retiredAt <= 0) throw new VerifierConfigError('a previous address must be {address: 20-byte address, retiredAt: unix seconds}');
      if (p.retiredAt > Math.floor(Date.now() / 1000) + 300) throw new VerifierConfigError('a previous address retiredAt must be unix seconds, not milliseconds, and cannot be in the future (maximum clock skew: 300 seconds)');
      if (a === address) throw new VerifierConfigError('the current address cannot also be a previous address');
      if (previous.some((x) => x.address === a)) throw new VerifierConfigError(`previous address ${a} is listed twice`);
      previous.push({ address: a, retiredAt: p.retiredAt });
    }
    return { address, publicKeyHex, chains, previous };
  }

  async publicKey(): Promise<VerifierKeyInfo> {
    const r = await this.ready();
    return { address: r.address, publicKeyHex: r.publicKeyHex, chains: [...r.chains.entries()].map(([chain, domain]) => ({ chain, domain: { ...domain } })), previous: r.previous.map((p) => ({ ...p })) };
  }

  async attest(req: AttestRequest): Promise<AttestResult | AttestFailure> {
    const fail = (code: AttestFailureCode): AttestFailure => ({ ok: false, code });
    const r = await this.ready();
    if (req.tier !== 2) return fail('wrong-context');
    // 0. the series' chain and its series key, from this verifier's own table (never from the request)
    const context = this.contextOf(r, req.seriesId);
    if (!context) return fail('wrong-context');
    const v = await this.zktls.verify(req.zktlsProof as ZkTlsProof, { seriesId: req.seriesId, periodId: req.periodId });
    if (!v.ok) return fail(v.error?.includes('replay') || v.error?.includes('another') ? 'wrong-context' : 'bad-proof');
    if (v.source !== req.source) return fail('bad-proof');
    if (v.currency.toUpperCase() !== req.reportingCurrency.toUpperCase()) return fail('currency-mismatch');
    if (v.figure === null) return fail('hash-only-unsupported'); // Part J.3: hash-attesting providers need a commitment scheme agreed with Reclaim

    const prior = await this.priorYtd(r, context, req);
    if (typeof prior !== 'bigint') return prior;
    const ytd = v.figure > prior ? v.figure : prior; // high-water (SPEC §1.5)
    let expected: string;
    try {
      expected = incomeCommitment(ytd, req.incomeSalt); // Poseidon(2)(ytd, salt)
    } catch {
      return fail('not-field'); // the salt is not a field element, or the figure is out of the u64 range
    }
    if (expected !== req.incomeCommitment) return fail('commitment-mismatch');
    // the signed message names no source: the provider is checked here and stays offchain (B7)
    const fields = { periodId: req.periodId, priorIncomeCommitment: req.priorIncomeCommitment, incomeCommitment: req.incomeCommitment, tier: 2 as const, liquidityEvent: req.liquidityEvent ?? false };
    this.assertNetwork(context.domain); // never mainnet (nor a live network for a dev key), checked again at the signature
    const { digest } = reportDigest({ domain: context.domain.domain, seriesKey: context.seriesKey }, fields);
    const signature = await this.kms.signDigest(this.config.keyId, digest);
    if (recoverSigner(digest, signature) !== r.address) throw new Error('the KMS signature does not recover to the verifier key'); // fail closed
    return { ok: true, attestation: { signer: r.address, signature, digest, chain: context.chain, seriesId: req.seriesId, ...fields } };
  }

  /**
   * The signing allow-list for this verifier's key: never mainnet; the local ids with `allowLocal`; with `localOnly` (a
   * published dev key) the local ids only, a testnet refused.
   */
  private assertNetwork(domain: SigningDomain): void {
    if (this.config.localOnly === true) assertLocalSigningNetwork(domain);
    else assertSigningNetwork(domain, { allowLocal: this.config.allowLocal === true });
  }

  /** The chain, its domain and the series key of a series id, or null when the chain is not in the table. */
  private contextOf(r: Ready, seriesId: string): { chain: ChainKey; domain: SigningDomain; seriesKey: string } | null {
    if (typeof seriesId !== 'string' || !/^[a-z0-9-]+:[A-Za-z0-9]+$/.test(seriesId)) return null;
    const { chain } = parseSeriesId(seriesId);
    const domain = r.chains.get(chain);
    if (!domain) return null;
    try {
      return { chain, domain, seriesKey: seriesKeyOf(seriesId, familyOfChainKind(domain.chainKind)) };
    } catch {
      return null;
    }
  }

  /** The prior's year-to-date figure under the prior rule (step 3), or the refusal. */
  private async priorYtd(r: Ready, context: { chain: ChainKey; domain: SigningDomain; seriesKey: string }, req: AttestRequest): Promise<bigint | AttestFailure> {
    const o = req.priorOpening ?? null;
    // decimal strings (the HTTP schema checks them; an in-process caller may not): never parse one into an error message
    const dec = (v: string): bigint | null => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
    if (o && (dec(o.incomeYtd) === null || dec(o.incomeSalt) === null)) return { ok: false, code: 'not-field' };
    if (req.priorIncomeCommitment === ZERO_INCOME_COMMITMENT) {
      if (o && (dec(o.incomeYtd) !== 0n || dec(o.incomeSalt) !== 0n)) return { ok: false, code: 'prior-mismatch' };
      return 0n;
    }
    const pid = toPid(req.periodId);
    if (quarterIndex(pid) === 0) return { ok: false, code: 'prior-mismatch' }; // a reporting year starts from ZERO
    if (!o) return { ok: false, code: 'prior-mismatch' };
    let opened: string;
    try {
      opened = incomeCommitment(o.incomeYtd, o.incomeSalt);
    } catch {
      return { ok: false, code: 'not-field' };
    }
    if (opened !== req.priorIncomeCommitment) return { ok: false, code: 'prior-mismatch' };
    const a = req.priorAttestation ?? null;
    const parsed = a === null ? null : reportAttestationRecordSchema.safeParse(a);
    if (!parsed?.success) return { ok: false, code: 'prior-unattested' };
    const p = parsed.data;
    if (p.chain !== context.chain || p.seriesId !== req.seriesId || p.periodId !== fromPid(pid - 1) || p.incomeCommitment !== req.priorIncomeCommitment || p.tier !== 2) return { ok: false, code: 'prior-unattested' };
    if (!this.signedByUs(r, context, p)) return { ok: false, code: 'prior-unattested' };
    return dec(o.incomeYtd)!;
  }

  /**
   * A record this verifier signed: the REPORT digest rebuilt over this chain's domain (from the verifier's own table)
   * and the series key recovers to its current address, or to a previous address retired at or after the end of the
   * record's period (S4 amendment D10: forward-only, as Stage 1's grace; a compromised key is never listed). The record's
   * own signer and digest must agree. The verifier keeps no chain registry and no record of what it signed.
   */
  private signedByUs(r: Ready, context: { domain: SigningDomain; seriesKey: string }, p: ReportAttestationRecord): boolean {
    let digest: string;
    try {
      digest = reportDigest({ domain: context.domain.domain, seriesKey: context.seriesKey }, p).digest;
    } catch {
      return false;
    }
    if (p.digest !== digest) return false;
    const who = recoverSigner(digest, p.signature);
    if (who === null || who !== p.signer) return false;
    if (who === r.address) return true;
    const retired = r.previous.find((x) => x.address === who);
    return !!retired && parsePeriod(p.periodId).end <= retired.retiredAt;
  }
}
