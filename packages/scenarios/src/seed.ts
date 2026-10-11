import { attestationOf, bidCommitment, randomSalt, termsCommitment, type SeriesTerms } from '@merces/domain';
import { PILOT_COHORT, stripeFixtureFor, stripeGrossUntil, type SyntheticIssuer } from '@merces/fixtures';
import { WAD, parsePeriod, periodsBetween, ratePerUnit, requiredEscrow, wadFromDecimal } from '@merces/math';
import { MemoryIncomeChain, assembleOnDevice, submitReportCommand } from '@merces/poi-device';
import { LocalKms, MockZkTls, type IncomeSourceKind } from '@merces/ports';
import { ReportVerifier, verifierChainsFromPorts } from '@merces/report-verifier';
import { SimHarness, SimWallet, SimulatorChain, defaultTerms, harnessFieldSalt, type PrivateTerms } from '@merces/simulator';

export interface SeededIssuer {
  issuer: SyntheticIssuer;
  wallet: SimWallet;
  seriesId: string;
  terms: SeriesTerms;
  privateTerms: PrivateTerms;
  clearingPrice: bigint;
}

export interface SeedResult {
  chains: Record<string, SimulatorChain>;
  harnesses: Record<string, SimHarness>;
  issuers: SeededIssuer[];
}

export interface SeedOptions {
  /** how many quarters of 2026 to report (0–4) */
  quarters?: number;
  /** restrict to a subset of handles */
  handles?: string[];
  log?: (m: string) => void;
  /**
   * The issuer devices' proofs: Stage 1 Groth16 (default; about 0.3 s each), or mock proofs for simulators started with
   * `MERCES_PROOF_SYSTEM=mock` (they refuse mock proofs otherwise, critique H3).
   */
  proofs?: 'groth16' | 'mock';
}

/** The report verifier the seeded issuers' devices use (registered on both simulators). */
export const SEED_VERIFIER_KEY_ID = 'seed-report-verifier';

/**
 * Seeds the 12-issuer pilot cohort on both simulator personalities: registers issuers, runs sealed-bid raises
 * with five synthetic backers each, then reports and pays the requested quarters from Stripe-shaped fixture
 * income through each issuer's device (`@merces/poi-device`: Stage 1 Groth16 proofs, the device's income chain,
 * tier-2 attestations from an in-process report verifier). Income figures exist only inside this function and the
 * device; nothing is persisted anywhere.
 */
