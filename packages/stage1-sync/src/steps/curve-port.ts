import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { StepReport } from '../report.ts';
import type { StepCtx } from './generate.ts';
import { PORTED } from './math.ts';
import { CORPUS_SEED, buildCorpus } from '../curve-port/corpus.ts';
import { ORACLE_FNS, OUR_FAMILY, canonical, ours, uncovered, wire, type Answer, type OracleFn, type PortedFamily } from '../curve-port/family.ts';
import { checkFigures, loadFixtures } from '../curve-port/figures.ts';
import { ORACLE_DIR, OracleError, REPO_ROOT, STAGE1_TOOLCHAIN_FILE, buildOracle, cargoEnv, crateFor, findCargo, runOracle, stage1Toolchain, toolchainVersions } from '../curve-port/oracle.ts';

export interface CurvePortOptions {
  /** the ported family under test (default: `@merces/math`'s); a test hands in a deliberately wrong function */
  family?: PortedFamily;
  /** the cargo to run (default: `CARGO`, else `cargo` on PATH, else `~/.cargo/bin/cargo`) */
  cargo?: string;
  /** the oracle crate (default: `tools/stage1-oracle`) */
  oracleDir?: string;
  /** the corpus seed (default `CORPUS_SEED`) */
  seed?: bigint;
}

/** At most this many disagreements are listed in the report (all are counted). */
const LISTED = 12;

interface OracleResult {
  total: number;
  agreed: number;
  fingerprint: string;
  seed: bigint;
  cargo: string;
  rustc: string | null;
  pinned: string | null;
  crate: string;
  perFn: { fn: OracleFn; cases: number; agreed: number }[];
}

/**
 * Step 4b, `curve-port`: runs `@merces/math`'s ported curve family (A-MATH-3) against Stage 1 on every sync, and fails
 * the sync on any disagreement.
 *
 * 1. **Stage 1's figures** (`curve-port/figures.ts`): every figure Stage 1's curve fixtures, merces-common's unit tests
 *    and the LiteSVM curve tests give for what the port computes, each row citing its Stage 1 lines; a citation that
 *    no longer holds fails as stale.
 * 2. **Stage 1's Rust** (`tools/stage1-oracle`): the oracle crate is built against the checkout's merces-common with
 *    Stage 1's toolchain, a deterministic corpus (edges, then seeded draws within Stage 1's input ranges) runs through
 *    it and through the port, and every answer, refusals included, must agree exactly.
 *
 * No cargo, no merces-common, no fixtures or a failed build is a failure, never a skip: the owner wants a gate. A
 * build with another toolchain than Stage 1's pin is reported ("warn") but not a failure (the arithmetic is integer
 * only). Appends its result to MATH_PARITY.md.
 */
