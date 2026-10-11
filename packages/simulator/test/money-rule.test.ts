import { describe, expect, it } from 'vitest';
import { ChainError, type DomainEvent, type UserCommand } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { SimHarness, SimWallet, serialiseState } from '../src/index.ts';
import { GENESIS, USDC } from './helpers.ts';
import { seriesOf } from './kit.ts';

/**
 * The money-per-event rule of Stage 1's claim family (S3 plan D3 and D4; cause S3-CL, S3-Z, S3-BU, S3-TL, S3-FN), as one
 * invariant over every claim a holder can send in every state a series can be in: live, Retired, Redeemed with a tail,
 * extinguished after a redemption and extinguished without one, with an auction bid left undelivered in each.
 *
 * For every claim (`claimPayout`, `claimRedemption`, `claimTail`, `claimFinal`) sent by every holder and a stranger,
 * twice in a row:
 *  - a refused claim changes nothing at all;
 *  - every stablecoin amount it moves appears in exactly one event amount: the wallet's balance moves by the sum of the
 *    claim events' amounts (`PayoutClaimed`, `RedemptionClaimed`, `TailClaimed`, `FinalClaimed`) plus the refund of a
 *    bid it delivers (`BidDelivered.refund`, paid from the auction escrow), and the vault by minus the claim amounts;
 *  - the claim's own event is emitted exactly once, zeros included (the zero-amount rule); a `PayoutClaimed` split out
 *    of a redemption appears only above 0 and burns nothing; `claimPayout` emits exactly one `PayoutClaimed`, whose
 *    `burnedUnits` are the units its `UnitsBurned` burns, on a Retired series only, the claim event first;
 *  - the units outstanding fall by exactly the units the claim's `UnitsBurned` events burn.
 *
 * S4 cause codes:
 *  - S4-EXT: an extinguishment is Stage 1's permissionless `extinguish` carrying two attestor keys' EXTINGUISH signatures
 *    over the live extinguish nonce, relayed by the keeper (`h.extinguishment`; S4 WP12; was `{attestors}` with the
 *    second attestor co-signing the first one's transaction).
 *  - S4-CS: nobody co-signs (S4 WP13): the harness attestors are keys, not wallets, so a stranger is a wallet of its own
 *    (was the first attestor's transitional wallet at its key's address).
 */

const DAY = 86_400;
type ClaimKind = 'claimPayout' | 'claimRedemption' | 'claimTail' | 'claimFinal';
const OWN: Record<ClaimKind, string> = { claimPayout: 'PayoutClaimed', claimRedemption: 'RedemptionClaimed', claimTail: 'TailClaimed', claimFinal: 'FinalClaimed' };
const CLAIM_EVENTS = new Set(Object.values(OWN));
const ALL: ClaimKind[] = ['claimPayout', 'claimRedemption', 'claimTail', 'claimFinal'];

const balance = async (h: SimHarness, wallet: string) => BigInt(await h.sim.getBalance(wallet, 'USDC'));
const p = (e: DomainEvent) => e.payload as Record<string, string>;
const sum = (evs: DomainEvent[], field: string) => evs.reduce((a, e) => a + BigInt(p(e)[field]!), 0n);

/** What the sweeps reached, so the test can show each rule was exercised and not passed vacuously. */
interface Seen {
  claims: Record<ClaimKind, number>;
  refusals: Set<string>;
  zeroOwn: Set<string>;
  burnsOnZeroClaim: number;
  splitPayouts: number;
  refunds: number;
}

