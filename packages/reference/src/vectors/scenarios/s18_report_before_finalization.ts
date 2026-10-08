import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s18: Scenario = {
  name: "18_report_before_finalization",
  async build() {
    const b = new ScenarioBuilder(
      "18_report_before_finalization",
      "Settled raise with one bid still unprocessed: the mint is not finalized, units_outstanding is still 0, and submit_report, pay, claim_release, retire_if_capped and redeem all revert MintNotFinalized; split-router receipts are held in the router account. Processing the last bid finalizes the mint (units_outstanding = 400); releases flow, the held income is routed with the next receipt and the Q1 report is accepted.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    b.actor("client");
    await b.fund("client", usdc(500_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN, tierFlags: 3, router: true, note: "tier 1|2: on-chain router plus attested proofs" });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS, skipProcess: ["b4"] });
    const s = b.sim.series.get("S1")!;
    if (s.auction.mintFinalized || s.ledger.unitsOutstanding !== 0n) throw new Error("finalized too early");
    b.expect("S1", "Settled at 105, units_sold 400 but bids_processed 3 of 4: units_minted 300, mintFinalized false, unitsOutstanding 0 (stored only at finalization); b4's escrow still held");

    b.at(ts(2026, 1, 20));
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "MintNotFinalized", "tranche 1 is vested but releases wait for finalization");
    b.at(ts(2026, 2, 10));
    await b.step({ op: "route_income", series: "S1", payer: "client", amount: usdc(30_000).toString() }, "receipts before finalization accumulate in the router's receiving account (IncomeHeld)");
    b.expect("S1", "routerBalance 30,000; nothing passed through, nothing routed");

    b.at(ts(2026, 4, 2));
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(30_000), tier: 2 }, "MintNotFinalized");
    await b.revert({ op: "pay", actor: "issuer", series: "S1" }, "MintNotFinalized");
    await b.revert({ op: "retire_if_capped", series: "S1" }, "MintNotFinalized");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "MintNotFinalized");
    b.at(ts(2026, 4, 3));
    await b.step({ op: "process_bid", series: "S1", bidder: "b4" }, "last bid: units_minted 400 == units_sold → RaiseMintFinalized; unitsOutstanding = 400");
    await b.step({ op: "deliver_bid", series: "S1", bidder: "b4" });
    const after = b.sim.series.get("S1")!;
    if (!after.auction.mintFinalized || after.ledger.unitsOutstanding !== 400n) throw new Error("not finalized");
    b.expect("S1", "mint finalized; every bidder holds 100 units; auction escrow empty");
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranche 1 (settlement + 0 d); tranche 2 vests mid-April");
    b.at(ts(2026, 4, 4));
    await b.step({ op: "route_income", series: "S1", payer: "client", amount: usdc(60_000).toString() }, "held 30,000 + 60,000 = 90,000 routed in one go: 80,000 passes through, 4% of 10,000 = 400 to the vault (fee 20); routerCredit 400");
    b.expect("S1", "routerBalance 0; issuer received 89,600; vault 380");
    b.at(ts(2026, 4, 5));
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(30_000), tier: 2, note: "Q1 attested income 30,000 < θ → payment 0" });
    if (q1.paymentUsd !== 0n) throw new Error("q1");
    b.expect("S1", "Q1 accepted; OnTime; routerCredit 400 carried to Q2");
    b.at(ts(2026, 7, 2));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(90_000), tier: 2, note: "payment 400 fully covered by the router credit → due 0" });
    if (q2.paymentUsd !== usdc(400) || q2.due !== 0n) throw new Error("q2");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "each holder claimed 95 USDC (25% of 380)");
    return b.build();
  },
};
