import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeProofForSolana, negateG1, verifyReport } from '@merces/circuits';
import { ZERO_INCOME_COMMITMENT, attestationOf, reportPublicInputs, termsCommitment, type Groth16ProofJson, type UserCommand } from '@merces/domain';
import { WAD, bpsOf, mulDiv, parsePeriod, scaledCapWad } from '@merces/math';
import { SimHarness, SimulatorChain, type PrivateTerms } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/*
 * The curve census on Stage 1 (S3 WP9): `syncCurveUnits` (Solana curve.rs:936-963), the report gate
 * (CurveUnitsNotSynced, curve.rs:1532-1541, income.rs:228-233) and `redeem`'s own census without the DAMM v2 pool
 * (exit.rs:80-95, B-C13). Figures are Stage 1's: the worked series of `solana/tests/tests/curve_mode.rs` (CMT) and its
 * report fixtures `solana/tests/fixtures/meteora/curve_reports.json` (FX; generator
 * `solana/scripts/gen-curve-zk-fixture.mjs`), replayed with their own Groth16 proofs.
 *
 * S3 cause codes:
 *  - S3-CN: the curve census: units outstanding = supply − protocol-held, the vault's N, the stake bound and the
 *    report's public input; taken by `syncCurveUnits` and by `redeem` (DAMM pool excluded).
 *
 * S4 cause codes:
 *  - S4-T3: a tier-3 report carries the attestor key's Stage 1 REPORT signature (tier 3) in `attestation` (S4 WP9; was
 *    the attestor's co-signature, named by `attestor`); the FX fallback is `fxFallback` (was `attestorRate`).
 */

const SWAP_BASE = 100_000_000n; // curve_config.json expected.swapBaseAmount
const INITIAL_BASE_SUPPLY = 110_363_638n; // curve_config.json expected.initialBaseSupply
const P0 = 10_000_000n; // curve_config.json expected.p0PerUnit
const SCALE = 1_000_000n;

/** Stage 1's curve report fixtures (FX) and their terms (generator :36-44): θ 60,000 USD, r 10^9 per base lamport, USD, indexing 0, salt 777. */
const FX = JSON.parse(readFileSync(new URL('../../../stage1/solana/tests/fixtures/meteora/curve_reports.json', import.meta.url), 'utf8')) as {
  terms: { theta: string; r_wad_per_base_lamport: string; terms_salt: string; terms_commitment: string };
  fixtures: { name: string; units_outstanding: string; prior_income_commitment: string; income_commitment: string; payment_usd: string; proof: string }[];
};
const FX_TERMS: PrivateTerms = { theta: BigInt(FX.terms.theta), rWad: BigInt(FX.terms.r_wad_per_base_lamport), currency: 'USD', indexingRule: 'none', termsSalt: BigInt(FX.terms.terms_salt) };

/**
 * A Groth16 proof from Stage 1's Solana encoding (256 bytes: pi_a with its y negated, pi_b's coordinates swapped, pi_c;
 * gen-curve-zk-fixture.mjs :77-80, :87) back to snarkjs JSON. The inverse of Stage 1's `encodeProofForSolana`.
 */
function fromSolanaProof(hex: string): Groth16ProofJson {
  const h = hex.replace(/^0x/, '');
  const w = (i: number) => BigInt('0x' + h.slice(i * 64, i * 64 + 64));
  const [ax, ay] = negateG1(w(0), w(1));
  return {
    pi_a: [ax.toString(), ay.toString(), '1'], pi_b: [[w(3).toString(), w(2).toString()], [w(5).toString(), w(4).toString()], ['1', '0']], pi_c: [w(6).toString(), w(7).toString(), '1'],
    protocol: 'groth16', curve: 'bn128',
  };
}

async function curveSeries(opts: { sim?: SimulatorChain; privateTerms?: PrivateTerms } = {}) {
  const h = await SimHarness.create('solana', { genesis: GENESIS, sim: opts.sim });
  const { seriesId, terms, privateTerms } = await h.createCurve({ privateTerms: opts.privateTerms });
  const s = () => seriesOf(h.sim, seriesId);
  const units = (w: string) => h.sim.curveUnitsOf(seriesId, w);
  const buyers = h.backers.slice(0, 3);
  const held = () => buyers.reduce((n, w) => n + units(w.address), 0n) + units(h.issuer.address);
  return { h, seriesId, terms, privateTerms, s, units, buyers, held };
}

