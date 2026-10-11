import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { ChainError, KEY_GRACE_SECONDS, type PermissionlessCommand } from '@merces/domain';
import { SimHarness, SimSigner, defaultTerms, personalitySigning, serialiseState, type HarnessKey } from '../src/index.ts';
import { seedLedger, seedPause, seriesOf } from './kit.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

const DAY = 86_400;
const YEAR = 365 * DAY;
type Approval = Extract<PermissionlessCommand, { kind: 'approvePause' }>;

/** cause S4-PAU: an attestor key's PAUSE signature over the live nonce, relayed by the keeper (anyone may send it). */
async function approve(h: SimHarness, seriesId: string, pauseEnd: number, key: HarnessKey = h.attestors[0]!) {
  return h.sim.submit(await h.pauseApproval(seriesId, pauseEnd, key), 'keeper');
}

/** The transaction is refused with Stage 1 error `name`, leaving the chain's state and event log as they were. */
async function refused(h: SimHarness, tx: Promise<unknown>, name: string, message?: RegExp): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx.then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  if (message) expect((e as ChainError).message).toMatch(message);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

/*
 * S4 cause codes on the pins that moved:
 *  - S4-CTX: the pause nonce is `SeriesState.nonces.pause`, a u64 decimal string, beside the other signing nonces (S4 D7;
 *    was `pauses.nonce`, a number).
 *  - S4-PAU: `approvePause` is Stage 1's: permissionless, carrying an attestor key's PAUSE signature over the live pause
 *    nonce and the end (`h.pauseApproval`; S4 WP10, D8), sent here by the keeper; was the attestor's wallet sending
 *    `{until}`. `pauseEnd` is a decimal string; `PauseRequested` carries the nonce, `PauseApproved` the start.
 *  - S4-WD: `withdrawPauseRequest` (Stage 1 `withdraw_pause_request`) clears the request and advances the nonce.
 */

