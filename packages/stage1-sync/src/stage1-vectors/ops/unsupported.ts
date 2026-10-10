import type { CallOp } from '@merces/reference';
import { blocked, notApplicable, type Translation, type TranslatorTable } from './types.ts';

/**
 * Ops the merces backend does not run in S1.
 *
 * - `retire_if_capped` (BLK-1): no canonical command (retirement happens inside `payIn`); BLOCKED, waived in 01#34
 *   and 05#42.
 * - `transfer_units` (NA-1): Stage 1 refuses a direct transfer (DirectTransferForbidden); the canonical model has no
 *   transfer to refuse, so the step has no meaning here.
 * - The ops only the vectors outside the S1 set use: BLOCKED, naming the milestone that brings them. The same
 *   milestones are in `steps/vectors.ts` `STAGE1_OP_MAP` (a test keeps them equal).
 */
export const NOT_IN_S1: Readonly<Partial<Record<CallOp, string>>> = Object.freeze({
  cancel_raise: 'S2',
  register_holder: 'S3',
  revoke_verifier_key: 'S4',
  withdraw_pause_request: 'S5',
  end_pause: 'S5',
  fx_snapshot: 'S5',
  set_fx_pair: 'S5',
  route_income: 'S5',
  close_router_period: 'S5',
  submit_trueup: 'S5',
  pay_trueup: 'S5',
  set_flags: 'S5',
  stop_issuance: 'S5',
  resume_issuance: 'S5',
  deactivate_issuer: 'S5',
  set_contract_hash: 'S5',
  set_release_pause: 'S5',
});

function notInS1(op: CallOp): Translation {
  return blocked(undefined, `${op} is not in S1 (${NOT_IN_S1[op] ?? '?'})`);
}

export const unsupportedOps: TranslatorTable = {
  retire_if_capped: () => blocked('BLK-1', 'retire_if_capped has no canonical command'),
  transfer_units: () => notApplicable('NA-1', 'the canonical model has no unit transfer to refuse'),
  ...Object.fromEntries((Object.keys(NOT_IN_S1) as CallOp[]).map((op) => [op, () => notInS1(op)])),
};
