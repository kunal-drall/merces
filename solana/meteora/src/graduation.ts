/**
 * End-to-end DBC graduation flow for a Merces curve-mode series (brief D10 build item 3).
 *
 * Steps (each one is idempotent: it reads the chain first and skips what is already done, and it records
 * what it did in a JSON state file so a crashed run resumes where it stopped):
 *
 *   1. ensureQuoteMint      use the configured USDC mint (or create a 6-decimal mock on devnet/localnet)
 *   2. ensureConfig         `create_config` with Merces as partner (`fee_claimer`, `leftover_receiver`)
 *   3. ensurePool           `initialize_virtual_pool_with_token2022` for the issuer (creator) with a fresh base mint
 *   4. ensureBuyers         fund N test wallets with SOL and quote
 *   5. buyUntilComplete     `swap2` (PartialFill) until `quote_reserve >= migration_quote_threshold`
 *   6. ensureLocker         `create_locker` when the config has locked vesting
 *   7. ensureMigration      `migration_damm_v2` with the DAMM v2 config as remaining account 0 and two position NFT keypairs
 *   8. withdrawMigrationFees `withdraw_migration_fee(1)` for the creator and `(0)` for the partner
 *   9. withdrawLeftover     `withdraw_leftover` (fixed supply) to the partner
 *  10. claimTradingFees     partner (and creator, if any) trading fees; surplus if any
 *  11. report              DAMM v2 pool address, balances, and the exact quote that reached issuer and Merces
 *
 * Program references: PROG = dynamic-bonding-curve/programs/dynamic-bonding-curve/src; SDK = dynamic-bonding-curve-sdk/.../src.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type Signer,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMintLen,
  getTransferFeeConfig,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  DynamicBondingCurveClient,
  deriveBaseKeyForLocker,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveEscrow,
  SwapMode as SdkSwapMode,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MigrationProgress, TokenType, U64_MAX } from "./constants.js";
import { formatQuote } from "./cli.js";
import { hashConfigParameters, type MercesCurveConfig } from "./config.js";
import { getIncludedFeeAmount } from "./math.js";
import { hasLockedVesting, jsonify, toSdkConfigParameters } from "./types.js";
import { readDammV2Pool, readDammV2Position, readPoolProgress, type DammV2PoolSummary, type DammV2PositionSummary, type PoolProgress } from "./state.js";

const big = (x: { toString(): string }): bigint => BigInt(x.toString());
const bn = (x: bigint): BN => new BN(x.toString());

// ---------------------------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------------------------

export interface StoredKeypair {
  publicKey: string;
  /** 64-byte secret key. Test wallets only: the state file is for devnet / local validators. */
  secretKey: number[];
}

export interface GraduationState {
  schema: "merces.meteora.graduation-state/1";
  createdAt: string;
  updatedAt: string;
  rpcUrl: string;
  genesisHash: string;
  configHash: string;
  payer: string;
  issuer: string;
  merces: string;
  quoteMint?: string;
  quoteMintCreatedByUs?: boolean;
  configKeypair?: StoredKeypair;
  config?: string;
  baseMintKeypair?: StoredKeypair;
  baseMint?: string;
  pool?: string;
  buyers: StoredKeypair[];
  firstPositionNftMint?: string;
  secondPositionNftMint?: string;
  dammConfig?: string;
  dammV2Pool?: string;
  /** Quote balances of the issuer and Merces ATAs before anything happened, for the exact-proceeds report. */
  initialQuoteBalances?: { issuer: string; merces: string };
  txs: Record<string, string[]>;
  report?: GraduationReport;
}

export function loadState(path: string): GraduationState | null {
  if (!existsSync(path)) return null;
  const s = JSON.parse(readFileSync(path, "utf8")) as GraduationState;
  if (s.schema !== "merces.meteora.graduation-state/1") throw new Error(`${path}: unknown state schema`);
  return s;
}

