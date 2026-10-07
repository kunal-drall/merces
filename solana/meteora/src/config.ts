/**
 * Oracle-driven DBC config generator for Merces curve-mode series (brief D10 build item 1).
 *
 * Turns an issuer's attested trailing annual income and the Merces series terms into a complete,
 * program-validated DBC `ConfigParameters` plus a deterministic JSON description. All money is in
 * quote-token base units (USDC: 6 decimals); all ratios are WAD (1e18) fixed point; all arithmetic is
 * exact bigint. Design choices and defaults are recorded in `docs/assumptions/track-d.md` and the
 * formulas are explained in `docs/meteora/CURVE_MODE.md`.
 */
import { createHash } from "node:crypto";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DammV2BaseFeeMode,
  MAX_FEE_BPS,
  MAX_SQRT_PRICE,
  MERCES_CURVE_BASE_DECIMALS,
  MIN_FEE_BPS,
  MIN_SQRT_PRICE,
  MigrationFeeOption,
  MigrationOption,
  Q128,
  TokenAuthorityOption,
  TokenType,
  USDC_DECIMALS,
  WAD,
} from "./constants.js";
import {
  bpsToFeeNumerator,
  getDeltaAmountQuote,
  isqrt,
  mulDiv,
  Rounding,
  sqrtPriceFromRatio,
  type CurvePoint,
} from "./math.js";
import { computeProceeds, type ProceedsBreakdown } from "./proceeds.js";
import {
  configParametersFromJson,
  jsonify,
  toCanonicalJson,
  ZERO_LIQUIDITY_VESTING,
  ZERO_LOCKED_VESTING,
  ZERO_MARKET_CAP_SCHEDULER,
  ZERO_MIGRATED_POOL_FEE,
  type DbcConfigParameters,
  type Jsonified,
  type LiquidityVestingInfoParams,
  type LockedVestingParams,
  type MigrationFee,
} from "./types.js";
import { validateDbcConfigParameters, type DerivedConfig } from "./validate.js";

export class MercesConfigError extends Error {
  constructor(
    readonly code:
      | "InvalidInput"
      | "StartPriceNotBelowAveragePrice"
      | "PriceRampTooSteep"
      | "PriceOutOfRange"
      | "UnsupportedQuoteDecimals",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MercesConfigError";
  }
}

/** Vesting schedule of the issuer-held allocation (Jupiter locker, created by `create_locker` after the curve completes). */
export interface IssuerVestingSchedule {
  /** Seconds between curve completion and the cliff (`cliff_duration_from_migration_time`). */
  cliffSeconds: number;
  /** Number of linear periods after the cliff (`number_of_period`); 0 means cliff-only. */
  periods: number;
  /** Seconds per period (`frequency`). */
  periodSeconds: number;
  /** Whole units unlocked at the cliff (`cliff_unlock_amount`); the division remainder is added to it. Default 0. */
  cliffUnlockUnits?: bigint;
}

export interface LiquidityDistributionInput {
  partnerLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  partnerLiquidityVestingInfo?: LiquidityVestingInfoParams;
  creatorLiquidityVestingInfo?: LiquidityVestingInfoParams;
}

