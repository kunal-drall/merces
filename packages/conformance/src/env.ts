import { randomBytes } from 'node:crypto';
import { EvmChain, evmServiceWallet } from '@merces/chain-evm';
import { SolanaChain, solanaServiceWallet } from '@merces/chain-solana';
import { digestKey, liveReportBuilder } from './live.ts';
import { ChainError, type ChainPort, type DigestSigner, type SeriesTerms, type UnsignedTx, type WalletSigner } from '@merces/domain';
import { SimHarness, SimSigner, SimWallet, SimulatorChain, defaultTerms, simAdminWallet, type Personality, type PrivateTerms } from '@merces/simulator';
import { createChains, chainsConfigFromEnv } from '@merces/chains';

/**
 * What a chain under test must provide to the conformance suite. The simulator provides it trivially; a live
 * chain provides funded test wallets, a way to wait for time to pass, and an attestor/admin that Stage 1's test
 * deployment recognises. Everything the suite asserts goes through `ChainPort` only.
 */
export interface ConformanceEnv {
  name: string;
  chain: ChainPort;
  issuer: WalletSigner;
  backers: WalletSigner[];
  /**
   * The attestors: secp256k1 keys the chain registered by their 20-byte addresses (S4 WP7), each a `DigestSigner`. A key
   * signs Stage 1 messages only, never a transaction: nobody co-signs (S4 WP13); its signature is an argument of the
   * command a wallet sends.
   */
  attestors: DigestSigner[];
  admin: WalletSigner;
  /** the report verifier key the chain has registered (a secp256k1 key's 20-byte address; S4 WP6) */
  verifierAddress: string;
  /** a secp256k1 key the chain has not registered as an attestor: what it signs is refused (S4 WP10) */
  outsider: DigestSigner;
  /** private terms matching the default terms' commitment */
  privateTerms: PrivateTerms;
  terms(over?: Partial<SeriesTerms>): SeriesTerms;
  /** Advance chain time (simulator) or wait until the chain clock passes `until` (live). */
  waitUntil(until: number): Promise<void>;
  /** Durations the suite uses; live chains need short ones. */
  durations: { commit: number; reveal: number; lockup: number; reportLead: number };
  /** Device-side report builder (the harness's) */
  buildReport: SimHarness['buildReport'];
  close(): Promise<void>;
  /** Operator-provided pool created with Stage 1's issuer-device tooling for the next curve series. */
  curvePool?: string;
}

/** Build, sign and send `cmd` with `wallet`, the transaction's one signer (nobody co-signs, S4 WP13). */
export async function exec(env: ConformanceEnv, wallet: WalletSigner, cmd: UnsignedTx['command']) {
  for (let i = 0; i < 32; i++) {
    const tx = await env.chain.build(cmd as never, wallet.address);
    const first = tx.preparations?.[0] ?? tx.approvals?.[0];
    if (first) {
      await env.chain.send(await wallet.sign({ ...tx, payload: first.payload, encoding: first.encoding, preparations: undefined, approvals: undefined, afterCreate: undefined }));
      continue;
    }
    const result = await env.chain.send(await wallet.sign(tx));
    const created = result.events.find((e) => e.type === 'SeriesCreated');
    if (tx.afterCreate && created) {
      const seriesId = (created.payload as { seriesId: string }).seriesId;
      const bound = await exec(env, wallet, { kind: 'setContractHash', seriesId, contractHash: tx.afterCreate.contractHash });
      result.events.push(...bound.events);
    }
    // The simulator's curve fixture activates at creation. A real chain uses Stage 1's explicit activation.
    if (cmd.kind === 'createSeries' && cmd.terms.raiseStyle === 'curve' && env.chain instanceof SolanaChain && created) {
      if (!env.curvePool) throw new Error('CONFORMANCE_CURVE_POOL is required for live curve activation');
      const seriesId = (created.payload as { seriesId: string }).seriesId;
      env.chain.config.curvePools ??= {};
      env.chain.config.curvePools[seriesId] = env.curvePool;
      const activated = await exec(env, wallet, { kind: 'openRaise', seriesId });
      result.events.push(...activated.events);
    }
    return result;
  }
  throw new Error('wallet prerequisites exceeded the bounded conformance run');
}

