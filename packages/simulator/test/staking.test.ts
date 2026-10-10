import { describe, expect, it } from 'vitest';
import { ChainError, type DomainEvent } from '@merces/domain';
import { WAD, bpsOf, mulDiv, parsePeriod, scaledAmount, scaledCapWad, settleHolderDelta } from '@merces/math';
import { SimHarness, SimWallet, serialiseState, type PrivateTerms } from '../src/index.ts';
import { balKey } from '../src/engine/core.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/*
 * Curve staking on Stage 1 (S3 WP10): `stakeUnits`, `unstakeUnits` and `tenderUnits` (Solana curve.rs:1250-1528), the
 * holder settlement by stake (`settle_curve_holder`, curve.rs:516-535) and the curve branches of the claim family
 * (claims.rs:182-196, :342, :365-391, :424-452, :252). The scenarios follow Stage 1's own curve tests,
 * `solana/tests/tests/curve_mode.rs` (CMT), on its worked series (100 units, X = 1,000 USDC, P0 = 10 USDC; buys of 400,
 * 350 and 300 USDC by `a` and `b`, allowlisted, and `d`, not) and its report fixtures
 * (`solana/tests/fixtures/meteora/curve_reports.json`: θ 60,000 USD, r 10^9 per base lamport, a census of 99,999,998
 * base lamports). Figures that depend on Meteora's DBC price path (what each buyer received) are relational: the
 * stand-in sells at the constant P0, so `a` holds 39,600,000 base lamports here and another count on Stage 1's DBC; every
 * payout is pinned as Stage 1's test pins it, `holder_delta(acc, last, staked)` (`settleHolderDelta`).
 *
 * S3 cause codes:
 *  - S3-ST: staking, tender and stake-weighted claims (only staked units earn; unstake credits pending; tender by stake
 *    and by wallet within the quota; claimTail and claimFinal by tendered units or stake; no burns but tenders).
 */

const SCALE = 1_000_000n;
const FX_UNITS = 99_999_998n; // curve_reports.json fixtures[*].units_outstanding
/** The fixture's terms (curve_reports.json `terms`; generator gen-curve-zk-fixture.mjs:36-49). */
const FX_TERMS: PrivateTerms = { theta: 60_000_000_000n, rWad: 1_000_000_000n, currency: 'USD', indexingRule: 'none', termsSalt: 777n };

/**
 * Stage 1's `launched()` (CMT:91-131): a curve series with the fixture's terms, `a` and `b` allowlisted, `d` not, buys of
 * 400, 350 and 300 USDC (the last fills the curve), then completion and collection. Stage 1's DBC leaves 2 base lamports
 * of the swap base unsold in the pool's base vault (its census is the fixture's 99,999,998); the stand-in sells all of
 * it, so those 2 go back from `d` into the pool's vault (white-box, S1 plan §2 rule 5: a figure that depends on DBC
 * rounding is seeded, never reproduced).
 */
async function launched() {
  const h = await SimHarness.create('solana', { genesis: GENESIS });
  const { seriesId, terms } = await h.createCurve({ privateTerms: FX_TERMS });
  const [a, b, d] = h.backers as [SimWallet, SimWallet, SimWallet];
  await h.sim.submit({ kind: 'setAllowlist', wallet: d.address, allowed: false }, 'allowlistManager');
  await h.fillCurve(seriesId, [a, b, d]);
  const s = () => seriesOf(h.sim, seriesId);
  const c = s().curve!;
  const units = (w: string) => h.sim.curveUnitsOf(seriesId, w);
  const move = (from: string, to: string, n: bigint) => {
    const bal = h.sim.state.balances;
    const take = (w: string, x: bigint) => bal.set(balKey(w, c.baseMint), (bal.get(balKey(w, c.baseMint)) ?? 0n) + x);
    if (units(from) < n) throw new Error('test: the account holds fewer units');
    take(from, -n);
    take(to, n);
  };
  move(d.address, c.accounts.dbcBaseVault, 2n);
  c.baseSold -= 2n;
  const usdc = async (w: string) => BigInt(await h.sim.getBalance(w, 'USDC'));
  const report = async (periodId: string, incomeYtdNow: bigint) => (await h.buildReport({ seriesId, periodId, privateTerms: FX_TERMS, termsCommitment: terms.termsCommitment, incomeYtdNow })).command;
  const pay = (periodId: string, incomeYtdNow: bigint, extra: { liquidityEvent?: boolean } = {}) => h.reportAndPay(seriesId, periodId, FX_TERMS, terms.termsCommitment, 0n, incomeYtdNow, extra);
  return { h, seriesId, terms, a, b, d, s, c, units, move, usdc, report, pay };
}

const amountOf = (evs: DomainEvent[], type: string): bigint => BigInt((evs.find((e) => e.type === type)!.payload as { amount: string }).amount);
const extinguish = (h: SimHarness, seriesId: string) => {
  const [k1, k2] = h.attestors as [SimWallet, SimWallet];
  return h.exec(k1, { kind: 'extinguish', seriesId, attestors: [k1.address, k2.address] }, [k2]);
};

