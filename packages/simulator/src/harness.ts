import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  DEFAULTS, attestationMessage, bidCommitment, currencyCodeOf, hex32ToField, incomeCommitment, INDEXING_RULE_CODE, mockProve, reportPublicInputs, termsCommitment,
  type AdminCommand, type ChainPort, type Command, type IndexingRule, type ReportProof, type SeriesTerms, type Stablecoin, type TxResult, type UserCommand, type VerifierAttestation,
} from '@merces/domain';
import { BN254_FR, U64_MAX, WAD, paymentStable, quarterIndex, ratePerUnit, toPid, wadFromDecimal, yearOf } from '@merces/math';
import { SimulatorChain } from './chain.ts';
import { SimWallet, simAdminWallet } from './wallets.ts';
import type { Personality } from './addresses.ts';

/** A local ed25519 report-verifier key for tests and local development (production keys live behind the KMS port). */
export class LocalVerifierKey {
  readonly keyId: string;
  private readonly priv: KeyObject;
  readonly publicKeyHex: string;
  constructor(keyId = 'verifier-dev-1') {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    this.keyId = keyId;
    this.priv = privateKey;
    this.publicKeyHex = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('hex');
  }
  /** Signs attestation v1 over Stage 1's report fields. The income source is checked offchain and never signed (B7). */
  attest(input: { seriesId: string; periodId: string; priorIncomeCommitment: string; incomeCommitment: string; tier: 1 | 2 | 3 | 4; liquidityEvent: boolean; source?: string }): VerifierAttestation {
    const { source: _source, ...tuple } = input;
    const sig = edSign(null, Buffer.from(attestationMessage(tuple)), this.priv).toString('hex');
    return { keyId: this.keyId, ...tuple, signature: '0x' + sig };
  }
}

/**
 * The opening of a series' terms commitment (SPEC §1.5): θ (the annual threshold, reporting currency at 6 decimals),
 * the per-unit rate r (WAD), the reporting currency, the indexing rule and the field salt.
 */
export interface PrivateTerms {
  theta: bigint;
  rWad: bigint;
  currency: string;
  indexingRule: IndexingRule;
  termsSalt: bigint;
}

/** The harness's fixed terms salt (a field element), so default series are reproducible. */
export const HARNESS_TERMS_SALT = BigInt('0x' + '11'.repeat(31));

/** A deterministic field salt for test reports (test memory only; real devices use `randomFieldSalt`). */
export function harnessFieldSalt(label: string): bigint {
  return BigInt('0x' + createHash('sha256').update('merces/harness-salt\n' + label).digest('hex')) % BN254_FR;
}

/**
 * Default series terms: 500 units, θ = 60,000 USD, a 10% total share (r = 0.10 / 500 per unit), CPI indexing, tiers
 * 2 and 3 (tier 1 is valid only on a pure tier-1 series: pass `tierFlags` for one).
 */
export function defaultTerms(sim: SimulatorChain, over: Partial<SeriesTerms> & { privateTerms?: PrivateTerms } = {}): { terms: SeriesTerms; privateTerms: PrivateTerms } {
  const { privateTerms: givenPrivate, ...termsOver } = over;
  const stablecoin: Stablecoin = over.stablecoin ?? 'USDC';
  const unitsOffered = over.unitsOffered ?? '500';
  const privateTerms: PrivateTerms = givenPrivate ?? { theta: 60_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), BigInt(unitsOffered)), currency: over.reportingCurrency ?? 'USD', indexingRule: 'cpi-annual', termsSalt: HARNESS_TERMS_SALT };
  const commitment = termsCommitment(privateTerms);
  const terms: SeriesTerms = {
    stablecoin,
    stablecoinMint: sim.mintOf(stablecoin),
    unitsOffered,
    reservePrice: '8000000',
    minimumRaise: '4000000000',
    capMultipleWad: DEFAULTS.capMultipleWad.toString(),
    lockupSeconds: DEFAULTS.lockupSeconds,
    releaseSchedule: [{ afterSeconds: 0, bps: 5000 }, { afterSeconds: 90 * 86_400, bps: 2500 }, { afterSeconds: 180 * 86_400, bps: 2500 }],
    auctionFeeBps: DEFAULTS.auctionFeeBps,
    payoutFeeBps: DEFAULTS.payoutFeeBps,
    hurdleWad: DEFAULTS.hurdleWad.toString(),
    payoutMultipleK: DEFAULTS.payoutMultipleK,
    /** 20% in the harness so five backers can sell out a 500-unit series; the protocol default is 10% (parameter) */
    walletCapBps: 2000,
    dueDays: DEFAULTS.dueDays,
    graceDays: DEFAULTS.graceDays,
    formalNoticeDays: DEFAULTS.formalNoticeDays,
    contractHash: '0x' + 'ab'.repeat(32),
    termsCommitment: commitment,
    tierFlags: { tier1: false, tier2: true, tier3: true, tier4: false },
    reportingCurrency: privateTerms.currency,
    raiseStyle: 'sealed',
    ...termsOver,
  };
  terms.termsCommitment = over.termsCommitment ?? commitment;
  return { terms, privateTerms };
}