describe('curve census (solana): syncCurveUnits', () => {
  // cause S3-CN: the census is supply − protocol-held = what the buyers hold (CMT:239-249, `assert_eq!(n, held)`); the
  // chain stores it, with its time, only when one is taken; a census may be taken while the curve still sells
  it('counts what the buyers hold, stores it with its time and emits CurveUnitsSynced', async () => {
    const { h, seriesId, s, held, buyers } = await curveSeries();
    await h.curveBuy(seriesId, buyers[0]!, USDC(400));
    // while the curve sells (the raise is Open): the census counts the first buyer's units
    const early = await h.syncCurve(seriesId, buyers[1]);
    expect((early.events[0]!.payload as { unitsOutstanding: string }).unitsOutstanding).toBe(held().toString());
    await h.curveBuy(seriesId, buyers[1]!, USDC(350));
    await h.curveBuy(seriesId, buyers[2]!, USDC(300));
    await h.completeAndCollect(seriesId);
    expect(held()).toBe(SWAP_BASE);
    // nothing is counted until a census is taken: the stored count is the early one
    const before = (await h.sim.getCurve(seriesId))!.census;
    expect(before).toMatchObject({ supply: INITIAL_BASE_SUPPLY.toString(), unitsOutstanding: SWAP_BASE.toString(), redemptionUnits: SWAP_BASE.toString(), stakedTotal: '0', changedSinceSync: true });
    expect(before.synced!.unitsOutstanding).not.toBe(SWAP_BASE.toString());
    await h.sim.advanceTime(3_600);
    const r = await h.syncCurve(seriesId);
    expect(types(r.events)).toEqual(['CurveUnitsSynced']);
    expect(r.events[0]!.payload).toEqual({ seriesId, supply: INITIAL_BASE_SUPPLY.toString(), protocolHeld: (INITIAL_BASE_SUPPLY - SWAP_BASE).toString(), unitsOutstanding: SWAP_BASE.toString(), stakedTotal: '0' });
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ unitsOutstanding: SWAP_BASE.toString(), unitsSyncedAt: r.blockTime });
    expect(s().unitsSyncedAt).toBe(r.blockTime);
    expect((await h.sim.getCurve(seriesId))!.census).toMatchObject({ synced: { unitsOutstanding: SWAP_BASE.toString(), at: r.blockTime }, changedSinceSync: false });
  });

  // cause S3-CN: relational on Stage 1's census test (CMT:708-766): the migration only moves protocol-held base, so the
  // census is unchanged; units the issuer claims from the locker and units bought out of the DAMM pool become outstanding
  it('a migration leaves the census unchanged; a locker release and a DAMM trade raise it by exactly the units moved', async () => {
    const { h, seriesId, buyers } = await curveSeries();
    await h.fillCurve(seriesId, buyers);
    const census = async () => BigInt(((await h.syncCurve(seriesId)).events[0]!.payload as { unitsOutstanding: string }).unitsOutstanding);
    const n0 = await census();
    expect(n0).toBe(SWAP_BASE);
    await h.sim.curveHook(seriesId, { kind: 'migrate', protocolBaseFee: 7n, leftover: 3n });
    expect(await census()).toBe(n0);
    const released = 4n * SCALE;
    await h.sim.curveHook(seriesId, { kind: 'lockerRelease', to: h.issuer.address, units: released });
    expect(await census()).toBe(n0 + released);
    const bought = 100_000n;
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: buyers[2]!.address, units: bought });
    expect(await census()).toBe(n0 + released + bought);
    // units sold into the DAMM pool are protocol-held again
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: buyers[2]!.address, units: -bought });
    expect(await census()).toBe(n0 + released);
  });

  // cause S3-CN: Stage 1's refusals in its order (curve.rs:940-948): NotCurveMode on a sealed-bid series; TerminalStatus
  // on a stored Redeemed or Extinguished series (curve.rs:948 `is_terminal`; Retired: the fixture replay below, as CMT's
  // "sync after retirement", :972-976). No CMT test takes a census on a Redeemed or Extinguished series (it closes staking
  // once redeemed, :345-350): these two are the rule's, not a Stage 1 figure
  it('refuses a sealed-bid series (NotCurveMode) and a Redeemed or Extinguished one (TerminalStatus)', async () => {
    const sealed = await SimHarness.create('solana', { genesis: GENESIS });
    const raise = await sealed.runRaise();
    await expectStage1Error(sealed.syncCurve(raise.seriesId), 'NotCurveMode');

    const a = await curveSeries();
    await a.h.fillCurve(a.seriesId, a.buyers);
    await a.h.syncCurve(a.seriesId);
    await a.h.exec(a.h.issuer, { kind: 'redeem', seriesId: a.seriesId, maxPricePerUnit: USDC(1_000).toString() });
    expect(a.s().status).toBe('Redeemed');
    await expectStage1Error(a.h.syncCurve(a.seriesId), 'TerminalStatus');

    const b = await curveSeries();
    await b.h.fillCurve(b.seriesId, b.buyers);
    await b.h.syncCurve(b.seriesId);
    const [a1, a2] = b.h.attestors as [typeof b.h.attestors[0], typeof b.h.attestors[0]];
    await b.h.exec(a1, { kind: 'extinguish', seriesId: b.seriesId, attestors: [a1.address, a2.address] }, [a2]);
    await expectStage1Error(b.h.syncCurve(b.seriesId), 'TerminalStatus');
  });

  // cause S3-CN: the census never falls below the stakes (CurveUnitsBelowStake, curve.rs:478-481) and holdings past the
  // supply are CurveUnitsInconsistent (:477). White-box (S1 plan §2 rule 5): stakes arrive with WP10, and the stand-in
  // conserves its supply, so both states are seeded
  it('refuses a census below the stakes (CurveUnitsBelowStake) or past the supply (CurveUnitsInconsistent); white-box', async () => {
    const { h, seriesId, s, buyers } = await curveSeries();
    await h.fillCurve(seriesId, buyers);
    s().stakedTotal = SWAP_BASE + 1n;
    await expectStage1Error(h.syncCurve(seriesId), 'CurveUnitsBelowStake');
    s().stakedTotal = SWAP_BASE;
    await h.syncCurve(seriesId);
    s().stakedTotal = 0n;
    s().curve!.supply = INITIAL_BASE_SUPPLY - SWAP_BASE - 1n;
    await expectStage1Error(h.syncCurve(seriesId), 'CurveUnitsInconsistent');
  });

  // cause S3-CN: extinguishment weighs the last census (exit.rs:268-272, unchanged in the engine): an unsynced curve has
  // no final units, and nothing is distributed on them (Stage 1 skips `receive_final`)
  it('extinguishment weighs the last census; with none taken nothing is distributed', async () => {
    for (const synced of [true, false]) {
      const { h, seriesId, s, buyers } = await curveSeries();
      await h.fillCurve(seriesId, buyers);
      if (synced) await h.syncCurve(seriesId);
      const [a1, a2] = h.attestors as [typeof h.attestors[0], typeof h.attestors[0]];
      await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
      expect(s().final.finalUnits).toBe(synced ? SWAP_BASE : 0n);
      expect(s().final.finalAccWad > 0n).toBe(synced);
    }
  });
});

