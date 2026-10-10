import { z } from 'zod';
import { AppError, audit } from '@merces/core';
import type { ChainPort } from '@merces/domain';
import { WAD, capRemaining } from '@merces/math';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E11 — fees and accounting (R33).
 * Backers pay a 1% auction fee on cleared bids and a 5% fee on every payout; issuers pay nothing; failed auctions
 * charge nothing (C5). The indexer projects every FeeTaken into `fees_ledger` and every money movement into
 * `money_events`; this service reads those tables (never the chain) for the ledger, the per-series statements and
 * the CSV export, and reads the chain only to reconcile the read model against onchain state.
 * Money is a decimal string in base units end to end: pg returns numerics as strings, sums are done in SQL or with
 * BigInt, and nothing here is ever Number()ed except timestamps, counts and basis points. Nothing income-bearing
 * exists in these tables; the statement and the export carry amounts, kinds, wallets and period ids only.
 */

const unixSeconds = z.string().regex(/^\d{1,12}$/, 'unix seconds').transform(Number);
const limitParam = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

export const feesQuerySchema = z.object({
  chain: z.string().min(1).max(32).optional(),
  seriesId: z.string().min(1).max(128).optional(),
  /** inclusive bounds on block_time, unix seconds */
  from: unixSeconds.optional(),
  to: unixSeconds.optional(),
  /** rows returned; totals always cover the whole filter */
  limit: limitParam(1000, 10_000),
});
export type FeesQuery = z.infer<typeof feesQuerySchema>;

