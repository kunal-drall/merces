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
 * must pass, or the runner or the checkout is broken) and on the merces backend (our simulator: each target and each
 * prefix gate must be at its expected status). A single JSON file of `scenarios` is the earlier Merces format, replayed through the harness.
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
 * How each Stage 1 vector op runs on the merces backend (S1 plan §5.3, S2; the rows live in
 * `../stage1-vectors/shims.ts`):
 * - `direct`: one canonical command with the same meaning;
 * - `shim`: a canonical command of another shape (`shim` names the row); executed and checked, but not parity;
 * - `blocked`: no canonical command yet; not run (waived where §5.6 says so);
 * - `n/a`: meaningless for the canonical model; not run;
 * - `not-yet`: used only by vectors that are not targets yet (`milestone` brings it);
 * - `harness`: test scaffolding, not a protocol op.
 */
export type OpKind = 'direct' | 'shim' | 'blocked' | 'n/a' | 'not-yet' | 'harness';
export const STAGE1_OP_MAP: Record<string, { canonical: string; kind: OpKind; shim?: string; milestone?: string }> = {
  fund: { canonical: 'simulator fund (test faucet)', kind: 'harness' },
  expect: { canonical: 'runner assertion', kind: 'harness' },
  expect_revert: { canonical: 'runner assertion (canonical error names)', kind: 'harness' },
  register_issuer: { canonical: 'registerIssuer signed by the protocol admin', kind: 'direct' },
  create_series: { canonical: 'createSeries (all Stage 1 bounded terms)', kind: 'direct' },
  open_raise: { canonical: 'openRaise (the phase ends from the series durations)', kind: 'direct' },
  cancel_raise: { canonical: 'cancelRaise', kind: 'direct' },
  allowlist: { canonical: 'setAllowlist', kind: 'direct' },
  register_attestor: { canonical: "registerAttestor of the vector key's 20-byte address (each personality's registry rules)", kind: 'direct' },
  revoke_attestor: { canonical: 'revokeAttestor (forward-only, the 45-day grace on report and FX signatures, never the last active key)', kind: 'direct' },
  register_verifier_key: { canonical: "registerVerifierKey of the vector key's 20-byte address (each personality's registry rules)", kind: 'direct' },
  commit_bid: { canonical: "commitBid (Stage 1's keccak commitment from the plaintext and the bidder's wallet; u64 price and quantity)", kind: 'direct' },
  reveal_bid: { canonical: 'revealBid', kind: 'direct' },
  begin_settlement: { canonical: 'beginSettlement (permissionless; sent by the keeper)', kind: 'direct' },
  finalize_settlement: { canonical: 'tallyBids (every page) then finalizeSettlement', kind: 'direct' },
  process_bid: { canonical: 'processBid', kind: 'direct' },
  deliver_bid: { canonical: 'deliverBid', kind: 'direct' },
  submit_report: { canonical: 'submitReport (Groth16 proof, REPORT and FX signatures; registry pair determines the FX basis)', kind: 'direct' },
  pay: { canonical: 'payIn (the chain computes the open due)', kind: 'direct' },
  claim: { canonical: 'claimPayout', kind: 'direct' },
  claim_release: { canonical: 'drawRelease', kind: 'direct' },
  crank_status: { canonical: 'crankStatus', kind: 'direct' },
  burn_retired: { canonical: 'burnRetired (permissionless; sent by the keeper)', kind: 'direct' },
  request_pause: { canonical: 'requestPause', kind: 'direct' },
  withdraw_pause_request: { canonical: 'withdrawPauseRequest (advances the pause nonce)', kind: 'direct' },
  approve_pause: { canonical: "approvePause (permissionless; the named key's PAUSE signature over the live pause nonce, sent by the keeper)", kind: 'direct' },
  end_pause: { canonical: 'endPause', kind: 'direct' },
  redeem: { canonical: 'redeem (optional product slippage guard omitted)', kind: 'direct' },
  claim_redemption: { canonical: 'claimRedemption', kind: 'direct' },
  claim_tail: { canonical: 'claimTail', kind: 'direct' },
  claim_final: { canonical: 'claimFinal', kind: 'direct' },
  extinguish: { canonical: "extinguish (permissionless; the two named keys' EXTINGUISH signatures over the live extinguish nonce, sent by the keeper)", kind: 'direct' },
  amend_terms: { canonical: "amendTerms (the issuer's; the named key's AMEND signature over the live amendment nonce)", kind: 'direct' },
  fx_snapshot: { canonical: 'snapshotFx', kind: 'direct' },
  set_fx_pair: { canonical: 'setFxPair', kind: 'direct' },
  open_window: { canonical: 'openTransferWindow (period kept by the runner)', kind: 'shim', shim: 'SH-WIN-1' },
  window_commit_bid: { canonical: 'commitWindowOrder(side=buy)', kind: 'shim', shim: 'SH-WIN-3' },
  commit_ask: { canonical: 'commitWindowOrder(side=sell)', kind: 'shim', shim: 'SH-WIN-2' },
  reveal_order: { canonical: 'revealWindowOrder', kind: 'shim', shim: 'SH-WIN-4' },
  begin_window_settlement: { canonical: 'none (recorded; clearTransferWindow is one step)', kind: 'shim', shim: 'SH-WIN-5' },
  finalize_window: { canonical: 'clearTransferWindow', kind: 'shim', shim: 'SH-WIN-6' },
  process_orders: { canonical: 'none (canonical clearing delivers inside clearTransferWindow)', kind: 'shim', shim: 'SH-WIN-7' },
  route_income: { canonical: 'postSplitReceipt', kind: 'not-yet', milestone: 'S5' },
  close_router_period: { canonical: 'none', kind: 'not-yet', milestone: 'S5' },
  submit_trueup: { canonical: 'submitTrueUp', kind: 'direct' },
  pay_trueup: { canonical: 'payTrueUp', kind: 'direct' },
  set_flags: { canonical: 'pauseNewRaises (Stage 1 also has windows_enabled)', kind: 'not-yet', milestone: 'S5' },
  stop_issuance: { canonical: 'stopIssuance', kind: 'not-yet', milestone: 'S5' },
  resume_issuance: { canonical: 'none', kind: 'not-yet', milestone: 'S5' },
  retire_if_capped: { canonical: 'retireIfCapped', kind: 'direct' },
  register_holder: { canonical: 'registerHolder', kind: 'direct' },
  transfer_units: { canonical: 'transferUnits (hook refuses DirectTransferForbidden)', kind: 'direct' },
  deactivate_issuer: { canonical: 'none', kind: 'not-yet', milestone: 'S5' },
  revoke_verifier_key: { canonical: 'revokeVerifierKey (forward-only, the 45-day grace on tier-2 reports, never the last active key)', kind: 'direct' },
  set_contract_hash: { canonical: 'none', kind: 'not-yet', milestone: 'S5' },
  set_release_pause: { canonical: 'none', kind: 'not-yet', milestone: 'S5' },
};