describe('curve staking (solana): the lifecycle with exact amounts (CMT:183-426)', () => {
  // cause S3-ST: CMT `curve_lifecycle_activate_sync_report_claim_tender`, from the census on: registration and staking
  // gated by the allowlist, a stake leaves the census alone, the report needs a census after its period, claims pay
  // staked units only (`holder_delta(net_acc, 0, staked)`), a stake after a receipt earns nothing from it, redemption by
  // tender with the stake reserved and the wallet quota, an unregistered wallet cannot tender
  it('registers and stakes allowlisted holders, pays stakes only, redeems by tender within the quota', async () => {
    const { h, seriesId, a, b, d, s, c, units, move, usdc, report, pay } = await launched();
    // the census: supply minus the protocol accounts = what the buyers hold (CMT:239-251)
    await h.syncCurve(seriesId);
    const n = s().unitsOutstanding;
    expect(n).toBe(units(a.address) + units(b.address) + units(d.address));
    expect(n).toBe(FX_UNITS);

    // claim gating: allowlisted holders register; d cannot (CMT:254-263)
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    await expectStage1Error(h.registerHolder(seriesId, d), 'NotAllowlisted');
    await expectStage1Error(h.stake(seriesId, d, 1n), 'NotAllowlisted');
    const aUnits = units(a.address);
    const bStaked = 10n * SCALE;
    const staked = await h.stake(seriesId, a, aUnits);
    expect(types(staked.events)).toEqual(['UnitsStaked']);
    expect(staked.events[0]!.payload).toEqual({ seriesId, holder: a.address, units: aUnits.toString(), staked: aUnits.toString() });
    await h.stake(seriesId, b, bStaked);
    expect(units(a.address)).toBe(0n);
    expect(units(c.accounts.stakeVault)).toBe(aUnits + bStaked);
    // staking never changes units outstanding: the stake vault is not protocol-held (CMT:275-280)
    await h.syncCurve(seriesId);
    expect(s().unitsOutstanding).toBe(n);
    expect(s().stakedTotal).toBe(aUnits + bStaked);

    // the report needs a census after its period ended (CMT:282-292): FX curve_q1 owes 1,999,999,960
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await expectStage1Error(h.exec(h.issuer, await report('2026Q1', USDC(80_000))), 'CurveUnitsNotSynced');
    await h.syncCurve(seriesId);
    const q1 = await pay('2026Q1', USDC(80_000));
    expect(q1.due).toBe(1_999_999_960n);
    const net = q1.due - bpsOf(q1.due, BigInt(s().terms.payoutFeeBps));
    const acc = s().vault.netAccWad;
    // per-base-lamport accumulator with the exact WAD carry (CMT:296-301)
    expect(acc * n + s().vault.carryWad).toBe(net * WAD);

    // claims pay staked units only, exactly (CMT:303-315)
    expect(s().vaultBalance).toBe(net);
    const [a0, b0] = [await usdc(a.address), await usdc(b.address)];
    const ca = await h.exec(a, { kind: 'claimPayout', seriesId });
    const cb = await h.exec(b, { kind: 'claimPayout', seriesId });
    const paidA = (await usdc(a.address)) - a0;
    const paidB = (await usdc(b.address)) - b0;
    expect(paidA).toBe(settleHolderDelta(acc, 0n, aUnits));
    expect(paidB).toBe(settleHolderDelta(acc, 0n, bStaked));
    expect(types(ca.events)).toEqual(['PayoutClaimed']);
    expect(ca.events[0]!.payload).toEqual({ seriesId, holder: a.address, amount: paidA.toString(), burnedUnits: '0' });
    expect(amountOf(cb.events, 'PayoutClaimed')).toBe(paidB);
    // the unstaked units' share stays in the vault (never over-paid)
    expect(paidA + paidB <= net).toBe(true);
    expect(s().vaultBalance).toBe(net - paidA - paidB);
    // staking after a receipt earns nothing for it (the debt pattern, CMT:316-330)
    await h.stake(seriesId, b, 5n * SCALE);
    const again = await h.exec(b, { kind: 'claimPayout', seriesId });
    expect(amountOf(again.events, 'PayoutClaimed')).toBe(0n);
    expect((await usdc(b.address)) - b0).toBe(paidB);
    const bStake = bStaked + 5n * SCALE;
    expect(s().positions.get(b.address)!.stakedUnits).toBe(bStake);

    // redemption by tender (CMT:332-347): the deposit covers the units counted at redemption
    const vaultMid = s().vaultBalance;
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const r = s().redemption!;
    expect(r.unitsAtRedemption).toBe(n);
    const price = r.pricePerUnit;
    expect(price > 0n).toBe(true);
    const deposit = scaledAmount(price, n, SCALE);
    expect(r.deposit).toBe(deposit);
    expect(s().vaultBalance).toBe(vaultMid + deposit);
    // the vault's dust (B-C11): the deposit is owed to the units counted at redemption; the unstaked units' share of the
    // payout is nobody's
    expect(BigInt((await h.sim.getVault(seriesId))!.dust)).toBe(vaultMid);
    // staking is closed once redeemed (CMT:348-353)
    await expectStage1Error(h.stake(seriesId, b, 1n), 'TerminalStatus');
    // a tenders its whole stake, burned in the stake vault (CMT:354-366)
    const supply0 = s().curve!.supply;
    const aStable0 = await usdc(a.address);
    const ta = await h.tender(seriesId, a, aUnits, 0n);
    expect(types(ta.events)).toEqual(['UnitsBurned', 'RedemptionClaimed']);
    expect(ta.events[0]!.payload).toEqual({ seriesId, holder: a.address, units: aUnits.toString(), reason: 'redemption' });
    expect(ta.events[1]!.payload).toEqual({ seriesId, holder: a.address, units: aUnits.toString(), amount: scaledAmount(price, aUnits, SCALE).toString(), fromStake: aUnits.toString() });
    expect((await usdc(a.address)) - aStable0).toBe(scaledAmount(price, aUnits, SCALE));
    expect(s().curve!.supply).toBe(supply0 - aUnits);
    // b tenders its stake and its wallet units, burned by its own signature (CMT:367-381)
    const bWallet = units(b.address);
    const bStable0 = await usdc(b.address);
    await h.tender(seriesId, b, bStake, bWallet);
    expect((await usdc(b.address)) - bStable0).toBe(scaledAmount(price, bStake + bWallet, SCALE));
    expect(units(b.address)).toBe(0n);
    expect(s().positions.get(b.address)).toMatchObject({ stakedUnits: 0n, redeemedUnits: bStake + bWallet });
    // the unregistered holder cannot tender (CMT:382-384)
    await expectStage1Error(h.tender(seriesId, d, 0n, 1n), 'HolderNotRegistered');
    // the census is never taken again: units outstanding stay the count at redemption
    expect(s().unitsOutstanding).toBe(n);

    // the tender quota (CMT:386-426): 10 units leave the DBC base vault for a registered holder e, as a release after the
    // redemption would, and d passes its units to e (white-box, as Stage 1's test mocks it)
    const e = h.backers[3]!;
    await h.registerHolder(seriesId, e);
    const dUnits = units(d.address);
    move(c.accounts.dbcBaseVault, e.address, 10n * SCALE);
    move(d.address, e.address, dUnits);
    const quota = r.unitsAtRedemption - s().tenderedTotal - s().stakedTotal;
    expect(quota).toBe(dUnits);
    await expectStage1Error(h.tender(seriesId, e, 0n, quota + 1n), 'TenderQuotaExhausted');
    await h.tender(seriesId, e, 0n, quota);
    await expectStage1Error(h.tender(seriesId, e, 0n, 1n), 'TenderQuotaExhausted');
    // the deposit covered every tender: what is left is the unstaked units' share of the payout and the rounding
    expect(s().tenderedTotal).toBe(r.unitsAtRedemption);
    const tenderedPaid = [aUnits, bStake + bWallet, quota].reduce((t, u) => t + scaledAmount(price, u, SCALE), 0n);
    expect(tenderedPaid <= deposit).toBe(true);
    expect(s().vaultBalance).toBe(vaultMid + deposit - tenderedPaid);
    expect(s().redemption!.claimed).toBe(tenderedPaid);
    expect(BigInt((await h.sim.getVault(seriesId))!.dust)).toBe(vaultMid);
  });
});