export async function seedCohort(sims: { solana: SimulatorChain; monad: SimulatorChain }, opts: SeedOptions = {}): Promise<SeedResult> {
  const log = opts.log ?? (() => undefined);
  const harnesses: Record<string, SimHarness> = {
    solana: await SimHarness.create('solana', { sim: sims.solana }),
    monad: await SimHarness.create('monad', { sim: sims.monad }),
  };
  const out: SeededIssuer[] = [];
  const cohort = PILOT_COHORT.filter((i) => !opts.handles || opts.handles.includes(i.handle));
  for (const [i, issuer] of cohort.entries()) {
    const h = harnesses[issuer.chain]!;
    const sim = h.sim;
    const wallet = new SimWallet(sim.family, `issuer:${issuer.handle}`);
    await sim.submit({ kind: 'setAllowlist', wallet: wallet.address, allowed: true }, 'allowlistManager');
    await sim.fund(wallet.address, issuer.stablecoin, 10_000_000_000_000n);
    const privateTerms: PrivateTerms = { theta: issuer.threshold, rWad: ratePerUnit(issuer.shareRateWad, issuer.unitsOffered), currency: issuer.reportingCurrency, indexingRule: 'cpi-annual', termsSalt: harnessFieldSalt(`seed:${issuer.handle}:terms`) };
    const commitment = termsCommitment(privateTerms);
    const { terms } = defaultTerms(sim, {
      stablecoin: issuer.stablecoin, stablecoinMint: sim.mintOf(issuer.stablecoin), unitsOffered: issuer.unitsOffered.toString(), reservePrice: issuer.reservePrice.toString(), minimumRaise: issuer.minimumRaise.toString(),
      reportingCurrency: issuer.reportingCurrency, termsCommitment: commitment, contractHash: '0x' + (0x80 + i).toString(16).padStart(2, '0').repeat(32),
      tierFlags: { tier1: issuer.tier === 1, tier2: issuer.tier === 2, tier3: issuer.tier === 3, tier4: false },
      // a 2-day commit and a 1-day reveal phase (the cohort's timing; openRaise derives the ends from these)
      commitDurationSeconds: 2 * 86_400, revealDurationSeconds: 86_400,
    });
    // the issuer wallet signs (not the harness default issuer)
    const exec = (cmd: Parameters<SimHarness['exec']>[1]) => h.exec(wallet, cmd);
    await h.exec(h.admin, { kind: 'registerIssuer', wallet: wallet.address });
    const created = await exec({ kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await exec({ kind: 'openRaise', seriesId });
    const { commitEndsAt, revealEndsAt } = (await sim.getAuction(seriesId))!;
    if (commitEndsAt === null || revealEndsAt === null) throw new Error(`seed: ${seriesId} opened without phase ends`);
    // five backers bid around the reserve; the wallet cap is 10% so each takes ≤ 10% of N
    const qty = issuer.unitsOffered / 10n;
    const prices = [issuer.reservePrice + 3_000_000n, issuer.reservePrice + 2_000_000n, issuer.reservePrice + 1_000_000n, issuer.reservePrice + 1_000_000n, issuer.reservePrice];
    const salts: string[] = [];
    for (const [b, price] of prices.entries()) {
      const w = h.backers[b]!;
      // a fresh salt per bid: Stage 1's commitment binds neither the series nor the raise (S4 D11)
      const salt = randomSalt();
      salts.push(salt);
      const c = bidCommitment({ bidder: w.address, pricePerUnit: price, quantity: qty, salt });
      const deposit = requiredEscrow(price, qty, terms.auctionFeeBps);
      await h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: deposit.toString() });
    }
    await sim.setTime(commitEndsAt);
    for (const [b, price] of prices.entries()) await h.exec(h.backers[b]!, { kind: 'revealBid', seriesId, pricePerUnit: price.toString(), quantity: qty.toString(), salt: salts[b]! });
    await sim.setTime(revealEndsAt);
    // Stage 1's settlement as the keeper: proposal, tally, finalize, a process and a delivery per bid (refunds and units
    // are pushed to the backers)
    await h.settle(seriesId, 'deliver');
    const auction = (await sim.getAuction(seriesId))!;
    if (auction.raiseState !== 'Settled') throw new Error(`seed: auction for ${issuer.handle} failed (${auction.failureReason}); fixture minimumRaise must be ≤ unitsOffered/2 × reservePrice`);
    const clearing = BigInt(auction.clearingPrice!);
    await exec({ kind: 'drawRelease', seriesId });
    if (issuer.tier === 1) await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    log(`${issuer.chain}:${issuer.handle} raised ${clearing * BigInt(qty) * 5n} at ${clearing}/unit`);
    out.push({ issuer, wallet, seriesId, terms, privateTerms, clearingPrice: clearing });
  }

  // report the requested quarters, each issuer through its own device (Stage 1 Groth16 proofs; tier-2 attestations from
  // an in-process report verifier whose key both simulators register)
  const quarters = Math.min(4, Math.max(0, opts.quarters ?? 0));
  const zktls = new MockZkTls();
  // the seed verifier's secp256k1 key (S4 WP6), registered by address; its chain table is each simulator's signing domain
  const verifierKms = new LocalKms('seed-report-verifier', { [SEED_VERIFIER_KEY_ID]: 'secp256k1' });
  const verifier = new ReportVerifier(zktls, verifierKms, { keyId: SEED_VERIFIER_KEY_ID, chains: () => verifierChainsFromPorts(Object.values(sims)), allowLocal: true });
  if (quarters > 0) {
    const address = await verifierKms.signerAddress(SEED_VERIFIER_KEY_ID);
    for (const h of Object.values(harnesses)) if (!(await h.sim.getSignerKey('verifier', address))?.active) await h.exec(h.admin, { kind: 'registerVerifierKey', key: address });
  }
  const incomeChain = new MemoryIncomeChain();
  for (let q = 1; q <= quarters; q++) {
    const periodId = `2026Q${q}`;
    const period = parsePeriod(periodId);
    for (const chain of ['solana', 'monad'] as const) if ((await sims[chain].now()) < period.end + 86_400) await sims[chain].setTime(period.end + 86_400);
    for (const s of out) {
      const h = harnesses[s.issuer.chain]!;
      const fixture = stripeFixtureFor(s.issuer.handle, 2026, s.issuer.incomeYtdByQuarter);
      const ytdNow = stripeGrossUntil(fixture, period.end) * 10_000n; // cents → 1e6 base units
      const fxBasis = s.issuer.reportingCurrency === 'USD' ? 'unity' : 'attestor';
      const pair = fxBasis === 'unity' ? null : `${s.issuer.reportingCurrency}/USD`;
      const rate = fxBasis === 'unity' ? WAD : wadFromDecimal(FX_PLACEHOLDER[s.issuer.reportingCurrency] ?? '1');
      const series = (await h.sim.getSeries(s.seriesId))!;
      const tier = s.issuer.tier as 1 | 2 | 3;
      const source = tier === 1 ? 'split' : tier === 3 ? 'attestor' : (s.issuer.source as IncomeSourceKind);
      const zktlsProof = tier === 2 ? zktls.prove({ source: source as IncomeSourceKind, seriesId: s.seriesId, periodId, figure: ytdNow, currency: s.issuer.reportingCurrency, coversUntil: period.end, owner: s.wallet.address }) : null;
      const { assembled, entry } = await assembleOnDevice({
        seriesId: s.seriesId, periodId, termsCommitment: s.terms.termsCommitment, unitsOutstanding: series.unitsOutstanding,
        privateTerms: { threshold: s.privateTerms.theta.toString(), ratePerUnitWad: s.privateTerms.rWad.toString(), reportingCurrency: s.privateTerms.currency, indexingRule: s.privateTerms.indexingRule, termsSalt: s.privateTerms.termsSalt.toString() },
        prior: q === 1 ? null : (incomeChain.get(s.seriesId, `2026Q${q - 1}`) ?? null), incomeYtdNow: ytdNow, fxAvgWad: rate, tier, source, zktlsProof,
        liquidityEvent: s.issuer.handle === 'mesh-mika' && q === 3, deviceSecret: `seed-device:${s.issuer.handle}`,
      }, verifier, { proofs: opts.proofs ?? 'groth16' });
      incomeChain.put(entry);
      // tier 3: the attestor key's REPORT signature; the FX fallback: an attestor key's FX signature for this series (S4 WP9)
      const command = submitReportCommand(assembled, {
        fxBasis, fxAvgWad: rate.toString(), pair,
        fxFallback: fxBasis === 'attestor' ? attestationOf(await h.attestFx(s.seriesId, periodId, rate, h.attestors[1]!)) : null,
        attestation: tier === 3 ? attestationOf(await h.attestReport(s.seriesId, { periodId, priorIncomeCommitment: assembled.priorIncomeCommitment, incomeCommitment: assembled.incomeCommitment, liquidityEvent: assembled.liquidityEvent, tier: 3 }, h.attestors[0]!)) : null,
      });
      if (fxBasis === 'attestor') await h.sim.submit({ kind: 'flagFxFallback', pair: pair!, periodId, reason: 'coverage' }, 'keeper').catch(() => undefined);
      const accepted = await h.exec(s.wallet, command);
      const due = BigInt((accepted.events.find((e) => e.type === 'ReportAccepted')!.payload as { paymentDue: string }).paymentDue);
      if (due > 0n) await h.exec(s.wallet, { kind: 'payIn', seriesId: s.seriesId, periodId, amount: due.toString() });
      log(`${s.issuer.chain}:${s.issuer.handle} ${periodId} due=${due}`);
    }
  }
  // a few backers claim so payout history is not empty
  for (const s of out) {
    const h = harnesses[s.issuer.chain]!;
    for (const b of h.backers.slice(0, 2)) await h.exec(b, { kind: 'claimPayout', seriesId: s.seriesId }).catch(() => undefined);
  }
  // one Solana curve-mode series to exercise E14
  const sol = harnesses.solana!;
  const curveIssuer = new SimWallet(sol.sim.family, 'issuer:curve-cam');
  await sol.sim.submit({ kind: 'setAllowlist', wallet: curveIssuer.address, allowed: true }, 'allowlistManager');
  await sol.exec(sol.admin, { kind: 'registerIssuer', wallet: curveIssuer.address });
  // the harness gives a curve series Stage 1's zeros (no lockup, no wallet cap, no raise phases; S3 WP7)
  const curveTerms = defaultTerms(sol.sim, { raiseStyle: 'curve', minimumRaise: '2000000000', reservePrice: '5000000' }).terms;
  await sol.exec(curveIssuer, { kind: 'createSeries', terms: curveTerms });
  return { chains: sims, harnesses, issuers: out };
}

/** Placeholder quarter-average rates used only for the synthetic cohort (attestor-signed in the simulator). Not market data. */
export const FX_PLACEHOLDER: Record<string, string> = { GBP: '1.27', EUR: '1.08', INR: '0.012', CAD: '0.73', SGD: '0.74' };
