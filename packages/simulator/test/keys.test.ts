import { describe, expect, it } from 'vitest';
import { ChainError, KEY_GRACE_SECONDS, type UserCommand } from '@merces/domain';
import { parsePeriod, wadFromDecimal } from '@merces/math';
import { SimAttestor, SimHarness, SimSigner, SimWallet, serialiseState } from '../src/index.ts';
import { GENESIS, USDC, expectChainError, types } from './helpers.ts';

/*
 * Stage 1's key registry on the simulator: attestor keys (S4 WP5) and the report verifier's keys (S4 WP6); S4 D5, D9,
 * D10. Cause codes:
 *  - S4-REG: register, revoke and rotate; forward-only revocation with its 45-day grace on report and FX signatures;
 *    the last-key rule (merces_registry lib.rs:218-302; MercesRegistry.sol:287-345; SIM:332-338, :535-546);
 *  - S4-ERR: each personality raises its own chain's names, with one chain-neutral code per case;
 *  - S4-T2: verifier keys are 20-byte addresses with the attestor keys' rules, and a tier-2 report is Stage 1's REPORT
 *    signature by one, with the same grace;
 *  - S4-ID: attestors are 20-byte keys on both personalities too (S4 WP7): the harness's are `SimAttestor`s
 *    (`SimSigner.attestor`), and a wallet address of another form is no key (the command's schema refuses it);
 *  - S4-T3 / S4-FX: a tier-3 report and the FX fallback carry the attestor key's own Stage 1 signature (REPORT tier 3, and
 *    FX per series; S4 WP9), with the report keys' grace; nobody co-signs.
 *  - S4-PAU: a pause approval is the attestor key's PAUSE signature, relayed by anyone (S4 WP10); an active key only.
 *  - S4-AMD: an amendment is the issuer's amendTerms carrying the attestor key's AMEND signature (S4 WP11); an active key
 *    only.
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
      const [a1, a2] = h.attestors as [SimAttestor, SimAttestor]; // cause S4-ID: the harness attestors are keys (SimAttestor)
      const fresh = SimSigner.attestor('attestor-3'); // cause S4-ID: attestors are 20-byte keys on both personalities
      // the harness registered two keys; the read is Stage 1's key record
      expect(await h.sim.listSignerKeys('attestor')).toEqual([a1.address, a2.address].sort().map((address) => ({ kind: 'attestor', address, active: true, revokedAt: null, graceUntil: null })));
      expect(await h.sim.getSignerKey('attestor', fresh.address)).toBeNull();

      // the zero address (cause S4-ID: a key address is 20 bytes on both personalities; a wallet address of another form
      // is no key, and the command's schema refuses it before the chain sees it)
      await refused(h, h.exec(h.admin, { kind: 'registerAttestor', attestor: '0x' + '0'.repeat(40) }), name('zero'), code('zero'));
      for (const notAKey of ['1'.repeat(32), new SimWallet('solana', 'attestor-wallet').address, '0x' + 'AB'.repeat(20)]) await expect(h.exec(h.admin, { kind: 'registerAttestor', attestor: notAKey })).rejects.toThrow(/Invalid string/);
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
      const [a1, a2] = h.attestors as [SimAttestor, SimAttestor]; // cause S4-ID: the harness attestors are keys (SimAttestor)
      const n1 = SimSigner.attestor('attestor-new-1'); // cause S4-ID: attestors are 20-byte keys on both personalities
      const n2 = SimSigner.attestor('attestor-new-2');
      const r = await h.exec(h.admin, { kind: 'rotateAttestor', from: a1.address, to: n1.address });
      expect(r.events.map((e) => [e.type, e.payload])).toEqual([['AttestorRegistered', { attestor: n1.address }], ['AttestorRevoked', { attestor: a1.address, revokedAt: await h.sim.now() }]]);
      expect(r.events.map((e) => e.txId)).toEqual([r.txId, r.txId]);
      expect((await h.sim.listSignerKeys('attestor')).filter((k) => k.active).map((k) => k.address).sort()).toEqual([a2.address, n1.address].sort());
      // the old key is not active: the revoke is refused and the new key's registration with it (atomic)
      await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: a1.address, to: n2.address }), name('revokeRevoked'), code('revokeRevoked'));
      expect(await h.sim.getSignerKey('attestor', n2.address)).toBeNull();
      // a key never registered as the old one
      await refused(h, h.exec(h.admin, { kind: 'rotateAttestor', from: n2.address, to: SimSigner.attestor('x').address }), name('revokeUnknown'), code('revokeUnknown'));
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

});

describe('the report verifier key registry, per personality (S4-T2, S4-REG, S4-ERR)', () => {
  const CASES = {
    zero: ['ZeroAttestorAddress', 'ZeroAddress', 'InvalidTerms'],
    revokeRevoked: ['KeyAlreadyRevoked', 'KeyNotRegistered', 'WrongStatus'],
    revokeUnknown: ['AccountNotInitialized', 'KeyNotRegistered', 'WrongStatus'],
    lastKey: ['LastKeyOfKind', 'LastActiveKey', 'NotPermitted'],
  } as const;

  for (const personality of ['solana', 'monad'] as const) {
    const name = (c: keyof typeof CASES) => CASES[c][personality === 'solana' ? 0 : 1];
    const code = (c: keyof typeof CASES) => CASES[c][2];

    it(`${personality}: verifier keys by 20-byte address, their own count; register, revoke, rotate and every refusal as the attestor keys'`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const v1 = h.verifier.address;
      const v2 = SimSigner.verifier('verifier-2').address;
      const v3 = SimSigner.verifier('verifier-3').address;
      // the harness registered one verifier key (Stage 1 VerifierKey record); attestor keys are a separate set
      expect(await h.sim.listSignerKeys('verifier')).toEqual([{ kind: 'verifier', address: v1, active: true, revokedAt: null, graceUntil: null }]);
      expect(await h.sim.getSignerKey('verifier', v2)).toBeNull();
      expect(await h.sim.getSignerKey('attestor', v1)).toBeNull();
      await refused(h, h.exec(h.admin, { kind: 'registerVerifierKey', key: '0x' + '0'.repeat(40) }), name('zero'), code('zero'));
      for (const cmd of [{ kind: 'registerVerifierKey', key: v2 }, { kind: 'revokeVerifierKey', key: v1 }, { kind: 'rotateVerifierKey', from: v1, to: v2 }] as const) {
        await expectChainError(h.exec(h.issuer, cmd), 'Unauthorized');
      }
      // the one verifier key is the last of its kind, though two attestor keys are active (each kind counts its own)
      await refused(h, h.exec(h.admin, { kind: 'revokeVerifierKey', key: v1 }), name('lastKey'), code('lastKey'));
      await refused(h, h.exec(h.admin, { kind: 'revokeVerifierKey', key: v2 }), name('revokeUnknown'), code('revokeUnknown'));
      const reg = await h.exec(h.admin, { kind: 'registerVerifierKey', key: v2 });
      expect(reg.events.map((e) => [e.type, e.payload])).toEqual([['VerifierKeyRegistered', { verifierKey: v2 }]]);
      const t = await h.sim.now();
      const rv = await h.exec(h.admin, { kind: 'revokeVerifierKey', key: v1 });
      expect(rv.events.map((e) => [e.type, e.payload])).toEqual([['VerifierKeyRevoked', { verifierKey: v1, revokedAt: t }]]);
      expect(await h.sim.getSignerKey('verifier', v1)).toEqual({ kind: 'verifier', address: v1, active: false, revokedAt: t, graceUntil: t + KEY_GRACE_SECONDS });
      await refused(h, h.exec(h.admin, { kind: 'revokeVerifierKey', key: v1 }), name('revokeRevoked'), code('revokeRevoked'));
      await refused(h, h.exec(h.admin, { kind: 'revokeVerifierKey', key: v2 }), name('lastKey'), code('lastKey'));
      // rotate v2 → v3: one transaction, registration then revocation; a refused revoke undoes the registration
      const rot = await h.exec(h.admin, { kind: 'rotateVerifierKey', from: v2, to: v3 });
      expect(rot.events.map((e) => [e.type, e.payload])).toEqual([['VerifierKeyRegistered', { verifierKey: v3 }], ['VerifierKeyRevoked', { verifierKey: v2, revokedAt: await h.sim.now() }]]);
      await refused(h, h.exec(h.admin, { kind: 'rotateVerifierKey', from: v2, to: v1 }), name('revokeRevoked'), code('revokeRevoked'));
      expect((await h.sim.getSignerKey('verifier', v1))!.active).toBe(false);
      // re-registering a revoked key clears its revocation; an active one: Solana re-emits, the EVM refuses
      await h.exec(h.admin, { kind: 'registerVerifierKey', key: v1 });
      expect(await h.sim.getSignerKey('verifier', v1)).toEqual({ kind: 'verifier', address: v1, active: true, revokedAt: null, graceUntil: null });
      if (personality === 'solana') expect((await h.exec(h.admin, { kind: 'registerVerifierKey', key: v1 })).events.map((e) => e.type)).toEqual(['VerifierKeyRegistered']);
      else await refused(h, h.exec(h.admin, { kind: 'registerVerifierKey', key: v1 }), 'KeyAlreadyActive', 'Duplicate');
    });
  }
});

describe('revocation grace on the signed paths (S4-REG; Stage 1 SPEC §1.4, SIM:332-338)', () => {
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
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a }); // cause S4-T3
      expect(command.attestation!.signer).toBe(a.address);
      const r = await h.exec(h.issuer, command); // cause S4-T3: no co-signer
      expect(types(r.events)).toContain('ReportAccepted');
    }
    // one second past the grace: refused
    {
      const { h, seriesId, privateTerms } = await settled();
      const a = h.attestors[0]!;
      await h.sim.setTime(q1.end + DAY);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(q1.end + DAY + KEY_GRACE_SECONDS + 1);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a }); // cause S4-T3
      await refused(h, h.exec(h.issuer, command), 'InvalidAttestorSignature', 'InvalidAttestation');
    }
    // revoked before the period ended: never usable for it (forward-only), even within 45 days
    {
      const { h, seriesId, privateTerms } = await settled();
      const a = h.attestors[0]!;
      await h.sim.setTime(q1.end - DAY);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(q1.end + DAY);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: a }); // cause S4-T3
      await refused(h, h.exec(h.issuer, command), 'InvalidAttestorSignature', 'InvalidAttestation');
    }
  });

  it('tier 2: a verifier key revoked after the period ended still signs its report until revokedAt + 45 days; one revoked before may not (S4-T2)', async () => {
    const q1 = parsePeriod('2026Q1');
    for (const [revokeAt, sendAt, ok] of [[q1.end, q1.end + KEY_GRACE_SECONDS, true], [q1.end, q1.end + KEY_GRACE_SECONDS + 1, false], [q1.end - 1, q1.end + DAY, false]] as const) {
      const { h, seriesId, privateTerms } = await settled();
      await h.exec(h.admin, { kind: 'registerVerifierKey', key: SimSigner.verifier('verifier-2').address });
      await h.sim.setTime(revokeAt);
      await h.exec(h.admin, { kind: 'revokeVerifierKey', key: h.verifier.address });
      await h.sim.setTime(sendAt);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
      expect(command.attestation!.signer).toBe(h.verifier.address);
      if (ok) expect(types((await h.exec(h.issuer, command)).events)).toContain('ReportAccepted');
      else {
        await refused(h, h.exec(h.issuer, command), 'InvalidVerifierSignature', 'InvalidAttestation');
        // the other, active key signs the same report
        const { command: again } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), verifier: SimSigner.verifier('verifier-2') });
        expect(types((await h.exec(h.issuer, again)).events)).toContain('ReportAccepted');
      }
    }
  });

  it('FX fallback: the same grace (both chains; Stage 1\'s reference gives none, DIV-S1I-3)', async () => {
    // cause S4-FX: the attestor's per-series FX signature (was `attestorRate`, co-signed); inside the grace, at its last
    // second, one second past it, and revoked before the period ended
    const q1 = parsePeriod('2026Q1');
    const rate = wadFromDecimal('1.08');
    const cases = [[q1.end + DAY, q1.end + 2 * DAY, true], [q1.end + DAY, q1.end + DAY + KEY_GRACE_SECONDS, true], [q1.end + DAY, q1.end + DAY + KEY_GRACE_SECONDS + 1, false], [q1.end - DAY, q1.end + DAY, false]] as const;
    for (const [revokeAt, sendAt, ok] of cases) {
      const { h, seriesId, privateTerms } = await settled({ terms: { reportingCurrency: 'EUR' } });
      const a = h.attestors[1]!;
      await h.sim.setTime(revokeAt);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a.address });
      await h.sim.setTime(sendAt);
      const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), pair: 'EUR/USD', fxAvgWad: rate, fxFallback: a });
      expect(command.fxFallback!.signer).toBe(a.address);
      if (ok) expect(types((await h.exec(h.issuer, command as Report)).events)).toContain('ReportAccepted');
      else {
        await refused(h, h.exec(h.issuer, command as Report), 'InvalidAttestorSignature', 'InvalidAttestation');
        // the active attestor signs the same rate for the series instead
        const { command: again } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), pair: 'EUR/USD', fxAvgWad: rate, fxFallback: h.attestors[0]! });
        expect(types((await h.exec(h.issuer, again as Report)).events)).toContain('ReportAccepted');
      }
    }
  });

  it('pause approval, amendment and extinguishment need an active key: no grace', async () => {
    const { h, seriesId, terms } = await settled();
    const [a1, a2] = h.attestors as [SimAttestor, SimAttestor]; // cause S4-ID: the harness attestors are keys (SimAttestor)
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 30 * DAY });
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a1.address });
    // cause S4-PAU: the revoked key's PAUSE signature, relayed by the keeper (approvePause is permissionless since S4 WP10)
    await refused(h, h.sim.submit(await h.pauseApproval(seriesId, now + 30 * DAY, a1), 'keeper'), 'InvalidAttestorSignature');
    // cause S4-AMD: the revoked key's AMEND signature in the issuer's amendTerms (was a1 co-signing)
    await refused(h, h.exec(h.issuer, await h.amendment(seriesId, { termsCommitment: terms.termsCommitment, capMultipleWad: terms.capMultipleWad }, a1)), 'InvalidAttestorSignature');
    await refused(h, h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]), 'InvalidAttestorSignature');
    // the active key still approves
    expect(types((await h.sim.submit(await h.pauseApproval(seriesId, now + 30 * DAY, a2), 'keeper')).events)).toContain('PauseApproved'); // cause S4-PAU
  });
});