export interface MercesCurveInput {
  /** Free-text label stored in the JSON (series id, issuer handle). */
  seriesLabel?: string;
  /** Attested trailing 12-month income `I`, in quote base units (USDC × 10^6). */
  trailingAnnualIncome: bigint;
  /** The issuer's requested raise `T`, in quote base units. */
  targetRaise: bigint;
  /** Units offered to the public on the curve, `N_pub` (whole HEU). */
  unitsOnCurve: bigint;
  /** Units reserved for the issuer, `N_iss` (whole HEU), vested through the locker. Default 0. */
  issuerUnits?: bigint;
  issuerVesting?: IssuerVestingSchedule;
  /** `μ`: max raise = μ × I. Default 3e18 (ASSUMPTIONS A3; Kunal H3). */
  maxRaiseMultipleWad?: bigint;
  /** `ν`: the series is valued at ν × I at the first unit sold (start FDV over issued units). Default 1e18. */
  startValuationMultipleWad?: bigint;
  /** Upper bound on `P_mig / P_start`. Default 25e18. */
  maxPriceRampWad?: bigint;
  /** Merces cap multiple `m` (informational: cap per unit = m × P0). Default 2.5e18. */
  capMultipleWad?: bigint;
  /** Quote mint (USDC). Mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v; devnet: configurable. */
  quoteMint: string;
  /** Decimals of the quote mint, read from the mint by the caller. Default 6; must be 6 for USDC. */
  quoteDecimals?: number;
  /** Base mint decimals (program bounds 6..=9). Default 6. */
  tokenDecimals?: number;
  tokenType?: TokenType;
  tokenAuthorityOption?: TokenAuthorityOption;
  /** Fixed trading fee during the bonding phase, bps. Default 100 (brief C5: backers pay 1%). */
  tradingFeeBps?: number;
  /** `creator_trading_fee_percentage`. Default 0 (brief D10: creator fee share may be zero). */
  creatorTradingFeePercentage?: number;
  collectFeeMode?: CollectFeeMode;
  /** Default `{ feePercentage: 99, creatorFeePercentage: 100 }` (ASSUMPTIONS A3). */
  migrationFee?: MigrationFee;
  /** DAMM v2 fee tier of the graduated pool. Default FixedBps100. */
  migrationFeeOption?: MigrationFeeOption;
  /** Default: 100% permanently locked, owned by the partner (Merces). */
  liquidityDistribution?: LiquidityDistributionInput;
  activationType?: ActivationType;
  poolCreationFeeLamports?: bigint;
  /** DAMM v2 `Config` to migrate into; default `DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]`. */
  dammConfig?: string;
}

export const MERCES_CURVE_DEFAULTS = {
  issuerUnits: 0n,
  issuerVesting: { cliffSeconds: 0, periods: 12, periodSeconds: 2_629_800, cliffUnlockUnits: 0n } satisfies IssuerVestingSchedule,
  maxRaiseMultipleWad: 3n * WAD,
  startValuationMultipleWad: WAD,
  maxPriceRampWad: 25n * WAD,
  capMultipleWad: (25n * WAD) / 10n,
  quoteDecimals: USDC_DECIMALS,
  tokenDecimals: MERCES_CURVE_BASE_DECIMALS,
  tokenType: TokenType.Token2022,
  tokenAuthorityOption: TokenAuthorityOption.Immutable,
  tradingFeeBps: 100,
  creatorTradingFeePercentage: 0,
  collectFeeMode: CollectFeeMode.QuoteToken,
  migrationFee: { feePercentage: 99, creatorFeePercentage: 100 } satisfies MigrationFee,
  migrationFeeOption: MigrationFeeOption.FixedBps100,
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
  } satisfies LiquidityDistributionInput,
  activationType: ActivationType.Timestamp,
  poolCreationFeeLamports: 0n,
} as const;

export type ResolvedMercesCurveInput = Required<Omit<MercesCurveInput, "seriesLabel" | "dammConfig">> & {
  seriesLabel: string;
  dammConfig: string;
};

export interface CurveAnchoring {
  /** `μ × I` */
  maxRaise: bigint;
  /** `X = min(T, μ × I)` */
  migrationQuoteThreshold: bigint;
  raiseCappedByIncome: boolean;
  /** `N_pub × 10^dec` */
  unitsBaseOnCurve: bigint;
  /** `(N_pub + N_iss) × 10^dec` */
  issuedUnitsBase: bigint;
  /** Start price in quote base units per whole unit (from the exact sqrt price). */
  startPricePerUnit: bigint;
  /** `floor(X / N_pub)`: the average price curve buyers pay, which is `P0` for cap accounting. */
  averagePricePerUnit: bigint;
  /** Migration price per whole unit implied by the program-derived `migration_sqrt_price`. */
  migrationPricePerUnit: bigint;
  sqrtStartPrice: bigint;
  /** Upper sqrt price of the single curve segment (target migration sqrt price). */
  sqrtCurveEnd: bigint;
  /** What the program stores as `migration_sqrt_price` (≤ `sqrtCurveEnd`, differs by at most rounding). */
  sqrtMigrationPrice: bigint;
  curveLiquidity: bigint;
  /** `P_mig / P_start` as WAD. */
  priceRampWad: bigint;
  /** FDV at the start price over issued units (`≈ ν × I`) and over total supply, quote base units. */
  startFdvIssuedUnits: bigint;
  startFdvTotalSupply: bigint;
}

