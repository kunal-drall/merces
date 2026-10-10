/**
 * The one table of Stage 1's figures for the ported curve family (A-MATH-3): every figure Stage 1's curve fixtures
 * (`curve_config.json` `expected`, `curve_reports.json`), merces-common's unit tests and the LiteSVM curve tests
 * (`curve_mode.rs`) give for something the port computes (P0, the offer check, the migration-fee split, units
 * outstanding, the dues, the receipt and its capped acceptance, the redemption, the tender and its quota).
 *
 * Each row cites the Stage 1 lines it comes from (paths from the Stage 1 root; abbreviations below) and the text that
 * must still be there (`anchor`, compared without whitespace), and evaluates the statement those lines make with our
 * functions. A row whose citation no longer holds fails as stale, so a Stage 1 change to a figure cannot pass
 * unnoticed. Fixture rows anchor on the keys and read the values from the fixture, so a regenerated fixture is checked
 * as it now stands. A statement Stage 1 makes as a relation (the deposit is `scaled_amount(price, n, 10^6)`) is checked
 * as that relation; derived figures with no Stage 1 literal live in `packages/math/test/curve.test.ts`, and the
 * oracle corpus replays their inputs against Stage 1's Rust (`corpus.ts` edges).
 *
 * CM = solana/crates/merces-common/src, CMT = solana/tests/tests/curve_mode.rs, FX = solana/tests/fixtures/meteora,
 * TSRC = solana/tests/src/curve.rs, PROG = solana/programs/merces_protocol/src, GEN = solana/scripts/gen-curve-zk-fixture.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capPerUnit, newTailState, newVaultState, newYearGross, paymentStable, settleHolderDelta, WAD, YEAR, yearGrossAdd, type YearGrossRing } from '@merces/math';
import { canonical, refusal, type PortedFamily, type PortedName } from './family.ts';

const CM = 'solana/crates/merces-common/src';
const CMT = 'solana/tests/tests/curve_mode.rs';
const FX = 'solana/tests/fixtures/meteora';
const TSRC = 'solana/tests/src/curve.rs';
const PROG = 'solana/programs/merces_protocol/src';
const GEN = 'solana/scripts/gen-curve-zk-fixture.mjs';

export const CURVE_CONFIG = `${FX}/curve_config.json`;
export const CURVE_REPORTS = `${FX}/curve_reports.json`;

/** A citation: lines of a Stage 1 file (`path:from-to` or `path:line`) and the text they must still hold. */
export interface Cite {
  at: string;
  anchor: readonly string[];
}

type Rec = Record<string, string | number>;

/** Stage 1's curve fixtures, as read from the checkout. */
export interface Fixtures {
  config: { expected: Rec; pdaCreator: { expected: Rec } };
  reports: { terms: Rec; fixtures: { name: string; units_outstanding: string; payment_usd: string }[] };
}

export interface Figure {
  id: string;
  /** what Stage 1 states, in words */
  what: string;
  cites: readonly Cite[];
  /** the ported names the row exercises */
  ported: readonly PortedName[];
  /** our value and Stage 1's: they must agree exactly (compared as canonical JSON) */
  run: (f: PortedFamily, fx: Fixtures) => { got: unknown; want: unknown };
}

const S = 1_000_000n;
const USDC = 1_000_000n;
const H8 = 80_000_000_000_000_000n;
const big = (v: string | number | undefined) => BigInt(v as string | number);
const cite = (at: string, ...anchor: string[]): Cite => ({ at, anchor });

/** The refusal `f` throws, or "no refusal". */
function refused(f: () => unknown): string {
  try {
    f();
    return 'no refusal';
  } catch (e) {
    return refusal(e);
  }
}

/** A receipt from a fresh vault holding `paid` (the merces-common tests pass the accumulators in each time). */
function receipt(f: PortedFamily, g: bigint, n: bigint, cap: bigint, scale: bigint, paid: bigint, carry: bigint, feeBps: number) {
  return f.vaultReceiveGrossScaled({ ...newVaultState(), paidPerUnitWad: paid, carryWad: carry }, g, n, cap, scale, feeBps, 0);
}

/** The redemption.rs tests' ring (`ring(&[...])` at redemption.rs:150-156), per accounting unit at `scale`. */
function ringOf(entries: readonly (readonly [number, bigint])[], scale: bigint): YearGrossRing {
  return entries.reduce((g, [y, v]) => yearGrossAdd(g, y, v / scale), newYearGross());
}

/** The redemption.rs tests' inputs at scale 1 and per base lamport (accumulators and ring divided by 10^6). */
function quote(f: PortedFamily, scale: bigint, i: { cap: bigint; paid: bigint; t: bigint; entries?: readonly (readonly [number, bigint])[]; hurdle?: bigint; k?: number }) {
  return f.redemptionQuoteScaled({
    p0: 1_000_000n,
    hurdleRateWad: i.hurdle ?? H8,
    payoutMultipleK: i.k ?? 5,
    t: i.t,
    capPerUnit: i.cap,
    paidPerUnitWad: i.paid / scale,
    yearGross: ringOf(i.entries ?? [], scale),
    unitsOutstanding: 1n,
    unitScale: scale,
  });
}

/** A statement checked at scale 1 and per base lamport: the same figure at both. */
const bothScales = <T>(at: (scale: bigint) => T, want: T) => ({ got: [at(1n), at(S)], want: [want, want] });

// the inp() helper of vault.rs's tests runs at scale 1
const VAULT_INP = cite(`${CM}/vault.rs:178-188`, 'fn inp(gross: u64, units: u64, cap: u64, paid: u128, carry: u64, fee: u16) -> ReceiveInput', 'unit_scale: 1,');
const H8_CONST = cite(`${CM}/redemption.rs:148`, 'const H8: u64 = 80_000_000_000_000_000;');
const Y2 = [[0, 300_000n * WAD], [1, 300_000n * WAD]] as const;

