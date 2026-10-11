// Composes 26_final_share_open_ask.json from Stage 1's vector 22 and the claim path of the Merces backend's scenario S3l,
// with both chains' values at the two expects (DIV-S1I-1-final-share-open-ask.md). Run from the Merces repository root:
//   pnpm exec tsx packages/stage1-sync/scripts/compose-vector-26.mts
// It runs Stage 1's own reference simulator over the composed steps, checks the reference's figures are the ones the report
// names, and writes the vector with b1's balance and the vault corrected by the 40 escrowed units' share (1,050 USDC).
// Stage 1 should regenerate the file from packages/reference/src/vectors once its reference counts the ask escrow.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Simulator } from '@merces/reference';
import { addressFromPrivateKey } from '@merces/math';
import { deriveTestPrivateKey } from '@merces/math/testing';

const WT = process.cwd();
const base = JSON.parse(readFileSync(`${WT}/stage1/packages/vectors/22_late_holder_tail_final.json`, 'utf8'));
const NAME = '26_final_share_open_ask';
const T = '1817331600';
const DELTA = 1_050_000_000n; // 40 escrowed units x 26.25 USDC

const own1 = [
  { t: T, note: "redeemed while b1's 40-unit ask is still in the window escrow (its window is in Reveal, not cleared); unitsAtRedemption 400 includes those 40", op: 'redeem', actor: 'issuer', series: 'S2' },
  { t: T, note: 'the 4th tranche (vests Jan 2028) is still unreleased: 10,500 USDC move to the vault as the final pool over the 400 units at redemption, 26.25 USDC a unit', op: 'extinguish', series: 'S2', attestors: ['attestor1', 'attestor2'] },
  { t: T, note: "b1 holds 60 units and has 40 in an uncleared ask: the claim redeems the 60 first (60 x P_redeem + pending), then pays the final share on weight 100 = redeemed_units 60 + ask-escrow units 40 (MercesVault.sol:658, claims.rs:486-490): 2,625 USDC, the same as every other 100-unit holder", op: 'claim_final', actor: 'b1', series: 'S2' },
];
const own2 = [
  { t: T, note: "the window ended NoMatch and returned b1's 40 units: this claim redeems them at P_redeem with a final share of 0 (b1's share was paid in full on weight 100)", op: 'claim_final', actor: 'b1', series: 'S2' },
  { t: T, note: 'b2, b3 and b4 each redeem 100 units inside claim_final and are paid 100/400 of the final pool: 2,625 USDC', op: 'claim_final', actor: 'b2', series: 'S2' },
  { t: T, op: 'claim_final', actor: 'b3', series: 'S2' },
  { t: T, op: 'claim_final', actor: 'b4', series: 'S2' },
];

const A = structuredClone(base.steps.slice(0, 71));
const B = structuredClone(base.steps.slice(79, 84));
const C = structuredClone(base.steps.slice(84, 87));
const sim = new Simulator({ flags: base.config.flags, verifyProofs: false });
const run = async (steps: any[]) => {
  for (const s of steps) await sim.apply(s);
};
await run(A);
await run(B);
await run(own1);
const snap1: any = sim.expect('S2', {});
await run(C);
await run(own2);
const snap2: any = sim.expect('S2', {});

const patch = (snap: any, note: string) => {
  const out: any = { t: T, ...structuredClone(snap) };
  out.balances.b1.stable = (BigInt(out.balances.b1.stable) + DELTA).toString();
  out.vault = (BigInt(out.vault) - DELTA).toString();
  out.note = note;
  return out;
};
// sanity: the reference's figures are the ones our scenario S3l records
const check = (a: unknown, b: string, what: string) => {
  if (a !== b) throw new Error(`${what}: ${a} != ${b}`);
};
check(snap1.balances.b1.stable, '69260161480', 'ref b1 after first claim');
check(snap1.vault, '54517581720', 'ref vault after first claim');
check(snap2.balances.b1.stable, '73986935800', 'ref b1 final');
check(snap2.vault, '1050000000', 'ref vault final');

