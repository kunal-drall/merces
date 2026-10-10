import { ChainError, seriesTermsViolations, wallet32Of, type Command } from '@merces/domain';
import { newFinalState, newTailState, newVaultState } from '@merces/math';
import { deriveAddress } from '../addresses.ts';
import { newAuction, type SimSeries, type SimTerms } from '../state.ts';
import { big, type EngineCore, type Emit } from './core.ts';
import { activateCurve, curveP0 } from './curve.ts';
import { fail } from './errors.ts';
import { newLedger } from './ledger.ts';

// ------------------------------------------------------------------ issuers and series
export function registerIssuer(e: EngineCore, signer: string, now: number, emit: Emit): void {
  e.requireAllowlisted(signer);
  if (e.state.issuers.has(signer)) throw new ChainError('Duplicate', 'issuer already registered');
  e.state.issuers.set(signer, { issuer: signer, registeredAt: now, issuanceStopped: false, seriesIds: [] });
  emit('IssuerRegistered', { issuer: signer });
}
export function stopIssuance(e: EngineCore, signer: string, emit: Emit): void {
  const i = e.state.issuers.get(signer);
  if (!i) throw new ChainError('NotFound', 'issuer not registered');
  i.issuanceStopped = true;
  emit('IssuanceStopped', { issuer: signer });
}

