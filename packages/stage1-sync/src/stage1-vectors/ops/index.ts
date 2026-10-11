import type { Call, CallOp } from '@merces/reference';
import { RunnerError } from '../errors.ts';
import { moneyOps } from './money.ts';
import { pauseOps } from './pauses.ts';
import { raiseOps } from './raise.ts';
import { redemptionOps } from './redemption.ts';
import { registryOps } from './registry.ts';
import { reportOps } from './reports.ts';
import { terminalOps } from './terminal.ts';
import { unsupportedOps } from './unsupported.ts';
import { windowOps } from './window.ts';
import { fxOps } from './fx.ts';
import type { OpContext, Translation, Translator, TranslatorTable } from './types.ts';

export { NOT_YET } from './unsupported.ts';
export type { OpContext, Translation } from './types.ts';

/** Every Stage 1 call op → its translator on the merces backend (S1 plan §5.3). */
export const TRANSLATORS: TranslatorTable = Object.freeze({
  ...registryOps,
  ...raiseOps,
  ...reportOps,
  ...moneyOps,
  ...pauseOps,
  ...redemptionOps,
  ...terminalOps,
  ...windowOps,
  ...fxOps,
  ...unsupportedOps,
});

/** How the merces backend runs `call`. Throws a RunnerError for an op no translator knows. */
export function translate(ctx: OpContext, call: Call): Translation {
  const t = TRANSLATORS[call.op as CallOp] as Translator | undefined;
  if (!t) throw new RunnerError(`the merces backend has no translator for ${call.op}`);
  return t(ctx, call);
}
