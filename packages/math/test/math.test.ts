import { describe, expect, it } from 'vitest';
import * as sdk from '@merces/sdk';
import * as ref from '@merces/reference';
import * as gateway from '../src/index.ts';
import * as testing from '../src/testing.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAY,
  PAYMENT_RANGE_ERROR,
  SeriesStatus,
  WAD,
  beginSettlement,
  capRemaining,
  claimsFor,
  countdown,
  deadlineSeconds,
  deriveStatus,
  finalizeSettlement,
  findClearingPrice,
  formalNoticeDue,
  fromPid,
  graceSeconds,
  interim,
  isBidValid,
  isPausedAt,
  newYearGross,
  parsePeriod,
  paymentStable,
  periodFrom,
  periodOf,
  periodsBetween,
  processBid,
  projectDeadlines,
  ratePerUnit,
  redemptionQuote,
  requiredEscrow,
  standingOf,
  statusParamsOf,
  tallyBids,
  toPid,
  wadFromDecimal,
  wadToDecimal,
  walletCapUnitsAtAuction,
  type AuctionRules,
  type LedgerClock,
  type Pause,
  type RevealedBid,
  type SettledState,
} from '../src/index.ts';

/**
 * Pins that moved with Stage 1 in S2 carry a cause code:
 *  - S2-G: `@merces/math` re-exports Stage 1's auction family (SPEC v1.1 §5.1–§5.2: the auction's wallet cap, the
 *    required escrow, validity at reveal, begin/tally/finalize, per-bid processing, honest claims and the clearing
 *    price); the interim auction family is retired (its callers moved to Stage 1's steps), and the interim cap left
 *    under `interim` is the window and curve cap (S5).
 *  - S3-NC: a curve raise has no cap at any stage (owner; Stage 1 stores 0), so the interim cap is the window cap only.
 *  - S3-M: a segregated family is ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3): the unit scale, the
 *    vault, tail and redemption at a scale, and curve mode's arithmetic. They are ours, not Stage 1 objects; at scale 1
 *    the scale-aware ones return Stage 1's own results (`curve.test.ts`).
 *
 * S4 cause codes:
 *  - S4-G: `@merces/math` re-exports Stage 1's signing primitives (the six signed messages, secp256k1 signing and
 *    recovery, the domain, the series key, the keccak bid commitment as `bidCommitmentBytes`, the wallet encodings,
 *    keccak256); the test-key derivation is only on `@merces/math/testing`, behind a grep gate.
 *  - S4-KMS: the local KMS (`@merces/ports` kms.ts) derives its secp256k1 dev keys with it: a reviewed importer.
 */

// ---------------------------------------------------------------- the gateway

const SDK_REEXPORTS = [
  'WAD', 'BPS_DENOMINATOR', 'mulDiv', 'mulDivCeil', 'ceilDiv', 'wadMul', 'wadDiv', 'bpsOf',
  'DAY', 'YEAR', 'periodStart', 'periodEnd', 'quarterIndex', 'yearOf', 'periodLabel', 'tradingDaysInPeriod',
  'unpaused', 'isPausedAt', 'pausedWithin',
  'newYearGross', 'settlementYear', 'yearGrossAdd', 'yearGrossGet',
  'DEFAULT_PARAMETERS', 'PARAMETER_BOUNDS', 'parametersFromStrings', 'SeriesStatus', 'RaiseState', 'TIER_FLAG', 'tierEnabled',
  'ERRORS', 'ERROR_ALIASES', 'isErrorName',
  'BN254_FR', 'assertField', 'poseidon2', 'poseidon5', 'CURRENCY_CODES', 'INDEXING_RULES',
  'U64_MAX', 'ZERO_INCOME_COMMITMENT', 'bytes32ToField', 'fieldToBytes32',
  // cause S4-G: Stage 1's signing primitives (SPEC §1.3-§1.4)
  'MAGIC', 'reportAttestationMessage', 'fxFallbackMessage', 'amendmentMessage', 'pauseApprovalMessage', 'extinguishMessage', 'trueUpMessage',
  'SECP256K1_N', 'SECP256K1_HALF_N', 'isLowS', 'signDigest', 'parseSignature', 'publicKeyFromPrivate', 'addressFromPublicKey', 'addressFromPrivateKey', 'recoverAddress', 'verifySignature', 'toChecksumAddress',
  'ChainKind', 'SOLANA_CLUSTER_TAGS', 'EVM_CHAIN_IDS', 'bidCommitmentPreimage', 'computeDomain', 'seriesKeyFromId',
  'walletFromSolanaPubkey', 'walletFromEvmAddress', 'evmAddressFromWallet', 'keccak256', 'fxPairId',
] as const;
/**
 * Stage 1's helpers, renamed: the Poseidon commitments return the field element (`@merces/domain` returns the 0x-hex);
 * cause S4-G: the keccak bid commitment returns bytes (`@merces/domain`'s `bidCommitment` returns the 0x-hex).
 */