describe('curve staking (solana): the rules (CMT:770-813)', () => {
  // cause S3-ST: CMT `curve_staking_rules_and_closed_sealed_bid_paths`: bounded by the census, allowlisted wallets only,
  // never more than staked out; de-allowlisted holders still unstake and claim (C10); the sealed-bid exits are closed
  it('refuses a stake before any census, a zero stake and an over-unstake; a removed wallet unstakes and claims, never stakes', async () => {
    const { h, seriesId, a, b, units } = await launched();
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    // nothing synced yet: no stake can be covered
    await expectStage1Error(h.stake(seriesId, a, 1n), 'StakeExceedsOutstanding');
    await h.syncCurve(seriesId);
    const aUnits = units(a.address);
    await expectStage1Error(h.stake(seriesId, a, 0n), 'ZeroUnits');
    await h.stake(seriesId, a, aUnits);
    await expectStage1Error(h.unstake(seriesId, a, aUnits + 1n), 'InsufficientStake');
    // de-allowlisted: no new stake, but unstaking and claiming still work
    await h.sim.submit({ kind: 'setAllowlist', wallet: b.address, allowed: false }, 'allowlistManager');
    await expectStage1Error(h.stake(seriesId, b, 1n), 'NotAllowlisted');
    await h.sim.submit({ kind: 'setAllowlist', wallet: a.address, allowed: false }, 'allowlistManager');
    await h.unstake(seriesId, a, aUnits / 2n);
    await h.exec(a, { kind: 'claimPayout', seriesId });
    expect(units(a.address)).toBe(aUnits / 2n);
    // the sealed-bid exits are closed for a curve series
    await expectStage1Error(h.exec(a, { kind: 'burnRetired', seriesId, holder: a.address }), 'CurveModeNoBurn');
    await expectStage1Error(h.exec(a, { kind: 'claimRedemption', seriesId }), 'CurveUsesTender');
  });

  // cause S3-ST: ZeroUnits for each of the three (curve.rs:1264, :1343, :1439), before the holder's record is read;
  // NotCurveMode first on a sealed-bid series; the stake bound is the census, not the wallet: stakes past it are refused
  // even when the wallet holds the units; a wallet short of units is the token program's refusal (no Stage 1 name)
  it('ZeroUnits for a stake, an unstake and a tender of 0; NotCurveMode on a sealed-bid series; InsufficientFunds for a short wallet', async () => {
    const { h, seriesId, a, units } = await launched();
    await h.registerHolder(seriesId, a);
    await h.syncCurve(seriesId);
    await expectStage1Error(h.stake(seriesId, a, 0n), 'ZeroUnits');
    await expectStage1Error(h.unstake(seriesId, a, 0n), 'ZeroUnits');
    // a wallet holding fewer units than it stakes: the stake bound passes, the transfer does not
    await expect(h.stake(seriesId, a, units(a.address) + 1n)).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === 'InsufficientFunds' && e.detail?.stage1 === undefined);
    // a tender before the redemption, then of 0 units after it
    await expectStage1Error(h.tender(seriesId, a, 0n, 1n), 'NotRedeemed');
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    await expectStage1Error(h.tender(seriesId, a, 0n, 0n), 'ZeroUnits');
    await expectStage1Error(h.tender(seriesId, a, 1n, 0n), 'InsufficientStake');
    const sealed = await SimHarness.create('solana', { genesis: GENESIS });
    const raise = await sealed.runRaise();
    const w = sealed.backers[0]!;
    await expectStage1Error(sealed.stake(raise.seriesId, w, 1n), 'NotCurveMode');
    await expectStage1Error(sealed.unstake(raise.seriesId, w, 1n), 'NotCurveMode');
    await expectStage1Error(sealed.tender(raise.seriesId, w, 1n, 0n), 'NotCurveMode');
  });

  // cause S3-ST: Stage 1 allows a stake while the curve still sells (curve.rs:1259-1262 with :944-947, plan §9.9): once a
  // census covers it; nothing accrues before the first payment. Stage 1's order: RaiseNotOpen precedes ZeroUnits
  it('stakes while the curve is Open once a census covers the stake', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.createCurve({ privateTerms: FX_TERMS });
    const a = h.backers[0]!;
    await h.curveBuy(seriesId, a, USDC(400));
    await h.registerHolder(seriesId, a);
    await expectStage1Error(h.stake(seriesId, a, 1n), 'StakeExceedsOutstanding');
    await h.syncCurve(seriesId);
    const held = h.sim.curveUnitsOf(seriesId, a.address);
    await h.stake(seriesId, a, held);
    const s = seriesOf(h.sim, seriesId);
    expect(s.phase).toBe('Open');
    expect(s.stakedTotal).toBe(held);
    expect((await h.sim.getPosition(seriesId, a.address))!).toMatchObject({ units: held.toString(), stakedUnits: held.toString(), walletUnits: '0', claimable: '0' });
  });
});

