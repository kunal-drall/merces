# MATH_PARITY.md

Stage 1 math: packages/reference (compared function by function on deterministic inputs; Stage 1 is the reference).

| Family | Ours | Stage 1 | Cases | Disagreements |
| --- | --- | --- | --- | --- |
| owed YTD | `owedYtd` | `owedYtd` | 302 | 0 |
| quarter payment in stablecoin | `quarterPayment().paymentStable` | `paymentUsd` | 300 | 0 |
| per-unit cap | `perUnitCap` | `capPerUnit` | 300 | 0 |
| wallet cap at the auction | `walletCapUnits` | `walletCapUnitsAtAuction` | 300 | 0 |
| bid escrow (price × quantity + auction fee) | `bidDeposit` | `requiredEscrow` | 300 | 0 |
| hurdle price | `hurdlePrice` | `hurdlePrice` | 303 | **221** |
| late accrual | `lateAccrual` | `lateAccrual` | 300 | **143** |
| vault receipt sequence (cap, payout fee, accumulator) | `applyGrossPayment + payoutFee + accrueNet` | `vaultReceiveGross` | 150 | **102** |
| holder claim since last settlement | `claimable(units, acc, rewardDebt(units, last))` | `settleHolderDelta` | 300 | **145** |
| remaining cap at redemption | `capRemaining` | `redemptionQuote` | 300 | 0 |
| redemption price | `redemptionQuote` | `redemptionQuote` | 300 | **137** |
| auction clearing | `clearAuction` | `findClearingPrice` | 300 | **121** |

## wallet cap at the auction

Inputs with a cap of at least one unit only: Stage 1 refuses to create a series whose cap rounds to 0, where ours would round up to 1.


## hurdle price

- input `{"h":"63424355743905193","p0":"964959146","t":"78191487"}`
  - ours `"1124427127"`
  - Stage 1 `"1124427126"`
- input `{"h":"102182344375991692","p0":"613677703","t":"192909626"}`
  - ours `"1113340044"`
  - Stage 1 `"1113340040"`
- input `{"h":"109304545580874819","p0":"277449087","t":"263676343"}`
  - ours `"661306133"`
  - Stage 1 `"661306126"`

## late accrual

Stage 1 takes a ledger clock; the clock here has no pauses and no grace, so its late days equal the day count passed to ours.

- input `{"amount":"500659376458","days":516,"h":"232390936365803794"}`
  - ours `"164481999639"`
  - Stage 1 `"164481999638"`
- input `{"amount":"122650315808","days":740,"h":"128811977780018146"}`
  - ours `"32030504159"`
  - Stage 1 `"32030504158"`
- input `{"amount":"867450094121","days":281,"h":"236529425351232470"}`
  - ours `"157958547155"`
  - Stage 1 `"157958547154"`

## vault receipt sequence (cap, payout fee, accumulator)

Each case is up to six receipts on one series; compared per receipt (accepted, refund, fee, paid per unit, retired) and the net accumulator after each.

- input `{"bps":"929","m":"2087329406428363372","p0":"54160836","receipts":["99078850365","26972681182","90838841346","72528378067"],"units":"506064"}`
  - ours `[{"accepted":"99078850365","fee":"9204425198","netAccWad":"177594978435533845521515","paidPerUnitWad":"195783241576164279616807","refund":"0","retired":false},{"accepted":"26972681182","fee":"2505762081","netAccWad":"225942458400518511492617","paidPerUnitWad":"249082194242230231749343","refund":"0","retired":false},{"accepted":"90838841346","fee":"8438928361","netAccWad":"388767541759540295298617","paidPerUnitWad":"428582892466170286762147","refund":"0","retired":false},{"accepted":"72528378067","fee":"6737886322","netAccWad":"518771833202915046318250","paidPerUnitWad":"571901480761326630623792","refund":"0","retired":false}]`
  - Stage 1 `[{"accepted":"99078850365","fee":"9204425198","netAccWad":"177594978435533845521515","paidPerUnitWad":"195783241576164279616807","refund":"0","retired":false},{"accepted":"26972681182","fee":"2505762081","netAccWad":"225942458400518511492617","paidPerUnitWad":"249082194242230231749343","refund":"0","retired":false},{"accepted":"90838841346","fee":"8438928361","netAccWad":"388767541759540295298618","paidPerUnitWad":"428582892466170286762147","refund":"0","retired":false},{"accepted":"72528378067","fee":"6737886322","netAccWad":"518771833202915046318252","paidPerUnitWad":"571901480761326630623792","refund":"0","retired":false}]`
