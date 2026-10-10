import { describe, expect, it } from 'vitest';
import { ChainError, type DomainEvent, type UserCommand } from '@merces/domain';
import { WAD } from '@merces/math';
import { SimHarness, SimWallet, serialiseState } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';
import { seedHolder, seedTail, seedVault, seriesOf } from './kit.ts';

/**
 * Stage 1's claim family (S3 WP1; SIM:624-636, 1403-1417, 1449-1475): `claimTail`, `claimFinal` and the permissionless
 * `burnRetired`. `claimPayout` is Stage 1's `claim` since S3 WP3 (the money-per-event rule over every claim in every state is
 * money-rule.test.ts).
 *
 * Every figure was computed with Stage 1's own `Simulator` (`@merces/reference`): a replay drove it through the same
 * flows as these tests (the harness's terms, 500 units at 9 USDC from bids of 12/11/10/10/9 × 100, released 50% at
 * settlement and 25% at 90 and 180 days), at the same times relative to settlement, with the same white-box seeds
 * (the net accumulator, the tail accumulator, the vault balance, a holder's registration and window escrow). Where Stage
 * 1's reference simulator emits fewer events (its auto-redemption inside `claim_tail` and `claim_final` emits no
 * `RedemptionClaimed`; the EVM does), the wallet's balance change and the claim's own event are what match.
 *
 * S3 cause codes:
 *  - S3-TL: `claimTail` (NotRedeemed, HolderNotRegistered, the redemption first, NoRedeemedUnits, `TailClaimed`);
 *  - S3-FN: `claimFinal` (TerminalStatus unless Extinguished, `FinalClaimed{units: weight, amount}`, then the burn);
 *  - S3-BR: `burnRetired{holder}` (TerminalStatus unless Retired, `UnitsBurned(0)` for a wallet holding nothing);
 *  - S3-BU: `PayoutClaimed.burnedUnits`;
 *  - S3-Z: the zero-amount rule: a claim of nothing emits its event with zeros.
 */

const DAY = 86_400;
const balance = async (h: SimHarness, wallet: string) => BigInt(await h.sim.getBalance(wallet, 'USDC'));

async function settled(opts: Parameters<SimHarness['runRaise']>[0] = {}) {
  const h = await SimHarness.create('monad', { genesis: GENESIS });
  const raise = await h.runRaise(opts);
  const settledAt = (await h.sim.getSeries(raise.seriesId))!.settledAt!;
  return { h, settledAt, ...raise };
}

/** The transaction is refused with Stage 1 error `name`, and the chain's state and event log are unchanged. */
async function refused(h: SimHarness, tx: () => Promise<unknown>, name: string): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx().then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

const MONEY_EVENTS = new Set(['PayoutClaimed', 'RedemptionClaimed', 'TailClaimed', 'FinalClaimed']);
/**
 * Send a holder's claim and check the money-per-event rule (S3 D3): every stablecoin amount the claim moves to the
 * wallet appears in exactly one event amount, so the wallet's balance moves by their sum (with a delivered refund).
 */
async function claim(h: SimHarness, w: SimWallet, cmd: UserCommand): Promise<{ events: DomainEvent[]; delta: bigint }> {
  const before = await balance(h, w.address);
  const { events } = await h.exec(w, cmd);
  const delta = (await balance(h, w.address)) - before;
  let inEvents = 0n;
  for (const e of events) {
    const p = e.payload as Record<string, string>;
    if (MONEY_EVENTS.has(e.type) && p.holder === w.address) inEvents += BigInt(p.amount!);
    if (e.type === 'BidDelivered' && p.bidder === w.address) inEvents += BigInt(p.refund!);
  }
  expect(delta).toBe(inEvents);
  return { events, delta };
}
const payload = (events: DomainEvent[], type: string) => events.find((e) => e.type === type)!.payload as Record<string, unknown>;

/** White-box: the vault's net accumulator moves by `perUnit` for every outstanding unit and the vault holds it. */
function seedNetPayout(h: SimHarness, seriesId: string, perUnit: bigint, units: bigint): void {
  const s = seriesOf(h.sim, seriesId);
  seedVault(h.sim, seriesId, { netAccWad: s.vault.netAccWad + perUnit * WAD, balance: s.vaultBalance + perUnit * units });
}