export async function expectChainError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChainError && e.code === code) return;
    throw new Error(`expected ChainError ${code}, got ${e instanceof ChainError ? e.code : (e as Error).message}`);
  }
  throw new Error(`expected ChainError ${code}, but the call succeeded`);
}

export async function simulatorEnv(personality: Personality): Promise<ConformanceEnv> {
  const h = await SimHarness.create(personality, { genesis: Date.UTC(2026, 0, 1) / 1000 });
  const durations = { commit: 3 * 86_400, reveal: 86_400, lockup: 30 * 86_400, reportLead: 86_400 };
  return {
    name: `simulator:${personality}`,
    chain: h.sim,
    issuer: h.issuer,
    backers: h.backers,
    attestors: h.attestors,
    admin: simAdminWallet(h.sim.family),
    verifierAddress: h.verifier.address,
    outsider: SimSigner.attestor('conformance-outsider'),
    privateTerms: defaultTerms(h.sim).privateTerms,
    // the raise's phases are terms: openRaise derives the ends from these durations
    terms: (over) => defaultTerms(h.sim, { commitDurationSeconds: durations.commit, revealDurationSeconds: durations.reveal, ...over }).terms,
    waitUntil: async (until) => {
      if ((await h.sim.now()) < until) await h.sim.setTime(until);
    },
    durations,
    buildReport: (p) => h.buildReport(p),
    close: async () => undefined,
  };
}

/**
 * Live environments are resolved from the Stage 1 manifest and the registry (mode=live). Funded test wallets and the
 * attestor/admin keys come from environment variables documented in STAGE1_INTEGRATION.md; without them the env
 * fails closed with a named configuration error. Public quarterly time is never shortened.
 */
