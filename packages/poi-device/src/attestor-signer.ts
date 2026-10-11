import {
  EVM_LOCAL_CHAIN_ID, EVM_TESTNET_CHAIN_IDS, SOLANA_LOCAL_TAG, SOLANA_SIGNING_TAGS, assertSigningNetwork, checkSigningRequest,
  chainFamilySchema, personalMessageDigest, signedBy, signingDomain, signingDomainSchema, signingRequestSchema,
  type Attestation, type ChainFamily, type ChainKey, type SigningDomain, type SigningFields, type SigningKind, type SigningRequest,
} from '@merces/domain';
import { toChecksumAddress } from '@merces/math';
import { signerKeyLinkMessage } from '@merces/ports';
import { signDigestWith, type AttestorKey } from './attestor-keys.ts';

/**
 * The attestor's signer (S4 D2: no custody). The API hands the attestor's device a `SigningRequest` for one of Stage
 * 1's six messages; this module never trusts it:
 *  1. `pinNetworks` loads the device's own network table (chain key → signing domain), refusing every mainnet, every
 *     network off the signing allow-list and every domain that is not the keccak of its own fields;
 *  2. `checkRequest` runs `checkSigningRequest` (`@merces/domain`): the request's chain must be pinned with exactly the
 *     pinned domain, the series key is recomputed from the series id, and the pre-image and digest are rebuilt with
 *     Stage 1's builders from the typed fields; any difference is refused. An attestor never signs a tier-2 REPORT
 *     (that is the report verifier's key);
 *  3. `describeSigningRequest` renders what the attestor reads from those typed fields only (the request carries no
 *     display text, and a request with extra fields is refused), with the cannot-be-recalled warning before a PAUSE or
 *     an EXTINGUISH (S4 amendment D2);
 *  4. `signChecked` signs the digest it rebuilt (never the request's), checks the signature recovers to the key, and
 *     returns `{signer, signature, digest}`: only the signature goes back to the API.
 * `linkProof` signs a key-link challenge (EIP-191) only when it is exactly the text the API's challenge route builds for
 * this key, so the key signs nothing else.
 *
 * What it cannot check in S4: that a nonce is the chain's live one. The live adapters (S5) let the device read the
 * series' nonces from a public RPC itself; until then a server could ask for a signature over a future nonce (SECURITY.md,
 * A-SIG-2), and the display says so.
 */

/** A refusal of the attestor's signer (the request checks themselves throw `SigningError` from `@merces/domain`). */
export type AttestorToolErrorCode = 'networks' | 'wrong-key' | 'not-attestor-message' | 'not-link-challenge' | 'not-checked' | 'self-check';
export class AttestorToolError extends Error {
  constructor(
    public readonly code: AttestorToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttestorToolError';
  }
}

// ---------------------------------------------------------------- the pinned network table

/** The device's own network table: chain key → the signing domain it signs under there. */
export type PinnedNetworks = Readonly<Record<ChainKey, SigningDomain>>;

/**
 * One entry of a network table file: a full `SigningDomain` (`{chainKind, chainId, registry, domain}`), or the parts
 * `{family, chainId, registry}` (the registry as its chain-local address or its 32-byte form) from which the domain is
 * computed with Stage 1's `computeDomain`; a `domain` given beside the parts must equal the computed one.
 */
export type PinnedNetworkEntry = SigningDomain | { family: ChainFamily; chainId: string | number; registry: string; domain?: string };

function pinEntry(chain: string, entry: unknown): SigningDomain {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new AttestorToolError('networks', `the pinned network ${chain} is not an object`);
  const e = entry as Record<string, unknown>;
  if ('family' in e) {
    const family = chainFamilySchema.safeParse(e.family);
    const keys = Object.keys(e).filter((k) => !['family', 'chainId', 'registry', 'domain'].includes(k));
    if (!family.success || keys.length > 0 || (typeof e.chainId !== 'string' && typeof e.chainId !== 'number') || typeof e.registry !== 'string') {
      throw new AttestorToolError('networks', `the pinned network ${chain} is not {family, chainId, registry}`);
    }
    let d: SigningDomain;
    try {
      d = signingDomain(family.data, e.chainId, e.registry);
    } catch {
      throw new AttestorToolError('networks', `the pinned network ${chain} has a malformed chain id or registry`);
    }
    if (e.domain !== undefined && e.domain !== d.domain) throw new AttestorToolError('networks', `the pinned network ${chain}'s domain is not the one its family, chain id and registry give`);
    return d;
  }
  const parsed = signingDomainSchema.safeParse(e);
  if (!parsed.success) throw new AttestorToolError('networks', `the pinned network ${chain} is not a signing domain {chainKind, chainId, registry, domain}`);
  return parsed.data as SigningDomain;
}

