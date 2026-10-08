import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s11: Scenario = {
  name: "11_extinguishment",
  async build() {
    const b = new ScenarioBuilder(
      "11_extinguishment",
      "Two distinct attestors confirm extinguishment while a payment is due and half the treasury is unvested: the due is cleared, the 21,000 USDC not yet vested by the schedule moves to the vault with no fee (the estate keeps what had vested), holders claim pending payouts plus their pro-rata share and units burn; releases, reports, redemption and amendments are refused afterwards.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 4, 2));
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(100_000), tier: 2, note: "800 owed and paid" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 1 and 2 (vested 14 January and 14 April): 21,000 released");
    b.at(ts(2026, 7, 2));
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(150_000), tier: 2, note: "2,000 due, never paid" });
    b.expect("S1", "before extinguishment: due 2,000, treasury 21,000 (tranches 3 and 4 vest 13 July and 11 October), holders have 190 pending each");

    b.at(ts(2026, 7, 10));
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor1"] }, "SameAttestor");
    await b.step({ op: "revoke_attestor", key: "attestor2" });
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "InvalidAttestorSignature", "revoked key");
    await b.step({ op: "register_attestor", key: "attestor2" });
    await b.step({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "unreleased = proceeds − vested(now) = 42,000 − 21,000 → vault, no fee; open due cleared; status Extinguished; final_units 400");
    b.expect("S1", "finalAccWad = 21,000 / 400 per unit; openDueAmount 0; treasury 0; extinguishedAt set");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "NothingVested", "the estate may only claim what had vested by extinguishment, and that was already released");
    await b.reportRevert({ series: "S1", period: Q(2026, 3), incomeYtd: usdc(200_000), tier: 2 }, "TerminalStatus");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "TerminalStatus");
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "TerminalStatus");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: b.salt("new"), newCapMultipleWad: (24n * 10n ** 17n).toString(), attestor: "attestor1" }, "AmendmentAfterTerminal");

    await b.step({ op: "claim_final", actor: "b1", series: "S1" }, "190 pending + 5,250 final; 100 units burned");
    b.expect("S1");
    for (const x of ["b2", "b3", "b4"]) await b.step({ op: "claim_final", actor: x, series: "S1" });
    b.expect("S1", "all units burned, vault empty, fee collector unchanged by the final distribution");
    return b.build();
  },
};
