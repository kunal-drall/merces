import type { AppContext } from '@merces/api';
import type { ESignPort, IdentityCheckPort, KmsPort, ProofVerifierPort, VaultCrypto, ZkTlsPort } from '@merces/ports';
import type { ReportVerifierPort } from '@merces/report-verifier';

/** Everything a service needs. Built once per process (main, dev:mock, tests). */
export interface ServiceContext extends AppContext {
  kms: KmsPort;
  vault: VaultCrypto;
  identity: IdentityCheckPort;
  esign: ESignPort;
  /** Explicit test-network-only e-sign simulation; never enables dev routes or mock income proofs. */
  testESign: boolean;
  zktls: ZkTlsPort;
  proofVerifier: ProofVerifierPort;
  /** client for the isolated report verifier (used only to read its public key; devices call it directly) */
  verifier: ReportVerifierPort;
  reportVerifierUrl: string;
  /** domain shown in sign-in messages */
  signInDomain: string;
  /**
   * The owner's non-reveal charge for new series, in bps within Stage 1's bounds (`MERCES_NON_REVEAL_CHARGE_BPS`,
   * `nonRevealChargeSetting`); null while unset, and then no sealed series is built. There is no built-in rate.
   */
  nonRevealChargeBps: number | null;
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
