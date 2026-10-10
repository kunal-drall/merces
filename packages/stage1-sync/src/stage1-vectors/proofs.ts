import { createHash } from 'node:crypto';
import { Groth16ReportVerifier, shutdownProofSystem } from '@merces/ports';

/**
 * Groth16 verdicts for the vectors' embedded report proofs (S1 plan §5.5).
 *
 * The runner only verifies: every `submit_report` carries Stage 1's proof and public signals, checked by the same
 * verifier the services and the API's simulator chains run, the ports' `Groth16ReportVerifier` (Stage 1's own
 * `@merces/circuits` `verifyReport` with the development verification key, behind the port's input checks). The
 * runner keeps its own per-process tally beside the port's cache, keyed by a digest of (proof, signals), so the
 * reference backend, both personalities of the merces backend and lockstep runs pay for each proof once (about 15 ms
 * warm, 300 ms cold) and the summary can say how many distinct proofs were verified and how many failed.
 *
 * snarkjs verifies on a multithreaded curve whose worker threads keep a process alive, so every entry point that
 * verified must `await shutdown()` (the ports' `shutdownProofSystem`) before it expects to exit.
 */

type PortProof = Parameters<Groth16ReportVerifier['verify']>[0];

const verifier = new Groth16ReportVerifier();
const verdicts = new Map<string, Promise<boolean>>();
let lookups = 0;

function digest(proof: unknown, publicSignals: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([proof, publicSignals])).digest('hex');
}

/**
 * The ports verifier's verdict on (proof, publicSignals), tallied. A malformed proof or signal list counts as an
 * invalid proof (the port never throws); nothing about the inputs is reported.
 */
export function verifyReportCached(proof: unknown, publicSignals: readonly string[]): Promise<boolean> {
  lookups++;
  const key = digest(proof, publicSignals);
  let v = verdicts.get(key);
  if (!v) {
    v = verifier.verify(proof as PortProof, [...publicSignals]).then(
      (ok) => ok === true,
      () => false,
    );
    verdicts.set(key, v);
  }
  return v;
}

export interface ProofStats {
  /** distinct (proof, signals) pairs verified */
  verified: number;
  /** of those, how many failed verification */
  invalid: number;
  /** lookups answered from the cache */
  cacheHits: number;
}

export async function proofStats(): Promise<ProofStats> {
  const all = await Promise.all(verdicts.values());
  return { verified: all.length, invalid: all.filter((ok) => !ok).length, cacheHits: lookups - all.length };
}

/** Terminate the proof system's worker threads once in-flight verifications finish. Safe to call more than once. */
export async function shutdown(): Promise<void> {
  await Promise.allSettled(verdicts.values());
  await shutdownProofSystem();
}
