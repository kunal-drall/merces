/**
 * demo:cycle — one complete raise-to-payout cycle on the simulator for BOTH personalities, through the real
 * services and API, with Stripe test-mode-shaped data and no manual steps. Exit code 0 means Stage 2's
 * pre-Stage-1 acceptance condition holds.
 */
import { createTestSchema } from '@merces/db';
import { buildApp, issueSession, makeContext } from '@merces/api';
import { createServiceContext, serviceRoutes } from '@merces/services';
import { Indexer } from '@merces/indexer';
import { Groth16ReportVerifier, LocalKms, MockESign, MockIdentityCheck, MockZkTls, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier } from '@merces/report-verifier';
import { MemoryIncomeChain, assembleOnDevice, choosePrior } from '@merces/poi-device';
import { stripeFixtureFor, stripeGrossUntil } from '@merces/fixtures';
import { parsePeriod } from '@merces/math';
import { SimHarness, SimulatorChain, type Personality } from '@merces/simulator';
import type { ChainRegistry } from '@merces/chains';
import type { UnsignedTx } from '@merces/domain';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const GENESIS = Date.UTC(2026, 0, 1) / 1000;
const out: string[] = [];
const say = (s: string) => {
  out.push(s);
  console.log(s);
};

const t = await createTestSchema();
// the issuer's device proves with Stage 1's prover; the chains (like the API) verify Stage 1 Groth16 proofs and accept no mock
const groth16 = new Groth16ReportVerifier();
const sol = await SimHarness.create('solana', { sim: SimulatorChain.createSync({ personality: 'solana', chainKey: 'solana', genesis: GENESIS, reportProofVerifier: groth16 }) });
const mon = await SimHarness.create('monad', { sim: SimulatorChain.createSync({ personality: 'monad', chainKey: 'monad', genesis: GENESIS, reportProofVerifier: groth16 }) });
const chains: ChainRegistry = { chains: new Map([['solana', sol.sim], ['monad', mon.sim]]), decisions: [], stage1: null, get: (c: string) => (c === 'solana' ? sol.sim : mon.sim), byFamily: (f: string) => (f === 'solana' ? sol.sim : mon.sim), close: async () => undefined };
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
const zktls = new MockZkTls();
const kms = new LocalKms('demo-seed', { 'report-verifier-demo': 'ed25519' });
const verifier = new ReportVerifier(zktls, kms, 'report-verifier-demo');
const spki = await kms.spkiHex('report-verifier-demo');
for (const h of [sol, mon]) await h.exec(h.admin, { kind: 'registerVerifierKey', keyId: 'report-verifier-demo', publicKey: spki, active: true });
const ctx = createServiceContext(makeContext({ pool: t.pool, chains, log: silent, sessionSecret: 'demo', devMode: true }), { esign: new MockESign(), identity: new MockIdentityCheck(), zktls, kms, verifier, reportVerifierUrl: 'in-process' });
const app = await buildApp(ctx, serviceRoutes);
await app.ready();
const indexer = new Indexer(t.pool, [sol.sim, mon.sim], { logger: silent });
const token = (accountId: string, wallets: { chain: string; address: string }[], roles: ('issuer' | 'backer' | 'admin' | 'attestor')[]) => issueSession('demo', { accountId, wallets, roles, eligible: true, exp: Math.floor(Date.now() / 1000) + 3600 });
const api = async (method: 'GET' | 'POST' | 'PUT', url: string, tok?: string, body?: unknown) => {
  const r = await app.inject({ method, url, headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload: body as Record<string, unknown> | undefined });
  if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
  return r.json();
};

