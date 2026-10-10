import { z } from 'zod';
import { addressSchema, hash32Schema, pairSchema, periodIdSchema, seriesIdSchema, stablecoinSchema } from './ids.ts';
import { moneySchema, unitsSchema, wadSchema } from './money.ts';

/**
 * Canonical domain events (provisional interface v0, Part D2). Every live adapter maps what Stage 1 actually
 * emits onto exactly these shapes. Services never see chain-specific event shapes.
 */

export const lifecycleStatusSchema = z.enum(['OnTime', 'InGrace', 'Late', 'Paused', 'Retired', 'Redeemed', 'Extinguished']);
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

/**
 * The raise's phase for display: `Reveal` is time-derived (an Open raise between its commit end and its reveal end, and
 * after the reveal end until settlement begins); `Settling` is Stage 1's state while a settlement round runs.
 */
export const raisePhaseSchema = z.enum(['Draft', 'Open', 'Reveal', 'Settling', 'Settled', 'Failed', 'Cancelled']);
export type RaisePhase = z.infer<typeof raisePhaseSchema>;
/** Stage 1's stored raise state (SPEC §5.1 `raise_state`), never time-derived: what settlement planning reads. */
export const raiseStateSchema = z.enum(['Draft', 'Open', 'Settling', 'Settled', 'Failed', 'Cancelled']);
export type RaiseStateName = z.infer<typeof raiseStateSchema>;
/** Why `finalizeSettlement` rejected a round (Stage 1 `SettlementRejected.reason`; Solana codes 1 and 2) */
export const settlementRejectionSchema = z.enum(['ClaimMismatch', 'InvalidClearingPrice']);
export type SettlementRejection = z.infer<typeof settlementRejectionSchema>;
/** Why a raise failed (Stage 1 `finalize_settlement` steps 1 and 5) */
export const raiseFailureSchema = z.enum(['NoValidBids', 'MinRaise']);
export type RaiseFailure = z.infer<typeof raiseFailureSchema>;

export const raiseStyleSchema = z.enum(['sealed', 'curve']);
export const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
/**
 * `auction`: a sealed raise's fee on each winner's cost; `payout`: the fee on each payment into the vault;
 * `curveTrading`: Merces' (the partner's) share of a curve's trading fees, collected from the pool by
 * `collectCurveProceeds` (Meteora keeps its own share); `nonReveal`: the non-reveal charge kept from an unrevealed bid's
 * escrow when a sealed raise settles (Stage 1 `process_bid`, `NonRevealCharged`), paid to the fee collector.
 */
export const feeKindSchema = z.enum(['auction', 'payout', 'curveTrading', 'nonReveal']);
export const paymentSourceSchema = z.enum(['payIn', 'split', 'redemption', 'tail', 'extinguishment']);
export const fxBasisSchema = z.enum(['accumulator', 'attestor', 'unity']);

export const releaseTrancheSchema = z.object({
  /** seconds after auction settlement when the tranche becomes drawable */
  afterSeconds: z.number().int().nonnegative(),
  /** share of total proceeds in basis points; all tranches sum to 10000 */
  bps: z.number().int().positive().max(10_000),
});
export type ReleaseTranche = z.infer<typeof releaseTrancheSchema>;

export const tierFlagsSchema = z.object({ tier1: z.boolean(), tier2: z.boolean(), tier3: z.boolean(), tier4: z.boolean() });