/** One income opening `(ytd, salt)` the device keeps between quarters (test memory only, never persisted). */
interface IncomeOpening {
  pid: number;
  ytd: bigint;
  salt: bigint;
}

/** The report circuit's witness (Stage 1 `ReportInputs`, circuits/src/prover.ts) as the harness assembles it. */
export interface ReportWitness {
  termsCommitment: string;
  unitsOutstanding: bigint;
  fxAvgWad: bigint;
  priorIncomeCommitment: string;
  incomeCommitment: string;
  paymentStable: bigint;
  privateTerms: PrivateTerms;
  incomeYtd: bigint;
  incomeSalt: bigint;
  priorIncomeYtd: bigint;
  priorSalt: bigint;
}

/**
 * The circuit's equations, checked in TypeScript before the harness emits a mock proof (Stage 1 report.circom): the
 * three commitments open to the witness, the 64-bit ranges hold, income ≥ prior, and the payment is Stage 1's
 * `payment_usd`. A mock proof is then a digest over signals an honest Groth16 proof could also have. Throws without
 * values.
 */
export function checkReportWitness(w: ReportWitness): void {
  const u64 = (v: bigint) => v >= 0n && v <= U64_MAX;
  const fail = (what: string): never => {
    throw new Error(`harness: report circuit equation fails (${what})`);
  };
  if (![w.unitsOutstanding, w.fxAvgWad, w.paymentStable, w.incomeYtd, w.priorIncomeYtd, w.privateTerms.theta, w.privateTerms.rWad].every(u64)) fail('64-bit range');
  if (termsCommitment(w.privateTerms) !== w.termsCommitment) fail('terms commitment');
  if (incomeCommitment(w.incomeYtd, w.incomeSalt) !== w.incomeCommitment) fail('income commitment');
  if (incomeCommitment(w.priorIncomeYtd, w.priorSalt) !== w.priorIncomeCommitment) fail('prior commitment');
  if (w.incomeYtd < w.priorIncomeYtd) fail('income below prior');
  const owed = paymentStable({ rWad: w.privateTerms.rWad, unitsOutstanding: w.unitsOutstanding, theta: w.privateTerms.theta, incomeYtd: w.incomeYtd, priorIncomeYtd: w.priorIncomeYtd, fxAvgWad: w.fxAvgWad });
  if (owed !== w.paymentStable) fail('payment');
}

/** A Groth16 proof of the witness with Stage 1's prover (`@merces/circuits`, development zkey), loaded on first use. */
async function groth16Prove(w: ReportWitness): Promise<ReportProof> {
  const { proveReport } = await import('@merces/circuits');
  const t = w.privateTerms;
  const { proof, publicSignals } = await proveReport({
    terms_commitment: hex32ToField(w.termsCommitment), units_outstanding: w.unitsOutstanding, fx_avg_wad: w.fxAvgWad, prior_income_commitment: hex32ToField(w.priorIncomeCommitment),
    income_commitment: hex32ToField(w.incomeCommitment), payment_usd: w.paymentStable, theta: t.theta, r_wad: t.rWad, currency_code: BigInt(currencyCodeOf(t.currency)),
    indexing_rule: BigInt(INDEXING_RULE_CODE[t.indexingRule]), terms_salt: t.termsSalt, income_ytd: w.incomeYtd, income_salt: w.incomeSalt, prior_income_ytd: w.priorIncomeYtd, prior_salt: w.priorSalt,
  });
  const p = proof as unknown as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  return { system: 'groth16-bn254', proof: { pi_a: p.pi_a, pi_b: p.pi_b, pi_c: p.pi_c, protocol: 'groth16', curve: 'bn128' }, publicInputs: [...publicSignals] };
}