/**
 * Loads a network table (the parsed JSON of the attestor's networks file). Every entry is checked as every signer checks
 * a domain (`assertSigningNetwork`): never mainnet (`SigningError` `mainnet`), only the allow-list (testnets; the
 * simulator's local ids only with `allowLocal`), and a domain that is the keccak of its own fields. One bad entry
 * refuses the whole table.
 */
export function pinNetworks(table: unknown, opts: { allowLocal?: boolean } = {}): PinnedNetworks {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new AttestorToolError('networks', 'the pinned network table is not a JSON object of chain key → network');
  const out: Record<string, SigningDomain> = {};
  for (const [chain, entry] of Object.entries(table)) {
    if (!/^[a-z0-9-]+$/.test(chain)) throw new AttestorToolError('networks', 'a pinned chain key is not lowercase letters, digits and dashes');
    const d = pinEntry(chain, entry);
    assertSigningNetwork(d, opts);
    out[chain] = Object.freeze({ ...d });
  }
  if (Object.keys(out).length === 0) throw new AttestorToolError('networks', 'the pinned network table is empty');
  return Object.freeze(out);
}

/** The network a domain names, in words (from the signing allow-list's own names). */
export function networkLabel(d: Pick<SigningDomain, 'chainKind' | 'chainId'>): string {
  const id = BigInt(d.chainId);
  if (d.chainKind === 1) {
    const name = SOLANA_SIGNING_TAGS.get(id) ?? (id === SOLANA_LOCAL_TAG ? 'localnet: the simulator, not a live network' : 'not on the allow-list');
    return `Solana ${name} (cluster tag ${id})`;
  }
  const n = id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : -1;
  const name = EVM_TESTNET_CHAIN_IDS.get(n) ?? (n === EVM_LOCAL_CHAIN_ID ? 'local chain: the simulator, not a live network' : 'not on the allow-list');
  return `EVM ${name} (chain id ${id})`;
}

// ---------------------------------------------------------------- checking a request

/** A request this device checked: every value rebuilt from the typed fields and the pinned domain. */
export interface CheckedSigningRequest<K extends SigningKind = SigningKind> {
  readonly kind: K;
  readonly chain: ChainKey;
  readonly seriesId: string;
  readonly seriesKey: string;
  /** the pinned domain (the request's equals it) */
  readonly domain: SigningDomain;
  /** the key the request is addressed to */
  readonly signer: string;
  readonly fields: SigningFields[K];
  /** the pre-image and digest this device rebuilt */
  readonly preimage: string;
  readonly digest: string;
  readonly validWhile: string;
}

const checked = new WeakSet<object>();

/**
 * Checks a signing request on the device (S4 D2). Throws `SigningError` (`malformed`, `unpinned-chain`,
 * `domain-mismatch`, `mainnet`, `network-not-allowed`, `series-mismatch`, `digest-mismatch`) or `AttestorToolError`
 * (`not-attestor-message`: a tier-2 REPORT). The result is frozen and is the only thing `signChecked` signs.
 */
export function checkRequest(req: unknown, pinned: PinnedNetworks, opts: { allowLocal?: boolean } = {}): CheckedSigningRequest {
  const rebuilt = checkSigningRequest(req, pinned, opts);
  const r = signingRequestSchema.parse(req) as SigningRequest;
  if (r.kind === 'REPORT' && (r.fields as SigningFields['REPORT']).tier !== 3) {
    throw new AttestorToolError('not-attestor-message', 'an attestor signs a tier-3 report attestation; tier 2 is the report verifier\'s own signature');
  }
  const c: CheckedSigningRequest = Object.freeze({
    kind: r.kind, chain: r.chain, seriesId: r.seriesId, seriesKey: r.seriesKey, domain: Object.freeze({ ...pinned[r.chain]! }), signer: rebuilt.signer,
    fields: Object.freeze({ ...r.fields }) as SigningFields[SigningKind], preimage: rebuilt.preimage, digest: rebuilt.digest, validWhile: r.validWhile,
  });
  checked.add(c);
  return c;
}

/** Kinds whose signature is a bearer authorisation anyone may submit (S4 amendment D2): the device warns before them. */
export const IRREVOCABLE_KINDS: ReadonlySet<SigningKind> = new Set(['PAUSE', 'EXTINGUISH']);

/** The warning the device states before it signs a PAUSE or an EXTINGUISH (S4 amendment D2). */
export const CANNOT_BE_RECALLED =
  'This signature cannot be recalled. Anyone who holds it can submit it until it is used or this key is revoked.';

/** A fixed-point integer (decimal string, `decimals` places) as an exact decimal number. */
function formatFixed(v: string, decimals: number): string {
  const neg = v.startsWith('-');
  const digits = (neg ? v.slice(1) : v).padStart(decimals + 1, '0');
  const int = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}
