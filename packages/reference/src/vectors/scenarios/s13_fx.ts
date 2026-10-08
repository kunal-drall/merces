import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, bootstrap } from "./common.js";
import { DAY, WAD, periodStart } from "@merces/sdk";
import type { Scenario } from "./index.js";

/** Pyth Stable EUR/USD feed id (docs/research/PYTH.md §5.2). */
const EURUSD = "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";

export const s13: Scenario = {
  name: "13_fx",
  async build() {
    const b = new ScenarioBuilder(
      "13_fx",
      "EUR income reported in USDC through the EUR/USD rate accumulator: a normally covered quarter (average of 76 daily Pyth snapshots), a low-coverage quarter (60 of 91 days → attestor-signed fallback rate), a quarter flagged for a >2% Pyth/Chainlink deviation (fallback), and a fourth normal quarter; FX reverts included.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.step({ op: "set_fx_pair", pairId: EURUSD, inverted: false, crosscheck: true }, "EUR/USD, quoted USD per EUR, Chainlink cross-check configured");
    await b.createSeries({
      series: "S1",
      issuer: "issuer",
      plain: { theta: usdc(80_000), rWad: WAD / 10_000n, currencyCode: 978, indexingRule: 0 },
      fxPairId: EURUSD,
      note: "θ = 80,000 EUR (6 decimals), currency 978",
    });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });

    const q1 = Q(2026, 1);
    const q2 = Q(2026, 2);
    const q3 = Q(2026, 3);
    const q4 = Q(2026, 4);
    const noon = (q: number, d: number) => periodStart(q) + BigInt(d) * DAY + 43_200n;
    // Pyth-shaped prices: expo −8, conf 0.02%
    const snap = async (t: bigint, p: bigint, cross: bigint, note?: string) => {
      b.at(t);
      await b.step({ op: "fx_snapshot", pairId: EURUSD, price: p.toString(), conf: "20000", expo: -8, publishTime: (t - 60n).toString(), crosscheckPrice: cross.toString(), crosscheckExpo: -8 }, note);
    };

    // Q1 2026: the keeper starts after the raise settles (15 January): 76 of 90 days ≥ 80% coverage; rate drifts 1.0814 → 1.0889
    const q1Price = (d: number) => 108_000_000n + BigInt(d) * 10_000n;
    for (let d = 14; d < 90; d++) {
      await snap(noon(q1, d), q1Price(d), q1Price(d), d === 14 ? "first snapshot of Q1 creates the Q1 checkpoint (sums 0)" : undefined);
      if (d === 14) {
        await b.revert({ op: "fx_snapshot", pairId: EURUSD, price: "108000000", conf: "20000", expo: -8, publishTime: (b.t - 60n).toString() }, "SnapshotAlreadyTaken");
        await b.revert({ op: "fx_snapshot", pairId: EURUSD, price: "108000000", conf: "20000", expo: -8, publishTime: (b.t - 3601n).toString() }, "SnapshotAlreadyTaken", "same day: the day check comes first");
      }
    }
    // first Q2 snapshot closes Q1
    b.at(noon(q2, 0));
    await b.revert({ op: "fx_snapshot", pairId: EURUSD, price: "109000000", conf: "20000", expo: -8, publishTime: (b.t - 3601n).toString() }, "StalePrice", "publish_time older than 3600 s");
    await b.revert({ op: "fx_snapshot", pairId: EURUSD, price: "109000000", conf: "1100000", expo: -8, publishTime: (b.t - 60n).toString() }, "ConfidenceTooWide", "conf 1.01% > 1%");
    await snap(noon(q2, 0), 109_000_000n, 109_000_000n, "first snapshot of Q2 closes the Q1 checkpoint");
    b.expect("S1", "Q1 closed with 76 snapshots (84% coverage)", { [EURUSD]: [q1] });

    // Q1 report with the accumulator average
    b.at(ts(2026, 4, 3));
    await b.reportRevert({ series: "S1", period: q1, incomeYtd: usdc(110_000), tier: 2, fxAvgWadOverride: WAD }, "FxMismatch", "stablecoin-rate shortcut is wrong for an FX series");
    await b.reportRevert({ series: "S1", period: q1, incomeYtd: usdc(110_000), tier: 2, fxFallback: { attestor: "attestor1", rateWad: 1_085_000_000_000_000_000n } }, "FxFallbackNotAllowed", "the accumulator is valid for Q1");
    const r1 = await b.report({ series: "S1", period: q1, incomeYtd: usdc(110_000), tier: 2, note: "owed 4% × 30,000 EUR = 1,200 EUR × avg(1.0814…1.0889) → USDC, floor" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", `Q1 paid: ${r1.paymentUsd} USDC`, { [EURUSD]: [q1, q2] });

    // Q2 2026: only 60 snapshots (days 0–59 of 91) → coverage 65.9% < 80%
    for (let d = 1; d < 60; d++) await snap(noon(q2, d), 109_000_000n, 109_000_000n);
    await snap(noon(q3, 0), 110_000_000n, 110_000_000n, "first snapshot of Q3 closes Q2 with 60 of 91 days → NeedsFallback");
    b.expect("S1", "Q2 NeedsFallback (coverage 60/91)", { [EURUSD]: [q2] });
    b.at(ts(2026, 7, 3));
    await b.reportRevert({ series: "S1", period: q2, incomeYtd: usdc(160_000), tier: 2, fxAvgWadOverride: 1_090_000_000_000_000_000n }, "FxFallbackRequired", "low coverage: an attestor-signed rate is required");
    await b.reportRevert({ series: "S1", period: q2, incomeYtd: usdc(160_000), tier: 2, fxFallback: { attestor: "verifier1", rateWad: 1_090_000_000_000_000_000n } }, "InvalidAttestorSignature", "the fallback rate must be signed by an attestor");
    const r2 = await b.report({ series: "S1", period: q2, incomeYtd: usdc(160_000), tier: 2, fxFallback: { attestor: "attestor1", rateWad: 1_090_000_000_000_000_000n }, note: "fallback rate 1.09 signed by attestor1 (MERCES_FX_V1 message); payment 2,000 EUR → 2,180 USDC" });
    if (r2.paymentUsd !== 2_180n * 1_000_000n) throw new Error(`r2 ${r2.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S1" });

    // Q3 2026: full coverage, but day 40 deviates 3% from the cross-check → flagged
    for (let d = 1; d < 92; d++) {
      await snap(noon(q3, d), 110_000_000n, d === 40 ? 113_300_000n : 110_000_000n, d === 40 ? "Chainlink 1.133 vs Pyth 1.10: 3% > 2% band → period flagged" : undefined);
    }
    await snap(noon(q4, 0), 111_000_000n, 111_000_000n, "first snapshot of Q4 closes Q3");
    b.expect("S1", "Q3 fully covered but flagged → NeedsFallback", { [EURUSD]: [q3] });
    b.at(ts(2026, 10, 3));
    const r3 = await b.report({ series: "S1", period: q3, incomeYtd: usdc(200_000), tier: 2, fxFallback: { attestor: "attestor2", rateWad: 1_100_000_000_000_000_000n }, note: "deviation fallback at 1.10: 1,600 EUR → 1,760 USDC" });
    if (r3.paymentUsd !== 1_760n * 1_000_000n) throw new Error(`r3 ${r3.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S1" });

    // Q4 2026: normal again at exactly 1.11
    for (let d = 1; d < 92; d++) await snap(noon(q4, d), 111_000_000n, 111_000_000n);
    await snap(noon(Q(2027, 1), 0), 111_000_000n, 111_000_000n, "first snapshot of 2027 Q1 closes Q4");
    b.expect("S1", "Q4 ok at exactly 1.11", { [EURUSD]: [q3, q4] });
    b.at(ts(2027, 1, 4));
    const r4 = await b.report({ series: "S1", period: q4, incomeYtd: usdc(250_000), tier: 2, note: "accumulator average 1.11 exactly: 2,000 EUR → 2,220 USDC" });
    if (r4.paymentUsd !== 2_220n * 1_000_000n) throw new Error(`r4 ${r4.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", `2026 payments in USDC: ${r1.paymentUsd}, ${r2.paymentUsd}, ${r3.paymentUsd}, ${r4.paymentUsd}; all OnTime`, { [EURUSD]: [q1, q2, q3, q4] });
    return b.build();
  },
};
