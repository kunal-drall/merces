import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { generateKeyPairSync,createHash,publicEncrypt,randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { createTestSchema,dbTestsEnabled } from '@merces/db';
import { signingDomain } from '@merces/domain';
import { LocalKms, vaultFromEnv } from '@merces/ports';
import { LocalOperator } from '../src/local-operator/service.ts';
import { operatorCommand } from '../src/local-operator/policy.ts';
import { openOperatorEnvelope } from '../../report-verifier/src/relay-crypto.ts';
import type { ServiceContext } from '../src/context.ts';
const wallet='0x399b989DD6D6bd3258D44A6ab049af3cb8265A24';
const policy={wallets:[{chain:'monad' as const,address:wallet}],series:['monad:1']};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'}),pin={kty:'RSA' as const,n:jwk.n!,e:'AQAB' as const};

describe('local operator policy and private transport',()=>{
  it('allows only named test wallets, series and service commands',()=>{
    expect(operatorCommand(policy,'monad','allowlistManager',{kind:'setAllowlist',wallet,allowed:true}).kind).toBe('setAllowlist');
    for(const [chain,role,cmd]of [
      ['ethereum','keeper',{kind:'syncCurveUnits',seriesId:'monad:1'}],
      ['monad','keeper',{kind:'setAllowlist',wallet,allowed:true}],
      ['monad','allowlistManager',{kind:'setAllowlist',wallet:'0x'+'1'.repeat(40),allowed:true}],
      ['monad','keeper',{kind:'crankStatus',seriesId:'monad:2'}],
      ['monad','keeper',{kind:'drawRelease',seriesId:'monad:1'}],
      ['monad','keeper',{kind:'snapshotRate',pair:'USD/EUR',rateWad:'1',confWad:'0',publishTime:0,update:null}],
      ['monad','keeper',{kind:'crankStatus',seriesId:'monad:1',to:wallet}],
    ]as const) expect(()=>operatorCommand(policy,chain,role,cmd)).toThrow();
  });
  it('keeps input and output opaque, authenticates the job id and rejects tampering',()=>{
    const id='canary-job',key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('merces/operator/request/v1:'+id));
    const secret={incomeYtd:'6161616161',incomeSalt:'9191919191'};
    const envelope={wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(secret)),cipher.final(),cipher.getAuthTag()]).toString('base64')};
    const pem=privateKey.export({format:'pem',type:'pkcs8'}).toString();
    expect(JSON.stringify(envelope)).not.toContain(secret.incomeYtd);
    expect(()=>openOperatorEnvelope(pem,'another-job',envelope)).toThrow();
    const opened=openOperatorEnvelope(pem,id,envelope);expect(opened.value).toEqual(secret);
    const result=opened.seal(secret);expect(JSON.stringify(result)).not.toContain(secret.incomeSalt);
    const sealed=Buffer.from(result.ciphertext,'base64'),decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(result.iv,'base64'));
    decipher.setAAD(Buffer.from('merces/operator/reply/v1:'+id));decipher.setAuthTag(sealed.subarray(-16));
    expect(JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]).toString())).toEqual(secret);
    expect(()=>openOperatorEnvelope(pem,id,{...envelope,ciphertext:Buffer.from('tampered').toString('base64')})).toThrow();
  });
});

