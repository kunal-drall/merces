import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BN254_FR, CURRENCY_CODES, DEFAULT_PARAMETERS } from '@merces/math';
import { randomBytes } from 'node:crypto';
import {
  CURVE_BUYER_NOTICE, CURVE_NO_CAP, CURVE_TERMS_ZEROS, CURVE_UNAPPROVED_EARN_NOTHING, curveBeforeYouBuy, curveBuyerNotice, curveNoticeFigures, CURVE_ZERO_TERMS, DEFAULTS, NON_REVEAL_CHARGE_BOUNDS, NON_REVEAL_CHARGE_SETTING, checkNonRevealCharge, nonRevealChargeSetting, rateUnits, seriesTermsViolations, seriesTermsSchema, type BoundedTerms, E2E_HEADER_BYTES, E2E_TAG_BYTES, E2E_TIER3_OPENING, INDEXING_RULE_CODE, REPORT_PUBLIC_INPUT_NAMES, ZERO_INCOME_COMMITMENT,
  adminCommandKinds, adminCommandSchema, amountBearingEvents, permissionlessCommandSchema,
  ChainError, bidCommitment, orderCommitment, randomSalt, canonicalJson, domainJsonSchema, eventTypes, expectedPrior, fieldToHex32, hex32ToField, incomeCommitment, isEvmAddress, isSolanaAddress,
  makeSeriesId, mockProve, mockVerify, parseDomainEvent, parseE2eEnvelope, readsAsText, parseSeriesId, randomFieldSalt, reportPublicInputs, reportProofSchema, routerIncomeCommitment, permissionlessCommandKinds, serviceCommandKinds, serviceCommandSchema, termsCommitment, userCommandKinds, userCommandSchema,
  type IndexingRule,
} from '../src/index.ts';
import * as domainModule from '../src/index.ts';

/*
 * S4 cause codes:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    no series, window or side; the salt is 32 bytes; the wallet is the bidder's chain-local address;
 *  - S4-REG: Stage 1's key registry (S4 WP5): register, forward-only revoke and rotate, with their events; schema 0.4.0;
 *  - S4-T3 / S4-FX: a tier-3 report carries an attestor key's REPORT signature in `attestation`, the FX fallback an
 *    attestor key's per-series FX signature in `fxFallback` (S4 WP9); the EIP-191 texts and the co-signer fields are gone.
 *  - S4-PAU: `approvePause` joins the permissionless group as Stage 1's `approve_pause(pauseEnd, attestor, signature)`
 *    (S4 WP10; was a user command `{until}` sent by the attestor); `PauseRequested` carries the nonce, `PauseApproved` the
 *    start;
 *  - S4-WD: `withdrawPauseRequest` (Stage 1 `withdraw_pause_request`) is a user command; `PauseRequestWithdrawn{nonce}`.
 *  - S4-AMD: `amendTerms` is Stage 1's `amend_terms(termsCommitment, capMultipleWad, attestor, signature)`, still the
 *    issuer's user command (S4 WP11; was `{attestor}` with the attestor co-signing); `TermsAmended` carries the signed
 *    nonce and a 20-byte attestor key.
 *
 * S2 cause codes:
 *  - S2-AD: commit and reveal durations are series terms (Stage 1's defaults 7 and 2 days);
 *  - S2-NRC: the non-reveal charge hold (new series record 0 bps; 0 bps applies whatever a series records);
 *  - S2-MS: multi-step settlement (Stage 1's settlement events);
 *  - S2-RH: registerHolder (`HolderRegistered`);
 *  - S2-E: Stage 1's auction error names (`detail.stage1`);
 *  - S2-PR: push delivery (`deliverBid`): the one-step settlement and the pull refund are retired.
 *
 * S3 cause codes:
 *  - S3-TL: `claimTail` and `TailClaimed` (Stage 1 `claim_tail`);
 *  - S3-FN: `claimFinal` and `FinalClaimed{units: weight}` (Stage 1 `claim_final`);
 *  - S3-BR: `burnRetired{holder}` (Stage 1 `burn_retired`), permissionless;
 *  - S3-BU: `PayoutClaimed.burnedUnits`.
 *  - S3-CT: curve terms are Stage 1's (registry create_series, lib.rs:462-572): lockup, wallet cap and raise durations 0
 *    (CurveTermsNotZero), a positive threshold (CurveThresholdZero), USDC (CurveQuoteMintMismatch), in the registry's
 *    order; the sealed-only rules (minimum raise reachable, a wallet cap of one unit) do not apply;
 *  - S3-NC: "no cap": one statement (`CURVE_NO_CAP`) for every curve read and notice; the buyer notice
 *    (`CURVE_BUYER_NOTICE`, amendments H2 and M1) states every required fact; since S3 WP12 (owner direction of
 *    2026-10-10) it renders the trading fee and its split from the curve config (was: "most of it goes to Merces, the
 *    rest to Meteora"), and the statements before a buy (`curveBeforeYouBuy`) open with "Unapproved wallets earn
 *    nothing and cannot tender."
 *  - S3-CV: Stage 1's curve lifecycle vocabulary: `curveSwap` (a Meteora DBC swap), the permissionless `completeCurve`
 *    and `collectCurveProceeds`, `CurveActivated`, `CurveGraduated` (Stage 1 RaiseSettled), `CurveProceedsCollected`,
 *    the `curveTrading` fee kind; the toy curve's buy and graduation commands and its mint and creation events are gone.
 *  - S3-CN: the curve census: the permissionless `syncCurveUnits` and `CurveUnitsSynced` (Stage 1 `sync_curve_units`).
 *  - S3-ST: curve staking and tender: the holder's `stakeUnits`, `unstakeUnits` and `tenderUnits{fromStake, fromWallet}`,
 *    `UnitsStaked` and `UnitsUnstaked` (units only), `RedemptionClaimed.fromStake` (a curve tender's; ours).
 *
 * S3 follow-up cause code:
 *  - NRC: the non-reveal charge is modelled as Stage 1's code does (was: the S2 owner hold, S2-NRC): a per-series term
 *    bounded 0–1,000 bps on every series (Stage 1 bounds the rate it records on a curve too), no built-in rate (the
 *    owner's setting `MERCES_NON_REVEAL_CHARGE_BPS`), `NonRevealCharged{seriesId, bidder, charge}` and the `nonReveal`
 *    fee kind.
 */
