import * as ours from '@merces/math';

/**
 * Differential comparison of `@merces/math` with Stage 1's reference math (`@merces/reference`, SPEC v1.1.2).
 *
 * Stage 1 does not export a `MercesMath` object: its functions take different shapes (a vault state instead of
 * loose accumulators, a ledger clock instead of a day count, a claims-based auction settlement). Each family below
 * maps one of our functions onto its Stage 1 counterpart and runs both on the same deterministic inputs, restricted
 * to inputs Stage 1 accepts (u64 ranges, a wallet cap of at least one unit, one valid bid per wallet). Outputs are
 * compared exactly; Stage 1 is the reference wherever they differ.
 */

type Fn = (...a: never[]) => unknown;
type Mod = Record<string, unknown>;

export interface FamilyResult {
  name: string;
  ours: string;
  stage1: string;
  cases: number;
  disagreements: number;
  examples: { input: unknown; ours: unknown; stage1: unknown }[];
  note?: string;
}

export interface Stage1MathReport {
  families: FamilyResult[];
  missing: string[];
  notCompared: { ours: string; why: string }[];
}

const WAD = 10n ** 18n;
const DAY = 86_400n;
const YEAR = 365n * DAY;

/** xorshift64*, so every run sees the same inputs. */
function rng(seed: bigint) {
  let s = seed & 0xffff_ffff_ffff_ffffn;
  const next = () => {
    s ^= s >> 12n;
    s ^= (s << 25n) & 0xffff_ffff_ffff_ffffn;
    s ^= s >> 27n;
    return (s * 0x2545_f491_4f6c_dd1dn) & 0xffff_ffff_ffff_ffffn;
  };
  /** uniform-ish in [lo, hi] */
  const big = (lo: bigint, hi: bigint) => lo + (((next() << 64n) | next()) % (hi - lo + 1n));
  const int = (lo: number, hi: number) => Number(big(BigInt(lo), BigInt(hi)));
  return { big, int };
}

function run(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    return `throws(${(e as Error).message})`;
  }
}

function same(a: unknown, b: unknown): boolean {
  return show(a) === show(b);
}

export function show(x: unknown): string {
  return (
    JSON.stringify(x, (_k, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
      return v;
    }) ?? 'undefined'
  );
}

interface Family {
  name: string;
  ours: string;
  stage1: string[];
  note?: string;
  cases: (r: ReturnType<typeof rng>) => unknown[];
  ours_: (input: never) => unknown;
  stage1_: (s1: Record<string, Fn>, input: never) => unknown;
}