/** Unix seconds (a decimal string) as an ISO date, when it is one. */
function dateOf(seconds: string): string {
  const s = BigInt(seconds);
  return s <= 8_640_000_000_000n ? `${new Date(Number(s) * 1000).toISOString()} (unix ${seconds})` : `unix ${seconds} (beyond any calendar date)`;
}

/**
 * What the attestor reads before signing, built only from the typed fields this device checked and its own pinned
 * network (never from text the server sent: a `SigningRequest` carries none). It names the message, the network, the
 * series, the key and what the signature authorises, and ends, for a PAUSE or an EXTINGUISH, with `CANNOT_BE_RECALLED`.
 * No income figure can appear: Stage 1's messages carry commitments, never income.
 */
export function describeSigningRequest(c: CheckedSigningRequest): string[] {
  const lines: string[] = [];
  const f = c.fields as Record<string, unknown>;
  switch (c.kind) {
    case 'REPORT':
      lines.push(
        `Tier-3 report attestation (MERCES_REPORT_V1) for period ${String(f.periodId)}: you attest that the report's income commitment opens to the documented year-to-date figure (high-water mark) and chains from the prior one.`,
        `  prior income commitment ${String(f.priorIncomeCommitment)}`,
        `  income commitment       ${String(f.incomeCommitment)}`,
        `  liquidity event         ${f.liquidityEvent === true ? 'yes' : 'no'}`,
      );
      break;
    case 'FX':
      lines.push(`FX fallback rate (MERCES_FX_V1) for period ${String(f.periodId)}: ${formatFixed(String(f.fxRateWad), 18)} (WAD ${String(f.fxRateWad)}), for this series only.`);
      break;
    case 'AMEND':
      lines.push(
        `Terms amendment (MERCES_AMEND_V1) at amendment nonce ${String(f.amendmentNonce)}: you approve new terms for the series.`,
        `  new terms commitment ${String(f.termsCommitment)}`,
        `  new cap multiple     ${formatFixed(String(f.capMultipleWad), 18)}× (WAD ${String(f.capMultipleWad)})`,
      );
      break;
    case 'PAUSE':
      lines.push(`Pause approval (MERCES_PAUSE_V1) at pause nonce ${String(f.pauseNonce)}: you approve the issuer's pending pause request; payments pause until ${dateOf(String(f.pauseEnd))}.`);
      break;
    case 'EXTINGUISH':
      lines.push(`Extinguishment approval (MERCES_EXTINGUISH_V1) at extinguish nonce ${String(f.extinguishNonce)}: with a second attestor's signature, anyone may submit Stage 1's extinguish for this series, which ends it (holders then take their final claims).`);
      break;
    case 'TRUEUP':
      lines.push(
        `Annual true-up (MERCES_TRUEUP_V1) at true-up nonce ${String(f.trueupNonce)} for year ${String(f.year)}:`,
        `  adjustment ${formatFixed(String(f.adjustment), 6)} (a payment figure at 6 decimals, ${String(f.adjustment)}; positive is owed to holders, negative is credited forward)`,
        `  attested at ${dateOf(String(f.attestationTs))}`,
      );
      break;
  }
  lines.push(
    `Series:      ${c.seriesId}`,
    `Network:     ${c.chain}, ${networkLabel(c.domain)}`,
    `Domain:      ${c.domain.domain} (pinned on this device)`,
    `Series key:  ${c.seriesKey}`,
    `Signing key: ${toChecksumAddress(c.signer)}`,
    `Digest:      ${c.digest} (rebuilt on this device)`,
    `Valid while: ${c.validWhile}`,
  );
  if (c.kind !== 'REPORT' && c.kind !== 'FX') {
    lines.push('The nonce comes from the server: this tool cannot check it against the chain yet (S5 reads it from a public RPC). Sign only a request you expect.');
  }
  if (IRREVOCABLE_KINDS.has(c.kind)) lines.push(`WARNING: ${CANNOT_BE_RECALLED}`);
  return lines;
}

// ---------------------------------------------------------------- signing

/** A signature made on this device: the attestation the API takes (`{signer, signature}`) and the digest signed. */
export type DeviceSignature = Attestation & { digest: string };

/**
 * Signs a request `checkRequest` returned (and nothing else: `not-checked`), with the key it is addressed to
 * (`wrong-key` otherwise). The digest signed is the one this device rebuilt; the signature (Stage 1's `signDigest`:
 * RFC 6979, low `s`, `v ∈ {27, 28}`) is checked to recover to the key before it is returned.
 */
