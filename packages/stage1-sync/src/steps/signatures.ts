import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { stage1Path } from '@merces/chains';
import {
  SIGNING_KINDS, bidCommitment, orderCommitment, recoverSigner, seriesKeyOf, signature65Hex, signingDigest, signingDomain, wallet32Of, type SigningFields,
  type SigningKind,
} from '@merces/domain';
import * as gateway from '@merces/math';
import {
  MAGIC, SECP256K1_N, addressFromPrivateKey, bidCommitmentBytes, bidCommitmentPreimage, evmAddressFromWallet, fromPid, publicKeyFromPrivate, seriesKeyFromId,
  signDigest, toChecksumAddress,
} from '@merces/math';
import * as testing from '@merces/math/testing';
import { signature65FromDer } from '@merces/ports';
import * as sdk from '@merces/sdk';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';

/**
 * The Stage 1 signing names `@merces/math` re-exports from `@merces/sdk` (S4 D1, A-SIG-1), each of which must be the
 * SDK's own object; `bidCommitmentBytes` is the SDK's `bidCommitment` under its byte-returning name.
 */
export const SIGNING_REEXPORTS = [
  'MAGIC', 'reportAttestationMessage', 'fxFallbackMessage', 'amendmentMessage', 'pauseApprovalMessage', 'extinguishMessage', 'trueUpMessage',
  'SECP256K1_N', 'SECP256K1_HALF_N', 'isLowS', 'signDigest', 'parseSignature', 'publicKeyFromPrivate', 'addressFromPublicKey', 'addressFromPrivateKey', 'recoverAddress', 'verifySignature', 'toChecksumAddress',
  'ChainKind', 'SOLANA_CLUSTER_TAGS', 'EVM_CHAIN_IDS', 'bidCommitmentPreimage', 'computeDomain', 'seriesKeyFromId',
  'walletFromSolanaPubkey', 'walletFromEvmAddress', 'evmAddressFromWallet', 'keccak256',
] as const;
export const SIGNING_RENAMED = { bidCommitmentBytes: 'bidCommitment' } as const;

/** At most this many failures are listed in the report (all are counted). */
const LISTED = 12;

interface KaMessage {
  kind: string; magic: string; domain: string; seriesKey: string; fields: Record<string, unknown>;
  preimage: string; preimageLength: number; digest: string; signer: string; signerAddress: string; signature: string; r: string; s: string; v: number;
}
interface KnownAnswers {
  wallets?: { kind: string; input: string; wallet: string }[];
  domains?: { name: string; chainKind: number; chainId: string; registry: string; preimage: string; domain: string }[];
  seriesKeys?: { evm?: { seriesId: string; key: string }; solana?: { base58: string; key: string } };
  bidCommitments?: { price: string; quantity: string; salt: string; wallet: string; walletNote?: string; preimage: string; commitment: string }[];
  testKeys?: { seed: string; privateKey: string; publicKey: string; address: string; addressChecksum: string }[];
  messages?: KaMessage[];
}

/** Where Stage 1's known answers sit in a drop: `known_answers.json` beside its vectors (`packages/vectors`). */
export function knownAnswersPath(ctx: StepCtx): string | null {
  const v = stage1Path(ctx.location, ctx.location.manifest.vectors);
  if (!v || !existsSync(v)) return null;
  const p = join(statSync(v).isDirectory() ? v : dirname(v), 'known_answers.json');
  return existsSync(p) ? p : null;
}

const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

/** KA's message fields in the canonical model's names (`fromPid` periods, decimal strings), or null for another kind. */
function fieldsOf(m: KaMessage): SigningFields[SigningKind] | null {
  const f = m.fields;
  switch (m.kind) {
    case 'REPORT': return { periodId: fromPid(f.period as number), priorIncomeCommitment: f.priorIncomeCommitment as string, incomeCommitment: f.incomeCommitment as string, tier: f.tier as 2 | 3, liquidityEvent: f.liquidityEvent as boolean };
    case 'FX': return { periodId: fromPid(f.period as number), fxRateWad: String(f.fxRateWad) };
    case 'AMEND': return { amendmentNonce: String(f.amendmentNonce), termsCommitment: f.newTermsCommitment as string, capMultipleWad: String(f.newCapMultipleWad) };
    case 'PAUSE': return { pauseNonce: String(f.pauseNonce), pauseEnd: String(f.pauseEnd) };
    case 'EXTINGUISH': return { extinguishNonce: String(f.extinguishNonce) };
    case 'TRUEUP': return { trueupNonce: String(f.trueupNonce), year: f.year as number, adjustment: String(f.adjustment), attestationTs: String(f.attestationTs) };
    default: return null;
  }
}

