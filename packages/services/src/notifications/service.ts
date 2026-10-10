import { z } from 'zod';
import { AppError, audit, type OutboxHandler } from '@merces/core';
import type { Queryable } from '@merces/db';
import { hashCanonical, lifecycleStatusSchema } from '@merces/domain';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';

/**
 * E12 — notifications (statuses, never reasons).
 * Everything that leaves the system arrives here as an outbox row with topic 'notification'. The handler resolves
 * the recipients (an account, the issuer of a series, its holders and bidders, the owner of a wallet, every admin
 * or attestor), writes one inbox row per recipient and sends an email through the channel when the account has an
 * address and email is enabled. Templates interpolate statuses, dates, series ids and period ids only: never a
 * reason, never an income figure, never an amount. Delivery is idempotent per outbox payload and account.
 */

export interface NotificationMessage {
  to: string;
  subject: string;
  body: string;
}

/** A delivery channel. Email first (Part J.6); other channels implement the same port. */
export interface NotificationChannel {
  readonly name: string;
  send(message: NotificationMessage): Promise<void>;
}

/** The mock email channel writes to email_outbox: what a real provider would have been handed, visible to admins in dev. */
export class MockEmailChannel implements NotificationChannel {
  readonly name = 'mock-email';
  constructor(
    private readonly db: Queryable,
    private readonly newId: (prefix: string) => string,
  ) {}
  async send(m: NotificationMessage): Promise<void> {
    await this.db.query('insert into email_outbox (email_id, to_address, subject, body) values ($1,$2,$3,$4)', [this.newId('eml'), m.to, m.subject, m.body]);
  }
}

export const preferencesSchema = z.object({
  email: z.boolean(),
  mutedKinds: z.array(z.string().min(1).max(64)).max(200),
  /** stored on accounts.email; null clears it; omitted leaves it unchanged */
  emailAddress: z.email().max(320).nullable().optional(),
});

/**
 * The only payload keys that may reach an inbox row or a template. Statuses, dates, ids and codes that name a
 * mechanism step. Explicitly absent: reason, amounts, deviations, anything free-text.
 */
const SAFE_KEYS = [
  'accountId', 'applicationId', 'seriesId', 'periodId', 'chain', 'pair', 'year', 'wallet', 'attestor',
  'dueAt', 'graceEndsAt', 'revealEndsAt', 'until', 'trueUpDueAt', 'outcome', 'from', 'to', 'status', 'outstanding', 'windowId',
  'caseId', 'hardshipId', 'annualId', 'amendmentId', 'draftId',
  // S3 WP11: a curve series' notices name its raise style, and a curve reminder the wallet's next step (fixed codes)
  'raiseStyle', 'next',
] as const;
type SafeKey = (typeof SAFE_KEYS)[number];
export type SafeData = Partial<Record<SafeKey, string | number>>;

function pickSafe(src: unknown): SafeData {
  const out: SafeData = {};
  if (!src || typeof src !== 'object') return out;
  const o = src as Record<string, unknown>;
  for (const k of SAFE_KEYS) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Statuses, dates, ids: the chain-event payload nested by the keepers (series.*) is flattened under the same whitelist. */
export function safeData(payload: Record<string, unknown>): SafeData {
  return { ...pickSafe(payload.payload), ...pickSafe(payload) };
}

/** unix seconds → YYYY-MM-DD (UTC); anything else → 'soon' so a template never prints a raw number it does not understand */
export function fmtDate(v: string | number | undefined): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === undefined || !Number.isFinite(n)) return 'soon';
  return new Date(n * 1000).toISOString().slice(0, 10);
}

