import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s04: Scenario = {
  name: "04_zero_quarters",
  async build() {
    const b = new ScenarioBuilder(
      "04_zero_quarters",
      "Year-to-date method: a whole year of income below θ (four zero payments), then a year that crosses θ in Q3 (payments only for the increments); plus proof/attestation reverts (tampered public signal, wrong prior commitment, wrong key type, disabled tier).",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.expect("S1", "400 units at 105 USDC");

    const ytd2026: [number, bigint, [number, number, number]][] = [
      [Q(2026, 1), usdc(20_000), [2026, 4, 2]],
      [Q(2026, 2), usdc(40_000), [2026, 7, 2]],
      [Q(2026, 3), usdc(60_000), [2026, 10, 2]],
      [Q(2026, 4), usdc(78_000), [2027, 1, 3]],
    ];
    for (const [period, ytd, [y, m, d]] of ytd2026) {
      b.at(ts(y, m, d));
      const r = await b.report({ series: "S1", period, incomeYtd: ytd, tier: 2 });
      if (r.paymentUsd !== 0n) throw new Error("expected zero payment");
    }
    b.expect("S1", "four zero reports: lastPaidPeriod 8107, nothing ever owed, vault 0, status OnTime");

    b.at(ts(2027, 4, 2));
    await b.report({ series: "S1", period: Q(2027, 1), incomeYtd: usdc(25_000), tier: 2, note: "new year, prior = ZERO commitment" });
    b.at(ts(2027, 7, 2));
    await b.report({ series: "S1", period: Q(2027, 2), incomeYtd: usdc(70_000), tier: 2 });
    b.at(ts(2027, 10, 2));
    await b.reportRevert({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, tamperPaymentUsd: 0n }, "InvalidProof", "honest proof for 800, claimed payment 0 → the public signal does not verify");
    await b.reportRevert({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, priorOverride: 12345n }, "InvalidProof", "prior commitment must chain to Q2's income commitment");
    await b.reportRevert({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, attestation: "attestor1" }, "InvalidVerifierSignature", "tier 2 needs a report-verifier key, not an attestor");
    await b.reportRevert({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 3 }, "TierNotEnabled", "series enables tier 2 only");
    await b.reportRevert({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, actor: "b1" }, "NotIssuer");
    const q3 = await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, note: "YTD crosses θ: owed 4% × 20,000 = 800" });
    if (q3.paymentUsd !== usdc(800)) throw new Error("q3");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", "first real payment in Q3 2027: 800 gross, 40 fee, 760 net");
    b.at(ts(2028, 1, 3));
    const q4 = await b.report({ series: "S1", period: Q(2027, 4), incomeYtd: usdc(140_000), tier: 2, note: "owed YTD 2,400 → payment 1,600" });
    if (q4.paymentUsd !== usdc(1_600)) throw new Error("q4");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "2027 total 2,400 = 4% × (140,000 − 80,000); each holder received 570 USDC net");
    return b.build();
  },
};
