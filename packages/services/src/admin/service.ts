import { addressFamily, normaliseAddress } from '@merces/domain';
import { z } from 'zod';
import { attestorOpenWork } from '../attestor/recovery.ts';
import { simulatorOnly } from '@merces/ports';
import { isPublishedTestKey } from '@merces/domain';
import { AppError, audit, getFlag, listFlags, setFlag } from '@merces/core';
import { keyGraceUntil, type AdminCommand, type ChainPort, type SignerKeyState, type UnsignedTx } from '@merces/domain';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { IdentityService } from '../identity/service.ts';
import { fxPairId } from '@merces/math';

/**
 * E13 — admin API with an append-only audit log.
 * Admins have no path to user funds or raw income: every chain action is an UnsignedTx built for the protocol
 * multisig (`info().admin`) and tracked in admin_tx_requests until the chain itself shows the effect. Offchain
 * actions (feature flags, role grants, audit sampling) are audited with the admin's account id. Nothing here
 * reads a figure, a document or a reason; the overview is counts, statuses and cursors.
 */

export const FLAG_NAMES = ['tier4', 'transfer_windows', 'early_draws', 'secondary_trading', 'private_payouts'] as const;
export type FlagName = (typeof FLAG_NAMES)[number];
export const protocolFlagsSchema = z.object({ chain: z.string().min(1), windowsEnabled: z.boolean().optional(), newRaisesPaused: z.boolean().optional() }).strict().refine((x) => x.windowsEnabled !== undefined || x.newRaisesPaused !== undefined, 'at least one flag is required');
export const fxPairSchema = z.object({ chain: z.string().min(1), feedId: z.string().regex(/^0x[0-9a-f]{64}$/), inverted: z.boolean(), crosscheck: z.string().min(1).max(64).nullable().default(null) }).strict();
/** R: private payouts are "coming soon" (E15) — the flag exists but can never be switched on from the API. */
export const LOCKED_FLAGS: ReadonlySet<FlagName> = new Set<FlagName>(['private_payouts']);

/** A secp256k1 key's 20-byte address (S4 D4, D10), any case; the canonical form is lowercase. */
const keyAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase());
/**
 * Propose an attestor key for registration (S4 WP7): the key's 20-byte address, linked by its own EIP-191 proof to
 * the account that will act with it (`accountId`, or the account it is linked to when omitted).
 */
