import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { addressFromPrivateKey, toChecksumAddress } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';
import {
  DIVERGENCE_BY_ID,
  MercesWorld,
  RunnerError,
  S3_CLAIM_SCENARIOS,
  S4_SIGNATURE_SCENARIOS,
  SCENARIO_EXPECTED,
  SCENARIO_SETS,
  fromJson,
  loadScenario,
  loadScenarios,
  loadVector,
  renderScenarios,
  replayVector,
  runScenarios,
  runStage1Vectors,
  scenarioExpected,
  shutdown,
  type RunReport,
} from '../src/stage1-vectors/index.ts';

/*
 * Our S4 signature scenarios (S4 plan §4; S4 WP5, WP6) and the scenario runner's S4 additions. Cause codes:
 *  - S4-REG: Stage 1's key registry on the vector runner: `register_attestor` / `revoke_attestor` of the vector key's
 *    20-byte address, each personality with its chain's names; S4d, the last-key rule, merces-only (amendment fix 1);
 *  - S4-SH: shims SH-REG-2 (S4 WP5) and SH-REG-3 (S4 WP6) retired (the registry runs directly);
 *  - S4-T2: S4a-S4c, the report verifier key's forward-only revocation and its 45-day grace on tier-2 reports, on the
 *    reference, the merces backend and in lockstep (Stage 1's reference models the grace, SIM:332-338);
 *  - S4-T3: S4f, an attestor key's forward-only revocation and the same grace on tier-3 reports, each report carrying the
 *    named key's Stage 1 REPORT signature with tier 3 (S4 WP9), on every backend.
 */
const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors', import.meta.url));
const S4D = join(S4_SIGNATURE_SCENARIOS, 'S4d_last_attestor_key.json');
const json = (x: unknown) => JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

afterAll(shutdown);

