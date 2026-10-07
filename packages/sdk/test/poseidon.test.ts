import { describe, it, expect, beforeAll } from "vitest";
import { buildPoseidon, type PoseidonFn } from "circomlibjs";
import {
  BN254_FR,
  ZERO_INCOME_COMMITMENT,
  bytes32ToField,
  deriveSalt,
  fieldToBytes32,
  incomeCommitment,
  poseidon2,
  poseidon5,
  termsCommitment,
} from "../src/index.js";

let circomPoseidon: PoseidonFn;
beforeAll(async () => {
  circomPoseidon = await buildPoseidon();
});

function lcg(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 128n);
    return s;
  };
}

describe("poseidon (circomlib parameters)", () => {
  it("matches the circomlib known answer Poseidon(1, 2)", () => {
    expect(poseidon2(1n, 2n)).toBe(7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  });
  it("poseidon-lite equals circomlibjs for 2 inputs", () => {
    const next = lcg(7n);
    const cases: [bigint, bigint][] = [
      [0n, 0n],
      [1n, 2n],
      [BN254_FR - 1n, BN254_FR - 2n],
      [(1n << 64n) - 1n, 0n],
    ];
    for (let i = 0; i < 40; i++) cases.push([next() % BN254_FR, next() % BN254_FR]);
    for (const [a, b] of cases) {
      expect(poseidon2(a, b)).toBe(circomPoseidon.F.toObject(circomPoseidon([a, b])));
    }
  });
  it("poseidon-lite equals circomlibjs for 5 inputs", () => {
    const next = lcg(11n);
    const cases: [bigint, bigint, bigint, bigint, bigint][] = [
      [0n, 0n, 0n, 0n, 0n],
      [1n, 2n, 3n, 4n, 5n],
      [BN254_FR - 1n, 840n, 0n, 1n, 2n],
    ];
    for (let i = 0; i < 40; i++) cases.push([next() % BN254_FR, next() % BN254_FR, next() % BN254_FR, next() % BN254_FR, next() % BN254_FR]);
    for (const c of cases) {
      expect(poseidon5(c)).toBe(circomPoseidon.F.toObject(circomPoseidon(c)));
    }
  });
  it("ZERO_INCOME_COMMITMENT is Poseidon(2)(0, 0)", () => {
    expect(ZERO_INCOME_COMMITMENT).toBe(poseidon2(0n, 0n));
    expect(ZERO_INCOME_COMMITMENT).toBe(circomPoseidon.F.toObject(circomPoseidon([0n, 0n])));
    expect(ZERO_INCOME_COMMITMENT).toBe(14744269619966411208579211824598458697587494354926760081771325075741142829156n);
  });
  it("commitments follow SPEC §1.5 argument order", () => {
    const t = { theta: 80_000_000_000n, rWad: 1_000_000_000_000_000n, currencyCode: 840, indexingRule: 0, termsSalt: 12345n };
    expect(termsCommitment(t)).toBe(poseidon5([t.theta, t.rWad, 840n, 0n, 12345n]));
    expect(termsCommitment({ ...t, termsSalt: 12346n })).not.toBe(termsCommitment(t));
    expect(incomeCommitment(5n, 6n)).toBe(poseidon2(5n, 6n));
    expect(incomeCommitment(6n, 5n)).not.toBe(incomeCommitment(5n, 6n));
  });
  it("rejects non-field inputs", () => {
    expect(() => poseidon2(BN254_FR, 0n)).toThrow(RangeError);
    expect(() => poseidon2(-1n, 0n)).toThrow(RangeError);
    expect(() => fieldToBytes32(BN254_FR)).toThrow(RangeError);
  });
  it("field <-> bytes32 round-trips big-endian", () => {
    const v = poseidon2(3n, 4n);
    const b = fieldToBytes32(v);
    expect(b.length).toBe(32);
    expect(bytes32ToField(b)).toBe(v);
    expect(fieldToBytes32(1n)[31]).toBe(1);
  });
  it("deriveSalt is deterministic and in-field", () => {
    expect(deriveSalt("seed", "a")).toBe(deriveSalt("seed", "a"));
    expect(deriveSalt("seed", "a")).not.toBe(deriveSalt("seed", "b"));
    expect(deriveSalt("seed", "a") < BN254_FR).toBe(true);
  });
});
