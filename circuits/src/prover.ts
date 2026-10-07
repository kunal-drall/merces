/// <reference path="./ffjavascript.d.ts" />
/**
 * Prover and proof encoders for the Merces ProofOfIncome report circuit (`src/report.circom`).
 *
 * Uses the development artefacts in `../build` (see `build/README.md`: not for production).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { groth16, type Groth16Proof, type PublicSignals } from "snarkjs";
export type { Groth16Proof, PublicSignals } from "snarkjs";
import { buildBn128 } from "ffjavascript";
import { keccak_256 } from "@noble/hashes/sha3.js";

const require = createRequire(import.meta.url);

/** BN254 scalar field modulus (public inputs and witness values live here). */
export const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field modulus (point coordinates live here). */
export const BN254_FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
/** 1e18 fixed point. */
export const WAD = 1_000_000_000_000_000_000n;

export const WASM_PATH = fileURLToPath(new URL("../build/report.wasm", import.meta.url));
export const ZKEY_PATH = fileURLToPath(new URL("../build/report_final.zkey", import.meta.url));
export const VERIFICATION_KEY_PATH = fileURLToPath(new URL("../build/verification_key.json", import.meta.url));

/** Names of the public inputs, in public-signal order (SPEC §8). */
export const PUBLIC_INPUT_NAMES = [
  "terms_commitment",
  "units_outstanding",
  "fx_avg_wad",
  "prior_income_commitment",
  "income_commitment",
  "payment_usd",
] as const;
export const NR_PUBLIC_INPUTS = PUBLIC_INPUT_NAMES.length;

/** Every signal of the circuit. Values are field elements (`0 ≤ v < BN254_FR`). */
export interface ReportInputs {
  // public
  terms_commitment: bigint;
  units_outstanding: bigint;
  fx_avg_wad: bigint;
  prior_income_commitment: bigint;
  income_commitment: bigint;
  payment_usd: bigint;
  // private
  theta: bigint;
  r_wad: bigint;
  currency_code: bigint;
  indexing_rule: bigint;
  terms_salt: bigint;
  income_ytd: bigint;
  income_salt: bigint;
  prior_income_ytd: bigint;
  prior_salt: bigint;
}

export interface ReportProof {
  proof: Groth16Proof;
  publicSignals: PublicSignals;
}

export interface ProveOptions {
  /**
   * Derive the Groth16 blinding scalars (r, s) from a hash of the inputs instead of the system
   * CSPRNG, so the same inputs always give the same proof (default: true). The proof stays
   * zero-knowledge towards verifiers because the derivation includes the private salts; it is
   * only reproducible for someone who already knows the witness. Set to false for fresh
   * randomness.
   */
  deterministic?: boolean;
  /** Extra bytes mixed into the deterministic derivation (for several proofs over one witness). */
  nonce?: Uint8Array;
}

// ---------------------------------------------------------------------------------------------
// YTD arithmetic (mirrors the circuit; the canonical copy for the protocol is @merces/reference)
// ---------------------------------------------------------------------------------------------

export function owedYtd(rWad: bigint, unitsOutstanding: bigint, incomeYtd: bigint, theta: bigint): bigint {
  const excess = incomeYtd > theta ? incomeYtd - theta : 0n;
  return (rWad * unitsOutstanding * excess) / WAD;
}

/** payment_usd = floor((owed(income) − owed(prior)) × fx / WAD), exactly as the circuit computes it. */
export function expectedPaymentUsd(args: {
  rWad: bigint;
  unitsOutstanding: bigint;
  theta: bigint;
  incomeYtd: bigint;
  priorIncomeYtd: bigint;
  fxAvgWad: bigint;
}): bigint {
  const now = owedYtd(args.rWad, args.unitsOutstanding, args.incomeYtd, args.theta);
  const prior = owedYtd(args.rWad, args.unitsOutstanding, args.priorIncomeYtd, args.theta);
  if (now < prior) throw new Error("owed amount must be monotone");
  return ((now - prior) * args.fxAvgWad) / WAD;
}

// ---------------------------------------------------------------------------------------------
// Proving and verifying
// ---------------------------------------------------------------------------------------------

type FrLike = { random: () => Uint8Array; e: (v: bigint) => Uint8Array };
type Bn128Curve = { Fr: FrLike };