describe('curve staking (solana): unstake credits pending (owner decision 1)', () => {
  // cause S3-ST: Stage 1's `unstake_units` settles into pending and moves no stablecoin (curve.rs:1315-1383; CMT:891-893
  // unstakes, then a claim pays); SPEC §9 says "pays", the code wins. The credit stays on the holder record and any later
  // claim pays exactly it: `claim` checks neither status nor allowlist (claims.rs:182-196), and records are never closed
  it('moves no stablecoin; the pending credit is exactly what the stake earned and the next claim pays it, even after removal', async () => {
    const { h, seriesId, a, b, s, units, usdc, pay } = await launched();
    for (const w of [a, b]) await h.registerHolder(seriesId, w);
    await h.syncCurve(seriesId);
    const bStake = 20n * SCALE;
    await h.stake(seriesId, b, bStake);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    await pay('2026Q1', USDC(80_000));
    const owed = settleHolderDelta(s().vault.netAccWad, 0n, bStake);
    expect((await h.sim.getPosition(seriesId, b.address))!.claimable).toBe(owed.toString());
    const b0 = await usdc(b.address);
    const vault0 = s().vaultBalance;
    const un = await h.unstake(seriesId, b, bStake);
    expect(types(un.events)).toEqual(['UnitsUnstaked']);
    expect(un.events[0]!.payload).toEqual({ seriesId, holder: b.address, units: bStake.toString(), staked: '0' });
    expect(await usdc(b.address)).toBe(b0);
    expect(s().vaultBalance).toBe(vault0);
    expect(s().positions.get(b.address)!.pending).toBe(owed);
    expect(units(b.address) >= bStake).toBe(true);
    // the credit stays claimable: off the allowlist, at any time later
    await h.sim.submit({ kind: 'setAllowlist', wallet: b.address, allowed: false }, 'allowlistManager');
    await h.sim.advanceTime(30 * 86_400);
    const claim = await h.exec(b, { kind: 'claimPayout', seriesId });
    expect(amountOf(claim.events, 'PayoutClaimed')).toBe(owed);
    expect((await usdc(b.address)) - b0).toBe(owed);
    expect(s().positions.get(b.address)!.pending).toBe(0n);
  });
});

describe('curve staking (solana): unstake and claim in ONE transaction (owner direction of 2026-10-10)', () => {
  // cause S3-ST: the chain port builds an ordered command list as one transaction, all or nothing (the simulator runs it
  // in one execution with one rollback; the Solana adapter packs both instructions). The unstake builder's
  // `[unstakeUnits, claimPayout]` pays exactly the pending payout the unstake credited
  it('both happen or neither; the claim pays exactly the pending the unstake credited', async () => {
    const { h, seriesId, a, b, s, units, usdc, pay } = await launched();
    for (const w of [a, b]) await h.registerHolder(seriesId, w);
    await h.syncCurve(seriesId);
    const bStake = 20n * SCALE;
    await h.stake(seriesId, b, bStake);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    await pay('2026Q1', USDC(80_000));
    const owed = settleHolderDelta(s().vault.netAccWad, 0n, bStake);
    expect(owed > 0n).toBe(true);
    const bundle = [{ kind: 'unstakeUnits' as const, seriesId, units: (bStake / 2n).toString() }, { kind: 'claimPayout' as const, seriesId }];
    const tx = await h.sim.build(bundle, b.address);
    expect(tx).toMatchObject({ command: bundle[0], commands: bundle, summary: 'unstakeUnits + claimPayout on solana (one transaction)' });

    // neither: a bundle whose unstake is refused (more than the stake) leaves the stake, the pending payout, the
    // stablecoin and the transaction count as they were, and emits nothing
    const [b0, vault0, tx0, events0] = [await usdc(b.address), s().vaultBalance, h.sim.state.txCount, h.sim.engine.events.length];
    await expectStage1Error(h.exec(b, [{ kind: 'unstakeUnits', seriesId, units: (bStake + 1n).toString() }, { kind: 'claimPayout', seriesId }]), 'InsufficientStake');
    // a bundle refused by its second command rolls back its first: a valid unstake, then a claim the chain refuses
    await expect(h.exec(b, [{ kind: 'unstakeUnits', seriesId, units: '1' }, { kind: 'claimPayout', seriesId: 'solana:missing' }])).rejects.toMatchObject({ code: 'NotFound' });
    expect(s().positions.get(b.address)!.stakedUnits).toBe(bStake);
    expect(s().positions.get(b.address)!.pending).toBe(0n);
    expect(s().stakedTotal).toBe(bStake);
    expect([await usdc(b.address), s().vaultBalance, h.sim.state.txCount, h.sim.engine.events.length]).toEqual([b0, vault0, tx0, events0]);

    // both: one transaction id, the unstake's event then the claim's, and the claim pays exactly what the unstake
    // credited into pending (all of the stake's earnings, the half still staked included: the holder is settled whole)
    const signed = await b.sign(tx);
    const res = await h.sim.send(signed);
    expect(types(res.events)).toEqual(['UnitsUnstaked', 'PayoutClaimed']);
    expect(new Set(res.events.map((e) => e.txId)).size).toBe(1);
    expect(res.events[1]!.payload).toEqual({ seriesId, holder: b.address, amount: owed.toString(), burnedUnits: '0' });
    expect((await usdc(b.address)) - b0).toBe(owed);
    expect(vault0 - s().vaultBalance).toBe(owed);
    expect(s().positions.get(b.address)!).toMatchObject({ stakedUnits: bStake / 2n, pending: 0n });
    expect(units(b.address) >= bStake / 2n).toBe(true);
    expect(h.sim.state.txCount).toBe(tx0 + 1);
  });

  it('refuses an empty list and a report inside a list; a list of one is that command', async () => {
    const { h, seriesId, a, report } = await launched();
    await expect(h.sim.build([], a.address)).rejects.toMatchObject({ code: 'NotPermitted' });
    // a report's Groth16 verdict is established per transaction: it is sent on its own
    await h.syncCurve(seriesId);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    const cmd = await report('2026Q1', USDC(80_000));
    await expect(h.sim.build([cmd, { kind: 'claimPayout', seriesId }], h.issuer.address)).rejects.toMatchObject({ code: 'NotPermitted' });
    expect((await h.sim.build(cmd, h.issuer.address)).command.kind).toBe('submitReport');
    const one = await h.sim.build([{ kind: 'claimPayout', seriesId }], a.address);
    expect(one.commands).toBeUndefined();
    expect(one.command).toEqual({ kind: 'claimPayout', seriesId });
  });
});

