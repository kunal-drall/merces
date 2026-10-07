import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  attestationMessage, bidCommitment, canonicalJson, domainJsonSchema, eventTypes, incomeCommitment, isEvmAddress, isSolanaAddress,
  makeSeriesId, mockProve, mockVerify, parseDomainEvent, parseSeriesId, termsCommitment, userCommandSchema,
} from '../src/index.ts';

describe('ids', () => {
  it('round-trips series ids and detects address families', () => {
    expect(parseSeriesId(makeSeriesId('solana', 'abc'))).toEqual({ chain: 'solana', address: 'abc' });
    expect(isEvmAddress('0x' + 'ab'.repeat(20))).toBe(true);
    expect(isSolanaAddress('11111111111111111111111111111111')).toBe(true);
    expect(isSolanaAddress('0x' + 'ab'.repeat(20))).toBe(false);
  });
});

describe('hashing', () => {
  it('canonical JSON sorts keys and stringifies bigints', () => {
    expect(canonicalJson({ b: 1n, a: [2, { d: 'x', c: null }] })).toBe('{"a":[2,{"c":null,"d":"x"}],"b":"1"}');
  });
  it('commitments are deterministic and salt-sensitive', () => {
    const a = termsCommitment({ threshold: 60_000_000_000n, ratePerUnitWad: 1n, reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x01' });
    const b = termsCommitment({ threshold: '60000000000', ratePerUnitWad: '1', reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x01' });
    const c = termsCommitment({ threshold: 60_000_000_000n, ratePerUnitWad: 1n, reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x02' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(incomeCommitment({ seriesId: 's', periodId: '2026Q1', incomeYtd: 1n, salt: 'x' })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bidCommitment({ seriesId: 's', bidder: 'b', pricePerUnit: 10n, quantity: 5n, salt: 'x' })).toMatch(/^0x[0-9a-f]{64}$/);
    expect(attestationMessage({ seriesId: 's', periodId: '2026Q1', incomeCommitment: '0x00', tier: 2, source: 'stripe' }).length).toBeGreaterThan(10);
  });
  it('mock proofs verify against their public inputs only', () => {
    const pub = ['1', '2', '3'];
    const proof = mockProve(pub, { incomeYtd: '123', threshold: '100', ratePerUnitWad: '1', salt: 's' });
    expect(proof).not.toContain('123');
    expect(mockVerify(proof, pub)).toBe(true);
    expect(mockVerify(proof, ['1', '2', '4'])).toBe(false);
    expect(mockVerify('garbage', pub)).toBe(false);
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