export function saveState(path: string, state: GraduationState): void {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function storeKeypair(k: Keypair): StoredKeypair {
  return { publicKey: k.publicKey.toBase58(), secretKey: Array.from(k.secretKey) };
}

export function restoreKeypair(s: StoredKeypair): Keypair {
  const k = Keypair.fromSecretKey(Uint8Array.from(s.secretKey));
  if (k.publicKey.toBase58() !== s.publicKey) throw new Error("stored keypair does not match its public key");
  return k;
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export interface GraduationParticipants {
  /** Pays rent and fees, funds test wallets; also the default Merces wallet. */
  payer: Keypair;
  /** The issuer: `creator` of the pool, receives the creator migration fee and the vesting escrow. */
  issuer: Keypair;
  /** Merces: `fee_claimer` and `leftover_receiver` of the config (partner). Defaults to `payer`. */
  merces: Keypair;
}

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  uri: string;
}

export interface GraduationOptions {
  connection: Connection;
  config: MercesCurveConfig;
  participants: GraduationParticipants;
  statePath: string;
  /** Override the quote mint of the config (devnet USDC is configurable). */
  quoteMint?: PublicKey;
  /** Create a 6-decimal SPL mock USDC with `payer` as mint authority and mint test funds from it. */
  createQuoteMint?: boolean;
  /** Number of test buyer wallets. Default 3. */
  buyers?: number;
  /** Largest single buy, in quote base units. Default: a third of the threshold. */
  maxBuy?: bigint;
  /** DAMM v2 config override (default: the config's `dammConfig`). */
  dammConfig?: PublicKey;
  tokenMetadata?: TokenMetadataInput;
  /** Lamports the DBC pool authority must hold for flash rent before migration (default 0.1 SOL; the SDK tests fund 1 SOL). */
  poolAuthorityMinLamports?: bigint;
  log?: (msg: string) => void;
}

export interface GraduationContext {
  connection: Connection;
  client: DynamicBondingCurveClient;
  config: MercesCurveConfig;
  payer: Keypair;
  issuer: Keypair;
  merces: Keypair;
  statePath: string;
  state: GraduationState;
  quoteMint: PublicKey;
  quoteTokenProgram: PublicKey;
  baseTokenProgram: PublicKey;
  dammConfig: PublicKey;
  tokenMetadata: TokenMetadataInput;
  buyersWanted: number;
  maxBuy: bigint;
  poolAuthorityMinLamports: bigint;
  createQuoteMint: boolean;
  log: (msg: string) => void;
  send: (tx: Transaction, signers: Signer[], label: string) => Promise<string>;
}

export const DEFAULT_TOKEN_METADATA: TokenMetadataInput = {
  name: "Merces HEU (curve)",
  symbol: "HEU",
  uri: "https://merces.example/heu-curve-devnet.json",
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested without a chain)
// ---------------------------------------------------------------------------------------------

/**
 * Split the gross quote needed to complete the curve among `n` buyers with a safety margin, in base units.
 * Gross = X / (1 − fee) rounded up (PROG/state/config.rs:189-201), plus 2% so per-swap fee rounding never
 * leaves the last buyer short; the final buy is a PartialFill and refunds whatever is not needed.
 */
export function planBuyerFunding(config: MercesCurveConfig, n: number): { perBuyer: bigint; total: bigint; gross: bigint } {
  if (n <= 0) throw new Error("need at least one buyer");
  const { included } = getIncludedFeeAmount(config.configParameters.poolFees.baseFee.cliffFeeNumerator, config.configParameters.migrationQuoteThreshold);
  const total = (included * 102n) / 100n;
  const perBuyer = (total + BigInt(n) - 1n) / BigInt(n);
  return { perBuyer, total: perBuyer * BigInt(n), gross: included };
}

/** Gross quote to send in the next PartialFill buy: enough to finish the curve, capped by the buyer's balance and `maxBuy`. */
export function nextBuyAmount(progress: PoolProgress, feeNumerator: bigint, buyerBalance: bigint, maxBuy: bigint): bigint {
  const remainingNet = progress.migrationQuoteThreshold - progress.quoteReserve;
  if (remainingNet <= 0n) return 0n;
  // +1 lamport net and a 1% margin: PartialFill refunds the excess, so overshooting is free
  const { included } = getIncludedFeeAmount(feeNumerator, remainingNet + 1n);
  let amount = included + included / 100n + 1n;
  if (amount > maxBuy) amount = maxBuy;
  if (amount > buyerBalance) amount = buyerBalance;
  return amount;
}

export interface QuoteMintCheck {
  decimals: number;
  tokenProgram: PublicKey;
  extensions: ExtensionType[];
  permissionless: boolean;
  transferFeeZero: boolean;
}

/**
 * Mirror of `validate_quote_mint_with_token_badge` (PROG/utils/token.rs:216-267) on a fetched mint:
 * SPL Token mints always pass; Token-2022 mints need a zero transfer fee and only MetadataPointer/TokenMetadata
 * extensions (anything else needs a Meteora-created token badge).
 */
export function checkQuoteMint(data: Buffer, owner: PublicKey, address: PublicKey): QuoteMintCheck {
  if (owner.equals(TOKEN_PROGRAM_ID)) {
    const mint = unpackMint(address, { data, owner, executable: false, lamports: 0 }, TOKEN_PROGRAM_ID);
    return { decimals: mint.decimals, tokenProgram: TOKEN_PROGRAM_ID, extensions: [], permissionless: true, transferFeeZero: true };
  }
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`quote mint ${address.toBase58()} is not owned by a token program`);
  const mint = unpackMint(address, { data, owner, executable: false, lamports: 0 }, TOKEN_2022_PROGRAM_ID);
  const extensions = mint.tlvData.length > 0 ? getExtensionTypes(mint.tlvData) : [];
  const feeConfig = getTransferFeeConfig(mint);
  const transferFeeZero =
    !feeConfig ||
    (feeConfig.olderTransferFee.transferFeeBasisPoints === 0 &&
      feeConfig.olderTransferFee.maximumFee === 0n &&
      feeConfig.newerTransferFee.transferFeeBasisPoints === 0 &&
      feeConfig.newerTransferFee.maximumFee === 0n);
  const permissionless = extensions.every((e) => e === ExtensionType.MetadataPointer || e === ExtensionType.TokenMetadata);
  return { decimals: mint.decimals, tokenProgram: TOKEN_2022_PROGRAM_ID, extensions, permissionless, transferFeeZero };
}

// ---------------------------------------------------------------------------------------------
// Transaction builders (thin, typed wrappers over the SDK; each returns the tx and its required signers)
// ---------------------------------------------------------------------------------------------

export interface BuiltTx {
  transaction: Transaction;
  signers: Signer[];
  label: string;
}

export async function buildCreateQuoteMintTx(connection: Connection, payer: Keypair, mint: Keypair, decimals = 6): Promise<BuiltTx> {
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mint.publicKey, decimals, payer.publicKey, null, TOKEN_PROGRAM_ID),
  );
  tx.feePayer = payer.publicKey;
  return { transaction: tx, signers: [payer, mint], label: "create mock quote mint" };
}

export async function buildCreateConfigTx(ctx: Pick<GraduationContext, "client" | "config" | "payer" | "merces" | "quoteMint">, configKeypair: Keypair): Promise<BuiltTx> {
  const tx = await ctx.client.partner.createConfig({
    config: configKeypair.publicKey,
    feeClaimer: ctx.merces.publicKey,
    leftoverReceiver: ctx.merces.publicKey,
    quoteMint: ctx.quoteMint,
    payer: ctx.payer.publicKey,
    ...toSdkConfigParameters(ctx.config.configParameters),
  });
  tx.feePayer = ctx.payer.publicKey;
  return { transaction: tx, signers: [ctx.payer, configKeypair], label: "create_config" };
}