/** What `buildReport` takes: the device-side facts of one quarterly report. */
export interface BuildReportParams {
  seriesId: string;
  periodId: string;
  privateTerms: PrivateTerms;
  /** the real year-to-date income at the end of the period (6 decimals); the harness applies the high-water rule */
  incomeYtdNow: bigint;
  /**
   * Only for a series' first report outside Q1 (A25): the attested year-to-date figure at the start of the period,
   * which the report supplies as its prior. Ignored otherwise: the prior comes from the series' commitment chain.
   */
  incomeYtdPrev?: bigint;
  /** defaults to the chain's units outstanding (units at redemption for a tail report) */
  unitsOutstanding?: bigint;
  /** when given, must equal the commitment of `privateTerms` (a circuit equation) */
  termsCommitment?: string;
  fxAvgWad?: bigint;
  fxBasis?: 'unity' | 'accumulator' | 'attestor';
  pair?: string | null;
  attestorRate?: { attestor: string; rateWad: bigint; pair: string } | null;
  tier?: 1 | 2 | 3;
  source?: string;
  attestor?: string | null;
  liquidityEvent?: boolean;
  incomeSalt?: bigint;
  /** 'mock' (default; the chain must accept mock proofs) or a real Groth16 proof from Stage 1's prover */
  proofs?: 'mock' | 'groth16';
}

/**
 * Scenario harness: wallets, roles, faucet and the "device side" of reporting (commitment + mock proof).
 * Used by the simulator tests, the scenario tests, the conformance suite (simulator env) and the demo.
 */
export class SimHarness {
  readonly admin: SimWallet;
  readonly issuer: SimWallet;
  readonly backers: SimWallet[];
  readonly attestors: SimWallet[];
  readonly verifier: LocalVerifierKey;
  readonly router: string;

  private constructor(readonly sim: SimulatorChain) {
    this.admin = simAdminWallet(sim.family);
    this.issuer = new SimWallet(sim.family, 'issuer-1');
    this.backers = ['backer-1', 'backer-2', 'backer-3', 'backer-4', 'backer-5'].map((l) => new SimWallet(sim.family, l));
    this.attestors = ['attestor-1', 'attestor-2'].map((l) => new SimWallet(sim.family, l));
    this.verifier = new LocalVerifierKey();
    this.router = sim.address('router:split-1');
  }

  static async create(personality: Personality, opts: { genesis?: number; sim?: SimulatorChain } = {}): Promise<SimHarness> {
    // the harness builds mock proofs: a chain it creates accepts them (a chain passed in must opt in itself)
    const sim = opts.sim ?? SimulatorChain.createSync({ personality, genesis: opts.genesis, acceptMockProofs: true });
    const h = new SimHarness(sim);
    await h.bootstrap();
    return h;
  }

  /** Registers attestors and the verifier key, allowlists everyone, funds wallets. */
  async bootstrap(): Promise<void> {
    for (const a of this.attestors) await this.exec(this.admin, { kind: 'registerAttestor', attestor: a.address, active: true });
    await this.exec(this.admin, { kind: 'registerVerifierKey', keyId: this.verifier.keyId, publicKey: this.verifier.publicKeyHex, active: true });
    for (const w of [this.issuer, ...this.backers]) await this.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    const coins: Stablecoin[] = this.sim.personality === 'solana' ? ['USDC', 'USDG'] : ['USDC'];
    for (const c of coins) {
      await this.sim.fund(this.issuer.address, c, 1_000_000_000_000n);
      for (const b of this.backers) await this.sim.fund(b.address, c, 1_000_000_000_000n);
      await this.sim.fund(this.router, c, 1_000_000_000_000n);
    }
  }

  get chain(): ChainPort {
    return this.sim;
  }

  async exec(wallet: SimWallet, cmd: UserCommand | AdminCommand, coSigners: SimWallet[] = []): Promise<TxResult> {
    const tx = await this.sim.build(cmd, wallet.address, coSigners.map((c) => c.address));
    let signed = await wallet.sign(tx);
    for (const c of coSigners) signed = await c.coSign(signed);
    return this.sim.send(signed);
  }

  /** The income openings this harness produced, by income commitment (the device's memory between quarters). */
  private readonly openings = new Map<string, IncomeOpening>();

