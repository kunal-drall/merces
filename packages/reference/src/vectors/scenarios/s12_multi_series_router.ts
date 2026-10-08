import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s12: Scenario = {
  name: "12_multi_series_router",
  async build() {
    const b = new ScenarioBuilder(
      "12_multi_series_router",
      "One issuer, two live series: S1 (tier 2) and S2 (tier 1 split router + quarterly proofs). On-chain receipts pass through 100% until θ, then route r × units to the vault; routed amounts are credited against each quarter's proven payment (shortfall paid, excess carried forward, year reset). Issuance stop/resume gates new series only.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { backerFunds: usdc(60_000) });
    b.actor("client");
    await b.fund("client", usdc(1_000_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.revert(
      { op: "create_series", actor: "issuer", series: "Sx", terms: b.terms(), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("x"), contractHash: b.salt("c"), tierFlags: 1, fxPairId: null },
      "RouterNotEnabled",
      "tier-1 flag without router terms",
    );
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN, tierFlags: 3, router: true, note: "tier flags 1|2: on-chain split router (plaintext θ and r, the issuer's choice) plus quarterly proofs" });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    b.expect("S2", "both series settled: 400 units each at 105; r × units = 4% on each");

    // issuance stop / resume
    b.at(ts(2026, 1, 26));
    await b.step({ op: "stop_issuance", actor: "issuer" });
    await b.revert(
      { op: "create_series", actor: "issuer", series: "S3", terms: b.terms(), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("S3:terms"), contractHash: b.salt("S3:contract"), tierFlags: 2, fxPairId: null },
      "IssuanceStopped",
    );
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "existing series are unaffected by the issuance stop");
    await b.step({ op: "resume_issuance", actor: "issuer" });

    // Q1 2026: 30k + 60k routed; 10k above θ → 400 to the vault
    b.at(ts(2026, 2, 10));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(30_000).toString() }, "below θ: 100% to the issuer");
    await b.revert({ op: "route_income", series: "S1", payer: "client", amount: usdc(1_000).toString() }, "RouterNotEnabled");
    b.at(ts(2026, 3, 10));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(60_000).toString() }, "50,000 below θ passes; 4% of 10,000 = 400 to the vault (fee 20); routerCredit 400");
    b.expect("S2", "routerCredit 400; vault 380; ytd 90,000");
    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S2", period: Q(2026, 1), incomeYtd: usdc(90_000), tier: 2, note: "payment 400 fully covered by router credit → due 0" });
    if (q1.paymentUsd !== usdc(400) || q1.due !== 0n) throw new Error("q1");
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(40_000), tier: 2 });
    b.expect("S2", "Q1 reconciled: routerCredit 0, lastPaidPeriod 8104");

    // Q2: 40k routed on-chain (1,600 share) but 10k more income off-chain → due 400
    b.at(ts(2026, 5, 12));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(40_000).toString() }, "all above θ: 1,600 routed");
    b.at(ts(2026, 7, 2));
    const q2 = await b.report({ series: "S2", period: Q(2026, 2), incomeYtd: usdc(140_000), tier: 2, note: "owed YTD 2,400, payment 2,000; credit 1,600 → shortfall 400 due" });
    if (q2.due !== usdc(400)) throw new Error("q2 due");
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(90_000), tier: 2 });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S2");

    // Q3: 50k routed (2,000 share) while the report shows only 40k more income → excess 400 carried forward
    b.at(ts(2026, 8, 12));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(50_000).toString() });
    b.at(ts(2026, 10, 2));
    const q3 = await b.report({ series: "S2", period: Q(2026, 3), incomeYtd: usdc(180_000), tier: 2, note: "payment 1,600 < credit 2,000 → due 0, credit 400 carried" });
    if (q3.due !== 0n) throw new Error("q3 due");
    b.expect("S2", "routerCredit 400 carried forward");

    // Q4: nothing routed; payment 800 → credit 400 used, 400 due
    b.at(ts(2027, 1, 3));
    const q4 = await b.report({ series: "S2", period: Q(2026, 4), incomeYtd: usdc(200_000), tier: 2 });
    if (q4.due !== usdc(400)) throw new Error("q4 due");
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S2" });
    b.expect("S2", "2026 gross on S2 = 4% × 120,000 = 4,800 (router 4,000 + issuer 800); holders got 95%");

    // new year: the router's YTD resets
    b.at(ts(2027, 1, 15));
    await b.step({ op: "route_income", series: "S2", payer: "client", amount: usdc(20_000).toString() }, "2027: below θ again → 100% pass-through");
    b.expect("S2", "routerCredit still 0; issuer received the full 20,000");
    b.expect("S1", "S1 untouched by S2's router");
    return b.build();
  },
};
