import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { DAY } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s06: Scenario = {
  name: "06_redemption_terms",
  async build() {
    const b = new ScenarioBuilder(
      "06_redemption_terms",
      "Three series of the same issuer redeemed after the 18-month lockup, each priced by a different term: S1 by the hurdle (no payments), S2 by k × D_avg (high first-year payments), S3 by the remaining cap (nearly capped). The redemption gate (every ended period reported, nothing due) is exercised; holders claim the redemption price and units burn; releases continue after redemption.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(600_000), backerFunds: usdc(80_000) });
    for (const id of ["S1", "S2", "S3"]) await b.createSeries({ series: id, issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S3", issuer: "issuer", openAt: ts(2026, 1, 25), bids: FOUR_BACKER_BIDS });
    const S = (id: string) => b.sim.series.get(id)!;
    const lockupEnd = (id: string) => S(id).settlementTs + S(id).terms.lockupSeconds;
    b.expect("S2", "three series × 400 units at 105 USDC; P0 = 105, cap 262.5 per unit");

    const income: Record<string, bigint[]> = {
      S1: [usdc(20_000), usdc(40_000), usdc(60_000), usdc(70_000)],
      S2: [usdc(50_000), usdc(380_000), usdc(380_000), usdc(380_000)],
      S3: [usdc(2_580_000), usdc(2_580_000), usdc(2_580_000), usdc(2_580_000)],
    };
    const dates: [number, number, number][] = [
      [2026, 4, 2],
      [2026, 7, 2],
      [2026, 10, 2],
      [2027, 1, 3],
    ];
    for (const [q, [y, m, d]] of dates.entries()) {
      b.at(ts(y, m, d));
      for (const id of ["S1", "S2", "S3"]) {
        const r = await b.report({ series: id, period: Q(2026, q + 1), incomeYtd: income[id]![q]!, tier: 2 });
        if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: id });
      }
    }
    b.expect("S2", "S2 paid 12,000 gross whose deadline (31 July 2026) falls in settlement year 0 → 30 USDC per unit in year_gross[0]; S1 nothing; S3 100,000 (deadline 1 May 2026) → 250 per unit");
    b.expect("S3");
    b.at(ts(2027, 4, 2));
    for (const id of ["S1", "S2", "S3"]) await b.report({ series: id, period: Q(2027, 1), incomeYtd: usdc(10_000), tier: 2 });

    b.at(lockupEnd("S1") - 1n);
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "LockupActive", "one second before the lockup ends");
    await b.revert({ op: "redeem", actor: "b1", series: "S1" }, "NotIssuer");
    b.at(lockupEnd("S1") + DAY);
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "UnreportedPeriods", "Q2 2027 ended on 1 July and has no accepted report yet");
    for (const id of ["S1", "S2", "S3"]) await b.report({ series: id, period: Q(2027, 2), incomeYtd: usdc(10_000), tier: 2 });
    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "P_hurdle = 105 × 1.08 × (1 + 0.08 × frac) > k × D_avg = 0; C_rem = 262.5 → hurdle decides");
    b.expect("S1", `redemptionPrice ${S("S1").ledger.redemptionPrice} (hurdle); deposit = price × 400 in the vault; tailCapPerUnit = 262.5 − price`);
    for (const x of ["b1", "b2"]) await b.step({ op: "claim_redemption", actor: x, series: "S1" });
    b.expect("S1", "b1 and b2 received the redemption price for 100 units each; units burned");

    b.at(lockupEnd("S2") + DAY);
    await b.step({ op: "redeem", actor: "issuer", series: "S2" }, "D_avg over 1 full year = 30 USDC/unit → k × D_avg = 150 decides");
    if (S("S2").ledger.redemptionPrice !== usdc(150)) throw new Error(`S2 price ${S("S2").ledger.redemptionPrice}`);
    b.expect("S2", "redemptionPrice 150; deposit 60,000; tailCapPerUnit = 232.5 − 150 = 82.5");

    b.at(ts(2027, 10, 2)); // S3's lockup ended in August 2027; the issuer waits for the Q3 report
    const r = await b.report({ series: "S3", period: Q(2027, 3), incomeYtd: usdc(100_000), tier: 2, note: "Q3 2027 ended 1 October; a due payment must be settled before redeeming" });
    if (r.due === 0n) throw new Error("expected a due");
    await b.revert({ op: "redeem", actor: "issuer", series: "S3" }, "PaymentOutstanding");
    await b.step({ op: "pay", actor: "issuer", series: "S3" }, "800 gross: 252 per unit paid in total");
    await b.step({ op: "redeem", actor: "issuer", series: "S3" }, "C_rem = 262.5 − 252 = 10.5 → remaining cap decides; tail cap 0");
    if (S("S3").ledger.redemptionPrice !== 10_500_000n) throw new Error(`S3 price ${S("S3").ledger.redemptionPrice}`);
    b.expect("S3", "redemptionPrice 10.5 USDC; tailCapPerUnit 0 → no tail is ever due");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim_redemption", actor: x, series: "S3" });
    await b.revert({ op: "claim_redemption", actor: "keeper", series: "S3" }, "HolderNotRegistered");
    b.expect("S3", "S3 fully redeemed and burned; pending payouts were paid with the redemption");

    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "all four tranches vested long ago; nothing was claimed before");
    b.expect("S1", "Redeemed series released its full treasury to the issuer");
    return b.build();
  },
};