describe('one transaction of several commands on an EVM chain', () => {
  // the EVM adapter builds one command per transaction until a bundle is needed there (curve mode is Solana only)
  it('is NotImplemented on the monad personality; a single command still builds', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const w = h.backers[0]!;
    await expect(h.sim.build([{ kind: 'claimPayout', seriesId: 'monad:x' }, { kind: 'claimPayout', seriesId: 'monad:y' }], w.address)).rejects.toMatchObject({ code: 'NotImplemented' });
    expect((await h.sim.build([{ kind: 'claimPayout', seriesId: 'monad:x' }], w.address)).command.kind).toBe('claimPayout');
  });
});

describe('curve staking (solana): extinguishment pays stakers (CMT:852-908)', () => {
  // cause S3-ST: CMT `curve_extinguishment_pays_stakers`: the unvested treasury is distributed over the last census and
  // only staked units take their share; an unstake settles it into pending first; a second claim pays nothing more
  it('distributes the unvested half over the census; stakers claim by stake; a second claimFinal pays 0', async () => {
    const { h, seriesId, a, b, d, s, units, usdc } = await launched();
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    await h.syncCurve(seriesId);
    const n = s().unitsOutstanding;
    const [sa, sb] = [units(a.address), 7n * SCALE];
    await h.stake(seriesId, a, sa);
    await h.stake(seriesId, b, sb);
    const proceeds = s().treasuryTotal;
    expect(proceeds).toBe(990_000_000n); // curve_config.json partnerMigrationFee
    await extinguish(h, seriesId);
    // nothing released yet: half vested at settlement stays with the estate, half is distributed
    const unreleased = proceeds - proceeds / 2n;
    expect(s().final.finalUnits).toBe(n);
    expect(s().final.finalAccWad * n + s().final.finalCarryWad).toBe(unreleased * WAD);
    const fAcc = s().final.finalAccWad;
    const a0 = await usdc(a.address);
    const fa = await h.exec(a, { kind: 'claimFinal', seriesId });
    expect((await usdc(a.address)) - a0).toBe(settleHolderDelta(fAcc, 0n, sa));
    expect(types(fa.events)).toEqual(['FinalClaimed']);
    expect(fa.events[0]!.payload).toEqual({ seriesId, holder: a.address, units: sa.toString(), amount: settleHolderDelta(fAcc, 0n, sa).toString() });
    // b unstakes first: the settlement credits its final share, then claimFinal pays it
    await h.unstake(seriesId, b, sb);
    const b0 = await usdc(b.address);
    const fb = await h.exec(b, { kind: 'claimFinal', seriesId });
    expect((await usdc(b.address)) - b0).toBe(settleHolderDelta(fAcc, 0n, sb));
    expect(fb.events[0]!.payload).toMatchObject({ units: '0', amount: settleHolderDelta(fAcc, 0n, sb).toString() });
    // a second claim pays nothing more
    const b1 = await usdc(b.address);
    const again = await h.exec(b, { kind: 'claimFinal', seriesId });
    expect(amountOf(again.events, 'FinalClaimed')).toBe(0n);
    expect(await usdc(b.address)).toBe(b1);
    // units in wallets earn nothing: d never registered, and nothing burns
    await expectStage1Error(h.exec(d, { kind: 'claimFinal', seriesId }), 'HolderNotRegistered');
    expect(units(d.address) > 0n).toBe(true);
    // the unstaked units' share stays in the vault as dust
    const owedStakers = settleHolderDelta(fAcc, 0n, sa) + settleHolderDelta(fAcc, 0n, sb);
    expect(s().vaultBalance).toBe(unreleased - owedStakers);
    expect(BigInt((await h.sim.getVault(seriesId))!.dust)).toBe(unreleased - owedStakers);
  });

  // cause S3-ST: on a curve series that did not redeem `claim` pays the stake's final share too (claims.rs:182-196: the
  // settlement credits it into pending); the position read counts it in `claimable`, `finalClaimable` is 0
  it('claimPayout pays the final share of a stake on an extinguished series that did not redeem', async () => {
    const { h, seriesId, a, s, units, usdc } = await launched();
    await h.registerHolder(seriesId, a);
    await h.syncCurve(seriesId);
    const sa = units(a.address);
    await h.stake(seriesId, a, sa);
    await extinguish(h, seriesId);
    const share = settleHolderDelta(s().final.finalAccWad, 0n, sa);
    expect((await h.sim.getPosition(seriesId, a.address))!).toMatchObject({ claimable: share.toString(), finalClaimable: '0' });
    const a0 = await usdc(a.address);
    const c = await h.exec(a, { kind: 'claimPayout', seriesId });
    expect(amountOf(c.events, 'PayoutClaimed')).toBe(share);
    expect((await usdc(a.address)) - a0).toBe(share);
    const f = await h.exec(a, { kind: 'claimFinal', seriesId });
    expect(f.events[0]!.payload).toMatchObject({ units: sa.toString(), amount: '0' });
  });

  // cause S3-ST: on a series that redeemed, the final share is weighed on the tendered units (claims.rs:424-447) over the
  // units at redemption; units left untendered take none; claimFinal redeems nothing on a curve
  it('after a redemption the final pool is shared by tendered units only', async () => {
    const { h, seriesId, a, b, s, units, usdc } = await launched();
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    await h.syncCurve(seriesId);
    const sa = units(a.address);
    await h.stake(seriesId, a, sa);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const n = s().redemption!.unitsAtRedemption;
    await h.tender(seriesId, a, sa, 0n);
    await extinguish(h, seriesId);
    expect(s().final.finalUnits).toBe(n);
    const fAcc = s().final.finalAccWad;
    expect((await h.sim.getPosition(seriesId, a.address))!.finalClaimable).toBe(settleHolderDelta(fAcc, 0n, sa).toString());
    const a0 = await usdc(a.address);
    const fa = await h.exec(a, { kind: 'claimFinal', seriesId });
    expect(types(fa.events)).toEqual(['FinalClaimed']);
    expect(fa.events[0]!.payload).toMatchObject({ units: sa.toString(), amount: settleHolderDelta(fAcc, 0n, sa).toString() });
    expect((await usdc(a.address)) - a0).toBe(settleHolderDelta(fAcc, 0n, sa));
    // b tendered nothing: weight 0, and its wallet units are not redeemed by the claim
    const bUnits = units(b.address);
    const fb = await h.exec(b, { kind: 'claimFinal', seriesId });
    expect(types(fb.events)).toEqual(['FinalClaimed']);
    expect(fb.events[0]!.payload).toMatchObject({ units: '0', amount: '0' });
    expect(units(b.address)).toBe(bUnits);
    // a holder can still tender after the extinguishment (Stage 1 checks the redemption time only)
    const t = await h.tender(seriesId, b, 0n, bUnits);
    expect(types(t.events)).toEqual(['UnitsBurned', 'RedemptionClaimed']);
  });
});

