import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s01: Scenario = {
  name: "01_happy_path",
  async build() {
    const b = new ScenarioBuilder(
      "01_happy_path",
      "Raise of 400 units at 105 USDC, scheduled treasury releases, five quarterly reports (zero, three paid, year reset), holder claims; checks the YTD method, fees and accumulators end to end.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, note: "1,000 units offered at reserve 100 USDC, min raise 20,000 USDC, defaults otherwise, 4 × 25% quarterly releases" });
    b.expect("S1", "series created in Draft");

    const p = await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    if (p !== usdc(105)) throw new Error("unexpected clearing price");
    b.expect("S1", "settled: 400 units at 105 USDC; proceeds 42,000; 1% fee 420; excess escrow refunded; each bidder holds 100 units");
    const s = b.sim.series.get("S1")!;

    // lockup and direct transfers
    await b.revert({ op: "transfer_units", actor: "b1", series: "S1", to: "b2", units: "1" }, "DirectTransferForbidden");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "LockupActive");

    // first tranche vests at settlement
    b.advance(86_400n);
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 1: 25% of 42,000");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "NothingToRelease");
    b.expect("S1", "issuer received 10,500 USDC");

    // Q1 2026: income below θ → zero payment, still a complete report
    b.at(ts(2026, 3, 31, 12));
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(35_000), tier: 2 }, "ReportTooEarly");
    b.at(ts(2026, 4, 2));
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(35_000), tier: 2, note: "YTD 35,000 < θ → payment 0; paid on acceptance" });
    await b.revert({ op: "pay", actor: "issuer", series: "S1" }, "NothingDue");
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(35_000), tier: 2 }, "WrongPeriod");
    b.expect("S1", "zero report accepted: lastPaidPeriod = 8104, nothing owed, status OnTime");

    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 2 vested 90 days after settlement");

    // Q2 2026: YTD 95,000 → owed_YTD = 4% × 15,000 = 600
    b.at(ts(2026, 7, 5));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(95_000), tier: 2, note: "r × units = 1e14 × 400 = 4%; owed YTD 600, payment 600" });
    if (q2.paymentUsd !== usdc(600)) throw new Error("q2 payment");
    b.expect("S1", "report accepted, 600 USDC due");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", "paid: fee 30 → collector, 570 net → vault; paidPerUnitWad = 1.5 USDC/unit");
    await b.revert({ op: "claim", actor: "keeper", series: "S1" }, "HolderNotRegistered");
    await b.step({ op: "claim", actor: "b1", series: "S1" }, "b1 holds 100 of 400 units → 142.5 USDC");
    b.expect("S1");

    b.at(ts(2026, 7, 14));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 3 (180 days)");

    // Q3 2026: YTD 150,000 → owed 2,800, payment 2,200
    b.at(ts(2026, 10, 3));
    const q3 = await b.report({ series: "S1", period: Q(2026, 3), incomeYtd: usdc(150_000), tier: 2 });
    if (q3.paymentUsd !== usdc(2_200)) throw new Error("q3 payment");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    await b.step({ op: "claim", actor: "b2", series: "S1" }, "b2 claims two quarters: 142.5 + 522.5");
    b.expect("S1");

    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 4 (270 days): treasury fully released");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "NothingToRelease");

    // Q4 2026: YTD 210,000 → owed 5,200, payment 2,400
    b.at(ts(2027, 1, 4));
    const q4 = await b.report({ series: "S1", period: Q(2026, 4), incomeYtd: usdc(210_000), tier: 2 });
    if (q4.paymentUsd !== usdc(2_400)) throw new Error("q4 payment");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "year 2026 complete: gross 5,200 = 4% × (210,000 − 80,000); 5% fees; every holder claimed 1,235 USDC net; vault empty");

    // Q1 2027: new reporting year → prior commitment is ZERO_INCOME_COMMITMENT again
    b.at(ts(2027, 4, 2));
    const q5 = await b.report({ series: "S1", period: Q(2027, 1), incomeYtd: usdc(60_000), tier: 2, note: "new year: prior = ZERO_INCOME_COMMITMENT; below θ → 0" });
    if (q5.paymentUsd !== 0n) throw new Error("q5 payment");
    b.expect("S1", "2027 Q1 zero report; status OnTime; releasedTotal == proceeds");
    void s;
    return b.build();
  },
};
