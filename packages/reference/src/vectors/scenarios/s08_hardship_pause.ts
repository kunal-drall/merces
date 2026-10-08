import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s08: Scenario = {
  name: "08_hardship_pause",
  async build() {
    const b = new ScenarioBuilder(
      "08_hardship_pause",
      "An attestor-approved hardship pause (10 April – 10 June 2026) spans the Q1 deadline: Q1's countdown stops for 61 days, the status reads Paused, releases keep flowing, Q1's deadline and grace move by 61 days while Q2's clock (starting 1 July) is untouched, the payment on 10 July carries no accrual; a request is withdrawn (nonce advances), bounds are enforced, and a second pause is ended early by the issuer.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" });

    b.at(ts(2026, 4, 2));
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(130_000), tier: 2, note: "2,000 due by 1 May" });
    b.at(ts(2026, 4, 8));
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "attestor1" }, "PauseNotRequested");
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" }, "no reason is stored on-chain; nonce 1");
    await b.step({ op: "withdraw_pause_request", actor: "issuer", series: "S1" }, "withdrawing advances the nonce (2): a signature over nonce 1 is dead");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "attestor1" }, "PauseNotRequested");
    b.at(ts(2026, 4, 10));
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" }, "nonce 3");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 4, 10).toString(), attestor: "attestor1" }, "InvalidPauseEnd");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2027, 4, 11).toString(), attestor: "attestor1" }, "PauseTooLong", "366 days > max_pause_seconds (365 d)");
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "verifier1" }, "InvalidAttestorSignature", "a report-verifier key is not an attestor");
    await b.step({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 6, 10).toString(), attestor: "attestor1" }, "pause 10 April → 10 June (61 days); pausedTotal = 61 d");
    b.expect("S1", "status Paused; pauseNonce 3; pauseCount 1");
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" });
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 7, 10).toString(), attestor: "attestor2" }, "AlreadyPaused");
    await b.step({ op: "withdraw_pause_request", actor: "issuer", series: "S1" });

    b.at(ts(2026, 4, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 2: a hardship pause never stops treasury releases (C11 §1)");
    b.at(ts(2026, 5, 15));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "15 May, past the nominal deadline: Paused");

    b.at(ts(2026, 6, 11));
    await b.step({ op: "crank_status", series: "S1" }, "pause over");
    b.expect("S1", "Q1 countdown = 71 d − 61 d = 10 d → OnTime");
    b.at(ts(2026, 7, 2));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "Q1 countdown 31 d → InGrace (deadline shifted to 1 July)");
    b.at(ts(2026, 7, 10));
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "countdown 39 d, inside grace → accrual 0");
    const s = b.sim.series.get("S1")!;
    if (s.reports.get(Q(2026, 1))!.accrualPaid !== 0n) throw new Error("accrual");
    b.expect("S1", "paid without accrual; Q2's clock started 1 July (after the pause) and is unshifted: OnTime, deadline 31 July");

    b.at(ts(2026, 7, 12));
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2 });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });

    b.at(ts(2026, 9, 1));
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" });
    await b.step({ op: "approve_pause", series: "S1", pauseEnd: ts(2026, 12, 1).toString(), attestor: "attestor2" }, "91 days approved; pausedTotal 152 d");
    b.at(ts(2026, 9, 20));
    await b.revert({ op: "end_pause", actor: "b1", series: "S1" }, "NotIssuer");
    await b.step({ op: "end_pause", actor: "issuer", series: "S1" }, "ended after 19 days: pausedTotal = 61 + 19 = 80 d");
    await b.revert({ op: "end_pause", actor: "issuer", series: "S1" }, "NotPaused");
    b.expect("S1", "pausedTotal 6,912,000 s; pauseCount 2; OnTime");
    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 3 and 4");
    b.expect("S1");
    return b.build();
  },
};
