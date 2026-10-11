import type { LifecycleStatus, RaiseFailure, RaisePhase, RaiseStateName, SeriesTerms, SettlementRejection } from './events.ts';
import type { Address, ChainFamily, ChainKey, ChainMode, Stablecoin } from './ids.ts';
import type { TradingFeeSplitBps, UnitScale } from './curve.ts';
import type { Money, Units, Wad } from './money.ts';
import type { SigningDomain } from './signing.ts';

/** Read-side state shapes returned by ChainPort. Money as strings; nothing chain-specific. */

export interface ChainInfo {
  chain: ChainKey;
  family: ChainFamily;
  mode: ChainMode;
  /** devnet / testnet / simulator-<personality> */
  network: string;
  stablecoins: Partial<Record<Stablecoin, { mint: Address; decimals: number }>>;
  /** program ids / contract addresses by module, when known */
  modules: Record<string, Address>;
  admin: Address;
  feeCollector: Address;
  newRaisesPaused: boolean;
  /** the chain's settlement limits (a property of the chain family, not of its state) */
  limits: ChainLimits;
  /**
   * The deployment's signing domain (Stage 1 SPEC §1.3): what every `MERCES_*_V1` message binds first,
   * `keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_32)` (S4 D6). Derived on every read, never persisted: the
   * simulator derives it from its personality and chain key (a per-chain-key registry, so two simulator chains never
   * share a domain and no simulator signature is valid on a real deployment); a live adapter reads the registry's own
   * (`ProtocolConfig.domain` on Solana, `MercesRegistry.domain()` on the EVM) and checks it against its manifest (S5).
   * Null while the adapter cannot read it: signing flows then answer 409 `signing-domain-unknown`.
   */
  signing: SigningDomain | null;
}

/**
 * Settlement limits of a chain family (Stage 1 SPEC §5.2): Solana tallies at most 24 bids per page and caps no bid
 * count; EVM tallies at most 200 per page and accepts at most 4,096 bids per auction.
 */
export interface ChainLimits {
  /** the most revealed bids one `tallyBids` may tally */
  tallyPageMax: number;
  /** the most bids one auction accepts; null when the chain sets no limit */
  maxBidsPerAuction: number | null;
}

export interface HealthReport {
  ok: boolean;
  mode: ChainMode;
  latency_ms: number;
  detail: string;
}

export interface IssuerState {
  issuer: Address;
  registeredAt: number;
  issuanceStopped: boolean;
  seriesIds: string[];
}

