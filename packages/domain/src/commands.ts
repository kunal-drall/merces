import { z } from 'zod';
import { addressSchema, hash32Schema, pairSchema, periodIdSchema, seriesIdSchema, stablecoinSchema } from './ids.ts';
import { moneySchema, unitsSchema, wadSchema } from './money.ts';
import { seriesTermsSchema, tierSchema, fxBasisSchema } from './events.ts';
import { attestationSchema, signerAddressSchema } from './signing.ts';

/**
 * Canonical commands (Part D2). User commands are built into unsigned transactions for the user's wallet.
 * Service commands are submitted by the backend's own low-privilege roles (keeper, allowlist manager).
 * Permissionless commands (Stage 1's sealed-bid settlement, holder registration, the Retired burn and a curve's
 * completion, proceeds and census) may be sent by anyone: the keeper `submit`s them, and any wallet may `build` and sign them
 * (self-delivery, or a fallback when the keepers stall).
 * Admin commands are built for the protocol multisig.
 */

/** A decimal string of at most 78 digits: a BN254 field element or smaller (snarkjs encoding). */
const decimalSchema = z.string().regex(/^\d{1,78}$/);

/** A snarkjs Groth16 proof over BN254 (chain-neutral JSON; the adapters encode it for the EVM or Solana verifier). */
export const groth16ProofSchema = z.object({
  pi_a: z.array(decimalSchema).length(3),
  pi_b: z.array(z.array(decimalSchema).length(2)).length(3),
  pi_c: z.array(decimalSchema).length(3),
  protocol: z.literal('groth16'),
  curve: z.literal('bn128'),
}).strict();
export type Groth16ProofJson = z.infer<typeof groth16ProofSchema>;

/**
 * The report proof: Stage 1's ProofOfIncome circuit (Groth16 over BN254) or, in the simulator only, the mock
 * system (a digest over the public inputs, accepted only by a simulator configured with `acceptMockProofs`).
 * `publicInputs` are the circuit's six public signals as decimal strings, in Stage 1's order
 * (`reportPublicInputs` in hashing.ts).
 */
export const reportProofSchema = z.discriminatedUnion('system', [
  z.object({ system: z.literal('groth16-bn254'), proof: groth16ProofSchema, publicInputs: z.array(decimalSchema).length(6) }),
  z.object({ system: z.literal('mock'), proof: z.string(), publicInputs: z.array(decimalSchema).length(6) }),
]);
export type ReportProof = z.infer<typeof reportProofSchema>;

/** An attestor-signed fallback rate (C9) — the attestor is a co-signer of the report transaction. */
export const attestorRateSchema = z.object({ attestor: addressSchema, rateWad: wadSchema, pair: pairSchema });

