import { describe, it, expect } from "vitest";
import { poseidon2, poseidon5 } from "poseidon-lite";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  BN254_FQ,
  NR_PUBLIC_INPUTS,
  PUBLIC_INPUT_NAMES,
  WAD,
  encodeProofForEvm,
  encodeProofForSolana,
  expectedPaymentUsd,
  negateG1,
  owedYtd,
  proveReport,
  publicSignalsOf,
  verifyReport,
  type ReportInputs,
} from "../src/index.js";

const USDC = 1_000_000n; // 6 decimals
const ZERO_INCOME_COMMITMENT = poseidon2([0n, 0n]);

interface Scenario {
  theta: bigint;
  rWad: bigint;
  units: bigint;
  fx?: bigint;
  incomeYtd: bigint;
  priorIncomeYtd: bigint;
  currencyCode?: bigint;
  indexingRule?: bigint;
  termsSalt?: bigint;
  incomeSalt?: bigint;
  priorSalt?: bigint;
  paymentUsd?: bigint;
}

function inputs(s: Scenario): ReportInputs {
  const fx = s.fx ?? WAD;
  const currency = s.currencyCode ?? 840n;
  const indexing = s.indexingRule ?? 0n;
  const termsSalt = s.termsSalt ?? 0x1111n;
  const incomeSalt = s.incomeSalt ?? 0x2222n;
  const priorSalt = s.priorSalt ?? (s.priorIncomeYtd === 0n ? 0n : 0x3333n);
  const paymentUsd =
    s.paymentUsd ??
    expectedPaymentUsd({
      rWad: s.rWad,
      unitsOutstanding: s.units,
      theta: s.theta,
      incomeYtd: s.incomeYtd,
      priorIncomeYtd: s.priorIncomeYtd,
      fxAvgWad: fx,
    });
  return {
    terms_commitment: poseidon5([s.theta, s.rWad, currency, indexing, termsSalt]),
    units_outstanding: s.units,
    fx_avg_wad: fx,
    prior_income_commitment: poseidon2([s.priorIncomeYtd, priorSalt]),
    income_commitment: poseidon2([s.incomeYtd, incomeSalt]),
    payment_usd: paymentUsd,
    theta: s.theta,
    r_wad: s.rWad,
    currency_code: currency,
    indexing_rule: indexing,
    terms_salt: termsSalt,
    income_ytd: s.incomeYtd,
    income_salt: incomeSalt,
    prior_income_ytd: s.priorIncomeYtd,
    prior_salt: priorSalt,
  };
}

// Baseline: θ = 80,000 USDC a year, 100 units at r = 0.1% each (10% total share).
const base: Scenario = {
  theta: 80_000n * USDC,
  rWad: WAD / 1000n,
  units: 100n,
  incomeYtd: 110_000n * USDC,
  priorIncomeYtd: 70_000n * USDC,
};