/** The curve series' figures from the fixtures: units outstanding, P0, the cap (Parameters::DEFAULT) and the fee. */
function curveSeries(fx: Fixtures) {
  const n = big(fx.reports.fixtures[0]!.units_outstanding);
  const p0 = big(fx.config.expected.p0PerUnit);
  // Parameters::DEFAULT: cap multiple 2.5 (CM params.rs:48), payout fee 500 bps (:54); the curve series takes them (TSRC:120-125)
  const cap = capPerUnit(2_500_000_000_000_000_000n, p0);
  return { n, p0, cap, feeBps: 500 };
}
const DEFAULTS = [cite(`${CM}/params.rs:48`, 'cap_multiple_wad: 2_500_000_000_000_000_000,'), cite(`${CM}/params.rs:54`, 'payout_fee_bps: 500,'), cite(`${TSRC}:120-125`, 'let d = merces_common::params::Parameters::DEFAULT;', 'cap_multiple_wad: d.cap_multiple_wad,')];
const N_IS_THE_FIXTURE = cite(`${CMT}:248-255`, 'let n = c.env.ledger(&series).unwrap().units_outstanding;', 'assert_eq!(n, fixture_units, "the proof fixture matches the DBC buys");');

/** The census of curve_mode.rs's migration test (CMT:708-766), from the fixture's supply, vesting and units. */
function census(fx: Fixtures) {
  const supply = big(fx.config.expected.initialBaseSupply);
  const vesting = big(fx.config.expected.lockedVestingTotal);
  const n0 = big(fx.reports.fixtures[0]!.units_outstanding);
  // before the migration the DBC base vault holds everything the buyers do not (the census's one non-zero term)
  const vault0 = supply - n0;
  const protocolFee = 7n;
  const leftover = 3n;
  return { supply, vesting, n0, protocolFee, leftover, deposit: vault0 - vesting - protocolFee - leftover };
}
const CENSUS_ORDER = cite(`${PROG}/curve.rs:475-476`, 'let held = [dbc_vault, counted_damm, locker, leftover];', 'let outstanding = units_outstanding(supply, &held)');
const CENSUS_SETUP = cite(`${CMT}:711-716`, 'let vault0 = c.env.token_balance(&c.dbc.base_vault);', 'let vesting = fixture_u64(&fixture, "lockedVestingTotal");', 'let protocol_fee = 7u64;', 'let leftover = 3u64;', 'let deposit = vault0 - vesting - protocol_fee - leftover;');
const CENSUS_FIXTURE = cite(`${CURVE_CONFIG}:6-19`, '"initialBaseSupply"', '"lockedVestingTotal"');

/** After the fixture's first payment (CMT:291-303): the vault state per base lamport. */
function firstPayment(f: PortedFamily, fx: Fixtures) {
  const { n, cap, feeBps } = curveSeries(fx);
  const due = big(fx.reports.fixtures[0]!.payment_usd);
  return { due, ...f.vaultReceiveGrossScaled(newVaultState(), due, n, cap, S, feeBps, 0) };
}

