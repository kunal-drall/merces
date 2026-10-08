import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s07: Scenario = {
  name: "07_late_payment",
  async build() {
    const b = new ScenarioBuilder(
      "07_late_payment",
      "Q1 2026 report accepted but unpaid: OnTime until the 30-day deadline (1 May), InGrace for 15 days, Late from 17 May with treasury releases blocked, FormalNoticeDue at 90 days (30 July); paid on 1 August with 77 days of 8% simple-interest accrual; the next report restores OnTime and releases resume.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 1");

    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(130_000), tier: 2, note: "owed 4% × 50,000 = 2,000, left unpaid" });
    if (q1.paymentUsd !== usdc(2_000)) throw new Error("q1");
    b.expect("S1", "2,000 due; status OnTime (deadline 1 May 2026)");
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 2: releases are not blocked while OnTime");

    b.at(ts(2026, 5, 1));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "deadline day: still OnTime (e ≤ deadline)");
    b.at(ts(2026, 5, 1, 0, 0, 1));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "one second past the deadline: InGrace");
    b.at(ts(2026, 5, 16));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "grace end (16 May 00:00): still InGrace");
    b.at(ts(2026, 5, 16, 0, 0, 1));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "Late");

    b.at(ts(2026, 7, 2));
    await b.reportRevert({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2 }, "PaymentOutstanding", "Q2 cannot be reported while Q1 is unpaid");
    b.at(ts(2026, 7, 14));
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesLate", "tranche 3 vested on 13 July but releases pause while Late");
    b.at(ts(2026, 7, 30));
    await b.step({ op: "crank_status", series: "S1" }, "deadline + 90 days → FormalNoticeDue(8104)");
    b.expect("S1", "formalNoticeEmittedFor = 8104; nothing slashed");

    b.at(ts(2026, 8, 1));
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "77 late days since 16 May: accrual = floor(2,000e6 × 0.08e18 × 77 / (365 × 1e18)) = 33,753,424; gross 2,033.753424");
    const s = b.sim.series.get("S1")!;
    if (s.reports.get(Q(2026, 1))!.accrualPaid !== 33_753_424n) throw new Error(`accrual ${s.reports.get(Q(2026, 1))!.accrualPaid}`);
    b.expect("S1", "Q1 paid with accrual (counts toward the cap); Q2 report was due 31 July → InGrace");
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "InGrace does not block releases: tranche 3 released");
    b.at(ts(2026, 8, 2));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2, note: "owed 4% × 80,000 = 3,200 → payment 1,200" });
    if (q2.paymentUsd !== usdc(1_200)) throw new Error("q2");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "InGrace for Q2: no accrual");
    b.expect("S1", "current again: OnTime, both periods paid; accrual 0 on Q2");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "holders split 95% of 3,233.753424 (the accrual is distributed like any gross payment)");
    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 4");
    b.expect("S1", "releasedTotal == proceeds");
    return b.build();
  },
};