export function signChecked(c: CheckedSigningRequest, key: AttestorKey): DeviceSignature {
  if (!checked.has(c)) throw new AttestorToolError('not-checked', 'only a request this device checked (checkRequest) is signed');
  if (c.signer !== key.address) {
    throw new AttestorToolError('wrong-key', `the request is addressed to key ${toChecksumAddress(c.signer)}; this keystore holds ${key.checksumAddress}`);
  }
  const signature = signDigestWith(key, Uint8Array.from(Buffer.from(c.digest.slice(2), 'hex')));
  if (!signedBy(c.digest, signature, key.address)) throw new AttestorToolError('self-check', 'the signature does not recover to the key (refused)');
  return { signer: key.address, signature, digest: c.digest };
}

/** `checkRequest` then `signChecked`: the library form, with no display (the CLI shows the display and asks first). */
export function signRequest(req: unknown, key: AttestorKey, pinned: PinnedNetworks, opts: { allowLocal?: boolean } = {}): DeviceSignature {
  return signChecked(checkRequest(req, pinned, opts), key);
}

// ---------------------------------------------------------------- link proofs (EIP-191)

/** A key-link challenge's parts (`POST /me/signer-keys/challenge`). */
export interface LinkChallenge {
  /** the host that issued it (the API's sign-in domain) */
  host: string;
  accountId: string;
  /** the key it is for: 0x + 40 lowercase hex */
  address: string;
  nonce: string;
  issuedAt: string;
}

const LINK_LINE_0 = / asks you to link an attestor key to your account\.$/;

/**
 * Parses a key-link challenge and requires it to be exactly the text the API builds for `address`
 * (`signerKeyLinkMessage` in `@merces/ports`), so the key signs no other EIP-191 text. `not-link-challenge` for any
 * other text, `wrong-key` for a challenge naming another key. One trailing newline (a file saved from the API's
 * `message`) is ignored.
 */
export function checkLinkChallenge(text: string, address: string): LinkChallenge {
  const t = typeof text === 'string' ? text.replace(/\r?\n$/, '') : '';
  const lines = t.split('\n');
  const refuse = () => new AttestorToolError('not-link-challenge', 'this text is not a Merces key-link challenge (POST /me/signer-keys/challenge); the attestor key signs nothing else');
  if (lines.length !== 8 || !LINK_LINE_0.test(lines[0]!)) throw refuse();
  const host = lines[0]!.replace(LINK_LINE_0, '');
  const account = /^Account: (.+)$/.exec(lines[2]!);
  const key = /^Key: (0x[0-9a-fA-F]{40})$/.exec(lines[3]!);
  const nonce = /^Nonce: ([0-9a-f]{32})$/.exec(lines[4]!);
  const issuedAt = /^Issued at: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(lines[5]!);
  if (!host || !account || !key || !nonce || !issuedAt) throw refuse();
  if (key[1]!.toLowerCase() !== address.toLowerCase()) throw new AttestorToolError('wrong-key', `the challenge is for key ${toChecksumAddress(key[1]!.toLowerCase())}; this keystore holds ${toChecksumAddress(address.toLowerCase())}`);
  const c: LinkChallenge = { host, accountId: account[1]!, address: address.toLowerCase(), nonce: nonce[1]!, issuedAt: issuedAt[1]! };
  if (signerKeyLinkMessage({ domain: c.host, accountId: c.accountId, address: c.address, nonce: c.nonce, issuedAt: c.issuedAt }) !== t) throw refuse();
  return c;
}

/** What the attestor reads before signing a link proof. */
export function describeLinkChallenge(c: LinkChallenge): string[] {
  return [
    'Key-link proof (EIP-191 personal_sign): links this attestor key to your account on the host below. It is not a Stage 1 message, not an attestation, and it moves no funds.',
    `Host:      ${c.host} (check it is the Merces service you use)`,
    `Account:   ${c.accountId}`,
    `Key:       ${toChecksumAddress(c.address)}`,
    `Nonce:     ${c.nonce}`,
    `Issued at: ${c.issuedAt}`,
  ];
}

/**
 * The key's EIP-191 proof for a key-link challenge (S4 D4): `checkLinkChallenge`, then Stage 1's `signDigest` over
 * `personalMessageDigest(text)` (viem's `hashMessage`), self-checked. Returns the body of `POST /me/signer-keys`. Its
 * digest's pre-image starts with 0x19, never a `MERCES_*` message's, so a link proof is never an attestation.
 */
export function linkProof(challengeText: string, key: AttestorKey): { address: string; nonce: string; signature: string } {
  const c = checkLinkChallenge(challengeText, key.address);
  const text = challengeText.replace(/\r?\n$/, '');
  const digest = personalMessageDigest(text);
  const signature = signDigestWith(key, Uint8Array.from(Buffer.from(digest.slice(2), 'hex')));
  if (!signedBy(digest, signature, key.address)) throw new AttestorToolError('self-check', 'the signature does not recover to the key (refused)');
  return { address: key.address, nonce: c.nonce, signature };
}

