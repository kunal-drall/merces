import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  'isTerminal', 'deadlineSeconds', 'graceSeconds', 'noticeSeconds', 'countdown', 'nextExpectedPeriod', 'earliestUnpaid', 'deriveStatus', 'isLateUnderlying', 'lateDays', 'newFxPairState', 'validatePythPrice', 'deviates', 'snapshot', 'quarterAverage', 'snapshotsNeeded', 'normalizePythPrice', 'invertRate', 'lateAccrual', 'lateAccrualTrueup', 'trueupNoticeDue', 'formalNoticeDue', 'pauseApprovalError',
  // payout vault
  'newVaultState', 'capPerUnit', 'capEffWad', 'isCapped', 'vaultReceiveGross', 'settleHolderDelta', 'accumulate',
  // redemption, tail and extinguishment
  'hurdlePrice', 'averageAnnualGross', 'redemptionQuote', 'newTailState', 'tailReceive', 'newFinalState', 'finalDistribute',
  // treasury
  'MAX_RELEASE_TRANCHES', 'validateReleaseSchedule', 'trancheAmounts', 'vested', 'releasable',
  // income
  'owedYtd', 'paymentUsd',
  // SPEC §6.5: router arithmetic and bounded checkpoint ring, Stage 1 objects.
  'newRouterState', 'closeRouterPeriod', 'closePeriodsThrough', 'ytdAtEnd', 'routeIncome', 'ROUTER_CHECKPOINT_RING',
  // auction (SPEC §5.1-5.2; S2)
  'walletCapUnitsAtAuction', 'requiredEscrow', 'isBidValid', 'beginSettlement', 'tallyBids', 'isClearingPriceValid', 'finalizeSettlement', 'marginalAllocation', 'processBid', 'claimsFor', 'findClearingPrice',
  'walletCapUnits', 'requiredBidEscrow', 'isOrderValid', 'tallyOrders', 'isNoMatchValid', 'classifyWindowPrice', 'finalizeWindow', 'findWindowClearingPrice', 'computeFills',
] as const;

/** Where the ported family's Rust lives in a Stage 1 checkout (merces-common, "CM"). */
export const MERCES_COMMON = 'solana/crates/merces-common/src';

const CURVE_ONLY = 'none (curve mode only)';

/**
 * The family `@merces/math` ports from Stage 1's Rust (S3, A-MATH-3), because Stage 1's TypeScript has no `unit_scale`
 * and no curve code. They are ours, not Stage 1 objects; at scale 1 the scale-aware ones call Stage 1's own TypeScript
 * function (`scale1` says what each is at scale 1, as the parity report prints it). Each names the merces-common items
 * it ports (`file:item` under MERCES_COMMON; the Solana program only calls them, e.g. `receive_tail` in
 * `common.rs:595-612` and the deposit in `exit.rs:125`) and a fingerprint of their source at the port (`sha`: the
 * first 16 hex digits of a sha256 over the items' text, in order), so a Stage 1 bump that removes or changes one fails
 * the math step until the port is redone or becomes an import.
 */
