import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stage1Path } from '@merces/chains';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import type { StepReport, StepStatus } from '../report.ts';
import type { StepCtx } from './generate.ts';
import { replayScenario, type ParityScenario } from '../vectors.ts';

/**
 * Step 5: replay Stage 1's parity vectors.
 *
 * Stage 1 ships a directory of vectors in its own format (`NN_name.json`, SPEC ops and `expect` checks); the Stage 1
 * vector runner (`../stage1-vectors`, S1 plan §5) replays them on the reference backend (Stage 1's own simulator: all
 * must pass, or the runner or the checkout is broken) and on the merces backend (our simulator: each S1 target must be
 * at its expected status). A single JSON file of `scenarios` is the earlier Merces format, replayed through the harness.
 * If our simulator disagrees, the simulator is wrong and must be fixed (everything was tested against it).
 */
export async function replayVectors(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const vectorsPath = stage1Path(ctx.location, m.vectors);
  if (!vectorsPath || !existsSync(vectorsPath)) return { step: 'vectors', status: 'warn', summary: 'no parity vectors in the manifest', details: [] };
  if (statSync(vectorsPath).isDirectory()) return replayStage1Vectors(vectorsPath, ctx);
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
 * How each Stage 1 vector op runs on the merces backend in S1 (S1 plan §5.3; the rows live in
 * `../stage1-vectors/shims.ts`):
 * - `direct`: one canonical command with the same meaning;
 * - `shim`: a canonical command of another shape (`shim` names the row); executed and checked, but not parity;
 * - `blocked`: no canonical command yet; not run (waived where §5.6 says so);
 * - `n/a`: meaningless for the canonical model; not run;
 * - `not-in-s1`: used only by vectors outside the S1 set (`milestone` brings it);
 * - `harness`: test scaffolding, not a protocol op.
 */
export type OpKind = 'direct' | 'shim' | 'blocked' | 'n/a' | 'not-in-s1' | 'harness';
export const STAGE1_OP_MAP: Record<string, { canonical: string; kind: OpKind; shim?: string; milestone?: string }> = {
  fund: { canonical: 'simulator fund (test faucet)', kind: 'harness' },
  expect: { canonical: 'runner assertion', kind: 'harness' },
  expect_revert: { canonical: 'runner assertion (canonical error names)', kind: 'harness' },
  register_issuer: { canonical: 'registerIssuer signed by the wallet (Stage 1: admin-only)', kind: 'shim', shim: 'SH-REG-1' },
  create_series: { canonical: 'createSeries (durations, window fee and non-reveal bps held by the runner)', kind: 'shim', shim: 'SH-REG-4' },
  open_raise: { canonical: 'openRaise with the runner-held durations', kind: 'shim', shim: 'SH-AUC-1' },
  cancel_raise: { canonical: 'cancelRaise', kind: 'not-in-s1', milestone: 'S2' },
  allowlist: { canonical: 'setAllowlist', kind: 'direct' },
  register_attestor: { canonical: 'registerAttestor', kind: 'shim', shim: 'SH-REG-2' },
  revoke_attestor: { canonical: 'registerAttestor(active=false) (Stage 1: forward-only with a 45-day grace)', kind: 'shim', shim: 'SH-REG-2' },
  register_verifier_key: { canonical: 'registerVerifierKey (ed25519; Stage 1: secp256k1)', kind: 'shim', shim: 'SH-REG-3' },
  commit_bid: { canonical: 'commitBid (our commitment recomputed from the plaintext)', kind: 'shim', shim: 'SH-AUC-2' },
  reveal_bid: { canonical: 'revealBid', kind: 'direct' },
  begin_settlement: { canonical: 'settleAuction (one step; Stage 1 is proposer claims + paged tally + finalize)', kind: 'shim', shim: 'SH-AUC-3' },
  finalize_settlement: { canonical: 'none (settled inside settleAuction)', kind: 'shim', shim: 'SH-AUC-4' },
  process_bid: { canonical: 'none (canonical settlement mints inside settleAuction)', kind: 'shim', shim: 'SH-AUC-5' },
  deliver_bid: { canonical: 'claimRefund for losers; none for winners', kind: 'shim', shim: 'SH-AUC-6' },
  submit_report: { canonical: 'submitReport (Groth16 proof; attestation signed by the runner)', kind: 'shim', shim: 'SH-REP-1' },
  pay: { canonical: 'payIn (period and amount supplied by the runner)', kind: 'shim', shim: 'SH-PAY-1' },
  claim: { canonical: 'claimPayout', kind: 'shim', shim: 'SH-CLM-1' },
  claim_release: { canonical: 'drawRelease', kind: 'direct' },
  crank_status: { canonical: 'crankStatus', kind: 'direct' },
  burn_retired: { canonical: 'crankBurn', kind: 'shim', shim: 'SH-BRN-1' },
  request_pause: { canonical: 'requestPause (until supplied by the runner)', kind: 'shim', shim: 'SH-PAU-1' },
  withdraw_pause_request: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
  approve_pause: { canonical: 'approvePause sent by the attestor wallet', kind: 'shim', shim: 'SH-PAU-2' },
  end_pause: { canonical: 'none (crankPause ends a pause at its end only)', kind: 'not-in-s1', milestone: 'S5' },
  redeem: { canonical: 'redeem (no slippage bound)', kind: 'shim', shim: 'SH-RED-1' },
  claim_redemption: { canonical: 'claimRedemption', kind: 'direct' },
  claim_tail: { canonical: 'none (claimRedemption if needed, then claimPayout)', kind: 'shim', shim: 'SH-CLM-2' },
  claim_final: { canonical: 'none (claimPayout)', kind: 'shim', shim: 'SH-CLM-3' },
  extinguish: { canonical: 'extinguish with a co-signing attestor', kind: 'shim', shim: 'SH-EXT-1' },
  amend_terms: { canonical: 'amendTerms with a co-signing attestor', kind: 'shim', shim: 'SH-AMD-1' },
  fx_snapshot: { canonical: 'snapshotRate', kind: 'not-in-s1', milestone: 'S5' },
  set_fx_pair: { canonical: 'none (admin FX pair configuration)', kind: 'not-in-s1', milestone: 'S5' },
  open_window: { canonical: 'openTransferWindow (period kept by the runner)', kind: 'shim', shim: 'SH-WIN-1' },
  window_commit_bid: { canonical: 'commitWindowOrder(side=buy)', kind: 'shim', shim: 'SH-WIN-3' },
  commit_ask: { canonical: 'commitWindowOrder(side=sell)', kind: 'shim', shim: 'SH-WIN-2' },
  reveal_order: { canonical: 'revealWindowOrder', kind: 'shim', shim: 'SH-WIN-4' },
  begin_window_settlement: { canonical: 'none (recorded; clearTransferWindow is one step)', kind: 'shim', shim: 'SH-WIN-5' },
  finalize_window: { canonical: 'clearTransferWindow', kind: 'shim', shim: 'SH-WIN-6' },
  process_orders: { canonical: 'none (canonical clearing delivers inside clearTransferWindow)', kind: 'shim', shim: 'SH-WIN-7' },
  route_income: { canonical: 'postSplitReceipt', kind: 'not-in-s1', milestone: 'S5' },
  close_router_period: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
  submit_trueup: { canonical: 'none (tier-3 true-up)', kind: 'not-in-s1', milestone: 'S5' },
  pay_trueup: { canonical: 'none (tier-3 true-up)', kind: 'not-in-s1', milestone: 'S5' },
  set_flags: { canonical: 'pauseNewRaises (Stage 1 also has windows_enabled)', kind: 'not-in-s1', milestone: 'S5' },
  stop_issuance: { canonical: 'stopIssuance', kind: 'not-in-s1', milestone: 'S5' },
  resume_issuance: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
  retire_if_capped: { canonical: 'none (canonical retirement happens inside payIn; Stage 1 also retires after a cap-lowering amendment)', kind: 'blocked', shim: 'BLK-1' },
  register_holder: { canonical: 'none (canonical holders are implicit in positions)', kind: 'not-in-s1', milestone: 'S3' },
  transfer_units: { canonical: 'none: a direct unit transfer, used only inside expect_revert (DirectTransferForbidden); the canonical model has no transfer to refuse', kind: 'n/a', shim: 'NA-1' },
  deactivate_issuer: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
  revoke_verifier_key: { canonical: 'registerVerifierKey(active=false)', kind: 'not-in-s1', milestone: 'S4' },
  set_contract_hash: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
  set_release_pause: { canonical: 'none', kind: 'not-in-s1', milestone: 'S5' },
};

interface Inventory {
  files: number;
  steps: number;
  reverts: number;
  ops: number;
  lines: string[];
}

/** The ops, expects and reverts of each Stage 1 vector, and how each op runs in S1 (the `VECTOR_PARITY.md` appendix). */
export function inventoryStage1Vectors(dir: string): Inventory {
  const files = readdirSync(dir).filter((f) => /^\d\d_.*\.json$/.test(f)).sort();
  const ops = new Map<string, number>();
  const expects = new Map<string, number>();
  let totalSteps = 0;
  let totalReverts = 0;
  const lines: string[] = ['## Inventory', '', '| Vector | Steps | Expect checks | Expected reverts | Ops the merces backend shims, blocks or lacks in S1 |', '| --- | --- | --- | --- | --- |'];
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { steps?: { op?: string; call?: { op?: string }; [k: string]: unknown }[] };
    const steps = v.steps ?? [];
    totalSteps += steps.length;
    let nExpect = 0;
    let nRevert = 0;
    const gaps = new Set<string>();
    const count = (op: string) => {
      ops.set(op, (ops.get(op) ?? 0) + 1);
      const kind = STAGE1_OP_MAP[op]?.kind;
      if (kind !== 'direct' && kind !== 'harness') gaps.add(op);
    };
    for (const st of steps) {
      const op = String(st.op ?? 'unknown');
      count(op);
      if (op === 'expect') {
        nExpect++;
        for (const k of Object.keys(st)) if (!['t', 'op', 'note'].includes(k)) expects.set(k, (expects.get(k) ?? 0) + 1);
      }
      // a reverted call is nested: { op: 'expect_revert', call: { op, … }, error }
      if (op === 'expect_revert') {
        nRevert++;
        totalReverts++;
        if (st.call?.op) count(String(st.call.op));
      }
    }
    lines.push(`| ${f} | ${steps.length} | ${nExpect} | ${nRevert} | ${gaps.size ? [...gaps].sort().map((g) => `\`${g}\``).join(', ') : 'none'} |`);
  }
  const how = (k: string) => {
    const e = STAGE1_OP_MAP[k];
    if (!e) return '**unmapped**';
    return e.kind === 'not-in-s1' ? `not in S1 (${e.milestone})` : `${e.kind}${e.shim ? ` (${e.shim})` : ''}`;
  };
  lines.push(
    '',
    '### Ops used and how they run on the merces backend in S1',
    '',
    '| Op | Uses | Canonical | Kind |',
    '| --- | --- | --- | --- |',
    ...[...ops].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `| \`${k}\` | ${n} | ${STAGE1_OP_MAP[k]?.canonical ?? 'unknown'} | ${how(k)} |`),
    '',
    '### Expect fields',
    '',
    ...[...expects].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `- \`${k}\` × ${n}`),
  );
  return { files: files.length, steps: totalSteps, reverts: totalReverts, ops: ops.size, lines };
}

