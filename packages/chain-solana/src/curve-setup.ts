import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  DAMM_V2_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDammV2PoolAuthority, deriveDammV2EventAuthority,
  deriveDammV2MigrationMetadataAddress, deriveDammV2PoolAddress, deriveDammV2TokenVaultAddress,
  derivePositionAddress, derivePositionNftAccount, deriveDbcPoolAuthority, deriveEscrow, deriveBaseKeyForLocker,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { configParametersFromJson, toSdkConfigParameters } from '@merces/meteora/src/types.ts';
import { validateDbcConfigParameters } from '@merces/meteora/src/validate.ts';
import { ChainError, type Command } from '@merces/domain';
import { pda, TOKEN, TOKEN_2022 } from './accounts.ts';
import { b, n, SolanaReads } from './reads.ts';
import type { SolanaCurve } from './curve.ts';
import type { SolPlan } from './commands.ts';

type SetupCommand = Extract<Command, {kind:'createCurveConfig'|'createCurvePool'}>;
export async function planCurveSetup(curve: SolanaCurve, cmd: SetupCommand, signer: string): Promise<SolPlan> {
  await curve.transport.verifyNetwork();
  const reads = new SolanaReads(curve.config, curve.transport, (await curve.transport.head()).time);
  const series = await reads.s(cmd.seriesId);
  if (!series || n(series.mode) !== 1 || n(series.raise_state) !== 0) throw new ChainError('WrongPhase', 'curve setup requires a draft curve series');
  if (series.issuer !== signer) throw new ChainError('Unauthorized', 'only the issuer creates this curve');
  if (series.stablecoin !== curve.config.stablecoins.USDC) throw new ChainError('InvalidTerms', 'curve setup requires the configured test USDC');
  const authority = new PublicKey(pda(reads.protocol, 'curve_authority', reads.address(cmd.seriesId)));
  const payer = new PublicKey(signer), config = new PublicKey(cmd.config);
  if (cmd.kind === 'createCurveConfig') {
    if (await curve.transport.raw(cmd.config)) throw new ChainError('WrongPhase', 'configuration already exists; continue with pool creation');
    // The issuer generates public curve parameters locally; raw income never enters the command.
    const parameters = configParametersFromJson(cmd.parameters as Parameters<typeof configParametersFromJson>[0]);
    const derived = validateDbcConfigParameters(parameters);
    if (parameters.migrationQuoteThreshold !== b(series.min_raise) || derived.swapBaseAmount !== b(series.units_offered) * 1000000n)
      throw new ChainError('InvalidTerms', 'curve threshold or supply differs from signed terms');
    const startPrice = parameters.sqrtStartPrice * parameters.sqrtStartPrice * 1000000n / (1n << 128n);
    if (startPrice !== b(series.reserve_price)) throw new ChainError('InvalidTerms', 'curve starting price differs from signed terms');
    if (parameters.migrationOption !== 1 || parameters.tokenType !== 1 || parameters.tokenDecimal !== 6 || !parameters.tokenSupply
      || parameters.tokenUpdateAuthority !== 1 || parameters.creatorTradingFeePercentage !== 0
      || parameters.migrationFee.feePercentage !== 99 || parameters.migrationFee.creatorFeePercentage !== 0
      || parameters.creatorLiquidityPercentage !== 0 || parameters.creatorPermanentLockedLiquidityPercentage !== 0
      || parameters.creatorLiquidityVestingInfo.vestingPercentage !== 0 || parameters.partnerPermanentLockedLiquidityPercentage !== 100)
      throw new ChainError('InvalidTerms', 'curve configuration differs from the Merces treasury route');
    const tx = await curve.client.partner.createConfig({config, payer, feeClaimer: authority, leftoverReceiver: authority,
      quoteMint: new PublicKey(String(series.stablecoin)), ...toSdkConfigParameters(parameters)});
    return {instructions: tx.instructions};
  }
  const rawConfig = await curve.transport.raw(cmd.config);
  if (!rawConfig?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw new ChainError('InvalidTerms', 'configuration has an unexpected owner');
  const cfg = await curve.client.state.getPoolConfig(config);
  if (!cfg || !cfg.quoteMint.equals(new PublicKey(String(series.stablecoin))) || !cfg.feeClaimer.equals(authority)
    || !cfg.leftoverReceiver.equals(authority) || cfg.creatorMigrationFeePercentage !== 0
    || cfg.migrationQuoteThreshold.toString() !== String(series.min_raise)
    || cfg.swapBaseAmount.toString() !== String(b(series.units_offered)*1000000n) || cfg.migrationOption!==1
    || cfg.tokenType!==1 || cfg.tokenDecimal!==6 || cfg.fixedTokenSupplyFlag!==1 || cfg.tokenUpdateAuthority!==1
    || cfg.creatorTradingFeePercentage!==0 || cfg.migrationFeePercentage!==99
    || cfg.creatorLiquidityPercentage!==0 || cfg.creatorPermanentLockedLiquidityPercentage!==0
    || cfg.creatorLiquidityVestingInfo.vestingPercentage!==0 || cfg.partnerPermanentLockedLiquidityPercentage!==100
    || BigInt(cfg.sqrtStartPrice.toString())**2n*1000000n/(1n<<128n)!==b(series.reserve_price)) throw new ChainError('InvalidTerms', 'configuration does not route this series to its treasury');
  if (await curve.transport.raw(cmd.baseMint)) throw new ChainError('WrongPhase', 'base mint already exists; resume the existing pool');
  const tx = await curve.client.creator.createPool({config, payer, poolCreator: payer, baseMint: new PublicKey(cmd.baseMint),
    name: `Merces ${reads.address(cmd.seriesId).slice(0,8)}`, symbol: 'MERCES', uri: ''});
  return {instructions: tx.instructions};
}

/** Pinned SDK migration account layout, with caller-reviewed fresh mint addresses instead of SDK-generated keys. */
export async function planCurveMigration(curve: SolanaCurve, cmd: Extract<Command,{kind:'migrateCurve'}>, signer: string): Promise<SolPlan> {
  const data = await curve.pool(cmd.seriesId);
  if (!data || !data.progress.curveComplete || data.progress.isMigrated) throw new ChainError('WrongPhase', 'curve must be complete and not yet migrated');
  const {pool, cfg, progress} = data, key = new PublicKey(progress.pool), dammConfig = new PublicKey(progress.dammConfig);
  for (const mint of [cmd.firstPositionMint, cmd.secondPositionMint]) if (await curve.transport.raw(mint)) throw new ChainError('InvalidTerms', 'migration position mint already exists');
  const first = new PublicKey(cmd.firstPositionMint), second = new PublicKey(cmd.secondPositionMint);
  const dammPool = deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, cfg.quoteMint);
  const instruction = await curve.client.migration.program.methods.migrationDammV2().accountsStrict({
    virtualPool: key, migrationMetadata: deriveDammV2MigrationMetadataAddress(key), config: pool.poolState.config,
    poolAuthority: deriveDbcPoolAuthority(), pool: dammPool,
    firstPositionNftMint: first, firstPosition: derivePositionAddress(first), firstPositionNftAccount: derivePositionNftAccount(first),
    secondPositionNftMint: second, secondPosition: derivePositionAddress(second), secondPositionNftAccount: derivePositionNftAccount(second),
    dammPoolAuthority: deriveDammV2PoolAuthority(), ammProgram: DAMM_V2_PROGRAM_ID,
    baseMint: pool.poolState.baseMint, quoteMint: cfg.quoteMint,
    tokenAVault: deriveDammV2TokenVaultAddress(dammPool, pool.poolState.baseMint), tokenBVault: deriveDammV2TokenVaultAddress(dammPool, cfg.quoteMint),
    baseVault: pool.poolState.baseVault, quoteVault: pool.poolState.quoteVault, payer: new PublicKey(signer),
    tokenBaseProgram: new PublicKey(cfg.tokenType === 0 ? TOKEN : TOKEN_2022), tokenQuoteProgram: new PublicKey(cfg.quoteTokenFlag === 0 ? TOKEN : TOKEN_2022),
    token2022Program: new PublicKey(TOKEN_2022), systemProgram: SystemProgram.programId, dammEventAuthority: deriveDammV2EventAuthority(),
  }).remainingAccounts([{pubkey:dammConfig,isSigner:false,isWritable:false}]).instruction();
  const lockerNeeded = !cfg.lockedVestingConfig.cliffUnlockAmount.isZero() || !cfg.lockedVestingConfig.amountPerPeriod.isZero();
  const preparations = lockerNeeded && !await curve.transport.raw(deriveEscrow(deriveBaseKeyForLocker(key)).toBase58())
    ? [{summary:'Create the configured vesting escrow',instructions:(await curve.client.migration.createLocker({payer:new PublicKey(signer),pool:key})).instructions}]
    : [];
  return {instructions:[instruction], ...(preparations.length ? {preparations} : {})};
}
