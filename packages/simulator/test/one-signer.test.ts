import { describe, expect, it } from 'vitest';
import { SimHarness, SimWallet } from '../src/index.ts';
import { GENESIS, expectChainError, expectStage1Error, types } from './helpers.ts';

/*
 * Cause code:
 *  - S4-CS: nobody co-signs (S4 D3, WP13). A transaction has one signer, the wallet it was built for: `UnsignedTx` has
 *    no co-signer field, `ChainPort.build(command, signer)` takes none, and the simulator's `send` checks that wallet's
 *    signature only. Every attestation is a Stage 1 signature the command carries (`approvePause`, `amendTerms`,
 *    `extinguish`, a tier-2 or tier-3 `submitReport`), so a signature beside the signer's grants nothing, and an attestor
 *    is a key, never a wallet.
 */

const TX_KEYS = ['chain', 'command', 'encoding', 'expiresAt', 'family', 'payload', 'signer', 'summary'];

describe('one signer per transaction (cause S4-CS)', () => {
  for (const personality of ['solana', 'monad'] as const) {
    it(`${personality}: build names one signer and no co-signer; the payload carries the command and that signer only`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId } = await h.runRaise();
      const tx = await h.sim.build({ kind: 'drawRelease', seriesId }, h.issuer.address);
      expect(Object.keys(tx).sort()).toEqual(TX_KEYS);
      expect(tx.signer).toBe(h.issuer.address);
      expect(Object.keys(JSON.parse(tx.payload)).sort()).toEqual(['command', 'signer']);
      // a transaction of several commands: the same one signer
      const bundle = personality === 'solana' ? await h.sim.build([{ kind: 'pauseReleases', seriesId, paused: true }, { kind: 'pauseReleases', seriesId, paused: false }], h.issuer.address) : null;
      if (bundle) {
        expect(Object.keys(bundle).sort()).toEqual([...TX_KEYS, 'commands'].sort());
        expect(Object.keys(JSON.parse(bundle.payload)).sort()).toEqual(['commands', 'signer']);
      }
    });

    it(`${personality}: send checks the signer's signature only, and another wallet's signature beside it grants nothing`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId } = await h.runRaise();
      const backer = h.backers[0]!;
      const tx = await h.sim.build({ kind: 'drawRelease', seriesId }, backer.address);
      // no signature, or only the issuer's: the signer has not signed
      await expectChainError(h.sim.send({ tx, signatures: {} }), 'Unauthorized');
      await expectChainError(h.sim.send({ tx, signatures: { [h.issuer.address]: `sim:${h.issuer.address}` } }), 'Unauthorized');
      // the signer's and the issuer's: the backer alone acts, so the issuer's own command is refused for it
      const both = { tx, signatures: { [backer.address]: `sim:${backer.address}`, [h.issuer.address]: `sim:${h.issuer.address}` } };
      await expectStage1Error(h.sim.send(both), 'NotIssuer');
      // built for the issuer and signed by it, the same command lands
      expect(types((await h.exec(h.issuer, { kind: 'drawRelease', seriesId })).events)).toEqual(['FundsReleased']);
    });
  }

  it('an attestor is a key, not a wallet: it signs Stage 1 digests and has nothing that signs a transaction', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    for (const a of h.attestors) {
      expect(a).not.toBeInstanceOf(SimWallet);
      expect('sign' in a || 'signMessage' in a).toBe(false);
      expect(a.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(await a.signDigest('0x' + '11'.repeat(32))).toMatch(/^0x[0-9a-f]{130}$/);
    }
  });
});
