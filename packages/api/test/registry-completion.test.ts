import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {dbTestsEnabled} from '@merces/db';
import {defaultTerms} from '@merces/simulator';
import type {UnsignedTx} from '@merces/domain';
import {makeRig} from './helpers.ts';
describe.skipIf(!dbTestsEnabled())('registry completion API',()=>{
 let rig:Awaited<ReturnType<typeof makeRig>>,issuerToken:string,adminToken:string;
 beforeAll(async()=>{rig=await makeRig();await rig.sol.exec(rig.sol.admin,{kind:'registerIssuer',wallet:rig.sol.issuer.address});issuerToken=rig.token({accountId:'registry-issuer',roles:['issuer'],wallets:[{chain:'solana',address:rig.sol.issuer.address}]});adminToken=rig.token({accountId:'registry-admin',roles:['admin'],wallets:[{chain:'solana',address:rig.sol.admin.address}]});});
 afterAll(async()=>{await rig.close();});
 it('binds only a matching signed draft and projects its confirmed contract hash',async()=>{
  const terms=defaultTerms(rig.sol.sim).terms,created=await rig.sol.exec(rig.sol.issuer,{kind:'createSeries',terms}),seriesId=(created.events[0]!.payload as {seriesId:string}).seriesId,hash='0x'+'bc'.repeat(32);
  await rig.sync();
  await rig.t.pool.query('insert into series_drafts (draft_id,account_id,chain,issuer,public_terms,state,contract_hash,terms_commitment) values ($1,$2,$3,$4,$5,$6,$7,$8)',['registry-draft','registry-issuer','solana',rig.sol.issuer.address,{},'contract_signed',hash,terms.termsCommitment]);
  const built=await rig.post('/drafts/registry-draft/build-contract-hash',{seriesId},issuerToken);expect(built.statusCode,built.body).toBe(200);const tx=built.json().tx as UnsignedTx;expect(tx.command).toEqual({kind:'setContractHash',seriesId,contractHash:hash});
  expect((await rig.post('/tx/send',{tx,signatures:{[rig.sol.issuer.address]:`sim:${rig.sol.issuer.address}`}},issuerToken)).statusCode).toBe(200);await rig.sync();
  expect((await rig.t.pool.query('select contract_hash from series where series_id=$1',[seriesId])).rows[0].contract_hash).toBe(hash);
  await rig.t.pool.query("update series_drafts set terms_commitment=$1 where draft_id='registry-draft'",['0x'+'ab'.repeat(32)]);expect((await rig.post('/drafts/registry-draft/build-contract-hash',{seriesId},issuerToken)).statusCode).toBe(409);
 });
 it('proposes issuer deactivation for the admin wallet and indexes the confirmed state',async()=>{
  const input={chain:'solana',wallet:rig.sol.issuer.address};expect((await rig.post('/admin/issuers/deactivate',input,issuerToken)).statusCode).toBe(403);
  const built=await rig.post('/admin/issuers/deactivate',input,adminToken);expect(built.statusCode,built.body).toBe(201);const tx=built.json().tx as UnsignedTx;expect(tx.command).toEqual({kind:'deactivateIssuer',wallet:input.wallet});
  expect((await rig.post('/tx/send',{tx,signatures:{[rig.sol.admin.address]:`sim:${rig.sol.admin.address}`}},adminToken)).statusCode).toBe(200);await rig.sync();
  expect((await rig.t.pool.query('select active from issuers where chain=$1 and issuer=$2',['solana',input.wallet])).rows[0].active).toBe(false);
 });
});
