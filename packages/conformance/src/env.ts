import { ChainError, type ChainPort, type DigestSigner, type SeriesTerms, type SignedTx, type UnsignedTx, type WalletSigner } from '@merces/domain';
import { SimHarness, SimSigner, SimWallet, SimulatorChain, defaultTerms, simAdminWallet, type Personality, type PrivateTerms } from '@merces/simulator';
import { createChains, locateStage1 } from '@merces/chains';

/**
 * What a chain under test must provide to the conformance suite. The simulator provides it trivially; a live
 * chain provides funded test wallets, a way to wait for time to pass, and an attestor/admin that Stage 1's test
 * deployment recognises. Everything the suite asserts goes through `ChainPort` only.
 */
export interface ConformanceEnv {
  name: string;
  chain: ChainPort;
  issuer: WalletSigner & { coSign?(signed: SignedTx): Promise<SignedTx> };
  backers: (WalletSigner & { coSign?(signed: SignedTx): Promise<SignedTx> })[];
  /**
   * The attestors: secp256k1 keys the chain registered by their 20-byte addresses (S4 WP7), each a `DigestSigner`.
   * Transitional until S4 WP13: the flows that still take an attestor as a co-signer sign as a wallet at the key's
   * address (`WalletSigner`); a live env provides keys whose wallet the chain recognises for those flows.
   */
  attestors: (WalletSigner & DigestSigner & { coSign?(signed: SignedTx): Promise<SignedTx> })[];
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
}

export async function exec(env: ConformanceEnv, wallet: WalletSigner & { coSign?(s: SignedTx): Promise<SignedTx> }, cmd: UnsignedTx['command'], coSigners: (WalletSigner & { coSign?(s: SignedTx): Promise<SignedTx> })[] = []) {
  const tx = await env.chain.build(cmd as never, wallet.address, coSigners.map((c) => c.address));
  let signed = await wallet.sign(tx);
  for (const c of coSigners) signed = c.coSign ? await c.coSign(signed) : { tx, signatures: { ...signed.signatures, ...(await c.sign(tx)).signatures } };
  return env.chain.send(signed);
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
 * throws, which the suite reports as "not configured" rather than a failure.
 */
export async function liveEnv(target: 'solana' | `evm:${string}`): Promise<ConformanceEnv> {
  const chainKey = target === 'solana' ? 'solana' : target.slice(4);
  const reg = await createChains({ solana: { mode: target === 'solana' ? 'live' : 'mock' }, evm: { mode: target === 'solana' ? 'mock' : 'live', chainKey }, stage1Path: process.env.STAGE1_PATH, generatedDir: process.env.STAGE1_SYNC_GENERATED, log: () => undefined });
  const chain = reg.get(chainKey);
  const loc = locateStage1(process.env.STAGE1_PATH);
  throw new Error(`live conformance env for ${target} needs funded test wallets (CONFORMANCE_ISSUER_KEY, CONFORMANCE_BACKER_KEYS, CONFORMANCE_ATTESTOR_KEYS, CONFORMANCE_ADMIN_KEY) and a live-wallet signer; chain=${chain.chain} manifest=${loc?.path ?? 'none'} — see STAGE1_INTEGRATION.md`);
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
