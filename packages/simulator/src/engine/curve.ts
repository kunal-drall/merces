import { ChainError, type Command } from '@merces/domain';
import { CURVE_BASE_DECIMALS, CURVE_UNIT_SCALE, capPerUnit, migrationFeeSplit, mulDiv, mulDivCeil, p0PerUnit, unitsOutstanding } from '@merces/math';
import { deriveAddress } from '../addresses.ts';
import type { SimCurve, SimSeries } from '../state.ts';
import { TERMINAL, balKey, str, u64, type EngineCore, type Emit } from './core.ts';
import { fail, guardStage1 } from './errors.ts';
import { pidAtTime } from './ledger.ts';
import { splitTranches } from './treasury.ts';

/**
 * Curve mode on Stage 1 (SPEC §9; Solana `merces_protocol` curve.rs, merces-common curve.rs; S3 WP8), Solana only.
 *
 * Merces' side is Stage 1's: activation (folded into `createSeries`: P0 fixed from X and the swap base, the raise Open),
 * `completeCurve` (settles at the pool's finish time with the P0 and units fixed at activation; no census, no
 * registration), `collectCurveProceeds` (the partner migration fee and surplus into the treasury, the partner trading
 * fee to the fee collector) and `syncCurveUnits`, the census (S3 WP9: units outstanding = supply − protocol-held, the
 * vault's N, the stake bound and the report's public input; `redeem` takes its own without the DAMM pool). The venue is not: Meteora's Dynamic Bonding Curve runs outside Merces and its source is not
 * in the checkout, so `curveSwap` trades against a **labelled stand-in** (`SimCurve.venue`) until S5 brings Stage 1's
 * DBC math through the Meteora port:
 *  - it sells the swap base at the constant price P0, exactly X per swap base (P0 before Stage 1 floors it), so the
 *    curve fills when its base is sold and its quote reserve reaches X;
 *  - every trade pays Stage 1's generated config's trading fee: `ceil(amount × 1%)`, Meteora's 20% of it
 *    (`floor(fee × 20 / 100)`) and the partner's the rest (PROCEEDS_OPTIONS.md R4); a buy pays it on its input, a sell
 *    on its output;
 *  - the buy that reaches X fills partially: it takes the rest of the swap base and is charged only the smallest input
 *    whose fee-free part is the quote still missing (ours: DBC's PartialFill), and the pool records its finish time;
 *  - selling back is open until the curve fills; no allowlist and no cap at any stage, and no Merces event;
 *  - the unit mint's fixed supply sits in the pool's base vault from activation (Stage 1's generated config: the swap
 *    base, the migration base, the issuer's locked allocation and the leftover, `curve_config.json` `expected`); the
 *    migration, a locker release and a DAMM trade are harness hooks that only move base lamports between accounts, as
 *    Stage 1's census test mocks them (curve_mode.rs:708-766).
 * Every money amount is Stage 1's arithmetic (`p0PerUnit`, `migrationFeeSplit`, `capPerUnit`, `trancheAmounts`); the
 * stand-in's own figures (the price path, the PartialFill charge) are labelled as ours.
 */