export const PORTED: readonly { name: string; rust: readonly string[]; scale1: string; sha: string }[] = [
  { name: 'CURVE_BASE_DECIMALS', rust: ['curve.rs:CURVE_BASE_DECIMALS'], scale1: CURVE_ONLY, sha: 'b3fd9a1209dabc43' },
  { name: 'CURVE_UNIT_SCALE', rust: ['curve.rs:CURVE_UNIT_SCALE'], scale1: CURVE_ONLY, sha: 'c5f54ea10bf80b20' },
  { name: 'unitScaleFor', rust: ['curve.rs:unit_scale_for'], scale1: CURVE_ONLY, sha: '8099035cfbf8d289' },
  { name: 'wadPerScaledUnit', rust: ['vault.rs:wad_per_scaled_unit'], scale1: "Stage 1's `WAD`", sha: 'aed6006fe56ea4ba' },
  { name: 'scaledCapWad', rust: ['vault.rs:scaled_cap_wad'], scale1: "Stage 1's `cap × WAD` (`capEffWad(cap, 0)`)", sha: 'd672878bdf6cfce2' },
  { name: 'scaledAmount', rust: ['vault.rs:scaled_amount'], scale1: "Stage 1's `P_redeem × units` (`redemptionQuote`'s deposit)", sha: '340845fe87bf5330' },
  { name: 'isCappedScaled', rust: ['vault.rs:is_capped'], scale1: "Stage 1's `isCapped`", sha: '54f3bb53005159b2' },
  { name: 'vaultReceiveGrossScaled', rust: ['vault.rs:receive_capped', 'vault.rs:distribute', 'vault.rs:scaled_cap_wad'], scale1: "Stage 1's `vaultReceiveGross`", sha: 'e520145cc7823336' },
  { name: 'tailReceiveScaled', rust: ['vault.rs:receive_capped', 'vault.rs:scaled_cap_wad'], scale1: "Stage 1's `tailReceive`", sha: '2dcd8a3a53600fc1' },
  { name: 'capRemainingScaled', rust: ['redemption.rs:redemption_price'], scale1: "Stage 1's `redemptionQuote(…).cRemaining` (our `capRemaining`)", sha: '646af69bd10d2474' },
  { name: 'redemptionQuoteScaled', rust: ['redemption.rs:redemption_price', 'vault.rs:scaled_amount'], scale1: "Stage 1's `redemptionQuote`", sha: '94a605cdaf67f4c6' },
  { name: 'p0PerUnit', rust: ['curve.rs:p0_per_unit'], scale1: CURVE_ONLY, sha: 'b66b2b0e7a003a03' },
  { name: 'swapBaseMatchesOffer', rust: ['curve.rs:swap_base_matches_offer'], scale1: CURVE_ONLY, sha: '4a88a1f45b237a50' },
  { name: 'unitsOutstanding', rust: ['curve.rs:units_outstanding'], scale1: CURVE_ONLY, sha: '4c3cfb602b8aee08' },
  { name: 'migrationFeeSplit', rust: ['curve.rs:migration_fee_split'], scale1: CURVE_ONLY, sha: 'a69c44d72fdbb25b' },
  { name: 'walletTenderFits', rust: ['curve.rs:wallet_tender_fits'], scale1: CURVE_ONLY, sha: 'cf07edba4454aa1e' },
];

/**
 * The source text of one merces-common item (`file:item`) in a checkout: a `const` line, or a `fn` from its signature
 * to the closing brace at its own indentation (rustfmt's layout). Null when the file or the item is missing.
 */
