/**
 * The shim table (S1 plan §5.3): where the merces backend runs a Stage 1 op through a call of another shape. A step
 * that ran through a shim is executed and checked, but it is **not parity** for that op: `VECTOR_PARITY.md` lists the
 * shims a run used under "Shims (not parity)". Each row names the milestone that removes it.
 *
 * The reference backend runs Stage 1's own simulator and uses none of them.
 *
 * Retired rows: SH-AUC-1 and SH-AUC-3..6 (S2: the raise runs Stage 1's settlement directly); SH-CLM-2, SH-CLM-3 and
 * SH-BRN-1 (S3 WP2: `claim_tail`, `claim_final` and `burn_retired` run as `claimTail`, `claimFinal` and `burnRetired`);
 * SH-CLM-1 (S3 WP3: `claim` runs as `claimPayout`, which is Stage 1's `claim`); SH-AUC-2 (S4 WP2: `commit_bid` runs
 * as `commitBid` with Stage 1's keccak commitment, S4 D11); SH-REG-2 (S4 WP5: `register_attestor` and `revoke_attestor` run
 * as `registerAttestor` and `revokeAttestor` of the vector key's address, Stage 1's registry with its grace and last-key
 * rule); SH-REG-3 (S4 WP6: `register_verifier_key` and `revoke_verifier_key` run as `registerVerifierKey` and
 * `revokeVerifierKey` of the vector key's address, and a tier-2 report carries the key's Stage 1 REPORT signature).
 */
export interface Shim {
  id: string;
  /** the Stage 1 op(s) it stands in for */
  ops: string[];
  /** what our backend calls instead */
  call: string;
  /** why it is not parity */
  why: string;
  /** the milestone that removes it ("—" when it stays) */
  removedIn: string;
  /** `blocked` and `n/a` rows: the op is not run at all */
  kind: 'shim' | 'blocked' | 'n/a';
  /**
   * The row may send more than one transaction for one Stage 1 call. When a later one reverts, the runner undoes the
   * ones that went through, so the call reverts as a whole by the runner's doing, not the engine's (runner-atomic; the
   * merces backend refuses a multi-transaction op through a row without this mark). No row needs it since S3 (SH-CLM-2,
   * the last one, became the direct `claimTail`); the mechanism stays, and a test keeps it working on a synthetic row.
   */
  runnerAtomic?: true;
}

export const SHIMS: readonly Shim[] = [
];

export const SHIM_BY_ID: ReadonlyMap<string, Shim> = new Map(SHIMS.map((s) => [s.id, s]));
