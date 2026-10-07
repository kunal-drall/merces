import { mockVerify } from '@merces/domain';

/**
 * Proof-system port (R11). The device generates a Groth16 proof with the prover artifacts we serve; the services
 * verify it offchain before submission. Until Stage 1's circuit exists the mock system is used end to end.
 */
export interface ProofVerifierPort {
  readonly system: 'groth16-bn254' | 'mock';
  verify(proof: string, publicInputs: string[]): Promise<boolean>;
}

export class MockProofVerifier implements ProofVerifierPort {
  readonly system = 'mock' as const;
  async verify(proof: string, publicInputs: string[]): Promise<boolean> {
    return mockVerify(proof, publicInputs);
  }
}

/** snarkjs 0.7.6: groth16.verify(vkey, publicSignals, proof). The proof is passed as base64 JSON of {pi_a, pi_b, pi_c, protocol, curve}. */
export class SnarkjsGroth16Verifier implements ProofVerifierPort {
  readonly system = 'groth16-bn254' as const;
  constructor(private readonly vkey: Record<string, unknown>) {}
  async verify(proof: string, publicInputs: string[]): Promise<boolean> {
    const snarkjs = (await import('snarkjs')) as unknown as { groth16: { verify(vk: unknown, pub: string[], proof: unknown): Promise<boolean> } };
    const obj = JSON.parse(Buffer.from(proof, 'base64').toString('utf8'));
    return snarkjs.groth16.verify(this.vkey, publicInputs, obj);
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
  version: '0.0.0-mock',
  system: 'mock',
  publicInputLayout: ['termsCommitment', 'incomeCommitment', 'unitsOutstanding', 'paymentStable', 'fxAvgWad', 'periodIndex'],
  wasmUrl: null,
  zkeyUrl: null,
  vkey: null,
  notes: 'Stage 1 has not published the Groth16 circuit. Devices use the mock system (a digest over the public inputs and a witness digest) so the full flow runs; stage1:sync swaps in the real artifacts.',
};
