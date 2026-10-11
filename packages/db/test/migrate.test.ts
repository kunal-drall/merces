import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, createPool, databaseUrl, dbTestsEnabled, migrate } from '../src/index.ts';

const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

async function withFreshSchema(fn: (schema: string) => Promise<void>): Promise<void> {
  const schema = `t_mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  await admin.query(`create schema ${schema}`);
  try {
    await fn(schema);
  } finally {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
}

/*
 * S4 cause codes (each migration test on a database seeded before it):
 *  - S4-REG: 023, Stage 1's attestor key registry; S4-T2: 024, the report verifier's keys by address;
 *  - S4-ID: 025, attestors are keys linked to accounts (the key links, chain-neutral link challenges with a purpose, the
 *    registry and the proposals keys-only, and the superseded-s4 closures of work addressed to non-keys).
 */
describe.skipIf(!dbTestsEnabled())('migrate', () => {
  it('serialises concurrent processes: three migrate() calls on a fresh schema all succeed, each file applied once', async () => {
    await withFreshSchema(async (schema) => {
      // separate pools stand in for separate processes booting together
      const pools = [0, 1, 2].map(() => createPool(databaseUrl(), schema));
      try {
        const results = await Promise.allSettled(pools.map((p) => migrate(p)));
        for (const r of results) expect(r.status, r.status === 'rejected' ? String(r.reason) : '').toBe('fulfilled');
        const applied = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        expect(applied.sort()).toEqual(files);
        const rows = await pools[0]!.query<{ name: string }>('select name from schema_migrations order by name');
        expect(rows.rows.map((r) => r.name)).toEqual(files);
        expect(await migrate(pools[0]!)).toEqual([]);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  it('releases the lock and the client after a failed migration', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig-'));
        writeFileSync(join(dir, '001_ok.sql'), 'create table mig_ok (id int);');
        writeFileSync(join(dir, '002_bad.sql'), 'create table mig_bad (id int); select no_such_function();');
        await expect(migrate(pool, dir)).rejects.toThrow(/migration 002_bad.sql failed/);
        // the failed file rolled back; a retry is not blocked by a leaked lock
        const t = await pool.query("select to_regclass('mig_bad') as bad, to_regclass('mig_ok') as ok");
        expect(t.rows[0]).toMatchObject({ bad: null, ok: 'mig_ok' });
        writeFileSync(join(dir, '002_bad.sql'), 'create table mig_bad (id int);');
        expect(await migrate(pool, dir)).toEqual(['002_bad.sql']);
        expect(pool.idleCount + pool.waitingCount).toBe(pool.totalCount);
      } finally {
        await pool.end();
      }
    });
  });

  // S4 WP5 (cause S4-REG; amendment fix 2): migration 023 on a database seeded before it: the registry's new columns get
  // values for the rows already there, the request kinds check takes the registry's commands, and the boolean
  // requests stored before S4 are re-expressed once in the registry's vocabulary
  it('023_key_registry on a seeded pre-S4 database: existing rows keep their state and satisfy the new constraints', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig023-'));
        for (const f of files.filter((x) => x < '023')) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        await migrate(pool, dir);
        await pool.query("insert into attestors (chain, attestor, active) values ('solana', 'att-on', true), ('solana', 'att-off', false)");
        const req = (id: string, command: Record<string, unknown>, state = 'proposed') =>
          pool.query("insert into admin_tx_requests (request_id, kind, chain, command, state, created_by) values ($1, $2, 'solana', $3, $4, 'adm')", [id, command.kind, JSON.stringify(command), state]);
        await req('r-on', { kind: 'registerAttestor', attestor: 'att-on', active: true }, 'confirmed');
        await req('r-off', { kind: 'registerAttestor', attestor: 'att-off', active: false }, 'sent');
        await req('r-vk', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true });
        // before 023 the registry's commands are refused by the kinds check
        await expect(pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ('x', 'revokeAttestor', 'solana', '{}', 'adm')")).rejects.toThrow(/admin_tx_requests_kind_check/);

        copyFileSync(join(MIGRATIONS_DIR, '023_key_registry.sql'), join(dir, '023_key_registry.sql'));
        expect(await migrate(pool, dir)).toEqual(['023_key_registry.sql']);
        // existing attestor rows: their state kept, no registry times, updated_seq 0 so any later event overwrites them
        const rows = await pool.query('select attestor, active, registered_at, revoked_at, updated_seq::int as updated_seq from attestors order by attestor');
        expect(rows.rows).toEqual([
          { attestor: 'att-off', active: false, registered_at: null, revoked_at: null, updated_seq: 0 },
          { attestor: 'att-on', active: true, registered_at: null, revoked_at: null, updated_seq: 0 },
        ]);
        // the boolean requests, re-expressed once: active=false is the revocation it now is, active=true a registration
        const reqs = await pool.query('select request_id, kind, command, state from admin_tx_requests order by request_id');
        expect(reqs.rows).toEqual([
          { request_id: 'r-off', kind: 'revokeAttestor', command: { kind: 'revokeAttestor', attestor: 'att-off' }, state: 'sent' },
          { request_id: 'r-on', kind: 'registerAttestor', command: { kind: 'registerAttestor', attestor: 'att-on' }, state: 'confirmed' },
          { request_id: 'r-vk', kind: 'registerVerifierKey', command: { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, state: 'proposed' },
        ]);
        // the registry's commands are accepted now, for both key kinds; anything else still is not
        for (const kind of ['revokeAttestor', 'rotateAttestor', 'revokeVerifierKey', 'rotateVerifierKey']) {
          await pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ($1, $2, 'solana', '{}', 'adm')", [`k-${kind}`, kind]);
        }
        await expect(pool.query("insert into admin_tx_requests (request_id, kind, chain, command, created_by) values ('bad', 'deactivateAttestor', 'solana', '{}', 'adm')")).rejects.toThrow(/admin_tx_requests_kind_check/);
        // a new row needs no updated_seq of its own
        await pool.query("insert into attestors (chain, attestor, active) values ('monad', 'att-new', true)");
        expect((await pool.query("select updated_seq::int as s from attestors where attestor = 'att-new'")).rows[0].s).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });

  // S4 WP6 (cause S4-T2): migration 024 on a database seeded at 023: the verifier keys' read model, the ed25519 verifier
  // key requests no chain can carry removed, and the reports holding a retired ed25519 attestation that were not yet
  // submitted superseded (no other report touched)
  it('024_verifier_keys on a database seeded at 023: the read model, the legacy verifier-key requests and the unsubmitted ed25519 reports', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig024-'));
        for (const f of files.filter((x) => x < '024')) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        await migrate(pool, dir);
        const req = (id: string, command: Record<string, unknown>, state: string) =>
          pool.query("insert into admin_tx_requests (request_id, kind, chain, command, state, created_by) values ($1, $2, 'solana', $3, $4, 'adm')", [id, command.kind, JSON.stringify(command), state]);
        await req('vk-old-proposed', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, 'proposed');
        await req('vk-old-confirmed', { kind: 'registerVerifierKey', keyId: 'k', publicKey: 'aa', active: true }, 'confirmed');
        await req('vk-new', { kind: 'registerVerifierKey', key: '0x' + '11'.repeat(20) }, 'proposed');
        await req('att', { kind: 'registerAttestor', attestor: 'a' }, 'confirmed');
        const ed = { keyId: 'k', seriesId: 'solana:x', periodId: '2026Q1', priorIncomeCommitment: '0x00', incomeCommitment: '0x01', tier: 2, liquidityEvent: false, signature: '0x22' };
        const rep = (id: string, state: string, tier: number, attestation: unknown) =>
          pool.query(
            "insert into reports (report_id, series_id, period_id, account_id, tier, source, state, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof, attestation) values ($1, 'solana:x', '2026Q1', 'acct', $2, 'stripe', $3, 0, '0x01', '0x02', 'unity', 1, '{}', $4)",
            [id, tier, state, attestation === null ? null : JSON.stringify(attestation)],
          );
        await rep('r-assembled', 'assembled', 2, ed);
        await rep('r-rejected', 'rejected', 2, ed);
        await rep('r-accepted', 'accepted', 2, ed);
        await rep('r-paid', 'paid', 2, ed);
        await rep('r-new', 'assembled', 2, { signer: '0x' + '11'.repeat(20), signature: '0x' + '22'.repeat(65) });
        await rep('r-tier3', 'assembled', 3, null);

        copyFileSync(join(MIGRATIONS_DIR, '024_verifier_keys.sql'), join(dir, '024_verifier_keys.sql'));
        expect(await migrate(pool, dir)).toEqual(['024_verifier_keys.sql']);
        expect((await pool.query('select request_id from admin_tx_requests order by request_id')).rows.map((r) => r.request_id)).toEqual(['att', 'vk-new']);
        const states = await pool.query('select report_id, state from reports order by report_id');
        expect(states.rows).toEqual([
          { report_id: 'r-accepted', state: 'accepted' },
          { report_id: 'r-assembled', state: 'superseded' },
          { report_id: 'r-new', state: 'assembled' },
          { report_id: 'r-paid', state: 'paid' },
          { report_id: 'r-rejected', state: 'superseded' },
          { report_id: 'r-tier3', state: 'assembled' },
        ]);
        // the read model: a 20-byte lowercase address per chain, updated_seq defaulting to 0
        await pool.query("insert into verifier_keys (chain, address, active) values ('solana', $1, true)", ['0x' + 'ab'.repeat(20)]);
        expect((await pool.query('select updated_seq::int as s, registered_at, revoked_at from verifier_keys')).rows).toEqual([{ s: 0, registered_at: null, revoked_at: null }]);
        for (const bad of ['0x' + 'AB'.repeat(20), '0x' + 'ab'.repeat(19), 'k']) {
          await expect(pool.query("insert into verifier_keys (chain, address, active) values ('monad', $1, true)", [bad])).rejects.toThrow(/verifier_keys_address_check/);
        }
      } finally {
        await pool.end();
      }
    });
  });
  // S4 WP7 (cause S4-ID; amendment fix 2): migration 025 on a database seeded at 024. Attestors become 20-byte keys:
  // the key links, the chain-neutral link challenge, the registry and the proposals keep keys only, and every open item
  // addressed to an attestor that is not a key is closed once with decision_code superseded-s4 in a state its table's
  // check allows (or re-opened, an FX request), while items addressed to keys and items already on a chain are kept.
  it('025_signer_keys on a database seeded at 024: key links, link challenges, keys-only registry and the superseded-s4 closures', async () => {
    await withFreshSchema(async (schema) => {
      const pool = createPool(databaseUrl(), schema);
      try {
        const dir = mkdtempSync(join(tmpdir(), 'merces-mig025-'));
        for (const f of files.filter((x) => x < '025')) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        await migrate(pool, dir);
        const KEY = '0x' + 'ab'.repeat(20);
        const KEY2 = '0x' + 'cd'.repeat(20);
        const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
        const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
        await q("insert into accounts (account_id) values ('acct-a'), ('acct-b')");
        await q("insert into auth_nonces (nonce, chain, address, expires_at) values ('n-old', 'solana', $1, now() + interval '1 hour')", [WALLET]);
        await q("insert into attestors (chain, attestor, active) values ('solana', $1, true), ('solana', $2, true), ('monad', $3, true)", [WALLET, KEY, KEY2]);
        await q("insert into attestor_proposals (chain, wallet, account_id, active, proposed_by) values ('solana', $1, 'acct-a', true, 'adm'), ('monad', $2, 'acct-b', true, 'adm')", [WALLET, KEY2]);
        const req = (id: string, command: Record<string, unknown>) =>
          q("insert into admin_tx_requests (request_id, kind, chain, command, state, created_by) values ($1, $2, 'solana', $3, 'proposed', 'adm')", [id, command.kind, JSON.stringify(command)]);
        await req('rq-wallet', { kind: 'registerAttestor', attestor: WALLET });
        await req('rq-key', { kind: 'registerAttestor', attestor: KEY });
        await req('rq-rot', { kind: 'rotateAttestor', from: KEY, to: WALLET });
        await req('rq-vk', { kind: 'registerVerifierKey', key: KEY });
        // work addressed to the wallet attestor and to a key, open and decided
        const hard = (id: string, attestor: string, state: string) =>
          q("insert into hardship_requests (hardship_id, series_id, chain, issuer, account_id, attestor, requested_until, ciphertext, state) values ($1, 'solana:s1', 'solana', 'iss', 'acct-i', $2, 1, 'c', $3)", [id, attestor, state]);
        await hard('h-wallet', WALLET, 'pending');
        await hard('h-key', KEY, 'pending');
        await hard('h-done', WALLET, 'approved');
        const t3 = (id: string, period: string, attestor: string, state: string) =>
          q("insert into tier3_cases (case_id, series_id, chain, period_id, issuer, account_id, attestor, documents_ciphertext, estimate_payment_stable, state) values ($1, 'solana:s1', 'solana', $2, 'iss', 'acct-i', $3, 'c', 0, $4)", [id, period, attestor, state]);
        await t3('c-open', '2026Q1', WALLET, 'open');
        await t3('c-signed-unused', '2026Q2', WALLET, 'signed');
        await t3('c-signed-used', '2026Q3', WALLET, 'signed');
        await t3('c-key', '2026Q4', KEY, 'open');
        const rep = (id: string, period: string, state: string, cols: { attestor?: string; attestorRate?: unknown; pair?: string; fxBasis?: string } = {}) =>
          q(
            "insert into reports (report_id, series_id, period_id, account_id, tier, source, state, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, pair, proof, attestor, attestor_rate) values ($1, 'solana:s1', $2, 'acct-i', 3, 'attestor', $3, 0, '0x01', '0x02', $4, 1, $5, '{}', $6, $7)",
            [id, period, state, cols.fxBasis ?? 'unity', cols.pair ?? null, cols.attestor ?? null, cols.attestorRate === undefined ? null : JSON.stringify(cols.attestorRate)],
          );
        await rep('r-used', '2026Q3', 'accepted', { attestor: WALLET });
        await rep('r-unsent', '2026Q2', 'assembled', { attestor: WALLET });
        await rep('r-rate', '2026Q2', 'rejected', { attestorRate: { attestor: WALLET, rateWad: '1' }, pair: 'GBP/USD', fxBasis: 'attestor' });
        await rep('r-keyed', '2026Q4', 'assembled', { attestor: KEY });
        await rep('r-fx-sent', '2026Q1', 'paid', { attestorRate: { attestor: WALLET, rateWad: '1' }, pair: 'EUR/USD', fxBasis: 'attestor' });
        const annual = (id: string, year: number, attestor: string, state: string) =>
          q("insert into tier3_annual (annual_id, series_id, chain, year, issuer, account_id, attestor, documents_ciphertext, state) values ($1, 'solana:s1', 'solana', $2, 'iss', 'acct-i', $3, 'c', $4)", [id, year, attestor, state]);
        await annual('a-open', 2026, WALLET, 'open');
        await annual('a-signed', 2027, WALLET, 'signed');
        const fx = (id: string, pair: string, period: string, state: string, attestor: string | null) =>
          q("insert into fx_fallback_requests (request_id, chain, pair, period_id, reason, state, attestor, rate_wad, signature) values ($1, 'solana', $2, $3, 'coverage', $4, $5, $6, $7)", [id, pair, period, state, attestor, attestor ? '1' : null, attestor ? 'sim:x' : null]);
        await fx('fx-signed-unused', 'GBP/USD', '2026Q2', 'signed', WALLET);
        await fx('fx-signed-used', 'EUR/USD', '2026Q1', 'signed', WALLET);
        await fx('fx-open', 'CAD/USD', '2026Q2', 'open', null);
        await fx('fx-key', 'SGD/USD', '2026Q2', 'signed', KEY);
        const ext = (id: string, attestors: string[], state: string) =>
          q("insert into extinguishment_requests (request_id, series_id, chain, attestors, requested_by, evidence_ciphertext, state) values ($1, 'solana:s1', 'solana', $2, 'acct-a', 'c', $3)", [id, attestors, state]);
        await ext('e-wallet', [KEY, WALLET], 'built');
        await ext('e-keys', [KEY, KEY2], 'built');
        await ext('e-sent', [WALLET, KEY], 'sent');
        // the indexed series carries the commitment of the amendment that landed
        await q(
          `insert into series (series_id, chain, issuer, stablecoin, stablecoin_mint, raise_style, units_offered, reserve_price, minimum_raise, cap_multiple_wad, lockup_seconds, release_schedule,
                               auction_fee_bps, payout_fee_bps, hurdle_wad, payout_multiple_k, wallet_cap_bps, due_days, grace_days, formal_notice_days, contract_hash, terms_commitment, tier_flags, reporting_currency, created_at)
           values ('solana:s1', 'solana', 'iss', 'USDC', 'mint', 'sealed', 1, 1, 1, 1, 0, '[]', 0, 0, 0, 1, 0, 30, 15, 30, '0x00', '0xapplied', '{}', 'USD', 0)`,
        );
        const amend = (id: string, state: string, attestor: string | null, commitment: string) =>
          q("insert into terms_amendments (amendment_id, series_id, draft_id, kind, new_commitment, new_cap_multiple_wad, ciphertext, version, state, attestor, rationale_code) values ($1, 'solana:s1', 'd', 'cap-decrease', $2, 1, 'c', 2, $3, $4, 'r')", [id, commitment, state, attestor]);
        await amend('m-proposed', 'proposed', null, '0xnew1');
        await amend('m-attested', 'attested', WALLET, '0xnew2');
        await amend('m-submitted', 'submitted', WALLET, '0xnew3');
        await amend('m-landed', 'submitted', WALLET, '0xapplied');
        await amend('m-key', 'attested', KEY, '0xnew4');

        copyFileSync(join(MIGRATIONS_DIR, '025_signer_keys.sql'), join(dir, '025_signer_keys.sql'));
        expect(await migrate(pool, dir)).toEqual(['025_signer_keys.sql']);
        const rows = async (sql: string) => (await q(sql)).rows;

        // the key links: one account per key, 20-byte lowercase addresses only
        await q("insert into account_signer_keys (address, account_id) values ($1, 'acct-a')", [KEY]);
        await expect(q("insert into account_signer_keys (address, account_id) values ($1, 'acct-b')", [KEY])).rejects.toThrow(/account_signer_keys_pkey/);
        for (const bad of [WALLET, '0x' + 'AB'.repeat(20), '0x' + 'ab'.repeat(19)]) await expect(q("insert into account_signer_keys (address, account_id) values ($1, 'acct-b')", [bad])).rejects.toThrow(/account_signer_keys_address_check/);
        await expect(q("insert into account_signer_keys (address, account_id) values ($1, 'nobody')", [KEY2])).rejects.toThrow(/account_signer_keys_account_id_fkey/);
        // auth nonces: the old row is a sign-in nonce; a link challenge names no chain but an account; nothing else passes
        expect(await rows("select nonce, purpose, chain from auth_nonces")).toEqual([{ nonce: 'n-old', purpose: 'sign-in', chain: 'solana' }]);
        await q("insert into auth_nonces (nonce, chain, address, expires_at, purpose, account_id) values ('n-link', null, $1, now(), 'link-signer-key', 'acct-a')", [KEY]);
        for (const [chain, purpose, account] of [[null, 'sign-in', null], ['solana', 'link-signer-key', 'acct-a'], [null, 'link-signer-key', null], [null, 'other', 'acct-a']] as const) {
          await expect(q("insert into auth_nonces (nonce, chain, address, expires_at, purpose, account_id) values ($1, $2, $3, now(), $4, $5)", [`n-${Math.random()}`, chain, KEY, purpose, account])).rejects.toThrow(/auth_nonces_purpose_check/);
        }
        // the registry and the proposals hold keys only
        expect(await rows('select chain, attestor from attestors order by chain, attestor')).toEqual([{ chain: 'monad', attestor: KEY2 }, { chain: 'solana', attestor: KEY }]);
        await expect(q("insert into attestors (chain, attestor, active) values ('solana', $1, true)", [WALLET])).rejects.toThrow(/attestors_attestor_check/);
        expect(await rows('select chain, address, account_id from attestor_proposals')).toEqual([{ chain: 'monad', address: KEY2, account_id: 'acct-b' }]);
        await expect(q("insert into attestor_proposals (chain, address, account_id, active, proposed_by) values ('solana', $1, 'acct-a', true, 'adm')", [WALLET])).rejects.toThrow(/attestor_proposals_address_check/);
        expect((await rows('select request_id from admin_tx_requests order by request_id')).map((r) => r.request_id)).toEqual(['rq-key', 'rq-vk']);
        // the closures: each table's own allowed state, decision_code superseded-s4, items addressed to keys untouched
        expect(await rows('select hardship_id, state, decision_code from hardship_requests order by hardship_id')).toEqual([
          { hardship_id: 'h-done', state: 'approved', decision_code: null },
          { hardship_id: 'h-key', state: 'pending', decision_code: null },
          { hardship_id: 'h-wallet', state: 'rejected', decision_code: 'superseded-s4' },
        ]);
        expect(await rows('select case_id, state, decision_code from tier3_cases order by case_id')).toEqual([
          { case_id: 'c-key', state: 'open', decision_code: null },
          { case_id: 'c-open', state: 'withdrawn', decision_code: 'superseded-s4' },
          { case_id: 'c-signed-unused', state: 'withdrawn', decision_code: 'superseded-s4' },
          { case_id: 'c-signed-used', state: 'signed', decision_code: null },
        ]);
        expect(await rows('select annual_id, state, decision_code from tier3_annual order by annual_id')).toEqual([
          { annual_id: 'a-open', state: 'withdrawn', decision_code: 'superseded-s4' },
          { annual_id: 'a-signed', state: 'signed', decision_code: null },
        ]);
        // a withdrawn annual attestation no longer holds its year; a live one still does
        await annual('a-again', 2026, KEY, 'open');
        await expect(annual('a-dup', 2026, KEY, 'open')).rejects.toThrow(/tier3_annual_live/);
        expect(await rows('select request_id, state, attestor, signature, decision_code from fx_fallback_requests order by request_id')).toEqual([
          { request_id: 'fx-key', state: 'signed', attestor: KEY, signature: 'sim:x', decision_code: null },
          { request_id: 'fx-open', state: 'open', attestor: null, signature: null, decision_code: null },
          { request_id: 'fx-signed-unused', state: 'open', attestor: null, signature: null, decision_code: 'superseded-s4' },
          { request_id: 'fx-signed-used', state: 'signed', attestor: WALLET, signature: 'sim:x', decision_code: null },
        ]);
        expect(await rows('select request_id, state, decision_code from extinguishment_requests order by request_id')).toEqual([
          { request_id: 'e-keys', state: 'built', decision_code: null },
          { request_id: 'e-sent', state: 'sent', decision_code: null },
          { request_id: 'e-wallet', state: 'withdrawn', decision_code: 'superseded-s4' },
        ]);
        expect(await rows('select amendment_id, state, decision_code from terms_amendments order by amendment_id')).toEqual([
          { amendment_id: 'm-attested', state: 'rejected', decision_code: 'superseded-s4' },
          { amendment_id: 'm-key', state: 'attested', decision_code: null },
          { amendment_id: 'm-landed', state: 'submitted', decision_code: null },
          { amendment_id: 'm-proposed', state: 'proposed', decision_code: null },
          { amendment_id: 'm-submitted', state: 'rejected', decision_code: 'superseded-s4' },
        ]);
        expect(await rows('select report_id, state from reports order by report_id')).toEqual([
          { report_id: 'r-fx-sent', state: 'paid' },
          { report_id: 'r-keyed', state: 'assembled' },
          { report_id: 'r-rate', state: 'superseded' },
          { report_id: 'r-unsent', state: 'superseded' },
          { report_id: 'r-used', state: 'accepted' },
        ]);
        // migrating again changes nothing (each row is closed once)
        expect(await migrate(pool, dir)).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });
});
