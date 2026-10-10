import { auctionEngineView, balanceUnits, holdersView, ledgerView, mintFinalized, moneyView, type SimSeries, type SimulatorChain } from '@merces/simulator';
import type { Actors } from './actors.ts';
import type { Book, SeriesBook } from './book.ts';
import { RunnerError } from './errors.ts';

/**
 * The merces backend's `expect` view (S1 plan §5.2, amendments M1/M2): Stage 1's snapshot shape (SIM:1760-1804)
 * built from our simulator, with the runner's bookkeeping only where our one-step window has no counterpart (S5).
 *
 * - `balances`: every name Stage 1 would list (the book's `seen`), `{stable, units}` where `units` is what Stage 1's
 *   account holds (`balanceUnits`: the position less window-escrowed units and less auction units not yet delivered).
 * - `feeCollector`: the chain's fee collector balance.
 * - `ledger`: `ledgerView` (the simulator's Stage 1 ledger, status derived at `now`).
 * - `treasury`, `vault`, `auctionEscrow`, window escrows: `moneyView`.
 * - `auction`: the engine's Stage 1 auction record (`auctionEngineView`; S2: rounds, tallies, results, processing and
 *   the mint gate are the engine's own).
 * - `holders`: registered holders with their stored `pending` and `redeemedUnits` and their bid's `pendingUnits`,
 *   `pendingRefund` and `delivered`, all from the engine (`holdersView`).
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

/** What Stage 1's account of `name` holds of a series (`unitsOf`). */
export function accountUnits(src: ViewSource, s: SimSeries, name: string): bigint {
  return balanceUnits(s, src.actors.address(name));
}

export function stableOf(src: ViewSource, address: string): bigint {
  return src.chain.engine.balance(address, src.mint);
}

/** Registered holders by vector name, in Stage 1's order (names sorted), from the engine. */
function holders(src: ViewSource, s: SimSeries): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const rows = Object.entries(holdersView(s)).map(([address, h]) => ({ name: src.actors.nameOf(address) ?? address, h }));
  rows.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const { name, h } of rows) out[name] = h;
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
    if (target) entry.units = D(accountUnits(src, target.s, name));
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
    out.auction = auctionEngineView(s);
    out.holders = holders(src, s);
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

/**
 * Holder units + auction and window escrows = the supply (SIM:1833-1839): the units every account holds, the auction's
 * undelivered units and the window's escrowed units, against the units outstanding once the mint is final (the units
 * minted so far before). Throws a RunnerError with public counts.
 */
export function checkUnitSupply(src: ViewSource, seriesName: string): void {
  const { s } = seriesOf(src, seriesName);
  let held = 0n;
  for (const p of s.positions.values()) held += balanceUnits(s, p.wallet);
  const escrows = s.auction.escrowUnits + BigInt(moneyView(s).windowEscrowUnits ?? '0');
  const supply = mintFinalized(s) ? s.unitsOutstanding : s.auction.unitsMinted;
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
      if (s && accountUnits(src, s, name) !== 0n) {
        seen.add(name);
        break;
      }
    }
  }
  return [...seen].sort();
}