export interface MercesDerived extends DerivedConfig {
  /** `P0 = floor(X × 10^dec / swap_base_amount)` quote base units per whole unit (SPEC §9 default, rounding favours the issuer). */
  p0PerUnit: bigint;
  /** `floor(m × P0 / 1e18)` */
  capPerUnit: bigint;
  issuerUnitsBase: bigint;
  /** `migration_base_threshold`: units deposited into the DAMM v2 pool at migration (not holder units). */
  poolHeldUnitsBase: bigint;
  totalSupplyBase: bigint;
  /** Human-readable supply with `tokenDecimals` decimals. */
  totalSupplyUnits: string;
  unitsSoldOnCurve: string;
}

export interface MercesCurveConfig {
  schema: "merces.meteora.curve-config/1";
  generator: "@merces/meteora buildMercesCurveConfig";
  input: ResolvedMercesCurveInput;
  anchoring: CurveAnchoring;
  configParameters: DbcConfigParameters;
  derived: MercesDerived;
  proceeds: ProceedsBreakdown;
  /** sha256 of the canonical JSON of `configParameters`; the graduation state file pins it. */
  configHash: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function positive(x: bigint, what: string): void {
  if (x <= 0n) throw new MercesConfigError("InvalidInput", `${what} must be > 0`);
}

export function formatUnits(baseAmount: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = baseAmount / d;
  const frac = (baseAmount % d).toString().padStart(decimals, "0");
  return decimals === 0 ? whole.toString() : `${whole}.${frac}`;
}

/** Quote base units per whole base unit implied by a Q64.64 sqrt price: `floor(√P² × 10^dec / 2^128)`. */
export function pricePerUnitFromSqrtPrice(sqrtPrice: bigint, tokenDecimals: number): bigint {
  return (sqrtPrice * sqrtPrice * 10n ** BigInt(tokenDecimals)) / Q128;
}

/**
 * Locked-vesting parameters for the issuer allocation.
 * Division remainder goes to the cliff unlock so that the total is exactly `N_iss × 10^dec`.
 * A cliff-only schedule (`periods = 0`) is encoded as the SDK does (`getLockedVestingParams`, common.ts:1320-1333)
 * but at base-unit granularity: one period of one base lamport one second after the cliff, so the locker
 * always sees `number_of_period ≥ 1` and `amount_per_period ≥ 1`.
 */
export function buildIssuerLockedVesting(issuerUnitsBase: bigint, schedule: IssuerVestingSchedule): LockedVestingParams {
  if (issuerUnitsBase === 0n) return { ...ZERO_LOCKED_VESTING };
  const cliffUnlockBase = (schedule.cliffUnlockUnits ?? 0n) * 10n ** BigInt(MERCES_CURVE_BASE_DECIMALS);
  if (schedule.cliffSeconds < 0 || schedule.periods < 0 || schedule.periodSeconds < 0 || !Number.isInteger(schedule.periods)) {
    throw new MercesConfigError("InvalidInput", "issuer vesting schedule fields must be non-negative integers");
  }
  if (cliffUnlockBase > issuerUnitsBase) throw new MercesConfigError("InvalidInput", "cliffUnlockUnits exceeds issuerUnits");
  if (schedule.periods === 0) {
    if (cliffUnlockBase !== 0n && cliffUnlockBase !== issuerUnitsBase) {
      throw new MercesConfigError("InvalidInput", "cliff-only schedule must unlock everything at the cliff");
    }
    return {
      amountPerPeriod: 1n,
      cliffDurationFromMigrationTime: BigInt(schedule.cliffSeconds),
      frequency: 1n,
      numberOfPeriod: 1n,
      cliffUnlockAmount: issuerUnitsBase - 1n,
    };
  }
  if (schedule.periodSeconds === 0) throw new MercesConfigError("InvalidInput", "periodSeconds must be > 0 when periods > 0");
  const periods = BigInt(schedule.periods);
  const amountPerPeriod = (issuerUnitsBase - cliffUnlockBase) / periods;
  const remainder = issuerUnitsBase - cliffUnlockBase - amountPerPeriod * periods;
  return {
    amountPerPeriod,
    cliffDurationFromMigrationTime: BigInt(schedule.cliffSeconds),
    frequency: BigInt(schedule.periodSeconds),
    numberOfPeriod: periods,
    cliffUnlockAmount: cliffUnlockBase + remainder,
  };
}

function resolveInput(input: MercesCurveInput): ResolvedMercesCurveInput {
  const migrationFeeOption = input.migrationFeeOption ?? MERCES_CURVE_DEFAULTS.migrationFeeOption;
  const dammConfig = input.dammConfig ?? DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!dammConfig) throw new MercesConfigError("InvalidInput", `no DAMM v2 config for migration fee option ${migrationFeeOption}`);
  const dist: LiquidityDistributionInput = input.liquidityDistribution ?? MERCES_CURVE_DEFAULTS.liquidityDistribution;
  return {
    seriesLabel: input.seriesLabel ?? "",
    trailingAnnualIncome: input.trailingAnnualIncome,
    targetRaise: input.targetRaise,
    unitsOnCurve: input.unitsOnCurve,
    issuerUnits: input.issuerUnits ?? MERCES_CURVE_DEFAULTS.issuerUnits,
    issuerVesting: {
      cliffSeconds: input.issuerVesting?.cliffSeconds ?? MERCES_CURVE_DEFAULTS.issuerVesting.cliffSeconds,
      periods: input.issuerVesting?.periods ?? MERCES_CURVE_DEFAULTS.issuerVesting.periods,
      periodSeconds: input.issuerVesting?.periodSeconds ?? MERCES_CURVE_DEFAULTS.issuerVesting.periodSeconds,
      cliffUnlockUnits: input.issuerVesting?.cliffUnlockUnits ?? 0n,
    },
    maxRaiseMultipleWad: input.maxRaiseMultipleWad ?? MERCES_CURVE_DEFAULTS.maxRaiseMultipleWad,
    startValuationMultipleWad: input.startValuationMultipleWad ?? MERCES_CURVE_DEFAULTS.startValuationMultipleWad,
    maxPriceRampWad: input.maxPriceRampWad ?? MERCES_CURVE_DEFAULTS.maxPriceRampWad,
    capMultipleWad: input.capMultipleWad ?? MERCES_CURVE_DEFAULTS.capMultipleWad,
    quoteMint: input.quoteMint,
    quoteDecimals: input.quoteDecimals ?? MERCES_CURVE_DEFAULTS.quoteDecimals,
    tokenDecimals: input.tokenDecimals ?? MERCES_CURVE_DEFAULTS.tokenDecimals,
    tokenType: input.tokenType ?? MERCES_CURVE_DEFAULTS.tokenType,
    tokenAuthorityOption: input.tokenAuthorityOption ?? MERCES_CURVE_DEFAULTS.tokenAuthorityOption,
    tradingFeeBps: input.tradingFeeBps ?? MERCES_CURVE_DEFAULTS.tradingFeeBps,
    creatorTradingFeePercentage: input.creatorTradingFeePercentage ?? MERCES_CURVE_DEFAULTS.creatorTradingFeePercentage,
    collectFeeMode: input.collectFeeMode ?? MERCES_CURVE_DEFAULTS.collectFeeMode,
    migrationFee: { ...(input.migrationFee ?? MERCES_CURVE_DEFAULTS.migrationFee) },
    migrationFeeOption,
    liquidityDistribution: {
      partnerLiquidityPercentage: dist.partnerLiquidityPercentage,
      partnerPermanentLockedLiquidityPercentage: dist.partnerPermanentLockedLiquidityPercentage,
      creatorLiquidityPercentage: dist.creatorLiquidityPercentage,
      creatorPermanentLockedLiquidityPercentage: dist.creatorPermanentLockedLiquidityPercentage,
      partnerLiquidityVestingInfo: { ...(dist.partnerLiquidityVestingInfo ?? ZERO_LIQUIDITY_VESTING) },
      creatorLiquidityVestingInfo: { ...(dist.creatorLiquidityVestingInfo ?? ZERO_LIQUIDITY_VESTING) },
    },
    activationType: input.activationType ?? MERCES_CURVE_DEFAULTS.activationType,
    poolCreationFeeLamports: input.poolCreationFeeLamports ?? MERCES_CURVE_DEFAULTS.poolCreationFeeLamports,
    dammConfig,
  };
}