export interface SeriesState {
  seriesId: string;
  chain: ChainKey;
  issuer: Address;
  terms: SeriesTerms;
  /**
   * Accounting units per whole unit (Stage 1 `Ledger.unit_scale`): "1" for a sealed-bid series, "1000000" (base
   * lamports) for a curve series. `unitsSold`, `unitsOutstanding`, position units and `paidPerUnitWad`/`accNetWad` are
   * per accounting unit; `issuePrice`, `capPerUnit` and the redemption price per whole unit.
   */
  unitScale: UnitScale;
  phase: RaisePhase;
  status: LifecycleStatus;
  createdAt: number;
  openedAt: number | null;
  settledAt: number | null;
  issuePrice: Money | null;
  unitsSold: Units;
  /**
   * The vault's N and the report proof's public input. A sealed raise's units are final once its last bid is processed;
   * a curve series' are its last census (`syncCurveUnits`, or `redeem`'s own), "0" before the first.
   */
  unitsOutstanding: Units;
  /**
   * Curve mode: when the last census was taken (Stage 1 `units_synced_at`); null before the first and on a sealed-bid
   * series. A report on a curve series needs one at or after its period's end (CurveUnitsNotSynced).
   */
  unitsSyncedAt: number | null;
  /**
   * Curve mode: the units holders hold in the series' stake vault (Stage 1 `staked_total`, base lamports), the only units
   * that earn; "0" on a sealed-bid series. Never more than the last census (StakeExceedsOutstanding).
   */
  stakedTotal: Units;
  /** Curve mode: the units tendered at the redemption so far (Stage 1 `tendered_total`, base lamports); "0" otherwise */
  tenderedTotal: Units;
  capPerUnit: Money | null;
  paidPerUnitWad: Wad;
  accNetWad: Wad;
  lockupEndsAt: number | null;
  releasesPaused: boolean;
  releasesPausedByIssuer: boolean;
  pause: { requestedUntil: number | null; approvedUntil: number | null; startedAt: number | null } | null;
  pausedSecondsTotal: number;
  redemption: RedemptionState | null;
  extinguishedAt: number | null;
  /** life-to-date gross accepted, for cap displays */
  grossPaidTotal: Money;
  feesTotal: Money;
  /** Stage 1's reporting ledger (SPEC v1.1 §6.4): which period is next, what is open, and the income chain head */
  reporting: SeriesReporting;
  /** hardship pauses as Stage 1 records them */
  pauses: SeriesPauses;
  /** the period whose formal notice has been recorded, if any */
  formalNoticeEmittedFor: string | null;
  /** the vault's undistributed remainder, WAD-scaled (`0 ≤ carryWad < unitsOutstanding`) */
  carryWad: Wad;
  /** gross refunded to the issuer because it would have passed the cap */
  refundedToIssuer: Money;
  /** gross accepted per settlement year (Stage 1's four-slot ring; `year` null = slot never written) */
  yearGross: { year: number | null; grossWad: Wad }[];
  /** the final pool of an extinguished series */
  final: { accWad: Wad; units: Units; distributed: Money };
  /**
   * The series key every signed message binds after the domain (Stage 1 SPEC §1.4), `0x` + 64 hex: the series PDA's
   * 32 bytes on Solana, `bytes32(uint256(series_id))` on the EVM. The simulator's monad series ids are 20-byte
   * pseudo-addresses: their key is the address left-padded, a labelled stand-in until S5's counter ids (A-ID-1). Equal
   * to `seriesKeyOf(seriesId, family)`; the chain's read is authoritative (S4 D7).
   */
  seriesKey: string;
  /** the series' live signing nonces (S4 D7): what PAUSE, AMEND, EXTINGUISH and TRUEUP signatures bind */
  nonces: SeriesNonces;
  /**
   * Stage 1's mint gate: a sealed raise's last bid is processed (or a curve completed, `completeCurve`). Payments,
   * reports, releases, redemption, extinguishment and windows wait for it (MintNotFinalized).
   */
  mintFinalized: boolean;
}

export interface SeriesReporting {
  /** the settlement quarter; null before settlement */
  firstPeriod: string | null;
  /** the only period a report may be submitted for next; null before settlement */
  nextExpectedPeriod: string | null;
  lastAcceptedPeriod: string | null;
  lastPaidPeriod: string | null;
  /** the period whose due is unpaid, when `openDueAmount` > 0 */
  openDuePeriod: string | null;
  /** the unpaid due, before lateness accrual */
  openDueAmount: Money;
  lastIncomePeriod: string | null;
  /** the income commitment the next report chains from (Poseidon(0, 0) at the start of a reporting year) */
  lastIncomeCommitment: string;
}

/**
 * A series' signing nonces as the chain stores them (Stage 1 `Ledger`: `pause_nonce`, `amendment_nonce`,
 * `extinguish_nonce`, `trueup_nonce`), u64 decimal strings. A command never carries one: the chain checks the signature
 * over its stored nonce, so a signature binds the nonce read when it was requested, and services read it again when they
 * accept a signature and when they build (409 `stale-nonce` when it moved). Each advances only as Stage 1 advances it:
 * `pause` on a pause request and on its withdrawal (an approval leaves it, clearing the request instead), `amendment` on
 * each accepted amendment, `extinguish` on the extinguishment, `trueup` on each accepted true-up (S5).
 */
export interface SeriesNonces {
  pause: string;
  amendment: string;
  extinguish: string;
  trueup: string;
}