/** Stage 1's generated config as the stand-in pool reads it: 1% fee, 20% Meteora, 0% creator, X = 1,000 USDC, 99% migration fee. */
const STAND_IN_FIGURES = { tradingFeeBps: 100, tradingFeeSplitBps: { protocol: 2_000, partner: 8_000, creator: 0 }, target: 1_000_000_000n, migrationFeePercentage: 99 };

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
  bidCommitments: { price: string; quantity: string; salt: string; wallet: string; walletNote: string; preimage: string; commitment: string }[];
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
  it('bid and order commitments are Stage 1\'s keccak over price, quantity, salt and wallet (cause S4-BID)', () => {
    // cause S4-BID: KA's two cases (an EVM wallet left-padded, a Solana pubkey) from the bidder's chain-local address
    expect(known.bidCommitments).toHaveLength(2);
    for (const b of known.bidCommitments) {
      const sol = /base58 ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(b.walletNote);
      const address = sol ? sol[1]! : '0x' + b.wallet.slice(26);
      if (!sol) expect(b.wallet.slice(2, 26)).toBe('0'.repeat(24));
      expect(bidCommitment({ bidder: address, pricePerUnit: BigInt(b.price), quantity: b.quantity, salt: b.salt })).toBe(b.commitment);
      expect(orderCommitment({ wallet: address, pricePerUnit: b.price, quantity: BigInt(b.quantity), salt: b.salt })).toBe(b.commitment);
      // the salt's case does not change its bytes
      expect(bidCommitment({ bidder: address, pricePerUnit: b.price, quantity: b.quantity, salt: b.salt.toUpperCase().replace('0X', '0x') })).toBe(b.commitment);
    }
    const evm = '0x' + 'a1'.repeat(20);
    const salt = '0x' + '5a'.repeat(32);
    const base = bidCommitment({ bidder: evm, pricePerUnit: 10n, quantity: 5n, salt });
    // an EVM address in any case is one wallet (EIP-55 or lowercase)
    expect(bidCommitment({ bidder: '0x' + 'A1'.repeat(20), pricePerUnit: 10n, quantity: 5n, salt })).toBe(base);
    // every input is bound: price, quantity, salt and wallet
    expect(new Set([
      base,
      bidCommitment({ bidder: evm, pricePerUnit: 11n, quantity: 5n, salt }),
      bidCommitment({ bidder: evm, pricePerUnit: 10n, quantity: 6n, salt }),
      bidCommitment({ bidder: evm, pricePerUnit: 10n, quantity: 5n, salt: '0x' + '5b'.repeat(32) }),
      bidCommitment({ bidder: '0x' + 'a2'.repeat(20), pricePerUnit: 10n, quantity: 5n, salt }),
    ]).size).toBe(5);
    // nothing else is: no series, raise, window or side, so an order of the same plaintext commits identically and
    // every bid needs a fresh salt (randomSalt: 32 bytes, never repeated)
    expect(orderCommitment({ wallet: evm, pricePerUnit: 10n, quantity: 5n, salt })).toBe(base);
    const salts = new Set(Array.from({ length: 16 }, () => randomSalt()));
    expect(salts.size).toBe(16);
    for (const r of salts) expect(r).toMatch(/^0x[0-9a-f]{64}$/);

    const refusal = (f: () => unknown): ChainError => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ChainError);
        return e as ChainError;
      }
      throw new Error('expected a refusal');
    };
    // cause S2-E (kept): the price and the quantity are u64s, as Stage 1's commit_bid decodes them (AmountOutOfRange,
    // value-free); 2^64 − 1 is a u64
    const U64_MAX = 2n ** 64n - 1n;
    expect(bidCommitment({ bidder: evm, pricePerUnit: U64_MAX, quantity: U64_MAX.toString(), salt })).toMatch(/^0x[0-9a-f]{64}$/);
    for (const [pricePerUnit, quantity] of [[U64_MAX + 1n, 5n], [10n, (U64_MAX + 1n).toString()], [-1n, 5n]] as const) {
      for (const err of [refusal(() => bidCommitment({ bidder: evm, pricePerUnit, quantity, salt })), refusal(() => orderCommitment({ wallet: evm, pricePerUnit, quantity, salt }))]) {
        expect(err).toMatchObject({ code: 'InvalidTerms', detail: { stage1: 'AmountOutOfRange' } });
        expect(err.message).not.toMatch(/\d{5,}/);
      }
    }
    // cause S4-BID: the salt is exactly 32 bytes of 0x-hex, the wallet a Solana or an EVM address; refused value-free
    for (const bad of ['x', '0x' + 'ab'.repeat(31), '0x' + 'ab'.repeat(33), 'ab'.repeat(32), '0x' + 'zz'.repeat(32)]) {
      const err = refusal(() => bidCommitment({ bidder: evm, pricePerUnit: 10n, quantity: 5n, salt: bad }));
      expect(err).toMatchObject({ code: 'InvalidTerms' });
      expect(err.message).not.toContain('abab');
      expect(err.detail).toBeUndefined();
    }
    for (const bad of ['b', '0x' + 'a1'.repeat(19), '0x' + 'a1'.repeat(32), '1'.repeat(60)]) {
      expect(refusal(() => bidCommitment({ bidder: bad, pricePerUnit: 10n, quantity: 5n, salt }))).toMatchObject({ code: 'InvalidTerms' });
      expect(refusal(() => orderCommitment({ wallet: bad, pricePerUnit: 10n, quantity: 5n, salt })).message).not.toContain(bad);
    }
  });
  it('tier 3 and the FX fallback are Stage 1 signatures inside submitReport; no attestation text, no co-signer (cause S4-T3, S4-FX)', () => {
    expect('attestationMessage' in domainModule).toBe(false);
    expect('fxAttestationMessage' in domainModule).toBe(false);
    expect('attestorRateSchema' in domainModule).toBe(false);
    const sig = { signer: '0x' + 'ab'.repeat(20), signature: '0x' + '11'.repeat(65) };
    const report = {
      kind: 'submitReport', seriesId: 'sol:abc', periodId: '2026Q1', tier: 3, paymentStable: '1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: '0x' + '01'.repeat(32),
      fxBasis: 'attestor', fxAvgWad: '1080000000000000000', pair: 'EUR/USD', fxFallback: sig, proof: { system: 'mock', proof: '0x', publicInputs: ['1', '2', '3', '4', '5', '6'] }, attestation: sig, liquidityEvent: false,
    };
    const parsed = userCommandSchema.parse(report) as Record<string, unknown>;
    expect(parsed.attestation).toEqual(sig);
    expect(parsed.fxFallback).toEqual(sig);
    expect(parsed).not.toHaveProperty('attestor');
    expect(parsed).not.toHaveProperty('attestorRate');
    // the signature is a 65-byte shape and the signer a 20-byte key; anything else is refused by the schema
    expect(() => userCommandSchema.parse({ ...report, fxFallback: { signer: sig.signer, signature: 'sim:x' } })).toThrow();
    expect(() => userCommandSchema.parse({ ...report, attestation: { ...sig, rateWad: '1' } })).toThrow();
    expect(() => userCommandSchema.parse({ ...report, fxFallback: undefined })).toThrow();
  });
  it('a pause approval is Stage 1\'s permissionless approve_pause with a signature; the withdrawal is the issuer\'s; the events carry the nonces (cause S4-PAU, S4-WD)', () => {
    const sid = 'solana:abc';
    const approval = { kind: 'approvePause', seriesId: sid, pauseEnd: '1790000000', attestor: '0x' + 'ab'.repeat(20), signature: '0x' + '11'.repeat(65) };
    expect(permissionlessCommandSchema.parse(approval)).toEqual(approval);
    expect(serviceCommandSchema.parse(approval)).toEqual(approval);
    expect(() => userCommandSchema.parse(approval)).toThrow();
    // the end is a decimal string, so 2^64 parses (the chain refuses it AmountOutOfRange, before the signature)
    expect(permissionlessCommandSchema.parse({ ...approval, pauseEnd: (1n << 64n).toString() })).toMatchObject({ pauseEnd: '18446744073709551616' });
    for (const bad of [{ ...approval, pauseEnd: 1_790_000_000 }, { ...approval, pauseEnd: '-1' }, { ...approval, pauseEnd: '01' }, { ...approval, signature: 'sim:x' }, { ...approval, attestor: 'w' }, { kind: 'approvePause', seriesId: sid, until: 1 }]) {
      expect(() => permissionlessCommandSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
    expect(userCommandSchema.parse({ kind: 'withdrawPauseRequest', seriesId: sid })).toEqual({ kind: 'withdrawPauseRequest', seriesId: sid });
    expect(() => permissionlessCommandSchema.parse({ kind: 'withdrawPauseRequest', seriesId: sid })).toThrow();
    const env = { chain: 'solana', cursor: '1', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    expect(parseDomainEvent({ ...env, type: 'PauseRequested', payload: { seriesId: sid, until: 5, nonce: '3' } }).payload).toEqual({ seriesId: sid, until: 5, nonce: '3' });
    expect(() => parseDomainEvent({ ...env, type: 'PauseRequested', payload: { seriesId: sid, until: 5 } })).toThrow();
    expect(parseDomainEvent({ ...env, type: 'PauseApproved', payload: { seriesId: sid, attestor: approval.attestor, start: 1, until: 5 } }).payload).toMatchObject({ start: 1 });
    expect(() => parseDomainEvent({ ...env, type: 'PauseApproved', payload: { seriesId: sid, attestor: 'w', start: 1, until: 5 } })).toThrow();
    expect(parseDomainEvent({ ...env, type: 'PauseRequestWithdrawn', payload: { seriesId: sid, nonce: '4' } }).payload).toEqual({ seriesId: sid, nonce: '4' });
    for (const t of ['PauseRequested', 'PauseApproved', 'PauseRequestWithdrawn'] as const) expect(amountBearingEvents.has(t as never)).toBe(false);
  });
  it('an amendment is the issuer\'s Stage 1 amend_terms with an attestor key\'s signature; TermsAmended carries the signed nonce (cause S4-AMD)', () => {
    const sid = 'solana:abc';
    const amend = { kind: 'amendTerms', seriesId: sid, termsCommitment: '0x' + '22'.repeat(32), capMultipleWad: '2400000000000000000', attestor: '0x' + 'ab'.repeat(20), signature: '0x' + '11'.repeat(65) };
    expect(userCommandSchema.parse(amend)).toEqual(amend);
    expect(() => permissionlessCommandSchema.parse(amend)).toThrow();
    // the cap is a decimal string, so one above u64 parses (the chain refuses it AmountOutOfRange, before the signature)
    expect(userCommandSchema.parse({ ...amend, capMultipleWad: (1n << 64n).toString() })).toMatchObject({ capMultipleWad: '18446744073709551616' });
    const { signature: _s, ...unsigned } = amend;
    for (const bad of [unsigned, { ...amend, signature: 'sim:x' }, { ...amend, signature: '0x' + '11'.repeat(64) }, { ...amend, attestor: 'w' }, { ...amend, attestor: '0x' + 'AB'.repeat(20) }, { ...amend, capMultipleWad: 2 }]) {
      expect(() => userCommandSchema.parse(bad), JSON.stringify(bad)).toThrow();
    }
    const env = { chain: 'solana', cursor: '1', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    const payload = { seriesId: sid, termsCommitment: amend.termsCommitment, previousCommitment: '0x' + '33'.repeat(32), capMultipleWad: amend.capMultipleWad, attestor: amend.attestor, nonce: '0' };
    expect(parseDomainEvent({ ...env, type: 'TermsAmended', payload }).payload).toEqual(payload);
    const { nonce: _n, ...noNonce } = payload;
    expect(() => parseDomainEvent({ ...env, type: 'TermsAmended', payload: noNonce })).toThrow();
    expect(() => parseDomainEvent({ ...env, type: 'TermsAmended', payload: { ...payload, attestor: 'w' } })).toThrow();
    expect(amountBearingEvents.has('TermsAmended' as never)).toBe(false);
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
    const required = ['IssuerRegistered', 'SeriesCreated', 'RaiseOpened', 'RaiseCancelled', 'BidCommitted', 'BidRevealed', 'AuctionSettled', 'AuctionFailed', 'TreasuryFunded', 'FundsReleased', 'ReleasesPaused', 'ReleasesResumed', 'SplitReceipt', 'ReportAccepted', 'PaymentReceived', 'PaymentRefunded', 'FeeTaken', 'PayoutClaimed', 'SeriesRetired', 'UnitsBurned', 'RedemptionOpened', 'RedemptionClaimed', 'TailPayout', 'PauseRequested', 'PauseApproved', 'PauseEnded', 'StatusChanged', 'FormalNoticeDue', 'TermsAmended', 'SeriesExtinguished', 'RateSnapshot', 'FxFallbackFlagged', 'TransferWindowOpened', 'TransferWindowCleared', 'UnitsTransferred', 'AllowlistUpdated', 'AttestorRegistered', 'AttestorRevoked', 'CurveGraduated'];
    for (const r of required) expect(eventTypes).toContain(r);
    // cause S3-CV: a curve's buys are Meteora's (no Merces mint event) and its creation is Stage 1's activation
    // (CurveActivated; was the toy curve's creation event); its proceeds arrive with CurveProceedsCollected
    expect(eventTypes.filter((t) => /Minted$|^CurveSeries/.test(t))).toEqual([]);
    for (const r of ['CurveActivated', 'CurveProceedsCollected']) expect(eventTypes).toContain(r);
    // cause S2-MS / S2-RH: Stage 1's settlement events and holder registration, with Stage 1's names
    for (const r of ['SettlementProposed', 'SettlementRejected', 'UnitsAllocated', 'BidDelivered', 'RaiseMintFinalized', 'HolderRegistered']) expect(eventTypes).toContain(r);
    // cause S2-PR: a bid's refund reaches the bidder with BidDelivered (the pull refund's event is retired); the one
    // refund event left is a payment's
    expect(eventTypes.filter((t) => /Refund/.test(t))).toEqual(['PaymentRefunded']);
  });
  it("has Stage 1's key registry: registerAttestor, revokeAttestor, rotateAttestor, AttestorRegistered and AttestorRevoked (cause S4-REG)", () => {
    const env = { chain: 'solana', cursor: '000000000001', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    const a = '0x' + '11'.repeat(20);
    const b = '0x' + '22'.repeat(20);
    expect(adminCommandKinds.filter((k) => /Attestor/.test(k))).toEqual(['registerAttestor', 'revokeAttestor', 'rotateAttestor']);
    expect(adminCommandSchema.parse({ kind: 'registerAttestor', attestor: a })).toEqual({ kind: 'registerAttestor', attestor: a });
    expect(adminCommandSchema.parse({ kind: 'revokeAttestor', attestor: a })).toEqual({ kind: 'revokeAttestor', attestor: a });
    expect(adminCommandSchema.parse({ kind: 'rotateAttestor', from: a, to: b })).toEqual({ kind: 'rotateAttestor', from: a, to: b });
    // the boolean registration is gone: Stage 1 registers, and revokes forward-only
    expect((adminCommandSchema.parse({ kind: 'registerAttestor', attestor: a, active: false }) as Record<string, unknown>).active).toBeUndefined();
    expect(parseDomainEvent({ ...env, type: 'AttestorRegistered', payload: { attestor: a } }).payload).toEqual({ attestor: a });
    expect(parseDomainEvent({ ...env, type: 'AttestorRevoked', payload: { attestor: a, revokedAt: 1_790_000_000 } }).payload).toEqual({ attestor: a, revokedAt: 1_790_000_000 });
    expect(() => parseDomainEvent({ ...env, type: 'AttestorRevoked', payload: { attestor: a } })).toThrow();
    for (const t of ['AttestorRegistered', 'AttestorRevoked'] as const) expect(amountBearingEvents.has(t as never)).toBe(false);
  });
  it('has no one-step settlement or pull refund (cause S2-MS, S2-PR: Stage 1 settles in steps and delivers)', () => {
    // the raise's wallet commands are Stage 1's four; the rest of the raise is the permissionless group
    expect(userCommandKinds.filter((k) => /Raise|Bid|Refund/.test(k))).toEqual(['openRaise', 'cancelRaise', 'commitBid', 'revealBid']);
    // cause S3-BR, S3-CV: a curve's completion and proceeds are permissionless (Stage 1 complete_curve, collect_curve_proceeds);
    // cause S3-CN: and its census (Stage 1 sync_curve_units)
    // cause S4-PAU: and a signed pause approval (Stage 1 approve_pause)
    expect(permissionlessCommandKinds).toEqual(['beginSettlement', 'tallyBids', 'finalizeSettlement', 'processBid', 'deliverBid', 'registerHolder', 'burnRetired', 'completeCurve', 'collectCurveProceeds', 'syncCurveUnits', 'approvePause']);
    // cause S3-BR: burnRetired{holder} (permissionless, above) replaces the S1 list burn crank (`holders[]`), so no service
    // command burns any more; cause S3-CV: completion is permissionless `completeCurve` (was a service graduation command)
    expect(serviceCommandKinds).toEqual(['snapshotRate', 'crankStatus', 'crankPause', 'openTransferWindow', 'clearTransferWindow', 'flagFxFallback', 'setAllowlist']);
    // cause S3-CV: a curve trade is `curveSwap` (a Meteora DBC swap; was the toy curve's buy command), buy or sell
    expect(userCommandKinds.filter((k) => /[Cc]urve/.test(k))).toEqual(['curveSwap']);
    expect(userCommandSchema.parse({ kind: 'curveSwap', seriesId: 'solana:abc', side: 'sell', amountIn: '1', minimumAmountOut: '0' }).kind).toBe('curveSwap');
    // submit takes both groups, each command once (the union's head is the first service command)
    expect(serviceCommandSchema.parse({ kind: 'deliverBid', seriesId: 'solana:abc', bidder: 'b' }).kind).toBe('deliverBid');
    expect(serviceCommandSchema.parse({ kind: 'snapshotRate', pair: 'EUR/USD', rateWad: '1', confWad: '0', publishTime: 1, update: null }).kind).toBe('snapshotRate');
    expect(() => serviceCommandSchema.parse({ kind: 'claimPayout', seriesId: 'solana:abc' })).toThrow();
  });
  it('has Stage 1\'s claim family: claimTail, claimFinal, burnRetired, TailClaimed, FinalClaimed and PayoutClaimed.burnedUnits (S3)', () => {
    const env = { chain: 'solana', cursor: '000000000001', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    const sid = 'solana:abc';
    // cause S3-TL, S3-FN: the holder's own claims with Stage 1's names; S3-BR: the burn is permissionless, not a wallet command
    expect(userCommandKinds.filter((k) => /^claim/.test(k))).toEqual(['claimPayout', 'claimTail', 'claimFinal', 'claimRedemption']);
    for (const kind of ['claimTail', 'claimFinal'] as const) {
      expect(userCommandSchema.parse({ kind, seriesId: sid })).toEqual({ kind, seriesId: sid });
      expect(() => serviceCommandSchema.parse({ kind, seriesId: sid })).toThrow();
    }
    expect(permissionlessCommandSchema.parse({ kind: 'burnRetired', seriesId: sid, holder: 'h' })).toEqual({ kind: 'burnRetired', seriesId: sid, holder: 'h' });
    expect(serviceCommandSchema.parse({ kind: 'burnRetired', seriesId: sid, holder: 'h' }).kind).toBe('burnRetired');
    expect(() => permissionlessCommandSchema.parse({ kind: 'burnRetired', seriesId: sid })).toThrow(); // one holder per call, Stage 1's argument
    expect(() => userCommandSchema.parse({ kind: 'burnRetired', seriesId: sid, holder: 'h' })).toThrow();
    // the events: Stage 1's fields (SIM, EVM IPayoutClaims); every claim amount is amount-bearing (R28)
    const payloads = {
      PayoutClaimed: { seriesId: sid, holder: 'h', amount: '5', burnedUnits: '100' }, // cause S3-BU
      TailClaimed: { seriesId: sid, holder: 'h', amount: '0' }, // cause S3-TL: a zero tail is an event
      FinalClaimed: { seriesId: sid, holder: 'h', units: '100', amount: '0' }, // cause S3-FN: units = the weight
    };
    for (const [type, payload] of Object.entries(payloads)) {
      expect(parseDomainEvent({ ...env, type, payload }).payload).toEqual(payload);
      expect(amountBearingEvents.has(type as never)).toBe(true);
    }
    expect(() => parseDomainEvent({ ...env, type: 'PayoutClaimed', payload: { seriesId: sid, holder: 'h', amount: '5' } })).toThrow(); // S3-BU: required
    expect(() => parseDomainEvent({ ...env, type: 'FinalClaimed', payload: { seriesId: sid, holder: 'h', amount: '5' } })).toThrow();
    // the domain schema version that carries them (cause S4-REG: 0.4.0 since S4 WP5's key registry; was 0.3.0)
    expect(domainJsonSchema().version).toBe('0.4.0');
  });
  it('has Stage 1\'s curve staking: stakeUnits, unstakeUnits, tenderUnits, UnitsStaked, UnitsUnstaked, RedemptionClaimed.fromStake (cause S3-ST)', () => {
    const env = { chain: 'solana', cursor: '000000000001', seq: 1, blockTime: 1, blockRef: '1', txId: 't', finality: 'finalized' as const };
    const sid = 'solana:abc';
    // the holder signs each (Stage 1 curve.rs: `owner: Signer`); none is permissionless
    expect(userCommandKinds.filter((k) => /stake|tender/i.test(k))).toEqual(['stakeUnits', 'unstakeUnits', 'tenderUnits']);
    for (const cmd of [{ kind: 'stakeUnits', seriesId: sid, units: '10' }, { kind: 'unstakeUnits', seriesId: sid, units: '10' }, { kind: 'tenderUnits', seriesId: sid, fromStake: '10', fromWallet: '0' }]) {
      expect(userCommandSchema.parse(cmd)).toEqual(cmd);
      expect(() => serviceCommandSchema.parse(cmd)).toThrow();
    }
    expect(() => userCommandSchema.parse({ kind: 'tenderUnits', seriesId: sid, units: '10' })).toThrow(); // Stage 1's two arguments
    // Stage 1's events (events.rs:483-497): units only, never amount-bearing
    for (const type of ['UnitsStaked', 'UnitsUnstaked'] as const) {
      const payload = { seriesId: sid, holder: 'h', units: '10', staked: '0' };
      expect(parseDomainEvent({ ...env, type, payload }).payload).toEqual(payload);
      expect(amountBearingEvents.has(type)).toBe(false);
    }
    // a curve tender's redemption names its staked part; a sealed-bid redemption has none
    const tender = { seriesId: sid, holder: 'h', units: '10', amount: '5', fromStake: '4' };
    expect(parseDomainEvent({ ...env, type: 'RedemptionClaimed', payload: tender }).payload).toEqual(tender);
    const sealed = { seriesId: sid, holder: 'h', units: '10', amount: '5' };
    expect(parseDomainEvent({ ...env, type: 'RedemptionClaimed', payload: sealed }).payload).toEqual(sealed);
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
    // cause S2-AD: the raise's phases are terms, defaulting to Stage 1's 7-day commit and 2-day reveal
    expect([DEFAULTS.commitDurationSeconds, DEFAULTS.revealDurationSeconds]).toEqual([Number(DEFAULT_PARAMETERS.commitDuration), Number(DEFAULT_PARAMETERS.revealDuration)]);
    expect([DEFAULTS.commitDurationSeconds, DEFAULTS.revealDurationSeconds]).toEqual([604_800, 172_800]);
  });

  // cause NRC (was S2-NRC: the hold recorded 0 bps for every new series and applied 0 whatever a series recorded): there is
  // no built-in rate; the owner's setting is read, checked against Stage 1's bounds and refused when malformed
  it('the non-reveal charge has no built-in rate: the owner\'s setting, within Stage 1\'s bounds, or null while unset', () => {
    expect('nonRevealChargeBps' in DEFAULTS).toBe(false);
    expect(NON_REVEAL_CHARGE_SETTING).toBe('MERCES_NON_REVEAL_CHARGE_BPS');
    expect(NON_REVEAL_CHARGE_BOUNDS).toEqual({ min: 0, max: 1000 }); // Stage 1 PARAMETER_BOUNDS.nonRevealChargeBps
    for (const env of [{}, { MERCES_NON_REVEAL_CHARGE_BPS: '' }, { MERCES_NON_REVEAL_CHARGE_BPS: '  ' }]) expect(nonRevealChargeSetting(env)).toBeNull();
    expect([nonRevealChargeSetting({ MERCES_NON_REVEAL_CHARGE_BPS: '0' }), nonRevealChargeSetting({ MERCES_NON_REVEAL_CHARGE_BPS: ' 100 ' }), nonRevealChargeSetting({ MERCES_NON_REVEAL_CHARGE_BPS: '1000' })]).toEqual([0, 100, 1000]);
    // out of bounds or not a whole number of bps: refused at startup, naming the setting and the bounds, never the value
    for (const bad of ['1001', '-1', '1.5', '1e2', 'abc', '99999']) {
      expect(() => nonRevealChargeSetting({ MERCES_NON_REVEAL_CHARGE_BPS: bad }), bad).toThrow('MERCES_NON_REVEAL_CHARGE_BPS must be a whole number of bps between 0 and 1000');
      try {
        nonRevealChargeSetting({ MERCES_NON_REVEAL_CHARGE_BPS: bad });
      } catch (e) {
        expect((e as Error).message, bad).not.toContain(bad);
      }
    }
    expect(checkNonRevealCharge(250)).toBe(250);
    for (const bad of [-1, 1001, 0.5, Number.NaN]) expect(() => checkNonRevealCharge(bad)).toThrow(/between 0 and 1000/);
    expect(DEFAULT_PARAMETERS.nonRevealChargeBps).toBe(100); // Stage 1's protocol default (its chains' set_defaults); not ours
  });
});

describe('Stage 1 create_series rules on the terms (S2: the raise\'s own terms)', () => {
  const sealed: BoundedTerms = {
    capMultipleWad: (25n * 10n ** 17n).toString(), hurdleWad: (8n * 10n ** 16n).toString(), payoutMultipleK: 5, lockupSeconds: DEFAULTS.lockupSeconds, walletCapBps: 1000, auctionFeeBps: 100, payoutFeeBps: 500,
    nonRevealChargeBps: 100, commitDurationSeconds: DEFAULTS.commitDurationSeconds, revealDurationSeconds: DEFAULTS.revealDurationSeconds,
    dueDays: 30, graceDays: 15, formalNoticeDays: 90, unitsOffered: '500', reservePrice: '8000000', minimumRaise: '4000000000', releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], raiseStyle: 'sealed',
    stablecoin: 'USDC',
  };
  // Stage 1's curve series (curve_mode.rs curve_series_args: 100 units, X = 1,000 USDC): the zeros, any start price
  const curve: BoundedTerms = { ...sealed, ...CURVE_TERMS_ZEROS, raiseStyle: 'curve', unitsOffered: '100', reservePrice: '1', minimumRaise: '1000000000' };
  const fields = (t: BoundedTerms) => seriesTermsViolations(t).map((v) => [v.field, v.stage1]);
  it('bounds the commit and reveal phases and the non-reveal charge of a sealed raise, in Stage 1 order', () => {
    expect(seriesTermsViolations(sealed)).toEqual([]);
    expect(fields({ ...sealed, revealDurationSeconds: 7 * 86_400 + 1, commitDurationSeconds: 3599, nonRevealChargeBps: 1001, payoutFeeBps: 2001 })).toEqual([
      ['payoutFeeBps', 'ParameterOutOfBounds'], ['nonRevealChargeBps', 'ParameterOutOfBounds'], ['commitDurationSeconds', 'ParameterOutOfBounds'], ['revealDurationSeconds', 'ParameterOutOfBounds'],
    ]);
    // cause NRC: a draft checked before the owner set the rate carries none, and that one bound is not checked (the terms
    // service builds no sealed series until the rate is set)
    const { nonRevealChargeBps: _unset, ...draft } = sealed;
    expect(seriesTermsViolations(draft)).toEqual([]);
    expect(fields({ ...draft, payoutFeeBps: 2001 })).toEqual([['payoutFeeBps', 'ParameterOutOfBounds']]);
  });
  // cause S3-CT (was: the raise's terms unchecked on a curve series, the lockup and wallet cap bounded as on a sealed one)
  it('a curve series takes Stage 1\'s zeros for the lockup, the wallet cap and the raise durations (CurveTermsNotZero), one per field', () => {
    expect(seriesTermsViolations(curve)).toEqual([]);
    expect(CURVE_ZERO_TERMS).toEqual(['lockupSeconds', 'walletCapBps', 'commitDurationSeconds', 'revealDurationSeconds']);
    // the sealed defaults on a curve series: each zero term is refused, by field and value-free
    const v = seriesTermsViolations({ ...sealed, raiseStyle: 'curve' });
    expect(v.map((x) => [x.field, x.stage1, x.code])).toEqual(CURVE_ZERO_TERMS.map((f) => [f, 'CurveTermsNotZero', 'curve-zero']));
    expect(v.map((x) => x.message)).toEqual(['lockup must be 0 on a curve series', 'wallet cap must be 0 on a curve series', 'commit duration must be 0 on a curve series', 'reveal duration must be 0 on a curve series']);
    // Stage 1's own refusals (curve_mode.rs:631-644): lockup 1, wallet cap 1,000 bps
    expect(fields({ ...curve, lockupSeconds: 1 })).toEqual([['lockupSeconds', 'CurveTermsNotZero']]);
    expect(fields({ ...curve, walletCapBps: 1000 })).toEqual([['walletCapBps', 'CurveTermsNotZero']]);
    // their bounds are not checked (Stage 1 bounds its defaults there, lib.rs:517-540)
    // cause NRC (was: the held non-reveal charge unchecked on a curve): the rate a curve records is bounded too (Stage 1
    // records its protocol default there and bounds it, lib.rs:550 and :562), though a curve has no bids to charge
    expect(fields({ ...curve, nonRevealChargeBps: 5000 })).toEqual([['nonRevealChargeBps', 'ParameterOutOfBounds']]);
    expect(fields({ ...curve, nonRevealChargeBps: 1000 })).toEqual([]);
    // the other bounds still hold
    expect(fields({ ...curve, auctionFeeBps: 1001 })).toEqual([['auctionFeeBps', 'ParameterOutOfBounds']]);
  });

  it('a curve series needs a threshold and USDC; the sealed-only rules do not apply; the registry\'s order', () => {
    // a zero threshold (curve_mode.rs:645-650) and a USDG quote (:625-630)
    expect(fields({ ...curve, minimumRaise: '0' })).toEqual([['minimumRaise', 'CurveThresholdZero']]);
    expect(fields({ ...curve, stablecoin: 'USDG' })).toEqual([['stablecoin', 'CurveQuoteMintMismatch']]);
    // the minimum raise is the curve's target X: no "≤ reserve × units" (the start price is informational), and no
    // wallet cap of one unit (lib.rs:564-570)
    expect(fields({ ...curve, minimumRaise: '1000000000000', reservePrice: '1', unitsOffered: '1' })).toEqual([]);
    // the registry's order (lib.rs:462-572): units, reserve, threshold, zeros, quote, schedule, bounds
    expect(fields({ ...sealed, raiseStyle: 'curve', unitsOffered: '0', reservePrice: '0', minimumRaise: '0', stablecoin: 'USDG', releaseSchedule: [{ afterSeconds: 0, bps: 5000 }], capMultipleWad: '1', lockupSeconds: 0, walletCapBps: 0, commitDurationSeconds: 1 })).toEqual([
      ['unitsOffered', 'InvalidTerms'], ['reservePrice', 'InvalidTerms'], ['minimumRaise', 'CurveThresholdZero'], ['commitDurationSeconds', 'CurveTermsNotZero'], ['revealDurationSeconds', 'CurveTermsNotZero'],
      ['stablecoin', 'CurveQuoteMintMismatch'], ['releaseSchedule', 'InvalidReleaseSchedule'], ['capMultipleWad', 'ParameterOutOfBounds'],
    ]);
    // a sealed raise is unchanged: Stage 1's reference simulator's order, a reachable minimum raise, a one-unit cap
    expect(fields({ ...sealed, minimumRaise: String(500n * 8_000_000n + 1n) })).toEqual([['minimumRaise', 'InvalidTerms']]);
    expect(fields({ ...sealed, unitsOffered: '5', minimumRaise: '1' })).toEqual([['unitsOffered', 'InvalidTerms']]);
    expect(fields({ ...sealed, walletCapBps: 0 })).toEqual([['walletCapBps', 'ParameterOutOfBounds'], ['unitsOffered', 'InvalidTerms']]);
  });

  it('the canonical terms accept a wallet cap of 0 (a curve series records it); r is per base lamport on a curve', () => {
    const terms = { stablecoin: 'USDC', stablecoinMint: 'm', unitsOffered: '100', reservePrice: '1', minimumRaise: '1000000000', capMultipleWad: '2500000000000000000', lockupSeconds: 0, releaseSchedule: [{ afterSeconds: 0, bps: 10_000 }], auctionFeeBps: 100, payoutFeeBps: 500, hurdleWad: '0', payoutMultipleK: 5, walletCapBps: 0, nonRevealChargeBps: 0, commitDurationSeconds: 0, revealDurationSeconds: 0, dueDays: 30, graceDays: 15, formalNoticeDays: 90, contractHash: '0x' + 'ab'.repeat(32), termsCommitment: '0x' + 'cd'.repeat(32), tierFlags: { tier1: false, tier2: true, tier3: true, tier4: false }, reportingCurrency: 'USD', raiseStyle: 'curve' };
    expect(seriesTermsSchema.safeParse(terms).success).toBe(true);
    expect(seriesTermsSchema.safeParse({ ...terms, walletCapBps: -1 }).success).toBe(false);
    // B-C2 (registry lib.rs:594-600): units offered × 10^6 on a curve series, the units offered on a sealed one
    expect(rateUnits({ unitsOffered: '100', raiseStyle: 'curve' })).toBe(100_000_000n);
    expect(rateUnits({ unitsOffered: '100', raiseStyle: 'sealed' })).toBe(100n);
  });

  // cause S3-NC: one statement for "no cap", said plainly (owner direction)
  it('says "no cap" in one statement: no wallet cap at any stage, any number of units, before and after the curve fills', () => {
    expect(CURVE_NO_CAP).toMatch(/^No cap: /);
    for (const clause of ['no wallet cap at any stage', 'any number of units', 'before and after the curve fills']) expect(CURVE_NO_CAP).toContain(clause);
    expect(CURVE_NO_CAP).not.toMatch(/default/i);
  });

  // cause S3-NC (amendments H2 and M1, the owner's wording): every clause of the buyer notice, each Stage 1's fact
  it('the buyer notice states every required fact, says "stops paying" and never "default"', () => {
    const filled = curveBuyerNotice(STAND_IN_FIGURES);
    for (const text of [CURVE_BUYER_NOTICE, filled]) {
      const clauses: [string, RegExp][] = [
        // before graduation the money sits in Meteora's pool, not with Merces, and Merces cannot repay it
        ['in the pool', /until the curve fills \(its graduation\), the USDC you pay, less the fee, sits in Meteora's pool, not with Merces, and Merces cannot repay it/i],
        // the only exit before graduation is selling back into the curve
        ['the only exit', /before graduation the only way out is to sell your units back into the curve/i],
        ['no deadline', /there is no deadline/i],
        ['the issuer receives nothing', /if the curve never fills, the issuer receives nothing/i],
        // the trading fee and its split from the pool's config (owner direction of 2026-10-10), never returned
        ['the fee', /every trade pays a trading fee \((\{fee\}|1)%\): (\{mercesShare\}|80)% of it goes to Merces, (\{meteoraShare\}|20)% to Meteora and (\{issuerShare\}|0)% to the issuer\. It is never returned, even if the curve never fills/i],
        // no wallet cap: any wallet holds any amount, before and after graduation (the one statement)
        ['no cap', new RegExp(CURVE_NO_CAP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
        ['no cap, plainly', /No cap: a curve raise has no wallet cap at any stage\. Any wallet can hold any number of units, before and after the curve fills/],
        // to earn: approved and staked; unstaked units earn nothing; unstake at any time
        ['stake to earn', /to earn, your wallet must be approved \(allowlisted\) and registered for this series, and you must stake your units/i],
        ['unstaked earn nothing', /unstaked units earn nothing/i],
        ['unstake any time', /you can unstake at any time/i],
        // a wallet not approved and registered: no stake, no tender, nothing from the series, only selling
        ['not approved', /a wallet that is not approved and registered cannot stake, cannot tender at a redemption and receives nothing from the series: it can only sell/i],
        // the issuer stops paying: extinguishment shares the unvested treasury among staked (or tendered) units
        ['stops paying', /if the issuer stops paying, payouts stop/i],
        ['extinguished', /the series can be extinguished\. The unvested treasury is then shared among staked units, or among tendered units after a redemption/i],
      ];
      for (const [name, re] of clauses) expect(text, name).toMatch(re);
      expect(text).not.toMatch(/default/i);
    }
    // the template holds no percentage of its own: every figure is the curve config's (owner direction of 2026-10-10)
    expect(CURVE_BUYER_NOTICE).not.toMatch(/\d+(\.\d+)?%/);
    // the curve's own figures: its 1% fee split 80 / 20 / 0, its 1,000 USDC target, Meteora's 99% migration fee
    expect(filled).toContain('a trading fee (1%): 80% of it goes to Merces, 20% to Meteora and 0% to the issuer.');
    expect(filled).toContain('its full target (1,000 USDC)');
    expect(filled).toContain('the series treasury receives 99% of the target');
    expect(filled).not.toMatch(/\{(fee|mercesShare|meteoraShare|issuerShare|target|migrationFee)\}/);
  });

  // owner direction of 2026-10-10: the trading fee and its split come from the series' curve config; two configs render
  // two notices, and a split that does not add up is never stated
  it('renders the trading fee and its split from the curve config (two configs)', () => {
    const other = curveBuyerNotice({ tradingFeeBps: 125, tradingFeeSplitBps: { protocol: 2_000, partner: 5_000, creator: 3_000 }, target: '1234567890', migrationFeePercentage: 50 });
    expect(other).toContain('a trading fee (1.25%): 50% of it goes to Merces, 20% to Meteora and 30% to the issuer.');
    expect(other).toMatch(/1,234\.56789 USDC[\s\S]*receives 50% of the target/);
    expect(other).not.toBe(curveBuyerNotice(STAND_IN_FIGURES));
    expect(curveBuyerNotice({ ...STAND_IN_FIGURES, tradingFeeSplitBps: { protocol: 2_550, partner: 7_450, creator: 0 } })).toContain('74.5% of it goes to Merces, 25.5% to Meteora and 0% to the issuer');
    expect(() => curveBuyerNotice({ ...STAND_IN_FIGURES, tradingFeeSplitBps: { protocol: 2_000, partner: 7_000, creator: 0 } })).toThrow(RangeError);
    // the read's figures map straight in
    expect(curveNoticeFigures({ tradingFeeBps: 100, tradingFeeSplitBps: STAND_IN_FIGURES.tradingFeeSplitBps, migrationQuoteThreshold: '1000000000', migrationFeePercentage: 99 })).toEqual({ ...STAND_IN_FIGURES, target: '1000000000' });
  });

  // owner direction of 2026-10-10: before the buy action, not only in the notice
  it('before you buy: "Unapproved wallets earn nothing and cannot tender." first, then the notice; versioned by content', () => {
    const b = curveBeforeYouBuy(STAND_IN_FIGURES);
    expect(b.statements[0]).toBe('Unapproved wallets earn nothing and cannot tender.');
    expect(b.statements[0]).toBe(CURVE_UNAPPROVED_EARN_NOTHING);
    // every point of the notice follows, with the curve's figures, and nothing else
    const points = curveBuyerNotice(STAND_IN_FIGURES).split('\n').slice(1).map((l) => l.replace(/^- /, ''));
    expect(b.statements.slice(1)).toEqual(points);
    expect(b.version).toMatch(/^byb1-[0-9a-f]{16}$/);
    // the version follows the statements: same figures, same version; another config, another version
    expect(curveBeforeYouBuy({ ...STAND_IN_FIGURES }).version).toBe(b.version);
    expect(curveBeforeYouBuy({ ...STAND_IN_FIGURES, tradingFeeBps: 200 }).version).not.toBe(b.version);
    expect(b.statements.join(' ')).not.toMatch(/default/i);
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
