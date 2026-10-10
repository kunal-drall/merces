import {
  beginSettlement, claimsFor, finalizeSettlement, findClearingPrice, isBidValid, tallyBids,
  type AuctionRules, type FinalizeOutcome, type Proposal, type RevealedBid, type Tally,
} from '@merces/math';
import type { PermissionlessCommand, TxResult } from './commands.ts';
import type { RaiseStateName } from './events.ts';
import type { Money, Units } from './money.ts';
import { ChainError, type ChainPort } from './port.ts';
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
  /** the series' own non-reveal charge, as it recorded it at creation (Stage 1 `non_reveal_charge_bps`) */
  nonRevealChargeBps: bigint | number;
}

/**
 * Stage 1's `AuctionRules` for a series (SIM `auctionRules`, SIM:917-926): the series' own terms, the non-reveal charge
 * included, so Stage 1's `processBid` keeps `floor(escrow × nonRevealChargeBps / 10000)` of an unrevealed bid on a
 * settled raise (REF auction.ts:141-146) and nothing on a failed one.
 */
export function auctionRulesOf(terms: AuctionTermsInput): AuctionRules {
  return {
    unitsOffered: BigInt(terms.unitsOffered),
    reservePrice: BigInt(terms.reservePrice),
    minRaise: BigInt(terms.minimumRaise),
    walletCapBps: Number(terms.walletCapBps),
    auctionFeeBps: Number(terms.auctionFeeBps),
    nonRevealChargeBps: Number(terms.nonRevealChargeBps),
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

/** The auction fields the planner reads. Structural: the chain's `AuctionState` satisfies it. */
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

/** The bid fields the planner reads. Structural: the chain's `BidState` satisfies it. */
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

// ------------------------------------------------------------------ driver

/**
 * Stage 1 refusals that mean another sender moved the settlement on between our read and our submit (anyone may send
 * every step): the driver re-reads and re-plans instead of failing.
 */
export const SETTLEMENT_LOST_RACE: ReadonlySet<string> = new Set([
  'TallyInProgress', 'NotSettling', 'TallyIncomplete', 'SettlementNotReady', 'RaiseNotOpen', 'RaiseNotSettled', 'AlreadyProcessed', 'NotProcessed', 'AlreadyDelivered',
]);

/** Where `runSettlement` stops: after `finalizeSettlement`, after the last `processBid` (the mint is final), or after every delivery. */
export type SettlementGoal = 'finalize' | 'process' | 'deliver';

export interface RunSettlementOptions {
  until: SettlementGoal;
  /** a bound on submits and re-plans (default 256) */
  maxSteps?: number;
  /**
   * What reaching `maxSteps` does: `'throw'` (the default) raises ChainSpecific; `'stop'` returns what was sent with
   * `limited` set (a keeper that bounds its work per run and comes back on the next).
   */
  atLimit?: 'throw' | 'stop';
  /**
   * What an error does once the run has planned a step (a refused step that is not a lost race, a failed read, or
   * `maxSteps` under `atLimit: 'throw'`): `'throw'` (the default) raises it and the steps already sent are not
   * reported; `'stop'` returns what was sent, with the stage of the last plan (where a refused step was planned) and
   * `error` set (a keeper that reports the steps a pass landed before a refusal). An error before the first plan is
   * thrown either way.
   */
  onError?: 'throw' | 'stop';
  /** how a step is sent; the keeper's `submit` by default (a wallet may build and sign any step instead) */
  submit?: (command: PermissionlessCommand) => Promise<TxResult>;
}

export interface SettlementRun {
  /** the commands sent, in order */
  steps: PermissionlessCommand['kind'][];
  /** the stage the raise stands at when the run stops */
  stage: SettlementStage;
  /** set when the planner will not act (an operator alert) */
  stuck?: SettlementStuckReason;
  /** set when the run stopped to wait for the chain clock (the reveal end) */
  waitUntil?: number;
  /** set when the run stopped at `maxSteps` with work left (`atLimit: 'stop'`) */
  limited?: true;
  /**
   * set when the run stopped at an error (`onError: 'stop'`): the error as raised, which may carry values in its
   * message, so a caller reports it by Stage 1 name or ChainError code only
   */
  error?: unknown;
  /** the transactions sent */
  results: TxResult[];
}

/** The planner's view of a series, read through the port; null when the chain has no such series. */
export async function readSettlementView(port: ChainPort, seriesId: string): Promise<SettlementView | null> {
  const [series, auction, bids] = await Promise.all([port.getSeries(seriesId), port.getAuction(seriesId), port.listBids(seriesId)]);
  if (!series || !auction) return null;
  return { auction, bids, terms: series.terms };
}

/**
 * Drive a raise's settlement through the chain until `until`: plan (`nextSettlementStep`), send, re-read, again. A
 * step refused because someone else moved the settlement on (`SETTLEMENT_LOST_RACE`) is re-planned; any other refusal
 * is thrown, or with `onError: 'stop'` ends the run with the steps already sent and `error`. Stops early, without
 * throwing, when the planner waits for the reveal end or is stuck. Used by the keepers, the harness, conformance and
 * the API's "build the next step".
 */
export async function runSettlement(port: ChainPort, seriesId: string, opts: RunSettlementOptions): Promise<SettlementRun> {
  const maxSteps = opts.maxSteps ?? 256;
  const submit = opts.submit ?? ((command: PermissionlessCommand) => port.submit(command, 'keeper'));
  const limits = (await port.info()).limits;
  const steps: PermissionlessCommand['kind'][] = [];
  const results: TxResult[] = [];
  /** the stage the raise stood at when the run last planned (null before the first plan) */
  let planned: SettlementStage | null = null;
  try {
    for (let attempts = 0; ; attempts++) {
      const view = await readSettlementView(port, seriesId);
      if (!view) throw new ChainError('NotFound', `series ${seriesId} not found`);
      const now = await port.now();
      const stage = settlementStage(view, now);
      const finalized = view.auction.raiseState === 'Settled' || view.auction.raiseState === 'Failed';
      if (opts.until === 'finalize' && finalized) return { steps, stage, results };
      const step = nextSettlementStep(view, { now, limits, deliver: opts.until === 'deliver' });
      planned = step.stage;
      if (step.kind === 'done') return { steps, stage: step.stage, results };
      if (step.kind === 'wait') return { steps, stage: step.stage, waitUntil: step.until, results };
      if (step.kind === 'stuck') return { steps, stage: step.stage, stuck: step.reason, results };
      if (attempts >= maxSteps) {
        if (opts.atLimit === 'stop') return { steps, stage: step.stage, limited: true, results };
        throw new ChainError('ChainSpecific', `settlement of ${seriesId} did not finish within ${maxSteps} steps`);
      }
      try {
        results.push(await submit(step.command));
        steps.push(step.command.kind);
      } catch (e) {
        const name = e instanceof ChainError ? e.detail?.stage1 : undefined;
        if (typeof name === 'string' && SETTLEMENT_LOST_RACE.has(name)) continue; // a lost race: re-read and re-plan
        throw e;
      }
    }
  } catch (e) {
    // the steps sent so far landed: a keeper reports them with the error rather than losing them
    if (opts.onError === 'stop' && planned !== null) return { steps, stage: planned, error: e, results };
    throw e;
  }
}
