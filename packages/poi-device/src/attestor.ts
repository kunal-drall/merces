import { incomeCommitment } from '@merces/domain';

/**
 * Tier 3 (critique M7): the issuer's device proves the report; the attestor checks the income commitment against the
 * issuer's documents. For that the attestor needs the opening (year-to-date figure and salt, and the prior's), which
 * the issuer's device encrypts end to end for the attestor, like the documents: the API stores only ciphertext, and
 * the opening never crosses it, the database, a queue or a log in plaintext.
 */
export interface Tier3Opening {
  version: 'merces/tier3-opening/v1';
  seriesId: string;
  periodId: string;
  incomeYtd: string;
  incomeSalt: string;
  priorIncomeYtd: string;
  priorSalt: string;
  priorIncomeCommitment: string;
  incomeCommitment: string;
}

export type Tier3OpeningCode = 'wrong-context' | 'not-field' | 'commitment-mismatch' | 'prior-mismatch' | 'not-high-water';

/**
 * The attestor's device, before signing a tier-3 case: the decrypted opening is for this case, opens both
 * commitments, and its year-to-date figure is the high-water mark `max(documented, prior)` of the figure the attestor
 * extracted from the documents (SPEC §1.5). The Groth16 proof then binds the payment to these commitments and the
 * series' terms commitment; the attestor does not need the private terms.
 */
export function checkTier3Opening(o: Tier3Opening, c: { seriesId: string; periodId: string; priorIncomeCommitment: string; incomeCommitment: string; documentedYtd: bigint }): { ok: true } | { ok: false; code: Tier3OpeningCode } {
  if (o.version !== 'merces/tier3-opening/v1' || o.seriesId !== c.seriesId || o.periodId !== c.periodId) return { ok: false, code: 'wrong-context' };
  let ic: string;
  let prior: string;
  try {
    ic = incomeCommitment(o.incomeYtd, o.incomeSalt);
    prior = incomeCommitment(o.priorIncomeYtd, o.priorSalt);
  } catch {
    return { ok: false, code: 'not-field' };
  }
  if (ic !== c.incomeCommitment || ic !== o.incomeCommitment) return { ok: false, code: 'commitment-mismatch' };
  if (prior !== c.priorIncomeCommitment || prior !== o.priorIncomeCommitment) return { ok: false, code: 'prior-mismatch' };
  const priorYtd = BigInt(o.priorIncomeYtd);
  const expected = c.documentedYtd > priorYtd ? c.documentedYtd : priorYtd;
  if (BigInt(o.incomeYtd) !== expected) return { ok: false, code: 'not-high-water' };
  return { ok: true };
}
