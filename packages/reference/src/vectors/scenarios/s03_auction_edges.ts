import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s03: Scenario = {
  name: "03_auction_edges",
  async build() {
    const b = new ScenarioBuilder(
      "03_auction_edges",
      "Oversubscribed raise of 300 units: tie at the margin filled pro rata with rounding dust left unsold, an over-collateralised bid, a bid above the wallet cap (invalid, refunded), a bid below reserve, a losing bid below p*, an unrevealed bid charged 1% of escrow, and the phase/commitment reverts.",
    );
    const backers = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"];
    await bootstrap(b, backers, { backerFunds: usdc(30_000) });
    await b.createSeries({
      series: "S1",
      issuer: "issuer",
      plain: STD_PLAIN,
      terms: { unitsOffered: 300n, walletCapBps: 3334, minRaise: usdc(10_000) },
      note: "300 units offered; wallet cap 33.34% → floor(300 × 3334 / 10000) = 100 units",
    });
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
      await b.step({ op: "commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`S1:bid:${x.actor}:${i}`), escrow: esc(x).toString() }, x.note);
    }
    await b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: usdc(100).toString(), quantity: "1", salt: b.salt("dup"), escrow: usdc(101).toString() }, "BidExists");
    await b.revert({ op: "reveal_bid", actor: "b1", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.salt("S1:bid:b1:0") }, "RevealNotStarted");
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
      await b.step({ op: "reveal_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`S1:bid:${x.actor}:${i}`) });
    }
    await b.revert({ op: "reveal_bid", actor: "b1", series: "S1", price: usdc(130).toString(), quantity: "100", salt: b.salt("S1:bid:b1:0") }, "AlreadyRevealed");
    await b.revert({ op: "process_bid", series: "S1", bidder: "b8" }, "RaiseNotSettled");
    b.at(s.revealEnd);
    await b.revert({ op: "reveal_bid", actor: "b8", series: "S1", price: usdc(200).toString(), quantity: "50", salt: b.salt("S1:bid:b8:7") }, "RevealPhaseClosed");
    await b.revert({ op: "settle", series: "S1", clearingPrice: usdc(120).toString() }, "InvalidClearingPrice", "q_above + q_at = 200 < 300 and 120 is not the lowest valid price");
    await b.revert({ op: "settle", series: "S1", clearingPrice: usdc(105).toString() }, "InvalidClearingPrice", "q_above = 355 ≥ 300");
    await b.revert({ op: "settle", series: "S1", clearingPrice: usdc(115).toString() }, "InvalidClearingPrice", "no bid at 115");
    await b.step({ op: "settle", series: "S1", clearingPrice: usdc(110).toString() }, "q_above = 200, q_at = 155, D = 355 ≥ 300 → R = 100");
    b.expect("S1", "Settled at 110: unitsSoldUpper 300, R = 100, q_at = 155");
    for (const x of bids) {
      b.advance(60n);
      await b.step({ op: "process_bid", series: "S1", bidder: x.actor });
    }
    b.expect(
      "S1",
      "b1/b2 100 units each; marginal fills floor(100×60/155)=38, 38 and floor(100×35/155)=22 → 298 sold, 2 units of dust unminted; b6/b9/b7 refunded in full; b8 charged 101 USDC; fee = 1% × 110 × 298 = 327.8 → collector 428.8",
    );
    return b.build();
  },
};
