import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandGroups, eventPayloads } from '@merces/domain';
import * as gateway from '@merces/math';
import { interim } from '@merces/math';
import * as reference from '@merces/reference';
import { renderReport, runSync, verdictsFrom, type StepReport } from '../src/index.ts';
import { renderAnchorIdl } from '../src/idl-render.ts';
import { diffInterfaces } from '../src/steps/diff.ts';
import { INTERIM_FAMILIES, MERCES_COMMON, PORTED, REFERENCE_REEXPORTS, checkMathPin, checkPorted, interimRemaining, portedFingerprint, rustItem } from '../src/steps/math.ts';
import { SIGNING_REEXPORTS, SIGNING_RENAMED, checkSignatures, knownAnswersPath } from '../src/steps/signatures.ts';
import * as sdk from '@merces/sdk';
import { locateStage1 } from '@merces/chains';

/*
 * S2 cause codes:
 *  - S2-MS: multi-step settlement with Stage 1's names (the one-step settlement and the pull refund are retired);
 *  - S2-G: the interim auction family is retired; the interim cap left is the window and curve cap (S5).
 * S3 cause codes:
 *  - S3-M: the math step lists the curve family ported from merces-common (A-MATH-3) and checks its Rust at the pin.
 *  - S3-NC: a curve raise has no cap at any stage, so the interim cap family is the window cap (S5) only.
 *  - S3-CV: Stage 1's curve lifecycle vocabulary: `curveSwap` (a Meteora DBC swap2; was the toy curve's buy command),
 *    `completeCurve` and `collectCurveProceeds` with Stage 1's names (was a service graduation command under an alias),
 *    and no mint event for a curve buy.
 * S4 cause codes:
 *  - S4-KAT: the `signatures` step (after `curve-port`) reproduces Stage 1's signing known answers through
 *    `@merces/math` and `@merces/domain` on every sync; a drop without them fails it (never a skip).
 *  - S4-BID: since S4 WP2 the step also checks our hex `bidCommitment` and `orderCommitment` against KA's bid
 *    commitments, from the bidder's chain-local address.
 *  - S4-KMS: since S4 WP3 the step also takes each known signature through the KMS DER path (a DER signature with s as
 *    signed and s forced high, normalised by `@merces/ports`' `signature65FromDer`): "DER path 20/20".
 */

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
  for (const { commands: g } of commandGroups) for (const [n, z] of Object.entries(g)) commands[n] = { properties: props((z as unknown as { shape: Record<string, unknown> }).shape, ['kind']) };
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
        { name: 'deliver_bid', args: [], accounts: [{ name: 'payer', signer: true }, { name: 'series' }, { name: 'bidder' }] },
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
    // cause S2-MS: Stage 1's own name, its series and bidder passed as accounts (was the pull refund, never paired with
    // `claim` by a look-alike)
    expect(md).toMatch(/\| deliverBid \| deliver_bid \| seriesId←series \(account\), bidder←bidder \(account\) \| none \|/);
    expect(md).toMatch(/\| claimPayout \| claim \(alias\)/);
    // cause S3-CV: a curve trade is `curveSwap`, a Meteora DBC swap2 (was the toy curve's buy); no Merces instruction pairs with it
    expect(md).toMatch(/\| curveSwap \| \*\*missing\*\* \| — \| a Meteora DBC swap2, not a Merces instruction/);
    // the toy curve's names are gone from the drift report (its buy and graduation commands, its mint and creation events)
    expect(md).not.toMatch(/(buy|graduate)Curve\b|UnitsMint|CurveSeriesCreat/);
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
      math: [{ fn: 'requiredEscrow', args: ['100000000', '1', '100'], expect: '101000000' }],
      scenarios: [{ name: 'register-and-stop', steps: [{ at: 0, actor: 'admin', command: { kind: 'registerIssuer', wallet: '$issuer' } }, { at: 1, actor: 'issuer', command: { kind: 'stopIssuance' } }, { at: 2, actor: 'admin', command: { kind: 'registerIssuer', wallet: '$issuer' } }] }],
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
    // cause GATE: the curve-port step runs on every sync; a drop without Stage 1's curve fixtures and merces-common
    // cannot prove the ported curve family, which fails the sync (never a skip)
    // cause S4-KAT: the signatures step runs after curve-port; a drop without Stage 1's known answers fails it
    expect(r.steps.map((s) => s.step)).toEqual(['detect', 'generate', 'diff', 'math', 'curve-port', 'signatures', 'vectors', 'conformance']);
    expect(by['curve-port']!.status).toBe('fail');
    expect(by['curve-port']!.summary).toMatch(/curve fixtures are not in this drop/);
    expect(by.signatures!.status).toBe('fail');
    expect(by.signatures!.summary).toMatch(/known answers \(known_answers\.json beside the vectors\) are not in this drop/);
    expect(renderReport(r)).toMatch(/Stage 1 signing primitives \(signatures\): FAIL/);
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
    // cause S3-M: the ported family is counted apart and its Rust checked at the pin
    expect(r.details).toContain(`${REFERENCE_REEXPORTS.length}/${REFERENCE_REEXPORTS.length} re-exports are Stage 1's own objects; ${PORTED.length} ported (curve, A-MATH-3)`);
    expect(r.details).toContain(`ported family: the merces-common items of all ${PORTED.length} names present and unchanged since the port (@1bfc66b)`);
    expect(r.summary).toMatch(/beside 16 ported from its Rust \(A-MATH-3\)/);
    const md = readFileSync(join(outDir, 'MATH_PARITY.md'), 'utf8');
    // cause S2-G: the interim auction family is gone; the window cap (S5; cause S3-NC: no curve cap) and the FX family
    // (S5) remain
    expect(md).toMatch(new RegExp(`^Stage 1 math imported at ${pinned.slice(0, 7)}; interim families remaining: .*window cap \\(S5\\)`, 'm'));
    expect(md).not.toMatch(/auction \(S2\)/);
    expect(md).toContain('## Ported from Stage 1\'s Rust (A-MATH-3)');
    expect(md).toContain('Check at this checkout: **ok**.');
    for (const p of PORTED) expect(md).toContain(`| \`${p.name}\` |`);
  });

  it('signatures (S4-KAT): ok on the pinned submodule, every known answer reproduced, and in the verdict', async () => {
    const location = locateStage1('stage1')!;
    const ctx = { location, outDir: mkdtempSync(join(tmpdir(), 'out-')), generatedDir: mkdtempSync(join(tmpdir(), 'gen-')) };
    expect(knownAnswersPath(ctx)).toBe(join(location.root, 'packages/vectors/known_answers.json'));
    const r = await checkSignatures(ctx);
    expect(r.status, r.details.join('\n')).toBe('ok');
    expect(r.details[0]).toBe('signatures: ok (20 messages, 2 domains, 2 series keys, 2 bid commitments, 5 keys, 4 wallets, DER path 20/20)'); // cause S4-KMS
    const total = SIGNING_REEXPORTS.length + Object.keys(SIGNING_RENAMED).length + 1;
    expect(r.details).toContain(`re-exports: ${total}/${total} signing names of @merces/math are @merces/sdk's own objects (deriveTestPrivateKey on @merces/math/testing only)`);
    expect(r.details.some((d) => d.includes('✗'))).toBe(false);
    // cause S4-BID: KA's bid commitments through Stage 1's bytes and through our builders
    expect(r.details).toContain('wallets: 4 through wallet32Of; domains: 2 through signingDomain; series keys: 2 through seriesKeyOf; bid commitments: 2 through bidCommitmentBytes, 2 through our bidCommitment and orderCommitment (the bidder\'s address)');
    const report = renderReport({ present: true, location: location.path, steps: [r], verdicts: [] });
    expect(report).toContain('    signatures: ok (20 messages, 2 domains, 2 series keys, 2 bid commitments, 5 keys, 4 wallets, DER path 20/20)'); // cause S4-KMS
    expect(r.details).toContain('DER path: 20/20 known signatures from a KMS-style DER signature (s as signed and s forced high) through signature65FromDer (@merces/ports)');
    expect(report).toMatch(/Stage 1 signing primitives \(signatures\): OK — Stage 1's signing known answers reproduced byte for byte/);
    // the list is exactly the signing names the gateway re-exports from the SDK, each the SDK's own object
    const gw = gateway as unknown as Record<string, unknown>;
    for (const n of SIGNING_REEXPORTS) expect(gw[n], n).toBe((sdk as unknown as Record<string, unknown>)[n]);
    expect(gw.bidCommitmentBytes).toBe(sdk.bidCommitment);
  });

  it('signatures (S4-KAT): a known answer we do not reproduce, an unknown message kind or a missing section fails', async () => {
    const ka = JSON.parse(readFileSync('stage1/packages/vectors/known_answers.json', 'utf8')) as Record<string, unknown> & { messages: { kind: string; digest: string }[]; wallets: { wallet: string }[] };
    const run = async (edit: (k: typeof ka) => void) => {
      const k = structuredClone(ka);
      edit(k);
      const d = drop({ vectors: 'packages/vectors' }, { 'packages/vectors/known_answers.json': JSON.stringify(k) });
      return checkSignatures(d);
    };
    const intact = await run(() => undefined);
    expect(intact.status, intact.details.join('\n')).toBe('ok');
    const tampered = await run((k) => {
      k.messages[3]!.digest = '0x' + '00'.repeat(32);
      k.wallets[2]!.wallet = '0x' + '00'.repeat(32);
    });
    expect(tampered.status).toBe('fail');
    // cause S4-KMS: a message refused before its DER path does not count toward it
    expect(tampered.details[0]).toBe('signatures: FAIL (20 messages, 2 domains, 2 series keys, 2 bid commitments, 5 keys, 4 wallets, DER path 19/20)');
    expect(tampered.details).toContain('  ✗ messages[3] FX (evm-monad-testnet): the digest differs');
    expect(tampered.details).toContain('  ✗ wallets[2] evm: wallet32Of differs');
    expect(tampered.summary).toMatch(/2 known answer\(s\) not reproduced/);
    const unknown = await run((k) => {
      k.messages[0]!.kind = 'TRANSFER';
    });
    expect(unknown.status).toBe('fail');
    expect(unknown.details.some((x) => /messages\[0\] TRANSFER .*a message kind this step does not know/.test(x))).toBe(true);
    // cause S4-BID: our builders hash the bidder's chain-local address; one whose wallet is not KA's fails the case
    const wrongBidder = await run((k) => {
      (k.bidCommitments as { walletNote: string }[])[1]!.walletNote = 'Solana pubkey base58 11111111111111111111111111111111';
    });
    expect(wrongBidder.status).toBe('fail');
    expect(wrongBidder.details).toContain('  ✗ bid commitments[1]: wallet32Of of the solana bidder is not the wallet');
    expect(wrongBidder.details.some((d) => d.includes('2 through bidCommitmentBytes, 1 through our bidCommitment'))).toBe(true);
    const noKeys = await run((k) => {
      delete k.testKeys;
    });
    expect(noKeys.status).toBe('fail');
    expect(noKeys.summary).toMatch(/the known answers have no testKeys/);
  });

  it('math (S3-M): PORTED is exactly the ported family @merces/math exports, none of it a Stage 1 object', () => {
    expect(PORTED.map((p) => p.name)).toEqual([
      'CURVE_BASE_DECIMALS', 'CURVE_UNIT_SCALE', 'unitScaleFor', 'wadPerScaledUnit', 'scaledCapWad', 'scaledAmount',
      'isCappedScaled', 'vaultReceiveGrossScaled', 'tailReceiveScaled', 'capRemainingScaled', 'redemptionQuoteScaled',
      'p0PerUnit', 'swapBaseMatchesOffer', 'unitsOutstanding', 'migrationFeeSplit', 'walletTenderFits',
    ]);
    const gw = gateway as unknown as Record<string, unknown>;
    const ref = reference as unknown as Record<string, unknown>;
    for (const p of PORTED) {
      expect(p.name in gw, p.name).toBe(true);
      expect(p.name in ref, p.name).toBe(false);
      expect(p.sha, p.name).toMatch(/^[0-9a-f]{16}$/);
    }
    // the ported names are the gateway's only exports outside Stage 1's, our helpers and `interim` (math.test.ts pins
    // the full key list); every scale-aware one names the Stage 1 function it is at scale 1
    expect(PORTED.filter((p) => /Scaled$/.test(p.name)).every((p) => p.scale1.startsWith("Stage 1's"))).toBe(true);
  });

  it('math (S3-M): the ported family\'s Rust is checked item by item (present, unchanged, not yet a Stage 1 import)', () => {
    // a drop with a copy of merces-common at the pin: ok
    const root = mkdtempSync(join(tmpdir(), 'stage1-cm-'));
    mkdirSync(join(root, MERCES_COMMON), { recursive: true });
    for (const f of ['curve.rs', 'vault.rs', 'redemption.rs']) copyFileSync(join('stage1', MERCES_COMMON, f), join(root, MERCES_COMMON, f));
    expect(checkPorted(root, {})).toEqual({ status: 'ok', details: [`ported family: the merces-common items of all ${PORTED.length} names present and unchanged since the port (@1bfc66b)`] });
    // the items: a const line, a top-level fn to its closing brace, a private fn
    expect(rustItem(root, 'curve.rs:CURVE_UNIT_SCALE')).toBe('pub const CURVE_UNIT_SCALE: u64 = 1_000_000;');
    const p0 = rustItem(root, 'curve.rs:p0_per_unit')!;
    expect(p0.split('\n')[0]).toBe('pub fn p0_per_unit(');
    expect(p0.endsWith('\n}')).toBe(true);
    expect(rustItem(root, 'vault.rs:distribute')!.startsWith('fn distribute(')).toBe(true);
    expect(rustItem(root, 'vault.rs:no_such_fn')).toBeNull();
    // a changed body: only the names that port it fail
    const curve = join(root, MERCES_COMMON, 'curve.rs');
    const src = readFileSync(curve, 'utf8');
    writeFileSync(curve, src.replace('.checked_add(99)', '.checked_add(98)'));
    const changed = checkPorted(root, {});
    expect(changed.status).toBe('fail');
    expect(changed.details.join('\n')).toMatch(/changed since the port .*: migrationFeeSplit \(curve\.rs:migration_fee_split\)$/m);
    // a removed item
    writeFileSync(curve, src.replace('pub fn wallet_tender_fits(', 'pub fn wallet_tender_fits_v2('));
    const gone = checkPorted(root, {});
    expect(gone.status).toBe('fail');
    expect(gone.details.join('\n')).toMatch(/missing at this checkout: walletTenderFits \(curve\.rs:wallet_tender_fits\)/);
    // the fingerprint ignores nothing but the other items
    writeFileSync(curve, src);
    expect(portedFingerprint(root, PORTED.find((p) => p.name === 'p0PerUnit')!.rust)).toBe(PORTED.find((p) => p.name === 'p0PerUnit')!.sha);
    // Stage 1's math exporting a ported name: replace the port with an import
    const imported = checkPorted(root, { p0PerUnit: () => 0n });
    expect(imported.status).toBe('warn');
    expect(imported.details[0]).toMatch(/Stage 1's math now exports p0PerUnit: replace the port with an import/);
    // a drop without the Rust crate cannot be checked
    expect(checkPorted(mkdtempSync(join(tmpdir(), 'stage1-none-')), {})).toEqual({ status: 'warn', details: [`ported family not checked: ${MERCES_COMMON} is not in this drop`] });
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
    // every interim name belongs to a family; the window cap (S5; cause S3-NC: no curve cap) and FX (S5) families
    // outlive S2
    expect(all.find((f) => f.family === 'unclassified')).toBeUndefined();
    // cause S2-G: since S2 exactly these two families remain, each in full (the auction family is retired)
    expect(all).toEqual(INTERIM_FAMILIES);
    expect(INTERIM_FAMILIES.map((f) => f.family)).toEqual(['window cap (S5)']);
    expect(INTERIM_FAMILIES.flatMap((f) => f.names).filter((n, i, a) => a.indexOf(n) !== i)).toEqual([]);
    expect(Object.keys(interim)).toContain('walletCapUnits');
    // a name outside the families (a retired interim name coming back, a Stage 1 name under `interim`) is unclassified
    expect(interimRemaining(['walletCapUnits', 'pythToWad', 'min', 'requiredEscrow'])).toEqual([
      { family: 'window cap (S5)', names: ['walletCapUnits'] },
      { family: 'unclassified', names: ['pythToWad', 'min', 'requiredEscrow'] },
    ]);
  });

  it('renders an Anchor IDL into a typed module', () => {
    const ts = renderAnchorIdl('x', { metadata: { name: 'x' }, instructions: [{ name: 'claim', args: [{ name: 'amount', type: 'u64' }, { name: 'who', type: 'pubkey' }] }], types: [{ name: 'Mode', type: { kind: 'enum', variants: [{ name: 'A' }, { name: 'B' }] } }] });
    expect(ts).toContain("export type Mode = \"A\" | \"B\"");
    expect(ts).toContain('claim:');
    expect(ts).toContain('"type":"bigint"');
  });
});
