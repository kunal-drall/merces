import { createHash } from 'node:crypto';
import { verifyReport } from '@merces/circuits';

/**
 * Groth16 verdicts for the vectors' embedded report proofs (S1 plan §5.5).
 *
 * The runner only verifies: every `submit_report` carries Stage 1's proof and public signals, checked with Stage 1's
 * own verifier (`@merces/circuits` `verifyReport`, the dev verification key). A verdict is cached per process, keyed by
 * a digest of (proof, signals), so the reference backend, both personalities of the merces backend and lockstep runs
 * pay for each proof once (about 15 ms warm, 300 ms cold).
 *
 * snarkjs verifies on a multithreaded curve that ffjavascript caches on `globalThis.curve_bn128`; its worker threads
 * keep a process alive, so every entry point that verified must `await shutdown()` before it expects to exit.
 */

type Proof = Parameters<typeof verifyReport>[0];

const verdicts = new Map<string, Promise<boolean>>();
let lookups = 0;

function digest(proof: unknown, publicSignals: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([proof, publicSignals])).digest('hex');
}

/**
 * Stage 1's verdict on (proof, publicSignals), cached. A verifier that throws (malformed proof or signals) counts as
 * an invalid proof; nothing about the inputs is reported.
 */
export function verifyReportCached(proof: unknown, publicSignals: readonly string[]): Promise<boolean> {
  lookups++;
  const key = digest(proof, publicSignals);
  let v = verdicts.get(key);
  if (!v) {
    v = verifyReport(proof as Proof, [...publicSignals]).then(
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

/** Terminate the proof system's worker threads (ffjavascript's cached bn128 curve). Safe to call more than once. */
export async function shutdown(): Promise<void> {
  // let in-flight verifications finish first; a terminated curve would reject them
  await Promise.allSettled(verdicts.values());
  const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null };
  const curve = g.curve_bn128;
  if (curve && typeof curve.terminate === 'function') await curve.terminate();
}
