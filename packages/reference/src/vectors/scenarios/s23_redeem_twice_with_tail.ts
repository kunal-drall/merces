import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

const WAD = 10n ** 18n;

export const s23: Scenario = {
  name: "23_redeem_twice_with_tail",
  async build() {
    const b = new ScenarioBuilder(
      "23_redeem_twice_with_tail",
      "A holder redeems in two batches with a tail claim in between, exercising the redemption-body tail catch-up (S6). b1 parks 40 of its 100 units in a transfer window ask, redeems the other 60, claims the tail (advancing its cursor to T0), then the series-terminal window NoMatches and returns the 40 units (S3); b1 redeems that second batch and is credited the [0, T0] tail slice on the 40 units immediately (catch-up, cursor not reset), then a second liquidity event grows the tail to T1 and b1 claims the [T0, T1] slice on all 100 — so b1's total tail equals 100 units × T1 and nothing strands. Without the catch-up the 40-unit [0, T0] slice would be permanently locked in the vault.",
      { flags: { windowsEnabled: true } },
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(600_000), backerFunds: usdc(80_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    const S = () => b.sim.series.get("S1")!;
    const lockupEnd = () => S().settlementTs + S().terms.lockupSeconds;

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
      const r = await b.report({ series: "S1", period: q < 4 ? Q(2026, q + 1) : Q(2027, q - 3), incomeYtd: ytd[q]!, tier: 2 });
      if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: "S1" });
    }

    // b1 parks 40 units in a window ask (balance → 60), then the series is redeemed with the window still open
    b.at(lockupEnd() + 86_400n);
    await b.step({ op: "open_window", series: "S1", period: S().ledger.lastPaidPeriod!.toString() });
    const w = S().window!;
    b.advance(3600n);
    await b.step({ op: "commit_ask", actor: "b1", series: "S1", price: usdc(120).toString(), quantity: "40", salt: b.salt("ask:b1"), units: "40" }, "b1 escrows 40 units: balance 60, 40 in the window escrow");
    b.at(w.commitEnd + 600n);
    await b.step({ op: "reveal_order", actor: "b1", series: "S1", price: usdc(120).toString(), quantity: "40", salt: b.salt("ask:b1") });
    if (b.sim.unitsOf("b1", "S1") !== 60n) throw new Error("b1 balance after ask");

    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "redeemed while b1's 40 units sit in the window escrow; unitsAtRedemption 400");
    if (S().ledger.status !== 5 || S().ledger.tail.tailCapPerUnit === 0n) throw new Error("not redeemed with tail");
    const pRedeem = S().ledger.redemptionPrice;
    await b.step({ op: "claim_redemption", actor: "b1", series: "S1" }, "batch 1: b1 redeems its 60-unit balance (redeemedUnits 60; tail cursor still 0)");
    for (const x of ["b2", "b3", "b4"]) await b.step({ op: "claim_redemption", actor: x, series: "S1" }, "b2/b3/b4 redeem 100 each");

    // first liquidity event → tail pool T0; b1 claims (advances its cursor to T0 on 60 units)
    b.at(ts(2027, 10, 5));
    const ev1 = await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(300_000), tier: 2, liquidityEvent: true, note: "first liquidity event: modest payment, well under the tail cap, so a second event can still pay" });
    if (ev1.paymentUsd === 0n) throw new Error("ev1");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    const t0 = S().ledger.tail.tailAccWad;
    if (t0 === 0n) throw new Error("t0 zero");
    await b.step({ op: "claim_tail", actor: "b1", series: "S1" }, "b1 claims the T0 slice on its 60 redeemed units; b1's cursor advances to T0");

    // the terminal window NoMatches (S3) and returns b1's 40 units
    await b.step({ op: "begin_window_settlement", series: "S1", clearingPrice: usdc(120).toString() }, "a proposal on a now-Redeemed series");
    await b.step({ op: "finalize_window", series: "S1" }, "series terminal → forced WindowNoMatch (S3 / C-S5); no trade");
    await b.step({ op: "process_orders", series: "S1" }, "b1's 40 units are returned from the window escrow");
    if (b.sim.unitsOf("b1", "S1") !== 40n) throw new Error("b1 units not returned");

    // batch 2: the S6 catch-up pays the [0, T0] slice on the 40 newly redeemed units
    const before = b.sim.account("b1").stable;
    await b.step({ op: "claim_redemption", actor: "b1", series: "S1" }, "batch 2: b1 redeems the returned 40; the catch-up credits the [0, T0] tail slice on them (cursor not reset)");
    const got = b.sim.account("b1").stable - before;
    const catchUp = (t0 * 40n) / WAD;
    if (got !== pRedeem * 40n + catchUp) throw new Error(`batch2 credit ${got} != ${pRedeem * 40n + catchUp}`);
    if (catchUp === 0n) throw new Error("catch-up is zero — S6 not exercised");
    b.expect("S1", `batch 2 paid redemption 40 × ${pRedeem} + tail catch-up ${catchUp} (the [0, T0] slice that would otherwise strand); redeemedUnits 100`);

    // second liquidity event → tail grows to T1; b1 claims the [T0, T1] slice on all 100 units
    b.at(ts(2028, 1, 5));
    const ev2 = await b.report({ series: "S1", period: Q(2027, 4), incomeYtd: usdc(500_000), tier: 2, liquidityEvent: true, note: "second liquidity event grows the tail to T1" });
    if (ev2.paymentUsd === 0n) throw new Error("ev2");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    const t1 = S().ledger.tail.tailAccWad;
    if (t1 <= t0) throw new Error("tail did not grow");
    const b1TailBefore = b.sim.account("b1").stable;
    await b.step({ op: "claim_tail", actor: "b1", series: "S1" }, "b1 claims the [T0, T1] slice on all 100 redeemed units");
    const lateSlice = b.sim.account("b1").stable - b1TailBefore;
    if (lateSlice !== ((t1 - t0) * 100n) / WAD) throw new Error(`late slice ${lateSlice}`);
    // b1's total tail across the three claims == 100 units × T1 (full, nothing forfeited)
    for (const x of ["b2", "b3", "b4"]) await b.step({ op: "claim_tail", actor: x, series: "S1" }, "each gets 100/400 of both events");
    if (S().vaultBalance !== 0n) throw new Error(`vault not empty: ${S().vaultBalance}`);
    b.expect("S1", "all 400 units' tail paid across both events; b1's two batches each got their full slice; vault empty, nothing stranded");
    return b.build();
  },
};
