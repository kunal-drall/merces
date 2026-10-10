import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as gateway from '@merces/math';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';

/**
 * The Stage 1 reference names `@merces/math` re-exports (S1 plan WP1 (c)). Each must be Stage 1's own object, not a
 * copy: that is what makes Stage 1 the implementation rather than a reference we compare against.
 */
export const REFERENCE_REEXPORTS = [
  // status, deadlines and accrual
  'isTerminal', 'deadlineSeconds', 'graceSeconds', 'noticeSeconds', 'countdown', 'nextExpectedPeriod', 'earliestUnpaid', 'deriveStatus', 'isLateUnderlying', 'lateDays', 'lateAccrual', 'formalNoticeDue', 'pauseApprovalError',
  // payout vault
  'newVaultState', 'capPerUnit', 'capEffWad', 'isCapped', 'vaultReceiveGross', 'settleHolderDelta', 'accumulate',
  // redemption, tail and extinguishment
  'hurdlePrice', 'averageAnnualGross', 'redemptionQuote', 'newTailState', 'tailReceive', 'newFinalState', 'finalDistribute',
  // treasury
  'MAX_RELEASE_TRANCHES', 'validateReleaseSchedule', 'trancheAmounts', 'vested', 'releasable',
  // income
  'owedYtd', 'paymentUsd',
] as const;

/**
 * The interim (Part C) math still exported under `interim`, by family. S1 moved every other family to Stage 1's own
 * functions; these two remain until S2 (Stage 1's auction) and S5 (Stage 1's FX accumulator). A name outside them is
 * reported as "unclassified".
 */
export const INTERIM_FAMILIES: { family: string; names: string[] }[] = [
  { family: 'FX (S5)', names: ['quarterAverageRate', 'coverageOk', 'deviationBps', 'withinBand', 'pythToWad'] },
  { family: 'auction (S2)', names: ['clearAuction', 'walletCapUnits', 'bidDeposit', 'auctionFee'] },
];

/** Interim families with at least one name still exported, with those names; unknown names land in "unclassified". */
export function interimRemaining(keys: readonly string[] = Object.keys(gateway.interim)): { family: string; names: string[] }[] {
  const out: { family: string; names: string[] }[] = [];
  const known = new Set<string>();
  for (const f of INTERIM_FAMILIES) {
    for (const n of f.names) known.add(n);
    const names = f.names.filter((n) => keys.includes(n));
    if (names.length) out.push({ family: f.family, names });
  }
  const other = keys.filter((k) => !known.has(k));
  if (other.length) out.push({ family: 'unclassified', names: other });
  return out;
}

/**
 * Step 4: check that the math we run is Stage 1's, at the pinned commit.
 *
 * `@merces/math` re-exports Stage 1's functions instead of re-implementing them, so a function-by-function parity
 * comparison would compare Stage 1 with itself (behavioural parity is the vector runner's job). What can go wrong is
 * the pin and the wiring, and this step checks both:
 * - the Stage 1 checkout is at the commit the manifest (`stage1.map.json`) pins;
 * - every name in REFERENCE_REEXPORTS is the identical object exported by the checkout's math package.
 * "ok" needs both. A drop that names no math package, pins no commit or is not a git checkout cannot be checked
 * ("warn"); a checkout at another commit, a missing or substituted function, or an unloadable package is "fail".
 * Writes MATH_PARITY.md (snapshot committed as docs/stage1/MATH_PARITY.md).
 */
export async function checkMathPin(ctx: StepCtx): Promise<StepReport> {
  const m = ctx.location.manifest;
  const details: string[] = [];
  const remaining = interimRemaining();
  const pkg = m.math?.package;
  if (!pkg) {
    writeParity(ctx, { pkg: null, commit: null, verdict: 'not checked: the manifest names no math package', remaining });
    return { step: 'math', status: 'warn', summary: 'manifest has no math package; the Stage 1 math pin cannot be checked', details };
  }

  // the pin
  const pinned = m.commit ?? null;
  const head = checkoutHead(ctx.location.root);
  let pin: 'ok' | 'warn' | 'fail';
  if (!pinned) {
    pin = 'warn';
    details.push('the manifest pins no commit');
  } else if (!head) {
    pin = 'warn';
    details.push(`${ctx.location.root} is not a git checkout; cannot confirm it is at ${pinned}`);
  } else if (!head.startsWith(pinned)) {
    pin = 'fail';
    details.push(`Stage 1 checkout is at ${head.slice(0, 7)} but ${relativeName(ctx)} pins ${pinned}`);
  } else {
    pin = 'ok';
    details.push(`Stage 1 checkout at ${head.slice(0, 7)} = pinned ${pinned}`);
  }

  // the wiring
  const entry = resolveMathEntry(ctx.location.root, pkg);
  if ('error' in entry) {
    writeParity(ctx, { pkg, commit: head ?? pinned, verdict: `not checked: ${entry.error}`, remaining });
    return { step: 'math', status: 'fail', summary: entry.error, details };
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(entry.specifier)) as Record<string, unknown>;
  } catch (e) {
    const why = `cannot load Stage 1 math ${pkg}: ${(e as Error).message}`;
    writeParity(ctx, { pkg, commit: head ?? pinned, verdict: `not checked: ${why}`, remaining });
    return { step: 'math', status: 'fail', summary: why, details };
  }
  const ours = gateway as unknown as Record<string, unknown>;
  const missing = REFERENCE_REEXPORTS.filter((n) => !(n in mod));
  const substituted = REFERENCE_REEXPORTS.filter((n) => n in mod && ours[n] !== mod[n]);
  const identical = REFERENCE_REEXPORTS.length - missing.length - substituted.length;
  details.push(`${identical}/${REFERENCE_REEXPORTS.length} re-exports are Stage 1's own objects`);
  if (missing.length) details.push(`Stage 1 ${pkg} no longer exports: ${missing.join(', ')}`);
  if (substituted.length) details.push(`@merces/math exports a different object than Stage 1 for: ${substituted.join(', ')}`);
  details.push(`interim families remaining: ${remaining.map((f) => f.family).join(', ') || 'none'}`);

  const wired = missing.length === 0 && substituted.length === 0;
  const commit = (head ?? pinned ?? 'unknown').slice(0, 7);
  writeParity(ctx, {
    pkg,
    commit,
    verdict: wired ? `imported at ${commit}` : `NOT imported faithfully at ${commit} (${[...missing.map((n) => `${n} missing`), ...substituted.map((n) => `${n} substituted`)].join(', ')})`,
    remaining,
    identical,
  });
  if (!wired || pin === 'fail') {
    return { step: 'math', status: 'fail', summary: !wired ? 'Stage 1 math is not what @merces/math re-exports (see MATH_PARITY.md)' : 'Stage 1 checkout is not at the pinned commit', details };
  }
  if (pin === 'warn') return { step: 'math', status: 'warn', summary: 'Stage 1 math wired through @merces/math; the pin could not be checked', details };
  return { step: 'math', status: 'ok', summary: `Stage 1 math imported at ${commit}; @merces/math re-exports Stage 1's own functions`, details };
}

