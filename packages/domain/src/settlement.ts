import {
  beginSettlement, claimsFor, finalizeSettlement, findClearingPrice, isBidValid, tallyBids,
  type AuctionRules, type FinalizeOutcome, type Proposal, type RevealedBid, type Tally,
} from '@merces/math';
import type { PermissionlessCommand } from './commands.ts';
import type { RaiseStateName } from './events.ts';
import type { Money, Units } from './money.ts';
import { appliedNonRevealChargeBps } from './params.ts';
import type { ChainLimits } from './state.ts';

/**
 * Stage 1's sealed-bid settlement (SPEC §5.2) on the canonical model: the rules a series' terms give Stage 1's auction
 * math, the one D7 rule, and the planner every caller uses (keepers, the harness, conformance and the API's "build the
 * next step"). All arithmetic is Stage 1's (`@merces/math`); this module only chooses which command comes next.
 */

// ------------------------------------------------------------------ rules

/**
 * The terms Stage 1's auction rules read. Structural, so the canonical `SeriesTerms` (decimal strings, numbers) and the
 * simulator's terms (bigints) both satisfy it.
 */
export interface AuctionTermsInput {
  unitsOffered: bigint | string;
  reservePrice: bigint | string;
  minimumRaise: bigint | string;
  walletCapBps: bigint | number;
  auctionFeeBps: bigint | number;
  /** as the series recorded it; the rules carry `appliedNonRevealChargeBps` of it (0 while the charge is held) */
  nonRevealChargeBps: number;
}

/**
 * Stage 1's `AuctionRules` for a series (SIM `auctionRules`). The non-reveal charge is the owner hold's
 * `appliedNonRevealChargeBps` (params.ts): 0 while `NON_REVEAL_CHARGE_HELD`, so Stage 1's own `processBid` refunds an
 * unrevealed bid in full. This is the only place the applied rate is chosen.
 */
export function auctionRulesOf(terms: AuctionTermsInput): AuctionRules {
  return {
    unitsOffered: BigInt(terms.unitsOffered),
    reservePrice: BigInt(terms.reservePrice),
    minRaise: BigInt(terms.minimumRaise),
    walletCapBps: Number(terms.walletCapBps),
    auctionFeeBps: Number(terms.auctionFeeBps),
    nonRevealChargeBps: appliedNonRevealChargeBps(terms.nonRevealChargeBps),
  };
}

/**
 * Stage 1's `finalizeSettlement` with SPEC §5.2 step 5 in full (S2 D7): a round that would settle with 0 units sold
 * fails the raise (MinRaise, proceeds 0), as SPEC and both chains do; the TS reference (`auction.ts:114`) settles it.
 * The engine, the planner's dry run and the services' preview all finalize through this, never through Stage 1's
 * function directly, so the three agree.
 */
export function settlementOutcome(tally: Tally, validCount: number, rules: AuctionRules, proposal: Proposal): FinalizeOutcome {
  const o = finalizeSettlement(tally, validCount, rules, proposal);
  if (o.kind === 'settled' && o.unitsSold === 0n) return { kind: 'failed', reason: 'MinRaise', clearingPrice: o.clearingPrice, unitsSold: 0n, proceeds: 0n };
  return o;
}

/** A proposal's three numbers, as `beginSettlement` takes them. */
export interface SettlementProposal {
  clearingPrice: bigint;
  qAboveClaim: bigint;
  qAtClaim: bigint;
}

/**
 * What an honest proposer claims for a set of revealed bids: Stage 1's `findClearingPrice`, then `claimsFor` at that
 * price. With no valid bid the price is null and the proposal is (0, 0, 0); finalize then fails the raise (NoValidBids)
 * whatever the proposal. Throws when Stage 1 finds no unique valid price (it cannot, with a valid bid).
 */
export function proposalFor(bids: readonly RevealedBid[], unitsOffered: bigint): SettlementProposal {
  const p = findClearingPrice([...bids], unitsOffered);
  if (p === null) return { clearingPrice: 0n, qAboveClaim: 0n, qAtClaim: 0n };
  return { clearingPrice: p, ...claimsFor(bids, p) };
}

// ------------------------------------------------------------------ views

/** The auction fields the planner reads. Structural: the chain's `AuctionState` satisfies it once S2 WP4 lands. */
export interface SettlementAuctionView {
  seriesId: string;
  /** Stage 1's stored raise state; never the display phase (whose `Reveal` also covers an Open raise past its reveal end) */
  raiseState: RaiseStateName;
  commitEndsAt: number | null;
  revealEndsAt: number | null;
  bidCount: number;
  revealedCount: number;
  validCount: number;
  /** Stage 1 `tally_round`: 0 before the first proposal */
  round: number;
  roundRejected: boolean;
  /** the current round's proposal (the rejected one while `roundRejected`); null before the first */
  proposal: { clearingPrice: Money; qAboveClaim: Units; qAtClaim: Units } | null;
  tally: { talliedCount: number };
  mintFinalized: boolean;
}