export async function buildCreatePoolTx(
  ctx: Pick<GraduationContext, "client" | "payer" | "issuer" | "tokenMetadata">,
  config: PublicKey,
  baseMint: Keypair,
): Promise<BuiltTx> {
  const tx = await ctx.client.creator.createPool({
    name: ctx.tokenMetadata.name,
    symbol: ctx.tokenMetadata.symbol,
    uri: ctx.tokenMetadata.uri,
    payer: ctx.payer.publicKey,
    poolCreator: ctx.issuer.publicKey,
    config,
    baseMint: baseMint.publicKey,
  });
  tx.feePayer = ctx.payer.publicKey;
  return { transaction: tx, signers: [ctx.payer, ctx.issuer, baseMint], label: "initialize_virtual_pool" };
}

export async function buildBuyTx(ctx: Pick<GraduationContext, "client">, pool: PublicKey, buyer: Keypair, amountIn: bigint, minimumAmountOut: bigint): Promise<BuiltTx> {
  const tx = await ctx.client.pool.swap2({
    pool,
    owner: buyer.publicKey,
    payer: buyer.publicKey,
    swapBaseForQuote: false,
    swapMode: SdkSwapMode.PartialFill,
    amountIn: bn(amountIn),
    minimumAmountOut: bn(minimumAmountOut),
    referralTokenAccount: null,
  });
  tx.feePayer = buyer.publicKey;
  return { transaction: tx, signers: [buyer], label: `swap2 PartialFill ${formatQuote(amountIn)} quote` };
}

export async function buildCreateLockerTx(ctx: Pick<GraduationContext, "client" | "payer">, pool: PublicKey): Promise<BuiltTx> {
  const tx = await ctx.client.migration.createLocker({ payer: ctx.payer.publicKey, pool });
  tx.feePayer = ctx.payer.publicKey;
  return { transaction: tx, signers: [ctx.payer], label: "create_locker" };
}

export async function buildMigrateTx(
  ctx: Pick<GraduationContext, "client" | "payer" | "dammConfig">,
  pool: PublicKey,
): Promise<BuiltTx & { firstPositionNftMint: Keypair; secondPositionNftMint: Keypair }> {
  const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await ctx.client.migration.migrateToDammV2({
    payer: ctx.payer.publicKey,
    pool,
    dammConfig: ctx.dammConfig,
  });
  transaction.feePayer = ctx.payer.publicKey;
  return {
    transaction,
    signers: [ctx.payer, firstPositionNftKeypair, secondPositionNftKeypair],
    label: "migration_damm_v2",
    firstPositionNftMint: firstPositionNftKeypair,
    secondPositionNftMint: secondPositionNftKeypair,
  };
}

export async function buildWithdrawMigrationFeeTx(ctx: Pick<GraduationContext, "client" | "payer">, pool: PublicKey, role: "creator" | "partner", sender: Keypair): Promise<BuiltTx> {
  const tx =
    role === "creator"
      ? await ctx.client.creator.creatorWithdrawMigrationFee({ pool, sender: sender.publicKey })
      : await ctx.client.partner.partnerWithdrawMigrationFee({ pool, sender: sender.publicKey });
  tx.feePayer = ctx.payer.publicKey;
  const signers = sender.publicKey.equals(ctx.payer.publicKey) ? [ctx.payer] : [ctx.payer, sender];
  return { transaction: tx, signers, label: `withdraw_migration_fee(${role === "partner" ? 0 : 1})` };
}

export async function buildWithdrawLeftoverTx(ctx: Pick<GraduationContext, "client" | "payer">, pool: PublicKey): Promise<BuiltTx> {
  const tx = await ctx.client.migration.withdrawLeftover({ payer: ctx.payer.publicKey, pool });
  tx.feePayer = ctx.payer.publicKey;
  return { transaction: tx, signers: [ctx.payer], label: "withdraw_leftover" };
}

export async function buildClaimTradingFeeTx(ctx: Pick<GraduationContext, "client" | "payer">, pool: PublicKey, role: "creator" | "partner", claimer: Keypair): Promise<BuiltTx> {
  const max = bn(U64_MAX);
  const tx =
    role === "partner"
      ? await ctx.client.partner.claimPartnerTradingFee({ feeClaimer: claimer.publicKey, payer: ctx.payer.publicKey, pool, maxBaseAmount: max, maxQuoteAmount: max })
      : await ctx.client.creator.claimCreatorTradingFee({ creator: claimer.publicKey, payer: ctx.payer.publicKey, pool, maxBaseAmount: max, maxQuoteAmount: max });
  tx.feePayer = ctx.payer.publicKey;
  const signers = claimer.publicKey.equals(ctx.payer.publicKey) ? [ctx.payer] : [ctx.payer, claimer];
  return { transaction: tx, signers, label: `claim ${role} trading fee` };
}

export async function buildWithdrawSurplusTx(ctx: Pick<GraduationContext, "client" | "payer">, pool: PublicKey, role: "creator" | "partner", who: Keypair): Promise<BuiltTx> {
  const tx =
    role === "partner"
      ? await ctx.client.partner.partnerWithdrawSurplus({ feeClaimer: who.publicKey, pool })
      : await ctx.client.creator.creatorWithdrawSurplus({ creator: who.publicKey, pool });
  tx.feePayer = ctx.payer.publicKey;
  const signers = who.publicKey.equals(ctx.payer.publicKey) ? [ctx.payer] : [ctx.payer, who];
  return { transaction: tx, signers, label: `${role}_withdraw_surplus` };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

async function tokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info || info.data.length < ACCOUNT_SIZE) return 0n;
  return AccountLayout.decode(info.data.subarray(0, ACCOUNT_SIZE)).amount;
}

function ata(mint: PublicKey, owner: PublicKey, program: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, program);
}