export interface SeriesPauses {
  /** pauses approved so far */
  count: number;
  /** Σ approved pause lengths */
  pausedTotalSeconds: number;
  /** an issuer request is waiting for an attestor */
  requested: boolean;
  /** the end the issuer asked for (advisory; the attestor approves the actual end) */
  requestedUntil: number | null;
  /** the pause active now, if any */
  current: { start: number; end: number } | null;
}

/**
 * A sealed-bid raise's auction record (Stage 1 SPEC §5.1–§5.2, the simulator's `SimAuction`). Amounts are the chain's,
 * all public: the escrow, the current round's proposal and running tally, and the results `finalizeSettlement` wrote
 * (for a MinRaise failure, the would-be price, units and proceeds).
 */
export interface AuctionState {
  seriesId: string;
  /** for display: `Reveal` is time-derived and also covers an Open raise past its reveal end, until settlement begins */
  phase: RaisePhase;
  /** Stage 1's stored raise state (never time-derived): what settlement planning reads, with the phase ends */
  raiseState: RaiseStateName;
  commitEndsAt: number | null;
  revealEndsAt: number | null;
  bidCount: number;
  revealedCount: number;
  /** revealed bids valid under Stage 1's rule (fixed at reveal) */
  validCount: number;
  /** stablecoin the auction holds: the deposits, less what processing moved out, less the refunds delivered */
  escrowTotal: Money;
  /** units minted to winners and not yet delivered */
  escrowUnits: Units;
  /** Stage 1 `tally_round`: 0 before the first proposal */
  round: number;
  roundRejected: boolean;
  rejectionReason: SettlementRejection | null;
  /** the current round's proposal (the rejected one while `roundRejected`); null before the first */
  proposal: { clearingPrice: Money; qAboveClaim: Units; qAtClaim: Units; rClaim: Units } | null;
  /** the current round's running tally */
  tally: { talliedCount: number; qAbove: Units; qAt: Units; allocSum: Units; minValidPrice: Money | null };
  /** the price `finalizeSettlement` cleared (kept on a MinRaise failure); null before it and when no bid was valid */
  clearingPrice: Money | null;
  qAbove: Units;
  qAt: Units;
  /** units for the bids exactly at the clearing price (`r_claim` of the accepted round; 0 when failed) */
  R: Units;
  unitsSold: Units;
  proceeds: Money;
  /** when `finalizeSettlement` settled or failed the raise */
  finalizedAt: number | null;
  failureReason: RaiseFailure | null;
  bidsProcessed: number;
  unitsMinted: Units;
  /** the last bid is processed: the money paths open (Stage 1 MintNotFinalized until then) */
  mintFinalized: boolean;
}

export interface BidState {
  seriesId: string;
  bidder: Address;
  commitment: string;
  deposit: Money;
  /** commit order */
  order: number;
  revealed: { pricePerUnit: Money; quantity: Units } | null;
  /** Stage 1 `reveal_index`; null until revealed */
  revealIndex: number | null;
  /** fixed at reveal (Stage 1 `isBidValid`); null until revealed */
  valid: boolean | null;
  /** the settlement round that last tallied the bid (0: never) */
  talliedRound: number;
  processed: boolean;
  /** units allocated when processed */
  allocatedUnits: Units;
  /** units and refund owed to the bidder until delivered ("0" once delivered) */
  pendingUnits: Units;
  pendingRefund: Money;
  /**
   * The non-reveal charge kept from the deposit when the bid was processed (Stage 1 `process_bid`: an unrevealed bid on
   * a settled raise, `floor(deposit × nonRevealChargeBps / 10000)`, paid to the fee collector); "0" for every other bid
   * and before processing. Kept after delivery.
   */
  nonRevealCharge: Money;
  delivered: boolean;
}

export interface TreasuryState {
  seriesId: string;
  total: Money;
  released: Money;
  balance: Money;
  paused: boolean;
  tranches: { index: number; afterSeconds: number; bps: number; amount: Money; drawableAt: number | null; drawn: boolean }[];
}

