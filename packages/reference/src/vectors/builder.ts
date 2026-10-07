/**
 * Scenario builder: records vector steps while executing them against the simulator, so every
 * `expect` snapshot in a vector is the simulator's own state and every action step is known to be
 * accepted (or to revert with exactly the named error).
 */
import {
  DEFAULT_PARAMETERS,
  WAD,
  ZERO_INCOME_COMMITMENT,
  addressFromPrivateKey,
  bytes32,
  bytesToHex,
  deriveSalt,
  deriveTestPrivateKey,
  fieldToBytes32,
  incomeCommitment,
  keccak256,
  parametersToStrings,
  termsCommitment,
  timestampFromCivil,
  utf8,
  type ErrorName,
  type Parameters,
} from "@merces/sdk";
import { encodeProofForEvm, encodeProofForSolana, proveReport, type ReportInputs } from "@merces/circuits";
import * as M from "../math/index.js";
import { Simulator } from "../sim/simulator.js";
import type { Call, ExpectStep, ReleaseTrancheInput, SeriesTermsInput, Step, Vector, VectorKey } from "../sim/types.js";

export const USDC = 1_000_000n;
export const DAY = 86_400n;
export const usdc = (n: number | bigint): bigint => BigInt(n) * USDC;
export const ts = timestampFromCivil;

export interface TermsPlain {
  theta: bigint;
  rWad: bigint;
  currencyCode: number;
  indexingRule: number;
}

interface SeriesSecrets extends TermsPlain {
  termsSalt: bigint;
  termsCommitment: bigint;
  lastIncome: { period: number; ytd: bigint; salt: bigint } | null;
  incomeCounter: number;
}

export interface ReportArgs {
  series: string;
  period: number;
  incomeYtd: bigint;
  tier: number;
  attestation?: string | null;
  liquidityEvent?: boolean;
  /** fallback rate signed by this attestor when the accumulator is NeedsFallback */
  fxFallback?: { attestor: string; rateWad: bigint };
  /** override the fx the report claims (to build reverts) */
  fxAvgWadOverride?: bigint;
  /** override the payment the report claims (to build reverts) */
  paymentOverride?: bigint;
  /** units_outstanding public input override (to build reverts) */
  unitsOverride?: bigint;
  actor?: string;
  note?: string;
}

export class ScenarioBuilder {
  readonly steps: Step[] = [];
  readonly actors = new Set<string>();
  readonly keys: Record<string, VectorKey> = {};
  readonly sim: Simulator;
  readonly params: Parameters;
  readonly flags: { newRaisesPaused: boolean; windowsEnabled: boolean; tier4Enabled: boolean };
  readonly secrets = new Map<string, SeriesSecrets>();
  t = 0n;

  constructor(
    readonly name: string,
    readonly description: string,
    opts: { parameters?: Parameters; flags?: Partial<{ newRaisesPaused: boolean; windowsEnabled: boolean; tier4Enabled: boolean }> } = {},
  ) {
    this.params = opts.parameters ?? DEFAULT_PARAMETERS;
    this.flags = { newRaisesPaused: false, windowsEnabled: false, tier4Enabled: false, ...(opts.flags ?? {}) };
    this.sim = new Simulator({ parameters: this.params, flags: this.flags });
  }

  // ---- time -------------------------------------------------------------------------------

  at(t: bigint): this {
    if (t < this.t) throw new Error(`${this.name}: time cursor backwards ${t} < ${this.t}`);
    this.t = t;
    return this;
  }

  advance(seconds: bigint): this {
    return this.at(this.t + seconds);
  }

  // ---- identities ---------------------------------------------------------------------------

  actor(...names: string[]): this {
    for (const n of names) this.actors.add(n);
    return this;
  }

  key(name: string, role: "attestor" | "verifier"): this {
    this.actors.add(name);
    const seed = `${this.name}:${name}`;
    const priv = deriveTestPrivateKey(seed);
    this.keys[name] = {
      seed,
      derivation: 'keccak256("MERCES_TEST_KEY" ‖ utf8(seed)) mod (secp256k1_n − 1) + 1',
      privateKey: bytesToHex(priv),
      address: bytesToHex(addressFromPrivateKey(priv)),
      role,
    };
    return this;
  }

