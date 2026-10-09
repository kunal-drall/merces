import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stage1Path } from '@merces/chains';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';
import { replayScenario, type ParityScenario } from '../vectors.ts';

/**
 * Step 5: replay Stage 1's parity vectors through the simulator. Every expected balance must match.
 * If it does not, the simulator is wrong and must be fixed (everything was tested against it).
 */
export async function replayVectors(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const vectorsPath = stage1Path(ctx.location, m.vectors);
  if (!vectorsPath || !existsSync(vectorsPath)) return { step: 'vectors', status: 'warn', summary: 'no parity vectors in the manifest', details: [] };
  // Stage 1 ships a directory of vectors in its own format (one file per vector, SPEC-named ops and expects)
  if (statSync(vectorsPath).isDirectory()) return inventoryStage1Vectors(vectorsPath, ctx);
  const raw = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { scenarios?: ParityScenario[] };
  const scenarios = raw.scenarios ?? [];
  if (scenarios.length === 0) return { step: 'vectors', status: 'warn', summary: 'vectors file has no scenarios', details: [] };
  const details: string[] = [];
  const lines: string[] = ['# VECTOR_PARITY.md', ''];
  let failures = 0;
  for (const sc of scenarios) {
    for (const personality of (sc.personalities ?? ['solana', 'monad']) as Personality[]) {
      const sim = SimulatorChain.createSync({ personality, genesis: sc.genesis });
      const h = await SimHarness.create(personality, { sim });
      const r = await replayScenario(h, sc);
      if (r.mismatches.length) {
        failures++;
        lines.push(`## ${sc.name} (${personality}): FAIL`, ...r.mismatches.map((x) => `- ${x}`), '');
        details.push(`${sc.name}/${personality}: ${r.mismatches.length} mismatch(es)`);
      } else lines.push(`## ${sc.name} (${personality}): ok (${r.steps} steps)`, '');
    }
  }
  writeFileSync(join(ctx.outDir, 'VECTOR_PARITY.md'), lines.join('\n') + '\n');
  return { step: 'vectors', status: failures ? 'fail' : 'ok', summary: failures ? `${failures} scenario run(s) disagree with the simulator` : `${scenarios.length} scenario(s) reproduced`, details };
}

/**
 * How each Stage 1 vector op maps onto the canonical command set (packages/domain/src/commands.ts) as of the
 * Stage 1 integration review. `direct`: one canonical command with the same meaning; `reshaped`: the canonical
 * model does the job in a different shape (one step where Stage 1 has several, or fields differ), so the runner needs
 * a model change or an adapter; `missing`: no canonical counterpart; `harness`: test scaffolding, not a protocol op.
 */
export const STAGE1_OP_MAP: Record<string, { canonical: string; kind: 'direct' | 'reshaped' | 'missing' | 'harness' }> = {
  fund: { canonical: 'simulator fund (test faucet)', kind: 'harness' },
  expect: { canonical: 'runner assertion', kind: 'harness' },
  expect_revert: { canonical: 'runner assertion (canonical error names)', kind: 'harness' },
  register_issuer: { canonical: 'registerIssuer', kind: 'direct' },
  create_series: { canonical: 'createSeries (Stage 1 adds tier_flags, fx_pair_id, mode, release schedule, k, fee bps per series)', kind: 'reshaped' },
  open_raise: { canonical: 'openRaise', kind: 'direct' },
  allowlist: { canonical: 'setAllowlist', kind: 'direct' },
  register_attestor: { canonical: 'registerAttestor', kind: 'direct' },
  revoke_attestor: { canonical: 'registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace)', kind: 'reshaped' },
  register_verifier_key: { canonical: 'registerVerifierKey', kind: 'direct' },
  commit_bid: { canonical: 'commitBid', kind: 'direct' },
  reveal_bid: { canonical: 'revealBid', kind: 'direct' },
  begin_settlement: { canonical: 'settleAuction (one step; Stage 1 is proposer claims + paged tally + finalize)', kind: 'reshaped' },
  finalize_settlement: { canonical: 'settleAuction', kind: 'reshaped' },
  process_bid: { canonical: 'none (canonical settlement mints and refunds inside settleAuction / claimRefund)', kind: 'missing' },
  deliver_bid: { canonical: 'claimRefund for losers; none for winners', kind: 'reshaped' },
  submit_report: { canonical: 'submitReport', kind: 'direct' },
  pay: { canonical: 'payIn', kind: 'direct' },
  claim: { canonical: 'claimPayout', kind: 'direct' },
  claim_release: { canonical: 'drawRelease', kind: 'direct' },
  crank_status: { canonical: 'crankStatus', kind: 'direct' },
  burn_retired: { canonical: 'crankBurn', kind: 'direct' },
  request_pause: { canonical: 'requestPause', kind: 'direct' },
  withdraw_pause_request: { canonical: 'none', kind: 'missing' },
  approve_pause: { canonical: 'approvePause', kind: 'direct' },
  end_pause: { canonical: 'crankPause', kind: 'reshaped' },
  redeem: { canonical: 'redeem', kind: 'direct' },
  claim_redemption: { canonical: 'claimRedemption', kind: 'direct' },
  claim_tail: { canonical: 'none (canonical tail pays through the payout accumulator)', kind: 'missing' },
  claim_final: { canonical: 'none (canonical extinguishment pays through the payout accumulator)', kind: 'missing' },
  extinguish: { canonical: 'extinguish', kind: 'direct' },
  amend_terms: { canonical: 'amendTerms (Stage 1 carries tier-1 θ/r plaintext)', kind: 'reshaped' },
  fx_snapshot: { canonical: 'snapshotRate', kind: 'direct' },
  set_fx_pair: { canonical: 'none (admin FX pair configuration)', kind: 'missing' },
  open_window: { canonical: 'openTransferWindow', kind: 'direct' },
  window_commit_bid: { canonical: 'commitWindowOrder(side=bid)', kind: 'direct' },
  commit_ask: { canonical: 'commitWindowOrder(side=ask)', kind: 'direct' },
  reveal_order: { canonical: 'revealWindowOrder', kind: 'direct' },
  begin_window_settlement: { canonical: 'clearTransferWindow (one step; Stage 1 is proposer + tally + finalize)', kind: 'reshaped' },
  finalize_window: { canonical: 'clearTransferWindow', kind: 'reshaped' },
  process_orders: { canonical: 'none (canonical clearing delivers inside clearTransferWindow)', kind: 'missing' },
  route_income: { canonical: 'postSplitReceipt', kind: 'reshaped' },
  close_router_period: { canonical: 'none', kind: 'missing' },
  submit_trueup: { canonical: 'none (tier-3 true-up)', kind: 'missing' },
  pay_trueup: { canonical: 'none (tier-3 true-up)', kind: 'missing' },
  set_flags: { canonical: 'pauseNewRaises (Stage 1 also has windows_enabled)', kind: 'reshaped' },
  stop_issuance: { canonical: 'stopIssuance', kind: 'direct' },
  resume_issuance: { canonical: 'none', kind: 'missing' },
  retire_if_capped: { canonical: 'none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment)', kind: 'missing' },
  register_holder: { canonical: 'none (canonical holders are implicit in positions)', kind: 'missing' },
};

