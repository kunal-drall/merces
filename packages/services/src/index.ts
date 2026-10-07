import type { AppContext } from '@merces/api';
import { LocalKms, MockESign, MockIdentityCheck, vaultFromEnv, type ESignPort, type IdentityCheckPort, type KmsPort, type VaultCrypto } from '@merces/ports';
import type { ServiceContext } from './context.ts';
import { newId } from './ids.ts';
import { registerIdentityRoutes } from './identity/routes.ts';
import { registerContractRoutes } from './contracts/routes.ts';
import { registerTermsRoutes } from './terms/routes.ts';

export * from './context.ts';
export * from './identity/service.ts';
export * from './contracts/service.ts';
export * from './terms/service.ts';

export interface ProviderOverrides {
  kms?: KmsPort;
  vault?: VaultCrypto;
  identity?: IdentityCheckPort;
  esign?: ESignPort;
  signInDomain?: string;
}

/** Compose the ServiceContext over the gateway's AppContext. Providers default to mocks / local dev signer. */
export function createServiceContext(base: AppContext, over: ProviderOverrides = {}): ServiceContext {
  const ctx = base as ServiceContext;
  ctx.kms = over.kms ?? new LocalKms(process.env.MERCES_LOCAL_KEY_SEED ?? 'dev-seed-not-for-production');
  ctx.vault = over.vault ?? vaultFromEnv();
  ctx.identity = over.identity ?? new MockIdentityCheck();
  ctx.esign = over.esign ?? new MockESign();
  ctx.signInDomain = over.signInDomain ?? process.env.MERCES_SIGNIN_DOMAIN ?? 'merces.local';
  ctx.wallClock = () => Math.floor(Date.now() / 1000);
  ctx.newId = newId;
  return ctx;
}

/** Every service route module, in registration order. The server composes them into the gateway. */
export const serviceRoutes: ((app: import('fastify').FastifyInstance, ctx: AppContext) => void)[] = [registerIdentityRoutes, registerContractRoutes, registerTermsRoutes];