describe("report circuit", () => {
  it("proves and verifies a valid witness; public signals are in SPEC §8 order", async () => {
    const inp = inputs(base);
    expect(inp.payment_usd).toBe(3_000n * USDC); // 10% × (110k − 80k)
    const t0 = performance.now();
    const { proof, publicSignals } = await proveReport(inp);
    const ms = performance.now() - t0;
    console.log(`proving time (first proof, includes wasm/zkey load): ${ms.toFixed(0)} ms`);
    expect(publicSignals).toHaveLength(NR_PUBLIC_INPUTS);
    expect(publicSignals).toEqual(publicSignalsOf(inp));
    expect(PUBLIC_INPUT_NAMES).toEqual([
      "terms_commitment",
      "units_outstanding",
      "fx_avg_wad",
      "prior_income_commitment",
      "income_commitment",
      "payment_usd",
    ]);
    expect(await verifyReport(proof, publicSignals)).toBe(true);
  });

  it("is deterministic for identical inputs and differs with a nonce; both verify", async () => {
    const inp = inputs(base);
    const t0 = performance.now();
    const a = await proveReport(inp);
    console.log(`proving time (warm): ${(performance.now() - t0).toFixed(0)} ms`);
    const b = await proveReport(inp);
    expect(b).toEqual(a);
    const c = await proveReport(inp, { nonce: Uint8Array.of(1) });
    expect(c.proof.pi_a).not.toEqual(a.proof.pi_a);
    expect(await verifyReport(c.proof, c.publicSignals)).toBe(true);
    const d = await proveReport(inp, { deterministic: false });
    expect(d.proof.pi_a).not.toEqual(a.proof.pi_a);
    expect(await verifyReport(d.proof, d.publicSignals)).toBe(true);
  });

  it("rejects a wrong payment_usd (over- and under-stated)", async () => {
    await expect(proveReport(inputs({ ...base, paymentUsd: 3_000n * USDC + 1n }))).rejects.toThrow();
    await expect(proveReport(inputs({ ...base, paymentUsd: 3_000n * USDC - 1n }))).rejects.toThrow();
    await expect(proveReport(inputs({ ...base, paymentUsd: 0n }))).rejects.toThrow();
  });

  it("rejects wrong commitments", async () => {
    const good = inputs(base);
    await expect(proveReport({ ...good, terms_commitment: good.terms_commitment + 1n })).rejects.toThrow();
    await expect(proveReport({ ...good, income_commitment: good.income_commitment + 1n })).rejects.toThrow();
    await expect(proveReport({ ...good, prior_income_commitment: ZERO_INCOME_COMMITMENT })).rejects.toThrow();
    // a different theta behind the same commitment is impossible
    await expect(proveReport({ ...good, theta: good.theta - 1n })).rejects.toThrow();
  });

  it("rejects income below the prior year-to-date income", async () => {
    const bad = inputs({ ...base, incomeYtd: 70_000n * USDC - 1n, priorIncomeYtd: 70_000n * USDC, paymentUsd: 0n });
    await expect(proveReport(bad)).rejects.toThrow();
  });

  it("theta boundary: income == theta pays 0; income == theta + 1 pays floor(r × units / WAD)", async () => {
    const atTheta = inputs({ ...base, incomeYtd: base.theta, priorIncomeYtd: 0n });
    expect(atTheta.payment_usd).toBe(0n);
    const p0 = await proveReport(atTheta);
    expect(await verifyReport(p0.proof, p0.publicSignals)).toBe(true);
    expect(p0.publicSignals[5]).toBe("0");

    // r_wad × units = 1e15 × 100 = 1e17 → floor(1e17 × 1 / 1e18) = 0 for one base unit of excess...
    expect(owedYtd(base.rWad, base.units, base.theta + 1n, base.theta)).toBe(0n);
    // ...so use a share where one unit of excess is visible: r × units = 2 WAD (200% is out of
    // bounds commercially, but the circuit only cares about field arithmetic).
    const bigRate: Scenario = { ...base, rWad: WAD / 50n, units: 100n }; // 2% × 100 = 200%
    const expected = (bigRate.rWad * bigRate.units * 1n) / WAD;
    expect(expected).toBe(2n);
    const justAbove = inputs({ ...bigRate, incomeYtd: base.theta + 1n, priorIncomeYtd: 0n });
    expect(justAbove.payment_usd).toBe(expected);
    const p1 = await proveReport(justAbove);
    expect(await verifyReport(p1.proof, p1.publicSignals)).toBe(true);
    // claiming zero when something is owed fails
    await expect(proveReport({ ...justAbove, payment_usd: 0n })).rejects.toThrow();
    // and income exactly at theta with that rate still pays 0
    const p2 = await proveReport(inputs({ ...bigRate, incomeYtd: base.theta, priorIncomeYtd: 0n }));
    expect(p2.publicSignals[5]).toBe("0");
  });

  it("year-to-date example from the brief (C3): four quarters, payments only once YTD income clears θ", async () => {
    // θ = 80,000; 10% total share; quarterly YTD income 30k, 70k, 110k, 160k.
    const ytd = [30_000n, 70_000n, 110_000n, 160_000n].map((v) => v * USDC);
    const expectedPayments = [0n, 0n, 3_000n * USDC, 5_000n * USDC];
    let prior = 0n;
    let priorSalt = 0n;
    for (let q = 0; q < 4; q++) {
      const salt = BigInt(0x5000 + q);
      const inp = inputs({ ...base, incomeYtd: ytd[q]!, priorIncomeYtd: prior, priorSalt, incomeSalt: salt });
      expect(inp.payment_usd).toBe(expectedPayments[q]);
      if (q === 0) expect(inp.prior_income_commitment).toBe(ZERO_INCOME_COMMITMENT);
      const { proof, publicSignals } = await proveReport(inp);
      expect(await verifyReport(proof, publicSignals)).toBe(true);
      expect(publicSignals[5]).toBe(expectedPayments[q]!.toString());
      prior = ytd[q]!;
      priorSalt = salt;
    }
    expect(expectedPayments.reduce((a, b) => a + b, 0n)).toBe(((160_000n - 80_000n) * USDC) / 10n);
  });

  it("applies the FX rate with floor rounding", async () => {
    const fx = 1_083_456_789_012_345_678n; // 1.083456789012345678 USD per unit of income currency
    const inp = inputs({ ...base, fx, currencyCode: 978n });
    expect(inp.payment_usd).toBe((3_000n * USDC * fx) / WAD);
    const { proof, publicSignals } = await proveReport(inp);
    expect(await verifyReport(proof, publicSignals)).toBe(true);
    await expect(proveReport({ ...inp, payment_usd: inp.payment_usd + 1n })).rejects.toThrow();
  });

  it("enforces the 64-bit range checks, including payment_usd (SPEC v1.1 §8)", async () => {
    const good = inputs(base);
    await expect(proveReport({ ...good, units_outstanding: 1n << 64n })).rejects.toThrow();
    await expect(proveReport({ ...good, fx_avg_wad: 1n << 64n })).rejects.toThrow();
    const hugeIncome = inputs({ ...base, incomeYtd: 1n << 64n, paymentUsd: 0n });
    await expect(proveReport(hugeIncome)).rejects.toThrow();
    // an honest witness whose payment does not fit u64 is unprovable: r × units × excess / WAD = 2^80
    const huge: Scenario = { theta: 0n, rWad: WAD, units: 1n << 40n, incomeYtd: 1n << 40n, priorIncomeYtd: 0n };
    const hugeInputs = inputs(huge);
    expect(hugeInputs.payment_usd).toBe(1n << 80n);
    await expect(proveReport(hugeInputs)).rejects.toThrow();
    // just under 2^64 proves
    const edge: Scenario = { theta: 0n, rWad: WAD, units: 1n << 32n, incomeYtd: (1n << 32n) - 1n, priorIncomeYtd: 0n };
    const edgeInputs = inputs(edge);
    expect(edgeInputs.payment_usd).toBe((1n << 64n) - (1n << 32n));
    const { proof, publicSignals } = await proveReport(edgeInputs);
    expect(await verifyReport(proof, publicSignals)).toBe(true);
  });

  it("a verified proof fails with tampered public signals", async () => {
    const inp = inputs(base);
    const { proof, publicSignals } = await proveReport(inp);
    const tampered = [...publicSignals];
    tampered[5] = (BigInt(tampered[5]!) + 1n).toString();
    expect(await verifyReport(proof, tampered)).toBe(false);
    const swapped = [...publicSignals];
    swapped[1] = "99";
    expect(await verifyReport(proof, swapped)).toBe(false);
  });

  it("encodes proofs for the EVM verifier and for groth16-solana", async () => {
    const inp = inputs(base);
    const { proof, publicSignals } = await proveReport(inp);

    const evm = encodeProofForEvm(proof, publicSignals);
    expect(evm.pA).toEqual([proof.pi_a[0], proof.pi_a[1]]);
    expect(evm.pB).toEqual([
      [proof.pi_b[0]![1], proof.pi_b[0]![0]],
      [proof.pi_b[1]![1], proof.pi_b[1]![0]],
    ]);
    expect(evm.pC).toEqual([proof.pi_c[0], proof.pi_c[1]]);
    expect(evm.pubSignals).toEqual(publicSignals);
    expect(evm.proofBytes).toMatch(/^0x[0-9a-f]{512}$/);
    expect(evm.calldata).toMatch(/^0x[0-9a-f]{8}([0-9a-f]{64}){14}$/);
    // selector of verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])
    expect(evm.calldata.slice(2, 10)).toBe(Buffer.from(keccak_256(new TextEncoder().encode("verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])")).slice(0, 4)).toString("hex"));
    expect(BigInt("0x" + evm.proofBytes.slice(2, 66))).toBe(BigInt(proof.pi_a[0]!));
    expect(BigInt("0x" + evm.proofBytes.slice(130, 194))).toBe(BigInt(proof.pi_b[0]![1]!));

    const sol = encodeProofForSolana(proof, publicSignals);
    expect(sol.proofA).toMatch(/^0x[0-9a-f]{128}$/);
    expect(sol.proofB).toMatch(/^0x[0-9a-f]{256}$/);
    expect(sol.proofC).toMatch(/^0x[0-9a-f]{128}$/);
    expect(sol.proof).toBe("0x" + sol.proofA.slice(2) + sol.proofB.slice(2) + sol.proofC.slice(2));
    expect(sol.publicInputs).toHaveLength(6);
    for (const [i, pi] of sol.publicInputs.entries()) {
      expect(pi).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(pi)).toBe(BigInt(publicSignals[i]!));
    }
    // pi_a is negated: x unchanged, y → q − y
    expect(BigInt("0x" + sol.proofA.slice(2, 66))).toBe(BigInt(proof.pi_a[0]!));
    expect(BigInt("0x" + sol.proofA.slice(66, 130))).toBe(BN254_FQ - BigInt(proof.pi_a[1]!));
    expect(negateG1(5n, 7n)).toEqual([5n, BN254_FQ - 7n]);
    expect(negateG1(5n, 0n)).toEqual([5n, 0n]);
    // pi_b order: x.c1, x.c0, y.c1, y.c0
    expect(BigInt("0x" + sol.proofB.slice(2, 66))).toBe(BigInt(proof.pi_b[0]![1]!));
    expect(BigInt("0x" + sol.proofB.slice(66, 130))).toBe(BigInt(proof.pi_b[0]![0]!));
    expect(BigInt("0x" + sol.proofB.slice(130, 194))).toBe(BigInt(proof.pi_b[1]![1]!));
    expect(BigInt("0x" + sol.proofB.slice(194, 258))).toBe(BigInt(proof.pi_b[1]![0]!));
    // the negated point must still be on the curve: y² = x³ + 3
    const x = BigInt("0x" + sol.proofA.slice(2, 66));
    const y = BigInt("0x" + sol.proofA.slice(66, 130));
    expect((y * y) % BN254_FQ).toBe((x * x * x + 3n) % BN254_FQ);
  });
});