const families: Family[] = [
  {
    name: 'owed YTD',
    ours: 'owedYtd',
    stage1: ['owedYtd'],
    cases: (r) => {
      const out: unknown[] = [{ rWad: 10n ** 15n, units: 100n, x: 5_000n, theta: 5_000n }, { rWad: 10n ** 15n, units: 100n, x: 0n, theta: 1n }];
      for (let i = 0; i < 300; i++) out.push({ rWad: r.big(0n, 10n ** 16n), units: r.big(1n, 10n ** 6n), x: r.big(0n, 10n ** 13n), theta: r.big(0n, 10n ** 13n) });
      return out;
    },
    ours_: (i: { rWad: bigint; units: bigint; x: bigint; theta: bigint }) => ours.owedYtd(i.rWad, i.units, i.x, i.theta),
    stage1_: (s, i: { rWad: bigint; units: bigint; x: bigint; theta: bigint }) => (s.owedYtd as unknown as (...a: bigint[]) => bigint)(i.rWad, i.units, i.x, i.theta),
  },
  {
    name: 'quarter payment in stablecoin',
    ours: 'quarterPayment().paymentStable',
    stage1: ['paymentUsd'],
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 300; i++) {
        const prior = r.big(0n, 10n ** 12n);
        out.push({ rWad: r.big(0n, 10n ** 16n), units: r.big(1n, 10n ** 6n), prior, x: prior + r.big(0n, 10n ** 12n), theta: r.big(0n, 10n ** 12n), fx: r.big(5n * 10n ** 17n, 2n * WAD) });
      }
      return out;
    },
    ours_: (i: { rWad: bigint; units: bigint; prior: bigint; x: bigint; theta: bigint; fx: bigint }) =>
      ours.quarterPayment({ ratePerUnitWad: i.rWad, unitsOutstanding: i.units, incomeYtdPrev: i.prior, incomeYtdNow: i.x, threshold: i.theta, fxAvgWad: i.fx }).paymentStable,
    stage1_: (s, i: { rWad: bigint; units: bigint; prior: bigint; x: bigint; theta: bigint; fx: bigint }) =>
      (s.paymentUsd as unknown as (a: object) => bigint)({ rWad: i.rWad, unitsOutstanding: i.units, theta: i.theta, incomeYtd: i.x, priorIncomeYtd: i.prior, fxAvgWad: i.fx }),
  },
  {
    name: 'per-unit cap',
    ours: 'perUnitCap',
    stage1: ['capPerUnit'],
    cases: (r) => Array.from({ length: 300 }, () => ({ m: r.big(WAD, 5n * WAD), p0: r.big(1n, 10n ** 9n) })),
    ours_: (i: { m: bigint; p0: bigint }) => ours.perUnitCap(i.m, i.p0),
    stage1_: (s, i: { m: bigint; p0: bigint }) => (s.capPerUnit as unknown as (...a: bigint[]) => bigint)(i.m, i.p0),
  },
  {
    name: 'wallet cap at the auction',
    ours: 'walletCapUnits',
    stage1: ['walletCapUnitsAtAuction'],
    note: 'Inputs with a cap of at least one unit only: Stage 1 refuses to create a series whose cap rounds to 0, where ours would round up to 1.',
    cases: (r) => {
      const out: unknown[] = [];
      while (out.length < 300) {
        const units = r.big(1n, 10n ** 6n);
        const bps = r.big(1n, 10_000n);
        if ((units * bps) / 10_000n >= 1n) out.push({ units, bps });
      }
      return out;
    },
    ours_: (i: { units: bigint; bps: bigint }) => ours.walletCapUnits(i.units, i.bps),
    stage1_: (s, i: { units: bigint; bps: bigint }) => (s.walletCapUnitsAtAuction as unknown as (u: bigint, b: number) => bigint)(i.units, Number(i.bps)),
  },
  {
    name: 'bid escrow (price × quantity + auction fee)',
    ours: 'bidDeposit',
    stage1: ['requiredEscrow'],
    cases: (r) => Array.from({ length: 300 }, () => ({ price: r.big(1n, 10n ** 9n), qty: r.big(1n, 10n ** 5n), bps: r.big(0n, 1_000n) })),
    ours_: (i: { price: bigint; qty: bigint; bps: bigint }) => ours.bidDeposit(i.price, i.qty, i.bps),
    stage1_: (s, i: { price: bigint; qty: bigint; bps: bigint }) => (s.requiredEscrow as unknown as (p: bigint, q: bigint, b: number) => bigint)(i.price, i.qty, Number(i.bps)),
  },
  {
    name: 'hurdle price',
    ours: 'hurdlePrice',
    stage1: ['hurdlePrice'],
    cases: (r) => {
      const out: unknown[] = [{ p0: 10_000_000n, h: 10n ** 17n, t: 0n }, { p0: 10_000_000n, h: 10n ** 17n, t: YEAR }, { p0: 10_000_000n, h: 10n ** 17n, t: 3n * YEAR + YEAR / 2n }];
      for (let i = 0; i < 300; i++) out.push({ p0: r.big(10n ** 5n, 10n ** 9n), h: r.big(0n, 3n * 10n ** 17n), t: r.big(0n, 10n * YEAR) });
      return out;
    },
    ours_: (i: { p0: bigint; h: bigint; t: bigint }) => ours.hurdlePrice(i.p0, i.h, 0, Number(i.t)),
    stage1_: (s, i: { p0: bigint; h: bigint; t: bigint }) => ((s.hurdlePrice as unknown as (p: bigint, h: bigint, t: bigint) => { pHurdle: bigint })(i.p0, i.h, i.t)).pHurdle,
  },
  {
    name: 'late accrual',
    ours: 'lateAccrual',
    stage1: ['lateAccrual', 'countdown'],
    note: 'Stage 1 takes a ledger clock; the clock here has no pauses and no grace, so its late days equal the day count passed to ours.',
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 300; i++) out.push({ amount: r.big(0n, 10n ** 12n), h: r.big(0n, 3n * 10n ** 17n), days: r.int(0, 800) });
      return out;
    },
    ours_: (i: { amount: bigint; h: bigint; days: number }) => ours.lateAccrual(i.amount, i.h, i.days),
    stage1_: (s, i: { amount: bigint; h: bigint; days: number }) => {
      const period = 2026 * 4; // 2026 Q1 (SPEC: period_id = year × 4 + quarter − 1)
      const far = 10n ** 12n;
      const countdown = s.countdown as unknown as (p: number, c: object, now: bigint) => bigint;
      const periodEnd = far - countdown(period, { pauses: [] }, far);
      const clock = { status: 0, firstPeriod: period, lastAcceptedPeriod: null, openDuePeriod: period, openDueAmount: i.amount, pauses: [], trueupDue: 0n, trueupAttestedAt: 0n };
      const params = { reportDueDays: 0, graceDays: 0, formalNoticeDays: 90, trueupDays: 30, hurdleRateWad: i.h };
      return (s.lateAccrual as unknown as (p: number, a: bigint, c: object, now: bigint, q: object) => bigint)(period, i.amount, clock, periodEnd + BigInt(i.days) * DAY, params);
    },
  },
  {
    name: 'vault receipt sequence (cap, payout fee, accumulator)',
    ours: 'applyGrossPayment + payoutFee + accrueNet',
    stage1: ['vaultReceiveGross', 'newVaultState', 'capPerUnit'],
    note: 'Each case is up to six receipts on one series; compared per receipt (accepted, refund, fee, paid per unit, retired) and the net accumulator after each.',
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 150; i++) {
        const n = r.int(1, 6);
        out.push({ units: r.big(1n, 10n ** 6n), m: r.big(WAD, 3n * WAD), p0: r.big(10n ** 4n, 10n ** 8n), bps: r.big(0n, 1_000n), receipts: Array.from({ length: n }, () => r.big(0n, 10n ** 11n)) });
      }
      return out;
    },
    ours_: (i: { units: bigint; m: bigint; p0: bigint; bps: bigint; receipts: bigint[] }) => {
      const cap = ours.perUnitCap(i.m, i.p0);
      let paid = 0n;
      let acc = 0n;
      const steps: unknown[] = [];
      for (const g of i.receipts) {
        const c = ours.applyGrossPayment(g, i.units, paid, cap);
        const f = ours.payoutFee(c.accepted, i.bps);
        paid = c.paidPerUnitWad;
        acc = ours.accrueNet(acc, f.net, i.units);
        steps.push({ accepted: c.accepted, refund: c.refunded, fee: f.fee, paidPerUnitWad: paid, retired: c.retired, netAccWad: acc });
        if (c.retired) break;
      }
      return steps;
    },
    stage1_: (s, i: { units: bigint; m: bigint; p0: bigint; bps: bigint; receipts: bigint[] }) => {
      const cap = (s.capPerUnit as unknown as (...a: bigint[]) => bigint)(i.m, i.p0);
      type St = { paidPerUnitWad: bigint; netAccWad: bigint };
      let st = (s.newVaultState as unknown as () => St)();
      const steps: unknown[] = [];
      for (const g of i.receipts) {
        const o = (s.vaultReceiveGross as unknown as (st: St, g: bigint, n: bigint, c: bigint, b: number, y: number) => { state: St; result: { accepted: bigint; refund: bigint; fee: bigint; retired: boolean } })(st, g, i.units, cap, Number(i.bps), 0);
        st = o.state;
        steps.push({ accepted: o.result.accepted, refund: o.result.refund, fee: o.result.fee, paidPerUnitWad: st.paidPerUnitWad, retired: o.result.retired, netAccWad: st.netAccWad });
        if (o.result.retired) break;
      }
      return steps;
    },
  },
  {
    name: 'holder claim since last settlement',
    ours: 'claimable(units, acc, rewardDebt(units, last))',
    stage1: ['settleHolderDelta'],
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 300; i++) {
        const last = r.big(0n, 10n ** 30n);
        out.push({ units: r.big(0n, 10n ** 6n), last, acc: last + r.big(0n, 10n ** 30n) });
      }
      return out;
    },
    ours_: (i: { units: bigint; last: bigint; acc: bigint }) => ours.claimable(i.units, i.acc, ours.rewardDebt(i.units, i.last)),
    stage1_: (s, i: { units: bigint; last: bigint; acc: bigint }) => (s.settleHolderDelta as unknown as (...a: bigint[]) => bigint)(i.acc, i.last, i.units),
  },
  {
    name: 'redemption price',
    ours: 'redemptionQuote',
    stage1: ['redemptionQuote', 'newVaultState', 'capPerUnit'],
    note: 'No payout history (D_avg is 0 or absent), so the price is decided by the hurdle or the remaining cap; compares price, remaining cap and hurdle.',
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 300; i++) {
        const m = r.big(WAD, 3n * WAD);
        const p0 = r.big(10n ** 4n, 10n ** 8n);
        const cap = (m * p0) / WAD;
        out.push({ m, p0, h: r.big(0n, 3n * 10n ** 17n), t: r.big(0n, 5n * YEAR), paid: r.big(0n, cap * WAD), units: r.big(1n, 10n ** 6n) });
      }
      return out;
    },
    ours_: (i: { m: bigint; p0: bigint; h: bigint; t: bigint; paid: bigint }) => {
      const years = Number(i.t / YEAR);
      const q = ours.redemptionQuote({ capPerUnit: ours.perUnitCap(i.m, i.p0), paidPerUnitWad: i.paid, issuePrice: i.p0, hurdleWad: i.h, payoutMultipleK: 2n, settlementTs: 0, nowTs: Number(i.t), annualGrossPerUnit: Array.from({ length: Math.min(years, 3) }, () => 0n) });
      return { price: q.pricePerUnit, capRemaining: q.capRemaining, hurdle: q.hurdlePrice };
    },
    stage1_: (s, i: { m: bigint; p0: bigint; h: bigint; t: bigint; paid: bigint; units: bigint }) => {
      const yearGross = (s.newVaultState as unknown as () => { yearGross: unknown })().yearGross;
      const cap = (s.capPerUnit as unknown as (...a: bigint[]) => bigint)(i.m, i.p0);
      const q = (s.redemptionQuote as unknown as (a: object) => { pRedeem: bigint; cRemaining: bigint; pHurdle: bigint })({ p0: i.p0, hurdleRateWad: i.h, payoutMultipleK: 2, t: i.t, capPerUnit: cap, paidPerUnitWad: i.paid, yearGross, unitsOutstanding: i.units });
      return { price: q.pRedeem, capRemaining: q.cRemaining, hurdle: q.pHurdle };
    },
  },
  {
    name: 'auction clearing',
    ours: 'clearAuction',
    stage1: ['findClearingPrice', 'claimsFor', 'beginSettlement', 'tallyBids', 'finalizeSettlement', 'marginalAllocation', 'requiredEscrow', 'walletCapUnitsAtAuction'],
    note: 'One valid bid per wallet, each within the wallet cap (bids past the cap are invalid at reveal in Stage 1). Compares success, clearing price, units sold and every bidder’s allocation.',
    cases: (r) => {
      const out: unknown[] = [];
      for (let i = 0; i < 300; i++) {
        const units = r.big(5n, 500n);
        const capBps = r.big(1_000n, 10_000n);
        const cap = (units * capBps) / 10_000n;
        const reserve = r.big(1n, 50n);
        const n = r.int(1, 12);
        const bids = Array.from({ length: n }, () => ({ price: reserve + r.big(0n, 6n), qty: r.big(1n, cap < 1n ? 1n : cap) }));
        out.push({ units, capBps, reserve, minRaise: r.big(0n, reserve * units), bids });
      }
      return out;
    },
    ours_: (i: { units: bigint; capBps: bigint; reserve: bigint; minRaise: bigint; bids: { price: bigint; qty: bigint }[] }) => {
      const res = ours.clearAuction({
        bids: i.bids.map((b, k) => ({ bidder: `w${k}`, pricePerUnit: b.price, quantity: b.qty, order: k })),
        unitsOffered: i.units,
        reservePrice: i.reserve,
        minimumRaise: i.minRaise,
        walletCapUnits: ours.walletCapUnits(i.units, i.capBps),
        auctionFeeBps: 100n,
      });
      if (!res.success) return { success: false };
      const by = new Map(res.allocations.map((a) => [a.bidder, a.units]));
      return { success: true, clearingPrice: res.clearingPrice, unitsSold: res.unitsSold, allocations: i.bids.map((_b, k) => by.get(`w${k}`) ?? 0n) };
    },
    stage1_: (s, i: { units: bigint; capBps: bigint; reserve: bigint; minRaise: bigint; bids: { price: bigint; qty: bigint }[] }) => {
      const f = s as unknown as Record<string, (...a: unknown[]) => unknown>;
      const rules = { unitsOffered: i.units, reservePrice: i.reserve, minRaise: i.minRaise, walletCapBps: Number(i.capBps), auctionFeeBps: 100, nonRevealChargeBps: 100 };
      const bids = i.bids.map((b, k) => ({ price: b.price, quantity: b.qty, escrow: f.requiredEscrow!(b.price, b.qty, 100) as bigint, valid: true, revealIndex: k }));
      const p = f.findClearingPrice!(bids, i.units) as bigint | null;
      if (p === null) return { success: false };
      const claims = f.claimsFor!(bids, p) as { qAboveClaim: bigint; qAtClaim: bigint };
      const prop = f.beginSettlement!(i.units, p, claims.qAboveClaim, claims.qAtClaim);
      const t = f.tallyBids!(bids, prop);
      const o = f.finalizeSettlement!(t, bids.length, rules, prop) as { kind: string; clearingPrice: bigint; R: bigint; qAt: bigint; unitsSold: bigint };
      if (o.kind !== 'settled') return { success: false };
      return {
        success: true,
        clearingPrice: o.clearingPrice,
        unitsSold: o.unitsSold,
        allocations: bids.map((b) => (b.price > o.clearingPrice ? b.quantity : b.price === o.clearingPrice ? (f.marginalAllocation!(o.R, b.quantity, o.qAt) as bigint) : 0n)),
      };
    },
  },
];

