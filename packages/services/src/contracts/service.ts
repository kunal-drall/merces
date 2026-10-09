import { createHash } from 'node:crypto';
import { AppError, audit, enqueueOutbox } from '@merces/core';
import { withTransaction } from '@merces/db';
import type { Session } from '@merces/api';
import type { ServiceContext } from '../context.ts';
import { PLACEHOLDER_CHARTER_TEMPLATE, PLACEHOLDER_HEU_TEMPLATE, render } from './templates.ts';

/**
 * E3 — contract signing. Renders the HEU contract and the Autonomy Charter from counsel's templates, collects
 * the issuer's signature through the e-signature port, stores the signed bundle encrypted, and exposes its hash
 * for `createSeries`. A raise cannot be opened without it: the simulator and Stage 1 refuse a zero hash, and
 * the terms service refuses to build `createSeries` until the draft is `contract_signed`.
 */
export class ContractService {
  constructor(private readonly ctx: ServiceContext) {}

  async ensureTemplates(): Promise<{ heu: string; charter: string }> {
    const rows = await this.ctx.pool.query<{ template_id: string; kind: string }>('select template_id, kind from contract_templates order by created_at desc');
    let heu = rows.rows.find((r) => r.kind === 'heu')?.template_id;
    let charter = rows.rows.find((r) => r.kind === 'charter')?.template_id;
    if (!heu) {
      heu = 'heu-placeholder-v0';
      await this.ctx.pool.query('insert into contract_templates (template_id, kind, version, body, body_hash) values ($1,$2,$3,$4,$5) on conflict do nothing', [heu, 'heu', 'placeholder-v0', PLACEHOLDER_HEU_TEMPLATE, sha(PLACEHOLDER_HEU_TEMPLATE)]);
    }
    if (!charter) {
      charter = 'charter-placeholder-v0';
      await this.ctx.pool.query('insert into contract_templates (template_id, kind, version, body, body_hash) values ($1,$2,$3,$4,$5) on conflict do nothing', [charter, 'charter', 'placeholder-v0', PLACEHOLDER_CHARTER_TEMPLATE, sha(PLACEHOLDER_CHARTER_TEMPLATE)]);
    }
    return { heu, charter };
  }

  /** Counsel-supplied templates are loaded by an admin; the previous version stays for existing sessions. */
  async addTemplate(kind: 'heu' | 'charter', version: string, body: string, by: string): Promise<{ templateId: string }> {
    const templateId = `${kind}-${version}`;
    // versions are immutable (existing sessions reference them): a repeat is a conflict, never an overwrite
    const ins = await this.ctx.pool.query('insert into contract_templates (template_id, kind, version, body, body_hash) values ($1,$2,$3,$4,$5) on conflict (template_id) do nothing', [templateId, kind, version, body, sha(body)]);
    if (!ins.rowCount) throw AppError.conflict(`template ${templateId} already exists`);
    await audit(this.ctx.pool, { actor: by, actorRole: 'admin', action: 'contract.template.add', target: templateId, detail: { kind, version, bodyHash: sha(body) } });
    return { templateId };
  }

  async prepare(draftId: string, session: Session): Promise<Record<string, unknown>> {
    const d = await this.ctx.pool.query('select * from series_drafts where draft_id = $1', [draftId]);
    const draft = d.rows[0];
    if (!draft) throw AppError.notFound('draft');
    if (draft.account_id !== session.accountId) throw AppError.forbidden();
    if (draft.state !== 'terms_set') throw AppError.conflict(`draft is ${draft.state}; set terms first`);
    const existing = await this.ctx.pool.query("select session_id, state from contract_sessions where draft_id = $1 and state in ('prepared','sent','signed') order by created_at desc limit 1", [draftId]);
    if (existing.rows[0]) return this.status(draftId, session);
    const { heu, charter } = await this.ensureTemplates();
    const tpl = await this.ctx.pool.query<{ template_id: string; body: string }>('select template_id, body from contract_templates where template_id = any($1)', [[heu, charter]]);
    const t = draft.public_terms as Record<string, unknown>;
    const vars: Record<string, string> = {
      issuer: draft.issuer, chain: draft.chain, draftId, stablecoin: String(t.stablecoin), unitsOffered: String(t.unitsOffered), reservePrice: String(t.reservePrice), minimumRaise: String(t.minimumRaise),
      capMultiple: String(t.capMultipleDecimal ?? t.capMultipleWad), lockupDays: String(Math.round(Number(t.lockupSeconds) / 86_400)), releaseSchedule: JSON.stringify(t.releaseSchedule), auctionFeeBps: String(t.auctionFeeBps), payoutFeeBps: String(t.payoutFeeBps),
      reportingCurrency: String(t.reportingCurrency), termsCommitment: String(draft.terms_commitment),
    };
    const heuBody = render(tpl.rows.find((r) => r.template_id === heu)!.body, vars);
    const charterBody = render(tpl.rows.find((r) => r.template_id === charter)!.body, vars);
    const sessionId = this.ctx.newId('csess');
    const env = await this.ctx.esign.createEnvelope({ sessionId, signerAccountId: session.accountId, documents: [{ name: 'HEU Contract', body: heuBody }, { name: 'Autonomy Charter', body: charterBody }] });
    await this.ctx.pool.query(
      "insert into contract_sessions (session_id, account_id, chain, issuer, draft_id, provider, provider_ref, state, heu_template_id, charter_template_id, rendered_hash) values ($1,$2,$3,$4,$5,$6,$7,'sent',$8,$9,$10)",
      [sessionId, session.accountId, draft.chain, draft.issuer, draftId, this.ctx.esign.provider, env.envelopeId, heu, charter, sha(heuBody + '\n' + charterBody)],
    );
    return { sessionId, state: 'sent', provider: this.ctx.esign.provider, signingUrl: env.signingUrl, documents: [{ name: 'HEU Contract', body: heuBody }, { name: 'Autonomy Charter', body: charterBody }] };
  }

