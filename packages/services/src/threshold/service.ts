import { z } from 'zod';
import { AppError, audit, enqueueOutbox } from '@merces/core';
import { withTransaction, type Queryable } from '@merces/db';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E9 — threshold data service (R34).
 * The curated median-income and inflation table (threshold_data, 004) is read publicly and edited by admins only.
 * Every edit is recorded in the append-only threshold_data_history table and audited. The yearly indexing side lists
 * the live series whose terms are CPI-indexed and have not been amended for a year, and nudges their issuers once
 * through the outbox. Nothing here decrypts a vault: candidates are derived from metadata alone.
 * The figures stored here are public statistics about a country, never a person's income.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const thresholdRowSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** annual median full-time income in currency base units (6 decimals), as a decimal string */
  medianFullTimeIncome: z.string().regex(/^\d+$/).refine((s) => BigInt(s) > 0n, 'median income must be positive'),
  /** year-over-year CPI change in basis points (negative = deflation) */
  inflationIndexBps: z.number().int().min(-10_000).max(100_000),
  source: z.string().trim().min(1, 'source is required').max(2000),
  sourceUrl: z.url().max(2000).nullable().optional(),
  /** ISO date (YYYY-MM-DD) the figure was retrieved from the source */
  retrievedAt: z.string().regex(DATE, 'retrievedAt must be YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'retrievedAt is not a date'),
  placeholder: z.boolean(),
});
export type ThresholdRowInput = z.infer<typeof thresholdRowSchema>;

export const thresholdKeySchema = z.object({
  country: z.string().length(2).transform((s) => s.toUpperCase()).pipe(z.string().regex(/^[A-Z]{2}$/)),
  year: z.coerce.number().int().min(2000).max(2100),
});
export const yearSchema = z.coerce.number().int().min(2000).max(2100);

interface ThresholdRow {
  country: string;
  year: number;
  currency: string;
  median_full_time_income: string;
  inflation_index_bps: number;
  source: string;
  source_url: string | null;
  retrieved_at: Date | string;
  placeholder: boolean;
  updated_by: string | null;
  updated_at: Date;
}

const isoDate = (d: Date | string): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function publicView(r: ThresholdRow): Record<string, unknown> {
  return { country: r.country, year: r.year, currency: r.currency, medianFullTimeIncome: r.median_full_time_income, inflationIndexBps: r.inflation_index_bps, source: r.source, sourceUrl: r.source_url, retrievedAt: isoDate(r.retrieved_at), placeholder: r.placeholder };
}
function adminView(r: ThresholdRow & { history_count?: string | number }): Record<string, unknown> {
  return { ...publicView(r), updatedBy: r.updated_by, updatedAt: r.updated_at, historyCount: r.history_count === undefined ? undefined : Number(r.history_count) };
}