export function rustItem(root: string, ref: string): string | null {
  const [file, item] = ref.split(':') as [string, string];
  const path = join(root, MERCES_COMMON, file);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  const head = new RegExp(`^(\\s*)(?:pub(?:\\([a-z]+\\))? )?(const|fn) ${item}\\b`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const [, indent, kind] = head.exec(lines[start]!)!;
  if (kind === 'const') return lines[start]!;
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  return end < 0 ? null : lines.slice(start, end + 1).join('\n');
}

/** The fingerprint of a ported name's Rust items (null when one is missing). */
export function portedFingerprint(root: string, rust: readonly string[]): string | null {
  const texts = rust.map((r) => rustItem(root, r));
  if (texts.some((t) => t === null)) return null;
  return createHash('sha256').update(texts.join('\n\u0000\n')).digest('hex').slice(0, 16);
}

/**
 * Checks the ported family against a checkout: every name exported by `@merces/math`, every Rust item still there and
 * unchanged since the port, and none yet exported by Stage 1's math package (then the port should become an import).
 * Without the Rust crate in the drop nothing can be checked ("warn").
 */
export function checkPorted(root: string, stage1Math: Record<string, unknown>): { status: 'ok' | 'warn' | 'fail'; details: string[] } {
  const ours = gateway as unknown as Record<string, unknown>;
  const details: string[] = [];
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  const notExported = PORTED.filter((p) => !(p.name in ours)).map((p) => p.name);
  if (notExported.length) {
    status = 'fail';
    details.push(`@merces/math does not export the ported names: ${notExported.join(', ')}`);
  }
  const imported = PORTED.filter((p) => p.name in stage1Math).map((p) => p.name);
  if (imported.length) {
    if (status === 'ok') status = 'warn';
    details.push(`Stage 1's math now exports ${imported.join(', ')}: replace the port with an import (A-MATH-3)`);
  }
  if (!existsSync(join(root, MERCES_COMMON))) {
    if (status === 'ok') status = 'warn';
    details.push(`ported family not checked: ${MERCES_COMMON} is not in this drop`);
    return { status, details };
  }
  const missing: string[] = [];
  const changed: string[] = [];
  for (const p of PORTED) {
    const sha = portedFingerprint(root, p.rust);
    if (sha === null) missing.push(`${p.name} (${p.rust.filter((r) => rustItem(root, r) === null).join(', ')})`);
    else if (sha !== p.sha) changed.push(`${p.name} (${p.rust.join(', ')})`);
  }
  if (missing.length) details.push(`merces-common items of ported names missing at this checkout: ${missing.join('; ')}`);
  if (changed.length) details.push(`merces-common items changed since the port (re-port, then update PORTED's fingerprint): ${changed.join('; ')}`);
  if (missing.length || changed.length) status = 'fail';
  else details.push(`ported family: the merces-common items of all ${PORTED.length} names present and unchanged since the port (@1bfc66b)`);
  return { status, details };
}

/**
 * The interim (Part C) math still exported under `interim`, by family. S1 moved every other family to Stage 1's own
 * functions and S2 the sealed-bid auction; these two remain until S5 (Stage 1's window semantics and FX accumulator).
 * A name outside them is reported as "unclassified".
 */
export const INTERIM_FAMILIES: { family: string; names: string[] }[] = [
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
 * "ok" needs both, and the ported family (PORTED, A-MATH-3) whole: exported by `@merces/math`, its merces-common items
 * present and unchanged since the port, none yet exported by Stage 1's math (then it should become an import, "warn").
 * A drop that names no math package, pins no commit or is not a git checkout cannot be checked ("warn"); a checkout at
 * another commit, a missing or substituted function, an unloadable package or a stale port is "fail".
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
  details.push(`${identical}/${REFERENCE_REEXPORTS.length} re-exports are Stage 1's own objects; ${PORTED.length} ported (curve, A-MATH-3)`);
  if (missing.length) details.push(`Stage 1 ${pkg} no longer exports: ${missing.join(', ')}`);
  if (substituted.length) details.push(`@merces/math exports a different object than Stage 1 for: ${substituted.join(', ')}`);
  // the ported family (A-MATH-3): its Rust sources at this checkout
  const ported = checkPorted(ctx.location.root, mod);
  details.push(...ported.details);
  details.push(`interim families remaining: ${remaining.map((f) => f.family).join(', ') || 'none'}`);

  const wired = missing.length === 0 && substituted.length === 0;
  const commit = (head ?? pinned ?? 'unknown').slice(0, 7);
  writeParity(ctx, {
    pkg,
    commit,
    verdict: wired ? `imported at ${commit}` : `NOT imported faithfully at ${commit} (${[...missing.map((n) => `${n} missing`), ...substituted.map((n) => `${n} substituted`)].join(', ')})`,
    remaining,
    identical,
    ported,
  });
  if (!wired || pin === 'fail' || ported.status === 'fail') {
    const summary = !wired ? 'Stage 1 math is not what @merces/math re-exports (see MATH_PARITY.md)' : pin === 'fail' ? 'Stage 1 checkout is not at the pinned commit' : 'the ported curve family no longer matches Stage 1\'s Rust at this checkout (see MATH_PARITY.md)';
    return { step: 'math', status: 'fail', summary, details };
  }
  if (pin === 'warn') return { step: 'math', status: 'warn', summary: 'Stage 1 math wired through @merces/math; the pin could not be checked', details };
  if (ported.status === 'warn') return { step: 'math', status: 'warn', summary: `Stage 1 math imported at ${commit}; the ported curve family needs attention (see MATH_PARITY.md)`, details };
  return { step: 'math', status: 'ok', summary: `Stage 1 math imported at ${commit}; @merces/math re-exports Stage 1's own functions, beside ${PORTED.length} ported from its Rust (A-MATH-3)`, details };
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

function writeParity(ctx: StepCtx, r: { pkg: string | null; commit: string | null; verdict: string; remaining: { family: string; names: string[] }[]; identical?: number; ported?: { status: 'ok' | 'warn' | 'fail'; details: string[] } }): void {
  const families = r.remaining.map((f) => f.family).join(', ') || 'none';
  const lines = [
    '# MATH_PARITY.md',
    '',
    r.verdict.startsWith('imported at ') ? `Stage 1 math ${r.verdict}; interim families remaining: ${families}.` : `Stage 1 math ${r.verdict}. Interim families remaining: ${families}.`,
    '',
    `- Stage 1 math package: ${r.pkg ?? '(none named)'}${r.commit ? ` at ${r.commit}` : ''}.`,
  ];
  if (r.identical !== undefined) {
    lines.push(`- \`@merces/math\` re-exports ${REFERENCE_REEXPORTS.length} Stage 1 reference names (status, vault, redemption, treasury, income, auction); ${r.identical} are Stage 1's own objects. It also re-exports \`@merces/sdk\`'s fixed point, periods, pauses, year ring, parameters and error names.`);
  }
  lines.push(
    '- No function-by-function comparison: the gateway runs Stage 1\'s functions, so comparing them would compare Stage 1 with itself. Behavioural parity is measured by the Stage 1 vector runner (`VECTOR_PARITY.md`). The last comparison of the interim math against Stage 1 (6 of 12 families disagreeing) is in this file\'s git history.',
    '- All interim mechanism math has been retired. An unexpected name under `interim` is reported as unclassified.',
    '',
  );
  if (r.remaining.length) {
    lines.push('| Interim family | Names still exported under `interim` |', '| --- | --- |');
    for (const f of r.remaining) lines.push(`| ${f.family} | ${f.names.map((n) => `\`${n}\``).join(', ')} |`);
    lines.push('');
  }
  lines.push(
    '## Ported from Stage 1\'s Rust (A-MATH-3)',
    '',
    `Stage 1's TypeScript has no \`unit_scale\` and no curve code, so \`@merces/math\` ports ${PORTED.length} names from merces-common (\`${MERCES_COMMON}\`) @1bfc66b, kept apart from the re-exports. They are not Stage 1 objects. At scale 1 each scale-aware one returns Stage 1's own TypeScript function's result (it calls it), so a sealed-bid series runs only Stage 1's functions (\`packages/math/test/curve.test.ts\` checks that on seeded grids). This step checks each Rust item still exists at the checkout and is unchanged since the port (fingerprint); the \`curve-port\` step checks what the family computes against Stage 1's figures and Stage 1's Rust on every sync (below). Stage 1 is asked to add \`unit_scale\` to its TypeScript so these become imports.`,
    '',
  );
  if (r.ported) lines.push(`Check at this checkout: **${r.ported.status}**. ${r.ported.details.join(' ')}`, '');
  lines.push('| Ported name | merces-common items | At scale 1 (in Stage 1 TypeScript) |', '| --- | --- | --- |');
  for (const p of PORTED) lines.push(`| \`${p.name}\` | ${p.rust.map((x) => `\`${x}\``).join(', ')} | ${p.scale1} |`);
  lines.push('');
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