export interface VaultState {
  seriesId: string;
  balance: Money;
  accNetWad: Wad;
  grossTotal: Money;
  feesTotal: Money;
  dust: Money;
}

export interface PositionState {
  seriesId: string;
  wallet: Address;
  /**
   * the holder's accrual weight (Stage 1 `accrual_units`): its balance, its auction units not yet delivered
   * (`undeliveredUnits`) and the units held for a window ask. On a curve series only staked units earn: `units` is the
   * holder's stake (`stakedUnits`), and the units in its wallet (`walletUnits`) earn nothing
   */
  units: Units;
  /**
   * Curve mode: the holder's units in the series' stake vault (Stage 1 `Holder.staked_units`, base lamports), what it can
   * unstake or tender from its stake; "0" on a sealed-bid series
   */
  stakedUnits: Units;
  /**
   * The units in the holder's wallet: on a curve series its base lamports of the unit mint (they earn nothing until
   * staked; a wallet that holds units without being registered reads `registered: false`); on a sealed-bid series its
   * own balance, `units − undeliveredUnits − escrowedUnits` (Stage 1 `unitsOf`)
   */
  walletUnits: Units;
  /** auction units allocated to the holder and not yet delivered (part of `units`) */
  undeliveredUnits: Units;
  /**
   * units held for the holder's window ask (part of `units`). The holder's own balance (Stage 1 `unitsOf`, what a
   * Retired claim or `burnRetired` burns) is `units − undeliveredUnits − escrowedUnits`
   */
  escrowedUnits: Units;
  /**
   * what `claimPayout` (Stage 1 `claim`) pays now: the net payout, `pending` plus what accrued since the holder's vault
   * cursor. The redemption, the tail and the final pool are separate fields, never included here
   */
  claimable: Money;
  claimedTotal: Money;
  redeemedUnits: Units;
  /**
   * what the holder's redemption pays now beside its pending payout (`claimRedemption`, or the redemption `claimTail` or
   * `claimFinal` runs first): the redemption price on the units not yet redeemed (its units less those held for a window
   * ask) plus the tail catch-up on them; 0 unless the series redeemed and is Redeemed or Extinguished. On a curve series
   * what `tenderUnits` would pay as principal now for the holder's whole stake and the wallet units that fit the tender
   * quota (`floor(P_redeem × units / 10^6)`; a tender has no tail catch-up), 0 unless the series redeemed
   */
  redemptionClaimable: Money;
  /**
   * what `claimTail` (Stage 1 `claim_tail`) pays as `TailClaimed`: Stage 1's `claimableTail` view, the tail since the
   * holder's tail cursor on its redeemed units or, before it redeems, on the units its redemption would redeem
   * (`claim_tail` redeems first, paying `redemptionClaimable` and the pending payout in the redemption's own events). On
   * a curve series the tail on the units the holder tendered only (`claim_tail` redeems nothing there)
   */
  tailClaimable: Money;
  /**
   * what `claimFinal` (Stage 1 `claim_final`) pays as the final-pool share after an extinguishment (it also pays
   * `claimable`). On a curve series that did not redeem the share of the holder's stake is credited into its pending
   * payout by every settlement, so it is part of `claimable` (any claim pays it) and this is 0; on one that redeemed it is
   * the share of the holder's tendered units
   */
  finalClaimable: Money;
  /** a Stage 1 registered holder (payouts accrue to registered holders only) */
  registered: boolean;
  /** payouts already settled into the holder's balance and not yet claimed */
  pending: Money;
  /** the vault accumulator at the holder's last settlement (its claim cursor) */
  lastAccWad: Wad;
}

