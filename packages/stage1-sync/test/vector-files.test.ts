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

  it("26_final_share_open_ask FAILS on the reference backend at its two expects, 1,050 USDC apart on b1's balance and the vault (DIV-S1I-1)", async () => {
    const r = await runVectorFiles([V26], { backend: 'reference' });
    expect(r.ok).toBe(false);
    const run = r.runs[0]!;
    expect([run.status, run.atExpected]).toEqual(['FAIL', false]);
    const flat = JSON.stringify(run.issues);
    // #79: both chains pay b1 the share on 100 units; the reference on 60 (1,050,000,000 base units less, kept by the vault)
    expect(flat).toContain('"70310161480"');
    expect(flat).toContain('"69260161480"');
    // #87: the chains' vault ends empty; the reference's keeps the 40 escrowed units' share for good
    expect(flat).toContain('"1050000000"');
  }, 180_000);

  it('a missing file is a RunnerError, and no files is one too', async () => {
    await expect(runVectorFiles(['/nonexistent/99_nothing.json'])).rejects.toBeInstanceOf(RunnerError);
    await expect(runVectorFiles([])).rejects.toBeInstanceOf(RunnerError);
  });
});