export async function checkCurvePort(ctx: StepCtx, opts: CurvePortOptions = {}): Promise<StepReport> {
  const family = opts.family ?? OUR_FAMILY;
  const root = ctx.location.root;
  const details: string[] = [];
  const failures: string[] = [];
  let warned = false;

  const gaps = uncovered();
  if (gaps.length) failures.push(`ported names no oracle entry point answers for: ${gaps.join(', ')}`);

  // (1) Stage 1's figures
  let figures: { pass: number; total: number } | null = null;
  const fx = loadFixtures(root);
  if ('missing' in fx) {
    failures.push(fx.missing);
    details.push(`figures: not checked: ${fx.missing}`);
  } else {
    const results = checkFigures(family, root, fx);
    const bad = results.filter((r) => !r.ok);
    figures = { pass: results.length - bad.length, total: results.length };
    details.push(`figures: ${figures.pass}/${figures.total} of Stage 1's figures agree (curve_config.json, curve_reports.json, merces-common's unit tests, curve_mode.rs), every citation holding at this checkout`);
    for (const r of bad.slice(0, LISTED)) details.push(`  ✗ ${r.id}: ${r.detail}`);
    if (bad.length > LISTED) details.push(`  … and ${bad.length - LISTED} more`);
    if (bad.length) failures.push(`${bad.length} of Stage 1's figures disagree or are stale`);
  }

  // (2) Stage 1's Rust
  let oracle: OracleResult | null = null;
  const pinned = stage1Toolchain(root);
  const found = findCargo(opts.cargo);
  if ('missing' in found) {
    const why = `${found.missing}: the curve-port gate needs a Rust toolchain to build Stage 1's merces-common (install rustup and Stage 1's ${pinned ? `${pinned} toolchain` : 'stable toolchain'}: \`rustup toolchain install ${pinned ?? 'stable'} --profile minimal\`; VERSIONS.md)`;
    failures.push(why);
    details.push(`oracle: not run: ${why}`);
  } else {
    try {
      const crate = crateFor(root, ctx.outDir, opts.oracleDir ?? ORACLE_DIR);
      const env = cargoEnv(root, crate.targetDir);
      const versions = toolchainVersions(found.cargo, env);
      const bin = buildOracle(found.cargo, crate, env);
      const corpus = buildCorpus(opts.seed ?? CORPUS_SEED);
      const answers = runOracle(bin, corpus.cases);
      const perFn = new Map<OracleFn, { cases: number; agreed: number }>();
      const disagreements: string[] = [];
      for (const c of corpus.cases) {
        const tally = perFn.get(c.fn) ?? { cases: 0, agreed: 0 };
        perFn.set(c.fn, tally);
        tally.cases++;
        const theirs: Answer | undefined = answers.get(c.id);
        const mine = ours(family, c);
        if (theirs && !('bad' in theirs) && !('panic' in theirs) && canonical(mine) === canonical(theirs)) {
          tally.agreed++;
          continue;
        }
        const args = wire(c);
        disagreements.push(`  ✗ #${c.id} ${c.fn} ${args.length > 360 ? args.slice(0, 360) + '…' : args}: ours ${canonical(mine)}, Stage 1 ${theirs ? canonical(theirs) : '(no answer)'}`);
      }
      const agreed = corpus.cases.length - disagreements.length;
      oracle = {
        total: corpus.cases.length,
        agreed,
        fingerprint: corpus.fingerprint,
        seed: opts.seed ?? CORPUS_SEED,
        cargo: versions.cargo,
        rustc: versions.rustc,
        pinned,
        crate: crate.overlay ? `a copy of tools/stage1-oracle against ${shown(root)}` : relative(REPO_ROOT, crate.dir),
        perFn: (Object.keys(ORACLE_FNS) as OracleFn[]).map((fn) => ({ fn, ...(perFn.get(fn) ?? { cases: 0, agreed: 0 }) })),
      };
      const version = /\b(\d+\.\d+\.\d+)\b/.exec(versions.cargo)?.[1] ?? versions.cargo;
      details.push(
        `oracle: ${agreed.toLocaleString('en-US')}/${corpus.cases.length.toLocaleString('en-US')} cases agree exactly with Stage 1's Rust (merces-common, through ${oracle.crate}; corpus ${corpus.fingerprint}, seed 0x${oracle.seed.toString(16)}; ${PORTED.length}/${PORTED.length} ported names covered)`,
        `oracle: built with ${versions.rustc ?? versions.cargo}${pinned ? ` (Stage 1 pins ${pinned}, ${STAGE1_TOOLCHAIN_FILE})` : ''}`,
      );
      if (pinned && /^\d+\.\d+\.\d+$/.test(pinned) && version !== pinned) {
        warned = true;
        details.push(`oracle: the toolchain is not Stage 1's pin (${version} ≠ ${pinned}); install it: rustup toolchain install ${pinned} --profile minimal`);
      }
      details.push(...disagreements.slice(0, LISTED));
      if (disagreements.length > LISTED) details.push(`  … and ${disagreements.length - LISTED} more`);
      if (disagreements.length) failures.push(`${disagreements.length} oracle case(s) disagree with Stage 1's Rust`);
    } catch (e) {
      const why = e instanceof OracleError ? e.message : `the oracle could not run: ${(e as Error).message}`;
      failures.push(why);
      details.push(`oracle: not run: ${why}`);
    }
  }

  const status: StepReport['status'] = failures.length ? 'fail' : warned ? 'warn' : 'ok';
  const summary = failures.length
    ? `the ported curve family is not proven equal to Stage 1: ${failures.join('; ')}`
    : `ported curve family agrees with Stage 1: ${figures!.pass}/${figures!.total} figures, ${oracle!.agreed.toLocaleString('en-US')}/${oracle!.total.toLocaleString('en-US')} oracle cases against merces-common`;
  writeSection(ctx.outDir, status, summary, figures, oracle);
  return { step: 'curve-port', status, summary, details };
}

/** A path as the report shows it: relative to the repository when inside it. */
function shown(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel === '' ? '.' : rel.startsWith('..') ? path : rel;
}

const HEADING = '## The curve-port gate';

/** Writes (or replaces) the gate's section of MATH_PARITY.md under `outDir`. */
function writeSection(outDir: string, status: StepReport['status'], summary: string, figures: { pass: number; total: number } | null, oracle: OracleResult | null): void {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'MATH_PARITY.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '# MATH_PARITY.md\n\n';
  const at = before.indexOf(`${HEADING}`);
  const kept = (at < 0 ? before : before.slice(0, at)).replace(/\n*$/, '\n\n');
  const lines = [
    HEADING,
    '',
    'Every `stage1:sync` runs the ported family above against Stage 1 itself (step `curve-port`, `packages/stage1-sync/src/steps/curve-port.ts`) and fails the sync on any disagreement: Stage 1\'s figures, one table with a citation per row (`curve-port/figures.ts`), and Stage 1\'s Rust, merces-common built into a small oracle (`tools/stage1-oracle`) that answers a deterministic corpus case by case, refusals included. No cargo is a failure, not a skip.',
    '',
    `Result at this checkout: **${status}**. ${summary}.`,
    '',
  ];
  if (figures) lines.push(`- Stage 1's figures: ${figures.pass}/${figures.total} rows agree (\`curve_config.json\` \`expected\` and \`pdaCreator\`, \`curve_reports.json\`, merces-common's \`curve.rs\`, \`vault.rs\` and \`redemption.rs\` tests, \`curve_mode.rs\`), every citation holding.`);
  if (oracle) {
    lines.push(
      `- Stage 1's Rust: ${oracle.agreed.toLocaleString('en-US')}/${oracle.total.toLocaleString('en-US')} oracle cases agree exactly (corpus \`${oracle.fingerprint}\`, seed \`0x${oracle.seed.toString(16)}\`), built with ${oracle.rustc ?? oracle.cargo}${oracle.pinned ? `, Stage 1's pin ${oracle.pinned}` : ''}.`,
      '',
      '| Oracle entry point | Answers for | Cases | Agree |',
      '| --- | --- | --- | --- |',
    );
    for (const p of oracle.perFn) lines.push(`| \`${p.fn}\` | ${ORACLE_FNS[p.fn].map((n) => `\`${n}\``).join(', ')} | ${p.cases.toLocaleString('en-US')} | ${p.agreed.toLocaleString('en-US')} |`);
  }
  lines.push('');
  writeFileSync(file, kept + lines.join('\n'));
}