/**
 * Stage 1's own vector format (a directory of NN_name.json files with `steps` of SPEC ops and `expect` checks). Until
 * the Stage 1 vector runner exists this step inventories them (ops, expects, reverts per vector) so the drift review can
 * see what replaying them needs; it never claims parity it has not checked.
 */
function inventoryStage1Vectors(dir: string, ctx: StepCtx): StepReport {
  const files = readdirSync(dir).filter((f) => /^\d\d_.*\.json$/.test(f)).sort();
  const ops = new Map<string, number>();
  const expects = new Map<string, number>();
  const lines: string[] = ['# VECTOR_PARITY.md', '', `Stage 1 vectors in ${dir.startsWith(ctx.location.root + '/') ? `$STAGE1_PATH/${relative(ctx.location.root, dir)}` : dir}${ctx.location.manifest.commit ? ` at ${ctx.location.manifest.commit}` : ''} (Stage 1 format). Replay through the Stage 1 vector runner is pending; inventory only.`, '', '| Vector | Steps | Expect checks | Expected reverts | Ops without a direct counterpart |', '| --- | --- | --- | --- | --- |'];
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { steps?: { op?: string; expect?: unknown; revert?: unknown; expectRevert?: unknown }[] };
    const steps = v.steps ?? [];
    let nExpect = 0;
    let nRevert = 0;
    const gaps = new Set<string>();
    for (const st of steps) {
      const op = String(st.op ?? 'unknown');
      ops.set(op, (ops.get(op) ?? 0) + 1);
      if (op === 'expect') {
        nExpect++;
        for (const k of Object.keys(st as Record<string, unknown>)) if (!['t', 'op'].includes(k)) expects.set(k, (expects.get(k) ?? 0) + 1);
      }
      if (op === 'expect_revert' || st.revert !== undefined || st.expectRevert !== undefined) nRevert++;
      const kind = STAGE1_OP_MAP[op]?.kind;
      if (kind !== 'direct' && kind !== 'harness') gaps.add(op);
    }
    lines.push(`| ${f} | ${steps.length} | ${nExpect} | ${nRevert} | ${gaps.size ? [...gaps].sort().map((g) => `\`${g}\``).join(', ') : 'none'} |`);
  }
  lines.push(
    '',
    '## Ops used and their canonical counterpart',
    '',
    '| Op | Uses | Canonical | Kind |',
    '| --- | --- | --- | --- |',
    ...[...ops].sort((a, b) => b[1] - a[1]).map(([k, n]) => `| \`${k}\` | ${n} | ${STAGE1_OP_MAP[k]?.canonical ?? 'unknown'} | ${STAGE1_OP_MAP[k]?.kind ?? '**unmapped**'} |`), '', '## Expect fields', '', ...[...expects].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- \`${k}\` × ${n}`));
  writeFileSync(join(ctx.outDir, 'VECTOR_PARITY.md'), lines.join('\n') + '\n');
  return { step: 'vectors', status: 'warn', summary: `${files.length} Stage 1 vectors found (Stage 1 format, ${ops.size} distinct ops); not replayed yet: the Stage 1 vector runner is pending the canonical-model review`, details: [`${files.length} vectors, ${[...ops.values()].reduce((a, b) => a + b, 0)} steps, ${ops.size} distinct ops; see VECTOR_PARITY.md`] };
}
