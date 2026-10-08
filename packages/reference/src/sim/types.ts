/**
 * Parity-vector schema (SPEC v1.1 §11). Every integer is a decimal string, every hash/commitment/
 * salt is 0x-hex. `t` is the block time the harness warps to before executing the step.
 */
import type { ErrorName } from "@merces/sdk";

export type Dec = string;
export type Hex = string;

export interface SeriesTermsInput {
  unitsOffered: Dec;
  reservePrice: Dec;
  minRaise: Dec;
  capMultipleWad: Dec;
  hurdleRateWad: Dec;
  payoutMultipleK: Dec;
  lockupSeconds: Dec;
  walletCapBps: Dec;
  auctionFeeBps: Dec;
  payoutFeeBps: Dec;
  windowFeeBps: Dec;
  nonRevealChargeBps: Dec;
  commitDuration: Dec;
  revealDuration: Dec;
  windowCommitDuration: Dec;
  windowRevealDuration: Dec;
}

export interface ReleaseTrancheInput {
  atOffsetSeconds: Dec;
  bps: Dec;
}

export interface ProofJson {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface ProofEvmJson {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
  proofBytes: Hex;
  calldata: Hex;
}

export interface ProofSolanaJson {
  proofA: Hex;
  proofB: Hex;
  proofC: Hex;
  proof: Hex;
  publicInputs: Hex[];
}

/** Witness data (TEST ONLY — real reports never publish these). */
export interface ReportWitness {
  incomeYtd: Dec;
  incomeSalt: Dec;
  priorIncomeYtd: Dec;
  priorSalt: Dec;
  theta: Dec;
  rWad: Dec;
}

export type Call =
  | { op: "fund"; actor: string; amount: Dec }
  | { op: "allowlist"; wallets: string[]; allowed?: boolean }
  | { op: "register_issuer"; wallet: string }
  | { op: "deactivate_issuer"; wallet: string }
  | { op: "register_attestor"; key: string }
  | { op: "revoke_attestor"; key: string }
  | { op: "register_verifier_key"; key: string }
  | { op: "revoke_verifier_key"; key: string }
  | { op: "set_flags"; newRaisesPaused?: boolean; windowsEnabled?: boolean; tier4Enabled?: boolean }
  | { op: "set_fx_pair"; feedId: Hex; inverted: boolean; crosscheck: boolean }
  | {
      op: "create_series";
      actor: string;
      series: string;
      terms: SeriesTermsInput;
      releaseSchedule: ReleaseTrancheInput[];
      termsCommitment: Hex;
      contractHash: Hex | null;
      tierFlags: number;
      fxPairId: Hex | null;
      router?: { theta: Dec; rWad: Dec };
    }
  | { op: "set_contract_hash"; actor: string; series: string; contractHash: Hex }
  | { op: "stop_issuance"; actor: string }
  | { op: "resume_issuance"; actor: string }
  | { op: "open_raise"; actor: string; series: string }
  | { op: "cancel_raise"; actor: string; series: string }
  | { op: "commit_bid"; actor: string; series: string; price: Dec; quantity: Dec; salt: Hex; escrow: Dec }
  | { op: "reveal_bid"; actor: string; series: string; price: Dec; quantity: Dec; salt: Hex }
  | { op: "begin_settlement"; series: string; clearingPrice: Dec; qAboveClaim: Dec; qAtClaim: Dec }
  | { op: "finalize_settlement"; series: string }
  | { op: "process_bid"; series: string; bidder: string }
  | { op: "deliver_bid"; series: string; bidder: string }
  | { op: "claim_release"; actor: string; series: string }
  | { op: "set_release_pause"; actor: string; series: string; paused: boolean }
  | {
      op: "submit_report";
      actor: string;
      series: string;
      period: Dec;
      paymentUsd: Dec;
      fxAvgWad: Dec;
      fxFallback: { attestor: string } | null;
      priorIncomeCommitment: Hex;
      incomeCommitment: Hex;
      tier: number;
      liquidityEvent: boolean;
      attestation: string | null;
      proof: ProofJson;
      publicSignals: string[];
      proofEvm: ProofEvmJson;
      proofSolana: ProofSolanaJson;
      witness: ReportWitness;
    }
  | { op: "pay"; actor: string; series: string }
  | { op: "submit_trueup"; actor: string; series: string; year: Dec; adjustment: Dec; attestationTs: Dec; attestor: string }
  | { op: "pay_trueup"; actor: string; series: string }
  | { op: "claim"; actor: string; series: string }
  | { op: "register_holder"; series: string; holder: string }
  | { op: "burn_retired"; series: string; holder: string }
  | { op: "retire_if_capped"; series: string }
  | { op: "crank_status"; series: string }
  | { op: "request_pause"; actor: string; series: string }
  | { op: "withdraw_pause_request"; actor: string; series: string }
  | { op: "approve_pause"; series: string; pauseEnd: Dec; attestor: string }
  | { op: "end_pause"; actor: string; series: string }
  | { op: "route_income"; series: string; payer: string; amount: Dec }
  | { op: "close_router_period"; series: string; period: Dec }
  | { op: "fx_snapshot"; pairId: Hex; price: Dec; conf: Dec; expo: number; publishTime: Dec; crosscheckPrice?: Dec; crosscheckExpo?: number }
  | { op: "redeem"; actor: string; series: string }
  | { op: "claim_redemption"; actor: string; series: string }
  | { op: "claim_tail"; actor: string; series: string }
  | { op: "extinguish"; series: string; attestors: [string, string] }
  | { op: "claim_final"; actor: string; series: string }
  | { op: "amend_terms"; actor: string; series: string; newTermsCommitment: Hex; newCapMultipleWad: Dec; attestor: string }
  | { op: "open_window"; series: string; period: Dec }
  | { op: "commit_ask"; actor: string; series: string; price: Dec; quantity: Dec; salt: Hex; units: Dec }
  | { op: "window_commit_bid"; actor: string; series: string; price: Dec; quantity: Dec; salt: Hex; escrow: Dec }
  | { op: "reveal_order"; actor: string; series: string; price: Dec; quantity: Dec; salt: Hex }
  | { op: "begin_window_settlement"; series: string; clearingPrice: Dec | "NO_MATCH" }
  | { op: "finalize_window"; series: string }
  | { op: "process_orders"; series: string }
  | { op: "transfer_units"; actor: string; series: string; to: string; units: Dec };

export type CallOp = Call["op"];

export interface LedgerExpect {
  status: string;
  raiseState: string;
  mintFinalized: boolean;
  unitsOutstanding: Dec;
  unitsSold: Dec;
  clearingPrice: Dec;
  proceeds: Dec;
  releasedTotal: Dec;
  capPerUnit: Dec;
  capMultipleWad: Dec;
  termsCommitment: Hex;
  amendmentNonce: Dec;
  paidPerUnitWad: Dec;
  netAccWad: Dec;
  /** reference's exact WAD-scaled remainder (SPEC's base-unit `carry` is `floor(carryWad / WAD)`, 0 in every vector) */
  carryWad: Dec;
  carry: Dec;
  grossReceived: Dec;
  feeCollected: Dec;
  refundedToIssuer: Dec;
  lastAcceptedPeriod: Dec | null;
  lastPaidPeriod: Dec | null;
  openDuePeriod: Dec | null;
  openDueAmount: Dec;
  routerCredit: Dec;
  trueupNonce: Dec;
  trueupDue: Dec;
  pauseNonce: Dec;
  pauseCount: Dec;
  pausedTotal: Dec;
  formalNoticeEmittedFor: Dec | null;
  redemptionPrice: Dec;
  unitsAtRedemption: Dec;
  tailCapPerUnit: Dec;
  tailAccWad: Dec;
  tailExhausted: boolean;
  extinguishedAt: Dec;
  finalAccWad: Dec;
  finalUnits: Dec;
  extinguishNonce: Dec;
}

export interface AuctionExpect {
  bidCount: Dec;
  revealedCount: Dec;
  validCount: Dec;
  escrowTotal: Dec;
  auctionEscrowUnits: Dec;
  tallyRound: Dec;
  roundRejected: boolean;
  rejectionReason: string | null;
  clearingPrice: Dec;
  qAbove: Dec;
  qAt: Dec;
  R: Dec;
  unitsSold: Dec;
  proceeds: Dec;
  unitsMinted: Dec;
  bidsProcessed: Dec;
  mintFinalized: boolean;
}

export interface WindowExpect {
  period: Dec;
  state: string;
  tallyRound: Dec;
  roundRejected: boolean;
  clearingPrice: Dec | null;
  branch: string | null;
  matchedUnits: Dec;
  escrowStable: Dec;
  escrowUnits: Dec;
}

export interface FxExpect {
  sumWad: Dec;
  count: Dec;
  quarters: Record<string, { ok: boolean; avgWad: Dec | null; n: Dec; flagged: boolean }>;
}

export interface HolderExpect {
  pending: Dec;
  redeemedUnits: Dec;
  pendingUnits: Dec;
  pendingRefund: Dec;
  delivered: boolean;
}

export interface ExpectStep {
  t: Dec;
  op: "expect";
  series?: string;
  balances?: Record<string, { stable: Dec; units?: Dec }>;
  treasury?: Dec;
  vault?: Dec;
  feeCollector?: Dec;
  auctionEscrow?: Dec;
  routerBalance?: Dec;
  windowEscrowStable?: Dec;
  windowEscrowUnits?: Dec;
  ledger?: LedgerExpect;
  auction?: AuctionExpect;
  window?: WindowExpect;
  holders?: Record<string, HolderExpect>;
  fx?: Record<Hex, FxExpect>;
  note?: string;
}

export interface ExpectRevertStep {
  t: Dec;
  op: "expect_revert";
  call: Call;
  error: ErrorName;
  note?: string;
}

export type ActionStep = { t: Dec; note?: string } & Call;

export type Step = ActionStep | ExpectStep | ExpectRevertStep;

export interface VectorKey {
  seed: string;
  derivation: string;
  privateKey: Hex;
  address: Hex;
  role: "attestor" | "verifier";
}

export interface SeriesPrivate {
  termsPlain: { theta: Dec; rWad: Dec; currencyCode: number; indexingRule: number; termsSalt: Dec };
  termsCommitment: Hex;
}

export interface Vector {
  name: string;
  description: string;
  schema: 2;
  specVersion: "1.1";
  generatedBy: string;
  config: {
    parameters: Record<string, Dec>;
    flags: { newRaisesPaused: boolean; windowsEnabled: boolean; tier4Enabled: boolean };
    stablecoinDecimals: number;
    chainDomainNote: string;
  };
  actors: string[];
  keys: Record<string, VectorKey>;
  seriesPrivate: Record<string, SeriesPrivate>;
  steps: Step[];
}
