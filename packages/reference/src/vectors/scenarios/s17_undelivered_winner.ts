import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s17: Scenario = {
  name: "17_undelivered_winner",
  async build() {
    const b = new ScenarioBuilder(
      "17_undelivered_winner",
      "A winning bidder (b4) is removed from the allowlist after revealing and its delivery is deferred (recipient-side failure modelled by the harness): processing still mints its 100 units to the auction escrow and finalizes the mint, treasury releases flow, the undelivered units carry accrual weight so b4 claims its share of the first payout, and deliver_bid later succeeds regardless of the current allowlist flag (validity was fixed at reveal).",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({
      series: "S1",
      issuer: "issuer",
      openAt: ts(2026, 1, 5),
      bids: FOUR_BACKER_BIDS,
      undelivered: ["b4"],
      beforeSettle: async () => {
        await b.step({ op: "allowlist", wallets: ["b4"], allowed: false }, "b4 leaves the allowlist after revealing; its bid stays valid (fixed at reveal)");
      },
    });
    const s = b.sim.series.get("S1")!;
    if (s.auction.escrowUnits !== 100n || !s.auction.mintFinalized) throw new Error("escrow units");
    b.expect("S1", "settled at 105 on 400 units; b4's 100 units sit in the auction escrow (holders.b4.pendingUnits 100, delivered false); mint finalized; unitsOutstanding 400");
    await b.revert({ op: "register_holder", series: "S1", holder: "b4" }, "NotAllowlisted", "re-registration needs the allowlist; b4 was registered in process_bid");
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "b1" }, "AlreadyDelivered");
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "keeper" }, "BidNotFound");

    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "releases depend only on bids_processed, not on deliveries");
    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(130_000), tier: 2, note: "owed 4% × 50,000 = 2,000; units_outstanding 400 includes the undelivered 100" });
    if (q1.paymentUsd !== usdc(2_000)) throw new Error("q1");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "net 1,900 over 400 units = 4.75 per unit");
    await b.step({ op: "claim", actor: "b4", series: "S1" }, "accrual_units(b4) = 0 balance + 100 pending → 475 USDC although nothing was delivered");
    await b.step({ op: "claim", actor: "b1", series: "S1" });
    b.expect("S1", "b4 paid 475 like every other holder; auction escrow still holds 100 units");

    b.at(ts(2026, 4, 10));
    await b.step({ op: "deliver_bid", series: "S1", bidder: "b4" }, "delivery retried and succeeds while b4 is still off the allowlist (C10): 100 units and the 10,605 − 10,605 = 0 refund move to b4");
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "b4" }, "AlreadyDelivered");
    b.expect("S1", "b4 holds 100 units; auction escrow 0; pending payouts unchanged by delivery");
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 2");

    b.at(ts(2026, 7, 2));
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(160_000), tier: 2, note: "owed 3,200 → payment 1,200" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "every holder received 25% of 3,040 net over the two quarters");
    return b.build();
  },
};