export const exportQuerySchema = z.object({
  chain: z.string().min(1).max(32).optional(),
  from: unixSeconds.optional(),
  to: unixSeconds.optional(),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const runsQuerySchema = z.object({ limit: limitParam(20, 100) });

export type FeeKind = 'auction' | 'payout';

export interface FeeRow {
  chain: string;
  seq: number;
  seriesId: string;
  stablecoin: string | null;
  kind: FeeKind;
  payer: string;
  amount: string;
  blockTime: number;
  txId: string;
}

export interface FeeSeriesTotal {
  seriesId: string;
  chain: string;
  stablecoin: string | null;
  auction: string;
  payout: string;
  total: string;
  count: number;
}

export interface FeesReport {
  filter: { chain: string | null; seriesId: string | null; from: number | null; to: number | null; limit: number };
  rows: FeeRow[];
  rowCount: number;
  truncated: boolean;
  totals: { total: string; count: number; byKind: Record<FeeKind, string>; bySeries: FeeSeriesTotal[] };
}

export type ReconciliationCheckName = 'fee-collector-balance' | 'vault-gross' | 'vault-fees' | 'treasury-total' | 'treasury-released';

export interface ReconciliationCheck {
  check: ReconciliationCheckName;
  chain: string;
  seriesId: string | null;
  stablecoin: string | null;
  /** indexed total (read model), base units; null when the read model has no row */
  indexed: string | null;
  /** onchain value, base units; null when the chain has no such account */
  onchain: string | null;
  /** onchain − indexed, signed decimal string */
  delta: string | null;
  ok: boolean;
  note?: string;
}

export interface ReconciliationRun {
  runId: string;
  at: string;
  actor: string;
  ok: boolean;
  checksTotal: number;
  checksFailed: number;
  checks: ReconciliationCheck[];
}

interface SeriesRow {
  series_id: string;
  chain: string;
  issuer: string;
  stablecoin: string;
  phase: string;
  status: string;
  auction_fee_bps: number;
  payout_fee_bps: number;
  cap_multiple_wad: string;
  issue_price: string | null;
  units_sold: string;
  units_outstanding: string;
  cap_per_unit: string | null;
  paid_per_unit_wad: string;
  gross_paid_total: string;
  fees_total: string;
  treasury_total: string;
  treasury_released: string;
  releases_paused: boolean;
  settled_at: string | null;
  redeemed_at: string | null;
  redemption_price: string | null;
  extinguished_at: string | null;
}

const big = (v: string | null | undefined): bigint => BigInt(v ?? '0');
const str = (v: bigint | null): string | null => (v === null ? null : v.toString());
const ts = (v: string | null): number | null => (v === null ? null : Number(v));
const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Build one reconciliation check: ok when both sides exist and agree to the base unit. */
function compare(check: ReconciliationCheckName, chain: string, seriesId: string | null, stablecoin: string | null, indexed: string | null | undefined, onchain: string | null | undefined): ReconciliationCheck {
  const i = indexed ?? null;
  const o = onchain ?? null;
  if (i === null || o === null) return { check, chain, seriesId, stablecoin, indexed: i, onchain: o, delta: null, ok: false, note: i === null ? 'not indexed' : 'not onchain' };
  const delta = (BigInt(o) - BigInt(i)).toString();
  return { check, chain, seriesId, stablecoin, indexed: i, onchain: o, delta, ok: delta === '0' };
}

export class AccountingService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireChain(chain: string | undefined): void {
    if (chain !== undefined && !this.ctx.chains.chains.has(chain)) throw AppError.badRequest(`unknown chain ${chain}`);
  }

  private requireRange(from: number | undefined, to: number | undefined): void {
    if (from !== undefined && to !== undefined && from > to) throw AppError.badRequest('from must not be after to');
  }

  // ---- fee ledger

  /** Fee ledger rows for a chain / series / block-time window with totals by kind and by series. */
  async fees(q: FeesQuery): Promise<FeesReport> {
    this.requireChain(q.chain);
    this.requireRange(q.from, q.to);
    const where = 'where ($1::text is null or f.chain = $1) and ($2::text is null or f.series_id = $2) and ($3::bigint is null or f.block_time >= $3) and ($4::bigint is null or f.block_time <= $4)';
    const args = [q.chain ?? null, q.seriesId ?? null, q.from ?? null, q.to ?? null];
    const rows = await this.ctx.pool.query<{ chain: string; seq: string; series_id: string; kind: FeeKind; payer: string; amount: string; block_time: string; tx_id: string; stablecoin: string | null }>(
      `select f.chain, f.seq, f.series_id, f.kind, f.payer, f.amount, f.block_time, f.tx_id, s.stablecoin from fees_ledger f left join series s on s.series_id = f.series_id ${where} order by f.chain, f.seq limit $5`,
      [...args, q.limit],
    );
    const byKind = await this.ctx.pool.query<{ kind: FeeKind; total: string; n: string }>(`select f.kind, sum(f.amount) as total, count(*) as n from fees_ledger f ${where} group by f.kind`, args);
    const bySeries = await this.ctx.pool.query<{ series_id: string; chain: string; stablecoin: string | null; auction: string; payout: string; total: string; n: string }>(
      `select f.series_id, f.chain, s.stablecoin,
              sum(case when f.kind = 'auction' then f.amount else 0 end) as auction,
              sum(case when f.kind = 'payout' then f.amount else 0 end) as payout,
              sum(f.amount) as total, count(*) as n
       from fees_ledger f left join series s on s.series_id = f.series_id ${where} group by f.series_id, f.chain, s.stablecoin order by f.chain, f.series_id`,
      args,
    );
    const kinds: Record<FeeKind, string> = { auction: '0', payout: '0' };
    let total = 0n;
    let count = 0;
    for (const k of byKind.rows) {
      kinds[k.kind] = k.total;
      total += BigInt(k.total);
      count += Number(k.n);
    }
    return {
      filter: { chain: q.chain ?? null, seriesId: q.seriesId ?? null, from: q.from ?? null, to: q.to ?? null, limit: q.limit },
      rows: rows.rows.map((r) => ({ chain: r.chain, seq: Number(r.seq), seriesId: r.series_id, stablecoin: r.stablecoin, kind: r.kind, payer: r.payer, amount: r.amount, blockTime: Number(r.block_time), txId: r.tx_id })),
      rowCount: count,
      truncated: rows.rows.length < count,
      totals: { total: total.toString(), count, byKind: kinds, bySeries: bySeries.rows.map((r) => ({ seriesId: r.series_id, chain: r.chain, stablecoin: r.stablecoin, auction: r.auction, payout: r.payout, total: r.total, count: Number(r.n) })) },
    };
  }

  // ---- statements

  /**
   * Per-series statement from the read model: gross payments against the cap (C6), fees by kind, payouts claimed,
   * refunds, treasury released vs total, redemption / tail / extinguishment totals and the period ledger. The same
   * numbers serve the admin and the issuer (who is entitled to their own statement).
   *
   * Every amount is shown once (Stage 1 keeps three pools): `payments` are the regular pay-ins and split receipts into
   * the payout vault; `tail` the tail payments after a redemption (Stage 1's tail state, outside the vault's
   * per-unit figures); `extinguishment` the unvested proceeds an extinguishment returned to holders through the final
   * pool (the vested part stays in the treasury). The cap's remaining room is Stage 1's `C_remaining` (paid rounded up).
   */
  async statement(seriesId: string): Promise<Record<string, unknown>> {
    const sr = await this.ctx.pool.query<SeriesRow>('select * from series where series_id = $1', [seriesId]);
    const s = sr.rows[0];
    if (!s) throw AppError.notFound('series');
    const fees = await this.ctx.pool.query<{ kind: FeeKind; total: string }>('select kind, sum(amount) as total from fees_ledger where series_id = $1 group by kind', [seriesId]);
    const money = await this.ctx.pool.query<{ kind: string; total: string; n: string }>('select kind, sum(amount) as total, count(*) as n from money_events where series_id = $1 group by kind', [seriesId]);
    // PaymentReceived rows by source: regular (payIn, split), tail, extinguishment
    const bySource = await this.ctx.pool.query<{ pool: 'regular' | 'tail' | 'extinguishment'; n: string; gross: string; fee: string; net: string }>(
      `select case when detail->>'source' in ('tail', 'extinguishment') then detail->>'source' else 'regular' end as pool, count(*) as n, coalesce(sum(amount), 0) as gross,
              coalesce(sum((detail->>'fee')::numeric), 0) as fee, coalesce(sum((detail->>'net')::numeric), 0) as net
       from money_events where series_id = $1 and kind = 'payment' group by 1`,
      [seriesId],
    );
    const refunds = await this.ctx.pool.query<{ bids: string; payments: string }>(
      "select coalesce(sum(case when detail ? 'reason' then 0 else amount end), 0) as bids, coalesce(sum(case when detail ? 'reason' then amount else 0 end), 0) as payments from money_events where series_id = $1 and kind = 'refund'",
      [seriesId],
    );
    const periods = await this.ctx.pool.query<{ period_id: string; tier: number | null; payment_due: string; accrual: string; paid: string; split_received: string; report_accepted: boolean; settled: boolean; liquidity_event: boolean }>(
      'select period_id, tier, payment_due, accrual, paid, split_received, report_accepted, settled, liquidity_event from periods where series_id = $1 order by period_id',
      [seriesId],
    );

    const feeByKind: Record<FeeKind, string> = { auction: '0', payout: '0' };
    for (const f of fees.rows) feeByKind[f.kind] = f.total;
    const moneyTotals: Record<string, { count: number; total: string }> = {};
    for (const m of money.rows) moneyTotals[m.kind] = { count: Number(m.n), total: m.total };
    const sum = (kind: string): bigint => big(moneyTotals[kind]?.total);

    const pool = (name: 'regular' | 'tail' | 'extinguishment') => {
      const r = bySource.rows.find((x) => x.pool === name);
      return { count: Number(r?.n ?? 0), gross: big(r?.gross), fee: big(r?.fee), net: big(r?.net) };
    };
    const regular = pool('regular');
    const tail = pool('tail');

    const capPerUnit = s.cap_per_unit === null ? null : BigInt(s.cap_per_unit);
    const unitsSold = big(s.units_sold);
    const unitsOutstanding = big(s.units_outstanding);
    const paidPerUnitWad = big(s.paid_per_unit_wad);
    const paidPerUnit = paidPerUnitWad / WAD;
    // Stage 1's C_remaining: the paid amount rounded UP, so the statement never shows more room than the chain accepts
    const remainingPerUnit = capPerUnit === null ? null : capRemaining(capPerUnit, paidPerUnitWad);
    const returnedToHolders = sum('extinguishment');
    // what holders were given to claim: the regular net, the tail net and the final pool (a PayoutClaimed pays all three)
    const distributable = regular.net + tail.net + returnedToHolders;
    const claimed = sum('payout');
    const treasuryTotal = big(s.treasury_total);
    const treasuryReleased = big(s.treasury_released);

    return {
      seriesId: s.series_id,
      chain: s.chain,
      issuer: s.issuer,
      stablecoin: s.stablecoin,
      phase: s.phase,
      status: s.status,
      settledAt: ts(s.settled_at),
      feeRates: { auctionFeeBps: s.auction_fee_bps, payoutFeeBps: s.payout_fee_bps },
      cap: {
        capMultipleWad: s.cap_multiple_wad,
        issuePrice: s.issue_price,
        perUnit: str(capPerUnit),
        unitsSold: s.units_sold,
        unitsOutstanding: s.units_outstanding,
        total: capPerUnit === null ? null : (capPerUnit * unitsSold).toString(),
        paidPerUnitWad: s.paid_per_unit_wad,
        paidPerUnit: paidPerUnit.toString(),
        remainingPerUnit: str(remainingPerUnit),
        remainingTotal: remainingPerUnit === null ? null : (remainingPerUnit * unitsOutstanding).toString(),
        progressBps: capPerUnit !== null && capPerUnit > 0n ? Number((paidPerUnitWad * 10_000n) / (capPerUnit * WAD)) : null,
      },
      payments: { grossPaidTotal: regular.gross.toString(), netDistributed: regular.net.toString(), feesTaken: regular.fee.toString(), count: regular.count },
      fees: { auction: feeByKind.auction, payout: feeByKind.payout, total: (BigInt(feeByKind.auction) + BigInt(feeByKind.payout)).toString(), vaultFeesTotal: s.fees_total },
      payouts: { claimed: claimed.toString(), unclaimed: (distributable > claimed ? distributable - claimed : 0n).toString(), count: moneyTotals.payout?.count ?? 0 },
      refunds: { total: sum('refund').toString(), bids: refunds.rows[0]?.bids ?? '0', payments: refunds.rows[0]?.payments ?? '0' },
      // an extinguishment returns the unvested proceeds to holders: they leave the treasury without being released
      treasury: { total: s.treasury_total, released: s.treasury_released, balance: (treasuryTotal - treasuryReleased - returnedToHolders).toString(), releasesPaused: s.releases_paused },
      redemption: { price: s.redemption_price, redeemedAt: ts(s.redeemed_at), deposit: sum('redemption').toString(), claimed: sum('redemption_claim').toString() },
      tail: { total: sum('tail').toString(), fees: tail.fee.toString(), net: tail.net.toString(), count: tail.count },
      extinguishment: { extinguishedAt: ts(s.extinguished_at), returnedToHolders: returnedToHolders.toString() },
      burns: { units: sum('burn').toString() },
      periods: periods.rows.map((p) => ({ periodId: p.period_id, tier: p.tier, paymentDue: p.payment_due, accrual: p.accrual, paid: p.paid, splitReceived: p.split_received, reportAccepted: p.report_accepted, settled: p.settled, liquidityEvent: p.liquidity_event })),
      moneyEventTotals: moneyTotals,
    };
  }

  // ---- reconciliation

  /**
   * Compare the read model with the chain: the fee ledger per chain and stablecoin against the fee collector's
   * balance; for every settled series the indexed gross / fee totals against the vault and the indexed treasury
   * totals against the treasury. Every run is persisted and audited.
   */
  async reconcile(actor: Session): Promise<ReconciliationRun> {
    const checks: ReconciliationCheck[] = [];
    for (const chain of this.ctx.chains.chains.values()) {
      checks.push(...(await this.reconcileChain(chain)));
    }
    const failed = checks.filter((c) => !c.ok).length;
    const ok = failed === 0;
    const runId = this.ctx.newId('recon');
    const at = new Date();
    await this.ctx.pool.query('insert into reconciliation_runs (run_id, at, actor, ok, checks_total, checks_failed, checks) values ($1,$2,$3,$4,$5,$6,$7)', [runId, at, actor.accountId, ok, checks.length, failed, JSON.stringify(checks)]);
    await audit(this.ctx.pool, { actor: actor.accountId, actorRole: 'admin', action: 'accounting.reconcile', target: runId, detail: { ok, checksTotal: checks.length, checksFailed: failed } });
    return { runId, at: at.toISOString(), actor: actor.accountId, ok, checksTotal: checks.length, checksFailed: failed, checks };
  }

  private async reconcileChain(chain: ChainPort): Promise<ReconciliationCheck[]> {
    const checks: ReconciliationCheck[] = [];
    const info = await chain.info();
    type Coin = keyof typeof info.stablecoins;
    for (const coin of Object.keys(info.stablecoins) as Coin[]) {
      const indexed = await this.ctx.pool.query<{ total: string }>('select coalesce(sum(f.amount), 0) as total from fees_ledger f join series s on s.series_id = f.series_id where f.chain = $1 and s.stablecoin = $2', [chain.chain, coin]);
      const onchain = await chain.getBalance(info.feeCollector, coin);
      checks.push(compare('fee-collector-balance', chain.chain, null, coin, indexed.rows[0]?.total ?? '0', onchain));
    }
    for (const s of await chain.listSeries()) {
      if (s.phase !== 'Settled') continue;
      const row = (await this.ctx.pool.query<{ gross_paid_total: string; fees_total: string; treasury_total: string; treasury_released: string }>('select gross_paid_total, fees_total, treasury_total, treasury_released from series where series_id = $1', [s.seriesId])).rows[0] ?? null;
      const vault = await chain.getVault(s.seriesId);
      const treasury = await chain.getTreasury(s.seriesId);
      const coin = s.terms.stablecoin;
      checks.push(compare('vault-gross', chain.chain, s.seriesId, coin, row?.gross_paid_total, vault?.grossTotal));
      checks.push(compare('vault-fees', chain.chain, s.seriesId, coin, row?.fees_total, vault?.feesTotal));
      checks.push(compare('treasury-total', chain.chain, s.seriesId, coin, row?.treasury_total, treasury?.total));
      checks.push(compare('treasury-released', chain.chain, s.seriesId, coin, row?.treasury_released, treasury?.released));
    }
    return checks;
  }

  async listRuns(limit: number): Promise<ReconciliationRun[]> {
    const r = await this.ctx.pool.query<{ run_id: string; at: Date; actor: string; ok: boolean; checks_total: number; checks_failed: number; checks: ReconciliationCheck[] }>('select run_id, at, actor, ok, checks_total, checks_failed, checks from reconciliation_runs order by at desc, run_id desc limit $1', [limit]);
    return r.rows.map((x) => ({ runId: x.run_id, at: x.at.toISOString(), actor: x.actor, ok: x.ok, checksTotal: x.checks_total, checksFailed: x.checks_failed, checks: x.checks }));
  }

  // ---- export

  /** CSV of money events joined with series (RFC 4180, CRLF, header row). Every export is audited with its filter and row count. */
  async exportCsv(q: ExportQuery, actor: Session): Promise<{ csv: string; filename: string; rows: number }> {
    this.requireChain(q.chain);
    this.requireRange(q.from, q.to);
    const r = await this.ctx.pool.query<{ chain: string; seq: string; block_time: string; series_id: string; period_id: string | null; kind: string; wallet: string | null; amount: string; tx_id: string; stablecoin: string | null }>(
      `select m.chain, m.seq, m.block_time, m.series_id, m.period_id, m.kind, m.wallet, m.amount, m.tx_id, s.stablecoin
       from money_events m left join series s on s.series_id = m.series_id
       where ($1::text is null or m.chain = $1) and ($2::bigint is null or m.block_time >= $2) and ($3::bigint is null or m.block_time <= $3)
       order by m.chain, m.seq`,
      [q.chain ?? null, q.from ?? null, q.to ?? null],
    );
    const header = ['chain', 'seq', 'block_time', 'series_id', 'period_id', 'kind', 'wallet', 'amount', 'tx_id', 'stablecoin'];
    const lines = [header.join(',')];
    for (const x of r.rows) {
      lines.push([x.chain, x.seq, new Date(Number(x.block_time) * 1000).toISOString(), x.series_id, x.period_id, x.kind, x.wallet, x.amount, x.tx_id, x.stablecoin].map(csvCell).join(','));
    }
    const csv = lines.join('\r\n') + '\r\n';
    const day = (t: number | undefined, fallback: string) => (t === undefined ? fallback : new Date(t * 1000).toISOString().slice(0, 10));
    const filename = `merces-money-events_${q.chain ?? 'all-chains'}_${day(q.from, 'genesis')}_${day(q.to, 'latest')}.csv`;
    await audit(this.ctx.pool, { actor: actor.accountId, actorRole: 'admin', action: 'accounting.export', target: q.chain ?? 'all', detail: { chain: q.chain ?? null, from: q.from ?? null, to: q.to ?? null, rows: r.rows.length, filename } });
    return { csv, filename, rows: r.rows.length };
  }
}
