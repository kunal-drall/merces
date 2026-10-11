import { z } from 'zod';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ChainKind, DAY, DEFAULT_PARAMETERS, EVM_CHAIN_IDS, MAGIC, SOLANA_CLUSTER_TAGS, U64_MAX, amendmentMessage, computeDomain, extinguishMessage,
  fxFallbackMessage, keccak256, parsePeriod, parseSignature, pauseApprovalMessage, recoverAddress, reportAttestationMessage, seriesKeyFromId,
  toPid, trueUpMessage, walletFromEvmAddress, walletFromSolanaPubkey, type Signature65, type SignedMessage,
} from '@merces/math';
import { hash32Schema, parseSeriesId, periodIdSchema, seriesIdSchema, type ChainFamily, type ChainKey } from './ids.ts';

/**
 * Stage 1's signatures (SPEC v1.1.2 §1.3-§1.4), chain-neutral and hex-in, hex-out (S4 D1, A-SIG-1).
 *
 * Every encoding is Stage 1's own function through `@merces/math` (the SDK's `messages.ts`, `signatures.ts`,
 * `commitments.ts`, `bytes.ts`): this module only validates inputs, converts the canonical model's strings to the SDK's
 * types and hex-encodes the results. Nothing here re-implements a byte layout.
 *
 * - A message's digest is the raw keccak256 of its pre-image (`"MERCES_<KIND>_V1" ‖ domain ‖ series_key ‖ fields`),
 *   with no EIP-191 prefix: the magic string is the domain separation.
 * - A signature is 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}`, low `s`; a key is identified by its 20-byte address
 *   (`keccak256(pubkey_64)[12..32]`), lowercase `0x` + 40 hex in the canonical model on both chains.
 * - The domain is `keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_32)`: Solana cluster tags 101-104 with the
 *   registry program id, EVM chain ids with the left-padded `MercesRegistry` address. The series key is the series
 *   PDA on Solana and `bytes32(uint256(series_id))` on the EVM.
 *
 * The wrappers are named `reportDigest` … `trueUpDigest` so they never shadow the SDK builders `@merces/math`
 * re-exports under their own names (S4 amendment D1).
 *
 * Never mainnet (S4 D6): the network allow-list and its mainnet tripwire live here, seeded from Stage 1's own constants
 * (`EVM_CHAIN_IDS.monadMainnet` = 143, `SOLANA_CLUSTER_TAGS.mainnetBeta` = 101; SDK commitments.ts); every signer
 * (the attestor's device, the report verifier, the local KMS's users) calls `assertSigningNetwork` before it signs,
 * and the EVM adapter's connection guard (`@merces/chain-evm` config.ts) reads the same list.
 */

// ---------------------------------------------------------------- errors

export type SigningErrorCode =
  | 'malformed' | 'mainnet' | 'network-not-allowed' | 'domain-mismatch' | 'unpinned-chain' | 'series-mismatch' | 'digest-mismatch';

/** A refusal of this module (a signing request, a domain, a network). Messages name no secret: nothing here holds one. */
export class SigningError extends Error {
  constructor(
    public readonly code: SigningErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SigningError';
  }
}

// ---------------------------------------------------------------- schemas

/** A secp256k1 key's 20-byte address: lowercase `0x` + 40 hex (display it with `toChecksumAddress`, EIP-55). */
export const signerAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
/**
 * A 65-byte signature `r ‖ s ‖ v`, as lowercase `0x` + 130 hex. Shape only (S4 D8): a non-canonical signature (high
 * `s`, `v ∉ {27, 28}`, `r` or `s` out of range) passes the schema and recovers to nobody (`recoverSigner` → null), as
 * the EVM's `tryRecover` recovers it to the zero address, so the chain's own error (`Invalid*Signature`) surfaces.
 */
export const signature65Schema = z.string().regex(/^0x[0-9a-f]{130}$/);
/** One key's signature over one message: the form every attestation takes inside a command (S4 D3: nobody co-signs). */
export const attestationSchema = z.object({ signer: signerAddressSchema, signature: signature65Schema }).strict();
export type Attestation = z.infer<typeof attestationSchema>;

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** A u64 as a canonical decimal string (no sign, no leading zero), at most 2^64 − 1. */
const u64StringSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine((s) => BigInt(s) <= U64_MAX, 'out of the u64 range');
/** An i64 as a canonical decimal string. */
const i64StringSchema = z.string().regex(/^(0|-?[1-9]\d{0,18})$/).refine((s) => BigInt(s) >= I64_MIN && BigInt(s) <= I64_MAX, 'out of the i64 range');

// ---------------------------------------------------------------- the network allow-list and its mainnet tripwire