/** The stand-in pool's settings: Stage 1's generated DBC config (`solana/tests/fixtures/meteora/curve_config.json`). */
export const STAND_IN_POOL = {
  /** `tradingFeeBps` 100: 1% on every trade */
  tradingFeeBps: 100n,
  /** Meteora's share of every trading fee (DBC constants.rs:94; PROCEEDS_OPTIONS.md R4) */
  protocolFeePercent: 20n,
  /**
   * the creator's (issuer's) share of what Meteora leaves, percent: 0, as Stage 1's config generator sets it
   * (`creatorTradingFeePercentage: 0`); the partner (Merces) takes the rest. The stand-in models no creator share
   */
  creatorTradingFeePercent: 0n,
  /** `migrationFeePercentage` 99 and `creatorMigrationFeePercentage` 0 (the issuer creates the pool: Stage 1 requires 0) */
  migrationFeePercentage: 99,
  creatorMigrationFeePercentage: 0,
  /** the partner's and creator's part of a surplus above X, percent (DBC virtual_pool.rs:1130-1166; PROCEEDS_OPTIONS.md R3) */
  surplusSharePercent: 80n,
  /**
   * The fixture's base supply around its swap base (`expected`: swap base 100,000,000, migration base 363,637, locked
   * vesting 10,000,000, `initialBaseSupply` 110,363,638, so a leftover of 1). Another swap base gets the same proportions
   * (the migration base rounded up, the vesting down) and a leftover of 1: Stage 1's generator fixes them from its
   * oracle-driven curve, which the stand-in does not run.
   */
  fixtureSwapBase: 100_000_000n,
  fixtureMigrationBase: 363_637n,
  fixtureLockedVesting: 10_000_000n,
  leftover: 1n,
} as const;

/** A curve series' curve (NotCurveMode for a sealed-bid series). */
export function curveOf(s: SimSeries): SimCurve {
  if (!s.curve) fail('NotCurveMode', 'not a curve-mode series');
  return s.curve;
}

/** The pool reached its target (DBC `quote_reserve ≥ migration_quote_threshold`): no more trades on the curve. */
export function poolComplete(c: SimCurve): boolean {
  return c.quoteReserve >= c.migrationQuoteThreshold;
}

// ------------------------------------------------------------------ activation
/**
 * Stage 1 `activate_curve`'s price (curve.rs:799-805): `P0 = p0_per_unit(X, swap base, 6)` on the terms' minimum raise
 * (X) and `unitsOffered × 10^6` (the swap base), which must be at least 1 (CurveThresholdMismatch). Checked before the
 * series exists.
 */
export function curveP0(s: { terms: { minimumRaise: bigint; unitsOffered: bigint } }): { p0: bigint; swapBase: bigint } {
  const swapBase = s.terms.unitsOffered * CURVE_UNIT_SCALE;
  const p0 = guardStage1(() => p0PerUnit(s.terms.minimumRaise, swapBase, CURVE_BASE_DECIMALS), 'AmountOutOfRange');
  if (p0 < 1n) fail('CurveThresholdMismatch', 'the curve price P0 = X × 10^6 / swap base is below 1');
  return { p0, swapBase };
}

/**
 * The curve's activation, folded into `createSeries` (Stage 1 `activate_curve` + the registry's `mark_curve_activated`,
 * curve.rs:691-832, registry lib.rs:990-1043; the caller checked P0, the new-raises pause and the issuer's allowlist
 * first). The stand-in pool is created with the issuer as its creator and the unit mint's whole supply in its base vault;
 * the series stores the swap base as its units sold and P0 as its price (Stage 1 `units_sold`, `clearing_price`), its
 * unit scale is 10^6 and its raise is Open. Emits `CurveActivated`, then `RaiseOpened{0, 0}` (curve.rs:824-830).
 */
