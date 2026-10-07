/**
 * Offline test helpers: a stub `Connection` serving fabricated accounts, and encoders that produce the
 * exact on-chain byte layout of `PoolConfig` / `VirtualPool` the way the program would store a Merces
 * config (via the SDK's Anchor coder, which is what the SDK itself uses to decode these accounts).
 */
import { Connection, Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, AccountLayout } from "@solana/spl-token";
import BN from "bn.js";
import { createDbcProgram, deriveDbcPoolAddress, deriveDbcTokenVaultAddress, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { MercesCurveConfig } from "../../src/config.js";
import { MigrationProgress } from "../../src/constants.js";

const bn = (x: bigint | number): BN => new BN(x.toString());

export interface StubAccounts {
  map: Map<string, AccountInfo<Buffer>>;
  set(pubkey: PublicKey, info: AccountInfo<Buffer>): void;
}

export function makeStubConnection(): { connection: Connection; accounts: StubAccounts; calls: string[] } {
  const map = new Map<string, AccountInfo<Buffer>>();
  const calls: string[] = [];
  const connection = new Connection("http://127.0.0.1:1", "confirmed");
  const stub = connection as unknown as Record<string, unknown>;
  stub["getAccountInfo"] = async (pk: PublicKey) => {
    calls.push(`getAccountInfo ${pk.toBase58()}`);
    return map.get(pk.toBase58()) ?? null;
  };
  stub["getAccountInfoAndContext"] = async (pk: PublicKey) => {
    calls.push(`getAccountInfoAndContext ${pk.toBase58()}`);
    return { context: { slot: 1 }, value: map.get(pk.toBase58()) ?? null };
  };
  stub["getMultipleAccountsInfo"] = async (pks: PublicKey[]) => {
    calls.push(`getMultipleAccountsInfo ${pks.length}`);
    return pks.map((pk) => map.get(pk.toBase58()) ?? null);
  };
  stub["getMultipleAccountsInfoAndContext"] = async (pks: PublicKey[]) => ({ context: { slot: 1 }, value: pks.map((pk) => map.get(pk.toBase58()) ?? null) });
  stub["getMinimumBalanceForRentExemption"] = async (size: number) => 890_880 + 6_960 * size;
  stub["getLatestBlockhash"] = async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1_000 });
  stub["getSlot"] = async () => 1;
  stub["getBlockTime"] = async () => 1_700_000_000;
  stub["getGenesisHash"] = async () => "stub-genesis";
  stub["getBalance"] = async () => 10_000_000_000;
  return {
    connection,
    accounts: { map, set: (pk, info) => map.set(pk.toBase58(), info) },
    calls,
  };
}

export function mintAccount(decimals: number, program: PublicKey, mintAuthority: PublicKey | null): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: mintAuthority ? 1 : 0,
      mintAuthority: mintAuthority ?? PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: program, executable: false, lamports: 1_461_600 };
}

export function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, program: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: program, executable: false, lamports: 2_039_280 };
}

export interface OnChainAddresses {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
}