async function check(h: SimHarness, seriesId: string, w: SimWallet, kind: ClaimKind, seen: Seen): Promise<void> {
  const before = serialiseState(h.sim.state);
  const s0 = seriesOf(h.sim, seriesId);
  const [vault0, units0, status] = [s0.vaultBalance, s0.unitsOutstanding, s0.status];
  const bal0 = await balance(h, w.address);
  const at = `${kind} by ${w.address} on ${status}`;
  let events: DomainEvent[];
  try {
    events = (await h.exec(w, { kind, seriesId } as UserCommand)).events;
  } catch (e) {
    expect(e, at).toBeInstanceOf(ChainError);
    expect(serialiseState(h.sim.state), `${at}: a refused claim changes nothing`).toBe(before);
    seen.refusals.add(`${kind} ${(e as ChainError).detail?.stage1 as string}`);
    return;
  }
  seen.claims[kind]++;
  for (const e of events) expect(p(e).holder ?? p(e).bidder, `${at}: ${e.type} is the claimant's`).toBe(w.address);
  const claimEvents = events.filter((e) => CLAIM_EVENTS.has(e.type));
  const claimed = sum(claimEvents, 'amount');
  const refunds = sum(events.filter((e) => e.type === 'BidDelivered'), 'refund');
  const burned = sum(events.filter((e) => e.type === 'UnitsBurned'), 'units');
  const s1 = seriesOf(h.sim, seriesId);
  // every amount once: the wallet, the vault and the units outstanding move by what the events say, nothing more
  expect((await balance(h, w.address)) - bal0, `${at}: wallet`).toBe(claimed + refunds);
  expect(vault0 - s1.vaultBalance, `${at}: vault`).toBe(claimed);
  expect(units0 - s1.unitsOutstanding, `${at}: units outstanding`).toBe(burned);
  // the claim's own event, exactly once, zeros included
  const own = events.filter((e) => e.type === OWN[kind]);
  expect(own, `${at}: its own event once`).toHaveLength(1);
  if (BigInt(p(own[0]!).amount!) === 0n) seen.zeroOwn.add(kind);
  if (refunds > 0n) seen.refunds++;
  if (kind === 'claimPayout') {
    expect(events.map((e) => e.type), `${at}: PayoutClaimed then its burn`).toEqual(burned > 0n ? ['PayoutClaimed', 'UnitsBurned'] : ['PayoutClaimed']);
    expect(BigInt(p(own[0]!).burnedUnits!), `${at}: burnedUnits`).toBe(burned);
    if (burned > 0n) expect(status, `${at}: only a Retired series burns on claim`).toBe('Retired');
    if (burned > 0n && claimed === 0n) seen.burnsOnZeroClaim++;
  } else {
    // a PayoutClaimed inside another claim is the redemption body's split-out payout: above 0 only, burning nothing
    for (const e of events.filter((x) => x.type === 'PayoutClaimed')) {
      expect(BigInt(p(e).amount!), `${at}: split-out payout above 0`).toBeGreaterThan(0n);
      expect(p(e).burnedUnits, at).toBe('0');
      seen.splitPayouts++;
    }
    if (kind === 'claimTail') expect(events.at(-1)!.type, `${at}: TailClaimed last`).toBe('TailClaimed');
    if (kind === 'claimFinal') {
      const i = events.findIndex((e) => e.type === 'FinalClaimed');
      expect(events.slice(i + 1).map((e) => [e.type, p(e).reason]), `${at}: only its burn after FinalClaimed`).toEqual(events.slice(i + 1).length ? [['UnitsBurned', 'extinguishment']] : []);
    }
  }
}

/** Every claim of `kinds` by every wallet, each sent twice in a row. */
async function sweep(h: SimHarness, seriesId: string, wallets: SimWallet[], seen: Seen, kinds: ClaimKind[] = ALL): Promise<void> {
  for (const w of wallets) for (const kind of kinds) for (let i = 0; i < 2; i++) await check(h, seriesId, w, kind, seen);
}

