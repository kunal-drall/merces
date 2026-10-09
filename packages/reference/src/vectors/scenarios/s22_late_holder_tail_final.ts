import { ScenarioBuilder, usdc, ts, DAY as DAY_B } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

const WAD = 10n ** 18n;

/** b5 buys `qty` units from `seller` in a transfer window clearing at `price` (supply == demand == qty). */
async function windowBuy(b: ScenarioBuilder, series: string, seller: string, buyer: string, qty: bigint, price: bigint): Promise<void> {
  const s = b.sim.series.get(series)!;
  await b.step({ op: "open_window", series, period: s.ledger.lastPaidPeriod!.toString() });
  const w = s.window!;
  b.advance(3600n);
  await b.step({ op: "commit_ask", actor: seller, series, price: price.toString(), quantity: qty.toString(), salt: b.salt(`${series}:ask:${seller}`), units: qty.toString() });
  b.advance(3600n);
  await b.step({ op: "window_commit_bid", actor: buyer, series, price: price.toString(), quantity: qty.toString(), salt: b.salt(`${series}:bid:${buyer}`), escrow: ((price * qty * 101n) / 100n).toString() });
  b.at(w.commitEnd + 600n);
  await b.step({ op: "reveal_order", actor: seller, series, price: price.toString(), quantity: qty.toString(), salt: b.salt(`${series}:ask:${seller}`) });
  b.advance(60n);
  await b.step({ op: "reveal_order", actor: buyer, series, price: price.toString(), quantity: qty.toString(), salt: b.salt(`${series}:bid:${buyer}`) });
  b.at(w.revealEnd + 600n);
  await b.step({ op: "begin_window_settlement", series, clearingPrice: price.toString() });
  await b.step({ op: "finalize_window", series }, "S = D = qty → supply-limited, matched qty");
  await b.step({ op: "process_orders", series }, `${buyer} buys ${qty} from ${seller}; ${buyer} is registered here with tail/final cursors seeded to 0 (S1 / C-S20)`);
}

