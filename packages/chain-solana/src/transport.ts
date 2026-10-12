import {createPublicKey,verify} from 'node:crypto';
import {creationSigners} from './creation-signers.ts';
import {Connection,Message,PublicKey,Transaction,type AccountInfo} from '@solana/web3.js';
import bs58 from 'bs58';
import {ChainError,stage1ChainError,type SignedTx,type TxResult} from '@merces/domain';
import {decodeAccount,decodeEvent,decodeInstruction,idlOf,type Row,type SolModule} from './codec.ts';
import {programOf,TOKEN,TOKEN_2022} from './accounts.ts';
import type {SolanaChainConfig} from './config.ts';
export interface SolRecord {module:SolModule;name:string;args:Row;slot:number;transactionIndex:number;logIndex:number;ordinal:number;invocation?:number;txId:string;blockTime:number;}
export interface SolAccount {address:string;module:SolModule;type:string;value:Row;}
export interface SolInput {module:SolModule;name:string;args:Row;accounts:Record<string,string>;}
export function solanaError(error:unknown):ChainError {
  if(error instanceof ChainError)return error;
  // Extract only the symbolic name. Logs can contain proof bytes or income: never forward them to the API.
  const value=error as {logs?:string[];message?:string};
  const match=value.logs?.map((l)=>l.match(/Error Code: ([A-Za-z][A-Za-z0-9_]+)/)?.[1]).find(Boolean);
  return match?stage1ChainError(match):new ChainError('ChainSpecific','Solana RPC operation failed');
}
export class SolanaTransport {
  private events:SolRecord[]=[];
  private loadedThrough=-1;
  private loading:Promise<void>|null=null;
  private transactions=new Map<string,Awaited<ReturnType<Connection['getTransaction']>>>();
  private pendingBlocks=new Map<number,string[]>();
  constructor(readonly config:SolanaChainConfig,readonly connection:Connection,readonly verifyNetwork:()=>Promise<void>){}
  async head(){await this.verifyNetwork();const slot=await this.connection.getSlot('finalized'),time=await this.connection.getBlockTime(slot);if(time===null)throw new ChainError('ChainSpecific','finalized slot has no block time');return {slot,time};}
  async raw(address:string):Promise<AccountInfo<Buffer>|null>{await this.verifyNetwork();return this.connection.getAccountInfo(new PublicKey(address),'finalized');}
  async account(address:string,type?:string):Promise<SolAccount|null>{
    const raw=await this.raw(address);if(!raw)return null;
    const module=(['registry','protocol','hook'] as const).find((m)=>raw.owner.toBase58()===programOf(this.config,m));if(!module)throw new ChainError('ChainSpecific','protocol account has an unexpected owner');
    const decoded=decodeAccount(module,raw.data);if(!decoded||type&&decoded.type!==type)throw new ChainError('ChainSpecific','protocol account discriminator differs from the pinned IDL');
    return {address,module,...decoded};
  }
  async scan(module:SolModule,type:string):Promise<SolAccount[]>{
    await this.verifyNetwork();const discriminator=idlOf(module).accounts.find((a)=>a.name===type)?.discriminator;if(!discriminator)throw new ChainError('ChainSpecific','unknown account type');
    const found=await this.connection.getProgramAccounts(new PublicKey(programOf(this.config,module)),{commitment:'finalized',filters:[{memcmp:{offset:0,bytes:bs58.encode(discriminator)}}]});
    return found.map(({pubkey,account})=>{const decoded=decodeAccount(module,account.data);if(!decoded||decoded.type!==type)throw new ChainError('ChainSpecific','RPC returned an unexpected account');return {address:pubkey.toBase58(),module,...decoded};});
  }
  async tokenBalance(address:string,mint?:string):Promise<bigint>{const account=await this.raw(address);if(!account)return 0n;if(![TOKEN,TOKEN_2022].includes(account.owner.toBase58())||account.data.length<165||mint&&new PublicKey(account.data.subarray(0,32)).toBase58()!==mint)throw new ChainError('ChainSpecific','invalid token account owner, mint or layout');return account.data.readBigUInt64LE(64);}
  async history():Promise<SolRecord[]>{
    const {slot}=await this.head();while(this.loadedThrough<slot){if(this.loading){await this.loading;continue;}this.loading=this.load(slot).finally(()=>{this.loading=null;});await this.loading;}return this.events.filter((e)=>e.slot<=slot);
  }
  private async load(through:number):Promise<void>{
    const signatures=new Map<string,number>();
    for(const module of ['registry','protocol','hook'] as const){
      let before:string|undefined;
      for(;;){
        const page=await this.connection.getSignaturesForAddress(new PublicKey(programOf(this.config,module)),{before,limit:1000},'finalized');if(!page.length)break;
        let reached=false;
        for(const sig of page){if(sig.slot<this.config.startSlot||sig.slot<=this.loadedThrough){reached=true;break;}if(!sig.err&&sig.slot<=through)signatures.set(sig.signature,sig.slot);}
        if(reached||page.length<1000)break;before=page.at(-1)!.signature;
      }
    }
    const order=new Map<number,string[]>();
    for(const slot of new Set(signatures.values())){
      let signatures=this.pendingBlocks.get(slot);
      if(!signatures){
        const block=await this.connection.getBlockSignatures(slot,'finalized');
        if(!block)throw new ChainError('ChainSpecific','finalized transaction block is unavailable; use an archive RPC');
        signatures=block.signatures;this.pendingBlocks.set(slot,signatures);
      }
      order.set(slot,signatures);
    }
    const sorted=[...signatures].sort(([a,sa],[b,sb])=>sa-sb||order.get(sa)!.indexOf(a)-order.get(sb)!.indexOf(b));
    const additions:SolRecord[]=[];
    for(const [txId,slot] of sorted){
      const tx=this.transactions.get(txId)??await this.connection.getTransaction(txId,{commitment:'finalized',maxSupportedTransactionVersion:0});
      if(!tx||!tx.meta||tx.blockTime==null)throw new ChainError('ChainSpecific','finalized transaction data is unavailable; use an archive RPC');
      if(tx.meta.err)continue;
      if(!tx.meta.logMessages||tx.meta.logMessages.some((line)=>/log truncated/i.test(line)))throw new ChainError('ChainSpecific','complete transaction logs are unavailable; use an archive RPC');
      const index=order.get(slot)!.indexOf(txId);if(index<0)throw new ChainError('ChainSpecific','transaction is absent from its finalized block');
      this.transactions.set(txId,tx);const stack:string[]=[],frames:number[]=[];let invocation=0;
      for(const [logIndex,line] of (tx.meta.logMessages??[]).entries()){
        const invoke=line.match(/^Program (\S+) invoke \[(\d+)\]$/);if(invoke){stack.length=Number(invoke[2])-1;stack.push(invoke[1]!);frames.length=stack.length-1;frames.push(invocation++);continue;}
        if(/^Program \S+ (success|failed:)/.test(line)){stack.pop();frames.pop();continue;}
        if(!line.startsWith('Program data: '))continue;
        const module=(['registry','protocol','hook'] as const).find((m)=>programOf(this.config,m)===stack.at(-1));if(!module)continue;
        const event=decodeEvent(module,Buffer.from(line.slice(14),'base64'));if(!event)throw new ChainError('ChainSpecific','unknown protocol event; run stage1:sync');
        additions.push({module,...event,slot,transactionIndex:index,logIndex,ordinal:this.events.length+additions.length,invocation:frames.at(-1),txId,blockTime:tx.blockTime});
      }
    }
    this.events.push(...additions);this.loadedThrough=through;this.pendingBlocks.clear();
  }
  async inputs(txId:string):Promise<SolInput[]>{
    const tx=this.transactions.get(txId)??await this.connection.getTransaction(txId,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx)throw new ChainError('ChainSpecific','transaction data is unavailable');
    const message=tx.transaction.message;
    // v0 loaded addresses are supplied by the finalized transaction metadata, not a mutable lookup-table read.
    const accountKeys=message.getAccountKeys({accountKeysFromLookups:tx.meta?.loadedAddresses});
    const outer=message.compiledInstructions;
    const ordered:typeof outer[number][]=[];
    for(const [index,ix] of outer.entries()){
      ordered.push(ix);
      for(const inner of tx.meta?.innerInstructions?.find((i)=>i.index===index)?.instructions??[])ordered.push({programIdIndex:inner.programIdIndex,accountKeyIndexes:inner.accounts,data:bs58.decode(inner.data)});
    }
    const out:SolInput[]=[];
    for(const ix of ordered){
      const module=(['registry','protocol','hook'] as const).find((m)=>programOf(this.config,m)===accountKeys.get(ix.programIdIndex)?.toBase58());if(!module)continue;
      const decoded=decodeInstruction(module,Buffer.from(ix.data));if(!decoded)continue;const definition=idlOf(module).instructions.find((i)=>i.name===decoded.name)!;
      const accounts=Object.fromEntries(definition.accounts.map((a,i)=>[a.name,accountKeys.get(ix.accountKeyIndexes[i]!)!.toBase58()]));out.push({module,...decoded,accounts});
    }
    return out;
  }
  /** Payload is the legacy message; the wallet supplies its raw Ed25519 signature (hex, base58, or base64). */
  async send(signed:SignedTx):Promise<TxResult>{
    await this.verifyNetwork();const tx=signed.tx;
    if(tx.chain!==this.config.chain||tx.family!=='solana'||tx.encoding!=='solana-base64')throw new ChainError('Unauthorized','transaction belongs to another chain');
    let message:Message,raw:Buffer;
    try { raw=Buffer.from(tx.payload,'base64');message=Message.from(raw); }
    catch { throw new ChainError('Unauthorized','invalid transaction message'); }
    const required=message.accountKeys.slice(0,message.header.numRequiredSignatures).map(k=>k.toBase58());
    const expected=[tx.signer,...(required.length===1?[]:creationSigners(tx.commands??[tx.command],tx.signer))];
    if(required[0]!==tx.signer||required.length!==expected.length||required.some(k=>!expected.includes(k))
      ||Object.keys(signed.signatures).length!==required.length)throw new ChainError('Unauthorized','transaction has unexpected signing accounts');
    const signatures=required.map(address=>{
      let signature:Buffer;
      try { const value=signed.signatures[address]!;signature=/^(?:0x)?[a-f0-9]{128}$/i.test(value)?Buffer.from(value.replace(/^0x/,''),'hex'):value.length<=90?Buffer.from(bs58.decode(value)):Buffer.from(value,'base64'); }
      catch { throw new ChainError('Unauthorized','invalid transaction signature'); }
      const key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(address).toBuffer()])});
      if(signature.length!==64||!verify(null,raw,key,signature))throw new ChainError('Unauthorized','signature does not match the transaction message');
      return bs58.encode(signature);
    });
    if(!(await this.connection.isBlockhashValid(message.recentBlockhash,{commitment:'finalized'})).value)throw new ChainError('TooLate','blockhash expired; rebuild the transaction');
    const transaction=Transaction.populate(message,signatures),txId=await this.connection.sendRawTransaction(transaction.serialize(),{preflightCommitment:'finalized',skipPreflight:false,maxRetries:3});
    const deadline=Date.now()+120_000;
    for(;;){
      const status=(await this.connection.getSignatureStatuses([txId],{searchTransactionHistory:true})).value[0];
      if(status?.err)throw new ChainError('ChainSpecific','transaction failed',{txId});
      if(status?.confirmationStatus==='finalized'){const blockTime=await this.connection.getBlockTime(status.slot);if(blockTime===null)throw new ChainError('ChainSpecific','finalized transaction has no block time',{txId});return {txId,blockTime,blockRef:String(status.slot),events:[]};}
      if(Date.now()>deadline)throw new ChainError('ChainSpecific','transaction is awaiting finality',{txId});await new Promise((resolve)=>setTimeout(resolve,1000));
    }
  }
}