let curvePromise: Promise<Bn128Curve> | undefined;
async function sharedCurve(): Promise<Bn128Curve> {
  // ffjavascript caches the multi-threaded bn128 instance on globalThis; snarkjs' prover uses the
  // same cached object, which is what lets us swap the blinding-scalar RNG below.
  curvePromise ??= buildBn128(false) as Promise<Bn128Curve>;
  return curvePromise;
}

let proveLock: Promise<unknown> = Promise.resolve();

function canonicalInputs(inputs: ReportInputs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(inputs).sort()) {
    const v = inputs[key as keyof ReportInputs];
    if (typeof v !== "bigint") throw new TypeError(`input ${key} must be a bigint`);
    if (v < 0n || v >= BN254_FR) throw new RangeError(`input ${key} is not a field element`);
    out[key] = v.toString();
  }
  return out;
}

function deriveBlindingScalars(inputs: Record<string, string>, nonce: Uint8Array | undefined): [bigint, bigint] {
  const enc = new TextEncoder();
  const seed = keccak_256(
    concatBytes(enc.encode("MERCES_DEV_PROOF_RNG_V1"), enc.encode(JSON.stringify(inputs)), nonce ?? new Uint8Array(0)),
  );
  const scalar = (index: number): bigint => {
    // 512 bits reduced mod r: bias < 2^-250.
    const a = keccak_256(concatBytes(seed, Uint8Array.of(index, 0)));
    const b = keccak_256(concatBytes(seed, Uint8Array.of(index, 1)));
    return (bytesToBigInt(a) * (1n << 256n) + bytesToBigInt(b)) % BN254_FR;
  };
  return [scalar(0), scalar(1)];
}

/**
 * Produces a Groth16 proof for the report circuit. Throws (from the witness calculator) when the
 * inputs do not satisfy the constraints, e.g. a wrong `payment_usd` or commitment.
 */
export async function proveReport(inputs: ReportInputs, options: ProveOptions = {}): Promise<ReportProof> {
  const canonical = canonicalInputs(inputs);
  const deterministic = options.deterministic ?? true;
  const run = async (): Promise<ReportProof> => {
    const curve = await sharedCurve();
    const Fr = curve.Fr;
    const originalRandom = Fr.random;
    if (deterministic) {
      const [r, s] = deriveBlindingScalars(canonical, options.nonce);
      const queue = [r, s];
      Fr.random = () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("deterministic prover: unexpected extra randomness request");
        return Fr.e(next);
      };
    }
    try {
      const { proof, publicSignals } = await groth16.fullProve(canonical, WASM_PATH, ZKEY_PATH);
      return { proof, publicSignals };
    } finally {
      Fr.random = originalRandom;
    }
  };
  const result = proveLock.then(run, run);
  proveLock = result.catch(() => undefined);
  return result;
}

let vkCache: unknown;
export function loadVerificationKey(): unknown {
  vkCache ??= JSON.parse(readFileSync(VERIFICATION_KEY_PATH, "utf8"));
  return vkCache;
}

export async function verifyReport(proof: Groth16Proof, publicSignals: PublicSignals): Promise<boolean> {
  return groth16.verify(loadVerificationKey(), publicSignals, proof);
}

/** The public signals the verifier will see for a given input set, in order. */
export function publicSignalsOf(inputs: ReportInputs): string[] {
  return PUBLIC_INPUT_NAMES.map((name) => inputs[name].toString());
}

// ---------------------------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------------------------

export interface EvmProofEncoding {
  /** `uint256[2]` — pi_a.x, pi_a.y as decimal strings. */
  pA: [string, string];
  /** `uint256[2][2]` — [[x.c1, x.c0], [y.c1, y.c0]] (imaginary part first), decimal strings. */
  pB: [[string, string], [string, string]];
  /** `uint256[2]` — pi_c.x, pi_c.y. */
  pC: [string, string];
  /** `uint256[6]` public signals, decimal strings. */
  pubSignals: string[];
  /** `abi.encode(pA, pB, pC)`: 8 words, 256 bytes, hex. */
  proofBytes: string;
  /** Full calldata for `verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])`, hex. */
  calldata: string;
}