export class ThresholdService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Public: one line per country — its latest year, currency, placeholder flag and source. No admin fields. */
  async listPublic(): Promise<{ countries: Record<string, unknown>[] }> {
    const r = await this.ctx.pool.query<Pick<ThresholdRow, 'country' | 'year' | 'currency' | 'placeholder' | 'source'>>('select distinct on (country) country, year, currency, placeholder, source from threshold_data order by country, year desc');
    return { countries: r.rows.map((x) => ({ country: x.country, latestYear: x.year, currency: x.currency, placeholder: x.placeholder, source: x.source })) };
  }

  /** Admin: every row with the number of recorded changes. */
  async listAdmin(): Promise<{ rows: Record<string, unknown>[] }> {
    const r = await this.ctx.pool.query<ThresholdRow & { history_count: string }>(
      'select t.*, (select count(*) from threshold_data_history h where h.country = t.country and h.year = t.year) as history_count from threshold_data t order by t.country, t.year desc',
    );
    return { rows: r.rows.map(adminView) };
  }

  /** Admin: the change history of one (country, year), oldest first. Works for deleted rows too. */
  async history(country: string, year: number): Promise<{ country: string; year: number; history: Record<string, unknown>[] }> {
    const r = await this.ctx.pool.query<ThresholdRow & { id: string; at: Date; op: string; changed_by: string }>('select * from threshold_data_history where country = $1 and year = $2 order by id', [country, year]);
    return { country, year, history: r.rows.map((x) => ({ id: Number(x.id), at: x.at, op: x.op, ...publicView(x), changedBy: x.changed_by })) };
  }

  private async recordHistory(db: Queryable, op: 'insert' | 'update' | 'delete', row: ThresholdRow, by: string): Promise<void> {
    await db.query(
      'insert into threshold_data_history (country, year, op, currency, median_full_time_income, inflation_index_bps, source, source_url, retrieved_at, placeholder, changed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [row.country, row.year, op, row.currency, row.median_full_time_income, row.inflation_index_bps, row.source, row.source_url, isoDate(row.retrieved_at), row.placeholder, by],
    );
  }

  /** Admin: insert or replace the row for (country, year); history + audit in the same transaction. */
  async upsert(country: string, year: number, input: ThresholdRowInput, session: Session): Promise<{ created: boolean; row: Record<string, unknown> }> {
    return withTransaction(this.ctx.pool, async (c) => {
      const before = (await c.query<ThresholdRow>('select * from threshold_data where country = $1 and year = $2 for update', [country, year])).rows[0];
      const r = await c.query<ThresholdRow>(
        `insert into threshold_data (country, year, currency, median_full_time_income, inflation_index_bps, source, source_url, retrieved_at, placeholder, updated_by, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         on conflict (country, year) do update set currency = excluded.currency, median_full_time_income = excluded.median_full_time_income, inflation_index_bps = excluded.inflation_index_bps,
           source = excluded.source, source_url = excluded.source_url, retrieved_at = excluded.retrieved_at, placeholder = excluded.placeholder, updated_by = excluded.updated_by, updated_at = now()
         returning *`,
        [country, year, input.currency, input.medianFullTimeIncome, input.inflationIndexBps, input.source, input.sourceUrl ?? null, input.retrievedAt, input.placeholder, session.accountId],
      );
      const row = r.rows[0]!;
      const op = before ? 'update' : 'insert';
      await this.recordHistory(c, op, row, session.accountId);
      await audit(c, { actor: session.accountId, actorRole: 'admin', action: `threshold.${op}`, target: `${country}:${year}`, detail: { after: publicView(row), before: before ? publicView(before) : null } });
      this.ctx.log.info({ country, year, op, placeholder: row.placeholder }, 'threshold row written');
      return { created: !before, row: adminView(row) };
    });
  }

  /** Admin: remove the row; the deleted values stay in the history. */
  async remove(country: string, year: number, session: Session): Promise<{ deleted: true; country: string; year: number }> {
    return withTransaction(this.ctx.pool, async (c) => {
      const r = await c.query<ThresholdRow>('delete from threshold_data where country = $1 and year = $2 returning *', [country, year]);
      const row = r.rows[0];
      if (!row) throw AppError.notFound('threshold row');
      await this.recordHistory(c, 'delete', row, session.accountId);
      await audit(c, { actor: session.accountId, actorRole: 'admin', action: 'threshold.delete', target: `${country}:${year}`, detail: { before: publicView(row) } });
      this.ctx.log.info({ country, year }, 'threshold row deleted');
      return { deleted: true as const, country, year };
    });
  }

  // ---- yearly indexing (C4, R34)

  /**
   * Series due for the yearly CPI amendment: a vault whose terms are CPI-indexed, linked to a live series, with no
   * 'inflation-index' amendment for the year and an inflation index on file for the series' country. Metadata only:
   * the indexing rule is read from the draft's public terms when present and otherwise assumed to be the default
   * ('cpi-annual'); the vault ciphertext is never opened here.
   */
  async indexingCandidates(year: number): Promise<{ year: number; candidates: Record<string, unknown>[] }> {
    const r = await this.ctx.pool.query<{ series_id: string; chain: string; issuer: string; status: string; draft_id: string; country: string; version: number; inflation_index_bps: number; index_placeholder: boolean; source: string; notified_at: Date | null }>(
      `select s.series_id, s.chain, s.issuer, s.status, d.draft_id, d.public_terms->>'country' as country, v.version,
              td.inflation_index_bps, td.placeholder as index_placeholder, td.source, n.notified_at
         from terms_vault v
         join series_drafts d on d.draft_id = v.draft_id
         join series s on s.series_id = v.series_id
         join threshold_data td on td.country = d.public_terms->>'country' and td.year = $1
         left join indexing_notifications n on n.series_id = s.series_id and n.year = $1
        where coalesce(d.public_terms->>'indexingRule', 'cpi-annual') = 'cpi-annual'
          and s.status not in ('Retired','Redeemed','Extinguished')
          and not exists (select 1 from terms_amendments a where a.series_id = s.series_id and a.kind = 'inflation-index' and a.rationale_code like $2)
        order by s.series_id`,
      [year, `cpi-${year}-%`],
    );
    return {
      year,
      candidates: r.rows.map((x) => ({ seriesId: x.series_id, chain: x.chain, issuer: x.issuer, status: x.status, draftId: x.draft_id, country: x.country, vaultVersion: x.version, inflationIndexBps: x.inflation_index_bps, indexPlaceholder: x.index_placeholder, source: x.source, notified: !!x.notified_at, notifiedAt: x.notified_at })),
    };
  }

  /** Admin: enqueue one 'indexing.due' notification per candidate not yet notified for the year (idempotent through the ledger) and audit. */
  async notifyIndexing(year: number, session: Session): Promise<{ year: number; candidates: number; notified: string[]; alreadyNotified: string[] }> {
    const { candidates } = await this.indexingCandidates(year);
    const notified: string[] = [];
    const alreadyNotified: string[] = [];
    for (const c of candidates) {
      const seriesId = String(c.seriesId);
      const fresh = await withTransaction(this.ctx.pool, async (db) => {
        const ins = await db.query('insert into indexing_notifications (series_id, year, country, inflation_index_bps, notified_by) values ($1,$2,$3,$4,$5) on conflict (series_id, year) do nothing returning series_id', [seriesId, year, c.country, c.inflationIndexBps, session.accountId]);
        if (!ins.rowCount) return false;
        const outboxId = await enqueueOutbox(db, 'notification', { kind: 'indexing.due', seriesId, year });
        await db.query('update indexing_notifications set outbox_id = $3 where series_id = $1 and year = $2', [seriesId, year, outboxId]);
        return true;
      });
      (fresh ? notified : alreadyNotified).push(seriesId);
    }
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: 'admin', action: 'indexing.notify', target: String(year), detail: { candidates: candidates.length, notified, alreadyNotified } });
    return { year, candidates: candidates.length, notified, alreadyNotified };
  }
}