export interface PeriodState {
  seriesId: string;
  periodId: string;
  dueAt: number;
  graceEndsAt: number;
  formalNoticeAt: number;
  reportAccepted: boolean;
  tier: number | null;
  /**
   * The accepted report's payment figure, Stage 1's `Report.payment_usd` (the proven payment, before any router credit
   * is applied to the due); '0' until reported. Stage 1 bounds a negative true-up by the year's sum of it (S4 WP13:
   * SIM:1204-1208, income.rs:827-833 `year_pay_at`, MercesIncome.sol:404-407 `_yearPayments`). A payment figure Stage 1
   * keeps onchain, never income.
   */
  paymentStable: Money;
  paymentDue: Money;
  accrual: Money;
  paid: Money;
  splitReceived: Money;
  settled: boolean;
  standing: 'NotDue' | 'OnTime' | 'InGrace' | 'Late' | 'FormalNoticeDue' | 'Deferred';
  incomeCommitment: string | null;
  /** the commitment this period's report chained from; null until reported */
  priorIncomeCommitment: string | null;
  liquidityEvent: boolean;
}

export interface RedemptionState {
  openedAt: number;
  pricePerUnit: Money;
  unitsAtRedemption: Units;
  deposit: Money;
  claimed: Money;
  tailCapPerUnit: Money;
  tailEndsAt: number;
  /** @deprecated use `tailPaidPerUnitWad`: the tail paid per whole unit, `tailPaidPerUnitWad / (WAD / unitScale)` */
  tailPaidPerUnit: Money;
  /** tail gross paid per accounting unit so far, WAD-scaled (Stage 1 tail state) */
  tailPaidPerUnitWad: Wad;
  /** the tail accumulator (net per unit, WAD-scaled) */
  tailAccWad: Wad;
  /** the tail cap is reached: no further tail is due */
  tailExhausted: boolean;
  /** tail gross refunded to the issuer above the tail cap */
  tailRefunded: Money;
}

export interface RateAccumulatorState {
  pair: string;
  sumWad: Wad;
  count: number;
  lastDayIndex: number | null;
  lastRateWad: Wad | null;
}

export interface QuarterRateState {
  pair: string;
  periodId: string;
  avgWad: Wad | null;
  snapshots: number;
  daysInQuarter: number;
  coverageOk: boolean;
  needsFallback: boolean;
  fallbackReason: 'coverage' | 'deviation' | null;
}

export interface TransferWindowState {
  seriesId: string;
  windowId: number;
  commitEndsAt: number;
  revealEndsAt: number;
  cleared: boolean;
  clearingPrice: Money | null;
  orderCount: number;
  /** stablecoin held for the window's buy orders (their deposits not yet paid out or refunded); "0" once cleared */
  escrowStable: Money;
  /** units held for the window's ask orders (still in the sellers' positions, earning payouts); "0" once cleared */
  escrowUnits: Units;
}

/**
 * A curve series' bonding curve (curve mode, Solana only) as the chain reads it. Base quantities are base lamports (the
 * series' accounting unit, 10^6 per whole unit); prices per whole unit. Until S5 the simulator runs a labelled stand-in
 * for Meteora's Dynamic Bonding Curve (`venue: 'simulator-stand-in'`): it sells at the constant price P0 and models the
 * pool's reserve, its trading fee, the fill at the target and its protocol-held base balances; Meteora's real venue
 * (`'meteora-dbc'`) arrives with the Solana adapter. No cap applies at any stage (`CURVE_NO_CAP`).
 */
