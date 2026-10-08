import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Canonical hashing for commitments and attestations. All parties (device, verifier, simulator, Stage 1)
 * must agree on these byte layouts; Stage 1's actual layouts are mapped by the adapters and recorded in
 * INTERFACE_DRIFT.md if they differ.
 */

export function sha256Hex(data: Uint8Array): string {
  return '0x' + bytesToHex(sha256(data));
}

/** Deterministic JSON: sorted keys, no whitespace, bigint as string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function hashCanonical(domainTag: string, value: unknown): string {
  return sha256Hex(utf8ToBytes(`merces/${domainTag}/v0\n` + canonicalJson(value)));
}

/** terms_commitment = hash(θ, r, reporting currency, indexing rule, salt) (C4). θ in income base units, r in WAD. */
export function termsCommitment(input: { threshold: bigint | string; ratePerUnitWad: bigint | string; reportingCurrency: string; indexingRule: string; salt: string }): string {
  return hashCanonical('terms', {
    threshold: input.threshold.toString(),
    ratePerUnitWad: input.ratePerUnitWad.toString(),
    reportingCurrency: input.reportingCurrency,
    indexingRule: input.indexingRule,
    salt: input.salt,
  });
}

/** income_commitment = hash(seriesId, periodId, income YTD figure, salt). Computed on the issuer's device. */
export function incomeCommitment(input: { seriesId: string; periodId: string; incomeYtd: bigint | string; salt: string }): string {
  return hashCanonical('income', { seriesId: input.seriesId, periodId: input.periodId, incomeYtd: input.incomeYtd.toString(), salt: input.salt });
}

/** Sealed-bid commitment = hash(seriesId, bidder, price, quantity, salt). */
export function bidCommitment(input: { seriesId: string; bidder: string; pricePerUnit: bigint | string; quantity: bigint | string; salt: string }): string {
  return hashCanonical('bid', { seriesId: input.seriesId, bidder: input.bidder, pricePerUnit: input.pricePerUnit.toString(), quantity: input.quantity.toString(), salt: input.salt });
}

/** Transfer-window order commitment. */
export function orderCommitment(input: { seriesId: string; windowId: number; wallet: string; side: 'buy' | 'sell'; pricePerUnit: bigint | string; quantity: bigint | string; salt: string }): string {
  return hashCanonical('order', { ...input, pricePerUnit: input.pricePerUnit.toString(), quantity: input.quantity.toString() });
}

/** The message a report verifier signs (ed25519). It names no income source: sources never go onchain (B7). */
export function attestationMessage(input: { seriesId: string; periodId: string; incomeCommitment: string; tier: number }): Uint8Array {
  return utf8ToBytes(`merces/attestation/v0\n` + canonicalJson({ seriesId: input.seriesId, periodId: input.periodId, incomeCommitment: input.incomeCommitment, tier: input.tier }));
}

/** The message an attestor signs when attesting a fallback FX rate. */
export function fxAttestationMessage(input: { pair: string; periodId: string; rateWad: string }): Uint8Array {
  return utf8ToBytes(`merces/fx-attestation/v0\n` + canonicalJson(input));
}

/**
 * Mock proof system used by the simulator until Stage 1's Groth16 circuit exists.
 * The "proof" is a digest over the public inputs and a private witness digest; the verifier recomputes the digest
 * from the public inputs and the witness digest supplied inside the proof string. This exercises the full data
 * flow (public inputs, commitments, verification before submission) without any cryptographic soundness.
 */
export function mockProve(publicInputs: string[], witness: { incomeYtd: string; threshold: string; ratePerUnitWad: string; salt: string }): string {
  const witnessDigest = hashCanonical('mock-witness', witness);
  // The proof reveals only the witness digest, never the witness.
  return hashCanonical('mock-proof', { publicInputs, witnessDigest }) + ':' + witnessDigest.slice(2);
}

export function mockVerify(proof: string, publicInputs: string[]): boolean {
  const [digest, witnessDigestNoPrefix] = proof.split(':');
  if (!digest || !witnessDigestNoPrefix) return false;
  return hashCanonical('mock-proof', { publicInputs, witnessDigest: '0x' + witnessDigestNoPrefix }) === digest;
}

export function randomSalt(bytes = 32): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return '0x' + bytesToHex(b);
}

export { bytesToHex, hexToBytes, utf8ToBytes };

/**
 * zk public input layout v0 (A-REP-2), shared by the device prover, the report verifier, the services and the
 * simulator: [termsCommitment, incomeCommitment, unitsOutstanding, paymentStable, fxAvgWad, periodIndex].
 * periodIndex = year × 4 + (quarter − 1). Stage 1's circuit wins if it differs (recorded in INTERFACE_DRIFT.md).
 */
export function reportPublicInputs(p: { termsCommitment: string; incomeCommitment: string; unitsOutstanding: bigint | string; paymentStable: bigint | string; fxAvgWad: bigint | string; periodId: string }): string[] {
  const m = /^(\d{4})Q([1-4])$/.exec(p.periodId);
  if (!m) throw new RangeError(`bad period id ${p.periodId}`);
  const idx = Number(m[1]) * 4 + Number(m[2]) - 1;
  return [p.termsCommitment, p.incomeCommitment, p.unitsOutstanding.toString(), p.paymentStable.toString(), p.fxAvgWad.toString(), String(idx)];
}
