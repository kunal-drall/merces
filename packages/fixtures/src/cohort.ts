import { wadFromDecimal } from '@merces/math';

/**
 * The pilot cohort (B8): 12 invited issuers, three per persona, six on Solana and six on Monad.
 * Everything here is synthetic. Names are placeholders, not people.
 */
export type Persona = 'artist' | 'engineer' | 'freelancer' | 'founder';

export interface SyntheticIssuer {
  handle: string;
  persona: Persona;
  chain: 'solana' | 'monad';
  stablecoin: 'USDC' | 'USDG';
  country: string;
  reportingCurrency: string;
  /** income source for tier 2 (Reclaim provider) or 'split' for tier 1, 'attestor' for tier 3 */
  source: 'stripe' | 'deel' | 'distrokid' | 'split' | 'attestor';
  tier: 1 | 2 | 3;
  /** annual threshold in income base units (6 decimals) */
  threshold: bigint;
  shareRateWad: bigint;
  unitsOffered: bigint;
  reservePrice: bigint;
  minimumRaise: bigint;
  /** quarterly income path for a demo year (income base units, YTD cumulative) */
  incomeYtdByQuarter: [bigint, bigint, bigint, bigint];
  bio: string;
}

const M = (n: number) => BigInt(Math.round(n * 1e6));

