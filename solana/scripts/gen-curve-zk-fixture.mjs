#!/usr/bin/env node
// Groth16 report proofs for the curve-mode LiteSVM scenario (SPEC §8, §9): the series' units are
// base lamports (10^6 per unit), so `r_wad` is per base lamport and `units_outstanding` is the
// value `sync_curve_units` stores for the scenario's DBC buys (tests/tests/curve_mode.rs asserts it).
//
//   node gen-curve-zk-fixture.mjs [--build circuits/build] [--out tests/fixtures/meteora/curve_reports.json]
//
// Development ceremony only (circuits/README).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const buildDir = resolve(opt("build", resolve(here, "../../circuits/build")));
const out = resolve(opt("out", resolve(here, "../tests/fixtures/meteora/curve_reports.json")));
const zkey = resolve(buildDir, "report_final.zkey");
const wasm = resolve(buildDir, "report_js/report.wasm");
const vkPath = resolve(buildDir, "verification_key.json");
for (const p of [zkey, wasm, vkPath]) if (!existsSync(p)) throw new Error(`missing ${p}`);
const vk = JSON.parse(readFileSync(vkPath, "utf8"));

const poseidon = await buildPoseidon();
const P = (xs) => poseidon.F.toObject(poseidon(xs.map((x) => BigInt(x))));
const WAD = 10n ** 18n;
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const be32 = (x) => BigInt(x).toString(16).padStart(64, "0");
const hex = (s) => "0x" + s;

// Terms: θ = 60,000 USD, r = 0.001 per whole unit = 10^9 per base lamport (10^6 per unit).
const THETA = 60_000_000_000n;
const R_WAD_BASE = 1_000_000_000n;
const CURRENCY = 840n;
const INDEXING = 0n;
const TERMS_SALT = 777n;
// Σ base lamports the scenario's three DBC buys leave outside the protocol (asserted by the test).
const UNITS = 99_999_998n;
const terms = P([THETA, R_WAD_BASE, CURRENCY, INDEXING, TERMS_SALT]);
const ZERO = P([0n, 0n]);
const owed = (ytd) => (R_WAD_BASE * UNITS * (ytd > THETA ? ytd - THETA : 0n)) / WAD;

const scenarios = [
  // 0.1 % × N × 20k = 2,000 USDC: under the 25 USDC/unit cap (P0 = 10, m = 2.5)
  { name: "curve_q1", prevYtd: 0n, prevSalt: 0n, prior: ZERO, ytd: 80_000_000_000n, salt: 2001n },
  // 0.1 % × N × 140k = 14,000 USDC: past the cap (≈ 2,500 USDC) → the series retires
  { name: "curve_q1_cap", prevYtd: 0n, prevSalt: 0n, prior: ZERO, ytd: 200_000_000_000n, salt: 2002n },
];
const fixtures = [];
for (const s of scenarios) {
  const income = P([s.ytd, s.salt]);
  const payment = owed(s.ytd) - owed(s.prevYtd);
  const input = {
    terms_commitment: terms.toString(),
    units_outstanding: UNITS.toString(),
    fx_avg_wad: WAD.toString(),
    prior_income_commitment: s.prior.toString(),
    income_commitment: income.toString(),
    payment_usd: payment.toString(),
    theta: THETA.toString(),
    r_wad: R_WAD_BASE.toString(),
    currency_code: CURRENCY.toString(),
    indexing_rule: INDEXING.toString(),
    terms_salt: TERMS_SALT.toString(),
    income_ytd: s.ytd.toString(),
    income_salt: s.salt.toString(),
    prior_income_ytd: s.prevYtd.toString(),
    prior_salt: s.prevSalt.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error(`${s.name} does not verify`);
  const ay = BigInt(proof.pi_a[1]);
  const a = be32(proof.pi_a[0]) + be32(ay === 0n ? 0n : Q - ay);
  const b = be32(proof.pi_b[0][1]) + be32(proof.pi_b[0][0]) + be32(proof.pi_b[1][1]) + be32(proof.pi_b[1][0]);
  const c = be32(proof.pi_c[0]) + be32(proof.pi_c[1]);
  fixtures.push({
    name: s.name,
    units_outstanding: UNITS.toString(),
    prior_income_commitment: hex(be32(s.prior)),
    income_commitment: hex(be32(income)),
    payment_usd: payment.toString(),
    proof: hex(a + b + c),
  });
  console.log(`proved ${s.name}: payment_usd=${payment}`);
}
writeFileSync(
  out,
  JSON.stringify(
    {
      generator: "solana/scripts/gen-curve-zk-fixture.mjs",
      terms: { theta: THETA.toString(), r_wad_per_base_lamport: R_WAD_BASE.toString(), terms_salt: TERMS_SALT.toString(), terms_commitment: hex(be32(terms)) },
      fixtures,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${out}`);
process.exit(0);
