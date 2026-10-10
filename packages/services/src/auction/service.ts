import { z } from 'zod';
import { AppError, enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import {
  ChainError, auctionRulesOf, bidCommitment, nextSettlementStep, processingOrder, proposalFor, readSettlementView, revealedBidsOf, runSettlement, settlementOutcome, settlementStage,
  type AuctionTermsInput, type ChainPort, type PermissionlessCommand, type SettlementBidView, type SettlementProposal, type SettlementStage,
  type SettlementStuckReason, type UnsignedTx,
} from '@merces/domain';
import { U64_MAX, beginSettlement, processBid, requiredEscrow, tallyBids, walletCapUnitsAtAuction, type FinalizeOutcome, type RevealedBid } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E6 — auction service, on Stage 1's sealed-bid auction (SPEC §5.1–§5.2; S2). Pre-checks a bid against Stage 1's
 * validity rule and required escrow before it is built; stores client-encrypted reveal backups it cannot read; previews
 * the settlement offchain with Stage 1's math (the honest proposal, the tally, the D7 outcome and each bid's processing);
 * builds the issuer's open and cancel, a delivery and the next settlement step for any wallet (every settlement step is
 * permissionless); and drives settlement and delivery for the keepers (`advanceSettlements`, `deliverDue`).
 * It can never reveal a bid on its own: reveals need the bidder's price, quantity and salt, which only the bidder (or
 * their encrypted backup) holds.
 */
export const precheckSchema = z.object({ bidder: z.string(), pricePerUnit: z.string().regex(/^\d+$/), quantity: z.string().regex(/^\d+$/) });

/**
 * A raise that drew no bid is not settled by the keepers until this long after its reveal end (ASSUMPTIONS A-AUC-12):
 * Stage 1 lets the issuer cancel an Open raise while no bid exists, with no time limit (SIM:578-585), and the keepers'
 * proposal would fail the raise (NoValidBids) at once. Anyone may still settle it earlier with a step of their own.
 */
export const ZERO_BID_GRACE_SECONDS = 24 * 3_600;

/** What one keeper pass over the settlements did (`advanceSettlements`). Value-free: names, codes and counts only. */
export interface SettlementAdvances {
  /** series moved on this pass, with the steps sent and the stage they reached (also when a later step was refused) */
  advanced: { seriesId: string; steps: PermissionlessCommand['kind'][]; stage: SettlementStage }[];
  /** series the planner will not act on (an operator alert; `SettlementStuckReason`) */
  stuck: { seriesId: string; stage: SettlementStage; reason: SettlementStuckReason }[];
  /** a chain or series whose pass raised: the Stage 1 error name or the ChainError code, never a message */
  failed: { target: string; error: string }[];
}

/**
 * The keepers' wait before retrying a failed delivery, by the number of failed attempts so far (1 min, 5 min, 30 min,
 * 2 h, 12 h, then daily): `deliveryBackoffSeconds`. Times are the chain's clock.
 */
export const DELIVERY_BACKOFF_SECONDS: readonly number[] = [60, 5 * 60, 30 * 60, 2 * 3_600, 12 * 3_600];
const DELIVERY_BACKOFF_DAILY = 24 * 3_600;

/** Seconds to wait after the `attempts`-th failed delivery of a bid before the next attempt. */
export function deliveryBackoffSeconds(attempts: number): number {
  return DELIVERY_BACKOFF_SECONDS[Math.max(1, attempts) - 1] ?? DELIVERY_BACKOFF_DAILY;
}

/**
 * A processed bid whose delivery has failed and that is still undelivered this long after the raise was finalized
 * (`AuctionState.finalizedAt`, chain time) is reported once as `bid.delivery-stuck` (the admins and the bidder).
 */
export const DELIVERY_STUCK_AFTER_SECONDS = 24 * 3_600;