/**
 * Stage 1 format: run the vector runner on the reference backend (every vector) and, once it exists (S1 WP9b), on the
 * merces backend (the S1 targets, both personalities). Status: `ok` iff every target is at its expected status;
 * `warn` while the merces backend is missing; `fail` when a target is not at its expected status or the reference
 * backend does not replay a vector (the runner or the Stage 1 checkout is broken).
 */
async function replayStage1Vectors(dir: string, ctx: StepCtx): Promise<StepReport> {
  const inv = inventoryStage1Vectors(dir);
  const runner = await import('../stage1-vectors/index.ts');
  const label = dir.startsWith(ctx.location.root + '/') ? `$STAGE1_PATH/${relative(ctx.location.root, dir)}` : dir;
  const source = { dir: label, ...(ctx.location.manifest.commit ? { commit: ctx.location.manifest.commit } : {}) };
  const details: string[] = [];
  const notes: string[] = [];
  const reports: Awaited<ReturnType<typeof runner.runStage1Vectors>>[] = [];
  let status: StepStatus;
  let summary: string;
  try {
    const reference = await runner.runStage1Vectors({ dir, backend: 'reference' });
    reports.push(reference);
    const refPass = reference.runs.filter((r) => r.status === 'PASS').length;
    const refLine = `reference backend (Stage 1's own simulator): ${refPass}/${reference.runs.length} PASS, proofs verified (${reference.proofs.verified} distinct, ${reference.proofs.invalid} invalid)`;
    details.push(refLine);
    for (const r of reference.runs.filter((x) => !x.atExpected)) details.push(`reference ${r.vector}: ${r.status}${r.issues[0] ? ` at #${r.issues[0].index} ${r.issues[0].op}: ${r.issues[0].message}` : ''}`);
    if (!reference.ok) {
      status = 'fail';
      summary = `the reference backend does not replay ${reference.runs.length - refPass} Stage 1 vector(s): the runner or the Stage 1 checkout is broken`;
    } else if (!runner.backendAvailable('merces')) {
      status = 'warn';
      summary = `${refLine}; our simulator is not replayed yet (the merces backend arrives with S1 WP9b)`;
      notes.push("The merces backend (our `SimulatorChain` through the S1 shims) arrives with S1 WP9b. Until then only the reference backend runs: it checks the runner and the Stage 1 checkout, not our simulator.");
    } else {
      const merces = await runner.runStage1Vectors({ dir, backend: 'merces' });
      reports.push(merces);
      const at = merces.runs.filter((r) => r.atExpected).length;
      details.push(`merces backend: ${at}/${merces.runs.length} target run(s) at expected status (${runner.TARGETS_S1.length} targets × personalities)`);
      for (const r of merces.runs.filter((x) => !x.atExpected)) details.push(`merces ${r.vector} [${r.world}]: ${r.status}, expected ${runner.describeExpected(r.expected)}`);
      status = merces.ok ? 'ok' : 'fail';
      summary = merces.ok ? `every S1 target is at its expected status on both personalities; ${refLine}` : `${merces.runs.length - at} target run(s) below their expected status: our simulator disagrees with Stage 1`;
    }
  } catch (e) {
    status = 'fail';
    summary = `the vector runner failed: ${e instanceof runner.RunnerError ? e.message : e instanceof Error ? e.constructor.name : typeof e}`;
  } finally {
    await runner.shutdown();
  }
  runner.writeParity(ctx.outDir, reports, source, { notes, appendix: inv.lines });
  details.push(`${inv.files} vectors, ${inv.steps} steps (${inv.reverts} expected reverts), ${inv.ops} distinct ops counting the calls inside reverts; see VECTOR_PARITY.md`);
  return { step: 'vectors', status, summary, details };
}
