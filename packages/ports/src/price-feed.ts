import { normalizePythPrice, invertRate } from '@merces/math';

/**
 * Price-feed ports (E8, C9). Pyth: shaped after the Hermes REST API / @pythnetwork/hermes-client 3.1.0
 * (`getLatestPriceUpdates(ids, {encoding, parsed})` → `{binary: {encoding, data[]}, parsed: [{id, price: {price, conf, expo, publish_time}}]}`).
 * Chainlink: shaped after AggregatorV3Interface.latestRoundData(). Facts and feed ids are in VERSIONS.md.
 */
export interface PythParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}
export interface PythPriceUpdate {
  binary: { encoding: 'hex' | 'base64'; data: string[] };
  parsed: PythParsedPrice[];
}

export interface PythPort {
  readonly provider: 'pyth-hermes' | 'mock';
  getLatestPriceUpdates(ids: string[]): Promise<PythPriceUpdate>;
  /** resolve FX feed ids by symbol (e.g. "FX.EUR/USD") from /v2/price_feeds?asset_type=fx */
  resolveFxFeedIds(symbols: string[]): Promise<Record<string, string | null>>;
}

export interface ChainlinkPort {
  readonly provider: 'chainlink' | 'mock';
  /** null when no feed is configured for the pair on the chain (true for every FX pair on Monad as of 2026-10-07) */
  latestRoundData(chain: string, pair: string): Promise<{ answer: bigint; decimals: number; updatedAt: number } | null>;
}

/** Pyth FX feed ids confirmed from the official price-feed list on 2026-10-07; others are resolved at runtime and fail closed. */
export const PYTH_FX_FEEDS_CONFIRMED: Record<string, string> = {
  'FX.EUR/USD': '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
  'FX.GBP/USD': '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1',
  'FX.AUD/USD': '0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80',
};

/** Pyth symbol for a Merces pair. EM pairs are quoted USD/XXX on Pyth (inverted by the keeper). */
export function pythSymbolFor(pair: string): { symbol: string; inverted: boolean } {
  const [base, quote] = pair.split('/');
  if (quote !== 'USD') throw new Error(`pairs must be <currency>/USD, got ${pair}`);
  const direct = ['EUR', 'GBP', 'AUD', 'NZD'];
  return direct.includes(base!) ? { symbol: `FX.${base}/USD`, inverted: false } : { symbol: `FX.USD/${base}`, inverted: true };
}

export function parsedToWad(p: PythParsedPrice, inverted: boolean): { rateWad: bigint; confWad: bigint } {
  const price = normalizePythPrice(BigInt(p.price.price), p.price.expo);
  const conf = BigInt(p.price.conf) === 0n ? 0n : normalizePythPrice(BigInt(p.price.conf), p.price.expo);
  if (!inverted) return { rateWad: price, confWad: conf };
  const rateWad = invertRate(price);
  const confWad = (conf * rateWad) / price; // relative confidence carries over
  return { rateWad, confWad };
}

/** Deterministic mock: a configurable table of symbol → price (decimal string), published "now". */
export class MockPyth implements PythPort {
  readonly provider = 'mock' as const;
  constructor(
    public prices: Record<string, { price: string; conf?: string }> = { 'FX.EUR/USD': { price: '1.08' }, 'FX.GBP/USD': { price: '1.27' }, 'FX.USD/INR': { price: '83.5' }, 'FX.USD/CAD': { price: '1.37' }, 'FX.USD/SGD': { price: '1.35' } },
    public now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  private idFor(symbol: string): string {
    return PYTH_FX_FEEDS_CONFIRMED[symbol] ?? '0x' + Buffer.from(symbol).toString('hex').padEnd(64, '0').slice(0, 64);
  }
  async resolveFxFeedIds(symbols: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(symbols.map((s) => [s, this.prices[s] ? this.idFor(s) : null]));
  }
  async getLatestPriceUpdates(ids: string[]): Promise<PythPriceUpdate> {
    const parsed: PythParsedPrice[] = [];
    for (const [symbol, p] of Object.entries(this.prices)) {
      const id = this.idFor(symbol);
      if (!ids.includes(id)) continue;
      const toInt = (d: string) => BigInt(Math.round(Number(d) * 1e8));
      parsed.push({ id, price: { price: toInt(p.price).toString(), conf: toInt(p.conf ?? (Number(p.price) * 0.0005).toFixed(8)).toString(), expo: -8, publish_time: this.now() } });
    }
    return { binary: { encoding: 'base64', data: parsed.map((p) => Buffer.from(`mock-vaa:${p.id}:${p.price.publish_time}`).toString('base64')) }, parsed };
  }
}

export class MockChainlink implements ChainlinkPort {
  readonly provider = 'mock' as const;
  constructor(public feeds: Record<string, { answer: string; decimals: number }> = {}, public now: () => number = () => Math.floor(Date.now() / 1000)) {}
  async latestRoundData(chain: string, pair: string): Promise<{ answer: bigint; decimals: number; updatedAt: number } | null> {
    const f = this.feeds[`${chain}:${pair}`];
    return f ? { answer: BigInt(Math.round(Number(f.answer) * 10 ** f.decimals)), decimals: f.decimals, updatedAt: this.now() } : null;
  }
}

/** Hermes adapter: the exact routes are named so going live is configuration. Not exercised without network access. */
export class HermesPyth implements PythPort {
  readonly provider = 'pyth-hermes' as const;
  constructor(private readonly baseUrl = 'https://hermes.pyth.network', private readonly fetchImpl: typeof fetch = fetch) {}
  async getLatestPriceUpdates(ids: string[]): Promise<PythPriceUpdate> {
    const u = new URL('/v2/updates/price/latest', this.baseUrl);
    for (const id of ids) u.searchParams.append('ids[]', id);
    u.searchParams.set('encoding', 'base64');
    u.searchParams.set('parsed', 'true');
    const res = await this.fetchImpl(u);
    if (!res.ok) throw new Error(`hermes ${res.status}`);
    return (await res.json()) as PythPriceUpdate;
  }
  async resolveFxFeedIds(symbols: string[]): Promise<Record<string, string | null>> {
    const res = await this.fetchImpl(new URL('/v2/price_feeds?asset_type=fx', this.baseUrl));
    if (!res.ok) throw new Error(`hermes ${res.status}`);
    const feeds = (await res.json()) as { id: string; attributes: { symbol: string } }[];
    return Object.fromEntries(symbols.map((s) => [s, feeds.find((f) => f.attributes.symbol === s)?.id ? '0x' + feeds.find((f) => f.attributes.symbol === s)!.id.replace(/^0x/, '') : null]));
  }
}