/** What one keeper delivery pass did (`deliverDue`). Value-free: series, bidders, codes and counts only. */
export interface DeliveryPass {
  /** bids delivered on this pass */
  delivered: { seriesId: string; bidder: string }[];
  /** processed, undelivered bids left alone on this pass: still in their backoff, or past the per-series bound */
  deferred: number;
  /** deliveries refused on this pass: the Stage 1 error name or the ChainError code (never a message) and the attempts so far */
  failed: { seriesId: string; bidder: string; error: string; attempts: number }[];
  /** bids reported stuck on this pass (`bid.delivery-stuck` enqueued; once per bid) */
  stuck: { seriesId: string; bidder: string }[];
  /** a chain or series whose bids could not be read: the code, never a message */
  errors: { target: string; error: string }[];
}

/** A bid's delivery record (`auction_deliveries`, failed bids only): the failed attempts, the next one (chain time), stuck notified. */
interface DeliveryRecord {
  attempts: number;
  nextAt: number;
  notified: boolean;
}

/** An error as a value-free code: the Stage 1 name (`detail.stage1`), else the ChainError code, else the class. */
export function errorCode(e: unknown): string {
  if (e instanceof ChainError) return typeof e.detail?.stage1 === 'string' ? e.detail.stage1 : e.code;
  return e instanceof Error ? e.name : 'Error';
}

export class AuctionService {
  constructor(private readonly ctx: ServiceContext) {}

