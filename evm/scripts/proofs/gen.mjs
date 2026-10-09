// Generates Groth16 proofs for the Merces report circuit (dev zkey) and prints them as a Solidity fixture.
// usage: node gen.mjs <name> <theta> <rWad> <units> <fxWad> <incomeYtd> <priorIncomeYtd> <currency> <indexing> <termsSalt> <incomeSalt> <priorSalt>
import { createRequire } from "node:module";
const require = createRequire(new URL("../../../circuits/package.json", import.meta.url));
const snarkjs = require("snarkjs");
const { poseidon2, poseidon5 } = require("poseidon-lite");
const WAD = 10n ** 18n;
const [name, theta, rWad, units, fxWad, incomeYtd, priorIncomeYtd, currency, indexing, termsSalt, incomeSalt, priorSalt] = process.argv.slice(2);
const T = BigInt(theta), R = BigInt(rWad), N = BigInt(units), FX = BigInt(fxWad), Y = BigInt(incomeYtd), P = BigInt(priorIncomeYtd);
const owed = (x) => (R * N * (x > T ? x - T : 0n)) / WAD;
const payment = owed(Y) - owed(P);
const paymentUsd = (payment * FX) / WAD;
const termsCommitment = poseidon5([T, R, BigInt(currency), BigInt(indexing), BigInt(termsSalt)]);
const incomeCommitment = poseidon2([Y, BigInt(incomeSalt)]);
const priorCommitment = poseidon2([P, BigInt(priorSalt)]);
const inputs = {
  terms_commitment: termsCommitment.toString(), units_outstanding: N.toString(), fx_avg_wad: FX.toString(),
  prior_income_commitment: priorCommitment.toString(), income_commitment: incomeCommitment.toString(), payment_usd: paymentUsd.toString(),
  theta: T.toString(), r_wad: R.toString(), currency_code: currency, indexing_rule: indexing, terms_salt: termsSalt,
  income_ytd: Y.toString(), income_salt: incomeSalt, prior_income_ytd: P.toString(), prior_salt: priorSalt,
};
const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, new URL("../../../circuits/build/report.wasm", import.meta.url).pathname, new URL("../../../circuits/build/report_final.zkey", import.meta.url).pathname);
const vk = JSON.parse(require("node:fs").readFileSync(new URL("../../../circuits/build/verification_key.json", import.meta.url), "utf8"));
const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
const hex = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const out = {
  name, ok, paymentUsd: paymentUsd.toString(), incomeYtd: Y.toString(), units: N.toString(), fxWad: FX.toString(), termsCommitment: hex(termsCommitment), incomeCommitment: hex(incomeCommitment), priorCommitment: hex(priorCommitment),
  publicSignals, pA: [proof.pi_a[0], proof.pi_a[1]], pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]], pC: [proof.pi_c[0], proof.pi_c[1]],
};
console.log(JSON.stringify(out, null, 1));
process.exit(0);
