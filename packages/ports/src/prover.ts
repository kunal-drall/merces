import { REPORT_PUBLIC_INPUT_NAMES, mockVerify, type ReportProof } from '@merces/domain';

/**
 * Proof-system port (R11). The device generates a proof of Stage 1's ProofOfIncome circuit; the services verify it
 * offchain before submission. The proof is the command's `proof.proof`: snarkjs Groth16 JSON, or the mock digest.
 */
export interface ProofVerifierPort {
  readonly system: 'groth16-bn254' | 'mock';
  verify(proof: ReportProof['proof'], publicInputs: string[]): Promise<boolean>;
}

/** The mock system (a digest over Stage 1's six public signals): simulator-only, it proves nothing. */
export class MockProofVerifier implements ProofVerifierPort {
  readonly system = 'mock' as const;
  async verify(proof: ReportProof['proof'], publicInputs: string[]): Promise<boolean> {
    return mockVerify(proof, publicInputs);
  }
}

/** snarkjs 0.7.6: groth16.verify(vkey, publicSignals, proof), with the proof as snarkjs JSON {pi_a, pi_b, pi_c, protocol, curve}. */
export class SnarkjsGroth16Verifier implements ProofVerifierPort {
  readonly system = 'groth16-bn254' as const;
  constructor(private readonly vkey: Record<string, unknown>) {}
  async verify(proof: ReportProof['proof'], publicInputs: string[]): Promise<boolean> {
    if (typeof proof === 'string') return false;
    const snarkjs = (await import('snarkjs')) as unknown as { groth16: { verify(vk: unknown, pub: string[], proof: unknown): Promise<boolean> } };
    return snarkjs.groth16.verify(this.vkey, publicInputs, proof);
  }
}

/** Prover artifacts served to devices (R11). Placeholder until Stage 1 publishes the circuit. */
export interface ProverArtifacts {
  circuitId: string;
  version: string;
  system: 'groth16-bn254' | 'mock';
  publicInputLayout: string[];
  wasmUrl: string | null;
  zkeyUrl: string | null;
  vkey: Record<string, unknown> | null;
  notes: string;
}

export const PLACEHOLDER_ARTIFACTS: ProverArtifacts = {
  circuitId: 'merces-proof-of-income',
  version: '0.1.0-mock',
  system: 'mock',
  publicInputLayout: [...REPORT_PUBLIC_INPUT_NAMES],
  wasmUrl: null,
  zkeyUrl: null,
  vkey: null,
  notes: 'The public inputs follow Stage 1\'s ProofOfIncome circuit (stage1/circuits). Until the services verify Groth16 (S1 WP10), devices use the mock system: a digest over the six public inputs, accepted only by a simulator configured for it.',
};