export async function createContext(opts: GraduationOptions): Promise<GraduationContext> {
  const log = opts.log ?? (() => {});
  const { payer, issuer, merces } = opts.participants;
  const connection = opts.connection;
  const configHash = hashConfigParameters(opts.config.configParameters);
  const genesisHash = await connection.getGenesisHash();
  let state = loadState(opts.statePath);
  if (state) {
    if (state.configHash !== configHash) throw new Error(`${opts.statePath} was created for another config (hash ${state.configHash}); use a new state file`);
    if (state.genesisHash !== genesisHash) throw new Error(`${opts.statePath} belongs to another cluster (genesis ${state.genesisHash})`);
    if (state.payer !== payer.publicKey.toBase58() || state.issuer !== issuer.publicKey.toBase58() || state.merces !== merces.publicKey.toBase58()) {
      throw new Error(`${opts.statePath} was created with different wallets`);
    }
    log(`resuming from ${opts.statePath}`);
  } else {
    state = {
      schema: "merces.meteora.graduation-state/1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rpcUrl: connection.rpcEndpoint,
      genesisHash,
      configHash,
      payer: payer.publicKey.toBase58(),
      issuer: issuer.publicKey.toBase58(),
      merces: merces.publicKey.toBase58(),
      buyers: [],
      txs: {},
    };
    saveState(opts.statePath, state);
  }
  const quoteMint = state.quoteMint ? new PublicKey(state.quoteMint) : (opts.quoteMint ?? new PublicKey(opts.config.input.quoteMint));
  const dammConfig = opts.dammConfig ?? (state.dammConfig ? new PublicKey(state.dammConfig) : new PublicKey(opts.config.input.dammConfig));
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const ctx: GraduationContext = {
    connection,
    client,
    config: opts.config,
    payer,
    issuer,
    merces,
    statePath: opts.statePath,
    state,
    quoteMint,
    quoteTokenProgram: TOKEN_PROGRAM_ID, // refined by ensureQuoteMint
    baseTokenProgram: opts.config.configParameters.tokenType === TokenType.Token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    dammConfig,
    tokenMetadata: opts.tokenMetadata ?? DEFAULT_TOKEN_METADATA,
    buyersWanted: opts.buyers ?? 3,
    maxBuy: opts.maxBuy ?? opts.config.configParameters.migrationQuoteThreshold / 3n + 1n,
    poolAuthorityMinLamports: opts.poolAuthorityMinLamports ?? LAMPORTS_PER_SOL_BIG / 10n,
    createQuoteMint: opts.createQuoteMint ?? false,
    log,
    send: async (tx, signers, label) => {
      const { sendAndConfirm } = await import("./cli.js");
      return sendAndConfirm(connection, tx, signers, label, { log });
    },
  };
  return ctx;
}

const LAMPORTS_PER_SOL_BIG = BigInt(LAMPORTS_PER_SOL);

function recordTx(ctx: GraduationContext, step: string, sig: string): void {
  (ctx.state.txs[step] ??= []).push(sig);
  saveState(ctx.statePath, ctx.state);
}

export async function ensureQuoteMint(ctx: GraduationContext): Promise<void> {
  const quoteDecimals = ctx.config.input.quoteDecimals;
  if (ctx.createQuoteMint && !ctx.state.quoteMint) {
    const mint = Keypair.generate();
    const built = await buildCreateQuoteMintTx(ctx.connection, ctx.payer, mint, quoteDecimals);
    const sig = await ctx.send(built.transaction, built.signers, built.label);
    ctx.state.quoteMint = mint.publicKey.toBase58();
    ctx.state.quoteMintCreatedByUs = true;
    ctx.quoteMint = mint.publicKey;
    recordTx(ctx, "createQuoteMint", sig);
    ctx.log(`created mock quote mint ${mint.publicKey.toBase58()} (${quoteDecimals} decimals, mint authority = payer)`);
  }
  const info = await ctx.connection.getAccountInfo(ctx.quoteMint, "confirmed");
  if (!info) throw new Error(`quote mint ${ctx.quoteMint.toBase58()} does not exist on this cluster`);
  const check = checkQuoteMint(info.data, info.owner, ctx.quoteMint);
  if (check.decimals !== quoteDecimals) throw new Error(`quote mint has ${check.decimals} decimals, config expects ${quoteDecimals}`);
  if (!check.transferFeeZero) throw new Error("quote mint has a non-zero transfer fee: the program rejects it (QuoteMintHasNonZeroTransferFee)");
  if (!check.permissionless) throw new Error(`quote mint carries Token-2022 extensions ${check.extensions.join(",")}: it needs a Meteora token badge (research memo §8)`);
  ctx.quoteTokenProgram = check.tokenProgram;
  if (!ctx.state.quoteMint) ctx.state.quoteMint = ctx.quoteMint.toBase58();
  if (!ctx.state.initialQuoteBalances) {
    ctx.state.initialQuoteBalances = {
      issuer: (await tokenBalance(ctx.connection, ata(ctx.quoteMint, ctx.issuer.publicKey, ctx.quoteTokenProgram))).toString(),
      merces: (await tokenBalance(ctx.connection, ata(ctx.quoteMint, ctx.merces.publicKey, ctx.quoteTokenProgram))).toString(),
    };
  }
  saveState(ctx.statePath, ctx.state);
  ctx.log(`quote mint ${ctx.quoteMint.toBase58()} ok (${check.tokenProgram.equals(TOKEN_PROGRAM_ID) ? "SPL Token" : "Token-2022"}, ${check.decimals} decimals)`);
}

export async function ensureConfig(ctx: GraduationContext): Promise<PublicKey> {
  if (ctx.state.config) {
    const existing = await ctx.client.state.getPoolConfig(new PublicKey(ctx.state.config));
    if (existing) {
      verifyOnChainConfig(ctx, existing);
      ctx.log(`config ${ctx.state.config} exists; skipping create_config`);
      return new PublicKey(ctx.state.config);
    }
  }
  const configKeypair = ctx.state.configKeypair ? restoreKeypair(ctx.state.configKeypair) : Keypair.generate();
  ctx.state.configKeypair = storeKeypair(configKeypair);
  ctx.state.config = configKeypair.publicKey.toBase58();
  saveState(ctx.statePath, ctx.state);
  const built = await buildCreateConfigTx(ctx, configKeypair);
  const sig = await ctx.send(built.transaction, built.signers, built.label);
  recordTx(ctx, "createConfig", sig);
  const onChain = await ctx.client.state.getPoolConfig(configKeypair.publicKey);
  if (!onChain) throw new Error("config account missing after create_config");
  verifyOnChainConfig(ctx, onChain);
  ctx.log(`config ${configKeypair.publicKey.toBase58()} created; on-chain derivation matches the generator`);
  return configKeypair.publicKey;
}