/** The immutable terms recorded on a series (C4). θ and r are NOT here: only their commitment. */
export const seriesTermsSchema = z.object({
  stablecoin: stablecoinSchema,
  stablecoinMint: addressSchema,
  unitsOffered: unitsSchema,
  reservePrice: moneySchema,
  minimumRaise: moneySchema,
  capMultipleWad: wadSchema,
  lockupSeconds: z.number().int().nonnegative(),
  releaseSchedule: z.array(releaseTrancheSchema).min(1),
  auctionFeeBps: z.number().int().nonnegative().max(10_000),
  payoutFeeBps: z.number().int().nonnegative().max(10_000),
  hurdleWad: wadSchema,
  payoutMultipleK: z.number().int().positive(),
  /**
   * The sealed-bid raise's wallet cap, in bps of the units offered (Stage 1 `wallet_cap_bps`; a bid above
   * `floor(units × bps / 10000)` is invalid at reveal). A curve series records 0: a curve raise has no wallet cap at any
   * stage (`CURVE_NO_CAP`; Stage 1 refuses anything else, CurveTermsNotZero).
   */
  walletCapBps: z.number().int().nonnegative().max(10_000),
  /**
   * Stage 1's non-reveal charge (SPEC §5.2), the series' own rate, frozen at creation: when a sealed raise settles,
   * `processBid` keeps `floor(escrow × bps / 10000)` of a bid committed and never revealed and pays it to the fee
   * collector (`NonRevealCharged`, `FeeTaken{nonReveal}`); a failed raise charges nothing. Stage 1 bounds it to
   * 0–1,000 bps at creation. New series built through the terms service take the owner's setting
   * (`NON_REVEAL_CHARGE_SETTING`, params.ts); issuers cannot choose it. A curve series has no bids to charge.
   */
  nonRevealChargeBps: z.number().int().nonnegative().max(10_000),
  /**
   * The commit phase of the sealed-bid raise, in seconds from `openRaise` (Stage 1 `commit_duration`); the reveal phase
   * follows for `revealDurationSeconds` (Stage 1 `reveal_duration`). The chain enforces Stage 1's bounds for a sealed
   * raise (1 hour–30 days and 1 hour–7 days); a curve series records 0 for both, as for `lockupSeconds` and
   * `walletCapBps` (Stage 1 CurveTermsNotZero).
   */
  commitDurationSeconds: z.number().int().nonnegative(),
  revealDurationSeconds: z.number().int().nonnegative(),
  /** report due, in days of unpaused time after the period end (Stage 1: countdown ≤ due days is OnTime) */
  dueDays: z.number().int().positive(),
  /** grace after the due date (Stage 1: countdown ≤ due + grace days is InGrace, then Late) */
  graceDays: z.number().int().nonnegative(),
  /** formal notice, in days of unpaused time after the **period end** (Stage 1 `formalNoticeDue`; 90 = period end + 90 days) */
  formalNoticeDays: z.number().int().positive(),
  contractHash: hash32Schema,
  termsCommitment: hash32Schema,
  tierFlags: tierFlagsSchema,
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  raiseStyle: raiseStyleSchema,
});
export type SeriesTerms = z.infer<typeof seriesTermsSchema>;

const seriesScoped = { seriesId: seriesIdSchema };