type Template = (d: SafeData) => { subject: string; body: string };
const series = (d: SafeData) => `series ${d.seriesId ?? '?'}`;
const period = (d: SafeData) => (d.periodId ? `, period ${d.periodId}` : '');
/** what a reporting reminder says is outstanding: the payment of a reported period, else the report */
const owed = (d: SafeData, title = false) => (d.outstanding === 'payment' ? (title ? 'Payment' : 'payment') : title ? 'Report' : 'report');
/** the series' status as the chain derived it when the notice was queued; nothing when the payload carries none (or no lifecycle status) */
const status = (d: SafeData) => (typeof d.status === 'string' && lifecycleStatusSchema.safeParse(d.status).success ? ` Status: ${d.status}.` : '');
/**
 * What a holder sends once a series reaches a status that opens a claim of Stage 1's family (S3): on Redeemed the
 * redemption (`claimRedemption`, or `claimTail`, which redeems first) and each tail payment (`claimTail`); on
 * Extinguished the final claim (`claimFinal`: the payout still owed and the final-pool share, and the units burn). A curve
 * series (S3 WP10, `raiseStyle: 'curve'`) is redeemed by tender (`tenderUnits`: staked units are reserved for their
 * holders, units in wallets share a quota), pays the tail on tendered units (`claimTail`) and burns nothing; its returned
 * treasury is shared by staked units, or by tendered units once it redeemed (`claimFinal`). The commands only, never an
 * amount: each holder's figures are in the app.
 */
const claimsFor = (d: SafeData) => {
  const curve = d.raiseStyle === 'curve';
  if (d.to === 'Redeemed') {
    return curve
      ? ' Holders tender their units with tenderUnits: staked units are reserved for their holders, units in wallets share a quota until it runs out, and only a registered holder can tender. Each tail payment on tendered units is claimed with claimTail.'
      : ' Holders claim their redemption with claimRedemption (or claimTail, which redeems first) and each tail payment with claimTail.';
  }
  if (d.to === 'Extinguished') {
    return curve
      ? ' Staked units (tendered units, if the series redeemed) share the returned treasury: holders claim it with claimFinal. Units in wallets share nothing, and no units burn.'
      : ' Holders claim the payout still owed and their share of the returned treasury with claimFinal; their units burn with it.';
  }
  return '';
};

/**
 * A curve wallet's next step in a keeper reminder (`next`, a fixed code; anything else renders as no step): its wallet
 * is not approved (allowlisted), it is approved and not a registered holder yet, or it is registered.
 */
const STAKE_STEP: Record<string, string> = {
  'approve-wallet': 'Staking needs an approved (allowlisted) wallet, and this one is not: until it is approved its units cannot be staked and earn nothing, and it can only sell them.',
  'register-and-stake': 'Register the wallet as a holder of the series, then stake its units: staked units earn from the next payment, and you can unstake at any time.',
  stake: 'Stake its units: staked units earn from the next payment, and you can unstake at any time.',
};
const TENDER_STEP: Record<string, string> = {
  'approve-wallet': 'Only a registered holder can tender, and registering needs an approved (allowlisted) wallet, which this one is not: until it is approved it can only sell its units.',
  'register-and-tender': 'Register the wallet as a holder of the series, then tender its units with tenderUnits.',
  tender: 'Tender its units with tenderUnits.',
};
const step = (steps: Record<string, string>, d: SafeData) => (typeof d.next === 'string' && Object.hasOwn(steps, d.next) ? ` ${steps[d.next]}` : '');
const wallet = (d: SafeData) => (typeof d.wallet === 'string' ? `Your wallet ${d.wallet}` : 'Your wallet');

