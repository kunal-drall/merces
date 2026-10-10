import { describe, expect, it } from 'vitest';
import { ChainError, KEY_GRACE_SECONDS, type UserCommand } from '@merces/domain';
import { parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, SimWallet, serialiseState } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

/*
 * Stage 1's key registry for attestor keys on the simulator (S4 WP5; S4 D5, D9). Cause codes:
 *  - S4-REG: register, revoke and rotate; forward-only revocation with its 45-day grace on report and FX signatures;
 *    the last-key rule (merces_registry lib.rs:218-260; MercesRegistry.sol:287-345; SIM:332-338, :535-546);
 *  - S4-ERR: each personality raises its own chain's names, with one chain-neutral code per case.
 */

type Report = Extract<UserCommand, { kind: 'submitReport' }>;
const DAY = 86_400;

/** The transaction is refused with Stage 1 error `name` (and `code`), leaving the chain's state and event log as they were. */
async function refused(h: SimHarness, tx: Promise<unknown>, name: string, code?: string): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx.then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  if (code) expect((e as ChainError).code).toBe(code);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

describe('the attestor key registry, per personality (S4-REG, S4-ERR)', () => {
  // each case: [solana name, monad name, the code both carry]; a register of an active key is no error on Solana
  const CASES = {
    zero: ['ZeroAttestorAddress', 'ZeroAddress', 'InvalidTerms'],
    revokeRevoked: ['KeyAlreadyRevoked', 'KeyNotRegistered', 'WrongStatus'],
    revokeUnknown: ['AccountNotInitialized', 'KeyNotRegistered', 'WrongStatus'],
    lastKey: ['LastKeyOfKind', 'LastActiveKey', 'NotPermitted'],
  } as const;

  for (const personality of ['solana', 'monad'] as const) {
    const name = (c: keyof typeof CASES) => CASES[c][personality === 'solana' ? 0 : 1];
    const code = (c: keyof typeof CASES) => CASES[c][2];

    it(`${personality}: register, revoke with revokedAt, re-register clears it; every refusal by its chain's name and in its chain's order`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const [a1, a2] = h.attestors as [SimWallet, SimWallet];
      const fresh = new SimWallet(h.sim.family, 'attestor-3');
      // the harness registered two keys; the read is Stage 1's key record
      expect(await h.sim.listSignerKeys('attestor')).toEqual([a1.address, a2.address].sort().map((address) => ({ kind: 'attestor', address, active: true, revokedAt: null, graceUntil: null })));
      expect(await h.sim.getSignerKey('attestor', fresh.address)).toBeNull();

      // the zero address, both encodings a key address could take
      for (const zero of ['0x' + '0'.repeat(40), '1'.repeat(32)]) await refused(h, h.exec(h.admin, { kind: 'registerAttestor', attestor: zero }), name('zero'), code('zero'));
      // only the admin registers, revokes or rotates
      for (const cmd of [{ kind: 'registerAttestor', attestor: fresh.address }, { kind: 'revokeAttestor', attestor: a1.address }, { kind: 'rotateAttestor', from: a1.address, to: fresh.address }] as const) {
        await expectChainError(h.exec(h.issuer, cmd), 'Unauthorized');
      }
      // a key never registered: Anchor's AccountNotInitialized on Solana, KeyNotRegistered on the EVM
      await refused(h, h.exec(h.admin, { kind: 'revokeAttestor', attestor: fresh.address }), name('revokeUnknown'), code('revokeUnknown'));

      // revoke: forward-only, at the chain's time
      const t = await h.sim.now();
      const rv = await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a2.address });
      expect(rv.events.map((e) => [e.type, e.payload])).toEqual([['AttestorRevoked', { attestor: a2.address, revokedAt: t }]]);
      expect(await h.sim.getSignerKey('attestor', a2.address)).toEqual({ kind: 'attestor', address: a2.address, active: false, revokedAt: t, graceUntil: t + KEY_GRACE_SECONDS });
      // order: a key that is not active is refused before the last-key rule (a1 is now the last active key)
      await refused(h, h.exec(h.admin, { kind: 'revokeAttestor', attestor: a2.address }), name('revokeRevoked'), code('revokeRevoked'));
      await refused(h, h.exec(h.admin, { kind: 'revokeAttestor', attestor: fresh.address }), name('revokeUnknown'), code('revokeUnknown'));
      // the last active key: both chains refuse it (Stage 1's reference does not: DIV-S1I-2)
      await refused(h, h.exec(h.admin, { kind: 'revokeAttestor', attestor: a1.address }), name('lastKey'), code('lastKey'));

      // re-registering a revoked key makes it active and clears its revocation
      await h.sim.setTime(t + DAY);
      const rr = await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address });
      expect(rr.events.map((e) => [e.type, e.payload])).toEqual([['AttestorRegistered', { attestor: a2.address }]]);
      expect(await h.sim.getSignerKey('attestor', a2.address)).toEqual({ kind: 'attestor', address: a2.address, active: true, revokedAt: null, graceUntil: null });

      // registering an active key: Solana re-emits the event and changes nothing; the EVM refuses KeyAlreadyActive
      if (personality === 'solana') {
        const before = structuredClone(h.sim.state);
        const again = await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address });
        expect(again.events.map((e) => [e.type, e.payload])).toEqual([['AttestorRegistered', { attestor: a2.address }]]);
        // only the transaction counters moved
        expect({ ...h.sim.state, seq: before.seq, txCount: before.txCount }).toEqual(before);
        expect(h.sim.state.attestors.get(a2.address)).toEqual({ active: true, revokedAt: null });
        expect([...h.sim.state.attestors.values()].filter((k) => k.active)).toHaveLength(2); // no double count: a1 may still not be the last
      } else {
        await refused(h, h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address }), 'KeyAlreadyActive', 'Duplicate');
      }
    });

    it(`${personality}: rotate registers the new key, then revokes the old one, in one transaction; a refused revoke undoes the registration`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const [a1, a2] = h.attestors as [SimWallet, SimWallet];
      const n1 = new SimWallet(h.sim.family, 'attestor-new-1');
      const n2 = new SimWallet(h.sim.family, 'attestor-new-2');
      const r = await h.exec(h.admin, { kind: 'rotateAttestor', from: a1.address, to: n1.address });
      expect(r.events.map((e) => [e.type, e.payload])).toEqual([['AttestorRegistered', { attestor: n1.address }], ['AttestorRevoked', { attestor: a1.address, revokedAt: await h.sim.now() }]]);
      expect(r.events.map((e) => e.txId)).toEqual([r.txId, r.txId]);
      expect((await h.sim.listSignerKeys('attestor')).filter((k) => k.active).map((k) => k.address).sort()).toEqual([a2.address, n1.address].sort());
      // the old key is not active: the revoke is refused and the new key's registration with it (atomic)
      await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: a1.address, to: n2.address }), name('revokeRevoked'), code('revokeRevoked'));
      expect(await h.sim.getSignerKey('attestor', n2.address)).toBeNull();
      // a key never registered as the old one
      await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: n2.address, to: new SimWallet(h.sim.family, 'x').address }), name('revokeUnknown'), code('revokeUnknown'));
      // rotating to a key that is already active: the EVM's registration refuses it; Solana's is a no-op and the revoke runs
      if (personality === 'monad') await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: a2.address, to: n1.address }), 'KeyAlreadyActive', 'Duplicate');
      else {
        await h.exec(h.admin, { kind: 'rotateAttestor', from: a2.address, to: n1.address });
        expect((await h.sim.listSignerKeys('attestor')).filter((k) => k.active).map((k) => k.address)).toEqual([n1.address]);
        // n1 alone: rotating it onto itself registers (no-op) then revokes the last key, which is refused
        await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: n1.address, to: n1.address }), 'LastKeyOfKind', 'NotPermitted');
      }
    });
  }

  it('verifier keys by address arrive with S4 WP6: kind verifier is NotImplemented until then', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await expectChainError(h.sim.getSignerKey('verifier', '0x' + '11'.repeat(20)), 'NotImplemented');
    await expectChainError(h.sim.listSignerKeys('verifier'), 'NotImplemented');
  });
});