export const eventPayloads = {
  IssuerRegistered: z.object({ issuer: addressSchema }),
  IssuanceStopped: z.object({ issuer: addressSchema }),
  SeriesCreated: z.object({ ...seriesScoped, issuer: addressSchema, terms: seriesTermsSchema }),
  /**
   * Stage 1 `RaiseOpened`: a sealed raise's `openRaise`, with its phase ends; a curve series' creation (its activation)
   * with 0 and 0, as Stage 1's `activate_curve` emits it (curve.rs:824-830): a curve raise has no commit or reveal phase.
   */
  RaiseOpened: z.object({ ...seriesScoped, commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  RaiseCancelled: z.object({ ...seriesScoped }),
  BidCommitted: z.object({ ...seriesScoped, bidder: addressSchema, commitment: hash32Schema, deposit: moneySchema, order: z.number().int() }),
  /** Stage 1 `BidRevealed`: `valid` is fixed at reveal (Stage 1 `isBidValid`); an invalid bid is refunded in full */
  BidRevealed: z.object({ ...seriesScoped, bidder: addressSchema, pricePerUnit: moneySchema, quantity: unitsSchema, valid: z.boolean() }),
  /**
   * Stage 1 `RaiseSettled` (`finalize_settlement`): the clearing price, units sold and proceeds, at `settledAt`. The fees
   * are not known yet: each winner's fee is taken when it is processed (`UnitsAllocated.fee`, `FeeTaken`).
   */
  AuctionSettled: z.object({
    ...seriesScoped, clearingPrice: moneySchema, unitsSold: unitsSchema, proceeds: moneySchema, settledAt: z.number().int(),
  }),
  /**
   * Stage 1 `RaiseFailed`. NoValidBids carries a price, units and proceeds of 0 (no price was found: the indexer records
   * the price as null, as the chain's auction read shows it); MinRaise carries the price that cleared
   * and the would-be units sold and proceeds (`unitsSold` is ours: Stage 1's event omits it, and live adapters derive it
   * as proceeds / clearingPrice when the price is above 0, else 0). Every deposit is returned in full.
   */
  AuctionFailed: z.object({ ...seriesScoped, reason: raiseFailureSchema, clearingPrice: moneySchema, unitsSold: unitsSchema, proceeds: moneySchema, minimumRaise: moneySchema }),
  /** Stage 1 `begin_settlement`: round `round` proposes `clearingPrice` (the proposer's claims are on the auction record) */
  SettlementProposed: z.object({ ...seriesScoped, clearingPrice: moneySchema, round: z.number().int().positive() }),
  /** Stage 1 `finalize_settlement` refused the round's proposal; the tally stays and a new round may be proposed */
  SettlementRejected: z.object({ ...seriesScoped, round: z.number().int().positive(), clearingPrice: moneySchema, reason: settlementRejectionSchema }),
  /**
   * Stage 1 `process_bid` for a winning bid: `units` minted to the auction escrow for the bidder, `cost` to the treasury,
   * `fee` to the fee collector, `refund` owed back to the bidder; units and refund reach the bidder with `BidDelivered`.
   * A losing or invalid bid, and every bid of a failed raise, is processed without an event; an unrevealed bid on a
   * settled raise emits `NonRevealCharged` when its charge is above 0.
   */
  UnitsAllocated: z.object({ ...seriesScoped, bidder: addressSchema, units: unitsSchema, cost: moneySchema, fee: moneySchema, refund: moneySchema }),
  /** Stage 1 `deliver_bid`: the processed bid's units and refund reach the bidder */
  BidDelivered: z.object({ ...seriesScoped, bidder: addressSchema, units: unitsSchema, refund: moneySchema }),
  /**
   * Stage 1 `NonRevealCharged` (`process_bid` of a bid committed and never revealed, on a settled raise): `charge`, the
   * series' non-reveal charge on the bid's escrow (`floor(escrow × nonRevealChargeBps / 10000)`), went to the fee
   * collector; the rest of the escrow is the bid's refund, paid by `deliverBid` (`BidDelivered`). Emitted only when the
   * charge is above 0 (Solana's rule; the EVM's `NonRevealCharged(0)` is dropped by its adapter), followed by
   * `FeeTaken{nonReveal}`. A failed raise charges nothing and emits neither.
   */
  NonRevealCharged: z.object({ ...seriesScoped, bidder: addressSchema, charge: moneySchema }),
  /**
   * Stage 1: the last `process_bid` finalises the mint (`unitsOutstanding = unitsSold`); 0 and 0 for a failed raise. A
   * curve's `completeCurve` emits it with the curve's units sold (base lamports) and proceeds 0, and leaves units
   * outstanding to the curve's census.
   */
  RaiseMintFinalized: z.object({ ...seriesScoped, unitsSold: unitsSchema, proceeds: moneySchema }),
  /**
   * A wallet's first registration as a holder of the series (Stage 1 `registerHolder`): by `register_holder`, a winning
   * `process_bid` or a window purchase. Payouts accrue to registered holders only.
   */
  HolderRegistered: z.object({ ...seriesScoped, holder: addressSchema }),
  /**
   * Stablecoin into the series treasury: a sealed raise's winner's cost at processing; a curve's proceeds (the migration
   * fee and surplus) at the `collectCurveProceeds` that brings them. A curve buy never funds it: the buyers' money sits
   * in the curve's pool until it fills.
   */
  TreasuryFunded: z.object({ ...seriesScoped, amount: moneySchema }),
  FundsReleased: z.object({ ...seriesScoped, amount: moneySchema, trancheIndex: z.number().int() }),
  ReleasesPaused: z.object({ ...seriesScoped, reason: z.enum(['Late', 'IssuerRequest']) }),
  ReleasesResumed: z.object({ ...seriesScoped }),
  SplitReceipt: z.object({ ...seriesScoped, periodId: periodIdSchema, amount: moneySchema, router: addressSchema }),
  ReportAccepted: z.object({
    ...seriesScoped,
    periodId: periodIdSchema,
    tier: tierSchema,
    /**
     * The due the report opened (Stage 1 `Report.due`): the payment less tier-1 split credit, 0 for a tail report
     * that is not a liquidity event. It excludes lateness accrual, which is charged when the payment lands
     * (`PaymentReceived.accrual`).
     */
    paymentDue: moneySchema,
    /** Always "0": accrual is charged at payment time (`PaymentReceived.accrual`), never at the report. */
    accrual: moneySchema,
    /** the income commitment the report chained from (Stage 1's event omits it; adapters read it from the stored report) */
    priorIncomeCommitment: hash32Schema,
    incomeCommitment: hash32Schema,
    /** the series' live terms commitment the proof was checked against */
    termsCommitment: hash32Schema,
    fxBasis: fxBasisSchema,
    fxAvgWad: wadSchema,
    liquidityEvent: z.boolean(),
  }),
  PaymentReceived: z.object({
    ...seriesScoped,
    periodId: periodIdSchema.nullable(),
    gross: moneySchema,
    fee: moneySchema,
    net: moneySchema,
    source: paymentSourceSchema,
    paidPerUnitWad: wadSchema,
    /** source `payIn` only: the period's final due and accrual, recomputed when the payment lands (interest runs until then) */
    paymentDue: moneySchema.optional(),
    accrual: moneySchema.optional(),
  }),
  PaymentRefunded: z.object({ ...seriesScoped, periodId: periodIdSchema.nullable(), amount: moneySchema, reason: z.enum(['cap', 'overpayment']) }),
  FeeTaken: z.object({ ...seriesScoped, kind: feeKindSchema, amount: moneySchema, payer: addressSchema }),
  /**
   * Stage 1 `PayoutClaimed`: `amount` is the net payout the claim paid; `burnedUnits` the units the claim burns (a
   * Retired series' balance; 0 otherwise). `claimPayout` always emits it, zeros included (SPEC's zero-amount rule),
   * before the `UnitsBurned` of a Retired balance. Inside the redemption body (`claimRedemption`, and the redemption a
   * `claimTail` or `claimFinal` runs first) it carries the holder's pending payout and the tail catch-up, with
   * `burnedUnits` 0 (the body's burn is its own `UnitsBurned`), and is emitted only when that amount is above 0; so it is
   * in a curve series' `tenderUnits` and `claimTail` (the pending payout split out of the tender's principal and the
   * tail). A curve series never burns on a claim (`burnedUnits` 0).
   */
  PayoutClaimed: z.object({ ...seriesScoped, holder: addressSchema, amount: moneySchema, burnedUnits: unitsSchema }),
  /** Stage 1 `TailClaimed` (`claimTail`): the tail paid on the holder's redeemed units, the tail only (0 included) */
  TailClaimed: z.object({ ...seriesScoped, holder: addressSchema, amount: moneySchema }),
  /**
   * Stage 1 `FinalClaimed` (`claimFinal`, the reference simulator's and the EVM's payload): `units` is the weight the
   * holder's final-pool share was taken on (its redeemed units on a series that redeemed, else its accrual units) and
   * `amount` its pending payout plus that share (0 included). A redemption run first pays in its own events. Emitted
   * before the `UnitsBurned` of the holder's remaining units.
   */
  FinalClaimed: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, amount: moneySchema }),
  SeriesRetired: z.object({ ...seriesScoped, paidPerUnitWad: wadSchema }),
  /**
   * A holder's units burned (Stage 1 `UnitsBurned`). On a sealed-bid series units outstanding fall by `units`; on a curve
   * series only a tender burns (`reason: redemption`, staked and wallet units together), and units outstanding stay the
   * count taken at redemption (Stage 1 takes no census after it).
   */
  UnitsBurned: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, reason: z.enum(['cap', 'redemption', 'extinguishment']) }),
  RedemptionOpened: z.object({ ...seriesScoped, pricePerUnit: moneySchema, unitsOutstanding: unitsSchema, deposit: moneySchema, tailCapPerUnit: moneySchema, tailEndsAt: z.number().int() }),
  /**
   * A holder's units redeemed: `amount` is the redemption principal, `P_redeem × units` at the series' unit scale (the
   * holder's pending payout and any tail catch-up go out in the `PayoutClaimed` before it). On a curve series
   * (`tenderUnits`, Stage 1 `tender_units`) `fromStake` is the part of `units` tendered from the holder's stake (ours:
   * Stage 1's event has no such field; the Solana adapter derives it from the tender's arguments); absent on a
   * sealed-bid series.
   */
  RedemptionClaimed: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, amount: moneySchema, fromStake: unitsSchema.optional() }),
  /**
   * Ours (no Stage 1 counterpart): a tail payment's `total` the tail accepted, and `perUnit` per whole unit,
   * `floor(total × unitScale / unitsAtRedemption)` (`floor(total / unitsAtRedemption)` on a sealed-bid series).
   */
  TailPayout: z.object({ ...seriesScoped, periodId: periodIdSchema, perUnit: moneySchema, total: moneySchema }),
  PauseRequested: z.object({ ...seriesScoped, until: z.number().int() }),
  PauseApproved: z.object({ ...seriesScoped, attestor: addressSchema, until: z.number().int() }),
  PauseEnded: z.object({ ...seriesScoped, pausedSeconds: z.number().int() }),
  StatusChanged: z.object({ ...seriesScoped, from: lifecycleStatusSchema, to: lifecycleStatusSchema }),
  FormalNoticeDue: z.object({ ...seriesScoped, periodId: periodIdSchema }),
  TermsAmended: z.object({ ...seriesScoped, termsCommitment: hash32Schema, previousCommitment: hash32Schema, capMultipleWad: wadSchema, attestor: addressSchema }),
  SeriesExtinguished: z.object({ ...seriesScoped, attestors: z.array(addressSchema).length(2), returnedToHolders: moneySchema }),
  RateSnapshot: z.object({ pair: pairSchema, rateWad: wadSchema, confWad: wadSchema, publishTime: z.number().int(), dayIndex: z.number().int(), sumWad: wadSchema, count: z.number().int() }),
  FxFallbackFlagged: z.object({ pair: pairSchema, periodId: periodIdSchema, reason: z.enum(['coverage', 'deviation']) }),
  TransferWindowOpened: z.object({ ...seriesScoped, windowId: z.number().int(), commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  TransferWindowCleared: z.object({ ...seriesScoped, windowId: z.number().int(), clearingPrice: moneySchema, unitsTransferred: unitsSchema }),
  UnitsTransferred: z.object({ ...seriesScoped, from: addressSchema, to: addressSchema, units: unitsSchema, windowId: z.number().int() }),
  AllowlistUpdated: z.object({ wallet: addressSchema, allowed: z.boolean() }),
  /** Stage 1's `AttestorRegistered{addr}` (registry events; MercesRegistry.sol:321): the key is active, `revokedAt` 0. */
  AttestorRegistered: z.object({ attestor: addressSchema }),
  /**
   * Stage 1's `AttestorRevoked{addr, revoked_at}` (MercesRegistry.sol:340): the key is revoked at `revokedAt` (unix
   * seconds, the block time). Report and FX signatures of periods that ended by then stay valid until
   * `revokedAt + KEY_GRACE_SECONDS`.
   */
  AttestorRevoked: z.object({ attestor: addressSchema, revokedAt: z.number().int() }),
  VerifierKeyRegistered: z.object({ keyId: z.string(), publicKey: z.string(), active: z.boolean() }),
  /**
   * Stage 1's registry `CurveActivated` (registry events.rs:172-180): a curve series is created and activated at once
   * here (its creation is the activation, S3). `dbcConfig` and `dbcPool` are the curve's pool, `baseMint` its unit mint
   * (6 decimals: units are base lamports), `dbcCreator` the pool creator; `unitsSold` is the swap base the curve sells
   * (base lamports) and `issuePrice` its P0 = floor(X × 10^6 / unitsSold) per whole unit (Stage 1 `clearing_price`), from
   * which the cap per unit follows. The raise is Open; `RaiseOpened{0, 0}` follows.
   */
  CurveActivated: z.object({ ...seriesScoped, dbcConfig: addressSchema, dbcPool: addressSchema, baseMint: addressSchema, dbcCreator: addressSchema, unitsSold: unitsSchema, issuePrice: moneySchema }),
  /**
   * Stage 1 `RaiseSettled` on a curve (`completeCurve`, curve.rs:861-906): the curve raise settles at `settledAt`, the
   * pool's finish time (when the curve filled), with the P0 (`issuePrice`) and units sold fixed at activation, proceeds
   * 0 (the treasury is funded by `collectCurveProceeds`). Units outstanding stay with the curve's census.
   */
  CurveGraduated: z.object({ ...seriesScoped, issuePrice: moneySchema, unitsSold: unitsSchema, settledAt: z.number().int() }),
  /**
   * Stage 1 `CurveProceedsCollected` (curve.rs:1206-1212): what one `collectCurveProceeds` moved. `migrationFee` and
   * `surplus` reached the treasury (once each, after the curve filled), `tradingFee` the fee collector (the partner's
   * share of the trading fees accrued since the last collection); `proceeds` is the treasury's total proceeds after it.
   */
  CurveProceedsCollected: z.object({ ...seriesScoped, migrationFee: moneySchema, surplus: moneySchema, tradingFee: moneySchema, proceeds: moneySchema }),
  /**
   * Stage 1 `CurveUnitsSynced` (curve.rs:492-508, events.rs:462-468): a curve census was stored, by `syncCurveUnits` or
   * by `redeem` (whose own census leaves the DAMM v2 pool's base vault out, B-C13). `unitsOutstanding = supply −
   * protocolHeld` (base lamports) becomes the series' units outstanding: the vault's N, the bound on the stakes and the
   * report proof's public input. `stakedTotal` is the stakes at that moment. Units only, no amount.
   */
  CurveUnitsSynced: z.object({ ...seriesScoped, supply: unitsSchema, protocolHeld: unitsSchema, unitsOutstanding: unitsSchema, stakedTotal: unitsSchema }),
  /**
   * Stage 1 `UnitsStaked` (curve.rs:1305-1310, events.rs:483-489): `holder` moved `units` base lamports into the series'
   * stake vault (`stakeUnits`); `staked` is its stake after it. Staked units earn from now on. Units only, no amount.
   */
  UnitsStaked: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, staked: unitsSchema }),
  /**
   * Stage 1 `UnitsUnstaked` (curve.rs:1376-1381, events.rs:491-497): `holder` took `units` base lamports back from the
   * stake vault to its wallet (`unstakeUnits`); `staked` is its stake after it. What the stake earned stays in the
   * holder's pending payout: no stablecoin moves. Units only, no amount.
   */
  UnitsUnstaked: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, staked: unitsSchema }),
} as const;