export const TEMPLATES: Record<string, Template> = {
  'application.submitted': (d) => ({ subject: 'Application submitted', body: `Application ${d.applicationId} has been submitted and is waiting for review. Status: submitted.` }),
  'application.in_review': (d) => ({ subject: 'Application in review', body: `Application ${d.applicationId} is being reviewed. Status: in_review.` }),
  'application.approved': (d) => ({ subject: 'Application approved', body: `Application ${d.applicationId} has been approved. Status: approved. Your wallet is being added to the allowlist.` }),
  'application.rejected': (d) => ({ subject: 'Application decision', body: `Application ${d.applicationId} was not approved. Status: rejected.` }),
  'eligibility.revoked': (d) => ({ subject: 'Eligibility revoked', body: `Eligibility for a wallet on ${d.chain ?? 'the chain'} has been revoked. Status: revoked. Claims, redemption and window sells stay open.` }),
  'contract.signed': () => ({ subject: 'Contract signed', body: 'Your HEU contract and Autonomy Charter are signed. Status: signed. You can now build the createSeries transaction.' }),
  'payout.available': (d) => ({ subject: 'Payout available', body: `A payout for ${series(d)}${period(d)} is available to claim. Status: paid.` }),
  'auction.settled': (d) => ({ subject: 'Raise settled', body: `The raise for ${series(d)} has settled. Status: Settled.` }),
  // S2: the keepers push every deposit back (Stage 1 `deliver_bid`); nobody has to reclaim anything (S2 L6)
  'auction.failed': (d) => ({ subject: 'Raise did not settle', body: `The raise for ${series(d)} did not settle. Status: Failed. Deposits are returned automatically.` }),
  // Stage 1's multi-step settlement (S2). No template names an amount, a price, a round or a reason: the events behind
  // them are public onchain and readable in the app.
  'auction.settlement-rejected': (d) => ({ subject: 'Settlement proposal rejected', body: `A settlement proposal for the raise on ${series(d)} was rejected by the chain. The next proposal follows automatically. Status: Settling.` }),
  'auction.mint-finalized': (d) =>
    d.outcome === 'failed'
      ? { subject: 'Raise bids processed', body: `Every bid on ${series(d)} has been processed. Status: Failed. Deposits are returned automatically.` }
      : { subject: 'Raise minting final', body: `Every bid on ${series(d)} has been processed and the raise's units are minted. Reports, payments and treasury releases are now open. Status: Settled.` },
  'auction.settlement-stuck': (d) => ({ subject: 'Settlement needs attention', body: `The keepers cannot move the settlement of ${series(d)} on${typeof d.outcome === 'string' && /^[A-Za-z]+$/.test(d.outcome) ? ` (${d.outcome})` : ''}. Anyone may still send the next settlement step. Status: stuck.` }),
  'bid.delivered': (d) => ({ subject: 'Bid delivered', body: `Your bid on ${series(d)} has been delivered: any units it won and any refund are in your wallet. Status: delivered.` }),
  'bid.delivery-stuck': (d) => ({ subject: 'Bid delivery delayed', body: `The delivery of a bid on ${series(d)} has been failing for more than a day; the keepers keep retrying. The bidder can also send the delivery from the app. Units the bid won count for payouts in the meantime. Status: delivery-delayed.` }),
  'bid.reveal-reminder': (d) => ({ subject: 'Reveal your bid', body: `Reveal your bid on ${series(d)} before ${fmtDate(d.revealEndsAt)}.` }),
  // The reporting reminders follow Stage 1's inclusive bounds: `dueAt` is the last OnTime instant and `graceEndsAt` the
  // last InGrace one. The keeper reminds only the earliest unpaid period (the one Stage 1's `deriveStatus` counts from),
  // sending 'report-due' once its `dueAt` has passed and 'grace-end' once its `graceEndsAt` has passed. The status a
  // notice names is the series' status the chain derived when the keeper queued it (`status`), never one assumed from
  // the milestone: an overdue true-up makes a series Late before its grace period ends, and a keeper that runs late finds
  // it Late already. A payload without it (queued before the keeper sent it) names no status. `outstanding` says whether
  // the period's report or, once reported, its payment is still due; 'report-due-soon' names no status.
  'reporting.report-due-soon': (d) => ({ subject: `${owed(d, true)} due soon`, body: `The ${owed(d)} for ${series(d)}${period(d)} is due by ${fmtDate(d.dueAt)}.` }),
  'reporting.report-due': (d) => ({ subject: `${owed(d, true)} due`, body: `The ${owed(d)} for ${series(d)}${period(d)} was due by ${fmtDate(d.dueAt)} and the grace period has started. The grace period ends on ${fmtDate(d.graceEndsAt)}.${status(d)}` }),
  'reporting.grace-end': (d) => ({ subject: 'Grace period ended', body: `The grace period for ${series(d)}${period(d)} ended on ${fmtDate(d.graceEndsAt)}.${status(d)}` }),
  'series.StatusChanged': (d) => ({ subject: 'Series status changed', body: `${series(d)} changed from ${d.from ?? '?'} to ${d.to ?? '?'}.${claimsFor(d)}` }),
  'series.FormalNoticeDue': (d) => ({ subject: 'Formal notice due', body: `A formal notice is due for ${series(d)}${period(d)}. Status: Late.` }),
  'series.ReleasesPaused': (d) => ({ subject: 'Treasury releases paused', body: `Treasury releases for ${series(d)} are paused. Status: ReleasesPaused.` }),
  'series.ReleasesResumed': (d) => ({ subject: 'Treasury releases resumed', body: `Treasury releases for ${series(d)} have resumed. Status: ReleasesResumed.` }),
  'series.PauseEnded': (d) => ({ subject: 'Pause ended', body: `The approved pause on ${series(d)} has ended. Status: active.` }),
  // Curve mode (S3 WP11; amendment M8). The chain notices go to the series' holders (its stakers) and, for completion, its
  // issuer; the keepers' reminders go to the account of one linked wallet that holds units in its wallet (they earn
  // nothing unstaked), naming its next step. None names an amount, a price or a count.
  'curve.completed': (d) => ({
    subject: 'Curve filled: the raise is settled',
    body: `The curve for ${series(d)} has filled and the raise is settled. Only staked units earn: an approved wallet registers as a holder of the series and stakes its units, and units left in wallets earn nothing. Status: Settled.`,
  }),
  'curve.tender-open': (d) => ({
    subject: 'Redemption open: tender your units',
    body: `${series(d)} has redeemed. Tender your units with tenderUnits to be paid the redemption price: staked units are reserved for their holders, units in wallets share a quota until it runs out, and only a registered holder can tender. Status: Redeemed.`,
  }),
  'curve.stake-reminder': (d) => ({ subject: 'Stake your units to earn', body: `${wallet(d)} holds units of ${series(d)} that are not staked, so they earn nothing.${step(STAKE_STEP, d)}` }),
  'curve.tender-reminder': (d) => ({ subject: 'Tender your units', body: `${wallet(d)} holds units of ${series(d)}, which has redeemed. Units in wallets share a quota that can run out; staked units are reserved for their holders.${step(TENDER_STEP, d)}` }),
  'fx.fallback-needed': (d) => ({ subject: 'Attestor FX rate needed', body: `An attestor-signed fallback rate is needed for ${d.pair ?? '?'}${period(d)} on ${d.chain ?? '?'}. Status: fallback-needed.` }),
  'fx.deviation': (d) => ({ subject: 'FX cross-check deviation', body: `The ${d.pair ?? '?'} rate on ${d.chain ?? '?'} deviated from its cross-check. Status: flagged.` }),
  'indexing.due': (d) => ({ subject: 'Yearly indexing due', body: `Yearly threshold indexing for ${series(d)} (${d.year ?? '?'}) is due. Status: due.` }),
};

