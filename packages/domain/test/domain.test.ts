import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BN254_FR, CURRENCY_CODES, DEFAULT_PARAMETERS } from '@merces/math';
import { randomBytes } from 'node:crypto';
import {
  DEFAULTS, E2E_HEADER_BYTES, E2E_TAG_BYTES, E2E_TIER3_OPENING, INDEXING_RULE_CODE, REPORT_PUBLIC_INPUT_NAMES, ZERO_INCOME_COMMITMENT,
  attestationMessage, bidCommitment, canonicalJson, domainJsonSchema, eventTypes, expectedPrior, fieldToHex32, hex32ToField, incomeCommitment, isEvmAddress, isSolanaAddress,
  makeSeriesId, mockProve, mockVerify, parseDomainEvent, parseE2eEnvelope, readsAsText, parseSeriesId, randomFieldSalt, reportPublicInputs, reportProofSchema, routerIncomeCommitment, termsCommitment, userCommandSchema,
  type IndexingRule,
} from '../src/index.ts';

describe('ids', () => {
  it('round-trips series ids and detects address families', () => {
    expect(parseSeriesId(makeSeriesId('solana', 'abc'))).toEqual({ chain: 'solana', address: 'abc' });
    expect(isEvmAddress('0x' + 'ab'.repeat(20))).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('0x' + 'ab'.repeat(20))).toBe(false);
  });
});

/** Stage 1's known answers and one vector, read from the pinned submodule (TEST ONLY data). */
const VECTORS = fileURLToPath(new URL('../../../stage1/packages/vectors/', import.meta.url));
const known = JSON.parse(readFileSync(VECTORS + 'known_answers.json', 'utf8')) as {
  termsCommitments: { theta: string; rWad: string; currencyCode: number; indexingRule: number; termsSalt: string; commitmentHex: string }[];
  incomeCommitments: { incomeYtd: string; incomeSalt: string; commitmentHex: string }[];
  routerIncomeCommitments: { ytdAtEnd: string; commitmentHex: string }[];
  poseidon2: { inputs: string[]; outputHex: string }[];
};
const alphaOf = (code: number): string => Object.entries(CURRENCY_CODES).find(([, c]) => c === code)![0];
const ruleOf = (code: number): IndexingRule => (Object.entries(INDEXING_RULE_CODE).find(([, c]) => c === code)![0] as IndexingRule);

