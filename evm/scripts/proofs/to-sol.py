#!/usr/bin/env python3
"""Writes test/utils/Proofs.sol from the JSON proofs produced by gen.mjs (see run.sh)."""
import json, sys, os
out_dir, target = sys.argv[1], sys.argv[2]
names = ["q1", "q2", "q3zero", "q4", "y2q1", "y2q2cap", "belowTheta", "fxQ1", "units299", "big", "tail", "tinyCap", "t1q1", "t1q2"]
parts = []
for n in names:
    d = json.load(open(os.path.join(out_dir, n + ".json")))
    assert d["ok"], n
    a, b, c = d["pA"], d["pB"], d["pC"]
    parts.append(f"""    function {n}() internal pure returns (Proof memory p) {{
        p.a = [uint256({a[0]}), uint256({a[1]})];
        p.b = [
            [uint256({b[0][0]}), uint256({b[0][1]})],
            [uint256({b[1][0]}), uint256({b[1][1]})]
        ];
        p.c = [uint256({c[0]}), uint256({c[1]})];
        p.termsCommitment = {d["termsCommitment"]};
        p.incomeCommitment = {d["incomeCommitment"]};
        p.priorCommitment = {d["priorCommitment"]};
        p.unitsOutstanding = {d["units"]};
        p.fxAvgWad = {d["fxWad"]};
        p.paymentUsd = {d["paymentUsd"]};
        p.incomeYtd = {d["incomeYtd"]};
    }}
""")
header = """// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Genuine Groth16 proofs for the ProofOfIncome circuit (circuits/build, development key), generated
/// with snarkjs from fixed witnesses by `evm/scripts/proofs/run.sh` (do not edit by hand). Terms: theta =
/// 80,000 USDC/yr (80e9), r = 0.1% per unit (1e15 WAD), currency 840 (fxQ1: 978 at fx 1.1), indexing 0,
/// terms salt 11111. Income salts are non-zero except for the `t1*` proofs (pure tier-1 series bind
/// `Poseidon(2)(ytd, 0)`, SPEC §1.5). Public inputs in SPEC §8 order. Regenerate when the circuit or its key
/// changes.
library Proofs {
    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        bytes32 termsCommitment;
        bytes32 incomeCommitment;
        bytes32 priorCommitment;
        uint64 unitsOutstanding;
        uint64 fxAvgWad;
        uint64 paymentUsd;
        uint64 incomeYtd;
    }

"""
open(target, "w").write(header + "\n".join(parts) + "}\n")
print("wrote", target, len(names), "proofs")