describe('revocation grace on the co-signed paths (S4-REG; Stage 1 SPEC §1.4, SIM:332-338)', () => {
  async function settled(terms: Parameters<SimHarness['runRaise']>[0] = {}) {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const raise = await h.runRaise(terms);
    return { h, ...raise };
  }

  it('tier 3: an attestor revoked after the period ended may still attest it until revokedAt + 45 days; one revoked before may not', async () => {
    const q1 = parsePeriod('2026Q1');
    // revoked one day after Q1 ended, reported within the grace: accepted
    {
      const { h, seriesId, privateTerms } = await settled();
      const a = h.attestors[0]!;
      await h.sim.setTime(q1.end + DAY);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(q1.end + DAY + KEY_GRACE_SECONDS); // the last second of the grace
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a.address });
      const r = await h.exec(h.issuer, command, [a]);
      expect(types(r.events)).toContain('ReportAccepted');
    }
    // one second past the grace: refused
    {
      const { h, seriesId, privateTerms } = await settled();
      const a = h.attestors[0]!;
      await h.sim.setTime(q1.end + DAY);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(q1.end + DAY + KEY_GRACE_SECONDS + 1);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a.address });
      await refused(h, h.exec(h.issuer, command, [a]), 'InvalidAttestorSignature', 'InvalidAttestation');
    }
    // revoked before the period ended: never usable for it (forward-only), even within 45 days
    {
      const { h, seriesId, privateTerms } = await settled();
      const a = h.attestors[0]!;
      await h.sim.setTime(q1.end - DAY);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(q1.end + DAY);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a.address });
      await refused(h, h.exec(h.issuer, command, [a]), 'InvalidAttestorSignature', 'InvalidAttestation');
    }
  });

  it('FX fallback: the same grace (both chains; Stage 1\'s reference gives none, DIV-S1I-3)', async () => {
    const q1 = parsePeriod('2026Q1');
    const rate = wadFromDecimal('1.08');
    for (const [revokeAt, sendAt, ok] of [[q1.end + DAY, q1.end + 2 * DAY, true], [q1.end - DAY, q1.end + DAY, false]] as const) {
      const { h, seriesId, privateTerms } = await settled({ terms: { reportingCurrency: 'EUR' } });
      const a = h.attestors[1]!;
      await h.sim.setTime(revokeAt);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(sendAt);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), pair: 'EUR/USD', fxAvgWad: rate, fxBasis: 'attestor', attestorRate: { attestor: a.address, rateWad: rate, pair: 'EUR/USD' } });
      if (ok) expect(types((await h.exec(h.issuer, command as Report, [a])).events)).toContain('ReportAccepted');
      else await refused(h, h.exec(h.issuer, command as Report, [a]), 'InvalidAttestorSignature');
    }
  });

  it('pause approval, amendment and extinguishment need an active key: no grace', async () => {
    const { h, seriesId, terms } = await settled();
    const [a1, a2] = h.attestors as [SimWallet, SimWallet];
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 30 * DAY });
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a1.address });
    await refused(h, h.exec(a1, { kind: 'approvePause', seriesId, until: now + 30 * DAY }), 'InvalidAttestorSignature');
    await refused(h, h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: terms.termsCommitment, capMultipleWad: terms.capMultipleWad.toString(), attestor: a1.address }, [a1]), 'InvalidAttestorSignature');
    await refused(h, h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]), 'InvalidAttestorSignature');
    // the active key still approves
    expect(types((await h.exec(a2, { kind: 'approvePause', seriesId, until: now + 30 * DAY })).events)).toContain('PauseApproved');
  });
});
