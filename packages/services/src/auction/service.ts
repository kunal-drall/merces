import { z } from 'zod';
import { AppError, enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import { bidCommitment, type UnsignedTx } from '@merces/domain';
import { bidDeposit, clearAuction, walletCapUnits } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E6 — auction service. Pre-checks the wallet cap, allowlist, phase and balance before a bid is built; stores
 * client-encrypted reveal backups it cannot read; previews the clearing price offchain from revealed bids;
 * the keeper cranks settlement. It can never reveal a bid on its own: reveals need the bidder's price,
 * quantity and salt, which only the bidder (or their encrypted backup) holds.
 */
export const precheckSchema = z.object({ bidder: z.string(), pricePerUnit: z.string().regex(/^\d+$/), quantity: z.string().regex(/^\d+$/) });

export class AuctionService {
  constructor(private readonly ctx: ServiceContext) {}

  private async requireWallet(session: Session, chain: string, address: string): Promise<void> {
    if (!session.wallets.some((w) => w.chain === chain && w.address === address) && !session.roles.includes('admin')) throw AppError.forbidden('wallet is not linked to your account');
  }

  /** R18/R17 pre-checks. Returns issues (empty = ok) plus the deposit the commit will lock. */
  async precheck(seriesId: string, session: Session, input: z.infer<typeof precheckSchema>): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, input.bidder);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const issues: { code: string; message: string }[] = [];
    const auction = await chain.getAuction(seriesId);
    if (auction?.phase !== 'Open') issues.push({ code: 'phase', message: `auction is ${auction?.phase ?? 'not open'}` });
    if (!(await chain.isAllowlisted(input.bidder))) issues.push({ code: 'allowlist', message: 'wallet is not allowlisted' });
    const price = BigInt(input.pricePerUnit);
    const qty = BigInt(input.quantity);
    if (price < BigInt(s.terms.reservePrice)) issues.push({ code: 'reserve', message: `price is below the reserve ${s.terms.reservePrice}` });
    const cap = walletCapUnits(BigInt(s.terms.unitsOffered), BigInt(s.terms.walletCapBps));
    if (qty > cap) issues.push({ code: 'wallet-cap', message: `quantity exceeds the per-wallet cap of ${cap} units (${s.terms.walletCapBps} bps)` });
    if (qty <= 0n) issues.push({ code: 'quantity', message: 'quantity must be positive' });
    if (await chain.getBid(seriesId, input.bidder)) issues.push({ code: 'duplicate', message: 'this wallet already committed a bid' });
    const deposit = bidDeposit(price, qty, BigInt(s.terms.auctionFeeBps));
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

  async buildRefund(seriesId: string, session: Session, bidder: string): Promise<{ tx: UnsignedTx; refundable: string }> {
    const chain = this.ctx.chainFor(seriesId);
    await this.requireWallet(session, chain.chain, bidder);
    const bid = await chain.getBid(seriesId, bidder);
    if (!bid) throw AppError.notFound('bid');
    if (!bid.settled) throw AppError.conflict('auction not settled yet');
    const s = (await chain.getSeries(seriesId))!;
    const spent = bid.revealed && BigInt(bid.allocatedUnits) > 0n ? BigInt(bid.allocatedUnits) * BigInt(s.issuePrice ?? '0') : 0n;
    const fee = (spent * BigInt(s.terms.auctionFeeBps)) / 10_000n;
    const refundable = BigInt(bid.deposit) - spent - fee - BigInt(bid.refunded);
    if (refundable <= 0n) throw AppError.conflict('nothing to refund');
    return { tx: await chain.build({ kind: 'claimRefund', seriesId }, bidder), refundable: refundable.toString() };
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

  /** Offchain clearing preview from revealed bids (public once the reveal phase is over). */
  async preview(seriesId: string): Promise<Record<string, unknown>> {
    const chain = this.ctx.chainFor(seriesId);
    const s = await chain.getSeries(seriesId);
    if (!s) throw AppError.notFound('series');
    const a = (await chain.getAuction(seriesId))!;
    const now = await chain.now();
    const bids = await chain.listBids(seriesId);
    // settlement drops revealed bids whose bidder has since left the allowlist; the projection must do the same
    const allowed = await Promise.all(bids.map((b) => (b.revealed ? chain.isAllowlisted(b.bidder) : false)));
    const revealed = bids.filter((b, i) => b.revealed && allowed[i]).map((b) => ({ bidder: b.bidder, pricePerUnit: BigInt(b.revealed!.pricePerUnit), quantity: BigInt(b.revealed!.quantity), order: b.order }));
    const res = clearAuction({ bids: revealed, unitsOffered: BigInt(s.terms.unitsOffered), reservePrice: BigInt(s.terms.reservePrice), minimumRaise: BigInt(s.terms.minimumRaise), walletCapUnits: walletCapUnits(BigInt(s.terms.unitsOffered), BigInt(s.terms.walletCapBps)), auctionFeeBps: BigInt(s.terms.auctionFeeBps) });
    const settleDue = s.phase === 'Open' && a.revealEndsAt !== null && now >= a.revealEndsAt;
    return {
      seriesId, phase: s.phase, bidCount: a.bidCount, revealedCount: a.revealedCount, settleDue,
      projected: s.phase === 'Open' ? { success: res.success, reason: res.reason ?? null, clearingPrice: res.clearingPrice.toString(), unitsSold: res.unitsSold.toString(), proceeds: res.proceeds.toString(), totalFees: res.totalFees.toString(), allocations: res.allocations.map((x) => ({ bidder: x.bidder, units: x.units.toString() })) } : null,
      settled: s.phase === 'Settled' ? { clearingPrice: s.issuePrice, unitsSold: s.unitsSold } : null,
    };
  }

  /** Keeper entry: settle every auction whose reveal phase is over. Idempotent (the chain refuses a second settlement). */
  /**
   * Keeper entry: settle every auction whose reveal phase is over. Chains and series are independent (one failure
   * never stops the rest). The settled/failed notice is enqueued by the indexer from the finalized AuctionSettled /
   * AuctionFailed event, in the same transaction that projects it.
   */
  async settleDue(): Promise<{ settled: string[]; failed: string[] }> {
    const settled: string[] = [];
    const failed: string[] = [];
    for (const chain of this.ctx.chains.chains.values()) {
      try {
        const now = await chain.now();
        for (const s of await chain.listSeries()) {
          if (s.phase !== 'Open') continue;
          try {
            const a = await chain.getAuction(s.seriesId);
            if (!a?.revealEndsAt || now < a.revealEndsAt) continue;
            await chain.submit({ kind: 'settleAuction', seriesId: s.seriesId }, 'keeper');
            settled.push(s.seriesId);
          } catch (e) {
            failed.push(`${s.seriesId}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        failed.push(`${chain.chain}: ${(e as Error).message}`);
      }
    }
    return { settled, failed };
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