export function activateCurve(e: EngineCore, s: SimSeries, p0: bigint, swapBase: bigint, now: number, emit: Emit): void {
  const family = e.state.config.family;
  const at = (label: string): string => deriveAddress(family, `curve:${s.address}:${label}`);
  const P = STAND_IN_POOL;
  const migrationBase = mulDivCeil(swapBase, P.fixtureMigrationBase, P.fixtureSwapBase);
  const lockedVesting = mulDiv(swapBase, P.fixtureLockedVesting, P.fixtureSwapBase);
  const supply = swapBase + migrationBase + lockedVesting + P.leftover;
  const c: SimCurve = {
    venue: 'simulator-stand-in', quoteStablecoin: 'USDC', dbcConfig: at('dbc-config'), dbcPool: at('dbc-pool'), dbcCreator: s.issuer, baseMint: at('base-mint'),
    accounts: { dbcBaseVault: at('dbc-base-vault'), dammBaseVault: at('damm-base-vault'), lockerEscrow: at('locker-escrow'), leftoverReceiver: at('curve-authority'), stakeVault: at('stake-vault') },
    migrationQuoteThreshold: s.terms.minimumRaise, swapBaseAmount: swapBase, migrationBaseAmount: migrationBase, lockedVestingAmount: lockedVesting, leftoverAmount: P.leftover, supply, p0,
    tradingFeeBps: P.tradingFeeBps, protocolFeePercent: P.protocolFeePercent, migrationFeePercentage: P.migrationFeePercentage, creatorMigrationFeePercentage: P.creatorMigrationFeePercentage,
    quoteReserve: 0n, protocolQuoteFee: 0n, partnerQuoteFee: 0n, baseSold: 0n, finishTs: null, migrationFeeWithdrawn: false, surplusWithdrawn: false, migrated: false,
    collected: { migrationFee: 0n, surplus: 0n, tradingFee: 0n },
  };
  s.curve = c;
  e.credit(c.accounts.dbcBaseVault, c.baseMint, supply);
  s.unitScale = CURVE_UNIT_SCALE;
  s.unitsSold = swapBase;
  s.issuePrice = p0;
  s.phase = 'Open';
  s.openedAt = now;
  emit('CurveActivated', { seriesId: s.seriesId, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, baseMint: c.baseMint, dbcCreator: c.dbcCreator, unitsSold: str(swapBase), issuePrice: str(p0) });
  emit('RaiseOpened', { seriesId: s.seriesId, commitEndsAt: 0, revealEndsAt: 0 });
}

// ------------------------------------------------------------------ the stand-in venue
/** What a stand-in trade does, before anything moves. */
export interface CurveSwapOutcome {
  /** what the trade takes of `amountIn` (a buy that fills the curve takes less) */
  used: bigint;
  /** base lamports out (buy) or stablecoin out after the fee (sell) */
  out: bigint;
  /** the trading fee, and its split: Meteora's share and the partner's */
  fee: bigint;
  protocolFee: bigint;
  partnerFee: bigint;
  /** quote into the pool's reserve (buy) or out of it (sell, the fee included) */
  reserveDelta: bigint;
  fillsCurve: boolean;
}

/**
 * A stand-in trade on the pool's current state (moves nothing; `quoteCurveSwap` reads it). A filled pool refuses every
 * trade (WrongPhase: Meteora's `PoolIsCompleted`, no Stage 1 name); `amountIn` must be a positive u64 and move
 * something (InvalidTerms); a sell cannot return more base than the curve sold (InvalidTerms).
 */
export function curveSwapOutcome(c: SimCurve, side: 'buy' | 'sell', amountInText: string): CurveSwapOutcome {
  if (poolComplete(c)) throw new ChainError('WrongPhase', 'the curve has filled: no more trades on the curve (Meteora PoolIsCompleted)');
  const amountIn = u64(amountInText);
  if (amountIn === 0n) throw new ChainError('InvalidTerms', 'amountIn must be above 0');
  const X = c.migrationQuoteThreshold;
  const S = c.swapBaseAmount;
  const split = (fee: bigint) => {
    const protocolFee = mulDiv(fee, c.protocolFeePercent, 100n);
    return { protocolFee, partnerFee: fee - protocolFee };
  };
  let o: CurveSwapOutcome;
  if (side === 'buy') {
    const missing = X - c.quoteReserve;
    const fee = mulDivCeil(amountIn, c.tradingFeeBps, 10_000n);
    if (amountIn - fee >= missing) {
      // the PartialFill (ours): the smallest input whose fee-free part is the quote still missing; the rest is never taken
      const used = mulDivCeil(missing, 10_000n, 10_000n - c.tradingFeeBps);
      const fillFee = used - missing;
      o = { used, out: S - c.baseSold, fee: fillFee, ...split(fillFee), reserveDelta: missing, fillsCurve: true };
    } else {
      const net = amountIn - fee;
      o = { used: amountIn, out: mulDiv(net, S, X), fee, ...split(fee), reserveDelta: net, fillsCurve: false };
    }
  } else {
    if (amountIn > c.baseSold) throw new ChainError('InvalidTerms', 'cannot sell more units than the curve sold');
    const gross = mulDiv(amountIn, X, S);
    const fee = mulDivCeil(gross, c.tradingFeeBps, 10_000n);
    if (gross > c.quoteReserve) throw new ChainError('ChainSpecific', 'curve reserve invariant violated'); // never happens: every buy rounds down
    o = { used: amountIn, out: gross - fee, fee, ...split(fee), reserveDelta: gross, fillsCurve: false };
  }
  if (o.out === 0n) throw new ChainError('InvalidTerms', 'the trade is too small to move anything');
  return o;
}

