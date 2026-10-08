import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s15: Scenario = {
  name: "15_zero_valid_bids",
  async build() {
    const b = new ScenarioBuilder(
      "15_zero_valid_bids",
      "A raise with no valid bid: one reveal below reserve, one above the wallet cap, one never revealed. The first settlement round fails the raise (valid_count == 0 → RaiseFailed(NoValidBids)) whatever the proposal says; processing refunds the invalid bids in full, charges the non-reveal 1% and finalizes the (empty) mint, so nothing is stuck.",
    );
    await bootstrap(b, ["b1", "b2", "b3"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, note: "1,000 units at reserve 100; wallet cap 10% → 100 units" });
    const s = b.sim.series.get("S1")!;
    const bids = [
      { actor: "b1", price: usdc(90), quantity: 50n, note: "below reserve → invalid" },
      { actor: "b2", price: usdc(150), quantity: 101n, note: "101 > wallet cap 100 → invalid" },
      { actor: "b3", price: usdc(200), quantity: 50n, note: "never revealed" },
    ];
    const esc = (x: (typeof bids)[number]) => (x.price * x.quantity * 101n) / 100n;
    b.at(ts(2026, 1, 5));
    await b.step({ op: "open_raise", actor: "issuer", series: "S1" });
    for (const [i, x] of bids.entries()) {
      b.advance(3600n);
      await b.step({ op: "commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i), escrow: esc(x).toString() }, x.note);
    }
    b.at(s.commitEnd + 3600n);
    for (const [i, x] of bids.entries()) {
      if (x.actor === "b3") continue;
      b.advance(600n);
      await b.step({ op: "reveal_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i) }, "recorded invalid, never reverts");
    }
    b.expect("S1", "3 committed, 2 revealed, 0 valid");
    b.at(s.revealEnd + 3600n);
    await b.step({ op: "begin_settlement", series: "S1", clearingPrice: usdc(100).toString(), qAboveClaim: "0", qAtClaim: "0" }, "any proposal: the tally finds no valid bid");
    await b.step({ op: "finalize_settlement", series: "S1" }, "valid_count == 0 → RaiseFailed(NoValidBids); clearing price 0, proceeds 0");
    b.expect("S1", "raiseState Failed; escrow 29,946.5 still held until processing");
    await b.revert({ op: "begin_settlement", series: "S1", clearingPrice: usdc(100).toString(), qAboveClaim: "0", qAtClaim: "0" }, "RaiseNotOpen", "a failed raise cannot be re-proposed");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "RaiseNotSettled");
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: 0n, tier: 2 }, "RaiseNotSettled");
    await b.revert({ op: "open_raise", actor: "issuer", series: "S1" }, "RaiseNotDraft");
    for (const x of bids) {
      b.advance(60n);
      await b.step({ op: "process_bid", series: "S1", bidder: x.actor }, x.actor === "b3" ? "non-reveal: 1% of 10,100 = 101 to the fee collector, 9,999 owed back" : "invalid bid: full escrow owed back");
    }
    b.expect("S1", "all bids processed: mint finalized with units_sold 0; fee collector 101; refunds pending in the auction escrow");
    await b.revert({ op: "process_bid", series: "S1", bidder: "b1" }, "AlreadyProcessed");
    for (const x of bids) {
      b.advance(60n);
      await b.step({ op: "deliver_bid", series: "S1", bidder: x.actor });
    }
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "b1" }, "AlreadyDelivered");
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "keeper" }, "BidNotFound");
    b.expect("S1", "escrow 0; b1 and b2 whole again; b3 down 101; no units exist");
    return b.build();
  },
};