export const FIGURES: readonly Figure[] = [
  // ---------------------------------------------------------------- merces-common curve.rs
  {
    id: 'curve.constants',
    what: 'a curve series has 6 base decimals and 10^6 base lamports per whole unit',
    cites: [cite(`${CM}/curve.rs:14-16`, 'pub const CURVE_BASE_DECIMALS: u8 = 6;', 'pub const CURVE_UNIT_SCALE: u64 = 1_000_000;')],
    ported: ['CURVE_BASE_DECIMALS', 'CURVE_UNIT_SCALE'],
    run: (f) => ({ got: [f.CURVE_BASE_DECIMALS, f.CURVE_UNIT_SCALE], want: [6, 1_000_000n] }),
  },
  ...([
    ['curve.p0.worked', ':123-126', 'X = 1,000 USDC over 100 units: P0 = 10 USDC', [1_000_000_000n, 100_000_000n], 10_000_000n, 'p0_per_unit(1_000_000_000, 100_000_000, 6).unwrap(), 10_000_000'],
    ['curve.p0.memo', ':128-131', 'X = 100,000 USDC over 10,000 units: P0 = 10 USDC', [100_000_000_000n, 10_000_000_000n], 10_000_000n, 'p0_per_unit(100_000_000_000, 10_000_000_000, 6).unwrap(), 10_000_000'],
    ['curve.p0.floor', ':133-136', 'P0 rounds down (issuer-favourable)', [1_000_000_000n, 100_000_002n], 9_999_999n, 'p0_per_unit(1_000_000_000, 100_000_002, 6).unwrap(), 9_999_999'],
  ] as const).map(([id, lines, what, [x, sb], want, anchor]): Figure => ({
    id,
    what,
    cites: [cite(`${CM}/curve.rs${lines}`, anchor)],
    ported: ['p0PerUnit'],
    run: (f) => ({ got: f.p0PerUnit(x, sb, 6), want }),
  })),
  {
    id: 'curve.p0.zero-swap-base',
    what: 'a zero swap base is a division by zero',
    cites: [cite(`${CM}/curve.rs:137`, 'assert_eq!(p0_per_unit(1, 0, 6), Err(MathError::DivisionByZero));')],
    ported: ['p0PerUnit'],
    run: (f) => ({ got: refused(() => f.p0PerUnit(1n, 0n, 6)), want: 'DivisionByZero' }),
  },
  ...([
    [':142', 100_000_000n, true],
    [':143', 99_999_998n, true],
    [':144', 101_000_000n, true],
    [':145', 98_999_999n, false],
    [':146', 102_000_000n, false],
  ] as const).map(([line, sb, want]): Figure => ({
    id: `curve.offer.${sb}`,
    what: `a swap base of ${sb} lamports ${want ? 'sells' : 'does not sell'} 100 whole units (the program's rounding is tolerated, one unit either way)`,
    cites: [cite(`${CM}/curve.rs${line}`, `assert!(${want ? '' : '!'}swap_base_matches_offer(${sb.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_')}, 100, 6).unwrap());`)],
    ported: ['swapBaseMatchesOffer'],
    run: (f) => ({ got: f.swapBaseMatchesOffer(sb, 100n, 6), want }),
  })),
  ...([
    ['curve.split.none', ':152-153', 100_000_000_000n, 0, 0, [0n, 0n], 'migration_fee_split(x, 0, 0).unwrap(), (0, 0)'],
    ['curve.split.creator', ':152-157', 100_000_000_000n, 20, 100, [0n, 20_000_000_000n], 'migration_fee_split(x, 20, 100).unwrap(), (0, 20_000_000_000)'],
    ['curve.split.partner', ':152-158', 100_000_000_000n, 99, 0, [99_000_000_000n, 0n], 'migration_fee_split(x, 99, 0).unwrap(), (99_000_000_000, 0)'],
    ['curve.split.half', ':152-162', 100_000_000_000n, 99, 50, [49_500_000_000n, 49_500_000_000n], 'migration_fee_split(x, 99, 50).unwrap(), (49_500_000_000, 49_500_000_000)'],
    ['curve.split.memo', ':164-167', 750_000_000n, 10, 50, [37_500_000n, 37_500_000n], 'migration_fee_split(750_000_000, 10, 50).unwrap(), (37_500_000, 37_500_000)'],
    ['curve.split.fixture', ':169-172', 1_000_000_000n, 99, 0, [990_000_000n, 0n], 'migration_fee_split(1_000_000_000, 99, 0).unwrap(), (990_000_000, 0)'],
  ] as const).map(([id, lines, x, fee, creator, [p, c], anchor]): Figure => ({
    id,
    what: `the DBC migration fee of X = ${x} at ${fee} %, creator ${creator} %: (partner, creator) = (${p}, ${c})`,
    cites: [cite(`${CM}/curve.rs${lines}`, ...(lines.startsWith(':152') ? ['let x = 100_000_000_000u64;'] : []), anchor)],
    ported: ['migrationFeeSplit'],
    run: (f) => ({ got: f.migrationFeeSplit(x, fee, creator), want: { partner: p, creator: c } }),
  })),
  {
    id: 'curve.outstanding.underflow',
    what: 'protocol-held balances above the supply are refused',
    cites: [cite(`${CM}/curve.rs:177-180`, 'units_outstanding(110, &[10, 0, 363, 0]), Err(MathError::InvalidInput)')],
    ported: ['unitsOutstanding'],
    run: (f) => ({ got: refused(() => f.unitsOutstanding(110n, [10n, 0n, 363n, 0n])), want: 'InvalidInput' }),
  },
  {
    id: 'curve.outstanding.sum',
    what: 'units outstanding are the supply less every protocol-held balance',
    cites: [cite(`${CM}/curve.rs:181`, 'assert_eq!(units_outstanding(1_000, &[10, 20, 30, 40]).unwrap(), 900);')],
    ported: ['unitsOutstanding'],
    run: (f) => ({ got: f.unitsOutstanding(1_000n, [10n, 20n, 30n, 40n]), want: 900n }),
  },
  {
    id: 'curve.quota',
    what: 'a wallet tender fits while tendered + staked + amount stays within the snapshot (inclusive)',
    cites: [cite(`${CM}/curve.rs:182-183`, 'assert!(wallet_tender_fits(100, 30, 50, 20).unwrap());', 'assert!(!wallet_tender_fits(100, 30, 50, 21).unwrap());')],
    ported: ['walletTenderFits'],
    run: (f) => ({ got: [f.walletTenderFits(100n, 30n, 50n, 20n), f.walletTenderFits(100n, 30n, 50n, 21n)], want: [true, false] }),
  },

  // ---------------------------------------------------------------- merces-common vault.rs (its tests run at scale 1)
  {
    id: 'vault.plain',
    what: 'a plain receipt below the cap: all accepted, 5 % fee, the exact accumulator step',
    cites: [VAULT_INP, cite(`${CM}/vault.rs:191-201`, 'receive_capped(inp(1_000_000, 100, 2_500_000, 0, 0, 500))', 'assert_eq!(out.accepted, 1_000_000);', 'assert_eq!(out.refund, 0);', 'assert_eq!(out.inc_wad, 10_000 * WAD);', 'assert_eq!(out.fee, 50_000);', 'assert_eq!(out.net, 950_000);', 'assert_eq!(out.delta_acc_wad, 9_500 * WAD);', 'assert_eq!(out.carry_wad_out, 0);', 'assert!(!out.capped);')],
    ported: ['vaultReceiveGrossScaled'],
    run: (f) => {
      const r = receipt(f, 1_000_000n, 100n, 2_500_000n, 1n, 0n, 0n, 500).result;
      return {
        got: [r.accepted, r.refund, r.incWad, r.fee, r.netAdded, r.deltaAccWad, r.carryWad, r.retired],
        want: [1_000_000n, 0n, 10_000n * WAD, 50_000n, 950_000n, 9_500n * WAD, 0n, false],
      };
    },
  },
  {
    id: 'vault.exact-carry',
    what: 'three net payments of 1 over 3 units: the carry stays below 3 and a holder of all 3 units is owed exactly 3',
    cites: [VAULT_INP, cite(`${CM}/vault.rs:204-217`, 'receive_capped(inp(1, 3, u64::MAX / 4, 0, carry, 0))', 'assert!(carry < 3);', 'assert_eq!(holder_delta(acc, 0, 3).unwrap(), 3);', 'assert_eq!(acc * 3 + u128::from(carry), 3 * WAD);')],
    ported: ['vaultReceiveGrossScaled'],
    run: (f) => {
      let acc = 0n;
      let carry = 0n;
      let below = true;
      for (let i = 0; i < 3; i++) {
        const r = receipt(f, 1n, 3n, (2n ** 64n - 1n) / 4n, 1n, 0n, carry, 0).result;
        acc += r.deltaAccWad;
        carry = r.carryWad;
        below &&= carry < 3n;
      }
      return { got: [below, settleHolderDelta(acc, 0n, 3n), acc * 3n + carry], want: [true, 3n, 3n * WAD] };
    },
  },
  ...([
    ['vault.cap.truncates', ':221-225', 'a receipt past the cap is truncated to it and the excess refunded', 20_000_000n, 2_500_000n, ['receive_capped(inp(20_000_000, 100, 2_500_000, 2_400_000 * WAD, 0, 500))', 'assert!(out.capped);', 'assert_eq!(out.accepted, 10_000_000);', 'assert_eq!(out.refund, 10_000_000);', 'assert_eq!(out.inc_wad, 100_000 * WAD);'], { capped: true, accepted: 10_000_000n, refund: 10_000_000n, inc: 100_000n * WAD }],
    ['vault.cap.exact', ':227-230', 'a receipt landing exactly on the cap caps, with no refund', 10_000_000n, 2_500_000n, ['receive_capped(inp(10_000_000, 100, 2_500_000, 2_400_000 * WAD, 0, 500))', 'assert!(exact.capped);', 'assert_eq!(exact.refund, 0);'], { capped: true, refund: 0n }],
    ['vault.cap.below', ':232-236', 'one base unit below the cap does not cap', 9_999_999n, 2_500_000n, ['!receive_capped(inp(9_999_999, 100, 2_500_000, 2_400_000 * WAD, 0, 500)).unwrap().capped'], { capped: false }],
    ['vault.cap.lowered', ':238-241', 'a cap lowered below what was paid: the effective cap is what was paid, all refunded, capped', 5n, 1n, ['receive_capped(inp(5, 100, 1, 2_400_000 * WAD, 0, 500))', 'assert!(low.capped);', 'assert_eq!(low.accepted, 0);', 'assert_eq!(low.refund, 5);'], { capped: true, accepted: 0n, refund: 5n }],
  ] as const).map(([id, lines, what, g, cap, anchors, want]): Figure => ({
    id,
    what,
    cites: [VAULT_INP, cite(`${CM}/vault.rs${lines}`, ...anchors)],
    ported: ['vaultReceiveGrossScaled'],
    run: (f) => {
      const r = receipt(f, g, 100n, cap, 1n, 2_400_000n * WAD, 0n, 500).result;
      const all = { capped: r.retired, accepted: r.accepted, refund: r.refund, inc: r.incWad };
      return { got: Object.fromEntries(Object.keys(want).map((k) => [k, all[k as keyof typeof all]])), want };
    },
  })),
  ...([
    [':242', 1n, 2_400_000n * WAD, 1n, true, 'assert!(is_capped(1, 2_400_000 * WAD, 1).unwrap());'],
    [':243', 2_500_000n, 2_400_000n * WAD, 1n, false, 'assert!(!is_capped(2_500_000, 2_400_000 * WAD, 1).unwrap());'],
    [':244-245', 25_000_000n, 25n * WAD, S, true, 'assert!(is_capped(25_000_000, 25 * WAD, 1_000_000).unwrap());'],
    [':246', 25_000_000n, 25n * WAD - 1n, S, false, 'assert!(!is_capped(25_000_000, 25 * WAD - 1, 1_000_000).unwrap());'],
  ] as const).map(([lines, cap, paid, scale, want, anchor]): Figure => ({
    id: `vault.is-capped${lines}`,
    what: `retire_if_capped's test at scale ${scale}: ${want ? 'capped' : 'not capped'}${scale === S ? ' (25 USDC per unit is 25 base units per base lamport)' : ''}`,
    cites: [cite(`${CM}/vault.rs${lines}`, anchor)],
    ported: ['isCappedScaled'],
    run: (f) => ({ got: f.isCappedScaled({ paidPerUnitWad: paid }, cap, scale), want }),
  })),
  {
    id: 'vault.zero-units',
    what: 'no receipt without units: merces-common refuses (InvalidInput) after the program already refused with NoUnitsOutstanding, the name our vault and tail throw, at every scale',
    cites: [
      VAULT_INP,
      cite(`${CM}/vault.rs:260-264`, 'receive_capped(inp(1, 0, 1, 0, 0, 0)), Err(MathError::InvalidInput)'),
      cite(`${PROG}/common.rs:540-541`, 'let units = self.units_outstanding;', 'require!(units > 0, ProtocolError::NoUnitsOutstanding);'),
      cite(`${PROG}/common.rs:600-601`, 'let units = self.units_at_redemption;', 'require!(units > 0, ProtocolError::NoUnitsOutstanding);'),
    ],
    ported: ['vaultReceiveGrossScaled', 'tailReceiveScaled'],
    run: (f) => ({
      got: [refused(() => receipt(f, 1n, 0n, 1n, 1n, 0n, 0n, 0)), refused(() => receipt(f, 1n, 0n, 1n, S, 0n, 0n, 0)), refused(() => f.tailReceiveScaled(newTailState(1n), 1n, 0n, 0, S))],
      want: ['NoUnitsOutstanding', 'NoUnitsOutstanding', 'NoUnitsOutstanding'],
    }),
  },

  // ---------------------------------------------------------------- merces-common redemption.rs (scale 1 and per base lamport)
  ...([
    [':160', 0n, 1_000_000n, 'hurdle_price(1_000_000, H8, 0).unwrap(), 1_000_000'],
    [':161', YEAR, 1_080_000n, 'hurdle_price(1_000_000, H8, YEAR).unwrap(), 1_080_000'],
    [':162', 2n * YEAR, 1_166_400n, 'hurdle_price(1_000_000, H8, 2 * YEAR).unwrap(), 1_166_400'],
    [':163', YEAR / 2n, 1_040_000n, 'hurdle_price(1_000_000, H8, YEAR / 2).unwrap(), 1_040_000'],
    [':164-167', YEAR + YEAR / 2n, 1_123_200n, 'hurdle_price(1_000_000, H8, YEAR + YEAR / 2).unwrap(), 1_123_200'],
  ] as const).map(([lines, t, want, anchor]): Figure => ({
    id: `redemption.hurdle${lines}`,
    what: `the hurdle compounds yearly and interpolates: P_hurdle(${t}s) = ${want}, the same per whole unit at every scale`,
    cites: [H8_CONST, cite(`${CM}/redemption.rs${lines}`, anchor)],
    ported: ['redemptionQuoteScaled'],
    run: (f) => bothScales((s) => quote(f, s, { cap: 2_500_000n, paid: 0n, t }).pHurdle, want),
  })),
  {
    id: 'redemption.hurdle-decides',
    what: 'half a year in, no payout year yet: the hurdle decides (1,040,000) and D_avg is 0',
    cites: [H8_CONST, cite(`${CM}/redemption.rs:172-186`, 'let empty = ring(&[]);', 'clearing_price: 1_000_000,', 'payout_multiple_k: 5,', 'cap_per_unit: 2_500_000,', 'paid_per_unit_wad: 0,', 'now: YEAR / 2,', 'assert_eq!(p.price, 1_040_000);', 'assert_eq!(p.d_avg, 0);')],
    ported: ['redemptionQuoteScaled'],
    run: (f) => bothScales((s) => {
      const q = quote(f, s, { cap: 2_500_000n, paid: 0n, t: YEAR / 2n });
      return [q.pRedeem, q.dAvg ?? 0n];
    }, [1_040_000n, 0n]),
  },
  {
    id: 'redemption.multiple-decides',
    what: 'two years of 300,000 per unit: k × D_avg = 1,500,000 decides over the hurdle 1,166,400, within C_remaining 1,900,000',
    cites: [H8_CONST, cite(`${CM}/redemption.rs:187-203`, 'let y = ring(&[(0, 300_000 * WAD), (1, 300_000 * WAD)]);', 'paid_per_unit_wad: 600_000 * WAD,', 'now: 2 * YEAR,', 'assert_eq!(p.d_avg, 300_000);', 'assert_eq!(p.hurdle, 1_166_400);', 'assert_eq!(p.cap_remaining, 1_900_000);', 'assert_eq!(p.price, 1_500_000);')],
    ported: ['redemptionQuoteScaled'],
    run: (f) => bothScales((s) => {
      const q = quote(f, s, { cap: 2_500_000n, paid: 600_000n * WAD, t: 2n * YEAR, entries: Y2 });
      return [q.dAvg, q.pHurdle, q.cRemaining, q.pRedeem];
    }, [300_000n, 1_166_400n, 1_900_000n, 1_500_000n]),
  },
  {
    id: 'redemption.cap-decides',
    what: 'with 2,000,000 per unit paid against a 2,500,000 cap, C_remaining = 500,000 decides',
    cites: [H8_CONST, cite(`${CM}/redemption.rs:204-216`, 'paid_per_unit_wad: 2_000_000 * WAD,', 'now: 2 * YEAR,', 'assert_eq!(p.price, 500_000);')],
    ported: ['redemptionQuoteScaled'],
    run: (f) => bothScales((s) => quote(f, s, { cap: 2_500_000n, paid: 2_000_000n * WAD, t: 2n * YEAR, entries: Y2 }).pRedeem, 500_000n),
  },
  {
    id: 'redemption.ceil',
    what: 'one wei past the cap (per accounting unit) rounds the paid amount up: C_remaining and the price saturate at 0',
    cites: [H8_CONST, cite(`${CM}/redemption.rs:217-231`, '// ceil rounding favours the issuer; a lowered cap saturates to 0', 'cap_per_unit: 2_000_000,', 'paid_per_unit_wad: 2_000_000 * WAD + 1,', 'assert_eq!(p.cap_remaining, 0);', 'assert_eq!(p.price, 0);')],
    ported: ['redemptionQuoteScaled', 'capRemainingScaled'],
    run: (f) => {
      // the "+ 1" is one wei on the per-accounting-unit accumulator at either scale
      const at = (s: bigint) => {
        const q = f.redemptionQuoteScaled({ p0: 1_000_000n, hurdleRateWad: H8, payoutMultipleK: 5, t: 2n * YEAR, capPerUnit: 2_000_000n, paidPerUnitWad: (2_000_000n * WAD) / s + 1n, yearGross: ringOf(Y2, s), unitsOutstanding: 1n, unitScale: s });
        return [q.cRemaining, q.pRedeem, f.capRemainingScaled(2_000_000n, (2_000_000n * WAD) / s + 1n, s)];
      };
      return bothScales(at, [0n, 0n, 0n]);
    },
  },
  {
    id: 'redemption.trailing-window',
    what: 'year 4 re-tags slot 0; at 4 years D_avg is the trailing three years (100,000 + 200,000 + 300,000) / 3 = 200,000 and P0 decides',
    cites: [cite(`${CM}/redemption.rs:236-260`, '(0, 900_000 * WAD),', '(1, 100_000 * WAD),', '(2, 200_000 * WAD),', '(3, 300_000 * WAD),', 'year_gross_add(&mut r, 4, 5 * WAD).unwrap();', 'hurdle_rate_wad: 0,', 'payout_multiple_k: 1,', 'cap_per_unit: 10_000_000,', 'now: 4 * YEAR,', 'assert_eq!(p.d_avg, 200_000);', 'assert_eq!(p.price, 1_000_000);')],
    ported: ['redemptionQuoteScaled'],
    run: (f) => bothScales((s) => {
      const q = quote(f, s, { cap: 10_000_000n, paid: 0n, t: 4n * YEAR, hurdle: 0n, k: 1, entries: [[0, 900_000n * WAD], [1, 100_000n * WAD], [2, 200_000n * WAD], [3, 300_000n * WAD], [4, 5n * WAD]] });
      return [q.dAvg, q.pRedeem];
    }, [200_000n, 1_000_000n]),
  },

  // ---------------------------------------------------------------- the curve fixtures and the LiteSVM curve tests
  {
    id: 'fixture.p0',
    what: 'curve_config.json: P0 from the pool config is the fixture\'s p0PerUnit, which activate_curve records as the clearing price',
    cites: [cite(`${CURVE_CONFIG}:6-19`, '"expected": {', '"tokenDecimal"', '"migrationQuoteThreshold"', '"swapBaseAmount"', '"p0PerUnit"'), cite(`${CMT}:202`, 'assert_eq!(s.clearing_price, fixture_u64(&fixture, "p0PerUnit"));')],
    ported: ['p0PerUnit'],
    run: (f, fx) => {
      const e = fx.config.expected;
      return { got: f.p0PerUnit(big(e.migrationQuoteThreshold), big(e.swapBaseAmount), Number(e.tokenDecimal)), want: big(e.p0PerUnit) };
    },
  },
  {
    id: 'fixture.offer',
    what: 'curve_config.json: the swap base sells the curve series\' 100 units, all of which activate_curve records as sold',
    cites: [cite(`${CURVE_CONFIG}:6-19`, '"swapBaseAmount"', '"tokenDecimal"'), cite(`${TSRC}:119-122`, 'pub fn curve_series_args(', 'units_offered: 100,'), cite(`${CMT}:203`, 'assert_eq!(s.units_sold, fixture_u64(&fixture, "swapBaseAmount"));')],
    ported: ['swapBaseMatchesOffer'],
    run: (f, fx) => ({ got: f.swapBaseMatchesOffer(big(fx.config.expected.swapBaseAmount), 100n, Number(fx.config.expected.tokenDecimal)), want: true }),
  },
  {
    id: 'fixture.split',
    what: 'curve_config.json: the migration fee splits into the fixture\'s partner and creator shares; the treasury\'s proceeds are the partner share',
    cites: [cite(`${CURVE_CONFIG}:6-19`, '"migrationQuoteThreshold"', '"migrationFeePercentage"', '"creatorMigrationFeePercentage"', '"partnerMigrationFee"', '"creatorMigrationFee"'), cite(`${CMT}:219-220`, 'assert_eq!(t.proceeds, fixture_u64(&fixture, "partnerMigrationFee"));')],
    ported: ['migrationFeeSplit'],
    run: (f, fx) => {
      const e = fx.config.expected;
      return { got: f.migrationFeeSplit(big(e.migrationQuoteThreshold), Number(e.migrationFeePercentage), Number(e.creatorMigrationFeePercentage)), want: { partner: big(e.partnerMigrationFee), creator: big(e.creatorMigrationFee) } };
    },
  },
  {
    id: 'fixture.pda.p0',
    what: 'curve_config.json pdaCreator: P0 from the PDA-creator pool config',
    cites: [cite(`${CURVE_CONFIG}:23-36`, '"tokenDecimal"', '"migrationQuoteThreshold"', '"swapBaseAmount"', '"p0PerUnit"')],
    ported: ['p0PerUnit'],
    run: (f, fx) => {
      const e = fx.config.pdaCreator.expected;
      return { got: f.p0PerUnit(big(e.migrationQuoteThreshold), big(e.swapBaseAmount), Number(e.tokenDecimal)), want: big(e.p0PerUnit) };
    },
  },
  {
    id: 'fixture.pda.split',
    what: 'curve_config.json pdaCreator: both migration-fee shares, which the PDA withdraws into the treasury: 990 USDC in all',
    cites: [cite(`${CURVE_CONFIG}:23-36`, '"migrationFeePercentage"', '"creatorMigrationFeePercentage"', '"partnerMigrationFee"', '"creatorMigrationFee"'), cite(`${CMT}:1017-1024`, 'let f = &curve_fixture()["pdaCreator"]["expected"];', 'share("partnerMigrationFee") + share("creatorMigrationFee")', 'assert_eq!(t.proceeds, 990 * ONE_USDC);')],
    ported: ['migrationFeeSplit'],
    run: (f, fx) => {
      const e = fx.config.pdaCreator.expected;
      const s = f.migrationFeeSplit(big(e.migrationQuoteThreshold), Number(e.migrationFeePercentage), Number(e.creatorMigrationFeePercentage));
      return { got: [s, s.partner + s.creator], want: [{ partner: big(e.partnerMigrationFee), creator: big(e.creatorMigrationFee) }, 990n * USDC] };
    },
  },
  ...([
    ['fixture.dues.q1', 0, 80_000_000_000n, `${GEN}:50`, 'name: "curve_q1", prevYtd: 0n, prevSalt: 0n, prior: ZERO, ytd: 80_000_000_000n', `${CMT}:292-293`, 'assert_eq!(due, 1_999_999_960);'],
    ['fixture.dues.q1-cap', 1, 200_000_000_000n, `${GEN}:52`, 'name: "curve_q1_cap", prevYtd: 0n, prevSalt: 0n, prior: ZERO, ytd: 200_000_000_000n', `${CMT}:928-929`, 'assert_eq!(due, 13_999_999_720);'],
  ] as const).map(([id, i, ytd, genAt, genAnchor, cmtAt, cmtAnchor]): Figure => ({
    id,
    what: `curve_reports.json: the dues of ${id.endsWith('cap') ? 'curve_q1_cap' : 'curve_q1'}, r per base lamport × N base lamports × (YTD − θ), are the fixture's payment_usd, which the program asserts; r per base lamport is 0.001 per whole unit over CURVE_UNIT_SCALE`,
    cites: [
      cite(`${CURVE_REPORTS}:3-${i === 0 ? 15 : 23}`, '"theta"', '"r_wad_per_base_lamport"', '"units_outstanding"', '"payment_usd"'),
      cite(`${GEN}:36-46`, 'r = 0.001 per whole unit = 10^9 per base lamport (10^6 per unit)', 'const owed = (ytd) => (R_WAD_BASE * UNITS * (ytd > THETA ? ytd - THETA : 0n)) / WAD;'),
      cite(genAt, genAnchor),
      cite(cmtAt, cmtAnchor),
    ],
    ported: ['CURVE_UNIT_SCALE'],
    run: (f, fx) => {
      const r = big(fx.reports.terms.r_wad_per_base_lamport);
      const x = fx.reports.fixtures[i]!;
      const dues = paymentStable({ rWad: r, unitsOutstanding: big(x.units_outstanding), theta: big(fx.reports.terms.theta), incomeYtd: ytd, priorIncomeYtd: 0n, fxAvgWad: WAD });
      return { got: [dues, r * f.CURVE_UNIT_SCALE], want: [big(x.payment_usd), WAD / 1_000n] };
    },
  })),
  {
    id: 'fixture.census.migrated',
    what: 'after the (mocked) migration the census counts the DBC vault\'s protocol fee, the DAMM deposit, the locker\'s vesting and the leftover: units outstanding unchanged (the fixture\'s N)',
    cites: [CENSUS_FIXTURE, N_IS_THE_FIXTURE, CENSUS_SETUP, CENSUS_ORDER, cite(`${CMT}:726-739`, 'c.env.set_token_amount(&c.dbc.base_vault, protocol_fee);', '.mock_token_account(&census[5], &base, &DBC_POOL_AUTHORITY, deposit);', '.mock_token_account(&census[6], &base, &escrow_owner, vesting);', '.mock_token_account(&census[7], &base, &curve_authority(&series), leftover);', 'assert_eq!(c.env.ledger(&series).unwrap().units_outstanding, n0);')],
    ported: ['unitsOutstanding'],
    run: (f, fx) => {
      const c = census(fx);
      return { got: f.unitsOutstanding(c.supply, [c.protocolFee, c.deposit, c.vesting, c.leftover]), want: c.n0 };
    },
  },
  {
    id: 'fixture.census.vesting-claim',
    what: '4 units claimed from the locker become outstanding',
    cites: [CENSUS_FIXTURE, N_IS_THE_FIXTURE, CENSUS_SETUP, CENSUS_ORDER, cite(`${CMT}:740-752`, 'let released = 4 * CURVE_UNIT_SCALE;', 'c.env.set_token_amount(&census[6], vesting - released);', 'n0 + released')],
    ported: ['unitsOutstanding', 'CURVE_UNIT_SCALE'],
    run: (f, fx) => {
      const c = census(fx);
      const released = 4n * f.CURVE_UNIT_SCALE;
      return { got: f.unitsOutstanding(c.supply, [c.protocolFee, c.deposit, c.vesting - released, c.leftover]), want: c.n0 + 4n * S };
    },
  },
  {
    id: 'fixture.census.damm-trade',
    what: 'a trader buys 100,000 lamports out of the DAMM pool: outstanding grows by exactly that',
    cites: [CENSUS_FIXTURE, N_IS_THE_FIXTURE, CENSUS_SETUP, CENSUS_ORDER, cite(`${CMT}:753-766`, 'let bought = 100_000u64;', 'c.env.set_token_amount(&census[5], deposit - bought);', 'n0 + released + bought')],
    ported: ['unitsOutstanding', 'CURVE_UNIT_SCALE'],
    run: (f, fx) => {
      const c = census(fx);
      const released = 4n * f.CURVE_UNIT_SCALE;
      return { got: f.unitsOutstanding(c.supply, [c.protocolFee, c.deposit - 100_000n, c.vesting - released, c.leftover]), want: c.n0 + 4n * S + 100_000n };
    },
  },
  {
    id: 'fixture.first-payment',
    what: 'the first payment per base lamport: all accepted below the 25 USDC cap, net = due − 5 %, and net_acc_wad × n + carry_wad = net × WAD exactly; the vault then holds net',
    cites: [...DEFAULTS, N_IS_THE_FIXTURE, cite(`${CMT}:292-307`, 'let due = c.env.ledger(&series).unwrap().open_due_amount;', 'let fee = bps_of(due, c.env.series(&series).payout_fee_bps).unwrap();', 'let net = due - fee;', 'l.net_acc_wad * u128::from(n) + u128::from(l.carry_wad),', 'u128::from(net) * u128::from(WAD)', 'assert_eq!(vault_before, net);')],
    ported: ['vaultReceiveGrossScaled'],
    run: (f, fx) => {
      const { n, feeBps } = curveSeries(fx);
      const { due, state, result } = firstPayment(f, fx);
      const net = due - (due * BigInt(feeBps)) / 10_000n;
      return {
        got: [result.accepted, result.refund, result.retired, result.netAdded, state.netAccWad * n + state.carryWad],
        want: [due, 0n, false, net, net * WAD],
      };
    },
  },
  {
    id: 'fixture.retirement',
    what: 'the past-the-cap payment retires the series: paid ≤ the cap per base lamport (25 USDC / 10^6, × WAD), accepted ≤ n × cap_wad / WAD + 1, the excess refunded to the issuer',
    cites: [
      ...DEFAULTS,
      cite(`${CMT}:928-947`, 'assert_eq!(due, 13_999_999_720);', 'merces_common::status::SeriesStatus::Retired', '// the cap per base lamport is exactly 25 USDC per unit / 10^6', 'let cap_wad = merces_common::vault::scaled_cap_wad(25 * ONE_USDC, CURVE_UNIT_SCALE).unwrap();', 'assert!(l.paid_per_unit_wad <= cap_wad);', 'let accepted = (u128::from(n) * cap_wad / u128::from(WAD)) as u64;', '<= accepted + 1);', 'l.refunded_to_issuer > 0,'),
    ],
    ported: ['vaultReceiveGrossScaled', 'scaledCapWad', 'isCappedScaled'],
    run: (f, fx) => {
      const { n, cap, feeBps } = curveSeries(fx);
      const due = big(fx.reports.fixtures[1]!.payment_usd);
      const { state, result } = f.vaultReceiveGrossScaled(newVaultState(), due, n, cap, S, feeBps, 0);
      const capWad = f.scaledCapWad(25n * USDC, S);
      const bound = (n * capWad) / WAD;
      return {
        got: [capWad, result.retired, f.isCappedScaled(state, cap, S), state.paidPerUnitWad <= capWad, result.accepted <= bound + 1n, state.refundedToIssuer > 0n, result.accepted + result.refund],
        want: [25n * WAD, true, true, true, true, true, due],
      };
    },
  },
  {
    id: 'fixture.redemption',
    what: 'redeeming after the first payment: a positive price, units at redemption = n, and the deposit is scaled_amount(price, n, 10^6); the tail cap is C_remaining − price',
    cites: [
      ...DEFAULTS,
      cite(`${CMT}:335-344`, 'ok(c.env.redeem_curve(&issuer, &series, &damm), "redeem");', 'assert_eq!(l.units_at_redemption, n);', 'assert!(price > 0);', 'let deposit = scaled_amount(price, n, CURVE_UNIT_SCALE).unwrap();', 'vault_mid + deposit'),
      cite(`${PROG}/exit.rs:125`, 'let deposit = scaled_amount(price.price, units, ledger.scale()).map_err(math)?;'),
      cite(`${PROG}/exit.rs:142-145`, 'ledger.tail_cap_per_unit = price', '.cap_remaining', '.checked_sub(price.price)'),
    ],
    ported: ['redemptionQuoteScaled', 'scaledAmount'],
    run: (f, fx) => {
      const { n, p0, cap } = curveSeries(fx);
      const { state } = firstPayment(f, fx);
      const q = f.redemptionQuoteScaled({ p0, hurdleRateWad: H8, payoutMultipleK: 5, t: YEAR / 4n, capPerUnit: cap, paidPerUnitWad: state.paidPerUnitWad, yearGross: state.yearGross, unitsOutstanding: n, unitScale: S });
      return { got: [q.pRedeem > 0n, q.deposit, q.tailCapPerUnit], want: [true, f.scaledAmount(q.pRedeem, n, S), q.cRemaining - q.pRedeem] };
    },
  },
  {
    id: 'fixture.tenders',
    what: 'each tender pays scaled_amount(price, units, 10^6), and tenders of a partition of the snapshot never exceed the deposit',
    cites: [
      cite(`${CMT}:358-361`, 'scaled_amount(price, a_units, CURVE_UNIT_SCALE).unwrap()'),
      cite(`${CMT}:370-373`, 'scaled_amount(price, b_staked + b_wallet, CURVE_UNIT_SCALE).unwrap()'),
      cite(`${CMT}:415-421`, 'assert_eq!(l.tendered_total, l.units_at_redemption);', '.map(|u| scaled_amount(price, *u, CURVE_UNIT_SCALE).unwrap())', 'assert!(tendered_paid <= deposit);'),
      cite(`${CMT}:267`, 'let b_staked = 10 * CURVE_UNIT_SCALE;'),
      cite(`${CMT}:326`, 'let b_staked = b_staked + 5 * CURVE_UNIT_SCALE;'),
      cite(`${PROG}/curve.rs:1496`, 'let redemption = scaled_amount(ledger.redemption_price, units, ledger.scale()).map_err(math)?;'),
    ],
    ported: ['scaledAmount', 'redemptionQuoteScaled'],
    run: (f, fx) => {
      const { n, p0, cap } = curveSeries(fx);
      const { state } = firstPayment(f, fx);
      const q = f.redemptionQuoteScaled({ p0, hurdleRateWad: H8, payoutMultipleK: 5, t: YEAR / 4n, capPerUnit: cap, paidPerUnitWad: state.paidPerUnitWad, yearGross: state.yearGross, unitsOutstanding: n, unitScale: S });
      // a partition of n: a third, b's 15 staked units, and the rest
      const parts = [n / 3n, 15n * S, n - n / 3n - 15n * S];
      const paid = parts.reduce((sum, u) => sum + f.scaledAmount(q.pRedeem, u, S), 0n);
      return { got: [paid <= q.deposit, parts.reduce((x, y) => x + y, 0n)], want: [true, n] };
    },
  },
  {
    id: 'fixture.quota',
    what: 'the wallet quota is exactly what is neither tendered nor staked: the quota fits, one more does not, and once tendered nothing more fits',
    cites: [
      cite(`${CMT}:396-412`, 'let quota = l.units_at_redemption - l.tendered_total - l.staked_total;', 'c.env.tender_units(&e, &series, 0, quota + 1),', 'u32::from(P::TenderQuotaExhausted),', 'c.env.tender_units(&e, &series, 0, quota),', 'c.env.tender_units(&e, &series, 0, 1),'),
      cite(`${PROG}/curve.rs:1445-1454`, 'wallet_tender_fits(', 'ledger.units_at_redemption,', 'ledger.tendered_total,', 'ledger.staked_total,', 'from_wallet', 'ProtocolError::TenderQuotaExhausted'),
    ],
    ported: ['walletTenderFits'],
    run: (f, fx) => {
      const { n } = curveSeries(fx);
      // by then both stakes were tendered (CMT:374-376), so the snapshot is split between tendered units and the quota
      const tendered = n / 3n + 15n * S;
      const quota = n - tendered;
      return { got: [f.walletTenderFits(n, tendered, 0n, quota), f.walletTenderFits(n, tendered, 0n, quota + 1n), f.walletTenderFits(n, tendered + quota, 0n, 1n)], want: [true, false, false] };
    },
  },
];

