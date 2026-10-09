/**
 * @merces/math — interim reference implementation of the Mercery mechanism math (Part C).
 *
 * Stage 1 will deliver its own reference math library. `stage1:sync` compares it against this one on every
 * parity vector and reports whether it is eligible to replace this one. Nothing swaps it in at runtime yet:
 * services, the simulator, the indexer and the keepers import the named functions below directly, and nothing
 * reads `math`/`selectMath()`. Wiring a replacement means routing those calls through `math` and making every
 * process select the same implementation at startup.
 */
import * as fixed from './fixed.ts';
import * as time from './time.ts';
import * as payment from './payment.ts';
import * as fees from './fees.ts';
import * as cap from './cap.ts';
import * as redemption from './redemption.ts';
import * as lateness from './lateness.ts';
import * as fx from './fx.ts';
import * as auction from './auction.ts';

export * from './fixed.ts';
export * from './time.ts';
export * from './payment.ts';
export * from './fees.ts';
export * from './cap.ts';
export * from './redemption.ts';
export * from './lateness.ts';
export * from './fx.ts';
export * from './auction.ts';

/** The surface Stage 1's library must satisfy to be swapped in. Kept to the money-relevant functions. */
export interface MercesMath {
  ratePerUnit: typeof payment.ratePerUnit;
  owedYtd: typeof payment.owedYtd;
  periodPayment: typeof payment.periodPayment;
  toStablecoin: typeof payment.toStablecoin;
  quarterPayment: typeof payment.quarterPayment;
  auctionFee: typeof fees.auctionFee;
  payoutFee: typeof fees.payoutFee;
  perUnitCap: typeof cap.perUnitCap;
  applyGrossPayment: typeof cap.applyGrossPayment;
  capRemaining: typeof cap.capRemaining;
  accrueNet: typeof cap.accrueNet;
  claimable: typeof cap.claimable;
  rewardDebt: typeof cap.rewardDebt;
  hurdlePrice: typeof redemption.hurdlePrice;
  redemptionQuote: typeof redemption.redemptionQuote;
  tailPayoutPerUnit: typeof redemption.tailPayoutPerUnit;
  lateAccrual: typeof lateness.lateAccrual;
  deadlinesFor: typeof lateness.deadlinesFor;
  quarterAverageRate: typeof fx.quarterAverageRate;
  coverageOk: typeof fx.coverageOk;
  deviationBps: typeof fx.deviationBps;
  clearAuction: typeof auction.clearAuction;
  walletCapUnits: typeof auction.walletCapUnits;
}

export const interimMath: MercesMath = {
  ratePerUnit: payment.ratePerUnit,
  owedYtd: payment.owedYtd,
  periodPayment: payment.periodPayment,
  toStablecoin: payment.toStablecoin,
  quarterPayment: payment.quarterPayment,
  auctionFee: fees.auctionFee,
  payoutFee: fees.payoutFee,
  perUnitCap: cap.perUnitCap,
  applyGrossPayment: cap.applyGrossPayment,
  capRemaining: cap.capRemaining,
  accrueNet: cap.accrueNet,
  claimable: cap.claimable,
  rewardDebt: cap.rewardDebt,
  hurdlePrice: redemption.hurdlePrice,
  redemptionQuote: redemption.redemptionQuote,
  tailPayoutPerUnit: redemption.tailPayoutPerUnit,
  lateAccrual: lateness.lateAccrual,
  deadlinesFor: lateness.deadlinesFor,
  quarterAverageRate: fx.quarterAverageRate,
  coverageOk: fx.coverageOk,
  deviationBps: fx.deviationBps,
  clearAuction: auction.clearAuction,
  walletCapUnits: auction.walletCapUnits,
};

let selected: MercesMath = interimMath;
let selectedName = 'interim';

/** Swap the implementation behind `math`. Affects only `math.<fn>()` callers in this process (there are none yet). */
export function selectMath(impl: MercesMath, name: string): void {
  selected = impl;
  selectedName = name;
}
export function selectedMathName(): string {
  return selectedName;
}
/** The implementation chosen by `selectMath()` (interim by default). */
export const math: MercesMath = new Proxy({} as MercesMath, {
  get: (_t, prop) => (selected as unknown as Record<string | symbol, unknown>)[prop],
}) as MercesMath;

export { fixed, time };
