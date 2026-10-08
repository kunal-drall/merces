import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

const WAD = 10n ** 18n;

export const s14: Scenario = {
  name: "14_amendment",
  async build() {
    const b = new ScenarioBuilder(
      "14_amendment",
      "Favourable amendments: S1 indexes θ 80,000 → 82,400 and lowers the cap 2.5 → 2.4 (attestor-signed, nonce 1); a proof built against the old terms commitment is InvalidProof, the next report pays 4% of income above the new θ. S2 has already paid 250 USDC per unit when its cap is lowered to 2.0 × 105 = 210: the effective cap is max(cap, paid) (no underflow) and a keeper's retire_if_capped retires the series. Reverts: NotIssuer, InvalidAttestorSignature, UnfavourableAmendment (cap up / below bounds), AmendmentAfterTerminal.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"], { issuerFunds: usdc(400_000) });
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.createSeries({ series: "S2", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    await b.raise({ series: "S2", issuer: "issuer", openAt: ts(2026, 1, 15), bids: FOUR_BACKER_BIDS });
    b.expect("S1", "both series settled: 400 units at 105; cap_per_unit 262.5; amendmentNonce 0");

    // S1: indexing amendment before the first report
    b.at(ts(2026, 2, 1));
    const s1Amend = b.prepareAmendment("S1", usdc(82_400));
    await b.revert({ op: "amend_terms", actor: "b1", series: "S1", newTermsCommitment: s1Amend.commitment, newCapMultipleWad: (24n * WAD / 10n).toString(), attestor: "attestor1" }, "NotIssuer");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: s1Amend.commitment, newCapMultipleWad: (24n * WAD / 10n).toString(), attestor: "verifier1" }, "InvalidAttestorSignature", "a report-verifier key is not an attestor");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: s1Amend.commitment, newCapMultipleWad: (26n * WAD / 10n).toString(), attestor: "attestor1" }, "UnfavourableAmendment", "the cap may only decrease");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: s1Amend.commitment, newCapMultipleWad: (19n * WAD / 10n).toString(), attestor: "attestor1" }, "UnfavourableAmendment", "below the 2.0 bound");
    await b.step({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: s1Amend.commitment, newCapMultipleWad: (24n * WAD / 10n).toString(), attestor: "attestor1" }, "θ 80,000 → 82,400 (3% indexing) and cap 2.5 → 2.4; the new terms commitment is Poseidon(5)(82,400e6, r, 840, 0, new salt)");
    b.expect("S1", "amendmentNonce 1; capMultipleWad 2.4e18; cap_per_unit = floor(2.4e18 × 105e6 / 1e18) = 252 USDC (read live); termsCommitment replaced");

    b.at(ts(2026, 4, 2));
    await b.reportRevert({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(90_000), tier: 2 }, "InvalidProof", "proof built against the pre-amendment terms commitment: public input 0 no longer matches the series");
    s1Amend.apply();
    const q1 = await b.report({ series: "S1", period: Q(2026, 1), incomeYtd: usdc(90_000), tier: 2, note: "new θ: owed 4% × (90,000 − 82,400) = 304" });
    if (q1.paymentUsd !== usdc(304)) throw new Error(`S1 q1 ${q1.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S1" });

    // S2: 250 USDC per unit already paid, then the cap is lowered under it
    const q1s2 = await b.report({ series: "S2", period: Q(2026, 1), incomeYtd: usdc(2_580_000), tier: 2, note: "exit proceeds: owed 4% × 2,500,000 = 100,000" });
    if (q1s2.paymentUsd !== usdc(100_000)) throw new Error(`S2 q1 ${q1s2.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S2" }, "100,000 gross on 400 units = 250 per unit < cap 262.5: accepted in full");
    await b.revert({ op: "retire_if_capped", series: "S2" }, "NothingDue", "paid 250 < cap 262.5");
    b.expect("S2", "paidPerUnitWad 250e24; OnTime");
    b.at(ts(2026, 4, 3));
    const s2Amend = b.prepareAmendment("S2", usdc(80_000));
    await b.step({ op: "amend_terms", actor: "issuer", series: "S2", newTermsCommitment: s2Amend.commitment, newCapMultipleWad: (2n * WAD).toString(), attestor: "attestor2" }, "cap 2.5 → 2.0: cap_per_unit 210 < paid 250 → cap_eff = max(210, 250) = 250, remaining room 0");
    s2Amend.apply();
    b.expect("S2", "capPerUnit 210 while paidPerUnitWad 250e24: no underflow, series not yet marked Retired");
    await b.step({ op: "retire_if_capped", series: "S2" }, "keeper crank: cap_eff − paid == 0 → Retired");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S2", newTermsCommitment: b.salt("S2:again"), newCapMultipleWad: (2n * WAD).toString(), attestor: "attestor1" }, "AmendmentAfterTerminal");
    await b.reportRevert({ series: "S2", period: Q(2026, 2), incomeYtd: usdc(3_000_000), tier: 2 }, "TerminalStatus");
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S2" });
    b.expect("S2", "Retired: every holder claimed 23,750 (25% of 95,000) and burned 100 units; unitsOutstanding 0; refundedToIssuer 0");

    // S1 continues under the new terms
    b.at(ts(2026, 4, 15));
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" }, "tranches 1 and 2");
    await b.step({ op: "claim_release", actor: "issuer", series: "S2" }, "a Retired series keeps releasing");
    b.at(ts(2026, 7, 2));
    const q2 = await b.report({ series: "S1", period: Q(2026, 2), incomeYtd: usdc(150_000), tier: 2, note: "owed 4% × 67,600 = 2,704 → payment 2,400" });
    if (q2.paymentUsd !== usdc(2_400)) throw new Error(`S1 q2 ${q2.paymentUsd}`);
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    for (const x of ["b1", "b2", "b3", "b4"]) await b.step({ op: "claim", actor: x, series: "S1" });
    b.expect("S1", "2,704 gross under the amended terms; cap room = 252 − 6.76 per unit");
    return b.build();
  },
};
