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

/**
 * Two rows: DIV-S1I-1 (S3 review) and DIV-S1I-2 (S4 WP5). DIV-NRC-1 (vector 03, the five fields of b8's 1% charge and its lockstep
 * parting at #65) went when the non-reveal charge was modelled as Stage 1 models it (S3 follow-up NRC), and 03 is PASS
 * in full. No Stage 1 vector carries a divergence.
 *
 * DIV-S1I-1 is a Stage 1-internal difference resolved toward both chains, as the register in STAGE1_INTEGRATION.md
 * resolves the others ("Stage 1 internal" row): Stage 1's TS reference (the reference backend) and Stage 1's EVM and
 * Solana programs disagree, the merces backend follows both programs, so it differs from the reference backend where a
 * run reaches the case. No Stage 1 vector does; our scenario S3l does (`scenarios.ts`, `SCENARIO_EXPECTATIONS`), and its
 * entries live there.
 *
 * DIV-S1I-2 is another: the last-key rule. Stage 1's reference revokes the last active key (the call succeeds), both
 * chains refuse it, so the backends cannot part on a value: the refusal is an `expect_revert` of the merces-only scenario
 * S4d (S4 amendment fix 1), and the row has no `expect` or lockstep entry.
 */
export const DIVERGENCES: readonly DivergenceRow[] = Object.freeze([
  {
    id: 'DIV-S1I-1',
    title: "a redeemed holder's final share counts the units in its open window ask (Stage 1 internal, resolved toward both chains)",
    what:
      "On a series that redeemed and was then extinguished, `claim_final` by a holder with units held for an uncleared window ask: Stage 1's EVM and Solana programs weigh the holder's final share on its redeemed units plus the ask's escrow (MercesVault.sol:654-658 `weight = redeemedUnits + escrow`; claims.rs:486-490), and the units, once the window returns them, are redeemed by a later claim at a share of 0; Stage 1's TS reference simulator weighs it on the redeemed units only (simulator.ts:1456-1460) and marks the share claimed, so the escrowed units' share stays in its vault for good. The merces backend weighs it as both chains do (`finalShare`, `claimableFinal`, the buildClaimFinal preview).",
    why: "Stage 1 wins, and both of Stage 1's programs (and its design notes, track-c.md C-S5 and track-b.md B-S25) count the escrow; only its TS reference leaves it out, and the live adapters must agree with the chains. Reported to Stage 1 as a defect with the missing vector: `docs/stage1/defects/DIV-S1I-1-final-share-open-ask.md` and `docs/stage1/defects/vectors/26_final_share_open_ask.json` (both chains' values; `pnpm stage1:vectors --vector-file <that file>` PASSes on the merces backend and fails on the reference backend at its first expect, 1,050 USDC apart on b1's balance and the vault).",
    milestone: "until Stage 1's TS reference counts the escrow (reported to Stage 1: docs/stage1/defects/DIV-S1I-1-final-share-open-ask.md)",
    seen: "our S3 claim scenario S3l (22's prefix with S2's window up to its reveals, then redeem, extinguish and claim_final): at its two expects (b1's balance and the vault, 1,050 USDC apart) and, in lockstep, right after b1's first claim_final; no Stage 1 vector reaches it (the proposed vector 26 in docs/stage1/defects/vectors does, with both chains' values)",
    lift: [
      "When Stage 1's reference weighs the share on the redeemed units plus the escrow, S3l's expects are retaken from it (they then equal ours),",
      "its entries go stale and fail the run until they are removed from `SCENARIO_EXPECTATIONS`,",
      'and the row goes.',
    ],
  },
  {
    id: 'DIV-S1I-2',
    title: 'the last active key of a kind cannot be revoked (Stage 1 internal, resolved toward both chains)',
    what:
      "Revoking an attestor (or verifier) key when it is the last active key of its kind: Stage 1's Solana program refuses it with `LastKeyOfKind` (merces_registry lib.rs:239-245, `attestor_count >= 2`) and its EVM contract with `LastActiveKey` (MercesRegistry.sol:331-335, `active == 1`); Stage 1's TS reference simulator revokes it (simulator.ts:535-546: `revoke_attestor` and `revoke_verifier_key` set the key inactive with no check). The merces backend refuses it as both chains do, each personality under its chain's name (S4 D5, D9).",
    why: "Stage 1 wins, and its SPEC and both of its programs refuse it (SPEC §1.4, SPEC.md:96: \"The registry refuses to revoke the last active key of a kind unless a replacement is registered in the same transaction\"); only its TS reference lets the last key go, and the live adapters must agree with the chains. The canonical model has no Stage 1 name for the case (each chain names it), so the expect_revert names it per personality. Reported to Stage 1.",
    milestone: "until Stage 1's TS reference refuses the last key (reported to Stage 1)",
    seen: "our S4 signature scenario S4d (11's prefix, then attestor2 and attestor1 revoked in turn), which runs on the merces backend only: the reference has no last-key rule, so lockstep (which needs both sides to succeed or both to revert) cannot compare it; no Stage 1 vector revokes the last key",
    lift: [
      "When Stage 1's reference refuses the last key, S4d runs on every backend (its expect_revert then needs Stage 1's canonical name for the case, or stays per personality on the merces backend),",
      'and the row goes.',
    ],
    shownBy: ['S4d'],
  },
]);

export const DIVERGENCE_BY_ID: ReadonlyMap<string, DivergenceRow> = new Map(DIVERGENCES.map((d) => [d.id, d]));