/** The bid fields the planner reads. Structural: the chain's `BidState` satisfies it once S2 WP4 lands. */
export interface SettlementBidView {
  bidder: string;
  deposit: Money;
  /** commit order */
  order: number;
  revealed: { pricePerUnit: Money; quantity: Units } | null;
  revealIndex: number | null;
  /** the chain's validity, fixed at reveal; null before the reveal */
  valid: boolean | null;
  processed: boolean;
  delivered: boolean;
}

/** What the planner needs about one series: its auction, its bids and its terms. */
export interface SettlementView {
  auction: SettlementAuctionView;
  bids: readonly SettlementBidView[];
  terms: AuctionTermsInput;
}

/** Revealed bids by reveal index, then unrevealed bids by commit order: the order bids are processed and delivered in. */
export function processingOrder<B extends SettlementBidView>(bids: readonly B[]): B[] {
  const byOrder = (x: B, y: B): number => x.order - y.order;
  const revealed = bids.filter((b) => b.revealed !== null).sort((x, y) => {
    const ix = x.revealIndex ?? Number.MAX_SAFE_INTEGER;
    const iy = y.revealIndex ?? Number.MAX_SAFE_INTEGER;
    return ix !== iy ? ix - iy : byOrder(x, y);
  });
  return [...revealed, ...bids.filter((b) => b.revealed === null).sort(byOrder)];
}

/** The revealed bids as Stage 1's `RevealedBid`s, in reveal order, with the chain's validity (false when unknown). */
export function revealedBidsOf(bids: readonly SettlementBidView[]): RevealedBid[] {
  return processingOrder(bids)
    .filter((b) => b.revealed !== null)
    .map((b, i) => ({ price: BigInt(b.revealed!.pricePerUnit), quantity: BigInt(b.revealed!.quantity), escrow: BigInt(b.deposit), valid: b.valid === true, revealIndex: b.revealIndex ?? i }));
}

// ------------------------------------------------------------------ stage

/**
 * Where a raise stands in Stage 1's settlement (a derived label for services; not chain state). `awaiting-proposal`
 * covers an Open raise past its reveal end and a Settling raise whose round was rejected; `delivering` a final mint
 * with a processed bid not yet delivered; `failed-complete` a failed raise with every deposit delivered back.
 */
export type SettlementStage =
  | 'draft' | 'commit' | 'reveal' | 'awaiting-proposal' | 'tallying' | 'awaiting-finalize' | 'processing' | 'delivering'
  | 'complete' | 'failed-complete' | 'cancelled';

export function settlementStage(view: { auction: SettlementAuctionView; bids: readonly SettlementBidView[] }, now: number): SettlementStage {
  const a = view.auction;
  switch (a.raiseState) {
    case 'Draft':
      return 'draft';
    case 'Cancelled':
      return 'cancelled';
    case 'Open':
      if (a.commitEndsAt === null || now < a.commitEndsAt) return 'commit';
      if (a.revealEndsAt === null || now < a.revealEndsAt) return 'reveal';
      return 'awaiting-proposal';
    case 'Settling':
      if (a.roundRejected) return 'awaiting-proposal';
      return a.tally.talliedCount < a.revealedCount ? 'tallying' : 'awaiting-finalize';
    case 'Settled':
    case 'Failed':
      if (!a.mintFinalized) return 'processing';
      if (view.bids.some((b) => b.processed && !b.delivered)) return 'delivering';
      return a.raiseState === 'Settled' ? 'complete' : 'failed-complete';
  }
}

// ------------------------------------------------------------------ planner

/**
 * Why the planner will not act (value-free codes; an operator alert, never a retry loop):
 * - `ValidityMismatch`: a revealed bid's validity on the chain differs from Stage 1's `isBidValid`, or the chain's
 *   valid count differs from its bids;
 * - `NoClearingPrice`: Stage 1's `findClearingPrice` found no unique valid price;
 * - `ProposalRejected`: Stage 1's dry run of the honest proposal is rejected;
 * - `ProposalAlreadyRejected`: the chain already rejected exactly this proposal;
 * - `NoRevealEnd`: an Open raise without phase ends;
 * - `NothingToProcess`: the mint is not final, yet every bid is processed.
 */
export type SettlementStuckReason = 'ValidityMismatch' | 'NoClearingPrice' | 'ProposalRejected' | 'ProposalAlreadyRejected' | 'NoRevealEnd' | 'NothingToProcess';

export type SettlementStep =
  | { kind: 'wait'; until: number; stage: SettlementStage }
  | { kind: 'submit'; command: PermissionlessCommand; stage: SettlementStage }
  | { kind: 'done'; stage: SettlementStage }
  | { kind: 'stuck'; reason: SettlementStuckReason; stage: SettlementStage };

