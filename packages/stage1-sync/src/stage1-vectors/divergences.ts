/**
 * The divergence register of the vector runner (S2 plan D13, §4): Stage 1 behaviour the merces backend knowingly does
 * not mirror, by decision rather than by omission (where Stage 1's TS reference and its chains disagree, the reference's
 * behaviour that the merces backend leaves for the chains'). Each row is the "why" behind the per-step entries a
 * vector's or a scenario's expectation carries (`Expected.divergences`, `Expected.lockstep`; `expected.ts`,
 * `SCENARIO_EXPECTATIONS` in `scenarios.ts`):
 *
 * - an `expect` difference equal to a recorded entry (step, path, Stage 1's value, ours) is accepted: the run is
 *   PASS-WITH-DIVERGENCES, never PASS;
 * - any other value at that path is a failure (the divergence moved);
 * - a recorded entry whose difference no longer occurs is a failure too ("stale divergence"): that is how lifting a
 *   hold, or fixing the engine, is caught until the entries go.
 *
 * Every value here is public (a vector's or a scenario's own expect values and ours). The register is printed into `VECTOR_PARITY.md`
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
  /**
   * Our merces-only scenarios that show it with an `expect_revert` of their own (a rule Stage 1's reference does not
   * model at all, so there is no `expect` value and no lockstep parting to record: the row has no entries).
   */
  shownBy?: string[];
}

/** DIV-S1I-1 is resolved in the Stage 1 reference and regression vector 26. Remaining rows record
 * guards both chains enforce and the reference omits. No official vector carries a waiver. */
export const DIVERGENCES: readonly DivergenceRow[] = Object.freeze([
  {
    id: 'DIV-S1I-7',
    title: 'router terminal pass-through and checkpoint retention follow the programs',
    what: 'Both programs pass income through after retirement, redemption or extinguishment; the TS reference route_income refuses terminal series. EVM retains every checkpoint and permits repeated close calls; Solana/reference retain eight, and Solana rejects closing an already closed period. EVM close requires a settled raise; neither program requires mint finalization for close.',
    why: 'MercesRouter.sol _route/_closeThrough/closeRouterPeriod and Solana router.rs route/close_router_period are authoritative.',
    milestone: 'until the reference models the program-specific router lifecycle and checkpoint rules',
    seen: 'packages/simulator/test/split.test.ts exercises terminal receipts, long gaps, retention and repeated closes on both personalities. Vectors 12 and 18 pass in full with no waiver.',
    lift: ['Extend the reference router lifecycle and personality-specific checkpoint storage, then replay these cases in lockstep.'],
  },
  {
    id: 'DIV-S1I-6',
    title: 'window payout ownership follows the clearing accumulator',
    what: 'Both programs freeze accAtClear and credit the buyer or the returned ask units from that point when each order is processed. The TS reference processes the whole book atomically and has no intervening payout or pending delivery state.',
    why: 'MercesVault.sol _settle/creditWindowAccrual and the Solana window processing implement C-S4: every unit earns for exactly one wallet, independently of keeper delays.',
    milestone: 'until the reference exposes per-order processing and delivery with clearing-time accrual',
    seen: 'packages/simulator/test/window.test.ts exercises both personalities with payouts before processing and before historical delivery. Vectors 10, 16 and 22 pass in full; no waived step or accepted snapshot difference.',
    lift: ['Extend the reference with separate process/deliver calls and the clearing accumulator, then replay the delayed-processing regression in lockstep.'],
  },
  {
    id: 'DIV-S1I-5',
    title: 'configured FX cross-check availability follows each chain',
    what: 'Solana fx.rs snapshot_fx requires the configured second Pyth update and rejects stale/nonpositive cross-checks; EVM MercesFxAccumulator._chainlink ignores unavailable, stale or nonpositive Chainlink answers. The TS reference accepts an omitted cross-check even when configured and has no cross-check timestamp input.',
    why: 'The simulator and keeper follow their chain personality; a configured Solana feed must not silently disappear from validation. Both chains retain a deviating primary price and flag the quarter.',
    milestone: 'until the reference models chain-specific cross-check availability',
    seen: 'packages/simulator/test/fx.test.ts tests missing and stale cross-checks on both personalities. Official FX vectors 13 and 24 still pass in full; no waiver.',
    lift: ['Model cross-check timestamps and required Solana updates in the reference, preserving the contract behavior and these regressions.'],
  },
  {
    id: 'DIV-S1I-4',
    title: 'true-up submissions reject terminal series and future attestation times',
    what: 'Both chains reject terminal series and future TRUEUP attestation times (income.rs submit_trueup:770–808; MercesIncome.sol:369–394); the TS reference submitTrueup omits these guards. The backend follows both contracts, using TrueUpTimestampInFuture on Solana and AttestationInFuture on EVM.',
    why: 'Stage 1 chain behavior governs money and charter rules. A future timestamp must not postpone the annual payment clock, and terminal series cannot acquire a new due.',
    milestone: 'until the Stage 1 reference implements these two contract guards',
    seen: 'packages/simulator/test/trueup.test.ts checks both personalities, including atomic refusal; none of the 25 official vectors submits these cases, so this row grants no waiver or accepted state difference.',
    lift: ['Add matching terminal and future-time guards to the reference, keep both contract regressions, then remove this row.'],
  },
  {
    id: 'DIV-S1I-2',
    title: 'the last active key of a kind cannot be revoked (Stage 1 internal, resolved toward both chains)',
    what:
      "Revoking an attestor (or verifier) key when it is the last active key of its kind: Stage 1's Solana program refuses it with `LastKeyOfKind` (merces_registry lib.rs:239-245, `attestor_count >= 2`) and its EVM contract with `LastActiveKey` (MercesRegistry.sol:331-335, `active == 1`); Stage 1's TS reference simulator revokes it (simulator.ts:535-546: `revoke_attestor` and `revoke_verifier_key` set the key inactive with no check). The merces backend refuses it as both chains do, each personality under its chain's name (S4 D5, D9).",
    why: "Stage 1 wins, and its SPEC and both of its programs refuse it (SPEC §1.4, SPEC.md:96: \"The registry refuses to revoke the last active key of a kind unless a replacement is registered in the same transaction\"); only its TS reference lets the last key go, and the live adapters must agree with the chains. The canonical model has no Stage 1 name for the case (each chain names it), so the expect_revert names it per personality. Reported to Stage 1.",
    milestone: "until Stage 1's TS reference refuses both the last active key and revoking an inactive key (reported to Stage 1)",
    seen: "our S4 signature scenario S4d (11's prefix, then attestor2 and attestor1 revoked in turn), which runs on the merces backend only: the reference has no last-key rule, so lockstep (which needs both sides to succeed or both to revert) cannot compare it; no Stage 1 vector revokes the last key. S4d also re-revokes attestor2 at #37: the reference moves revokedAt and reopens grace, while Solana refuses KeyAlreadyRevoked (registry lib.rs:241) and EVM KeyNotRegistered (MercesRegistry.sol:328)",
    lift: [
      "When Stage 1's reference refuses both the last key and re-revocation of an inactive key, S4d runs on every backend (its expect_revert then needs Stage 1's canonical name for the case, or stays per personality on the merces backend),",
      'and the row goes.',
    ],
    shownBy: ['S4d'],
  },
]);

export const DIVERGENCE_BY_ID: ReadonlyMap<string, DivergenceRow> = new Map(DIVERGENCES.map((d) => [d.id, d]));
