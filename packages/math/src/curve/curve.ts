/**
 * Curve mode's pure arithmetic, ported from Stage 1's Rust (merces-common @1bfc66b `curve.rs:24-112`; A-MATH-3): P0
 * from the pool config, the offer check, units outstanding from the protocol-held balances, the DBC migration-fee
 * split and the tender quota of a redemption. Stage 1's TypeScript reference has no curve code. Quantities are u64 in
 * Rust; a value outside u64 is refused (see `scale.ts`).
 */
import { mulDiv } from '@merces/sdk';
import { argU64, argU8, mathError, toU64, unitScaleFor } from './scale.ts';

/**
 * `P0 = floor(migration_quote_threshold × 10^token_decimal / swap_base_amount)`, quote base units per whole unit, fixed
 * from the pool config alone and rounded in the issuer's favour (`curve.rs:24-39` `p0_per_unit`).
 */
export function p0PerUnit(migrationQuoteThreshold: bigint, swapBaseAmount: bigint, tokenDecimal: number): bigint {
  argU64(migrationQuoteThreshold, 'migration quote threshold');
  argU64(swapBaseAmount, 'swap base amount');
  if (swapBaseAmount === 0n) throw mathError('DivisionByZero', 'swap base amount is 0');
  return toU64(mulDiv(migrationQuoteThreshold, unitScaleFor(tokenDecimal), swapBaseAmount), 'P0');
}

/**
 * Whether the config's `swap_base_amount` sells the series' `units_offered` whole units: `floor(swap_base_amount /
 * 10^d)` is within one unit of `units_offered` (`curve.rs:41-53` `swap_base_matches_offer`).
 */
export function swapBaseMatchesOffer(swapBaseAmount: bigint, unitsOffered: bigint, tokenDecimal: number): boolean {
  argU64(swapBaseAmount, 'swap base amount');
  argU64(unitsOffered, 'units offered');
  const whole = swapBaseAmount / unitScaleFor(tokenDecimal);
  const diff = whole > unitsOffered ? whole - unitsOffered : unitsOffered - whole;
  return diff <= 1n;
}

/**
 * `units_outstanding = supply − Σ protocol_held` (the DAMM v2 pool's base vault, the DBC base vault, the locker escrow
 * and the leftover receiver). A sum past u64 is Overflow; holdings above the supply are InvalidInput
 * (`curve.rs:55-63` `units_outstanding`).
 */
export function unitsOutstanding(supply: bigint, protocolHeld: readonly bigint[]): bigint {
  argU64(supply, 'supply');
  let held = 0n;
  for (const h of protocolHeld) held = toU64(held + argU64(h, 'protocol-held balance'), 'protocol-held total');
  if (held > supply) throw mathError('InvalidInput', 'protocol-held units exceed the supply');
  return supply - held;
}

/** The DBC migration fee, split: the partner's share and the creator's. */
export interface MigrationFeeSplit {
  partner: bigint;
  creator: bigint;
}

/**
 * The DBC migration fee and its split: `q_gross = ceil(X × (100 − f) / 100)`, `fee = X − q_gross`,
 * `creator = floor(fee × c / 100)`, `partner = fee − creator`; a percentage above 100 is InvalidInput
 * (`curve.rs:65-94` `migration_fee_split`, which returns `(partner, creator)`).
 */
export function migrationFeeSplit(migrationQuoteThreshold: bigint, feePercentage: number, creatorFeePercentage: number): MigrationFeeSplit {
  argU64(migrationQuoteThreshold, 'migration quote threshold');
  argU8(feePercentage, 'fee percentage');
  argU8(creatorFeePercentage, 'creator fee percentage');
  if (feePercentage > 100 || creatorFeePercentage > 100) throw mathError('InvalidInput', 'a fee percentage is above 100');
  const x = migrationQuoteThreshold;
  const keep = 100n - BigInt(feePercentage);
  const qGross = (x * keep + 99n) / 100n;
  const fee = toU64(x - qGross, 'migration fee');
  const creator = toU64(mulDiv(fee, BigInt(creatorFeePercentage), 100n), 'creator migration fee');
  return { partner: fee - creator, creator };
}

/**
 * The tender quota of a redeemed curve series: a wallet tender of `amount` fits while
 * `tendered_total + staked_total + amount ≤ units_at_redemption` (staked units are reserved for their holders); a sum
 * past u64 is Overflow (`curve.rs:96-112` `wallet_tender_fits`).
 */
export function walletTenderFits(unitsAtRedemption: bigint, tenderedTotal: bigint, stakedTotal: bigint, amount: bigint): boolean {
  argU64(unitsAtRedemption, 'units at redemption');
  const used = toU64(argU64(tenderedTotal, 'tendered total') + argU64(stakedTotal, 'staked total'), 'tender quota used');
  return toU64(used + argU64(amount, 'amount'), 'tender quota used') <= unitsAtRedemption;
}
