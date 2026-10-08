/**
 * Meteora Dynamic Bonding Curve port (E14, R35; Solana only). Shaped after @meteora-ag/dynamic-bonding-curve-sdk 1.5.x
 * (verified 2026-10-07; program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN on mainnet and devnet): a config key holds
 * the curve parameters, a pool is created from it, swaps move along the curve, and the pool migrates ("graduates")
 * to a DAMM v2 pool once the migration quote threshold is reached. Stage 1 owns the oracle-driven config generator;
 * this port runs it and reads curve progress. Only the mock exists until Stage 1 lands.
 */
export interface CurveConfigInput {
  seriesId: string;
  quoteMint: string; // USDC mint: the curve quotes in USDC (B8)
  /** target raise at graduation, quote base units */
  migrationQuoteThreshold: string;
  /** initial market cap proxy: reserve price per unit, quote base units */
  initialPricePerUnit: string;
  totalSupplyUnits: string;
}

export interface CurveConfig {
  configKey: string;
  params: Record<string, string | number>;
  generatedBy: 'stage1-oracle-config' | 'mock';
}

export interface CurvePoolState {
  pool: string;
  configKey: string;
  quoteRaised: string;
  unitsSold: string;
  spotPrice: string;
  /** 0–10000 bps toward the migration threshold */
  progressBps: number;
  graduated: boolean;
  dammPool: string | null;
}

export interface MeteoraPort {
  readonly provider: 'meteora-dbc' | 'mock';
  /** Runs Stage 1's config generator for a series (buildCurveWithMarketCap in the SDK). */
  generateConfig(input: CurveConfigInput): Promise<CurveConfig>;
  getPoolState(pool: string): Promise<CurvePoolState | null>;
  /** Quote a buy on the curve: units out for quote in (swapQuote in the SDK). */
  quoteBuy(pool: string, quoteIn: string): Promise<{ unitsOut: string; priceImpactBps: number; spotAfter: string }>;
  /** Quote-token badge requirement for non-standard quote mints (Token-2022 with extensions); classic SPL USDC needs none. */
  tokenBadgeRequired(quoteMint: string): Promise<boolean>;
}

export class MockMeteora implements MeteoraPort {
  readonly provider = 'mock' as const;
  readonly pools = new Map<string, CurvePoolState & { threshold: bigint; basePrice: bigint }>();
  async generateConfig(input: CurveConfigInput): Promise<CurveConfig> {
    const configKey = `cfg_${input.seriesId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
    const pool = `pool_${configKey}`;
    this.pools.set(pool, { pool, configKey, quoteRaised: '0', unitsSold: '0', spotPrice: input.initialPricePerUnit, progressBps: 0, graduated: false, dammPool: null, threshold: BigInt(input.migrationQuoteThreshold), basePrice: BigInt(input.initialPricePerUnit) });
    return { configKey, params: { quoteMint: input.quoteMint, migrationQuoteThreshold: input.migrationQuoteThreshold, initialPricePerUnit: input.initialPricePerUnit, totalSupplyUnits: input.totalSupplyUnits, curve: 'linear-mock' }, generatedBy: 'mock' };
  }
  async getPoolState(pool: string): Promise<CurvePoolState | null> {
    const p = this.pools.get(pool);
    if (!p) return null;
    const { threshold: _t, basePrice: _b, ...state } = p;
    return state;
  }
  async quoteBuy(pool: string, quoteIn: string): Promise<{ unitsOut: string; priceImpactBps: number; spotAfter: string }> {
    const p = this.pools.get(pool);
    if (!p) throw new Error('unknown pool');
    const spot = BigInt(p.spotPrice);
    const units = BigInt(quoteIn) / spot;
    const spotAfter = p.basePrice + (p.basePrice * (BigInt(p.unitsSold) + units)) / 1000n;
    return { unitsOut: units.toString(), priceImpactBps: spot === 0n ? 0 : Number(((spotAfter - spot) * 10_000n) / spot), spotAfter: spotAfter.toString() };
  }
  async tokenBadgeRequired(quoteMint: string): Promise<boolean> {
    return quoteMint.startsWith('t22:'); // classic SPL mints (USDC) need no badge; Token-2022 mints with extensions do
  }
  /** test hook: mirror a simulator buy into the mock pool */
  applyBuy(pool: string, quoteIn: bigint, unitsOut: bigint): void {
    const p = this.pools.get(pool);
    if (!p) return;
    p.quoteRaised = (BigInt(p.quoteRaised) + quoteIn).toString();
    p.unitsSold = (BigInt(p.unitsSold) + unitsOut).toString();
    p.spotPrice = (p.basePrice + (p.basePrice * BigInt(p.unitsSold)) / 1000n).toString();
    p.progressBps = Math.min(10_000, Number((BigInt(p.quoteRaised) * 10_000n) / p.threshold));
    if (BigInt(p.quoteRaised) >= p.threshold) {
      p.graduated = true;
      p.dammPool = `damm_${p.configKey}`;
    }
  }
}
