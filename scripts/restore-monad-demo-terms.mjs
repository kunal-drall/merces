/** One-time insert-only repair of the original disposable Monad series document.
 * Run inside the Merces API service private network; default is read-only.
 * No signing, no chain writes, no unencrypted terms persisted.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {termsCommitment} from '../packages/domain/src/hashing.ts';
import {createPool} from '../packages/db/src/index.ts';
import {abiOf} from '../packages/chain-evm/src/abi.ts';
import {AesGcmVault} from '../packages/ports/src/vault-crypto.ts';
const require=createRequire(new URL('../packages/chain-evm/package.json',import.meta.url));
const {createPublicClient,http}=require('viem');
const record=JSON.parse(readFileSync(new URL('../deployment/monad-terms-restoration.json',import.meta.url)));
assert(process.env.MERCES_VAULT_KEY_HEX&&process.env.DATABASE_URL,'Existing service encryption and database configuration required');
const api=process.env;
const manifest={monad:{rpcUrl:'https://testnet-rpc.monad.xyz',contracts:{registry:record.registry}}};
const client=createPublicClient({transport:http(manifest.monad.rpcUrl,{timeout:15000,retryCount:1})});
assert.equal(await client.getChainId(),10143);
assert.equal(record.seriesId,'monad:1');assert.equal(record.terms.stablecoinMint.toLowerCase(),'0x534b2f3a21130d7a60830c2df862319e593943a3');
// These are the exact synthetic inputs used by run-monad-raise.mjs on October 12.
const terms={scheme:'poseidon5-v1',threshold:'1000000',shareRate:'0.1',ratePerUnitWad:'1000000000000000',reportingCurrency:'USD',currencyCode:840,indexingRule:'none',indexingRuleCode:0,termsSalt:'2026101202'};
const commitment=termsCommitment({theta:terms.threshold,rWad:terms.ratePerUnitWad,currency:terms.reportingCurrency,indexingRule:terms.indexingRule,termsSalt:terms.termsSalt});
assert.equal(commitment,record.terms.termsCommitment);
const abi=abiOf('Registry');
const head=await client.getBlock({blockTag:'finalized'});
const core=await client.readContract({address:manifest.monad.contracts.registry,abi:Array.isArray(abi)?abi:abi.abi,functionName:'getSeriesCore',args:[1n],blockNumber:head.number});
assert.equal(core.issuer.toLowerCase(),record.terms.issuer);assert.equal(core.termsCommitment,commitment);assert.equal(core.contractHash,record.terms.contractHash);
const pool=createPool();
try {
 const owner=(await pool.query("select account_id from account_wallets where chain='monad' and lower(address)=$1",[record.terms.issuer])).rows;
 assert.equal(owner.length,1);
 const current=(await pool.query('select d.draft_id,v.commitment from series_drafts d left join terms_vault v on v.draft_id=d.draft_id where d.series_id=$1 or v.series_id=$1',[record.seriesId])).rows;
 if(current.length){assert.equal(current.length,1);assert.equal(current[0].commitment,commitment);console.log(JSON.stringify({status:'already-restored',seriesId:record.seriesId,commitment}));}
 else if(!process.argv.includes('--apply'))console.log(JSON.stringify({status:'ready-to-restore',seriesId:record.seriesId,commitment,finalizedBlock:String(head.number),existingDocuments:0}));
 else {
  const draftId='restored-monad-testnet-series-1';
  const vault=new AesGcmVault(api.MERCES_VAULT_KEY_ID??'vault-dev-1',api.MERCES_VAULT_KEY_HEX);
  const ciphertext=vault.encrypt(JSON.stringify(terms),`terms:${draftId}`);
  assert.deepEqual(JSON.parse(vault.decrypt(ciphertext,`terms:${draftId}`)),terms);
  const publicTerms={...record.terms,raiseStyle:'sealed',reportingCurrency:'USD',capMultiple:'2.5',hurdle:'0.08',indexingRule:'none',restorationSource:'Original disposable testnet series; synthetic income terms; no real legal agreement.'};
  const c=await pool.connect();
  try {
   await c.query('begin');
   await c.query("select pg_advisory_xact_lock(hashtext('restore-monad-testnet-series-1'))");
   assert.equal((await c.query('select draft_id from terms_vault where series_id=$1',[record.seriesId])).rowCount,0);
   const indexed=(await c.query('select issuer,terms_commitment,contract_hash from series where series_id=$1 for share',[record.seriesId])).rows[0];
   assert.equal(indexed.issuer.toLowerCase(),record.terms.issuer);assert.equal(indexed.terms_commitment,commitment);assert.equal(indexed.contract_hash,record.terms.contractHash);
   await c.query("insert into series_drafts(draft_id,account_id,chain,issuer,public_terms,terms_commitment,contract_hash,series_id,state) values($1,$2,'monad',$3,$4,$5,$6,$7,'created')",[draftId,owner[0].account_id,record.terms.issuer,JSON.stringify(publicTerms),commitment,record.terms.contractHash,record.seriesId]);
   await c.query('insert into terms_vault(draft_id,series_id,ciphertext,key_id,commitment,version) values($1,$2,$3,$4,$5,1)',[draftId,record.seriesId,ciphertext,vault.keyId,commitment]);
   await c.query("insert into audit_log(actor,actor_role,action,target,detail) values('kunal-drall','admin','restore-original-testnet-terms',$1,$2)",[record.seriesId,JSON.stringify({commitment,source:'evidence/monad-raise.json and scripts/run-monad-raise.mjs',finalizedBlock:String(head.number),syntheticIncome:true,transactionsSent:false})]);
   await c.query('commit');
   console.log(JSON.stringify({status:'restored',seriesId:record.seriesId,commitment,finalizedBlock:String(head.number),transactionsSent:false}));
  }catch(error){await c.query('rollback');throw error;}finally{c.release();}
 }
}finally{await pool.end();}
