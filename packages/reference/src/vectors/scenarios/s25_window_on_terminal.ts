import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

/** Opens a window with a crossing book (b1 asks 40, buyer bids 40 at the same price) and reveals both. */
async function crossingWindow(b: ScenarioBuilder, series: string, buyer: string, price: bigint): Promise<void> {
  const s = b.sim.series.get(series)!;
  await b.step({ op: "open_window", series, period: s.ledger.lastPaidPeriod!.toString() });
  const w = s.window!;
  b.advance(3600n);
  await b.step({ op: "commit_ask", actor: "b1", series, price: price.toString(), quantity: "40", salt: b.salt(`${series}:ask`), units: "40" });
  b.advance(3600n);
  await b.step({ op: "window_commit_bid", actor: buyer, series, price: price.toString(), quantity: "40", salt: b.salt(`${series}:bid`), escrow: ((price * 40n * 101n) / 100n).toString() });
  b.at(w.commitEnd + 600n);
  await b.step({ op: "reveal_order", actor: "b1", series, price: price.toString(), quantity: "40", salt: b.salt(`${series}:ask`) });
  b.advance(60n);
  await b.step({ op: "reveal_order", actor: buyer, series, price: price.toString(), quantity: "40", salt: b.salt(`${series}:bid`) });
  b.at(w.revealEnd + 600n);
}

export const s25: Scenario = {
  name: "25_window_on_terminal",
  async build() {
    const b = new ScenarioBuilder(
      "25_window_on_terminal",
      "A transfer window whose book would really clear (b1 asks 40 units, b5 bids 40 at the same price → 40 units supply-limited) is mid-settlement when the series goes terminal. finalize_window is forced down the NoMatch path and process_orders refunds every order — no non-consensual trade on a dead series (S3 / C-S5). Shown on both a Redeemed (S1) and an Extinguished (S2) series: the ask units return to b1, the bid escrow returns to b5, and no units change hands.",
      { flags: { windowsEnabled: true } },
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(600_000), backerFunds: usdc(80_000), extraAllowlist: ["b5"] });
    b.actor("b5");
    await b.fund("b5", usdc(80_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    const S = (id: string) => b.sim.series.get(id)!;
    const lockupEnd = (id: string) => S(id).settlementTs + S(id).terms.lockupSeconds;

    const dates: [number, number, number][] = [
      [2026, 4, 2],
      [2026, 7, 2],
      [2026, 10, 2],
      [2027, 1, 3],
      [2027, 4, 2],
      [2027, 7, 2],
    ];
    const ytd = [usdc(60_000), usdc(130_000), usdc(180_000), usdc(230_000), usdc(50_000), usdc(120_000)];
    for (const [q, [y, m, d]] of dates.entries()) {
      b.at(ts(y, m, d));
      for (const id of ["S1", "S2"]) {
        const r = await b.report({ series: id, period: q < 4 ? Q(2026, q + 1) : Q(2027, q - 3), incomeYtd: ytd[q]!, tier: 2 });
        if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: id });
      }
    }

    // ---- S1: redeemed mid-window ----
    b.at(lockupEnd("S2") + 86_400n);
    const b5Stable0 = b.sim.account("b5").stable;
    await crossingWindow(b, "S1", "b5", usdc(120));
    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "the series is redeemed while the (crossing) window is still mid-flight");
    if (S("S1").ledger.status !== 5) throw new Error("S1 not redeemed");
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(120).toString() }, "a proposal at 120 that would clear 40 units on a live series");
    await b.step({ op: "finalize_window", series: "S1" }, "series terminal → forced WindowNoMatch (S3 / C-S5), not WindowCleared");
    if (S("S1").window!.state !== "NoMatch") throw new Error("S1 window not NoMatch");
    await b.step({ op: "process_orders", series: "S1" }, "every order refunded: b1's 40 units returned, b5's escrow returned; no trade");
    if (b.sim.unitsOf("b1", "S1") !== 100n || b.sim.unitsOf("b5", "S1") !== 0n) throw new Error("S1 units moved");
    if (b.sim.account("b5").stable !== b5Stable0) throw new Error("b5 stable changed on S1");
    b.expect("S1", "Redeemed series: window NoMatched, b1 holds its 40 back (100 total), b5 refunded in full, zero units traded");

    // ---- S2: extinguished mid-window ----
    const b5Stable1 = b.sim.account("b5").stable;
    await crossingWindow(b, "S2", "b5", usdc(120));
    await b.step({ op: "extinguish", series: "S2", attestors: ["attestor1", "attestor2"] }, "the series is extinguished while the (crossing) window is mid-flight");
    if (S("S2").ledger.status !== 6) throw new Error("S2 not extinguished");
    await b.step({ op: "begin_window_settlement", series: "S2", clearingPrice: usdc(120).toString() });
    await b.step({ op: "finalize_window", series: "S2" }, "terminal → forced WindowNoMatch");
    if (S("S2").window!.state !== "NoMatch") throw new Error("S2 window not NoMatch");
    await b.step({ op: "process_orders", series: "S2" }, "b1's 40 units returned, b5's escrow returned");
    if (b.sim.unitsOf("b1", "S2") !== 100n || b.sim.unitsOf("b5", "S2") !== 0n) throw new Error("S2 units moved");
    if (b.sim.account("b5").stable !== b5Stable1) throw new Error("b5 stable changed on S2");
    b.expect("S2", "Extinguished series: same — window NoMatched, nothing traded, every order made whole");
    return b.build();
  },
};
