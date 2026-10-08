import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { WAD } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s12: Scenario = {
  name: "12_multi_series_router",
  async build() {
    const b = new ScenarioBuilder(
      "12_multi_series_router",
      "One issuer, three live series: S1 (tier 2), S2 (tier 1 split router + tier 2 proofs: routed amounts are credited against each quarter's attested payment — shortfall paid, excess carried, year reset) and S3 (pure tier 1: reports bind to the router's period checkpoints through Poseidon(2)(ytd_at_end, 0) with no attestation). Issuance stop/resume gates new series only.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { backerFunds: usdc(80_000) });
    b.actor("client");
    await b.fund("client", usdc(1_000_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.revert(
      { op: "create_series", actor: "issuer", series: "Sx", terms: b.terms(), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("x"), contractHash: b.salt("c"), tierFlags: 1, fxPairId: null },
      "RouterNotEnabled",
      "tier-1 flag without router terms",
    );
    await b.revert(
      { op: "create_series", actor: "issuer", series: "Sx", terms: b.terms(), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("x"), contractHash: b.salt("c"), tierFlags: 1, fxPairId: null, router: { theta: usdc(80_000).toString(), rWad: (WAD / 100n).toString() } },
      "InvalidTerms",
      "r_wad × units_offered = 10 WAD > WAD",
    );
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN, tierFlags: 3, router: true, note: "tier flags 1|2: on-chain split router (plaintext θ and r, the issuer's choice) plus attested quarterly proofs" });
    await b.createSeries({ series: "S3", issuer: "issuer", plain: STD_PLAIN, tierFlags: 1, router: true, note: "pure tier 1: reports are bound to the router checkpoints and need no attestation" });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S3", issuer: "issuer", openAt: ts(2026, 1, 25), bids: FOUR_BACKER_BIDS });
    b.expect("S2", "three series settled: 400 units each at 105; r × units = 4% on each");

    b.at(ts(2026, 2, 5));
    await b.step({ op: "stop_issuance", actor: "issuer" });
    await b.revert(
      { op: "create_series", actor: "issuer", series: "S4", terms: b.terms(), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("S4:terms"), contractHash: b.salt("S4:contract"), tierFlags: 2, fxPairId: null },
      "IssuanceStopped",
    );
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "existing series are unaffected by the issuance stop");
    await b.step({ op: "resume_issuance", actor: "issuer" });

    // S2: Q1 2026 — 30k + 60k routed; 10k above θ → 400 to the vault
    b.at(ts(2026, 2, 10));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(30_000).toString() }, "below θ: 100% to the issuer");
    await b.step({ op: "route_income", series: "S3", payer: "client", amount: usdc(90_000).toString() }, "S3: 80,000 passes, 10,000 above θ → 400 routed (4%)");
    await b.revert({ op: "route_income", series: "S1", payer: "client", amount: usdc(1_000).toString() }, "RouterNotEnabled");
    b.at(ts(2026, 3, 10));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(60_000).toString() }, "50,000 below θ passes; 4% of 10,000 = 400 to the vault (fee 20); routerCredit 400");
    b.expect("S2", "routerCredit 400; vault 380; ytd 90,000");
    b.at(ts(2026, 4, 2));
    await b.reportRevert({ series: "S2", period: Q(2026, 1), incomeYtd: usdc(90_000), tier: 1, attestation: null }, "TierNotEnabled", "a series with tier 2 enabled must report with the attested tier");
    const q1 = await b.report({ series: "S2", period: Q(2026, 1), incomeYtd: usdc(90_000), tier: 2, note: "payment 400 fully covered by router credit → due 0" });
    if (q1.paymentUsd !== usdc(400) || q1.due !== 0n) throw new Error("q1");
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(40_000), tier: 2 });
    await b.reportRevert({ series: "S3", period: Q(2026, 1), incomeYtd: 0n, tier: 1, attestation: null }, "RouterPeriodNotClosed", "no receipt arrived in Q2 yet, so Q1's checkpoint is missing");
    await b.step({ op: "close_router_period", series: "S3", period: Q(2026, 1).toString() }, "keeper closes Q1: ytd_at_end = 90,000");
    const s3q1 = await b.report({ series: "S3", period: Q(2026, 1), incomeYtd: 0n, tier: 1, attestation: null, note: "tier-1 report: income_commitment = Poseidon(2)(90,000e6, 0); payment 400 covered by router credit" });
    if (s3q1.paymentUsd !== usdc(400) || s3q1.due !== 0n) throw new Error("s3 q1");
    b.expect("S2", "Q1 reconciled: routerCredit 0, lastPaidPeriod 8104");
    b.expect("S3");

    b.at(ts(2026, 5, 12));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(40_000).toString() }, "all above θ: 1,600 routed");
    await b.step({ op: "route_income", series: "S3", payer: "client", amount: usdc(50_000).toString() }, "the Q2 receipt closes S3's Q1 checkpoint implicitly (already closed) and routes 2,000");
    b.at(ts(2026, 7, 2));
    const q2 = await b.report({ series: "S2", period: Q(2026, 2), incomeYtd: usdc(140_000), tier: 2, note: "owed YTD 2,400, payment 2,000; credit 1,600 → shortfall 400 due" });
    if (q2.due !== usdc(400)) throw new Error("q2 due");
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(90_000), tier: 2 });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    await b.step({ op: "close_router_period", series: "S3", period: Q(2026, 2).toString() });
    const s3q2 = await b.report({ series: "S3", period: Q(2026, 2), incomeYtd: 0n, tier: 1, attestation: null, note: "ytd_at_end 140,000 → payment 2,000, fully routed already → due 0" });
    if (s3q2.due !== 0n) throw new Error("s3 q2");
    b.expect("S2");
    b.expect("S3", "S3 routerCredit 0 after reconciling 2,400 of routed income");

    b.at(ts(2026, 8, 12));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(50_000).toString() });
    b.at(ts(2026, 10, 2));
    const q3 = await b.report({ series: "S2", period: Q(2026, 3), incomeYtd: usdc(180_000), tier: 2, note: "payment 1,600 < credit 2,000 → due 0, credit 400 carried" });
    if (q3.due !== 0n) throw new Error("q3 due");
    await b.step({ op: "close_router_period", series: "S3", period: Q(2026, 3).toString() }, "no receipts in Q3: checkpoint holds the year total so far (140,000)");
    await b.report({ series: "S3", period: Q(2026, 3), incomeYtd: 0n, tier: 1, attestation: null, note: "payment 0" });
    b.expect("S2", "routerCredit 400 carried forward");

    b.at(ts(2027, 1, 3));
    const q4 = await b.report({ series: "S2", period: Q(2026, 4), incomeYtd: usdc(200_000), tier: 2 });
    if (q4.due !== usdc(400)) throw new Error("q4 due");
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S2" });
    b.expect("S2", "2026 gross on S2 = 4% × 120,000 = 4,800 (router 4,000 + issuer 800); holders got 95%");

    b.at(ts(2027, 1, 15));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(20_000).toString() }, "2027: below θ again → 100% pass-through; the receipt closes 2026 Q4 for S2's router");
    await b.step({ op: "route_income", series: "S3", payer: "client", amount: usdc(20_000).toString() }, "closes S3's Q4 2026 checkpoint (140,000) and resets the year");
    await b.report({ series: "S3", period: Q(2026, 4), incomeYtd: 0n, tier: 1, attestation: null, note: "Q4 2026 bound to the closed checkpoint; prior = Poseidon(2)(140,000e6, 0)" });
    b.expect("S3", "S3 2026 complete: 2,400 routed and reconciled, nothing paid by the issuer directly");
    b.expect("S1", "S1 untouched by the routers");
    return b.build();
  },
};
