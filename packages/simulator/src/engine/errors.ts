import { ChainError, type ChainErrorCode } from '@merces/domain';
import type { ErrorName } from '@merces/math';

/**
 * Stage 1 error names on simulator errors (S1 plan D4, §5.4).
 *
 * Every `ChainError` raised on a Stage 1 path carries `detail.stage1`, Stage 1's own error name (SPEC §11,
 * `@merces/sdk` `ERRORS`), beside our chain-neutral `ChainErrorCode`. The vector runner compares `detail.stage1`;
 * the API returns `detail` as is. `STAGE1_CODE` fixes the code each name travels with.
 */
export {STAGE1_CODE,STAGE1_SOLANA_CODE,STAGE1_EVM_CODE,type Stage1Error} from '@merces/domain';
import {STAGE1_CODE,STAGE1_SOLANA_CODE,STAGE1_EVM_CODE,type Stage1Error} from '@merces/domain';
const ALL_CODES:Record<Stage1Error,ChainErrorCode>={...STAGE1_CODE,...STAGE1_SOLANA_CODE,...STAGE1_EVM_CODE};

/**
 * Throw the `ChainError` for Stage 1 error `name`: its code from `STAGE1_CODE` (or a chain's own table),
 * `detail.stage1 = name`. The message is ours; it must never carry an income figure, salt, opening or document
 * (callers pass public facts only: names, ids, public amounts).
 */
export function fail(name: Stage1Error, message: string = name, extra?: Record<string, unknown>): never {
  throw new ChainError(ALL_CODES[name], message, { ...extra, stage1: name });
}

/**
 * Run a call into Stage 1 code (sdk, reference, circuits). A `ChainError` passes through unchanged; anything else
 * (Stage 1's `RangeError`s and plain `Error`s, whose messages can embed the offending value, SDK bytes.ts
 * `assertRange`) becomes `ChainError('ChainSpecific', 'stage1 math rejected the inputs', {stage1: name})` with the
 * original message and stack dropped.
 */
export function guardStage1<T>(fn: () => T, name: ErrorName): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw new ChainError('ChainSpecific', 'stage1 math rejected the inputs', { stage1: name });
  }
}
