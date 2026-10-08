import type { AppContext } from '@merces/api';
import { LocalKms, MockESign, MockIdentityCheck, MockProofVerifier, MockZkTls, vaultFromEnv, type ESignPort, type IdentityCheckPort, type KmsPort, type ProofVerifierPort, type VaultCrypto, type ZkTlsPort } from '@merces/ports';
import { HttpReportVerifierClient, ReportVerifier, type ReportVerifierPort } from '@merces/report-verifier';
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

export * from './context.ts';
export * from './identity/service.ts';
export * from './contracts/service.ts';
export * from './terms/service.ts';
export * from './poi/service.ts';
export * from './auction/service.ts';
export * from './lifecycle/service.ts';
export * from './meteora/service.ts';
export * from './threshold/service.ts';
export * from './attestor/service.ts';
export * from './accounting/service.ts';
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
}

/** Compose the ServiceContext over the gateway's AppContext. Providers default to mocks / local dev signer. */
export function createServiceContext(base: AppContext, over: ProviderOverrides = {}): ServiceContext {
  const ctx = base as ServiceContext;
  ctx.kms = over.kms ?? new LocalKms(process.env.MERCES_LOCAL_KEY_SEED ?? 'dev-seed-not-for-production');
  ctx.vault = over.vault ?? vaultFromEnv();
  ctx.identity = over.identity ?? new MockIdentityCheck();
  ctx.esign = over.esign ?? new MockESign();
  ctx.zktls = over.zktls ?? new MockZkTls();
  ctx.proofVerifier = over.proofVerifier ?? new MockProofVerifier();
  ctx.reportVerifierUrl = over.reportVerifierUrl ?? process.env.REPORT_VERIFIER_URL ?? 'http://localhost:3100';
  // In mock mode the verifier runs in-process with the same local key the standalone service derives (dev seed); live mode talks to the isolated service.
  ctx.verifier = over.verifier ?? (base.devMode ? new ReportVerifier(ctx.zktls, ctx.kms, process.env.REPORT_VERIFIER_KEY_ID ?? 'report-verifier-1') : new HttpReportVerifierClient(ctx.reportVerifierUrl));
  ctx.signInDomain = over.signInDomain ?? process.env.MERCES_SIGNIN_DOMAIN ?? 'merces.local';
  ctx.wallClock = () => Math.floor(Date.now() / 1000);
  ctx.newId = newId;
  return ctx;
}

/** Every service route module, in registration order. The server composes them into the gateway. */
export const serviceRoutes: ((app: import('fastify').FastifyInstance, ctx: AppContext) => void)[] = [registerIdentityRoutes, registerContractRoutes, registerTermsRoutes, registerPoiRoutes, registerAuctionRoutes, registerLifecycleRoutes, registerMeteoraRoutes, registerThresholdRoutes, registerAttestorRoutes, registerAccountingRoutes];
