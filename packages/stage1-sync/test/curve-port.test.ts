import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as gateway from '@merces/math';
import { locateStage1, type Stage1Location } from '@merces/chains';
import { renderReport, verdictsFrom, type StepReport, type SyncReport } from '../src/index.ts';
import { buildCorpus, CORPUS_SEED } from '../src/curve-port/corpus.ts';
import { ORACLE_FNS, ours, OUR_FAMILY, refusal, uncovered, type PortedFamily } from '../src/curve-port/family.ts';
import { checkCite, checkFigures, FIGURES, loadFixtures, type Fixtures } from '../src/curve-port/figures.ts';
import { crateFor, findCargo, ORACLE_DEPENDENCY, ORACLE_DIR, REPO_ROOT, stage1Toolchain } from '../src/curve-port/oracle.ts';
import { checkCurvePort } from '../src/steps/curve-port.ts';
import { MERCES_COMMON, PORTED } from '../src/steps/math.ts';

/*
 * Cause GATE (S3 follow-up): stage1:sync's curve-port step runs @merces/math's ported curve family (A-MATH-3) against
 * Stage 1's figures (one cited table) and against Stage 1's own Rust (merces-common, built into tools/stage1-oracle),
 * and fails the sync on any disagreement, on a stale citation, and when cargo is missing.
 *
 * The oracle tests need cargo. Without it they are skipped locally and fail in CI (`CI` set), where the workflows
 * install Stage 1's toolchain: the gate must never pass by not running.
 */

const CARGO = 'cargo' in findCargo();
const needsCargo = CARGO || !!process.env.CI;
const STAGE1 = join(REPO_ROOT, 'stage1');

function ctxAt(location: Stage1Location) {
  const outDir = mkdtempSync(join(tmpdir(), 'curve-port-'));
  return { location, outDir, generatedDir: outDir };
}

/** A copy of the Stage 1 files the gate reads (merces-common, its workspace and toolchain, every cited file). */
function stage1Copy(): string {
  const root = mkdtempSync(join(tmpdir(), 'stage1-curve-'));
  const files = new Set<string>(['solana/Cargo.toml', 'solana/rust-toolchain.toml']);
  for (const f of FIGURES) for (const c of f.cites) files.add(c.at.replace(/:\d+(-\d+)?$/, ''));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(STAGE1, f), join(root, f));
  }
  cpSync(join(STAGE1, 'solana/crates/merces-common'), join(root, 'solana/crates/merces-common'), { recursive: true, filter: (p) => !p.includes('/target') });
  return root;
}

/** The location of a bare Stage 1 directory (the gate reads only `root`). */
const at = (root: string) => ({ root, kind: 'map', path: root, manifest: {} }) as unknown as Stage1Location;

/** Our migration-fee split with the pool share rounded down instead of up: right on every round figure. */
const floorSplit: PortedFamily['migrationFeeSplit'] = (x, f, c) => {
  const fee = x - (x * BigInt(100 - f)) / 100n;
  const creator = (fee * BigInt(c)) / 100n;
  return { partner: fee - creator, creator };
};