describe('curve staking (solana): retirement ends claims without burns (CMT:912-985)', () => {
  // cause S3-ST: CMT `curve_retirement_ends_claims_without_burns`: FX curve_q1_cap owes 13,999,999,720, the capping
  // receipt is truncated (refund to the issuer), staked holders keep claiming what they earned, nothing is burned,
  // staking and the census stop, unstaking stays open
  it('retires at the cap; the stake claims what it earned; no burn; stake and census refused; unstake open', async () => {
    const { h, seriesId, a, s, c, units, usdc, pay } = await launched();
    await h.registerHolder(seriesId, a);
    await h.syncCurve(seriesId);
    const sa = units(a.address);
    await h.stake(seriesId, a, sa);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    const issuer0 = await usdc(h.issuer.address);
    const q1 = await pay('2026Q1', USDC(200_000));
    expect(q1.due).toBe(13_999_999_720n);
    expect(s().status).toBe('Retired');
    // the cap per base lamport is exactly 25 USDC per unit / 10^6
    const capWad = scaledCapWad(25n * SCALE, SCALE);
    expect(s().vault.paidPerUnitWad <= capWad).toBe(true);
    const n = s().unitsOutstanding;
    const accepted = mulDiv(n, capWad, WAD);
    expect(issuer0 - (await usdc(h.issuer.address)) <= accepted + 1n).toBe(true);
    expect(s().vault.refundedToIssuer > 0n).toBe(true);
    // claims end with what was earned; nothing burns
    const supply = s().curve!.supply;
    const stake = units(c.accounts.stakeVault);
    const a0 = await usdc(a.address);
    const claim = await h.exec(a, { kind: 'claimPayout', seriesId });
    expect((await usdc(a.address)) - a0).toBe(settleHolderDelta(s().vault.netAccWad, 0n, sa));
    expect(claim.events.map((e) => e.type)).toEqual(['PayoutClaimed']);
    expect(claim.events[0]!.payload).toMatchObject({ burnedUnits: '0' });
    expect(s().curve!.supply).toBe(supply);
    expect(units(c.accounts.stakeVault)).toBe(stake);
    await expectStage1Error(h.exec(a, { kind: 'burnRetired', seriesId, holder: a.address }), 'CurveModeNoBurn');
    await expectStage1Error(h.stake(seriesId, a, 1n), 'TerminalStatus');
    await expectStage1Error(h.syncCurve(seriesId), 'TerminalStatus');
    // units can always come back to the wallet
    await h.unstake(seriesId, a, sa);
    expect(units(a.address)).toBe(sa);
    const a1 = await usdc(a.address);
    const nothing = await h.exec(a, { kind: 'claimPayout', seriesId });
    expect(amountOf(nothing.events, 'PayoutClaimed')).toBe(0n);
    expect(await usdc(a.address)).toBe(a1);
  });
});