/** The `PoolConfig` account the program writes for a Merces config (`PoolConfig::init`, PROG/state/config.rs:731-832). */
export function poolConfigObject(cfg: MercesCurveConfig, a: OnChainAddresses, quoteTokenFlag = 0) {
  const p = cfg.configParameters;
  const d = cfg.derived;
  const curve = Array.from({ length: 20 }, (_, i) => {
    const c = p.curve[i];
    return c ? { sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) } : { sqrtPrice: bn(0), liquidity: bn(0) };
  });
  const vesting = (v: typeof p.partnerLiquidityVestingInfo) => ({
    isInitialized: v.vestingPercentage === 0 && v.bpsPerPeriod === 0 && v.numberOfPeriods === 0 && v.cliffDurationFromMigrationTime === 0 && v.frequency === 0 ? 0 : 1,
    vestingPercentage: v.vestingPercentage,
    padding: [0, 0],
    bpsPerPeriod: v.bpsPerPeriod,
    numberOfPeriods: v.numberOfPeriods,
    frequency: v.frequency,
    cliffDurationFromMigrationTime: v.cliffDurationFromMigrationTime,
  });
  return {
    quoteMint: a.quoteMint,
    feeClaimer: a.feeClaimer,
    leftoverReceiver: a.leftoverReceiver,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: bn(p.poolFees.baseFee.cliffFeeNumerator),
        secondFactor: bn(p.poolFees.baseFee.secondFactor),
        thirdFactor: bn(p.poolFees.baseFee.thirdFactor),
        firstFactor: p.poolFees.baseFee.firstFactor,
        baseFeeMode: p.poolFees.baseFee.baseFeeMode,
        padding0: [0, 0, 0, 0, 0],
      },
      dynamicFee: {
        initialized: p.poolFees.dynamicFee ? 1 : 0,
        padding: [0, 0, 0, 0, 0, 0, 0],
        maxVolatilityAccumulator: p.poolFees.dynamicFee?.maxVolatilityAccumulator ?? 0,
        variableFeeControl: p.poolFees.dynamicFee?.variableFeeControl ?? 0,
        binStep: p.poolFees.dynamicFee?.binStep ?? 0,
        filterPeriod: p.poolFees.dynamicFee?.filterPeriod ?? 0,
        decayPeriod: p.poolFees.dynamicFee?.decayPeriod ?? 0,
        reductionFactor: p.poolFees.dynamicFee?.reductionFactor ?? 0,
        padding2: [0, 0, 0, 0, 0, 0, 0, 0],
        binStepU128: bn(p.poolFees.dynamicFee?.binStepU128 ?? 0n),
      },
    },
    partnerLiquidityVestingInfo: vesting(p.partnerLiquidityVestingInfo),
    creatorLiquidityVestingInfo: vesting(p.creatorLiquidityVestingInfo),
    padding0: new Array(14).fill(0),
    padding1: 0,
    collectFeeMode: p.collectFeeMode,
    migrationOption: p.migrationOption,
    activationType: p.activationType,
    tokenDecimal: p.tokenDecimal,
    version: 0,
    tokenType: p.tokenType,
    quoteTokenFlag,
    partnerPermanentLockedLiquidityPercentage: p.partnerPermanentLockedLiquidityPercentage,
    partnerLiquidityPercentage: p.partnerLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: p.creatorPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: p.creatorLiquidityPercentage,
    migrationFeeOption: p.migrationFeeOption,
    fixedTokenSupplyFlag: p.tokenSupply ? 1 : 0,
    creatorTradingFeePercentage: p.creatorTradingFeePercentage,
    tokenUpdateAuthority: p.tokenUpdateAuthority,
    migrationFeePercentage: p.migrationFee.feePercentage,
    creatorMigrationFeePercentage: p.migrationFee.creatorFeePercentage,
    padding2: new Array(7).fill(0),
    swapBaseAmount: bn(d.swapBaseAmount),
    migrationQuoteThreshold: bn(p.migrationQuoteThreshold),
    migrationBaseThreshold: bn(d.migrationBaseThreshold),
    migrationSqrtPrice: bn(d.migrationSqrtPrice),
    lockedVestingConfig: {
      amountPerPeriod: bn(p.lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: bn(p.lockedVesting.cliffDurationFromMigrationTime),
      frequency: bn(p.lockedVesting.frequency),
      numberOfPeriod: bn(p.lockedVesting.numberOfPeriod),
      cliffUnlockAmount: bn(p.lockedVesting.cliffUnlockAmount),
      padding: bn(0),
    },
    preMigrationTokenSupply: bn(p.tokenSupply?.preMigrationTokenSupply ?? 0n),
    postMigrationTokenSupply: bn(p.tokenSupply?.postMigrationTokenSupply ?? 0n),
    migratedCollectFeeMode: p.migratedPoolFee.collectFeeMode,
    migratedDynamicFee: p.migratedPoolFee.dynamicFee,
    migratedPoolFeeBps: p.migratedPoolFee.poolFeeBps,
    migratedPoolBaseFeeMode: p.migratedPoolBaseFeeMode,
    enableFirstSwapWithMinFee: p.enableFirstSwapWithMinFee ? 1 : 0,
    migratedCompoundingFeeBps: p.compoundingFeeBps,
    poolCreationFee: bn(p.poolCreationFee),
    migratedPoolBaseFeeBytes: new Array(16).fill(0),
    sqrtStartPrice: bn(p.sqrtStartPrice),
    curve,
  };
}

export interface PoolStateOverrides {
  quoteReserve?: bigint;
  baseReserve?: bigint;
  sqrtPrice?: bigint;
  migrationProgress?: MigrationProgress;
  isMigrated?: boolean;
  partnerQuoteFee?: bigint;
  creatorQuoteFee?: bigint;
  protocolQuoteFee?: bigint;
  migrationFeeWithdrawStatus?: number;
  finishCurveTimestamp?: bigint;
  isWithdrawLeftover?: boolean;
}