describe('hashing', () => {
  it('canonical JSON sorts keys and stringifies bigints', () => {
    expect(canonicalJson({ b: 1n, a: [2, { d: 'x', c: null }] })).toBe('{"a":[2,{"c":null,"d":"x"}],"b":"1"}');
  });
  it('terms commitments are Stage 1\'s Poseidon(5) (known answers)', () => {
    expect(known.termsCommitments.length).toBeGreaterThan(0);
    for (const k of known.termsCommitments) {
      expect(termsCommitment({ theta: k.theta, rWad: BigInt(k.rWad), currency: alphaOf(k.currencyCode), indexingRule: ruleOf(k.indexingRule), termsSalt: k.termsSalt })).toBe(k.commitmentHex);
    }
  });
  it('income and router commitments are Stage 1\'s Poseidon(2) (known answers); ZERO is Poseidon(0, 0)', () => {
    for (const k of known.incomeCommitments) expect(incomeCommitment(BigInt(k.incomeYtd), k.incomeSalt)).toBe(k.commitmentHex);
    for (const k of known.routerIncomeCommitments) expect(routerIncomeCommitment(k.ytdAtEnd)).toBe(k.commitmentHex);
    const zero = known.poseidon2.find((k) => k.inputs.join() === '0,0')!;
    expect(ZERO_INCOME_COMMITMENT).toBe(zero.outputHex);
    expect(incomeCommitment(0n, 0n)).toBe(ZERO_INCOME_COMMITMENT);
  });
  it('field encoding round-trips and refuses values that are not field elements, without echoing them', () => {
    const f = hex32ToField(ZERO_INCOME_COMMITMENT);
    expect(fieldToHex32(f)).toBe(ZERO_INCOME_COMMITMENT);
    const r = BN254_FR.toString(16).padStart(64, '0');
    expect(() => hex32ToField('0x' + r)).toThrow(/not a BN254 field element/);
    expect(() => hex32ToField('0x12')).toThrow(RangeError);
    expect(() => incomeCommitment(7_317_317_317n, BN254_FR)).toThrow(/^incomeSalt is not a BN254 field element$/);
    expect(() => incomeCommitment(1n << 64n, 1n)).toThrow(/^incomeYtd is out of the u64 range$/);
    expect(() => termsCommitment({ theta: 1n, rWad: 1n, currency: 'XXX', indexingRule: 'none', termsSalt: 1n })).toThrow(/^unsupported reporting currency$/);
    const s = randomFieldSalt();
    expect(s >= 0n && s < BN254_FR).toBe(true);
  });
  it('reportPublicInputs is Stage 1\'s signal layout: vector 07 step 31 (2026Q1 report)', () => {
    const v = JSON.parse(readFileSync(VECTORS + '07_late_payment.json', 'utf8')) as {
      seriesPrivate: { S1: { termsPlain: { theta: string; rWad: string; currencyCode: number; indexingRule: number; termsSalt: string }; termsCommitment: string } };
      steps: Record<string, string | null | object>[];
    };
    const step = v.steps[31]!;
    expect(step.op).toBe('submit_report');
    const t = v.seriesPrivate.S1;
    expect(termsCommitment({ theta: t.termsPlain.theta, rWad: t.termsPlain.rWad, currency: alphaOf(t.termsPlain.currencyCode), indexingRule: ruleOf(t.termsPlain.indexingRule), termsSalt: t.termsPlain.termsSalt })).toBe(t.termsCommitment);
    const signals = reportPublicInputs({
      termsCommitment: t.termsCommitment, unitsOutstanding: 400n, fxAvgWad: step.fxAvgWad as string,
      priorIncomeCommitment: step.priorIncomeCommitment as string, incomeCommitment: step.incomeCommitment as string, paymentStable: step.paymentUsd as string,
    });
    expect(signals).toEqual(step.publicSignals);
    expect(REPORT_PUBLIC_INPUT_NAMES).toHaveLength(6);
  });
  it('expectedPrior follows SPEC §6.2 step 5: chained, A25 first report, otherwise ZERO', () => {
    const c = incomeCommitment(5n, 9n);
    const other = incomeCommitment(6n, 9n);
    const q1 = 8104; // 2026Q1
    // chained within the year
    expect(expectedPrior({ lastAcceptedPeriod: q1, lastIncomePeriod: q1, lastIncomeCommitment: c }, q1 + 1, other)).toBe(c);
    // the chain breaks at a year boundary: 2026Q4 → 2027Q1 starts again from ZERO
    expect(expectedPrior({ lastAcceptedPeriod: q1 + 3, lastIncomePeriod: q1 + 3, lastIncomeCommitment: c }, q1 + 4, other)).toBe(ZERO_INCOME_COMMITMENT);
    // first report outside Q1 (A25): the supplied prior is accepted as given
    expect(expectedPrior({ lastAcceptedPeriod: null, lastIncomePeriod: null, lastIncomeCommitment: ZERO_INCOME_COMMITMENT }, q1 + 2, other)).toBe(other);
    // first report in Q1: ZERO
    expect(expectedPrior({ lastAcceptedPeriod: null, lastIncomePeriod: null, lastIncomeCommitment: ZERO_INCOME_COMMITMENT }, q1, other)).toBe(ZERO_INCOME_COMMITMENT);
  });
  it('other commitments and the attestation message keep their encodings', () => {
    expect(bidCommitment({ seriesId: 's', bidder: 'b', pricePerUnit: 10n, quantity: 5n, salt: 'x' })).toMatch(/^0x[0-9a-f]{64}$/);
    const msg = new TextDecoder().decode(attestationMessage({ seriesId: 's', periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: '0x' + '01'.repeat(32), tier: 2, liquidityEvent: false }));
    expect(msg.startsWith('merces/attestation/v1\n')).toBe(true);
    expect(msg).toContain('"priorIncomeCommitment"');
    expect(msg).toContain('"liquidityEvent":false');
  });
  it('mock proofs are a digest over the six public inputs only', () => {
    const pub = ['1', '2', '3', '4', '5', '6'];
    const proof = mockProve(pub);
    expect(mockVerify(proof, pub)).toBe(true);
    expect(mockVerify(proof, ['1', '2', '3', '4', '5', '7'])).toBe(false);
    expect(mockVerify(proof, pub.slice(0, 5))).toBe(false);
    expect(mockVerify('garbage', pub)).toBe(false);
    expect(mockVerify({ pi_a: [] }, pub)).toBe(false);
  });
});