/**
 * A trade on the curve (`curveSwap`): NotCurveMode, then the stand-in's checks (`curveSwapOutcome`), the slippage bound
 * (InvalidTerms when fewer than `minimumAmountOut` come out) and the trader's balance (InsufficientFunds; Meteora's own
 * error, no Stage 1 name). A buy takes the stablecoin used into the pool and pays base lamports out of its base vault;
 * a sell takes base lamports back into the vault and pays the stablecoin out of the reserve. The fee splits between
 * Meteora's bucket and the partner's. The buy that fills the curve records the pool's finish time (now). No allowlist,
 * no cap and no Merces event: the treasury receives nothing until `collectCurveProceeds`.
 */
export function curveSwap(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'curveSwap' }>, now: number, _emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  const o = curveSwapOutcome(c, cmd.side, cmd.amountIn);
  if (o.out < u64(cmd.minimumAmountOut)) throw new ChainError('InvalidTerms', 'slippage: less than minimumAmountOut would come out');
  const quoteMint = s.terms.stablecoinMint;
  const [payMint, getMint] = cmd.side === 'buy' ? [quoteMint, c.baseMint] : [c.baseMint, quoteMint];
  if (balanceOf(e, signer, payMint) < o.used) throw new ChainError('InsufficientFunds', 'the wallet cannot pay for this trade');
  e.debit(signer, payMint, o.used);
  if (cmd.side === 'buy') {
    c.quoteReserve += o.reserveDelta;
    c.baseSold += o.out;
    e.debit(c.accounts.dbcBaseVault, c.baseMint, o.out);
    e.credit(signer, getMint, o.out);
    if (o.fillsCurve) c.finishTs = now;
  } else {
    c.quoteReserve -= o.reserveDelta;
    c.baseSold -= o.used;
    e.credit(c.accounts.dbcBaseVault, c.baseMint, o.used);
    e.credit(signer, getMint, o.out);
  }
  c.protocolQuoteFee += o.protocolFee;
  c.partnerQuoteFee += o.partnerFee;
}

function balanceOf(e: EngineCore, wallet: string, mint: string): bigint {
  return e.state.balances.get(balKey(wallet, mint)) ?? 0n;
}

// ------------------------------------------------------------------ completion
/**
 * Stage 1 `complete_curve` (curve.rs:861-906), permissionless: NotCurveMode, RaiseNotOpen (the raise is Open), then
 * CurveNotComplete unless the pool filled (`quote_reserve ≥ X` and a finish time). The raise settles at the pool's
 * finish time, not now, with the P0 and units sold fixed at activation: the first reporting period follows from it, the
 * cap per unit is Stage 1's `capPerUnit(capMultipleWad, P0)`, and the mint is final at once. It takes no census (units
 * outstanding stay 0 until the curve's census) and registers nobody (a holder registers itself, allowlisted).
 * Events: `CurveGraduated` (Stage 1 `RaiseSettled`, proceeds 0) and `RaiseMintFinalized{unitsSold, proceeds: 0}`.
 */
