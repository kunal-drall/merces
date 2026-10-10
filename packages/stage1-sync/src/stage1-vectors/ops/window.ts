import { orderCommitment } from '@merces/domain';
import { ledgerView } from '@merces/simulator';
import { RunnerError } from '../errors.ts';
import { hex32, num } from '../codec.ts';
import type { WindowBook } from '../book.ts';
import { blocked, eventOf, shim, type OpContext, type TranslatorTable } from './types.ts';

/**
 * Transfer windows on our one-step clearing (shims SH-WIN-1..7, SH-FLG-1; S1 plan §5.3). Stage 1 opens a window,
 * takes commits and reveals, then proposes a price (`begin_window_settlement`), tallies and finalizes
 * (`finalize_window`) and delivers (`process_orders`); the canonical `clearTransferWindow` clears and delivers in one
 * step. In S1 the runner supports the windows the target vectors run: those Stage 1 settles as NO_MATCH, or forces to
 * NoMatch because the series is terminal (SIM:1575-1581). A priced proposal on a live series is BLOCKED (S5 brings
 * multi-step windows).
 */
const TERMINAL = new Set(['Retired', 'Redeemed', 'Extinguished']);

function windowBook(ctx: OpContext, series: string): WindowBook {
  const w = ctx.seriesBook(series).window;
  if (!w) throw new RunnerError(`${series}: no transfer window is open`);
  return w;
}

function terminal(ctx: OpContext, series: string): boolean {
  return TERMINAL.has(ledgerView(ctx.seriesState(series), ctx.now()).status);
}

export const windowOps: TranslatorTable = {
  open_window: (ctx, c) => {
    if (!ctx.book.windowsEnabled) return blocked('SH-FLG-1', 'windows are disabled by config.flags; the canonical model has no windows flag to refuse with');
    return shim('SH-WIN-1', async () => {
      const b = ctx.seriesBook(c.series);
      const commitEndsAt = ctx.now() + b.terms.windowCommitDuration;
      const r = await ctx.submit({ kind: 'openTransferWindow', seriesId: b.seriesId, commitEndsAt, revealEndsAt: commitEndsAt + b.terms.windowRevealDuration }, 'keeper');
      const opened = eventOf<{ windowId: number }>(r, 'TransferWindowOpened');
      if (!opened) throw new RunnerError(`open_window ${c.series}: no TransferWindowOpened event`);
      ctx.seriesBook(c.series).window = { windowId: opened.windowId, period: num(c.period, 'period'), state: 'Commit', tallyRound: 0, roundRejected: false, proposal: null, matchedUnits: '0' };
    });
  },

  commit_ask: (ctx, c) =>
    shim('SH-WIN-2', async () => {
      const b = ctx.seriesBook(c.series);
      const w = windowBook(ctx, c.series);
      const wallet = ctx.actors.wallet(c.actor);
      const commitment = orderCommitment({ wallet: wallet.address, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
      await ctx.send(wallet, { kind: 'commitWindowOrder', seriesId: b.seriesId, windowId: w.windowId, side: 'sell', commitment, deposit: '0', units: c.units });
    }),

  window_commit_bid: (ctx, c) =>
    shim('SH-WIN-3', async () => {
      const b = ctx.seriesBook(c.series);
      const w = windowBook(ctx, c.series);
      const wallet = ctx.actors.wallet(c.actor);
      const commitment = orderCommitment({ wallet: wallet.address, pricePerUnit: BigInt(c.price), quantity: BigInt(c.quantity), salt: hex32(c.salt, 'salt') });
      await ctx.send(wallet, { kind: 'commitWindowOrder', seriesId: b.seriesId, windowId: w.windowId, side: 'buy', commitment, deposit: c.escrow, units: '0' });
    }),

  reveal_order: (ctx, c) =>
    shim('SH-WIN-4', async () => {
      const b = ctx.seriesBook(c.series);
      const w = windowBook(ctx, c.series);
      const wallet = ctx.actors.wallet(c.actor);
      const order = ctx.seriesState(c.series).transferWindows[w.windowId]?.orders.get(wallet.address);
      await ctx.send(wallet, { kind: 'revealWindowOrder', seriesId: b.seriesId, windowId: w.windowId, side: order?.side ?? 'buy', pricePerUnit: c.price, quantity: c.quantity, salt: hex32(c.salt, 'salt') });
      const after = windowBook(ctx, c.series);
      if (after.state === 'Commit') after.state = 'Reveal';
    }),

  begin_window_settlement: (ctx, c) => {
    if (c.clearingPrice !== 'NO_MATCH' && !terminal(ctx, c.series)) {
      return blocked('SH-WIN-5', 'a priced window proposal on a live series needs multi-step windows (S5)');
    }
    return shim('SH-WIN-5', async () => {
      const w = windowBook(ctx, c.series);
      if (w.state !== 'Commit' && w.state !== 'Reveal' && w.state !== 'Settling') throw new RunnerError(`begin_window_settlement ${c.series}: the window is ${w.state}`);
      w.tallyRound += 1;
      w.roundRejected = false;
      w.proposal = c.clearingPrice;
      w.state = 'Settling';
    });
  },

  finalize_window: (ctx, c) =>
    shim('SH-WIN-6', async () => {
      const b = ctx.seriesBook(c.series);
      const w0 = windowBook(ctx, c.series);
      if (w0.state !== 'Settling') throw new RunnerError(`finalize_window ${c.series}: no settlement round (the window is ${w0.state})`);
      const wasTerminal = terminal(ctx, c.series);
      const r = await ctx.submit({ kind: 'clearTransferWindow', seriesId: b.seriesId, windowId: w0.windowId }, 'keeper');
      const cleared = eventOf<{ unitsTransferred: string }>(r, 'TransferWindowCleared');
      const transferred = BigInt(cleared?.unitsTransferred ?? '0');
      if (transferred > 0n && (wasTerminal || w0.proposal === 'NO_MATCH')) {
        throw new RunnerError(`finalize_window ${c.series}: clearTransferWindow moved ${transferred} units where Stage 1 settles NoMatch`);
      }
      const w = windowBook(ctx, c.series);
      w.state = transferred > 0n ? 'Settled' : 'NoMatch';
      w.matchedUnits = transferred.toString();
    }),

  process_orders: (ctx, c) =>
    shim('SH-WIN-7', async () => {
      const w = windowBook(ctx, c.series);
      if (w.state !== 'NoMatch' && w.state !== 'Settled') throw new RunnerError(`process_orders ${c.series}: the window is ${w.state}`);
      w.state = 'Done';
    }),
};