describe('curve staking (solana): claimTail and tenders pay pending as its own event', () => {
  // cause S3-ST: claims.rs:365-391: a curve's claim_tail settles, pays pending plus the tail on the tendered units and
  // redeems nothing (NoRedeemedUnits without a tender); tender pays pending with the principal (curve.rs:1489-1494). S3 D3
  // splits the pending payout into its own PayoutClaimed{burnedUnits: 0}, emitted only above 0
  it('a tender pays pending and principal in separate events; claimTail pays pending and the tail on tendered units', async () => {
    const { h, seriesId, a, b, s, units, usdc, pay } = await launched();
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    await h.syncCurve(seriesId);
    const [sa, sb] = [units(a.address), 10n * SCALE];
    await h.stake(seriesId, a, sa);
    await h.stake(seriesId, b, sb);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    // a Q1 of 1 USDC per unit leaves room under the cap for a tail (the tail cap is C_rem − P_redeem)
    await pay('2026Q1', USDC(61_000));
    const acc = s().vault.netAccWad;
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const price = s().redemption!.pricePerUnit;
    expect(s().redemption!.tailCapPerUnit > 0n).toBe(true);
    // b has not tendered: claimTail is refused and changes nothing
    const before = serialiseState(h.sim.state);
    await expectStage1Error(h.exec(b, { kind: 'claimTail', seriesId }), 'NoRedeemedUnits');
    expect(serialiseState(h.sim.state)).toBe(before);
    // a tenders: its pending payout and the principal, each in its own event
    const a0 = await usdc(a.address);
    const t = await h.tender(seriesId, a, sa, 0n);
    expect(types(t.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    const pendingA = settleHolderDelta(acc, 0n, sa);
    expect(t.events[0]!.payload).toEqual({ seriesId, holder: a.address, amount: pendingA.toString(), burnedUnits: '0' });
    expect(amountOf(t.events, 'RedemptionClaimed')).toBe(scaledAmount(price, sa, SCALE));
    expect((await usdc(a.address)) - a0).toBe(pendingA + scaledAmount(price, sa, SCALE));
    // b tenders its wallet units only, keeping its stake: its pending payout comes with the tail claim after it
    const bWallet = units(b.address);
    const tb = await h.tender(seriesId, b, 0n, bWallet);
    expect(types(tb.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    expect(tb.events[2]!.payload).toMatchObject({ units: bWallet.toString(), fromStake: '0' });
    // the tail: a tail report after the quarter (a liquidity event: a tail report owes only then), paid on the units at
    // redemption
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await pay('2026Q2', USDC(90_000), { liquidityEvent: true });
    const tailAcc = s().tail.tailAccWad;
    expect(tailAcc > 0n).toBe(true);
    const ct = await h.exec(a, { kind: 'claimTail', seriesId });
    expect(types(ct.events)).toEqual(['TailClaimed']);
    expect(amountOf(ct.events, 'TailClaimed')).toBe(settleHolderDelta(tailAcc, 0n, sa));
    expect(s().positions.get(a.address)!.redeemedUnits).toBe(sa);
    // b's stake earned nothing since its tender paid the pending payout (a tail payment is not a vault receipt): claimTail
    // pays the tail on b's tendered units only
    const bt = await h.exec(b, { kind: 'claimTail', seriesId });
    expect(types(bt.events)).toEqual(['TailClaimed']);
    expect(amountOf(bt.events, 'TailClaimed')).toBe(settleHolderDelta(tailAcc, 0n, bWallet));
    // b's stake is still reserved: it tenders it now
    expect(s().positions.get(b.address)!.stakedUnits).toBe(sb);
    await h.tender(seriesId, b, sb, 0n);
    expect(s().stakedTotal).toBe(0n);
  });
});

describe('curve staking (solana): reads', () => {
  // cause S3-ST: the position read on a curve: `units` is the stake (the accrual weight), `walletUnits` the base
  // lamports in the wallet; a wallet that holds units without registering reads as unregistered; the list holds the
  // registered holders; the series read carries the stake and tender totals
  it('reads positions, stakes and tenders', async () => {
    const { h, seriesId, a, b, d, units } = await launched();
    const dRead = (await h.sim.getPosition(seriesId, d.address))!;
    expect(dRead).toMatchObject({ registered: false, units: '0', stakedUnits: '0', walletUnits: units(d.address).toString(), claimable: '0' });
    expect(await h.sim.getPosition(seriesId, h.backers[4]!.address)).toBeNull();
    await h.registerHolder(seriesId, a);
    await h.registerHolder(seriesId, b);
    await h.syncCurve(seriesId);
    const sa = units(a.address) / 2n;
    await h.stake(seriesId, a, sa);
    expect((await h.sim.getPosition(seriesId, a.address))!).toMatchObject({ registered: true, units: sa.toString(), stakedUnits: sa.toString(), walletUnits: units(a.address).toString() });
    expect((await h.sim.listPositions(seriesId)).map((p) => p.wallet).sort()).toEqual([a.address, b.address].sort());
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ stakedTotal: sa.toString(), tenderedTotal: '0' });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const price = seriesOf(h.sim, seriesId).redemption!.pricePerUnit;
    // the tender preview: the whole stake and the wallet units that fit the quota
    expect((await h.sim.getPosition(seriesId, a.address))!.redemptionClaimable).toBe(scaledAmount(price, sa + units(a.address), SCALE).toString());
    await h.tender(seriesId, a, sa, 1n);
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ stakedTotal: '0', tenderedTotal: (sa + 1n).toString() });
    expect((await h.sim.getPosition(seriesId, a.address))!).toMatchObject({ stakedUnits: '0', redeemedUnits: (sa + 1n).toString() });
  });
});