/** The series key a KA message names in words ("bytes32(uint256(1))", "series PDA base58 …"), through `seriesKeyOf`. */
function seriesKeyFor(described: string): string | null {
  const evm = /^bytes32\(uint256\((\d+)\)\)$/.exec(described);
  if (evm) return seriesKeyOf(`ka:${evm[1]}`, 'evm');
  const sol = /base58 ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(described);
  if (sol) return seriesKeyOf(`ka:${sol[1]}`, 'solana');
  return null;
}

/**
 * Step 4c, `signatures` (S4 WP1): Stage 1's signing known answers (`known_answers.json` beside its vectors, "KA"),
 * reproduced byte for byte through what we run: `@merces/math`'s re-exports (which must be the SDK's own objects) and
 * `@merces/domain`'s hex wrappers (signing.ts), so a change to either side, or to Stage 1's encodings at a new pin,
 * fails the sync.
 *
 * - **keys**: every test key from its seed (`@merces/math/testing`): private key, public key, address, EIP-55 form;
 * - **wallets**: `wallet32Of` (a Solana pubkey as-is, an EVM address left-padded);
 * - **domains**: `signingDomain` from each chain kind, chain id and registry;
 * - **series keys**: `seriesKeyOf` (and Stage 1's `seriesKeyFromId` for the EVM id);
 * - **bid commitments**: `bidCommitmentPreimage` and `bidCommitmentBytes`, and since S4 WP2 what our builders send: the
 *   domain's hex `bidCommitment` and `orderCommitment` from the bidder's chain-local address (the Solana pubkey KA's
 *   note names, else the EVM address its padded wallet holds), whose `wallet32Of` must be KA's wallet;
 * - **messages**: `reportDigest` … `trueUpDigest` over our own domain and series key give KA's pre-image and digest,
 *   `signDigest` with the seed's key gives KA's signature byte for byte (RFC 6979), and `recoverSigner` its address;
 * - **the DER path** (S4 WP3): what a cloud KMS returns for the same key and digest (a DER signature, with whatever `s`
 *   comes out: noble's own DER with `lowS: false`, and that signature with `s` forced high), through `@merces/ports`'
 *   `signature65FromDer` (low `s`, the recovery id by trial against the signer's address), gives KA's signature back.
 *
 * No known answers in the drop is a failure, never a skip: the signing primitives cannot be proven without them.
 */