  /** Poll the provider (or receive its webhook) and persist the signed bundle. */
  async refresh(sessionId: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from contract_sessions where session_id = $1', [sessionId]);
    const cs = r.rows[0];
    if (!cs) throw AppError.notFound('contract session');
    if (cs.state === 'signed') return this.view(cs);
    const st = await this.ctx.esign.status(cs.provider_ref);
    if (st === 'signed') {
      const doc = await this.ctx.esign.signedDocument(cs.provider_ref);
      if (!doc) throw AppError.conflict('provider reports signed but returned no document');
      const signedHash = '0x' + sha(doc.body);
      const enc = this.ctx.vault.encrypt(doc.body, `contract:${sessionId}`);
      // one transaction: a session marked signed with the draft still terms_set is never revisited (refresh returns early)
      await withTransaction(this.ctx.pool, async (c) => {
        const upd = await c.query("update contract_sessions set state = 'signed', signed_hash = $2, signed_document_encrypted = $3, signed_at = $4 where session_id = $1 and state <> 'signed'", [sessionId, signedHash, enc, doc.completedAt]);
        if (!upd.rowCount) return; // a concurrent refresh (webhook vs poll) already recorded it
        await c.query("update series_drafts set state = 'contract_signed', contract_hash = $2, updated_at = now() where draft_id = $1 and state = 'terms_set'", [cs.draft_id, signedHash]);
        await enqueueOutbox(c, 'notification', { kind: 'contract.signed', accountId: cs.account_id, draftId: cs.draft_id });
      });
    } else if (st !== 'sent') {
      await this.ctx.pool.query('update contract_sessions set state = $2 where session_id = $1', [sessionId, st]);
      await this.ctx.pool.query("update series_drafts set state = 'terms_set' where draft_id = $1 and state = 'terms_set'", [cs.draft_id]);
    }
    return this.refreshView(sessionId);
  }

  private async refreshView(sessionId: string): Promise<Record<string, unknown>> {
    const r = await this.ctx.pool.query('select * from contract_sessions where session_id = $1', [sessionId]);
    return this.view(r.rows[0]);
  }
  private view(cs: Record<string, unknown>): Record<string, unknown> {
    return { sessionId: cs.session_id, draftId: cs.draft_id, state: cs.state, provider: cs.provider, renderedHash: '0x' + cs.rendered_hash, signedHash: cs.signed_hash ?? null, signedAt: cs.signed_at ?? null, templates: { heu: cs.heu_template_id, charter: cs.charter_template_id } };
  }

  async status(draftId: string, session: Session): Promise<Record<string, unknown>> {
    const d = await this.ctx.pool.query('select account_id from series_drafts where draft_id = $1', [draftId]);
    if (!d.rows[0]) throw AppError.notFound('draft');
    if (d.rows[0].account_id !== session.accountId && !session.roles.includes('admin')) throw AppError.forbidden();
    const r = await this.ctx.pool.query('select * from contract_sessions where draft_id = $1 order by created_at desc limit 1', [draftId]);
    if (!r.rows[0]) return { draftId, state: 'none' };
    if (r.rows[0].state === 'sent') return this.refresh(r.rows[0].session_id);
    return this.view(r.rows[0]);
  }

  /** The signed document, decrypted for the signer (or an admin), never for anyone else. */
  async signedDocument(draftId: string, session: Session): Promise<{ body: string; signedHash: string }> {
    const d = await this.ctx.pool.query('select account_id from series_drafts where draft_id = $1', [draftId]);
    if (!d.rows[0]) throw AppError.notFound('draft');
    if (d.rows[0].account_id !== session.accountId && !session.roles.includes('admin')) throw AppError.forbidden();
    const r = await this.ctx.pool.query("select session_id, signed_hash, signed_document_encrypted from contract_sessions where draft_id = $1 and state = 'signed' order by signed_at desc limit 1", [draftId]);
    const cs = r.rows[0];
    if (!cs) throw AppError.notFound('signed contract');
    await audit(this.ctx.pool, { actor: session.accountId, actorRole: session.roles.includes('admin') ? 'admin' : 'issuer', action: 'contract.read', target: draftId });
    return { body: this.ctx.vault.decrypt(cs.signed_document_encrypted, `contract:${cs.session_id}`), signedHash: cs.signed_hash };
  }
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