  private async requireWallet(session: Session, chain: string, address: string): Promise<void> {
    if (!session.wallets.some((w) => w.chain === chain && w.address === address) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
  }

  /**
   * A sealed-bid series, read from the chain (404 when unknown). Every auction builder refuses a curve series first
   * with 409 NotSealedBid (S3 amendment M7), as the chain does: a curve raise is its bonding curve, with no auction.
   */
  private async sealedSeries(chain: ChainPort, seriesId: string): Promise<NonNullable<Awaited<ReturnType<ChainPort['getSeries']>>>> {
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    if (s.terms.raiseStyle !== 'sealed') throw AppError.conflict('a curve-mode series runs no sealed-bid raise', { stage1: 'NotSealedBid' });
    return s;
  }

  /**
   * R18/R17 pre-checks against Stage 1's rules (S2): the commit phase, the allowlist, one bid per wallet, and the bid's
   * validity as Stage 1 fixes it at reveal (`isBidValid`: reserve, 1 ≤ quantity ≤ the auction's wallet cap, escrow ≥
   * `requiredEscrow`). A bid that breaks a validity rule can still be committed, but it is invalid at reveal and refunded
   * in full. Returns the issues (empty = ok) and the deposit the commit will lock (`requiredEscrow`).
   */
  async precheck(seriesId: string, session: Session, input: z.infer<typeof precheckSchema>): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, input.bidder);
    const s = await this.sealedSeries(chain, seriesId);
    const issues: { code: string; message: string }[] = [];
    const auction = await chain.getAuction(seriesId);
    if (auction?.phase !== 'Open') issues.push({ code: 'phase', message: `auction is ${auction?.phase ?? 'not open'}` });
    if (!(await chain.isAllowlisted(input.bidder))) issues.push({ code: 'allowlist', message: 'wallet is not allowlisted' });
    const rules = auctionRulesOf(s.terms);
    const price = BigInt(input.pricePerUnit);
    const qty = BigInt(input.quantity);
    const invalid = 'such a bid is invalid at reveal and refunded in full';
    if (price < rules.reservePrice) issues.push({ code: 'reserve', message: `price is below the reserve ${rules.reservePrice}; ${invalid}` });
    const cap = walletCapUnitsAtAuction(rules.unitsOffered, rules.walletCapBps);
    if (qty > cap) issues.push({ code: 'wallet-cap', message: `quantity exceeds the per-wallet cap of ${cap} units (${rules.walletCapBps} bps); ${invalid}` });
    if (qty <= 0n) issues.push({ code: 'quantity', message: `quantity must be positive; ${invalid}` });
    if (await chain.getBid(seriesId, input.bidder)) issues.push({ code: 'duplicate', message: 'this wallet already committed a bid' });
    const deposit = requiredEscrow(price, qty, rules.auctionFeeBps);
    // Stage 1 decodes the escrow, the price and the quantity as u64s (AmountOutOfRange)
    if (price > U64_MAX || qty > U64_MAX || deposit > U64_MAX) issues.push({ code: 'range', message: 'the price, the quantity and the deposit must each fit in 64 bits' });
    const balance = BigInt(await chain.getBalance(input.bidder, s.terms.stablecoin));
    if (balance < deposit) issues.push({ code: 'balance', message: `deposit ${deposit} exceeds balance ${balance}` });
    return { ok: issues.length === 0, issues, deposit: deposit.toString(), walletCapUnits: cap.toString(), fee: (deposit - price * qty).toString(), commitEndsAt: auction?.commitEndsAt ?? null, revealEndsAt: auction?.revealEndsAt ?? null };
  }

  /** Build commitBid from a commitment the client computed (price, quantity and salt never reach the server). */
  async buildCommit(seriesId: string, session: Session, bidder: string, commitment: string, deposit: string): Promise<{ tx: UnsignedTx }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    await this.sealedSeries(chain, seriesId);
    return { tx: await chain.build({ kind: 'commitBid', seriesId, commitment, deposit }, bidder) };
  }

  /** Helper for clients without the hashing library: compute the commitment. Nothing is stored. */
  commitment(seriesId: string, bidder: string, pricePerUnit: string, quantity: string, salt: string): { commitment: string } {
    return { commitment: bidCommitment({ seriesId, bidder, pricePerUnit, quantity, salt }) };
  }

  async buildReveal(seriesId: string, session: Session, bidder: string, pricePerUnit: string, quantity: string, salt: string): Promise<{ tx: UnsignedTx }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    await this.sealedSeries(chain, seriesId);
    const bid = await chain.getBid(seriesId, bidder);
    if (!bid) throw AppError.notFound('bid');
    if (bidCommitment({ seriesId, bidder, pricePerUnit, quantity, salt }) !== bid.commitment) throw AppError.unprocessable('these values do not match the committed bid');
    return { tx: await chain.build({ kind: 'revealBid', seriesId, pricePerUnit, quantity, salt }, bidder) };
  }

  /**
   * A delivery (Stage 1 `deliver_bid`, permissionless): a `deliverBid` for a processed, undelivered bid, which pays the
   * bidder its refund (`pendingRefund`) and its units (`pendingUnits`). The keepers deliver every bid; this is the
   * bidder's "deliver now", or anyone's when the keepers stall. `signer` (the wallet that sends it) defaults to the
   * bidder and must be one of the caller's wallets; any wallet may deliver any bid, and the bidder is always the one
   * paid. 409 before the bid is processed (NotProcessed) and once it is delivered (AlreadyDelivered).
   */
  async buildDeliver(seriesId: string, session: Session, bidder: string, signer?: string): Promise<{ tx: UnsignedTx; pendingUnits: string; pendingRefund: string }> {
    const chain = this.ctx.chainFor(seriesId);
    const from = signer ?? bidder;
    await this.requireWallet(session, chain.chain, from);
    await this.sealedSeries(chain, seriesId);
    const bid = await chain.getBid(seriesId, bidder);
    if (!bid) throw AppError.notFound('bid');
    if (!bid.processed) throw AppError.conflict('the bid is not processed yet', { stage1: 'NotProcessed' });
    if (bid.delivered) throw AppError.conflict('the bid is already delivered', { stage1: 'AlreadyDelivered' });
    return { tx: await chain.build({ kind: 'deliverBid', seriesId, bidder }, from), pendingUnits: bid.pendingUnits, pendingRefund: bid.pendingRefund };
  }

  /**
   * The next settlement step as an unsigned transaction for `signer` (one of the caller's wallets): the planner the
   * keepers use (`nextSettlementStep`, from the chain's stored raise state and its clock, deliveries included), so a
   * wallet can drive a settlement itself when the keepers stall, or settle a raise with no bid inside the keepers' grace
   * (A-AUC-12). Every step is permissionless. Relaying each step and asking again reaches mint finalisation, then delivers
   * each bid. 409 with `{stage, reason}` when there is nothing to build: `wait` (until the reveal end, `until`), `done`,
   * or the planner's stuck code (`SettlementStuckReason`; an operator matter).
   */
  async buildSettlementStep(seriesId: string, session: Session, signer: string): Promise<{ stage: SettlementStage; command: PermissionlessCommand; tx: UnsignedTx }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, signer);
    await this.sealedSeries(chain, seriesId);
    const view = await readSettlementView(chain, seriesId);
    if (!view) throw AppError.notFound('auction');
    const [now, info] = await Promise.all([chain.now(), chain.info()]);
    const step = nextSettlementStep(view, { now, limits: info.limits, deliver: true });
    switch (step.kind) {
      case 'submit':
        return { stage: step.stage, command: step.command, tx: await chain.build(step.command, signer) };
      case 'wait':
        throw AppError.conflict(`nothing to settle before the reveal end (${step.until})`, { stage: step.stage, reason: 'wait', until: step.until });
      case 'done':
        throw AppError.conflict('the settlement is complete', { stage: step.stage, reason: 'done' });
      case 'stuck':
        throw AppError.conflict(`the settlement cannot go on (${step.reason})`, { stage: step.stage, reason: step.reason });
    }
  }

  /**
   * The issuer's `openRaise` (Stage 1 `open_raise`), with Stage 1's checks in its order so a refusal comes before the
   * wallet signs: a sealed-bid series (NotSealedBid: a curve's raise opens at its creation), a Draft raise
   * (RaiseNotDraft), a contract hash (ContractHashMissing), the issuer still allowlisted (NotAllowlisted), new raises not
   * paused (NewRaisesPaused). The chain sets the phase ends from the series' durations when it executes. 409 on a
   * refusal, with the Stage 1 name where Stage 1 has one.
   */
  async buildOpenRaise(seriesId: string): Promise<{ tx: UnsignedTx; commitDurationSeconds: number; revealDurationSeconds: number }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await this.sealedSeries(chain, seriesId);
    if (s.phase !== 'Draft') throw AppError.conflict(`the raise is ${s.phase}`, { stage1: 'RaiseNotDraft' });
    if (/^0x0*$/.test(s.terms.contractHash)) throw AppError.conflict('the series has no contract hash', { stage1: 'ContractHashMissing' });
    if (!(await chain.isAllowlisted(s.issuer))) throw AppError.conflict('the issuer is not allowlisted', { stage1: 'NotAllowlisted' });
    if ((await chain.info()).newRaisesPaused) throw AppError.conflict('new raises are paused', { stage1: 'NewRaisesPaused' });
    return { tx: await chain.build({ kind: 'openRaise', seriesId }, s.issuer), commitDurationSeconds: s.terms.commitDurationSeconds, revealDurationSeconds: s.terms.revealDurationSeconds };
  }

  /**
   * The issuer's `cancelRaise` (Stage 1 `cancel_raise`): a sealed-bid series (NotSealedBid: a curve raise has no cancel,
   * no failure and no deadline), an Open raise with no bid (RaiseNotOpen, BidsExist; no time limit, so a raise that drew
   * no bid can be cancelled after its reveal end). 409 on a refusal.
   */
  async buildCancelRaise(seriesId: string): Promise<{ tx: UnsignedTx }> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await this.sealedSeries(chain, seriesId);
    if (s.phase !== 'Open') throw AppError.conflict(`the raise is ${s.phase}`, { stage1: 'RaiseNotOpen' });
    const a = await chain.getAuction(seriesId);
    if ((a?.bidCount ?? 0) > 0) throw AppError.conflict('bids exist; the raise can no longer be cancelled', { stage1: 'BidsExist' });
    return { tx: await chain.build({ kind: 'cancelRaise', seriesId }, s.issuer) };
  }

  // ---- client-encrypted backups
  async putBackup(seriesId: string, session: Session, bidder: string, ciphertext: string, keyHint: string | null): Promise<{ ok: true }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    if (ciphertext.length > 16_384) throw AppError.badRequest('backup too large');
    if (/"pricePerUnit"|"quantity"|"salt"/.test(ciphertext)) throw AppError.badRequest('backup must be client-encrypted; plaintext bid fields detected');
    await this.ctx.pool.query('insert into bid_backups (series_id, bidder, account_id, ciphertext, key_hint) values ($1,$2,$3,$4,$5) on conflict (series_id, bidder) do update set ciphertext = excluded.ciphertext, key_hint = excluded.key_hint, updated_at = now()', [seriesId, bidder, session.accountId, ciphertext, keyHint]);
    return { ok: true };
  }
  async getBackup(seriesId: string, session: Session, bidder: string): Promise<{ ciphertext: string; keyHint: string | null; updatedAt: string }> {
    const r = await this.ctx.pool.query('select ciphertext, key_hint, updated_at, account_id from bid_backups where series_id = $1 and bidder = $2', [seriesId, bidder]);
    const row = r.rows[0];
    if (!row) throw AppError.notFound('backup');
    if (row.account_id !== session.accountId) throw AppError.forbidden();
    return { ciphertext: row.ciphertext, keyHint: row.key_hint, updatedAt: row.updated_at };
  }

  /**
   * Offchain settlement preview from the revealed bids (public onchain once revealed), with Stage 1's math and the
   * chain's validity: the honest proposal (`proposalFor`), its tally, the outcome with SPEC's D7 rule
   * (`settlementOutcome`: the engine and the planner use the same) and each revealed bid's processing (Stage 1
   * `processBid` under `auctionRulesOf`). Every revealed bid counts, its bidder still allowlisted or not: Stage 1 checks
   * the allowlist at commit only, and settles and delivers a bidder removed since (S2-DA). Shown while the raise is Open or
   * Settling; null when no single clearing price exists. `stage` is where the settlement stands; `settleDue` is
   * `stage === 'awaiting-proposal'`. A curve series has no auction to preview (409 NotSealedBid).
   */
  async preview(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await this.sealedSeries(chain, seriesId);
    const a = await chain.getAuction(seriesId);
    if (!a) throw AppError.notFound('auction');
    const now = await chain.now();
    const bids = await chain.listBids(seriesId);
    const stage = settlementStage({ auction: a, bids }, now);
    const projecting = a.raiseState === 'Open' || a.raiseState === 'Settling';
    return {
      seriesId, phase: s.phase, stage, bidCount: a.bidCount, revealedCount: a.revealedCount, validCount: a.validCount, settleDue: stage === 'awaiting-proposal',
      projected: projecting ? projectSettlement(s.terms, bids, a.validCount) : null,
      settled: s.phase === 'Settled' ? { clearingPrice: s.issuePrice, unitsSold: s.unitsSold } : null,
    };
  }

  /**
   * Keeper entry: drive every sealed-bid settlement on every chain one pass further with Stage 1's steps
   * (`runSettlement`: proposal, tally pages, finalize, a process per bid and, with `deliver`, a delivery per bid), at
   * most `maxStepsPerSeries` sends per series per pass (the next pass goes on). `deliver` has no default: the caller
   * says whether this pass also pushes refunds and units (S2 amendment L8). A raise that drew no bid waits
   * `ZERO_BID_GRACE_SECONDS` past its reveal end, so its issuer can still cancel it (A-AUC-12). A step another sender got
   * in first is re-planned, not a failure. Chains and series are independent (one failure never stops the rest), and
   * every failure is a code, never a message (S2 L7; adapter messages can embed values). A pass that sends steps and is
   * then refused reports both: the steps that landed (`advanced`, with the stage where the refused step was planned) and
   * the refusal (`failed`). A series the planner will not act on is reported in `stuck` and, once per round and
   * reason, to the admins (`auction.settlement-stuck`). The keepers'
   * `auction.settle` job passes `deliver: false` and leaves delivery to `deliverDue` (its own job, with a per-bid
   * backoff). The settled, failed, mint-finalized and delivered notices come from the indexer's projection of the
   * finalized events.
   */
  async advanceSettlements(opts: { deliver: boolean; maxStepsPerSeries?: number }): Promise<SettlementAdvances> {
    const out: SettlementAdvances = { advanced: [], stuck: [], failed: [] };
    const maxSteps = opts.maxStepsPerSeries ?? 64;
    for (const chain of this.ctx.chains.chains.values()) {
      try {
        const now = await chain.now();
        for (const s of await chain.listSeries()) {
          if (s.terms.raiseStyle !== 'sealed' || s.phase === 'Draft' || s.phase === 'Cancelled') continue;
          if ((s.phase === 'Settled' || s.phase === 'Failed') && s.mintFinalized && !opts.deliver) continue;
          try {
            if (s.phase === 'Open' && (await this.inZeroBidGrace(chain, s.seriesId, now))) continue;
            // a refusal ends the series' pass but keeps the steps that landed before it (`onError: 'stop'`)
            const run = await runSettlement(chain, s.seriesId, { until: opts.deliver ? 'deliver' : 'process', maxSteps, atLimit: 'stop', onError: 'stop' });
            if (run.steps.length) out.advanced.push({ seriesId: s.seriesId, steps: run.steps, stage: run.stage });
            if (run.error !== undefined) out.failed.push({ target: s.seriesId, error: errorCode(run.error) });
            if (run.stuck) {
              out.stuck.push({ seriesId: s.seriesId, stage: run.stage, reason: run.stuck });
              await this.noticeSettlementStuck(chain, s.seriesId, run.stuck);
            }
          } catch (e) {
            out.failed.push({ target: s.seriesId, error: errorCode(e) });
          }
        }
      } catch (e) {
        out.failed.push({ target: chain.chain, error: errorCode(e) });
      }
    }
    return out;
  }

  /** An Open raise with no bid, before `ZERO_BID_GRACE_SECONDS` past its reveal end. */
  private async inZeroBidGrace(chain: ChainPort, seriesId: string, now: number): Promise<boolean> {
    const a = await chain.getAuction(seriesId);
    return !!a && a.raiseState === 'Open' && a.bidCount === 0 && a.revealEndsAt !== null && now < a.revealEndsAt + ZERO_BID_GRACE_SECONDS;
  }

  /**
   * Tell the admins a settlement is stuck (`auction.settlement-stuck`), once per series, round and reason: the ledger row
   * and the notice commit together. The notice carries the reason code only (`outcome`).
   */
  private async noticeSettlementStuck(chain: ChainPort, seriesId: string, reason: SettlementStuckReason): Promise<void> {
    const round = (await chain.getAuction(seriesId))?.round ?? 0;
    await withTransaction(this.ctx.pool, async (db) => {
      const ins = await db.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', ['auction.settlement-stuck', `${seriesId}:${round}:${reason}`, 'admins']);
      if (ins.rowCount) await enqueueOutbox(db, 'notification', { kind: 'auction.settlement-stuck', seriesId, outcome: reason });
    });
  }

  /**
   * Keeper entry (`auction.deliver`): push every processed, undelivered bid on every chain with Stage 1's `deliver_bid`
   * (permissionless; it pays the bid's refund and its units). The bids are the chain's (`listBids`, processed and not
   * delivered: a failed raise's deposits and the losers' refunds included; S2 amendment M4), never the indexer's. A
   * delivery the chain refuses is retried with a per-bid backoff (`deliveryBackoffSeconds`, chain time) kept in
   * `auction_deliveries` with the Stage 1 error name or the ChainError code only, never a message (S2 L7; adapter
   * messages can embed values). A bid whose delivery has failed and that is still undelivered
   * `DELIVERY_STUCK_AFTER_SECONDS` after its raise was finalized is reported once (`bid.delivery-stuck`, to the admins
   * and the bidder). A bid someone else delivered first (AlreadyDelivered) is not a failure, and its record is dropped.
   * Chains and series are independent; at most `maxPerSeries` attempts per series per pass (the next pass goes on).
   * Processing is the settle job's (`advanceSettlements`); a bid can be delivered as soon as it is processed (Stage 1
   * checks NotProcessed and AlreadyDelivered only).
   */
  async deliverDue(opts: { maxPerSeries?: number } = {}): Promise<DeliveryPass> {
    const out: DeliveryPass = { delivered: [], deferred: 0, failed: [], stuck: [], errors: [] };
    const maxPerSeries = opts.maxPerSeries ?? 64;
    const records = await this.deliveryRecords();
    for (const chain of this.ctx.chains.chains.values()) {
      try {
        const now = await chain.now();
        for (const s of await chain.listSeries()) {
          if (s.terms.raiseStyle !== 'sealed' || (s.phase !== 'Settled' && s.phase !== 'Failed')) continue;
          try {
            await this.deliverSeries(chain, s.seriesId, now, records.get(s.seriesId) ?? new Map(), maxPerSeries, out);
          } catch (e) {
            out.errors.push({ target: s.seriesId, error: errorCode(e) });
          }
        }
      } catch (e) {
        out.errors.push({ target: chain.chain, error: errorCode(e) });
      }
    }
    return out;
  }

  /** The keepers' delivery records (failed bids only), by series and bidder. */
  private async deliveryRecords(): Promise<Map<string, Map<string, DeliveryRecord>>> {
    const r = await this.ctx.pool.query<{ series_id: string; bidder: string; attempts: number; next_at: string | null; notified: boolean }>(
      'select series_id, bidder, attempts, extract(epoch from next_attempt_at)::bigint::text as next_at, stuck_notified_at is not null as notified from auction_deliveries',
    );
    const out = new Map<string, Map<string, DeliveryRecord>>();
    for (const x of r.rows) {
      const bySeries = out.get(x.series_id) ?? new Map<string, DeliveryRecord>();
      bySeries.set(x.bidder, { attempts: x.attempts, nextAt: x.next_at === null ? 0 : Number(x.next_at), notified: x.notified });
      out.set(x.series_id, bySeries);
    }
    return out;
  }

  /** One series' pass of `deliverDue`. */
  private async deliverSeries(chain: ChainPort, seriesId: string, now: number, records: Map<string, DeliveryRecord>, maxPerSeries: number, out: DeliveryPass): Promise<void> {
    const due = processingOrder(await chain.listBids(seriesId)).filter((b) => b.processed && !b.delivered);
    const owed = new Set(due.map((b) => b.bidder));
    // a recorded bid delivered since (by anyone): its record is no longer needed
    for (const bidder of records.keys()) if (!owed.has(bidder)) await this.dropDeliveryRecord(seriesId, bidder);
    if (!due.length) return;
    const finalizedAt = (await chain.getAuction(seriesId))?.finalizedAt ?? null;
    let attempted = 0;
    for (const b of due) {
      let record = records.get(b.bidder) ?? null;
      if ((record && now < record.nextAt) || attempted >= maxPerSeries) {
        out.deferred++;
      } else {
        attempted++;
        try {
          await chain.submit({ kind: 'deliverBid', seriesId, bidder: b.bidder }, 'keeper');
          out.delivered.push({ seriesId, bidder: b.bidder });
          if (record) await this.dropDeliveryRecord(seriesId, b.bidder);
          continue;
        } catch (e) {
          const error = errorCode(e);
          if (error === 'AlreadyDelivered') {
            // someone else (the bidder, any wallet) delivered it between our read and our send
            if (record) await this.dropDeliveryRecord(seriesId, b.bidder);
            continue;
          }
          const attempts = (record?.attempts ?? 0) + 1;
          const nextAt = now + deliveryBackoffSeconds(attempts);
          await this.ctx.pool.query(
            'insert into auction_deliveries (series_id, bidder, attempts, next_attempt_at, last_error) values ($1,$2,$3,to_timestamp($4),$5) on conflict (series_id, bidder) do update set attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error',
            [seriesId, b.bidder, attempts, nextAt, error],
          );
          record = { attempts, nextAt, notified: record?.notified ?? false };
          out.failed.push({ seriesId, bidder: b.bidder, error, attempts });
        }
      }
      if (record && !record.notified && finalizedAt !== null && now >= finalizedAt + DELIVERY_STUCK_AFTER_SECONDS && (await this.noticeDeliveryStuck(seriesId, b.bidder, now))) {
        out.stuck.push({ seriesId, bidder: b.bidder });
      }
    }
  }

  private async dropDeliveryRecord(seriesId: string, bidder: string): Promise<void> {
    await this.ctx.pool.query('delete from auction_deliveries where series_id = $1 and bidder = $2', [seriesId, bidder]);
  }

  /** `bid.delivery-stuck`, once per bid: the record's mark and the notice commit together. */
  private async noticeDeliveryStuck(seriesId: string, bidder: string, now: number): Promise<boolean> {
    return withTransaction(this.ctx.pool, async (db) => {
      const r = await db.query('update auction_deliveries set stuck_notified_at = to_timestamp($3) where series_id = $1 and bidder = $2 and stuck_notified_at is null', [seriesId, bidder, now]);
      if (!r.rowCount) return false;
      await enqueueOutbox(db, 'notification', { kind: 'bid.delivery-stuck', seriesId, wallet: bidder });
      return true;
    });
  }

  /** Keeper entry: remind committed-but-unrevealed bidders before the reveal deadline (once per bidder per series). */
  async revealReminders(hoursBefore = 12, errors: string[] = []): Promise<number> {
    let sent = 0;
    for (const chain of this.ctx.chains.chains.values()) {
      try {
        const now = await chain.now();
        for (const s of await chain.listSeries()) {
          if (s.phase !== 'Open') continue;
          const a = await chain.getAuction(s.seriesId);
          if (!a?.revealEndsAt || !a.commitEndsAt || now < a.commitEndsAt || now > a.revealEndsAt || a.revealEndsAt - now > hoursBefore * 3600) continue;
          for (const b of await chain.listBids(s.seriesId)) {
            if (b.revealed) continue;
            // ledger row and notice commit together, so a crash between them can neither lose nor repeat the reminder
            const fresh = await withTransaction(this.ctx.pool, async (db) => {
              const ins = await db.query('insert into reminders_sent (kind, target, recipient) values ($1,$2,$3) on conflict do nothing', ['reveal', s.seriesId, b.bidder]);
              if (!ins.rowCount) return false;
              await enqueueOutbox(db, 'notification', { kind: 'bid.reveal-reminder', seriesId: s.seriesId, wallet: b.bidder, revealEndsAt: a.revealEndsAt });
              return true;
            });
            if (fresh) sent++;
          }
        }
      } catch (e) {
        errors.push(`${chain.chain}: ${errorCode(e)}`); // a code, never a message (S2 L7)
      }
    }
    return sent;
  }

}

