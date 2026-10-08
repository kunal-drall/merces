import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { DAY } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s16: Scenario = {
  name: "16_demand_limited_window",
  async build() {
    const b = new ScenarioBuilder(
      "16_demand_limited_window",
      "Demand-limited transfer window: asks 30 @ 120 and 20 @ 125 meet a single bid 10 @ 125. A proposal at 125 is rejected (S = 50 > D = 10 and the asks below 125 exceed D); at 120 the demand-limited branch clears 10 units (s_below = 0 < D = 10 ≤ S = 30): the ask at p* is filled first-come and gets 20 units back, the ask above p* is returned whole, the buyer pays 120 + 1% fee and is refunded the rest of its escrow. A later window with max_bid < min_ask settles NO_MATCH and returns every order.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4", "b5"], { backerFunds: usdc(60_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    const s = b.sim.series.get("S1")!;
    const plan: [number, bigint, [number, number, number]][] = [
      [Q(2026, 1), usdc(60_000), [2026, 4, 2]],
      [Q(2026, 2), usdc(130_000), [2026, 7, 2]],
      [Q(2026, 3), usdc(180_000), [2026, 10, 2]],
      [Q(2026, 4), usdc(230_000), [2027, 1, 3]],
      [Q(2027, 1), usdc(50_000), [2027, 4, 2]],
      [Q(2027, 2), usdc(120_000), [2027, 7, 2]],
    ];
    for (const [period, ytd, [y, m, d]] of plan) {
      b.at(ts(y, m, d));
      const r = await b.report({ series: "S1", period, incomeYtd: ytd, tier: 2 });
      if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: "S1" });
    }
    await b.step({ op: "set_flags", windowsEnabled: true });
    b.at(s.settlementTs + s.terms.lockupSeconds + DAY);
    await b.step({ op: "open_window", series: "S1", period: Q(2027, 2).toString() });
    const w = s.window!;
    const asks = [
      { actor: "b1", price: usdc(120), quantity: 30n },
      { actor: "b2", price: usdc(125), quantity: 20n },
    ];
    const bid = { actor: "b5", price: usdc(125), quantity: 10n, escrow: (usdc(125) * 10n * 101n) / 100n };
    for (const [i, a] of asks.entries()) {
      b.advance(3600n);
      await b.step({ op: "commit_ask", actor: a.actor, series: "S1", price: a.price.toString(), quantity: a.quantity.toString(), salt: b.salt(`ask:${a.actor}:${i}`), units: a.quantity.toString() });
    }
    b.advance(3600n);
    await b.step({ op: "window_commit_bid", actor: bid.actor, series: "S1", price: bid.price.toString(), quantity: bid.quantity.toString(), salt: b.salt("bid:b5:0"), escrow: bid.escrow.toString() }, "escrow 125 × 10 × 1.01 = 1,262.5");
    b.at(w.commitEnd + 600n);
    for (const [i, a] of asks.entries()) {
      b.advance(60n);
      await b.step({ op: "reveal_order", actor: a.actor, series: "S1", price: a.price.toString(), quantity: a.quantity.toString(), salt: b.salt(`ask:${a.actor}:${i}`) });
    }
    b.advance(60n);
    await b.step({ op: "reveal_order", actor: bid.actor, series: "S1", price: bid.price.toString(), quantity: bid.quantity.toString(), salt: b.salt("bid:b5:0") });
    b.expect("S1", "50 units and 1,262.5 USDC in the window escrow");
    b.at(w.revealEnd + 600n);
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(125).toString() }, "round 1: 125");
    await b.step({ op: "finalize_window", series: "S1" }, "S = 50, D = 10, d_above = 0, s_below = 30: supply-limited needs S ≤ D, demand-limited needs s_below < D → WindowSettlementRejected");
    b.expect("S1", "round 1 rejected; window still Settling");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(120).toString() }, "round 2: 120");
    await b.step({ op: "finalize_window", series: "S1" }, "S = 30, D = 10, s_below = 0 < 10 ≤ 30 → demand-limited, matched 10; the single bid is above p* and fills in full");
    b.expect("S1", "WindowCleared(120, 10, DemandLimited)");
    await b.step({ op: "process_orders", series: "S1" }, "b5 buys 10 at 120 (1,200 + 12 fee, 50.5 refunded); b1 (the only ask at p*) sells 10 and gets 20 units back; b2's 20 units return untouched");
    b.expect("S1", "units: b1 90, b2 100, b3 100, b4 100, b5 10; b1 +1,200; fee collector +12; window escrow empty");

    b.at(ts(2027, 10, 2));
    await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(220_000), tier: 2, note: "owed 4% × 140,000 = 5,600 → payment 4,000" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    await b.step({ op: "open_window", series: "S1", period: Q(2027, 3).toString() }, "second window, after the Q3 report");
    const w2 = s.window!;
    b.advance(3600n);
    await b.step({ op: "commit_ask", actor: "b3", series: "S1", price: usdc(130).toString(), quantity: "10", salt: b.salt("ask2:b3"), units: "10" });
    b.advance(3600n);
    await b.step({ op: "window_commit_bid", actor: "b5", series: "S1", price: usdc(110).toString(), quantity: "10", salt: b.salt("bid2:b5"), escrow: ((usdc(110) * 10n * 101n) / 100n).toString() });
    b.at(w2.commitEnd + 600n);
    await b.step({ op: "reveal_order", actor: "b3", series: "S1", price: usdc(130).toString(), quantity: "10", salt: b.salt("ask2:b3") });
    b.advance(60n);
    await b.step({ op: "reveal_order", actor: "b5", series: "S1", price: usdc(110).toString(), quantity: "10", salt: b.salt("bid2:b5") });
    b.at(w2.revealEnd + 600n);
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(120).toString() }, "round 1: a price with no valid clearing");
    await b.step({ op: "finalize_window", series: "S1" }, "S = 0 (no ask ≤ 120) → rejected");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: "NO_MATCH" }, "round 2: NO_MATCH");
    await b.step({ op: "finalize_window", series: "S1" }, "max_bid 110 < min_ask 130 → WindowNoMatch");
    await b.step({ op: "process_orders", series: "S1" }, "every order returned: b3's 10 units, b5's 1,111 USDC");
    b.expect("S1", "no units moved; holders' pending payouts from Q3 2027 intact (b5 earned 10/400 of the 3,800 net)");
    for (const x of ["b1", "b2", "b3", "b4", "b5"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "b1 claims on 90 units for Q3 2027 and 100 units before the first window");
    return b.build();
  },
};
