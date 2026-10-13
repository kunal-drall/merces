import {decodeEventLog,decodeFunctionData,erc20Abi,getAddress,parseAbi,parseTransaction,recoverTransactionAddress,type Hex,type TransactionSerialized,type PublicClient} from 'viem';
import {ChainError,type SignedTx,type TxResult} from '@merces/domain';
import {abiOf,evmError,moduleAddress,type EvmModule} from './abi.ts';
import {record,n,type EvmReadContext,type EvmRecord} from './reads.ts';
import type {EvmChainConfig} from './config.ts';

const MODULES:EvmModule[]=['Registry','Auction','Income','Vault','Treasury','Window','Router','FxAccumulator'];
export const PYTH_FEE_ABI=parseAbi(['function getUpdateFee(bytes[] updateData) view returns (uint256)']);
export interface EvmPayload {to:string;data:Hex;value:string;chainId:number;}
/** All reads within a snapshot use the exact finalized block number, never several moving latest tags. */
export class EvmTransport {
  private events:EvmRecord[]=[];
  private pendingHead:ReturnType<EvmTransport['loadHead']>|null=null;
  private pendingReads=new Map<string,Promise<unknown>>();
  private through:bigint;
  private eventLoad:Promise<void>|null=null;
  private inputs=new Map<string,Promise<{name:string;args:readonly unknown[];sender:string}>>();
  constructor(readonly config:EvmChainConfig,readonly client:PublicClient,readonly verify:()=>Promise<void>){this.through=BigInt(config.startBlock)-1n;}
  private loadHead(){return this.client.getBlock({blockTag:this.config.finalityTag});}
  async head(){
    await this.verify();
    this.pendingHead??=this.loadHead().finally(()=>{this.pendingHead=null;});
    return this.pendingHead;
  }
  async read(module:EvmModule,name:string,args:readonly unknown[]=[],blockNumber?:bigint):Promise<unknown>{
    await this.verify();
    // Only identical reads at an explicit finalized block can share an in-flight call.
    // Clear on completion (including failure); never serve a cached balance or moving head.
    const key=blockNumber===undefined?null:JSON.stringify([blockNumber,module,name,args],(_,v)=>typeof v==='bigint'?{bigint:v.toString()}:v);
    if(key&&this.pendingReads.has(key))return this.pendingReads.get(key)!;
    const read=this.client.readContract({address:moduleAddress(this.config.contracts,module),abi:abiOf(module),functionName:name,args,...(blockNumber===undefined?{blockTag:this.config.finalityTag}:{blockNumber})}).catch(e=>{throw evmError(e);}).finally(()=>{if(key)this.pendingReads.delete(key);});
    if(key)this.pendingReads.set(key,read);
    return read;
  }
  async tokenBalance(token:string,wallet:string,blockNumber?:bigint):Promise<bigint>{
    await this.verify();return this.client.readContract({address:getAddress(token),abi:erc20Abi,functionName:'balanceOf',args:[getAddress(wallet)],...(blockNumber===undefined?{blockTag:this.config.finalityTag}:{blockNumber})});
  }
  async snapshot():Promise<EvmReadContext>{
    const head=await this.head();return this.snapshotAt(head.number,n(head.timestamp));
  }
  async snapshotAt(block:bigint,time:number):Promise<EvmReadContext>{
    return {chain:this.config.chain,now:time,stablecoins:this.config.stablecoins,fxCurrencies:this.config.fxCurrencies??{},read:(module,name,args=[])=>this.read(module,name,args,block),tokenBalance:(token,wallet)=>this.tokenBalance(token,wallet,block),history:()=>this.history(block),input:(event)=>this.input(event)};
  }
  /** RPC-sized ranges, stable total ordering and a cache containing finalized events only. */
  async history(upTo?:bigint):Promise<EvmRecord[]>{
    const target=upTo??(await this.head()).number;
    while(this.through<target){
      if(this.eventLoad){await this.eventLoad;continue;}
      this.eventLoad=this.load(target).finally(()=>{this.eventLoad=null;});await this.eventLoad;
    }
    return this.events.filter((e)=>e.blockNumber<=target);
  }
  private async load(target:bigint):Promise<void>{
    const byAddress=new Map(MODULES.map((m)=>[moduleAddress(this.config.contracts,m).toLowerCase(),m]));
    while(this.through<target){
      // Bounded concurrent pages keep cold-start catch-up from blocking every wallet read.
      // Publish pages in order; a failed page cannot advance the finalized cursor past a gap.
      // Leave room for wallet reads on the shared public endpoint. Private/local
      // RPCs keep concurrent catch-up; finalized cursor and gap handling are unchanged.
      const concurrency=new URL(this.config.rpcUrl).hostname==='testnet-rpc.monad.xyz'?1:4;
      const ranges=Array.from({length:concurrency},(_,i)=>this.through+1n+BigInt(i)*100n).filter(from=>from<=target).map(from=>({from,to:from+99n<target?from+99n:target}));
      const pages=await Promise.allSettled(ranges.map(({from,to})=>this.client.getLogs({address:[...byAddress.keys()] as Hex[],fromBlock:from,toBlock:to})));
      for(const [i,page] of pages.entries()){
      if(page.status==='rejected')throw page.reason;
      const logs=page.value,to=ranges[i]!.to;
      const times=new Map<bigint,number>();
      for(const block of new Set(logs.map((l)=>l.blockNumber)))if(block!==null)times.set(block,n((await this.client.getBlock({blockNumber:block})).timestamp));
      const decoded:EvmRecord[]=[];
      for(const l of logs){
        if(l.removed || l.blockNumber===null || l.logIndex===null || l.transactionIndex===null || l.transactionHash===null)throw new ChainError('ChainSpecific','RPC returned a nonfinalized log in a finalized range');
        const module=byAddress.get(l.address.toLowerCase())!;
        try {
          const event=decodeEventLog({abi:abiOf(module),data:l.data,topics:l.topics,strict:true});
          if(!event.eventName)throw new Error('unknown event');
          decoded.push({module,name:event.eventName,args:record(event.args),blockNumber:l.blockNumber,logIndex:l.logIndex,transactionIndex:l.transactionIndex,txId:l.transactionHash,blockTime:times.get(l.blockNumber)!});
        }catch {
          throw new ChainError('ChainSpecific','cannot decode a configured protocol event; run stage1:sync');
        }
      }
      decoded.sort((a,b)=>a.blockNumber===b.blockNumber?a.logIndex-b.logIndex:a.blockNumber<b.blockNumber?-1:1);
      this.events.push(...decoded);this.through=to;
      }
    }
  }
  input(event:EvmRecord):Promise<{name:string;args:readonly unknown[];sender:string}>{
    const key=`${event.txId}:${event.logIndex}`;
    let promise=this.inputs.get(key);if(promise)return promise;
    promise=(async()=>{
      const tx=await this.client.getTransaction({hash:event.txId as Hex});
      const decode=(to:string|undefined,data:Hex,from:string)=>{
        const module=MODULES.find((m)=>moduleAddress(this.config.contracts,m).toLowerCase()===to?.toLowerCase());
        if(!module)return null;
        try{const decoded=decodeFunctionData({abi:abiOf(module),data});return {name:decoded.functionName,args:decoded.args??[],sender:from.toLowerCase()};}catch{return null;}
      };
      const direct=decode(tx.to??undefined,tx.input,tx.from);if(direct)return direct;
      // Contract wallets and timelocks are ordinary callers. An archive RPC's call trace supplies their inner calls;
      // never guess a call by searching arbitrary calldata for a selector or decode an untrusted submitted command.
      type Call={from:string;to?:string;input?:Hex;calls?:Call[]};
      let trace:Call;
      try{trace=await (this.client.request as unknown as (args:unknown)=>Promise<Call>)({method:'debug_traceTransaction',params:[event.txId,{tracer:'callTracer'}]});}
      catch{throw new ChainError('ChainSpecific','RPC call tracing is required to read transactions sent through contract wallets');}
      const calls:NonNullable<ReturnType<typeof decode>>[]=[];
      function walk(call:Call){if(call.input){const decoded=decode(call.to,call.input,call.from);if(decoded)calls.push(decoded);}for(const child of call.calls??[])walk(child);}
      walk(trace);
      const expected:Record<string,string[]>={SeriesCreated:['createSeries'],TermsAmended:['amendTerms'],ReportAccepted:['submitReport'],PayoutDistributed:['pay','payTrueUp','route','sweep'],TailDistributed:['pay'],PauseApproved:['approvePause'],SeriesExtinguished:['extinguish']};
      const names=expected[event.name];
      const candidates=calls.filter((call)=>{
        if(names&&!names.includes(call.name))return false;
        if(event.name==='SeriesCreated')return true;
        const arg=call.args[0],id=typeof arg==='object'&&arg!==null?(arg as Record<string,unknown>).seriesId:arg;
        return event.args.series===undefined||String(id)===String(event.args.series);
      });
      if(candidates.length===1)return candidates[0]!;
      if(event.name==='SeriesCreated'){
        const creations=(await this.history(event.blockNumber)).filter((x)=>x.txId===event.txId&&x.name==='SeriesCreated');
        if(creations.length===candidates.length)return candidates[creations.findIndex((x)=>x.logIndex===event.logIndex)]!;
      }
      throw new ChainError('ChainSpecific','cannot uniquely associate a protocol event with its contract-wallet call');
    })().catch((error)=>{this.inputs.delete(key);throw evmError(error);});
    this.inputs.set(key,promise);return promise;
  }
  async updateFee(updates:readonly Hex[]):Promise<bigint>{
    const pyth=String(await this.read('FxAccumulator','pyth'));
    return this.client.readContract({address:getAddress(pyth),abi:PYTH_FEE_ABI,functionName:'getUpdateFee',args:[updates],blockTag:this.config.finalityTag});
  }
  /** SignedTx.signatures[signer] is the complete wallet-signed serialized EVM transaction. */
  async send(signed:SignedTx):Promise<TxResult>{
    await this.verify();
    const tx=signed.tx;
    if(tx.family!=='evm' || tx.chain!==this.config.chain || tx.encoding!=='evm-json')throw new ChainError('InvalidTerms','transaction belongs to another chain');
    const raw=signed.signatures[tx.signer] as Hex|undefined;
    if(!raw || !/^0x[0-9a-fA-F]+$/.test(raw))throw new ChainError('Unauthorized','wallet-signed serialized transaction is required');
    if(Object.keys(signed.signatures).length!==1)throw new ChainError('Unauthorized','exactly one wallet signature is required');
    let expected:EvmPayload,parsed:ReturnType<typeof parseTransaction>,sender:string;
    try {expected=JSON.parse(tx.payload) as EvmPayload;parsed=parseTransaction(raw);sender=await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized});}catch{throw new ChainError('Unauthorized','invalid signed transaction');}
    if(parsed.chainId!==this.config.chainId || expected.chainId!==this.config.chainId || sender.toLowerCase()!==tx.signer.toLowerCase() || parsed.to?.toLowerCase()!==expected.to.toLowerCase() || (parsed.data??'0x')!==expected.data || (parsed.value??0n)!==BigInt(expected.value))throw new ChainError('Unauthorized','signed transaction does not match the requested call');
    const hash=await this.client.sendRawTransaction({serializedTransaction:raw});
    const receipt=await this.client.waitForTransactionReceipt({hash,timeout:120_000});
    if(receipt.status!=='success')throw new ChainError('ChainSpecific','transaction reverted',{txId:hash});
    const deadline=Date.now()+120_000;
    while((await this.head()).number<receipt.blockNumber){if(Date.now()>deadline)throw new ChainError('ChainSpecific','transaction is awaiting finality',{txId:hash});await new Promise((resolve)=>setTimeout(resolve,1000));}
    const included=await this.client.getBlock({blockNumber:receipt.blockNumber});
    if(included.hash!==receipt.blockHash)throw new ChainError('ChainSpecific','transaction receipt changed before finality',{txId:hash});
    return {txId:hash,blockTime:n(included.timestamp),blockRef:receipt.blockNumber.toString(),events:[]};
  }
}
