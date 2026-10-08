import type { Pool } from '@merces/db';
import { createLogger, type Logger } from '@merces/core';
import { parseDomainEvent, type ChainPort, type DomainEvent } from '@merces/domain';
import { project } from './projections.ts';
import { enqueueChainNotice } from './notices.ts';

export interface IndexerOptions {
  batchSize?: number;
  logger?: Logger;
}

/**
 * E1 indexer. Per chain: read events after the stored cursor, validate them against the canonical schema,
 * apply finalized ones to the read model inside one transaction per batch, advance the cursor.
 *
 * Guarantees:
 *  - idempotent: every projection is an upsert keyed by (chain, seq); re-delivery is a no-op
 *  - resumable: the cursor lives in indexer_cursors and is advanced in the same transaction as the projections
 *  - duplicate-safe and order-safe: a batch is sorted by seq; events at or below last_seq are skipped;
 *    a gap (seq > last_seq + 1) stops the batch so the port can be re-read from the last cursor
 *  - reorg-safe: only `finalized` events reach money tables; `confirmed` events land in events_pending
 */
export class Indexer {
  private readonly log: Logger;
  private readonly batchSize: number;
  constructor(
    private readonly pool: Pool,
    private readonly chains: ChainPort[],
    opts: IndexerOptions = {},
  ) {
    this.log = opts.logger ?? createLogger('indexer');
    this.batchSize = opts.batchSize ?? 200;
  }

  async cursor(chain: string): Promise<{ cursor: string | null; lastSeq: number }> {
    const r = await this.pool.query<{ cursor: string | null; last_seq: string }>('select cursor, last_seq from indexer_cursors where chain = $1', [chain]);
    const row = r.rows[0];
    return row ? { cursor: row.cursor, lastSeq: Number(row.last_seq) } : { cursor: null, lastSeq: 0 };
  }

  /** Process at most one batch for one chain. Returns the number of events applied. */
  async runOnce(chain: ChainPort): Promise<number> {
    const { cursor, lastSeq } = await this.cursor(chain.chain);
    const { events, nextCursor } = await chain.readEvents(cursor, this.batchSize);
    if (events.length === 0) return 0;
    return this.apply(chain.chain, events, nextCursor, lastSeq);
  }

  /** Apply a delivered batch (used by runOnce and by tests that simulate duplicate / out-of-order delivery). */
  async apply(chainKey: string, delivered: DomainEvent[], nextCursor: string | null, knownLastSeq?: number): Promise<number> {
    const client = await this.pool.connect();
    let applied = 0;
    try {
      await client.query('begin');
      const cur = knownLastSeq ?? (await this.cursor(chainKey)).lastSeq;
      let lastSeq = cur;
      let lastCursor: string | null = null;
      const sorted = [...delivered].sort((a, b) => a.seq - b.seq);
      for (const raw of sorted) {
        const e = parseDomainEvent(raw);
        if (e.chain !== chainKey) throw new Error(`event for ${e.chain} delivered to the ${chainKey} indexer`);
        if (e.finality !== 'finalized') {
          await client.query('insert into events_pending (chain, cursor, seq, type, series_id, payload) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [e.chain, e.cursor, e.seq, e.type, (e.payload as { seriesId?: string }).seriesId ?? null, JSON.stringify(e.payload)]);
          continue;
        }
        if (e.seq <= lastSeq) continue; // duplicate
        if (e.seq > lastSeq + 1) {
          this.log.warn({ chain: chainKey, expected: lastSeq + 1, got: e.seq }, 'gap in event stream; stopping batch to re-read');
          break;
        }
        const ins = await client.query('insert into events (chain, cursor, seq, block_time, block_ref, tx_id, type, series_id, payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing', [e.chain, e.cursor, e.seq, e.blockTime, e.blockRef, e.txId, e.type, (e.payload as { seriesId?: string }).seriesId ?? null, JSON.stringify(e.payload)]);
        if (ins.rowCount === 1) {
          await project(client, e);
          await enqueueChainNotice(client, e);
        }
        await client.query('delete from events_pending where chain = $1 and cursor = $2', [e.chain, e.cursor]);
        lastSeq = e.seq;
        lastCursor = e.cursor;
        applied++;
      }
      if (applied > 0 || nextCursor !== null) {
        const cursorToStore = lastCursor ?? (applied === 0 && delivered.every((d) => d.finality !== 'finalized') ? null : null);
        if (cursorToStore !== null) await client.query('insert into indexer_cursors (chain, cursor, last_seq) values ($1,$2,$3) on conflict (chain) do update set cursor = excluded.cursor, last_seq = excluded.last_seq, updated_at = now()', [chainKey, cursorToStore, lastSeq]);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (applied) this.log.debug({ chain: chainKey, applied }, 'indexed');
    return applied;
  }

  /**
   * Drain every chain until no new events arrive. Chains are independent: one chain's failure (RPC outage, an event
   * that fails validation) is logged and the other chains are still indexed; the failures are rethrown together
   * once every chain has been attempted, so the caller still sees them.
   */
  async catchUp(): Promise<number> {
    let total = 0;
    const failures: string[] = [];
    for (const c of this.chains) {
      try {
        for (;;) {
          const n = await this.runOnce(c);
          total += n;
          if (n === 0) break;
        }
      } catch (e) {
        const msg = (e as Error).message;
        this.log.error({ chain: c.chain, err: msg }, 'indexing failed for this chain; other chains continue');
        failures.push(`${c.chain}: ${msg}`);
      }
    }
    if (failures.length) throw new Error(`indexer: ${failures.join('; ')}`);
    return total;
  }

  /** Poll loop for long-running processes. */
  async runLoop(intervalMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        await this.catchUp();
      } catch (e) {
        this.log.error({ err: (e as Error).message }, 'indexer batch failed; will retry');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