/** The program must have derived exactly what the generator predicted (PROG process_create_config.rs:564-596). */
export function verifyOnChainConfig(ctx: Pick<GraduationContext, "config" | "merces" | "quoteMint">, onChain: PoolConfig): void {
  const d = ctx.config.derived;
  const p = ctx.config.configParameters;
  const checks: [string, string, string][] = [
    ["migration_quote_threshold", onChain.migrationQuoteThreshold.toString(), p.migrationQuoteThreshold.toString()],
    ["sqrt_start_price", onChain.sqrtStartPrice.toString(), p.sqrtStartPrice.toString()],
    ["migration_sqrt_price", onChain.migrationSqrtPrice.toString(), d.migrationSqrtPrice.toString()],
    ["swap_base_amount", onChain.swapBaseAmount.toString(), d.swapBaseAmount.toString()],
    ["migration_base_threshold", onChain.migrationBaseThreshold.toString(), d.migrationBaseThreshold.toString()],
    ["pre_migration_token_supply", onChain.preMigrationTokenSupply.toString(), p.tokenSupply ? p.tokenSupply.preMigrationTokenSupply.toString() : "0"],
    ["migration_fee_percentage", String(onChain.migrationFeePercentage), String(p.migrationFee.feePercentage)],
    ["creator_migration_fee_percentage", String(onChain.creatorMigrationFeePercentage), String(p.migrationFee.creatorFeePercentage)],
    ["fee_claimer", onChain.feeClaimer.toBase58(), ctx.merces.publicKey.toBase58()],
    ["leftover_receiver", onChain.leftoverReceiver.toBase58(), ctx.merces.publicKey.toBase58()],
    ["quote_mint", onChain.quoteMint.toBase58(), ctx.quoteMint.toBase58()],
    ["token_decimal", String(onChain.tokenDecimal), String(p.tokenDecimal)],
  ];
  const bad = checks.filter(([, a, b]) => a !== b);
  if (bad.length > 0) throw new Error(`on-chain config differs from the generator: ${bad.map(([n, a, b]) => `${n} on-chain=${a} expected=${b}`).join("; ")}`);
}

export async function ensurePool(ctx: GraduationContext, config: PublicKey): Promise<PublicKey> {
  if (ctx.state.pool) {
    const existing = await ctx.client.state.getPool(new PublicKey(ctx.state.pool));
    if (existing) {
      ctx.log(`pool ${ctx.state.pool} exists; skipping initialize_virtual_pool`);
      return new PublicKey(ctx.state.pool);
    }
  }
  const baseMint = ctx.state.baseMintKeypair ? restoreKeypair(ctx.state.baseMintKeypair) : Keypair.generate();
  const pool = deriveDbcPoolAddress(ctx.quoteMint, baseMint.publicKey, config);
  ctx.state.baseMintKeypair = storeKeypair(baseMint);
  ctx.state.baseMint = baseMint.publicKey.toBase58();
  ctx.state.pool = pool.toBase58();
  saveState(ctx.statePath, ctx.state);
  const built = await buildCreatePoolTx(ctx, config, baseMint);
  const sig = await ctx.send(built.transaction, built.signers, built.label);
  recordTx(ctx, "createPool", sig);
  const onChain = await ctx.client.state.getPool(pool);
  if (!onChain) throw new Error("pool account missing after initialize_virtual_pool");
  if (!onChain.poolState.creator.equals(ctx.issuer.publicKey)) throw new Error("pool creator is not the issuer");
  ctx.log(`pool ${pool.toBase58()} created with base mint ${baseMint.publicKey.toBase58()} (creator = issuer ${ctx.issuer.publicKey.toBase58()})`);
  return pool;
}

export async function ensureBuyers(ctx: GraduationContext): Promise<Keypair[]> {
  while (ctx.state.buyers.length < ctx.buyersWanted) ctx.state.buyers.push(storeKeypair(Keypair.generate()));
  saveState(ctx.statePath, ctx.state);
  const buyers = ctx.state.buyers.map(restoreKeypair);
  const { perBuyer } = planBuyerFunding(ctx.config, buyers.length);
  const solPerBuyer = 20_000_000n; // 0.02 SOL: ATAs + swap fees
  for (const buyer of buyers) {
    const ixs = [];
    const lamports = BigInt(await ctx.connection.getBalance(buyer.publicKey, "confirmed"));
    if (lamports < solPerBuyer) ixs.push(SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: buyer.publicKey, lamports: solPerBuyer - lamports }));
    const buyerAta = ata(ctx.quoteMint, buyer.publicKey, ctx.quoteTokenProgram);
    const have = await tokenBalance(ctx.connection, buyerAta);
    if (have < perBuyer) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(ctx.payer.publicKey, buyerAta, buyer.publicKey, ctx.quoteMint, ctx.quoteTokenProgram));
      const need = perBuyer - have;
      if (ctx.state.quoteMintCreatedByUs) {
        ixs.push(createMintToInstruction(ctx.quoteMint, buyerAta, ctx.payer.publicKey, need, [], ctx.quoteTokenProgram));
      } else {
        const payerAta = ata(ctx.quoteMint, ctx.payer.publicKey, ctx.quoteTokenProgram);
        const payerHas = await tokenBalance(ctx.connection, payerAta);
        if (payerHas < need) throw new Error(`payer quote balance ${formatQuote(payerHas)} < ${formatQuote(need)} needed to fund ${buyer.publicKey.toBase58()}; top up the payer's USDC (see DEVNET_RUNBOOK.md)`);
        const { createTransferCheckedInstruction } = await import("@solana/spl-token");
        ixs.push(createTransferCheckedInstruction(payerAta, ctx.quoteMint, buyerAta, ctx.payer.publicKey, need, ctx.config.input.quoteDecimals, [], ctx.quoteTokenProgram));
      }
    }
    if (ixs.length > 0) {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = ctx.payer.publicKey;
      const sig = await ctx.send(tx, [ctx.payer], `fund buyer ${buyer.publicKey.toBase58()}`);
      recordTx(ctx, "fundBuyers", sig);
    }
  }
  ctx.log(`${buyers.length} buyers funded with ${formatQuote(perBuyer)} quote each`);
  return buyers;
}