describe('the money-per-event rule of the claim family (S3 D3, D4)', () => {
  it('holds for every claim by every holder in every state: live, Retired, Redeemed with a tail, extinguished with and without a redemption', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const [b0, b1, b2, b3, b4] = h.backers as [SimWallet, SimWallet, SimWallet, SimWallet, SimWallet];
    const stranger = new SimWallet(h.sim.family, 'stranger'); // cause S4-CS
    const seen: Seen = { claims: { claimPayout: 0, claimRedemption: 0, claimTail: 0, claimFinal: 0 }, refusals: new Set(), zeroOwn: new Set(), burnsOnZeroClaim: 0, splitPayouts: 0, refunds: 0 };
    // three series raised side by side; every bid processed and delivered but one per series (held back to be delivered
    // by a claim, or by a delivery after the series retired)
    const raise = async (undelivered: SimWallet, lockupSeconds?: number) => {
      const r = await h.runRaise({ settle: 'process', ...(lockupSeconds ? { terms: { lockupSeconds } } : {}) });
      for (const b of h.backers) if (b !== undelivered) await h.sim.submit({ kind: 'deliverBid', seriesId: r.seriesId, bidder: b.address }, 'keeper');
      return r;
    };
    const A = await raise(b4, 30 * DAY); // live, then Redeemed with a tail, then extinguished
    const B = await raise(b3); // Retired at its cap
    const C = await raise(b2); // extinguished without a redemption
    const settledA = (await h.sim.getSeries(A.seriesId))!.settledAt!;

    // Q1: 70,000 of income pays 1,000 into A and C; 200,000 reaches B's cap and retires it
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    for (const x of [A, C]) await h.reportAndPay(x.seriesId, '2026Q1', x.privateTerms, x.terms.termsCommitment, 0n, USDC(70_000));
    await h.reportAndPay(B.seriesId, '2026Q1', B.privateTerms, B.terms.termsCommitment, 0n, USDC(200_000));
    expect((await h.sim.getSeries(B.seriesId))!.status).toBe('Retired');

    // live: the net payout only; no redemption, tail or final claim yet
    await sweep(h, A.seriesId, [b0, b1, stranger], seen);
    // Retired: the claim pays and burns the balance (b3's units, undelivered, are not in it); burnRetired takes the rest;
    // b3's bid, delivered after the retirement, burns at its next claim with nothing to pay
    await sweep(h, B.seriesId, [b0, b1, b2, b3, stranger], seen);
    for (const b of h.backers) await h.sim.submit({ kind: 'burnRetired', seriesId: B.seriesId, holder: b.address }, 'keeper');
    await h.sim.submit({ kind: 'deliverBid', seriesId: B.seriesId, bidder: b3.address }, 'keeper');
    await sweep(h, B.seriesId, [b3, b4], seen);
    // extinguished without a redemption: the final share on accrual units, the undelivered bid delivered first
    await h.sim.submit(await h.extinguishment(C.seriesId), 'keeper'); // cause S4-EXT
    await sweep(h, C.seriesId, [b2, b0], seen, ['claimFinal', 'claimPayout', 'claimTail', 'claimRedemption']);
    await sweep(h, C.seriesId, [b1, b3, b4, stranger], seen);

    // A redeems; b0 and b4 (its bid undelivered) redeem before the tail is paid
    await h.sim.setTime(Math.max(settledA + 31 * DAY, parsePeriod('2026Q1').end + 2 * DAY));
    await h.exec(h.issuer, { kind: 'redeem', seriesId: A.seriesId, maxPricePerUnit: USDC(100).toString() });
    await sweep(h, A.seriesId, [b0, b4], seen);
    // a Q2 liquidity event pays the tail; b1 claims every way, b2 sends claimTail first (it redeems first)
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(A.seriesId, '2026Q2', A.privateTerms, A.terms.termsCommitment, USDC(70_000), USDC(2_000_000), { liquidityEvent: true });
    await sweep(h, A.seriesId, [b0, b1, b4, stranger], seen);
    await sweep(h, A.seriesId, [b2], seen, ['claimTail', 'claimPayout', 'claimRedemption', 'claimFinal']);
    // a wallet registered after the redemption with no units: every claim of nothing succeeds with zeros, but the
    // tail claim is refused (it has redeemed nothing)
    const late = new SimWallet(h.sim.family, 'late-holder');
    await h.sim.submit({ kind: 'setAllowlist', wallet: late.address, allowed: true }, 'allowlistManager');
    await h.sim.submit({ kind: 'registerHolder', seriesId: A.seriesId, wallet: late.address }, 'keeper');
    await sweep(h, A.seriesId, [late], seen);
    // extinguished after the redemption: b3 has not redeemed (claimFinal redeems it first), the others weigh their
    // redeemed units
    await h.sim.submit(await h.extinguishment(A.seriesId), 'keeper'); // cause S4-EXT
    await sweep(h, A.seriesId, [b3], seen, ['claimFinal', 'claimTail', 'claimPayout', 'claimRedemption']);
    await sweep(h, A.seriesId, [b0, b1, b2, b4, late, stranger], seen);

    // the rules were exercised, not passed vacuously
    for (const kind of ALL) expect(seen.claims[kind], kind).toBeGreaterThan(4);
    expect([...seen.zeroOwn].sort()).toEqual([...ALL].sort()); // every claim's own event with a 0 amount
    expect(seen.burnsOnZeroClaim).toBeGreaterThan(0); // a claim of 0 on a Retired series that burns
    expect(seen.splitPayouts).toBeGreaterThan(0); // a redemption body's pending payout inside claimTail or claimFinal
    expect(seen.refunds).toBeGreaterThan(0); // a bid delivered by a claim
    expect([...seen.refusals].sort()).toEqual([
      'claimFinal HolderNotRegistered', 'claimFinal TerminalStatus', 'claimPayout HolderNotRegistered', 'claimRedemption HolderNotRegistered',
      'claimRedemption NotRedeemed', 'claimTail HolderNotRegistered', 'claimTail NoRedeemedUnits', 'claimTail NotRedeemed',
    ]);
    // nothing is left owed but the floors' dust: every vault holds no less than its dust
    for (const x of [A, B, C]) {
      const v = (await h.sim.getVault(x.seriesId))!;
      expect(BigInt(v.balance) - BigInt(v.dust), x.seriesId).toBe(0n);
    }
  }, 60_000);
});