export interface SettlementPlanOptions {
  /** chain time */
  now: number;
  limits: ChainLimits;
  /** whether processed bids are delivered too (the caller's choice; there is no default) */
  deliver: boolean;
}

/**
 * The next settlement command for a series, from its stored raise state, the phase ends and the chain time (a pure
 * function of chain state: re-plan after every submit). In order:
 *  1. Draft or Cancelled: done.
 *  2. Open before the reveal end: wait for it.
 *  3. Open after the reveal end, or Settling with the round rejected: the honest proposal (`proposalFor` over the revealed
 *     bids with the chain's validity, cross-checked with Stage 1's `isBidValid`), dry-run through Stage 1's
 *     `beginSettlement` → `tallyBids` → `settlementOutcome`; `beginSettlement` unless that is stuck (see
 *     `SettlementStuckReason`).
 *  4. Settling, the round not rejected, bids left to tally: `tallyBids` (a foreign round too; it may be right).
 *  5. Settling, the tally complete: `finalizeSettlement`.
 *  6. Settled or Failed with the mint not final: `processBid`, revealed bids by reveal index, then unrevealed ones by
 *     commit order.
 *  7. With `deliver`, a processed bid not yet delivered: `deliverBid`, in the same order.
 *  8. Otherwise done.
 */
export function nextSettlementStep(view: SettlementView, opts: SettlementPlanOptions): SettlementStep {
  const a = view.auction;
  const seriesId = a.seriesId;
  const stage = settlementStage(view, opts.now);
  const submit = (command: PermissionlessCommand): SettlementStep => ({ kind: 'submit', command, stage });
  const stuck = (reason: SettlementStuckReason): SettlementStep => ({ kind: 'stuck', reason, stage });
  switch (a.raiseState) {
    case 'Draft':
    case 'Cancelled':
      return { kind: 'done', stage };
    case 'Open':
      if (a.revealEndsAt === null) return stuck('NoRevealEnd');
      if (opts.now < a.revealEndsAt) return { kind: 'wait', until: a.revealEndsAt, stage };
      return propose(view, submit, stuck);
    case 'Settling':
      if (a.roundRejected) return propose(view, submit, stuck);
      if (a.tally.talliedCount < a.revealedCount) return submit({ kind: 'tallyBids', seriesId, maxBids: opts.limits.tallyPageMax });
      return submit({ kind: 'finalizeSettlement', seriesId });
    case 'Settled':
    case 'Failed': {
      const ordered = processingOrder(view.bids);
      if (!a.mintFinalized) {
        const next = ordered.find((b) => !b.processed);
        return next ? submit({ kind: 'processBid', seriesId, bidder: next.bidder }) : stuck('NothingToProcess');
      }
      if (opts.deliver) {
        const next = ordered.find((b) => b.processed && !b.delivered);
        if (next) return submit({ kind: 'deliverBid', seriesId, bidder: next.bidder });
      }
      return { kind: 'done', stage };
    }
  }
}

function propose(view: SettlementView, submit: (c: PermissionlessCommand) => SettlementStep, stuck: (r: SettlementStuckReason) => SettlementStep): SettlementStep {
  const a = view.auction;
  const rules = auctionRulesOf(view.terms);
  const revealed = revealedBidsOf(view.bids);
  // the chain fixed each bid's validity at reveal; a planner that disagrees with Stage 1's rule must not propose
  const chainValid = processingOrder(view.bids).filter((b) => b.revealed !== null).map((b) => b.valid);
  for (const [i, b] of revealed.entries()) if (chainValid[i] !== isBidValid(b.price, b.quantity, b.escrow, rules)) return stuck('ValidityMismatch');
  if (revealed.filter((b) => b.valid).length !== a.validCount) return stuck('ValidityMismatch');
  let mine: SettlementProposal;
  try {
    mine = proposalFor(revealed, rules.unitsOffered);
  } catch {
    return stuck('NoClearingPrice');
  }
  const begun = beginSettlement(rules.unitsOffered, mine.clearingPrice, mine.qAboveClaim, mine.qAtClaim);
  if (settlementOutcome(tallyBids(revealed, begun), a.validCount, rules, begun).kind === 'rejected') return stuck('ProposalRejected');
  const last = a.proposal;
  if (a.roundRejected && last && BigInt(last.clearingPrice) === mine.clearingPrice && BigInt(last.qAboveClaim) === mine.qAboveClaim && BigInt(last.qAtClaim) === mine.qAtClaim) return stuck('ProposalAlreadyRejected');
  return submit({ kind: 'beginSettlement', seriesId: a.seriesId, clearingPrice: mine.clearingPrice.toString(), qAboveClaim: mine.qAboveClaim.toString(), qAtClaim: mine.qAtClaim.toString() });
}