export async function liveEnv(target: 'solana' | `evm:${string}`): Promise<ConformanceEnv> {
  const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required for live conformance`); return value; };
  const keyList = (name: string, min: number): string[] => {
    let values: unknown; try { values = JSON.parse(required(name)); } catch { throw new Error(`${name} must be a JSON array of keys`); }
    if (!Array.isArray(values) || values.length < min || values.some((x) => typeof x !== 'string')) throw new Error(`${name} needs at least ${min} keys`);
    return values as string[];
  };
  // Validate secrets before opening any RPC connection. Never include their values in errors.
  const issuerKey = required('CONFORMANCE_ISSUER_KEY'), adminKey = required('CONFORMANCE_ADMIN_KEY');
  const backerKeys = keyList('CONFORMANCE_BACKER_KEYS', 5), attestors = keyList('CONFORMANCE_ATTESTOR_KEYS', 2).map(digestKey);
  const verifier = digestKey(required('CONFORMANCE_VERIFIER_KEY'));
  const chainKey = target === 'solana' ? 'solana' : target.slice(4);
  const config = chainsConfigFromEnv(process.env);
  const reg = await createChains({ ...config, solana: { ...config.solana, mode: target === 'solana' ? 'live' : 'mock' }, evm: { ...config.evm, mode: target === 'solana' ? 'mock' : 'live', chainKey }, simulators: 'skip', proofSystem: 'groth16-bn254', log: () => undefined });
  try {
    const chain = reg.get(chainKey), info = await chain.info();
    const wallet = (key: string): WalletSigner => {
      if (!/^(?:0x)?[0-9a-f]{64}$/i.test(key)) throw new Error('conformance wallet keys must contain 32 bytes of hex');
      return chain instanceof EvmChain ? evmServiceWallet(chain.config, `0x${key.replace(/^0x/, '')}`)
        : solanaServiceWallet((chain as SolanaChain).config, Buffer.from(key.replace(/^0x/, ''), 'hex'));
    };
    const issuer = wallet(issuerKey), admin = wallet(adminKey), backers = backerKeys.map(wallet);
    for (const w of [issuer, ...backers]) if (!await chain.isAllowlisted(w.address)) throw new Error('allowlist every conformance issuer and backer before running the suite');
    for (const a of attestors) if (!(await chain.getSignerKey('attestor', a.address))?.active) throw new Error('register each conformance attestor before running the suite');
    if (!(await chain.getSignerKey('verifier', verifier.address))?.active) throw new Error('register the conformance verifier before running the suite');
    if (admin.address.toLowerCase() !== info.admin.toLowerCase()) throw new Error('CONFORMANCE_ADMIN_KEY does not match the deployed admin; use a dedicated conformance deployment');
    const template = SimulatorChain.createSync({ personality: chain.family === 'solana' ? 'solana' : 'monad' });
    const durations = { commit: 3600, reveal: 3600, lockup: 30 * 86400, reportLead: 60 };
    const waitUntil = async (until: number) => {
      let now = await chain.now(); if (until <= now) return;
      if (process.env.CONFORMANCE_EVM_TIME_TRAVEL === 'true') {
        if (!(chain instanceof EvmChain) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(chain.config.rpcUrl).hostname)) throw new Error('conformance time travel is restricted to a loopback EVM fork');
        const request = chain.client.request as unknown as (p: unknown) => Promise<unknown>;
        await request({ method: 'evm_setNextBlockTimestamp', params: [until] });
        await request({ method: 'evm_mine', params: [] });
      }
      const max = Number(process.env.CONFORMANCE_MAX_WAIT_SECONDS ?? '60');
      if (!Number.isSafeInteger(max) || max < 0) throw new Error('CONFORMANCE_MAX_WAIT_SECONDS must be a nonnegative integer');
      const deadline = Date.now() + max * 1000;
      while ((now = await chain.now()) < until) {
        if (Date.now() >= deadline) throw new Error('conformance needs a later chain clock; public quarterly lifecycle checks require real time, or a loopback EVM fork with CONFORMANCE_EVM_TIME_TRAVEL=true');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };
    return { name: target, chain, issuer, backers, attestors, admin, verifierAddress: verifier.address, outsider: digestKey(`0x${randomBytes(32).toString('hex')}`),
      privateTerms: defaultTerms(template).privateTerms,
      terms: (over) => ({ ...defaultTerms(template, { commitDurationSeconds: durations.commit, revealDurationSeconds: durations.reveal, ...over }).terms, stablecoinMint: info.stablecoins[over?.stablecoin ?? 'USDC']!.mint }),
      waitUntil, durations, buildReport: liveReportBuilder(chain, verifier, attestors[0]!), close: () => reg.close(), curvePool: process.env.CONFORMANCE_CURVE_POOL,
    };
  } catch (e) { await reg.close(); throw e; }
}

/**
 * Target names for a CONFORMANCE_CHAIN value, resolved synchronously so the suite can declare one describe block
 * per target at collection time: `simulator` (default) is both personalities, anything else is that one target.
 */
export function conformanceTargets(target: string = process.env.CONFORMANCE_CHAIN ?? 'simulator'): string[] {
  return target === 'simulator' ? ['simulator:solana', 'simulator:monad'] : [target];
}

/** Builds a fresh env for one target name from `conformanceTargets`. */
export async function envFor(name: string): Promise<ConformanceEnv> {
  if (name === 'simulator:solana') return simulatorEnv('solana');
  if (name === 'simulator:monad') return simulatorEnv('monad');
  if (name === 'solana' || /^evm:.+/.test(name)) return liveEnv(name as 'solana' | `evm:${string}`);
  throw new Error(`unknown CONFORMANCE_CHAIN target '${name}' (simulator, simulator:solana, simulator:monad, solana, evm:<chain>)`);
}

export async function resolveEnv(): Promise<ConformanceEnv[]> {
  const out: ConformanceEnv[] = [];
  for (const name of conformanceTargets()) out.push(await envFor(name));
  return out;
}

export { SimWallet, SimulatorChain };
