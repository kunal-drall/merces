# MATH_PARITY.md

Stage 1 math imported at 1bfc66b; interim families remaining: fixed point, time and periods, payment, vault and claims, redemption and tail, status and lateness, FX (S5), auction (S2).

- Stage 1 math package: packages/reference at 1bfc66b.
- `@merces/math` re-exports 34 Stage 1 reference names (status, vault, redemption, treasury, income); 34 are Stage 1's own objects. It also re-exports `@merces/sdk`'s fixed point, periods, pauses, year ring, parameters and error names.
- No function-by-function comparison: the gateway runs Stage 1's functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file's git history.
- The interim (Part C) math survives only under `interim.*` until each caller moves to Stage 1; S1 removes all of it except the auction family (S2) and the FX family (S5).

| Interim family | Names still exported under `interim` |
| --- | --- |
| fixed point | `WAD`, `BPS`, `assertNonNegative`, `mulDiv`, `wadMul`, `wadDiv`, `wadFromDecimal`, `wadToDecimal`, `bpsOf`, `min`, `max`, `pow`, `wadPow1p` |
| time and periods | `DAY`, `YEAR_DAYS`, `periodOf`, `periodFrom`, `parsePeriod`, `previousPeriod`, `nextPeriod`, `periodsBetween`, `comparePeriods`, `utcDayIndex`, `daysBetween`, `yearsSince` |
| payment | `ratePerUnit`, `owedYtd`, `periodPayment`, `toStablecoin`, `quarterPayment` |
| vault and claims | `perUnitCap`, `applyGrossPayment`, `capRemaining`, `accrueNet`, `claimable`, `rewardDebt`, `payoutFee`, `DEFAULT_PAYOUT_FEE_BPS` |
| redemption and tail | `hurdlePrice`, `averageAnnualPayout`, `redemptionQuote`, `tailPayoutPerUnit` |
| status and lateness | `DEFAULT_DUE_DAYS`, `DEFAULT_GRACE_DAYS`, `DEFAULT_FORMAL_NOTICE_DAYS`, `deadlinesFor`, `daysLate`, `lateAccrual`, `periodStanding` |
| FX (S5) | `DEFAULT_MIN_COVERAGE_BPS`, `quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`, `pythToWad` |
| auction (S2) | `clearAuction`, `walletCapUnits`, `bidDeposit`, `auctionFee`, `DEFAULT_AUCTION_FEE_BPS` |