describe('S4 signature scenarios: load', () => {
  it('the S4 set is its own section, after the S3 set; S4a-S4c and S4f run on every backend, S4d on the merces backend only', () => {
    expect(SCENARIO_SETS.map((s) => [s.id, s.dir, s.title])).toEqual([
      ['S3', S3_CLAIM_SCENARIOS, "S3 claim scenarios (ours, lockstep against Stage 1's Simulator)"],
      ['S4', S4_SIGNATURE_SCENARIOS, 'S4 signature scenarios (ours)'],
    ]);
    const all = loadScenarios(S4_SIGNATURE_SCENARIOS, VECTORS);
    const every3 = ['reference', 'merces', 'lockstep'];
    // cause S4-T2: S4a-S4c reuse 01 without #32 and #34 (the direct transfer and retire_if_capped refusals the merces
    // backend does not run) and add the verifier key's register and revoke, and reports of their own
    expect(all.map((s) => [s.vector.id, s.vector.name, s.base, s.covers, s.backends, s.parts, s.own])).toEqual([
      ['S4a', 'S4a_verifier_grace', '01_happy_path', ['a'], every3, ['01 #0-#31 as #0-#31', '01 #33 as #32', '01 #35-#38 as #33-#36', 'ours as #37-#38', '01 #39-#43 as #39-#43', 'ours as #44-#45', '01 #45-#50 as #46-#51'], 4],
      ['S4b', 'S4b_verifier_grace_ended', '01_happy_path', ['b'], every3, ['01 #0-#31 as #0-#31', '01 #33 as #32', '01 #35-#38 as #33-#36', 'ours as #37-#40'], 4],
      ['S4c', 'S4c_verifier_revoked_before_period_end', '01_happy_path', ['c'], every3, ['01 #0-#31 as #0-#31', '01 #33 as #32', '01 #35-#37 as #33-#35', 'ours as #36-#37', '01 #38 as #38', 'ours as #39-#40', '01 #40-#43 as #41-#44', 'ours as #45', '01 #45-#50 as #46-#51'], 5],
      ['S4d', 'S4d_last_attestor_key', '11_extinguishment', ['d'], ['merces'], ['11 #0-#34 as #0-#34', 'ours as #35-#41'], 7],
      // cause S4-T3: S4f revokes attestor1 a day after 2026Q1 ended, on 20's prefix, and moves its 2026Q2 reports to attestor2
      ['S4f', 'S4f_tier3_attestor_grace', '20_tier3_trueup', ['f'], every3, ['20 #0-#51 as #0-#51', 'ours as #52', '20 #52-#56 as #53-#57', 'ours as #58-#59', '20 #58 as #60', 'ours as #61', '20 #60 as #62'], 4],
    ]);
    // the default loads every set, ids unique across them
    const every = loadScenarios(undefined, VECTORS);
    expect(every.map((s) => s.vector.id)).toEqual([...loadScenarios(S3_CLAIM_SCENARIOS, VECTORS).map((s) => s.vector.id), 'S4a', 'S4b', 'S4c', 'S4d', 'S4f']);
    expect(readdirSync(S4_SIGNATURE_SCENARIOS).filter((f) => f.endsWith('.json'))).toEqual(['S4a_verifier_grace.json', 'S4b_verifier_grace_ended.json', 'S4c_verifier_revoked_before_period_end.json', 'S4d_last_attestor_key.json', 'S4f_tier3_attestor_grace.json']);
    // their expectation is PASS wherever they run (no divergence entry: DIV-S1I-2 is shown by S4d's expect_reverts)
    for (const id of ['S4a', 'S4b', 'S4c', 'S4f']) for (const b of ['reference', 'merces', 'lockstep'] as const) expect(scenarioExpected(id, b), `${id} ${b}`).toEqual(SCENARIO_EXPECTED);
    expect(scenarioExpected('S4d', 'merces')).toEqual(SCENARIO_EXPECTED);
    expect(DIVERGENCE_BY_ID.get('DIV-S1I-2')?.shownBy).toEqual(['S4d']);
  });

  it('S4d revokes on 11\'s keys; its per-personality reverts name each chain\'s error', () => {
    const s = loadScenario(S4D, VECTORS);
    const own = s.vector.steps.slice(35) as unknown as Record<string, unknown>[];
    expect(own.map((st) => (st.op === 'expect_revert' ? `expect_revert ${(st.call as { op: string; key?: string }).op} ${(st.call as { key?: string }).key ?? ''}`.trim() : `${st.op as string} ${st.key as string}`))).toEqual([
      'revoke_attestor attestor2',
      'expect_revert revoke_attestor attestor1',
      'expect_revert revoke_attestor attestor2',
      'register_attestor attestor2',
      'revoke_attestor attestor1',
      'expect_revert extinguish',
      'expect_revert revoke_attestor attestor2',
    ]);
    expect(own.filter((st) => st.errorByPersonality).map((st) => st.errorByPersonality)).toEqual([
      { solana: 'LastKeyOfKind', monad: 'LastActiveKey' },
      { solana: 'KeyAlreadyRevoked', monad: 'KeyNotRegistered' },
      { solana: 'LastKeyOfKind', monad: 'LastActiveKey' },
    ]);
    // the base vector's keys stay non-enumerable
    expect(Object.keys(s.vector)).not.toContain('keys');
    expect(json(s.vector)).not.toContain('privateKey');
  });

  it('refuses a malformed S4 scenario, naming the problem: backends, per-personality errors, its own keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 's4-signatures-'));
    const base = JSON.parse(readFileSync(S4D, 'utf8')) as Record<string, unknown> & { segments: [{ baseSteps: number[] }, { steps: Record<string, unknown>[] }] };
    const steps = base.segments[1].steps;
    const write = (patch: Record<string, unknown>) => {
      const f = join(dir, 'S4d.json');
      writeFileSync(f, JSON.stringify({ ...base, ...patch }));
      return f;
    };
    const withStep = (i: number, st: Record<string, unknown>) => ({ segments: [base.segments[0], { steps: steps.map((x, k) => (k === i ? st : x)) }] });
    const seed = 'S4d:verifier2';
    const pk = '0x' + Buffer.from(deriveTestPrivateKey(seed)).toString('hex');
    const address = toChecksumAddress(addressFromPrivateKey(pk));
    const cases: [Record<string, unknown>, string][] = [
      [{ backends: [] }, 'S4d_last_attestor_key: backends must list some of reference, merces, lockstep'],
      [{ backends: ['merces', 'nowhere'] }, 'S4d_last_attestor_key: backends must list some of reference, merces, lockstep'],
      [{ backends: ['merces', 'merces'] }, 'S4d_last_attestor_key: backends must list some of reference, merces, lockstep'],
      // a per-personality error needs a merces-only scenario: the reference has no personality
      [{ backends: undefined }, 'S4d_last_attestor_key: an error per personality needs a scenario run on the merces backend only (the reference has no personality)'],
      [{ backends: ['merces', 'lockstep'] }, 'S4d_last_attestor_key: an error per personality needs a scenario run on the merces backend only (the reference has no personality)'],
      [withStep(1, { ...steps[1], errorByPersonality: { solana: 'LastKeyOfKind' } }), 'S4d_last_attestor_key: errorByPersonality must name the error on solana and monad'],
      [withStep(1, { ...steps[1], errorByPersonality: { solana: 'LastKeyOfKind', monad: '' } }), 'S4d_last_attestor_key: errorByPersonality must name the error on solana and monad'],
      [withStep(1, { ...steps[1], error: 'LastActiveKey' }), 'S4d_last_attestor_key: an expect_revert with errors per personality repeats the solana name as its error'],
      [withStep(0, { ...steps[0], errorByPersonality: { solana: 'X', monad: 'Y' } }), 'S4d_last_attestor_key: only an expect_revert may name its error per personality'],
      // keys of its own: seed `<id>:<name>`, Stage 1's test key for it, its own address, a name the base does not use
      [{ keys: { verifier2: { seed: 'S4a:verifier2', privateKey: pk, address } } }, 'S4d_last_attestor_key: key verifier2 must have the seed S4d:verifier2'],
      [{ keys: { verifier2: { seed, privateKey: '0x' + '11'.repeat(32), address } } }, "S4d_last_attestor_key: key verifier2 is not Stage 1's test key for its seed"],
      [{ keys: { verifier2: { seed, privateKey: pk, address: '0x' + '22'.repeat(20) } } }, "S4d_last_attestor_key: key verifier2's address is not its private key's"],
      [{ keys: { attestor1: { seed: 'S4d:attestor1', privateKey: pk, address } } }, 'S4d_last_attestor_key: key attestor1 is already a key of 11_extinguishment'],
      [{ keys: [] }, 'S4d_last_attestor_key: keys must map names to keys'],
    ];
    for (const [patch, message] of cases) expect(() => loadScenario(write(patch), VECTORS), message).toThrow(new RunnerError(message));
    // a key of its own is accepted (lowercase or EIP-55), joins the base vector's, and stays non-enumerable
    const ok = loadScenario(write({ keys: { verifier2: { seed, privateKey: pk, address } } }), VECTORS);
    expect(ok.vector.keys.verifier2).toEqual({ seed, privateKey: pk, address });
    expect(Object.keys(ok.vector.keys).sort()).toEqual(['attestor1', 'attestor2', 'verifier1', 'verifier2']);
    expect(json(ok.vector)).not.toContain(pk.slice(2));
    expect(loadScenario(write({ keys: { verifier2: { seed, privateKey: pk, address: address.toLowerCase() } } }), VECTORS).vector.keys.verifier2?.address).toBe(address.toLowerCase());
  });
});

