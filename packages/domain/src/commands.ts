import { z } from 'zod';
import { addressSchema, hash32Schema, pairSchema, periodIdSchema, seriesIdSchema, stablecoinSchema } from './ids.ts';
import { moneySchema, unitsSchema, wadSchema } from './money.ts';
import { seriesTermsSchema, tierSchema, fxBasisSchema } from './events.ts';

/**
 * Canonical commands (Part D2). User commands are built into unsigned transactions for the user's wallet.
 * Service commands are submitted by the backend's own low-privilege roles (keeper, allowlist manager).
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

/**
 * Signed by the report verifier over `attestationMessage()`: Stage 1's report-attestation fields (series, period,
 * prior and income commitments, tier, liquidity event). The income source never goes onchain (B7).
 */
export const verifierAttestationSchema = z.object({
  keyId: z.string(),
  seriesId: seriesIdSchema,
  periodId: periodIdSchema,
  priorIncomeCommitment: hash32Schema,
  incomeCommitment: hash32Schema,
  tier: tierSchema,
  liquidityEvent: z.boolean(),
  /** hex ed25519 signature over attestationMessage() */
  signature: z.string(),
});
export type VerifierAttestation = z.infer<typeof verifierAttestationSchema>;

/** An attestor-signed fallback rate (C9) — the attestor is a co-signer of the report transaction. */
export const attestorRateSchema = z.object({ attestor: addressSchema, rateWad: wadSchema, pair: pairSchema });

export const userCommands = {
  registerIssuer: z.object({ kind: z.literal('registerIssuer') }),
  createSeries: z.object({ kind: z.literal('createSeries'), terms: seriesTermsSchema, /** simulator/testing only: fixed address for deterministic ids */ seriesAddressHint: z.string().optional() }),
  openRaise: z.object({ kind: z.literal('openRaise'), seriesId: seriesIdSchema, commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  cancelRaise: z.object({ kind: z.literal('cancelRaise'), seriesId: seriesIdSchema }),
  commitBid: z.object({ kind: z.literal('commitBid'), seriesId: seriesIdSchema, commitment: hash32Schema, deposit: moneySchema }),
  revealBid: z.object({ kind: z.literal('revealBid'), seriesId: seriesIdSchema, pricePerUnit: moneySchema, quantity: unitsSchema, salt: hash32Schema }),
  claimRefund: z.object({ kind: z.literal('claimRefund'), seriesId: seriesIdSchema }),
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
    attestation: verifierAttestationSchema.nullable(),
    /** tier 3: attestor co-signs instead of the verifier attesting */
    attestor: addressSchema.nullable(),
    liquidityEvent: z.boolean(),
  }),
  payIn: z.object({ kind: z.literal('payIn'), seriesId: seriesIdSchema, periodId: periodIdSchema, amount: moneySchema }),
  claimPayout: z.object({ kind: z.literal('claimPayout'), seriesId: seriesIdSchema }),
  requestPause: z.object({ kind: z.literal('requestPause'), seriesId: seriesIdSchema, until: z.number().int() }),
  approvePause: z.object({ kind: z.literal('approvePause'), seriesId: seriesIdSchema, until: z.number().int() }),
  redeem: z.object({ kind: z.literal('redeem'), seriesId: seriesIdSchema, maxPricePerUnit: moneySchema }),
  claimRedemption: z.object({ kind: z.literal('claimRedemption'), seriesId: seriesIdSchema }),
  amendTerms: z.object({ kind: z.literal('amendTerms'), seriesId: seriesIdSchema, termsCommitment: hash32Schema, capMultipleWad: wadSchema, attestor: addressSchema }),
  extinguish: z.object({ kind: z.literal('extinguish'), seriesId: seriesIdSchema, attestors: z.array(addressSchema).length(2) }),
  commitWindowOrder: z.object({ kind: z.literal('commitWindowOrder'), seriesId: seriesIdSchema, windowId: z.number().int(), side: z.enum(['buy', 'sell']), commitment: hash32Schema, deposit: moneySchema, units: unitsSchema }),
  revealWindowOrder: z.object({ kind: z.literal('revealWindowOrder'), seriesId: seriesIdSchema, windowId: z.number().int(), side: z.enum(['buy', 'sell']), pricePerUnit: moneySchema, quantity: unitsSchema, salt: hash32Schema }),
  buyCurve: z.object({ kind: z.literal('buyCurve'), seriesId: seriesIdSchema, amountIn: moneySchema, minUnitsOut: unitsSchema }),
  stopIssuance: z.object({ kind: z.literal('stopIssuance') }),
} as const;