export const userCommands = {
  registerIssuer: z.object({ kind: z.literal('registerIssuer') }),
  createSeries: z.object({ kind: z.literal('createSeries'), terms: seriesTermsSchema, /** simulator/testing only: fixed address for deterministic ids */ seriesAddressHint: z.string().optional() }),
  /** Stage 1 `open_raise`: the chain sets the commit end to now + `commitDurationSeconds` and the reveal end to the commit end + `revealDurationSeconds` (the series' terms) */
  openRaise: z.object({ kind: z.literal('openRaise'), seriesId: seriesIdSchema }),
  cancelRaise: z.object({ kind: z.literal('cancelRaise'), seriesId: seriesIdSchema }),
  commitBid: z.object({ kind: z.literal('commitBid'), seriesId: seriesIdSchema, commitment: hash32Schema, deposit: moneySchema }),
  revealBid: z.object({ kind: z.literal('revealBid'), seriesId: seriesIdSchema, pricePerUnit: moneySchema, quantity: unitsSchema, salt: hash32Schema }),
  drawRelease: z.object({ kind: z.literal('drawRelease'), seriesId: seriesIdSchema }),
  pauseReleases: z.object({ kind: z.literal('pauseReleases'), seriesId: seriesIdSchema, paused: z.boolean() }),
  submitReport: z.object({
    kind: z.literal('submitReport'),
    seriesId: seriesIdSchema,
    periodId: periodIdSchema,
    tier: tierSchema,
    paymentStable: moneySchema,
    /** the income commitment this report chains from (Stage 1 prior chain; ZERO at a year start) */
    priorIncomeCommitment: hash32Schema,
    incomeCommitment: hash32Schema,
    /* no termsCommitment: the chain proves against the series' live commitment (SPEC §6.2) */
    fxBasis: fxBasisSchema,
    fxAvgWad: wadSchema,
    pair: pairSchema.nullable(),
    attestorRate: attestorRateSchema.nullable(),
    proof: reportProofSchema,
    /**
     * Tier 2: the report verifier key's Stage 1 signature over `MERCES_REPORT_V1` (domain, series key, period, prior and
     * income commitments, tier 2, liquidity flag; `reportDigest`), as the chains take it (Solana `attestation_sig` and
     * `attestation_addr`, income.rs:396-424; EVM `attestationSignature`, MercesIncome.sol:207-228): `signer` must be the
     * address the signature recovers to and a verifier key usable for the period (active, or revoked after the period
     * ended and within the 45-day grace), else InvalidVerifierSignature. The fields are the report's own, never a
     * second copy. Tiers 1 and 4 ignore it, as both chains do; tier 3 is still the attestor's co-signature (`attestor`)
     * until S4 WP9. Builders send null outside tier 2.
     */
    attestation: attestationSchema.nullable(),
    /** tier 3: attestor co-signs instead of the verifier attesting (until S4 WP9 moves it to the REPORT signature) */
    attestor: addressSchema.nullable(),
    liquidityEvent: z.boolean(),
  }),
  payIn: z.object({ kind: z.literal('payIn'), seriesId: seriesIdSchema, periodId: periodIdSchema, amount: moneySchema }),
  /**
   * Stage 1 `claim` (SIM:1268-1282): the holder's net payout (its pending payout) and nothing else: the tail is
   * `claimTail`'s and the final-pool share `claimFinal`'s. HolderNotRegistered for a wallet that is not a registered
   * holder. On a Retired series the holder's balance also burns (also when nothing is paid); on any other status nothing
   * burns. Emits `PayoutClaimed{amount, burnedUnits}` always (0 included), then the burn. A curve series never burns
   * (claims.rs:182-196): it pays what the holder's stake earned, and on an extinguished series that did not redeem its
   * final-pool share too (the settlement credits it into the pending payout).
   */
  claimPayout: z.object({ kind: z.literal('claimPayout'), seriesId: seriesIdSchema }),
  /**
   * Stage 1 `claim_tail` (SIM:1403-1417): the tail on the holder's redeemed units since its tail cursor. NotRedeemed
   * before the issuer redeemed, HolderNotRegistered for a wallet that is not a registered holder; a holder that has not
   * redeemed and still has units is redeemed first (the redemption body), then NoRedeemedUnits if it has still redeemed
   * nothing. Emits `TailClaimed` (the tail only; 0 included). A curve series redeems nothing here (claims.rs:365-391):
   * the tail is paid on the units the holder tendered (NoRedeemedUnits without a tender), and its pending payout goes out
   * first as `PayoutClaimed{burnedUnits: 0}` (only when above 0).
   */
  claimTail: z.object({ kind: z.literal('claimTail'), seriesId: seriesIdSchema }),
  /**
   * Stage 1 `claim_final` (SIM:1449-1475): the holder's pending payout and its share of the final pool, once.
   * TerminalStatus unless the series is Extinguished; a pending auction bid is delivered first; HolderNotRegistered.
   * On a series that redeemed, the holder's remaining units are redeemed first and its share is weighed on its redeemed
   * units, otherwise on its accrual units. Emits `FinalClaimed{units: weight, amount}` (0 included), then burns the
   * holder's remaining units. A curve series burns nothing and redeems nothing here (claims.rs:424-452): the weight is the
   * holder's tendered units on a series that redeemed, otherwise its stake, whose share the settlement already credited
   * into the pending payout.
   */
  claimFinal: z.object({ kind: z.literal('claimFinal'), seriesId: seriesIdSchema }),
  requestPause: z.object({ kind: z.literal('requestPause'), seriesId: seriesIdSchema, until: z.number().int() }),
  approvePause: z.object({ kind: z.literal('approvePause'), seriesId: seriesIdSchema, until: z.number().int() }),
  redeem: z.object({ kind: z.literal('redeem'), seriesId: seriesIdSchema, maxPricePerUnit: moneySchema }),
  claimRedemption: z.object({ kind: z.literal('claimRedemption'), seriesId: seriesIdSchema }),
  amendTerms: z.object({ kind: z.literal('amendTerms'), seriesId: seriesIdSchema, termsCommitment: hash32Schema, capMultipleWad: wadSchema, attestor: addressSchema }),
  extinguish: z.object({ kind: z.literal('extinguish'), seriesId: seriesIdSchema, attestors: z.array(addressSchema).length(2) }),
  commitWindowOrder: z.object({ kind: z.literal('commitWindowOrder'), seriesId: seriesIdSchema, windowId: z.number().int(), side: z.enum(['buy', 'sell']), commitment: hash32Schema, deposit: moneySchema, units: unitsSchema }),
  revealWindowOrder: z.object({ kind: z.literal('revealWindowOrder'), seriesId: seriesIdSchema, windowId: z.number().int(), side: z.enum(['buy', 'sell']), pricePerUnit: moneySchema, quantity: unitsSchema, salt: hash32Schema }),
  /**
   * A trade on a curve series' bonding curve (curve mode, Solana only). On a live chain it is a Meteora DBC swap
   * (`swap2`) the wallet sends straight to Meteora's program, not a Merces instruction; the simulator runs a labelled
   * stand-in pool (S3; Meteora's own venue in S5). `buy`: `amountIn` stablecoin, the trading fee included, for base
   * lamports (the last buy before the curve fills takes the rest of the curve and is charged only what that costs).
   * `sell`: `amountIn` base lamports back into the curve, before it fills only, for stablecoin less the trading fee.
   * Fewer than `minimumAmountOut` out refuses the trade. No allowlist and no cap: any wallet trades any amount. Emits
   * no Merces event.
   */
  curveSwap: z.object({ kind: z.literal('curveSwap'), seriesId: seriesIdSchema, side: z.enum(['buy', 'sell']), amountIn: moneySchema, minimumAmountOut: moneySchema }),
  /**
   * Stage 1 `stake_units` (curve.rs:1250-1313), curve mode: moves `units` base lamports from the holder's wallet into the
   * series' stake vault; on a curve series only staked units earn, from the moment they are staked (the holder is
   * settled at its old stake first). NotCurveMode, RaiseNotOpen (Open or Settled), TerminalStatus (the stored status
   * Retired, Redeemed or Extinguished), ZeroUnits, NotAllowlisted (the wallet must be allowlisted now),
   * StakeExceedsOutstanding (the stakes may not pass the last census: take a census first), HolderNotRegistered.
   * Emits `UnitsStaked`.
   */
  stakeUnits: z.object({ kind: z.literal('stakeUnits'), seriesId: seriesIdSchema, units: unitsSchema }),
  /**
   * Stage 1 `unstake_units` (curve.rs:1338-1383), curve mode, in any status and with no allowlist check: settles the
   * holder (what its stake earned, and the final-pool share of an extinguished series that did not redeem, go into its
   * pending payout) and returns `units` base lamports from the stake vault to its wallet. It pays no stablecoin: the
   * pending payout is `claimPayout`'s (or `claimFinal`'s), at any time later. NotCurveMode, ZeroUnits,
   * InsufficientStake, HolderNotRegistered. Emits `UnitsUnstaked`.
   */
  unstakeUnits: z.object({ kind: z.literal('unstakeUnits'), seriesId: seriesIdSchema, units: unitsSchema }),
  /**
   * Stage 1 `tender_units(from_stake, from_wallet)` (curve.rs:1426-1528), a curve series' redemption: a registered
   * holder burns `fromStake` staked and `fromWallet` wallet base lamports and is paid `floor(P_redeem × units / 10^6)`
   * plus its pending payout from the redemption deposit. Staked units are reserved for their holders; wallet units share
   * what is left of the units counted at redemption (`unitsAtRedemption − tendered − staked`). No allowlist check.
   * NotCurveMode, NotRedeemed, ZeroUnits, InsufficientStake, TenderQuotaExhausted, HolderNotRegistered. Emits
   * `PayoutClaimed{burnedUnits: 0}` for the pending payout (only when above 0), `UnitsBurned{redemption}` and
   * `RedemptionClaimed{units, amount: principal, fromStake}`.
   */
  tenderUnits: z.object({ kind: z.literal('tenderUnits'), seriesId: seriesIdSchema, fromStake: unitsSchema, fromWallet: unitsSchema }),
  stopIssuance: z.object({ kind: z.literal('stopIssuance') }),
} as const;

