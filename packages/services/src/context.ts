import type { AppContext } from '@merces/api';
import type { ESignPort, IdentityCheckPort, KmsPort, VaultCrypto } from '@merces/ports';

/** Everything a service needs. Built once per process (main, dev:mock, tests). */
export interface ServiceContext extends AppContext {
  kms: KmsPort;
  vault: VaultCrypto;
  identity: IdentityCheckPort;
  esign: ESignPort;
  /** domain shown in sign-in messages */
  signInDomain: string;
  /** wall-clock seconds; chain time is used for mechanism deadlines */
  wallClock(): number;
  /** id generator */
  newId(prefix: string): string;
}

/** Route modules receive the AppContext from the gateway and upcast it; the gateway composes a ServiceContext. */
export function svc(ctx: AppContext): ServiceContext {
  const s = ctx as ServiceContext;
  if (!s.kms || !s.vault) throw new Error('ServiceContext not configured (kms/vault missing)');
  return s;
}
