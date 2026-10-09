import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

const U64_PLUS_ONE = (1n << 64n).toString();

export const s21: Scenario = {
  name: "21_entry_rules",
  async build() {
    const b = new ScenarioBuilder(
      "21_entry_rules",
      "§1.1 conventions: the entry-point range rule (a bid escrow, price or quantity, a pause end or a claimed payment_usd of 2^64 revert AmountOutOfRange before any other check; a zero escrow is ZeroEscrow), idempotency of the two-phase bid path (AlreadyProcessed, AlreadyDelivered), and the zero-amount rule: a claim with nothing pending and no units to burn succeeds as a no-op, burn_retired on an empty or unregistered wallet is a no-op, while pay with nothing due still reverts NothingDue.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(400_000), extraAllowlist: ["b5"] });
    b.actor("b5");
    await b.fund("b5", usdc(50_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({
      series: "S1",
      issuer: "issuer",
      openAt: ts(2026, 1, 5),
      bids: FOUR_BACKER_BIDS,
      duringCommit: async () => {
        const ok = { price: usdc(110).toString(), quantity: "10", salt: b.salt("b5"), escrow: (usdc(110) * 10n * 101n / 100n).toString() };
        await b.revert({ op: "commit_bid", actor: "b5", series: "S1", ...ok, escrow: U64_PLUS_ONE }, "AmountOutOfRange", "escrow 2^64");
        await b.revert({ op: "commit_bid", actor: "b5", series: "S1", ...ok, escrow: "0" }, "ZeroEscrow");
        await b.revert({ op: "commit_bid", actor: "b5", series: "S1", ...ok, price: U64_PLUS_ONE }, "AmountOutOfRange", "price 2^64");
        await b.revert({ op: "commit_bid", actor: "b5", series: "S1", ...ok, quantity: U64_PLUS_ONE }, "AmountOutOfRange", "quantity 2^64");
      },
    });
    await b.revert({ op: "process_bid", series: "S1", bidder: "b1" }, "AlreadyProcessed");
    await b.revert({ op: "deliver_bid", series: "S1", bidder: "b1" }, "AlreadyDelivered", "delivery is idempotent: a second call reverts and moves nothing");
    b.expect("S1", "settled: 400 units at 105; b5 never committed");

    b.at(ts(2026, 1, 20));
    await b.step({ op: "claim", actor: "b1", series: "S1" }, "nothing pending, nothing to burn → no-op success (PayoutClaimed 0)");
    await b.revert({ op: "pay", actor: "issuer", series: "S1" }, "NothingDue", "pay is not a claim: nothing due reverts");
    await b.step({ op: "request_pause", actor: "issuer", series: "S1" });
    await b.revert({ op: "approve_pause", series: "S1", pauseEnd: U64_PLUS_ONE, attestor: "attestor1" }, "AmountOutOfRange", "pause_end 2^64");
    await b.step({ op: "withdraw_pause_request", actor: "issuer", series: "S1" });
    b.expect("S1", "unchanged by the no-op claim and the rejected calls");

    b.at(ts(2026, 4, 2));
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(2_705_000), tier: 2, tamperPaymentUsd: 1n << 64n }, "AmountOutOfRange", "claimed payment_usd 2^64 fails the entry rule before the proof is even looked at");
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(2_705_000), tier: 2, note: "owed 4% × 2,625,000 = 105,000 = exactly the cap (262.5 × 400)" });
    if (q1.paymentUsd !== usdc(105_000)) throw new Error("q1");
    await b.step({ op: "pay", actor: "issuer", series: "S1" }, "cap reached exactly: nothing refunded, series Retired");
    b.expect("S1", "Retired; paidPerUnitWad 262.5e24; refundedToIssuer 0");

    await b.step({ op: "claim", actor: "b1", series: "S1" }, "25% of 99,750 and the 100 units burn");
    await b.step({ op: "claim", actor: "b1", series: "S1" }, "second claim: zero stablecoin, zero units → no-op success");
    await b.step({ op: "burn_retired", series: "S1", holder: "b1" }, "nothing to burn → no-op");
    await b.step({ op: "burn_retired", series: "S1", holder: "keeper" }, "never a holder → no-op");
    await b.step({ op: "burn_retired", series: "S1", holder: "b2" }, "burns b2's 100 units; the pending payout stays claimable");
    await b.step({ op: "burn_retired", series: "S1", holder: "b2" }, "already burned → no-op");
    await b.step({ op: "claim", actor: "b2", series: "S1" }, "pending paid, no units left to burn");
    await b.revert({ op: "claim", actor: "b5", series: "S1" }, "HolderNotRegistered", "a precondition, not a zero amount");
    await b.step({ op: "claim", actor: "b3", series: "S1" });
    await b.step({ op: "claim", actor: "b4", series: "S1" });
    b.expect("S1", "all 400 units burned; vault empty; fee collector 420 + 5,250");
    b.at(ts(2026, 10, 12));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "all four tranches");
    b.expect("S1", "releasedTotal == proceeds");
    return b.build();
  },
};