- input `{"bps":"770","m":"2540140470592091518","p0":"29220406","receipts":["82283520782","68292231635","97907630226"],"units":"467854"}`
  - ours `[{"accepted":"82283520782","fee":"6335831100","netAccWad":"162332030253027653926224","paidPerUnitWad":"175874355636587482419729","refund":"0","retired":false},{"accepted":"68292231635","fee":"5258501835","netAccWad":"297061518084701637690389","paidPerUnitWad":"321843464877932004428731","refund":"0","retired":false},{"accepted":"97907630226","fee":"7538887527","netAccWad":"490217380167744638284591","paidPerUnitWad":"531113087935552544169761","refund":"0","retired":false}]`
  - Stage 1 `[{"accepted":"82283520782","fee":"6335831100","netAccWad":"162332030253027653926224","paidPerUnitWad":"175874355636587482419729","refund":"0","retired":false},{"accepted":"68292231635","fee":"5258501835","netAccWad":"297061518084701637690390","paidPerUnitWad":"321843464877932004428731","refund":"0","retired":false},{"accepted":"97907630226","fee":"7538887527","netAccWad":"490217380167744638284593","paidPerUnitWad":"531113087935552544169761","refund":"0","retired":false}]`
- input `{"bps":"308","m":"1635329945878972082","p0":"18837470","receipts":["52451696589","54648876667","83885610153","22807446561","892676089","9584254062"],"units":"991973"}`
  - ours `[{"accepted":"52451696589","fee":"1615512254","netAccWad":"51247548406055406749982","paidPerUnitWad":"52876133311088104212513","refund":"0","retired":false},{"accepted":"54648876667","fee":"1683185401","netAccWad":"104641835615485502125561","paidPerUnitWad":"107967226180551285166026","refund":"0","retired":false},{"accepted":"83885610153","fee":"2583676792","netAccWad":"186601660490759325102597","paidPerUnitWad":"192531634841875736537182","refund":"0","retired":false},{"accepted":"22807446561","fee":"702469354","netAccWad":"208885510159046667600830","paidPerUnitWad":"215523638213943323054153","refund":"0","retired":false},{"accepted":"892676089","fee":"27494423","netAccWad":"209757692835389672904401","paidPerUnitWad":"216423537796895681636493","refund":"0","retired":false},{"accepted":"9584254062","fee":"295195025","netAccWad":"219121918511894981012585","paidPerUnitWad":"226085347202998468708318","refund":"0","retired":false}]`
  - Stage 1 `[{"accepted":"52451696589","fee":"1615512254","netAccWad":"51247548406055406749982","paidPerUnitWad":"52876133311088104212513","refund":"0","retired":false},{"accepted":"54648876667","fee":"1683185401","netAccWad":"104641835615485502125561","paidPerUnitWad":"107967226180551285166026","refund":"0","retired":false},{"accepted":"83885610153","fee":"2583676792","netAccWad":"186601660490759325102598","paidPerUnitWad":"192531634841875736537182","refund":"0","retired":false},{"accepted":"22807446561","fee":"702469354","netAccWad":"208885510159046667600831","paidPerUnitWad":"215523638213943323054153","refund":"0","retired":false},{"accepted":"892676089","fee":"27494423","netAccWad":"209757692835389672904403","paidPerUnitWad":"216423537796895681636493","refund":"0","retired":false},{"accepted":"9584254062","fee":"295195025","netAccWad":"219121918511894981012588","paidPerUnitWad":"226085347202998468708318","refund":"0","retired":false}]`

## holder claim since last settlement

- input `{"acc":"1229315910945399839269457207543","last":"846606476361819718622235427694","units":"768469"}`
  - ours `"294100336485009232"`
  - Stage 1 `"294100336485009231"`
- input `{"acc":"1209548769690029000740876233121","last":"256232618707713996829030059448","units":"133143"}`
  - ours `"126927372290238367"`
  - Stage 1 `"126927372290238366"`
- input `{"acc":"1503694491901238744821100955837","last":"767656518031679285671984441546","units":"389291"}`
  - ours `"286532958885654672"`
  - Stage 1 `"286532958885654671"`

## remaining cap at redemption

Ours floors (C·WAD − paid)/WAD; Stage 1 takes C − ceil(paid/WAD). The two are algebraically equal; this family checks it.


## redemption price

No payout history (D_avg is 0 or absent), so the price is decided by the hurdle or the remaining cap; compares price, remaining cap and hurdle. A disagreement here that the remaining-cap family does not show comes from the hurdle.