describe('schemas', () => {
  it('parses a valid event and rejects an unknown one', () => {
    const ev = parseDomainEvent({ chain: 'solana', cursor: '0000000001', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized', type: 'AllowlistUpdated', payload: { wallet: 'w', allowed: true } });
    expect(ev.type).toBe('AllowlistUpdated');
    expect(() => parseDomainEvent({ chain: 'solana', cursor: '1', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized', type: 'Nope', payload: {} })).toThrow();
    expect(() => parseDomainEvent({ chain: 'solana', cursor: '1', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized', type: 'PayoutClaimed', payload: { seriesId: 'solana:x', holder: 'h', amount: '1.5' } })).toThrow();
  });
  it('parses commands', () => {
    expect(userCommandSchema.parse({ kind: 'claimPayout', seriesId: 'solana:abc' }).kind).toBe('claimPayout');
    const signals = ['1', '2', '3', '4', '5', '6'];
    const g16 = { pi_a: ['1', '2', '1'], pi_b: [['1', '2'], ['3', '4'], ['1', '0']], pi_c: ['5', '6', '1'], protocol: 'groth16', curve: 'bn128' };
    expect(reportProofSchema.parse({ system: 'groth16-bn254', proof: g16, publicInputs: signals }).system).toBe('groth16-bn254');
    expect(() => reportProofSchema.parse({ system: 'groth16-bn254', proof: { ...g16, witness: '1' }, publicInputs: signals })).toThrow();
    expect(() => reportProofSchema.parse({ system: 'mock', proof: 'x', publicInputs: signals.slice(1) })).toThrow();
    expect(() => reportProofSchema.parse({ system: 'mock', proof: 'x', publicInputs: ['0x01', ...signals.slice(1)] })).toThrow();
    expect(() => userCommandSchema.parse({ kind: 'payIn', seriesId: 'solana:abc', periodId: '2026Q5', amount: '1' })).toThrow();
  });
  it('covers every event listed in Part D2', () => {
    const required = ['IssuerRegistered', 'SeriesCreated', 'RaiseOpened', 'RaiseCancelled', 'BidCommitted', 'BidRevealed', 'AuctionSettled', 'AuctionFailed', 'BidRefunded', 'UnitsMinted', 'TreasuryFunded', 'FundsReleased', 'ReleasesPaused', 'ReleasesResumed', 'SplitReceipt', 'ReportAccepted', 'PaymentReceived', 'PaymentRefunded', 'FeeTaken', 'PayoutClaimed', 'SeriesRetired', 'UnitsBurned', 'RedemptionOpened', 'RedemptionClaimed', 'TailPayout', 'PauseRequested', 'PauseApproved', 'PauseEnded', 'StatusChanged', 'FormalNoticeDue', 'TermsAmended', 'SeriesExtinguished', 'RateSnapshot', 'FxFallbackFlagged', 'TransferWindowOpened', 'TransferWindowCleared', 'UnitsTransferred', 'AllowlistUpdated', 'AttestorRegistered', 'CurveSeriesCreated', 'CurveGraduated'];
    for (const r of required) expect(eventTypes).toContain(r);
  });
  it('the committed JSON schema is up to date', () => {
    const path = fileURLToPath(new URL('../schema/domain-v0.schema.json', import.meta.url));
    const committed = JSON.parse(readFileSync(path, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(domainJsonSchema())));
  });
});

describe('protocol defaults', () => {
  it('take Stage 1\'s defaults where Stage 1 fixes one', () => {
    expect(DEFAULTS.lockupSeconds).toBe(47_336_400); // 18 × 30.4375 days
    expect(DEFAULTS.tailSeconds).toBe(31_536_000); // 365 days
    expect(DEFAULTS.maxPauseSeconds).toBe(Number(DEFAULT_PARAMETERS.maxPauseSeconds));
    expect(DEFAULTS.maxCumulativePauseSeconds).toBe(Number(DEFAULT_PARAMETERS.maxCumulativePauseSeconds));
    expect(DEFAULTS.maxPauses).toBe(16);
    expect([DEFAULTS.dueDays, DEFAULTS.graceDays, DEFAULTS.formalNoticeDays]).toEqual([DEFAULT_PARAMETERS.reportDueDays, DEFAULT_PARAMETERS.graceDays, DEFAULT_PARAMETERS.formalNoticeDays]);
  });
});

// S1 review: a tier-3 opening must be a merces-e2e v1 envelope; the server refuses anything else by its shape (it holds
// no key). The shape: base64(0x01 ‖ ephemeral X25519 public key (32) ‖ nonce (12) ‖ ciphertext ‖ tag (16)).
describe('merces-e2e v1 envelope shape', () => {
  const opening = JSON.stringify({ version: 'merces/tier3-opening/v1', seriesId: 'solana:s', periodId: '2026Q3', incomeYtd: '8484848484', incomeSalt: '123', priorIncomeYtd: '8282828282', priorSalt: '456', priorIncomeCommitment: '0x' + '11'.repeat(32), incomeCommitment: '0x' + '22'.repeat(32) });
  const frame = (payload: Buffer, over: { version?: number; key?: Buffer; nonce?: Buffer } = {}) => Buffer.concat([Buffer.from([over.version ?? 1]), over.key ?? randomBytes(32), over.nonce ?? randomBytes(12), payload]);
  // random bytes stand in for ciphertext ‖ tag: the server cannot tell them apart, which is the point
  const sealedLike = (n: number) => frame(randomBytes(n + E2E_TAG_BYTES));
  const code = (v: string) => {
    const r = parseE2eEnvelope(v, E2E_TIER3_OPENING);
    return r.ok ? 'ok' : r.code;
  };

  it('accepts the shape of a sealed opening and exposes its parts', () => {
    const b = sealedLike(Buffer.byteLength(opening));
    const r = parseE2eEnvelope(b.toString('base64'), E2E_TIER3_OPENING);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.version).toBe(1);
    expect(Buffer.from(r.envelope.header).equals(b.subarray(0, E2E_HEADER_BYTES))).toBe(true);
    expect(Buffer.from(r.envelope.ephemeralPublicKey).equals(b.subarray(1, 33))).toBe(true);
    expect(Buffer.from(r.envelope.nonce).equals(b.subarray(33, 45))).toBe(true);
    expect(r.envelope.sealed.length).toBe(Buffer.byteLength(opening) + E2E_TAG_BYTES);
  });

  it('refuses the opening in plaintext and in every encoding: hex (bare, upper case, 0x), base64, base64url', () => {
    const raw = Buffer.from(opening);
    expect(code(opening)).toBe('not-base64');
    expect(code(raw.toString('hex'))).toBe('unknown-version');
    expect(code(raw.toString('hex').toUpperCase())).toBe('unknown-version');
    expect(code('0x' + raw.toString('hex'))).toBe('not-base64');
    expect(code(raw.toString('base64'))).toBe('unknown-version');
    expect(code(raw.toString('base64url'))).not.toBe('ok');
  });

  it('refuses a framed but unencrypted opening, placeholder keys and nonces, wrong sizes and non-canonical base64', () => {
    const raw = Buffer.from(opening);
    expect(code(frame(Buffer.concat([raw, randomBytes(16)])).toString('base64'))).toBe('plaintext');
    expect(code(Buffer.concat([Buffer.from([1]), raw]).toString('base64'))).toBe('plaintext');
    expect(code(frame(randomBytes(400), { key: Buffer.alloc(32) }).toString('base64'))).toBe('not-a-key');
    expect(code(frame(randomBytes(400), { nonce: Buffer.alloc(12, 7) }).toString('base64'))).toBe('not-a-nonce');
    expect(code(frame(randomBytes(400), { version: 2 }).toString('base64'))).toBe('unknown-version');
    expect(code(sealedLike(E2E_TIER3_OPENING.minPayloadBytes - 1).toString('base64'))).toBe('too-short');
    expect(code(sealedLike(E2E_TIER3_OPENING.minPayloadBytes).toString('base64'))).toBe('ok');
    expect(code(sealedLike(E2E_TIER3_OPENING.maxPayloadBytes + 1).toString('base64'))).toBe('too-long');
    const ok = sealedLike(300).toString('base64');
    for (const v of [` ${ok}`, `${ok}\n`, ok.replace(/=+$/, ''), ok.replace(/\+/g, '-').replace(/\//g, '_') + (ok.includes('+') || ok.includes('/') ? '' : '-')]) expect(code(v)).toBe('not-base64');
    expect(code('')).toBe('not-base64');
  });

  it('reads text (a ten-digit run, or nine bytes in ten printable from 32 bytes on) but not random bytes', () => {
    expect(readsAsText(Buffer.from('x 8484848484 y'))).toBe(true);
    expect(readsAsText(Buffer.from('1040 Schedule C gross receipts, see attached'))).toBe(true);
    expect(readsAsText(Buffer.from('short text'))).toBe(false);
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (readsAsText(randomBytes(32 + (i % 512)))) hits++;
    expect(hits).toBe(0);
  });
});