export function completeCurve(e: EngineCore, cmd: Extract<Command, { kind: 'completeCurve' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  if (s.phase !== 'Open') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (!poolComplete(c) || c.finishTs === null) fail('CurveNotComplete', 'the curve has not filled');
  const settledAt = c.finishTs;
  s.phase = 'Settled';
  s.settledAt = settledAt;
  s.ledger.firstPeriod = pidAtTime(settledAt);
  s.capPerUnit = capPerUnit(s.terms.capMultipleWad, c.p0);
  s.auction.mintFinalized = true;
  emit('CurveGraduated', { seriesId: s.seriesId, issuePrice: str(c.p0), unitsSold: str(s.unitsSold), settledAt });
  emit('RaiseMintFinalized', { seriesId: s.seriesId, unitsSold: str(s.unitsSold), proceeds: '0' });
}

// ------------------------------------------------------------------ proceeds
/**
 * Stage 1 `collect_curve_proceeds` (curve.rs:1112-1214), permissionless and idempotent: NotCurveMode, RaiseNotOpen
 * (Open or Settled). Once the pool filled, the partner's migration fee (`migrationFeeSplit(X, 99, 0)`, once) and the
 * partner's surplus above X (80% of it, once; the stand-in fills exactly at X, so it is 0 there) move into the series
 * treasury; at any time the partner's accrued trading fee moves to the fee collector. The treasury's proceeds grow by
 * what arrived; the first collection that brings proceeds splits them into the release tranches (Stage 1's
 * `trancheAmounts`, vesting from the settlement time), and no later one can bring more (an invariant: DBC pays each
 * once). The issuer is the pool's creator, so no creator share is collected here.
 * Events: `CurveProceedsCollected{migrationFee, surplus, tradingFee, proceeds}`, then `TreasuryFunded` and
 * `FeeTaken{curveTrading}` when they are above 0.
 */
export function collectCurveProceeds(e: EngineCore, cmd: Extract<Command, { kind: 'collectCurveProceeds' }>, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  const c = curveOf(s);
  if (s.phase !== 'Open' && s.phase !== 'Settled') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  let migrationFee = 0n;
  let surplus = 0n;
  if (poolComplete(c)) {
    const { partner } = guardStage1(() => migrationFeeSplit(c.migrationQuoteThreshold, c.migrationFeePercentage, c.creatorMigrationFeePercentage), 'AmountOutOfRange');
    if (partner > 0n && !c.migrationFeeWithdrawn) {
      c.migrationFeeWithdrawn = true;
      migrationFee = partner;
    }
    if (c.quoteReserve > c.migrationQuoteThreshold && !c.surplusWithdrawn) {
      c.surplusWithdrawn = true;
      surplus = mulDiv(c.quoteReserve - c.migrationQuoteThreshold, STAND_IN_POOL.surplusSharePercent, 100n);
    }
  }
  const tradingFee = c.partnerQuoteFee;
  c.partnerQuoteFee = 0n;
  const received = migrationFee + surplus;
  if (received > 0n) {
    if (s.tranches.length > 0) throw new ChainError('ChainSpecific', 'curve proceeds arrived twice'); // never happens: DBC pays each once
    s.treasuryTotal += received;
    s.tranches = splitTranches(s);
  }
  if (tradingFee > 0n) e.credit(e.state.feeCollector, s.terms.stablecoinMint, tradingFee);
  c.collected.migrationFee += migrationFee;
  c.collected.surplus += surplus;
  c.collected.tradingFee += tradingFee;
  const { seriesId } = s;
  emit('CurveProceedsCollected', { seriesId, migrationFee: str(migrationFee), surplus: str(surplus), tradingFee: str(tradingFee), proceeds: str(s.treasuryTotal) });
  if (received > 0n) emit('TreasuryFunded', { seriesId, amount: str(received) });
  if (tradingFee > 0n) emit('FeeTaken', { seriesId, kind: 'curveTrading', amount: str(tradingFee), payer: c.dbcPool });
}

// ------------------------------------------------------------------ the census
/** A census (Stage 1 `CurveUnits`): the unit mint's supply, the base lamports protocol accounts hold, and the rest. */
export interface CurveCensusCount {
  supply: bigint;
  protocolHeld: bigint;
  outstanding: bigint;
}

/**
 * The base lamports in the protocol-held accounts, in Stage 1's order (`compute_curve_units`, curve.rs:470-475): the DBC
 * pool's base vault, the DAMM v2 pool's base vault (0 when `excludeDamm`), the locker escrow and the leftover receiver.
 * The stake vault is not among them: staked units are the holders'.
 */
function protocolHeldBalances(e: EngineCore, c: SimCurve, excludeDamm: boolean): bigint[] {
  const a = c.accounts;
  const bal = (account: string) => balanceOf(e, account, c.baseMint);
  return [bal(a.dbcBaseVault), excludeDamm ? 0n : bal(a.dammBaseVault), bal(a.lockerEscrow), bal(a.leftoverReceiver)];
}

/**
 * The census as Stage 1 counts it (`compute_curve_units`, curve.rs:350-490; merces-common `units_outstanding`, ported):
 * `supply − (DBC base vault + DAMM v2 base vault + locker escrow + leftover)`. Holdings past the supply or a sum past
 * u64 are CurveUnitsInconsistent; a count below the stakes is CurveUnitsBelowStake. `excludeDamm` leaves the DAMM v2
 * pool's base vault out of the subtraction, as `redeem` does (S2, B-C13): the count then covers wallets, stakes and the
 * pool, an upper bound on what holders can tender that the issuer cannot lower by parking units in the pool. Moves
 * nothing. The stand-in's supply (`SimCurve.supply`) is fixed until a redemption: only tenders burn base lamports
 * (`tenderUnits`), and no census is taken after a redemption.
 */
export function takeCensus(e: EngineCore, s: SimSeries, excludeDamm: boolean): CurveCensusCount {
  const c = curveOf(s);
  const held = protocolHeldBalances(e, c, excludeDamm);
  let outstanding: bigint;
  try {
    outstanding = unitsOutstanding(c.supply, held);
  } catch {
    return fail('CurveUnitsInconsistent', 'the protocol-held units exceed the unit supply');
  }
  if (outstanding < s.stakedTotal) fail('CurveUnitsBelowStake', 'the census would fall below the staked units');
  return { supply: c.supply, protocolHeld: c.supply - outstanding, outstanding };
}

/**
 * Stores a census (Stage 1 `store_curve_units`, curve.rs:492-508): the series' units outstanding and the census time;
 * emits `CurveUnitsSynced` with the stakes at that moment.
 */
export function storeCensus(s: SimSeries, u: CurveCensusCount, now: number, emit: Emit): void {
  s.unitsOutstanding = u.outstanding;
  s.unitsSyncedAt = now;
  emit('CurveUnitsSynced', { seriesId: s.seriesId, supply: str(u.supply), protocolHeld: str(u.protocolHeld), unitsOutstanding: str(u.outstanding), stakedTotal: str(s.stakedTotal) });
}

/**
 * Stage 1 `sync_curve_units` (curve.rs:936-963), permissionless: NotCurveMode, RaiseNotOpen (the raise is Open or
 * Settled: a census may be taken while the curve sells), TerminalStatus (the stored status is Retired, Redeemed or
 * Extinguished), then the census (`takeCensus`, the DAMM v2 pool counted: it is not held by holders, and the per-unit
 * income math is invariant to it) is stored. Emits `CurveUnitsSynced`.
 */
export function syncCurveUnits(e: EngineCore, cmd: Extract<Command, { kind: 'syncCurveUnits' }>, now: number, emit: Emit): void {
  const s = e.series(cmd.seriesId);
  curveOf(s);
  if (s.phase !== 'Open' && s.phase !== 'Settled') fail('RaiseNotOpen', `the raise is ${s.phase}`);
  if (TERMINAL.has(s.status)) fail('TerminalStatus', `series is ${s.status}`);
  storeCensus(s, takeCensus(e, s, false), now, emit);
}

/** The census preview for the curve read: both counts now, without the refusals (`takeCensus` moves and refuses nothing else). */
export function censusPreview(e: EngineCore, s: SimSeries): { full: CurveCensusCount | null; redemption: bigint | null } {
  const c = curveOf(s);
  const count = (excludeDamm: boolean): bigint | null => {
    try {
      return unitsOutstanding(c.supply, protocolHeldBalances(e, c, excludeDamm));
    } catch {
      return null;
    }
  };
  const full = count(false);
  return { full: full === null ? null : { supply: c.supply, protocolHeld: c.supply - full, outstanding: full }, redemption: count(true) };
}

// ------------------------------------------------------------------ harness hooks (not reachable through ChainPort)
/**
 * The stand-in's migration (DBC `migrate_damm_v2`, `create_locker`, `withdraw_leftover`), mocked as Stage 1's census
 * test mocks it (curve_mode.rs:708-739): base lamports only move. The base vault keeps `protocolBaseFee` (Meteora's base
 * fee), the leftover receiver takes `leftover`, the locker escrow the issuer's locked allocation and the DAMM v2 pool's
 * vault the rest. Only after the pool filled, once.
 */
export function migrateCurve(e: EngineCore, s: SimSeries, opts: { protocolBaseFee?: bigint; leftover?: bigint } = {}): void {
  const c = curveOf(s);
  if (!poolComplete(c)) throw new ChainError('WrongPhase', 'the curve has not filled');
  if (c.migrated) throw new ChainError('Duplicate', 'the curve has migrated');
  const a = c.accounts;
  const vault = balanceOf(e, a.dbcBaseVault, c.baseMint);
  const fee = opts.protocolBaseFee ?? 0n;
  const leftover = opts.leftover ?? c.leftoverAmount;
  const deposit = vault - c.lockedVestingAmount - fee - leftover;
  if (deposit < 0n) throw new ChainError('InvalidTerms', 'the base vault cannot cover the migration');
  moveBase(e, c, a.dbcBaseVault, a.lockerEscrow, c.lockedVestingAmount);
  moveBase(e, c, a.dbcBaseVault, a.leftoverReceiver, leftover);
  moveBase(e, c, a.dbcBaseVault, a.dammBaseVault, deposit);
  c.migrated = true;
}

/** The issuer claims `units` vested base lamports from the locker escrow (curve_mode.rs:740-752): they reach `to`. */
export function releaseLockedUnits(e: EngineCore, s: SimSeries, to: string, units: bigint): void {
  const c = curveOf(s);
  moveBase(e, c, c.accounts.lockerEscrow, to, units);
}

/**
 * A secondary trade in the DAMM v2 pool (curve_mode.rs:753-766), base side only: `units > 0` moves base lamports out of
 * the pool to `wallet` (a buy), `units < 0` from `wallet` into the pool (a sell).
 */
export function dammTrade(e: EngineCore, s: SimSeries, wallet: string, units: bigint): void {
  const c = curveOf(s);
  if (!c.migrated) throw new ChainError('WrongPhase', 'the curve has not migrated to its DAMM pool');
  if (units >= 0n) moveBase(e, c, c.accounts.dammBaseVault, wallet, units);
  else moveBase(e, c, wallet, c.accounts.dammBaseVault, -units);
}

function moveBase(e: EngineCore, c: SimCurve, from: string, to: string, units: bigint): void {
  if (units < 0n) throw new ChainError('InvalidTerms', 'a negative amount of units');
  if (balanceOf(e, from, c.baseMint) < units) throw new ChainError('InsufficientFunds', 'the account holds fewer units');
  e.debit(from, c.baseMint, units);
  e.credit(to, c.baseMint, units);
}
