import { describe, expect, it } from 'vitest';
import { bidCommitment, nextSettlementStep, permissionlessCommandKinds, type PermissionlessCommand, type SettlementView } from '@merces/domain';
import { requiredEscrow } from '@merces/math';
import { SimHarness, SimulatorChain, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, expectChainError } from './helpers.ts';

/*
 * S2 cause codes:
 *  - S2-MS: multi-step settlement (Stage 1's permissionless commands, the planner, the chain's limits).
 */

/** The harness's default raise, committed and revealed but not settled; the clock at the reveal end. */
async function revealedRaise(h: SimHarness): Promise<{ seriesId: string; revealEndsAt: number }> {
  const { terms } = defaultTerms(h.sim);
  await h.exec(h.issuer, { kind: 'registerIssuer' });
  const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
  const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
  await h.exec(h.issuer, { kind: 'openRaise', seriesId });
  const { commitEndsAt, revealEndsAt } = (await h.sim.getAuction(seriesId))!;
  const bids = [12, 11, 10, 10, 9].map((p, i) => ({ w: h.backers[i]!, price: USDC(p), qty: 100n, salt: '0x' + String(i + 1).padStart(2, '0').repeat(32) }));
  for (const b of bids) {
    const commitment = bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: b.qty, salt: b.salt });
    await h.exec(b.w, { kind: 'commitBid', seriesId, commitment, deposit: requiredEscrow(b.price, b.qty, terms.auctionFeeBps).toString() });
  }
  await h.sim.setTime(commitEndsAt!);
  for (const b of bids) await h.exec(b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: b.qty.toString(), salt: b.salt });
  await h.sim.setTime(revealEndsAt! - 1);
  return { seriesId, revealEndsAt: revealEndsAt! };
}

describe('settlement plumbing (S2 WP3; the engine runs it from WP4)', () => {
  it('reports the personality\'s settlement limits, derived on every read and never persisted', async () => {
    const sol = SimulatorChain.createSync({ personality: 'solana', genesis: GENESIS });
    const mon = SimulatorChain.createSync({ personality: 'monad', genesis: GENESIS });
    expect((await sol.info()).limits).toEqual({ tallyPageMax: 24, maxBidsPerAuction: null });
    expect((await mon.info()).limits).toEqual({ tallyPageMax: 200, maxBidsPerAuction: 4096 });
    expect('limits' in sol.state.config).toBe(false);
  });

  // TRANSITIONAL (deleted in S2 WP4, which implements the six commands)
  it('builds every permissionless command for any wallet, and the engine refuses them until WP4 (NotImplemented)', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId } = await revealedRaise(h);
    const anyone = h.backers[4]!;
    const cmds: PermissionlessCommand[] = [
      { kind: 'beginSettlement', seriesId, clearingPrice: '9000000', qAboveClaim: '400', qAtClaim: '100' },
      { kind: 'tallyBids', seriesId, maxBids: 24 },
      { kind: 'finalizeSettlement', seriesId },
      { kind: 'processBid', seriesId, bidder: h.backers[0]!.address },
      { kind: 'deliverBid', seriesId, bidder: h.backers[0]!.address },
      { kind: 'registerHolder', seriesId, wallet: anyone.address },
    ];
    expect(cmds.map((c) => c.kind)).toEqual(permissionlessCommandKinds);
    const txCount = h.sim.state.txCount;
    for (const cmd of cmds) {
      const tx = await h.sim.build(cmd, anyone.address);
      expect(tx.command).toEqual(cmd);
      await expectChainError(h.sim.send(await anyone.sign(tx)), 'NotImplemented');
      await expectChainError(h.sim.submit(cmd, 'keeper'), 'NotImplemented');
    }
    expect(h.sim.state.txCount).toBe(txCount);
    // an unknown kind is still refused at build
    await expect(h.sim.build({ kind: 'settleEverything', seriesId } as never, anyone.address)).rejects.toThrow();
  });

  // S2 amendment M3: the planner reads the stored raise state, not the display phase (which reads Reveal after the end)
  it('plans from a real auction read: wait during the reveal, then Stage 1\'s proposal once it has ended', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId, revealEndsAt } = await revealedRaise(h);
    const terms = (await h.sim.getSeries(seriesId))!.terms;
    const limits = (await h.sim.info()).limits;
    const plan = async () => {
      const a = (await h.sim.getAuction(seriesId))!;
      const bids = await h.sim.listBids(seriesId);
      // until WP4 the chain's auction and bid reads lack the settlement fields: a raise before its first round has
      // these values, and the harness's five bids are valid under Stage 1's rule
      const view: SettlementView = {
        auction: { ...a, validCount: a.revealedCount, round: 0, roundRejected: false, proposal: null, tally: { talliedCount: 0 }, mintFinalized: false },
        bids: bids.map((b) => ({ ...b, revealIndex: b.revealed ? b.order : null, valid: b.revealed ? true : null, processed: false, delivered: false })),
        terms,
      };
      return { a, step: nextSettlementStep(view, { now: await h.sim.now(), limits, deliver: true }) };
    };
    const during = await plan();
    expect([during.a.phase, during.a.raiseState]).toEqual(['Reveal', 'Open']);
    expect(during.step).toEqual({ kind: 'wait', until: revealEndsAt, stage: 'reveal' });
    await h.sim.setTime(revealEndsAt);
    const after = await plan();
    // the display phase still reads Reveal past the reveal end; the stored state says Open, and the plan proposes
    expect([after.a.phase, after.a.raiseState]).toEqual(['Reveal', 'Open']);
    expect(after.step).toEqual({ kind: 'submit', command: { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' }, stage: 'awaiting-proposal' });
  });
});