export type EventType = keyof typeof eventPayloads;
export const eventTypes = Object.keys(eventPayloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloads)[T]>;

export const finalitySchema = z.enum(['finalized', 'confirmed']);

const envelopeBase = {
  chain: z.string(),
  /** opaque, lexicographically ordered within a chain */
  cursor: z.string(),
  /** monotonic per chain */
  seq: z.number().int().nonnegative(),
  blockTime: z.number().int(),
  blockRef: z.string(),
  txId: z.string(),
  finality: finalitySchema,
};

export const domainEventSchema = z.discriminatedUnion(
  'type',
  Object.entries(eventPayloads).map(([type, payload]) => z.object({ ...envelopeBase, type: z.literal(type), payload })) as unknown as [
    z.ZodObject<{ type: z.ZodLiteral<'IssuerRegistered'> }>,
    ...z.ZodObject<{ type: z.ZodLiteral<string> }>[],
  ],
);

export interface DomainEvent<T extends EventType = EventType> {
  chain: string;
  cursor: string;
  seq: number;
  blockTime: number;
  blockRef: string;
  txId: string;
  finality: 'finalized' | 'confirmed';
  type: T;
  payload: EventPayload<T>;
}

export function parseDomainEvent(x: unknown): DomainEvent {
  return domainEventSchema.parse(x) as unknown as DomainEvent;
}

export function isEvent<T extends EventType>(e: DomainEvent, type: T): e is DomainEvent<T> {
  return e.type === type;
}

/**
 * Events that carry a money amount and must never appear in the public activity feed with amounts (R28). A label for
 * the generated docs: the control itself is the indexer's activity `summary()`, which names no amount for any event.
 */
export const amountBearingEvents: ReadonlySet<EventType> = new Set<EventType>([
  'BidCommitted', 'BidRevealed', 'AuctionSettled', 'AuctionFailed', 'SettlementProposed', 'SettlementRejected', 'UnitsAllocated',
  'BidDelivered', 'NonRevealCharged', 'RaiseMintFinalized', 'TreasuryFunded', 'FundsReleased', 'SplitReceipt', 'ReportAccepted',
  'PaymentReceived', 'PaymentRefunded', 'FeeTaken', 'PayoutClaimed', 'TailClaimed', 'FinalClaimed', 'RedemptionOpened', 'RedemptionClaimed', 'TailPayout',
  'SeriesExtinguished', 'TransferWindowCleared', 'CurveActivated', 'CurveGraduated', 'CurveProceedsCollected',
]);