export const serviceCommands = {
  settleAuction: z.object({ kind: z.literal('settleAuction'), seriesId: seriesIdSchema }),
  snapshotRate: z.object({ kind: z.literal('snapshotRate'), pair: pairSchema, rateWad: wadSchema, confWad: wadSchema, publishTime: z.number().int(), /** opaque provider update payload (e.g. Pyth VAA) for live chains */ update: z.string().nullable() }),
  crankStatus: z.object({ kind: z.literal('crankStatus'), seriesId: seriesIdSchema }),
  crankBurn: z.object({ kind: z.literal('crankBurn'), seriesId: seriesIdSchema, holders: z.array(addressSchema) }),
  crankPause: z.object({ kind: z.literal('crankPause'), seriesId: seriesIdSchema }),
  openTransferWindow: z.object({ kind: z.literal('openTransferWindow'), seriesId: seriesIdSchema, commitEndsAt: z.number().int(), revealEndsAt: z.number().int() }),
  clearTransferWindow: z.object({ kind: z.literal('clearTransferWindow'), seriesId: seriesIdSchema, windowId: z.number().int() }),
  flagFxFallback: z.object({ kind: z.literal('flagFxFallback'), pair: pairSchema, periodId: periodIdSchema, reason: z.enum(['coverage', 'deviation']) }),
  graduateCurve: z.object({ kind: z.literal('graduateCurve'), seriesId: seriesIdSchema }),
  setAllowlist: z.object({ kind: z.literal('setAllowlist'), wallet: addressSchema, allowed: z.boolean() }),
} as const;

export const adminCommands = {
  registerAttestor: z.object({ kind: z.literal('registerAttestor'), attestor: addressSchema, active: z.boolean() }),
  registerVerifierKey: z.object({ kind: z.literal('registerVerifierKey'), keyId: z.string(), publicKey: z.string(), active: z.boolean() }),
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
export const serviceCommandSchema = z.discriminatedUnion('kind', Object.values(serviceCommands) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'settleAuction'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);
export const adminCommandSchema = z.discriminatedUnion('kind', Object.values(adminCommands) as unknown as [z.ZodObject<{ kind: z.ZodLiteral<'registerAttestor'> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]);

export type UserCommand = { [K in keyof typeof userCommands]: z.infer<(typeof userCommands)[K]> }[keyof typeof userCommands];
export type ServiceCommand = { [K in keyof typeof serviceCommands]: z.infer<(typeof serviceCommands)[K]> }[keyof typeof serviceCommands];
export type AdminCommand = { [K in keyof typeof adminCommands]: z.infer<(typeof adminCommands)[K]> }[keyof typeof adminCommands];
export type RouterCommand = z.infer<(typeof routerCommands)['postSplitReceipt']>;
export type Command = UserCommand | ServiceCommand | AdminCommand | RouterCommand;
export type CommandKind = Command['kind'];
export const userCommandKinds = Object.keys(userCommands) as UserCommand['kind'][];
export const serviceCommandKinds = Object.keys(serviceCommands) as ServiceCommand['kind'][];
export const adminCommandKinds = Object.keys(adminCommands) as AdminCommand['kind'][];

/** The backend's own onchain roles. It never holds user funds (no custody). */
export type ServiceRole = 'keeper' | 'allowlistManager';

export interface UnsignedTx {
  chain: string;
  family: 'solana' | 'evm';
  /** primary signer (fee payer on Solana, msg.sender on EVM) */
  signer: string;
  /** additional required signers (e.g. an attestor on amendTerms/approvePause) */
  coSigners: string[];
  command: Command;
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