describe('stage1:sync curve-port (cause GATE)', () => {
  it('the table: one row per Stage 1 figure, every citation holding at the pinned checkout, all agreeing', () => {
    const fx = loadFixtures(STAGE1) as Fixtures;
    expect('missing' in fx).toBe(false);
    const results = checkFigures(OUR_FAMILY, STAGE1, fx);
    expect(results.filter((r) => !r.ok), JSON.stringify(results.filter((r) => !r.ok), null, 1)).toEqual([]);
    expect(results).toHaveLength(FIGURES.length);
    expect(new Set(FIGURES.map((f) => f.id)).size).toBe(FIGURES.length);
    // the figures the owner named are in it: P0, the split, units outstanding, the dues, the capped acceptance
    for (const id of ['fixture.p0', 'fixture.split', 'fixture.census.migrated', 'fixture.dues.q1', 'fixture.dues.q1-cap', 'fixture.retirement', 'curve.p0.floor', 'vault.cap.truncates']) expect(FIGURES.map((f) => f.id)).toContain(id);
    // every citation is to Stage 1's solana tree, by file and line
    for (const f of FIGURES) for (const c of f.cites) expect(c.at, f.id).toMatch(/^solana\/[\w./-]+:\d+(-\d+)?$/);
  });

  it('a citation that no longer holds, or a fixture Stage 1 regenerated, fails the row', () => {
    const root = stage1Copy();
    const fx = () => loadFixtures(root) as Fixtures;
    expect(checkFigures(OUR_FAMILY, root, fx()).every((r) => r.ok)).toBe(true);
    // Stage 1 changes a unit-test figure: the row's citation is stale
    const curve = join(root, MERCES_COMMON, 'curve.rs');
    writeFileSync(curve, readFileSync(curve, 'utf8').replace('9_999_999', '9_999_998'));
    const stale = checkFigures(OUR_FAMILY, root, fx()).filter((r) => !r.ok);
    expect(stale.map((r) => r.id)).toEqual(['curve.p0.floor']);
    expect(stale[0]!.detail).toMatch(/^citation stale: solana\/crates\/merces-common\/src\/curve\.rs:133-136: no longer holds "p0_per_unit\(1_000_000_000, 100_000_002, 6\)\.unwrap\(\), 9_999_999"/);
    // Stage 1 regenerates a fixture: the row reads the new value, and ours no longer agrees
    const config = join(root, 'solana/tests/fixtures/meteora/curve_config.json');
    writeFileSync(config, readFileSync(config, 'utf8').replace('"partnerMigrationFee": "990000000"', '"partnerMigrationFee": "990000001"'));
    const moved = checkFigures(OUR_FAMILY, root, fx()).filter((r) => !r.ok).map((r) => r.id);
    expect(moved).toContain('fixture.split');
    // a missing cited file
    expect(checkCite(root, { at: 'solana/nowhere.rs:1', anchor: ['x'] })).toBe('solana/nowhere.rs:1: solana/nowhere.rs is not in this checkout');
  });

  it('the corpus is deterministic, within Stage 1\'s types, and covers every ported name', () => {
    const a = buildCorpus();
    const b = buildCorpus(CORPUS_SEED);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(buildCorpus(CORPUS_SEED + 1n).fingerprint).not.toBe(a.fingerprint);
    expect(a.cases.length).toBeGreaterThan(5_000);
    expect(uncovered()).toEqual([]);
    expect(new Set(Object.values(ORACLE_FNS).flat())).toEqual(new Set(PORTED.map((p) => p.name)));
    for (const fn of Object.keys(ORACLE_FNS)) expect(a.counts[fn as keyof typeof ORACLE_FNS], fn).toBeGreaterThan(0);
    // ours answers every case with a value or one of Stage 1's refusals, never anything else
    for (const c of a.cases) {
      const answer = ours(OUR_FAMILY, c);
      if ('err' in answer) expect(answer.err, `#${c.id} ${c.fn}`).toMatch(/^(Overflow|DivisionByZero|InvalidInput|NoUnitsOutstanding)$/);
    }
    expect(refusal(new RangeError('Overflow: x'))).toBe('Overflow');
    expect(refusal(new Error('NoUnitsOutstanding'))).toBe('NoUnitsOutstanding');
    expect(refusal(new TypeError('boom'))).toMatch(/^not a Stage 1 refusal: TypeError: boom$/);
  });

  it('the oracle crate depends on the pinned submodule\'s merces-common and nothing else; Stage 1 pins its toolchain', () => {
    const manifest = readFileSync(join(ORACLE_DIR, 'Cargo.toml'), 'utf8');
    expect(manifest).toContain(`merces-common = { path = "${ORACLE_DEPENDENCY}" }`);
    expect(manifest).toMatch(/^\[workspace\]$/m);
    const deps = manifest.slice(manifest.indexOf('[dependencies]'), manifest.indexOf('[workspace]')).trim().split('\n').slice(1).filter((l) => l.trim() && !l.startsWith('#'));
    expect(deps).toEqual([`merces-common = { path = "${ORACLE_DEPENDENCY}" }`]);
    expect(stage1Toolchain(STAGE1)).toMatch(/^\d+\.\d+\.\d+$/);
    // the submodule: the committed crate; another checkout: a copy pointed at it
    expect(crateFor(STAGE1, tmpdir()).overlay).toBe(false);
    expect(() => crateFor(mkdtempSync(join(tmpdir(), 'none-')), tmpdir())).toThrow(/merces-common is not in this Stage 1 drop/);
  });

  it('without cargo the step fails, saying what to install (never a skip)', async () => {
    const r = await checkCurvePort(ctxAt(locateStage1(STAGE1)!), { cargo: join(tmpdir(), 'no-such-cargo') });
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/cargo not found .*the curve-port gate needs a Rust toolchain .*rustup toolchain install \d+\.\d+\.\d+ --profile minimal/);
    // the figures still ran
    expect(r.details[0]).toBe(`figures: ${FIGURES.length}/${FIGURES.length} of Stage 1's figures agree (curve_config.json, curve_reports.json, merces-common's unit tests, curve_mode.rs), every citation holding at this checkout`);
    // a drop without Stage 1's Rust or fixtures cannot be checked: a failure too
    const bare = await checkCurvePort(ctxAt(at(mkdtempSync(join(tmpdir(), 'bare-')))));
    expect(bare.status).toBe('fail');
    expect(bare.summary).toMatch(/curve fixtures are not in this drop/);
  });

  it.skipIf(!needsCargo)('ok on the pinned submodule: every figure and every oracle case agrees with Stage 1', async () => {
    const ctx = ctxAt(locateStage1(STAGE1)!);
    const r = await checkCurvePort(ctx);
    expect(r.status, r.details.join('\n')).not.toBe('fail');
    const corpus = buildCorpus();
    const n = corpus.cases.length.toLocaleString('en-US');
    expect(r.summary).toBe(`ported curve family agrees with Stage 1: ${FIGURES.length}/${FIGURES.length} figures, ${n}/${n} oracle cases against merces-common`);
    expect(r.details).toContain(`oracle: ${n}/${n} cases agree exactly with Stage 1's Rust (merces-common, through tools/stage1-oracle; corpus ${corpus.fingerprint}, seed 0x${CORPUS_SEED.toString(16)}; ${PORTED.length}/${PORTED.length} ported names covered)`);
    // MATH_PARITY.md gets the gate's section, with a row per oracle entry point
    const md = readFileSync(join(ctx.outDir, 'MATH_PARITY.md'), 'utf8');
    expect(md).toContain('## The curve-port gate');
    expect(md).toMatch(/Result at this checkout: \*\*(ok|warn)\*\*\. ported curve family agrees with Stage 1/);
    for (const fn of Object.keys(ORACLE_FNS)) expect(md).toMatch(new RegExp(`^\\| \`${fn}\` \\|`, 'm'));
  });

  it.skipIf(!needsCargo)('a deliberately wrong function fails the step: the oracle catches what no round figure shows', async () => {
    const location = locateStage1(STAGE1)!;
    const wrong = await checkCurvePort(ctxAt(location), { family: { ...gateway, migrationFeeSplit: floorSplit } });
    expect(wrong.status).toBe('fail');
    expect(wrong.summary).toMatch(/\d+ oracle case\(s\) disagree with Stage 1's Rust/);
    expect(wrong.summary).not.toMatch(/figures disagree/); // every Stage 1 figure is a round number
    expect(wrong.details.some((d) => /^ {2}✗ #\d+ migration_fee_split /.test(d))).toBe(true);
    // an off-by-one P0: both the figures and the oracle
    const p0 = await checkCurvePort(ctxAt(location), { family: { ...gateway, p0PerUnit: (x, sb, d) => gateway.p0PerUnit(x, sb, d) + 1n } });
    expect(p0.status).toBe('fail');
    expect(p0.summary).toMatch(/of Stage 1's figures disagree or are stale; \d+ oracle case\(s\) disagree/);
    expect(p0.details.some((d) => d.startsWith('  ✗ curve.p0.worked: ours "10000001", Stage 1 "10000000"'))).toBe(true);
    // the verdict names it, and it blocks every chain
    const report: SyncReport = { present: true, location: 'stage1', steps: [p0], verdicts: verdictsFrom([p0], { manifest: { solana: {} } }) };
    expect(renderReport(report)).toContain(`  ported curve family (curve-port): FAIL — ${p0.summary}`);
    expect(report.verdicts[0]!.blockers.some((b) => b.startsWith('curve-port: '))).toBe(true);
  });

  it.skipIf(!needsCargo)('a Stage 1 Rust change the port did not follow fails the oracle (built against that checkout)', async () => {
    const root = stage1Copy();
    const curve = join(root, MERCES_COMMON, 'curve.rs');
    // Stage 1 starts rounding the pool share down (the port still rounds it up)
    writeFileSync(curve, readFileSync(curve, 'utf8').replace('.checked_add(99)', '.checked_add(0)'));
    const ctx = ctxAt(at(root));
    const r = await checkCurvePort(ctx);
    expect(r.status).toBe('fail');
    expect(r.details.find((d) => d.startsWith('oracle: ') && d.includes('cases agree'))).toMatch(/through a copy of tools\/stage1-oracle against /);
    expect(r.details.some((d) => /^ {2}✗ #\d+ migration_fee_split /.test(d))).toBe(true);
  });

  it('the verdict reports the step whatever its status; only a failure blocks', () => {
    const step = (status: StepReport['status']): StepReport => ({ step: 'curve-port', status, summary: `s-${status}`, details: [] });
    const loc = { manifest: { solana: {} } };
    const base = [{ step: 'diff', status: 'ok', summary: 'd', details: [] }, { step: 'conformance', status: 'ok', summary: 'c', details: ['[solana] conformance passed'] }] as StepReport[];
    expect(verdictsFrom([...base, step('ok')], loc)[0]!.ready).toBe(true);
    expect(verdictsFrom([...base, step('warn')], loc)[0]!.ready).toBe(true);
    expect(verdictsFrom([...base, step('fail')], loc)[0]!.blockers).toEqual(['curve-port: s-fail']);
    const report: SyncReport = { present: true, location: 'x', steps: [...base, step('ok')], verdicts: verdictsFrom([...base, step('ok')], loc) };
    expect(renderReport(report)).toMatch(/^Verdict\n {2}ported curve family \(curve-port\): OK — s-ok\n {2}solana: READY for live$/m);
  });
});
