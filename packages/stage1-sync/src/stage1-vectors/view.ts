import { auctionEngineView, holdersView, ledgerView, mintFinalized, moneyView, pendingRefundOf, type SimSeries, type SimulatorChain } from '@merces/simulator';
import type { Actors } from './actors.ts';
import type { Book, SeriesBook } from './book.ts';
import { RunnerError } from './errors.ts';
import { auctionRules, revealedBids } from './ops/raise.ts';

/**
 * The merces backend's `expect` view (S1 plan §5.2, amendments M1/M2): Stage 1's snapshot shape (SIM:1760-1804)
 * built from our simulator, with the runner's bookkeeping where our one-step model has no counterpart.
 *
 * - `balances`: every name Stage 1 would list (the book's `seen`), `{stable, units}` where `units` is what Stage 1's
 *   account holds: the position less window-escrowed units and less units allocated but not yet delivered.
 * - `feeCollector`: the chain's fee collector balance.
 * - `ledger`: `ledgerView` (the simulator's Stage 1 ledger, status derived at `now`).
 * - `treasury`, `vault`, `auctionEscrow`, window escrows: `moneyView` (`auctionEscrow` = deposits, then unclaimed
 *   refunds; the auction view's `escrowTotal` is the same value).
 * - `auction`: the engine's counts, prices and `mintFinalized`; `validCount` by Stage 1's `isBidValid` over the
 *   revealed bids; rounds, tallies, minted and processed counts and escrowed units from the book (not parity).
 * - `holders`: registered holders with their stored `pending` and `redeemedUnits`; `pendingUnits`, `pendingRefund`
 *   (the engine's `refundable`, never Stage 1's `processBid`, which would apply the non-reveal charge) and
 *   `delivered` from the book.
 * - `window`: the book's phase and rounds with the engine's escrows and clearing price.
 */
export interface ViewSource {
  chain: SimulatorChain;
  actors: Actors;
  book: Book;
  mint: string;
}

const D = (v: bigint | number): string => v.toString();

function seriesOf(src: ViewSource, name: string): { s: SimSeries; b: SeriesBook } {
  const b = src.book.series[name];
  if (!b) throw new RunnerError(`unknown series ${name}`);
  const s = src.chain.state.series.get(b.seriesId);
  if (!s) throw new RunnerError(`series ${name} is missing from the chain state`);
  return { s, b };
}

/** Units allocated to a bidder that Stage 1 would hold in the auction escrow (processed, not delivered). */
function undelivered(src: ViewSource, s: SimSeries, b: SeriesBook, name: string): { units: bigint; refund: bigint } {
  if (!b.auction.processed.includes(name) || b.auction.delivered.includes(name)) return { units: 0n, refund: 0n };
  const address = src.actors.address(name);
  return { units: s.bids.get(address)?.allocatedUnits ?? 0n, refund: pendingRefundOf(s, address) };
}

/** What Stage 1's account of `name` holds of a series. */
export function accountUnits(src: ViewSource, s: SimSeries, b: SeriesBook, name: string): bigint {
  const p = s.positions.get(src.actors.address(name));
  if (!p) return 0n;
  return p.units - p.escrowed - undelivered(src, s, b, name).units;
}

export function stableOf(src: ViewSource, address: string): bigint {
  return src.chain.engine.balance(address, src.mint);
}

/** Σ allocated-but-undelivered units (Stage 1 `auction.escrowUnits`). */
function auctionEscrowUnits(src: ViewSource, s: SimSeries, b: SeriesBook): bigint {
  let total = 0n;
  for (const name of b.auction.processed) total += undelivered(src, s, b, name).units;
  return total;
}

function auctionView(src: ViewSource, s: SimSeries, b: SeriesBook): Record<string, unknown> {
  const e = auctionEngineView(s);
  const a = b.auction;
  return {
    bidCount: e.bidCount,
    revealedCount: e.revealedCount,
    validCount: D(revealedBids(s, auctionRules(s, b)).filter((x) => x.valid).length),
    escrowTotal: e.escrowTotal,
    auctionEscrowUnits: D(auctionEscrowUnits(src, s, b)),
    tallyRound: D(a.tallyRound),
    roundRejected: a.roundRejected,
    rejectionReason: a.rejectionReason,
    clearingPrice: e.clearingPrice,
    qAbove: a.qAbove,
    qAt: a.qAt,
    R: a.R,
    unitsSold: e.unitsSold,
    proceeds: e.proceeds,
    unitsMinted: a.unitsMinted,
    bidsProcessed: D(a.bidsProcessed),
    mintFinalized: e.mintFinalized,
  };
}

