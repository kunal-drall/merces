import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, bootstrap } from "./common.js";
import { DAY, WAD, isTradingDay, periodStart } from "@merces/sdk";
import type { Scenario } from "./index.js";

/** Pyth Stable USD/JPY feed id (quoted JPY per USD ≈ 150, expo −8). */
const USDJPY_FEED = "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52";
const U64_MAX = 2n ** 64n - 1n;

export const s24: Scenario = {
  name: "24_inverted_fx",
  async build() {
    const b = new ScenarioBuilder(
      "24_inverted_fx",
      "A JPY-income series reported in USDC through an inverted FX pair (USD/JPY ≈ 150, expo −8 → JPY/USD). The un-inverted WAD rate is 1.5e20, which exceeds u64; the normalization must invert in wide arithmetic and only the final inverted rate (≈ 6.67e15) needs to fit u64 (S4 / C-S? — both stacks must accept it). Snapshots accumulate across a covered quarter and quarter_average returns ok (not the attestor fallback); the report pays in USDC at the inverted average.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    const JPYUSD = await b.fxPair(USDJPY_FEED, true, true, "USD/JPY feed, inverted to JPY/USD; pair id = keccak256(feed_id ‖ 0x01)");
    await b.createSeries({
      series: "S1",
      issuer: "issuer",
      plain: { theta: 12_000_000n * 1_000_000n, rWad: WAD / 10_000n, currencyCode: 392, indexingRule: 0 },
      fxPairId: JPYUSD,
      note: "θ = 12,000,000 JPY at 6 decimals (income scale ≈ 80,000 USD), currency 392",
    });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });

    const q1 = Q(2026, 1);
    const noon = (d: number) => periodStart(q1) + BigInt(d) * DAY + 43_200n;
    // USD/JPY drifts 148 → 152 over the quarter; each snapshot is normalized then inverted (JPY/USD).
    const usdjpy = (d: number) => 148_00000000n + BigInt(d) * 5_000_000n;
    let n = 0;
    let lastInverted = 0n;
    for (let d = 13; d < 90 && n < 60; d++) {
      const t = noon(d);
      if (!isTradingDay(t)) continue;
      b.at(t);
      const price = usdjpy(d);
      await b.step(
        { op: "fx_snapshot", pairId: JPYUSD, price: price.toString(), conf: "20000", expo: -8, publishTime: (t - 60n).toString(), crosscheckPrice: price.toString(), crosscheckExpo: -8 },
        d === 13 ? "first snapshot of Q1 creates the Q1 checkpoint; the un-inverted WAD rate (> u64) is inverted in wide arithmetic to a u64-fitting JPY/USD rate" : undefined,
      );
      lastInverted = (WAD * WAD) / (price * 10n ** 10n);
      if (lastInverted > U64_MAX) throw new Error("inverted rate exceeds u64");
      n++;
    }
    if (n < 52) throw new Error(`coverage ${n} < 52 (80% of 64 trading days)`);
    // the un-inverted rate really does exceed u64 (the S4 trap); the stored rate is the inverted one
    const preInversion = usdjpy(13) * 10n ** 10n;
    if (preInversion <= U64_MAX) throw new Error("test does not exercise the over-u64 pre-inversion value");

    b.at(ts(2026, 4, 1, 6));
    const r = await b.report({ series: "S1", period: q1, incomeYtd: 15_000_000n * 1_000_000n, tier: 2, note: "live-end checkpoint; quarter_average ok (covered, inverted); owed 4% × (15,000,000 − 12,000,000) JPY = 120,000 JPY, converted to USDC at the inverted average" });
    if (r.paymentUsd === 0n) throw new Error("payment zero");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", `Q1 accepted through the inverted accumulator (${n}/64 trading days); payment ${r.paymentUsd} USDC`, { [JPYUSD]: [q1] });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "holders split 95% of the JPY→USDC payment; the inverted pair never forced the attestor fallback");
    return b.build();
  },
};