export interface SolanaProofEncoding {
  /** 64 bytes hex: pi_a with its y coordinate NEGATED (x ‖ q − y), as groth16-solana expects. */
  proofA: string;
  /** 128 bytes hex: x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0 of pi_b, big-endian. */
  proofB: string;
  /** 64 bytes hex: pi_c x ‖ y. */
  proofC: string;
  /** 256 bytes hex: proofA ‖ proofB ‖ proofC (the instruction payload). */
  proof: string;
  /** Six 32-byte big-endian field elements, hex, in public-input order. */
  publicInputs: string[];
}

const VERIFY_PROOF_SELECTOR = bytesToHex(
  keccak_256(new TextEncoder().encode("verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])")).slice(0, 4),
);

export function encodeProofForEvm(proof: Groth16Proof, publicSignals: PublicSignals): EvmProofEncoding {
  assertGroth16(proof);
  if (publicSignals.length !== NR_PUBLIC_INPUTS) throw new Error(`expected ${NR_PUBLIC_INPUTS} public signals`);
  const pA: [string, string] = [dec(proof.pi_a[0]!), dec(proof.pi_a[1]!)];
  const pB: [[string, string], [string, string]] = [
    [dec(proof.pi_b[0]![1]!), dec(proof.pi_b[0]![0]!)],
    [dec(proof.pi_b[1]![1]!), dec(proof.pi_b[1]![0]!)],
  ];
  const pC: [string, string] = [dec(proof.pi_c[0]!), dec(proof.pi_c[1]!)];
  const pubSignals = publicSignals.map((s) => dec(s));
  const words = [...pA, ...pB[0], ...pB[1], ...pC].map((w) => word(BigInt(w), BN254_FQ));
  const proofBytes = "0x" + words.join("");
  const calldata = "0x" + VERIFY_PROOF_SELECTOR + words.join("") + pubSignals.map((p) => word(BigInt(p), BN254_FR)).join("");
  return { pA, pB, pC, pubSignals, proofBytes, calldata };
}

/** Affine negation of a G1 point given as decimal coordinate strings: (x, y) → (x, q − y). */
export function negateG1(x: bigint, y: bigint): [bigint, bigint] {
  if (x >= BN254_FQ || y >= BN254_FQ) throw new RangeError("coordinate out of range");
  return [x, y === 0n ? 0n : BN254_FQ - y];
}

export function encodeProofForSolana(proof: Groth16Proof, publicSignals: PublicSignals): SolanaProofEncoding {
  assertGroth16(proof);
  if (publicSignals.length !== NR_PUBLIC_INPUTS) throw new Error(`expected ${NR_PUBLIC_INPUTS} public signals`);
  const [ax, ay] = negateG1(BigInt(proof.pi_a[0]!), BigInt(proof.pi_a[1]!));
  const proofA = word(ax, BN254_FQ) + word(ay, BN254_FQ);
  const proofB =
    word(BigInt(proof.pi_b[0]![1]!), BN254_FQ) +
    word(BigInt(proof.pi_b[0]![0]!), BN254_FQ) +
    word(BigInt(proof.pi_b[1]![1]!), BN254_FQ) +
    word(BigInt(proof.pi_b[1]![0]!), BN254_FQ);
  const proofC = word(BigInt(proof.pi_c[0]!), BN254_FQ) + word(BigInt(proof.pi_c[1]!), BN254_FQ);
  const publicInputs = publicSignals.map((s) => "0x" + word(BigInt(s), BN254_FR));
  return {
    proofA: "0x" + proofA,
    proofB: "0x" + proofB,
    proofC: "0x" + proofC,
    proof: "0x" + proofA + proofB + proofC,
    publicInputs,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function assertGroth16(proof: Groth16Proof): void {
  if (proof.protocol !== "groth16" || proof.curve !== "bn128") throw new Error("not a bn128 groth16 proof");
  if (proof.pi_a[2] !== "1" || proof.pi_c[2] !== "1" || proof.pi_b[2]![0] !== "1" || proof.pi_b[2]![1] !== "0") {
    throw new Error("proof points must be affine");
  }
}

function dec(v: string | bigint | number): string {
  return BigInt(v).toString(10);
}

function word(v: bigint, modulus: bigint): string {
  if (v < 0n || v >= modulus) throw new RangeError(`value ${v} out of range`);
  return v.toString(16).padStart(64, "0");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** snarkjs version actually loaded (for manifests). */
export function snarkjsVersion(): string {
  return (require("snarkjs/package.json") as { version: string }).version;
}
