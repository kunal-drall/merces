# Merces ProofOfIncome reference circuit

`src/report.circom` is the Groth16 (BN254) circuit of SPEC.md §8: it proves that a quarter's
`payment_usd` follows from the year-to-date formula of the brief (C3) without revealing income, the
threshold θ or the per-unit rate r. The same proof is verified by `evm/src/zk/Groth16Verifier.sol`
(snarkjs-generated, EVM precompiles) and by the Solana program through `groth16-solana` 0.2.0 with the
key in `solana/programs/merces_protocol/src/zk/vk.rs`. Both files are generated here; never edit them.

> **The trusted setup in `build/` is development-only.** It is a deterministic snarkjs *beacon*
> ceremony (see `build/README.md`) whose toxic waste anyone can recompute. Production needs a real
> multi-party ceremony and regenerated verifiers.

## Build

```bash
pnpm install
pnpm circuits:build          # at the repo root; same as `pnpm --filter @merces/circuits circuit`
cd circuits && pnpm test     # vitest: proving, negative cases, encoders
```

`scripts/build.sh` runs circom 2.2.3 (`-l node_modules` for circomlib 2.0.5), picks the smallest
powers-of-tau size that fits the circuit (2^12 today), performs the beacon ceremony, verifies the ptau
and the zkey, exports `build/verification_key.json`, writes the Solidity verifier (pragma rewritten to
`^0.8.30`, GPL header kept, `forge fmt` applied when `forge` is on PATH) and the Rust key (`rustfmt`
applied when available), and records hashes in `build/MANIFEST.txt`. Running it twice yields identical
bytes (the build is checked in and the embedded proofs in `packages/vectors` depend on it).

## Measurements

| Item | Value |
| --- | --- |
| Constraints (snarkjs `r1cs info`) | **3,432** (SPEC v1.1 adds the `payment_usd < 2^64` check; v1.0 had 3,367) |
| Public inputs | 6 |
| Private inputs | 9 |
| Powers of tau | 2^12 |
| Proving time, snarkjs 0.7.6 (Node 22, this container) | ≈ 640 ms cold (includes loading wasm + zkey), ≈ 290 ms warm |
| `report_final.zkey` | ≈ 3.5 MB (checked in) |

On-chain verification cost (CU on Solana, gas on EVM) is measured by Tracks B and C and reported in
`AUDIT_NOTES.md`.

## Signals

Public inputs, **in this order** (declaration order in the template; it is also the order of the
snarkjs `publicSignals`, of `Groth16Verifier.verifyProof(..., uint256[6] pubSignals)` and of the
`[[u8; 32]; 6]` array passed to `groth16_solana::Groth16Verifier`):

| # | Signal | Meaning |
| --- | --- | --- |
| 0 | `terms_commitment` | `Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)` (read from the registry on-chain) |
| 1 | `units_outstanding` | units outstanding at report time (`units_at_redemption` for tail reports) |
| 2 | `fx_avg_wad` | quarter-average rate, WAD (`1e18` for stablecoin income) |
| 3 | `prior_income_commitment` | `Poseidon(2)(prior_income_ytd, prior_salt)`; `ZERO_INCOME_COMMITMENT = Poseidon(2)(0, 0)` at the start of a year |
| 4 | `income_commitment` | `Poseidon(2)(income_ytd, income_salt)` |
| 5 | `payment_usd` | stablecoin base units due for the quarter |

Private: `theta, r_wad, currency_code, indexing_rule, terms_salt, income_ytd, income_salt, prior_income_ytd, prior_salt`.

Constraints: the three Poseidon openings; 64-bit range checks on `income_ytd`, `prior_income_ytd`,
`theta`, `r_wad`, `units_outstanding`, `fx_avg_wad` and `payment_usd` (the last is new in SPEC v1.1 §8 so the
stablecoin amount always fits `u64`); `income_ytd ≥ prior_income_ytd` (the high-water-mark rule of §1.5
guarantees a witness exists);
`excess(x) = x > theta ? x − theta : 0` (comparator + multiplication);
`owed(x) = floor(r_wad × units_outstanding × excess(x) / WAD)` as witness quotient/remainder with
`num === q × WAD + rem`, `rem < WAD` and `q < 2^128`; `owed(income) ≥ owed(prior)`;
`payment_usd === floor((owed(income) − owed(prior)) × fx_avg_wad / WAD)` with the same technique.
All products stay below 2^192 so nothing wraps the field.