describe('claimTail (Stage 1 claim_tail)', () => {
  it('refuses before a redemption and a stranger after it, redeems first, pays the tail, then 0; refuses a holder with nothing redeemed', async () => {
    const { h, seriesId, settledAt } = await settled({ terms: { lockupSeconds: 10 } });
    const [b0, b1, b2] = [h.backers[0]!, h.backers[1]!, h.backers[2]!];
    const stranger = h.attestors[0]!;
    const tail = (w: SimWallet) => claim(h, w, { kind: 'claimTail', seriesId });
    await h.sim.setTime(settledAt + 11);
    // cause S3-TL: the redemption is checked before the holder (SIM:1405-1408), so a stranger also gets NotRedeemed
    await refused(h, () => tail(b0), 'NotRedeemed');
    await refused(h, () => tail(stranger), 'NotRedeemed');
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    expect((await h.sim.getRedemption(seriesId))!).toMatchObject({ pricePerUnit: USDC(9).toString(), deposit: USDC(4500).toString() });
    await refused(h, () => tail(stranger), 'HolderNotRegistered');

    // white-box: a net payout of 2.5 per unit (250 pending each) and a tail of 1.234567890123456789012345 per unit
    seedNetPayout(h, seriesId, USDC(2.5), 500n);
    const T1 = 1_234_567_890_123_456_789_012_345n;
    seedTail(h.sim, seriesId, { tailAccWad: T1 });
    seedVault(h.sim, seriesId, { balance: seriesOf(h.sim, seriesId).vaultBalance + USDC(700) });
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ claimable: USDC(250).toString(), tailClaimable: '123456789' });

    // b0 has not redeemed: the redemption body runs first (pending 250 + 9 × 100, no catch-up at a 0 cursor), then the
    // tail on its 100 redeemed units, floor(T1 × 100 / WAD) = 123.456789. Stage 1: 1,273.456789 in all
    const c0 = await tail(b0);
    expect(types(c0.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed', 'TailClaimed']);
    expect(c0.events[0]!.payload).toMatchObject({ amount: USDC(250).toString(), burnedUnits: '0' }); // S3-BU: the body's burn is its own
    expect(c0.events[1]!.payload).toMatchObject({ units: '100', reason: 'redemption' });
    expect(c0.events[2]!.payload).toMatchObject({ units: '100', amount: USDC(900).toString() });
    expect(c0.events[3]!.payload).toEqual({ seriesId, holder: b0.address, amount: '123456789' });
    expect(c0.delta).toBe(1_273_456_789n);
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '0', redeemedUnits: '100', tailClaimable: '0', claimable: '0' });
    // cause S3-Z: a second claim pays 0 and still emits its event
    const again = await tail(b0);
    expect(again.events.map((e) => [e.type, (e.payload as { amount: string }).amount])).toEqual([['TailClaimed', '0']]);
    expect(again.delta).toBe(0n);
    // the tail grows by 0.5 per unit: the next claim pays the slice since its cursor, 50
    seedTail(h.sim, seriesId, { tailAccWad: T1 + USDC(0.5) * WAD });
    seedVault(h.sim, seriesId, { balance: seriesOf(h.sim, seriesId).vaultBalance + USDC(250) });
    expect((await tail(b0)).delta).toBe(USDC(50));

    // b1 redeems by itself first (1,150: no catch-up at a 0 cursor), then its tail is the whole slice: 173.456789
    expect((await claim(h, b1, { kind: 'claimRedemption', seriesId })).delta).toBe(USDC(1150));
    const c1 = await tail(b1);
    expect(types(c1.events)).toEqual(['TailClaimed']);
    expect(c1.delta).toBe(173_456_789n);
    // Stage 1's vault after the same steps: 4,500 + 1,250 + 700 + 250 − 1,273.456789 − 50 − 1,150 − 173.456789
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(4_053_086_422n);

    // b2's 100 units are all held for a window ask (white-box): it has accrual units, so the body runs, but it redeems
    // nothing (the escrow is not redeemed) and the claim is refused as a whole (Stage 1: NoRedeemedUnits). Stage 1's
    // reference simulator leaves the body's payment of b2's 250 in place when the call raises (its `checkRevert`,
    // SIM:488-497, would report that as a state change; no vector reaches it); on a chain, and here, the transaction
    // reverts as a whole
    seedHolder(h.sim, seriesId, b2.address, { escrowed: 100n });
    await refused(h, () => tail(b2), 'NoRedeemedUnits');
    seedHolder(h.sim, seriesId, b2.address, { escrowed: 0n });

    // a wallet registered after the redemption with no units has redeemed nothing (vector 22 #97-98)
    const late = new SimWallet(h.sim.family, 'late-holder');
    await h.sim.submit({ kind: 'setAllowlist', wallet: late.address, allowed: true }, 'allowlistManager');
    expect(types((await h.sim.submit({ kind: 'registerHolder', seriesId, wallet: late.address }, 'keeper')).events)).toEqual(['HolderRegistered']);
    await refused(h, () => tail(late), 'NoRedeemedUnits');
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(4_053_086_422n);
  });
});