describe('curve census (solana): the report gate', () => {
  // cause S3-CN: a regular report needs a census taken at or after its period's end (CMT:282-291: "stale units", :285-289,
  // until `sync_curve_units` runs after the period, :290); the census is the proof's public input. A tail report proves over the
  // units at redemption and needs none (a Redeemed series cannot take one)
  it('refuses a report before any census and with a census older than the period end; accepts it after a fresh one', async () => {
    const { h, seriesId, privateTerms, terms, s, buyers } = await curveSeries();
    await h.fillCurve(seriesId, buyers);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    const report = async (periodId: string, incomeYtdNow: bigint) => (await h.buildReport({ seriesId, periodId, privateTerms, termsCommitment: terms.termsCommitment, incomeYtdNow })).command;
    // no census yet: units outstanding are 0
    // (the harness's curve terms: θ 60,000 USDC, r 10^9 per base lamport: 1,000 USDC owed on 70,000, 1,500 on 75,000;
    // the cap is 2,500 USDC)
    await expectStage1Error(h.exec(h.issuer, await report('2026Q1', USDC(70_000))), 'CurveUnitsNotSynced');
    await h.syncCurve(seriesId);
    const q1 = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(70_000));
    expect(q1.paid).toBe(USDC(1_000));
    expect(q1.events.find((e) => e.type === 'ReportAccepted')).toBeTruthy();
    // Q2 ends: the Q1 census is older than its end
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await expectStage1Error(h.exec(h.issuer, await report('2026Q2', USDC(75_000))), 'CurveUnitsNotSynced');
    await h.syncCurve(seriesId);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 0n, USDC(75_000));
    // a redemption, then a tail report with no census after it: accepted
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    expect(s().status).toBe('Redeemed');
    await h.sim.setTime(parsePeriod('2026Q3').end + 3_600);
    expect(s().unitsSyncedAt! < parsePeriod('2026Q3').end).toBe(true);
    const tail = await h.exec(h.issuer, await report('2026Q3', USDC(80_000)));
    expect(tail.events[0]!.type).toBe('ReportAccepted');
  });
});