  /** Deterministic 32-byte salt / hash for this scenario. */
  salt(label: string): string {
    return bytesToHex(keccak256(utf8(`${this.name}:${label}`)));
  }

  fieldSalt(label: string): bigint {
    return deriveSalt(this.name, label);
  }

  // ---- steps --------------------------------------------------------------------------------

  async step(call: Call, note?: string): Promise<void> {
    const step: Step = note ? { t: this.t.toString(), note, ...call } : { t: this.t.toString(), ...call };
    this.steps.push(step);
    await this.sim.apply(step);
    this.sim.totalStable();
  }

  async revert(call: Call, error: ErrorName, note?: string): Promise<void> {
    const step: Step = note ? { t: this.t.toString(), op: "expect_revert", call, error, note } : { t: this.t.toString(), op: "expect_revert", call, error };
    this.steps.push(step);
    await this.sim.apply(step);
  }

  expect(series: string | null, note?: string, fx?: Record<string, number[]>): ExpectStep {
    const snap = this.sim.expect(series, fx ? { fx } : {});
    const step: ExpectStep = { t: this.t.toString(), ...snap };
    if (note) step.note = note;
    this.steps.push(step);
    if (series) this.sim.checkUnitSupply(series);
    return step;
  }

  // ---- high-level helpers -------------------------------------------------------------------

  async fund(actor: string, amount: bigint): Promise<void> {
    this.actors.add(actor);
    await this.step({ op: "fund", actor, amount: amount.toString() });
  }

