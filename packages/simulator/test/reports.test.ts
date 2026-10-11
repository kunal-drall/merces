import { afterAll, describe, expect, it } from 'vitest';
import { verifyReport } from '@merces/circuits';
import { ChainError, ZERO_INCOME_COMMITMENT, attestationOf, incomeCommitment, mockProve, reportDigest, reportPublicInputs, type UserCommand } from '@merces/domain';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, SimSigner, SimulatorChain, defaultTerms, harnessFieldSalt, personalitySigning, serialiseState, type SimWallet } from '../src/index.ts';
import { GENESIS, USDC } from './helpers.ts';

/**
 * `submitReport` in Stage 1's order (S1 plan WP3 table; Stage 1 simulator SIM:1050-1149): one case per check, in
 * order, each refused with Stage 1's error name and leaving the chain untouched; then the prior chain and the effects.
 *
 * S4 cause codes:
 *  - S4-T2: tier 2 is Stage 1's REPORT signature (secp256k1 over `MERCES_REPORT_V1` with the chain's domain and the series
 *    key) by a registered verifier key, recovered and checked as both chains do (was ed25519 attestation v1 by key id).
 */

type Report = Extract<UserCommand, { kind: 'submitReport' }>;

async function settled(opts: Parameters<SimHarness['runRaise']>[0] = {}, genesis = GENESIS) {
  const h = await SimHarness.create('monad', { genesis });
  const raise = await h.runRaise(opts);
  return { h, ...raise };
}

/** The transaction is refused with Stage 1 error `name`, and the chain's state and event log are unchanged. */
async function refused(h: SimHarness, tx: () => Promise<unknown>, name: string, message?: RegExp): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx().then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  if (message) expect((e as ChainError).message).toMatch(message);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

/** The same report with other public signals and an honest mock proof over them. */
function withSignals(cmd: Report, signals: string[]): Report {
  return { ...cmd, proof: { system: 'mock', proof: mockProve(signals), publicInputs: signals } };
}

const send = (h: SimHarness, cmd: Report, co: SimWallet[] = [], who: SimWallet = h.issuer) => () => h.exec(who, cmd, co);

