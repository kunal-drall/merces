import type { ServiceContext } from '@merces/services';
import type { KeeperJob } from './jobs.ts';

type RunResult = { ok: boolean; actions: number; detail?: string };

/**
 * In-process scheduler. Each job runs on its own interval; runs are logged to keeper_runs. `runAll()` runs
 * every job once (tests, cron-style deployments); `start()` loops until aborted.
 *
 * A run is recorded as failed (ok = false) when the job throws or returns `errors`, so a stuck series shows up in
 * the admin view of failing keeper runs. The scheduler itself never dies on a job or on its own bookkeeping: a
 * database blip while writing keeper_runs is logged and the loop carries on with the next tick.
 */
export class KeeperScheduler {
  private readonly lastRun = new Map<string, number>();
  constructor(
    private readonly ctx: ServiceContext,
    private readonly jobs: KeeperJob[],
  ) {}

  async runJob(job: KeeperJob): Promise<RunResult> {
    let id: string | null = null;
    try {
      const started = await this.ctx.pool.query<{ id: string }>('insert into keeper_runs (job) values ($1) returning id', [job.name]);
      id = started.rows[0]?.id ?? null;
    } catch (e) {
      this.ctx.log.error({ job: job.name, err: (e as Error).message }, 'could not record keeper run start');
    }
    let result: RunResult;
    try {
      const r = await job.run(this.ctx);
      const errors = r.errors ?? [];
      const detail = [r.detail, errors.length ? `errors: ${errors.join('; ')}` : undefined].filter(Boolean).join(' | ').slice(0, 500) || undefined;
      result = { ok: errors.length === 0, actions: r.actions, detail };
      if (!result.ok) this.ctx.log.error({ job: job.name, actions: r.actions, errors }, 'keeper job had failures');
      else if (r.actions) this.ctx.log.info({ job: job.name, actions: r.actions, detail: r.detail }, 'keeper job ran');
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      this.ctx.log.error({ job: job.name, err: msg }, 'keeper job failed');
      result = { ok: false, actions: 0, detail: msg };
    } finally {
      this.lastRun.set(job.name, Date.now());
    }
    if (id) {
      try {
        await this.ctx.pool.query('update keeper_runs set finished_at = now(), ok = $2, actions = $3, detail = $4 where id = $1', [id, result.ok, result.actions, result.detail ?? null]);
      } catch (e) {
        this.ctx.log.error({ job: job.name, err: (e as Error).message }, 'could not record keeper run result');
      }
    }
    return result;
  }

  async runAll(): Promise<Record<string, RunResult>> {
    const out: Record<string, RunResult> = {};
    for (const j of this.jobs) out[j.name] = await this.runJob(j);
    return out;
  }

  async start(signal?: AbortSignal, tickMs = 5_000): Promise<void> {
    while (!signal?.aborted) {
      for (const j of this.jobs) {
        const last = this.lastRun.get(j.name) ?? 0;
        if (Date.now() - last < j.intervalSeconds * 1000) continue;
        try {
          await this.runJob(j);
        } catch (e) {
          // runJob already guards its own work; this is the last line so the loop never exits on an error
          this.ctx.log.error({ job: j.name, err: (e as Error).message }, 'keeper tick failed');
          this.lastRun.set(j.name, Date.now());
        }
      }
      await new Promise((r) => setTimeout(r, tickMs));
    }
  }
}