/** One revealed bid's projected processing (Stage 1 `processBid`). */
export interface ProjectedAllocation {
  bidder: string;
  units: string;
  cost: string;
  fee: string;
  refund: string;
}

/**
 * The settlement Stage 1 would reach on the revealed bids (the preview): the honest proposal, the D7 outcome and each
 * revealed bid's processing, in reveal order. Null when no single valid clearing price exists, or when Stage 1 would
 * reject the honest proposal (neither can happen with a valid bid; the planner reports them as stuck).
 */
export function projectSettlement(terms: AuctionTermsInput, bids: readonly SettlementBidView[], validCount: number): Record<string, unknown> | null {
  const rules = auctionRulesOf(terms);
  const revealed: RevealedBid[] = revealedBidsOf(bids);
  let proposal: SettlementProposal;
  try {
    proposal = proposalFor(revealed, rules.unitsOffered);
  } catch {
    return null;
  }
  const begun = beginSettlement(rules.unitsOffered, proposal.clearingPrice, proposal.qAboveClaim, proposal.qAtClaim);
  const tally = tallyBids(revealed, begun);
  const o: FinalizeOutcome = settlementOutcome(tally, validCount, rules, begun);
  if (o.kind === 'rejected') return null;
  const settled = o.kind === 'settled';
  const state = { failed: !settled, clearingPrice: o.clearingPrice, R: settled ? o.R : 0n, qAt: tally.qAt };
  const allocations: ProjectedAllocation[] = processingOrder(bids)
    .filter((b) => b.revealed !== null)
    .map((b) => {
      const x = processBid({ escrow: BigInt(b.deposit), revealed: true, valid: b.valid === true, price: BigInt(b.revealed!.pricePerUnit), quantity: BigInt(b.revealed!.quantity) }, state, rules);
      return { bidder: b.bidder, units: x.alloc.toString(), cost: x.cost.toString(), fee: x.fee.toString(), refund: x.pendingRefund.toString() };
    });
  return {
    success: settled,
    reason: settled ? null : o.reason,
    clearingPrice: o.kind === 'failed' && o.reason === 'NoValidBids' ? null : o.clearingPrice.toString(),
    unitsSold: o.unitsSold.toString(),
    proceeds: o.proceeds.toString(),
    qAboveClaim: proposal.qAboveClaim.toString(),
    qAtClaim: proposal.qAtClaim.toString(),
    R: (settled ? o.R : 0n).toString(),
    allocations,
  };
}