  /**
   * Device-side report assembly (Stage 1's builder, reference/src/vectors/builder.ts): the prior opening follows the
   * series' commitment chain (chained in the same year, the attested prior on an A25 first report, else ZERO), the
   * year-to-date figure is the high-water mark `max(real, prior)`, the payment is Stage 1's `payment_usd`, and the
   * proof is a mock (after the circuit equations are checked) or a real Groth16 proof. The income figure and salts
   * stay in the harness's memory; the command carries commitments, the payment and the proof only.
   */
  async buildReport(params: BuildReportParams): Promise<{ command: Extract<UserCommand, { kind: 'submitReport' }>; paymentStable: bigint; /** offchain only (B7): never part of the command */ source: string }> {
    const x = this.sim.state.series.get(params.seriesId);
    if (!x) throw new Error(`harness: unknown series ${params.seriesId}`);
    const pid = toPid(params.periodId);
    const prior = this.priorOpening(params.seriesId, pid, params.incomeYtdPrev);
    const incomeYtd = params.incomeYtdNow > prior.ytd ? params.incomeYtdNow : prior.ytd; // high-water (SPEC §1.5)
    const incomeSalt = params.incomeSalt ?? harnessFieldSalt(`${params.seriesId}:${params.periodId}:income`);
    const fx = params.fxAvgWad ?? WAD;
    const units = params.unitsOutstanding ?? (x.redemption ? x.redemption.unitsAtRedemption : x.unitsOutstanding);
    const t = params.privateTerms;
    const witness: ReportWitness = {
      termsCommitment: params.termsCommitment ?? termsCommitment(t), unitsOutstanding: units, fxAvgWad: fx,
      priorIncomeCommitment: incomeCommitment(prior.ytd, prior.salt), incomeCommitment: incomeCommitment(incomeYtd, incomeSalt),
      paymentStable: paymentStable({ rWad: t.rWad, unitsOutstanding: units, theta: t.theta, incomeYtd, priorIncomeYtd: prior.ytd, fxAvgWad: fx }),
      privateTerms: t, incomeYtd, incomeSalt, priorIncomeYtd: prior.ytd, priorSalt: prior.salt,
    };
    let proof: ReportProof;
    if ((params.proofs ?? 'mock') === 'groth16') {
      proof = await groth16Prove(witness);
    } else {
      checkReportWitness(witness);
      const publicInputs = reportPublicInputs(witness);
      proof = { system: 'mock', proof: mockProve(publicInputs), publicInputs };
    }
    this.openings.set(witness.incomeCommitment, { pid, ytd: incomeYtd, salt: incomeSalt });
    const tier = params.tier ?? 2;
    const liquidityEvent = params.liquidityEvent ?? false;
    // the income source never goes onchain (B7): it is returned beside the command for the offchain record (E5) only
    const source = params.source ?? 'stripe';
    const attestation = tier === 2 ? this.verifier.attest({ seriesId: params.seriesId, periodId: params.periodId, priorIncomeCommitment: witness.priorIncomeCommitment, incomeCommitment: witness.incomeCommitment, tier, liquidityEvent }) : null;
    return {
      paymentStable: witness.paymentStable,
      source,
      command: {
        kind: 'submitReport', seriesId: params.seriesId, periodId: params.periodId, tier, paymentStable: witness.paymentStable.toString(),
        priorIncomeCommitment: witness.priorIncomeCommitment, incomeCommitment: witness.incomeCommitment,
        fxBasis: params.fxBasis ?? 'unity', fxAvgWad: fx.toString(), pair: params.pair ?? null, attestorRate: params.attestorRate ? { attestor: params.attestorRate.attestor, rateWad: params.attestorRate.rateWad.toString(), pair: params.attestorRate.pair } : null,
        proof, attestation, attestor: params.attestor ?? null, liquidityEvent,
      },
    };
  }

  /** The prior opening the chain will expect for period `pid` (SPEC §6.2 step 5; Stage 1 builder `priorFor`). */
  private priorOpening(seriesId: string, pid: number, attestedPriorYtd: bigint | undefined): { ytd: bigint; salt: bigint } {
    const l = this.sim.state.series.get(seriesId)!.ledger;
    const last = l.lastIncomePeriod;
    if (last !== null && last === pid - 1 && yearOf(last) === yearOf(pid)) {
      const o = this.openings.get(l.lastIncomeCommitment);
      if (!o || o.pid !== last) throw new Error(`harness: no income opening for the last report of ${seriesId}`);
      return { ytd: o.ytd, salt: o.salt };
    }
    if (l.lastAcceptedPeriod === null && quarterIndex(pid) !== 0 && attestedPriorYtd !== undefined && attestedPriorYtd > 0n) {
      return { ytd: attestedPriorYtd, salt: harnessFieldSalt(`${seriesId}:attested-prior`) };
    }
    return { ytd: 0n, salt: 0n };
  }

