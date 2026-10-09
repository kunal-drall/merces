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
| redemption price | `redemptionQuote` | `redemptionQuote` | 300 | **156** |
| auction clearing | `clearAuction` | `findClearingPrice` | 300 | **124** |

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

## redemption price

No payout history (D_avg is 0 or absent), so the price is decided by the hurdle or the remaining cap; compares price, remaining cap and hurdle.

- input `{"h":"181668758885104475","m":"1777708222709513123","p0":"93350074","paid":"160159544621283948301505519","t":"153504363","units":"51137"}`
  - ours `{"capRemaining":"5789649","hurdle":"210698550","price":"5789649"}`
  - Stage 1 `{"capRemaining":"5789649","hurdle":"210698548","price":"5789649"}`
- input `{"h":"136395082576696274","m":"2921432434429724151","p0":"54758403","paid":"152675354288769529703070170","t":"132351215","units":"685237"}`
  - ours `{"capRemaining":"7297619","hurdle":"93772114","price":"7297619"}`
  - Stage 1 `{"capRemaining":"7297619","hurdle":"93772112","price":"7297619"}`
- input `{"h":"239900750412411717","m":"1767155064764063992","p0":"81651578","paid":"90544246668300287706281591","t":"80091858","units":"527770"}`
  - ours `{"capRemaining":"53746752","hurdle":"141779838","price":"53746752"}`
  - Stage 1 `{"capRemaining":"53746752","hurdle":"141779837","price":"53746752"}`

## auction clearing

One valid bid per wallet, each within the wallet cap (bids past the cap are invalid at reveal in Stage 1). Compares success, clearing price, units sold and every bidder’s allocation.

- input `{"bids":[{"price":"35","qty":"342"},{"price":"32","qty":"377"},{"price":"32","qty":"368"},{"price":"33","qty":"299"},{"price":"35","qty":"198"},{"price":"37","qty":"367"},{"price":"35","qty":"382"},{"price":"35","qty":"291"},{"price":"34","qty":"31"},{"price":"33","qty":"417"}],"capBps":"9663","minRaise":"6110","reserve":"31","units":"488"}`
  - ours `{"allocations":["121","0","0","0","0","367","0","0","0","0"],"clearingPrice":"35","success":true,"unitsSold":"488"}`
  - Stage 1 `{"allocations":["34","0","0","0","19","367","38","29","0","0"],"clearingPrice":"35","success":true,"unitsSold":"487"}`
- input `{"bids":[{"price":"16","qty":"92"},{"price":"21","qty":"159"},{"price":"16","qty":"213"},{"price":"17","qty":"88"},{"price":"21","qty":"107"},{"price":"19","qty":"58"},{"price":"21","qty":"148"},{"price":"16","qty":"32"},{"price":"16","qty":"117"},{"price":"21","qty":"222"},{"price":"15","qty":"130"}],"capBps":"6260","minRaise":"2176","reserve":"15","units":"460"}`
  - ours `{"allocations":["0","159","0","0","107","0","148","0","0","46","0"],"clearingPrice":"21","success":true,"unitsSold":"460"}`
  - Stage 1 `{"allocations":["0","115","0","0","77","0","107","0","0","160","0"],"clearingPrice":"21","success":true,"unitsSold":"459"}`
- input `{"bids":[{"price":"38","qty":"35"},{"price":"41","qty":"176"},{"price":"37","qty":"150"},{"price":"38","qty":"84"},{"price":"39","qty":"29"},{"price":"42","qty":"186"}],"capBps":"4157","minRaise":"10181","reserve":"37","units":"458"}`
  - ours `{"allocations":["35","176","0","32","29","186"],"clearingPrice":"38","success":true,"unitsSold":"458"}`
  - Stage 1 `{"allocations":["19","176","0","47","29","186"],"clearingPrice":"38","success":true,"unitsSold":"457"}`

## Not compared function by function

- `ratePerUnit`: Stage 1 takes r_wad per unit from the terms commitment; it never derives r from a share rate and units offered.
- `periodPayment, toStablecoin`: Covered by the quarter-payment family (Stage 1 has no separate functions).
- `auctionFee, payoutFee, capRemaining, accrueNet, rewardDebt`: Covered inside the escrow, vault-sequence, claim and redemption families.
- `tailPayoutPerUnit`: Stage 1 runs the tail through its own accumulator (`tailReceive`) over gross receipts; there is no per-unit function with the same inputs. Covered by the parity vectors instead.
- `deadlinesFor, periodStanding`: Stage 1 derives status from a ledger clock over unpaused time (`deriveStatus`); compared through the parity vectors.
- `quarterAverageRate, coverageOk, deviationBps`: Stage 1 keeps a per-pair snapshot state (`snapshot`, `quarterAverage`) with its own coverage and deviation rules; compared through the parity vectors.