/**
 * EVM chain ids this backend may connect to and sign for. Fail closed: anything not listed is refused, so a new network
 * needs a deliberate code change here, and only testnets belong in it. Ids checked against ethereum-lists/chains
 * (_data/chains/eip155-<id>.json) on 2026-10-08; Monad Testnet is Stage 1's `EVM_CHAIN_IDS.monadTestnet`. Moved here
 * from `@merces/chain-evm` in S4 (D6) so the signers and the adapter read one list.
 */
export const EVM_TESTNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [Number(EVM_CHAIN_IDS.monadTestnet), 'Monad Testnet'],
  [11155111, 'Ethereum Sepolia'],
  [84532, 'Base Sepolia'],
  [421614, 'Arbitrum Sepolia'],
  [11155420, 'OP Sepolia'],
]);
/** The local EVM dev chain id (anvil, hardhat; the simulator's monad personality): signing only, with `allowLocal`. */
export const EVM_LOCAL_CHAIN_ID = 31337;
/** Known EVM mainnet ids (Stage 1's Monad mainnet among them), kept as a tripwire: none may ever be allowed. */
export const EVM_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([1, 10, 56, 100, 137, Number(EVM_CHAIN_IDS.monadMainnet), 324, 8453, 42161, 42170, 43114, 59144, 81457, 534352]);

/** Solana cluster tags (Stage 1 `SOLANA_CLUSTER_TAGS`) a signer may sign for: testnet and devnet. */
export const SOLANA_SIGNING_TAGS: ReadonlyMap<bigint, string> = new Map([
  [SOLANA_CLUSTER_TAGS.testnet, 'testnet'],
  [SOLANA_CLUSTER_TAGS.devnet, 'devnet'],
]);
/** Stage 1's localnet tag (104; the simulator's solana personality and the LiteSVM harness): signing only, with `allowLocal`. */
export const SOLANA_LOCAL_TAG = SOLANA_CLUSTER_TAGS.localnet;
/** Stage 1's mainnet-beta tag (101): never. */
export const SOLANA_MAINNET_TAGS: ReadonlySet<bigint> = new Set([SOLANA_CLUSTER_TAGS.mainnetBeta]);

/**
 * The tripwire: throws when an allowed id is a known mainnet. It runs when this module loads, over both families'
 * allow-lists and local ids, so a mainnet can never be added to either by mistake.
 */
export function assertNoMainnetAllowed(family: ChainFamily, allowed: Iterable<number | bigint>, mainnets: ReadonlySet<number> | ReadonlySet<bigint>): void {
  const known = new Set<string>([...(mainnets as ReadonlySet<number | bigint>)].map(String));
  for (const id of allowed) if (known.has(String(id))) throw new Error(`the ${family} signing allow-list contains mainnet id ${id} (ground rule: never mainnet)`);
}
assertNoMainnetAllowed('evm', [...EVM_TESTNET_CHAIN_IDS.keys(), EVM_LOCAL_CHAIN_ID], EVM_MAINNET_CHAIN_IDS);
assertNoMainnetAllowed('solana', [...SOLANA_SIGNING_TAGS.keys(), SOLANA_LOCAL_TAG], SOLANA_MAINNET_TAGS);

// ---------------------------------------------------------------- domain, wallets, series keys

export type SignerKind = 'attestor' | 'verifier';
export const SIGNING_KINDS = ['REPORT', 'FX', 'AMEND', 'PAUSE', 'EXTINGUISH', 'TRUEUP'] as const;
/** The six signed messages (Stage 1 `MAGIC` names). */
export type SigningKind = (typeof SIGNING_KINDS)[number];
if (Object.keys(MAGIC).join() !== SIGNING_KINDS.join()) throw new Error("SIGNING_KINDS is not Stage 1's MAGIC");

/** A deployment's signing domain (SPEC §1.3): what every signed message binds first. */
export interface SigningDomain {
  /** Stage 1 `ChainKind`: 1 Solana, 2 EVM */
  chainKind: 1 | 2;
  /** the chain id as a u64 decimal string: a Solana cluster tag (101-104) or an EVM chain id */
  chainId: string;
  /** the registry's 32-byte wallet form: the program id on Solana, the left-padded `MercesRegistry` on the EVM */
  registry: string;
  /** keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_32) */
  domain: string;
}
export const signingDomainSchema = z.object({
  chainKind: z.union([z.literal(1), z.literal(2)]),
  chainId: u64StringSchema,
  registry: hash32Schema,
  domain: hash32Schema,
}).strict();

export function chainKindOf(family: ChainFamily): 1 | 2 {
  return family === 'solana' ? ChainKind.Solana : ChainKind.Evm;
}
export function familyOfChainKind(kind: 1 | 2): ChainFamily {
  return kind === ChainKind.Solana ? 'solana' : 'evm';
}