export async function buyUntilComplete(ctx: GraduationContext, pool: PublicKey, buyers: Keypair[]): Promise<PoolProgress> {
  const feeNumerator = ctx.config.configParameters.poolFees.baseFee.cliffFeeNumerator;
  let progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  let round = 0;
  while (!progress.curveComplete) {
    const buyer = buyers[round % buyers.length]!;
    round++;
    const balance = await tokenBalance(ctx.connection, ata(ctx.quoteMint, buyer.publicKey, ctx.quoteTokenProgram));
    const amount = nextBuyAmount(progress, feeNumerator, balance, ctx.maxBuy);
    if (amount <= 0n) {
      if (round > buyers.length) throw new Error("buyers are out of quote before the curve completed; fund them and re-run");
      continue;
    }
    const built = await buildBuyTx(ctx, pool, buyer, amount, 0n);
    const sig = await ctx.send(built.transaction, built.signers, built.label);
    recordTx(ctx, "swaps", sig);
    progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
    ctx.log(`buy #${round}: ${buyer.publicKey.toBase58().slice(0, 8)} sent ${formatQuote(amount)}; reserve ${formatQuote(progress.quoteReserve)} / ${formatQuote(progress.migrationQuoteThreshold)} (${(progress.progressBps / 100).toFixed(2)}%)`);
    if (round > 10_000) throw new Error("buy loop did not converge");
  }
  ctx.log(`curve complete: quote_reserve ${formatQuote(progress.quoteReserve)}, progress ${progress.migrationProgressName}`);
  return progress;
}

export async function ensureLocker(ctx: GraduationContext, pool: PublicKey): Promise<void> {
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  const needsLocker = hasLockedVesting(ctx.config.configParameters.lockedVesting);
  if (!needsLocker) {
    if (progress.migrationProgress !== MigrationProgress.LockedVesting && progress.migrationProgress !== MigrationProgress.CreatedPool) {
      throw new Error(`expected LockedVesting without a locker step, found ${progress.migrationProgressName}`);
    }
    ctx.log("no locked vesting configured; create_locker not needed");
    return;
  }
  if (progress.migrationProgress >= MigrationProgress.LockedVesting) {
    ctx.log("locker already created; skipping");
    return;
  }
  if (progress.migrationProgress !== MigrationProgress.PostBondingCurve) throw new Error(`cannot create locker in state ${progress.migrationProgressName}`);
  await ensurePoolAuthorityFunded(ctx);
  const built = await buildCreateLockerTx(ctx, pool);
  const sig = await ctx.send(built.transaction, built.signers, built.label);
  recordTx(ctx, "createLocker", sig);
  const after = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (after.migrationProgress !== MigrationProgress.LockedVesting) throw new Error("create_locker did not advance to LockedVesting");
  ctx.log(`locker created for the issuer's ${formatQuote(ctx.config.derived.lockedVestingTotal, ctx.config.input.tokenDecimals)} vested units`);
}

/** `create_locker` and `migration_damm_v2` borrow rent from the pool authority (flash rent, PROG/instructions/migration/flash_rent.rs:6-25). */
export async function ensurePoolAuthorityFunded(ctx: GraduationContext): Promise<void> {
  const authority = deriveDbcPoolAuthority();
  const balance = BigInt(await ctx.connection.getBalance(authority, "confirmed"));
  if (balance >= ctx.poolAuthorityMinLamports) return;
  const top = ctx.poolAuthorityMinLamports - balance;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: ctx.payer.publicKey, toPubkey: authority, lamports: top }));
  tx.feePayer = ctx.payer.publicKey;
  const sig = await ctx.send(tx, [ctx.payer], `fund DBC pool authority with ${formatQuote(top, 9)} SOL for flash rent`);
  recordTx(ctx, "fundPoolAuthority", sig);
}

export async function ensureMigration(ctx: GraduationContext, pool: PublicKey): Promise<PoolProgress> {
  let progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (progress.isMigrated) {
    ctx.log(`already migrated to DAMM v2 pool ${progress.dammV2Pool}; skipping`);
    ctx.state.dammV2Pool = progress.dammV2Pool;
    ctx.state.dammConfig = ctx.dammConfig.toBase58();
    saveState(ctx.statePath, ctx.state);
    return progress;
  }
  if (progress.migrationProgress !== MigrationProgress.LockedVesting) throw new Error(`cannot migrate in state ${progress.migrationProgressName}`);
  const dammConfigInfo = await ctx.connection.getAccountInfo(ctx.dammConfig, "confirmed");
  if (!dammConfigInfo) throw new Error(`DAMM v2 config ${ctx.dammConfig.toBase58()} does not exist on this cluster; pass --damm-config (see DEVNET_RUNBOOK.md)`);
  await ensurePoolAuthorityFunded(ctx);
  const built = await buildMigrateTx(ctx, pool);
  ctx.state.firstPositionNftMint = built.firstPositionNftMint.publicKey.toBase58();
  ctx.state.secondPositionNftMint = built.secondPositionNftMint.publicKey.toBase58();
  ctx.state.dammConfig = ctx.dammConfig.toBase58();
  saveState(ctx.statePath, ctx.state);
  const sig = await ctx.send(built.transaction, built.signers, built.label);
  recordTx(ctx, "migrate", sig);
  progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (!progress.isMigrated) throw new Error("migration_damm_v2 confirmed but the pool is not marked migrated");
  ctx.state.dammV2Pool = progress.dammV2Pool;
  saveState(ctx.statePath, ctx.state);
  ctx.log(`migrated: DAMM v2 pool ${progress.dammV2Pool}`);
  return progress;
}