describe('submitReport checks, in Stage 1 order', () => {
  it('1-3: issuer, settled raise, entry ranges', async () => {
    const { h, seriesId, privateTerms } = await settled();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, command, [], h.backers[0]!), 'NotIssuer');
    // a second series of the same issuer, still in Draft
    const draft = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const draftId = (draft.events[0]!.payload as { seriesId: string }).seriesId;
    await refused(h, send(h, { ...command, seriesId: draftId }), 'RaiseNotSettled');
    await refused(h, send(h, { ...command, paymentStable: (1n << 64n).toString() }), 'AmountOutOfRange');
    await refused(h, send(h, { ...command, fxAvgWad: (1n << 64n).toString() }), 'AmountOutOfRange');
    await refused(h, send(h, { ...command, incomeCommitment: '0x' + 'ff'.repeat(32) }), 'InvalidProof', /field element/);
    await refused(h, send(h, { ...command, priorIncomeCommitment: '0x' + 'ff'.repeat(32) }), 'InvalidProof', /field element/);
    await h.exec(h.issuer, command); // the untouched report is fine
  });

  it('5: a Retired or Extinguished series takes no report', async () => {
    const { h, seriesId, privateTerms } = await settled();
    await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, command), 'TerminalStatus');
  });

  it('6-9: the next expected period only, after it ends, with nothing outstanding, once', async () => {
    const { h, seriesId, privateTerms } = await settled();
    const q1 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, q1.command), 'ReportTooEarly');
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const q2early = await h.buildReport({ seriesId, periodId: '2026Q2', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, q2early.command), 'WrongPeriod', /2026Q1/);
    await h.exec(h.issuer, q1.command); // 4,000 due, left unpaid
    const q2 = await h.buildReport({ seriesId, periodId: '2026Q2', privateTerms, incomeYtdNow: USDC(120_000) });
    await refused(h, send(h, q2.command), 'PaymentOutstanding');
    // the same report again: the period is no longer the next one
    await refused(h, send(h, q1.command), 'WrongPeriod');
    const live = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: (BigInt(live.paymentDue) - BigInt(live.paid)).toString() });
    await h.exec(h.issuer, q2.command);
  });

  it('10: tail reports end a year after the redemption (TailEnded)', async () => {
    const { h, seriesId, terms, privateTerms } = await settled({ terms: { lockupSeconds: 30 * 86_400 } });
    await h.sim.setTime(Date.UTC(2026, 1, 10) / 1000);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    // reports after a redemption are tail reports: without a liquidity event nothing is due, the chain advances
    for (const q of ['2026Q1', '2026Q2', '2026Q3', '2026Q4', '2027Q1']) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      const r = await h.reportAndPay(seriesId, q, privateTerms, terms.termsCommitment, 0n, USDC(50_000));
      expect([r.due, r.paid]).toEqual([0n, 0n]);
    }
    await h.sim.setTime(parsePeriod('2027Q2').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2027Q2', privateTerms, incomeYtdNow: USDC(50_000) });
    await refused(h, send(h, command), 'TailEnded');
  });

  it('11: the tier must be enabled, and tier 1 needs a pure tier-1 series', async () => {
    const { h, seriesId, privateTerms } = await settled({ terms: { tierFlags: { tier1: true, tier2: true, tier3: false, tier4: false } } });
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const t3 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: h.attestors[0]!.address });
    await refused(h, send(h, t3.command, [h.attestors[0]!]), 'TierNotEnabled', /tier 3/);
    const t1 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 1 });
    await refused(h, send(h, t1.command), 'TierNotEnabled', /pure tier-1/);
  });

  it('12: FX (FxMismatch, FxFallbackNotAllowed, FxFallbackRequired, attestor co-signature)', async () => {
    const usd = await settled();
    await usd.h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const notWad = await usd.h.buildReport({ seriesId: usd.seriesId, periodId: '2026Q1', privateTerms: usd.privateTerms, incomeYtdNow: USDC(100_000), fxAvgWad: WAD + 1n });
    await refused(usd.h, send(usd.h, notWad.command), 'FxMismatch');
    const ok = await usd.h.buildReport({ seriesId: usd.seriesId, periodId: '2026Q1', privateTerms: usd.privateTerms, incomeYtdNow: USDC(100_000) });
    const a1 = usd.h.attestors[1]!;
    await refused(usd.h, send(usd.h, { ...ok.command, fxBasis: 'attestor', attestorRate: { attestor: a1.address, rateWad: WAD.toString(), pair: 'USD/USD' } }, [a1]), 'FxFallbackNotAllowed');

    const eur = await settled({ terms: { reportingCurrency: 'EUR' } });
    await eur.h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const rate = wadFromDecimal('1.08');
    const base = { seriesId: eur.seriesId, periodId: '2026Q1', privateTerms: eur.privateTerms, incomeYtdNow: USDC(100_000), pair: 'EUR/USD', fxAvgWad: rate };
    // no snapshots for the quarter: the accumulator cannot be used
    const acc = await eur.h.buildReport({ ...base, fxBasis: 'accumulator' });
    await refused(eur.h, send(eur.h, acc.command), 'FxFallbackRequired');
    const ea1 = eur.h.attestors[1]!;
    const att = await eur.h.buildReport({ ...base, fxBasis: 'attestor', attestorRate: { attestor: ea1.address, rateWad: rate, pair: 'EUR/USD' } });
    await refused(eur.h, send(eur.h, att.command), 'InvalidAttestorSignature');
    await refused(eur.h, send(eur.h, { ...att.command, attestorRate: { ...att.command.attestorRate!, rateWad: (rate + 1n).toString() } }, [ea1]), 'FxMismatch');
    await eur.h.exec(eur.h.issuer, att.command, [ea1]);
  });

  it('13-15: the prior chain, the six signals against the live terms, the proof', async () => {
    const { h, seriesId, terms, privateTerms } = await settled();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(70_000));
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q2', privateTerms, incomeYtdNow: USDC(100_000) });
    const signals = command.proof.publicInputs;
    // 13: an honest proof over a prior that does not chain (here: ZERO in Q2)
    const zeroPrior = [...signals.slice(0, 3), BigInt(ZERO_INCOME_COMMITMENT).toString(), ...signals.slice(4)];
    await refused(h, send(h, withSignals({ ...command, priorIncomeCommitment: ZERO_INCOME_COMMITMENT }, zeroPrior)), 'InvalidProof', /prior/);
    // 14: the command claims another payment than the proof; a proof over other terms (vector 14)
    await refused(h, send(h, { ...command, paymentStable: '1' }), 'InvalidProof', /public signals/);
    const otherTerms = [BigInt(incomeCommitment(1n, 1n)).toString(), ...signals.slice(1)];
    await refused(h, send(h, withSignals(command, otherTerms)), 'InvalidProof', /public signals/);
    await refused(h, send(h, withSignals(command, [...signals.slice(0, 1), '499', ...signals.slice(2)])), 'InvalidProof', /public signals/);
    // 15: the proof itself
    await refused(h, send(h, { ...command, proof: { system: 'mock', proof: '0x' + '00'.repeat(32), publicInputs: signals } }), 'InvalidProof', /mock proof does not verify/);
    const g16 = { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['5', '6', '1'], protocol: 'groth16' as const, curve: 'bn128' as const };
    await refused(h, send(h, { ...command, proof: { system: 'groth16-bn254', proof: g16, publicInputs: signals } }), 'InvalidProof', /no Groth16 verifier/);
    await h.exec(h.issuer, command);
  });

  it('15: mock proofs are refused unless the chain opts in', async () => {
    const sim = SimulatorChain.createSync({ personality: 'solana', genesis: GENESIS }); // acceptMockProofs defaults to false
    const h = await SimHarness.create('solana', { sim });
    const { seriesId, privateTerms } = await h.runRaise();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, command), 'InvalidProof', /not accepted/);
  });

  it('16: source binding after the proof (tier 2 the verifier key\'s REPORT signature, tier 3 the attestor co-signature)', async () => {
    // cause S4-T2: a signature recovered over Stage 1's REPORT digest (was an ed25519 attestation v1 named by key id)
    const { h, seriesId, privateTerms } = await settled();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    const a = command.attestation!;
    // the command carries the signer and the signature only: the fields are the report's own
    expect(Object.keys(a).sort()).toEqual(['signature', 'signer']);
    expect(a.signer).toBe(h.verifier.address);
    // the chain's digest: MERCES_REPORT_V1 over its signing domain and the series key, tier 2
    const series = (await h.sim.getSeries(seriesId))!;
    const digest = reportDigest({ domain: (await h.sim.info()).signing!.domain, seriesKey: series.seriesKey }, { periodId: '2026Q1', priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, tier: 2, liquidityEvent: false }).digest;
    expect(await h.verifier.signDigest(digest)).toBe(a.signature);
    await refused(h, send(h, { ...command, attestation: null }), 'InvalidVerifierSignature', /required/);
    // a key that is not a registered verifier key (04#68 signs a tier-2 report with an attestor key)
    const stranger = new SimSigner('sim-verifier:not-registered');
    const foreign = attestationOf(await h.attestReport(seriesId, { periodId: '2026Q1', priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, liquidityEvent: false }, stranger));
    await refused(h, send(h, { ...command, attestation: foreign }), 'InvalidVerifierSignature', /not a usable verifier key/);
    // the named signer must be the key that signed
    await refused(h, send(h, { ...command, attestation: { ...a, signer: stranger.address } }), 'InvalidVerifierSignature', /does not recover/);
    // the signature binds the liquidity flag and the commitments: changing one breaks it
    await refused(h, send(h, { ...command, liquidityEvent: true }), 'InvalidVerifierSignature', /does not recover/);
    // non-canonical signatures recover to nobody (the EVM's tryRecover): v outside {27, 28}, and high s
    await refused(h, send(h, { ...command, attestation: { ...a, signature: a.signature.slice(0, -2) + '1d' } }), 'InvalidVerifierSignature', /does not recover/);
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const sHigh = (n - BigInt('0x' + a.signature.slice(66, 130))).toString(16).padStart(64, '0');
    const flipV = a.signature.slice(130) === '1b' ? '1c' : '1b';
    await refused(h, send(h, { ...command, attestation: { ...a, signature: a.signature.slice(0, 66) + sHigh + flipV } }), 'InvalidVerifierSignature', /does not recover/);
    // a signature over another chain's domain (a solana simulator's) or another series' key does not recover to the key
    const otherDomain = personalitySigning('solana', 'solana');
    const elsewhere = await h.verifier.attest('REPORT', otherDomain, series.seriesKey, { periodId: '2026Q1', priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, tier: 2, liquidityEvent: false });
    await refused(h, send(h, { ...command, attestation: attestationOf(elsewhere) }), 'InvalidVerifierSignature', /does not recover/);
    const otherSeries = await h.verifier.attest('REPORT', (await h.sim.info()).signing!, '0x' + '00'.repeat(12) + '11'.repeat(20), { periodId: '2026Q1', priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, tier: 2, liquidityEvent: false });
    await refused(h, send(h, { ...command, attestation: attestationOf(otherSeries) }), 'InvalidVerifierSignature', /does not recover/);
    // tier 3 is still the attestor's co-signature (S4 WP9 moves it); a tier-3 report carries no attestation
    const t3 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), tier: 3, attestor: h.attestors[0]!.address });
    expect(t3.command.attestation).toBeNull();
    await refused(h, send(h, t3.command), 'InvalidAttestorSignature');
    await h.exec(h.issuer, t3.command, [h.attestors[0]!]);
  });
});