export function createSeries(e: EngineCore, signer: string, cmd: Extract<Command, { kind: 'createSeries' }>, now: number, emit: Emit): void {
  const issuer = e.state.issuers.get(signer);
  if (!issuer) throw new ChainError('Unauthorized', 'issuer not registered');
  if (issuer.issuanceStopped) throw new ChainError('NotPermitted', 'issuer stopped issuance');
  const t = cmd.terms;
  // curve mode is Solana only: the EVM registry refuses it right after the issuer check, before the stablecoin and the
  // terms (MercesRegistry.sol:479-481, CurveModeUnsupported)
  if (t.raiseStyle === 'curve' && e.state.config.family !== 'solana') fail('CurveModeUnsupported', 'curve-mode raises exist on Solana only');
  const coin = e.state.config.stablecoins[t.stablecoin];
  if (!coin) throw new ChainError('InvalidTerms', `${t.stablecoin} is not available on ${e.state.config.chain}`);
  if (coin.mint !== t.stablecoinMint) throw new ChainError('InvalidTerms', 'stablecoin mint does not match the chain catalogue');
  // Stage 1's create_series rules in its order. A sealed raise (SIM:756-781): the bounded parameters
  // (ParameterOutOfBounds), units, reserve and minimum raise and the wallet cap of at least one unit (InvalidTerms), the
  // release schedule (InvalidReleaseSchedule). A curve raise (the Solana registry, lib.rs:462-572): units and reserve
  // (InvalidTerms), the threshold (CurveThresholdZero), lockup, wallet cap and raise durations 0 (CurveTermsNotZero),
  // USDC (CurveQuoteMintMismatch), the schedule, then the bounds on the other terms. The messages carry the field and
  // the bound, never the submitted value
  const violation = seriesTermsViolations(t)[0];
  if (violation) fail(violation.stage1, violation.message);
  if (/^0x0{64}$/.test(t.contractHash)) throw new ChainError('InvalidTerms', 'contract hash required: a raise needs a signed contract');
  if (t.tierFlags.tier4) throw new ChainError('InvalidTerms', 'tier 4 is switched off');
  // A curve raise starts at creation here: its creation is the curve's activation (Stage 1 `activate_curve` and the
  // registry's `mark_curve_activated`), checked in their order before the series exists: P0 at least 1
  // (CurveThresholdMismatch, curve.rs:799-805), new raises not paused (NewRaisesPaused), the issuer still allowlisted
  // (NotAllowlisted; registry lib.rs:1001-1013). New raises paused: Stage 1 refuses a sealed raise's open_raise
  // (NewRaisesPaused, SIM:875), never create_series, so a sealed series is still created (openRaise refuses).
  const curve = t.raiseStyle === 'curve' ? curveP0({ terms: { minimumRaise: big(t.minimumRaise), unitsOffered: big(t.unitsOffered) } }) : null;
  if (curve) {
    if (e.state.newRaisesPaused) fail('NewRaisesPaused', 'new raises are paused by the protocol admin');
    if (!e.state.allowlist.has(signer)) fail('NotAllowlisted', 'the issuer is not allowlisted');
  }
  const capWad = big(t.capMultipleWad);
  // a hint (simulator and harness only) must be an address of the chain's family: the series key every signed message
  // binds is its 32 bytes (`SeriesState.seriesKey`, S4 D7)
  if (cmd.seriesAddressHint !== undefined) {
    try {
      wallet32Of(cmd.seriesAddressHint, e.state.config.family);
    } catch {
      throw new ChainError('InvalidTerms', `seriesAddressHint is not a ${e.state.config.family} address`);
    }
  }
  const address = cmd.seriesAddressHint ?? deriveAddress(e.state.config.family, `series:${signer}:${issuer.seriesIds.length}`);
  const seriesId = `${e.state.config.chain}:${address}`;
  if (e.state.series.has(seriesId)) throw new ChainError('Duplicate', 'series exists');
  const terms: SimTerms = {
    stablecoin: t.stablecoin,
    stablecoinMint: t.stablecoinMint,
    unitsOffered: big(t.unitsOffered),
    reservePrice: big(t.reservePrice),
    minimumRaise: big(t.minimumRaise),
    capMultipleWad: capWad,
    lockupSeconds: t.lockupSeconds,
    releaseSchedule: t.releaseSchedule.map((x) => ({ ...x })),
    auctionFeeBps: BigInt(t.auctionFeeBps),
    payoutFeeBps: BigInt(t.payoutFeeBps),
    hurdleWad: big(t.hurdleWad),
    payoutMultipleK: BigInt(t.payoutMultipleK),
    walletCapBps: BigInt(t.walletCapBps),
    nonRevealChargeBps: t.nonRevealChargeBps,
    commitDurationSeconds: t.commitDurationSeconds,
    revealDurationSeconds: t.revealDurationSeconds,
    dueDays: t.dueDays,
    graceDays: t.graceDays,
    formalNoticeDays: t.formalNoticeDays,
    contractHash: t.contractHash,
    termsCommitment: t.termsCommitment,
    tierFlags: { ...t.tierFlags },
    reportingCurrency: t.reportingCurrency,
    raiseStyle: t.raiseStyle,
  };
  // the unit scale is 1 for a sealed-bid series and 10^6 for a curve (set at its activation below); every money path
  // passes it to the scale-aware `@merces/math` functions, which run Stage 1's own at scale 1
  const s: SimSeries = {
    seriesId, address, issuer: signer, terms, unitScale: 1n, phase: 'Draft', status: 'OnTime', createdAt: now, openedAt: null, commitEndsAt: null, revealEndsAt: null, settledAt: null,
    issuePrice: null, unitsSold: 0n, unitsOutstanding: 0n, capPerUnit: null, vaultBalance: 0n, vaultDistributedNet: 0n,
    treasuryTotal: 0n, treasuryReleased: 0n, treasuryReturned: 0n, tranches: [], releasesPausedByIssuer: false, bids: new Map(), bidOrder: 0, auction: newAuction(), positions: new Map(), periods: new Map(),
    redemption: null, extinguishedAt: null, grossPaidTotal: 0n, feesTotal: 0n, transferWindows: [], curve: null, splitRouter: null, amendments: [],
    ledger: newLedger(), vault: newVaultState(), tail: newTailState(0n), final: newFinalState(),
    stakedTotal: 0n, tenderedTotal: 0n, unitsSyncedAt: null,
  };
  e.state.series.set(seriesId, s);
  issuer.seriesIds.push(seriesId);
  emit('SeriesCreated', { seriesId, issuer: signer, terms: t });
  if (curve) activateCurve(e, s, curve.p0, curve.swapBase, now, emit);
}

// ------------------------------------------------------------------ allowlist
export function setAllowlist(e: EngineCore, cmd: Extract<Command, { kind: 'setAllowlist' }>, emit: Emit): void {
  if (cmd.allowed) e.state.allowlist.add(cmd.wallet);
  else e.state.allowlist.delete(cmd.wallet);
  emit('AllowlistUpdated', { wallet: cmd.wallet, allowed: cmd.allowed });
}
