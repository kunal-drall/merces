import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { DAY } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s09: Scenario = {
  name: "09_tail_clause",
  async build() {
    const b = new ScenarioBuilder(
      "09_tail_clause",
      "S1 is redeemed at k × D_avg = 150 (tail cap 82.5 per unit); a liquidity event reported inside the 12-month tail pays holders at redemption up to the tail cap (excess refunded), a later event finds the cap exhausted, and reports after the tail window are rejected. S2 was redeemed at its remaining cap, so no tail is ever due.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(600_000), backerFunds: usdc(80_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    const S = (id: string) => b.sim.series.get(id)!;
    const lockupEnd = (id: string) => S(id).settlementTs + S(id).terms.lockupSeconds;

    const income: Record<string, bigint[]> = {
      S1: [usdc(50_000), usdc(380_000), usdc(380_000), usdc(380_000)],
      S2: [usdc(2_580_000), usdc(2_580_000), usdc(2_580_000), usdc(2_580_000)],
    };
    const dates: [number, number, number][] = [
      [2026, 4, 2],
      [2026, 7, 2],
      [2026, 10, 2],
      [2027, 1, 3],
    ];
    for (const [q, [y, m, d]] of dates.entries()) {
      b.at(ts(y, m, d));
      for (const id of ["S1", "S2"]) {
        const r = await b.report({ series: id, period: Q(2026, q + 1), incomeYtd: income[id]![q]!, tier: 2 });
        if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: id });
      }
    }
    b.at(ts(2027, 4, 2));
    for (const id of ["S1", "S2"]) await b.report({ series: id, period: Q(2027, 1), incomeYtd: usdc(10_000), tier: 2 });

    // S1 redemption
    b.at(lockupEnd("S1") + DAY);
    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "k × D_avg = 5 × 30 = 150 decides; tail cap = 232.5 − 150 = 82.5 per unit");
    if (S("S1").ledger.redemptionPrice !== usdc(150)) throw new Error("S1 price");
    for (const x of ["b1", "b2", "b3"]) await b.step({ op: "claim_redemption", actor: x, series: "S1" });
    b.expect("S1", "b4 has not claimed yet: still holds 100 units, redeemedUnits 0");
    await b.reportRevert({ series: "S1", period: Q(2027, 2), incomeYtd: usdc(1_000_000), tier: 2 }, "NotLiquidityEvent", "a report on a Redeemed series must flag a liquidity event");

    // liquidity event in Q2 2027 (the quarter that ended just before redemption)
    b.at(ts(2027, 7, 20));
    const tail = await b.report({ series: "S1", period: Q(2027, 2), incomeYtd: usdc(1_000_000), tier: 2, liquidityEvent: true, note: "exit: owed 4% × 920,000 = 36,800 (units public input = units at redemption = 400)" });
    if (tail.paymentUsd !== usdc(36_800)) throw new Error("tail payment");
    b.expect("S1", "tail report accepted: 36,800 due");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "tail cap 82.5 × 400 = 33,000 accepted; 3,800 refunded; fee 1,650; tailAccWad = 31,350 / 400 per unit");
    b.expect("S1", "tail distributed; refundedToIssuer unchanged (tail refunds are tracked in the tail state)");
    await b.revert({ op: "claim_tail", actor: "b4", series: "S1" }, "NoRedeemedUnits", "b4 must claim the redemption first so its redeemed units are recorded");
    await b.step({ op: "claim_redemption", actor: "b4", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim_tail", actor: x, series: "S1" });
    b.expect("S1", "each holder received 7,837.5 USDC of tail; vault empty; all units burned");
    await b.revert({ op: "claim_tail", actor: "keeper", series: "S1" }, "HolderNotRegistered");

    // S2: redeemed at the remaining cap → no tail
    b.at(lockupEnd("S2") + DAY);
    await b.report({ series: "S2", period: Q(2027, 2), incomeYtd: usdc(100_000), tier: 2 });
    await b.step({ op: "pay", actor: "issuer", series: "S2" });
    await b.step({ op: "redeem", actor: "issuer", series: "S2" }, "C_rem = 262.5 − 252 = 10.5 < hurdle → remaining cap decides, tail cap 0");
    if (S("S2").ledger.tail.tailCapPerUnit !== 0n) throw new Error("S2 tail cap");
    b.expect("S2", "tailCapPerUnit 0");
    await b.reportRevert({ series: "S2", period: Q(2027, 3), incomeYtd: usdc(900_000), tier: 2, liquidityEvent: true }, "NoTailDue");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim_redemption", actor: x, series: "S2" });
    b.expect("S2", "S2 closed out at 10.5 per unit");

    // S1: a second event finds the tail cap exhausted → accepted 0, everything refunded
    b.at(ts(2027, 10, 5));
    const tail2 = await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(1_500_000), tier: 2, liquidityEvent: true, note: "another 20,000 owed, but the tail cap is exhausted" });
    if (tail2.paymentUsd !== usdc(20_000)) throw new Error("tail2");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "accepted 0, 20,000 refunded to the issuer");
    b.expect("S1", "tailPaidPerUnitWad stays at the cap; issuer balance unchanged by this payment");

    // after 12 months the tail ends
    b.at(S("S1").ledger.redemptionTs + 31_536_000n + DAY);
    await b.reportRevert({ series: "S1", period: Q(2027, 4), incomeYtd: usdc(2_000_000), tier: 2, liquidityEvent: true }, "TailExpired");
    return b.build();
  },
};
