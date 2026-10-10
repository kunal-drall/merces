import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson, mockVerify, REPORT_PUBLIC_INPUT_NAMES, type ReportProof } from '@merces/domain';

/**
 * Proof-system port (R11). The issuer's device proves Stage 1's ProofOfIncome circuit (`@merces/circuits`, Groth16
 * over BN254); the services verify the proof offchain before they build `submitReport`, and simulator chains verify it
 * again before their engine runs. The proof is the command's `proof.proof`: snarkjs Groth16 JSON, or the mock digest.
 *
 * Stage 1's verifier and prover live in `@merces/circuits` (the `stage1` submodule). It is imported lazily: loading it
 * pulls in snarkjs and ffjavascript, and verifying starts a multithreaded curve whose worker threads keep a process
 * alive until `shutdownProofSystem()` terminates them.
 */

export type ReportProofSystem = ReportProof['system'];

export interface ProofVerifierPort {
  /** the proof systems this verifier accepts (a proof of any other system is refused before `verify`) */
  readonly systems: readonly ReportProofSystem[];
  /** true when the proof verifies against the six public inputs; never throws */
  verify(proof: ReportProof['proof'], publicInputs: readonly string[]): Promise<boolean>;
}

type Circuits = typeof import('@merces/circuits');
let circuitsModule: Promise<Circuits> | null = null;
const loadCircuits = (): Promise<Circuits> => (circuitsModule ??= import('@merces/circuits'));

const DECIMAL = /^\d{1,78}$/;

/** Per-process verdicts keyed by sha256 of the canonical {proof, signals}: a proof is verified once per process. */
const verdicts = new Map<string, Promise<boolean>>();
/** A bound on the cache: a flood of distinct garbage proofs must not grow memory without limit. */
const MAX_VERDICTS = 10_000;

function verdictKey(proof: unknown, publicInputs: readonly string[]): string {
  return createHash('sha256').update(canonicalJson({ proof, signals: [...publicInputs] })).digest('hex');
}

/**
 * Stage 1's Groth16 verifier (`@merces/circuits` `verifyReport`, the development verification key) behind the port.
 * Malformed proofs and signals, and a verifier that throws, count as a proof that does not verify; nothing about the
 * inputs is reported. Verdicts are cached per process.
 */
export class Groth16ReportVerifier implements ProofVerifierPort {
  readonly systems = ['groth16-bn254'] as const;

  async verify(proof: ReportProof['proof'], publicInputs: readonly string[]): Promise<boolean> {
    if (typeof proof !== 'object' || proof === null) return false;
    if (publicInputs.length !== REPORT_PUBLIC_INPUT_NAMES.length || !publicInputs.every((s) => typeof s === 'string' && DECIMAL.test(s))) return false;
    const key = verdictKey(proof, publicInputs);
    let v = verdicts.get(key);
    if (!v) {
      v = (async () => {
        try {
          const c = await loadCircuits();
          return (await c.verifyReport(proof as unknown as Parameters<Circuits['verifyReport']>[0], [...publicInputs])) === true;
        } catch {
          return false;
        }
      })();
      if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!);
      verdicts.set(key, v);
    }
    return v;
  }
}

/** The mock system (a digest over Stage 1's six public signals): simulator-only, it proves nothing. */
export class MockProofVerifier implements ProofVerifierPort {
  readonly systems = ['mock'] as const;
  async verify(proof: ReportProof['proof'], publicInputs: readonly string[]): Promise<boolean> {
    return mockVerify(proof, publicInputs);
  }
}

/**
 * The verifier a process runs: Groth16 always; the mock system too only when `acceptMock` (a simulator-only process
 * with `MERCES_PROOF_SYSTEM=mock`, see `reportProofSystemFromEnv`).
 */
export function reportProofVerifier(opts: { acceptMock: boolean; groth16?: Groth16ReportVerifier }): ProofVerifierPort {
  const g16 = opts.groth16 ?? new Groth16ReportVerifier();
  if (!opts.acceptMock) return g16;
  const mock = new MockProofVerifier();
  return {
    systems: ['groth16-bn254', 'mock'],
    verify: (proof, publicInputs) => (typeof proof === 'string' ? mock.verify(proof, publicInputs) : g16.verify(proof, publicInputs)),
  };
}

/**
 * The report proof system a process accepts, from `MERCES_PROOF_SYSTEM` (`groth16`, the default, or `mock`).
 *
 * Mock proofs are forgeable by construction (anyone can compute the digest), so `mock` is accepted only in a process
 * whose every chain is the simulator; with a live chain configured it refuses to start rather than silently accept
 * them. The caller logs `MOCK_PROOFS_WARNING` when the answer is `mock`.
 */
export function reportProofSystemFromEnv(env: NodeJS.ProcessEnv, opts: { simulatorOnly: boolean }): ReportProofSystem {
  const v = (env.MERCES_PROOF_SYSTEM ?? 'groth16').trim().toLowerCase();
  if (v === '' || v === 'groth16' || v === 'groth16-bn254') return 'groth16-bn254';
  if (v !== 'mock') throw new Error(`MERCES_PROOF_SYSTEM must be "groth16" or "mock" (got "${v}")`);
  if (!opts.simulatorOnly) throw new Error('MERCES_PROOF_SYSTEM=mock is refused: mock report proofs are forgeable, and this process has a live chain');
  return 'mock';
}

