import type { ServiceContext } from '@merces/services';
import type { KeeperJob } from './jobs.ts';

/**
 * In-process scheduler. Each job runs on its own interval; runs are logged to keeper_runs. `runAll()` runs
 * every job once (tests, cron-style deployments); `start()` loops until aborted.
 */
export class KeeperScheduler {
  private readonly lastRun = new Map<string, number>();
  constructor(
    private readonly ctx: ServiceContext,
    private readonly jobs: KeeperJob[],
  ) {}

  async runJob(job: KeeperJob): Promise<{ ok: boolean; actions: number; detail?: string }> {
    const started = await this.ctx.pool.query<{ id: string }>('insert into keeper_runs (job) values ($1) returning id', [job.name]);
    const id = started.rows[0]!.id;
    try {
      const r = await job.run(this.ctx);
      await this.ctx.pool.query('update keeper_runs set finished_at = now(), ok = true, actions = $2, detail = $3 where id = $1', [id, r.actions, r.detail ?? null]);
      if (r.actions) this.ctx.log.info({ job: job.name, actions: r.actions, detail: r.detail }, 'keeper job ran');
      return { ok: true, ...r };
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      await this.ctx.pool.query('update keeper_runs set finished_at = now(), ok = false, detail = $2 where id = $1', [id, msg]);
      this.ctx.log.error({ job: job.name, err: msg }, 'keeper job failed');
      return { ok: false, actions: 0, detail: msg };
    } finally {
      this.lastRun.set(job.name, Date.now());
    }
  }

  async runAll(): Promise<Record<string, { ok: boolean; actions: number; detail?: string }>> {
    const out: Record<string, { ok: boolean; actions: number; detail?: string }> = {};
    for (const j of this.jobs) out[j.name] = await this.runJob(j);
    return out;
  }

  async start(signal?: AbortSignal, tickMs = 5_000): Promise<void> {
    while (!signal?.aborted) {
      for (const j of this.jobs) {
        const last = this.lastRun.get(j.name) ?? 0;
        if (Date.now() - last >= j.intervalSeconds * 1000) await this.runJob(j);
      }
      await new Promise((r) => setTimeout(r, tickMs));
    }
  }
}
