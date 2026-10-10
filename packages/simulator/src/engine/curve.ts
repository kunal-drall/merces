import { ChainError, type Command } from '@merces/domain';
import { WAD, bpsOf, capPerUnit, mulDiv } from '@merces/math';
import type { SimSeries } from '../state.ts';
import { TERMINAL, big, str, type EngineCore, type Emit } from './core.ts';
import { position, registerHolder, setUnits } from './holders.ts';
import { pidAtTime } from './ledger.ts';

// ------------------------------------------------------------------ curve mode (Solana only; toy linear curve)
export function buyCurve(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'buyCurve' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = s.curve;
  if (!c) throw new ChainError('WrongPhase', 'not a curve-mode series');
  if (c.graduated) throw new ChainError('WrongPhase', 'curve graduated; trade on the DEX');
  if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', `cannot buy while ${s.status}`);
  if (s.phase === 'Cancelled' || s.phase === 'Failed') throw new ChainError('WrongPhase', `raise is ${s.phase}`);
  // pre-graduation units are sealed-style holdings: only approved wallets may mint them (C10)
  e.requireAllowlisted(signer);
  const amountIn = big(cmd.amountIn);
  if (amountIn <= 0n) throw new ChainError('InvalidTerms', 'amountIn must be positive');
  // Stage 1's mulDiv (sdk), on non-negative inputs: the base price is the reserve price, the slope a constant
  const spot = c.basePrice + mulDiv(c.basePrice, c.slopeWad * s.unitsOutstanding, WAD);
  const units = amountIn / spot;
  if (units < big(cmd.minUnitsOut) || units === 0n) throw new ChainError('InvalidTerms', 'slippage: fewer units than minUnitsOut');
  // no cap (owner; S3 WP7): a curve raise has no wallet cap at any stage, as Stage 1 stores 0 and enforces none
  // (CURVE_NO_CAP); a wallet buys and holds any number of units
  e.debit(signer, s.terms.stablecoinMint, amountIn);
  c.raised += amountIn;
  s.treasuryTotal += amountIn;
  const p = position(s, signer);
  setUnits(s, p, p.units + units);
  s.unitsOutstanding += units;
  s.unitsSold += units;
  emit('UnitsMinted', { seriesId: s.seriesId, holder: signer, units: str(units) });
  emit('TreasuryFunded', { seriesId: s.seriesId, amount: str(amountIn) });
  if (c.raised >= c.graduationThreshold) graduate(s, now, emit);
}
export function graduate(s: SimSeries, now: number, emit: Emit): void {
  const c = s.curve!;
  c.graduated = true;
  s.phase = 'Settled';
  s.settledAt = now;
  s.auction.mintFinalized = true; // the curve's units are minted as bought: graduation opens the money paths
  s.ledger.firstPeriod = pidAtTime(now);
  // every curve buyer becomes a registered holder at graduation, as Stage 1 registers allocated bidders at settlement
  for (const p of s.positions.values()) if (p.units > 0n) registerHolder(s, p);
  s.issuePrice = s.unitsSold > 0n ? c.raised / s.unitsSold : c.basePrice;
  s.capPerUnit = capPerUnit(s.terms.capMultipleWad, s.issuePrice);
  let allocated = 0n;
  s.tranches = s.terms.releaseSchedule.map((t, i, arr) => {
    const amount = i === arr.length - 1 ? s.treasuryTotal - allocated : bpsOf(s.treasuryTotal, BigInt(t.bps));
    allocated += amount;
    return { index: i, afterSeconds: t.afterSeconds, bps: t.bps, amount, drawn: false, returned: false };
  });
  emit('CurveGraduated', { seriesId: s.seriesId, raised: str(c.raised), unitsOutstanding: str(s.unitsOutstanding), issuePrice: str(s.issuePrice) });
}
export function graduateCurve(e: EngineCore, cmd: Extract<Command, { kind: 'graduateCurve' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  if (!s.curve || s.curve.graduated) throw new ChainError('WrongPhase', 'not graduatable');
  if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', `cannot graduate while ${s.status}`);
  if (s.phase === 'Cancelled' || s.phase === 'Failed') throw new ChainError('WrongPhase', `raise is ${s.phase}`);
  if (s.curve.raised < s.curve.graduationThreshold) throw new ChainError('TooEarly', 'threshold not reached');
  graduate(s, e.clock.now(), emit);
}