function render(kind: string, d: SafeData): { subject: string; body: string } {
  const t = TEMPLATES[kind];
  if (t) return t(d);
  const refs = [d.seriesId ? series(d) : null, d.periodId ? `period ${d.periodId}` : null, d.applicationId ? `application ${d.applicationId}` : null].filter(Boolean).join(', ');
  return { subject: `Update: ${kind}`, body: `There is a new update (${kind})${refs ? ` on ${refs}` : ''}. Open Merces for details.` };
}

/** A keeper's reminder about one wallet (curve mode): it reaches that wallet's account only, never the issuer or the holders. */
const walletReminder = (kind: string) => kind === 'curve.stake-reminder' || kind === 'curve.tender-reminder';
/**
 * holders and bidders of the series (a failed raise's notice reaches its bidders, whose deposits come back); a curve
 * series' notices (`curve.*`) reach its holders too (amendment M8: on a curve the position rows are its stakers), except
 * the reminders about one wallet
 */
const toHolders = (kind: string) => kind === 'payout.available' || kind === 'auction.settled' || kind === 'auction.failed' || kind.startsWith('series.') || (kind.startsWith('curve.') && !walletReminder(kind));
const toAdmins = (kind: string) =>
  kind.startsWith('fx.') || kind.startsWith('indexing.') || kind === 'application.submitted' || kind === 'auction.settlement-rejected' || kind === 'auction.settlement-stuck' || kind === 'bid.delivery-stuck';