Income scale (SPEC v1.1 §1.5): `income_ytd` and `theta` are amounts in the income currency expressed with
the **stablecoin's decimals** (6 for USDC/USDG), not ISO minor units; `fx_avg_wad` is the unit-less WAD
ratio "stablecoin units per income-currency unit" and equals `1e18` when the income currency is the
stablecoin itself (§6.2 step 4), so `payment_usd` is directly in stablecoin base units.

## Proof encoding

`src/prover.ts` (`@merces/circuits`) exports:

- `proveReport(inputs, { deterministic?, nonce? })` → `{ proof, publicSignals }` in snarkjs JSON form.
  By default the Groth16 blinding scalars are derived from a hash of the inputs (which include the
  private salts), so the same witness always yields the same proof; this is what keeps
  `packages/vectors` reproducible. The proof remains zero-knowledge towards verifiers. Pass
  `{ deterministic: false }` for CSPRNG randomness.
- `verifyReport(proof, publicSignals)` with `build/verification_key.json`.
- `encodeProofForEvm(proof, publicSignals)` → `{ pA, pB, pC, pubSignals, proofBytes, calldata }`
  - `pA = [pi_a.x, pi_a.y]`, `pC = [pi_c.x, pi_c.y]` (decimal strings)
  - `pB = [[pi_b.x.c1, pi_b.x.c0], [pi_b.y.c1, pi_b.y.c0]]` — **imaginary part first**, exactly what
    `snarkjs zkey export solidityverifier` / `exportSolidityCallData` expect
  - `proofBytes` = `abi.encode(pA, pB, pC)` (8 words); `calldata` = selector of
    `verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[6])` + 14 words
- `encodeProofForSolana(proof, publicSignals)` → `{ proofA, proofB, proofC, proof, publicInputs }`
  - every coordinate is a 32-byte **big-endian** field element (groth16-solana reads big-endian)
  - `proofA` (64 bytes) is **`negate_g1(pi_a)`**: `x ‖ (q − y)`. groth16-solana's pairing check
    expects `−A` as its first G1 input (its README negates `proof_a` before calling
    `Groth16Verifier::new`); doing the negation off-chain saves the on-chain `ark` decode. The program
    must pass `proofA` straight through and must **not** negate again.
  - `proofB` (128 bytes) = `x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0`; `proofC` (64 bytes) = `x ‖ y`
  - `proof` = `proofA ‖ proofB ‖ proofC` (256 bytes, the natural instruction payload)
  - `publicInputs` = six 32-byte big-endian scalars in the order above, for `[[u8; 32]; 6]`
- `negateG1(x, y)`, `expectedPaymentUsd(...)`, `owedYtd(...)`, `publicSignalsOf(inputs)`.

`vk.rs` follows the crate's `parse_vk_to_rust.js` byte order (G2 = `c1 ‖ c0` per coordinate) and its
`nr_pubinputs` convention (`IC.len()` = public inputs + 1); `NR_PUBLIC_INPUTS = 6` is exported
alongside. The file is rustfmt-clean so `cargo fmt --check` passes once Track B declares `mod zk;`.

## Tests (`test/report.test.ts`)

Valid witness proves and verifies with public signals in SPEC order; determinism (same inputs → same
proof, nonce → different proof); wrong `payment_usd` (±1, 0) rejected; wrong terms / income / prior
commitments rejected; income below prior rejected; θ boundary (income = θ pays 0, income = θ + 1 pays
`floor(r × units / WAD)`, claiming 0 then fails); the brief's four-quarter YTD example; FX floor
rounding; 64-bit range checks including an honest witness whose `payment_usd` would be `2^80` (unprovable)
and one just under `2^64` (proves); tampered public signals fail verification; EVM and Solana encodings
(including the on-curve check of the negated `pi_a`).
