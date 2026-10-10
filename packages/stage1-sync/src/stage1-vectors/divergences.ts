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

export const DIVERGENCES: readonly DivergenceRow[] = Object.freeze([
  {
    id: 'DIV-NRC-1',
    title: 'the non-reveal charge (owner hold)',
    what:
      "Stage 1 keeps floor(escrow × nonRevealChargeBps / 10000) of a bid committed and never revealed when the raise settles, and pays it to the fee collector at `process_bid` (SPEC §5.2; REF `processBid`, the unrevealed branch; SIM `processBid`); the bid's refund is the escrow less the charge. On a failed raise nothing is charged. The merces backend records the series' rate but applies 0 bps (`appliedNonRevealChargeBps`), so the bid is refunded in full and the fee collector receives nothing for it.",
    why:
      "owner hold (S2 amendment M1): the owner asked to be told what Stage 1 does before the charge is modelled. `NON_REVEAL_CHARGE_HELD` (packages/domain/src/params.ts) is the one switch; the engine refuses any non-zero charge while it is on (ASSUMPTIONS.md A-AUC-11).",
    milestone: 'after the owner decides',
    seen:
      "only vector 03 (S1/b8, escrow 10,100 USDC, charged 101 USDC at 1%): the expects at #67 (feeCollector, auctionEscrow, auction.escrowTotal) and #77 (balances.b8.stable, feeCollector); lockstep parts at #65 (`process_bid b8`). The other unrevealed bids (02 S2/b1, 15 S1/b3) are on failed raises, where Stage 1 charges nothing.",
    lift: [
      'set `NON_REVEAL_CHARGE_HELD` to false and add what the charge needs (the `NonRevealCharged` event, a `nonReveal` fee kind, the bids\' charge column, accounting and API fields; STAGE1_INTEGRATION.md divergence register);',
      'delete the DIV-NRC-1 entries and the lockstep expectation of vector 03 in `expected.ts` and set 03 to PASS (until then the runner fails 03 on five stale entries);',
      'regenerate VECTOR_PARITY.md and update A-AUC-11.',
    ],
  },
]);

export const DIVERGENCE_BY_ID: ReadonlyMap<string, DivergenceRow> = new Map(DIVERGENCES.map((d) => [d.id, d]));
