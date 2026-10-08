import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s19: Scenario = {
  name: "19_pause_while_late",
  async build() {
    const b = new ScenarioBuilder(
      "19_pause_while_late",
      "A hardship pause approved while the series is already Late: the status reads Paused but is_late_underlying keeps treasury releases blocked until the overdue payment is made; the Q1 countdown stops during the pause (4 late days → 4 days of accrual when paid on 1 June), releases resume right after payment, and Q2's clock (starting 1 July, after the pause) is unshifted: InGrace one second after 31 July.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 1");
    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(130_000), tier: 2, note: "2,000 due by 1 May, grace to 16 May" });
    if (q1.paymentUsd !== usdc(2_000)) throw new Error("q1");
    b.at(ts(2026, 5, 17));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "Late since 16 May 00:00:01; tranche 2 (vested 8 April) was never claimed");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesLate");

    b.at(ts(2026, 5, 20));
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" });
    await b.step({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 20).toString(), attestor: "attestor1" }, "pause 20 May → 20 June approved while Late (4 late days so far)");
    b.expect("S1", "status Paused (derived), pauseCount 1, pausedTotal 31 d; 2,000 still due");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesLate", "Paused does not lift the release block: is_late_underlying ignores the pause");
    b.at(ts(2026, 5, 28));
    await b.step({ op: "crank_status", series: "S1" });
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesLate", "still blocked eight days into the pause");

    b.at(ts(2026, 6, 1));
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "countdown(Q1) = 61 d − 12 d paused = 49 d; late days = 49 − 45 = 4 → accrual = mulDiv(mulDiv(2,000e6, 0.08e18, 1e18), 4, 365) = 1,753,424");
    const s = b.sim.series.get("S1")!;
    if (s.reports.get(Q(2026, 1))!.accrualPaid !== 1_753_424n) throw new Error(`accrual ${s.reports.get(Q(2026, 1))!.accrualPaid}`);
    b.expect("S1", "Q1 paid with 4 days of accrual; still Paused until 20 June; is_late_underlying false");
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "releases resume as soon as the arrears are paid, pause or not: tranche 2");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "NothingVested");

    b.at(ts(2026, 6, 21));
    await b.step({ op: "crank_status", series: "S1" }, "pause over");
    b.expect("S1", "OnTime: Q2's countdown has not started (period ends 1 July)");
    b.at(ts(2026, 7, 31));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "31 July: Q2 countdown 30 d → OnTime (the pause ended before Q2's clock started, so nothing shifts)");
    b.at(ts(2026, 7, 31, 0, 0, 1));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "one second later: InGrace — the Q2 deadline is the unshifted 31 July");
    b.at(ts(2026, 8, 2));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2, note: "owed 3,200 → payment 1,200" });
    if (q2.paymentUsd !== usdc(1_200)) throw new Error("q2");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "InGrace: no accrual");
    if (s.reports.get(Q(2026, 2))!.accrualPaid !== 0n) throw new Error("q2 accrual");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "OnTime; holders split 95% of 3,201.753424");
    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 3 and 4");
    b.expect("S1", "releasedTotal == proceeds; pausedTotal unchanged (31 d)");
    return b.build();
  },
};