describe('curve census (solana): the redemption census', () => {
  // cause S3-CN: relational on Stage 1's sandwich test (CMT:1036-1108): units parked in the DAMM v2 pool are not
  // subtracted by `redeem`'s census, so the deposit covers every unit holders could tender and parking cannot lower it;
  // the regular census would have subtracted them. The curve read previews the count `redeem` takes (amendment M4)
  it("redeem takes its own census without the DAMM pool: parked units cannot deflate the deposit", async () => {
    const { h, seriesId, s, units, buyers } = await curveSeries();
    await h.fillCurve(seriesId, buyers);
    await h.syncCurve(seriesId);
    await h.sim.curveHook(seriesId, { kind: 'migrate', protocolBaseFee: 7n });
    // a holder parks all its units in the DAMM pool (the issuer's sandwich swaps base in before redeeming)
    const parked = units(buyers[2]!.address);
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: buyers[2]!.address, units: -parked });
    const tenderable = units(buyers[0]!.address) + units(buyers[1]!.address);
    const c = s().curve!;
    const damm = units(c.accounts.dammBaseVault);
    const preview = (await h.sim.getCurve(seriesId))!.census;
    // a regular census would count wallets only; the redemption census counts the pool too
    expect(BigInt(preview.unitsOutstanding)).toBe(tenderable);
    expect(BigInt(preview.redemptionUnits)).toBe(tenderable + damm);
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    expect(types(r.events)).toEqual(['CurveUnitsSynced', 'RedemptionOpened', 'StatusChanged']);
    const n = s().redemption!.unitsAtRedemption;
    expect(r.events[0]!.payload).toEqual({ seriesId, supply: INITIAL_BASE_SUPPLY.toString(), protocolHeld: (INITIAL_BASE_SUPPLY - n).toString(), unitsOutstanding: n.toString(), stakedTotal: '0' });
    expect(n).toBe(BigInt(preview.redemptionUnits));
    expect(n >= tenderable).toBe(true);
    // the old census (the pool subtracted) would have stranded the holders
    expect(n - damm < tenderable + parked).toBe(true);
    // the deposit is floor(P_redeem × N / 10^6) (exit.rs:125)
    const r0 = s().redemption!;
    expect(r0.deposit).toBe(mulDiv(r0.pricePerUnit, n, SCALE));
    expect(s().unitsOutstanding).toBe(n);
    expect(s().unitsSyncedAt).toBe(r.blockTime);
  });
});

