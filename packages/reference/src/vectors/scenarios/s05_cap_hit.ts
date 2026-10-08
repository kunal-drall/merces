import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s05: Scenario = {
  name: "05_cap_hit",
  async build() {
    const b = new ScenarioBuilder(
      "05_cap_hit",
      "Per-unit cap 2.5 × 105 = 262.5 USDC (105,000 on 400 units) is reached in the third payment: the payment is truncated, the excess refunded to the issuer, the series Retired, units burned on claim or by a keeper crank; later reports are rejected while treasury releases continue.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(400_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    const s = b.sim.series.get("S1")!;
    b.expect("S1", "capPerUnit = floor(2.5e18 × 105e6 / 1e18) = 262,500,000");

    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(100_000), tier: 2, note: "owed 4% × 20,000 = 800" });
    if (q1.paymentUsd !== usdc(800)) throw new Error("q1");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 1 and 2 (settlement + 90 days)");

    b.at(ts(2026, 7, 2));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(1_500_000), tier: 2, note: "exit proceeds: owed 4% × 1,420,000 = 56,800 → payment 56,000" });
    if (q2.paymentUsd !== usdc(56_000)) throw new Error("q2");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", "paidPerUnitWad = 56,800 / 400 = 142 USDC per unit; still below the cap");
    await b.step({ op: "claim", actor: "b1", series: "S1" }, "b1 claims 25% of (760 + 53,200)");

    b.at(ts(2026, 10, 2));
    const q3 = await b.report({ series: "S1", period: Q(2026, 3), incomeYtd: usdc(2_900_000), tier: 2, note: "owed 4% × 2,820,000 = 112,800 → payment 56,000; only 48,200 fits under the cap" });
    if (q3.paymentUsd !== usdc(56_000)) throw new Error("q3");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "cap hit: accepted 48,200, refund 7,800 to the issuer, fee 2,410, series Retired");
    if (s.vault.paidPerUnitWad !== 262_500_000n * 10n ** 18n) throw new Error(`paid ${s.vault.paidPerUnitWad}`);
    b.expect("S1", "Retired: paidPerUnitWad == cap × WAD; refundedToIssuer 7,800; gross 105,000 = 400 × 262.5");

    await b.reportRevert({ series: "S1", period: Q(2026, 4), incomeYtd: usdc(3_000_000), tier: 2 }, "SeriesRetired", "no reports after retirement (nothing owed)");
    await b.step({ op: "claim", actor: "b1", series: "S1" }, "claim on a Retired series burns the holder's units");
    await b.step({ op: "claim", actor: "b2", series: "S1" });
    await b.step({ op: "burn_retired", series: "S1", holder: "b3" }, "keeper crank: burns b3's units; b3's pending stays claimable");
    b.expect("S1", "b3 burned but unpaid: holders.b3.pending = 25% of net");
    await b.step({ op: "claim", actor: "b3", series: "S1" });
    await b.step({ op: "claim", actor: "b4", series: "S1" });
    b.expect("S1", "all units burned (unitsOutstanding 0); vault empty; fee collector = 420 + 5% × 105,000");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "SeriesTerminal", "a Retired series cannot be redeemed (the status check precedes the lockup check)");

    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "Retired series still release on schedule: tranches 3 and 4");
    b.expect("S1", "releasedTotal == proceeds 42,000");
    return b.build();
  },
};