describe.skipIf(!dbTestsEnabled())('local operator durable queue',()=>{
  let db:Awaited<ReturnType<typeof createTestSchema>>,op:LocalOperator,info:any;
  beforeAll(async()=>{
    db=await createTestSchema();
    const kms=new LocalKms('local-operator-test-secret-'.repeat(3),{v:'secp256k1'}),address=await kms.signerAddress('v');
    info={address,publicKeyHex:(await kms.publicKey('v')).publicKeyHex,previous:[],syntheticIncome:{testOnly:true,notice:'test only'},chains:[{chain:'monad',domain:signingDomain('evm',10143,'0x'+'1'.repeat(40))}]};
    const signature=await kms.signDigest('v','0x'+createHash('sha256').update('merces/local-verifier-key/v1:'+JSON.stringify(pin)).digest('hex'));
    info.transport={kind:'local-operator-v1',encryptionKey:pin,encryptionSignature:signature};
    const ctx={pool:db.pool,vault:vaultFromEnv({}, {simulatorOnly:true}),chains:{chains:new Map([['monad',{chain:'monad',info:async()=>({signing:info.chains[0].domain})}]])}} as unknown as ServiceContext;
    op=new LocalOperator(ctx,'x'.repeat(64),policy,pin,address);
  });
  afterAll(async()=>db?.drop());
  it('rejects missing credentials and refuses queued work while offline',async()=>{
    expect(()=>op.authenticate('Bearer wrong')).toThrow();expect(()=>op.authenticate(undefined)).toThrow();expect(()=>op.authenticate('Bearer '+'x'.repeat(64))).not.toThrow();
    expect((await op.status()).online).toBe(false);
    await expect(op.enqueueVerifier('alice',crypto.randomUUID(),{seriesId:'monad:1',envelope:{v:1,wrappedKey:'AAAA',iv:'AAAA',ciphertext:'AAAA'}})).rejects.toMatchObject({status:503});
  });
  it('binds the encryption key, leases once and isolates results by account and lease',async()=>{
    await expect(op.poll({...info,transport:{...info.transport,encryptionSignature:'0x'+'00'.repeat(65)}})).rejects.toMatchObject({status:403});
    await op.poll(info,false);expect((await op.keys()).transport?.encryptionKey).toEqual(pin);
    const id=crypto.randomUUID();await op.enqueueVerifier('alice',id,{seriesId:'monad:1',envelope:{v:1,wrappedKey:'AAAA',iv:'AAAA',ciphertext:'AAAA'}});
    await expect(op.reply('bob',id)).rejects.toMatchObject({status:404});
    const leases=await Promise.all([op.poll(info),op.poll(info)]),jobs=leases.filter(r=>r.job);expect(jobs).toHaveLength(1);
    expect((await op.finish(id,crypto.randomUUID(),{ciphertext:'wrong'})).accepted).toBe(false);
    expect((await op.finish(id,jobs[0]!.job.lease,{ciphertext:'opaque'})).accepted).toBe(true);
    expect((await op.finish(id,jobs[0]!.job.lease,{ciphertext:'replay'})).accepted).toBe(false);
    expect((await op.reply('alice',id)).result).toEqual({ciphertext:'opaque'});
  });
  it('encrypts provider queue payloads and results and requires explicit real-provider activation',async()=>{
    const job={operation:'esign.create' as const,params:{sessionId:'contract-1',signerAccountId:'alice',documents:[{name:'Agreement',body:'private-contract-canary'}]}};
    await expect(op.provider(job)).rejects.toMatchObject({status:503});
    vi.stubEnv('MERCES_LOCAL_PROVIDERS','true');
    try{
      await op.poll({...info,syntheticIncome:undefined},false);
      await expect(op.poll(info,false)).rejects.toMatchObject({status:403});
      const pending=op.provider(job);
      await vi.waitFor(async()=>expect((await db.pool.query("select 1 from local_operator_jobs where kind='provider'")).rowCount).toBe(1));
      const stored=(await db.pool.query("select payload from local_operator_jobs where kind='provider'")).rows[0];
      expect(JSON.stringify(stored.payload)).not.toContain('private-contract-canary');
      const lease=await op.poll({...info,syntheticIncome:undefined});expect(lease.job.payload).toEqual(job);
      await op.finish(lease.job.id,lease.job.lease,{envelopeId:'provider-1',signingUrl:'https://example.invalid/private-signing-link'});
      expect(await pending).toEqual({envelopeId:'provider-1',signingUrl:'https://example.invalid/private-signing-link'});
      const result=(await db.pool.query('select result from local_operator_jobs where id=$1',[lease.job.id])).rows[0];
      expect(JSON.stringify(result)).not.toContain('private-signing-link');
    }finally{vi.unstubAllEnvs();}
  });
});