describe('the prior chain and the report effects', () => {
  it('chains Q1 → Q4 within a year and starts again from ZERO at the year boundary', async () => {
    const { h, seriesId, terms, privateTerms } = await settled();
    const ytd = [30_000, 70_000, 70_000, 110_000, 20_000].map(USDC);
    const quarters = ['2026Q1', '2026Q2', '2026Q3', '2026Q4', '2027Q1'];
    let last = ZERO_INCOME_COMMITMENT;
    for (const [i, q] of quarters.entries()) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      const r = await h.reportAndPay(seriesId, q, privateTerms, terms.termsCommitment, 0n, ytd[i]!);
      const accepted = r.events.find((e) => e.type === 'ReportAccepted')!.payload as { priorIncomeCommitment: string; incomeCommitment: string; paymentDue: string; accrual: string };
      expect(accepted.priorIncomeCommitment, q).toBe(q === '2027Q1' ? ZERO_INCOME_COMMITMENT : last);
      expect(accepted.accrual).toBe('0');
      expect((await h.sim.getPeriod(seriesId, q))!.priorIncomeCommitment).toBe(accepted.priorIncomeCommitment);
      expect((await h.sim.getSeries(seriesId))!.reporting.lastIncomeCommitment).toBe(accepted.incomeCommitment);
      last = accepted.incomeCommitment;
    }
    // payments follow the year-to-date figures: θ = 60k, 10% of the excess; Q3 has no new income
    const due = await Promise.all(quarters.map(async (q) => BigInt((await h.sim.getPeriod(seriesId, q))!.paid)));
    expect(due).toEqual([0n, USDC(1000), 0n, USDC(4000), 0n]);
  });

  it('accepts a supplied prior on a first report outside Q1 (A25)', async () => {
    const { h, seriesId, terms, privateTerms } = await settled({}, Date.UTC(2026, 3, 1) / 1000);
    expect((await h.sim.getSeries(seriesId))!.reporting.firstPeriod).toBe('2026Q2');
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    // the attested year-to-date figure at the start of 2026Q2 was 70k: the report owes on the 30k above it
    const r = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(70_000), USDC(100_000));
    const accepted = r.events.find((e) => e.type === 'ReportAccepted')!.payload as { priorIncomeCommitment: string };
    expect(accepted.priorIncomeCommitment).toBe(incomeCommitment(USDC(70_000), harnessFieldSalt(`${seriesId}:attested-prior`)));
    expect(r.due).toBe(USDC(3000));
    // the next quarter chains from it
    await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    const q3 = await h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, 0n, USDC(110_000));
    expect(q3.due).toBe(USDC(1000));
  });

  it('opens the due on the ledger, and a payment closes it; a zero due settles at once', async () => {
    const { h, seriesId, privateTerms } = await settled();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const q1 = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(50_000) });
    await h.exec(h.issuer, q1.command);
    let ledger = h.sim.stage1View(seriesId).ledger;
    expect([ledger.lastAcceptedPeriod, ledger.lastPaidPeriod, ledger.openDuePeriod, ledger.openDueAmount]).toEqual(['8104', '8104', null, '0']);
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.settled).toBe(true);
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const q2 = await h.buildReport({ seriesId, periodId: '2026Q2', privateTerms, incomeYtdNow: USDC(100_000) });
    await h.exec(h.issuer, q2.command);
    ledger = h.sim.stage1View(seriesId).ledger;
    expect([ledger.lastAcceptedPeriod, ledger.lastPaidPeriod, ledger.openDuePeriod, ledger.openDueAmount]).toEqual(['8105', '8104', '8105', USDC(4000).toString()]);
    await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q2', amount: USDC(4000).toString() });
    ledger = h.sim.stage1View(seriesId).ledger;
    expect([ledger.lastPaidPeriod, ledger.openDuePeriod, ledger.openDueAmount]).toEqual(['8105', null, '0']);
  });

  it('applies the high-water rule: a year-to-date figure below the prior is reported at the prior', async () => {
    const { h, seriesId, terms, privateTerms } = await settled();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(90_000));
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    // a refund lowered the real figure; the attested figure stays at 90k and nothing more is owed
    const r = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 0n, USDC(80_000));
    expect(r.due).toBe(0n);
  });
});

