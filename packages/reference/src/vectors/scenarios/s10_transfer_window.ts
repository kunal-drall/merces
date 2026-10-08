import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import { DAY } from "@merces/sdk";
import type { Scenario } from "./index.js";

export const s10: Scenario = {
  name: "10_transfer_window",
  async build() {
    const b = new ScenarioBuilder(
      "10_transfer_window",
      "Admin enables windows after the first lockups end; a quarterly window clears 35 units at 125 USDC supply-limited (bids above p* fill, the single bid at p* takes the remainder first-come, the ask above p* gets its units back), buyers pay the 1% window fee, sellers' accrued payouts are settled before their balance changes; wrong proposals are rejected (not reverted); lockup, eligibility, one-order-per-wallet, wallet-cap (invalid order) and direct-transfer rejections.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4", "b5", "b6", "b7"], { backerFunds: usdc(60_000) });
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
      if (period === Q(2026, 2)) await b.revert({ op: "open_window", series: "S1", period: Q(2026, 1).toString() }, "WindowsDisabled", "windows ship closed");
    }
    await b.step({ op: "set_flags", windowsEnabled: true }, "admin enables transfer windows");
    await b.revert({ op: "open_window", series: "S1", period: Q(2027, 1).toString() }, "LockupActive", "18-month lockup still running on 2 July 2027");
    b.expect("S1", "before the window: 400 units, holders have unclaimed payouts");

    const lockupEnd = s.settlementTs + s.terms.lockupSeconds;
    b.at(lockupEnd + DAY);
    await b.revert({ op: "open_window", series: "S1", period: Q(2027, 1).toString() }, "WindowNotEligible", "the window must follow the just-reported quarter (Q2 2027)");
    await b.step({ op: "open_window", series: "S1", period: Q(2027, 2).toString() }, "3-day commit, 1-day reveal");
    await b.revert({ op: "open_window", series: "S1", period: Q(2027, 2).toString() }, "WindowOpen");
    await b.revert({ op: "transfer_units", actor: "b1", series: "S1", to: "b5", units: "10" }, "DirectTransferForbidden", "direct transfers never pass, lockup or not");

    const w = s.window!;
    const asks = [
      { actor: "b1", price: usdc(120), quantity: 20n },
      { actor: "b2", price: usdc(125), quantity: 15n },
      { actor: "b3", price: usdc(130), quantity: 10n },
    ];
    const bids = [
      { actor: "b5", price: usdc(125), quantity: 30n },
      { actor: "b6", price: usdc(128), quantity: 20n },
      { actor: "b7", price: usdc(126), quantity: 41n, note: "41 units > wallet cap floor(400 × 10%) = 40 → invalid at reveal, refunded" },
    ];
    for (const [i, a] of asks.entries()) {
      b.advance(3600n);
      await b.step({ op: "commit_ask", actor: a.actor, series: "S1", price: a.price.toString(), quantity: a.quantity.toString(), salt: b.salt(`ask:${a.actor}:${i}`), units: a.quantity.toString() }, "armed escrow deposit: settle_holder first, units into the window escrow, accrual weight unchanged");
    }
    await b.revert({ op: "commit_ask", actor: "b1", series: "S1", price: usdc(121).toString(), quantity: "5", salt: b.salt("dup"), units: "5" }, "OrderExists");
    await b.revert({ op: "window_commit_bid", actor: "b1", series: "S1", price: usdc(121).toString(), quantity: "5", salt: b.salt("dup2"), escrow: usdc(700).toString() }, "OrderExists", "one order per wallet, either side");
    await b.revert({ op: "commit_ask", actor: "b4", series: "S1", price: usdc(121).toString(), quantity: "101", salt: b.salt("too-many"), units: "101" }, "InsufficientUnits");
    for (const [i, x] of bids.entries()) {
      b.advance(3600n);
      const escrow = (x.price * x.quantity * 101n) / 100n;
      await b.step({ op: "window_commit_bid", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`bid:${x.actor}:${i}`), escrow: escrow.toString() }, x.note);
    }
    await b.revert({ op: "window_commit_bid", actor: "stranger", series: "S1", price: usdc(125).toString(), quantity: "1", salt: b.salt("x"), escrow: usdc(200).toString() }, "NotAllowlisted");
    b.actors.add("stranger");
    b.expect("S1", "45 units and the bidders' stablecoin in the window escrow");
    await b.revert({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(125).toString() }, "SettlementNotReady");

    b.at(w.commitEnd + 600n);
    for (const [i, a] of asks.entries()) {
      b.advance(60n);
      await b.step({ op: "reveal_order", actor: a.actor, series: "S1", price: a.price.toString(), quantity: a.quantity.toString(), salt: b.salt(`ask:${a.actor}:${i}`) });
    }
    for (const [i, x] of bids.entries()) {
      b.advance(60n);
      await b.step({ op: "reveal_order", actor: x.actor, series: "S1", price: x.price.toString(), quantity: x.quantity.toString(), salt: b.salt(`bid:${x.actor}:${i}`) }, x.actor === "b7" ? "recorded invalid (cap), never reverts" : undefined);
    }
    await b.revert({ op: "process_orders", series: "S1" }, "WindowNotOpen", "nothing to process before settlement");
    b.at(w.revealEnd + 600n);
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: "NO_MATCH" }, "round 1: NO_MATCH");
    await b.step({ op: "finalize_window", series: "S1" }, "max_bid 128 ≥ min_ask 120 → WindowSettlementRejected");
    b.expect("S1", "round 1 rejected");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(120).toString() }, "round 2: 120");
    await b.step({ op: "finalize_window", series: "S1" }, "d_above = 50 ≥ S = 20 and D = 50 > S → neither branch → rejected");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(130).toString() }, "round 3: 130");
    await b.step({ op: "finalize_window", series: "S1" }, "S = 45 > D = 0 but D must be > 0 → rejected");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(125).toString() }, "round 4: 125");
    await b.step({ op: "finalize_window", series: "S1" }, "S = 35 (asks at 120 and 125), D = 50 (bids at 128 and 125), d_above = 20 < 35 ≤ 50 → supply-limited, matched 35, marginal remaining 15");
    b.expect("S1", "window settled (branch SupplyLimited)");
    await b.step({ op: "process_orders", series: "S1" }, "b6 buys 20, b5 (only bid at p*) buys 15 first-come; b1 sells 20, b2 sells 15, b3 gets 10 back; b7 refunded; fees 1% of 2,500 and 1,875");
    b.expect("S1", "units: b1 80, b2 85, b3 100, b4 100, b5 15, b6 20; fee collector up by 43.75; sellers' pending payouts preserved");

    b.at(ts(2027, 10, 2));
    await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(220_000), tier: 2, note: "owed 4% × 140,000 = 5,600 → payment 4,000" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4", "b5", "b6"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "b5 and b6 receive 15/400 and 20/400 of this quarter only; b1 and b2 keep what accrued on 100 units before the window");
    await b.revert({ op: "claim", actor: "b7", series: "S1" }, "HolderNotRegistered");
    return b.build();
  },
};
