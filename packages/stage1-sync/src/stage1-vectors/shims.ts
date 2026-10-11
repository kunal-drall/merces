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
  { id: 'SH-REG-1', ops: ['register_issuer'], call: 'registerIssuer signed by that wallet', why: 'Stage 1 registers issuers admin-only (STAGE1_INTEGRATION.md B.7)', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-REG-4', ops: ['create_series'], call: 'createSeries (USDC, USD, sealed; due/grace/notice days from config.parameters; tier bitmask → object; atOffsetSeconds → afterSeconds); window durations and windowFeeBps held by the runner, their Stage 1 bounds unchecked', why: 'canonical terms lack those fields', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-REP-1', ops: ['submit_report'], call: 'submitReport{prior, income, Groth16 proof and signals; tiers 2 and 3 the named key\'s REPORT signature; the FX fallback the named key\'s FX signature}; fxBasis and pair derived by the runner', why: 'FX pairs and the accumulator are S5', removedIn: 'S5 (FX)', kind: 'shim' },
  { id: 'SH-PAY-1', ops: ['pay'], call: 'payIn{periodId: open due period (else the next expected period), amount: the period payment due}', why: "Stage 1's pay has no amount or period", removedIn: 'S5', kind: 'shim' },
  { id: 'SH-PAU-1', ops: ['request_pause'], call: 'requestPause{until: t + maxPauseSeconds}', why: "Stage 1's request has no end", removedIn: 'S5', kind: 'shim' },
  { id: 'SH-RED-1', ops: ['redeem'], call: 'redeem{maxPricePerUnit: U64_MAX}', why: 'Stage 1 has no slippage bound', removedIn: '—', kind: 'shim' },
  { id: 'SH-WIN-1', ops: ['open_window'], call: 'keeper openTransferWindow{t + windowCommitDuration, + windowRevealDuration}; period kept by the runner', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-2', ops: ['commit_ask'], call: 'commitWindowOrder{side: sell, Stage 1\'s keccak order commitment over the plaintext and the wallet (S4), deposit 0, units}', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-3', ops: ['window_commit_bid'], call: 'commitWindowOrder{side: buy, Stage 1\'s keccak order commitment over the plaintext and the wallet (S4), deposit: escrow, units 0}', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-4', ops: ['reveal_order'], call: 'revealWindowOrder (side from the commit)', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-5', ops: ['begin_window_settlement'], call: 'record only, for NO_MATCH or a terminal series; a priced proposal on a live series is BLOCKED', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-6', ops: ['finalize_window'], call: 'clearTransferWindow; asserts nothing transferred where Stage 1 settles NoMatch', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-7', ops: ['process_orders'], call: 'no-op', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-FLG-1', ops: ['config.flags.windowsEnabled'], call: 'runner only: open_window on a series with windows disabled is BLOCKED', why: 'no canonical windows flag', removedIn: 'S5', kind: 'shim' },
  { id: 'BLK-1', ops: ['retire_if_capped'], call: 'none: BLOCKED (waived in 01#34, 05#42)', why: 'no canonical command', removedIn: 'S5', kind: 'blocked' },
  { id: 'NA-1', ops: ['transfer_units'], call: 'none: N/A (01#32)', why: 'the canonical model has no transfer to refuse', removedIn: '—', kind: 'n/a' },
];

export const SHIM_BY_ID: ReadonlyMap<string, Shim> = new Map(SHIMS.map((s) => [s.id, s]));