export function virtualPoolObject(cfg: MercesCurveConfig, a: OnChainAddresses, o: PoolStateOverrides = {}) {
  const pool = deriveDbcPoolAddress(a.quoteMint, a.baseMint, a.config);
  const zero = bn(0);
  return {
    poolState: {
      volatilityTracker: { lastUpdateTimestamp: zero, padding: new Array(8).fill(0), sqrtPriceReference: zero, volatilityAccumulator: zero, volatilityReference: zero },
      config: a.config,
      creator: a.creator,
      baseMint: a.baseMint,
      baseVault: deriveDbcTokenVaultAddress(pool, a.baseMint),
      quoteVault: deriveDbcTokenVaultAddress(pool, a.quoteMint),
      baseReserve: bn(o.baseReserve ?? cfg.derived.initialBaseSupply),
      quoteReserve: bn(o.quoteReserve ?? 0n),
      protocolBaseFee: zero,
      protocolQuoteFee: bn(o.protocolQuoteFee ?? 0n),
      partnerBaseFee: zero,
      partnerQuoteFee: bn(o.partnerQuoteFee ?? 0n),
      sqrtPrice: bn(o.sqrtPrice ?? cfg.configParameters.sqrtStartPrice),
      activationPoint: bn(1_700_000_000),
      poolType: cfg.configParameters.tokenType,
      isMigrated: o.isMigrated ? 1 : 0,
      isPartnerWithdrawSurplus: 0,
      isProtocolWithdrawSurplus: 0,
      migrationProgress: o.migrationProgress ?? MigrationProgress.PreBondingCurve,
      isWithdrawLeftover: o.isWithdrawLeftover ? 1 : 0,
      isCreatorWithdrawSurplus: 0,
      migrationFeeWithdrawStatus: o.migrationFeeWithdrawStatus ?? 0,
      metrics: { totalProtocolBaseFee: zero, totalProtocolQuoteFee: zero, totalTradingBaseFee: zero, totalTradingQuoteFee: zero },
      finishCurveTimestamp: bn(o.finishCurveTimestamp ?? 0n),
      creatorBaseFee: zero,
      creatorQuoteFee: bn(o.creatorQuoteFee ?? 0n),
      legacyCreationFeeBits: 0,
      creationFeeBits: 0,
      hasSwap: o.quoteReserve ? 1 : 0,
      padding0: [0, 0, 0, 0, 0],
      protocolLiquidityMigrationFeeBps: 20,
      padding1: [0, 0, 0, 0, 0, 0],
      protocolMigrationBaseFeeAmount: zero,
      protocolMigrationQuoteFeeAmount: zero,
      padding2: [zero, zero, zero],
    },
  };
}

export async function encodeAccount(connection: Connection, name: "poolConfig" | "virtualPool", obj: unknown): Promise<AccountInfo<Buffer>> {
  const { program } = createDbcProgram(connection, "confirmed");
  // Anchor's BorshAccountsCoder.encode allocates a fixed 1000-byte scratch buffer, too small for the
  // 1040-byte PoolConfig, so encode with the account layout directly into a larger buffer.
  const coder = program.coder.accounts as unknown as {
    accountLayouts: Map<string, { discriminator: Buffer | number[]; layout: { encode(account: unknown, buffer: Buffer): number } }>;
    accountDiscriminator(name: string): Buffer;
  };
  const entry = coder.accountLayouts.get(name);
  if (!entry) throw new Error(`no layout for ${name}`);
  const buffer = Buffer.alloc(8_192);
  const len = entry.layout.encode(obj, buffer);
  const encoded = Buffer.concat([coder.accountDiscriminator(name), buffer.subarray(0, len)]);
  await Promise.resolve();
  return { data: encoded, owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID, executable: false, lamports: 10_000_000 };
}

export interface Scenario {
  connection: Connection;
  accounts: StubAccounts;
  calls: string[];
  addresses: OnChainAddresses & { pool: PublicKey };
  payer: Keypair;
  issuer: Keypair;
  merces: Keypair;
  configKeypair: Keypair;
  baseMintKeypair: Keypair;
}

/** A stub world with the quote mint, the config and (optionally) the pool already on chain. */
export async function scenario(cfg: MercesCurveConfig, opts: { withPool?: boolean; poolState?: PoolStateOverrides } = {}): Promise<Scenario> {
  const { connection, accounts, calls } = makeStubConnection();
  const payer = Keypair.generate();
  const issuer = Keypair.generate();
  const merces = Keypair.generate();
  const configKeypair = Keypair.generate();
  const baseMintKeypair = Keypair.generate();
  const quoteMint = new PublicKey(cfg.input.quoteMint);
  const addresses: OnChainAddresses = {
    quoteMint,
    feeClaimer: merces.publicKey,
    leftoverReceiver: merces.publicKey,
    config: configKeypair.publicKey,
    baseMint: baseMintKeypair.publicKey,
    creator: issuer.publicKey,
  };
  accounts.set(quoteMint, mintAccount(6, TOKEN_PROGRAM_ID, payer.publicKey));
  accounts.set(configKeypair.publicKey, await encodeAccount(connection, "poolConfig", poolConfigObject(cfg, addresses)));
  const pool = deriveDbcPoolAddress(quoteMint, baseMintKeypair.publicKey, configKeypair.publicKey);
  if (opts.withPool) {
    accounts.set(baseMintKeypair.publicKey, mintAccount(cfg.input.tokenDecimals, TOKEN_2022_PROGRAM_ID, null));
    accounts.set(pool, await encodeAccount(connection, "virtualPool", virtualPoolObject(cfg, addresses, opts.poolState)));
  }
  return { connection, accounts, calls, addresses: { ...addresses, pool }, payer, issuer, merces, configKeypair, baseMintKeypair };
}