// ---------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------

export function buildMercesCurveConfig(rawInput: MercesCurveInput): MercesCurveConfig {
  const input = resolveInput(rawInput);
  const I = input.trailingAnnualIncome;
  const T = input.targetRaise;
  positive(I, "trailingAnnualIncome");
  positive(T, "targetRaise");
  positive(input.unitsOnCurve, "unitsOnCurve");
  positive(input.maxRaiseMultipleWad, "maxRaiseMultipleWad");
  positive(input.startValuationMultipleWad, "startValuationMultipleWad");
  positive(input.capMultipleWad, "capMultipleWad");
  if (input.issuerUnits < 0n) throw new MercesConfigError("InvalidInput", "issuerUnits must be >= 0");
  if (input.maxPriceRampWad <= WAD) throw new MercesConfigError("InvalidInput", "maxPriceRampWad must be > 1e18");
  if (input.quoteDecimals !== USDC_DECIMALS) {
    throw new MercesConfigError("UnsupportedQuoteDecimals", `the curve quotes in USDC (6 decimals); got ${input.quoteDecimals}`);
  }
  if (!Number.isInteger(input.tradingFeeBps) || input.tradingFeeBps < MIN_FEE_BPS || input.tradingFeeBps > MAX_FEE_BPS) {
    throw new MercesConfigError("InvalidInput", `tradingFeeBps must be within [${MIN_FEE_BPS}, ${MAX_FEE_BPS}]`);
  }
  if (!PUBKEY_RE.test(input.quoteMint)) throw new MercesConfigError("InvalidInput", "quoteMint is not a base58 pubkey");
  if (!PUBKEY_RE.test(input.dammConfig)) throw new MercesConfigError("InvalidInput", "dammConfig is not a base58 pubkey");

  const dec = input.tokenDecimals;
  const basePerUnit = 10n ** BigInt(dec);

  // --- 1. Raise anchoring: X = min(T, μ × I) ---------------------------------------------------
  const maxRaise = (input.maxRaiseMultipleWad * I) / WAD;
  const X = T < maxRaise ? T : maxRaise;
  positive(X, "migration quote threshold");

  // --- 2. Start price anchoring: P_start × issued units = ν × I ---------------------------------
  const unitsBaseOnCurve = input.unitsOnCurve * basePerUnit;
  const issuedUnitsBase = (input.unitsOnCurve + input.issuerUnits) * basePerUnit;
  const startValuation = (input.startValuationMultipleWad * I) / WAD; // quote base units
  positive(startValuation, "start valuation");
  const sqrtStartPrice = sqrtPriceFromRatio(startValuation, issuedUnitsBase);
  if (sqrtStartPrice < MIN_SQRT_PRICE || sqrtStartPrice >= MAX_SQRT_PRICE) {
    throw new MercesConfigError("PriceOutOfRange", `start sqrt price ${sqrtStartPrice} outside [MIN_SQRT_PRICE, MAX_SQRT_PRICE)`);
  }

  // --- 3. Migration price from the raise: X / N_base = √P_start × √P_mig / 2^128 ----------------
  const sqrtCurveEnd = (X * Q128) / (unitsBaseOnCurve * sqrtStartPrice);
  if (sqrtCurveEnd <= sqrtStartPrice) {
    throw new MercesConfigError(
      "StartPriceNotBelowAveragePrice",
      `start price (ν × I / issued units) must be below the average price X / N_pub; lower startValuationMultipleWad, raise unitsOnCurve, or raise the target`,
    );
  }
  if (sqrtCurveEnd >= MAX_SQRT_PRICE) throw new MercesConfigError("PriceOutOfRange", "migration sqrt price reaches MAX_SQRT_PRICE");
  const priceRampWad = (sqrtCurveEnd * sqrtCurveEnd * WAD) / (sqrtStartPrice * sqrtStartPrice);
  if (priceRampWad > input.maxPriceRampWad) {
    throw new MercesConfigError(
      "PriceRampTooSteep",
      `P_mig / P_start = ${formatUnits(priceRampWad, 18)} exceeds maxPriceRampWad ${formatUnits(input.maxPriceRampWad, 18)}`,
    );
  }

  // --- 4. One constant-liquidity segment that absorbs exactly X -----------------------------------
  // L = ceil(X·2^128 / Δ√P) guarantees ceil(L·Δ√P / 2^128) >= X, so the program never reports NotEnoughLiquidity
  // and derives migration_sqrt_price <= sqrtCurveEnd with the quote needed to reach it equal to X (math.ts notes).
  const curveLiquidity = mulDiv(X, Q128, sqrtCurveEnd - sqrtStartPrice, Rounding.Up);
  const curve: CurvePoint[] = [{ sqrtPrice: sqrtCurveEnd, liquidity: curveLiquidity }];
  const capacity = getDeltaAmountQuote(sqrtStartPrice, sqrtCurveEnd, curveLiquidity, Rounding.Up);
  if (capacity < X) throw new MercesConfigError("InvalidInput", "internal: curve capacity below threshold");

  // --- 5. Issuer allocation vesting -----------------------------------------------------------
  const issuerUnitsBase = input.issuerUnits * basePerUnit;
  const lockedVesting = buildIssuerLockedVesting(issuerUnitsBase, input.issuerVesting);

  // --- 6. Assemble ConfigParameters (supply filled after a first validation pass) -----------------
  const base: DbcConfigParameters = {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: bpsToFeeNumerator(input.tradingFeeBps),
        firstFactor: 0,
        secondFactor: 0n,
        thirdFactor: 0n,
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      },
      dynamicFee: null,
    },
    collectFeeMode: input.collectFeeMode,
    migrationOption: MigrationOption.DammV2,
    activationType: input.activationType,
    tokenType: input.tokenType,
    tokenDecimal: dec,
    partnerLiquidityPercentage: input.liquidityDistribution.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: input.liquidityDistribution.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: input.liquidityDistribution.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: input.liquidityDistribution.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: X,
    sqrtStartPrice,
    lockedVesting,
    migrationFeeOption: input.migrationFeeOption,
    tokenSupply: null,
    creatorTradingFeePercentage: input.creatorTradingFeePercentage,
    tokenUpdateAuthority: input.tokenAuthorityOption,
    migrationFee: { ...input.migrationFee },
    migratedPoolFee: { ...ZERO_MIGRATED_POOL_FEE },
    poolCreationFee: input.poolCreationFeeLamports,
    partnerLiquidityVestingInfo: { ...input.liquidityDistribution.partnerLiquidityVestingInfo! },
    creatorLiquidityVestingInfo: { ...input.liquidityDistribution.creatorLiquidityVestingInfo! },
    migratedPoolBaseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
    migratedPoolMarketCapFeeSchedulerParams: { ...ZERO_MARKET_CAP_SCHEDULER },
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: 0,
    curve,
  };
  // Fixed supply = exactly what the curve can sell + the DAMM v2 deposit + the issuer allocation: nothing extra to burn.
  const pass1 = validateDbcConfigParameters(base);
  const configParameters: DbcConfigParameters = {
    ...base,
    tokenSupply: {
      preMigrationTokenSupply: pass1.minimumBaseSupplyWithBuffer,
      postMigrationTokenSupply: pass1.minimumBaseSupplyWithBuffer,
    },
  };
  const derivedCore = validateDbcConfigParameters(configParameters);

  // --- 7. Merces-level derived values --------------------------------------------------------------
  const p0PerUnit = (X * basePerUnit) / derivedCore.swapBaseAmount;
  const derived: MercesDerived = {
    ...derivedCore,
    p0PerUnit,
    capPerUnit: (input.capMultipleWad * p0PerUnit) / WAD,
    issuerUnitsBase,
    poolHeldUnitsBase: derivedCore.migrationBaseThreshold,
    totalSupplyBase: derivedCore.initialBaseSupply,
    totalSupplyUnits: formatUnits(derivedCore.initialBaseSupply, dec),
    unitsSoldOnCurve: formatUnits(derivedCore.swapBaseAmount, dec),
  };

  const anchoring: CurveAnchoring = {
    maxRaise,
    migrationQuoteThreshold: X,
    raiseCappedByIncome: maxRaise < T,
    unitsBaseOnCurve,
    issuedUnitsBase,
    startPricePerUnit: pricePerUnitFromSqrtPrice(sqrtStartPrice, dec),
    averagePricePerUnit: X / input.unitsOnCurve,
    migrationPricePerUnit: pricePerUnitFromSqrtPrice(derivedCore.migrationSqrtPrice, dec),
    sqrtStartPrice,
    sqrtCurveEnd,
    sqrtMigrationPrice: derivedCore.migrationSqrtPrice,
    curveLiquidity,
    priceRampWad,
    startFdvIssuedUnits: (pricePerUnitFromSqrtPrice(sqrtStartPrice, dec) * issuedUnitsBase) / basePerUnit,
    startFdvTotalSupply: (pricePerUnitFromSqrtPrice(sqrtStartPrice, dec) * derivedCore.initialBaseSupply) / basePerUnit,
  };

  const proceeds = computeProceeds({
    migrationQuoteThreshold: X,
    migrationFeePercentage: input.migrationFee.feePercentage,
    creatorMigrationFeePercentage: input.migrationFee.creatorFeePercentage,
    creatorTradingFeePercentage: input.creatorTradingFeePercentage,
    tradingFeeNumerator: configParameters.poolFees.baseFee.cliffFeeNumerator,
    sqrtMigrationPrice: derivedCore.migrationSqrtPrice,
  });

  return {
    schema: "merces.meteora.curve-config/1",
    generator: "@merces/meteora buildMercesCurveConfig",
    input,
    anchoring,
    configParameters,
    derived,
    proceeds,
    configHash: hashConfigParameters(configParameters),
  };
}

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function hashConfigParameters(p: DbcConfigParameters): string {
  return createHash("sha256").update(toCanonicalJson(p)).digest("hex");
}

