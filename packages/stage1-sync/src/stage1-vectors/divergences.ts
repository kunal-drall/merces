/**
 * The divergence register of the vector runner (S2 plan D13, §4): Stage 1 behaviour the merces backend knowingly does
 * not mirror, by decision rather than by omission. Each row is the "why" behind the per-step entries a vector's
 * expectation carries (`Expected.divergences`, `Expected.lockstep` in `expected.ts`):
 *
 * - an `expect` difference equal to a recorded entry (step, path, Stage 1's value, ours) is accepted: the run is
 *   PASS-WITH-DIVERGENCES, never PASS;
 * - any other value at that path is a failure (the divergence moved);
 * - a recorded entry whose difference no longer occurs is a failure too ("stale divergence"): that is how lifting a
 *   hold, or fixing the engine, is caught until the entries go.
 *
 * Every value here is public (a vector's own expect values and ours). The register is printed into `VECTOR_PARITY.md`
 * under "Known divergences (not parity)".
 */
export interface DivergenceRow {
  id: string;
  title: string;
  /** what Stage 1 does, and what the merces backend does instead */
  what: string;
  /** why it is not mirrored */
  why: string;
  /** when it ends */
  milestone: string;
  /** where the vectors see it (the entries in `expected.ts`) */
  seen: string;
  /** what lifting it changes, in order */
  lift: string[];
}

/**
 * Empty since the non-reveal charge is modelled as Stage 1 models it (S3 follow-up NRC): DIV-NRC-1 (vector 03, the five
 * fields of b8's 1% charge and its lockstep parting at #65) was the only row, and 03 is PASS in full. The mechanism
 * stays (tests keep it working on a test-only row), so a future divergence is recorded the same way.
 */
export const DIVERGENCES: readonly DivergenceRow[] = Object.freeze([]);

export const DIVERGENCE_BY_ID: ReadonlyMap<string, DivergenceRow> = new Map(DIVERGENCES.map((d) => [d.id, d]));