export async function withdrawMigrationFees(ctx: GraduationContext, pool: PublicKey): Promise<void> {
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (!progress.curveComplete) throw new Error("curve not complete");
  if (progress.migrationFee.creator > 0n && !progress.migrationFee.creatorWithdrawn) {
    const built = await buildWithdrawMigrationFeeTx(ctx, pool, "creator", ctx.issuer);
    recordTx(ctx, "withdrawMigrationFeeCreator", await ctx.send(built.transaction, built.signers, built.label));
    ctx.log(`issuer withdrew the creator migration fee: ${formatQuote(progress.migrationFee.creator)}`);
  } else ctx.log(`creator migration fee: ${formatQuote(progress.migrationFee.creator)} (withdrawn=${progress.migrationFee.creatorWithdrawn}); skipping`);
  if (progress.migrationFee.partner > 0n && !progress.migrationFee.partnerWithdrawn) {
    const built = await buildWithdrawMigrationFeeTx(ctx, pool, "partner", ctx.merces);
    recordTx(ctx, "withdrawMigrationFeePartner", await ctx.send(built.transaction, built.signers, built.label));
    ctx.log(`Merces withdrew the partner migration fee: ${formatQuote(progress.migrationFee.partner)}`);
  } else ctx.log(`partner migration fee: ${formatQuote(progress.migrationFee.partner)} (withdrawn=${progress.migrationFee.partnerWithdrawn}); skipping`);
}

export async function withdrawLeftover(ctx: GraduationContext, pool: PublicKey): Promise<void> {
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (!ctx.config.configParameters.tokenSupply) return ctx.log("dynamic supply: no leftover step");
  if (!progress.isMigrated) throw new Error("withdraw_leftover needs CreatedPool");
  if (progress.leftoverWithdrawn) return ctx.log("leftover already withdrawn; skipping");
  const built = await buildWithdrawLeftoverTx(ctx, pool);
  recordTx(ctx, "withdrawLeftover", await ctx.send(built.transaction, built.signers, built.label));
  ctx.log("leftover base withdrawn to the partner (leftover_receiver)");
}

export async function claimFeesAndSurplus(ctx: GraduationContext, pool: PublicKey): Promise<void> {
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  if (progress.unclaimedFees.partnerQuote > 0n || progress.unclaimedFees.partnerBase > 0n) {
    const built = await buildClaimTradingFeeTx(ctx, pool, "partner", ctx.merces);
    recordTx(ctx, "claimPartnerTradingFee", await ctx.send(built.transaction, built.signers, built.label));
    ctx.log(`Merces claimed partner trading fees: ${formatQuote(progress.unclaimedFees.partnerQuote)} quote`);
  }
  if (progress.unclaimedFees.creatorQuote > 0n || progress.unclaimedFees.creatorBase > 0n) {
    const built = await buildClaimTradingFeeTx(ctx, pool, "creator", ctx.issuer);
    recordTx(ctx, "claimCreatorTradingFee", await ctx.send(built.transaction, built.signers, built.label));
    ctx.log(`issuer claimed creator trading fees: ${formatQuote(progress.unclaimedFees.creatorQuote)} quote`);
  }
  if (progress.surplus.total > 0n) {
    if (!progress.surplus.partnerWithdrawn) {
      const built = await buildWithdrawSurplusTx(ctx, pool, "partner", ctx.merces);
      recordTx(ctx, "partnerWithdrawSurplus", await ctx.send(built.transaction, built.signers, built.label));
    }
    if (!progress.surplus.creatorWithdrawn && ctx.config.configParameters.creatorTradingFeePercentage > 0) {
      const built = await buildWithdrawSurplusTx(ctx, pool, "creator", ctx.issuer);
      recordTx(ctx, "creatorWithdrawSurplus", await ctx.send(built.transaction, built.signers, built.label));
    }
    ctx.log(`surplus ${formatQuote(progress.surplus.total)} withdrawn (80% partner/creator, 20% protocol)`);
  }
}

export interface GraduationReport {
  dammV2Pool: string;
  dbcPool: string;
  config: string;
  baseMint: string;
  quoteMint: string;
  issuer: string;
  merces: string;
  quoteBalances: Record<string, string>;
  baseBalances: Record<string, string>;
  issuerQuoteReceived: string;
  mercesQuoteReceived: string;
  expected: { creatorMigrationFee: string; partnerMigrationFee: string; partnerTradingFee: string; poolQuoteNet: string };
  dammV2: DammV2PoolSummary | null;
  positions: { first: DammV2PositionSummary | null; second: DammV2PositionSummary | null };
  progress: PoolProgress;
}