export const s22: Scenario = {
  name: "22_late_holder_tail_final",
  async build() {
    const b = new ScenarioBuilder(
      "22_late_holder_tail_final",
      "A holder that joins a series mid-life through a transfer window is still paid its full pro-rata slice of a tail or final pool created later (S1 / C-S20: registration seeds the tail and final cursors to 0, not the live accumulators, so nothing strands in the vault). S1: window buyer b5 (40 of 400 units) redeems after another holder has already claimed tail and receives its full 40/400 tail share. S2: window buyer b5 (40 of 400) receives its full 40/400 of the extinguishment final pool (a back-loaded release schedule keeps treasury unvested at the exit). A permissionless register_holder on the already-terminal S1 (tail pool > 0) also seeds to 0 and strands nothing.",
      { flags: { windowsEnabled: true } },
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(600_000), backerFunds: usdc(80_000), extraAllowlist: ["b5", "b6"] });
    b.actor("b5", "b6");
    await b.fund("b5", usdc(80_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    // S2's last tranche vests two years after settlement, so 25% of the treasury is still unreleased at the mid-2027 exit.
    const backloaded = [
      { atOffsetSeconds: "0", bps: "2500" },
      { atOffsetSeconds: (90n * DAY_B).toString(), bps: "2500" },
      { atOffsetSeconds: (180n * DAY_B).toString(), bps: "2500" },
      { atOffsetSeconds: (730n * DAY_B).toString(), bps: "2500" },
    ];
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN, schedule: backloaded });
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

    // mid-life: b5 joins each series through a window (both pools still 0 → b5's tail/final cursors = 0)
    b.at(lockupEnd("S2") + DAY_B);
    await windowBuy(b, "S1", "b1", "b5", 40n, usdc(120));
    await windowBuy(b, "S2", "b1", "b5", 40n, usdc(120));
    if (b.sim.unitsOf("b5", "S1") !== 40n || b.sim.unitsOf("b1", "S1") !== 60n) throw new Error("S1 window buy");
    b.expect("S1", "after the window: b5 holds 40, b1 60, b2/b3/b4 100; b5 registered mid-life");

    // ---- S1: redemption + tail; the late holder b5 gets its full 40/400 tail share ----
    await b.step({ op: "redeem", actor: "issuer", series: "S1" }, "redeemed mid-2027 (Q2 2027 reported, nothing due); unitsAtRedemption 400 incl. b5's 40");
    if (S("S1").ledger.status !== 5 || S("S1").ledger.tail.tailCapPerUnit === 0n) throw new Error("S1 not redeemed with tail");
    for (const x of ["b1", "b2"]) await b.step({ op: "claim_redemption", actor: x, series: "S1" });
    b.expect("S1", "b1 and b2 redeemed; b3, b4, b5 still hold units");

    b.at(ts(2027, 10, 5));
    const tail = await b.report({ series: "S1", period: Q(2027, 3), incomeYtd: usdc(1_200_000), tier: 2, liquidityEvent: true, note: "liquidity event inside the tail: a large payment fills the tail pool over all 400 redemption units" });
    if (tail.paymentUsd === 0n) throw new Error("tail payment");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "tail pool funded; tailAccWad > 0");
    await b.step({ op: "claim_tail", actor: "b1", series: "S1" }, "b1 (redeemed 100) claims tail first; only b1's own cursor advances");
    const perUnitWad = S("S1").ledger.tail.tailAccWad;
    const b5Before = b.sim.account("b5").stable;
    await b.step({ op: "claim_tail", actor: "b5", series: "S1" }, "b5 (late holder) claim_tail redeems its 40 first (S6 catch-up 0, never claimed tail), then pays the full [0, tailAccWad] slice on 40 units");
    const b5Tail = b.sim.account("b5").stable - b5Before;
    const expectB5 = (perUnitWad * 40n) / WAD + S("S1").ledger.redemptionPrice * 40n;
    if (b5Tail !== expectB5) throw new Error(`b5 tail+redemption ${b5Tail} != ${expectB5}`);
    if ((perUnitWad * 40n) / WAD === 0n) throw new Error("b5 tail slice zero");
    b.expect("S1", "b5 received its full 40/400 tail slice (not 0) plus its redemption; nothing stranded");
    await b.step({ op: "register_holder", series: "S1", holder: "b6" }, "permissionless register on a Redeemed series with tailAccWad > 0: cursors seed to 0 (S1), not the live accumulator; b6 holds nothing");
    await b.revert({ op: "claim_tail", actor: "b6", series: "S1" }, "NoRedeemedUnits", "b6 is registered but holds and redeemed nothing: no tail is owed, and the live tail pool is not misattributed to it");
    if ((b.sim.accounts.get("b6")?.stable ?? 0n) !== 0n) throw new Error("b6 received funds");
    for (const x of ["b2", "b3", "b4"]) await b.step({ op: "claim_tail", actor: x, series: "S1" }, "b2 already redeemed; b3/b4 redeem inside claim_tail — each paid its 100/400 tail slice");
    if (S("S1").vaultBalance !== 0n) throw new Error(`S1 vault not empty: ${S("S1").vaultBalance}`);
    b.expect("S1", "all holders paid their exact unit-weighted tail share; vault empty, nothing stranded");

    // ---- S2: extinguishment + final; the late holder b5 gets its full 40/400 final share ----
    b.at(ts(2027, 11, 2));
    await b.step({ op: "extinguish", series: "S2", attestors: ["attestor1", "attestor2"] }, "the 4th tranche (vests Jan 2028) is still unreleased → final pool over 400 units incl. b5's 40");
    const finalAcc = S("S2").ledger.final.finalAccWad;
    if (finalAcc === 0n) throw new Error("no final pool");
    const b5f0 = b.sim.account("b5").stable;
    await b.step({ op: "claim_final", actor: "b5", series: "S2" }, "b5 (late holder, 40 units) claims its full 40/400 final share");
    const b5Final = b.sim.account("b5").stable - b5f0;
    const expectB5f = (finalAcc * 40n) / WAD;
    if (b5Final !== expectB5f || b5Final === 0n) throw new Error(`b5 final ${b5Final} != ${expectB5f}`);
    b.expect("S2", "b5 received its full 40/400 final slice (not 0)");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim_final", actor: x, series: "S2" });
    if (S("S2").vaultBalance !== 0n) throw new Error(`S2 vault not empty: ${S("S2").vaultBalance}`);
    b.expect("S2", "every holder paid its exact final share; units burned; vault empty, nothing stranded");
    return b.build();
  },
};
