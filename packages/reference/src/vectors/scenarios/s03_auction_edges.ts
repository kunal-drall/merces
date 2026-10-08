import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s03: Scenario = {
  name: "03_auction_edges",
  async build() {
    const b = new ScenarioBuilder(
      "03_auction_edges",
      "Oversubscribed raise of 300 units: tie at the margin filled pro rata with rounding dust excluded from units_sold in one pass, an over-collateralised bid, a bid above the wallet cap (invalid, refunded), a bid below reserve, a losing bid below p*, an unrevealed bid charged 1% of escrow, two rejected proposals (wrong price, wrong claims) before the right one, and the phase/commitment reverts.",
    );
    const backers = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"];
    await bootstrap(b, backers, { backerFunds: usdc(30_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, terms: { unitsOffered: 300n, walletCapBps: 3334, minRaise: usdc(10_000) }, note: "300 units offered; wallet cap 33.34% → floor(300 × 3334 / 10000) = 100 units" });
    await b.revert(
      { op: "create_series", actor: "issuer", series: "Sx", terms: b.terms({ unitsOffered: 5n, walletCapBps: 1000 }), releaseSchedule: b.quarterlySchedule(), termsCommitment: b.salt("x"), contractHash: b.salt("c"), tierFlags: 2, fxPairId: null },
      "InvalidTerms",
      "floor(5 × 10%) = 0: no bid could ever be valid",
    );
    const s = b.sim.series.get("S1")!;
    const bids = [
      { actor: "b1", price: usdc(130), quantity: 100n, escrow: usdc(20_000), note: "over-collateralised (needs 13,130)" },
      { actor: "b2", price: usdc(120), quantity: 100n },
      { actor: "b3", price: usdc(110), quantity: 60n, note: "at the margin" },
      { actor: "b4", price: usdc(110), quantity: 60n, note: "at the margin" },
      { actor: "b5", price: usdc(110), quantity: 35n, note: "at the margin" },
      { actor: "b6", price: usdc(105), quantity: 50n, note: "valid but below p*" },
      { actor: "b7", price: usdc(150), quantity: 101n, note: "101 units > wallet cap 100 → invalid" },
      { actor: "b8", price: usdc(200), quantity: 50n, note: "never revealed → 1% non-reveal charge" },
      { actor: "b9", price: usdc(90), quantity: 100n, note: "below reserve → invalid" },
    ];
    const esc = (x: (typeof bids)[number]) => x.escrow ?? (x.price * x.quantity * 101n) / 100n;
    b.at(ts(2026, 1, 5));
    await b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: "1", quantity: "1", salt: b.salt("pre"), escrow: "1" }, "RaiseNotOpen");
    await b.step({ op: "open_raise", actor: "issuer", series: "S1" });
    for (const [i, x] of bids.entries()) {
      b.advance(3600n);
      await b.step({ op: "commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i), escrow: esc(x).toString() }, x.note);
    }
    await b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: usdc(100).toString(), quantity: "1", salt: b.salt("dup"), escrow: usdc(101).toString() }, "BidExists");
    await b.revert({ op: "reveal_bid", actor: "b1", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.bidSalt("S1", "b1", 0) }, "RevealNotStarted");
    b.expect("S1", "nine bids committed; escrow held");
    b.at(s.commitEnd);
    await b.revert({ op: "commit_bid", actor: "keeper", series: "S1", price: usdc(100).toString(), quantity: "1", salt: b.salt("late"), escrow: usdc(101).toString() }, "NotAllowlisted");
    await b.step({ op: "allowlist", wallets: ["keeper"] });
    await b.revert({ op: "commit_bid", actor: "keeper", series: "S1", price: usdc(100).toString(), quantity: "1", salt: b.salt("late"), escrow: usdc(101).toString() }, "CommitPhaseClosed");
    await b.revert({ op: "reveal_bid", actor: "b1", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.salt("wrong") }, "CommitmentMismatch");
    await b.revert({ op: "reveal_bid", actor: "keeper", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.salt("wrong") }, "BidNotFound");
    for (const [i, x] of bids.entries()) {
      if (x.actor === "b8") continue;
      b.advance(600n);
      await b.step({ op: "reveal_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.bidSalt("S1", x.actor, i) }, x.actor === "b7" || x.actor === "b9" ? "recorded invalid, never reverts" : undefined);
    }
    await b.revert({ op: "reveal_bid", actor: "b1", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.bidSalt("S1", "b1", 0) }, "AlreadyRevealed");
    await b.revert({ op: "process_bid", series: "S1", bidder: "b8" }, "RaiseNotSettled");
    b.expect("S1", "8 revealed, 6 valid");
    b.at(s.revealEnd);
    await b.revert({ op: "reveal_bid", actor: "b8", series: "S1", price: usdc(200).toString(), quantity: "50", salt: b.bidSalt("S1", "b8", 7) }, "RevealPhaseClosed");
    // round 1: wrong price (120) with honest claims for 120 → rejected, no revert
    await b.step({ op: "begin_settlement", series: "S1", clearingPrice: usdc(120).toString(), qAboveClaim: "100", qAtClaim: "100" }, "round 1: 120 (q_above 100, q_at 100)");
    await b.revert({ op: "begin_settlement", series: "S1", clearingPrice: usdc(110).toString(), qAboveClaim: "200", qAtClaim: "155" }, "TallyInProgress", "a round in progress cannot be reset");
    await b.step({ op: "finalize_settlement", series: "S1" }, "q_above + q_at = 200 < 300 and 120 is not the lowest valid price (105) → SettlementRejected(InvalidClearingPrice)");
    b.expect("S1", "round 1 rejected; raise still Settling");
    // round 2: right price, wrong claims
    await b.step({ op: "begin_settlement", series: "S1", clearingPrice: usdc(110).toString(), qAboveClaim: "200", qAtClaim: "150" }, "round 2: 110 with a wrong q_at claim");
    await b.step({ op: "finalize_settlement", series: "S1" }, "tally says q_at = 155 → SettlementRejected(ClaimMismatch)");
    b.expect("S1", "round 2 rejected");
    // round 3: honest
    await b.step({ op: "begin_settlement", series: "S1", clearingPrice: usdc(110).toString(), qAboveClaim: "200", qAtClaim: "155" }, "round 3: r_claim = min(300 − 200, 155) = 100");
    await b.step({ op: "finalize_settlement", series: "S1" }, "alloc_sum = floor(100×60/155) + floor(100×60/155) + floor(100×35/155) = 38 + 38 + 22 = 98 → units_sold 298, proceeds 32,780 exact");
    b.expect("S1", "Settled at 110: unitsSold 298 (2 units of dust never minted), proceeds 110 × 298");
    for (const x of bids) {
      b.advance(60n);
      await b.step({ op: "process_bid", series: "S1", bidder: x.actor });
    }
    b.expect("S1", "all bids processed: units minted to the auction escrow, cost → treasury, fees + b8's 101 USDC charge → collector; mint finalized (units_minted == units_sold)");
    for (const x of bids) {
      b.advance(60n);
      await b.step({ op: "deliver_bid", series: "S1", bidder: x.actor });
    }
    b.expect("S1", "b1/b2 100 units each; b3 38, b4 38, b5 22; b6/b9/b7 refunded in full; b8 refunded 9,999; fee = 1% × 32,780 = 327.8 → collector 428.8");
    return b.build();
  },
};
