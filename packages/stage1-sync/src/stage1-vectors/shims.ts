/**
 * The shim table (S1 plan §5.3): where the merces backend runs a Stage 1 op through a call of another shape. A step
 * that ran through a shim is executed and checked, but it is **not parity** for that op: `VECTOR_PARITY.md` lists the
 * shims a run used under "Shims (not parity)". Each row names the milestone that removes it.
 *
 * The reference backend runs Stage 1's own simulator and uses none of them.
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
}

export const SHIMS: readonly Shim[] = [
  { id: 'SH-REG-1', ops: ['register_issuer'], call: 'registerIssuer signed by that wallet', why: 'Stage 1 registers issuers admin-only (STAGE1_INTEGRATION.md B.7)', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-REG-2', ops: ['register_attestor', 'revoke_attestor'], call: 'admin registerAttestor{active}', why: 'no 45-day revocation grace modelled', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-REG-3', ops: ['register_verifier_key'], call: 'registerVerifierKey{keyId: name, ed25519 SPKI from the seed}', why: 'Stage 1 verifier keys are secp256k1', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-REG-4', ops: ['create_series'], call: 'createSeries (USDC, USD, sealed; due/grace/notice days from config.parameters; tier bitmask → object; atOffsetSeconds → afterSeconds); commit/reveal/window durations, windowFeeBps and nonRevealChargeBps held by the runner, their Stage 1 bounds unchecked', why: 'canonical terms lack those fields', removedIn: 'S2, S5', kind: 'shim' },
  { id: 'SH-AUC-1', ops: ['open_raise'], call: 'openRaise{commitEndsAt = t + commitDuration, revealEndsAt = + revealDuration}', why: 'durations are not canonical terms', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-AUC-2', ops: ['commit_bid'], call: 'commitBid{commitment recomputed from the plaintext, deposit = escrow}', why: 'Stage 1 uses a keccak commitment', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-AUC-3', ops: ['begin_settlement'], call: 'keeper settleAuction (one step) when Stage 1\'s tally of the same revealed bids accepts the proposal (claims and isClearingPriceValid), then our price and units checked against it; a proposal Stage 1 rejects is BLOCKED', why: 'canonical settlement is one step', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-AUC-4', ops: ['finalize_settlement'], call: 'no-op; asserts Settled or Failed', why: 'canonical settlement is one step', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-AUC-5', ops: ['process_bid'], call: 'no-op; bookkeeping of processed bids and minted units (the engine\'s allocation)', why: 'canonical settlement mints inside settleAuction', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-AUC-6', ops: ['deliver_bid'], call: 'claimRefund when refundable > 0, else nothing; bookkeeping of delivery', why: 'push vs pull refunds', removedIn: 'S2', kind: 'shim' },
  { id: 'SH-REP-1', ops: ['submit_report'], call: 'submitReport{prior, income, Groth16 proof and signals}; tier-2 attestation signed by the runner with the named key; tier 3 co-signed by the attestor', why: 'signatures are S4; proofs are real', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-PAY-1', ops: ['pay'], call: 'payIn{periodId: open due period (else the next expected period), amount: the period payment due}', why: "Stage 1's pay has no amount or period", removedIn: 'S5', kind: 'shim' },
  { id: 'SH-PAU-1', ops: ['request_pause'], call: 'requestPause{until: t + maxPauseSeconds}', why: "Stage 1's request has no end", removedIn: 'S5', kind: 'shim' },
  { id: 'SH-PAU-2', ops: ['approve_pause'], call: 'approvePause{until: pauseEnd} sent by the attestor wallet', why: 'signatures as arguments are S4', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-CLM-1', ops: ['claim'], call: 'claimPayout', why: 'S1 claimPayout = claim + tail + final', removedIn: 'S3', kind: 'shim' },
  { id: 'SH-CLM-2', ops: ['claim_tail'], call: 'claimRedemption first when nothing is redeemed yet and units remain (SIM:1409), then claimPayout', why: 'no claimTail command', removedIn: 'S3', kind: 'shim' },
  { id: 'SH-CLM-3', ops: ['claim_final'], call: 'claimPayout', why: 'no claimFinal command', removedIn: 'S3', kind: 'shim' },
  { id: 'SH-BRN-1', ops: ['burn_retired'], call: 'keeper crankBurn{holders: [holder]}', why: 'batch shape', removedIn: '—', kind: 'shim' },
  { id: 'SH-RED-1', ops: ['redeem'], call: 'redeem{maxPricePerUnit: U64_MAX}', why: 'Stage 1 has no slippage bound', removedIn: '—', kind: 'shim' },
  { id: 'SH-EXT-1', ops: ['extinguish'], call: 'extinguish{attestors} sent by attestors[0], attestors[1] co-signing (deduplicated)', why: 'co-signing vs signatures', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-AMD-1', ops: ['amend_terms'], call: 'amendTerms{termsCommitment, capMultipleWad, attestor} with the attestor co-signing', why: 'co-signing vs signatures', removedIn: 'S4', kind: 'shim' },
  { id: 'SH-WIN-1', ops: ['open_window'], call: 'keeper openTransferWindow{t + windowCommitDuration, + windowRevealDuration}; period kept by the runner', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-2', ops: ['commit_ask'], call: 'commitWindowOrder{side: sell, deposit 0, units}', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-3', ops: ['window_commit_bid'], call: 'commitWindowOrder{side: buy, deposit: escrow, units 0}', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-4', ops: ['reveal_order'], call: 'revealWindowOrder (side from the commit)', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-5', ops: ['begin_window_settlement'], call: 'record only, for NO_MATCH or a terminal series; a priced proposal on a live series is BLOCKED', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-6', ops: ['finalize_window'], call: 'clearTransferWindow; asserts nothing transferred where Stage 1 settles NoMatch', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-WIN-7', ops: ['process_orders'], call: 'no-op', why: 'one-step windows', removedIn: 'S5', kind: 'shim' },
  { id: 'SH-FLG-1', ops: ['config.flags.windowsEnabled'], call: 'runner only: open_window on a series with windows disabled is BLOCKED', why: 'no canonical windows flag', removedIn: 'S5', kind: 'shim' },
  { id: 'BLK-1', ops: ['retire_if_capped'], call: 'none: BLOCKED (waived in 01#34, 05#42)', why: 'no canonical command', removedIn: 'S5', kind: 'blocked' },
  { id: 'NA-1', ops: ['transfer_units'], call: 'none: N/A (01#32)', why: 'the canonical model has no transfer to refuse', removedIn: '—', kind: 'n/a' },
];

export const SHIM_BY_ID: ReadonlyMap<string, Shim> = new Map(SHIMS.map((s) => [s.id, s]));