export const serviceCommands = {
  snapshotRate: z.object({ kind: z.literal('snapshotRate'), pair: pairSchema, rateWad: wadSchema, confWad: wadSchema, publishTime: z.number().int(), /** opaque provider update payload (e.g. Pyth VAA) for live chains */ update: z.string().nullable() }),
  crankStatus: z.object({ kind: z.literal('crankStatus'), seriesId: seriesIdSchema }),
  crankPause: z.object({ kind: z.literal('crankPause'), seriesId: seriesIdSchema }),
  openTransferWindow: z.object({ kind: z.literal('openTransferWindow'), seriesId: seriesIdSchema, commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  clearTransferWindow: z.object({ kind: z.literal('clearTransferWindow'), seriesId: seriesIdSchema, windowId: z.number().int() }),
  flagFxFallback: z.object({ kind: z.literal('flagFxFallback'), pair: pairSchema, periodId: periodIdSchema, reason: z.enum(['coverage', 'deviation']) }),
  setAllowlist: z.object({ kind: z.literal('setAllowlist'), wallet: addressSchema, allowed: z.boolean() }),
} as const;

/**
 * Stage 1's sealed-bid settlement (SPEC §5.2), holder registration, the Retired burn and a curve's completion,
 * proceeds and census, with Stage 1's names. Anyone may send them: the keeper `submit`s them and any wallet may `build` them. `nextSettlementStep` (settlement.ts) plans
 * the settlement steps.
 */
export const permissionlessCommands = {
  /** Stage 1 `begin_settlement`: proposes a clearing price with the proposer's tally claims; starts the next round */
  beginSettlement: z.object({ kind: z.literal('beginSettlement'), seriesId: seriesIdSchema, clearingPrice: moneySchema, qAboveClaim: unitsSchema, qAtClaim: unitsSchema }),
  /**
   * Stage 1 `tally_bids`: tallies the next page of revealed bids not yet tallied this round, in reveal order, at most
   * `min(maxBids, ChainInfo.limits.tallyPageMax)` of them (a page that overlaps tallied bids is harmless)
   */
  tallyBids: z.object({ kind: z.literal('tallyBids'), seriesId: seriesIdSchema, maxBids: z.number().int().min(1).optional() }),
  /** Stage 1 `finalize_settlement`: settles, fails or rejects the round once every revealed bid is tallied */
  finalizeSettlement: z.object({ kind: z.literal('finalizeSettlement'), seriesId: seriesIdSchema }),
  /** Stage 1 `process_bid`: moves a bid's cost and fee to protocol accounts and records what the bidder is owed */
  processBid: z.object({ kind: z.literal('processBid'), seriesId: seriesIdSchema, bidder: addressSchema }),
  /** Stage 1 `deliver_bid`: pays a processed bid's refund and units to the bidder */
  deliverBid: z.object({ kind: z.literal('deliverBid'), seriesId: seriesIdSchema, bidder: addressSchema }),
  /**
   * Stage 1 `register_holder`: registers an allowlisted wallet as a holder of the series (idempotent). On a curve series
   * it is the only way a holder registers (nothing registers buyers or stakers on their own, claims.rs:35-45), and a
   * holder must be registered to stake, unstake, tender and claim
   */
  registerHolder: z.object({ kind: z.literal('registerHolder'), seriesId: seriesIdSchema, wallet: addressSchema }),
  /**
   * Stage 1 `burn_retired` (SIM:624-636): burns a holder's balance on a Retired series. TerminalStatus unless the stored
   * status is Retired; a wallet holding no units emits `UnitsBurned{units: 0}` before any registration check (also a
   * wallet that never held any); otherwise HolderNotRegistered, then the holder is settled (its pending payout stays
   * claimable) and its balance burns.
   */
  burnRetired: z.object({ kind: z.literal('burnRetired'), seriesId: seriesIdSchema, holder: addressSchema }),
  /**
   * Stage 1 `complete_curve` (curve.rs:861-906): once the curve's pool has filled (its quote reserve reached the target
   * and it has a finish time), settles the curve raise at that finish time with the price and units fixed at creation;
   * the units are final at once. NotCurveMode, RaiseNotOpen, CurveNotComplete. Takes no census and registers nobody.
   * Emits `CurveGraduated` (Stage 1 `RaiseSettled`, proceeds 0) and `RaiseMintFinalized{proceeds: 0}`.
   */
  completeCurve: z.object({ kind: z.literal('completeCurve'), seriesId: seriesIdSchema }),
  /**
   * Stage 1 `collect_curve_proceeds` (curve.rs:1112-1214), idempotent: once the pool has filled, the partner migration
   * fee and the partner surplus move into the series treasury (each once); at any time the partner trading fee moves to
   * the fee collector. NotCurveMode, RaiseNotOpen (Open or Settled). Emits `CurveProceedsCollected`, then
   * `TreasuryFunded` and `FeeTaken{curveTrading}` when they are above 0.
   */
  collectCurveProceeds: z.object({ kind: z.literal('collectCurveProceeds'), seriesId: seriesIdSchema }),
  /**
   * Stage 1 `sync_curve_units` (curve.rs:936-963), the curve's census: units outstanding = the unit mint's supply less
   * the base lamports in protocol accounts (the DBC pool's base vault, the DAMM v2 pool's base vault, the locker escrow
   * and the leftover receiver; the stake vault is the holders'). The census is the vault's N, the bound on the stakes
   * and the report proof's public input: a report needs one taken after its period ended (CurveUnitsNotSynced). Anyone
   * may send it at any time. NotCurveMode, RaiseNotOpen (Open or Settled), TerminalStatus (the stored status Retired,
   * Redeemed or Extinguished), CurveUnitsBelowStake when the count falls below the stakes. Emits `CurveUnitsSynced`.
   */
  syncCurveUnits: z.object({ kind: z.literal('syncCurveUnits'), seriesId: seriesIdSchema }),
} as const;

export const adminCommands = {
  /**
   * Stage 1 `register_attestor` / `registerAttestor` (merces_registry lib.rs:218-236; MercesRegistry.sol:287-289, :315-329;
   * SIM:535-536): the admin registers (or re-activates) an attestor key; `revokedAt` returns to 0. A zero address is
   * refused (`ZeroAttestorAddress` on Solana, `ZeroAddress` on the EVM). Registering a key that is already active
   * re-emits `AttestorRegistered` on Solana and changes nothing, and reverts `KeyAlreadyActive` on the EVM: each
   * simulator personality behaves as its chain does (S4 D9). Emits `AttestorRegistered`.
   */
  registerAttestor: z.object({ kind: z.literal('registerAttestor'), attestor: addressSchema }),
  /**
   * Stage 1 `revoke_attestor` / `revokeAttestor` (lib.rs:238-260; MercesRegistry.sol:291-295, :331-345; SIM:538-539):
   * forward-only revocation (SPEC §1.4): the key stops being active and `revokedAt` = now. Report and FX signatures of a
   * period that ended at or before `revokedAt` stay valid for `KEY_GRACE_SECONDS` (45 days); every other signature
   * needs an active key. Refused for a key that is not active (`KeyAlreadyRevoked`, or Anchor's `AccountNotInitialized`
   * for a key never registered, on Solana; `KeyNotRegistered` on the EVM) and for the last active attestor key
   * (`LastKeyOfKind` on Solana, `LastActiveKey` on the EVM). Stage 1's reference simulator has no last-key rule; both
   * chains do, and ours follows them (DIV-S1I-2). Emits `AttestorRevoked`.
   */
  revokeAttestor: z.object({ kind: z.literal('revokeAttestor'), attestor: addressSchema }),
  /**
   * Replace one attestor key with another in one transaction: register `to`, then revoke `from` (EVM `rotateAttestor`,
   * MercesRegistry.sol:297-300; Solana has no rotate instruction, so its adapter sends `register_attestor(to)` and
   * `revoke_attestor(from)` as two instructions of one transaction, S5). Either both apply or neither: a refused revoke
   * undoes the registration. Each step keeps its chain's rules (the EVM refuses a `to` that is already active).
   */
  rotateAttestor: z.object({ kind: z.literal('rotateAttestor'), from: addressSchema, to: addressSchema }),
  /**
   * Stage 1 `register_verifier_key` / `registerVerifierKey` (merces_registry lib.rs:262-279; MercesRegistry.sol:302-304,
   * :315-329; SIM:541-542): the admin registers (or re-activates) a report verifier key, a secp256k1 key's 20-byte
   * address (S4 D10); `revokedAt` returns to 0. The attestor key's rules, each personality as its chain (S4 D9): a zero
   * address is `ZeroAttestorAddress` on Solana (its verifier path reuses the attestor's name) and `ZeroAddress` on the
   * EVM; an active key re-emits `VerifierKeyRegistered` on Solana and reverts `KeyAlreadyActive` on the EVM. Emits
   * `VerifierKeyRegistered`.
   */
  registerVerifierKey: z.object({ kind: z.literal('registerVerifierKey'), key: signerAddressSchema }),
  /**
   * Stage 1 `revoke_verifier_key` / `revokeVerifierKey` (lib.rs:281-302; MercesRegistry.sol:306-308, :331-345;
   * SIM:544-545): forward-only (SPEC §1.4). A tier-2 report attestation of a period that ended at or before `revokedAt`
   * stays valid until `revokedAt + KEY_GRACE_SECONDS`. Refused for a key that is not active (`KeyAlreadyRevoked` or
   * `AccountNotInitialized` on Solana, `KeyNotRegistered` on the EVM) and for the last active verifier key
   * (`LastKeyOfKind` / `LastActiveKey`; Stage 1's reference has no such rule, DIV-S1I-2). Emits `VerifierKeyRevoked`.
   */
  revokeVerifierKey: z.object({ kind: z.literal('revokeVerifierKey'), key: signerAddressSchema }),
  /**
   * Replace one verifier key with another in one transaction: register `to`, then revoke `from` (EVM
   * `rotateVerifierKey`, MercesRegistry.sol:310-313; Solana sends the two instructions in one transaction, S5). Either
   * both apply or neither.
   */
  rotateVerifierKey: z.object({ kind: z.literal('rotateVerifierKey'), from: signerAddressSchema, to: signerAddressSchema }),
  pauseNewRaises: z.object({ kind: z.literal('pauseNewRaises'), paused: z.boolean() }),
  setFeeCollector: z.object({ kind: z.literal('setFeeCollector'), feeCollector: addressSchema }),
  /** tier-1 router registration: which router address may post SplitReceipts for a series */
  registerSplitRouter: z.object({ kind: z.literal('registerSplitRouter'), seriesId: seriesIdSchema, router: addressSchema }),
} as const;

/** Tier-1 routers are contracts; in the simulator this is the only way a split receipt enters. */
export const routerCommands = {
  postSplitReceipt: z.object({ kind: z.literal('postSplitReceipt'), seriesId: seriesIdSchema, amount: moneySchema }),
} as const;

export const userCommandSchema = z.discriminatedUnion('kind', Object.values(userCommands) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'registerIssuer'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);
export const permissionlessCommandSchema = z.discriminatedUnion('kind', Object.values(permissionlessCommands) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'beginSettlement'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);
/** What `ChainPort.submit` accepts: the service group and the permissionless group (each command is defined once). */
export const serviceCommandSchema = z.discriminatedUnion('kind', [...Object.values(serviceCommands), ...Object.values(permissionlessCommands)] as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'snapshotRate'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);
export const adminCommandSchema = z.discriminatedUnion('kind', Object.values(adminCommands) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'registerAttestor'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);

export type UserCommand = { [K in keyof typeof userCommands]: z.infer<(typeof userCommands)[K]> }[keyof typeof userCommands];
export type PermissionlessCommand = { [K in keyof typeof permissionlessCommands]: z.infer<(typeof permissionlessCommands)[K]> }[keyof typeof permissionlessCommands];
/** A command the backend submits with its own key (`ChainPort.submit`): a service-role command or a permissionless one. */
export type ServiceCommand = { [K in keyof typeof serviceCommands]: z.infer<(typeof serviceCommands)[K]> }[keyof typeof serviceCommands] | PermissionlessCommand;
export type AdminCommand = { [K in keyof typeof adminCommands]: z.infer<(typeof adminCommands)[K]> }[keyof typeof adminCommands];
export type RouterCommand = z.infer<(typeof routerCommands)['postSplitReceipt']>;
export type Command = UserCommand | ServiceCommand | AdminCommand | RouterCommand;
export type CommandKind = Command['kind'];
export const userCommandKinds = Object.keys(userCommands) as UserCommand['kind'][];
/** the service-role group only; `permissionlessCommandKinds` lists the rest of what `submit` accepts */
export const serviceCommandKinds = Object.keys(serviceCommands) as Exclude<ServiceCommand, PermissionlessCommand>['kind'][];
export const permissionlessCommandKinds = Object.keys(permissionlessCommands) as PermissionlessCommand['kind'][];
export const adminCommandKinds = Object.keys(adminCommands) as AdminCommand['kind'][];

/** Every command group, each command listed once, for the generated docs, the JSON schema and the interface diff. */
export const commandGroups = [
  { title: 'User commands', commands: userCommands },
  { title: 'Service commands (keeper / allowlist manager)', commands: serviceCommands },
  { title: 'Permissionless commands (keeper `submit` or any wallet `build`)', commands: permissionlessCommands },
  { title: 'Admin commands (multisig)', commands: adminCommands },
  { title: 'Router commands', commands: routerCommands },
] as const;

/** The backend's own onchain roles. It never holds user funds (no custody). */
export type ServiceRole = 'keeper' | 'allowlistManager';

/** What `ChainPort.build` builds for a wallet to sign: a user, permissionless or admin command. */
export type BuildableCommand = UserCommand | AdminCommand | PermissionlessCommand;

export interface UnsignedTx {
  chain: string;
  family: 'solana' | 'evm';
  /** primary signer (fee payer on Solana, msg.sender on EVM) */
  signer: string;
  /** additional required signers (e.g. an attestor on amendTerms/approvePause) */
  coSigners: string[];
  /** the transaction's command; for a transaction that carries several (`commands`), the first */
  command: Command;
  /**
   * Every command of a transaction built from an ordered list (`ChainPort.build` with a list; owner direction of
   * 2026-10-10), in order: the chain executes them all or none (one transaction, one rollback; the Solana adapter packs
   * their instructions into one transaction). Absent on a transaction of one command.
   */
  commands?: Command[];
  /** chain-specific serialised transaction: base64 Solana message, or EVM {to,data,value,chainId} JSON. Simulator: JSON of the command. */
  payload: string;
  encoding: 'simulator-json' | 'solana-base64' | 'evm-json';
  summary: string;
  /** unix seconds after which the tx should be rebuilt (blockhash expiry etc.) */
  expiresAt: number | null;
}

export interface SignedTx {
  tx: UnsignedTx;
  /** signatures keyed by signer address; format is chain-specific */
  signatures: Record<string, string>;
}

export interface TxResult {
  txId: string;
  /** chain time at inclusion */
  blockTime: number;
  blockRef: string;
  /** events emitted by this transaction, already in canonical form (the simulator fills this; live adapters may leave it empty and rely on the event stream) */
  events: import('./events.ts').DomainEvent[];
}