- input `{"h":"59600772141515082","m":"2846638925209514082","p0":"27295413","paid":"43230726816752182647089240","t":"124844186","units":"35498"}`
  - ours `{"capRemaining":"34469458","hurdle":"34328173","price":"34328173"}`
  - Stage 1 `{"capRemaining":"34469458","hurdle":"34328171","price":"34328171"}`
- input `{"h":"146228036530187672","m":"1901240749367979221","p0":"69016600","paid":"89901468238659154749682552","t":"144559165","units":"747367"}`
  - ours `{"capRemaining":"41315703","hurdle":"129307258","price":"41315703"}`
  - Stage 1 `{"capRemaining":"41315703","hurdle":"129307255","price":"41315703"}`
- input `{"h":"126830720104131701","m":"2244398366115028563","p0":"22835636","paid":"40983874233020275554662116","t":"110922607","units":"320795"}`
  - ours `{"capRemaining":"10268389","hurdle":"34816806","price":"10268389"}`
  - Stage 1 `{"capRemaining":"10268389","hurdle":"34816804","price":"10268389"}`

## auction clearing

One valid bid per wallet, each within the wallet cap (bids past the cap are invalid at reveal in Stage 1). Compares success, clearing price, units sold and every bidder’s allocation.

- input `{"bids":[{"price":"16","qty":"51"},{"price":"21","qty":"66"},{"price":"21","qty":"24"},{"price":"19","qty":"11"},{"price":"16","qty":"2"},{"price":"20","qty":"41"},{"price":"20","qty":"29"},{"price":"15","qty":"58"}],"capBps":"8790","minRaise":"549","reserve":"15","units":"83"}`
  - ours `{"allocations":["0","66","17","0","0","0","0","0"],"clearingPrice":"21","success":true,"unitsSold":"83"}`
  - Stage 1 `{"allocations":["0","60","22","0","0","0","0","0"],"clearingPrice":"21","success":true,"unitsSold":"82"}`
- input `{"bids":[{"price":"50","qty":"24"},{"price":"51","qty":"41"},{"price":"49","qty":"36"},{"price":"51","qty":"44"},{"price":"48","qty":"13"},{"price":"49","qty":"9"},{"price":"51","qty":"45"},{"price":"48","qty":"9"}],"capBps":"9843","minRaise":"692","reserve":"47","units":"78"}`
  - ours `{"allocations":["0","41","0","37","0","0","0","0"],"clearingPrice":"51","success":true,"unitsSold":"78"}`
  - Stage 1 `{"allocations":["0","24","0","26","0","0","27","0"],"clearingPrice":"51","success":true,"unitsSold":"77"}`
- input `{"bids":[{"price":"42","qty":"76"},{"price":"47","qty":"234"},{"price":"41","qty":"12"},{"price":"45","qty":"218"},{"price":"45","qty":"61"},{"price":"42","qty":"37"},{"price":"42","qty":"117"},{"price":"45","qty":"94"},{"price":"46","qty":"220"},{"price":"46","qty":"49"},{"price":"47","qty":"239"},{"price":"46","qty":"26"}],"capBps":"8675","minRaise":"10046","reserve":"41","units":"346"}`
  - ours `{"allocations":["0","234","0","0","0","0","0","0","0","0","112","0"],"clearingPrice":"47","success":true,"unitsSold":"346"}`
  - Stage 1 `{"allocations":["0","171","0","0","0","0","0","0","0","0","174","0"],"clearingPrice":"47","success":true,"unitsSold":"345"}`

## Not compared function by function

- `ratePerUnit`: Stage 1 takes r_wad per unit from the terms commitment; it never derives r from a share rate and units offered.
- `periodPayment, toStablecoin`: Covered by the quarter-payment family (Stage 1 has no separate functions).
- `auctionFee, payoutFee, capRemaining, accrueNet, rewardDebt`: Covered inside the escrow, vault-sequence, claim and redemption families.
- `tailPayoutPerUnit`: Stage 1 runs the tail through its own accumulator (`tailReceive`) over gross receipts; there is no per-unit function with the same inputs. Covered by the parity vectors instead.
- `deadlinesFor, periodStanding`: Stage 1 derives status from a ledger clock over unpaused time (`deriveStatus`); compared through the parity vectors.
- `quarterAverageRate, coverageOk, deviationBps`: Stage 1 keeps a per-pair snapshot state (`snapshot`, `quarterAverage`) with its own coverage and deviation rules; compared through the parity vectors.