const SDK_RENAMED = { termsCommitmentField: 'termsCommitment', incomeCommitmentField: 'incomeCommitment', routerIncomeCommitmentField: 'routerIncomeCommitment', bidCommitmentBytes: 'bidCommitment' } as const;
const REFERENCE_REEXPORTS = [
  'isTerminal', 'deadlineSeconds', 'graceSeconds', 'noticeSeconds', 'countdown', 'nextExpectedPeriod', 'earliestUnpaid', 'deriveStatus', 'isLateUnderlying', 'lateDays', 'newFxPairState', 'validatePythPrice', 'deviates', 'snapshot', 'quarterAverage', 'snapshotsNeeded', 'normalizePythPrice', 'invertRate', 'lateAccrual', 'lateAccrualTrueup', 'trueupNoticeDue', 'formalNoticeDue', 'pauseApprovalError',
  'newVaultState', 'capPerUnit', 'capEffWad', 'isCapped', 'vaultReceiveGross', 'settleHolderDelta', 'accumulate',
  'hurdlePrice', 'averageAnnualGross', 'redemptionQuote', 'newTailState', 'tailReceive', 'newFinalState', 'finalDistribute',
  'MAX_RELEASE_TRANCHES', 'validateReleaseSchedule', 'trancheAmounts', 'vested', 'releasable',
  'owedYtd', 'paymentUsd',
  // SPEC §6.5: router arithmetic and bounded checkpoint ring, Stage 1 objects.
  'newRouterState', 'closeRouterPeriod', 'closePeriodsThrough', 'ytdAtEnd', 'routeIncome', 'ROUTER_CHECKPOINT_RING',
  // cause S2-G: Stage 1's auction family
  'walletCapUnitsAtAuction', 'requiredEscrow', 'isBidValid', 'beginSettlement', 'tallyBids', 'isClearingPriceValid', 'finalizeSettlement', 'marginalAllocation', 'processBid', 'claimsFor', 'findClearingPrice',
  'walletCapUnits', 'requiredBidEscrow', 'isOrderValid', 'tallyOrders', 'isNoMatchValid', 'classifyWindowPrice', 'finalizeWindow', 'findWindowClearingPrice', 'computeFills',
] as const;

/** cause S3-M: ported from merces-common @1bfc66b (A-MATH-3); `stage1:sync` lists them as ported. */
const PORTED = [
  'CURVE_BASE_DECIMALS', 'CURVE_UNIT_SCALE', 'unitScaleFor', 'wadPerScaledUnit', 'scaledCapWad', 'scaledAmount',
  'isCappedScaled', 'vaultReceiveGrossScaled', 'tailReceiveScaled', 'capRemainingScaled', 'redemptionQuoteScaled',
  'p0PerUnit', 'swapBaseMatchesOffer', 'unitsOutstanding', 'migrationFeeSplit', 'walletTenderFits',
] as const;

