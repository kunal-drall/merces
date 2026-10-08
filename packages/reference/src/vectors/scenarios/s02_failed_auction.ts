import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s02: Scenario = {
  name: "02_failed_auction",
  async build() {
    const b = new ScenarioBuilder(
      "02_failed_auction",
      "Two raises that fail: S1 clears at 110 but its exact proceeds (22,000) are below the minimum raise (full refunds, no fee, no units); S2 has no reveal at all (valid_count 0 → Failed with clearing price 0 whatever was proposed, unrevealed bid refunded without charge).",
    );
    await bootstrap(b, ["b1", "b2"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, terms: { minRaise: usdc(60_000) }, note: "min raise 60,000 USDC" });
    await b.revert({ op: "begin_settlement", series: "S1", clearingPrice: "0", qAboveClaim: "0", qAtClaim: "0" }, "RaiseNotOpen");

    const bids = [
      { actor: "b1", price: usdc(120), quantity: 100n },
      { actor: "b2", price: usdc(110), quantity: 100n },
    ];
    const s1 = b.sim.series.get("S1")!;
    b.at(ts(2026, 1, 5));
    await b.step({ op: "open_raise", actor: "issuer", series: "S1" });
    await b.revert({ op: "open_raise", actor: "issuer", series: "S1" }, "RaiseNotDraft");
    for (const [i, x] of bids.entries()) {
      b.advance(3600n);
      await b.step({ op: "commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i), escrow: ((x.price * x.quantity * 101n) / 100n).toString() });
    }
    await b.revert({ op: "cancel_raise", actor: "issuer", series: "S1" }, "BidsExist");
    b.at(s1.commitEnd + 3600n);
    for (const [i, x] of bids.entries()) {
      b.advance(600n);
      await b.step({ op: "reveal_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i) });
    }
    await b.revert({ op: "begin_settlement", series: "S1", clearingPrice: usdc(110).toString(), qAboveClaim: "100", qAtClaim: "100" }, "SettlementNotReady");
    await b.revert({ op: "finalize_settlement", series: "S1" }, "NotSettling");
    b.at(s1.revealEnd + 3600n);
    await b.step({ op: "begin_settlement", series: "S1", clearingPrice: usdc(110).toString(), qAboveClaim: "100", qAtClaim: "100" }, "honest proposal: 110 with claims q_above 100, q_at 100");
    await b.step({ op: "finalize_settlement", series: "S1" }, "valid price, exact proceeds 110 × 200 = 22,000 < 60,000 → Failed");
    b.expect("S1", "raise Failed; escrow still held until bids are processed and delivered");
    await b.step({ op: "process_bid", series: "S1", bidder: "b1" }, "failed raise: pending refund = full escrow, no fee");
    await b.revert({ op: "process_bid", series: "S1", bidder: "b1" }, "AlreadyProcessed");
    await b.step({ op: "process_bid", series: "S1", bidder: "b2" });
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "RaiseNotSettled");
    b.expect("S1", "both refunds pending in the auction escrow; mint finalization is irrelevant for a failed raise");
    await b.step({ op: "deliver_bid", series: "S1", bidder: "b1" });
    await b.step({ op: "deliver_bid", series: "S1", bidder: "b2" });
    b.expect("S1", "both bidders fully refunded; fee collector 0; no units; treasury 0");

    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN });
    const s2 = b.sim.series.get("S2")!;
    b.at(ts(2026, 2, 2));
    await b.step({ op: "open_raise", actor: "issuer", series: "S2" });
    b.advance(3600n);
    await b.step({ op: "commit_bid", actor: "b1", series: "S2", price: usdc(130).toString(), quantity: "50", salt: b.bidSalt("S2", "b1", 0), escrow: usdc(10_000).toString() }, "over-collateralised, never revealed");
    b.at(s2.revealEnd + 3600n);
    await b.step({ op: "begin_settlement", series: "S2", clearingPrice: usdc(130).toString(), qAboveClaim: "0", qAtClaim: "0" }, "any proposal is accepted when nothing valid was revealed");
    await b.step({ op: "finalize_settlement", series: "S2" }, "valid_count == 0 → Failed with clearing price 0");
    await b.step({ op: "process_bid", series: "S2", bidder: "b1" }, "failed raise: no non-reveal charge");
    await b.step({ op: "deliver_bid", series: "S2", bidder: "b1" });
    b.expect("S2", "b1 back to 50,000 USDC; fee collector still 0");
    return b.build();
  },
};
