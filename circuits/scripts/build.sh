#!/usr/bin/env bash
# Merces ProofOfIncome circuit build + DEVELOPMENT-ONLY trusted setup.
#
# Deterministic: the powers-of-tau and phase-2 contributions are snarkjs *beacon* contributions
# (a public SHA-256 hash chain, no local randomness), so every run reproduces the same
# report_final.zkey, verification_key.json, Groth16Verifier.sol and vk.rs byte for byte.
# This is NOT a secure ceremony: anyone can recompute the toxic waste. See build/README.md.
set -euo pipefail

CIRCUITS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${CIRCUITS_DIR:?}/.." && pwd)"
BUILD="${CIRCUITS_DIR:?}/build"
SNARKJS="${CIRCUITS_DIR:?}/node_modules/.bin/snarkjs"
CIRCOM="${CIRCOM:-circom}"
NAME="report"

EVM_VERIFIER="${REPO_DIR:?}/evm/src/zk/Groth16Verifier.sol"
SOLANA_VK="${REPO_DIR:?}/solana/programs/merces_protocol/src/zk/vk.rs"

# Fixed, public beacon values (hex of ASCII strings so they are self-describing).
PTAU_BEACON_HEX=$(printf 'MERCES_DEV_PTAU_BEACON_V1_NOT_FOR_PRODUCTION' | od -An -tx1 | tr -d ' \n')
ZKEY_BEACON_HEX=$(printf 'MERCES_DEV_PHASE2_BEACON_V1_NOT_FOR_PRODUCTION' | od -An -tx1 | tr -d ' \n')
BEACON_ITER_EXP=10
MIN_POWER=12

log() { printf '\n[circuits] %s\n' "$*"; }

command -v "$CIRCOM" >/dev/null || { echo "circom not found on PATH" >&2; exit 1; }
[ -x "$SNARKJS" ] || { echo "snarkjs not installed: run pnpm install" >&2; exit 1; }

mkdir -p "${BUILD:?}"
rm -rf "${BUILD:?}/${NAME:?}_js"
rm -f "${BUILD:?}/${NAME:?}.r1cs" "${BUILD:?}/${NAME:?}.sym" "${BUILD:?}/${NAME:?}.wasm"

log "compiling $NAME.circom ($($CIRCOM --version))"
"$CIRCOM" "$CIRCUITS_DIR/src/$NAME.circom" --r1cs --wasm --sym -o "$BUILD" -l "$CIRCUITS_DIR/node_modules"
cp "$BUILD/${NAME}_js/$NAME.wasm" "$BUILD/$NAME.wasm"

INFO=$("$SNARKJS" r1cs info "$BUILD/$NAME.r1cs" | sed 's/\x1b\[[0-9;]*m//g')
CONSTRAINTS=$(printf '%s\n' "$INFO" | sed -n 's/.*# of Constraints: *\([0-9]*\).*/\1/p')
PUBLIC=$(printf '%s\n' "$INFO" | sed -n 's/.*# of Public Inputs: *\([0-9]*\).*/\1/p')
OUTPUTS=$(printf '%s\n' "$INFO" | sed -n 's/.*# of Outputs: *\([0-9]*\).*/\1/p')
[ -n "$CONSTRAINTS" ] && [ -n "$PUBLIC" ] && [ -n "$OUTPUTS" ] || { echo "could not parse snarkjs r1cs info" >&2; exit 1; }

# The Groth16 evaluation domain must cover constraints + public signals + 1.
NEEDED=$((CONSTRAINTS + PUBLIC + OUTPUTS + 1))
POWER=$MIN_POWER
while [ $((1 << POWER)) -lt "$NEEDED" ]; do POWER=$((POWER + 1)); done
log "constraints=$CONSTRAINTS public=$PUBLIC outputs=$OUTPUTS -> powers of tau 2^$POWER"

