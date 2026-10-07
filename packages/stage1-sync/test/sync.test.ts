import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderReport, runSync } from '../src/index.ts';
import { renderAnchorIdl } from '../src/idl-render.ts';

describe('stage1:sync', () => {
  it('reports "Stage 1 not present" cleanly when STAGE1_PATH is unset or empty', async () => {
    const r = await runSync({ stage1Path: undefined, outDir: mkdtempSync(join(tmpdir(), 'out-')), generatedDir: mkdtempSync(join(tmpdir(), 'gen-')), runConformance: false, json: false });
    expect(r.present).toBe(false);
    expect(renderReport(r)).toContain('Stage 1 not present');
    const r2 = await runSync({ stage1Path: mkdtempSync(join(tmpdir(), 'empty-')), outDir: mkdtempSync(join(tmpdir(), 'out-')), generatedDir: mkdtempSync(join(tmpdir(), 'gen-')), runConformance: false, json: false });
    expect(r2.present).toBe(false);
  });

  it('generates clients, diffs interfaces and replays vectors from a synthetic Stage 1 drop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stage1-'));
    mkdirSync(join(root, 'handoff'));
    mkdirSync(join(root, 'idl'));
    mkdirSync(join(root, 'abi'));
    writeFileSync(join(root, 'idl', 'series.json'), JSON.stringify({ address: 'Ser1es1111111111111111111111111111111111111', metadata: { name: 'series', version: '0.1.0', spec: '0.1.0' }, instructions: [{ name: 'create_series', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: 'issuer', signer: true, writable: true }], args: [{ name: 'units_offered', type: 'u64' }] }], events: [{ name: 'SeriesCreated', discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }, { name: 'WeirdExtraEvent', discriminator: [1, 1, 1, 1, 1, 1, 1, 1] }], types: [{ name: 'Terms', type: { kind: 'struct', fields: [{ name: 'units_offered', type: 'u64' }, { name: 'issuer', type: 'pubkey' }] } }] }));
    writeFileSync(join(root, 'abi', 'Series.json'), JSON.stringify({ abi: [{ type: 'event', name: 'RaiseOpened', inputs: [{ name: 'seriesId', type: 'bytes32' }, { name: 'commitEndsAt', type: 'uint64' }] }, { type: 'function', name: 'openRaise', inputs: [{ name: 'seriesId', type: 'bytes32' }] }] }));
    writeFileSync(join(root, 'vectors.json'), JSON.stringify({
      math: [{ fn: 'auctionFee', args: ['100000000', '100'], expect: '1000000' }],
      scenarios: [{ name: 'register-and-stop', steps: [{ at: 0, actor: 'issuer', command: { kind: 'registerIssuer' } }, { at: 1, actor: 'issuer', command: { kind: 'stopIssuance' } }, { at: 2, actor: 'issuer', command: { kind: 'registerIssuer' }, expectError: 'Duplicate' }] }],
    }));
    writeFileSync(join(root, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', commit: 'abc', vectors: 'vectors.json', solana: { cluster: 'devnet', programs: { series: 'Ser1es1111111111111111111111111111111111111' }, idlDir: 'idl' }, evm: [{ chain: 'monad-testnet', chainId: 10143, contracts: { Series: '0x' + '22'.repeat(20) }, abiDir: 'abi' }] }));
    const outDir = mkdtempSync(join(tmpdir(), 'out-'));
    const generatedDir = mkdtempSync(join(tmpdir(), 'gen-'));
    const cwd = process.cwd();
    const r = await runSync({ stage1Path: root, outDir, generatedDir, runConformance: false, json: false });
    expect(r.present).toBe(true);
    const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
    expect(by.generate!.status).toBe('ok');
    expect(existsSync(join(generatedDir, 'solana', 'series.ts'))).toBe(true);
    expect(readFileSync(join(generatedDir, 'evm', 'Series.ts'), 'utf8')).toContain('as const');
    expect(by.diff!.status).toBe('warn'); // most canonical events have no counterpart in this tiny drop
    const drift = readFileSync(join(outDir, 'INTERFACE_DRIFT.md'), 'utf8');
    expect(drift).toContain('WeirdExtraEvent');
    expect(drift).toMatch(/\| RaiseOpened \| RaiseOpened \|/);
    expect(drift).toMatch(/\| PayoutClaimed \| \*\*missing\*\*/);
    expect(by.math!.status).toBe('warn'); // no math package in the manifest
    expect(by.vectors!.status).toBe('ok');
    expect(r.verdicts.map((v) => v.chain)).toEqual(['solana', 'monad-testnet']);
    expect(r.verdicts.every((v) => v.ready)).toBe(true);
    expect(process.cwd()).toBe(cwd);
  });

  it('renders an Anchor IDL into a typed module', () => {
    const ts = renderAnchorIdl('x', { metadata: { name: 'x' }, instructions: [{ name: 'claim', args: [{ name: 'amount', type: 'u64' }, { name: 'who', type: 'pubkey' }] }], types: [{ name: 'Mode', type: { kind: 'enum', variants: [{ name: 'A' }, { name: 'B' }] } }] });
    expect(ts).toContain("export type Mode = \"A\" | \"B\"");
    expect(ts).toContain('claim:');
    expect(ts).toContain('"type":"bigint"');
  });
});