describe('S4 signature scenarios: replay', () => {
  const reports: Partial<Record<'reference' | 'merces' | 'lockstep', RunReport>> = {};

  it('S4d passes on the merces backend on both personalities, each refusing the last key under its own chain\'s name', async () => {
    const r = await runScenarios({ vectorsDir: VECTORS, backend: 'merces', only: ['S4d'] });
    reports.merces = r.report;
    expect(r.skipped).toEqual([]);
    expect(r.report.runs.map((x) => [x.id, x.world, x.status, x.executed, x.total, x.issues, x.atExpected])).toEqual([
      ['S4d', 'merces/solana', 'PASS', 42, 42, [], true],
      ['S4d', 'merces/monad', 'PASS', 42, 42, [], true],
    ]);
    // cause S4-SH: the registry runs directly
    for (const run of r.report.runs) expect(run.shims['SH-REG-2']).toBeUndefined();
    expect(r.report.ok).toBe(true);
  }, 180_000);

  it('cause S4-T2: S4a-S4c pass on the reference, the merces backend and in lockstep, on both personalities', async () => {
    const only = ['S4a', 'S4b', 'S4c'];
    const counts: Record<string, number> = { S4a: 52, S4b: 41, S4c: 52 };
    for (const backend of ['reference', 'merces', 'lockstep'] as const) {
      const r = await runScenarios({ vectorsDir: VECTORS, backend, only });
      expect(r.skipped, backend).toEqual([]);
      const worlds = backend === 'reference' ? ['reference'] : [`${backend}/solana`, `${backend}/monad`];
      expect(r.report.runs.map((x) => [x.id, x.world, x.status, x.executed, x.total, x.issues, x.atExpected]), backend).toEqual(
        only.flatMap((id) => worlds.map((w) => [id, w, 'PASS', counts[id], counts[id], [], true])),
      );
      // the verifier keys' registry runs directly (SH-REG-3 retired); a report still goes through SH-REP-1 (tier 3, FX)
      if (backend !== 'reference') for (const run of r.report.runs) expect([run.shims['SH-REG-3'], run.shims['SH-REP-1']! > 0], run.world).toEqual([undefined, true]);
    }
  }, 300_000);

  it('cause S4-T2: S4a checks something: with verifier1 revoked before 2026Q1 ended instead, its 2026Q1 report is refused', async () => {
    const s = loadScenario(join(S4_SIGNATURE_SCENARIOS, 'S4a_verifier_grace.json'), VECTORS);
    const steps = structuredClone(s.vector.steps) as unknown as Record<string, unknown>[];
    // the revocation (#38) one second before 2026Q1 ends: #39, verifier1's report, has no grace
    steps[37]!.t = steps[38]!.t = '1775001599';
    const v = fromJson({ schema: 2, specVersion: '1.1', config: JSON.parse(readFileSync(join(VECTORS, '01_happy_path.json'), 'utf8')).config, keys: s.vector.keys, steps }, '99_s4a_early');
    for (const backend of ['reference', 'merces'] as const) {
      const r = await runStage1Vectors({ vectors: [v], backend, personalities: ['solana'] });
      expect(r.runs[0]!.issues[0], backend).toMatchObject({ index: 39, kind: 'fail', message: 'unexpected revert InvalidVerifierSignature' });
    }
  }, 180_000);

  it('cause S4-T3: S4f passes on the reference, the merces backend and in lockstep, on both personalities; its reports are signed, not co-signed', async () => {
    const s = loadScenario(join(S4_SIGNATURE_SCENARIOS, 'S4f_tier3_attestor_grace.json'), VECTORS);
    const steps = s.vector.steps as unknown as Record<string, unknown>[];
    // the tier-3 reports name their attestor key: attestor1 for 2026Q1 (in the grace), attestor2 for 2026Q2
    expect(steps.filter((x) => x.op === 'submit_report').map((x) => [x.period, x.tier, x.attestation])).toEqual([['8104', 3, 'attestor1'], ['8104', 3, 'attestor1'], ['8105', 3, 'attestor2'], ['8105', 3, 'attestor2']]);
    expect(steps[52]).toMatchObject({ op: 'revoke_attestor', key: 'attestor1', t: '1775088000' });
    expect(steps[58]).toMatchObject({ op: 'expect_revert', error: 'InvalidAttestorSignature', call: { op: 'submit_report', period: '8105', attestation: 'attestor1' } });
    for (const backend of ['reference', 'merces', 'lockstep'] as const) {
      const r = await runScenarios({ vectorsDir: VECTORS, backend, only: ['S4f'] });
      expect(r.skipped, backend).toEqual([]);
      const worlds = backend === 'reference' ? ['reference'] : [`${backend}/solana`, `${backend}/monad`];
      expect(r.report.runs.map((x) => [x.id, x.world, x.status, x.executed, x.total, x.issues, x.atExpected]), backend).toEqual(worlds.map((w) => ['S4f', w, 'PASS', 63, 63, [], true]));
      // SH-REP-1 is left with the FX basis only: the report goes through it, the attestor registry runs directly
      if (backend !== 'reference') for (const run of r.report.runs) expect([run.shims['SH-REG-2'], run.shims['SH-REP-1']! > 0], run.world).toEqual([undefined, true]);
    }
  }, 300_000);

  it('cause S4-T3: S4f checks something: with attestor1 revoked before 2026Q1 ended instead, its 2026Q1 tier-3 report is refused', async () => {
    const s = loadScenario(join(S4_SIGNATURE_SCENARIOS, 'S4f_tier3_attestor_grace.json'), VECTORS);
    const steps = structuredClone(s.vector.steps) as unknown as Record<string, unknown>[];
    // the revocation (#52) moved before 20's TierNotEnabled refusal (#51, a day after 2026Q1 ended) to one second before
    // 2026Q1 ends: #53, attestor1's 2026Q1 report, has no grace
    const [revoke] = steps.splice(52, 1);
    steps.splice(51, 0, { ...revoke!, t: '1775001599' });
    expect([steps[50]!.t, steps[51]!.op, steps[52]!.op]).toEqual(['1769299200', 'revoke_attestor', 'expect_revert']);
    const v = fromJson({ schema: 2, specVersion: '1.1', config: JSON.parse(readFileSync(join(VECTORS, '20_tier3_trueup.json'), 'utf8')).config, keys: s.vector.keys, steps }, '99_s4f_early');
    for (const backend of ['reference', 'merces'] as const) {
      const r = await runStage1Vectors({ vectors: [v], backend, personalities: ['solana'] });
      expect(r.runs[0]!.issues[0], backend).toMatchObject({ index: 53, kind: 'fail', message: 'unexpected revert InvalidAttestorSignature' });
    }
  }, 180_000);

  it('S4d is not run on the reference or in lockstep: named as skipped', async () => {
    for (const backend of ['reference', 'lockstep'] as const) {
      const r = await runScenarios({ vectorsDir: VECTORS, backend, only: ['S4d'] });
      reports[backend] = r.report;
      expect([r.report.runs, r.skipped.map((s) => s.vector.id), r.report.ok], backend).toEqual([[], ['S4d'], true]);
    }
  });

  it('a wrong name on one personality fails that run only (the per-personality errors are checked, not ignored)', async () => {
    const s = loadScenario(S4D, VECTORS);
    const steps = structuredClone(s.vector.steps) as unknown as Record<string, unknown>[];
    (steps[36]!.errorByPersonality as Record<string, string>).monad = 'LastKeyOfKind';
    const v = fromJson({ schema: 2, specVersion: '1.1', config: JSON.parse(readFileSync(join(VECTORS, '11_extinguishment.json'), 'utf8')).config, keys: s.vector.keys, steps }, '99_s4d_wrong');
    const runs = await Promise.all((['solana', 'monad'] as const).map(async (personality) => {
      const w = await MercesWorld.create(v, { personality });
      try {
        return await replayVector(w, v);
      } finally {
        await w.close();
      }
    }));
    expect(runs.map((r) => r.status)).toEqual(['PASS', 'FAIL']);
    expect(runs[1]!.issues[0]).toMatchObject({ index: 36, op: 'expect_revert revoke_attestor', kind: 'fail', message: 'expected revert LastKeyOfKind for revoke_attestor, got LastActiveKey' });
  }, 180_000);

  it("DIV-S1I-2 for real: Stage 1's reference revokes the last key, our backend refuses it", async () => {
    const v11 = loadVector(join(VECTORS, '11_extinguishment.json'));
    const t = '1783641600';
    const steps = [...v11.steps.slice(0, 35), { t, op: 'revoke_attestor', key: 'attestor2' }, { t, op: 'revoke_attestor', key: 'attestor1' }];
    const v = fromJson({ schema: 2, specVersion: '1.1', config: JSON.parse(readFileSync(join(VECTORS, '11_extinguishment.json'), 'utf8')).config, keys: v11.keys, steps }, '11_last_key');
    const ref = await runStage1Vectors({ vectors: [v], backend: 'reference' });
    expect(ref.runs.map((r) => [r.status, r.executed])).toEqual([['PASS', 37]]);
    const ours = await runStage1Vectors({ vectors: [v], backend: 'merces' });
    expect(ours.runs.map((r) => [r.world, r.status, r.issues.map((i) => [i.index, i.message])])).toEqual([
      ['merces/solana', 'FAIL', [[36, 'unexpected revert LastKeyOfKind']]],
      ['merces/monad', 'FAIL', [[36, 'unexpected revert LastActiveKey']]],
    ]);
  }, 180_000);

  it('the vector key names are their keys\' 20-byte addresses on both personalities, registered by register_attestor', async () => {
    const v11 = loadVector(join(VECTORS, '11_extinguishment.json'));
    for (const personality of ['solana', 'monad'] as const) {
      const w = await MercesWorld.create(v11, { personality });
      try {
        for (const name of ['attestor1', 'attestor2', 'verifier1']) {
          const a = (v11.keys[name] as { address: string }).address.toLowerCase();
          expect([w.actors.keyAddress(name), w.actors.address(name), w.actors.nameOf(a)], `${personality} ${name}`).toEqual([a, a, name]);
        }
        expect(w.actors.keyAddress('b1')).toBeUndefined();
        await w.apply(v11.steps[0] as never);
        expect(await w.chain.getSignerKey('attestor', w.actors.address('attestor1'))).toMatchObject({ active: true, revokedAt: null });
        await expect(w.apply({ op: 'register_attestor', key: 'b1' } as never)).rejects.toThrow(new RunnerError('the vector has no key named b1'));
      } finally {
        await w.close();
      }
    }
  });

  it('VECTOR_PARITY.md gets an S4 section: S4d\'s merces results, "not run" on the reference and in lockstep', () => {
    const scenarios = loadScenarios(S4_SIGNATURE_SCENARIOS, VECTORS);
    const md = renderScenarios(scenarios, [reports.reference!, reports.merces!, reports.lockstep!]).join('\n');
    expect(md).toContain('## S4 signature scenarios (ours)');
    expect(md).not.toContain('## S3 claim scenarios');
    expect(md).toContain('| Scenario | Covers | Built from | merces/solana | merces/monad |');
    expect(md).toContain('| S4d_last_attestor_key | (d) | 11 #0-#34 as #0-#34; ours as #35-#41 | PASS 42/42 | PASS 42/42 |');
    // with a lockstep world in the reports, its column reads "not run"
    const lockstepRun = { ...reports.merces!, backend: 'lockstep' as const, runs: [{ ...reports.merces!.runs[0]!, world: 'lockstep/solana', backend: 'lockstep' as const, vector: 'S3a_tail_before_redeem' }] };
    expect(renderScenarios(scenarios, [reports.merces!, lockstepRun]).join('\n')).toContain('| S4d_last_attestor_key | (d) | 11 #0-#34 as #0-#34; ours as #35-#41 | PASS 42/42 | PASS 42/42 | not run (merces only) |');
    expect(md).toContain(`- S4d_last_attestor_key: ${scenarios.find((x) => x.vector.id === 'S4d')!.vector.description}`);
    expect(md).not.toContain('### Scenario findings');
  });
});