describe('hardship pause (Stage 1 request_pause / approve_pause)', () => {
  it('request: issuer only, settled and not terminal; repeatable, also while paused; `until` is advisory', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const draft = (created.events.find((e) => e.type === 'SeriesCreated')!.payload as { seriesId: string }).seriesId;
    await expectStage1Error(h.exec(h.issuer, { kind: 'requestPause', seriesId: draft, until: GENESIS + 30 * DAY }), 'RaiseNotSettled');
    const { seriesId } = await h.runRaise();
    const now = await h.sim.now();
    await expectStage1Error(h.exec(h.backers[0]!, { kind: 'requestPause', seriesId, until: now + 10 * DAY }), 'NotIssuer');
    const r1 = await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 10 * DAY });
    expect(types(r1.events)).toEqual(['PauseRequested']);
    expect(r1.events[0]!.payload).toEqual({ seriesId, until: now + 10 * DAY, nonce: '1' }); // cause S4-PAU: the event carries the new nonce
    // a second request is not refused; the advisory end is replaced
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 20 * DAY });
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ requested: true, requestedUntil: now + 20 * DAY, count: 0, current: null });
    expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('2'); // cause S4-CTX: each request advances it
    expect(seriesOf(h.sim, seriesId).ledger.pauseRequestedAt).toBe(BigInt(now));
    // the chain does not hold the attestor to the advisory end (the attestor service does)
    const ap = await approve(h, seriesId, now + 30 * DAY); // cause S4-PAU
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ requested: false, requestedUntil: null, count: 1, current: { start: now, end: now + 30 * DAY } });
    expect(seriesOf(h.sim, seriesId).ledger.pauseRequestedAt).toBe(0n); // cleared with the request, as both chains do
    expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('2'); // cause S4-CTX: an approval does not advance it (SIM:650-670)
    // a request while paused is accepted (Stage 1 does not refuse it); approving it is AlreadyPaused
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 40 * DAY });
    await expectStage1Error(approve(h, seriesId, now + 40 * DAY), 'AlreadyPaused'); // cause S4-PAU
    // terminal (derived) status
    seriesOf(h.sim, seriesId).status = 'Retired';
    await expectStage1Error(h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 50 * DAY }), 'TerminalStatus');
  });

  it('approve: an active attestor\'s PAUSE signature, a pending request and Stage 1 bounds; pausedTotal counts the whole pause at approval', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = parsePeriod('2026Q1').end + 10 * DAY;
    await h.sim.setTime(now);
    await expectStage1Error(approve(h, seriesId, now + DAY), 'PauseNotRequested'); // cause S4-PAU (here and below)
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
    // a key that is not an attestor (the report verifier's) signs: InvalidAttestorSignature (was a backer's wallet sending it)
    await expectStage1Error(approve(h, seriesId, now + DAY, h.verifier), 'InvalidAttestorSignature');
    await expectStage1Error(approve(h, seriesId, now), 'InvalidPauseEnd');
    await expectStage1Error(approve(h, seriesId, now + YEAR + 1), 'PauseTooLong');
    // cumulative bound: 2 years in total
    seedLedger(h.sim, seriesId, { pausedTotal: BigInt(2 * YEAR - 10 * DAY) });
    await expectStage1Error(approve(h, seriesId, now + 11 * DAY), 'PauseTooLong');
    seedLedger(h.sim, seriesId, { pausedTotal: 0n });
    // at most 16 pauses (seeded as one-second pauses before settlement, so no countdown moves)
    for (let i = 0; i < 16; i++) seedPause(h.sim, seriesId, GENESIS + 2 * i, GENESIS + 2 * i + 1);
    seedLedger(h.sim, seriesId, { pauseRequested: true });
    await expectStage1Error(approve(h, seriesId, now + DAY), 'TooManyPauses');
    seedLedger(h.sim, seriesId, { pauses: [], pausedTotal: 0n });
    // every refusal left the request pending
    expect(seriesOf(h.sim, seriesId).ledger.pauseRequested).toBe(true);
    const ap = await approve(h, seriesId, now + 90 * DAY, h.attestors[1]!);
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    // cause S4-PAU: the signing key (not the sender, the keeper) and the pause's start, as both chains emit them
    expect(ap.events[0]!.payload).toEqual({ seriesId, attestor: h.attestors[1]!.address, start: now, until: now + 90 * DAY });
    const l = seriesOf(h.sim, seriesId).ledger;
    expect(l.pauses).toEqual([{ start: BigInt(now), end: BigInt(now + 90 * DAY) }]);
    expect(l.pausedTotal).toBe(BigInt(90 * DAY));
    expect(l.pauseRequested).toBe(false);
    expect(l.pauseNonce).toBe(1n);
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.status).toBe('Paused');
    expect(s.pausedSecondsTotal).toBe(90 * DAY);
  });

  it('ends by itself at its end, deadlines move by the paused time, crankPause only announces the end', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 10 * DAY);
    const until = q1.end + 100 * DAY;
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until });
    await approve(h, seriesId, until); // cause S4-PAU
    // 60 days later: without the pause Q1 would be Late; Paused instead, the period Deferred, deadlines past the pause
    await h.sim.setTime(q1.end + 70 * DAY);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    const r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toHaveLength(0);
    let per = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    expect(per.standing).toBe('Deferred');
    expect(BigInt(per.accrual)).toBe(0n);
    await expectChainError(h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper'), 'TooEarly');
    // at its end the pause is over with no transaction: the derived status is current again (10 unpaused days)
    await h.sim.setTime(until);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    expect((await h.sim.getSeries(seriesId))!.pauses.current).toBeNull();
    expect(seriesOf(h.sim, seriesId).status).toBe('Paused'); // stored until the next sync point
    per = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    // due shifted by the 90 paused days: end + 30 days → end + 120 days; notice end + 90 → end + 180 days
    expect([per.dueAt, per.graceEndsAt, per.formalNoticeAt]).toEqual([q1.end + 120 * DAY, q1.end + 135 * DAY, q1.end + 180 * DAY]);
    expect(per.standing).toBe('OnTime');
    const ended = await h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper');
    expect(types(ended.events)).toEqual(['PauseEnded', 'StatusChanged']);
    expect(ended.events[0]!.payload).toMatchObject({ pausedSeconds: 90 * DAY });
    expect(seriesOf(h.sim, seriesId).status).toBe('OnTime');
    await expectStage1Error(h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper'), 'NotPaused');
    // paying now carries no accrual
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    expect(res.due).toBe(USDC(4000));
    expect(res.paid).toBe(USDC(4000));
  });

  it('a pause approved while Late keeps releases blocked (late underneath); paying the arrears lifts the block', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    const first = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    expect(types(first.events)).toEqual(['FundsReleased']);
    await h.sim.setTime(q1.end + 50 * DAY);
    expect(types((await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper')).events)).toEqual(['StatusChanged', 'ReleasesPaused']);
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: q1.end + 80 * DAY });
    const ap = await approve(h, seriesId, q1.end + 80 * DAY); // cause S4-PAU
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']); // still blocked: no release event
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    expect((await h.sim.getTreasury(seriesId))!.paused).toBe(true);
    // the second tranche vested 90 days after settlement; Paused does not lift the block
    await h.sim.setTime(q1.end + 60 * DAY);
    await expectStage1Error(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'SeriesLate');
    // pay the arrears mid-pause: countdown frozen at 50 days → 5 late days of accrual; the block lifts, still Paused
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    expect(res.paid - res.due).toBe((USDC(4000) * 8n * 5n) / (100n * 365n));
    expect(types(res.events).slice(-3)).toEqual(['FeeTaken', 'PaymentReceived', 'ReleasesResumed']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
    const second = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    expect(types(second.events)).toEqual(['FundsReleased']);
    expect(second.events[0]!.payload).toMatchObject({ trancheIndex: 1, amount: USDC(1125).toString() });
    await expectStage1Error(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'NothingVested');
  });

  // cause S4-PAU (S4 WP10, D8): the PAUSE signature binds the domain, the series key, the live nonce and the end; the
  // sender is anyone. Each refusal leaves the state and the event log as they were.
  it('approve is Stage 1\'s signed, permissionless approve_pause: range first, then the signature over the live nonce, then the request', async () => {
    for (const personality of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId } = await h.runRaise();
      const other = (await h.runRaise()).seriesId;
      const now = parsePeriod('2026Q1').end + 10 * DAY;
      await h.sim.setTime(now);
      await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
      await h.exec(h.issuer, { kind: 'requestPause', seriesId: other, until: now + 90 * DAY });
      const end = now + 30 * DAY;
      const good = await h.pauseApproval(seriesId, end);
      const [series] = [(await h.sim.getSeries(seriesId))!];
      // 2^64 is AmountOutOfRange before any recovery: the signature is a placeholder the chain never looks at (the EVM's
      // toU64 first; no message can encode 2^64), and so is u64::MAX + 1 with a valid signature for another end
      await refused(h, h.sim.submit({ ...good, pauseEnd: (1n << 64n).toString(), signature: '0x' + '00'.repeat(65) }, 'keeper'), 'AmountOutOfRange');
      await refused(h, h.sim.submit({ ...good, pauseEnd: (1n << 64n).toString() }, 'keeper'), 'AmountOutOfRange');
      // the signature binds the end: another end recovers to another address
      await refused(h, h.sim.submit({ ...good, pauseEnd: String(end + 1) }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another series' key (the same issuer's other series, also requested at nonce 1): no replay across series
      await refused(h, h.sim.submit({ ...(await h.pauseApproval(other, end)), seriesId }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another chain's domain (the other personality's simulator)
      const foreign = personalitySigning(personality === 'solana' ? 'monad' : 'solana', personality === 'solana' ? 'monad' : 'solana');
      const elsewhere = await h.attestors[0]!.attest('PAUSE', foreign, series.seriesKey, { pauseNonce: series.nonces.pause, pauseEnd: String(end) });
      await refused(h, h.sim.submit({ ...good, signature: elsewhere.signature }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another nonce (a signature made for a request that is not the live one)
      await refused(h, h.sim.submit(await h.pauseApproval(seriesId, end, h.attestors[0]!, { pauseNonce: '0' }), 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // the named attestor must be the signer; a key that is no attestor; a non-canonical (high-s) signature
      await refused(h, h.sim.submit({ ...good, attestor: h.attestors[1]!.address }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.sim.submit(await h.pauseApproval(seriesId, end, SimSigner.attestor('never-registered')), 'keeper'), 'InvalidAttestorSignature', /not a usable attestor key/);
      const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
      const sHigh = (n - BigInt('0x' + good.signature.slice(66, 130))).toString(16).padStart(64, '0');
      const flipV = good.signature.slice(130) === '1b' ? '1c' : '1b';
      await refused(h, h.sim.submit({ ...good, signature: good.signature.slice(0, 66) + sHigh + flipV }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // the schema takes a 65-byte hex signature and a 20-byte attestor; the end is a decimal string
      for (const bad of [{ ...good, signature: 'sim:' + h.attestors[0]!.address }, { ...good, attestor: h.backers[0]!.address }, { ...good, pauseEnd: end }, { ...good, pauseEnd: '-1' }]) {
        await expect(h.sim.submit(bad as unknown as Approval, 'keeper')).rejects.toThrow();
      }
      // the signer and the sender are independent: a backer's wallet sends the attestor's signature
      const ap = await h.exec(h.backers[0]!, good);
      expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
      expect(ap.events[0]!.payload).toEqual({ seriesId, attestor: h.attestors[0]!.address, start: now, until: end });
      // an approval leaves the nonce as it is (the cleared request is what blocks a replay): a replay is PauseNotRequested
      expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('1');
      await refused(h, h.sim.submit(good, 'keeper'), 'PauseNotRequested');
      // the other series' request is untouched
      expect((await h.sim.getSeries(other))!.pauses.requested).toBe(true);
    }
  });

  it('a re-request or a withdrawal advances the nonce: a signature collected before it is dead', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = parsePeriod('2026Q1').end + 10 * DAY;
    await h.sim.setTime(now);
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
    const before = await h.pauseApproval(seriesId, now + 30 * DAY);
    // the issuer requests again (nonce 1 → 2): the collected signature recovers to another address
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 60 * DAY });
    await refused(h, h.sim.submit(before, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
    // cause S4-WD: the issuer withdraws (nonce 2 → 3): a signature over nonce 2 is dead too
    const atTwo = await h.pauseApproval(seriesId, now + 30 * DAY);
    await refused(h, h.exec(h.backers[0]!, { kind: 'withdrawPauseRequest', seriesId }), 'NotIssuer');
    const wd = await h.exec(h.issuer, { kind: 'withdrawPauseRequest', seriesId });
    expect(types(wd.events)).toEqual(['PauseRequestWithdrawn']);
    expect(wd.events[0]!.payload).toEqual({ seriesId, nonce: '3' }); // the new nonce, as the EVM and the reference emit it
    const l = seriesOf(h.sim, seriesId).ledger;
    expect([l.pauseRequested, l.pauseRequestedAt, l.pauseRequestedUntil, l.pauseNonce]).toEqual([false, 0n, null, 3n]);
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ requested: false, requestedUntil: null, count: 0 });
    expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('3');
    await refused(h, h.sim.submit(atTwo, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
    // a signature over the live nonce after the withdrawal recovers, and finds no request: PauseNotRequested
    await refused(h, h.sim.submit(await h.pauseApproval(seriesId, now + 30 * DAY), 'keeper'), 'PauseNotRequested');
    // nothing to withdraw now
    await refused(h, h.exec(h.issuer, { kind: 'withdrawPauseRequest', seriesId }), 'PauseNotRequested');
    // a new request (nonce 4) is approved with a signature over it
    const r = await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 60 * DAY });
    expect(r.events[0]!.payload).toMatchObject({ nonce: '4' });
    expect(types((await approve(h, seriesId, now + 30 * DAY)).events)).toEqual(['PauseApproved', 'StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.nonces.pause).toBe('4');
    // the withdrawal is the issuer's whatever the status: a pending request while paused is withdrawn too
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
    expect(types((await h.exec(h.issuer, { kind: 'withdrawPauseRequest', seriesId })).events)).toEqual(['PauseRequestWithdrawn']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Paused');
  });

  it('a revoked attestor key cannot approve, inside the report grace or not: a PAUSE needs an active key', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = parsePeriod('2026Q1').end + 10 * DAY;
    await h.sim.setTime(now);
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
    const signed = await h.pauseApproval(seriesId, now + 30 * DAY);
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: h.attestors[0]!.address });
    await h.sim.setTime(now + 1);
    expect(now + 1).toBeLessThan(now + KEY_GRACE_SECONDS);
    await refused(h, h.sim.submit(signed, 'keeper'), 'InvalidAttestorSignature', /not a usable attestor key/);
    expect(types((await approve(h, seriesId, now + 30 * DAY, h.attestors[1]!)).events)).toContain('PauseApproved');
  });
});