/** Reads the two curve fixtures from a Stage 1 checkout (null with the reason when they are missing or unreadable). */
export function loadFixtures(stage1Root: string): Fixtures | { missing: string } {
  const paths = [CURVE_CONFIG, CURVE_REPORTS].map((p) => join(stage1Root, p));
  const gone = paths.filter((p) => !existsSync(p));
  if (gone.length) return { missing: `Stage 1's curve fixtures are not in this drop (${[CURVE_CONFIG, CURVE_REPORTS].filter((_p, i) => !existsSync(paths[i]!)).join(', ')})` };
  try {
    return { config: JSON.parse(readFileSync(paths[0]!, 'utf8')), reports: JSON.parse(readFileSync(paths[1]!, 'utf8')) } as Fixtures;
  } catch (e) {
    return { missing: `Stage 1's curve fixtures cannot be read: ${(e as Error).message}` };
  }
}

/** Whether a citation still holds at a checkout: the lines exist and hold every anchor (whitespace ignored). */
export function checkCite(stage1Root: string, c: Cite): string | null {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(c.at);
  if (!m) return `${c.at}: not a file:line citation`;
  const [, file, from, to] = m as unknown as [string, string, string, string | undefined];
  const path = join(stage1Root, file);
  if (!existsSync(path)) return `${c.at}: ${file} is not in this checkout`;
  const lines = readFileSync(path, 'utf8').split('\n');
  const a = Number(from);
  const b = Number(to ?? from);
  if (a < 1 || b < a || b > lines.length) return `${c.at}: ${file} has ${lines.length} lines`;
  const text = lines.slice(a - 1, b).join('').replace(/\s+/g, '');
  const gone = c.anchor.filter((x) => !text.includes(x.replace(/\s+/g, '')));
  return gone.length ? `${c.at}: no longer holds ${gone.map((x) => JSON.stringify(x)).join(', ')}` : null;
}

export interface FigureResult {
  id: string;
  ok: boolean;
  detail?: string;
}

/** Evaluates every row: its citations at the checkout, then our value against Stage 1's. */
export function checkFigures(f: PortedFamily, stage1Root: string, fx: Fixtures, figures: readonly Figure[] = FIGURES): FigureResult[] {
  return figures.map((row) => {
    const stale = row.cites.map((c) => checkCite(stage1Root, c)).filter((x): x is string => x !== null);
    if (stale.length) return { id: row.id, ok: false, detail: `citation stale: ${stale.join('; ')}` };
    try {
      const { got, want } = row.run(f, fx);
      const g = canonical(got);
      const w = canonical(want);
      return g === w ? { id: row.id, ok: true } : { id: row.id, ok: false, detail: `ours ${g}, Stage 1 ${w} (${row.what})` };
    } catch (e) {
      return { id: row.id, ok: false, detail: `ours threw ${refusal(e)} (${row.what})` };
    }
  });
}