const expect1 = patch(snap1, 'both chains: b1 is paid 60 x 118.169358 (its 60 redeemed units) + 1,805 pending + 2,625 final share (weight 100); the vault holds the rest. The reference simulator pays a 1,575 final share (weight 60): b1 1,050 USDC lower, the vault 1,050 USDC higher');
const expect2 = patch(snap2, "every unit claimed: each 100-unit holder received exactly 2,625 USDC of the 10,500 USDC final pool and the vault is empty. The reference simulator leaves 1,050,000,000 base units (the 40 escrowed units' share) in the vault for good");

const keys: Record<string, unknown> = {};
for (const [name, role] of [['attestor1', 'attestor'], ['attestor2', 'attestor'], ['verifier1', 'verifier']] as const) {
  const seed = `${NAME}:${name}`;
  const priv = deriveTestPrivateKey(seed);
  keys[name] = {
    seed,
    derivation: 'keccak256("MERCES_TEST_KEY" ‖ utf8(seed)) mod (secp256k1_n − 1) + 1',
    privateKey: '0x' + Buffer.from(priv).toString('hex'),
    address: '0x' + Buffer.from(addressFromPrivateKey(priv)).toString('hex'),
    role,
  };
}

const vector = {
  name: NAME,
  description:
    "A holder of a Redeemed-then-Extinguished series that has part of its units in an uncleared transfer-window ask must receive the same final share per unit as every other holder, and the vault must end empty (SPEC §6.1: units in a protocol escrow never strand a distribution; §6.9). On vector 22's bootstrap, raises, reports and payments (steps #0-#70) and S2's window up to its reveals (22's #79-#83: b1 asks 40 of its 100 units, b5 bids for them), S2 is redeemed with the ask still open (unitsAtRedemption 400) and extinguished (10,500 USDC unreleased → 26.25 USDC a unit). b1's claim_final redeems its 60 free units and is paid the final share on 100 units (60 redeemed + 40 in the ask's escrow): 2,625 USDC, as both chain programs weigh it (evm/src/MercesVault.sol:654-658, solana/programs/merces_protocol/src/claims.rs:472-490). The window then ends NoMatch on the terminal series (22's #84-#86) and returns the 40 units; b1's second claim_final redeems them at P_redeem with a share of 0; b2, b3 and b4 claim 2,625 USDC each; the vault ends at 0. The TypeScript reference simulator (packages/reference/src/sim/simulator.ts:1456-1460) weighs b1's share on its 60 redeemed units only (1,575 USDC) and marks the share claimed, so 1,050 USDC stay in its vault for good: it fails this vector at the first expect (#79). Composed by hand from vector 22 by the Merces backend team (DIV-S1I-1); keys seeded `26_final_share_open_ask:<name>`.",
  schema: 2,
  specVersion: '1.1',
  generatedBy: 'composed by hand from 22_late_holder_tail_final.json (steps #0-#70 and #79-#86, as generated) with the claim steps of the Merces backend scenario S3l; expect values are both chain programs\' (the reference simulator\'s at every field but balances.b1.stable and vault). To be regenerated by packages/reference/src/vectors/generate.ts once the reference counts the ask escrow (see DIV-S1I-1-final-share-open-ask.md)',
  config: base.config,
  actors: base.actors,
  keys,
  seriesPrivate: base.seriesPrivate,
  steps: [...A, ...B, ...own1, expect1, ...C, ...own2, expect2],
};
mkdirSync(`${WT}/docs/stage1/defects/vectors`, { recursive: true });
writeFileSync(`${WT}/docs/stage1/defects/vectors/${NAME}.json`, JSON.stringify(vector, null, 2) + '\n');
console.log(`wrote ${NAME}.json: ${vector.steps.length} steps; expect at #${A.length + B.length + own1.length} and #${vector.steps.length - 1}`);
console.log('keys', Object.fromEntries(Object.entries(keys).map(([k, v]: any) => [k, v.address])));
console.log('ref snap1 b1/vault', snap1.balances.b1.stable, snap1.vault, '-> chains', expect1.balances.b1.stable, expect1.vault);
console.log('ref snap2 b1/vault', snap2.balances.b1.stable, snap2.vault, '-> chains', expect2.balances.b1.stable, expect2.vault);
console.log('expect keys', Object.keys(expect1).join(','));
