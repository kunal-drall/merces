import type { CallOp } from '@merces/reference';
import { blocked, type Translation, type TranslatorTable } from './types.ts';

/**
 * Ops the merces backend does not run yet.
 *
 * - The ops only the vectors that are not targets use (NOT-YET): BLOCKED, naming the milestone that brings them. The
 *   same milestones are in `steps/vectors.ts` `STAGE1_OP_MAP` (a test keeps them equal). S2 brought `cancel_raise` and
 *   `register_holder` (now in `raise.ts`); S4 WP6 `revoke_verifier_key` (now in `registry.ts`); S4 WP10
 *   `withdraw_pause_request` (now in `pauses.ts`).
 */
export const NOT_YET: Readonly<Partial<Record<CallOp, string>>> = Object.freeze({
});

function notYet(op: CallOp): Translation {
  return blocked(undefined, `${op} is not modelled yet (${NOT_YET[op] ?? '?'})`);
}

export const unsupportedOps: TranslatorTable = {
  ...Object.fromEntries((Object.keys(NOT_YET) as CallOp[]).map((op) => [op, () => notYet(op)])),
};
