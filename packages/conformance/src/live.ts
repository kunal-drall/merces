import { randomBytes } from 'node:crypto';
import { ChainError, assertSigningNetwork, isPublishedTestKey, reportDigest, signature65Hex, termsCommitment, type ChainPort, type DigestSigner } from '@merces/domain';
import { addressFromPrivateKey, signDigest, toPid, quarterIndex, yearOf, WAD } from '@merces/math';
import { assembleOnDevice, type IncomeChainEntry } from '@merces/poi-device';
import type { SimHarness } from '@merces/simulator';

/** Test operator keys only. This module is never imported by the API or verifier service. */
export function digestKey(key: string): DigestSigner {
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('conformance digest key must be a 32-byte hex value');
  let address: string;
  try { address = `0x${Buffer.from(addressFromPrivateKey(key)).toString('hex')}`; }
  catch { throw new Error('invalid conformance digest key'); }
  if (isPublishedTestKey(address)) throw new Error('published test keys are refused for live conformance');
  return { address, async signDigest(digest) { return signature65Hex(signDigest(digest, key)); } };
}

/** Real Groth16 proofs of synthetic test income; openings remain in this operator process's memory only. */
export function liveReportBuilder(chain: ChainPort, verifier: DigestSigner, attestor: DigestSigner): SimHarness['buildReport'] {
  const openings = new Map<string, IncomeChainEntry>(), secret = randomBytes(32);
  return async (p) => {
    if (p.proofs === 'mock') throw new Error('mock proofs are refused on live chains');
    const [info, series] = await Promise.all([chain.info(), chain.getSeries(p.seriesId)]);
    if (!info.signing || !series) throw new Error('live report signing context is unavailable');
    assertSigningNetwork(info.signing, { allowLocal: false });
    const pid = toPid(p.periodId), last = series.reporting.lastIncomePeriod;
    let prior: IncomeChainEntry | null = null;
    if (last && toPid(last) === pid - 1 && yearOf(toPid(last)) === yearOf(pid)) {
      prior = openings.get(series.reporting.lastIncomeCommitment) ?? null;
      if (!prior) throw new Error('the previous income opening is absent from this conformance process');
    } else if (series.reporting.lastAcceptedPeriod === null && quarterIndex(pid) !== 0 && (p.incomeYtdPrev ?? 0n) > 0n) {
      // A25 is deliberately unsupported without an authenticated prior record; this suite starts from zero.
      throw new Error('live conformance requires a zero first-period prior');
    }
    const t = p.privateTerms, tier = p.tier ?? 2;
    const built = await assembleOnDevice({
      seriesId: p.seriesId, periodId: p.periodId, termsCommitment: p.termsCommitment ?? termsCommitment(t),
      unitsOutstanding: String(p.unitsOutstanding ?? BigInt(series.redemption?.unitsAtRedemption ?? series.unitsOutstanding)),
      privateTerms: { threshold: String(t.theta), ratePerUnitWad: String(t.rWad), reportingCurrency: t.currency, indexingRule: t.indexingRule, termsSalt: String(t.termsSalt) },
      prior, incomeYtdNow: p.incomeYtdNow, fxAvgWad: p.fxAvgWad ?? WAD,
      // Assembly makes the real proof; an operator's registered key signs the synthetic test report below.
      tier: tier === 1 ? 1 : 3, source: 'attestor', deviceSecret: secret, incomeSalt: p.incomeSalt, liquidityEvent: p.liquidityEvent,
    }, null);
    openings.set(built.entry.incomeCommitment, built.entry);
    const a = built.assembled;
    let attestation = null;
    if (tier !== 1) {
      const key = tier === 2 ? (p.verifier ?? verifier) : (p.attestor ?? attestor);
      if (isPublishedTestKey(key.address)) throw new ChainError('Unauthorized', 'published test keys are refused on live chains');
      const fields = { periodId: p.periodId, priorIncomeCommitment: a.priorIncomeCommitment, incomeCommitment: a.incomeCommitment, tier: tier as 2 | 3, liquidityEvent: a.liquidityEvent };
      const digest = reportDigest({ domain: info.signing.domain, seriesKey: series.seriesKey }, fields).digest;
      const signature = 'signDigest' in key ? await key.signDigest(digest) : (await key.attest('REPORT', info.signing, series.seriesKey, fields)).signature;
      attestation = { signer: key.address, signature };
    }
    const fxFallback = p.fxFallback ? await p.fxFallback.attest('FX', info.signing, series.seriesKey, { periodId: p.periodId, fxRateWad: String(p.fxAvgWad ?? WAD) }) : null;
    return { paymentStable: BigInt(a.paymentStable), source: p.source ?? 'synthetic-conformance', command: {
      kind: 'submitReport', seriesId: p.seriesId, periodId: p.periodId, tier,
      paymentStable: a.paymentStable, priorIncomeCommitment: a.priorIncomeCommitment, incomeCommitment: a.incomeCommitment,
      proof: a.proof, attestation, liquidityEvent: a.liquidityEvent, fxAvgWad: String(p.fxAvgWad ?? WAD),
      fxBasis: p.fxBasis ?? (fxFallback ? 'attestor' : 'unity'), pair: p.pair ?? null,
      fxFallback: fxFallback ? { signer: fxFallback.signer, signature: fxFallback.signature } : null,
    } };
  };
}