const toAttestors = (kind: string) => kind === 'fx.fallback-needed';
/**
 * Whether a series notice also reaches the series' issuer (the default). Not: a notice about one bid (`bid.*`, which
 * goes to that bid's wallet, plus the admins for a stuck delivery), an operator alert (`auction.settlement-stuck`), a
 * curve's call to its holders to tender (`curve.tender-open`; the issuer's own redemption is told by the status change)
 * and a reminder about one wallet.
 */
const toIssuer = (kind: string) => !kind.startsWith('bid.') && kind !== 'auction.settlement-stuck' && kind !== 'curve.tender-open' && !walletReminder(kind);

export class NotificationsService {
  readonly channel: NotificationChannel;
  constructor(
    private readonly ctx: ServiceContext,
    channel?: NotificationChannel,
  ) {
    this.channel = channel ?? new MockEmailChannel(ctx.pool, ctx.newId);
  }

  // ---- delivery (outbox handler)

  /** Who gets an inbox row for this payload. Sorted and deduplicated. Throws when a referenced series is not indexed yet so the outbox retries. */
  async resolveRecipients(payload: Record<string, unknown>): Promise<string[]> {
    const kind = String(payload.kind ?? '');
    const out = new Set<string>();
    const add = (rows: { account_id: string }[]) => rows.forEach((r) => out.add(r.account_id));
    const seriesId = typeof payload.seriesId === 'string' ? payload.seriesId : null;
    let chain = typeof payload.chain === 'string' ? payload.chain : seriesId ? seriesId.split(':')[0] ?? null : null;

    if (typeof payload.accountId === 'string') add((await this.ctx.pool.query<{ account_id: string }>('select account_id from accounts where account_id = $1', [payload.accountId])).rows);
    if (seriesId) {
      const s = await this.ctx.pool.query<{ chain: string; issuer: string; account_id: string | null }>('select s.chain, s.issuer, w.account_id from series s left join account_wallets w on w.chain = s.chain and w.address = s.issuer where s.series_id = $1', [seriesId]);
      const row = s.rows[0];
      if (!row) throw new Error(`series ${seriesId} is not indexed yet`);
      chain = row.chain;
      if (row.account_id && toIssuer(kind)) out.add(row.account_id);
      if (toHolders(kind)) {
        add((await this.ctx.pool.query<{ account_id: string }>(
          `select distinct w.account_id from positions p join account_wallets w on w.chain = $2 and w.address = p.wallet
             where p.series_id = $1 and (p.units > 0 or p.claimed_total > 0 or p.redeemed_units > 0 or p.burned_units > 0)
           union
           select distinct w.account_id from bids b join account_wallets w on w.chain = $2 and w.address = b.bidder where b.series_id = $1`,
          [seriesId, chain],
        )).rows);
      }
    }
    if (typeof payload.wallet === 'string') add((await this.ctx.pool.query<{ account_id: string }>('select account_id from account_wallets where address = $1 and ($2::text is null or chain = $2)', [payload.wallet, chain])).rows);
    // a notice addressed to an attestor wallet reaches its account only while that wallet is an active, indexed
    // attestor (A-M5-2): a deactivated or not-yet-indexed wallet gets no inbox row or email
    if (typeof payload.attestor === 'string')
      add((await this.ctx.pool.query<{ account_id: string }>('select distinct w.account_id from attestors t join account_wallets w on w.chain = t.chain and w.address = t.attestor where t.active and t.attestor = $1 and ($2::text is null or t.chain = $2)', [payload.attestor, chain])).rows);
    if (toAdmins(kind)) add((await this.ctx.pool.query<{ account_id: string }>("select account_id from accounts where roles @> '{admin}'")).rows);
    // attestor work goes to accounts holding a wallet that is an active, indexed attestor on that chain (A-M5-2),
    // never to a stored role: a proposed or deactivated attestor gets no attestor notices
    if (toAttestors(kind))
      add((await this.ctx.pool.query<{ account_id: string }>('select distinct w.account_id from attestors t join account_wallets w on w.chain = t.chain and w.address = t.attestor where t.active and ($1::text is null or t.chain = $1)', [chain])).rows);
    return [...out].sort();
  }