describe('@merces/math gateway', () => {
  it('re-exports Stage 1\'s own objects, not copies', () => {
    const gw = gateway as unknown as Record<string, unknown>;
    for (const n of SDK_REEXPORTS) expect(gw[n], n).toBe((sdk as unknown as Record<string, unknown>)[n]);
    expect(gw.pidAt).toBe(sdk.periodOf);
    for (const [ours, theirs] of Object.entries(SDK_RENAMED)) expect(gw[ours], ours).toBe((sdk as unknown as Record<string, unknown>)[theirs]);
    for (const n of REFERENCE_REEXPORTS) expect(gw[n], n).toBe((ref as unknown as Record<string, unknown>)[n]);
  });
  it('exports exactly Stage 1, our helpers, the ported curve family and `interim` (no swap machinery, no other top-level interim name)', () => {
    const ours = ['periodOf', 'periodOfPid', 'periodFrom', 'parsePeriod', 'periodsBetween', 'toPid', 'fromPid', 'wadFromDecimal', 'wadToDecimal', 'utcDayIndex', 'ratePerUnit', 'paymentStable', 'PAYMENT_RANGE_ERROR', 'statusParamsOf', 'projectDeadlines', 'standingOf', 'capRemaining'];
    const keys = Object.keys(gateway);
    // cause S3-M: the ported family (16 names) sits beside Stage 1's, and none of it is a Stage 1 object
    expect([...keys].sort()).toEqual([...SDK_REEXPORTS, 'pidAt', ...Object.keys(SDK_RENAMED), ...REFERENCE_REEXPORTS, ...ours, ...PORTED, 'interim'].sort());
    const stage1 = new Set<unknown>([...Object.values(sdk), ...Object.values(ref)].filter((v) => typeof v === 'function'));
    for (const n of PORTED) {
      expect(n in sdk || n in ref, n).toBe(false);
      expect(stage1.has((gateway as unknown as Record<string, unknown>)[n]), n).toBe(false);
    }
    // Stage 1's positional quarterPayment (θ third) and Stage 1's `walletCapUnits` (the redemption-window cap, S5) are
    // deliberately not re-exported; the auction's cap is `walletCapUnitsAtAuction` (cause S2-G)
    expect(keys).not.toContain('quarterPayment');
    expect(gateway.walletCapUnits).toBe(ref.walletCapUnits);
    // cause S4-G: Stage 1's test-key derivation is only on `@merces/math/testing`, and the SDK's `bidCommitment` only
    // under its byte-returning name (the domain's `bidCommitment` is the hex one)
    expect(keys).not.toContain('deriveTestPrivateKey');
    expect(keys).not.toContain('bidCommitment');
    expect(gateway.walletCapUnitsAtAuction).toBe(ref.walletCapUnitsAtAuction);
    expect(gateway.redemptionQuote).toBe(ref.redemptionQuote);
  });
  it('has retired all interim math', () => { expect(Object.keys(interim)).toEqual([]); });
});

/** The repository root (packages/math/test → ../../..). */
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The only production `src` files that may name Stage 1's test-key derivation or import `@merces/math/testing` (cause
 * S4-G). Each S4 WP that needs a published test key adds its file here, reviewed: the vector runner and `stage1:sync`
 * (they replay Stage 1's known answers and vectors), the local KMS (S4 WP3, cause S4-KMS: its secp256k1 dev keys, behind
 * a published seed the services accept only while every chain is the simulator), and later the simulator harness and
 * the dev seeds. Services, the API, the keepers, the indexer, the report verifier and the device tool never may.
 */
const TESTING_IMPORTERS = new Set([
  'packages/math/src/testing.ts',
  'packages/stage1-sync/src/steps/signatures.ts',
  'packages/ports/src/kms.ts',
  // S4 WP5 (cause S4-REG): the vector runner's scenario loader checks a scenario's own keys are Stage 1's published test
  // keys for their seeds (`<scenario id>:<name>`)
  'packages/stage1-sync/src/stage1-vectors/scenarios.ts',
  // S4 WP6 (cause S4-T2): the simulator harness's report verifier key (`SimSigner`, seed `sim-verifier:<label>`), and the
  // vector runner's keyring, which checks each vector key is Stage 1's published test key for its seed before it signs
  'packages/simulator/src/wallets.ts',
  'packages/stage1-sync/src/stage1-vectors/keys.ts',
]);

/** True when the code (comments stripped: the gateway's own JSDoc names the subpath) names the derivation or the subpath. */
function namesTestKeys(text: string): boolean {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /deriveTestPrivateKey|@merces\/math\/testing/.test(code);
}

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === 'generated') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mts|js|mjs)$/.test(e)) out.push(p);
    }
  };
  for (const pkg of readdirSync(join(REPO, 'packages'))) {
    const src = join(REPO, 'packages', pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // a package without src
    }
  }
  return out;
}

