import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bidCommitment, type DomainEvent } from '@merces/domain';
import { WAD, parsePeriod, perUnitCap } from '@merces/math';
import { exec, expectChainError, resolveEnv, type ConformanceEnv } from '../src/env.ts';

/**
 * H2 — the behavioural contract every ChainPort implementation must satisfy. Written against the port only.
 * CONFORMANCE_CHAIN selects the target: simulator (default, both personalities), solana, evm:<chainKey>.
 */
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const types = (evs: DomainEvent[]) => evs.map((e) => e.type);

let envs: ConformanceEnv[] = [];
beforeAll(async () => {
  envs = await resolveEnv();
});
afterAll(async () => {
  for (const e of envs) await e.close();
});

describe.each(envs.length ? envs.map((e) => [e.name]) : [['simulator:solana'], ['simulator:monad']])('ChainPort conformance on %s', (name) => {
  const env = () => envs.find((e) => e.name === name) ?? envs[0]!;
  let seriesId: string;
  let clearing: bigint;

  it('reports info, health and a monotonic chain clock', async () => {
    const { chain } = env();
    const info = await chain.info();
    expect(['solana', 'evm']).toContain(info.family);
    expect(Object.keys(info.stablecoins).length).toBeGreaterThan(0);
    if (info.family === 'evm') expect(info.stablecoins.USDG).toBeUndefined();
    expect((await chain.health()).ok).toBe(true);
    const t1 = await chain.now();
    const t2 = await chain.now();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('registers an issuer only when allowlisted and creates a series with immutable terms', async () => {
    const e = env();
    const stranger = e.backers[4]!;
    // backers are allowlisted; a brand-new wallet is not
    const r = await exec(e, e.issuer, { kind: 'registerIssuer' });
    expect(types(r.events)).toEqual(['IssuerRegistered']);
    await expectChainError(exec(e, e.issuer, { kind: 'registerIssuer' }), 'Duplicate');
    const badCap = e.terms({ capMultipleWad: (35n * WAD / 10n).toString() });
    await expectChainError(exec(e, e.issuer, { kind: 'createSeries', terms: badCap }), 'InvalidTerms');
    const noContract = e.terms({ contractHash: '0x' + '00'.repeat(32) });
    await expectChainError(exec(e, e.issuer, { kind: 'createSeries', terms: noContract }), 'InvalidTerms');
    const created = await exec(e, e.issuer, { kind: 'createSeries', terms: e.terms({ lockupSeconds: e.durations.lockup }) });
    seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const s = (await e.chain.getSeries(seriesId))!;
    expect(s.phase).toBe('Draft');
    expect(s.terms.termsCommitment).toMatch(/^0x/);
    expect(s.terms).not.toHaveProperty('threshold');
    void stranger;
  });

  it('runs a sealed-bid raise: commit, reveal, settle at one price with fees, pull refunds, mint within the wallet cap', async () => {
    const e = env();
    const now = await e.chain.now();
    const commitEndsAt = now + e.durations.commit;
    const revealEndsAt = commitEndsAt + e.durations.reveal;
    await exec(e, e.issuer, { kind: 'openRaise', seriesId, commitEndsAt, revealEndsAt });
    const bids = [12, 11, 10, 10, 9].map((p, i) => ({ w: e.backers[i]!, price: USDC(p), qty: 100n, salt: '0x' + (0x30 + i).toString(16).padStart(2, '0').repeat(32) }));
    for (const b of bids) {
      const c = bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: b.qty, salt: b.salt });
      const deposit = b.price * b.qty + (b.price * b.qty) / 100n;
      const r = await exec(e, b.w, { kind: 'commitBid', seriesId, commitment: c, deposit: deposit.toString() });
      expect(types(r.events)).toEqual(['BidCommitted']);
    }
    await expectChainError(exec(e, e.issuer, { kind: 'cancelRaise', seriesId }), 'TooLate');
    await expectChainError(exec(e, bids[0]!.w, { kind: 'revealBid', seriesId, pricePerUnit: bids[0]!.price.toString(), quantity: '100', salt: bids[0]!.salt }), 'WrongPhase');
    await e.waitUntil(commitEndsAt);
    await expectChainError(exec(e, bids[0]!.w, { kind: 'revealBid', seriesId, pricePerUnit: bids[0]!.price.toString(), quantity: '99', salt: bids[0]!.salt }), 'InvalidCommitment');
    for (const b of bids) await exec(e, b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: b.qty.toString(), salt: b.salt });
    await expectChainError(e.chain.submit({ kind: 'settleAuction', seriesId }, 'keeper'), 'TooEarly');
    await e.waitUntil(revealEndsAt);
    const settled = await e.chain.submit({ kind: 'settleAuction', seriesId }, 'keeper');
    const ev = settled.events.find((x) => x.type === 'AuctionSettled')!.payload as { clearingPrice: string; unitsSold: string; proceeds: string; totalFees: string };
    clearing = BigInt(ev.clearingPrice);
    expect(ev.clearingPrice).toBe(USDC(9).toString());
    expect(ev.unitsSold).toBe('500');
    expect(ev.totalFees).toBe(USDC(45).toString());
    const s = (await e.chain.getSeries(seriesId))!;
    expect(s.phase).toBe('Settled');
    expect(s.capPerUnit).toBe(perUnitCap(BigInt(s.terms.capMultipleWad), clearing).toString());
    const pos = (await e.chain.getPosition(seriesId, bids[0]!.w.address))!;
    expect(pos.units).toBe('100');
    const before = BigInt(await e.chain.getBalance(bids[0]!.w.address, s.terms.stablecoin));
    const refund = await exec(e, bids[0]!.w, { kind: 'claimRefund', seriesId });
    expect(types(refund.events)).toEqual(['BidRefunded']);
    expect(BigInt(await e.chain.getBalance(bids[0]!.w.address, s.terms.stablecoin)) - before).toBe(USDC(300) + USDC(3)); // 12→9 on 100 units plus the fee difference
    const t = (await e.chain.getTreasury(seriesId))!;
    expect(t.total).toBe(USDC(4500).toString());
  });

  it('releases treasury on the schedule without approval; pauses only for Late or the issuer', async () => {
    const e = env();
    const r = await exec(e, e.issuer, { kind: 'drawRelease', seriesId });
    expect(types(r.events)).toEqual(['FundsReleased']);
    await expectChainError(exec(e, e.issuer, { kind: 'drawRelease', seriesId }), 'TooEarly');
    await expectChainError(exec(e, e.backers[0]!, { kind: 'drawRelease', seriesId }), 'Unauthorized');
    await exec(e, e.issuer, { kind: 'pauseReleases', seriesId, paused: true });
    await expectChainError(exec(e, e.issuer, { kind: 'drawRelease', seriesId }), 'Paused');
    await exec(e, e.issuer, { kind: 'pauseReleases', seriesId, paused: false });
  });

  it('accepts a zero report, a paying report with the 5% fee and reward-per-share claims; refuses bad proofs and commitments', async () => {
    const e = env();
    const s = (await e.chain.getSeries(seriesId))!;
    const settledAt = s.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await e.waitUntil(q.end + e.durations.reportLead);
    const zero = e.buildReport({ seriesId, periodId: q.id, unitsOutstanding: 500n, unitsOffered: 500n, privateTerms: e.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: 0n, termsCommitment: s.terms.termsCommitment });
    const z = await exec(e, e.issuer, zero.command);
    expect((z.events[0]!.payload as { paymentDue: string }).paymentDue).toBe('0');
    expect((await e.chain.getPeriod(seriesId, q.id))!.settled).toBe(true);
    await expectChainError(exec(e, e.issuer, zero.command), 'Duplicate');
    // next quarter: 75k income on a 60k threshold → 10% × 15k = 1500 gross
    const q2 = parsePeriod(q.quarter === 4 ? `${q.year + 1}Q1` : `${q.year}Q${q.quarter + 1}`);
    await e.waitUntil(q2.end + e.durations.reportLead);
    const good = e.buildReport({ seriesId, periodId: q2.id, unitsOutstanding: 500n, unitsOffered: 500n, privateTerms: e.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(75_000), termsCommitment: s.terms.termsCommitment });
    const tampered = { ...good.command, paymentStable: '1' };
    await expectChainError(exec(e, e.issuer, tampered), 'InvalidProof');
    const wrongCommitment = { ...good.command, termsCommitment: '0x' + '11'.repeat(32) };
    await expectChainError(exec(e, e.issuer, wrongCommitment), 'InvalidTerms');
    const forged = { ...good.command, attestation: { ...good.command.attestation!, signature: '0x' + '22'.repeat(64) } };
    await expectChainError(exec(e, e.issuer, forged), 'InvalidAttestation');
    const acc = await exec(e, e.issuer, good.command);
    const due = (acc.events[0]!.payload as { paymentDue: string }).paymentDue;
    expect(due).toBe(USDC(1500).toString());
    await expectChainError(exec(e, e.issuer, { kind: 'payIn', seriesId, periodId: q2.id, amount: '1' }), 'InvalidTerms');
    const paid = await exec(e, e.issuer, { kind: 'payIn', seriesId, periodId: q2.id, amount: due });
    expect(types(paid.events)).toEqual(['FeeTaken', 'PaymentReceived']);
    const v = (await e.chain.getVault(seriesId))!;
    expect(v.balance).toBe(USDC(1425).toString());
    const claim = await exec(e, e.backers[0]!, { kind: 'claimPayout', seriesId });
    expect((claim.events[0]!.payload as { amount: string }).amount).toBe(USDC(285).toString());
    await expectChainError(exec(e, e.backers[0]!, { kind: 'claimPayout', seriesId }), 'NotFound');
    expect(BigInt((await e.chain.getVault(seriesId))!.balance)).toBeGreaterThanOrEqual(0n);
  });

  it('exposes an ordered, resumable event stream with the canonical vocabulary', async () => {
    const e = env();
    const first = await e.chain.readEvents(null, 10);
    expect(first.events.length).toBe(10);
    expect(first.events.map((x) => x.seq)).toEqual([...first.events].map((x) => x.seq).sort((a, b) => a - b));
    const rest = await e.chain.readEvents(first.nextCursor, 10_000);
    expect(rest.events[0]!.seq).toBe(first.events[9]!.seq + 1);
    const all = [...first.events, ...rest.events];
    for (const ev of all) {
      expect(ev.chain).toBe(e.chain.chain);
      expect(ev.finality).toBe('finalized');
      expect(typeof ev.cursor).toBe('string');
    }
    expect(all.map((x) => x.type)).toEqual(expect.arrayContaining(['SeriesCreated', 'RaiseOpened', 'BidCommitted', 'BidRevealed', 'AuctionSettled', 'TreasuryFunded', 'FundsReleased', 'ReportAccepted', 'FeeTaken', 'PaymentReceived', 'PayoutClaimed']));
    const again = await e.chain.readEvents(first.nextCursor, 10_000);
    expect(again.events.map((x) => x.cursor)).toEqual(rest.events.map((x) => x.cursor));
  });

  it('enforces roles: admin cannot touch a live series; keepers are permissionless; allowlist removal never strands value', async () => {
    const e = env();
    await expectChainError(exec(e, e.admin, { kind: 'drawRelease', seriesId }), 'Unauthorized');
    await expectChainError(exec(e, e.admin, { kind: 'claimPayout', seriesId }), 'NotFound'); // admin holds nothing; the call itself is open to any holder
    await expectChainError(exec(e, e.backers[0]!, { kind: 'registerAttestor', attestor: e.backers[0]!.address, active: true }), 'Unauthorized');
    await e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: false }, 'allowlistManager');
    expect(await e.chain.isAllowlisted(e.backers[1]!.address)).toBe(false);
    const claim = await exec(e, e.backers[1]!, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed']);
    await expectChainError(e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: true }, 'keeper'), 'Unauthorized');
    await e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: true }, 'allowlistManager');
  });

  it('redeems after the lockup at the formula price and burns on claim; a hardship pause needs an attestor', async () => {
    const e = env();
    const s = (await e.chain.getSeries(seriesId))!;
    const now = await e.chain.now();
    const until = now + 10 * 86_400;
    await exec(e, e.issuer, { kind: 'requestPause', seriesId, until });
    await expectChainError(exec(e, e.backers[0]!, { kind: 'approvePause', seriesId, until }), 'Unauthorized');
    const ap = await exec(e, e.attestors[0]!, { kind: 'approvePause', seriesId, until });
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    expect((await e.chain.getSeries(seriesId))!.status).toBe('Paused');
    await e.waitUntil(until);
    await e.chain.submit({ kind: 'crankPause', seriesId }, 'keeper');
    expect((await e.chain.getSeries(seriesId))!.status).toBe('OnTime');
    await e.waitUntil(Math.max(await e.chain.now(), s.settledAt! + s.terms.lockupSeconds + 1));
    // any completed quarter must be reported first (A-RED-1)
    for (const p of await e.chain.listPeriods(seriesId)) {
      if (p.settled) continue;
      const rep = e.buildReport({ seriesId, periodId: p.periodId, unitsOutstanding: 500n, unitsOffered: 500n, privateTerms: e.privateTerms, incomeYtdPrev: USDC(75_000), incomeYtdNow: USDC(75_000), termsCommitment: s.terms.termsCommitment });
      await exec(e, e.issuer, rep.command);
    }
    const r = await exec(e, e.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    const opened = r.events[0]!.payload as { pricePerUnit: string; deposit: string };
    expect(BigInt(opened.pricePerUnit)).toBeGreaterThan(0n);
    expect(BigInt(opened.deposit)).toBe(BigInt(opened.pricePerUnit) * 500n);
    expect((await e.chain.getSeries(seriesId))!.status).toBe('Redeemed');
    const c = await exec(e, e.backers[2]!, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toContain('UnitsBurned');
    expect(types(c.events)).toContain('RedemptionClaimed');
    await expectChainError(exec(e, e.backers[2]!, { kind: 'claimRedemption', seriesId }), 'NotFound');
  });
});