const NOT_COMPARED: { ours: string; why: string }[] = [
  { ours: 'ratePerUnit', why: 'Stage 1 takes r_wad per unit from the terms commitment; it never derives r from a share rate and units offered.' },
  { ours: 'periodPayment, toStablecoin', why: 'Covered by the quarter-payment family (Stage 1 has no separate functions).' },
  { ours: 'auctionFee, payoutFee, capRemaining, accrueNet, rewardDebt', why: 'Covered inside the escrow, vault-sequence, claim and redemption families.' },
  { ours: 'tailPayoutPerUnit', why: 'Stage 1 runs the tail through its own accumulator (`tailReceive`) over gross receipts; there is no per-unit function with the same inputs. Covered by the parity vectors instead.' },
  { ours: 'deadlinesFor, periodStanding', why: 'Stage 1 derives status from a ledger clock over unpaused time (`deriveStatus`); compared through the parity vectors.' },
  { ours: 'quarterAverageRate, coverageOk, deviationBps', why: 'Stage 1 keeps a per-pair snapshot state (`snapshot`, `quarterAverage`) with its own coverage and deviation rules; compared through the parity vectors.' },
];

export function compareStage1Math(stage1: Mod): Stage1MathReport {
  const fns = stage1 as Record<string, Fn>;
  const missing = [...new Set(families.flatMap((f) => f.stage1))].filter((n) => typeof fns[n] !== 'function');
  const out: FamilyResult[] = [];
  let seed = 0x5eafd41n;
  for (const f of families) {
    seed += 1n;
    if (f.stage1.some((n) => typeof fns[n] !== 'function')) {
      out.push({ name: f.name, ours: f.ours, stage1: f.stage1.join(', '), cases: 0, disagreements: 0, examples: [], note: 'Stage 1 function missing; not compared' });
      continue;
    }
    const cases = f.cases(rng(seed));
    let disagreements = 0;
    const examples: FamilyResult['examples'] = [];
    for (const input of cases) {
      const o = run(() => f.ours_(input as never));
      const t = run(() => f.stage1_(fns, input as never));
      if (!same(o, t)) {
        disagreements++;
        if (examples.length < 3) examples.push({ input, ours: o, stage1: t });
      }
    }
    out.push({ name: f.name, ours: f.ours, stage1: f.stage1[0]!, cases: cases.length, disagreements, examples, ...(f.note ? { note: f.note } : {}) });
  }
  return { families: out, missing, notCompared: NOT_COMPARED };
}

export function renderStage1Math(pkg: string, r: Stage1MathReport): string {
  const lines = ['# MATH_PARITY.md', '', `Stage 1 math: ${pkg} (compared function by function on deterministic inputs; Stage 1 is the reference).`, ''];
  lines.push('| Family | Ours | Stage 1 | Cases | Disagreements |', '| --- | --- | --- | --- | --- |');
  for (const f of r.families) lines.push(`| ${f.name} | \`${f.ours}\` | \`${f.stage1}\` | ${f.cases} | ${f.disagreements ? `**${f.disagreements}**` : '0'} |`);
  for (const f of r.families.filter((x) => x.disagreements || x.note)) {
    lines.push('', `## ${f.name}`, '');
    if (f.note) lines.push(f.note, '');
    for (const e of f.examples) lines.push(`- input \`${show(e.input)}\``, `  - ours \`${show(e.ours)}\``, `  - Stage 1 \`${show(e.stage1)}\``);
  }
  if (r.missing.length) lines.push('', '## Missing in Stage 1', '', ...r.missing.map((m) => `- \`${m}\``));
  lines.push('', '## Not compared function by function', '', ...r.notCompared.map((n) => `- \`${n.ours}\`: ${n.why}`));
  return lines.join('\n') + '\n';
}
