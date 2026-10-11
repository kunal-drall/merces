import { registerRouterRoutes } from './router/routes.ts';
import type { AppContext } from '@merces/api';
import { checkNonRevealCharge, nonRevealChargeSetting } from '@merces/domain';
import { LocalKms, MockESign, MockIdentityCheck, MockZkTls, reportProofSystemFromEnv, reportProofVerifier, resolveSecret, simulatorOnly, vaultFromEnv, type ESignPort, type IdentityCheckPort, type KmsPort, type ProofVerifierPort, type VaultCrypto, type ZkTlsPort } from '@merces/ports';
import { HttpReportVerifierClient, ReportVerifier, verifierChainsFromPorts, type ReportVerifierPort } from '@merces/report-verifier';
import type { ServiceContext } from './context.ts';
import { newId } from './ids.ts';
import { registerIdentityRoutes } from './identity/routes.ts';
import { registerContractRoutes } from './contracts/routes.ts';
import { registerTermsRoutes } from './terms/routes.ts';
import { registerPoiRoutes } from './poi/routes.ts';
import { registerAuctionRoutes } from './auction/routes.ts';
import { registerLifecycleRoutes } from './lifecycle/routes.ts';
import { registerMeteoraRoutes } from './meteora/routes.ts';
import { registerThresholdRoutes } from './threshold/routes.ts';
import { registerAttestorRoutes } from './attestor/routes.ts';
import { registerAccountingRoutes } from './accounting/routes.ts';
import { registerNotificationsRoutes } from './notifications/routes.ts';
import { registerAdminRoutes } from './admin/routes.ts';

export * from './context.ts';
export * from './identity/service.ts';
export * from './contracts/service.ts';
export * from './terms/service.ts';
export * from './poi/service.ts';
export * from './auction/service.ts';
export * from './lifecycle/service.ts';
export * from './meteora/service.ts';
export * from './meteora/lifecycle.ts';
export * from './meteora/staking.ts';
export * from './curve-census.ts';
export * from './threshold/service.ts';
export * from './attestor/service.ts';
export * from './accounting/service.ts';
export * from './notifications/service.ts';
export * from './admin/service.ts';
export { registerMeteoraRoutes, defaultMeteoraProviders } from './meteora/routes.ts';

export interface ProviderOverrides {
  kms?: KmsPort;
  vault?: VaultCrypto;
  identity?: IdentityCheckPort;
  esign?: ESignPort;
  zktls?: ZkTlsPort;
  proofVerifier?: ProofVerifierPort;
  verifier?: ReportVerifierPort;
  reportVerifierUrl?: string;
  signInDomain?: string;
  /**
   * The non-reveal charge for new series (bps, checked against Stage 1's bounds), or null for unset; when absent, the
   * owner's setting `MERCES_NON_REVEAL_CHARGE_BPS` is read. Tests pass it explicitly.
   */
  nonRevealChargeBps?: number | null;
}

/** Compose the ServiceContext over the gateway's AppContext. Providers default to mocks / local dev signer. */
export function createServiceContext(base: AppContext, over: ProviderOverrides = {}): ServiceContext {
  const ctx = base as ServiceContext;
  // dev seeds and keys are accepted only while every chain is the simulator (resolveSecret refuses otherwise)
  const simOnly = simulatorOnly(base.chains);
  // the in-process report verifier's key is the only local key the services hold; its algorithm is configuration (S4 WP3),
  // Stage 1's secp256k1 (S4 WP6, D10)
  const verifierKeyId = process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1';
  ctx.kms = over.kms ?? new LocalKms(resolveSecret(process.env, 'MERCES_LOCAL_KEY_SEED', { simulatorOnly: simOnly, devDefault: 'dev-seed-not-for-production' }), { [verifierKeyId]: 'secp256k1' });
  ctx.vault = over.vault ?? vaultFromEnv(process.env, { simulatorOnly: simOnly });
  ctx.identity = over.identity ?? new MockIdentityCheck();
  ctx.esign = over.esign ?? new MockESign();
  ctx.zktls = over.zktls ?? new MockZkTls();
  if (!simOnly && ctx.zktls instanceof MockZkTls) throw new Error('mock zkTLS is simulator-only: configure a real zkTLS provider before live reporting (Part J.3)');
  // Stage 1 Groth16 by default; mock proofs too only in a simulator-only process with MERCES_PROOF_SYSTEM=mock (H3;
  // the chain registry logs the warning and refuses the setting next to a live chain)
  ctx.proofVerifier = over.proofVerifier ?? reportProofVerifier({ acceptMock: reportProofSystemFromEnv(process.env, { simulatorOnly: simOnly }) === 'mock' });
  ctx.reportVerifierUrl = over.reportVerifierUrl ?? process.env.REPORT_VERIFIER_URL ?? 'http://localhost:3100';
  // In mock mode the verifier runs in-process with the same local key the standalone service derives (dev seed); live
  // mode talks to the isolated service. Its chain table is each chain's own signing domain (`ChainInfo.signing`: the
  // simulators' derived local domains, S4 amendment D10), local ids allowed only in a simulator-only process; the pin
  // `REPORT_VERIFIER_ADDRESS` is checked when set.
  ctx.verifier = over.verifier ?? (base.devMode
    ? new ReportVerifier(ctx.zktls, ctx.kms, { keyId: verifierKeyId, address: process.env.REPORT_VERIFIER_ADDRESS?.trim() || null, chains: () => verifierChainsFromPorts(base.chains.chains.values()), allowLocal: simOnly })
    : new HttpReportVerifierClient(ctx.reportVerifierUrl));
  ctx.signInDomain = over.signInDomain ?? process.env.MERCES_SIGNIN_DOMAIN ?? 'merces.local';
  // the owner's decision, never a built-in rate: a malformed or out-of-bounds setting stops the process here
  ctx.nonRevealChargeBps = over.nonRevealChargeBps !== undefined ? (over.nonRevealChargeBps === null ? null : checkNonRevealCharge(over.nonRevealChargeBps)) : nonRevealChargeSetting(process.env);
  ctx.wallClock = () => Math.floor(Date.now() / 1000);
  ctx.newId = newId;
  return ctx;
}

/** Every service route module, in registration order. The server composes them into the gateway. */
export const serviceRoutes: ((app: import('fastify').FastifyInstance, ctx: AppContext) => void)[] = [registerRouterRoutes, registerIdentityRoutes, registerContractRoutes, registerTermsRoutes, registerPoiRoutes, registerAuctionRoutes, registerLifecycleRoutes, registerMeteoraRoutes, registerThresholdRoutes, registerAttestorRoutes, registerAccountingRoutes, registerNotificationsRoutes, registerAdminRoutes];
