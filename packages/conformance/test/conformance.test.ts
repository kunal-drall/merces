import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURVE_TERMS_ZEROS, assertSigningNetwork, bidCommitment, rateUnits, runSettlement, seriesKeyOf, termsCommitment, type DomainEvent } from '@merces/domain';
import { WAD, capPerUnit, parsePeriod, ratePerUnit, requiredEscrow, wadFromDecimal } from '@merces/math';
import { conformanceTargets, envFor, exec, expectChainError, type ConformanceEnv } from '../src/env.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes;
 *  - S4-REG: Stage 1's key registry (S4 WP5): `registerAttestor{attestor}` (the boolean `active` is gone; a revocation is
 *    `revokeAttestor`);
 *  - S4-T2: a tier-2 report carries the verifier key's Stage 1 REPORT signature `{signer, signature}` (65 bytes; S4 WP6;
 *    was an ed25519 attestation v1 by key id);
 *  - S4-ID: an attestor is a secp256k1 key's 20-byte address on every chain (S4 WP7): a registry command names a key,
 *    never a chain wallet; the env's attestors are keys the chain registered, each able to sign a digest.
 * S4 cause codes on new checks:
 *  - S4-CTX: the signing context (S4 D6, D7): a chain's signing domain is null or one a signer may sign for (local ids on
 *    a mock chain only, never a mainnet); a new series reads its Stage 1 series key and four nonces at 0.
 */

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
 *  - S3-ST: curve staking (Solana only): a registered, allowlisted holder stakes its base lamports after a census and is
 *    paid on its stake; a buyer that did not register earns nothing; unstake credits pending and moves no stablecoin; an
 *    EVM chain refuses a curve series (CurveModeUnsupported). S3 WP12: an ordered command list builds one transaction,
 *    all or nothing, on Solana ([unstakeUnits, claimPayout]); an EVM chain builds one command per transaction.
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
    // cause S4-CTX: null until the adapter reads it; otherwise its family's and on the signers' allow-list
    if (info.signing !== null) {
      expect(info.signing.chainKind).toBe(info.family === 'solana' ? 1 : 2);
      expect(() => assertSigningNetwork(info.signing!, { allowLocal: info.mode === 'mock' })).not.toThrow();
    }
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
    // cause S4-CTX: Stage 1's series key for the id, and every signing nonce at 0
    expect(s.seriesKey).toBe(seriesKeyOf(seriesId, e.chain.family));
    expect(s.nonces).toEqual({ pause: '0', amendment: '0', extinguish: '0', trueup: '0' });
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
      // cause S4-BID: Stage 1's keccak commitment, over no series or window
      const c = bidCommitment({ bidder: b.w.address, pricePerUnit: b.price, quantity: b.qty, salt: b.salt });
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
    // cause S4-T2: a 65-byte signature that recovers to no verifier key (was a 64-byte ed25519 signature)
    expect(good.command.attestation!.signer).toBe(e.verifierAddress);
    const forged = { ...good.command, attestation: { ...good.command.attestation!, signature: '0x' + '22'.repeat(64) + '1b' } };
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
    await expectChainError(exec(e, e.backers[0]!, { kind: 'registerAttestor', attestor: '0x' + '5a'.repeat(20) }), 'Unauthorized'); // cause S4-REG: Stage 1's registerAttestor{attestor} (was {…, active}); cause S4-ID: a key's 20-byte address (was the backer's wallet)
    // cause S4-ID: the env's attestors are 20-byte keys the chain has registered and active
    for (const a of e.attestors) {
      expect(a.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(await e.chain.getSignerKey('attestor', a.address)).toMatchObject({ kind: 'attestor', address: a.address, active: true, revokedAt: null });
      expect(typeof a.signDigest).toBe('function');
    }
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

  // cause S3-ST: Stage 1's curve mode through the port (curve_mode.rs: register, sync, stake, receive, claim); EVM
  // registries refuse a curve series right after the issuer check (MercesRegistry.sol:479-481)
  it('runs curve staking on Solana: register, census, stake, receive, claim by stake, unstake credits pending; EVM refuses a curve', async () => {
    const e = env();
    if (!(await e.chain.getIssuer(e.issuer.address))) await exec(e, e.issuer, { kind: 'registerIssuer' });
    // Stage 1's worked curve series: 100 units, X = 1,000 USDC, r per base lamport, the curve's zeros
    const over = { raiseStyle: 'curve' as const, ...CURVE_TERMS_ZEROS, unitsOffered: '100', minimumRaise: '1000000000' };
    const privateTerms = { ...e.privateTerms, rWad: ratePerUnit(wadFromDecimal('0.10'), rateUnits(over)) };
    const terms = e.terms({ ...over, termsCommitment: termsCommitment(privateTerms) });
    if (e.chain.family !== 'solana') {
      await expectChainError(exec(e, e.issuer, { kind: 'createSeries', terms }), 'NotPermitted');
      // one command per transaction on an EVM chain (no bundles there yet; curve mode, their first user, is Solana only)
      await expectChainError(e.chain.build([{ kind: 'claimPayout', seriesId }, { kind: 'claimPayout', seriesId }], e.backers[0]!.address), 'NotImplemented');
      return;
    }
    const created = await exec(e, e.issuer, { kind: 'createSeries', terms });
    expect(types(created.events)).toEqual(['SeriesCreated', 'CurveActivated', 'RaiseOpened']);
    const curveId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const [a, b, c] = e.backers as [typeof e.backers[0], typeof e.backers[0], typeof e.backers[0]];
    for (const [w, amount] of [[a, 400], [b, 350], [c, 300]] as const) {
      await exec(e, w, { kind: 'curveSwap', seriesId: curveId, side: 'buy', amountIn: USDC(amount).toString(), minimumAmountOut: '0' });
    }
    await e.chain.submit({ kind: 'completeCurve', seriesId: curveId }, 'keeper');
    await e.chain.submit({ kind: 'collectCurveProceeds', seriesId: curveId }, 'keeper');
    // a buyer holds units in its wallet and is not registered: it earns nothing
    const held = BigInt((await e.chain.getPosition(curveId, a.address))!.walletUnits);
    expect(held > 0n).toBe(true);
    await e.chain.submit({ kind: 'registerHolder', seriesId: curveId, wallet: a.address }, 'keeper');
    // nothing staked before a census covers it (StakeExceedsOutstanding, code WrongStatus)
    await expectChainError(exec(e, a, { kind: 'stakeUnits', seriesId: curveId, units: held.toString() }), 'WrongStatus');
    await e.chain.submit({ kind: 'syncCurveUnits', seriesId: curveId }, 'keeper');
    const staked = await exec(e, a, { kind: 'stakeUnits', seriesId: curveId, units: held.toString() });
    expect(staked.events.map((x) => [x.type, x.payload])).toEqual([['UnitsStaked', { seriesId: curveId, holder: a.address, units: held.toString(), staked: held.toString() }]]);
    expect(await e.chain.getPosition(curveId, a.address)).toMatchObject({ registered: true, units: held.toString(), stakedUnits: held.toString(), walletUnits: '0' });
    // a report after the quarter, over a census taken after it
    const s = (await e.chain.getSeries(curveId))!;
    const q = parsePeriod(s.reporting.firstPeriod!);
    await e.waitUntil(q.end + e.durations.reportLead);
    await e.chain.submit({ kind: 'syncCurveUnits', seriesId: curveId }, 'keeper');
    const n = BigInt((await e.chain.getSeries(curveId))!.unitsOutstanding);
    const report = await e.buildReport({ seriesId: curveId, periodId: q.id, unitsOutstanding: n, privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(70_000), termsCommitment: terms.termsCommitment });
    const accepted = await exec(e, e.issuer, report.command);
    const due = (accepted.events[0]!.payload as { paymentDue: string }).paymentDue;
    expect(BigInt(due) > 0n).toBe(true);
    await exec(e, e.issuer, { kind: 'payIn', seriesId: curveId, periodId: q.id, amount: due });
    // the stake is paid its share of the net, `floor(acc × staked / WAD)`; the unstaked units' share stays in the vault
    const acc = BigInt((await e.chain.getSeries(curveId))!.accNetWad);
    const owed = (acc * held) / WAD;
    expect((await e.chain.getPosition(curveId, a.address))!.claimable).toBe(owed.toString());
    const claim = await exec(e, a, { kind: 'claimPayout', seriesId: curveId });
    expect(claim.events.map((x) => [x.type, x.payload])).toEqual([['PayoutClaimed', { seriesId: curveId, holder: a.address, amount: owed.toString(), burnedUnits: '0' }]]);
    // b bought and never registered: no claim (HolderNotRegistered, code NotFound)
    await expectChainError(exec(e, b, { kind: 'claimPayout', seriesId: curveId }), 'NotFound');
    // unstaking returns the units and moves no stablecoin
    const before = await e.chain.getBalance(a.address, 'USDC');
    const un = await exec(e, a, { kind: 'unstakeUnits', seriesId: curveId, units: held.toString() });
    expect(types(un.events)).toEqual(['UnitsUnstaked']);
    expect(await e.chain.getBalance(a.address, 'USDC')).toBe(before);
    expect(await e.chain.getPosition(curveId, a.address)).toMatchObject({ stakedUnits: '0', walletUnits: held.toString() });
    // one transaction of several commands (owner direction of 2026-10-10): the unstake builder's [unstakeUnits,
    // claimPayout] runs all or nothing: a refused unstake leaves the stake as it was and pays nothing
    await exec(e, a, { kind: 'stakeUnits', seriesId: curveId, units: held.toString() });
    const tooMuch = await e.chain.build([{ kind: 'unstakeUnits', seriesId: curveId, units: (held + 1n).toString() }, { kind: 'claimPayout', seriesId: curveId }], a.address);
    expect(tooMuch.commands?.map((x) => x.kind)).toEqual(['unstakeUnits', 'claimPayout']);
    await expectChainError(e.chain.send(await a.sign(tooMuch)), 'InsufficientFunds');
    expect(await e.chain.getPosition(curveId, a.address)).toMatchObject({ stakedUnits: held.toString(), walletUnits: '0' });
    const both = await e.chain.send(await a.sign(await e.chain.build([{ kind: 'unstakeUnits', seriesId: curveId, units: held.toString() }, { kind: 'claimPayout', seriesId: curveId }], a.address)));
    expect(types(both.events)).toEqual(['UnitsUnstaked', 'PayoutClaimed']);
    expect(new Set(both.events.map((x) => x.txId)).size).toBe(1);
    expect(await e.chain.getPosition(curveId, a.address)).toMatchObject({ stakedUnits: '0', walletUnits: held.toString(), pending: '0' });
  });
});
