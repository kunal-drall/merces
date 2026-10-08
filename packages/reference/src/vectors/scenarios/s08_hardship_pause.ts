import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s08: Scenario = {
  name: "08_hardship_pause",
  async build() {
    const b = new ScenarioBuilder(
      "08_hardship_pause",
      "An attestor-approved hardship pause (10 April – 10 June 2026) spans the Q1 deadline: the clock stops for 61 days, the status reads Paused, releases keep flowing, the deadline and grace move by 61 days and the payment on 10 July carries no accrual; a second pause is ended early by the issuer.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" });

    b.at(ts(2026, 4, 2));
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(130_000), tier: 2, note: "2,000 due by 1 May" });
    b.at(ts(2026, 4, 10));
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "attestor1" }, "PauseNotRequested");
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" }, "no reason is stored on-chain");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 4, 10).toString(), attestor: "attestor1" }, "InvalidPauseEnd");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "verifier1" }, "InvalidAttestorSignature", "a report-verifier key is not an attestor");
    await b.step({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "attestor1" }, "pause 10 April → 10 June (61 days)");
    b.expect("S1", "status Paused; pauseNonce 1");
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" });
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 7, 10).toString(), attestor: "attestor2" }, "AlreadyPaused");

    b.at(ts(2026, 4, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 2: a hardship pause never stops treasury releases (C11 §1)");
    b.at(ts(2026, 5, 15));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "15 May, past the nominal deadline: Paused, pausedTotal so far 35 days");

    b.at(ts(2026, 6, 11));
    await b.step({ op: "crank_status", series: "S1" }, "pause ended: paused_total = 61 days = 5,270,400 s");
    b.expect("S1", "effective time 11 June − 61 d = 11 April → OnTime");
    b.at(ts(2026, 7, 2));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "effective 2 May → InGrace (deadline shifted to 1 July)");
    b.at(ts(2026, 7, 10));
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "effective 10 May, inside grace → accrual 0");
    const s = b.sim.series.get("S1")!;
    if (s.reports.get(Q(2026, 1))!.accrualPaid !== 0n) throw new Error("accrual");
    b.expect("S1", "paid without accrual; Q2 (due 31 July nominal, 30 September effective) still OnTime");

    b.at(ts(2026, 7, 12));
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2 });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });

    // second pause, ended early by the issuer
    b.at(ts(2026, 9, 1));
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" }, "the earlier stale request was consumed by the first approval; a new one is needed");
    await b.step({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 12, 1).toString(), attestor: "attestor2" });
    b.at(ts(2026, 9, 20));
    await b.revert({ op: "end_pause", actor: "b1", series: "S1" }, "NotIssuer");
    await b.step({ op: "end_pause", actor: "issuer", series: "S1" }, "ended after 19 days: paused_total = 80 days");
    await b.revert({ op: "end_pause", actor: "issuer", series: "S1" }, "NotPaused");
    b.expect("S1", "pausedTotal 6,912,000 s; pauseNonce 2; OnTime");
    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 3 and 4");
    b.expect("S1");
    return b.build();
  },
};