function relativeName(ctx: StepCtx): string {
  return ctx.location.kind === 'map' ? 'stage1.map.json' : 'the Stage 1 manifest';
}

/** HEAD of the git checkout rooted exactly at `root` (null when `root` is not the top of a checkout, or no git). */
function checkoutHead(root: string): string | null {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return null;
    return git('rev-parse', 'HEAD');
  } catch {
    return null;
  }
}

function writeParity(ctx: StepCtx, r: { pkg: string | null; commit: string | null; verdict: string; remaining: { family: string; names: string[] }[]; identical?: number }): void {
  const families = r.remaining.map((f) => f.family).join(', ') || 'none';
  const lines = [
    '# MATH_PARITY.md',
    '',
    r.verdict.startsWith('imported at ') ? `Stage 1 math ${r.verdict}; interim families remaining: ${families}.` : `Stage 1 math ${r.verdict}. Interim families remaining: ${families}.`,
    '',
    `- Stage 1 math package: ${r.pkg ?? '(none named)'}${r.commit ? ` at ${r.commit}` : ''}.`,
  ];
  if (r.identical !== undefined) {
    lines.push(`- \`@merces/math\` re-exports ${REFERENCE_REEXPORTS.length} Stage 1 reference names (status, vault, redemption, treasury, income); ${r.identical} are Stage 1's own objects. It also re-exports \`@merces/sdk\`'s fixed point, periods, pauses, year ring, parameters and error names.`);
  }
  lines.push(
    '- No function-by-function comparison: the gateway runs Stage 1\'s functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file\'s git history.',
    '- The interim (Part C) math survives only under `interim.*`: since S1, only the auction family (S2) and the FX family (S5). Any other name there is reported as unclassified.',
    '',
  );
  if (r.remaining.length) {
    lines.push('| Interim family | Names still exported under `interim` |', '| --- | --- |');
    for (const f of r.remaining) lines.push(`| ${f.family} | ${f.names.map((n) => `\`${n}\``).join(', ')} |`);
    lines.push('');
  }
  writeFileSync(join(ctx.outDir, 'MATH_PARITY.md'), lines.join('\n'));
}

/**
 * Where to import Stage 1's math from. A path (relative to the Stage 1 root) to a package directory resolves through
 * its package.json `exports`/`main`; an unbuilt package is reported with the command that builds it. Anything else is
 * imported as a bare specifier.
 */
export function resolveMathEntry(root: string, pkg: string): { specifier: string } | { error: string } {
  const p = resolve(root, pkg);
  if (!existsSync(p)) {
    if (pkg.startsWith('.') || pkg.startsWith('/')) return { error: `Stage 1 math ${pkg} not found at ${p}` };
    return { specifier: pkg };
  }
  if (!statSync(p).isDirectory()) return { specifier: pathToFileURL(p).href };
  const manifest = join(p, 'package.json');
  if (!existsSync(manifest)) return { error: `Stage 1 math ${pkg} has no package.json` };
  const pj = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; main?: string; exports?: Record<string, unknown> };
  const dot = pj.exports?.['.'];
  const rel = (typeof dot === 'string' ? dot : (dot as { import?: string; default?: string } | undefined)?.import ?? (dot as { default?: string } | undefined)?.default) ?? pj.main ?? 'index.js';
  const file = resolve(p, rel);
  if (!existsSync(file)) {
    return { error: `Stage 1 math ${pj.name ?? pkg} is not built (${rel} missing): run \`pnpm install && pnpm -r --filter '${pj.name ?? pkg}...' build\` in the Stage 1 checkout` };
  }
  return { specifier: pathToFileURL(file).href };
}
