/**
 * Read a DBC pool's progress and the post-graduation DAMM v2 pool (brief D10 build item 3, read side).
 *
 * Library: `readPoolProgress`, `readDammV2Pool`, `readDammV2Position`.
 * CLI:     `tsx src/state.ts --cluster devnet --pool <pubkey> [--damm-config <pubkey>] [--json]`
 *
 * Field sources: `PoolState` (PROG/state/virtual_pool.rs:90-160) and `PoolConfig` (PROG/state/config.rs:498-588),
 * fetched through the SDK's `StateService` (SDK services/state.ts:76-143).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  createDammV2Program,
  deriveDammV2PoolAddress,
  derivePositionAddress,
  DynamicBondingCurveClient,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  CREATOR_MIGRATION_FEE_MASK,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  MigrationProgress,
  PARTNER_MIGRATION_FEE_MASK,
  Q128,
} from "./constants.js";
import { formatQuote, boolFlag, logger, optionalFlag, parseArgs, pubkey, requireFlag, resolveRpcUrl } from "./cli.js";
import { getMigrationFeeDistribution, getMigrationQuoteAmount } from "./math.js";
import { jsonify } from "./types.js";

const big = (x: { toString(): string }): bigint => BigInt(x.toString());

export interface PoolProgress {
  pool: string;
  config: string;
  creator: string;
  feeClaimer: string;
  leftoverReceiver: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  tokenDecimal: number;
  migrationProgress: MigrationProgress;
  migrationProgressName: string;
  isMigrated: boolean;
  curveComplete: boolean;
  /** `quote_reserve / migration_quote_threshold` in bps, clamped to 10_000. */
  progressBps: number;
  quoteReserve: bigint;
  migrationQuoteThreshold: bigint;
  baseReserve: bigint;
  /** Base sold so far: initial supply minus base reserve minus base fee buckets. */
  baseSold: bigint;
  swapBaseAmount: bigint;
  migrationBaseThreshold: bigint;
  initialBaseSupply: bigint;
  sqrtPrice: bigint;
  sqrtStartPrice: bigint;
  migrationSqrtPrice: bigint;
  /** Quote base units per whole base unit (10^tokenDecimal). */
  pricePerUnit: { current: bigint; start: bigint; migration: bigint };
  /** SPEC §9 default `P0 = floor(migration_quote_threshold × 10^dec / swap_base_amount)`. */
  p0PerUnit: bigint;
  unclaimedFees: {
    partnerQuote: bigint;
    partnerBase: bigint;
    creatorQuote: bigint;
    creatorBase: bigint;
    protocolQuote: bigint;
    protocolBase: bigint;
  };
  migrationFee: { total: bigint; creator: bigint; partner: bigint; creatorWithdrawn: boolean; partnerWithdrawn: boolean };
  protocolMigrationFee: { quote: bigint; base: bigint };
  surplus: { total: bigint; partnerWithdrawn: boolean; creatorWithdrawn: boolean; protocolWithdrawn: boolean };
  leftoverWithdrawn: boolean;
  finishCurveTimestamp: bigint;
  migrationFeeOption: number;
  dammConfig: string;
  dammV2Pool: string;
}

export const MIGRATION_PROGRESS_NAMES: Readonly<Record<number, string>> = {
  [MigrationProgress.PreBondingCurve]: "PreBondingCurve",
  [MigrationProgress.PostBondingCurve]: "PostBondingCurve",
  [MigrationProgress.LockedVesting]: "LockedVesting",
  [MigrationProgress.CreatedPool]: "CreatedPool",
};

function pricePerUnit(sqrtPrice: bigint, tokenDecimal: number): bigint {
  return (sqrtPrice * sqrtPrice * 10n ** BigInt(tokenDecimal)) / Q128;
}