PTAU0="${BUILD:?}/pot${POWER}_0000.ptau"
PTAU1="${BUILD:?}/pot${POWER}_beacon.ptau"
PTAUF="${BUILD:?}/pot${POWER}_final.ptau"
if [ ! -f "$PTAUF" ]; then
  log "powers of tau: new"
  "$SNARKJS" powersoftau new bn128 "$POWER" "$PTAU0" >/dev/null
  log "powers of tau: deterministic beacon contribution"
  "$SNARKJS" powersoftau beacon "$PTAU0" "$PTAU1" "$PTAU_BEACON_HEX" "$BEACON_ITER_EXP" -n="Merces dev beacon (not for production)" >/dev/null
  log "powers of tau: prepare phase 2"
  "$SNARKJS" powersoftau prepare phase2 "$PTAU1" "$PTAUF" >/dev/null
  rm -f "${PTAU0:?}" "${PTAU1:?}"
fi
log "powers of tau: verify"
"$SNARKJS" powersoftau verify "$PTAUF" >/dev/null

ZKEY0="${BUILD:?}/${NAME:?}_0000.zkey"
ZKEYF="${BUILD:?}/${NAME:?}_final.zkey"
log "groth16 setup"
"$SNARKJS" groth16 setup "$BUILD/$NAME.r1cs" "$PTAUF" "$ZKEY0" >/dev/null
log "phase 2: deterministic beacon contribution"
"$SNARKJS" zkey beacon "$ZKEY0" "$ZKEYF" "$ZKEY_BEACON_HEX" "$BEACON_ITER_EXP" -n="Merces dev phase-2 beacon (not for production)" >/dev/null
rm -f "${ZKEY0:?}"
log "zkey verify"
"$SNARKJS" zkey verify "$BUILD/$NAME.r1cs" "$PTAUF" "$ZKEYF" >/dev/null
"$SNARKJS" zkey export verificationkey "$ZKEYF" "$BUILD/verification_key.json" >/dev/null

log "exporting Solidity verifier -> $EVM_VERIFIER"
mkdir -p "$(dirname "$EVM_VERIFIER")"
"$SNARKJS" zkey export solidityverifier "$ZKEYF" "$EVM_VERIFIER" >/dev/null
# snarkjs emits `pragma solidity >=0.7.0 <0.9.0;`; Merces contracts compile with 0.8.30.
sed -i 's/^pragma solidity .*;$/pragma solidity ^0.8.30;/' "$EVM_VERIFIER"
grep -q '^pragma solidity \^0.8.30;$' "$EVM_VERIFIER"
grep -q 'SPDX-License-Identifier: GPL-3.0' "$EVM_VERIFIER"
if command -v forge >/dev/null 2>&1; then
  (cd "$REPO_DIR/evm" && forge fmt "$EVM_VERIFIER" >/dev/null 2>&1) || echo "[circuits] warning: forge fmt failed on the generated verifier" >&2
fi

log "exporting Rust verifying key -> $SOLANA_VK"
mkdir -p "$(dirname "$SOLANA_VK")"
node "$CIRCUITS_DIR/scripts/export-vk-rs.mjs" "$BUILD/verification_key.json" "$SOLANA_VK"
if command -v rustfmt >/dev/null 2>&1; then
  rustfmt --edition 2021 "$SOLANA_VK"
fi

# Record what the artefacts were built from so a stale zkey is detectable without the ptau.
{
  echo "circuit: src/$NAME.circom"
  echo "circom: $($CIRCOM --version | tr -d '\n')"
  echo "snarkjs: $(node -p "require('$CIRCUITS_DIR/node_modules/snarkjs/package.json').version")"
  echo "constraints: $CONSTRAINTS"
  echo "public_inputs: $PUBLIC"
  echo "power: $POWER"
  echo "ptau_beacon_hex: $PTAU_BEACON_HEX"
  echo "zkey_beacon_hex: $ZKEY_BEACON_HEX"
  echo "beacon_iterations_exp: $BEACON_ITER_EXP"
  echo "r1cs_sha256: $(sha256sum "$BUILD/$NAME.r1cs" | cut -d' ' -f1)"
  echo "wasm_sha256: $(sha256sum "$BUILD/$NAME.wasm" | cut -d' ' -f1)"
  echo "zkey_sha256: $(sha256sum "$ZKEYF" | cut -d' ' -f1)"
  echo "vk_sha256: $(sha256sum "$BUILD/verification_key.json" | cut -d' ' -f1)"
} > "$BUILD/MANIFEST.txt"

log "done: zkey sha256 $(sed -n 's/^zkey_sha256: //p' "$BUILD/MANIFEST.txt")"