export const PILOT_COHORT: SyntheticIssuer[] = [
  { handle: 'nova-synth', persona: 'artist', chain: 'solana', stablecoin: 'USDC', country: 'US', reportingCurrency: 'USD', source: 'distrokid', tier: 2, threshold: M(60_000), shareRateWad: wadFromDecimal('0.12'), unitsOffered: 1000n, reservePrice: M(8), minimumRaise: M(4000), incomeYtdByQuarter: [M(18_000), M(39_000), M(71_000), M(104_000)], bio: 'Electronic producer; royalties via distribution.' },
  { handle: 'ink-and-ash', persona: 'artist', chain: 'monad', stablecoin: 'USDC', country: 'GB', reportingCurrency: 'GBP', source: 'stripe', tier: 2, threshold: M(38_000), shareRateWad: wadFromDecimal('0.10'), unitsOffered: 800n, reservePrice: M(10), minimumRaise: M(4000), incomeYtdByQuarter: [M(9_000), M(21_000), M(36_000), M(58_000)], bio: 'Illustrator selling prints and commissions.' },
  { handle: 'low-tide', persona: 'artist', chain: 'solana', stablecoin: 'USDG', country: 'US', reportingCurrency: 'USD', source: 'stripe', tier: 2, threshold: M(60_000), shareRateWad: wadFromDecimal('0.08'), unitsOffered: 1200n, reservePrice: M(8), minimumRaise: M(4000), incomeYtdByQuarter: [M(25_000), M(52_000), M(80_000), M(99_000)], bio: 'Touring musician with merch and streaming income.' },
  { handle: 'kernel-k', persona: 'engineer', chain: 'monad', stablecoin: 'USDC', country: 'DE', reportingCurrency: 'EUR', source: 'deel', tier: 2, threshold: M(54_000), shareRateWad: wadFromDecimal('0.07'), unitsOffered: 1500n, reservePrice: M(12), minimumRaise: M(8000), incomeYtdByQuarter: [M(22_000), M(45_000), M(70_000), M(96_000)], bio: 'Systems engineer relocating for a research role.' },
  { handle: 'byte-anand', persona: 'engineer', chain: 'solana', stablecoin: 'USDC', country: 'IN', reportingCurrency: 'INR', source: 'deel', tier: 2, threshold: M(1_200_000), shareRateWad: wadFromDecimal('0.09'), unitsOffered: 1000n, reservePrice: M(9), minimumRaise: M(4000), incomeYtdByQuarter: [M(400_000), M(850_000), M(1_400_000), M(2_000_000)], bio: 'ML engineer taking a year to study.' },
  { handle: 'rust-belt', persona: 'engineer', chain: 'monad', stablecoin: 'USDC', country: 'US', reportingCurrency: 'USD', source: 'attestor', tier: 3, threshold: M(60_000), shareRateWad: wadFromDecimal('0.10'), unitsOffered: 900n, reservePrice: M(10), minimumRaise: M(4000), incomeYtdByQuarter: [M(30_000), M(60_000), M(90_000), M(120_000)], bio: 'Embedded engineer with W-2 income, annual CPA attestation.' },
  { handle: 'pixel-pat', persona: 'freelancer', chain: 'solana', stablecoin: 'USDC', country: 'US', reportingCurrency: 'USD', source: 'stripe', tier: 2, threshold: M(60_000), shareRateWad: wadFromDecimal('0.10'), unitsOffered: 1000n, reservePrice: M(8), minimumRaise: M(4000), incomeYtdByQuarter: [M(25_000), M(50_000), M(75_000), M(100_000)], bio: 'Product designer billing clients through Stripe invoices.' },
  { handle: 'copy-cass', persona: 'freelancer', chain: 'monad', stablecoin: 'USDC', country: 'CA', reportingCurrency: 'CAD', source: 'stripe', tier: 2, threshold: M(62_000), shareRateWad: wadFromDecimal('0.11'), unitsOffered: 700n, reservePrice: M(9), minimumRaise: M(3000), incomeYtdByQuarter: [M(12_000), M(26_000), M(41_000), M(59_000)], bio: 'Copywriter; income below threshold this year.' },
  { handle: 'lens-lior', persona: 'freelancer', chain: 'solana', stablecoin: 'USDG', country: 'US', reportingCurrency: 'USD', source: 'split', tier: 1, threshold: M(60_000), shareRateWad: wadFromDecimal('0.10'), unitsOffered: 1000n, reservePrice: M(8), minimumRaise: M(4000), incomeYtdByQuarter: [M(40_000), M(70_000), M(110_000), M(150_000)], bio: 'Photographer paid onchain through a split router.' },
  { handle: 'founder-fen', persona: 'founder', chain: 'monad', stablecoin: 'USDC', country: 'US', reportingCurrency: 'USD', source: 'attestor', tier: 3, threshold: M(60_000), shareRateWad: wadFromDecimal('0.15'), unitsOffered: 2000n, reservePrice: M(10), minimumRaise: M(10000), incomeYtdByQuarter: [M(0), M(0), M(45_000), M(45_000)], bio: 'Second-time founder; salary plus potential exit.' },
  { handle: 'orbit-ora', persona: 'founder', chain: 'solana', stablecoin: 'USDC', country: 'SG', reportingCurrency: 'SGD', source: 'stripe', tier: 2, threshold: M(70_000), shareRateWad: wadFromDecimal('0.12'), unitsOffered: 1500n, reservePrice: M(10), minimumRaise: M(7000), incomeYtdByQuarter: [M(30_000), M(60_000), M(95_000), M(140_000)], bio: 'SaaS founder drawing a salary from her company.' },
  { handle: 'mesh-mika', persona: 'founder', chain: 'monad', stablecoin: 'USDC', country: 'US', reportingCurrency: 'USD', source: 'stripe', tier: 2, threshold: M(60_000), shareRateWad: wadFromDecimal('0.10'), unitsOffered: 1000n, reservePrice: M(8), minimumRaise: M(4000), incomeYtdByQuarter: [M(15_000), M(30_000), M(180_000), M(200_000)], bio: 'Founder with a mid-year acquisition (liquidity event).' },
];

export const SYNTHETIC_BACKERS = Array.from({ length: 12 }, (_, i) => ({ handle: `backer-${String(i + 1).padStart(2, '0')}`, country: ['US', 'GB', 'DE', 'SG'][i % 4]!, eligible: i !== 11 }));
export const SYNTHETIC_ATTESTORS = [
  { handle: 'cpa-north', jurisdiction: 'US', kind: 'CPA' },
  { handle: 'ca-south', jurisdiction: 'GB', kind: 'CA' },
];
