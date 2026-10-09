import { ChainError, DEFAULTS, type Command } from '@merces/domain';
import { WAD } from '@merces/math';
import { deriveAddress } from '../addresses.ts';
import type { SimSeries, SimTerms } from '../state.ts';
import { big, str, type EngineCore, type Emit } from './core.ts';

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
  if (e.state.newRaisesPaused) throw new ChainError('Paused', 'new raises are paused by the protocol admin');
  const t = cmd.terms;
  const coin = e.state.config.stablecoins[t.stablecoin];
  if (!coin) throw new ChainError('InvalidTerms', `${t.stablecoin} is not available on ${e.state.config.chain}`);
  if (coin.mint !== t.stablecoinMint) throw new ChainError('InvalidTerms', 'stablecoin mint does not match the chain catalogue');
  const capWad = big(t.capMultipleWad);
  if (capWad < DEFAULTS.capMultipleMinWad || capWad > DEFAULTS.capMultipleMaxWad) throw new ChainError('InvalidTerms', 'cap multiple out of bounds (2.0–3.0)');
  const bpsSum = t.releaseSchedule.reduce((a, x) => a + x.bps, 0);
  if (bpsSum !== 10_000) throw new ChainError('InvalidTerms', 'release schedule must sum to 10000 bps');
  if (big(t.unitsOffered) <= 0n) throw new ChainError('InvalidTerms', 'unitsOffered must be positive');
  if (/^0x0{64}$/.test(t.contractHash)) throw new ChainError('InvalidTerms', 'contract hash required: a raise needs a signed contract');
  if (t.raiseStyle === 'curve' && e.state.config.family !== 'solana') throw new ChainError('InvalidTerms', 'curve-mode raises exist on Solana only');
  if (t.tierFlags.tier4) throw new ChainError('InvalidTerms', 'tier 4 is switched off');
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
    dueDays: t.dueDays,
    graceDays: t.graceDays,
    formalNoticeDays: t.formalNoticeDays,
    contractHash: t.contractHash,
    termsCommitment: t.termsCommitment,
    tierFlags: { ...t.tierFlags },
    reportingCurrency: t.reportingCurrency,
    raiseStyle: t.raiseStyle,
  };
  const s: SimSeries = {
    seriesId, address, issuer: signer, terms, phase: 'Draft', status: 'OnTime', createdAt: now, openedAt: null, commitEndsAt: null, revealEndsAt: null, settledAt: null,
    issuePrice: null, unitsSold: 0n, unitsOutstanding: 0n, capPerUnit: null, paidPerUnitWad: 0n, accNetWad: 0n, vaultBalance: 0n, vaultGrossTotal: 0n, vaultFeesTotal: 0n, vaultDistributedNet: 0n,
    treasuryTotal: 0n, treasuryReleased: 0n, tranches: [], releasesPausedByIssuer: false, releasesPausedLate: false, bids: new Map(), bidOrder: 0, positions: new Map(), periods: new Map(),
    pause: null, pauseIntervals: [], pausedSecondsTotal: 0, redemption: null, extinguishedAt: null, grossByYear: new Map(), grossPaidTotal: 0n, feesTotal: 0n, transferWindows: [], curve: null, splitRouter: null, amendments: [],
  };
  e.state.series.set(seriesId, s);
  issuer.seriesIds.push(seriesId);
  emit('SeriesCreated', { seriesId, issuer: signer, terms: t });
  if (t.raiseStyle === 'curve') {
    const threshold = terms.minimumRaise;
    s.curve = { quoteStablecoin: 'USDC', raised: 0n, basePrice: terms.reservePrice, slopeWad: WAD / 1000n, graduationThreshold: threshold, graduated: false };
    emit('CurveSeriesCreated', { seriesId, issuer: signer, quoteStablecoin: 'USDC', graduationThreshold: str(threshold) });
  }
}

// ------------------------------------------------------------------ allowlist
export function setAllowlist(e: EngineCore, cmd: Extract<Command, { kind: 'setAllowlist' }>, emit: Emit): void {
  if (cmd.allowed) e.state.allowlist.add(cmd.wallet);
  else e.state.allowlist.delete(cmd.wallet);
  emit('AllowlistUpdated', { wallet: cmd.wallet, allowed: cmd.allowed });
}
