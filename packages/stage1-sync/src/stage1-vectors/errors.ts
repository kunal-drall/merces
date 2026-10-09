import { ChainError } from '@merces/domain';
import { ERROR_ALIASES } from '@merces/math';

/**
 * A fault of the runner or of the vector file (bad schema, time going backwards, an unknown backend). Its message
 * carries public facts only: names, step indices, op names.
 */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

/**
 * What a call raised, as the runner compares it.
 * - `protocol`: a protocol revert, with its Stage 1 error name (SPEC §11).
 * - otherwise: anything else; only the class name is kept. The message is never printed: Stage 1 and engine errors
 *   can embed the values they rejected (`@merces/sdk` bytes.ts `assertRange`), and a runner report is a public file.
 */
export type Raised = { protocol: true; name: string } | { protocol: false; className: string };

/** The canonical (v1.1) spelling of an error name: pre-v1.1 names map through Stage 1's `ERROR_ALIASES`. */
export function canonicalErrorName(name: string): string {
  return (ERROR_ALIASES as Readonly<Record<string, string>>)[name] ?? name;
}

function className(e: unknown): string {
  if (e === null || e === undefined) return String(e);
  if (typeof e !== 'object') return typeof e;
  const n = (e as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof n === 'string' && n ? n : 'Object';
}

/** A non-protocol exception (class name only). */
export function nonProtocol(e: unknown): { protocol: false; className: string } {
  return { protocol: false, className: className(e) };
}

/**
 * Classify an error thrown by our `SimulatorChain` (the merces backend): the Stage 1 name is `ChainError.detail.stage1`
 * (S1 plan D4, `packages/simulator/src/engine/errors.ts`). A `ChainError` without it is not comparable and counts as a
 * non-protocol exception, named by its chain-neutral code.
 */
export function classifyChainError(e: unknown): Raised {
  if (e instanceof ChainError) {
    const name = e.detail?.stage1;
    if (typeof name === 'string' && name) return { protocol: true, name: canonicalErrorName(name) };
    return { protocol: false, className: `ChainError(${e.code}) without detail.stage1` };
  }
  return nonProtocol(e);
}

/** How a raised error reads in a report. */
export function describeRaised(r: Raised): string {
  return r.protocol ? r.name : `non-protocol exception ${r.className}`;
}