/** Deterministic JSON description (bigints as decimal strings, fixed key order). */
export function mercesCurveConfigToJson(cfg: MercesCurveConfig): string {
  return toCanonicalJson(cfg);
}

/**
 * Parse a config file. The file is rebuilt from its `input` block and must reproduce the stored
 * `configParameters` bit for bit; a mismatch means the file was edited or produced by another version.
 */
export function mercesCurveConfigFromJson(json: string): MercesCurveConfig {
  const j = JSON.parse(json) as Jsonified<MercesCurveConfig>;
  if (j.schema !== "merces.meteora.curve-config/1") throw new MercesConfigError("InvalidInput", `unknown schema ${String(j.schema)}`);
  const i = j.input;
  const input: MercesCurveInput = {
    seriesLabel: i.seriesLabel,
    trailingAnnualIncome: BigInt(i.trailingAnnualIncome),
    targetRaise: BigInt(i.targetRaise),
    unitsOnCurve: BigInt(i.unitsOnCurve),
    issuerUnits: BigInt(i.issuerUnits),
    issuerVesting: {
      cliffSeconds: i.issuerVesting.cliffSeconds,
      periods: i.issuerVesting.periods,
      periodSeconds: i.issuerVesting.periodSeconds,
      cliffUnlockUnits: BigInt(i.issuerVesting.cliffUnlockUnits ?? "0"),
    },
    maxRaiseMultipleWad: BigInt(i.maxRaiseMultipleWad),
    startValuationMultipleWad: BigInt(i.startValuationMultipleWad),
    maxPriceRampWad: BigInt(i.maxPriceRampWad),
    capMultipleWad: BigInt(i.capMultipleWad),
    quoteMint: i.quoteMint,
    quoteDecimals: i.quoteDecimals,
    tokenDecimals: i.tokenDecimals,
    tokenType: i.tokenType,
    tokenAuthorityOption: i.tokenAuthorityOption,
    tradingFeeBps: i.tradingFeeBps,
    creatorTradingFeePercentage: i.creatorTradingFeePercentage,
    collectFeeMode: i.collectFeeMode,
    migrationFee: i.migrationFee,
    migrationFeeOption: i.migrationFeeOption,
    liquidityDistribution: i.liquidityDistribution,
    activationType: i.activationType,
    poolCreationFeeLamports: BigInt(i.poolCreationFeeLamports),
    dammConfig: i.dammConfig,
  };
  const rebuilt = buildMercesCurveConfig(input);
  const stored = configParametersFromJson(j.configParameters);
  if (hashConfigParameters(stored) !== rebuilt.configHash || j.configHash !== rebuilt.configHash) {
    throw new MercesConfigError("InvalidInput", "config file does not reproduce from its input block (edited or stale)");
  }
  return rebuilt;
}

/** The `input` block as it appears in JSON (handy for CLIs). */
export function describeInput(cfg: MercesCurveConfig): Jsonified<ResolvedMercesCurveInput> {
  return jsonify(cfg.input);
}
