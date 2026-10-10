import type { SeriesTerms } from '@merces/domain';
import { RunnerError } from '../errors.ts';
import { ZERO_HASH32, hex32, num, tierFlagsOf } from '../codec.ts';
import { direct, eventOf, shim, type OpContext, type TranslatorTable } from './types.ts';

/**
 * Registry ops: the faucet, the allowlist, issuer / attestor / verifier-key registration and series creation.
 *
 * - `fund`: the simulator faucet (direct).
 * - `allowlist`: one `setAllowlist` per wallet from the allowlist manager (direct; atomic as one step).
 * - `register_issuer` (SH-REG-1): `registerIssuer` signed by that wallet; Stage 1 registers issuers admin-only.
 * - `register_attestor` / `revoke_attestor`: admin `registerAttestor` / `revokeAttestor` of the vector key's own 20-byte
 *   address (direct since S4 WP5; was SH-REG-2): Stage 1's registry with forward-only revocation, the 45-day grace on
 *   report and FX signatures and the last-key rule, each personality with its chain's names. A name without a vector
 *   key is a runner error.
 * - `register_verifier_key` (SH-REG-3): admin `registerVerifierKey` with the ed25519 key derived from the vector key.
 * - `create_series` (SH-REG-4): `createSeries` in USDC with USD income, sealed; due, grace and notice days from
 *   `config.parameters`; the raise durations and the non-reveal bps are canonical terms (S2), so the engine bounds them
 *   as Stage 1 does (SIM:759-777); the window durations and the window fee are held by the runner (S5; their Stage 1
 *   bounds are not checked).
 */
/** The 20-byte address of the vector key a registry op names (Stage 1's harnesses register the key's address). */
function keyAddressOf(ctx: OpContext, name: string): string {
  const a = ctx.actors.keyAddress(name);
  if (!a) throw new RunnerError(`the vector has no key named ${name}`);
  return a;
}

export const registryOps: TranslatorTable = {
  fund: (ctx, c) =>
    direct(async () => {
      await ctx.chain.fund(ctx.actors.address(c.actor), 'USDC', BigInt(c.amount));
    }),

  allowlist: (ctx, c) =>
    direct(async () => {
      for (const w of c.wallets) await ctx.submit({ kind: 'setAllowlist', wallet: ctx.actors.address(w), allowed: c.allowed !== false }, 'allowlistManager');
    }),

  register_issuer: (ctx, c) =>
    shim('SH-REG-1', async () => {
      await ctx.send(ctx.actors.wallet(c.wallet), { kind: 'registerIssuer' });
    }),

  register_attestor: (ctx, c) => {
    const attestor = keyAddressOf(ctx, c.key);
    return direct(async () => {
      await ctx.send(ctx.actors.admin, { kind: 'registerAttestor', attestor });
    });
  },

  revoke_attestor: (ctx, c) => {
    const attestor = keyAddressOf(ctx, c.key);
    return direct(async () => {
      await ctx.send(ctx.actors.admin, { kind: 'revokeAttestor', attestor });
    });
  },

  register_verifier_key: (ctx, c) =>
    shim('SH-REG-3', async () => {
      const k = ctx.keyring.ed25519(c.key);
      await ctx.send(ctx.actors.admin, { kind: 'registerVerifierKey', keyId: k.keyId, publicKey: k.publicKeyHex, active: true });
    }),

  create_series: (ctx, c) => {
    // FX income and tier-1 routers are S5 and the tier-1 milestone: the canonical terms cannot carry them yet
    if (c.fxPairId) throw new RunnerError(`create_series ${c.series}: series with FX income are not modelled before S5`);
    if (c.router) throw new RunnerError(`create_series ${c.series}: tier-1 router series are not modelled yet (S5)`);
    if (ctx.book.series[c.series]) throw new RunnerError(`create_series ${c.series}: the vector creates this series twice`);
    const t = c.terms;
    const p = ctx.vector.parameters;
    const terms: SeriesTerms = {
      stablecoin: 'USDC',
      stablecoinMint: ctx.mint,
      unitsOffered: t.unitsOffered,
      reservePrice: t.reservePrice,
      minimumRaise: t.minRaise,
      capMultipleWad: t.capMultipleWad,
      lockupSeconds: num(t.lockupSeconds, 'lockupSeconds'),
      releaseSchedule: c.releaseSchedule.map((r) => ({ afterSeconds: num(r.atOffsetSeconds, 'atOffsetSeconds'), bps: num(r.bps, 'bps') })),
      auctionFeeBps: num(t.auctionFeeBps, 'auctionFeeBps'),
      payoutFeeBps: num(t.payoutFeeBps, 'payoutFeeBps'),
      hurdleWad: t.hurdleRateWad,
      payoutMultipleK: num(t.payoutMultipleK, 'payoutMultipleK'),
      walletCapBps: num(t.walletCapBps, 'walletCapBps'),
      nonRevealChargeBps: num(t.nonRevealChargeBps, 'nonRevealChargeBps'),
      commitDurationSeconds: num(t.commitDuration, 'commitDuration'),
      revealDurationSeconds: num(t.revealDuration, 'revealDuration'),
      dueDays: p.reportDueDays,
      graceDays: p.graceDays,
      formalNoticeDays: p.formalNoticeDays,
      contractHash: c.contractHash ? hex32(c.contractHash, 'contractHash') : ZERO_HASH32,
      termsCommitment: hex32(c.termsCommitment, 'termsCommitment'),
      tierFlags: tierFlagsOf(c.tierFlags),
      reportingCurrency: 'USD',
      raiseStyle: 'sealed',
    };
    const held = {
      windowCommitDuration: num(t.windowCommitDuration, 'windowCommitDuration'),
      windowRevealDuration: num(t.windowRevealDuration, 'windowRevealDuration'),
      windowFeeBps: num(t.windowFeeBps, 'windowFeeBps'),
    };
    return shim('SH-REG-4', async () => {
      const r = await ctx.send(ctx.actors.wallet(c.actor), { kind: 'createSeries', terms, seriesAddressHint: ctx.actors.seriesAddress(c.series) });
      const created = eventOf<{ seriesId: string }>(r, 'SeriesCreated');
      if (!created) throw new RunnerError(`create_series ${c.series}: no SeriesCreated event`);
      ctx.book.series[c.series] = { seriesId: created.seriesId, terms: held, window: null };
    });
  },
};
