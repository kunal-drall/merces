import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminCommands, eventPayloads, routerCommands, serviceCommands, userCommands } from '@merces/domain';
import { interimMath, selectedMathName } from '@merces/math';
import { renderReport, runSync, verdictsFrom, type StepReport } from '../src/index.ts';
import { renderAnchorIdl } from '../src/idl-render.ts';
import { canon, decodeArg } from '../src/steps/math.ts';
import { diffInterfaces } from '../src/steps/diff.ts';
import { swapMath } from '../src/steps/math.ts';
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

  it('math vectors decode bigints at any depth, so object-argument functions can be compared', async () => {
    const params = { bids: [{ bidder: 'a', pricePerUnit: 10_000_000n, quantity: 100n, order: 0 }, { bidder: 'b', pricePerUnit: 9_000_000n, quantity: 300n, order: 1 }], unitsOffered: 300n, reservePrice: 8_000_000n, minimumRaise: 1_000_000_000n, walletCapUnits: 300n, auctionFeeBps: 100n };
    const asJson = JSON.parse(JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as unknown;
    expect(decodeArg(asJson)).toEqual(params);
    const expected = JSON.parse(canon(interimMath.clearAuction(params))) as unknown;
    (globalThis as Record<string, unknown>).__mercesInterimForTest = interimMath;
    const vectors = JSON.stringify({ math: [{ fn: 'clearAuction', args: [asJson], expect: expected }] });
    const same = drop({ math: { package: './fake-math.mjs' }, vectors: 'vectors.json' }, { 'fake-math.mjs': 'export const mercesMath = { ...globalThis.__mercesInterimForTest };', 'vectors.json': vectors });
    const r = await swapMath(same);
    expect(r.status, readFileSync(join(same.outDir, 'MATH_PARITY.md'), 'utf8')).toBe('ok');
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

  it('math parity compares whole results, so a wrong object result is a disagreement', async () => {
    const args = ['1000000', '100', '0', '1000000000000000000000'];
    const expected = JSON.parse(canon(interimMath.applyGrossPayment(...(args.map(BigInt) as [bigint, bigint, bigint, bigint])))) as unknown;
    const stage1Module = `const m = globalThis.__mercesInterimForTest;
export const mercesMath = { ...m, applyGrossPayment: () => ({ accepted: 999999999n, refund: 0n, capReached: true }) };`;
    (globalThis as Record<string, unknown>).__mercesInterimForTest = interimMath;
    const vectors = JSON.stringify({ math: [{ fn: 'applyGrossPayment', args, expect: expected }] });
    const bad = drop({ math: { package: './fake-math.mjs' }, vectors: 'vectors.json' }, { 'fake-math.mjs': stage1Module, 'vectors.json': vectors });
    const r = await swapMath(bad);
    expect(r.status).toBe('fail');
    expect(readFileSync(join(bad.outDir, 'MATH_PARITY.md'), 'utf8')).toMatch(/DISAGREE applyGrossPayment/);
    // the same vector against a faithful library proves parity, which is reported as eligibility, not a swap
    const good = drop({ math: { package: './fake-math.mjs' }, vectors: 'vectors.json' }, { 'fake-math.mjs': 'export const mercesMath = { ...globalThis.__mercesInterimForTest };', 'vectors.json': vectors });
    const ok = await swapMath(good);
    expect(ok.status).toBe('ok');
    expect(ok.summary).toMatch(/eligible.*not wired at runtime/);
    expect(ok.summary).not.toMatch(/selected|switched/);
    expect(selectedMathName()).toBe('interim');
    expect(canon({ b: 1n, a: [2, '3'] })).toBe(canon({ a: ['2', 3n], b: '1' }));
    expect(canon({ a: 1n })).not.toBe(canon({ a: 1n, b: 0n }));
  });

  it('renders an Anchor IDL into a typed module', () => {
    const ts = renderAnchorIdl('x', { metadata: { name: 'x' }, instructions: [{ name: 'claim', args: [{ name: 'amount', type: 'u64' }, { name: 'who', type: 'pubkey' }] }], types: [{ name: 'Mode', type: { kind: 'enum', variants: [{ name: 'A' }, { name: 'B' }] } }] });
    expect(ts).toContain("export type Mode = \"A\" | \"B\"");
    expect(ts).toContain('claim:');
    expect(ts).toContain('"type":"bigint"');
  });
});
