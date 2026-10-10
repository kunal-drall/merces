import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { SigningError, assertSigningNetwork, checkSigningRequest, parseSeriesId, seriesKeyOf, signingRequest } from '@merces/domain';
import { computeDomain, seriesKeyFromId } from '@merces/math';
import { SimHarness, SimulatorChain, defaultTerms, serialiseState } from '../src/index.ts';
import { GENESIS, expectChainError } from './helpers.ts';

/*
 * S4 cause codes:
 *  - S4-CTX: the signing context on the chain port (S4 D6, D7): `ChainInfo.signing` (the deployment's domain, derived on
 *    every read, never persisted), `SeriesState.seriesKey` and the four signing nonces `SeriesState.nonces`.
 */

const hex = (b: Uint8Array): string => '0x' + bytesToHex(b);

describe('the signing context (S4-CTX)', () => {
  it('derives each chain\'s signing domain from its personality and chain key, Stage 1\'s local ids, never persisted', async () => {
    const sol = SimulatorChain.createSync({ personality: 'solana' });
    const solB = SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana-b' });
    const mon = SimulatorChain.createSync({ personality: 'monad' });
    const monB = SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad-b' });
    const [s, sb, m, mb] = await Promise.all([sol.info(), solB.info(), mon.info(), monB.info()]);
    // Stage 1's local ids: Solana's localnet cluster tag (SOLANA_CLUSTER_TAGS.localnet, the LiteSVM harness's
    // CHAIN_ID_LOCALNET) and the local EVM chain id
    expect([s.signing!.chainKind, s.signing!.chainId]).toEqual([1, '104']);
    expect([m.signing!.chainKind, m.signing!.chainId]).toEqual([2, '31337']);
    // the registry is the chain's own registry module: the program id's 32 bytes, the contract address left-padded
    expect(s.signing!.registry).toBe(hex(bs58.decode(s.modules.merces_registry!)));
    expect(m.modules.MercesRegistry).toMatch(/^0x[0-9a-f]{40}$/);
    expect(m.signing!.registry).toBe('0x' + '00'.repeat(12) + m.modules.MercesRegistry!.slice(2));
    // the domain is Stage 1's computeDomain of its own fields
    for (const d of [s.signing!, sb.signing!, m.signing!, mb.signing!]) {
      expect(d.domain).toBe(hex(computeDomain(d.chainKind, BigInt(d.chainId), hexToBytes(d.registry.slice(2)))));
    }
    // two chain keys of one personality never share a registry or a domain
    expect(sb.signing!.registry).not.toBe(s.signing!.registry);
    expect(sb.signing!.domain).not.toBe(s.signing!.domain);
    expect(mb.signing!.domain).not.toBe(m.signing!.domain);
    // deterministic: the same chain key gives the same domain
    expect((await SimulatorChain.createSync({ personality: 'monad' }).info()).signing).toEqual(m.signing);
    // the signers' allow-list accepts these local ids only with allowLocal; never as a live network
    for (const d of [s.signing!, m.signing!]) {
      expect(() => assertSigningNetwork(d, { allowLocal: true })).not.toThrow();
      expect(() => assertSigningNetwork(d)).toThrow(SigningError);
    }
    // derived on read, not persisted with the chain state (as the limits are)
    for (const [chain, info, module] of [[sol, s, 'merces_registry'], [mon, m, 'MercesRegistry']] as const) {
      const json = serialiseState(chain.state);
      expect(json).not.toContain(info.signing!.domain.slice(2));
      expect(json).not.toContain(info.modules[module]!);
    }
  });

  it('reads the series key Stage 1 binds: the series PDA\'s bytes on solana, the left-padded pseudo-address on monad', async () => {
    const sh = await SimHarness.create('solana', { genesis: GENESIS });
    const solSeries = (await sh.runRaise()).seriesId;
    const ss = (await sh.sim.getSeries(solSeries))!;
    expect(ss.seriesKey).toBe(hex(bs58.decode(parseSeriesId(solSeries).address)));
    expect(ss.seriesKey).toBe(seriesKeyOf(solSeries, 'solana'));
    const mh = await SimHarness.create('monad', { genesis: GENESIS });
    const monSeries = (await mh.runRaise()).seriesId;
    const ms = (await mh.sim.getSeries(monSeries))!;
    // bytes32(uint256(uint160(addr))): Stage 1's seriesKeyFromId of the pseudo-address as a number (A-ID-1 stand-in)
    expect(ms.seriesKey).toBe(hex(seriesKeyFromId(BigInt(parseSeriesId(monSeries).address))));
    expect(ms.seriesKey).toBe(seriesKeyOf(monSeries, 'evm'));
    expect((await mh.sim.listSeries()).map((x) => x.seriesKey)).toEqual([ms.seriesKey]);
  });

  it('folds the ledger\'s four nonces into `nonces`, as Stage 1 names and advances them', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const fold = async () => {
      const l = h.sim.stage1View(seriesId).ledger;
      return { read: (await h.sim.getSeries(seriesId))!.nonces, stage1: { pause: l.pauseNonce, amendment: l.amendmentNonce, extinguish: l.extinguishNonce, trueup: l.trueupNonce } };
    };
    expect(await fold()).toEqual({ read: { pause: '0', amendment: '0', extinguish: '0', trueup: '0' }, stage1: { pause: '0', amendment: '0', extinguish: '0', trueup: '0' } });
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 10 * 86_400 });
    const after = await fold();
    expect(after.read).toEqual(after.stage1);
    expect(after.read.pause).toBe('1');
  });

  it('gives a signing request the device can rebuild from the chain\'s own context', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until: now + 10 * 86_400 });
    const [info, series] = await Promise.all([h.sim.info(), h.sim.getSeries(seriesId)]);
    const req = signingRequest({
      kind: 'PAUSE', chain: info.chain, seriesId, seriesKey: series!.seriesKey, domain: info.signing!, signer: '0x' + '11'.repeat(20),
      fields: { pauseNonce: series!.nonces.pause, pauseEnd: String(now + 10 * 86_400) },
    });
    expect(req.validWhile).toBe('pause nonce 1');
    expect(checkSigningRequest(req, { [info.chain]: info.signing! }, { allowLocal: true }).digest).toBe(req.digest);
    // another simulator chain's domain is another domain: the device refuses the request against its pin
    const other = (await SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad-b' }).info()).signing!;
    expect(() => checkSigningRequest(req, { [info.chain]: other }, { allowLocal: true })).toThrow(/pinned domain/);
  });

  it('refuses a series address hint that is not an address of the chain\'s family (the series key is its bytes)', async () => {
    for (const p of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(p, { genesis: GENESIS });
      await h.exec(h.issuer, { kind: 'registerIssuer' });
      const terms = defaultTerms(h.sim).terms;
      const foreign = p === 'solana' ? '0x' + '22'.repeat(20) : bs58.encode(new Uint8Array(32).fill(7));
      for (const hint of ['S1', foreign]) await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms, seriesAddressHint: hint }), 'InvalidTerms');
      const ok = p === 'solana' ? bs58.encode(new Uint8Array(32).fill(9)) : '0x' + '33'.repeat(20);
      const created = await h.exec(h.issuer, { kind: 'createSeries', terms, seriesAddressHint: ok });
      const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
      expect((await h.sim.getSeries(seriesId))!.seriesKey).toBe(p === 'solana' ? '0x' + '09'.repeat(32) : '0x' + '00'.repeat(12) + '33'.repeat(20));
    }
  });
});
