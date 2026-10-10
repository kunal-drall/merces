import { describe, expect, it } from 'vitest';
import { parsePeriod } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { seedLedger, seedPause, seriesOf } from './kit.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';

const DAY = 86_400;
const YEAR = 365 * DAY;

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
    // a second request is not refused; the advisory end is replaced
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 20 * DAY });
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ requested: true, nonce: 2, requestedUntil: now + 20 * DAY, count: 0, current: null });
    expect(seriesOf(h.sim, seriesId).ledger.pauseRequestedAt).toBe(BigInt(now));
    // the chain does not hold the attestor to the advisory end (the attestor service does)
    const ap = await h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + 30 * DAY });
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.pauses).toMatchObject({ requested: false, requestedUntil: null, nonce: 2, count: 1, current: { start: now, end: now + 30 * DAY } });
    // a request while paused is accepted (Stage 1 does not refuse it); approving it is AlreadyPaused
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 40 * DAY });
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + 40 * DAY }), 'AlreadyPaused');
    // terminal (derived) status
    seriesOf(h.sim, seriesId).status = 'Retired';
    await expectStage1Error(h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 50 * DAY }), 'TerminalStatus');
  });

  it('approve: an active attestor, a pending request and Stage 1 bounds; pausedTotal counts the whole pause at approval', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = parsePeriod('2026Q1').end + 10 * DAY;
    await h.sim.setTime(now);
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + DAY }), 'PauseNotRequested');
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 90 * DAY });
    await expectStage1Error(h.exec(h.backers[0]!, { kind: 'approvePause', seriesId, until: now + DAY }), 'InvalidAttestorSignature');
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now }), 'InvalidPauseEnd');
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + YEAR + 1 }), 'PauseTooLong');
    // cumulative bound: 2 years in total
    seedLedger(h.sim, seriesId, { pausedTotal: BigInt(2 * YEAR - 10 * DAY) });
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + 11 * DAY }), 'PauseTooLong');
    seedLedger(h.sim, seriesId, { pausedTotal: 0n });
    // at most 16 pauses (seeded as one-second pauses before settlement, so no countdown moves)
    for (let i = 0; i < 16; i++) seedPause(h.sim, seriesId, GENESIS + 2 * i, GENESIS + 2 * i + 1);
    seedLedger(h.sim, seriesId, { pauseRequested: true });
    await expectStage1Error(h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: now + DAY }), 'TooManyPauses');
    seedLedger(h.sim, seriesId, { pauses: [], pausedTotal: 0n });
    // every refusal left the request pending
    expect(seriesOf(h.sim, seriesId).ledger.pauseRequested).toBe(true);
    const ap = await h.exec(h.attestors[1]!, { kind: 'approvePause', seriesId, until: now + 90 * DAY });
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    expect(ap.events[0]!.payload).toMatchObject({ attestor: h.attestors[1]!.address, until: now + 90 * DAY });
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
    await h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until });
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
    const ap = await h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until: q1.end + 80 * DAY });
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
});