let failures = 0;
for (const personality of ['solana', 'monad'] as Personality[]) {
  const h = personality === 'solana' ? sol : mon;
  say(`\n=== ${personality} ===`);
  const issuerTok = token(`issuer-${personality}`, [{ chain: h.sim.chain, address: h.issuer.address }], ['issuer']);
  const raise = await h.runRaise();
  await indexer.catchUp();
  const series = await api('GET', `/series/${raise.seriesId}`);
  say(`raise settled: ${series.unitsOutstanding} units at ${series.issuePrice} base units; cap/unit ${series.capPerUnit}`);
  const treasury = await api('GET', `/series/${raise.seriesId}/treasury`, issuerTok);
  say(`treasury ${treasury.total}; released ${treasury.released}`);
  const fixture = stripeFixtureFor(`demo-${personality}`, 2026, [USDC(25_000), USDC(50_000), USDC(75_000), USDC(100_000)]);
  // the private terms as the vault discloses them to the issuer: the opening of the Poseidon terms commitment
  const privateTerms = { threshold: raise.privateTerms.theta.toString(), ratePerUnitWad: raise.privateTerms.rWad.toString(), reportingCurrency: 'USD', indexingRule: raise.privateTerms.indexingRule, termsSalt: raise.privateTerms.termsSalt.toString() };
  // the device keeps its income chain (openings and attestations) for the next quarter's prior (never sent to the API)
  const incomeChain = new MemoryIncomeChain();
  for (const q of ['2026Q1', '2026Q2', '2026Q3']) {
    const period = parsePeriod(q);
    await h.sim.setTime(period.end + 86_400);
    const sess = await api('POST', `/series/${raise.seriesId}/reporting/zktls-session`, issuerTok, { periodId: q, source: 'stripe' });
    const ytd = stripeGrossUntil(fixture, period.end) * 10_000n;
    const proof = zktls.prove({ source: 'stripe', seriesId: raise.seriesId, periodId: q, figure: ytd, currency: 'USD', coversUntil: period.end, owner: h.issuer.address, sessionId: sess.sessionId });
    const expected = await api('GET', `/series/${raise.seriesId}/reporting/prior?periodId=${q}`);
    const prior = choosePrior(incomeChain, raise.seriesId, q, expected.expectedPriorIncomeCommitment);
    const { assembled, entry } = await assembleOnDevice({ seriesId: raise.seriesId, periodId: q, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: series.unitsOutstanding, privateTerms, prior, incomeYtdNow: ytd, fxAvgWad: 10n ** 18n, tier: 2, source: 'stripe', zktlsProof: proof, deviceSecret: `demo-device-${personality}` }, verifier);
    incomeChain.put(entry);
    const rep = await api('POST', `/series/${raise.seriesId}/reports`, issuerTok, assembled);
    const sent = await api('POST', '/tx/send', issuerTok, await h.issuer.sign(rep.tx as UnsignedTx));
    const due = sent.events.find((e: { type: string }) => e.type === 'ReportAccepted').payload.paymentDue as string;
    await api('POST', `/reports/${rep.reportId}/submitted`, issuerTok, { txId: sent.txId });
    if (due !== '0') {
      const pay = await api('POST', `/reports/${rep.reportId}/build-payin`, issuerTok);
      const paid = await api('POST', '/tx/send', issuerTok, await h.issuer.sign(pay.tx as UnsignedTx));
      await api('POST', `/reports/${rep.reportId}/paid`, issuerTok, { txId: paid.txId });
    }
    // the income figure itself is never printed: only the onchain-public payment is (Part B)
    say(`${q}: ProofOfIncome (Stage 1 Groth16) accepted → payment due ${due} base units (${(Number(due) / 1e6).toFixed(2)} USDC)`);
  }
  await indexer.catchUp();
  const backer = h.backers[0]!;
  const backerTok = token(`backer-${personality}`, [{ chain: h.sim.chain, address: backer.address }], ['backer']);
  const holdings = await api('GET', '/me/holdings', backerTok);
  const claimTx = await h.sim.build({ kind: 'claimPayout', seriesId: raise.seriesId }, backer.address);
  const claimed = await api('POST', '/tx/send', backerTok, await backer.sign(claimTx));
  const amount = claimed.events[0].payload.amount as string;
  say(`backer-1 holds ${holdings.holdings[0].units} units; claimed ${amount} base units (${(Number(amount) / 1e6).toFixed(2)} USDC)`);
  const expected = USDC(1500) * 95n / 100n / 5n;
  if (BigInt(amount) !== expected) {
    failures++;
    say(`MISMATCH: expected ${expected}`);
  }
  await indexer.catchUp();
  const activity = await api('GET', `/series/${raise.seriesId}/activity?limit=3`);
  say(`public activity (no amounts): ${activity.activity.map((a: { summary: string }) => a.summary).join(' | ')}`);
  const fees = await t.pool.query('select kind, sum(amount)::text as total from fees_ledger where series_id = $1 group by kind order by kind', [raise.seriesId]);
  say(`fees: ${fees.rows.map((r) => `${r.kind}=${r.total}`).join(', ')}`);
}
await app.close();
await t.drop();
// snarkjs' worker threads (proving and verifying) would otherwise keep the process alive
await shutdownProofSystem();
say(failures ? `\nDEMO FAILED (${failures} mismatch)` : '\nDEMO OK: raise → treasury → three quarterly ProofOfIncome reports with Stripe data → payouts claimed, on both personalities, no manual steps.');
process.exit(failures ? 1 : 0);