export const registerAttestorSchema = z.object({
  chain: z.string().min(1),
  attestor: keyAddressSchema,
  accountId: z.string().min(1).max(128).optional(),
  /** ISO 3166-1 alpha-2 */
  jurisdiction: z.string().length(2).optional(),
  kind: z.enum(['CA', 'CPA']).optional(),
}).strict();
export const revokeAttestorSchema = z.object({ chain: z.string().min(1), attestor: keyAddressSchema }).strict();
export const rotateAttestorSchema = z.object({ chain: z.string().min(1), from: keyAddressSchema, to: keyAddressSchema }).strict();
/** A report verifier key: a secp256k1 key's 20-byte address (S4 WP6, D10), any case; the canonical form is lowercase. */
const verifierAddressSchema = keyAddressSchema;
export const registerVerifierKeySchema = z.object({ chain: z.string().min(1), address: verifierAddressSchema }).strict();
export const revokeVerifierKeySchema = registerVerifierKeySchema;
export const rotateVerifierKeySchema = z.object({ chain: z.string().min(1), from: verifierAddressSchema, to: verifierAddressSchema }).strict();
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

  private refusePublishedKey(address: string): void {
    if (!simulatorOnly(this.ctx.chains) && isPublishedTestKey(address)) throw AppError.unprocessable('published test keys are refused while any chain is live', { reason: 'published-test-key' });
  }

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
  async setProtocolFlags(input: z.infer<typeof protocolFlagsSchema>, admin: Session): Promise<{request: AdminTxRequest; tx: UnsignedTx}> {
    const { chain, ...flags } = input;
    const r = await this.propose(chain, { kind: 'setFlags', ...flags }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'protocol.flags', target: chain, detail: { requestId: r.request.requestId, ...flags } });
    return r;
  }
  async setFxPair(input: z.infer<typeof fxPairSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const info = await this.port(input.chain).info();
    if (input.crosscheck) {
      input = { ...input, crosscheck: normaliseAddress(input.crosscheck, info.family) };
      if (addressFamily(input.crosscheck!) !== info.family) throw AppError.unprocessable('crosscheck must be a feed address on this chain');
    }
    const pairId = '0x' + Buffer.from(fxPairId(input.feedId, input.inverted)).toString('hex');
    if (await this.port(input.chain).getRateAccumulator(pairId)) throw AppError.conflict('this feed/inversion pair is already registered', { stage1: 'FxPairExists' });
    const r = await this.propose(input.chain, { kind: 'setFxPair', feedId: input.feedId, inverted: input.inverted, crosscheck: input.crosscheck }, admin, { pairId });
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'fx-pair.register', target: `${input.chain}:${pairId}`, detail: { requestId: r.request.requestId } });
    return r;
  }
  /** Build an admin command for the multisig and record the request. The backend never signs it. */
  private async propose(chain: string, command: AdminCommand, admin: Session, meta: Record<string, unknown> = {}): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const port = this.port(chain);
    const info = await port.info();
    const tx = await port.build(command, info.admin);
    const id = this.ctx.newId('adminreq');
    await this.ctx.pool.query('insert into admin_tx_requests (request_id, kind, chain, command, created_by, meta) values ($1,$2,$3,$4,$5,$6)', [id, command.kind, chain, JSON.stringify(command), admin.accountId, JSON.stringify(meta)]);
    return { request: await this.getRequest(id), tx };
  }

  /** The account attestor key `address` is linked to (its own EIP-191 proof, S4 WP7), or null. */
  private async linkedAccount(address: string): Promise<string | null> {
    const r = await this.ctx.pool.query<{ account_id: string }>('select account_id from account_signer_keys where address = $1', [address]);
    return r.rows[0]?.account_id ?? null;
  }

  /**
   * The owner's decision (A-SIG-7): "Extinguishment: two separately verified accounts, enforced at registration". A key
   * is registered for an account (`registerAttestor`), or rotated to (`rotateAttestor`), only when (1) the account's
   * attestor identity check has passed (409 `identity-not-verified`: the account completes `POST
   * /me/attestor/identity-check` first) and (2) no other key linked to the account, apart from `except` (the key
   * itself, and the key a rotation replaces), is active on the chain (read live) or proposed for it (a registration
   * proposal whose multisig request is not confirmed yet): 409 `account-already-attestor`. One verified account holds
   * one attestor key per chain, so the two keys Stage 1's extinguish takes are two separately verified accounts; the
   * extinguish-time same-account check (S4 D15) stays as defence in depth. Neither refusal names a key or an account.
   */
  private async requireVerifiedAttestorAccount(port: ChainPort, chain: string, accountId: string, except: string[]): Promise<void> {
    if (!(await new IdentityService(this.ctx).attestorIdentityPassed(accountId))) {
      throw AppError.conflict("the key's account has not passed the attestor identity check: the attestor completes it first (POST /me/attestor/identity-check)", { reason: 'identity-not-verified' });
    }
    const others = (await this.ctx.pool.query<{ address: string }>('select address from account_signer_keys where account_id = $1 and not (address = any($2::text[]))', [accountId, except])).rows.map((r) => r.address);
    if (!others.length) return;
    const active = new Set((await port.listSignerKeys('attestor')).filter((k) => k.active).map((k) => k.address));
    const proposed = await this.ctx.pool.query(
      "select 1 from attestor_proposals p left join admin_tx_requests r on r.request_id = p.request_id where p.chain = $1 and p.active and p.address = any($2::text[]) and coalesce(r.state, 'proposed') <> 'confirmed' limit 1",
      [chain, others],
    );
    if (others.some((a) => active.has(a)) || proposed.rowCount) {
      throw AppError.conflict('another attestor key linked to this account is active or proposed on this chain: one attestor key per verified account and chain (rotate the key instead)', { reason: 'account-already-attestor' });
    }
  }

  /** Record what was proposed for a key (A-M5-2: a proposal grants nothing; access follows the indexed registry). */
  private async recordProposal(chain: string, address: string, accountId: string | null, active: boolean, requestId: string, admin: Session): Promise<void> {
    await this.ctx.pool.query(
      'insert into attestor_proposals (chain, address, account_id, active, request_id, proposed_by) values ($1,$2,$3,$4,$5,$6) on conflict (chain, address) do update set account_id = coalesce(excluded.account_id, attestor_proposals.account_id), active = excluded.active, request_id = excluded.request_id, proposed_by = excluded.proposed_by, proposed_at = now()',
      [chain, address, accountId, active, requestId, admin.accountId],
    );
  }

  /**
   * Propose attestor key `attestor` (a secp256k1 key's 20-byte address on every chain, S4 D4) for Stage 1's
   * `registerAttestor`, built for the multisig. The key must be linked, by its own EIP-191 proof, to the account that
   * will act with it (`accountId`; when omitted, the account it is linked to): otherwise the registry would give
   * attestor access to whoever links the key later (422). The registry's rules are checked against the chain first, one
   * 409 per case on every chain (S4 D9): a key already active (`detail.reason: key-already-active`; the EVM reverts
   * KeyAlreadyActive, Solana would re-emit). The chain itself is read (`getSignerKey`), not the read model, so a
   * registration the indexer has not caught up with still counts. Then the owner's rule (A-SIG-7,
   * `requireVerifiedAttestorAccount`): the account has passed the attestor identity check (409 `identity-not-verified`)
   * and holds no other attestor key active or proposed on this chain (409 `account-already-attestor`).
   */
  async registerAttestor(input: z.infer<typeof registerAttestorSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    this.refusePublishedKey(input.attestor);
    const port = this.port(input.chain);
    if (input.accountId) {
      const acc = await this.ctx.pool.query('select 1 from accounts where account_id = $1', [input.accountId]);
      if (!acc.rowCount) throw AppError.notFound('account');
    }
    const holder = await this.linkedAccount(input.attestor);
    if (!holder) throw AppError.unprocessable('the key is not linked to any account: the attestor links it first (POST /me/signer-keys, an EIP-191 proof made with the key)', { reason: 'key-not-linked' });
    if (input.accountId && holder !== input.accountId) throw AppError.unprocessable('the key is linked to another account than the one proposed', { reason: 'key-not-linked' });
    if ((await port.getSignerKey('attestor', input.attestor))?.active) throw AppError.conflict('the attestor key is already active on this chain', { reason: 'key-already-active' });
    await this.requireVerifiedAttestorAccount(port, input.chain, holder, [input.attestor]);
    const meta = { accountId: holder, jurisdiction: input.jurisdiction ?? null, kind: input.kind ?? null };
    const r = await this.propose(input.chain, { kind: 'registerAttestor', attestor: input.attestor }, admin, meta);
    // A proposal grants nothing (A-M5-2): attestor access starts when the multisig's registerAttestor is onchain and
    // indexed, for the account the key is linked to then. Until then the account sees no hardship cases or documents.
    await this.recordProposal(input.chain, input.attestor, holder, true, r.request.requestId, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'attestor.register', target: `${input.chain}:${input.attestor}`, detail: { requestId: r.request.requestId, ...meta } });
    return r;
  }

  /**
   * Stage 1's `revokeAttestor` (forward-only, S4 WP5) for the multisig, with the chain's pre-checks, one 409 per case
   * on every chain: a key that is not active (`key-not-active`), the last active key (`last-active-key`: rotate to a new
   * key instead; Solana LastKeyOfKind, EVM LastActiveKey). A revocation grants nothing, so it needs no link: an admin can
   * always end a key's access. Report and FX signatures of periods ended by then stay valid on the chain for 45 days;
   * offchain access ends once the revocation is indexed.
   */
  async revokeAttestor(input: z.infer<typeof revokeAttestorSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const port = this.port(input.chain);
    if (!(await port.getSignerKey('attestor', input.attestor))?.active) throw AppError.conflict('the attestor key is not active on this chain: there is nothing to revoke', { reason: 'key-not-active' });
    if ((await port.listSignerKeys('attestor')).filter((k) => k.active).length <= 1) throw AppError.conflict('the last active attestor key of a chain cannot be revoked: rotate it to a new key instead', { reason: 'last-active-key' });
    const r = await this.propose(input.chain, { kind: 'revokeAttestor', attestor: input.attestor }, admin, { openWork: await attestorOpenWork(this.ctx, input.chain, input.attestor) });
    await this.recordProposal(input.chain, input.attestor, await this.linkedAccount(input.attestor), false, r.request.requestId, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'attestor.revoke', target: `${input.chain}:${input.attestor}`, detail: { requestId: r.request.requestId } });
    return r;
  }

  /**
   * `rotateAttestor{from, to}`: register `to` and revoke `from` in one transaction (EVM; two instructions on Solana,
   * S5), for the multisig. The new key replaces the old one for the same attestor: `to` must be linked to the account
   * `from` is linked to (422 otherwise). Pre-checks against the chain: the same key (422), `to` already active
   * (`key-already-active`), `from` not active (`key-not-active`); after it `to` is active, so it never revokes the last
   * key. PAUSE, AMEND, EXTINGUISH and TRUEUP signatures collected from `from` are dead once it lands and are signed
   * again with `to`; report and FX signatures of ended periods stay valid within the grace. The account must have
   * passed the attestor identity check and hold no third key active or proposed on the chain (A-SIG-7; the key being
   * replaced is expected to be active).
   */
  async rotateAttestor(input: z.infer<typeof rotateAttestorSchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    this.refusePublishedKey(input.to);
    if (input.from === input.to) throw AppError.unprocessable('a rotation replaces one key with another: from and to are the same key');
    const port = this.port(input.chain);
    const holder = await this.linkedAccount(input.from);
    if (!holder || (await this.linkedAccount(input.to)) !== holder) throw AppError.unprocessable('the new key must be linked to the account the key it replaces is linked to', { reason: 'key-not-linked' });
    const [from, to] = await Promise.all([port.getSignerKey('attestor', input.from), port.getSignerKey('attestor', input.to)]);
    if (to?.active) throw AppError.conflict('the new attestor key is already active on this chain', { reason: 'key-already-active' });
    if (!from?.active) throw AppError.conflict('the attestor key to replace is not active on this chain', { reason: 'key-not-active' });
    await this.requireVerifiedAttestorAccount(port, input.chain, holder, [input.from, input.to]);
    const r = await this.propose(input.chain, { kind: 'rotateAttestor', from: input.from, to: input.to }, admin, { accountId: holder, openWork: await attestorOpenWork(this.ctx, input.chain, input.from) });
    await this.recordProposal(input.chain, input.to, holder, true, r.request.requestId, admin);
    await this.recordProposal(input.chain, input.from, holder, false, r.request.requestId, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'attestor.rotate', target: `${input.chain}:${input.from}`, detail: { requestId: r.request.requestId, to: input.to, accountId: holder } });
    return r;
  }

  /**
   * Attestor proposals and the indexed onchain registry side by side, by key. status: 'registered' (active onchain),
   * 'pending-onchain' (proposed active, not yet indexed as active), 'deactivation-pending' (proposed inactive, still
   * active onchain) or 'inactive'. `accountId` is the account the key is linked to now (the one that gets access), and
   * `proposedAccountId` the one it was linked to when proposed. Only an indexed active registration gives access.
   * `identityStatus` is that account's attestor identity check as stored (A-SIG-7; `not_started` without one, null when
   * no account holds the key): a status, never the provider's data.
   */
  async listAttestors(): Promise<Record<string, unknown>[]> {
    const r = await this.ctx.pool.query(
      `select x.chain, x.address, k.account_id, x.proposed_account_id, x.proposed_active, x.request_id, x.proposed_by, x.proposed_at, x.onchain_active,
              x.registered_at, x.revoked_at, ic.status as identity_status
         from (select coalesce(p.chain, a.chain) as chain, coalesce(p.address, a.attestor) as address, p.account_id as proposed_account_id, p.active as proposed_active,
                      p.request_id, p.proposed_by, p.proposed_at, a.active as onchain_active, a.registered_at, a.revoked_at
                 from attestor_proposals p full outer join attestors a on a.chain = p.chain and a.attestor = p.address) x
         left join account_signer_keys k on k.address = x.address
         left join attestor_identity_checks ic on ic.account_id = k.account_id
        order by 1, 2`,
    );
    return r.rows.map((x) => {
      const onchain = x.onchain_active === true;
      const status = onchain ? (x.proposed_active === false ? 'deactivation-pending' : 'registered') : x.proposed_active === true ? 'pending-onchain' : 'inactive';
      // indexed registry times (unix seconds; S4 WP5): when the key last became active, and its forward-only revocation,
      // after which report and FX signatures of ended periods stay valid on the chain until graceUntil
      const registeredAt = x.registered_at === null || x.registered_at === undefined ? null : Number(x.registered_at);
      const revokedAt = x.revoked_at === null || x.revoked_at === undefined ? null : Number(x.revoked_at);
      return {
        chain: x.chain, attestor: x.address, accountId: x.account_id ?? null, identityStatus: x.account_id ? (x.identity_status ?? 'not_started') : null, status, onchainActive: onchain, registeredAt, revokedAt, graceUntil: keyGraceUntil(revokedAt),
        proposal: x.proposed_by ? { active: x.proposed_active, accountId: x.proposed_account_id ?? null, requestId: x.request_id, proposedBy: x.proposed_by, proposedAt: x.proposed_at } : null,
      };
    });
  }

  /**
   * The report verifier's keys (S4 WP6, D10): Stage 1's `registerVerifierKey`, `revokeVerifierKey` and
   * `rotateVerifierKey` of a secp256k1 key's 20-byte address, built for the multisig, with the attestor keys' pre-checks
   * against the chain's registry, one 409 per case on every chain (S4 D9): registering an active key
   * (`key-already-active`), revoking a key that is not active (`key-not-active`), revoking the last active verifier key
   * (`last-active-key`: rotate instead). A rotation needs `to` not active and `from` active (after it `to` is active, so
   * it never revokes the last key). A verifier key grants no account anything, so no account link is involved. The
   * registered address must be the report verifier's own (`REPORT_VERIFIER_ADDRESS`, which it checks at startup).
   */
  async registerVerifierKey(input: z.infer<typeof registerVerifierKeySchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    this.refusePublishedKey(input.address);
    const port = this.port(input.chain);
    if ((await port.getSignerKey('verifier', input.address))?.active) throw AppError.conflict('the verifier key is already active on this chain', { reason: 'key-already-active' });
    const r = await this.propose(input.chain, { kind: 'registerVerifierKey', key: input.address }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'verifier-key.register', target: `${input.chain}:${input.address}`, detail: { requestId: r.request.requestId } });
    return r;
  }

  /** `revokeVerifierKey` (forward-only, SPEC §1.4): tier-2 attestations of periods ended by then stay valid for 45 days. */
  async revokeVerifierKey(input: z.infer<typeof revokeVerifierKeySchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    const port = this.port(input.chain);
    if (!(await port.getSignerKey('verifier', input.address))?.active) throw AppError.conflict('the verifier key is not active on this chain: there is nothing to revoke', { reason: 'key-not-active' });
    if ((await port.listSignerKeys('verifier')).filter((k) => k.active).length <= 1) throw AppError.conflict('the last active verifier key of a chain cannot be revoked: rotate it to a new key instead', { reason: 'last-active-key' });
    const r = await this.propose(input.chain, { kind: 'revokeVerifierKey', key: input.address }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'verifier-key.revoke', target: `${input.chain}:${input.address}`, detail: { requestId: r.request.requestId } });
    return r;
  }

  /** `rotateVerifierKey{from, to}`: register `to` and revoke `from` in one transaction (EVM; two instructions on Solana, S5). */
  async rotateVerifierKey(input: z.infer<typeof rotateVerifierKeySchema>, admin: Session): Promise<{ request: AdminTxRequest; tx: UnsignedTx }> {
    this.refusePublishedKey(input.to);
    if (input.from === input.to) throw AppError.unprocessable('a rotation replaces one key with another: from and to are the same key');
    const port = this.port(input.chain);
    const [from, to] = await Promise.all([port.getSignerKey('verifier', input.from), port.getSignerKey('verifier', input.to)]);
    if (to?.active) throw AppError.conflict('the new verifier key is already active on this chain', { reason: 'key-already-active' });
    if (!from?.active) throw AppError.conflict('the verifier key to replace is not active on this chain', { reason: 'key-not-active' });
    const r = await this.propose(input.chain, { kind: 'rotateVerifierKey', from: input.from, to: input.to }, admin);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'verifier-key.rotate', target: `${input.chain}:${input.from}`, detail: { requestId: r.request.requestId, to: input.to } });
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
      case 'setFlags': {
        const info = await port.info();
        return (cmd.newRaisesPaused === undefined || info.newRaisesPaused === cmd.newRaisesPaused) && (cmd.windowsEnabled === undefined || info.windowsEnabled === cmd.windowsEnabled) && (cmd.tier4Enabled === undefined || info.tier4Enabled === cmd.tier4Enabled);
      }
      case 'setFxPair':
        return !!(await port.getRateAccumulator('0x' + Buffer.from(fxPairId(cmd.feedId, cmd.inverted)).toString('hex')));
      // the registry as the chain holds it (S4 WP5): a registration shows as an active key, a revocation as a revoked one
      // with its revocation time, a rotation as both
      case 'registerIssuer':
        return !!(await port.getIssuer(cmd.wallet));
      case 'registerAttestor':
        return (await port.getSignerKey('attestor', cmd.attestor))?.active === true;
      case 'revokeAttestor': {
        const k = await port.getSignerKey('attestor', cmd.attestor);
        return !!k && !k.active && k.revokedAt !== null;
      }
      case 'rotateAttestor': {
        const [from, to] = await Promise.all([port.getSignerKey('attestor', cmd.from), port.getSignerKey('attestor', cmd.to)]);
        return to?.active === true && !!from && !from.active && from.revokedAt !== null;
      }
      // the report verifier's keys likewise (S4 WP6)
      case 'registerVerifierKey':
        return (await port.getSignerKey('verifier', cmd.key))?.active === true;
      case 'revokeVerifierKey': {
        const k = await port.getSignerKey('verifier', cmd.key);
        return !!k && !k.active && k.revokedAt !== null;
      }
      case 'rotateVerifierKey': {
        const [from, to] = await Promise.all([port.getSignerKey('verifier', cmd.from), port.getSignerKey('verifier', cmd.to)]);
        return to?.active === true && !!from && !from.active && from.revokedAt !== null;
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
  /**
   * The report verifier's keys as each chain's registry holds them (S4 WP6: Stage 1's key records, active and revoked,
   * with `revokedAt` and `graceUntil`), and the address the report verifier signs with, so an operator sees at once
   * whether the verifier's key is the one registered.
   */
  async verifierKeys(chain?: string): Promise<{ verifier: { address: string | null }; chains: { chain: string; keys: SignerKeyState[] }[] }> {
    const ports = chain ? [this.port(chain)] : [...this.ctx.chains.chains.values()];
    const address = await this.ctx.verifier.publicKey().then((k) => k.address, () => null);
    return { verifier: { address }, chains: await Promise.all(ports.map(async (p) => ({ chain: p.chain, keys: await p.listSignerKeys('verifier') }))) };
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