  /** Run a full sealed-bid raise: create, open, N backers bid at given prices, reveal, settle. Returns the seriesId. */
  async runRaise(opts: { terms?: Partial<SeriesTerms>; privateTerms?: PrivateTerms; bids?: { backer: number; price: bigint; qty: bigint }[]; commitSeconds?: number; revealSeconds?: number } = {}): Promise<{ seriesId: string; terms: SeriesTerms; privateTerms: PrivateTerms; clearingPrice: bigint }> {
    const { terms, privateTerms } = defaultTerms(this.sim, { ...(opts.terms ?? {}), privateTerms: opts.privateTerms });
    if (!(await this.sim.getIssuer(this.issuer.address))) await this.exec(this.issuer, { kind: 'registerIssuer' });
    const created = await this.exec(this.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events.find((e) => e.type === 'SeriesCreated')!.payload as { seriesId: string }).seriesId;
    const now = await this.sim.now();
    const commitEndsAt = now + (opts.commitSeconds ?? 3 * 86_400);
    const revealEndsAt = commitEndsAt + (opts.revealSeconds ?? 86_400);
    await this.exec(this.issuer, { kind: 'openRaise', seriesId, commitEndsAt, revealEndsAt });
    const bids = opts.bids ?? [
      { backer: 0, price: 12_000_000n, qty: 100n },
      { backer: 1, price: 11_000_000n, qty: 100n },
      { backer: 2, price: 10_000_000n, qty: 100n },
      { backer: 3, price: 10_000_000n, qty: 100n },
      { backer: 4, price: 9_000_000n, qty: 100n },
    ];
    const salts = new Map<number, string>();
    for (const b of bids) {
      const w = this.backers[b.backer]!;
      const salt = '0x' + (b.backer + 1).toString(16).padStart(2, '0').repeat(32);
      salts.set(b.backer, salt);
      const commitment = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: b.price, quantity: b.qty, salt });
      const deposit = b.price * b.qty + (b.price * b.qty * BigInt(terms.auctionFeeBps)) / 10_000n;
      await this.exec(w, { kind: 'commitBid', seriesId, commitment, deposit: deposit.toString() });
    }
    await this.sim.setTime(commitEndsAt);
    for (const b of bids) {
      const w = this.backers[b.backer]!;
      await this.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: b.qty.toString(), salt: salts.get(b.backer)! });
    }
    await this.sim.setTime(revealEndsAt);
    const settled = await this.sim.submit({ kind: 'settleAuction', seriesId }, 'keeper');
    const ev = settled.events.find((e) => e.type === 'AuctionSettled');
    const clearingPrice = ev ? BigInt((ev.payload as { clearingPrice: string }).clearingPrice) : 0n;
    return { seriesId, terms, privateTerms, clearingPrice };
  }

  /**
   * Report a quarter and pay what the chain then asks (tier 2, USD by default). `incomeYtdPrev` matters only for an A25
   * first report (see `BuildReportParams`). Returns the due the report opened (`ReportAccepted.paymentDue`, without
   * accrual) and the amount paid (the live due, accrual included).
   */
  async reportAndPay(seriesId: string, periodId: string, privateTerms: PrivateTerms, termsCommitment: string, incomeYtdPrev: bigint, incomeYtdNow: bigint, extra: Partial<BuildReportParams> = {}): Promise<{ paymentStable: bigint; due: bigint; paid: bigint; events: TxResult['events'] }> {
    const { command, paymentStable } = await this.buildReport({ seriesId, periodId, privateTerms, termsCommitment, incomeYtdPrev, incomeYtdNow, ...extra });
    const coSigners = [command.attestor, command.attestorRate?.attestor].filter((a): a is string => !!a).map((a) => this.attestors.find((w) => w.address === a)!);
    const r1 = await this.exec(this.issuer, command, coSigners);
    const accepted = r1.events.find((e) => e.type === 'ReportAccepted')!.payload as { paymentDue: string };
    const due = BigInt(accepted.paymentDue);
    let events = r1.events;
    let paid = 0n;
    const period = await this.sim.getPeriod(seriesId, periodId);
    if (period && !period.settled) {
      paid = BigInt(period.paymentDue) - BigInt(period.paid); // the live due: lateness accrual runs until payment
      const r2 = await this.exec(this.issuer, { kind: 'payIn', seriesId, periodId, amount: paid.toString() });
      events = [...events, ...r2.events];
    }
    return { paymentStable, due, paid, events };
  }
}

export type { Command };