describe('claimFinal (Stage 1 claim_final)', () => {
  it('refuses a live series and a stranger; pays pending + share on accrual units, delivers first, burns after, then 0', async () => {
    const { h, seriesId, settledAt } = await settled({ settle: 'process' });
    const [b0, b2, b3] = [h.backers[0]!, h.backers[2]!, h.backers[3]!];
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    // every bid is processed (the mint is final); all but b2 are delivered
    for (const b of h.backers) if (b !== b2) await h.sim.submit({ kind: 'deliverBid', seriesId, bidder: b.address }, 'keeper');
    const final = (w: SimWallet) => claim(h, w, { kind: 'claimFinal', seriesId });
    await h.sim.setTime(settledAt + DAY);
    // cause S3-FN: the status is checked first (SIM:1451), also for a stranger; burnRetired refuses a live series too
    await refused(h, () => final(b0), 'TerminalStatus');
    await refused(h, () => final(a1), 'TerminalStatus');
    await refused(h, () => h.sim.submit({ kind: 'burnRetired', seriesId, holder: b0.address }, 'keeper'), 'TerminalStatus');

    seedNetPayout(h, seriesId, USDC(2.5), 500n);
    await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    // one day after settlement only tranche 0 has vested: 2,250 returns through the final pool, 4.5 per unit
    expect((await h.sim.getSeries(seriesId))!.final).toEqual({ accWad: (USDC(4.5) * WAD).toString(), units: '500', distributed: USDC(2250).toString() });
    // S3-BR: an Extinguished series is not Retired (its units burn at claimFinal)
    await refused(h, () => h.sim.submit({ kind: 'burnRetired', seriesId, holder: b0.address }, 'keeper'), 'TerminalStatus');
    await refused(h, () => final(a1), 'HolderNotRegistered');

    // b0: pending 250 + share 4.5 × 100, weighed on its accrual units; the claim event comes before the burn
    const c0 = await final(b0);
    expect(types(c0.events)).toEqual(['FinalClaimed', 'UnitsBurned']);
    expect(c0.events[0]!.payload).toEqual({ seriesId, holder: b0.address, units: '100', amount: USDC(700).toString() });
    expect(c0.events[1]!.payload).toMatchObject({ units: '100', reason: 'extinguishment' });
    expect(c0.delta).toBe(USDC(700));
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '0', claimable: '0', finalClaimable: '0' });
    // cause S3-Z: a second claim pays nothing and burns nothing; its weight is what it holds now, 0 (Stage 1)
    const again = await final(b0);
    expect(again.events.map((e) => e.payload)).toEqual([{ seriesId, holder: b0.address, units: '0', amount: '0' }]);
    expect(again.delta).toBe(0n);

    // b2's auction units are still undelivered: they are delivered first (refund 1,010 − 909 = 101) and counted
    const c2 = await final(b2);
    expect(types(c2.events)).toEqual(['BidDelivered', 'FinalClaimed', 'UnitsBurned']);
    expect(c2.events[0]!.payload).toMatchObject({ units: '100', refund: USDC(101).toString() });
    expect(c2.events[1]!.payload).toMatchObject({ units: '100', amount: USDC(700).toString() });
    expect(c2.delta).toBe(USDC(801));
    // the series never redeemed: claimTail is refused (NotRedeemed)
    await refused(h, () => claim(h, b3, { kind: 'claimTail', seriesId }), 'NotRedeemed');
    // Stage 1's vault: 1,250 + 2,250 − 700 − 700
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(USDC(2100));
  });

  it('on a series that redeemed, weighs redeemed units and redeems a remaining balance first; the tail stays claimable', async () => {
    const { h, seriesId, settledAt } = await settled({ terms: { lockupSeconds: 10 } });
    const [b0, b1, b2, b3] = [h.backers[0]!, h.backers[1]!, h.backers[2]!, h.backers[3]!];
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const final = (w: SimWallet) => claim(h, w, { kind: 'claimFinal', seriesId });
    await h.sim.setTime(settledAt + 11);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    expect((await claim(h, b0, { kind: 'claimRedemption', seriesId })).delta).toBe(USDC(900));
    // white-box: 2.5 per unit on the 400 units still held (250 pending each for b1..b4)
    seedNetPayout(h, seriesId, USDC(2.5), 400n);
    await h.sim.setTime(settledAt + 12);
    await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    // the final units are the units at redemption, 500: 2,250 / 500 = 4.5 per unit
    expect((await h.sim.getSeries(seriesId))!.final).toMatchObject({ units: '500', accWad: (USDC(4.5) * WAD).toString() });

    // b0 redeemed everything before: weight = its 100 redeemed units, nothing to burn
    const c0 = await final(b0);
    expect(c0.events.map((e) => [e.type, e.payload])).toEqual([['FinalClaimed', { seriesId, holder: b0.address, units: '100', amount: USDC(450).toString() }]]);
    expect(c0.delta).toBe(USDC(450));
    // b1 still holds 100 units: the redemption body pays pending 250 + 900 first, then the share 450 (Stage 1: 1,600)
    const c1 = await final(b1);
    expect(types(c1.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed', 'FinalClaimed']);
    expect(c1.events[0]!.payload).toMatchObject({ amount: USDC(250).toString(), burnedUnits: '0' });
    expect(c1.events[2]!.payload).toMatchObject({ units: '100', amount: USDC(900).toString() });
    expect(c1.events[3]!.payload).toMatchObject({ units: '100', amount: USDC(450).toString() });
    expect(c1.delta).toBe(USDC(1600));
    // cause S3-Z: again, the weight stays its redeemed units and the share is not paid twice
    const again = await final(b1);
    expect(again.events.map((e) => e.payload)).toEqual([{ seriesId, holder: b1.address, units: '100', amount: '0' }]);
    // claim_tail checks the redemption only (not the status): on the extinguished series it redeems b2 first, tail 0
    const t2 = await claim(h, b2, { kind: 'claimTail', seriesId });
    expect(types(t2.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed', 'TailClaimed']);
    expect(t2.delta).toBe(USDC(1150));
    expect((await final(b2)).delta).toBe(USDC(450));
    await refused(h, () => h.sim.submit({ kind: 'burnRetired', seriesId, holder: b3.address }, 'keeper'), 'TerminalStatus');
    // Stage 1's vault: 4,500 + 1,000 + 2,250 − 900 − 450 − 1,600 − 1,150 − 450
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(USDC(3200));
  });
});

describe('burnRetired (Stage 1 burn_retired)', () => {
  it('burns a Retired holder\'s balance for anyone, emits a burn of 0 for a wallet holding nothing, refuses an unregistered holder', async () => {
    const { h, seriesId } = await settled({ terms: { lockupSeconds: 30 * DAY } });
    const [b0, b1, b3, b4] = [h.backers[0]!, h.backers[1]!, h.backers[3]!, h.backers[4]!];
    const stranger = h.attestors[0]!.address;
    await h.sim.setTime(Date.UTC(2026, 1, 10) / 1000);
    // white-box: the vault has paid the full cap; redeem retires the series instead (SIM:1353-1357)
    seedVault(h.sim, seriesId, { paidPerUnitWad: USDC(22.5) * WAD });
    expect(types((await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: '0' })).events)).toEqual(['StatusChanged', 'SeriesRetired']);
    seedNetPayout(h, seriesId, USDC(2.5), 500n);
    const burn = (holder: string, by?: SimWallet) => (by ? h.exec(by, { kind: 'burnRetired', seriesId, holder }) : h.sim.submit({ kind: 'burnRetired', seriesId, holder }, 'keeper'));

    // cause S3-BR, S3-Z: a wallet that never held units: a burn of 0, before any registration check (21#51), from any
    // wallet or the keeper
    for (const by of [b4, undefined]) {
      const z = await burn(stranger, by);
      expect(z.events.map((e) => [e.type, e.payload])).toEqual([['UnitsBurned', { seriesId, holder: stranger, units: '0', reason: 'cap' }]]);
    }
    // a wallet with units that is not registered (white-box) is refused: the burn settles the holder first
    seedHolder(h.sim, seriesId, b3.address, { registered: false });
    await refused(h, () => burn(b3.address), 'HolderNotRegistered');
    // b0's 100 units burn, sent by another wallet; nothing is paid, its 250 stays claimable
    const before = await balance(h, b0.address);
    const c = await burn(b0.address, b4);
    expect(c.events.map((e) => [e.type, e.payload])).toEqual([['UnitsBurned', { seriesId, holder: b0.address, units: '100', reason: 'cap' }]]);
    expect(await balance(h, b0.address)).toBe(before);
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '0', claimable: USDC(250).toString() });
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('400');
    const paid = await claim(h, b0, { kind: 'claimPayout', seriesId });
    expect(paid.events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: b0.address, amount: USDC(250).toString(), burnedUnits: '0' }]]);
    // a repeat is a burn of 0
    expect((await burn(b0.address)).events.map((e) => (e.payload as { units: string }).units)).toEqual(['0']);
    // cause S3-BU: a claim on a Retired series names the units it burns (Stage 1: amount 250, burned 100)
    const c1 = await claim(h, b1, { kind: 'claimPayout', seriesId });
    expect(types(c1.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(payload(c1.events, 'PayoutClaimed')).toMatchObject({ amount: USDC(250).toString(), burnedUnits: '100' });
    // Stage 1's vault and units outstanding: 1,250 − 250 − 250; 500 − 100 − 100
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(USDC(750));
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('300');
  });
});
