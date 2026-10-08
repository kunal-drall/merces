import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { DAY } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s09: Scenario = {
  name: "09_tail_clause",
  async build() {
    const b = new ScenarioBuilder(
      "09_tail_clause",
      "S1 is redeemed at k × D_avg = 150 (tail cap 82.5 per unit); a liquidity event reported inside the 12-month tail pays holders at redemption up to the tail cap (excess refunded, tail exhausted), a later event is refused (NoTailDue), non-liquidity tail-period reports only advance the chain, and a period starting after the tail window is rejected (TailEnded). S2 was redeemed at its remaining cap, so no tail is ever due.",
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
    b.at(ts(2027, 7, 2));
    for (const id of ["S1", "S2"]) await b.report({ series: id, period: Q(2027, 2), incomeYtd: usdc(10_000), tier: 2 });

    b.at(lockupEnd("S1") + DAY);
    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "k × D_avg = 5 × 30 = 150 decides; tail cap = 232.5 − 150 = 82.5 per unit; tail runs to redemption + 365 d");
    if (S("S1").ledger.redemptionPrice !== usdc(150)) throw new Error("S1 price");
    for (const x of ["b1", "b2", "b3"]) await b.step({ op: "claim_redemption", actor: x, series: "S1" });
    b.expect("S1", "b4 has not claimed yet: still holds 100 units, redeemedUnits 0");

    b.at(lockupEnd("S2") + DAY);
    await b.step({ op: "redeem", actor: "issuer", series: "S2" }, "C_rem = 262.5 − 250 = 12.5 < hurdle → remaining cap decides, tail cap 0");
    if (S("S2").ledger.tail.tailCapPerUnit !== 0n) throw new Error("S2 tail cap");
    b.expect("S2", "tailCapPerUnit 0");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim_redemption", actor: x, series: "S2" });
    b.expect("S2", "S2 closed out at 12.5 per unit");

    // Q3 2027: liquidity event on S1; S2's liquidity report is refused (no tail)
    b.at(ts(2027, 10, 5));
    await b.reportRevert({ series: "S2", period: Q(2027, 3), incomeYtd: usdc(900_000), tier: 2, liquidityEvent: true }, "NoTailDue");
    await b.report({ series: "S2", period: Q(2027, 3), incomeYtd: usdc(900_000), tier: 2, note: "non-liquidity report after redemption: accepted with due 0, only advances the chain" });
    const tail = await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(1_000_000), tier: 2, liquidityEvent: true, note: "exit: owed 4% × 920,000 = 36,800 (units public input = units at redemption = 400)" });
    if (tail.paymentUsd !== usdc(36_800)) throw new Error("tail payment");
    b.expect("S1", "tail report accepted: 36,800 due");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "tail cap 82.5 × 400 = 33,000 accepted; 3,800 refunded; fee 1,650; tailAccWad = 31,350 / 400 per unit; tail exhausted");
    b.expect("S1", "tail distributed and exhausted; refundedToIssuer unchanged (tail refunds are tracked in the tail state)");
    await b.step({ op: "claim_tail", actor: "b4", series: "S1" }, "b4 never claimed the redemption: claim_tail redeems first, then pays the tail");
    for (const x of ["b1", "b2", "b3"]) await b.step({ op: "claim_tail", actor: x, series: "S1" });
    b.expect("S1", "each holder received 7,837.5 USDC of tail; vault empty; all units burned");
    await b.revert({ op: "claim_tail", actor: "keeper", series: "S1" }, "HolderNotRegistered");

    b.at(ts(2028, 1, 5));
    await b.reportRevert({ series: "S1", period: Q(2027, 4), incomeYtd: usdc(1_500_000), tier: 2, liquidityEvent: true }, "NoTailDue", "the tail cap is exhausted");
    await b.report({ series: "S1", period: Q(2027, 4), incomeYtd: usdc(1_500_000), tier: 2, note: "reported without the flag: due 0" });
    b.at(ts(2028, 4, 3));
    await b.report({ series: "S1", period: Q(2028, 1), incomeYtd: usdc(100_000), tier: 2 });
    b.at(ts(2028, 7, 3));
    await b.report({ series: "S1", period: Q(2028, 2), incomeYtd: usdc(200_000), tier: 2 });
    b.at(ts(2028, 10, 3));
    await b.report({ series: "S1", period: Q(2028, 3), incomeYtd: usdc(300_000), tier: 2, note: "Q3 2028 started on 1 July 2028, inside the tail (redemption + 365 d ≈ 16 July 2028)" });
    b.at(ts(2029, 1, 4));
    await b.reportRevert({ series: "S1", period: Q(2028, 4), incomeYtd: usdc(400_000), tier: 2 }, "TailEnded", "Q4 2028 started after the tail ended");
    b.expect("S1", "there are no deadlines after redemption: status stays Redeemed");
    return b.build();
  },
};
