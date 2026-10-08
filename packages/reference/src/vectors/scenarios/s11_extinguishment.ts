import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s11: Scenario = {
  name: "11_extinguishment",
  async build() {
    const b = new ScenarioBuilder(
      "11_extinguishment",
      "Two distinct attestors confirm extinguishment while a payment is due and half the treasury is unreleased: the due is cleared, 21,000 USDC of unreleased proceeds move to the vault with no fee, holders claim pending payouts plus their pro-rata share and units burn; releases and reports are refused afterwards.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    b.at(ts(2026, 4, 2));
    await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(100_000), tier: 2, note: "800 owed and paid" });
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 1 and 2: 21,000 released, 21,000 unreleased");
    b.at(ts(2026, 7, 2));
    await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(150_000), tier: 2, note: "2,000 due, never paid" });
    b.expect("S1", "before extinguishment: due 2,000, treasury 21,000, holders have 190 pending each");

    b.at(ts(2026, 7, 10));
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor1"] }, "SameAttestor");
    await b.step({ op: "revoke_attestor", key: "attestor2" });
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "InvalidAttestorSignature", "revoked key");
    await b.step({ op: "register_attestor", key: "attestor2" });
    await b.step({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "unreleased 21,000 → vault, no fee; open due cleared; status Extinguished");
    b.expect("S1", "finalAccWad = 21,000 / 400 per unit; openDueAmount 0; treasury 0");
    await b.revert({ op: "claim_release", actor: "issuer", series: "S1" }, "SeriesTerminal");
    await b.reportRevert({ series: "S1", period: Q(2026, 3), incomeYtd: usdc(200_000), tier: 2 }, "SeriesTerminal");
    await b.revert({ op: "redeem", actor: "issuer", series: "S1" }, "SeriesTerminal");
    await b.revert({ op: "extinguish", series: "S1", attestors: ["attestor1", "attestor2"] }, "SeriesTerminal");

    await b.step({ op: "claim_final", actor: "b1", series: "S1" }, "190 pending + 5,250 final; 100 units burned");
    b.expect("S1");
    for (const x of ["b2", "b3", "b4"]) await b.step({ op: "claim_final", actor: x, series: "S1" });
    b.expect("S1", "all units burned, vault empty, fee collector unchanged by the final distribution");
    return b.build();
  },
};
