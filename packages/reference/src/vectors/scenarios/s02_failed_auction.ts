import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s02: Scenario = {
  name: "02_failed_auction",
  async build() {
    const b = new ScenarioBuilder(
      "02_failed_auction",
      "Two raises that fail: S1 clears below its minimum raise (full refunds, no fee, no units); S2 has no valid reveal at all (clearing price 0 accepted, raise fails, unrevealed bid refunded without charge).",
    );
    await bootstrap(b, ["b1", "b2"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, terms: { minRaise: usdc(60_000) }, note: "min raise 60,000 USDC" });
    await b.revert({ op: "settle", series: "S1", clearingPrice: "0" }, "RaiseNotOpen");

    // S1: p* = 110, only 200 units sold → proceeds 22,000 < 60,000
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
      await b.step({ op: "commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`S1:bid:${x.actor}:${i}`), escrow: (x.price * x.quantity * 101n / 100n).toString() });
    }
    await b.revert({ op: "cancel_raise", actor: "issuer", series: "S1" }, "BidsExist");
    b.at(s1.commitEnd + 3600n);
    for (const [i, x] of bids.entries()) {
      b.advance(600n);
      await b.step({ op: "reveal_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`S1:bid:${x.actor}:${i}`) });
    }
    await b.revert({ op: "settle", series: "S1", clearingPrice: usdc(110).toString() }, "SettlementNotReady");
    b.at(s1.revealEnd + 3600n);
    await b.step({ op: "settle", series: "S1", clearingPrice: usdc(110).toString() }, "p* = 110 valid, but 110 × 200 = 22,000 < 60,000 → Failed");
    b.expect("S1", "raise Failed; escrow still held until bids are processed");
    await b.step({ op: "process_bid", series: "S1", bidder: "b1" });
    await b.revert({ op: "process_bid", series: "S1", bidder: "b1" }, "AlreadyProcessed");
    await b.step({ op: "process_bid", series: "S1", bidder: "b2" });
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "RaiseNotSettled");
    b.expect("S1", "both bidders fully refunded; fee collector 0; no units; treasury 0");

    // S2: one bidder commits and never reveals
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN });
    const s2 = b.sim.series.get("S2")!;
    b.at(ts(2026, 2, 2));
    await b.step({ op: "open_raise", actor: "issuer", series: "S2" });
    b.advance(3600n);
    await b.step({ op: "commit_bid", actor: "b1", series: "S2", price: usdc(130).toString(), quantity: "50", salt: b.salt("S2:bid:b1"), escrow: usdc(10_000).toString() }, "over-collateralised, never revealed");
    b.at(s2.revealEnd + 3600n);
    await b.revert({ op: "settle", series: "S2", clearingPrice: usdc(130).toString() }, "InvalidClearingPrice", "no valid bid exists, so no positive price can be valid");
    await b.step({ op: "settle", series: "S2", clearingPrice: "0" }, "no valid revealed bids: proposal 0 → Failed (SPEC defect S4)");
    await b.step({ op: "process_bid", series: "S2", bidder: "b1" }, "failed raise: full refund, no non-reveal charge");
    b.expect("S2", "b1 back to 50,000 USDC; fee collector still 0");
    void Q;
    return b.build();
  },
};