/** 0x-hex of bytes (lowercase). */
function hex(b: Uint8Array): string {
  return '0x' + bytesToHex(b);
}
/** The bytes of a `0x` + 2n-hex string of exactly `len` bytes, else a RangeError naming `what` (never the value). */
function bytesOf(h: string, len: number, what: string): Uint8Array {
  if (typeof h !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${len * 2}}$`).test(h)) throw new RangeError(`${what} must be ${len}-byte 0x-hex`);
  return hexToBytes(h.slice(2));
}

/**
 * An address as Stage 1's 32-byte wallet value (SPEC §1.3): a Solana pubkey as-is (base58), an EVM address
 * (`0x` + 40 hex, any case) left-padded with 12 zero bytes. Stage 1's `walletFromSolanaPubkey` / `walletFromEvmAddress`.
 */
export function wallet32Of(address: string, family: ChainFamily): Uint8Array {
  if (family === 'evm') {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new RangeError('not an EVM address (0x + 40 hex)');
    return walletFromEvmAddress(address);
  }
  try {
    return walletFromSolanaPubkey(address);
  } catch {
    throw new RangeError('not a Solana address (base58 of 32 bytes)');
  }
}

/** A u64 from a canonical decimal string, a bigint or a safe non-negative integer, else a RangeError naming `what`. */
function u64Of(v: bigint | string | number, what: string): bigint {
  let x: bigint;
  if (typeof v === 'bigint') x = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) x = BigInt(v);
  else if (typeof v === 'string' && /^\d{1,20}$/.test(v)) x = BigInt(v);
  else throw new RangeError(`${what} is not an unsigned integer`);
  if (x < 0n || x > U64_MAX) throw new RangeError(`${what} is out of the u64 range`);
  return x;
}
function i64Of(v: bigint | string, what: string): bigint {
  let x: bigint;
  if (typeof v === 'bigint') x = v;
  else if (typeof v === 'string' && /^-?\d{1,19}$/.test(v)) x = BigInt(v);
  else throw new RangeError(`${what} is not an integer`);
  if (x < I64_MIN || x > I64_MAX) throw new RangeError(`${what} is out of the i64 range`);
  return x;
}

/**
 * A deployment's signing domain from its parts (Stage 1 `computeDomain`). `registry` is the registry's chain-local
 * address (Solana base58, EVM `0x` + 40 hex) or its 32-byte wallet form (`0x` + 64 hex).
 */
export function signingDomain(family: ChainFamily, chainId: bigint | string | number, registry: string | Uint8Array): SigningDomain {
  const id = u64Of(chainId, 'chainId');
  let reg: Uint8Array;
  if (registry instanceof Uint8Array) {
    if (registry.length !== 32) throw new RangeError('registry must be 32 bytes');
    reg = Uint8Array.from(registry);
  } else reg = /^0x[0-9a-fA-F]{64}$/.test(registry) ? bytesOf(registry, 32, 'registry') : wallet32Of(registry, family);
  const chainKind = chainKindOf(family);
  return { chainKind, chainId: id.toString(), registry: hex(reg), domain: hex(computeDomain(chainKind, id, reg)) };
}

/**
 * Refuses to sign for anything but an allow-listed network (S4 D6): Solana testnet or devnet, an EVM testnet on
 * `EVM_TESTNET_CHAIN_IDS`, and with `allowLocal` the local ids (Solana localnet 104, EVM 31337). A mainnet is always
 * refused, by name. The domain hash must also be the hash of its own fields (a forged `domain` is refused).
 */
export function assertSigningNetwork(d: SigningDomain, opts: { allowLocal?: boolean } = {}): void {
  const parsed = signingDomainSchema.safeParse(d);
  if (!parsed.success) throw new SigningError('malformed', 'the signing domain is malformed');
  const id = BigInt(d.chainId);
  if (signingDomain(familyOfChainKind(d.chainKind), id, d.registry).domain !== d.domain) {
    throw new SigningError('domain-mismatch', 'the signing domain is not keccak256(chain_kind ‖ chain_id ‖ registry) of its own fields');
  }
  if (d.chainKind === ChainKind.Solana) {
    if (SOLANA_MAINNET_TAGS.has(id)) throw new SigningError('mainnet', `refusing to sign for Solana mainnet-beta (cluster tag ${id}): never mainnet`);
    if (SOLANA_SIGNING_TAGS.has(id) || (opts.allowLocal === true && id === SOLANA_LOCAL_TAG)) return;
    throw new SigningError('network-not-allowed', `Solana cluster tag ${id} is not on the signing allow-list (testnet 102, devnet 103${opts.allowLocal ? ', localnet 104' : ''})`);
  }
  if (id <= BigInt(Number.MAX_SAFE_INTEGER) && EVM_MAINNET_CHAIN_IDS.has(Number(id))) throw new SigningError('mainnet', `refusing to sign for EVM mainnet chain id ${id}: never mainnet`);
  if (id <= BigInt(Number.MAX_SAFE_INTEGER) && (EVM_TESTNET_CHAIN_IDS.has(Number(id)) || (opts.allowLocal === true && Number(id) === EVM_LOCAL_CHAIN_ID))) return;
  throw new SigningError('network-not-allowed', `EVM chain id ${id} is not on the signing allow-list (EVM_TESTNET_CHAIN_IDS${opts.allowLocal ? `, local ${EVM_LOCAL_CHAIN_ID}` : ''})`);
}

/**
 * True for a local dev id (Solana localnet 104, EVM 31337): the simulator's networks, nothing live. A testnet is a live
 * network. Only the kind and id are read: `assertSigningNetwork` checks the rest.
 */
export function isLocalSigningDomain(d: Pick<SigningDomain, 'chainKind' | 'chainId'>): boolean {
  if (typeof d?.chainId !== 'string' || !/^\d{1,20}$/.test(d.chainId)) return false;
  const id = BigInt(d.chainId);
  if (d.chainKind === ChainKind.Solana) return id === SOLANA_LOCAL_TAG;
  return d.chainKind === ChainKind.Evm && id === BigInt(EVM_LOCAL_CHAIN_ID);
}

/**
 * A published development or test key (the local KMS's dev seed, the simulator harness's `SimSigner`, the vector keys)
 * signs for the simulator only (ground rule: dev and test keys are refused when any chain is live): the domain passes
 * `assertSigningNetwork` (never mainnet, a forged domain refused) and is a local id. A testnet is refused.
 */
export function assertLocalSigningNetwork(d: SigningDomain): void {
  assertSigningNetwork(d, { allowLocal: true });
  if (!isLocalSigningDomain(d)) throw new SigningError('network-not-allowed', `a published development or test key signs for the simulator only (Solana localnet ${SOLANA_LOCAL_TAG}, EVM ${EVM_LOCAL_CHAIN_ID}), never a live network (chain id ${d.chainId})`);
}

/**
 * The series key a message binds (SPEC §1.4), from the canonical series id `"<chain>:<address>"`:
 * - Solana: the series PDA's 32 bytes (the series address, base58), as Stage 1's programs use it;
 * - EVM: `bytes32(uint256(series_id))` (Stage 1 `seriesKeyFromId`) for a numeric id; the simulator's monad series ids
 *   are 20-byte pseudo-addresses, whose key is the address left-padded (`bytes32(uint256(uint160(addr)))`, equal to
 *   `seriesKeyFromId(BigInt(addr))`), a labelled stand-in until S5's counter ids (A-ID-1).
 * The chain's own read (`SeriesState.seriesKey`, S4 WP4) is authoritative; this is the pure form a party without
 * chain access uses (the report verifier, the device's check).
 */
export function seriesKeyOf(seriesId: string, family: ChainFamily): string {
  if (!seriesIdSchema.safeParse(seriesId).success) throw new RangeError('not a series id');
  const { address } = parseSeriesId(seriesId);
  if (family === 'solana') return hex(wallet32Of(address, 'solana'));
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return hex(walletFromEvmAddress(address));
  if (/^\d{1,78}$/.test(address)) {
    const id = BigInt(address);
    if (id >= 1n << 256n) throw new RangeError('the EVM series id does not fit in 32 bytes');
    return hex(seriesKeyFromId(id));
  }
  throw new RangeError('not an EVM series id (a uint256 or a 20-byte pseudo-address)');
}

// ---------------------------------------------------------------- the six messages

/** What every message binds before its fields: the deployment's domain and the series key (both `0x` + 64 hex). */
export interface SigningContext {
  domain: string;
  seriesKey: string;
}
/** A built message: Stage 1's kind, the exact pre-image and its keccak256 (what is signed), as 0x-hex. */
export interface SignedDigest {
  kind: SigningKind;
  preimage: string;
  digest: string;
}

type U64In = bigint | string | number;

/** The fields of each message as the canonical model carries them (decimal strings for integers, "YYYYQn" periods). */
export interface SigningFields {
  /** tier 2 is the report verifier's key, tier 3 an attestor's (the report tier, not the tier flag bit) */
  REPORT: { periodId: string; priorIncomeCommitment: string; incomeCommitment: string; tier: 2 | 3; liquidityEvent: boolean };
  /** the report's own `fxAvgWad` */
  FX: { periodId: string; fxRateWad: string };
  AMEND: { amendmentNonce: string; termsCommitment: string; capMultipleWad: string };
  PAUSE: { pauseNonce: string; pauseEnd: string };
  EXTINGUISH: { extinguishNonce: string };
  /** `adjustment` is a signed payment figure Stage 1 publishes onchain (`submit_trueup`), not income */
  TRUEUP: { trueupNonce: string; year: number; adjustment: string; attestationTs: string };
}

export const signingFieldsSchemas = {
  REPORT: z.object({ periodId: periodIdSchema, priorIncomeCommitment: hash32Schema, incomeCommitment: hash32Schema, tier: z.union([z.literal(2), z.literal(3)]), liquidityEvent: z.boolean() }).strict(),
  FX: z.object({ periodId: periodIdSchema, fxRateWad: u64StringSchema }).strict(),
  AMEND: z.object({ amendmentNonce: u64StringSchema, termsCommitment: hash32Schema, capMultipleWad: u64StringSchema }).strict(),
  PAUSE: z.object({ pauseNonce: u64StringSchema, pauseEnd: u64StringSchema }).strict(),
  EXTINGUISH: z.object({ extinguishNonce: u64StringSchema }).strict(),
  TRUEUP: z.object({ trueupNonce: u64StringSchema, year: z.number().int().min(0).max(0xffff), adjustment: i64StringSchema, attestationTs: u64StringSchema }).strict(),
} as const satisfies { [K in SigningKind]: z.ZodType<SigningFields[K]> };

function context(ctx: SigningContext): { domain: Uint8Array; seriesKey: Uint8Array } {
  return { domain: bytesOf(ctx.domain, 32, 'domain'), seriesKey: bytesOf(ctx.seriesKey, 32, 'seriesKey') };
}
function out(m: SignedMessage): SignedDigest {
  return { kind: m.kind, preimage: hex(m.preimage), digest: hex(m.digest) };
}

/** `MERCES_REPORT_V1` (Stage 1 `reportAttestationMessage`): the tier-2 verifier's or a tier-3 attestor's report attestation. */
export function reportDigest(ctx: SigningContext, f: { periodId: string; priorIncomeCommitment: string; incomeCommitment: string; tier: 2 | 3; liquidityEvent: boolean }): SignedDigest {
  if (f.tier !== 2 && f.tier !== 3) throw new RangeError('a report attestation is tier 2 (verifier) or tier 3 (attestor)');
  return out(reportAttestationMessage({
    ...context(ctx),
    period: toPid(f.periodId),
    priorIncomeCommitment: bytesOf(f.priorIncomeCommitment, 32, 'priorIncomeCommitment'),
    incomeCommitment: bytesOf(f.incomeCommitment, 32, 'incomeCommitment'),
    tier: f.tier,
    liquidityEvent: f.liquidityEvent === true,
  }));
}

/** `MERCES_FX_V1` (Stage 1 `fxFallbackMessage`): an attestor's fallback rate, per series and period (S4 D14). */
export function fxDigest(ctx: SigningContext, f: { periodId: string; fxRateWad: U64In }): SignedDigest {
  return out(fxFallbackMessage({ ...context(ctx), period: toPid(f.periodId), fxRateWad: u64Of(f.fxRateWad, 'fxRateWad') }));
}

/** `MERCES_AMEND_V1` (Stage 1 `amendmentMessage`) over the series' live amendment nonce. */
export function amendDigest(ctx: SigningContext, f: { amendmentNonce: U64In; termsCommitment: string; capMultipleWad: U64In }): SignedDigest {
  return out(amendmentMessage({
    ...context(ctx),
    amendmentNonce: u64Of(f.amendmentNonce, 'amendmentNonce'),
    newTermsCommitment: bytesOf(f.termsCommitment, 32, 'termsCommitment'),
    newCapMultipleWad: u64Of(f.capMultipleWad, 'capMultipleWad'),
  }));
}

/** `MERCES_PAUSE_V1` (Stage 1 `pauseApprovalMessage`) over the live pause nonce (a request or a withdrawal advances it). */
export function pauseDigest(ctx: SigningContext, f: { pauseNonce: U64In; pauseEnd: U64In }): SignedDigest {
  return out(pauseApprovalMessage({ ...context(ctx), pauseNonce: u64Of(f.pauseNonce, 'pauseNonce'), pauseEnd: u64Of(f.pauseEnd, 'pauseEnd') }));
}

/** `MERCES_EXTINGUISH_V1` (Stage 1 `extinguishMessage`) over the live extinguish nonce. */
export function extinguishDigest(ctx: SigningContext, f: { extinguishNonce: U64In }): SignedDigest {
  return out(extinguishMessage({ ...context(ctx), extinguishNonce: u64Of(f.extinguishNonce, 'extinguishNonce') }));
}

/** `MERCES_TRUEUP_V1` (Stage 1 `trueUpMessage`) over the live true-up nonce. */
export function trueUpDigest(ctx: SigningContext, f: { trueupNonce: U64In; year: number; adjustment: bigint | string; attestationTs: U64In }): SignedDigest {
  if (!Number.isInteger(f.year) || f.year < 0 || f.year > 0xffff) throw new RangeError('year is out of the u16 range');
  return out(trueUpMessage({
    ...context(ctx),
    trueupNonce: u64Of(f.trueupNonce, 'trueupNonce'),
    year: f.year,
    adjustment: i64Of(f.adjustment, 'adjustment'),
    attestationTs: u64Of(f.attestationTs, 'attestationTs'),
  }));
}

/** The message of `kind` over `fields` (the dispatch `checkSigningRequest` uses). */
export function signingDigest<K extends SigningKind>(kind: K, ctx: SigningContext, fields: SigningFields[K]): SignedDigest {
  switch (kind) {
    case 'REPORT': return reportDigest(ctx, fields as SigningFields['REPORT']);
    case 'FX': return fxDigest(ctx, fields as SigningFields['FX']);
    case 'AMEND': return amendDigest(ctx, fields as SigningFields['AMEND']);
    case 'PAUSE': return pauseDigest(ctx, fields as SigningFields['PAUSE']);
    case 'EXTINGUISH': return extinguishDigest(ctx, fields as SigningFields['EXTINGUISH']);
    case 'TRUEUP': return trueUpDigest(ctx, fields as SigningFields['TRUEUP']);
    default: throw new SigningError('malformed', 'unknown message kind');
  }
}

// ---------------------------------------------------------------- recovery

/**
 * The 20-byte address a 65-byte signature over `digest` recovers to, or null when the signature is not canonical (not
 * 65 bytes, `v ∉ {27, 28}`, `r` or `s` zero or out of range, high `s`) or recovers to no point: the EVM's `tryRecover`
 * returns the zero address there, which is never a registered key, so every such case is the kind's `Invalid*Signature`
 * (S4 D8). Throws only on a malformed `digest` (a caller's bug, not a signer's).
 */
export function recoverSigner(digest: string, signature: string): string | null {
  const d = bytesOf(digest, 32, 'digest');
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  try {
    return hex(recoverAddress(d, parseSignature(hexToBytes(signature.slice(2)))));
  } catch {
    return null;
  }
}

/** True when `signature` over `digest` recovers to `signer` (a 20-byte address; any case). */
export function signedBy(digest: string, signature: string, signer: string): boolean {
  if (typeof signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(signer)) return false;
  const who = recoverSigner(digest, signature);
  return who !== null && who === signer.toLowerCase();
}

/** A Stage 1 `Signature65` (`signDigest`'s result) as the canonical model's lowercase 0x-hex. */
export function signature65Hex(sig: Signature65): string {
  return hex(sig.bytes);
}

// ---------------------------------------------------------------- the report verifier's record (tier 2)

/**
 * What the report verifier returns for a tier-2 report (S4 WP6, D10), and what the issuer's device keeps as the next
 * quarter's `priorAttestation`: its Stage 1 signature over `MERCES_REPORT_V1`, the fields it signed (tier 2), the chain
 * whose signing domain it signed under and the digest. Only `{signer, signature}` (`attestationOf`) goes into
 * `submitReport.attestation`: the chain, the API and the verifier itself recompute the digest from the domain and the
 * series key they hold, never from this record. Public data: commitments and flags, no income figure, no source.
 */
export interface ReportAttestationRecord extends Attestation {
  /** the REPORT digest signed (`reportDigest`), for the holder's information */
  digest: string;
  /** the chain whose signing domain the verifier signed under (the series id's chain) */
  chain: ChainKey;
  seriesId: string;
  periodId: string;
  priorIncomeCommitment: string;
  incomeCommitment: string;
  tier: 2;
  liquidityEvent: boolean;
}
export const reportAttestationRecordSchema = z.object({
  signer: signerAddressSchema,
  signature: signature65Schema,
  digest: hash32Schema,
  chain: z.string().regex(/^[a-z0-9-]+$/),
  seriesId: seriesIdSchema,
  periodId: periodIdSchema,
  priorIncomeCommitment: hash32Schema,
  incomeCommitment: hash32Schema,
  tier: z.literal(2),
  liquidityEvent: z.boolean(),
}).strict();

/** The command form of an attestation record: `{signer, signature}`, what `submitReport.attestation` carries. */
export function attestationOf(r: Attestation): Attestation {
  return { signer: r.signer, signature: r.signature };
}

// ---------------------------------------------------------------- revocation grace

/**
 * How long a revoked key stays usable for a report (tier 2 or 3) or FX signature of a period that ended at or before
 * its revocation: `(report_due_days + grace_days) × DAY` = 3,888,000 s (Stage 1: Solana `income.rs` `KEY_GRACE_S`,
 * EVM `MercesConstants.GRACE_SECONDS`, the reference's `reportKeyValid`).
 */
export const KEY_GRACE_SECONDS = (DEFAULT_PARAMETERS.reportDueDays + DEFAULT_PARAMETERS.graceDays) * Number(DAY);
if (KEY_GRACE_SECONDS !== 3_888_000) throw new Error('KEY_GRACE_SECONDS is not Stage 1\'s 45 days');

/** A registered key as the chain holds it (Stage 1 `AttestorKey` / `VerifierKey`, EVM `KeyInfo`). */
export interface SignerKeyState {
  kind: SignerKind;
  /**
   * The key's address as the chain registered it: 0x + 40 lowercase hex (a secp256k1 key's 20-byte address). Until
   * S4 WP7 makes attestor addresses 20-byte keys everywhere, a simulator chain may also hold an attestor registered
   * under a wallet address of its family (the transitional co-signing attestors).
   */
  address: string;
  active: boolean;
  /** unix seconds; null while the key was never revoked */
  revokedAt: number | null;
  /** `revokedAt + KEY_GRACE_SECONDS`: report and FX signatures for periods ending ≤ `revokedAt` stay valid until then */
  graceUntil: number | null;
}

/** `revokedAt + KEY_GRACE_SECONDS`, or null for a key never revoked. */
export function keyGraceUntil(revokedAt: number | null): number | null {
  return revokedAt === null ? null : revokedAt + KEY_GRACE_SECONDS;
}

/**
 * Whether a key may sign at `now` (unix seconds; the chain's time). An active key always may. A revoked one may only
 * for a report or FX signature (`reportPeriod` given, "YYYYQn"), and only when that period ended at or before the
 * revocation and `now ≤ revokedAt + KEY_GRACE_SECONDS`: Stage 1's forward-only revocation (SPEC §1.4; both chains also
 * give the FX fallback this grace, DIV-S1I-3). AMEND, PAUSE, EXTINGUISH and TRUEUP pass no period: active keys only.
 */
export function keyUsable(k: Pick<SignerKeyState, 'active' | 'revokedAt'>, now: number, opts: { reportPeriod?: string } = {}): boolean {
  if (k.active) return true;
  if (opts.reportPeriod === undefined || k.revokedAt === null || k.revokedAt <= 0) return false;
  return parsePeriod(opts.reportPeriod).end <= k.revokedAt && now <= k.revokedAt + KEY_GRACE_SECONDS;
}

// ---------------------------------------------------------------- signing requests (the no-custody path, S4 D2)

/**
 * One message for one key to sign, as the API hands it to the attestor's own device (S4 D2: attestor keys never reach
 * the backend). The device never trusts it: `checkSigningRequest` rebuilds the pre-image and the digest from the typed
 * fields against its own pinned network table, and the device signs only the digest it rebuilt.
 *
 * It carries no display text: the device renders what it shows from the typed fields it checked, never from server
 * text (S4 amendment D2), and before a PAUSE or EXTINGUISH it states that the signature cannot be recalled.
 */
export interface SigningRequest<K extends SigningKind = SigningKind> {
  kind: K;
  chain: ChainKey;
  seriesId: string;
  seriesKey: string;
  domain: SigningDomain;
  /** the key addressed: 0x + 40 lowercase hex */
  signer: string;
  fields: SigningFields[K];
  preimage: string;
  digest: string;
  /** what keeps a signature usable, derived from the kind and the fields (e.g. "pause nonce 3") */
  validWhile: string;
}

function requestSchema<K extends SigningKind>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    chain: z.string().min(1),
    seriesId: seriesIdSchema,
    seriesKey: hash32Schema,
    domain: signingDomainSchema,
    signer: signerAddressSchema,
    fields: signingFieldsSchemas[kind],
    preimage: z.string().regex(/^0x(?:[0-9a-f]{2})+$/),
    digest: hash32Schema,
    validWhile: z.string(),
  }).strict();
}
export const signingRequestSchema = z.discriminatedUnion('kind', [
  requestSchema('REPORT'), requestSchema('FX'), requestSchema('AMEND'), requestSchema('PAUSE'), requestSchema('EXTINGUISH'), requestSchema('TRUEUP'),
]);

/** What keeps a signature of `kind` usable (S4 D5, D7): no nonce for REPORT and FX, the live nonce for the others. */
export function validWhileOf<K extends SigningKind>(kind: K, fields: SigningFields[K]): string {
  const f = fields as Record<string, unknown>;
  switch (kind) {
    case 'REPORT':
    case 'FX': return `one per series and period (${String(f.periodId)}); no nonce`;
    case 'AMEND': return `amendment nonce ${String(f.amendmentNonce)}`;
    case 'PAUSE': return `pause nonce ${String(f.pauseNonce)}`;
    case 'EXTINGUISH': return `extinguish nonce ${String(f.extinguishNonce)}`;
    case 'TRUEUP': return `true-up nonce ${String(f.trueupNonce)}`;
    default: throw new SigningError('malformed', 'unknown message kind');
  }
}

/**
 * Builds a signing request (the API side). The series key is the chain's (`SeriesState.seriesKey`) and must equal
 * `seriesKeyOf(seriesId)`; the domain must be allow-listed (local ids allowed: the simulator) and never mainnet.
 */
export function signingRequest<K extends SigningKind>(input: { kind: K; chain: ChainKey; seriesId: string; seriesKey: string; domain: SigningDomain; signer: string; fields: SigningFields[K] }): SigningRequest<K> {
  assertSigningNetwork(input.domain, { allowLocal: true });
  if (!seriesIdSchema.safeParse(input.seriesId).success || parseSeriesId(input.seriesId).chain !== input.chain) throw new SigningError('series-mismatch', 'the series is not on this chain');
  if (seriesKeyOf(input.seriesId, familyOfChainKind(input.domain.chainKind)) !== input.seriesKey) throw new SigningError('series-mismatch', 'the series key is not the series id\'s');
  if (!signerAddressSchema.safeParse(input.signer).success) throw new SigningError('malformed', 'the signer is not a 20-byte address');
  const fields = signingFieldsSchemas[input.kind].safeParse(input.fields);
  if (!fields.success) throw new SigningError('malformed', `the ${input.kind} fields are malformed`);
  const m = signingDigest(input.kind, { domain: input.domain.domain, seriesKey: input.seriesKey }, fields.data as SigningFields[K]);
  return {
    kind: input.kind, chain: input.chain, seriesId: input.seriesId, seriesKey: input.seriesKey, domain: { ...input.domain }, signer: input.signer,
    fields: fields.data as SigningFields[K], preimage: m.preimage, digest: m.digest, validWhile: validWhileOf(input.kind, fields.data as SigningFields[K]),
  };
}

/**
 * The device-side check (S4 D2): parses `req` strictly, requires its chain to be in the device's own `pinned` table
 * with exactly the pinned domain, refuses any network off the allow-list and every mainnet (`allowLocal` only for the
 * simulator), recomputes the series key from the series id, rebuilds the pre-image and the digest with Stage 1's
 * builders from the typed fields, and requires every recomputed value to equal the request's. Returns the rebuilt
 * message: the device signs that digest, never the request's.
 */
export function checkSigningRequest(req: unknown, pinned: Readonly<Record<ChainKey, SigningDomain>>, opts: { allowLocal?: boolean } = {}): SignedDigest & { signer: string } {
  const parsed = signingRequestSchema.safeParse(req);
  if (!parsed.success) throw new SigningError('malformed', 'the signing request is malformed');
  const r = parsed.data as SigningRequest;
  const pin = Object.prototype.hasOwnProperty.call(pinned, r.chain) ? pinned[r.chain] : undefined;
  if (!pin) throw new SigningError('unpinned-chain', `chain ${r.chain} is not in this device's pinned network table`);
  assertSigningNetwork(pin, opts);
  if (pin.chainKind !== r.domain.chainKind || pin.chainId !== r.domain.chainId || pin.registry !== r.domain.registry || pin.domain !== r.domain.domain) {
    throw new SigningError('domain-mismatch', `the request's domain is not the pinned domain of ${r.chain}`);
  }
  if (parseSeriesId(r.seriesId).chain !== r.chain) throw new SigningError('series-mismatch', 'the series is not on the request\'s chain');
  let key: string;
  try {
    key = seriesKeyOf(r.seriesId, familyOfChainKind(pin.chainKind));
  } catch {
    throw new SigningError('series-mismatch', 'the series id has no series key on this chain');
  }
  if (key !== r.seriesKey) throw new SigningError('series-mismatch', 'the series key is not the series id\'s');
  const m = signingDigest(r.kind, { domain: pin.domain, seriesKey: key }, r.fields);
  if (m.preimage !== r.preimage || m.digest !== r.digest) throw new SigningError('digest-mismatch', 'the pre-image or digest is not the one the typed fields give');
  if (validWhileOf(r.kind, r.fields) !== r.validWhile) throw new SigningError('malformed', 'validWhile is not the one the typed fields give');
  return { ...m, signer: r.signer };
}

// ---------------------------------------------------------------- link proofs (EIP-191)

/**
 * The EIP-191 (version 0x45, `personal_sign`) digest of a text: `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖
 * message)`, len the message's byte length in decimal. An attestor proves control of a key by signing a link challenge
 * this way (S4 D4). Its pre-image starts with 0x19, every `MERCES_*` pre-image with "M" (0x4d): a link proof is never
 * an attestation.
 */
export function personalMessageDigest(message: string | Uint8Array): string {
  const bytes = typeof message === 'string' ? utf8ToBytes(message) : message;
  return hex(keccak256(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
}
