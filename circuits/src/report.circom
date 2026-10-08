pragma circom 2.2.3;

// Merces ProofOfIncome reference circuit (SPEC.md §8).
//
// Proves that `payment_usd` follows from the year-to-date payment formula of the brief (C3)
//
//     owed_YTD(x)    = floor(r_wad × units_outstanding × max(0, x − theta) / WAD)
//     payment        = owed_YTD(income_ytd) − owed_YTD(prior_income_ytd)
//     payment_usd    = floor(payment × fx_avg_wad / WAD)
//
// without revealing income, theta or r. Public inputs, in this order (also the order of the
// snarkjs public signals and of the on-chain verifier inputs):
//
//     [terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]
//
// Poseidon is circomlib's BN254 instance (the same parameters poseidon-lite and circomlibjs use).
//
// Income scale (SPEC §1.5): `theta` and `income_ytd` are amounts in the income currency expressed
// with the stablecoin's decimals (6 for USDC/USDG); `fx_avg_wad` is the unit-less WAD ratio
// "stablecoin units per income-currency unit" (1e18 for stablecoin income), so `payment_usd` comes
// out directly in stablecoin base units and must fit u64.

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

// quotient = floor(num / WAD), with the quotient and remainder supplied as witnesses and
// constrained exactly: num === quotient × WAD + remainder, remainder < WAD, quotient < 2^qBits.
// Sound for num < 2^(qBits + 60) because no term can wrap the field.
template FloorDivWad(qBits) {
    signal input num;
    signal output quotient;
    signal remainder;

    var WAD = 1000000000000000000;

    quotient <-- num \ WAD;
    remainder <-- num % WAD;
    num === quotient * WAD + remainder;

    component quotientBits = Num2Bits(qBits);
    quotientBits.in <== quotient;

    // remainder < WAD: WAD < 2^60, so bound the remainder to 60 bits first (LessThan needs
    // both operands below 2^n) and then compare.
    component remainderBits = Num2Bits(60);
    remainderBits.in <== remainder;
    component remainderLt = LessThan(60);
    remainderLt.in[0] <== remainder;
    remainderLt.in[1] <== WAD;
    remainderLt.out === 1;
}

// out = x > theta ? x − theta : 0. Both operands must already be range-checked to 64 bits.
template Excess() {
    signal input x;
    signal input theta;
    signal output out;

    component gt = GreaterThan(64);
    gt.in[0] <== x;
    gt.in[1] <== theta;
    out <== gt.out * (x - theta);
}

template Report() {
    // ---- public inputs (declaration order = public signal order) ----
    signal input terms_commitment;
    signal input units_outstanding;
    signal input fx_avg_wad;
    signal input prior_income_commitment;
    signal input income_commitment;
    signal input payment_usd;

    // ---- private inputs ----
    signal input theta;
    signal input r_wad;
    signal input currency_code;
    signal input indexing_rule;
    signal input terms_salt;
    signal input income_ytd;
    signal input income_salt;
    signal input prior_income_ytd;
    signal input prior_salt;

    // 1. terms_commitment === Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)
    component termsHash = Poseidon(5);
    termsHash.inputs[0] <== theta;
    termsHash.inputs[1] <== r_wad;
    termsHash.inputs[2] <== currency_code;
    termsHash.inputs[3] <== indexing_rule;
    termsHash.inputs[4] <== terms_salt;
    termsHash.out === terms_commitment;

    // 2. income_commitment === Poseidon(2)(income_ytd, income_salt)
    //    prior_income_commitment === Poseidon(2)(prior_income_ytd, prior_salt)
    component incomeHash = Poseidon(2);
    incomeHash.inputs[0] <== income_ytd;
    incomeHash.inputs[1] <== income_salt;
    incomeHash.out === income_commitment;

    component priorHash = Poseidon(2);
    priorHash.inputs[0] <== prior_income_ytd;
    priorHash.inputs[1] <== prior_salt;
    priorHash.out === prior_income_commitment;

    // 3. range checks: income_ytd, prior_income_ytd, theta, r_wad, units_outstanding, fx_avg_wad, payment_usd < 2^64
    component incomeBits = Num2Bits(64);
    incomeBits.in <== income_ytd;
    component priorBits = Num2Bits(64);
    priorBits.in <== prior_income_ytd;
    component thetaBits = Num2Bits(64);
    thetaBits.in <== theta;
    component rateBits = Num2Bits(64);
    rateBits.in <== r_wad;
    component unitsBits = Num2Bits(64);
    unitsBits.in <== units_outstanding;
    component fxBits = Num2Bits(64);
    fxBits.in <== fx_avg_wad;
    component paymentUsdBits = Num2Bits(64);
    paymentUsdBits.in <== payment_usd;

    //    income_ytd ≥ prior_income_ytd  (year-to-date income is monotone within a year)
    component incomeMonotone = LessThan(64);
    incomeMonotone.in[0] <== income_ytd;
    incomeMonotone.in[1] <== prior_income_ytd;
    incomeMonotone.out === 0;

    // 4. owed(x) = floor(r_wad × units_outstanding × excess(x) / WAD)
    //    r_wad × units_outstanding < 2^128; × excess < 2^192: no field wrap.
    component excessNow = Excess();
    excessNow.x <== income_ytd;
    excessNow.theta <== theta;

    component excessPrior = Excess();
    excessPrior.x <== prior_income_ytd;
    excessPrior.theta <== theta;

    signal rateUnits <== r_wad * units_outstanding;
    signal owedNowNum <== rateUnits * excessNow.out;
    signal owedPriorNum <== rateUnits * excessPrior.out;

    component owedNow = FloorDivWad(128);
    owedNow.num <== owedNowNum;
    component owedPrior = FloorDivWad(128);
    owedPrior.num <== owedPriorNum;

    // 5. payment = owed(income_ytd) − owed(prior_income_ytd), enforced non-negative
    component owedMonotone = LessThan(128);
    owedMonotone.in[0] <== owedNow.quotient;
    owedMonotone.in[1] <== owedPrior.quotient;
    owedMonotone.out === 0;

    signal payment <== owedNow.quotient - owedPrior.quotient;

    // 6. payment_usd === floor(payment × fx_avg_wad / WAD); payment < 2^128, fx < 2^64: no wrap
    signal paymentUsdNum <== payment * fx_avg_wad;
    component paymentUsd = FloorDivWad(128);
    paymentUsd.num <== paymentUsdNum;
    paymentUsd.quotient === payment_usd;
}

component main { public [terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd] } = Report();