interface Inventory {
  files: number;
  steps: number;
  reverts: number;
  ops: number;
  lines: string[];
}

/** The ops, expects and reverts of each Stage 1 vector, and how each op runs now (the `VECTOR_PARITY.md` appendix). */
export function inventoryStage1Vectors(dir: string): Inventory {
  const files = readdirSync(dir).filter((f) => /^\d\d_.*\.json$/.test(f)).sort();
  const ops = new Map<string, number>();
  const expects = new Map<string, number>();
  let totalSteps = 0;
  let totalReverts = 0;
  const lines: string[] = ['## Inventory', '', '| Vector | Steps | Expect checks | Expected reverts | Ops the merces backend shims, blocks or lacks |', '| --- | --- | --- | --- | --- |'];
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
    return e.kind === 'not-yet' ? `not yet (${e.milestone})` : `${e.kind}${e.shim ? ` (${e.shim})` : ''}`;
  };
  lines.push(
    '',
    '### Ops used and how they run on the merces backend',
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
 * Stage 1 format: run the vector runner on the reference backend (every vector) and on the merces backend (the
 * targets in full and the prefix-gated vectors to their gate, both personalities). Status: `ok` iff every run is at its
 * expected status; `fail` when one is not or the reference backend does not replay a vector (the runner or the Stage 1
 * checkout is broken).
 */
async function replayStage1Vectors(dir: string, ctx: StepCtx): Promise<StepReport> {
  const inv = inventoryStage1Vectors(dir);
  const runner = await import('../stage1-vectors/index.ts');
  const label = dir.startsWith(ctx.location.root + '/') ? `$STAGE1_PATH/${relative(ctx.location.root, dir)}` : dir;
  const source = { dir: label, ...(ctx.location.manifest.commit ? { commit: ctx.location.manifest.commit } : {}) };
  const details: string[] = [];
  const reports: Awaited<ReturnType<typeof runner.runStage1Vectors>>[] = [];
  let sections: string[] = [];
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
    } else {
      const merces = await runner.runStage1Vectors({ dir, backend: 'merces' });
      reports.push(merces);
      const at = merces.runs.filter((r) => r.atExpected).length;
      const gates = Object.keys(runner.PREFIX_GATES).length;
      const diverging = merces.runs.filter((r) => r.status === 'PASS-WITH-DIVERGENCES').length;
      details.push(`merces backend: ${at}/${merces.runs.length} run(s) at expected status (${runner.TARGETS.length} targets and ${gates} prefix gates × personalities; ${diverging} run(s) with accepted divergences, see VECTOR_PARITY.md)`);
      for (const r of merces.runs.filter((x) => !x.atExpected)) details.push(`merces ${r.vector} [${r.world}]: ${r.status}, expected ${runner.describeExpected(r.expected)}`);
      // our scenarios (the S3 claim set, S3 plan WP2; the S4 signature set, S4 plan §4): Stage 1's simulator, ours on
      // both personalities, and the two in lockstep; a merces-only scenario (S4d) runs on the merces backend alone
      const scenarioReports: typeof reports = [];
      let scenarios: Awaited<ReturnType<typeof runner.runScenarios>>['scenarios'] = [];
      let skipped = 0;
      for (const backend of ['reference', 'merces', 'lockstep'] as const) {
        const r = await runner.runScenarios({ vectorsDir: dir, backend });
        scenarios = r.scenarios;
        skipped += r.skipped.length;
        scenarioReports.push(r.report);
      }
      sections = runner.renderScenarios(scenarios, scenarioReports);
      const scenarioRuns = scenarioReports.flatMap((r) => r.runs);
      const scenariosOk = scenarioReports.every((r) => r.ok);
      const scenarioDiverging = scenarioRuns.filter((r) => r.status === 'PASS-WITH-DIVERGENCES').length;
      const sets = runner.SCENARIO_SETS.map((x) => `${scenarios.filter((s) => runner.scenarioSetOf(s) === x).length} ${x.id}`).join(', ');
      details.push(`our scenarios: ${scenarios.length} (${sets}), ${scenarioRuns.filter((r) => r.status === 'PASS').length}/${scenarioRuns.length} run(s) PASS on the reference, merces and lockstep backends${scenarioDiverging ? `, ${scenarioDiverging} PASS-WITH-DIVERGENCES on a recorded Stage 1-internal difference resolved toward both chains (see VECTOR_PARITY.md)` : ''}${skipped ? `, ${skipped} backend(s) skipped by merces-only scenarios` : ''}; ${scenarioRuns.filter((r) => r.atExpected).length}/${scenarioRuns.length} at expected status`);
      for (const r of scenarioRuns.filter((x) => !x.atExpected)) details.push(`scenario ${r.vector} [${r.world}]: ${r.status}, expected ${runner.describeExpected(r.expected)}`);
      status = merces.ok && scenariosOk ? 'ok' : 'fail';
      summary = !merces.ok
        ? `${merces.runs.length - at} run(s) below their expected status: our simulator disagrees with Stage 1`
        : scenariosOk
          ? `every target and prefix gate is at its expected status on both personalities, and our scenarios are at theirs (in lockstep where Stage 1's simulator models the rule); ${refLine}`
          : `${scenarioRuns.filter((r) => !r.atExpected).length} scenario run(s) of ours are below their expected status: our simulator disagrees with Stage 1`;
    }
  } catch (e) {
    status = 'fail';
    summary = `the vector runner failed: ${e instanceof runner.RunnerError ? e.message : e instanceof Error ? e.constructor.name : typeof e}`;
  } finally {
    await runner.shutdown();
  }
  runner.writeParity(ctx.outDir, reports, source, { sections, appendix: inv.lines });
  details.push(`${inv.files} vectors, ${inv.steps} steps (${inv.reverts} expected reverts), ${inv.ops} distinct ops counting the calls inside reverts; see VECTOR_PARITY.md`);
  return { step: 'vectors', status, summary, details };
}