export async function checkSignatures(ctx: StepCtx): Promise<StepReport> {
  const details: string[] = [];
  const failures: string[] = [];
  const fail = (what: string): void => {
    failures.push(what);
  };

  // the wiring: Stage 1's own objects
  const gw = gateway as unknown as Record<string, unknown>;
  const theirs = sdk as unknown as Record<string, unknown>;
  const notOwn = SIGNING_REEXPORTS.filter((n) => !(n in theirs) || gw[n] !== theirs[n]).map(String);
  for (const [ours, name] of Object.entries(SIGNING_RENAMED)) if (!(name in theirs) || gw[ours] !== theirs[name]) notOwn.push(`${ours} (${name})`);
  if (testing.deriveTestPrivateKey !== sdk.deriveTestPrivateKey) notOwn.push('deriveTestPrivateKey (@merces/math/testing)');
  if ('deriveTestPrivateKey' in gw) notOwn.push('deriveTestPrivateKey is on the main gateway (it belongs on @merces/math/testing only)');
  const total = SIGNING_REEXPORTS.length + Object.keys(SIGNING_RENAMED).length + 1;
  if (notOwn.length) fail(`@merces/math does not re-export Stage 1's own signing objects: ${notOwn.join(', ')}`);
  details.push(`re-exports: ${total - notOwn.length}/${total} signing names of @merces/math are @merces/sdk's own objects (deriveTestPrivateKey on @merces/math/testing only)`);

  const path = knownAnswersPath(ctx);
  if (!path) {
    const why = 'Stage 1\'s known answers (known_answers.json beside the vectors) are not in this drop: the signing primitives cannot be proven';
    details.unshift('signatures: FAIL (no known answers)');
    return { step: 'signatures', status: 'fail', summary: why, details };
  }
  let ka: KnownAnswers;
  try {
    ka = JSON.parse(readFileSync(path, 'utf8')) as KnownAnswers;
  } catch (e) {
    const why = `cannot read Stage 1's known answers: ${(e as Error).message}`;
    details.unshift('signatures: FAIL (unreadable known answers)');
    return { step: 'signatures', status: 'fail', summary: why, details };
  }
  details.push(`known answers: ${relative(ctx.location.root, path) || path}`);
  const listed: string[] = [];
  const bad = (section: string, at: string, what: string): void => {
    listed.push(`  ✗ ${section}${at}: ${what}`);
  };
  const guard = (section: string, at: string, f: () => void): void => {
    try {
      f();
    } catch (e) {
      bad(section, at, `threw ${(e as Error).name}: ${(e as Error).message}`);
    }
  };
  const need = <T>(section: string, v: T[] | undefined): T[] => {
    if (!v || v.length === 0) fail(`the known answers have no ${section}`);
    return v ?? [];
  };

  // keys
  const keys = need('testKeys', ka.testKeys);
  const privateKeyOf = new Map<string, Uint8Array>();
  for (const k of keys) {
    guard('keys', `[${k.seed}]`, () => {
      const sk = testing.deriveTestPrivateKey(k.seed);
      privateKeyOf.set(k.seed, sk);
      if (hex(sk) !== k.privateKey) bad('keys', `[${k.seed}]`, 'the derived private key differs');
      else if (hex(publicKeyFromPrivate(sk)) !== k.publicKey) bad('keys', `[${k.seed}]`, 'the public key differs');
      else if (hex(addressFromPrivateKey(sk)) !== k.address) bad('keys', `[${k.seed}]`, 'the address differs');
      else if (toChecksumAddress(k.address) !== k.addressChecksum) bad('keys', `[${k.seed}]`, 'the EIP-55 form differs');
    });
  }

  // wallets
  const wallets = need('wallets', ka.wallets);
  for (const [i, w] of wallets.entries()) {
    guard('wallets', `[${i}]`, () => {
      if (w.kind !== 'solana' && w.kind !== 'evm') bad('wallets', `[${i}]`, `unknown kind ${w.kind}`);
      else if (hex(wallet32Of(w.input, w.kind)) !== w.wallet) bad('wallets', `[${i}] ${w.kind}`, 'wallet32Of differs');
    });
  }

  // domains
  const domains = need('domains', ka.domains);
  const domainOf = new Map<string, string>();
  for (const d of domains) {
    guard('domains', `[${d.name}]`, () => {
      if (d.chainKind !== 1 && d.chainKind !== 2) return bad('domains', `[${d.name}]`, `unknown chain kind ${d.chainKind}`);
      const ours = signingDomain(d.chainKind === 1 ? 'solana' : 'evm', d.chainId, d.registry);
      domainOf.set(d.name, ours.domain);
      if (ours.registry !== d.registry || ours.chainId !== d.chainId || ours.domain !== d.domain) bad('domains', `[${d.name}]`, 'signingDomain differs');
    });
  }

  // series keys
  const sk = ka.seriesKeys ?? {};
  let seriesKeys = 0;
  if (sk.evm) {
    seriesKeys++;
    guard('series keys', '[evm]', () => {
      if (seriesKeyOf(`ka:${sk.evm!.seriesId}`, 'evm') !== sk.evm!.key || hex(seriesKeyFromId(BigInt(sk.evm!.seriesId))) !== sk.evm!.key) bad('series keys', '[evm]', 'seriesKeyOf differs');
    });
  }
  if (sk.solana) {
    seriesKeys++;
    guard('series keys', '[solana]', () => {
      if (seriesKeyOf(`ka:${sk.solana!.base58}`, 'solana') !== sk.solana!.key) bad('series keys', '[solana]', 'seriesKeyOf differs');
    });
  }
  if (seriesKeys === 0) fail('the known answers have no seriesKeys');

  // bid commitments
  const bids = need('bidCommitments', ka.bidCommitments);
  let ourBids = 0;
  for (const [i, b] of bids.entries()) {
    guard('bid commitments', `[${i}]`, () => {
      const wallet = bytes(b.wallet);
      if (hex(bidCommitmentPreimage(BigInt(b.price), BigInt(b.quantity), b.salt, wallet)) !== b.preimage) return bad('bid commitments', `[${i}]`, 'the pre-image differs');
      if (hex(bidCommitmentBytes(BigInt(b.price), BigInt(b.quantity), b.salt, wallet)) !== b.commitment) return bad('bid commitments', `[${i}]`, 'the commitment differs');
      // ours (S4 WP2): the builders take the bidder's chain-local address, as a client and the runner hold it
      const sol = /base58 ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(b.walletNote ?? '');
      const [address, family] = sol ? [sol[1]!, 'solana' as const] : [evmAddressFromWallet(wallet).toLowerCase(), 'evm' as const];
      if (hex(wallet32Of(address, family)) !== b.wallet) return bad('bid commitments', `[${i}]`, `wallet32Of of the ${family} bidder is not the wallet`);
      if (bidCommitment({ bidder: address, pricePerUnit: b.price, quantity: b.quantity, salt: b.salt }) !== b.commitment) return bad('bid commitments', `[${i}]`, 'our bidCommitment differs');
      if (orderCommitment({ wallet: address, pricePerUnit: b.price, quantity: b.quantity, salt: b.salt }) !== b.commitment) return bad('bid commitments', `[${i}]`, 'our orderCommitment differs');
      ourBids++;
    });
  }

  // messages
  const messages = need('messages', ka.messages);
  const kinds = new Set<string>();
  let derPath = 0;
  for (const [i, m] of messages.entries()) {
    const at = `[${i}] ${m.kind} (${m.domain})`;
    guard('messages', at, () => {
      kinds.add(m.kind);
      const fields = fieldsOf(m);
      if (!fields || !(SIGNING_KINDS as readonly string[]).includes(m.kind)) return bad('messages', at, 'a message kind this step does not know (Stage 1 added one?)');
      if (MAGIC[m.kind as SigningKind] !== m.magic) return bad('messages', at, 'the magic differs');
      const domain = domainOf.get(m.domain);
      if (!domain) return bad('messages', at, 'names a domain the known answers do not define');
      const seriesKey = seriesKeyFor(m.seriesKey);
      if (!seriesKey) return bad('messages', at, `cannot read the series key "${m.seriesKey}"`);
      const built = signingDigest(m.kind as SigningKind, { domain, seriesKey }, fields);
      if (built.preimage !== m.preimage || (built.preimage.length - 2) / 2 !== m.preimageLength) return bad('messages', at, 'the pre-image differs');
      if (built.digest !== m.digest) return bad('messages', at, 'the digest differs');
      const key = privateKeyOf.get(m.signer);
      if (!key) return bad('messages', at, `signer ${m.signer} is not a test key`);
      const sig = signDigest(built.digest, key);
      if (signature65Hex(sig) !== m.signature || hex(bytes(sig.r.toString(16).padStart(64, '0'))) !== m.r || hex(bytes(sig.s.toString(16).padStart(64, '0'))) !== m.s || sig.v !== m.v) {
        return bad('messages', at, 'signDigest does not give the known signature');
      }
      if (recoverSigner(built.digest, m.signature) !== m.signerAddress) return bad('messages', at, 'recoverSigner does not give the signer');
      // the DER path: a KMS's DER, s as it comes (high in most of KA's cases at the pin) and s forced high
      const der = secp256k1.sign(bytes(built.digest), key, { prehash: false, lowS: false, format: 'der' });
      const parsed = secp256k1.Signature.fromBytes(der, 'der');
      const high = parsed.hasHighS() ? der : new secp256k1.Signature(parsed.r, SECP256K1_N - parsed.s).toBytes('der');
      for (const [which, d] of [['as signed', der], ['s forced high', high]] as const) {
        let got: string;
        try {
          got = signature65FromDer(d, built.digest, m.signerAddress);
        } catch (e) {
          return bad('messages', at, `the DER path (${which}) fails: ${(e as Error).message}`);
        }
        if (got !== m.signature) return bad('messages', at, `the DER path (${which}) does not give the known signature`);
      }
      derPath++;
    });
  }
  const missingKinds = SIGNING_KINDS.filter((k) => !kinds.has(k));
  if (messages.length && missingKinds.length) fail(`the known answers have no ${missingKinds.join(', ')} message`);

  const counts = `${messages.length} messages, ${domains.length} domains, ${seriesKeys} series keys, ${bids.length} bid commitments, ${keys.length} keys, ${wallets.length} wallets, DER path ${derPath}/${messages.length}`;
  if (listed.length) fail(`${listed.length} known answer(s) not reproduced`);
  details.push(
    `keys: ${keys.length} from their seeds (private key, public key, address, EIP-55)`,
    `wallets: ${wallets.length} through wallet32Of; domains: ${domains.length} through signingDomain; series keys: ${seriesKeys} through seriesKeyOf; bid commitments: ${bids.length} through bidCommitmentBytes, ${ourBids} through our bidCommitment and orderCommitment (the bidder's address)`,
    `messages: ${messages.length} through reportDigest … trueUpDigest (pre-image, digest), signDigest (signature byte-equal, RFC 6979) and recoverSigner (the signer's address)`,
    `DER path: ${derPath}/${messages.length} known signatures from a KMS-style DER signature (s as signed and s forced high) through signature65FromDer (@merces/ports)`,
    ...listed.slice(0, LISTED),
  );
  if (listed.length > LISTED) details.push(`  … and ${listed.length - LISTED} more`);
  if (failures.length) {
    details.unshift(`signatures: FAIL (${counts})`);
    return { step: 'signatures', status: 'fail', summary: `Stage 1's signing known answers are not reproduced: ${failures.join('; ')}`, details };
  }
  details.unshift(`signatures: ok (${counts})`);
  return { step: 'signatures', status: 'ok', summary: `Stage 1's signing known answers reproduced byte for byte through @merces/math, @merces/domain and @merces/ports' DER normaliser (${counts})`, details };
}