  /** Deliver one outbox payload: an inbox row per recipient (deduped on payload hash) and an email where enabled. */
  async deliver(payload: Record<string, unknown>): Promise<{ kind: string; recipients: number; created: number; emailed: number; muted: number }> {
    const kind = String(payload.kind ?? 'unknown');
    const hash = hashCanonical('notification', payload);
    const data = safeData(payload);
    const { subject, body } = render(kind, data);
    const recipients = await this.resolveRecipients(payload);
    let created = 0;
    let emailed = 0;
    let muted = 0;
    if (recipients.length) {
      const prefs = new Map((await this.ctx.pool.query<{ account_id: string; email: boolean; muted_kinds: string[] }>('select account_id, email, muted_kinds from notification_preferences where account_id = any($1)', [recipients])).rows.map((r) => [r.account_id, r]));
      const emails = new Map((await this.ctx.pool.query<{ account_id: string; email: string | null }>('select account_id, email from accounts where account_id = any($1)', [recipients])).rows.map((r) => [r.account_id, r.email]));
      for (const accountId of recipients) {
        const p = prefs.get(accountId);
        if (p?.muted_kinds.includes(kind)) {
          muted++;
          continue;
        }
        const ins = await this.ctx.pool.query<{ notification_id: string }>(
          'insert into notifications (notification_id, account_id, kind, subject, body, data, payload_hash) values ($1,$2,$3,$4,$5,$6,$7) on conflict (payload_hash, account_id) do nothing returning notification_id',
          [this.ctx.newId('ntf'), accountId, kind, subject, body, JSON.stringify(data), hash],
        );
        if (ins.rowCount) created++;
        const wantEmail = (p?.email ?? true) && !!emails.get(accountId);
        if (!wantEmail) continue;
        // send once per (payload, account): a redelivery after a failed send retries the email; a redelivery after success does not
        const row = await this.ctx.pool.query<{ notification_id: string; email_sent_at: Date | null }>('select notification_id, email_sent_at from notifications where payload_hash = $1 and account_id = $2', [hash, accountId]);
        const n = row.rows[0];
        if (!n || n.email_sent_at) continue;
        await this.channel.send({ to: emails.get(accountId)!, subject, body });
        await this.ctx.pool.query('update notifications set email_sent_at = now() where notification_id = $1', [n.notification_id]);
        emailed++;
      }
    }
    // never log the payload: kind and counts only
    this.ctx.log.info({ kind, recipients: recipients.length, created, emailed, muted, channel: this.channel.name }, 'notification delivered');
    return { kind, recipients: recipients.length, created, emailed, muted };
  }

  // ---- inbox (account)

