import type { DomainEvent } from './events.ts';
import type { AdminCommand, PermissionlessCommand, ServiceCommand, ServiceRole, SignedTx, TxResult, UnsignedTx, UserCommand } from './commands.ts';
import type { Address, ChainFamily, ChainKey, ChainMode, Stablecoin } from './ids.ts';
import type { Money } from './money.ts';
import type {
  AuctionState, BidState, ChainInfo, CurveState, CurveSwapQuote, HealthReport, IssuerState, PeriodState, PositionState, QuarterRateState,
  RateAccumulatorState, RedemptionState, SeriesState, TransferWindowState, TreasuryState, VaultState,
} from './state.ts';

/**
 * ChainPort — the only way any service talks to a chain (Part D1).
 * Read: current state. Events: ordered, resumable stream from a cursor. Write: build unsigned transactions
 * for users; submit only for the backend's own permissionless/service roles.
 */
export interface ChainPort {
  readonly chain: ChainKey;
  readonly family: ChainFamily;
  readonly mode: ChainMode;

  info(): Promise<ChainInfo>;
  health(): Promise<HealthReport>;
  /** Chain time (latest finalised block time), unix seconds. Services use this, not the wall clock, for mechanism deadlines. */
  now(): Promise<number>;

  // ---- read ----
  getIssuer(issuer: Address): Promise<IssuerState | null>;
  listSeries(): Promise<SeriesState[]>;
  getSeries(seriesId: string): Promise<SeriesState | null>;
  getAuction(seriesId: string): Promise<AuctionState | null>;
  getBid(seriesId: string, bidder: Address): Promise<BidState | null>;
  listBids(seriesId: string): Promise<BidState[]>;
  getTreasury(seriesId: string): Promise<TreasuryState | null>;
  getVault(seriesId: string): Promise<VaultState | null>;
  getPosition(seriesId: string, wallet: Address): Promise<PositionState | null>;
  listPositions(seriesId: string): Promise<PositionState[]>;
  getPeriod(seriesId: string, periodId: string): Promise<PeriodState | null>;
  listPeriods(seriesId: string): Promise<PeriodState[]>;
  getRedemption(seriesId: string): Promise<RedemptionState | null>;
  getRateAccumulator(pair: string): Promise<RateAccumulatorState | null>;
  getQuarterRate(pair: string, periodId: string): Promise<QuarterRateState | null>;
  isAllowlisted(wallet: Address): Promise<boolean>;
  listAttestors(): Promise<Address[]>;
  listVerifierKeys(): Promise<{ keyId: string; publicKey: string }[]>;
  getTransferWindow(seriesId: string): Promise<TransferWindowState | null>;
  getCurve(seriesId: string): Promise<CurveState | null>;
  /**
   * Quote a `curveSwap` on a curve series at the current state (moves nothing): the simulator's stand-in pool; the live
   * adapters quote Meteora's pool from S5 (NotImplemented until then).
   */
  quoteCurveSwap(seriesId: string, side: 'buy' | 'sell', amountIn: Money): Promise<CurveSwapQuote>;
  getBalance(wallet: Address, stablecoin: Stablecoin): Promise<Money>;

  // ---- events ----
  /** Read canonical events after `cursor` (null = from the beginning), oldest first. */
  readEvents(cursor: string | null, limit: number): Promise<{ events: DomainEvent[]; nextCursor: string | null }>;

  // ---- write ----
  /**
   * Build an unsigned transaction for a user's wallet (or the admin multisig) to sign. Never signs. A permissionless
   * command may be built for any wallet (a bidder delivering its own bid, or anyone when the keepers stall).
   */
  build(command: UserCommand | AdminCommand | PermissionlessCommand, signer: Address, coSigners?: Address[]): Promise<UnsignedTx>;
  /** Broadcast a user-signed transaction. */
  send(signed: SignedTx): Promise<TxResult>;
  /** Submit a permissionless or service-role transaction signed by the backend's own low-privilege key (`ServiceCommand` covers both). */
  submit(command: ServiceCommand, role: ServiceRole): Promise<TxResult>;
}

/** Anything that can sign an UnsignedTx for a given address (user wallet, test wallet, KMS-backed service key). */
export interface WalletSigner {
  readonly address: Address;
  readonly family: ChainFamily;
  sign(tx: UnsignedTx): Promise<SignedTx>;
  /** Sign an arbitrary message (used for sign-in and for attestor signatures), hex-encoded. */
  signMessage(message: Uint8Array): Promise<string>;
}

export class ChainError extends Error {
  constructor(
    public readonly code: ChainErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ChainError';
  }
}

export type ChainErrorCode =
  | 'NotFound' | 'Unauthorized' | 'NotAllowlisted' | 'WrongPhase' | 'WrongStatus' | 'TooEarly' | 'TooLate' | 'InsufficientFunds'
  | 'InvalidCommitment' | 'InvalidProof' | 'InvalidAttestation' | 'InvalidTerms' | 'WalletCap' | 'Duplicate' | 'Paused'
  | 'NotPermitted' | 'ChainSpecific' | 'NotImplemented';
