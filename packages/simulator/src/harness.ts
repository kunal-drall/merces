import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  DEFAULTS, attestationMessage, bidCommitment, incomeCommitment, mockProve, termsCommitment,
  type AdminCommand, type ChainPort, type Command, type ReportProof, type SeriesTerms, type Stablecoin, type TxResult, type UserCommand, type VerifierAttestation,
} from '@merces/domain';
import { WAD, quarterPayment, ratePerUnit, wadFromDecimal } from '@merces/math';
import { SimulatorChain } from './chain.ts';
import { SimEngine } from './engine.ts';
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
  attest(input: { seriesId: string; periodId: string; incomeCommitment: string; tier: 1 | 2 | 3 | 4; source?: string }): VerifierAttestation {
    const { source: _source, ...tuple } = input; // the source stays offchain (B7)
    const sig = edSign(null, Buffer.from(attestationMessage(tuple)), this.priv).toString('hex');
    return { keyId: this.keyId, ...tuple, signature: '0x' + sig };
  }
}

export interface PrivateTerms {
  threshold: bigint;
  shareRateWad: bigint;
  reportingCurrency: string;
  indexingRule: string;
  salt: string;
}

export function defaultTerms(sim: SimulatorChain, over: Partial<SeriesTerms> & { privateTerms?: PrivateTerms } = {}): { terms: SeriesTerms; privateTerms: PrivateTerms } {
  const stablecoin: Stablecoin = over.stablecoin ?? 'USDC';
  const unitsOffered = over.unitsOffered ?? '500';
  const privateTerms: PrivateTerms = over.privateTerms ?? { threshold: 60_000_000_000n, shareRateWad: wadFromDecimal('0.10'), reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x' + '11'.repeat(32) };
  const r = ratePerUnit(privateTerms.shareRateWad, BigInt(unitsOffered));
  const commitment = termsCommitment({ threshold: privateTerms.threshold, ratePerUnitWad: r, reportingCurrency: privateTerms.reportingCurrency, indexingRule: privateTerms.indexingRule, salt: privateTerms.salt });
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
    tierFlags: { tier1: true, tier2: true, tier3: true, tier4: false },
    reportingCurrency: privateTerms.reportingCurrency,
    raiseStyle: 'sealed',
    ...over,
  };
  terms.termsCommitment = over.termsCommitment ?? commitment;
  return { terms, privateTerms };
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
    const sim = opts.sim ?? SimulatorChain.createSync({ personality, genesis: opts.genesis });
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

  /** Device-side report assembly for the mock proof system. The income figure never leaves this function's return value's private half. */
  buildReport(params: {
    seriesId: string;
    periodId: string;
    unitsOutstanding: bigint;
    /** N offered at creation: r = s / N (C1). Defaults to unitsOutstanding, which is exact when the raise sold out. */
    unitsOffered?: bigint;
    privateTerms: PrivateTerms;
    incomeYtdPrev: bigint;
    incomeYtdNow: bigint;
    fxAvgWad?: bigint;
    fxBasis?: 'unity' | 'accumulator' | 'attestor';
    pair?: string | null;
    attestorRate?: { attestor: string; rateWad: bigint; pair: string } | null;
    tier?: 1 | 2 | 3;
    source?: string;
    attestor?: string | null;
    liquidityEvent?: boolean;
    termsCommitment: string;
    incomeSalt?: string;
  }): { command: Extract<UserCommand, { kind: 'submitReport' }>; paymentStable: bigint; /** offchain only (B7): never part of the command */ source: string } {
    const fx = params.fxAvgWad ?? WAD;
    const rate = ratePerUnit(params.privateTerms.shareRateWad, params.unitsOffered ?? params.unitsOutstanding); // r = s / N, N = units offered (C1)
    const q = quarterPayment({ ratePerUnitWad: rate, unitsOutstanding: params.unitsOutstanding, incomeYtdPrev: params.incomeYtdPrev, incomeYtdNow: params.incomeYtdNow, threshold: params.privateTerms.threshold, fxAvgWad: fx });
    const salt = params.incomeSalt ?? '0x' + '22'.repeat(32);
    const ic = incomeCommitment({ seriesId: params.seriesId, periodId: params.periodId, incomeYtd: params.incomeYtdNow, salt });
    const publicInputs = SimEngine.publicInputs({ termsCommitment: params.termsCommitment, incomeCommitment: ic, unitsOutstanding: params.unitsOutstanding, paymentStable: q.paymentStable, fxAvgWad: fx, periodId: params.periodId });
    const proof: ReportProof = { system: 'mock', proof: mockProve(publicInputs, { incomeYtd: params.incomeYtdNow.toString(), threshold: params.privateTerms.threshold.toString(), ratePerUnitWad: rate.toString(), salt }), publicInputs };
    const tier = params.tier ?? 2;
    // the income source never goes onchain (B7): it is returned beside the command for the offchain record (E5) only
    const source = params.source ?? 'stripe';
    const attestation = tier === 2 || tier === 1 ? this.verifier.attest({ seriesId: params.seriesId, periodId: params.periodId, incomeCommitment: ic, tier }) : null;
    return {
      paymentStable: q.paymentStable,
      source,
      command: {
        kind: 'submitReport', seriesId: params.seriesId, periodId: params.periodId, tier, paymentStable: q.paymentStable.toString(), incomeCommitment: ic, termsCommitment: params.termsCommitment,
        fxBasis: params.fxBasis ?? 'unity', fxAvgWad: fx.toString(), pair: params.pair ?? null, attestorRate: params.attestorRate ? { attestor: params.attestorRate.attestor, rateWad: params.attestorRate.rateWad.toString(), pair: params.attestorRate.pair } : null,
        proof, attestation, attestor: params.attestor ?? null, liquidityEvent: params.liquidityEvent ?? false,
      },
    };
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

  /** Report and pay a quarter in one go (tier 2, USD). */
  async reportAndPay(seriesId: string, periodId: string, privateTerms: PrivateTerms, termsCommitment: string, incomeYtdPrev: bigint, incomeYtdNow: bigint, extra: Partial<Parameters<SimHarness['buildReport']>[0]> = {}): Promise<{ paymentStable: bigint; due: bigint; events: TxResult['events'] }> {
    const series = (await this.sim.getSeries(seriesId))!;
    const units = BigInt(series.redemption ? series.redemption.unitsAtRedemption : series.unitsOutstanding);
    const { command, paymentStable } = this.buildReport({ seriesId, periodId, unitsOutstanding: units, unitsOffered: BigInt(series.terms.unitsOffered), privateTerms, incomeYtdPrev, incomeYtdNow, termsCommitment, ...extra });
    const coSigners = [command.attestor, command.attestorRate?.attestor].filter((a): a is string => !!a).map((a) => this.attestors.find((w) => w.address === a)!);
    const r1 = await this.exec(this.issuer, command, coSigners);
    const accepted = r1.events.find((e) => e.type === 'ReportAccepted')!.payload as { paymentDue: string };
    const due = BigInt(accepted.paymentDue);
    let events = r1.events;
    if (due > 0n) {
      const r2 = await this.exec(this.issuer, { kind: 'payIn', seriesId, periodId, amount: due.toString() });
      events = [...events, ...r2.events];
    }
    return { paymentStable, due, events };
  }
}

export type { Command };