export async function buildReport(ctx: GraduationContext, pool: PublicKey, buyers: Keypair[]): Promise<GraduationReport> {
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  const baseMint = new PublicKey(progress.baseMint);
  const quoteBalances: Record<string, string> = {};
  const baseBalances: Record<string, string> = {};
  const q = async (owner: PublicKey): Promise<bigint> => tokenBalance(ctx.connection, ata(ctx.quoteMint, owner, ctx.quoteTokenProgram));
  const b = async (owner: PublicKey): Promise<bigint> => tokenBalance(ctx.connection, ata(baseMint, owner, ctx.baseTokenProgram));
  const issuerQuote = await q(ctx.issuer.publicKey);
  const mercesQuote = await q(ctx.merces.publicKey);
  quoteBalances["issuer"] = issuerQuote.toString();
  quoteBalances["merces"] = mercesQuote.toString();
  quoteBalances["dbcQuoteVault"] = (await tokenBalance(ctx.connection, new PublicKey(progress.quoteVault))).toString();
  baseBalances["dbcBaseVault"] = (await tokenBalance(ctx.connection, new PublicKey(progress.baseVault))).toString();
  baseBalances["merces(leftover)"] = (await b(ctx.merces.publicKey)).toString();
  baseBalances["issuer"] = (await b(ctx.issuer.publicKey)).toString();
  for (const buyer of buyers) {
    quoteBalances[`buyer:${buyer.publicKey.toBase58()}`] = (await q(buyer.publicKey)).toString();
    baseBalances[`buyer:${buyer.publicKey.toBase58()}`] = (await b(buyer.publicKey)).toString();
  }
  if (hasLockedVesting(ctx.config.configParameters.lockedVesting)) {
    const escrow = deriveEscrow(deriveBaseKeyForLocker(pool));
    baseBalances["lockerEscrow"] = (await tokenBalance(ctx.connection, ata(baseMint, escrow, ctx.baseTokenProgram))).toString();
  }
  const damm = progress.isMigrated ? await readDammV2Pool(ctx.connection, new PublicKey(progress.dammV2Pool)) : null;
  if (damm) {
    quoteBalances["dammV2QuoteVault"] = damm.tokenBAmount.toString();
    baseBalances["dammV2BaseVault"] = damm.tokenAAmount.toString();
  }
  const first = ctx.state.firstPositionNftMint ? await readDammV2Position(ctx.connection, new PublicKey(ctx.state.firstPositionNftMint)) : null;
  const second = ctx.state.secondPositionNftMint ? await readDammV2Position(ctx.connection, new PublicKey(ctx.state.secondPositionNftMint)) : null;
  const initial = ctx.state.initialQuoteBalances ?? { issuer: "0", merces: "0" };
  const report: GraduationReport = {
    dammV2Pool: progress.dammV2Pool,
    dbcPool: pool.toBase58(),
    config: progress.config,
    baseMint: progress.baseMint,
    quoteMint: progress.quoteMint,
    issuer: ctx.issuer.publicKey.toBase58(),
    merces: ctx.merces.publicKey.toBase58(),
    quoteBalances,
    baseBalances,
    issuerQuoteReceived: (issuerQuote - BigInt(initial.issuer)).toString(),
    mercesQuoteReceived: (mercesQuote - BigInt(initial.merces)).toString(),
    expected: {
      creatorMigrationFee: ctx.config.proceeds.creatorMigrationFee.toString(),
      partnerMigrationFee: ctx.config.proceeds.partnerMigrationFee.toString(),
      partnerTradingFee: ctx.config.proceeds.tradingFees.partner.toString(),
      poolQuoteNet: ctx.config.proceeds.quoteForPoolNet.toString(),
    },
    dammV2: damm,
    positions: { first, second },
    progress,
  };
  ctx.state.report = JSON.parse(JSON.stringify(jsonify(report))) as GraduationReport;
  saveState(ctx.statePath, ctx.state);
  return report;
}

export function formatReport(r: GraduationReport, quoteDecimals = 6, baseDecimals = 6): string {
  const lines: string[] = [];
  lines.push(`=== Merces curve-mode graduation report ===`);
  lines.push(`DBC pool            ${r.dbcPool}`);
  lines.push(`DBC config          ${r.config}`);
  lines.push(`base mint (HEU)     ${r.baseMint}`);
  lines.push(`quote mint          ${r.quoteMint}`);
  lines.push(`DAMM v2 pool        ${r.dammV2Pool}${r.dammV2 ? "" : " (not created yet)"}`);
  lines.push(`issuer              ${r.issuer}  received ${formatQuote(BigInt(r.issuerQuoteReceived), quoteDecimals)} quote (expected creator migration fee ${formatQuote(BigInt(r.expected.creatorMigrationFee), quoteDecimals)})`);
  lines.push(`Merces              ${r.merces}  received ${formatQuote(BigInt(r.mercesQuoteReceived), quoteDecimals)} quote (expected partner migration fee ${formatQuote(BigInt(r.expected.partnerMigrationFee), quoteDecimals)} + trading fees ≈ ${formatQuote(BigInt(r.expected.partnerTradingFee), quoteDecimals)})`);
  if (r.dammV2) {
    lines.push(`DAMM v2 reserves    base ${formatQuote(r.dammV2.tokenAAmount, baseDecimals)}, quote ${formatQuote(r.dammV2.tokenBAmount, quoteDecimals)} (expected pool quote ${formatQuote(BigInt(r.expected.poolQuoteNet), quoteDecimals)}), liquidity ${r.dammV2.liquidity}, permanently locked ${r.dammV2.permanentLockLiquidity}`);
  }
  for (const [k, v] of Object.entries(r.quoteBalances)) lines.push(`quote ${k.padEnd(52)} ${formatQuote(BigInt(v), quoteDecimals)}`);
  for (const [k, v] of Object.entries(r.baseBalances)) lines.push(`base  ${k.padEnd(52)} ${formatQuote(BigInt(v), baseDecimals)}`);
  for (const [name, p] of [
    ["first", r.positions.first],
    ["second", r.positions.second],
  ] as const) {
    if (p) lines.push(`position ${name.padEnd(6)} ${p.position} unlocked ${p.unlockedLiquidity} vested ${p.vestedLiquidity} permanent ${p.permanentLockedLiquidity}`);
  }
  return lines.join("\n");
}

/** Run every step in order. Safe to call again after a failure: completed steps are skipped. */
export async function runGraduation(opts: GraduationOptions): Promise<GraduationReport> {
  const ctx = await createContext(opts);
  await ensureQuoteMint(ctx);
  const config = await ensureConfig(ctx);
  const pool = await ensurePool(ctx, config);
  const progress = await readPoolProgress(ctx.connection, pool, ctx.dammConfig);
  let buyers = ctx.state.buyers.map(restoreKeypair);
  if (progress.curveComplete) {
    ctx.log(`curve already complete (${formatQuote(progress.quoteReserve)} quote in reserve); skipping buyer funding and buys`);
  } else {
    buyers = await ensureBuyers(ctx);
    await buyUntilComplete(ctx, pool, buyers);
  }
  await ensureLocker(ctx, pool);
  await ensureMigration(ctx, pool);
  await withdrawMigrationFees(ctx, pool);
  await withdrawLeftover(ctx, pool);
  await claimFeesAndSurplus(ctx, pool);
  return buildReport(ctx, pool, buyers);
}

/** Helpers re-exported for tests. */
export const _internal = { tokenBalance, ata, getMintLen, ExtensionType };
export type { VirtualPool, PoolConfig };
