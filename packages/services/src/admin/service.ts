import { z } from 'zod';
import { AppError, audit, getFlag, listFlags, setFlag } from '@merces/core';
import { addressFamily, normaliseAddress, type AdminCommand, type ChainPort, type UnsignedTx } from '@merces/domain';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E13 — admin API with an append-only audit log.
 * Admins have no path to user funds or raw income: every chain action is an UnsignedTx built for the protocol
 * multisig (`info().admin`) and tracked in admin_tx_requests until the chain itself shows the effect. Offchain
 * actions (feature flags, role grants, audit sampling) are audited with the admin's account id. Nothing here
 * reads a figure, a document or a reason; the overview is counts, statuses and cursors.
 */

export const FLAG_NAMES = ['tier4', 'transfer_windows', 'early_draws', 'secondary_trading', 'private_payouts'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
/** R: private payouts are "coming soon" (E15) — the flag exists but can never be switched on from the API. */
export const LOCKED_FLAGS: ReadonlySet<FlagName> = new Set<FlagName>(['private_payouts']);

export const registerAttestorSchema = z.object({
  chain: z.string().min(1),
  wallet: z.string().min(1).max(64),
  accountId: z.string().min(1).max(128),
  active: z.boolean(),
  /** ISO 3166-1 alpha-2 */
  jurisdiction: z.string().length(2).optional(),
  kind: z.enum(['CA', 'CPA']).optional(),
});
export const registerVerifierKeySchema = z.object({
  chain: z.string().min(1),
  keyId: z.string().min(1).max(128),
  /** DER SubjectPublicKeyInfo, hex (ed25519 SPKI is 44 bytes) */
  publicKeySpkiHex: z.string().regex(/^(0x)?([0-9a-fA-F]{2}){32,128}$/),
  active: z.boolean(),
});
export const pauseRaisesSchema = z.object({ chain: z.string().min(1), paused: z.boolean() });
export const auditSamplesSchema = z.object({ count: z.number().int().min(1).max(100) });
export const txRequestsQuerySchema = z.object({ chain: z.string().optional(), kind: z.string().optional(), state: z.enum(['proposed', 'sent', 'confirmed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const auditLogQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), actor: z.string().optional(), action: z.string().optional(), target: z.string().optional(), before: z.coerce.number().int().positive().optional() });
export const keeperRunsQuerySchema = z.object({ job: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const auditSamplesQuerySchema = z.object({ outcome: z.enum(['pending', 'passed', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export interface AdminTxRequest {
  requestId: string;
  kind: AdminCommand['kind'];
  chain: string;
  command: AdminCommand;
  state: 'proposed' | 'sent' | 'confirmed';
  txId: string | null;
  createdBy: string;
  meta: Record<string, unknown>;
  createdAt: Date;
  sentAt: Date | null;
  confirmedAt: Date | null;
}

type RequestRow = { request_id: string; kind: AdminCommand['kind']; chain: string; command: AdminCommand; state: AdminTxRequest['state']; tx_id: string | null; created_by: string; meta: Record<string, unknown>; created_at: Date; sent_at: Date | null; confirmed_at: Date | null };

export class AdminService {
  constructor(private readonly ctx: ServiceContext) {}

  private port(chain: string): ChainPort {
    const port = this.ctx.chains.chains.get(chain);
    if (!port) throw AppError.badRequest(`unknown chain ${chain}`);
    return port;
  }

  // ---------------------------------------------------------------- overview
  async overview(): Promise<Record<string, unknown>> {
    const chains: Record<string, unknown>[] = [];
    for (const port of this.ctx.chains.chains.values()) {
      const [info, health, cursor, byStatus, byPhase] = await Promise.all([
        port.info(),
        port.health().catch((e: Error) => ({ ok: false, mode: port.mode, latency_ms: 0, detail: `health check failed: ${e.message}` })),
        this.ctx.pool.query<{ cursor: string | null; last_seq: string; updated_at: Date }>('select cursor, last_seq, updated_at from indexer_cursors where chain = $1', [port.chain]),
        this.ctx.pool.query<{ status: string; n: number }>('select status, count(*)::int as n from series where chain = $1 group by status order by status', [port.chain]),
        this.ctx.pool.query<{ phase: string; n: number }>('select phase, count(*)::int as n from series where chain = $1 group by phase order by phase', [port.chain]),
      ]);
      const c = cursor.rows[0];
      chains.push({
        chain: port.chain, family: port.family, mode: port.mode, network: info.network, admin: info.admin, newRaisesPaused: info.newRaisesPaused,
        health: { ok: health.ok, latencyMs: health.latency_ms, detail: health.detail },
        indexer: c ? { cursor: c.cursor, lastSeq: Number(c.last_seq), updatedAt: c.updated_at } : null,
        series: { total: byStatus.rows.reduce((a, r) => a + r.n, 0), byStatus: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n])), byPhase: Object.fromEntries(byPhase.rows.map((r) => [r.phase, r.n])) },
      });
    }
    const [lastRuns, failures, outbox, applications, txRequests, flags] = await Promise.all([
      this.ctx.pool.query('select distinct on (job, chain) id, job, chain, started_at, finished_at, ok, actions, detail from keeper_runs order by job, chain, started_at desc, id desc'),
      this.ctx.pool.query('select id, job, chain, started_at, finished_at, ok, actions, detail from keeper_runs where ok = false order by started_at desc, id desc limit 20'),
      this.ctx.pool.query<{ pending: number; failed: number }>('select count(*) filter (where dispatched_at is null)::int as pending, count(*) filter (where dispatched_at is null and last_error is not null)::int as failed from outbox'),
      this.ctx.pool.query<{ open: number; submitted: number; in_review: number }>("select count(*)::int as open, count(*) filter (where state = 'submitted')::int as submitted, count(*) filter (where state = 'in_review')::int as in_review from applications where state in ('submitted','in_review')"),
      this.ctx.pool.query<{ state: string; n: number }>('select state, count(*)::int as n from admin_tx_requests group by state'),
      listFlags(this.ctx.pool),
    ]);
    const o = outbox.rows[0]!;
    const a = applications.rows[0]!;
    return {
      at: new Date().toISOString(),
      chains,
      keepers: { lastRuns: lastRuns.rows.map(keeperRun), recentFailures: failures.rows.map(keeperRun) },
      outbox: { pending: o.pending, failed: o.failed },
      applications: { open: a.open, submitted: a.submitted, inReview: a.in_review },
      txRequests: { proposed: 0, sent: 0, confirmed: 0, ...Object.fromEntries(txRequests.rows.map((r) => [r.state, r.n])) },
      flags: flags.map((f) => ({ name: f.name, enabled: f.enabled, locked: LOCKED_FLAGS.has(f.name as FlagName) })),
    };
  }

  // ---------------------------------------------------------------- flags
  async flags(): Promise<{ name: string; enabled: boolean; locked: boolean }[]> {
    return (await listFlags(this.ctx.pool)).map((f) => ({ name: f.name, enabled: f.enabled, locked: LOCKED_FLAGS.has(f.name as FlagName) }));
  }

  async setFlag(name: string, enabled: boolean, admin: Session): Promise<{ name: string; enabled: boolean; locked: boolean; changed: boolean }> {
    if (!(FLAG_NAMES as readonly string[]).includes(name)) throw AppError.notFound(`flag ${name}`);
    const flag = name as FlagName;
    if (enabled && LOCKED_FLAGS.has(flag)) throw AppError.conflict(`${name} is coming soon and cannot be enabled`);
    const previous = await getFlag(this.ctx.pool, flag);
    await setFlag(this.ctx.pool, flag, enabled, admin.accountId);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'flag.set', target: flag, detail: { enabled, previous } });
    return { name: flag, enabled, locked: LOCKED_FLAGS.has(flag), changed: previous !== enabled };
  }

  // ---------------------------------------------------------------- audit log
  async auditLog(q: z.infer<typeof auditLogQuerySchema>): Promise<Record<string, unknown>[]> {
    // `action` matches the exact action or its namespace prefix (`flag` matches `flag.set`)
    const r = await this.ctx.pool.query(
      `select id, at, actor, actor_role, action, target, detail from audit_log
       where ($1::text is null or actor = $1) and ($2::text is null or action = $2 or action like $2 || '.%') and ($3::text is null or target = $3) and ($4::bigint is null or id < $4)
       order by id desc limit $5`,
      [q.actor ?? null, q.action ?? null, q.target ?? null, q.before ?? null, q.limit],
    );
    return r.rows.map((x) => ({ id: Number(x.id), at: x.at, actor: x.actor, actorRole: x.actor_role, action: x.action, target: x.target, detail: x.detail }));
  }

  // ---------------------------------------------------------------- multisig requests
  /** Build an admin command for the multisig and record the request. The backend never signs it. */
  private async propose(chain: string, command: AdminCommand, admin: Session, meta: Record<string, unknown> = {}): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const port = this.port(chain);
    const info = await port.info();
    const tx = await port.build(command, info.admin);
    const id = this.ctx.newId('adminreq');
    await this.ctx.pool.query('insert into admin_tx_requests (request_id, kind, chain, command, created_by, meta) values ($1,$2,$3,$4,$5,$6)', [id, command.kind, chain, JSON.stringify(command), admin.accountId, JSON.stringify(meta)]);
    return { request: await this.getRequest(id), tx };
  }

  async registerAttestor(input: z.infer<typeof registerAttestorSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const port = this.port(input.chain);
    const wallet = normaliseAddress(input.wallet, port.family);
    if (addressFamily(wallet) !== port.family) throw AppError.badRequest(`wallet is not a ${port.family} address`);
    const acc = await this.ctx.pool.query('select 1 from accounts where account_id = $1', [input.accountId]);
    if (!acc.rowCount) throw AppError.notFound('account');
    // the proposal names the account that will act as attestor: it must have proven it holds this wallet, or the
    // registry would give attestor access to whoever links the wallet instead
    const linked = await this.ctx.pool.query('select 1 from account_wallets where chain = $1 and address = $2 and account_id = $3', [input.chain, wallet, input.accountId]);
    if (!linked.rowCount) throw AppError.unprocessable('the wallet is not linked to that account; the account must link it (sign in with it) first');
    const meta = { accountId: input.accountId, jurisdiction: input.jurisdiction ?? null, kind: input.kind ?? null };
    const r = await this.propose(input.chain, { kind: 'registerAttestor', attestor: wallet, active: input.active }, admin, meta);
    // A proposal grants nothing (A-M5-2): attestor access starts when the multisig's registerAttestor is onchain and
    // indexed, and ends when a deactivation is indexed. Until then the account sees no hardship cases or documents.
    await this.ctx.pool.query(
      'insert into attestor_proposals (chain, wallet, account_id, active, request_id, proposed_by) values ($1,$2,$3,$4,$5,$6) on conflict (chain, wallet) do update set account_id = excluded.account_id, active = excluded.active, request_id = excluded.request_id, proposed_by = excluded.proposed_by, proposed_at = now()',
      [input.chain, wallet, input.accountId, input.active, r.request.requestId, admin.accountId],
    );
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'attestor.register', target: `${input.chain}:${wallet}`, detail: { requestId: r.request.requestId, ...meta, active: input.active } });
    return r;
  }

  /**
   * Attestor proposals and the indexed onchain registry side by side. status: 'registered' (active onchain),
   * 'pending-onchain' (proposed active, not yet indexed as active), 'deactivation-pending' (proposed inactive, still
   * active onchain) or 'inactive'. accountId is the account holding the wallet now (the one that gets access). Only an
   * indexed active registration gives attestor access.
   */
  async listAttestors(): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query(
      `select x.chain, x.wallet, coalesce(w.account_id, x.account_id) as account_id, x.proposed_active, x.request_id, x.proposed_by, x.proposed_at, x.onchain_active
         from (select coalesce(p.chain, a.chain) as chain, coalesce(p.wallet, a.attestor) as wallet, p.account_id, p.active as proposed_active,
                      p.request_id, p.proposed_by, p.proposed_at, a.active as onchain_active
                 from attestor_proposals p full outer join attestors a on a.chain = p.chain and a.attestor = p.wallet) x
         left join account_wallets w on w.chain = x.chain and w.address = x.wallet
        order by 1, 2`,
    );
    return r.rows.map((x) => {
      const onchain = x.onchain_active === true;
      const status = onchain ? (x.proposed_active === false ? 'deactivation-pending' : 'registered') : x.proposed_active === true ? 'pending-onchain' : 'inactive';
      return { chain: x.chain, wallet: x.wallet, accountId: x.account_id ?? null, status, onchainActive: onchain, proposal: x.proposed_by ? { active: x.proposed_active, requestId: x.request_id, proposedBy: x.proposed_by, proposedAt: x.proposed_at } : null };
    });
  }

  async registerVerifierKey(input: z.infer<typeof registerVerifierKeySchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const publicKey = input.publicKeySpkiHex.replace(/^0x/, '').toLowerCase();
    const r = await this.propose(input.chain, { kind: 'registerVerifierKey', keyId: input.keyId, publicKey, active: input.active }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'verifier-key.register', target: `${input.chain}:${input.keyId}`, detail: { requestId: r.request.requestId, active: input.active } });
    return r;
  }

  async pauseNewRaises(input: z.infer<typeof pauseRaisesSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const r = await this.propose(input.chain, { kind: 'pauseNewRaises', paused: input.paused }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: input.paused ? 'raises.pause' : 'raises.resume', target: input.chain, detail: { requestId: r.request.requestId, paused: input.paused } });
    return r;
  }

  async getRequest(id: string): Promise<AdminTxRequest> {
    const r = await this.ctx.pool.query<RequestRow>('select * from admin_tx_requests where request_id = $1', [id]);
    if (!r.rows[0]) throw AppError.notFound('tx request');
    return requestRow(r.rows[0]);
  }

  async listRequests(q: z.infer<typeof txRequestsQuerySchema>): Promise<AdminTxRequest[]> {
    const r = await this.ctx.pool.query<RequestRow>(
      'select * from admin_tx_requests where ($1::text is null or chain = $1) and ($2::text is null or kind = $2) and ($3::text is null or state = $3) order by created_at desc limit $4',
      [q.chain ?? null, q.kind ?? null, q.state ?? null, q.limit],
    );
    return r.rows.map(requestRow);
  }

  /** The admin reports the multisig's tx id; the chain decides whether the request is confirmed. */
  async markSent(id: string, txId: string, admin: Session): Promise<AdminTxRequest> {
    const req = await this.getRequest(id);
    if (req.state === 'confirmed' && req.txId !== txId) throw AppError.conflict(`request already confirmed with tx ${req.txId}`);
    if (req.state === 'proposed') await this.ctx.pool.query("update admin_tx_requests set state = 'sent', tx_id = $2, sent_at = now() where request_id = $1", [id, txId]);
    else if (req.txId !== txId) await this.ctx.pool.query('update admin_tx_requests set tx_id = $2 where request_id = $1', [id, txId]);
    const confirmed = req.state === 'confirmed' || (await this.effectVisible(req));
    if (confirmed && req.state !== 'confirmed') await this.ctx.pool.query("update admin_tx_requests set state = 'confirmed', confirmed_at = now() where request_id = $1", [id]);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'tx-request.sent', target: id, detail: { kind: req.kind, chain: req.chain, txId, confirmed } });
    return this.getRequest(id);
  }

  /** Does the chain already show the command's effect? Read-only; never trusts the caller. */
  private async effectVisible(req: AdminTxRequest): Promise<boolean> {
    const port = this.port(req.chain);
    const cmd = req.command;
    switch (cmd.kind) {
      case 'registerAttestor': {
        const listed = (await port.listAttestors()).includes(cmd.attestor);
        return listed === cmd.active;
      }
      case 'registerVerifierKey': {
        const key = (await port.listVerifierKeys()).find((k) => k.keyId === cmd.keyId);
        return cmd.active ? !!key && key.publicKey.toLowerCase() === cmd.publicKey.toLowerCase() : !key;
      }
      case 'pauseNewRaises':
        return (await port.info()).newRaisesPaused === cmd.paused;
      case 'setFeeCollector':
        return (await port.info()).feeCollector === cmd.feeCollector;
      case 'registerSplitRouter':
        return false; // no read-side view of routers; stays `sent` until the indexer or an operator confirms
    }
  }

  // ---------------------------------------------------------------- read views
  async verifierKeys(chain?: string): Promise<{ chain: string; keys: { keyId: string; publicKey: string }[] }[]> {
    const ports = chain ? [this.port(chain)] : [...this.ctx.chains.chains.values()];
    return Promise.all(ports.map(async (p) => ({ chain: p.chain, keys: await p.listVerifierKeys() })));
  }

  async eligibility(chain?: string): Promise<Record<string, unknown>[]> {
    if (chain) this.port(chain);
    const r = await this.ctx.pool.query(
      `select e.chain, e.wallet, e.account_id, e.kind, e.approved_at, e.revoked_at, e.allowlist_synced_at, e.allowlist_tx, a.allowed as indexed_allowed
       from eligibility e left join allowlist a on a.chain = e.chain and a.wallet = e.wallet
       where ($1::text is null or e.chain = $1) order by e.approved_at desc, e.wallet`,
      [chain ?? null],
    );
    return r.rows.map((x) => {
      const expected = x.revoked_at === null;
      const indexed: boolean | null = x.indexed_allowed ?? null;
      const syncState = x.allowlist_synced_at === null ? 'pending' : indexed === null ? 'unindexed' : indexed === expected ? 'synced' : 'diverged';
      return { chain: x.chain, wallet: x.wallet, accountId: x.account_id, kind: x.kind, approvedAt: x.approved_at, revokedAt: x.revoked_at, expectedAllowed: expected, allowlistSyncedAt: x.allowlist_synced_at, allowlistTx: x.allowlist_tx, indexedAllowed: indexed, syncState };
    });
  }

  async keeperRuns(q: z.infer<typeof keeperRunsQuerySchema>): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query('select id, job, chain, started_at, finished_at, ok, actions, detail from keeper_runs where ($1::text is null or job = $1) order by started_at desc, id desc limit $2', [q.job ?? null, q.limit]);
    return r.rows.map(keeperRun);
  }

  // ---------------------------------------------------------------- tier-4 audit sampling (scaffolding)
  /** Picks accepted/paid tier-4 reports at random for a documents review. Off (returns 0) until the tier4 flag is on. */
  async drawAuditSamples(count: number, admin: Session): Promise<{ sampled: number; samples: Record<string, unknown>[]; note?: string }> {
    const on = await getFlag(this.ctx.pool, 'tier4');
    if (!on) {
      await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'audit-samples.draw', detail: { requested: count, sampled: 0, flagOn: false } });
      return { sampled: 0, samples: [], note: 'tier4 flag is off: tier-4 self-attestation is not live, so there is nothing to sample' };
    }
    const picked = await this.ctx.pool.query<{ report_id: string }>(
      "select report_id from reports r where tier = 4 and state in ('accepted','paid') and not exists (select 1 from audit_samples s where s.report_id = r.report_id) order by random() limit $1",
      [count],
    );
    const ids: string[] = [];
    for (const p of picked.rows) {
      const id = this.ctx.newId('sample');
      await this.ctx.pool.query('insert into audit_samples (sample_id, report_id, sampled_by) values ($1,$2,$3)', [id, p.report_id, admin.accountId]);
      ids.push(id);
    }
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'audit-samples.draw', detail: { requested: count, sampled: ids.length, flagOn: true, sampleIds: ids } });
    const samples = ids.length ? await this.listAuditSamples({ limit: ids.length }, ids) : [];
    return { sampled: ids.length, samples };
  }

  async listAuditSamples(q: z.infer<typeof auditSamplesQuerySchema>, ids?: string[]): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query(
      `select s.sample_id, s.report_id, s.sampled_at, s.sampled_by, s.outcome, r.series_id, r.period_id, r.tier, r.state
       from audit_samples s left join reports r on r.report_id = s.report_id
       where ($1::text is null or s.outcome = $1) and ($2::text[] is null or s.sample_id = any($2)) order by s.sampled_at desc limit $3`,
      [q.outcome ?? null, ids ?? null, q.limit],
    );
    return r.rows.map((x) => ({ sampleId: x.sample_id, reportId: x.report_id, seriesId: x.series_id, periodId: x.period_id, tier: x.tier, reportState: x.state, sampledAt: x.sampled_at, sampledBy: x.sampled_by, outcome: x.outcome }));
  }
}

function requestRow(x: RequestRow): AdminTxRequest {
  return { requestId: x.request_id, kind: x.kind, chain: x.chain, command: x.command, state: x.state, txId: x.tx_id, createdBy: x.created_by, meta: x.meta ?? {}, createdAt: x.created_at, sentAt: x.sent_at, confirmedAt: x.confirmed_at };
}

function keeperRun(x: Record<string, unknown>): Record<string, unknown> {
  return { id: Number(x.id), job: x.job, chain: x.chain, startedAt: x.started_at, finishedAt: x.finished_at, ok: x.ok, actions: x.actions, detail: x.detail };
}