describe('Groth16 report proofs', () => {
  afterAll(async () => {
    // snarkjs keeps a multithreaded curve alive on globalThis (proof-path reader §3)
    const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null };
    await g.curve_bn128?.terminate?.();
  });

  it('verifies a real proof before the engine runs, and refuses a tampered one', async () => {
    const sim = SimulatorChain.createSync({ personality: 'monad', genesis: GENESIS, reportProofVerifier: { verify: (proof, signals) => verifyReport(proof as never, signals) } });
    const h = await SimHarness.create('monad', { sim });
    const { seriesId, privateTerms } = await h.runRaise();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000), proofs: 'groth16' });
    expect(command.proof.system).toBe('groth16-bn254');
    expect(command.proof.publicInputs).toEqual(reportPublicInputs({ termsCommitment: (await h.sim.getSeries(seriesId))!.terms.termsCommitment, unitsOutstanding: 500n, fxAvgWad: WAD, priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: command.incomeCommitment, paymentStable: command.paymentStable }));
    if (command.proof.system !== 'groth16-bn254') throw new Error('unreachable');
    const tampered = { ...command, proof: { ...command.proof, proof: { ...command.proof.proof, pi_a: [command.proof.proof.pi_c[0]!, command.proof.proof.pi_c[1]!, '1'] } } };
    await refused(h, send(h, tampered), 'InvalidProof', /does not verify/);
    // a mock proof on this chain (no opt-in) is refused too
    const mock = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: USDC(100_000) });
    await refused(h, send(h, mock.command), 'InvalidProof', /not accepted/);
    const ok = await h.exec(h.issuer, command);
    expect(ok.events[0]!.type).toBe('ReportAccepted');
  });
});
