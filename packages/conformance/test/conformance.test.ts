import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bidCommitment, runSettlement, type DomainEvent } from '@merces/domain';
import { WAD, capPerUnit, parsePeriod, requiredEscrow } from '@merces/math';
import { conformanceTargets, envFor, exec, expectChainError, type ConformanceEnv } from '../src/env.ts';

/**
 * H2 — the behavioural contract every ChainPort implementation must satisfy. Written against the port only.
 * CONFORMANCE_CHAIN selects the target: simulator (default, both personalities), solana, evm:<chainKey>.
 */
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/*
 * Pins that moved with Stage 1 (S1 WP12) carry a cause code:
 *  - R: Stage 1's report rules: reports are sequential (WrongPeriod, code WrongPhase), and the chain proves against the
 *    series' live terms commitment, so a proof over other terms fails its public signals (InvalidProof);
 *  - C: Stage 1's zero-amount claim is a successful no-op (SIM:1268-1282); a wallet with no registration is refused
 *    (HolderNotRegistered, code NotFound);
 *  - P: Stage 1's approve_pause takes an active attestor's signature (InvalidAttestorSignature, code InvalidAttestation);
 *  - RD: Stage 1's claim_redemption of 0 units succeeds.
 * S2 cause codes:
 *  - S2-AD: commit and reveal durations are series terms; `openRaise` derives the phase ends from them;
 *  - S2-MS: Stage 1's multi-step settlement (begin, tally pages, finalize, a process per bid), permissionless, driven by
 *    the domain's `runSettlement`; Stage 1's error names (SettlementNotReady); `AuctionSettled` has no fee total;
 *  - S2-PR: push delivery (`deliverBid`, any wallet; the pull refund is retired): a winner's units count from processing;
 *  - S2-PU: per-bid money movement: one `FeeTaken` per processed winner.
 * S3 cause codes:
 *  - S3-Z: Stage 1's zero-amount rule: a claim of nothing succeeds and emits its event with zeros (`PayoutClaimed{0, 0}`);
 *  - S3-BU: `PayoutClaimed.burnedUnits`, 0 off a Retired series.
 */
const types = (evs: DomainEvent[]) => evs.map((e) => e.type);

