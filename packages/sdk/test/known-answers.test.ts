import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChainKind,
  MAGIC,
  ZERO_INCOME_COMMITMENT,
  addressFromPrivateKey,
  amendmentMessage,
  bidCommitment,
  bidCommitmentPreimage,
  bytesToHex,
  computeDomain,
  daysInPeriod,
  deriveTestPrivateKey,
  extinguishMessage,
  fieldToBytes32,
  fxFallbackMessage,
  hexToBytes,
  incomeCommitment,
  keccak256,
  mulDiv,
  mulDivCeil,
  pauseApprovalMessage,
  periodEnd,
  periodOf,
  periodStart,
  poseidon2,
  poseidon5,
  publicKeyFromPrivate,
  recoverAddress,
  reportAttestationMessage,
  signDigest,
  termsCommitment,
  toChecksumAddress,
  trueUpMessage,
  verifySignature,
  walletFromEvmAddress,
  walletFromSolanaPubkey,
  parametersToStrings,
  DEFAULT_PARAMETERS,
  tradingDaysInPeriod,
  pausedWithin,
  unpaused,
  newYearGross,
  yearGrossAdd,
  yearGrossGet,
  settlementYear,
  fxPairId,
  normalizePythPrice,
  invertRate,
  routerIncomeCommitment,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sdkJson = readFileSync(resolve(here, "known-answers.json"), "utf8");
const vectorsJson = readFileSync(resolve(here, "../../vectors/known_answers.json"), "utf8");
const ka = JSON.parse(sdkJson);