describe('@merces/math/testing (cause S4-G)', () => {
  it('exports exactly Stage 1\'s own deriveTestPrivateKey', () => {
    expect(Object.keys(testing)).toEqual(['deriveTestPrivateKey']);
    expect(testing.deriveTestPrivateKey).toBe(sdk.deriveTestPrivateKey);
  });
  it('the package maps the subpath, and the derivation is Stage 1\'s (known answer: attestor1)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages/math/package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './testing': './src/testing.ts' });
    const known = JSON.parse(readFileSync(join(REPO, 'stage1/packages/vectors/known_answers.json'), 'utf8')) as { testKeys: { seed: string; privateKey: string }[] };
    const a1 = known.testKeys.find((k) => k.seed === 'attestor1')!;
    expect('0x' + Buffer.from(testing.deriveTestPrivateKey('attestor1')).toString('hex')).toBe(a1.privateKey);
  });
  it('grep gate: no production src outside the reviewed list names the test-key derivation or imports the subpath', () => {
    const offenders: string[] = [];
    for (const f of srcFiles()) {
      const rel = relative(REPO, f).split('\\').join('/');
      if (TESTING_IMPORTERS.has(rel)) continue;
      if (namesTestKeys(readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // the gate sees code, not comments
    expect(namesTestKeys("import { deriveTestPrivateKey } from '@merces/math/testing';")).toBe(true);
    expect(namesTestKeys("const u = 'https://x';\nconst k = deriveTestPrivateKey('seed');")).toBe(true);
    expect(namesTestKeys("const m = await import('@merces/math/testing');")).toBe(true);
    expect(namesTestKeys('/** see `@merces/math/testing` */\n// deriveTestPrivateKey stays out\nconst x = 1;')).toBe(false);
    // the reviewed importers exist (a stale entry would let a renamed file slip through unnoticed)
    for (const f of TESTING_IMPORTERS) expect(statSync(join(REPO, f)).isFile(), f).toBe(true);
  });
});

// ---------------------------------------------------------------- periods

describe('period codec on Stage 1 periods', () => {
  it('maps "YYYYQn" to Stage 1 period ids with Stage 1 boundaries, 2026Q1 to 2030Q4', () => {
    const q1 = parsePeriod('2026Q1');
    expect(q1).toEqual({ id: '2026Q1', pid: 8104, year: 2026, quarter: 1, start: 1_767_225_600, end: 1_775_001_600, days: 90 });
    expect(toPid('2026Q1')).toBe(8104);
    expect(fromPid(8104)).toBe('2026Q1');
    for (let year = 2026; year <= 2030; year++) {
      for (const quarter of [1, 2, 3, 4] as const) {
        const id = `${year}Q${quarter}`;
        const pid = sdk.periodId(year, quarter);
        const p = parsePeriod(id);
        expect(p.pid).toBe(pid);
        expect(toPid(id)).toBe(pid);
        expect(fromPid(pid)).toBe(id);
        expect(sdk.periodLabel(pid)).toBe(id);
        expect(BigInt(p.start)).toBe(sdk.periodStart(pid));
        expect(BigInt(p.end)).toBe(sdk.periodEnd(pid));
        expect(BigInt(p.days)).toBe(sdk.daysInPeriod(pid));
        expect(periodFrom(year, quarter)).toEqual(p);
        expect(periodOf(p.start)).toEqual(p);
        expect(periodOf(p.end - 1)).toEqual(p);
        expect(periodOf(p.end).pid).toBe(pid + 1);
        expect(sdk.periodOf(BigInt(p.start))).toBe(pid);
      }
    }
    expect(periodsBetween(parsePeriod('2026Q1').start, parsePeriod('2030Q4').end).map((p) => p.pid)).toEqual(Array.from({ length: 20 }, (_, i) => 8104 + i));
    expect(() => toPid('2026Q5')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- rate, payment, cap

const hasDigit = (f: () => unknown): boolean => {
  try {
    f();
  } catch (e) {
    return /\d/.test((e as Error).message);
  }
  throw new Error('did not throw');
};

describe('ratePerUnit bounds (SPEC §1.5)', () => {
  it('derives r = floor(s / N) and enforces r < 2^64 and r × N ≤ WAD', () => {
    expect(ratePerUnit(wadFromDecimal('0.10'), 1_000n)).toBe(100_000_000_000_000n);
    expect(ratePerUnit(WAD, 3n)).toBe(333_333_333_333_333_333n);
    expect(ratePerUnit(WAD, 1n)).toBe(WAD); // r × N = WAD exactly: allowed
    expect(() => ratePerUnit(WAD + 1n, 1n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(2n * WAD, 3n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(-1n, 3n)).toThrow(new RangeError('rate out of range'));
    expect(() => ratePerUnit(WAD, 0n)).toThrow(RangeError);
    for (const f of [() => ratePerUnit(WAD + 1n, 1n), () => ratePerUnit(-5n, 7n), () => ratePerUnit(WAD, 0n)]) expect(hasDigit(f)).toBe(false);
  });
});

describe('paymentStable wraps Stage 1 paymentUsd', () => {
  const base = { rWad: ratePerUnit(wadFromDecimal('0.10'), 1_000n), unitsOutstanding: 1_000n, theta: 60_000_000_000n, priorIncomeYtd: 50_000_000_000n, incomeYtd: 75_000_000_000n, fxAvgWad: WAD };
  it('is Stage 1\'s payment', () => {
    expect(paymentStable(base)).toBe(ref.paymentUsd(base));
    expect(paymentStable(base)).toBe(1_500_000_000n);
    expect(paymentStable({ ...base, fxAvgWad: wadFromDecimal('1.08') })).toBe(1_620_000_000n);
  });
  it('rethrows every Stage 1 error without the figures', () => {
    // Stage 1's own message names the value: income figures must never reach an error
    expect(() => ref.paymentUsd({ ...base, incomeYtd: 2n ** 64n })).toThrow(/18446744073709551616/);
    const bad = [{ ...base, incomeYtd: 2n ** 64n }, { ...base, incomeYtd: 1n, priorIncomeYtd: 2n }, { ...base, theta: -1n }, { ...base, fxAvgWad: 2n ** 70n }];
    for (const a of bad) {
      expect(() => paymentStable(a)).toThrow(new RangeError(PAYMENT_RANGE_ERROR));
      expect(hasDigit(() => paymentStable(a))).toBe(false);
    }
  });
});

describe('capRemaining (display) equals Stage 1 C_remaining', () => {
  it('on a deterministic grid, rounding the paid amount up', () => {
    const caps = [0n, 1n, 25_000_000n, 262_500_002n];
    let n = 0;
    for (const cap of caps) {
      const paids = [0n, 1n, WAD - 1n, WAD, WAD + 1n, cap * WAD - 1n, cap * WAD, cap * WAD + 1n, (cap * WAD) / 3n, (cap * WAD * 7n) / 9n + 13n].filter((x) => x >= 0n);
      for (const paid of paids) {
        const q = redemptionQuote({ p0: 10_000_000n, hurdleRateWad: wadFromDecimal('0.08'), payoutMultipleK: 5, t: 0n, capPerUnit: cap, paidPerUnitWad: paid, yearGross: newYearGross(), unitsOutstanding: 1n });
        expect(capRemaining(cap, paid), `${cap}/${paid}`).toBe(q.cRemaining);
        n++;
      }
    }
    expect(n).toBe(39);
    // a fraction of a base unit paid counts as a whole one (cap − floor(paid / WAD) would show 24,999,999)
    expect(capRemaining(25_000_000n, WAD + 1n)).toBe(24_999_998n);
  });
});

// ---------------------------------------------------------------- status

const params = statusParamsOf({ dueDays: 30, graceDays: 15, formalNoticeDays: 90, hurdleWad: wadFromDecimal('0.08') });
const clockOf = (pid: number, pauses: Pause[]): LedgerClock => ({ status: SeriesStatus.OnTime, firstPeriod: pid, lastAcceptedPeriod: null, openDuePeriod: null, openDueAmount: 0n, pauses, trueupDue: 0n, trueupAttestedAt: 0n });
const d = (n: number) => BigInt(n) * DAY;

describe('statusParamsOf', () => {
  it('maps series terms onto Stage 1 StatusParams', () => {
    expect(params).toEqual({ reportDueDays: 30, graceDays: 15, formalNoticeDays: 90, trueupDays: 60, hurdleRateWad: 80_000_000_000_000_000n });
    expect(statusParamsOf({ dueDays: 30, graceDays: 15, formalNoticeDays: 90, hurdleWad: '80000000000000000', trueupDays: 60 }).hurdleRateWad).toBe(80_000_000_000_000_000n);
  });
});

describe('projectDeadlines against Stage 1 countdown, deriveStatus and formalNoticeDue', () => {
  // pause layouts relative to the period end E; `now` marks which pauses are recorded (and which one is open)
  const layouts: { name: string; pauses: (e: bigint) => Pause[]; now: (e: bigint) => bigint; expect: [number, number, number] }[] = [
    { name: 'no pause', pauses: () => [], now: (e) => e + d(1), expect: [30, 45, 90] },
    { name: 'one recorded pause before the due date', pauses: (e) => [{ start: e + d(10), end: e + d(25) }], now: (e) => e + d(26), expect: [45, 60, 105] },
    { name: 'a recorded pause straddling the period end', pauses: (e) => [{ start: e - d(5), end: e + d(3) }], now: (e) => e + d(4), expect: [33, 48, 93] },
    { name: 'a recorded pause starting exactly at the due instant', pauses: (e) => [{ start: e + d(30), end: e + d(40) }], now: (e) => e + d(41), expect: [40, 55, 100] },
    { name: 'an open pause during grace (counted to its approved end)', pauses: (e) => [{ start: e + d(40), end: e + d(70) }], now: (e) => e + d(50), expect: [30, 75, 120] },
    { name: 'two recorded pauses', pauses: (e) => [{ start: e + d(2), end: e + d(4) }, { start: e + d(50), end: e + d(53) }], now: (e) => e + d(60), expect: [32, 47, 95] },
  ];
  for (const pid of [8104, 8105, 8107, 8111]) {
    for (const l of layouts) {
      it(`${fromPid(pid)}: ${l.name}`, () => {
        const e = sdk.periodEnd(pid);
        const pauses = l.pauses(e);
        const clock = clockOf(pid, pauses);
        const { dueAt, graceEndsAt, formalNoticeAt } = projectDeadlines(pid, pauses, l.now(e), params);
        expect([dueAt, graceEndsAt, formalNoticeAt]).toEqual(l.expect.map((x) => e + d(x)));
        for (const t of [dueAt, dueAt + 1n, graceEndsAt, graceEndsAt + 1n, formalNoticeAt - 1n, formalNoticeAt]) expect(isPausedAt(pauses, t)).toBe(false);
        // formal notice turns due exactly at formalNoticeAt
        expect(formalNoticeDue(pid, clock, formalNoticeAt, params)).toBe(true);
        expect(formalNoticeDue(pid, clock, formalNoticeAt - 1n, params)).toBe(false);
        // the countdown crosses the bounds exactly there
        expect(countdown(pid, clock, dueAt)).toBe(deadlineSeconds(params));
        expect(countdown(pid, clock, graceEndsAt)).toBe(graceSeconds(params));
        // Stage 1's derived status at the projected instants
        expect(deriveStatus(clock, dueAt, params)).toBe(SeriesStatus.OnTime);
        expect(deriveStatus(clock, dueAt + 1n, params)).toBe(SeriesStatus.InGrace);
        expect(deriveStatus(clock, graceEndsAt, params)).toBe(SeriesStatus.InGrace);
        expect(deriveStatus(clock, graceEndsAt + 1n, params)).toBe(SeriesStatus.Late);
        // and the per-period standing
        expect(standingOf(pid, clock, dueAt, params, false)).toBe('OnTime');
        expect(standingOf(pid, clock, dueAt + 1n, params, false)).toBe('InGrace');
        expect(standingOf(pid, clock, graceEndsAt, params, false)).toBe('InGrace');
        expect(standingOf(pid, clock, graceEndsAt + 1n, params, false)).toBe('Late');
        expect(standingOf(pid, clock, formalNoticeAt - 1n, params, false)).toBe('Late');
        expect(standingOf(pid, clock, formalNoticeAt, params, false)).toBe('FormalNoticeDue');
        expect(standingOf(pid, clock, formalNoticeAt, params, true)).toBe('OnTime');
        expect(standingOf(pid, clock, e - 1n, params, false)).toBe('NotDue');
        for (const p of pauses) if (p.start >= e) expect(standingOf(pid, clock, p.start, params, false)).toBe('Deferred');
      });
    }
  }
  it('assumes no pause beyond those recorded as of `now`', () => {
    const e = sdk.periodEnd(8104);
    const later = [{ start: e + d(20), end: e + d(30) }];
    expect(projectDeadlines(8104, later, e + d(10), params)).toEqual(projectDeadlines(8104, [], e + d(10), params));
    expect(projectDeadlines(8104, later, e + d(20), params).dueAt).toBe(e + d(40));
  });
});

// ---------------------------------------------------------------- Stage 1's auction family (S2)

describe('Stage 1 auction family (SPEC v1.1 §5.1–§5.2; cause S2-G)', () => {
  const usdc = (n: number) => BigInt(n) * 1_000_000n;
  // the harness's default raise (`defaultTerms` and `runRaise` in packages/simulator/src/harness.ts): 500 units, reserve
  // 8 USDC, minimum raise 4,000, wallet cap 20% (100 units), auction fee 1%, non-reveal charge 1% (the harness's own rate;
  // cause NRC, was 0 under the S2 hold: a revealed bid, valid or not, never pays it)
  const rules: AuctionRules = { unitsOffered: 500n, reservePrice: usdc(8), minRaise: usdc(4_000), walletCapBps: 2000, auctionFeeBps: 100, nonRevealChargeBps: 100 };
  const revealed = (price: bigint, quantity: bigint, revealIndex: number): RevealedBid => {
    const escrow = requiredEscrow(price, quantity, rules.auctionFeeBps);
    return { price, quantity, escrow, valid: isBidValid(price, quantity, escrow, rules), revealIndex };
  };
  // five backers bid 12 / 11 / 10 / 10 / 9 USDC × 100 units, each escrowing exactly price × quantity plus the 1% fee
  const bids = [12, 11, 10, 10, 9].map((p, i) => revealed(usdc(p), 100n, i));

  it('the default harness raise: clears at 9 USDC, sells out, takes 9 USDC of fee per bid and refunds 303/202/101/101/0', () => {
    // why most `runRaise` pins survived S2: Stage 1 settles this raise at the figures the retired interim clearing gave
    // (from Stage 1's own Simulator: every backer pays 909 USDC for 100 units)
    expect(walletCapUnitsAtAuction(rules.unitsOffered, rules.walletCapBps)).toBe(100n);
    expect(bids.map((b) => b.escrow)).toEqual([1_212, 1_111, 1_010, 1_010, 909].map(usdc));
    expect(bids.every((b) => b.valid)).toBe(true);
    const price = findClearingPrice(bids, rules.unitsOffered);
    expect(price).toBe(usdc(9));
    const claims = claimsFor(bids, price!);
    expect(claims).toEqual({ qAboveClaim: 400n, qAtClaim: 100n });
    const proposal = beginSettlement(rules.unitsOffered, price!, claims.qAboveClaim, claims.qAtClaim);
    expect(proposal.rClaim).toBe(100n);
    const tally = tallyBids(bids, proposal);
    expect(tally).toEqual({ qAbove: 400n, qAt: 100n, allocSum: 100n, minValidPrice: usdc(9), talliedCount: 5 });
    expect(finalizeSettlement(tally, 5, rules, proposal)).toEqual({ kind: 'settled', clearingPrice: usdc(9), R: 100n, qAt: 100n, qAbove: 400n, unitsSold: 500n, proceeds: usdc(4_500) });
    const settled: SettledState = { failed: false, clearingPrice: usdc(9), R: 100n, qAt: 100n };
    const outcomes = bids.map((b) => processBid({ ...b, revealed: true }, settled, rules));
    for (const o of outcomes) expect(o).toMatchObject({ alloc: 100n, cost: usdc(900), fee: usdc(9), charge: 0n });
    expect(outcomes.map((o) => o.pendingRefund)).toEqual([303, 202, 101, 101, 0].map(usdc));
  });

  it('a bid above the wallet cap is invalid (not trimmed to the cap): it is tallied for nothing and refunded in full', () => {
    // 300 units on a 100-unit cap, fully escrowed: invalid at reveal (the interim clearing trimmed it to the cap)
    const over = revealed(usdc(12), 300n, 5);
    expect(over.valid).toBe(false);
    expect(isBidValid(usdc(12), 100n, requiredEscrow(usdc(12), 100n, 100), rules)).toBe(true);
    expect(isBidValid(usdc(12), 101n, requiredEscrow(usdc(12), 101n, 100), rules)).toBe(false);
    // the clearing is the default raise's: the invalid bid counts toward `talliedCount` only
    const all = [...bids, over];
    expect(findClearingPrice(all, rules.unitsOffered)).toBe(usdc(9));
    expect(tallyBids(all, beginSettlement(rules.unitsOffered, usdc(9), 400n, 100n))).toEqual({ qAbove: 400n, qAt: 100n, allocSum: 100n, minValidPrice: usdc(9), talliedCount: 6 });
    const settled: SettledState = { failed: false, clearingPrice: usdc(9), R: 100n, qAt: 100n };
    expect(processBid({ ...over, revealed: true }, settled, rules)).toEqual({ alloc: 0n, cost: 0n, fee: 0n, pendingRefund: usdc(3_636), charge: 0n });
  });

  it('the auction wallet cap has no minimum of one unit (the interim cap rounded up to one)', () => {
    expect(walletCapUnitsAtAuction(5n, 1000)).toBe(0n);
    expect(gateway.walletCapUnits(5n, 1_000)).toBe(0n);
    // so no bid on such a series is valid (Stage 1's create_series refuses a cap below one unit)
    const tiny: AuctionRules = { ...rules, unitsOffered: 5n, walletCapBps: 1000 };
    expect(isBidValid(usdc(9), 1n, requiredEscrow(usdc(9), 1n, 100), tiny)).toBe(false);
    expect(walletCapUnitsAtAuction(10n, 1000)).toBe(1n);
  });
});

// ---------------------------------------------------------------- ours, and the interim cap (S5) and FX (S5) families

describe('fixed point', () => {
  it('parses decimals exactly', () => {
    expect(wadFromDecimal('2.5')).toBe(2_500_000_000_000_000_000n);
    expect(wadFromDecimal('0.08')).toBe(80_000_000_000_000_000n);
    expect(wadToDecimal(wadFromDecimal('0.025'))).toBe('0.025');
    expect(() => wadFromDecimal('1e5')).toThrow();
  });

  it('accepts 18 places and refuses more; its errors carry no value (a share rate is a private term)', () => {
    expect(wadFromDecimal('0.064264264264264264')).toBe(64_264_264_264_264_264n);
    for (const bad of ['0.0642642642642642642', '6426426426e-9', 'x0.0642642642']) {
      let err: unknown = null;
      try {
        wadFromDecimal(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(RangeError);
      expect(`${(err as Error).message}\n${(err as Error).stack}`).not.toMatch(/642642/);
    }
  });
});

describe('time', () => {
  it('derives quarters in UTC', () => {
    const p = periodOf(Date.UTC(2026, 9, 7) / 1000);
    expect(p.id).toBe('2026Q4');
    expect(p.days).toBe(92);
    expect(periodsBetween(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 11, 31) / 1000).map((x) => x.id)).toEqual(['2026Q1', '2026Q2', '2026Q3', '2026Q4']);
  });
});

describe('Stage 1 window cap', () => {
  it('wallet cap is at least one unit', () => {
    expect(gateway.walletCapUnits(1_000n, 1_000)).toBe(100n);
    expect(gateway.walletCapUnits(5n, 1_000)).toBe(0n);
  });
});