  async list(session: Session, opts: { unread?: boolean; limit?: number }): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query(
      'select notification_id, kind, subject, body, data, created_at, read_at from notifications where account_id = $1 and ($2::boolean is not true or read_at is null) order by created_at desc, notification_id desc limit $3',
      [session.accountId, opts.unread ?? false, opts.limit ?? 50],
    );
    return { notifications: r.rows.map(toNotification), unreadCount: await this.unreadCount(session.accountId) };
  }

  async markRead(session: Session, ids: string[]): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query<{ notification_id: string }>('update notifications set read_at = now() where account_id = $1 and notification_id = any($2) and read_at is null returning notification_id', [session.accountId, ids]);
    return { read: r.rows.map((x) => x.notification_id), unreadCount: await this.unreadCount(session.accountId) };
  }

  private async unreadCount(accountId: string): Promise<number> {
    const c = await this.ctx.pool.query<{ n: string }>('select count(*)::text as n from notifications where account_id = $1 and read_at is null', [accountId]);
    return Number(c.rows[0]?.n ?? 0);
  }

  // ---- preferences (account)

  async getPreferences(session: Session): Promise<Record<string, unknown>> {
    const acc = await this.ctx.pool.query<{ email: string | null }>('select email from accounts where account_id = $1', [session.accountId]);
    if (!acc.rows[0]) throw AppError.notFound('account');
    const p = await this.ctx.pool.query<{ email: boolean; muted_kinds: string[]; updated_at: Date }>('select email, muted_kinds, updated_at from notification_preferences where account_id = $1', [session.accountId]);
    const row = p.rows[0];
    return { email: row?.email ?? true, mutedKinds: row?.muted_kinds ?? [], emailAddress: acc.rows[0].email, channel: this.channel.name, updatedAt: row?.updated_at ?? null, knownKinds: Object.keys(TEMPLATES) };
  }

  async setPreferences(session: Session, input: z.infer<typeof preferencesSchema>): Promise<Record<string, unknown>> {
    const acc = await this.ctx.pool.query('select 1 from accounts where account_id = $1', [session.accountId]);
    if (!acc.rowCount) throw AppError.notFound('account');
    await this.ctx.pool.query(
      'insert into notification_preferences (account_id, email, muted_kinds) values ($1,$2,$3) on conflict (account_id) do update set email = excluded.email, muted_kinds = excluded.muted_kinds, updated_at = now()',
      [session.accountId, input.email, [...new Set(input.mutedKinds)]],
    );
    if (input.emailAddress !== undefined) await this.ctx.pool.query('update accounts set email = $2 where account_id = $1', [session.accountId, input.emailAddress]);
    return this.getPreferences(session);
  }

  // ---- admin visibility

  /** Backlog counts and the most recent rows. Payloads may carry amounts owed (issuer/holder notifications): admin-only, and the view is audited. */
  async adminOutbox(admin: Session): Promise<Record<string, unknown>> {
    const c = await this.ctx.pool.query<{ pending: string; failed: string; dispatched: string }>(
      "select count(*) filter (where dispatched_at is null)::text as pending, count(*) filter (where dispatched_at is null and last_error is not null)::text as failed, count(*) filter (where dispatched_at is not null)::text as dispatched from outbox where topic = 'notification'",
    );
    const failed = await this.ctx.pool.query("select id, topic, payload->>'kind' as kind, attempts, last_error, created_at from outbox where topic = 'notification' and dispatched_at is null and last_error is not null order by id desc limit 50");
    const recent = await this.ctx.pool.query("select id, topic, payload, attempts, last_error, created_at, dispatched_at from outbox where topic = 'notification' order by id desc limit 50");
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'notifications.outbox.view' });
    const counts = c.rows[0]!;
    return {
      counts: { pending: Number(counts.pending), failed: Number(counts.failed), dispatched: Number(counts.dispatched) },
      failed: failed.rows.map((r) => ({ id: Number(r.id), topic: r.topic, kind: r.kind, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at })),
      recent: recent.rows.map((r) => ({ id: Number(r.id), topic: r.topic, kind: (r.payload as { kind?: string }).kind ?? null, payload: r.payload, attempts: r.attempts, lastError: r.last_error, createdAt: r.created_at, dispatchedAt: r.dispatched_at })),
    };
  }

  /** The mock email outbox (dev visibility). */
  async adminEmails(admin: Session, limit = 50): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select email_id, to_address, subject, body, created_at from email_outbox order by created_at desc, email_id desc limit $1', [limit]);
    await audit(this.ctx.pool, { actor: admin.accountId, actorRole: 'admin', action: 'notifications.emails.view', detail: { limit } });
    return { channel: this.channel.name, emails: r.rows.map((e) => ({ emailId: e.email_id, to: e.to_address, subject: e.subject, body: e.body, createdAt: e.created_at })) };
  }
}

function toNotification(r: Record<string, unknown>): Record<string, unknown> {
  return { notificationId: r.notification_id, kind: r.kind, subject: r.subject, body: r.body, data: r.data, createdAt: r.created_at, readAt: r.read_at };
}

/**
 * The keeper's outbox handler (E7 `outboxJob(handler)`): delivers topic 'notification'; other topics are left to
 * whichever handler the integrator composes alongside this one.
 */
export function notificationsOutboxHandler(ctx: ServiceContext, channel?: NotificationChannel): OutboxHandler {
  const s = new NotificationsService(ctx, channel);
  return async (topic, payload) => {
    if (topic !== 'notification') return;
    await s.deliver(payload);
  };
}
