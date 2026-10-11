import { AppError } from '@merces/core';
import { SigningError, signingRequest, type ChainPort, type SigningDomain, type SigningFields, type SigningKind, type SigningRequest } from '@merces/domain';

/**
 * What every service that hands an attestor a Stage 1 message to sign shares (S4 D2: no custody; the attestor service
 * since S4 WP9-WP10, the terms service's amendments since S4 WP11). The API never signs: it builds a signing request from
 * the chain's own reads, which the attestor's device rebuilds and checks before it signs, and it recovers and checks every
 * signature it is sent.
 */

/** The chain's signing domain, or 409 `signing-domain-unknown` (a live adapter before S5 cannot read it yet). */
export async function signingDomainOf(chain: ChainPort): Promise<SigningDomain> {
  const signing = (await chain.info()).signing;
  if (!signing) throw new AppError(409, 'Conflict', `the signing domain of chain ${chain.chain} is not known yet: nothing can be signed for it`, { reason: 'signing-domain-unknown' });
  return signing;
}

/**
 * A signing request for the attestor's device (S4 D2), from the chain's own domain and series key. The domain is
 * allow-listed and never mainnet (`signingRequest` refuses it: 409 `signing-network-refused`, value-free).
 */
export function requestFor<K extends SigningKind>(input: { kind: K; chain: string; seriesId: string; seriesKey: string; domain: SigningDomain; signer: string; fields: SigningFields[K] }): SigningRequest<K> {
  try {
    return signingRequest(input);
  } catch (e) {
    if (e instanceof SigningError) throw new AppError(409, 'Conflict', `no signing request can be issued for this chain: ${e.message}`, { reason: 'signing-network-refused', code: e.code });
    throw e;
  }
}

/** A refusal of a signature the chain would refuse: 422 with Stage 1's error name (value-free). */
export function invalidAttestorSignature(message: string, detail: Record<string, unknown> = {}): AppError {
  return AppError.unprocessable(message, { stage1: 'InvalidAttestorSignature', ...detail });
}