export interface CurveState {
  seriesId: string;
  venue: 'simulator-stand-in' | 'meteora-dbc';
  dbcConfig: Address;
  dbcPool: Address;
  /** the series' unit mint (6 decimals) */
  baseMint: Address;
  quoteStablecoin: Stablecoin;
  /** X: the quote the pool must hold for the curve to fill (the terms' minimum raise) */
  migrationQuoteThreshold: Money;
  /** the quote the pool holds for the curve (buys net of the trading fee, less sells); the treasury holds none of it */
  quoteReserve: Money;
  /** progress toward the target, `floor(quoteReserve × 10000 / X)`, at most 10000 */
  progressBps: number;
  /** when the curve filled (the raise's settlement time); null while it has not */
  finishCurveTimestamp: number | null;
  /** the pool reached its target: no more trades on the curve */
  poolComplete: boolean;
  /** `completeCurve` ran: the raise is Settled at `finishCurveTimestamp` */
  settled: boolean;
  /** P0 per whole unit, fixed at activation (Stage 1 `clearing_price`) */
  issuePrice: Money;
  /** the base lamports the curve sells (Stage 1 `units_sold`, the pool's swap base), fixed at activation */
  unitsSold: Units;
  /** base lamports bought out of the curve, net of sells */
  baseSold: Units;
  /**
   * the unit mint's supply: the swap base, the migration base, the issuer's locked allocation and the leftover, fixed at
   * activation; only tenders burn units after a redemption (`tenderUnits`)
   */
  baseSupply: Units;
  /** the curve's price per whole unit now (the stand-in's is P0 throughout) */
  spotPrice: Money;
  /** the trading fee every buy and sell pays, in bps (100 = 1%), as the pool's config sets it */
  tradingFeeBps: number;
  /**
   * how the pool's config splits that fee, in bps of the fee (summing to 10,000): Meteora's protocol share, the
   * partner's (Merces') and the creator's (the issuer's; 0 unless configured). The buyer notice states these figures,
   * never its own (owner direction of 2026-10-10)
   */
  tradingFeeSplitBps: TradingFeeSplitBps;
  /** Meteora's migration fee, percent of X; the partner's share of it funds the series treasury */
  migrationFeePercentage: number;
  /** the partner's trading fees accrued in the pool and not collected yet */
  tradingFeeUncollected: Money;
  /** what `collectCurveProceeds` moved so far: the migration fee and surplus into the treasury, the trading fee to the fee collector */
  collected: { migrationFee: Money; surplus: Money; tradingFee: Money; proceeds: Money };
  /** the curve's census now and the one the chain stored last */
  census: CurveCensus;
}

/**
 * A curve series' census (Stage 1 `compute_curve_units`, curve.rs:350-490), base lamports. Units outstanding are the unit
 * mint's supply less what protocol accounts hold: the DBC pool's base vault, the DAMM v2 pool's base vault, the locker
 * escrow and the leftover receiver (the stake vault is the holders'). The chain stores a census only when one is taken
 * (`syncCurveUnits`, or `redeem`'s own); what it stored is the vault's N, the bound on the stakes and the report proof's
 * public input.
 */
export interface CurveCensus {
  /** the unit mint's supply now */
  supply: Units;
  /** base lamports in protocol accounts now */
  protocolHeld: Units;
  /** what `syncCurveUnits` would store now: `supply − protocolHeld` */
  unitsOutstanding: Units;
  /**
   * What `redeem` would count now, its deposit's N: the DAMM v2 pool's base vault is not subtracted (Stage 1 B-C13), so
   * the count covers every unit holders could tender and the issuer cannot lower it by parking units in the pool
   */
  redemptionUnits: Units;
  /** the stakes now (Stage 1 `staked_total`) */
  stakedTotal: Units;
  /** the census the chain stored last (`SeriesState.unitsOutstanding`) and when; null before the first */
  synced: { unitsOutstanding: Units; at: number } | null;
  /** a census now would store another count than the last one (or none was taken yet) */
  changedSinceSync: boolean;
}

/**
 * A quote for a `curveSwap` at the chain's current state (`ChainPort.quoteCurveSwap`). `buy`: `amountIn` stablecoin in,
 * `amountUsed` of it charged (less only when the trade fills the curve: the rest is never taken), `fee` the trading
 * fee on it, `amountOut` base lamports out. `sell`: `amountIn` base lamports in, `amountOut` stablecoin out after the
 * `fee`. `fillsCurve`: this trade fills the curve.
 */
export interface CurveSwapQuote {
  seriesId: string;
  side: 'buy' | 'sell';
  amountIn: Money;
  amountUsed: Money;
  amountOut: Money;
  fee: Money;
  fillsCurve: boolean;
}
