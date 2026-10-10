/**
 * Contract templates. These are PLACEHOLDERS so the signing flow runs end to end; counsel supplies the real
 * HEU contract and Autonomy Charter (Phase 0). Placeholders are rendered with {{keys}} from the draft terms.
 * The charter text mirrors C11 so the signed document and the code say the same thing.
 */
export const PLACEHOLDER_HEU_TEMPLATE = `HUMAN EQUITY UNIT (HEU) CONTRACT — PLACEHOLDER TEMPLATE v0 (counsel to replace)

Issuer wallet: {{issuer}} on {{chain}}
Series draft: {{draftId}}
Stablecoin: {{stablecoin}}
Units offered: {{unitsOffered}}
Reserve price per unit: {{reservePrice}} base units
Minimum raise: {{minimumRaise}} base units
Payout cap: {{capMultiple}} × issue price per unit (gross)
Lockup: {{lockupDays}} days from auction settlement
Release schedule: {{releaseSchedule}}
Fees: backers pay {{auctionFeeBps}} bps on cleared bids and {{payoutFeeBps}} bps on payouts; the issuer pays nothing
Reporting currency: {{reportingCurrency}}; reporting period: calendar quarter (UTC)
Terms commitment (Poseidon(5) over BN254 of the threshold θ, the rate per unit r (WAD), the ISO-4217 numeric currency code, the indexing rule code and a random field salt; Stage 1 SPEC §1.5): {{termsCommitment}}

1. The issuer owes, for each quarter, r × units outstanding × max(0, income YTD − θ) minus what was owed year to date, converted at the quarter-average rate; nothing is owed below the threshold θ.
2. Payments are due 30 days after quarter end with 15 days of grace; afterwards simple interest accrues at the series hurdle rate and treasury releases pause until the issuer is current. Nothing is ever slashed.
3. Each unit's gross lifetime payments are capped; at the cap the unit is burned.
4. After the lockup the issuer may redeem the whole series at the formula price; the tail clause applies for 12 months.
5. If this contract and the onchain record disagree, this contract governs.
`;

export const PLACEHOLDER_CHARTER_TEMPLATE = `AUTONOMY CHARTER — PLACEHOLDER TEMPLATE v0 (counsel to replace)

Issuer wallet: {{issuer}} on {{chain}}

1. Capital releases follow the fixed schedule with no approval from anyone. Only a Late status or the issuer's own request pauses them.
2. Onchain data about the issuer is limited to series parameters, the terms commitment, payment amounts, statuses and events. No health, location, relationship or career data, ever.
3. No work obligation: no function can force a payment, and no penalty exists for reporting zero.
4. Units carry no vote. No function whose outcome affects the issuer is gated on holder votes or signatures.
5. The issuer can stop new issuance at any time. Existing series end only through cap, redemption or extinguishment.
6. On death or permanent disability, confirmed by two registered attestors, all claims end; unreleased treasury funds return to holders pro rata.
7. Charter terms have no upgrade path. Only issuer-favourable amendments exist.
`;

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
}
