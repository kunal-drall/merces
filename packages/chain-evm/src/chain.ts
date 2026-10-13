import { pacedRpcFetch } from './rpc-fetch.ts';
import { createPublicClient, erc20Abi, encodeFunctionData, getAddress, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';
import {
  ChainError, FinalizedEvents, signingDomain, isPublishedTestKey, serviceCommandSchema, type Command, type BuildableCommand, type ChainInfo, type ChainPort, type DomainEvent, type HealthReport, type ServiceCommand, type ServiceRole, type SignedTx,
  type TxResult, type UnsignedTx,
} from '@merces/domain';
import { assertNotMainnet, type EvmChainConfig } from './config.ts';
import { EvmEventMapper } from './mapping.ts';
import { EvmTransport } from './transport.ts';
import { EvmReads, record, n, type EvmReadContext, type EvmRecord } from './reads.ts';
import { planEvmCommand, type EvmCall } from './commands.ts';
import { calldata, evmError, moduleAddress, type EvmModule } from './abi.ts';
import { eventCursor, mapEvmEvent } from './events.ts';

/** Stage 1 on EVM: at most 200 bids per `tallyBids` range and 4,096 bids per auction (MercesConstants.sol). */
const EVM_LIMITS = { tallyPageMax: 200, maxBidsPerAuction: 4096 } as const satisfies ChainInfo['limits'];

/**
 * EvmChain — live adapter driven by chain config and the pinned Stage 1 ABIs.
 * The same class serves Monad testnet today and Ethereum/Arbitrum/Base/Robinhood Chain later (R23).
 * Money-bearing reads and the event stream use the configured finality tag ('finalized' by default).
 */
export class EvmChain implements ChainPort {
  readonly family = 'evm' as const;
  readonly mode = 'live' as const;
  readonly chain: string;
  readonly client: PublicClient;
  readonly mapper: EvmEventMapper;
  /** Generated Stage 1 builders, reads and canonical event stream are connected. */
  readonly wired: boolean = true;
  readonly transport: EvmTransport;
  private readonly finalizedEvents = new FinalizedEvents<EvmRecord>((e)=>eventCursor(e,31),async(e,all)=>mapEvmEvent(await this.transport.snapshotAt(e.blockNumber,e.blockTime),e,all));
  private serviceQueues=new Map<ServiceRole,Promise<unknown>>();
  private abis: Record<string, unknown> | null = null;
  private networkVerified: Promise<void> | null = null;
  private deploymentCodeValidUntil = 0;
  private deploymentCodeCheck: Promise<string[]> | null = null;

  constructor(readonly config: EvmChainConfig) {
    assertNotMainnet(config);
    this.chain = config.chain;
    const publicMonad=config.chainId===monadTestnet.id&&new URL(config.rpcUrl).hostname==='testnet-rpc.monad.xyz';
    // Multicall combines independent getters into one eth_call. Every group retains
    // its exact finalized block; JSON-RPC batching alone still charges each getter
    // against the public endpoint's request budget. No transaction is submitted.
    this.client = createPublicClient({
      ...(publicMonad?{batch:{multicall:{batchSize:16_384,wait:8}}}:{}),
      transport: http(config.rpcUrl,{...(publicMonad?{fetchFn:pacedRpcFetch(150),retryDelay:750,batch:{batchSize:8,wait:8}}:{})}),
      chain: { id: config.chainId, name: config.network, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } },...(publicMonad?{contracts:monadTestnet.contracts}:{}) },
    });
    this.mapper = new EvmEventMapper(config);
    this.transport = new EvmTransport(config,this.client,()=>this.ensureNetwork());
  }

  async loadGenerated(): Promise<boolean> {
    if (!this.config.generatedDir) return false;
    try {
      this.abis = (await import(`${this.config.generatedDir}/index.ts`)) as Record<string, unknown>;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The configured chain id is allow-listed at construction; this checks the RPC actually serves it, so a
   * mainnet endpoint behind a testnet id is refused. A success is cached, a failure is retried on the next call.
   */
  ensureNetwork(): Promise<void> {
    this.networkVerified ??= (async () => {
      const chainId = await this.client.getChainId();
      if (chainId !== this.config.chainId) throw new ChainError('ChainSpecific', `refusing: rpc chainId ${chainId} ≠ configured ${this.config.chainId}`, { chainId });
    })().catch((e: unknown) => {
      this.networkVerified = null;
      throw e;
    });
    return this.networkVerified;
  }

  async info(): Promise<ChainInfo> {
    return this.infoAt(await this.transport.snapshot());
  }

  private async infoAt(ctx:EvmReadContext):Promise<ChainInfo> {
    const [domain,admin,feeCollector,flags]=await Promise.all([ctx.read('Registry','domain'),ctx.read('Registry','admin'),ctx.read('Registry','feeCollector'),ctx.read('Registry','getFlags')]);
    const signing=signingDomain('evm',this.config.chainId,moduleAddress(this.config.contracts,'Registry'));
    if(domain!==signing.domain)throw new ChainError('ChainSpecific','refusing: registry signing domain differs from the deployment');
    const stablecoins:ChainInfo['stablecoins']={};
    for(const [k,addr] of Object.entries(this.config.stablecoins))if(addr)stablecoins[k as 'USDC'|'USDG']={mint:addr.toLowerCase(),decimals:6};
    return {chain:this.chain,family:this.family,mode:this.mode,network:this.config.network,stablecoins,modules:this.config.contracts,admin:String(admin).toLowerCase(),feeCollector:String(feeCollector).toLowerCase(),newRaisesPaused:Boolean(record(flags).newRaisesPaused),windowsEnabled:Boolean(record(flags).windowsEnabled),tier4Enabled:Boolean(record(flags).tier4Enabled),limits:EVM_LIMITS,signing};
  }

  /** Deployment presence is metadata, not a balance or authorization decision.
   * Validate at startup and at most every five minutes; failures are never cached.
   * Registry links, signing domain, flags and finalized head remain live each probe.
   */
  private missingDeploymentCode(blockNumber: bigint): Promise<string[]> {
    if (Date.now() < this.deploymentCodeValidUntil) return Promise.resolve([]);
    this.deploymentCodeCheck ??= Promise.all(Object.entries(this.config.contracts).map(async ([name, addr]) => {
      const code = await this.client.getCode({address: getAddress(addr), blockNumber});
      return !code || code === '0x' ? name : null;
    })).then(names => {
      const missing = names.filter((name): name is string => name !== null);
      if (!missing.length) this.deploymentCodeValidUntil = Date.now() + 5 * 60_000;
      return missing;
    }).finally(() => { this.deploymentCodeCheck = null; });
    return this.deploymentCodeCheck;
  }

  async health(): Promise<HealthReport> {
    const t0 = Date.now();
    try {
      await this.ensureNetwork();
      const chainId = this.config.chainId;
      const block = await this.transport.head();
      // MercesRegistry.getProtocolContracts is authoritative for the core module links.
      for(const name of ['Registry','Auction','Income','Vault','Treasury','Window','Router','FxAccumulator'] as const)moduleAddress(this.config.contracts,name);
      const ctx=await this.transport.snapshotAt(block.number,Number(block.timestamp));
      const [rawLinks,missing]=await Promise.all([
        ctx.read('Registry','getProtocolContracts'),
        this.missingDeploymentCode(block.number),
        this.infoAt(ctx),
      ]);
      const links=record(rawLinks);
      for(const [field,module] of Object.entries({auction:'Auction',treasury:'Treasury',income:'Income',vault:'Vault',window:'Window'})){
        if(String(links[field]).toLowerCase()!==moduleAddress(this.config.contracts,module as EvmModule).toLowerCase())throw new ChainError('ChainSpecific',`refusing: registry ${field} differs from the manifest`);
      }
      const latency_ms = Date.now() - t0;
      if (missing.length) return { ok: false, mode: 'live', latency_ms, detail: `rpc ok (block ${block.number}) but contracts missing: ${missing.join(', ')}` };
      return { ok: true, mode: 'live', latency_ms, detail: `chainId ${chainId}, ${this.config.finalityTag} block ${block.number}` };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, mode: 'live', latency_ms: Date.now() - t0, detail: e instanceof ChainError || msg.startsWith('refusing:') ? msg : 'RPC health check failed' };
    }
  }

  async now(): Promise<number> {
    const b = await this.transport.head();
    return Number(b.timestamp);
  }

  private async reads(){return new EvmReads(await this.transport.snapshot());}
  async getIssuer(issuer: string): ReturnType<ChainPort['getIssuer']> {try{return await (await this.reads()).getIssuer(issuer);}catch(e){throw evmError(e);}}
  async listSeries(): ReturnType<ChainPort['listSeries']> {try{return await (await this.reads()).listSeries();}catch(e){throw evmError(e);}}
  async getSeries(seriesId: string): ReturnType<ChainPort['getSeries']> {try{return await (await this.reads()).getSeries(seriesId);}catch(e){throw evmError(e);}}
  async getPendingReportingState(seriesId:string):ReturnType<NonNullable<ChainPort['getPendingReportingState']>> {try{return await (await this.reads()).getPendingReportingState(seriesId);}catch(e){throw evmError(e);}}
  async getAuction(seriesId: string): ReturnType<ChainPort['getAuction']> {try{return await (await this.reads()).getAuction(seriesId);}catch(e){throw evmError(e);}}
  async getBid(seriesId: string, bidder: string): ReturnType<ChainPort['getBid']> {try{return await (await this.reads()).getBid(seriesId, bidder);}catch(e){throw evmError(e);}}
  async listBids(seriesId: string): ReturnType<ChainPort['listBids']> {try{return await (await this.reads()).listBids(seriesId);}catch(e){throw evmError(e);}}
  async getTreasury(seriesId: string): ReturnType<ChainPort['getTreasury']> {try{return await (await this.reads()).getTreasury(seriesId);}catch(e){throw evmError(e);}}
  async getVault(seriesId: string): ReturnType<ChainPort['getVault']> {try{return await (await this.reads()).getVault(seriesId);}catch(e){throw evmError(e);}}
  async getPosition(seriesId: string, wallet: string): ReturnType<ChainPort['getPosition']> {try{return await (await this.reads()).getPosition(seriesId, wallet);}catch(e){throw evmError(e);}}
  async listPositions(seriesId: string): ReturnType<ChainPort['listPositions']> {try{return await (await this.reads()).listPositions(seriesId);}catch(e){throw evmError(e);}}
  async getPeriod(seriesId: string, periodId: string): ReturnType<ChainPort['getPeriod']> {try{return await (await this.reads()).getPeriod(seriesId, periodId);}catch(e){throw evmError(e);}}
  async listPeriods(seriesId: string): ReturnType<ChainPort['listPeriods']> {try{return await (await this.reads()).listPeriods(seriesId);}catch(e){throw evmError(e);}}
  async getRedemption(seriesId: string): ReturnType<ChainPort['getRedemption']> {try{return await (await this.reads()).getRedemption(seriesId);}catch(e){throw evmError(e);}}
  async getRateAccumulator(pair: string): ReturnType<ChainPort['getRateAccumulator']> {try{return await (await this.reads()).getRateAccumulator(pair);}catch(e){throw evmError(e);}}
  async getQuarterRate(pair: string, periodId: string): ReturnType<ChainPort['getQuarterRate']> {try{return await (await this.reads()).getQuarterRate(pair, periodId);}catch(e){throw evmError(e);}}
  async getSignerKey(kind: import('@merces/domain').SignerKind, address: string): ReturnType<ChainPort['getSignerKey']> {try{return await (await this.reads()).getSignerKey(kind, address);}catch(e){throw evmError(e);}}
  async listSignerKeys(kind: import('@merces/domain').SignerKind): ReturnType<ChainPort['listSignerKeys']> {try{return await (await this.reads()).listSignerKeys(kind);}catch(e){throw evmError(e);}}
  async getRouter(seriesId: string): ReturnType<ChainPort['getRouter']> {try{return await (await this.reads()).getRouter(seriesId);}catch(e){throw evmError(e);}}
  async getTransferWindow(seriesId: string, windowId?: number): ReturnType<ChainPort['getTransferWindow']> {try{return await (await this.reads()).getTransferWindow(seriesId, windowId);}catch(e){throw evmError(e);}}
  async isAllowlisted(wallet: string): Promise<boolean> {return Boolean(await this.transport.read('Registry','isAllowed',[getAddress(wallet)]));}
  async getCurve(): Promise<null> { return null; } // curve mode is Solana-only
  async quoteCurveSwap(): Promise<never> { throw new ChainError('NotPermitted', 'curve mode is Solana only: the EVM refuses a curve series (CurveModeUnsupported)'); }
  async getBalance(wallet: string, stablecoin: 'USDC' | 'USDG'): Promise<string> {
    const token = this.config.stablecoins[stablecoin];
    if (!token) return '0';
    await this.ensureNetwork();
    const bal = await this.client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(wallet)], blockTag: this.config.finalityTag });
    return bal.toString();
  }

  /** Finalized log + expansion sub-index: resuming in a multi-event log never drops the remainder. */
  async readEvents(cursor: string | null, limit: number): Promise<{events:DomainEvent[];nextCursor:string|null}> {
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw new ChainError('InvalidTerms','invalid event page size');
    if(cursor!==null&&!/^\d{20}:\d{8}:\d{3}$/.test(cursor))throw new ChainError('InvalidTerms','invalid event cursor');
    try {
      await this.finalizedEvents.update(await this.transport.history());
      return this.finalizedEvents.page(cursor,limit);
    }catch(e){throw evmError(e);}
  }
  private payload(plan:EvmCall):string {return JSON.stringify({to:moduleAddress(this.config.contracts,plan.module),data:calldata(plan.module,plan.functionName,plan.args),value:(plan.value??0n).toString(),chainId:this.config.chainId});}
  private async buildCommand(command:Command,signer:string):Promise<UnsignedTx>{
    await this.ensureNetwork();const ctx=await this.transport.snapshot();
    const plan=await planEvmCommand({chain:this.chain,read:ctx.read,now:async()=>ctx.now,pythUpdateFee:(u)=>this.transport.updateFee(u)},command);
    const tx:UnsignedTx={chain:this.chain,family:this.family,signer:getAddress(signer).toLowerCase(),command,payload:this.payload(plan),encoding:'evm-json',summary:command.kind,expiresAt:ctx.now+120};
    if(plan.contractHashAfterCreate)tx.afterCreate={kind:'setContractHash',contractHash:plan.contractHashAfterCreate};
    if(plan.preparations?.length)tx.preparations=plan.preparations.map((p)=>({summary:p.functionName,payload:this.payload(p),encoding:'evm-json'}));
    if(plan.approval&&plan.approval.amount>0n){
      const {token,amount,module}=plan.approval,spender=moduleAddress(this.config.contracts,module);
      const allowance=await this.client.readContract({address:getAddress(token),abi:erc20Abi,functionName:'allowance',args:[getAddress(signer),spender],blockTag:this.config.finalityTag});
      if(allowance<amount){
        // Tokens that require zero-before-change are supported. Every approval is exact, never unlimited.
        tx.approvals=(allowance>0n?[0n,amount]:[amount]).map((value)=>({token:token.toLowerCase(),spender:spender.toLowerCase(),amount:value.toString(),encoding:'evm-json',payload:JSON.stringify({to:token,data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[spender,value]}),value:'0',chainId:this.config.chainId})}));
      }
    }
    return tx;
  }
  async build(command:BuildableCommand|readonly BuildableCommand[],signer:string):Promise<UnsignedTx>{
    const commands=Array.isArray(command)?command:[command];
    if(commands.length!==1)throw new ChainError('NotImplemented','EVM transactions require exactly one command');
    if(Array.isArray(command)&&commands[0].kind==='submitReport')throw new ChainError('NotPermitted','a report must be submitted on its own');
    try{return await this.buildCommand(commands[0]!,signer);}catch(e){throw evmError(e);}
  }
  async send(signed:SignedTx):Promise<TxResult>{try{
    const result=await this.transport.send(signed);
    await this.finalizedEvents.update(await this.transport.history(BigInt(result.blockRef)));
    return {...result,events:this.finalizedEvents.transaction(result.txId)};
  }catch(e){throw evmError(e);}}
  async submit(command:ServiceCommand,role:ServiceRole):Promise<TxResult>{
    const parsed=serviceCommandSchema.safeParse(command);
    if(!parsed.success)throw new ChainError('Unauthorized','service signer cannot send this command');
    if((command.kind==='setAllowlist')!==(role==='allowlistManager'))throw new ChainError('Unauthorized','command is not permitted for this service role');
    const signer=this.config.serviceSigners?.[role],expected=role==='keeper'?this.config.keeperAddress:this.config.allowlistManagerAddress;
    if(!signer||signer.family!=='evm'||!expected||signer.address.toLowerCase()!==expected.toLowerCase())throw new ChainError('Unauthorized','funded service signer is not configured');
    if(isPublishedTestKey(signer.address))throw new ChainError('Unauthorized','published test keys are refused on live chains');
    const run=async()=>{try{
    // Rebuild after each bounded prerequisite. No user-token approvals are signed by a service wallet.
    for(let step=0;step<32;step++){
      const tx=await this.buildCommand(command,signer.address);
      if(tx.approvals?.length)throw new ChainError('Unauthorized','service transactions cannot approve token spending');
      const preparation=tx.preparations?.[0];
      if(preparation){await this.send(await signer.sign({...tx,payload:preparation.payload,summary:preparation.summary,preparations:undefined}));continue;}
      return this.send(await signer.sign(tx));
    }
    throw new ChainError('ChainSpecific','prerequisites did not finish within the bounded service run');
    }catch(e){throw evmError(e);}};
    const result=(this.serviceQueues.get(role)??Promise.resolve()).catch(()=>{}).then(run);this.serviceQueues.set(role,result);return result;
  }
}