// Targets are known at collection time; each describe builds its own env, so a single-chain target runs once.
describe.each(conformanceTargets())('ChainPort conformance on %s', (name) => {
  let current: ConformanceEnv | undefined;
  beforeAll(async () => {
    current = await envFor(name);
  });
  afterAll(async () => {
    await current?.close();
  });
  const env = (): ConformanceEnv => {
    if (!current) throw new Error(`conformance env ${name} was not created`);
    return current;
  };
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

  // cause S2-MS, S2-PR (was: the one-step settlement and a pulled refund)
  it('runs a sealed-bid raise: commit, reveal, Stage 1\'s settlement steps at one price with fees, push delivery, mint within the wallet cap', async () => {
    const e = env();
    const now = await e.chain.now();
    // cause S2-AD: the chain derives the phase ends from the series' durations
    const opened = await exec(e, e.issuer, { kind: 'openRaise', seriesId });
    const auction = (await e.chain.getAuction(seriesId))!;
    const commitEndsAt = auction.commitEndsAt!;
    const revealEndsAt = auction.revealEndsAt!;
    expect(opened.events.find((x) => x.type === 'RaiseOpened')!.payload).toMatchObject({ commitEndsAt, revealEndsAt });
    expect([commitEndsAt - now >= e.durations.commit, revealEndsAt - commitEndsAt]).toEqual([true, e.durations.reveal]);
    const bids = [12, 11, 10, 10, 9].map((p, i) => ({ w: e.backers[i]!, price: USDC(p), qty: 100n, salt: '0x' + (0x30 + i).toString(16).padStart(2, '0').repeat(32) }));
    const terms = (await e.chain.getSeries(seriesId))!.terms;
    for (const b of bids) {
      const c = bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: b.qty, salt: b.salt });
      const deposit = requiredEscrow(b.price, b.qty, terms.auctionFeeBps);
      const r = await exec(e, b.w, { kind: 'commitBid', seriesId, commitment: c, deposit: deposit.toString() });
      expect(types(r.events)).toEqual(['BidCommitted']);
    }
    await expectChainError(exec(e, e.issuer, { kind: 'cancelRaise', seriesId }), 'TooLate');
    await expectChainError(exec(e, bids[0]!.w, { kind: 'revealBid', seriesId, pricePerUnit: bids[0]!.price.toString(), quantity: '100', salt: bids[0]!.salt }), 'WrongPhase');
    await e.waitUntil(commitEndsAt);
    await expectChainError(exec(e, bids[0]!.w, { kind: 'revealBid', seriesId, pricePerUnit: bids[0]!.price.toString(), quantity: '99', salt: bids[0]!.salt }), 'InvalidCommitment');
    for (const b of bids) await exec(e, b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: b.qty.toString(), salt: b.salt });
    // settlement begins only after the reveal end (Stage 1 SettlementNotReady, code TooEarly)
    const early = e.chain.submit({ kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' }, 'keeper');
    await expect(early).rejects.toMatchObject({ code: 'TooEarly', detail: { stage1: 'SettlementNotReady' } });
    await e.waitUntil(revealEndsAt);
    // the keeper's steps up to the last process: the honest proposal, one tally page, finalize, a process per bid
    const run = await runSettlement(e.chain, seriesId, { until: 'process' });
    expect([run.steps, run.stage, run.stuck]).toEqual([['beginSettlement', 'tallyBids', 'finalizeSettlement', ...Array(5).fill('processBid')], 'delivering', undefined]);
    const events = run.results.flatMap((r) => r.events);
    const ev = events.find((x) => x.type === 'AuctionSettled')!.payload as { clearingPrice: string; unitsSold: string; proceeds: string };
    clearing = BigInt(ev.clearingPrice);
    expect(ev).toMatchObject({ clearingPrice: USDC(9).toString(), unitsSold: '500', proceeds: USDC(4500).toString() });
    expect(ev).not.toHaveProperty('totalFees'); // cause S2-MS: unknowable at finalize
    // cause S2-PU: the fees are taken bid by bid at processing (1% of 100 × 9 USDC per winner)
    const fees = events.filter((x) => x.type === 'FeeTaken').map((x) => BigInt((x.payload as { amount: string }).amount));
    expect([fees.length, fees.reduce((a, b) => a + b, 0n)]).toEqual([5, USDC(45)]);
    expect(types(events).filter((t) => t === 'UnitsAllocated')).toHaveLength(5);
    expect(types(events).at(-1)).toBe('RaiseMintFinalized');
    const s = (await e.chain.getSeries(seriesId))!;
    expect([s.phase, s.mintFinalized]).toEqual(['Settled', true]);
    expect(s.capPerUnit).toBe(capPerUnit(BigInt(s.terms.capMultipleWad), clearing).toString()); // Stage 1's capPerUnit
    // cause S2-PR: a winner's units count from processing, undelivered until its bid is delivered
    expect((await e.chain.getPosition(seriesId, bids[0]!.w.address))!).toMatchObject({ units: '100', undeliveredUnits: '100' });
    // the bidder delivers its own bid (any wallet may): its units and its refund (12 → 9 on 100 units plus the fee)
    const before = BigInt(await e.chain.getBalance(bids[0]!.w.address, s.terms.stablecoin));
    const own = await exec(e, bids[0]!.w, { kind: 'deliverBid', seriesId, bidder: bids[0]!.w.address });
    expect(types(own.events)).toEqual(['BidDelivered']);
    expect(own.events[0]!.payload).toMatchObject({ bidder: bids[0]!.w.address, units: '100', refund: (USDC(300) + USDC(3)).toString() });
    expect(BigInt(await e.chain.getBalance(bids[0]!.w.address, s.terms.stablecoin)) - before).toBe(USDC(300) + USDC(3));
    await expectChainError(exec(e, bids[0]!.w, { kind: 'deliverBid', seriesId, bidder: bids[0]!.w.address }), 'Duplicate'); // AlreadyDelivered
    expect((await e.chain.getPosition(seriesId, bids[0]!.w.address))!).toMatchObject({ units: '100', undeliveredUnits: '0' });
    // the keeper delivers the rest
    const rest = await runSettlement(e.chain, seriesId, { until: 'deliver' });
    expect([rest.steps, rest.stage]).toEqual([Array(4).fill('deliverBid'), 'complete']);
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

  it('accepts a zero report, a paying report with the 5% fee and reward-per-share claims; refuses bad proofs, other terms and replays', async () => {
    const e = env();
    const s = (await e.chain.getSeries(seriesId))!;
    const settledAt = s.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await e.waitUntil(q.end + e.durations.reportLead);
    const zero = await e.buildReport({ seriesId, periodId: q.id, unitsOutstanding: 500n, privateTerms: e.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: 0n, termsCommitment: s.terms.termsCommitment });
    const z = await exec(e, e.issuer, zero.command);
    expect((z.events[0]!.payload as { paymentDue: string }).paymentDue).toBe('0');
    expect((await e.chain.getPeriod(seriesId, q.id))!.settled).toBe(true);
    // the same report again: the period is no longer the next one (Stage 1 WrongPeriod; cause R: was Duplicate)
    await expectChainError(exec(e, e.issuer, zero.command), 'WrongPhase');
    // next quarter: 75k income on a 60k threshold → 10% × 15k = 1500 gross
    const q2 = parsePeriod(q.quarter === 4 ? `${q.year + 1}Q1` : `${q.year}Q${q.quarter + 1}`);
    await e.waitUntil(q2.end + e.durations.reportLead);
    const good = await e.buildReport({ seriesId, periodId: q2.id, unitsOutstanding: 500n, privateTerms: e.privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(75_000), termsCommitment: s.terms.termsCommitment });
    const tampered = { ...good.command, paymentStable: '1' };
    await expectChainError(exec(e, e.issuer, tampered), 'InvalidProof');
    // a proof over other terms than the series' live commitment (Stage 1 vector 14; cause R: was a command naming another
    // termsCommitment, refused InvalidTerms; the command no longer carries one)
    const otherTerms = await e.buildReport({ seriesId, periodId: q2.id, unitsOutstanding: 500n, privateTerms: { ...e.privateTerms, termsSalt: e.privateTerms.termsSalt + 1n }, incomeYtdNow: USDC(75_000) });
    await expectChainError(exec(e, e.issuer, otherTerms.command), 'InvalidProof');
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
    expect(claim.events[0]!.payload).toMatchObject({ amount: USDC(285).toString(), burnedUnits: '0' }); // cause S3-BU
    // a second claim with nothing accrued succeeds and emits its event with zeros (Stage 1's zero-amount rule; cause C: was
    // NotFound; cause S3-Z: was no event)
    const nothing = await exec(e, e.backers[0]!, { kind: 'claimPayout', seriesId });
    expect(nothing.events.map((x) => [x.type, x.payload])).toEqual([['PayoutClaimed', { seriesId, holder: e.backers[0]!.address, amount: '0', burnedUnits: '0' }]]);
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
    // cause S2-MS: Stage 1's settlement events, with their names
    expect(all.map((x) => x.type)).toEqual(expect.arrayContaining(['SeriesCreated', 'RaiseOpened', 'BidCommitted', 'BidRevealed', 'SettlementProposed', 'AuctionSettled', 'UnitsAllocated', 'TreasuryFunded', 'RaiseMintFinalized', 'BidDelivered', 'FundsReleased', 'ReportAccepted', 'FeeTaken', 'PaymentReceived', 'PayoutClaimed']));
    const again = await e.chain.readEvents(first.nextCursor, 10_000);
    expect(again.events.map((x) => x.cursor)).toEqual(rest.events.map((x) => x.cursor));
  });

  it('enforces roles: admin cannot touch a live series; keepers are permissionless; allowlist removal never strands value', async () => {
    const e = env();
    await expectChainError(exec(e, e.admin, { kind: 'drawRelease', seriesId }), 'Unauthorized');
    // admin holds no registration (Stage 1 HolderNotRegistered; cause C: still NotFound, unlike a registered holder's zero
    // claim); the call itself is open to any holder
    await expectChainError(exec(e, e.admin, { kind: 'claimPayout', seriesId }), 'NotFound');
    await expectChainError(exec(e, e.backers[0]!, { kind: 'registerAttestor', attestor: e.backers[0]!.address, active: true }), 'Unauthorized');
    await e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: false }, 'allowlistManager');
    expect(await e.chain.isAllowlisted(e.backers[1]!.address)).toBe(false);
    const claim = await exec(e, e.backers[1]!, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed']);
    expect(claim.events[0]!.payload).toMatchObject({ holder: e.backers[1]!.address, burnedUnits: '0' }); // cause S3-BU
    await expectChainError(e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: true }, 'keeper'), 'Unauthorized');
    await e.chain.submit({ kind: 'setAllowlist', wallet: e.backers[1]!.address, allowed: true }, 'allowlistManager');
  });

  it('redeems after the lockup at the formula price and burns on claim; a hardship pause needs an attestor', async () => {
    const e = env();
    const s = (await e.chain.getSeries(seriesId))!;
    const now = await e.chain.now();
    const until = now + 10 * 86_400;
    await exec(e, e.issuer, { kind: 'requestPause', seriesId, until });
    // Stage 1 approve_pause: a signer that is not an active attestor is InvalidAttestorSignature (code InvalidAttestation;
    // cause P: was Unauthorized)
    await expectChainError(exec(e, e.backers[0]!, { kind: 'approvePause', seriesId, until }), 'InvalidAttestation');
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
      const rep = await e.buildReport({ seriesId, periodId: p.periodId, unitsOutstanding: 500n, privateTerms: e.privateTerms, incomeYtdPrev: USDC(75_000), incomeYtdNow: USDC(75_000), termsCommitment: s.terms.termsCommitment });
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
    // a second claim has nothing left to redeem: a claim of 0 units succeeds and burns nothing (Stage 1 SIM:1375-1401;
    // cause RD: was NotFound); a wallet with no registration is refused (Stage 1 HolderNotRegistered)
    const again = await exec(e, e.backers[2]!, { kind: 'claimRedemption', seriesId });
    expect(types(again.events)).toEqual(['RedemptionClaimed']);
    expect(again.events[0]!.payload).toMatchObject({ units: '0', amount: '0' });
    await expectChainError(exec(e, e.admin, { kind: 'claimRedemption', seriesId }), 'NotFound');
  });
});