export const MOCK_PROOFS_WARNING = 'MERCES_PROOF_SYSTEM=mock: simulator chains and the report service accept MOCK report proofs, which anyone can forge. Simulator-only development use; never with a live chain.';

/**
 * Terminate the proof system's worker threads (ffjavascript caches a multithreaded bn128 curve on
 * `globalThis.curve_bn128`; snarkjs verification and proving start it). Waits for in-flight verifications first.
 * Safe to call more than once; a later verification builds a fresh curve. Every CLI that verified or proved, and the
 * servers on shutdown, call it.
 */
export async function shutdownProofSystem(): Promise<void> {
  await Promise.allSettled([...verdicts.values()]);
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null };
  const curve = g.curve_bn128;
  if (curve && typeof curve.terminate === 'function') await curve.terminate();
}

// ---------------------------------------------------------------- prover artifacts served to devices

export type ProverArtifactKind = 'wasm' | 'zkey';

/** What a device needs to prove: Stage 1's circuit, its public input layout and the artifacts, each with its sha256. */
export interface ProverArtifacts {
  circuitId: string;
  version: string;
  system: 'groth16-bn254';
  publicInputLayout: string[];
  wasm: { url: string; sha256: string; bytes: number };
  zkey: { url: string; sha256: string; bytes: number };
  vkeySha256: string;
  vkey: Record<string, unknown>;
  /** the trusted setup the zkey comes from */
  trustedSetup: 'development';
  notes: string;
}

interface LoadedArtifacts {
  /** Stage 1's `PUBLIC_INPUT_NAMES` (`@merces/circuits`) */
  publicInputNames: string[];
  files: Record<ProverArtifactKind, { bytes: Buffer; sha256: string }>;
  vkeySha256: string;
  vkey: Record<string, unknown>;
}
let artifactsLoaded: Promise<LoadedArtifacts> | null = null;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Reads Stage 1's artifacts (`stage1/circuits/build`) once and checks each against the build's `MANIFEST.txt`
 * (`wasm_sha256`, `zkey_sha256`, `vk_sha256`): a file that differs from its manifest entry is never served.
 */
function loadArtifacts(): Promise<LoadedArtifacts> {
  return (artifactsLoaded ??= (async () => {
    const c = await loadCircuits();
    const [wasm, zkey, vk, manifestText] = await Promise.all([readFile(c.WASM_PATH), readFile(c.ZKEY_PATH), readFile(c.VERIFICATION_KEY_PATH), readFile(join(dirname(c.WASM_PATH), 'MANIFEST.txt'), 'utf8')]);
    const manifest = Object.fromEntries(manifestText.split('\n').map((l) => l.split(':').map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0]) as [string, string][]);
    const files = { wasm: { bytes: wasm, sha256: sha256(wasm) }, zkey: { bytes: zkey, sha256: sha256(zkey) } };
    const vkeySha256 = sha256(vk);
    for (const [name, got] of [['wasm_sha256', files.wasm.sha256], ['zkey_sha256', files.zkey.sha256], ['vk_sha256', vkeySha256]] as const) {
      if (manifest[name] !== got) throw new Error(`Stage 1 prover artifact does not match its manifest (${name})`);
    }
    return { publicInputNames: [...c.PUBLIC_INPUT_NAMES], files, vkeySha256, vkey: JSON.parse(vk.toString('utf8')) as Record<string, unknown> };
  })().catch((e: unknown) => {
    artifactsLoaded = null;
    throw e;
  }));
}

/** The circuit description devices fetch (`GET /prover/artifacts`); `base` is where the files are served. */
export async function stage1ProverArtifacts(base = '/prover'): Promise<ProverArtifacts> {
  const a = await loadArtifacts();
  return {
    circuitId: 'merces-proof-of-income',
    version: 'stage1-spec-1.1.2',
    system: 'groth16-bn254',
    publicInputLayout: a.publicInputNames,
    wasm: { url: `${base}/report.wasm`, sha256: a.files.wasm.sha256, bytes: a.files.wasm.bytes.length },
    zkey: { url: `${base}/report.zkey`, sha256: a.files.zkey.sha256, bytes: a.files.zkey.bytes.length },
    vkeySha256: a.vkeySha256,
    vkey: a.vkey,
    trustedSetup: 'development',
    notes:
      "Stage 1's ProofOfIncome circuit (stage1/circuits, SPEC v1.1.2 §8): Groth16 over BN254, public inputs in the order given. " +
      'The proving key comes from a DEVELOPMENT trusted setup with a public beacon (stage1/circuits/build/MANIFEST.txt): anyone can forge proofs with it. ' +
      'Never mainnet. Check each file against its sha256 before proving; prove on the device with fresh randomness (snarkjs groth16.fullProve).',
  };
}

/** One artifact's bytes and sha256 (`GET /prover/report.wasm`, `GET /prover/report.zkey`). */
export async function proverArtifactFile(kind: ProverArtifactKind): Promise<{ bytes: Buffer; sha256: string; contentType: string }> {
  const f = (await loadArtifacts()).files[kind];
  return { bytes: f.bytes, sha256: f.sha256, contentType: kind === 'wasm' ? 'application/wasm' : 'application/octet-stream' };
}