describe("known-answers.json", () => {
  it("is identical to the copy shipped with the vectors", () => {
    expect(vectorsJson).toBe(sdkJson);
  });
  it("constants", () => {
    expect(ka.schema).toBe(2);
    expect(ka.specVersion).toBe("1.1");
    expect(ka.constants.WAD).toBe("1000000000000000000");
    expect(ka.constants.ZERO_INCOME_COMMITMENT).toBe(ZERO_INCOME_COMMITMENT.toString());
    expect(ka.constants.ZERO_INCOME_COMMITMENT_HEX).toBe(bytesToHex(fieldToBytes32(ZERO_INCOME_COMMITMENT)));
    expect(ka.constants.MAGIC).toEqual(MAGIC);
    expect(ka.constants.MAGIC_HEX.REPORT).toBe("0x4d45524345535f5245504f52545f5631");
    expect(ka.parameters.defaults).toEqual(parametersToStrings(DEFAULT_PARAMETERS));
  });
  it("keccak256", () => {
    for (const c of ka.keccak256) expect(bytesToHex(keccak256(hexToBytes(c.input)))).toBe(c.output);
  });
  it("poseidon", () => {
    for (const c of ka.poseidon2) {
      const out = poseidon2(BigInt(c.inputs[0]), BigInt(c.inputs[1]));
      expect(out.toString()).toBe(c.output);
      expect(bytesToHex(fieldToBytes32(out))).toBe(c.outputHex);
    }
    for (const c of ka.poseidon5) {
      const out = poseidon5(c.inputs.map((v: string) => BigInt(v)) as [bigint, bigint, bigint, bigint, bigint]);
      expect(out.toString()).toBe(c.output);
    }
    for (const c of ka.termsCommitments) {
      const out = termsCommitment({ theta: BigInt(c.theta), rWad: BigInt(c.rWad), currencyCode: c.currencyCode, indexingRule: c.indexingRule, termsSalt: BigInt(c.termsSalt) });
      expect(out.toString()).toBe(c.commitment);
      expect(bytesToHex(fieldToBytes32(out))).toBe(c.commitmentHex);
    }
    for (const c of ka.incomeCommitments) {
      expect(incomeCommitment(BigInt(c.incomeYtd), BigInt(c.incomeSalt)).toString()).toBe(c.commitment);
    }
  });
  it("wallets, domains and series keys", () => {
    for (const w of ka.wallets) {
      const out = w.kind === "solana" ? walletFromSolanaPubkey(w.input) : walletFromEvmAddress(w.input);
      expect(bytesToHex(out)).toBe(w.wallet);
    }
    for (const d of ka.domains) {
      expect(bytesToHex(computeDomain(d.chainKind as ChainKind, BigInt(d.chainId), hexToBytes(d.registry)))).toBe(d.domain);
      expect(bytesToHex(keccak256(hexToBytes(d.preimage)))).toBe(d.domain);
      expect(hexToBytes(d.preimage).length).toBe(1 + 8 + 32);
    }
    expect(ka.seriesKeys.evm.key).toBe("0x" + "00".repeat(31) + "01");
  });
  it("bid commitments", () => {
    for (const b of ka.bidCommitments) {
      expect(bytesToHex(bidCommitmentPreimage(BigInt(b.price), BigInt(b.quantity), hexToBytes(b.salt), hexToBytes(b.wallet)))).toBe(b.preimage);
      expect(bytesToHex(bidCommitment(BigInt(b.price), BigInt(b.quantity), hexToBytes(b.salt), hexToBytes(b.wallet)))).toBe(b.commitment);
      expect(bytesToHex(keccak256(hexToBytes(b.preimage)))).toBe(b.commitment);
    }
  });
  it("test keys", () => {
    for (const k of ka.testKeys) {
      const priv = deriveTestPrivateKey(k.seed);
      expect(bytesToHex(priv)).toBe(k.privateKey);
      expect(bytesToHex(publicKeyFromPrivate(priv))).toBe(k.publicKey);
      expect(bytesToHex(addressFromPrivateKey(priv))).toBe(k.address);
      expect(toChecksumAddress(k.address)).toBe(k.addressChecksum);
    }
  });
  it("messages: pre-images, digests and signatures", () => {
    const domains = Object.fromEntries(ka.domains.map((d: { name: string; domain: string }) => [d.name, hexToBytes(d.domain)]));
    const keys = Object.fromEntries(ka.testKeys.map((k: { seed: string; privateKey: string }) => [k.seed, hexToBytes(k.privateKey)]));
    expect(ka.messages.length).toBe(20);
    for (const m of ka.messages) {
      const domain = domains[m.domain]!;
      const seriesKey = m.seriesKey.startsWith("bytes32") ? hexToBytes(ka.seriesKeys.evm.key) : hexToBytes(ka.seriesKeys.solana.key);
      const common = { domain, seriesKey };
      const f = m.fields;
      let built;
      switch (m.kind) {
        case "REPORT":
          built = reportAttestationMessage({ ...common, period: f.period, priorIncomeCommitment: hexToBytes(f.priorIncomeCommitment), incomeCommitment: hexToBytes(f.incomeCommitment), tier: f.tier, liquidityEvent: f.liquidityEvent });
          break;
        case "FX":
          built = fxFallbackMessage({ ...common, period: f.period, fxRateWad: BigInt(f.fxRateWad) });
          break;
        case "AMEND":
          built = amendmentMessage({ ...common, amendmentNonce: BigInt(f.amendmentNonce), newTermsCommitment: hexToBytes(f.newTermsCommitment), newCapMultipleWad: BigInt(f.newCapMultipleWad) });
          break;
        case "PAUSE":
          built = pauseApprovalMessage({ ...common, pauseNonce: BigInt(f.pauseNonce), pauseEnd: BigInt(f.pauseEnd) });
          break;
        case "EXTINGUISH":
          built = extinguishMessage({ ...common, extinguishNonce: BigInt(f.extinguishNonce) });
          break;
        case "TRUEUP":
          built = trueUpMessage({ ...common, trueupNonce: BigInt(f.trueupNonce), year: f.year, adjustment: BigInt(f.adjustment), attestationTs: BigInt(f.attestationTs) });
          break;
        default:
          throw new Error(`unknown kind ${m.kind}`);
      }
      expect(bytesToHex(built.preimage)).toBe(m.preimage);
      expect(built.preimage.length).toBe(m.preimageLength);
      expect(bytesToHex(built.digest)).toBe(m.digest);
      expect(bytesToHex(keccak256(hexToBytes(m.preimage)))).toBe(m.digest);
      const sig = signDigest(built.digest, keys[m.signer]!);
      expect(bytesToHex(sig.bytes)).toBe(m.signature);
      expect(bytesToHex(sig.bytes.slice(0, 32))).toBe(m.r);
      expect(bytesToHex(sig.bytes.slice(32, 64))).toBe(m.s);
      expect(sig.v).toBe(m.v);
      expect(bytesToHex(recoverAddress(built.digest, hexToBytes(m.signature)))).toBe(m.signerAddress);
      expect(verifySignature(built.digest, hexToBytes(m.signature), hexToBytes(m.signerAddress))).toBe(true);
    }
  });
  it("periods", () => {
    expect(ka.periods.length).toBeGreaterThanOrEqual(20);
    for (const p of ka.periods) {
      const ts = BigInt(p.timestamp);
      expect(BigInt(Date.parse(p.iso) / 1000)).toBe(ts);
      expect(periodOf(ts)).toBe(p.periodId);
      expect(p.periodId).toBe(p.year * 4 + p.quarter - 1);
      expect(periodStart(p.periodId).toString()).toBe(p.periodStart);
      expect(periodEnd(p.periodId).toString()).toBe(p.periodEnd);
      expect(Number(daysInPeriod(p.periodId))).toBe(p.daysInPeriod);
      expect(Number(tradingDaysInPeriod(p.periodId))).toBe(p.tradingDaysInPeriod);
    }
  });
  it("pauses, year_gross ring, fx helpers and router bindings", () => {
    const pauses = ka.pauses.pauseList.map((p: { start: string; end: string }) => ({ start: BigInt(p.start), end: BigInt(p.end) }));
    for (const c of ka.pauses.cases) {
      expect(pausedWithin(pauses, BigInt(c.a), BigInt(c.b), BigInt(c.now)).toString()).toBe(c.pausedWithin);
      expect(unpaused(pauses, BigInt(c.a), BigInt(c.b), BigInt(c.now)).toString()).toBe(c.unpaused);
    }
    let ring = newYearGross();
    for (const a of ka.yearGross.adds) ring = yearGrossAdd(ring, a.year, BigInt(a.incWad));
    expect(ring.map((s) => ({ year: s.year, grossWad: s.grossWad.toString() }))).toEqual(ka.yearGross.slots);
    for (const r of ka.yearGross.reads) expect(yearGrossGet(ring, r.year).toString()).toBe(r.grossWad);
    for (const e of ka.yearGross.settlementYearExamples) expect(settlementYear(BigInt(e.ts), BigInt(e.settlementTs))).toBe(e.year);
    for (const p of ka.fx.pairIds) expect(bytesToHex(fxPairId(p.feedId, p.inverted))).toBe(p.pairId);
    for (const n of ka.fx.normalize) expect(normalizePythPrice(BigInt(n.price), n.expo).toString()).toBe(n.rateWad);
    for (const i of ka.fx.invert) expect(invertRate(BigInt(i.rateWad)).toString()).toBe(i.inverted);
    for (const r of ka.routerIncomeCommitments) {
      expect(routerIncomeCommitment(BigInt(r.ytdAtEnd)).toString()).toBe(r.commitment);
      expect(bytesToHex(fieldToBytes32(routerIncomeCommitment(BigInt(r.ytdAtEnd))))).toBe(r.commitmentHex);
    }
  });
  it("fixed point", () => {
    for (const c of ka.fixedPoint) {
      const f = c.op === "mulDiv" ? mulDiv : mulDivCeil;
      expect(f(BigInt(c.a), BigInt(c.b), BigInt(c.c)).toString()).toBe(c.result);
    }
  });
});
