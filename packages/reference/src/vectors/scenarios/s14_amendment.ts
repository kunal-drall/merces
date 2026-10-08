import { ScenarioBuilder, usdc, ts } from "../builder.js";
import { FOUR_BACKER_BIDS, Q, STD_PLAIN, bootstrap } from "./common.js";
import type { Scenario } from "./index.js";

export const s14: Scenario = {
  name: "14_amendment",
  async build() {
    const b = new ScenarioBuilder(
      "14_amendment",
      "Favourable amendment (θ indexed from 80,000 to 82,400, cap multiple lowered 2.5 → 2.4) accepted with the issuer's and an attestor's signatures; later proofs must open the new commitment. Unfavourable attempts (cap increase, cap below bounds, non-attestor, non-issuer) are rejected.",
    );
    await bootstrap(b, ["b1", "b2", "b3", "b4"]);
    await b.createSeries({ series: "S1", issuer: "issuer", plain: STD_PLAIN });
    await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: FOUR_BACKER_BIDS });
    const s = b.sim.series.get("S1")!;
    const plan: [number, bigint, [number, number, number]][] = [
      [Q(2026, 1), usdc(50_000), [2026, 4, 2]],
      [Q(2026, 2), usdc(100_000), [2026, 7, 2]],
      [Q(2026, 3), usdc(150_000), [2026, 10, 2]],
      [Q(2026, 4), usdc(200_000), [2027, 1, 3]],
    ];
    for (const [period, ytd, [y, m, d]] of plan) {
      b.at(ts(y, m, d));
      const r = await b.report({ series: "S1", period, incomeYtd: ytd, tier: 2 });
      if (r.due > 0n) await b.step({ op: "pay", actor: "issuer", series: "S1" });
    }
    b.expect("S1", "2026: 4,800 gross paid; amendmentNonce 0; cap 2.5 → capPerUnit 262.5");

    b.at(ts(2027, 1, 10));
    const amended = b.prepareAmendment("S1", usdc(82_400));
    const cap24 = (24n * 10n ** 18n) / 10n;
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: (26n * 10n ** 18n / 10n).toString(), attestor: "attestor1" }, "UnfavourableAmendment", "cap multiple may only decrease");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: (19n * 10n ** 18n / 10n).toString(), attestor: "attestor1" }, "UnfavourableAmendment", "below the 2.0 bound");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: cap24.toString(), attestor: "verifier1" }, "InvalidAttestorSignature");
    await b.revert({ op: "amend_terms", actor: "b1", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: cap24.toString(), attestor: "attestor1" }, "NotIssuer");
    await b.step({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: cap24.toString(), attestor: "attestor1" }, "θ → 82,400 (yearly indexation), cap 2.5 → 2.4: issuer-favourable, nonce 0 → 1");
    if (s.vault.capPerUnit !== 252_000_000n) throw new Error(`cap ${s.vault.capPerUnit}`);
    b.expect("S1", "termsCommitment replaced; amendmentNonce 1; capMultipleWad 2.4e18; capPerUnit 252");

    b.at(ts(2027, 4, 2));
    await b.reportRevert({ series: "S1", period: Q(2027, 1), incomeYtd: usdc(90_000), tier: 2 }, "InvalidProof", "a proof opening the OLD commitment no longer matches the registry");
    amended.apply();
    const r = await b.report({ series: "S1", period: Q(2027, 1), incomeYtd: usdc(90_000), tier: 2, note: "new θ: owed 4% × (90,000 − 82,400) = 304" });
    if (r.paymentUsd !== usdc(304)) throw new Error("payment");
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    b.expect("S1", "payment under the amended terms; the lower cap applies from now on");
    await b.revert({ op: "amend_terms", actor: "issuer", series: "S1", newTermsCommitment: amended.commitment, newCapMultipleWad: (25n * 10n ** 18n / 10n).toString(), attestor: "attestor2" }, "UnfavourableAmendment", "cannot go back up to 2.5");
    return b.build();
  },
};