/** Pure projection of fetched accounts into `PoolProgress` (unit-testable without a connection). */
export function projectPoolProgress(
  pool: PublicKey,
  virtualPool: VirtualPool,
  config: PoolConfig,
  dammConfigOverride?: PublicKey,
): PoolProgress {
  const s = virtualPool.poolState;
  const quoteReserve = big(s.quoteReserve);
  const threshold = big(config.migrationQuoteThreshold);
  const progressBpsRaw = threshold === 0n ? 0n : (quoteReserve * 10_000n) / threshold;
  const migrationFeeOption = config.migrationFeeOption;
  const dammConfig = dammConfigOverride ?? new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption] ?? DAMM_V2_MIGRATION_FEE_ADDRESS[0]!);
  const { fee } = getMigrationQuoteAmount(threshold, config.migrationFeePercentage);
  const dist = getMigrationFeeDistribution(fee, config.creatorMigrationFeePercentage);
  const initialBaseSupply = config.fixedTokenSupplyFlag === 1 ? big(config.preMigrationTokenSupply) : big(config.swapBaseAmount) + big(config.migrationBaseThreshold);
  const baseFees = big(s.partnerBaseFee) + big(s.creatorBaseFee) + big(s.protocolBaseFee);
  const baseReserve = big(s.baseReserve);
  const tokenDecimal = config.tokenDecimal;
  const sqrtPrice = big(s.sqrtPrice);
  const sqrtStartPrice = big(config.sqrtStartPrice);
  const migrationSqrtPrice = big(config.migrationSqrtPrice);
  const swapBaseAmount = big(config.swapBaseAmount);
  const status = s.migrationFeeWithdrawStatus;
  return {
    pool: pool.toBase58(),
    config: s.config.toBase58(),
    creator: s.creator.toBase58(),
    feeClaimer: config.feeClaimer.toBase58(),
    leftoverReceiver: config.leftoverReceiver.toBase58(),
    baseMint: s.baseMint.toBase58(),
    quoteMint: config.quoteMint.toBase58(),
    baseVault: s.baseVault.toBase58(),
    quoteVault: s.quoteVault.toBase58(),
    tokenDecimal,
    migrationProgress: s.migrationProgress as MigrationProgress,
    migrationProgressName: MIGRATION_PROGRESS_NAMES[s.migrationProgress] ?? `unknown(${s.migrationProgress})`,
    isMigrated: s.isMigrated === 1,
    curveComplete: quoteReserve >= threshold,
    progressBps: Number(progressBpsRaw > 10_000n ? 10_000n : progressBpsRaw),
    quoteReserve,
    migrationQuoteThreshold: threshold,
    baseReserve,
    baseSold: initialBaseSupply > baseReserve + baseFees ? initialBaseSupply - baseReserve - baseFees : 0n,
    swapBaseAmount,
    migrationBaseThreshold: big(config.migrationBaseThreshold),
    initialBaseSupply,
    sqrtPrice,
    sqrtStartPrice,
    migrationSqrtPrice,
    pricePerUnit: {
      current: pricePerUnit(sqrtPrice, tokenDecimal),
      start: pricePerUnit(sqrtStartPrice, tokenDecimal),
      migration: pricePerUnit(migrationSqrtPrice, tokenDecimal),
    },
    p0PerUnit: swapBaseAmount === 0n ? 0n : (threshold * 10n ** BigInt(tokenDecimal)) / swapBaseAmount,
    unclaimedFees: {
      partnerQuote: big(s.partnerQuoteFee),
      partnerBase: big(s.partnerBaseFee),
      creatorQuote: big(s.creatorQuoteFee),
      creatorBase: big(s.creatorBaseFee),
      protocolQuote: big(s.protocolQuoteFee),
      protocolBase: big(s.protocolBaseFee),
    },
    migrationFee: {
      total: fee,
      creator: dist.creatorMigrationFee,
      partner: dist.partnerMigrationFee,
      creatorWithdrawn: (status & CREATOR_MIGRATION_FEE_MASK) !== 0,
      partnerWithdrawn: (status & PARTNER_MIGRATION_FEE_MASK) !== 0,
    },
    protocolMigrationFee: { quote: big(s.protocolMigrationQuoteFeeAmount), base: big(s.protocolMigrationBaseFeeAmount) },
    surplus: {
      total: quoteReserve > threshold ? quoteReserve - threshold : 0n,
      partnerWithdrawn: s.isPartnerWithdrawSurplus === 1,
      creatorWithdrawn: s.isCreatorWithdrawSurplus === 1,
      protocolWithdrawn: s.isProtocolWithdrawSurplus === 1,
    },
    leftoverWithdrawn: s.isWithdrawLeftover === 1,
    finishCurveTimestamp: big(s.finishCurveTimestamp),
    migrationFeeOption,
    dammConfig: dammConfig.toBase58(),
    dammV2Pool: deriveDammV2PoolAddress(dammConfig, s.baseMint, config.quoteMint).toBase58(),
  };
}

export async function readPoolProgress(connection: Connection, pool: PublicKey, dammConfig?: PublicKey): Promise<PoolProgress> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const virtualPool = await client.state.getPool(pool);
  if (!virtualPool) throw new Error(`DBC pool not found: ${pool.toBase58()}`);
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error(`DBC config not found: ${virtualPool.poolState.config.toBase58()}`);
  return projectPoolProgress(pool, virtualPool, config, dammConfig);
}

export interface DammV2PoolSummary {
  pool: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  tokenAAmount: bigint;
  tokenBAmount: bigint;
  liquidity: bigint;
  permanentLockLiquidity: bigint;
  sqrtPrice: bigint;
  collectFeeMode: number;
  creator: string;
}

export async function readDammV2Pool(connection: Connection, dammPool: PublicKey): Promise<DammV2PoolSummary | null> {
  const program = createDammV2Program(connection, "confirmed");
  const pool = await program.account.pool.fetchNullable(dammPool);
  if (!pool) return null;
  return {
    pool: dammPool.toBase58(),
    tokenAMint: pool.tokenAMint.toBase58(),
    tokenBMint: pool.tokenBMint.toBase58(),
    tokenAVault: pool.tokenAVault.toBase58(),
    tokenBVault: pool.tokenBVault.toBase58(),
    tokenAAmount: big(pool.tokenAAmount),
    tokenBAmount: big(pool.tokenBAmount),
    liquidity: big(pool.liquidity),
    permanentLockLiquidity: big(pool.permanentLockLiquidity),
    sqrtPrice: big(pool.sqrtPrice),
    collectFeeMode: pool.collectFeeMode,
    creator: pool.creator.toBase58(),
  };
}

