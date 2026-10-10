import type { EventPayload, EventType, Groth16ProofJson, LifecycleStatus } from '@merces/domain';
import { U64_MAX } from '@merces/math';
import type { SimClock } from '../clock.ts';
import type { SimSeries, SimState } from '../state.ts';
import { fail } from './errors.ts';

/** Checks a Groth16 report proof against its six public signals (Stage 1's verifier, `@merces/circuits` `verifyReport`). */
export interface ReportProofVerifier {
  verify(proof: Groth16ProofJson, publicInputs: string[]): Promise<boolean>;
}

export interface EngineOptions {
  /**
   * Accept `mock` report proofs (a digest over the public signals: anyone can compute one). Off by default; the
   * tests, the harness and the vector runner opt in. Never enable it for a chain that stands in for a live one.
   */
  acceptMockProofs?: boolean;
  /**
   * Verifies `groth16-bn254` report proofs. Verification is asynchronous, so `SimulatorChain.send` runs it before the
   * (synchronous) engine and hands the verdict in through `ExecContext.proofVerdict`. Without one, every Groth16
   * report is refused.
   */
  reportProofVerifier?: ReportProofVerifier;
}

/** Facts established outside the synchronous engine for one transaction. */
export interface ExecContext {
  /** the Groth16 verifier's verdict on the command's (proof, public signals); undefined when none ran */
  proofVerdict?: boolean;
}

/**
 * What every engine module sees of the engine: the state, the clock, the options and the shared guards and
 * balance moves. `state` is replaced when a transaction fails, so modules read `e.state` each time and never keep it.
 */
export interface EngineCore {
  readonly state: SimState;
  readonly clock: SimClock;
  readonly opts: EngineOptions;
  series(id: string): SimSeries;
  requireIssuer(s: SimSeries, signer: string): void;
  requireAllowlisted(wallet: string): void;
  /**
   * Whether attestor key `a` may sign at `now`: an active key, or with `reportPeriod` (report and FX signatures only) a
   * key revoked after that period ended, within Stage 1's 45-day grace (`keys.ts` `attestorUsable`, S4 D5).
   */
  attestorUsable(a: string, now: number, opts?: { reportPeriod?: string }): boolean;
  credit(wallet: string, mint: string, amount: bigint): void;
  debit(wallet: string, mint: string, amount: bigint): void;
}

export type Emit = <T extends EventType>(type: T, payload: EventPayload<T>) => void;

export const TERMINAL: ReadonlySet<LifecycleStatus> = new Set(['Retired', 'Redeemed', 'Extinguished']);

export function big(x: string): bigint {
  return BigInt(x);
}
export function str(x: bigint): string {
  return x.toString();
}
export function balKey(wallet: string, mint: string): string {
  return `${wallet}|${mint}`;
}

/** A decimal amount as Stage 1 decodes it: a u64, else AmountOutOfRange (the message names no value). */
export function u64(x: string): bigint {
  let v: bigint;
  try {
    v = BigInt(x);
  } catch {
    return fail('AmountOutOfRange', 'amount is not an integer');
  }
  if (v < 0n || v > U64_MAX) fail('AmountOutOfRange', 'amount is out of the u64 range');
  return v;
}
