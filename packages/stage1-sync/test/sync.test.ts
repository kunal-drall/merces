import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminCommands, eventPayloads, routerCommands, serviceCommands, userCommands } from '@merces/domain';
import { interim } from '@merces/math';
import { renderReport, runSync, verdictsFrom, type StepReport } from '../src/index.ts';
import { renderAnchorIdl } from '../src/idl-render.ts';
import { diffInterfaces } from '../src/steps/diff.ts';
import { INTERIM_FAMILIES, REFERENCE_REEXPORTS, checkMathPin, interimRemaining } from '../src/steps/math.ts';
import { locateStage1 } from '@merces/chains';

/** A Stage 1 drop with only a manifest (plus extra files written by the caller). */
function drop(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stage1-'));
  mkdirSync(join(root, 'handoff'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  writeFileSync(join(root, 'handoff', 'manifest.json'), JSON.stringify({ version: '0.0.1', ...manifest }));
  const location = locateStage1(root)!;
  const outDir = mkdtempSync(join(tmpdir(), 'out-'));
  // the repository copy of the drift report is never touched by tests
  return { location, outDir, generatedDir: mkdtempSync(join(tmpdir(), 'gen-')), driftFile: join(outDir, 'repo-INTERFACE_DRIFT.md') };
}

/** A JSON events schema that mirrors the canonical vocabulary exactly. */
function canonicalSchema() {
  const props = (shape: Record<string, unknown>, drop: string[] = []) => Object.fromEntries(Object.keys(shape).filter((k) => !drop.includes(k)).map((k) => [k, {}]));
  const events = Object.fromEntries(Object.entries(eventPayloads).map(([n, z]) => [n, { properties: props((z as unknown as { shape: Record<string, unknown> }).shape) }]));
  const commands: Record<string, { properties: Record<string, unknown> }> = {};
  // a command's `kind` is the discriminator, not an argument
  for (const g of [userCommands, serviceCommands, adminCommands, routerCommands]) for (const [n, z] of Object.entries(g)) commands[n] = { properties: props((z as unknown as { shape: Record<string, unknown> }).shape, ['kind']) };
  return { events, commands };
}

describe('stage1:sync', () => {
  it('reports "Stage 1 not present" cleanly when STAGE1_PATH is unset or empty', async () => {
    const r = await runSync({ stage1Path: undefined, outDir: mkdtempSync(join(tmpdir(), 'out-')), generatedDir: mkdtempSync(join(tmpdir(), 'gen-')), runConformance: false, json: false });
    expect(r.present).toBe(false);
    expect(renderReport(r)).toContain('Stage 1 not present');
    const r2 = await runSync({ stage1Path: mkdtempSync(join(tmpdir(), 'empty-')), outDir: mkdtempSync(join(tmpdir(), 'out-')), generatedDir: mkdtempSync(join(tmpdir(), 'gen-')), runConformance: false, json: false });
    expect(r2.present).toBe(false);
  });

  it('interface diff is ok only for exact matches; extra args and look-alike names are drift', async () => {
    const schema = canonicalSchema();
    const exact = drop({ events: { schema: 'events.schema.json' } }, { 'events.schema.json': JSON.stringify(schema) });
    const cwd = process.cwd();
    const clean = await diffInterfaces(exact);
    expect(clean.status).toBe('ok');
    expect(Object.keys(schema.commands)).toContain('submitReport');
    expect(Object.keys(schema.events)).toContain('PaymentReceived');
    const drifted = structuredClone(schema);
    drifted.commands.submitReport!.properties.proofVersion = {};
    const pr = Object.keys(drifted.events.PaymentReceived!.properties);
    drifted.events.PaymentReceived!.properties = Object.fromEntries(pr.map((k) => [({ seriesId: 'series', fee: 'feeBps', periodId: 'periodIdx' } as Record<string, string>)[k] ?? k, {}]));
    const d = drop({ events: { schema: 'events.schema.json' } }, { 'events.schema.json': JSON.stringify(drifted) });
    const r = await diffInterfaces(d);
    expect(r.status).toBe('warn');
    const md = readFileSync(join(d.outDir, 'INTERFACE_DRIFT.md'), 'utf8');
    expect(md).toMatch(/\| submitReport \| submitReport \|.*extra arg proofVersion/);
    // `series` is a reviewed spelling of seriesId; a near name is an unverified match; anything else is missing + extra
    expect(md).toMatch(/\| PaymentReceived \| PaymentReceived \| seriesId←series.*unverified match periodId←periodIdx/);
    expect(md).toMatch(/missing field fee;.*extra field feeBps/);
    expect(process.cwd()).toBe(cwd);
  });

  it('Solana IDLs: reviewed aliases, series passed as an account, internal instructions and by-design gaps', async () => {
    const idl = {
      instructions: [
        { name: 'claim_release', args: [], accounts: [{ name: 'issuer', signer: true }, { name: 'series' }, { name: 'treasury' }] },
        { name: 'claim', args: [], accounts: [{ name: 'holder' }, { name: 'series' }] },
        { name: 'mark_terminal', args: [{ name: 'status' }], accounts: [{ name: 'series' }] },
      ],
      events: [{ name: 'RaiseSettled' }],
      types: [{ name: 'RaiseSettled', type: { kind: 'struct', fields: [{ name: 'series' }, { name: 'clearing_price' }] } }],
    };
    const d = drop({ solana: { idlDir: 'idls' } }, { 'idls/merces_protocol.json': JSON.stringify(idl) });
    const r = await diffInterfaces(d);
    expect(r.status).toBe('warn');
    const md = readFileSync(join(d.outDir, 'INTERFACE_DRIFT.md'), 'utf8');
    expect(md).toMatch(/\| drawRelease \| claim_release \(alias\) \| seriesId←series \(account\)/);
    expect(md).toMatch(/\| AuctionSettled \| RaiseSettled \(alias\) \| seriesId←series, clearingPrice←clearing_price/);
    expect(md).toMatch(/\| claimRefund \| \*\*missing\*\*/); // never paired with `claim` by a look-alike
    expect(md).toMatch(/\| buyCurve \| \*\*missing\*\* \| — \| curve buys are Meteora DBC swaps/);
    expect(md).toContain('callable only by another Merces program or contract');
    expect(md).toMatch(/mark_terminal \(merces_protocol\)/);
    expect(md).not.toMatch(/\| — \| mark_terminal \|/);
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
    const r = await runSync({ stage1Path: root, outDir, generatedDir, runConformance: false, json: false, driftFile: join(outDir, 'repo-INTERFACE_DRIFT.md') });
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
    // unresolved drift and conformance that never ran both block live
    for (const v of r.verdicts) {
      expect(v.ready).toBe(false);
      expect(v.blockers.some((b) => b.startsWith('diff:'))).toBe(true);
      expect(v.blockers.some((b) => b.startsWith('conformance:'))).toBe(true);
    }
    expect(renderReport(r)).not.toContain('READY for live');
    expect(process.cwd()).toBe(cwd);
  });

  it('extra Stage 1 items, names-only sources and disagreeing sources are drift', async () => {
    const committed = readFileSync('INTERFACE_DRIFT.md', 'utf8');
    const schema = canonicalSchema();
    const extra = structuredClone(schema) as { events: Record<string, { properties: Record<string, unknown> }>; commands: Record<string, { properties: Record<string, unknown> }> };
    extra.commands.adminSweep = { properties: { to: {}, amount: {} } };
    extra.events.AdminSweep = { properties: { to: {}, amount: {} } };
    const withExtra = drop({ events: { schema: 'events.schema.json' } }, { 'events.schema.json': JSON.stringify(extra) });
    const r = await diffInterfaces(withExtra);
    expect(r.status).toBe('warn');
    expect(r.details[0]).toMatch(/2 extra Stage 1 item/);
    // a names-only Solana IDL and an ABI with fields for the same names: the item stays unverified, never 'ok'
    const d = drop({});
    mkdirSync(join(d.generatedDir, 'solana'));
    mkdirSync(join(d.generatedDir, 'evm'));
    writeFileSync(join(d.generatedDir, 'solana', 'series.ts'), 'export const instructions = {\n  openRaise: { discriminator: [1] },\n};\nexport const events = {\n  RaiseOpened: { discriminator: [2] },\n};\nexport const accounts = {};\n');
    writeFileSync(join(d.generatedDir, 'evm', 'Series.ts'), 'export const SeriesAbi = ' + JSON.stringify([{ type: 'event', name: 'RaiseOpened', inputs: [{ name: 'seriesId' }] }, { type: 'function', name: 'openRaise', stateMutability: 'nonpayable', inputs: [{ name: 'seriesId' }] }, { type: 'function', name: 'getSeries', stateMutability: 'view', inputs: [{ name: 'seriesId' }] }]) + ' as const;\n');
    const n = await diffInterfaces(d);
    const md = readFileSync(join(d.outDir, 'INTERFACE_DRIFT.md'), 'utf8');
    expect(md).toMatch(/\| RaiseOpened \| RaiseOpened \| fields unknown/);
    expect(md).toMatch(/\| openRaise \| openRaise \| fields unknown/);
    expect(md).not.toContain('getSeries'); // view functions are reads, not instructions
    expect(n.status).toBe('warn');
    // the test never wrote the committed report
    expect(readFileSync('INTERFACE_DRIFT.md', 'utf8')).toBe(committed);
  });

  it('a chain is not ready when conformance passed on other chains but never ran on it', () => {
    const step = (name: string, status: StepReport['status'], details: string[] = []): StepReport => ({ step: name, status, summary: name, details });
    const base = [step('detect', 'ok'), step('generate', 'ok'), step('diff', 'ok'), step('math', 'warn'), step('vectors', 'ok')];
    const loc = { manifest: { solana: { cluster: 'devnet' }, evm: [{ chain: 'monad-testnet' }] } };
    const v = verdictsFrom([...base, step('conformance', 'ok', ['[monad-testnet] conformance passed'])], loc);
    expect(v.find((x) => x.chain === 'monad-testnet')!.ready).toBe(true);
    expect(v.find((x) => x.chain === 'solana')!.ready).toBe(false);
    expect(v.find((x) => x.chain === 'solana')!.blockers).toContain('conformance: did not run on solana');
  });

  it('verdict is ready only when diff and conformance are ok', () => {
    const step = (name: string, status: StepReport['status'], details: string[] = []): StepReport => ({ step: name, status, summary: name, details });
    const base = [step('detect', 'ok'), step('generate', 'ok'), step('math', 'warn'), step('vectors', 'ok')];
    const loc = { manifest: { solana: {}, evm: [{ chain: 'monad-testnet' }] } };
    const passedBoth = ['[solana] conformance passed', '[monad-testnet] conformance passed'];
    expect(verdictsFrom([...base, step('diff', 'ok'), step('conformance', 'ok', passedBoth)], loc).every((v) => v.ready)).toBe(true);
    expect(verdictsFrom([...base, step('diff', 'warn'), step('conformance', 'ok')], loc).some((v) => v.ready)).toBe(false);
    expect(verdictsFrom([...base, step('diff', 'ok'), step('conformance', 'skipped')], loc).some((v) => v.ready)).toBe(false);
    expect(verdictsFrom([...base, step('diff', 'ok')], loc)[0]!.blockers).toContain('conformance: did not run');
  });

  it('math: ok on the pinned submodule, where every re-export is Stage 1\'s own function', async () => {
    const location = locateStage1('stage1')!;
    const pinned = location.manifest.commit!;
    const outDir = mkdtempSync(join(tmpdir(), 'out-'));
    const r = await checkMathPin({ location, outDir, generatedDir: mkdtempSync(join(tmpdir(), 'gen-')) });
    expect(r.status, r.details.join('\n')).toBe('ok');
    expect(r.details).toContain(`${REFERENCE_REEXPORTS.length}/${REFERENCE_REEXPORTS.length} re-exports are Stage 1's own objects`);
    const md = readFileSync(join(outDir, 'MATH_PARITY.md'), 'utf8');
    expect(md).toMatch(new RegExp(`^Stage 1 math imported at ${pinned}; interim families remaining: .*auction \\(S2\\)`, 'm'));
  });

  it('math: a substituted function, a missing export or another commit fails; an unpinned drop only warns', async () => {
    // a math package whose functions are not Stage 1's own objects (a re-implementation, however faithful)
    const fake = 'export const deriveStatus = () => 0;\nexport const owedYtd = () => 0n;\n';
    const sub = drop({ commit: 'abc', math: { package: './fake-math.mjs' } }, { 'fake-math.mjs': fake });
    const r = await checkMathPin(sub);
    expect(r.status).toBe('fail');
    expect(r.details.join('\n')).toMatch(/different object than Stage 1 for: .*deriveStatus/);
    expect(r.details.join('\n')).toMatch(/no longer exports: .*capPerUnit/);
    expect(r.details.join('\n')).toMatch(/not a git checkout/);
    expect(readFileSync(join(sub.outDir, 'MATH_PARITY.md'), 'utf8')).toMatch(/NOT imported faithfully/);
    // a git checkout at another commit than the manifest pins
    const moved = drop({ commit: '0000000', math: { package: './fake-math.mjs' } }, { 'fake-math.mjs': fake });
    const git = (...a: string[]) => execFileSync('git', ['-C', moved.location.root, ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x');
    const m = await checkMathPin(moved);
    expect(m.status).toBe('fail');
    expect(m.details.join('\n')).toMatch(/checkout is at [0-9a-f]{7} but the Stage 1 manifest pins 0000000/);
    // nothing to check: no math package
    const none = await checkMathPin(drop({ commit: 'abc' }));
    expect(none.status).toBe('warn');
  });

  it('math: interim families are reported from what `interim` still exports', () => {
    const all = interimRemaining();
    // every interim name belongs to a family; the auction (S2) and FX (S5) families outlive S1
    expect(all.find((f) => f.family === 'unclassified')).toBeUndefined();
    // since S1 exactly these two families remain, each in full
    expect(all).toEqual(INTERIM_FAMILIES);
    expect(INTERIM_FAMILIES.flatMap((f) => f.names).filter((n, i, a) => a.indexOf(n) !== i)).toEqual([]);
    expect(Object.keys(interim)).toContain('clearAuction');
    // a retired interim name coming back is unclassified, not quietly accepted
    expect(interimRemaining(['clearAuction', 'pythToWad', 'min', 'somethingNew'])).toEqual([
      { family: 'FX (S5)', names: ['pythToWad'] },
      { family: 'auction (S2)', names: ['clearAuction'] },
      { family: 'unclassified', names: ['min', 'somethingNew'] },
    ]);
  });

  it('renders an Anchor IDL into a typed module', () => {
    const ts = renderAnchorIdl('x', { metadata: { name: 'x' }, instructions: [{ name: 'claim', args: [{ name: 'amount', type: 'u64' }, { name: 'who', type: 'pubkey' }] }], types: [{ name: 'Mode', type: { kind: 'enum', variants: [{ name: 'A' }, { name: 'B' }] } }] });
    expect(ts).toContain("export type Mode = \"A\" | \"B\"");
    expect(ts).toContain('claim:');
    expect(ts).toContain('"type":"bigint"');
  });
});