function holders(src: ViewSource, s: SimSeries, b: SeriesBook): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rows = Object.entries(holdersView(s)).map(([address, h]) => ({ name: src.actors.nameOf(address) ?? address, address, h }));
  rows.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const { name, address, h } of rows) {
    const pending = undelivered(src, s, b, name);
    out[name] = {
      pending: h.pending,
      redeemedUnits: h.redeemedUnits,
      pendingUnits: D(pending.units),
      pendingRefund: D(pending.refund),
      delivered: s.bids.has(address) ? b.auction.delivered.includes(name) : true,
    };
  }
  return out;
}

/** The `expect` snapshot of the merces backend for `seriesName` (or the global part when null). */
export function mercesSnapshot(src: ViewSource, seriesName: string | null, now: number): Record<string, unknown> {
  const out: Record<string, unknown> = { op: 'expect' };
  if (seriesName) out.series = seriesName;
  const target = seriesName ? seriesOf(src, seriesName) : null;
  const balances: Record<string, { stable: string; units?: string }> = {};
  for (const name of [...src.book.seen].sort()) {
    const entry: { stable: string; units?: string } = { stable: D(stableOf(src, src.actors.address(name))) };
    if (target) entry.units = D(accountUnits(src, target.s, target.b, name));
    balances[name] = entry;
  }
  out.balances = balances;
  out.feeCollector = D(stableOf(src, src.chain.state.feeCollector));
  if (target) {
    const { s, b } = target;
    const money = moneyView(s);
    out.treasury = money.treasury;
    out.vault = money.vault;
    out.auctionEscrow = money.auctionEscrow;
    if (b.window) {
      const ew = s.transferWindows[b.window.windowId];
      out.windowEscrowStable = money.windowEscrowStable ?? '0';
      out.windowEscrowUnits = money.windowEscrowUnits ?? '0';
      out.window = {
        period: D(b.window.period),
        state: b.window.state,
        tallyRound: D(b.window.tallyRound),
        roundRejected: b.window.roundRejected,
        clearingPrice: ew?.clearingPrice != null && b.window.state !== 'NoMatch' ? D(ew.clearingPrice) : null,
        branch: null,
        matchedUnits: b.window.matchedUnits,
        escrowStable: money.windowEscrowStable ?? '0',
        escrowUnits: money.windowEscrowUnits ?? '0',
      };
    }
    out.ledger = ledgerView(s, now);
    out.auction = auctionView(src, s, b);
    out.holders = holders(src, s, b);
  }
  return out;
}

/** Σ stablecoin over every account (the fee collector included) and every series pool. */
export function totalStable(src: ViewSource): bigint {
  let total = 0n;
  const suffix = `|${src.mint}`;
  for (const [k, v] of src.chain.state.balances) if (k.endsWith(suffix)) total += v;
  for (const s of src.chain.state.series.values()) {
    const m = moneyView(s);
    total += BigInt(m.treasury) + BigInt(m.vault) + BigInt(m.auctionEscrow) + BigInt(m.windowEscrowStable ?? '0');
  }
  return total;
}

/** Holder units + auction and window escrows = the supply (SIM:1833-1839); throws a RunnerError with public counts. */
export function checkUnitSupply(src: ViewSource, seriesName: string): void {
  const { s, b } = seriesOf(src, seriesName);
  let held = 0n;
  const pendingByAddress = new Map<string, bigint>();
  for (const name of b.auction.processed) pendingByAddress.set(src.actors.address(name), undelivered(src, s, b, name).units);
  for (const p of s.positions.values()) held += p.units - p.escrowed - (pendingByAddress.get(p.wallet) ?? 0n);
  const escrows = auctionEscrowUnits(src, s, b) + BigInt(moneyView(s).windowEscrowUnits ?? '0');
  const supply = mintFinalized(s) ? s.unitsOutstanding : BigInt(b.auction.unitsMinted);
  if (held + escrows !== supply) throw new RunnerError(`unit supply: holders and escrows hold ${held + escrows}, supply is ${supply}`);
}

/** The names Stage 1 lists in `balances` after this step: those seen before plus any now holding stablecoin or units. */
export function seenAfter(src: ViewSource): string[] {
  const seen = new Set(src.book.seen);
  for (const name of src.actors.all()) {
    if (seen.has(name)) continue;
    if (stableOf(src, src.actors.address(name)) > 0n) {
      seen.add(name);
      continue;
    }
    for (const b of Object.values(src.book.series)) {
      const s = src.chain.state.series.get(b.seriesId);
      if (s && accountUnits(src, s, b, name) !== 0n) {
        seen.add(name);
        break;
      }
    }
  }
  return [...seen].sort();
}
