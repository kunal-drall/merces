import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunnerError, runVectorFiles, shutdown } from '../src/stage1-vectors/index.ts';

/**
 * `--vector-file` (`runVectorFiles`): a vector in Stage 1's format given by path, outside the Stage 1 directory, expected
 * to PASS in full on the chosen backend. The one such vector is the one we propose to Stage 1 for DIV-S1I-1
 * (`docs/stage1/defects/vectors/26_final_share_open_ask.json`, composed from vector 22 and our scenario S3l with both
 * chains' values): it PASSes on the merces backend on both personalities, and FAILS on the reference backend exactly at
 * its two expects, on b1's balance and the vault, 1,050,000,000 base units apart (the reference weighs b1's final share
 * on its 60 redeemed units, not on 60 + the 40 in its uncleared ask), which is the defect the report shows Stage 1.
 */
const V26 = resolve(import.meta.dirname, '../../../docs/stage1/defects/vectors/26_final_share_open_ask.json');

describe('stage1 vector runner: vector files by path (the vectors we propose to Stage 1)', () => {
  afterAll(async () => {
    await shutdown();
  });

  it('26_final_share_open_ask PASSes in full on the merces backend, on both personalities', async () => {
    const r = await runVectorFiles([V26], { backend: 'merces' });
    if (!r.ok) console.log(JSON.stringify(r.runs.map((x) => [x.world, x.status, x.executed, x.issues.slice(0, 3)])));
    expect(r.ok).toBe(true);
    expect(r.runs.map((x) => [x.vector, x.personality, x.status, x.atExpected])).toEqual([
      ['26_final_share_open_ask', 'solana', 'PASS', true],
      ['26_final_share_open_ask', 'monad', 'PASS', true],
    ]);
    expect(r.runs.every((x) => x.executed === 88 && x.total === 88)).toBe(true);
  }, 180_000);

  it('26_final_share_open_ask passes on the fixed Stage 1 reference and in lockstep without a waiver', async () => {
    for (const backend of ['reference', 'lockstep'] as const) {
      const r = await runVectorFiles([V26], { backend });
      expect(r.ok, JSON.stringify(r.runs.map((x) => x.issues))).toBe(true);
      for (const run of r.runs) expect([run.status, run.atExpected, run.executed, run.total]).toEqual(['PASS', true, 88, 88]);
    }
  }, 180_000);

  it('a missing file is a RunnerError, and no files is one too', async () => {
    await expect(runVectorFiles(['/nonexistent/99_nothing.json'])).rejects.toBeInstanceOf(RunnerError);
    await expect(runVectorFiles([])).rejects.toBeInstanceOf(RunnerError);
  });
});