describe('curve census (solana): Stage 1 curve report fixture replay', () => {
  afterAll(async () => {
    // snarkjs keeps a multithreaded curve alive on globalThis
    const g = globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null };
    await g.curve_bn128?.terminate?.();
  });

  /**
   * Stage 1's worked curve series with the fixture's terms, a fill (400, 350, 300 USDC), a census of 99,999,998 base
   * lamports (the fixture's `units_outstanding`, what Stage 1's DBC leaves outside the protocol: its rounding keeps 2
   * base lamports in the pool's vault; the stand-in sells the whole swap base, so a holder sells 2 into the DAMM pool
   * after the migration instead) and a Q1 report with the fixture's own Groth16 proof (tier 3, as CMT reports, :138-183).
   */
  async function replay(index: 0 | 1) {
    const sim = SimulatorChain.createSync({ personality: 'solana', genesis: GENESIS, reportProofVerifier: { verify: (proof, signals) => verifyReport(proof as never, signals) } });
    const x = await curveSeries({ sim, privateTerms: FX_TERMS });
    const { h, seriesId, terms, buyers } = x;
    // our Poseidon terms commitment over the fixture's terms is the fixture's (generator :44, written at :96)
    expect(terms.termsCommitment).toBe(FX.terms.terms_commitment);
    expect(termsCommitment(FX_TERMS)).toBe(FX.terms.terms_commitment);
    await h.fillCurve(seriesId, buyers);
    await h.sim.curveHook(seriesId, { kind: 'migrate' });
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: buyers[2]!.address, units: -2n });
    await h.syncCurve(seriesId);
    const f = FX.fixtures[index]!;
    const N = BigInt(f.units_outstanding);
    expect(x.s().unitsOutstanding).toBe(N);
    // CMT:283-289: the period ended and the census predates its end ("stale units")
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    expect(f.prior_income_commitment).toBe(ZERO_INCOME_COMMITMENT);
    const publicInputs = reportPublicInputs({ termsCommitment: FX.terms.terms_commitment, unitsOutstanding: N, fxAvgWad: WAD, priorIncomeCommitment: f.prior_income_commitment, incomeCommitment: f.income_commitment, paymentStable: BigInt(f.payment_usd) });
    const proof = fromSolanaProof(f.proof);
    // the decoding is exact: Stage 1's own encoder gives back the fixture's bytes
    expect(encodeProofForSolana(proof as never, publicInputs).proof).toBe(f.proof);
    // cause S4-T3: the attestor key's REPORT signature with tier 3, no co-signer
    const attestation = attestationOf(await h.attestReport(seriesId, { periodId: '2026Q1', priorIncomeCommitment: f.prior_income_commitment, incomeCommitment: f.income_commitment, liquidityEvent: false, tier: 3 }, h.attestors[0]!));
    const cmd: Extract<UserCommand, { kind: 'submitReport' }> = {
      kind: 'submitReport', seriesId, periodId: '2026Q1', tier: 3, paymentStable: f.payment_usd, priorIncomeCommitment: f.prior_income_commitment, incomeCommitment: f.income_commitment,
      fxBasis: 'unity', fxAvgWad: WAD.toString(), pair: null, fxFallback: null, proof: { system: 'groth16-bn254', proof, publicInputs }, attestation, liquidityEvent: false,
    };
    await expectStage1Error(h.exec(h.issuer, cmd), 'CurveUnitsNotSynced');
    await h.syncCurve(seriesId);
    const accepted = await h.exec(h.issuer, cmd);
    expect(accepted.events[0]!.type).toBe('ReportAccepted');
    const due = BigInt((accepted.events[0]!.payload as { paymentDue: string }).paymentDue);
    return { ...x, N, due };
  }

  // cause S3-CN: FX `curve_q1`: 0.1% × N × 20,000 USDC = 1,999,999,960 (CMT:292-293); the vault's accumulator is per base
  // lamport with the exact WAD carry (CMT:299-303)
  it('replays curve_q1: our terms commitment and census verify the fixture proof; the issuer owes 1,999,999,960', async () => {
    const { h, seriesId, s, N, due } = await replay(0);
    expect(due).toBe(1_999_999_960n);
    await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: due.toString() });
    const net = due - bpsOf(due, BigInt(s().terms.payoutFeeBps));
    expect(s().vault.netAccWad * N + s().vault.carryWad).toBe(net * WAD);
    expect(s().status).not.toBe('Retired');
  }, 60_000);

  // cause S3-CN: FX `curve_q1_cap`: 13,999,999,720 owed, past the cap (P0 = 10 USDC, m = 2.5: 25 USDC per unit, 25 base
  // units per base lamport, `scaled_cap_wad`; CMT:928-947, the due at :929, the cap at :938-940): the vault accepts
  // 25 × N = 2,499,999,950, refunds the rest and the series retires; a census is then refused (CMT:972-976)
  it('replays curve_q1_cap: owes 13,999,999,720, the vault accepts 25 × N and retires the series', async () => {
    const { h, seriesId, s, N, due } = await replay(1);
    expect(due).toBe(13_999_999_720n);
    const capWad = scaledCapWad(25n * SCALE, SCALE);
    expect(capWad).toBe(25n * WAD);
    expect(s().capPerUnit).toBe((P0 * 5n) / 2n); // P0 × m = 10 × 2.5 USDC per whole unit
    expect(s().capPerUnit).toBe(25n * SCALE);
    const paid = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: due.toString() });
    const accepted = 25n * N;
    expect(accepted).toBe(2_499_999_950n);
    expect(paid.events.find((e) => e.type === 'PaymentRefunded')!.payload).toMatchObject({ amount: (due - accepted).toString(), reason: 'cap' });
    expect(s().vault.paidPerUnitWad).toBe(capWad);
    expect(s().vault.grossReceived).toBe(accepted);
    expect(s().status).toBe('Retired');
    await expectStage1Error(h.syncCurve(seriesId), 'TerminalStatus');
  }, 60_000);
});