describe('curve staking (solana): never overpays (merces-common properties.rs:340-401)', () => {
  /** A small deterministic generator (an LCG), so a failing sequence replays. */
  function rng(seed: number): (n: number) => number {
    let x = BigInt(seed);
    return (n) => {
      x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
      return Number((x >> 33n) % BigInt(n));
    };
  }

  // cause S3-ST: Stage 1's `curve_staking_never_overpays` on the engine itself: whatever the interleaving of receipts,
  // stakes, unstakes, censuses and claims, what has been paid plus what is owed now never exceeds the net received, and
  // the vault always holds what is owed. Receipts are split receipts (tier 1, any amount); a locker release raises the
  // census so later stakes fit
  it('paid + owed ≤ net received after every step of seeded interleavings', async () => {
    for (const seed of [1, 7, 42]) {
      const { h, seriesId, a, b, d, s, c } = await launched();
      const r = rng(seed);
      const e = h.backers[3]!;
      await h.sim.submit({ kind: 'setAllowlist', wallet: d.address, allowed: true }, 'allowlistManager');
      const holders = [a, b, d, e];
      for (const w of holders) await h.registerHolder(seriesId, w);
      await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
      await h.sim.curveHook(seriesId, { kind: 'migrate' });
      await h.syncCurve(seriesId);
      let net = 0n;
      let paid = 0n;
      let steps = 0;
      for (let i = 0; i < 60; i++) {
        const w = holders[r(4)]!;
        const op = r(6);
        try {
          if (op === 0) {
            const res = await h.sim.postSplitReceipt(h.router, seriesId, BigInt(1 + r(50)) * 1_000_000n + BigInt(r(1_000_000)));
            net += res.events.filter((x) => x.type === 'PaymentReceived').reduce((t, x) => t + BigInt((x.payload as { net: string }).net), 0n);
          } else if (op === 1) {
            const held = h.sim.curveUnitsOf(seriesId, w.address);
            if (held > 0n) await h.stake(seriesId, w, 1n + BigInt(r(1_000_000_000)) % held);
          } else if (op === 2) {
            const st = s().positions.get(w.address)!.stakedUnits;
            if (st > 0n) await h.unstake(seriesId, w, 1n + BigInt(r(1_000_000_000)) % st);
          } else if (op === 3) {
            const res = await h.exec(w, { kind: 'claimPayout', seriesId });
            paid += amountOf(res.events, 'PayoutClaimed');
          } else if (op === 4) {
            // the issuer's locked units released to a holder: the next census counts them
            const locked = h.sim.curveUnitsOf(seriesId, c.accounts.lockerEscrow);
            if (locked > 0n) await h.sim.curveHook(seriesId, { kind: 'lockerRelease', to: e.address, units: 1n + BigInt(r(1_000_000_000)) % locked });
            await h.syncCurve(seriesId);
          } else {
            await h.syncCurve(seriesId);
          }
          steps++;
        } catch (err) {
          // a refused step (the cap retires the series, a stake past the census) changes nothing; anything else fails
          if (!(err instanceof ChainError)) throw err;
        }
        let owed = 0n;
        for (const w2 of holders) owed += BigInt((await h.sim.getPosition(seriesId, w2.address))!.claimable);
        expect(paid + owed <= net, `seed ${seed} step ${i}`).toBe(true);
        expect(owed <= s().vaultBalance, `seed ${seed} step ${i}: the vault holds what is owed`).toBe(true);
      }
      expect(steps > 30).toBe(true);
      expect(net > 0n && paid > 0n).toBe(true);
    }
  });
});

describe('curve staking (solana): the money-per-event rule', () => {
  // cause S3-ST: every stablecoin amount a curve claim or tender moves appears in exactly one event amount; the wallet
  // moves by the claim events' amounts, the vault by minus them; units outstanding never move after the census (a tender
  // takes none), and the unit mint's supply falls by exactly the units the tender burns
  it('wallet and vault move by the event amounts; a tender burns its units from the supply, never from units outstanding', async () => {
    const { h, seriesId, a, b, s, units, usdc, pay } = await launched();
    for (const w of [a, b]) await h.registerHolder(seriesId, w);
    await h.syncCurve(seriesId);
    await h.stake(seriesId, a, units(a.address));
    await h.stake(seriesId, b, 5n * SCALE);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    await pay('2026Q1', USDC(61_000));
    const amounts = new Set(['PayoutClaimed', 'RedemptionClaimed', 'TailClaimed', 'FinalClaimed']);
    const step = async (w: SimWallet, cmd: Parameters<SimHarness['exec']>[1]) => {
      const [bal0, vault0, n0, supply0] = [await usdc(w.address), s().vaultBalance, s().unitsOutstanding, s().curve!.supply];
      const res = await h.exec(w, cmd);
      const moved = res.events.filter((e) => amounts.has(e.type)).reduce((t, e) => t + BigInt((e.payload as { amount: string }).amount), 0n);
      const burned = res.events.filter((e) => e.type === 'UnitsBurned').reduce((t, e) => t + BigInt((e.payload as { units: string }).units), 0n);
      expect((await usdc(w.address)) - bal0).toBe(moved);
      expect(vault0 - s().vaultBalance).toBe(moved);
      expect(s().unitsOutstanding).toBe(n0);
      expect(supply0 - s().curve!.supply).toBe(burned);
    };
    await step(a, { kind: 'claimPayout', seriesId });
    await step(b, { kind: 'unstakeUnits', seriesId, units: SCALE.toString() });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    await step(b, { kind: 'tenderUnits', seriesId, fromStake: (4n * SCALE).toString(), fromWallet: SCALE.toString() });
    await step(a, { kind: 'tenderUnits', seriesId, fromStake: s().positions.get(a.address)!.stakedUnits.toString(), fromWallet: '0' });
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await pay('2026Q2', USDC(90_000), { liquidityEvent: true });
    expect(s().tail.tailAccWad > 0n).toBe(true);
    await step(a, { kind: 'claimTail', seriesId });
    await step(b, { kind: 'claimTail', seriesId });
    await extinguish(h, seriesId);
    await step(a, { kind: 'claimFinal', seriesId });
    await step(b, { kind: 'claimFinal', seriesId });
    await step(b, { kind: 'claimPayout', seriesId });
  });
});
