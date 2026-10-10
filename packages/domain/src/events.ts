import { z } from 'zod';
import { addressSchema, hash32Schema, pairSchema, periodIdSchema, seriesIdSchema, stablecoinSchema } from './ids.ts';
import { moneySchema, unitsSchema, wadSchema } from './money.ts';

/**
 * Canonical domain events (provisional interface v0, Part D2). Every live adapter maps what Stage 1 actually
 * emits onto exactly these shapes. Services never see chain-specific event shapes.
 */

export const lifecycleStatusSchema = z.enum(['OnTime', 'InGrace', 'Late', 'Paused', 'Retired', 'Redeemed', 'Extinguished']);
export type LifecycleStatus = z.infer<typeof lifecycleStatusSchema>;

export const raisePhaseSchema = z.enum(['Draft', 'Open', 'Reveal', 'Settled', 'Failed', 'Cancelled']);
export type RaisePhase = z.infer<typeof raisePhaseSchema>;

export const raiseStyleSchema = z.enum(['sealed', 'curve']);
export const tierSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const feeKindSchema = z.enum(['auction', 'payout']);
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
  walletCapBps: z.number().int().positive().max(10_000),
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
  RaiseOpened: z.object({ ...seriesScoped, commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  RaiseCancelled: z.object({ ...seriesScoped }),
  BidCommitted: z.object({ ...seriesScoped, bidder: addressSchema, commitment: hash32Schema, deposit: moneySchema, order: z.number().int() }),
  BidRevealed: z.object({ ...seriesScoped, bidder: addressSchema, pricePerUnit: moneySchema, quantity: unitsSchema }),
  AuctionSettled: z.object({ ...seriesScoped, clearingPrice: moneySchema, unitsSold: unitsSchema, proceeds: moneySchema, totalFees: moneySchema, settledAt: z.number().int() }),
  AuctionFailed: z.object({ ...seriesScoped, reason: z.enum(['no-bids', 'below-minimum-raise']) }),
  BidRefunded: z.object({ ...seriesScoped, bidder: addressSchema, amount: moneySchema }),
  UnitsMinted: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema }),
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
  PayoutClaimed: z.object({ ...seriesScoped, holder: addressSchema, amount: moneySchema }),
  SeriesRetired: z.object({ ...seriesScoped, paidPerUnitWad: wadSchema }),
  UnitsBurned: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, reason: z.enum(['cap', 'redemption', 'extinguishment']) }),
  RedemptionOpened: z.object({ ...seriesScoped, pricePerUnit: moneySchema, unitsOutstanding: unitsSchema, deposit: moneySchema, tailCapPerUnit: moneySchema, tailEndsAt: z.number().int() }),
  RedemptionClaimed: z.object({ ...seriesScoped, holder: addressSchema, units: unitsSchema, amount: moneySchema }),
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
  AttestorRegistered: z.object({ attestor: addressSchema, active: z.boolean() }),
  VerifierKeyRegistered: z.object({ keyId: z.string(), publicKey: z.string(), active: z.boolean() }),
  CurveSeriesCreated: z.object({ ...seriesScoped, issuer: addressSchema, quoteStablecoin: stablecoinSchema, graduationThreshold: moneySchema }),
  CurveGraduated: z.object({ ...seriesScoped, raised: moneySchema, unitsOutstanding: unitsSchema }),
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

/** Events that carry a money amount and must never appear in the public activity feed with amounts (R28). */
export const amountBearingEvents: ReadonlySet<EventType> = new Set<EventType>([
  'BidCommitted', 'BidRevealed', 'AuctionSettled', 'BidRefunded', 'TreasuryFunded', 'FundsReleased', 'SplitReceipt', 'ReportAccepted',
  'PaymentReceived', 'PaymentRefunded', 'FeeTaken', 'PayoutClaimed', 'RedemptionOpened', 'RedemptionClaimed', 'TailPayout',
  'SeriesExtinguished', 'TransferWindowCleared', 'CurveGraduated',
]);
