import { z } from 'zod';
import { AppError, enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import {
  ChainError, auctionRulesOf, bidCommitment, processingOrder, proposalFor, revealedBidsOf, runSettlement, settlementOutcome, settlementStage,
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
 * builds a bidder's own delivery; and drives settlement for the keepers (`advanceSettlements`). It can never reveal a bid
 * on its own: reveals need the bidder's price, quantity and salt, which only the bidder (or their encrypted backup)
 * holds.
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
  /** series moved on this pass, with the steps sent and the stage they reached */
  advanced: { seriesId: string; steps: PermissionlessCommand['kind'][]; stage: SettlementStage }[];
  /** series the planner will not act on (an operator alert; `SettlementStuckReason`) */
  stuck: { seriesId: string; stage: SettlementStage; reason: SettlementStuckReason }[];
  /** a chain or series whose pass raised: the Stage 1 error name or the ChainError code, never a message */
  failed: { target: string; error: string }[];
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
   * R18/R17 pre-checks against Stage 1's rules (S2): the commit phase, the allowlist, one bid per wallet, and the bid's
   * validity as Stage 1 fixes it at reveal (`isBidValid`: reserve, 1 ≤ quantity ≤ the auction's wallet cap, escrow ≥
   * `requiredEscrow`). A bid that breaks a validity rule can still be committed, but it is invalid at reveal and refunded
   * in full. Returns the issues (empty = ok) and the deposit the commit will lock (`requiredEscrow`).
   */
  async precheck(seriesId: string, session: Session, input: z.infer<typeof precheckSchema>): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, input.bidder);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
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
    return { tx: await chain.build({ kind: 'commitBid', seriesId, commitment, deposit }, bidder) };
  }

  /** Helper for clients without the hashing library: compute the commitment. Nothing is stored. */
  commitment(seriesId: string, bidder: string, pricePerUnit: string, quantity: string, salt: string): { commitment: string } {
    return { commitment: bidCommitment({ seriesId, bidder, pricePerUnit, quantity, salt }) };
  }

  async buildReveal(seriesId: string, session: Session, bidder: string, pricePerUnit: string, quantity: string, salt: string): Promise<{ tx: UnsignedTx }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    const bid = await chain.getBid(seriesId, bidder);
    if (!bid) throw AppError.notFound('bid');
    if (bidCommitment({ seriesId, bidder, pricePerUnit, quantity, salt }) !== bid.commitment) throw AppError.unprocessable('these values do not match the committed bid');
    return { tx: await chain.build({ kind: 'revealBid', seriesId, pricePerUnit, quantity, salt }, bidder) };
  }

  /**
   * The bidder's own delivery (Stage 1 `deliver_bid`, permissionless): a `deliverBid` for its processed, undelivered
   * bid, which pays it the refund (`refundable`, the chain's `pendingRefund`) and its units. 409 before the bid is
   * processed and once it is delivered (the keepers deliver every bid; this is the bidder's "deliver now"). The route
   * keeps its S1 path until WP7 renames it.
   */
  async buildRefund(seriesId: string, session: Session, bidder: string): Promise<{ tx: UnsignedTx; refundable: string }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    const bid = await chain.getBid(seriesId, bidder);
    if (!bid) throw AppError.notFound('bid');
    if (!bid.processed) throw AppError.conflict('the bid is not processed yet');
    if (bid.delivered) throw AppError.conflict('the bid is already delivered');
    return { tx: await chain.build({ kind: 'deliverBid', seriesId, bidder }, bidder), refundable: bid.pendingRefund };
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
   * `stage === 'awaiting-proposal'`.
   */
  async preview(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
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
   * every failure is a code, never a message (S2 L7; adapter messages can embed values). The settled, failed and
   * delivered notices come from the indexer's projection of the finalized events.
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
            const run = await runSettlement(chain, s.seriesId, { until: opts.deliver ? 'deliver' : 'process', maxSteps, atLimit: 'stop' });
            if (run.steps.length) out.advanced.push({ seriesId: s.seriesId, steps: run.steps, stage: run.stage });
            if (run.stuck) out.stuck.push({ seriesId: s.seriesId, stage: run.stage, reason: run.stuck });
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
        errors.push(`${chain.chain}: ${(e as Error).message}`);
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
