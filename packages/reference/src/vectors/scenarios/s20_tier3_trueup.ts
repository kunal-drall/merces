import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s20: Scenario = {
  name: "20_tier3_trueup",
  async build() {
    const b = new ScenarioBuilder(
      "20_tier3_trueup",
      "Tier-3 (attestor) series with annual true-ups. S1: four quarterly estimates paid for 2026, a +400 true-up recorded with trueup_nonce 0 (a replay of the same signature and a signature over the wrong nonce fail InvalidAttestorSignature; a second true-up while one is unpaid is TrueUpOutstanding), paid inside the 60-day window without accrual; for 2027 a +1,000 true-up is left unpaid past the deadline → Late (releases blocked, redeem rejected), then paid with 10 days of accrual and the series recovers. S2: a −800 adjustment bounded by the year's accepted payments (−7,000 is TrueUpAdjustmentTooLarge) becomes router credit consumed by the next report.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, tierFlags: 4, note: "tier flags 4: attestor-signed quarterly estimates with annual true-ups" });
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN, tierFlags: 4 });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 1, 25));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "S1 tranche 1; tranches 3 and 4 are deliberately left unclaimed until 2028");

    const y2026: [number, bigint, [number, number, number]][] = [
      [Q(2026, 1), usdc(100_000), [2026, 4, 2]],
      [Q(2026, 2), usdc(150_000), [2026, 7, 2]],
      [Q(2026, 3), usdc(200_000), [2026, 10, 2]],
      [Q(2026, 4), usdc(250_000), [2027, 1, 3]],
    ];
    for (const [period, ytd, [y, m, d]] of y2026) {
      b.at(ts(y, m, d));
      if (period === Q(2026, 1)) await b.reportRevert({ series: "S1", period, incomeYtd: ytd, tier: 2 }, "TierNotEnabled", "tier 2 is not enabled on a pure tier-3 series");
      for (const id of ["S1", "S2"]) {
        const r = await b.report({ series: id, period, incomeYtd: ytd, tier: 3 });
        if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: id });
      }
      if (period === Q(2026, 1)) {
        b.at(ts(2026, 4, 15));
        await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "S1 tranche 2");
      }
      if (period === Q(2026, 3)) {
        b.at(ts(2026, 10, 12));
        await b.step({ op: "claim_release", actor: "issuer", series: "S2" }, "S2: all four tranches");
      }
    }
    b.expect("S1", "2026 estimates: 800 + 2,000 + 2,000 + 2,000 = 6,800 accepted on each series; trueupNonce 0");

    // S2: negative true-up for 2026 → router credit
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S2", year: "2026", adjustment: usdc(-7_000).toString(), attestationTs: b.t.toString(), attestor: "attestor1", nonce: "0" }, "TrueUpAdjustmentTooLarge", "|−7,000| > 6,800 accepted for 2026");
    await b.step({ op: "submit_trueup", actor: "issuer", series: "S2", year: "2026", adjustment: usdc(-800).toString(), attestationTs: b.t.toString(), attestor: "attestor1", nonce: "0" }, "audited 2026 income 230,000 → owed 6,000, estimates paid 6,800 → −800 credited forward (no refund)");
    b.expect("S2", "routerCredit 800; trueupNonce 1; lastTrueupYear 2026; nothing due");

    // S1: positive true-up for 2026
    b.at(ts(2027, 2, 1));
    const att1 = b.t;
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2027", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "0" }, "TrueUpYearInvalid", "2027 is not complete");
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "verifier1", nonce: "0" }, "InvalidAttestorSignature", "a report-verifier key is not an attestor");
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "1" }, "InvalidAttestorSignature", "signed over nonce 1 while the series' trueup_nonce is 0");
    await b.revert({ op: "submit_trueup", actor: "b1", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "0" }, "NotIssuer");
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S2", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "1" }, "TrueUpYearInvalid", "S2 already trued up 2026");
    await b.step({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "0" }, "audited 2026 income 260,000 → owed 7,200 vs 6,800 paid → +400 due within 60 unpaused days of 1 February 2027");
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor1", nonce: "0" }, "InvalidAttestorSignature", "replay of the same signature: the stored nonce is now 1");
    await b.revert({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2026", adjustment: usdc(400).toString(), attestationTs: att1.toString(), attestor: "attestor2", nonce: "1" }, "TrueUpOutstanding", "the previous true-up must be paid first");
    b.expect("S1", "trueupDue 400; trueupAttestedAt 1 Feb 2027; trueupNonce 1; status OnTime");
    b.at(ts(2027, 3, 15));
    await b.step({ op: "pay_trueup", actor: "issuer", series: "S1" }, "42 unpaused days < 60 → no accrual; vault_receive_gross(400, Payment, period_of(attested_at))");
    await b.revert({ op: "pay_trueup", actor: "issuer", series: "S1" }, "NothingDue");
    b.expect("S1", "true-up paid: fee 20, 380 to the vault; lastTrueupYear 2026; trueupDue 0");

    // 2027: S2 consumes its credit; S1 pays four more estimates
    b.at(ts(2027, 4, 2));
    const s2q1 = await b.report({ series: "S2", period: Q(2027, 1), incomeYtd: usdc(120_000), tier: 3, note: "payment 1,600; router credit 800 consumed → due 800" });
    if (s2q1.paymentUsd !== usdc(1_600) || s2q1.due !== usdc(800)) throw new Error(`s2 q1 ${s2q1.paymentUsd} ${s2q1.due}`);
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    b.expect("S2", "routerCredit 0 after the Q1 2027 report");
    const y2027: [number, bigint, [number, number, number]][] = [
      [Q(2027, 1), usdc(110_000), [2027, 4, 2]],
      [Q(2027, 2), usdc(160_000), [2027, 7, 2]],
      [Q(2027, 3), usdc(210_000), [2027, 10, 2]],
      [Q(2027, 4), usdc(260_000), [2028, 1, 3]],
    ];
    for (const [period, ytd, [y, m, d]] of y2027) {
      b.at(ts(y, m, d));
      await b.report({ series: "S1", period, incomeYtd: ytd, tier: 3 });
      await b.step({ op: "pay", actor: "issuer", series: "S1" });
    }

    // 2027 true-up left unpaid past the 60-day deadline
    b.at(ts(2028, 1, 10));
    const att2 = b.t;
    await b.step({ op: "submit_trueup", actor: "issuer", series: "S1", year: "2027", adjustment: usdc(1_000).toString(), attestationTs: att2.toString(), attestor: "attestor2", nonce: "1" }, "+1,000 due by 10 March 2028 (60 days; 2028 is a leap year)");
    b.expect("S1", "trueupDue 1,000; trueupNonce 2");
    b.at(ts(2028, 3, 10));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "exactly 60 unpaused days: still OnTime");
    b.at(ts(2028, 3, 10, 0, 0, 1));
    await b.step({ op: "crank_status", series: "S1" });
    b.expect("S1", "one second later: trueup_overdue → Late");
    b.at(ts(2028, 3, 15));
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesLate", "tranches 3 and 4 vested in 2026 but a Late series releases nothing");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "SeriesLate", "lockup over since July 2027, Q4 2027 reported, Q1 2028 still running: only the true-up blocks");
    b.at(ts(2028, 3, 20));
    const before = b.sim.account("issuer").stable;
    await b.step({ op: "pay_trueup", actor: "issuer", series: "S1" }, "70 unpaused days − 60 = 10 late days: accrual = mulDiv(mulDiv(1,000e6, 0.08e18, 1e18), 10, 365) = 2,191,780");
    const paid = before - b.sim.account("issuer").stable;
    if (paid !== usdc(1_000) + 2_191_780n) throw new Error(`trueup paid ${paid}`);
    b.expect("S1", "OnTime again; 1,002.19178 gross received");
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "releases resume: tranches 3 and 4 (21,000)");
    b.at(ts(2028, 4, 2));
    const q1 = await b.report({ series: "S1", period: Q(2028, 1), incomeYtd: usdc(90_000), tier: 3, note: "recovery: a normal estimate for Q1 2028" });
    if (q1.paymentUsd !== usdc(400)) throw new Error("2028 q1");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) {
      await b.step({ op: "claim", actor: x, series: "S1" });
      await b.step({ op: "claim", actor: x, series: "S2" });
    }
    b.expect("S1", "S1 gross: 6,800 + 400 + 7,200 + 1,002.19178 + 400; releasedTotal == proceeds; vault empty");
    b.expect("S2", "S2 gross: 6,800 + 800 (the credit covered 800 of the 1,600 Q1 2027 payment)");
    return b.build();
  },
};