export interface DammV2PositionSummary {
  position: string;
  nftMint: string;
  pool: string;
  unlockedLiquidity: bigint;
  vestedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
  feeAPending: bigint;
  feeBPending: bigint;
}

export async function readDammV2Position(connection: Connection, positionNftMint: PublicKey): Promise<DammV2PositionSummary | null> {
  const program = createDammV2Program(connection, "confirmed");
  const address = derivePositionAddress(positionNftMint);
  const position = await program.account.position.fetchNullable(address);
  if (!position) return null;
  return {
    position: address.toBase58(),
    nftMint: positionNftMint.toBase58(),
    pool: position.pool.toBase58(),
    unlockedLiquidity: big(position.unlockedLiquidity),
    vestedLiquidity: big(position.vestedLiquidity),
    permanentLockedLiquidity: big(position.permanentLockedLiquidity),
    feeAPending: big(position.feeAPending),
    feeBPending: big(position.feeBPending),
  };
}

export function describePoolProgress(p: PoolProgress, quoteDecimals = 6): string {
  const lines = [
    `DBC pool          ${p.pool}`,
    `config            ${p.config}`,
    `creator (issuer)  ${p.creator}`,
    `fee claimer       ${p.feeClaimer}`,
    `base mint         ${p.baseMint}`,
    `quote mint        ${p.quoteMint}`,
    `progress          ${p.migrationProgressName} (${p.migrationProgress}); migrated=${p.isMigrated}; curve complete=${p.curveComplete}`,
    `raise             ${formatQuote(p.quoteReserve, quoteDecimals)} / ${formatQuote(p.migrationQuoteThreshold, quoteDecimals)} quote (${(p.progressBps / 100).toFixed(2)}%)`,
    `units sold        ${formatQuote(p.baseSold, p.tokenDecimal)} of ${formatQuote(p.swapBaseAmount, p.tokenDecimal)} on the curve; pool deposit ${formatQuote(p.migrationBaseThreshold, p.tokenDecimal)}`,
    `price / unit      now ${formatQuote(p.pricePerUnit.current, quoteDecimals)}, start ${formatQuote(p.pricePerUnit.start, quoteDecimals)}, migration ${formatQuote(p.pricePerUnit.migration, quoteDecimals)}, P0 ${formatQuote(p.p0PerUnit, quoteDecimals)}`,
    `migration fee     total ${formatQuote(p.migrationFee.total, quoteDecimals)}: creator ${formatQuote(p.migrationFee.creator, quoteDecimals)} (withdrawn=${p.migrationFee.creatorWithdrawn}), partner ${formatQuote(p.migrationFee.partner, quoteDecimals)} (withdrawn=${p.migrationFee.partnerWithdrawn})`,
    `unclaimed fees    partner ${formatQuote(p.unclaimedFees.partnerQuote, quoteDecimals)} quote, creator ${formatQuote(p.unclaimedFees.creatorQuote, quoteDecimals)} quote, protocol ${formatQuote(p.unclaimedFees.protocolQuote, quoteDecimals)} quote`,
    `surplus           ${formatQuote(p.surplus.total, quoteDecimals)} (partner withdrawn=${p.surplus.partnerWithdrawn}, creator withdrawn=${p.surplus.creatorWithdrawn})`,
    `protocol mig fee  ${formatQuote(p.protocolMigrationFee.quote, quoteDecimals)} quote, ${formatQuote(p.protocolMigrationFee.base, p.tokenDecimal)} base`,
    `leftover          withdrawn=${p.leftoverWithdrawn}`,
    `DAMM v2 config    ${p.dammConfig}`,
    `DAMM v2 pool      ${p.dammV2Pool}`,
  ];
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const rpc = resolveRpcUrl(optionalFlag(args, "cluster"), optionalFlag(args, "rpc"));
  const connection = new Connection(rpc, "confirmed");
  const pool = pubkey(requireFlag(args, "pool"), "--pool");
  const dammConfigFlag = optionalFlag(args, "damm-config");
  const progress = await readPoolProgress(connection, pool, dammConfigFlag ? pubkey(dammConfigFlag, "--damm-config") : undefined);
  const damm = progress.isMigrated ? await readDammV2Pool(connection, new PublicKey(progress.dammV2Pool)) : null;
  if (boolFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(jsonify({ progress, dammV2: damm }), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${describePoolProgress(progress)}\n`);
  if (damm) {
    process.stdout.write(
      `DAMM v2 reserves  base ${formatQuote(damm.tokenAAmount, progress.tokenDecimal)}, quote ${formatQuote(damm.tokenBAmount)}, liquidity ${damm.liquidity}, permanently locked ${damm.permanentLockLiquidity}\n`,
    );
  }
}

const isMain = process.argv[1] !== undefined && /state\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    logger()(e instanceof Error ? e.stack ?? e.message : String(e));
    process.exit(1);
  });
}
