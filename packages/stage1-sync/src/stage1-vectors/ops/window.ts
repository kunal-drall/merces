import { orderCommitment } from '@merces/domain';
import { hex32, periodIdOf } from '../codec.ts';
import { RunnerError } from '../errors.ts';
import { direct, type OpContext, type TranslatorTable } from './types.ts';

function current(ctx: OpContext, series: string) {
  const s = ctx.seriesState(series), w = s.transferWindows.at(-1);
  if (!w) throw new RunnerError(`${series}: no transfer window`);
  return { s, w };
}
/** The reference's aggregate finalize/process ops expand into the contracts' permissionless steps. */
export const windowOps: TranslatorTable = {
  open_window: (ctx, c) => direct(async () => {
    await ctx.submit({ kind: 'openWindow', seriesId: ctx.seriesBook(c.series).seriesId, periodId: periodIdOf(c.period) }, 'keeper');
  }),
  commit_ask: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series), wallet = ctx.actors.wallet(c.actor);
    const commitment = orderCommitment({ wallet: wallet.address, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
    await ctx.send(wallet, { kind: 'commitWindowOrder', seriesId: s.seriesId, windowId: w.windowId, side: 'sell', commitment, deposit: '0', units: c.units });
  }),
  window_commit_bid: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series), wallet = ctx.actors.wallet(c.actor);
    const commitment = orderCommitment({ wallet: wallet.address, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
    await ctx.send(wallet, { kind: 'commitWindowOrder', seriesId: s.seriesId, windowId: w.windowId, side: 'buy', commitment, deposit: c.escrow, units: '0' });
  }),
  reveal_order: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series), wallet = ctx.actors.wallet(c.actor);
    await ctx.send(wallet, { kind: 'revealWindowOrder', seriesId: s.seriesId, windowId: w.windowId, side: w.orders.get(wallet.address)?.side ?? 'buy', pricePerUnit: c.price, quantity: c.quantity, salt: hex32(c.salt, 'salt') });
  }),
  begin_window_settlement: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series);
    await ctx.submit({ kind: 'beginWindowSettlement', seriesId: s.seriesId, windowId: w.windowId, clearingPrice: c.clearingPrice === 'NO_MATCH' ? null : c.clearingPrice }, 'keeper');
  }),
  finalize_window: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series);
    const info = await ctx.chain.info();
    while (w.talliedCount < [...w.orders.values()].filter((o) => o.revealed).length) {
      await ctx.submit({ kind: 'tallyWindow', seriesId: s.seriesId, windowId: w.windowId, maxOrders: info.limits.tallyPageMax }, 'keeper');
    }
    await ctx.submit({ kind: 'finalizeWindow', seriesId: s.seriesId, windowId: w.windowId }, 'keeper');
  }),
  process_orders: (ctx, c) => direct(async () => {
    const { s, w } = current(ctx, c.series);
    const list = [...w.orders.values()].sort((a, b) => a.side === b.side ? a.revealIndex - b.revealIndex : a.side === 'buy' ? -1 : 1);
    for (const o of list) await ctx.submit({ kind: 'processOrder', seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet }, 'keeper');
    for (const o of list) await ctx.submit({ kind: 'deliverOrder', seriesId: s.seriesId, windowId: w.windowId, owner: o.wallet }, 'keeper');
  }),
};
