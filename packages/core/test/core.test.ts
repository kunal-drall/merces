import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, dbTestsEnabled } from '@merces/db';
import { audit, claimJobs, completeJob, createLogger, dispatchOutbox, enqueueJob, enqueueOutbox, logCapture, withIdempotency } from '../src/index.ts';

describe('logger redaction', () => {
  it('redacts income-bearing keys and captures lines for the canary', () => {
    logCapture.enabled = true;
    logCapture.reset();
    const log = createLogger('test', 'info');
    log.info({ incomeYtd: '7317317317', nested: { figure: 7317317317, ok: 'visible' } }, 'hello');
    expect(logCapture.lines.join('\n')).not.toContain('7317317317');
    expect(logCapture.lines.join('\n')).toContain('visible');
    logCapture.enabled = false;
  });
});

describe.skipIf(!dbTestsEnabled())('core db primitives', () => {
  let t: Awaited<ReturnType<typeof createTestSchema>>;
  beforeAll(async () => {
    t = await createTestSchema();
  });
  afterAll(async () => {
    await t.drop();
  });

  it('idempotency replays and rejects body changes', async () => {
    let calls = 0;
    const fn = async () => ({ status: 201, response: { n: ++calls } });
    const a = await withIdempotency(t.pool, 'bids', 'k1', { x: 1 }, fn);
    const b = await withIdempotency(t.pool, 'bids', 'k1', { x: 1 }, fn);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual({ n: 1 });
    await expect(withIdempotency(t.pool, 'bids', 'k1', { x: 2 }, fn)).rejects.toThrow(/different request body/);
  });

  it('outbox dispatches once and retries failures', async () => {
    await enqueueOutbox(t.pool, 'email', { to: 'a' });
    await enqueueOutbox(t.pool, 'email', { to: 'boom' });
    const seen: string[] = [];
    const client = await t.pool.connect();
    try {
      const r = await dispatchOutbox(client, async (_topic, p) => {
        if (p.to === 'boom') throw new Error('smtp down');
        seen.push(String(p.to));
      });
      expect(r).toEqual({ dispatched: 1, failed: 1 });
      const r2 = await dispatchOutbox(client, async (_t, p) => {
        seen.push(String(p.to));
      });
      expect(r2).toEqual({ dispatched: 1, failed: 0 });
    } finally {
      client.release();
    }
    expect(seen).toEqual(['a', 'boom']);
  });

  it('jobs dedupe while pending and are claimed with SKIP LOCKED', async () => {
    const a = await enqueueJob(t.pool, 'crank', { seriesId: 's' }, { dedupeKey: 's' });
    const b = await enqueueJob(t.pool, 'crank', { seriesId: 's' }, { dedupeKey: 's' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const claimed = await claimJobs(t.pool, ['crank'], 10);
    expect(claimed).toHaveLength(1);
    expect(await claimJobs(t.pool, ['crank'], 10)).toHaveLength(0); // locked
    await completeJob(t.pool, claimed[0]!.id);
    const c = await enqueueJob(t.pool, 'crank', { seriesId: 's' }, { dedupeKey: 's' });
    expect(c).not.toBeNull();
  });

  it('audit log is append-only', async () => {
    await audit(t.pool, { actor: 'admin-1', actorRole: 'admin', action: 'flag.set', target: 'tier4', detail: { enabled: false } });
    await expect(t.pool.query('delete from audit_log')).rejects.toThrow(/append-only/);
    await expect(t.pool.query("update audit_log set action = 'x'")).rejects.toThrow(/append-only/);
  });
});