  terms(overrides: Partial<Record<keyof SeriesTermsInput, bigint | number>> = {}): SeriesTermsInput {
    const p = this.params;
    const base: Record<keyof SeriesTermsInput, bigint | number> = {
      unitsOffered: 1000n,
      reservePrice: usdc(100),
      minRaise: usdc(20_000),
      capMultipleWad: p.capMultipleWad,
      hurdleRateWad: p.hurdleRateWad,
      payoutMultipleK: p.payoutMultipleK,
      lockupSeconds: p.lockupSeconds,
      walletCapBps: p.walletCapBps,
      auctionFeeBps: p.auctionFeeBps,
      payoutFeeBps: p.payoutFeeBps,
      windowFeeBps: p.windowFeeBps,
      nonRevealChargeBps: p.nonRevealChargeBps,
      commitDuration: p.commitDuration,
      revealDuration: p.revealDuration,
      windowCommitDuration: p.windowCommitDuration,
      windowRevealDuration: p.windowRevealDuration,
      ...overrides,
    };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) out[k] = BigInt(v).toString();
    return out as unknown as SeriesTermsInput;
  }

  quarterlySchedule(): ReleaseTrancheInput[] {
    return [0n, 90n * DAY, 180n * DAY, 270n * DAY].map((o) => ({ atOffsetSeconds: o.toString(), bps: "2500" }));
  }

  /** Registers the series' private terms and returns the commitment (hex). */
  defineTerms(series: string, plain: TermsPlain): string {
    const termsSalt = this.fieldSalt(`${series}:terms-salt`);
    const c = termsCommitment({ ...plain, termsSalt });
    this.secrets.set(series, { ...plain, termsSalt, termsCommitment: c, lastIncome: null, incomeCounter: 0 });
    return bytesToHex(fieldToBytes32(c));
  }

  /** New terms commitment for an amendment (θ indexed up); keeps r. */
  amendedTerms(series: string, newTheta: bigint): string {
    const sec = this.secrets.get(series)!;
    const termsSalt = this.fieldSalt(`${series}:terms-salt:${sec.incomeCounter}:${newTheta}`);
    const c = termsCommitment({ theta: newTheta, rWad: sec.rWad, currencyCode: sec.currencyCode, indexingRule: sec.indexingRule, termsSalt });
    this.secrets.set(series, { ...sec, theta: newTheta, termsSalt, termsCommitment: c });
    return bytesToHex(fieldToBytes32(c));
  }

  async createSeries(args: {
    series: string;
    issuer: string;
    plain: TermsPlain;
    terms?: Partial<Record<keyof SeriesTermsInput, bigint | number>>;
    schedule?: ReleaseTrancheInput[];
    tierFlags?: number;
    fxPairId?: string | null;
    contractHash?: string | null;
    router?: boolean;
    note?: string;
  }): Promise<void> {
    const commitment = this.defineTerms(args.series, args.plain);
    const call: Call = {
      op: "create_series",
      actor: args.issuer,
      series: args.series,
      terms: this.terms(args.terms ?? {}),
      releaseSchedule: args.schedule ?? this.quarterlySchedule(),
      termsCommitment: commitment,
      contractHash: args.contractHash === undefined ? this.salt(`${args.series}:contract`) : args.contractHash,
      tierFlags: args.tierFlags ?? 2,
      fxPairId: args.fxPairId ?? null,
    };
    if (args.router) call.router = { theta: args.plain.theta.toString(), rWad: args.plain.rWad.toString() };
    await this.step(call, args.note);
  }

  /** Standard raise: open, commit, reveal, settle, process every bid. Returns the clearing price. */
  async raise(args: {
    series: string;
    issuer: string;
    openAt: bigint;
    bids: { actor: string; price: bigint; quantity: bigint; escrow?: bigint; reveal?: boolean }[];
    clearingPrice?: bigint;
  }): Promise<bigint> {
    const s = this.sim.series.get(args.series)!;
    this.at(args.openAt);
    await this.step({ op: "open_raise", actor: args.issuer, series: args.series });
    for (const [i, b] of args.bids.entries()) {
      this.advance(3600n);
      const escrow = b.escrow ?? M.requiredEscrow(b.price, b.quantity, s.terms.auctionFeeBps);
      await this.step({ op: "commit_bid", actor: b.actor, series: args.series, price: b.price.toString(), quantity: b.quantity.toString(), salt: this.salt(`${args.series}:bid:${b.actor}:${i}`), escrow: escrow.toString() });
    }
    this.at(s.commitEnd + 3600n);
    for (const [i, b] of args.bids.entries()) {
      if (b.reveal === false) continue;
      this.advance(600n);
      await this.step({ op: "reveal_bid", actor: b.actor, series: args.series, price: b.price.toString(), quantity: b.quantity.toString(), salt: this.salt(`${args.series}:bid:${b.actor}:${i}`) });
    }
    this.at(s.revealEnd + 3600n);
    const revealed = [...s.bids.values()].filter((x) => x.revealed);
    const p = args.clearingPrice ?? M.findClearingPrice(revealed, s.terms.unitsOffered);
    await this.step({ op: "settle", series: args.series, clearingPrice: p.toString() });
    for (const b of args.bids) {
      this.advance(60n);
      await this.step({ op: "process_bid", series: args.series, bidder: b.actor });
    }
    return p;
  }

  /** Builds, proves and submits a quarterly report (and keeps the YTD commitment chain). */
  async report(a: ReportArgs): Promise<{ paymentUsd: bigint; due: bigint }> {
    const s = this.sim.series.get(a.series)!;
    const sec = this.secrets.get(a.series)!;
    const sameYearChain = sec.lastIncome !== null && Math.floor(sec.lastIncome.period / 4) === Math.floor(a.period / 4) && sec.lastIncome.period === a.period - 1;
    const prior = sameYearChain ? sec.lastIncome! : { period: a.period - 1, ytd: 0n, salt: 0n };
    const isTail = s.ledger.redemptionTs !== 0n && s.ledger.status === 5;
    const units = a.unitsOverride ?? (isTail ? s.ledger.unitsAtRedemption : s.supply);
    let fx = WAD;
    if (s.fxPairId) {
      const pair = this.sim.fxPairs.get(s.fxPairId)!;
      const qa = M.quarterAverage(pair.state, a.period, this.params);
      if (qa.ok) fx = qa.avgWad;
      else if (a.fxFallback) fx = a.fxFallback.rateWad;
      else throw new Error(`${this.name}: period ${a.period} needs an fx fallback rate`);
    }
    if (a.fxAvgWadOverride !== undefined) fx = a.fxAvgWadOverride;
    const incomeSalt = this.fieldSalt(`${a.series}:income:${sec.incomeCounter}`);
    const payment = a.paymentOverride ?? M.paymentUsd({ rWad: sec.rWad, unitsOutstanding: units, theta: sec.theta, incomeYtd: a.incomeYtd, priorIncomeYtd: prior.ytd, fxAvgWad: fx });
    const inputs: ReportInputs = {
      terms_commitment: sec.termsCommitment,
      units_outstanding: units,
      fx_avg_wad: fx,
      prior_income_commitment: prior.ytd === 0n && prior.salt === 0n ? ZERO_INCOME_COMMITMENT : incomeCommitment(prior.ytd, prior.salt),
      income_commitment: incomeCommitment(a.incomeYtd, incomeSalt),
      payment_usd: payment,
      theta: sec.theta,
      r_wad: sec.rWad,
      currency_code: BigInt(sec.currencyCode),
      indexing_rule: BigInt(sec.indexingRule),
      terms_salt: sec.termsSalt,
      income_ytd: a.incomeYtd,
      income_salt: incomeSalt,
      prior_income_ytd: prior.ytd,
      prior_salt: prior.salt,
    };
    const { proof, publicSignals } = await proveReport(inputs);
    const call: Call = {
      op: "submit_report",
      actor: a.actor ?? s.issuer,
      series: a.series,
      period: a.period.toString(),
      paymentUsd: payment.toString(),
      fxAvgWad: fx.toString(),
      fxFallback: a.fxFallback ? { attestor: a.fxFallback.attestor } : null,
      incomeCommitment: bytesToHex(fieldToBytes32(inputs.income_commitment)),
      tier: a.tier,
      liquidityEvent: a.liquidityEvent ?? false,
      attestation: a.attestation === undefined ? (a.tier === 2 ? "verifier1" : a.tier === 3 ? "attestor1" : null) : a.attestation,
      proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol, curve: proof.curve },
      publicSignals,
      proofEvm: encodeProofForEvm(proof, publicSignals),
      proofSolana: encodeProofForSolana(proof, publicSignals),
      witness: { incomeYtd: a.incomeYtd.toString(), incomeSalt: incomeSalt.toString(), priorIncomeYtd: prior.ytd.toString(), priorSalt: prior.salt.toString(), theta: sec.theta.toString(), rWad: sec.rWad.toString() },
    };
    const before = s.ledger.openDueAmount;
    await this.step(call, a.note);
    sec.incomeCounter++;
    sec.lastIncome = { period: a.period, ytd: a.incomeYtd, salt: incomeSalt };
    return { paymentUsd: payment, due: s.ledger.openDueAmount - before };
  }

  /** Same as {@link report} but expected to revert; does not advance the commitment chain. */
  async reportRevert(a: ReportArgs, error: ErrorName): Promise<void> {
    const s = this.sim.series.get(a.series)!;
    const sec = this.secrets.get(a.series)!;
    const sameYearChain = sec.lastIncome !== null && Math.floor(sec.lastIncome.period / 4) === Math.floor(a.period / 4) && sec.lastIncome.period === a.period - 1;
    const prior = sameYearChain ? sec.lastIncome! : { period: a.period - 1, ytd: 0n, salt: 0n };
    const isTail = s.ledger.redemptionTs !== 0n && s.ledger.status === 5;
    const units = a.unitsOverride ?? (isTail ? s.ledger.unitsAtRedemption : s.supply);
    let fx = a.fxAvgWadOverride ?? WAD;
    if (a.fxAvgWadOverride === undefined && s.fxPairId) {
      const pair = this.sim.fxPairs.get(s.fxPairId)!;
      const qa = M.quarterAverage(pair.state, a.period, this.params);
      fx = qa.ok ? qa.avgWad : (a.fxFallback?.rateWad ?? WAD);
    }
    const incomeSalt = this.fieldSalt(`${a.series}:income:${sec.incomeCounter}:revert`);
    const payment = a.paymentOverride ?? M.paymentUsd({ rWad: sec.rWad, unitsOutstanding: units, theta: sec.theta, incomeYtd: a.incomeYtd, priorIncomeYtd: prior.ytd, fxAvgWad: fx });
    const inputs: ReportInputs = {
      terms_commitment: sec.termsCommitment,
      units_outstanding: units,
      fx_avg_wad: fx,
      prior_income_commitment: prior.ytd === 0n && prior.salt === 0n ? ZERO_INCOME_COMMITMENT : incomeCommitment(prior.ytd, prior.salt),
      income_commitment: incomeCommitment(a.incomeYtd, incomeSalt),
      payment_usd: payment,
      theta: sec.theta,
      r_wad: sec.rWad,
      currency_code: BigInt(sec.currencyCode),
      indexing_rule: BigInt(sec.indexingRule),
      terms_salt: sec.termsSalt,
      income_ytd: a.incomeYtd,
      income_salt: incomeSalt,
      prior_income_ytd: prior.ytd,
      prior_salt: prior.salt,
    };
    const { proof, publicSignals } = await proveReport(inputs);
    const call: Call = {
      op: "submit_report",
      actor: a.actor ?? s.issuer,
      series: a.series,
      period: a.period.toString(),
      paymentUsd: payment.toString(),
      fxAvgWad: fx.toString(),
      fxFallback: a.fxFallback ? { attestor: a.fxFallback.attestor } : null,
      incomeCommitment: bytesToHex(fieldToBytes32(inputs.income_commitment)),
      tier: a.tier,
      liquidityEvent: a.liquidityEvent ?? false,
      attestation: a.attestation === undefined ? (a.tier === 2 ? "verifier1" : a.tier === 3 ? "attestor1" : null) : a.attestation,
      proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol, curve: proof.curve },
      publicSignals,
      proofEvm: encodeProofForEvm(proof, publicSignals),
      proofSolana: encodeProofForSolana(proof, publicSignals),
      witness: { incomeYtd: a.incomeYtd.toString(), incomeSalt: incomeSalt.toString(), priorIncomeYtd: prior.ytd.toString(), priorSalt: prior.salt.toString(), theta: sec.theta.toString(), rWad: sec.rWad.toString() },
    };
    await this.revert(call, error, a.note);
  }

  // ---- output -------------------------------------------------------------------------------

  build(): Vector {
    const seriesPrivate: Vector["seriesPrivate"] = {};
    for (const [id, sec] of this.secrets) {
      seriesPrivate[id] = {
        termsPlain: { theta: sec.theta.toString(), rWad: sec.rWad.toString(), currencyCode: sec.currencyCode, indexingRule: sec.indexingRule, termsSalt: sec.termsSalt.toString() },
        termsCommitment: bytesToHex(fieldToBytes32(sec.termsCommitment)),
      };
    }
    return {
      name: this.name,
      description: this.description,
      schema: 1,
      generatedBy: "packages/reference/src/vectors/generate.ts (pnpm vectors)",
      config: {
        parameters: parametersToStrings(this.params),
        flags: this.flags,
        stablecoinDecimals: 6,
        chainDomainNote:
          "Bid/ask commitments, signed messages and the deployment domain depend on chain-specific wallet bytes and chain id; harnesses recompute them from the plaintext fields here (salts, prices, quantities, periods, nonces) and sign with the keys derived from `keys[*].seed`. Amounts, periods and ledger values are chain-independent.",
      },
      actors: [...this.actors].sort(),
      keys: this.keys,
      seriesPrivate,
      steps: this.steps,
    };
  }
}

export { bytes32 };
