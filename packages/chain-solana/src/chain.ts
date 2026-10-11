import { Connection, PublicKey, Transaction, ComputeBudgetProgram, type TransactionInstruction } from '@solana/web3.js';
import {
  ChainError, FinalizedEvents, signingDomain, isPublishedTestKey, userCommandSchema, permissionlessCommandSchema, adminCommandSchema, serviceCommandSchema, type Command, type BuildableCommand, type ChainInfo, type ChainPort, type DomainEvent, type HealthReport, type ServiceCommand, type ServiceRole, type SignedTx,
  type TxResult, type UnsignedTx,
} from '@merces/domain';
import { assertNotMainnet, checkGenesis, normalizeCluster, type SolanaChainConfig } from './config.ts';
import { SolanaEventMapper } from './mapping.ts';
import {SolanaTransport,solanaError,type SolRecord} from './transport.ts';
import {SolanaReads} from './reads.ts';
import {SolanaCurve} from './curve.ts';
import {planSolCommand} from './commands.ts';
import {eventCursor,mapSolanaEvent} from './events.ts';
import {assertIdlPrograms,programOf,pda} from './accounts.ts';
import {hex} from './codec.ts';

/** Stage 1 on Solana: a tally page holds at most 24 Bid accounts (`TALLY_PAGE`, state.rs); no limit on the bid count. */
const SOLANA_LIMITS = { tallyPageMax: 24, maxBidsPerAuction: null } as const satisfies ChainInfo['limits'];

/**
 * Solana adapter over the pinned Stage 1 IDLs, with finalized account reads, canonical events and wallet builders.
 *
 * Commitment levels: money-bearing reads and the event stream use `finalized`; `confirmed` is reserved for
 * interface hints (E1).
 */
export class SolanaChain implements ChainPort {
  readonly family = 'solana' as const;
  readonly mode = 'live' as const;
  readonly chain: string;
  readonly connection: Connection;
  readonly mapper: SolanaEventMapper;
  /** Generated Stage 1 builders, reads and canonical event stream are connected. */
  readonly wired: boolean = true;
  readonly transport:SolanaTransport;
  private readonly finalizedEvents=new FinalizedEvents<SolRecord>((e)=>eventCursor(e,31),async(e,all)=>mapSolanaEvent(new SolanaReads(this.config,this.transport,e.blockTime),e,all));
  readonly curve:SolanaCurve;
  private serviceQueues=new Map<ServiceRole,Promise<unknown>>();
  private clients: Record<string, unknown> | null = null;
  private networkVerified: Promise<void> | null = null;

  constructor(readonly config: SolanaChainConfig) {
    assertNotMainnet(config);
    this.chain = config.chain;
    this.connection = new Connection(config.rpcUrl, 'finalized');
    this.mapper = new SolanaEventMapper(config);
    this.transport=new SolanaTransport(config,this.connection,()=>this.ensureNetwork());
    this.curve=new SolanaCurve(config,this.transport);
  }

  /** Loads generated clients if stage1:sync has produced them. */
  async loadGenerated(): Promise<boolean> {
    if (!this.config.generatedDir) return false;
    try {
      const mod = (await import(`${this.config.generatedDir}/index.ts`)) as Record<string, unknown>;
      this.clients = mod;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fails closed unless the RPC's genesis hash is the configured cluster's. Every RPC use goes through this; a
   * success is cached, a failure is retried on the next call.
   */
  ensureNetwork(): Promise<void> {
    this.networkVerified ??= (async () => {
      const hash = await this.connection.getGenesisHash();
      const refusal = checkGenesis(this.config.cluster, hash);
      if (refusal) throw new ChainError('ChainSpecific', refusal, { cluster: this.config.cluster });
    })().catch((e: unknown) => {
      this.networkVerified = null;
      throw e;
    });
    return this.networkVerified;
  }

  async info(): Promise<ChainInfo> {
    await this.ensureNetwork();assertIdlPrograms(this.config);
    const registry=programOf(this.config,'registry'),cfg=(await this.transport.account(pda(registry,'config'),'ProtocolConfig'))?.value;
    if(!cfg)throw new ChainError('ChainSpecific','registry configuration is missing');
    const cluster=normalizeCluster(this.config.cluster);
    const signing=signingDomain('solana',cluster==='devnet'?103:cluster==='testnet'?102:104,registry);
    if(hex(cfg.domain)!==signing.domain)throw new ChainError('ChainSpecific','refusing: registry signing domain differs from configured cluster');
    const stablecoins:ChainInfo['stablecoins']={};for(const [k,mint] of Object.entries(this.config.stablecoins))if(mint)stablecoins[k as 'USDC'|'USDG']={mint,decimals:6};
    return {chain:this.chain,family:this.family,mode:this.mode,network:this.config.cluster,stablecoins,modules:this.config.programs,admin:String(cfg.admin),feeCollector:String(cfg.fee_collector),newRaisesPaused:Boolean(cfg.new_raises_paused),windowsEnabled:Boolean(cfg.windows_enabled),tier4Enabled:Boolean(cfg.tier4_enabled),limits:SOLANA_LIMITS,signing};
  }

  async health(): Promise<HealthReport> {
    const t0 = Date.now();
    try {
      await this.ensureNetwork();
      const [slot, version] = await Promise.all([this.connection.getSlot('finalized'), this.connection.getVersion()]);
      const programsOk = await this.programsDeployed();
      const latency_ms = Date.now() - t0;
      if (!programsOk.ok) return { ok: false, mode: 'live', latency_ms, detail: `rpc ok (slot ${slot}, ${version['solana-core']}) but programs missing: ${programsOk.missing.join(', ')}` };
      await this.info();
      return { ok: true, mode: 'live', latency_ms, detail: `slot ${slot}, solana-core ${version['solana-core']}, ${Object.keys(this.config.programs).length} programs deployed` };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, mode: 'live', latency_ms: Date.now() - t0, detail: e instanceof ChainError || msg.startsWith('refusing:') ? msg : 'RPC health check failed' };
    }
  }

  async programsDeployed(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    for (const [name, id] of Object.entries(this.config.programs)) {
      try {
        const info = await this.connection.getAccountInfo(new PublicKey(id), 'finalized');
        if (!info || !info.executable) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
    return { ok: missing.length === 0, missing };
  }

  async now(): Promise<number> {
    await this.ensureNetwork();
    const slot = await this.connection.getSlot('finalized');
    const t = await this.connection.getBlockTime(slot);
    if (t === null) throw new ChainError('ChainSpecific', 'no block time for finalized slot');
    return t;
  }

  private async reads(){return new SolanaReads(this.config,this.transport,await this.now());}
  async getIssuer(issuer: string): ReturnType<ChainPort['getIssuer']> {try{return await (await this.reads()).getIssuer(issuer);}catch(e){throw solanaError(e);}}
  async listSeries(): ReturnType<ChainPort['listSeries']> {try{return await (await this.reads()).listSeries();}catch(e){throw solanaError(e);}}
  async getSeries(seriesId: string): ReturnType<ChainPort['getSeries']> {try{return await (await this.reads()).getSeries(seriesId);}catch(e){throw solanaError(e);}}
  async getAuction(seriesId: string): ReturnType<ChainPort['getAuction']> {try{return await (await this.reads()).getAuction(seriesId);}catch(e){throw solanaError(e);}}
  async getBid(seriesId: string, bidder: string): ReturnType<ChainPort['getBid']> {try{return await (await this.reads()).getBid(seriesId, bidder);}catch(e){throw solanaError(e);}}
  async listBids(seriesId: string): ReturnType<ChainPort['listBids']> {try{return await (await this.reads()).listBids(seriesId);}catch(e){throw solanaError(e);}}
  async getTreasury(seriesId: string): ReturnType<ChainPort['getTreasury']> {try{return await (await this.reads()).getTreasury(seriesId);}catch(e){throw solanaError(e);}}
  async getVault(seriesId: string): ReturnType<ChainPort['getVault']> {try{return await (await this.reads()).getVault(seriesId);}catch(e){throw solanaError(e);}}
  async getPosition(seriesId: string, wallet: string): ReturnType<ChainPort['getPosition']> {try{return await (await this.reads()).getPosition(seriesId, wallet);}catch(e){throw solanaError(e);}}
  async listPositions(seriesId: string): ReturnType<ChainPort['listPositions']> {try{return await (await this.reads()).listPositions(seriesId);}catch(e){throw solanaError(e);}}
  async getPeriod(seriesId: string, periodId: string): ReturnType<ChainPort['getPeriod']> {try{return await (await this.reads()).getPeriod(seriesId, periodId);}catch(e){throw solanaError(e);}}
  async listPeriods(seriesId: string): ReturnType<ChainPort['listPeriods']> {try{return await (await this.reads()).listPeriods(seriesId);}catch(e){throw solanaError(e);}}
  async getRedemption(seriesId: string): ReturnType<ChainPort['getRedemption']> {try{return await (await this.reads()).getRedemption(seriesId);}catch(e){throw solanaError(e);}}
  async getRateAccumulator(pair: string): ReturnType<ChainPort['getRateAccumulator']> {try{return await (await this.reads()).getRateAccumulator(pair);}catch(e){throw solanaError(e);}}
  async getQuarterRate(pair: string, periodId: string): ReturnType<ChainPort['getQuarterRate']> {try{return await (await this.reads()).getQuarterRate(pair, periodId);}catch(e){throw solanaError(e);}}
  async getSignerKey(kind: import('@merces/domain').SignerKind, address: string): ReturnType<ChainPort['getSignerKey']> {try{return await (await this.reads()).getSignerKey(kind, address);}catch(e){throw solanaError(e);}}
  async listSignerKeys(kind: import('@merces/domain').SignerKind): ReturnType<ChainPort['listSignerKeys']> {try{return await (await this.reads()).listSignerKeys(kind);}catch(e){throw solanaError(e);}}
  async getRouter(seriesId: string): ReturnType<ChainPort['getRouter']> {try{return await (await this.reads()).getRouter(seriesId);}catch(e){throw solanaError(e);}}
  async getTransferWindow(seriesId: string, windowId?: number): ReturnType<ChainPort['getTransferWindow']> {try{return await (await this.reads()).getTransferWindow(seriesId, windowId);}catch(e){throw solanaError(e);}}
  async isAllowlisted(wallet:string):Promise<boolean>{try{return await (await this.reads()).isAllowlisted(wallet);}catch(e){throw solanaError(e);}}
  async getCurve(seriesId:string):ReturnType<ChainPort['getCurve']>{try{return await this.curve.getCurve(seriesId);}catch(e){throw solanaError(e);}}
  async quoteCurveSwap(seriesId:string,side:'buy'|'sell',amountIn:string):ReturnType<ChainPort['quoteCurveSwap']>{try{return await this.curve.quoteCurveSwap(seriesId,side,amountIn);}catch(e){throw solanaError(e);}}
  async getBalance(wallet: string, stablecoin: 'USDC' | 'USDG'): Promise<string> {
    const mint = this.config.stablecoins[stablecoin];
    if (!mint) return '0';
    await this.ensureNetwork();
    const res = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: new PublicKey(mint) }, 'finalized');
    let total = 0n;
    for (const acc of res.value) {
      const amt = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (amt) total += BigInt(amt);
    }
    return total.toString();
  }

  async readEvents(cursor:string|null,limit:number):Promise<{events:DomainEvent[];nextCursor:string|null}>{
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw new ChainError('InvalidTerms','invalid event page size');
    if(cursor!==null&&!/^\d{20}:\d{8}:\d{5}:\d{3}$/.test(cursor))throw new ChainError('InvalidTerms','invalid event cursor');
    try{await this.finalizedEvents.update(await this.transport.history());
      return this.finalizedEvents.page(cursor,limit);
    }catch(e){throw solanaError(e);}
  }
  private async buildCommands(commands:readonly Command[],signer:string):Promise<UnsignedTx>{
    await this.ensureNetwork();assertIdlPrograms(this.config);
    const now=await this.now(),plans=[];
    for(const command of commands)plans.push(await planSolCommand({config:this.config,transport:this.transport,reads:this,curve:this.curve,now},command,signer));
    const latest=await this.connection.getLatestBlockhash('finalized');
    const payload=(instructions:TransactionInstruction[])=>{
      const tx=new Transaction({feePayer:new PublicKey(signer),recentBlockhash:latest.blockhash});
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),...instructions);
      const message=tx.compileMessage();if(message.header.numRequiredSignatures!==1||message.accountKeys[0]!.toBase58()!==signer)throw new ChainError('NotPermitted','transaction requires an additional signer');
      let serialized:Buffer;try{serialized=tx.serializeMessage();}catch{throw new ChainError('NotPermitted','transaction exceeds the Solana message size; reduce the requested batch');}
      if(serialized.length+65>1232)throw new ChainError('NotPermitted','transaction exceeds the Solana packet size; reduce the requested batch');return serialized.toString('base64');
    };
    const preparations=plans.flatMap((p)=>p.preparations??[]).map((p)=>({summary:p.summary,payload:payload(p.instructions),encoding:'solana-base64' as const}));
    return {chain:this.chain,family:this.family,signer,command:commands[0]!,...(commands.length>1?{commands:[...commands]}:{}),payload:payload(plans.flatMap((p)=>p.instructions)),encoding:'solana-base64',summary:commands.map((c)=>c.kind).join(' + '),expiresAt:now+60,...(preparations.length?{preparations}:{})};
  }
  async build(command:BuildableCommand|readonly BuildableCommand[],signer:string):Promise<UnsignedTx>{
    const commands=Array.isArray(command)?command:[command];
    if(!commands.length||commands.length>1&&commands.some((c)=>c.kind==='submitReport'))throw new ChainError('NotPermitted','a transaction needs commands and a report must be sent on its own');
    const parsed=commands.map((c)=>{for(const schema of [userCommandSchema,permissionlessCommandSchema,adminCommandSchema]){const result=schema.safeParse(c);if(result.success)return result.data as Command;}throw new ChainError('InvalidTerms','invalid buildable command');});
    try{return await this.buildCommands(parsed,signer);}catch(e){throw solanaError(e);}
  }
  async send(signed:SignedTx):Promise<TxResult>{try{
    const result=await this.transport.send(signed);
    await this.finalizedEvents.update(await this.transport.history());
    return {...result,events:this.finalizedEvents.transaction(result.txId)};
  }catch(e){throw solanaError(e);}}
  async submit(command:ServiceCommand,role:ServiceRole):Promise<TxResult>{
    if(!serviceCommandSchema.safeParse(command).success||(command.kind==='setAllowlist')!==(role==='allowlistManager'))throw new ChainError('Unauthorized','command is not permitted for this service role');
    const signer=this.config.serviceSigners?.[role],expected=role==='keeper'?this.config.keeperPublicKey:this.config.allowlistManagerPublicKey;
    if(!signer||signer.family!=='solana'||!expected||signer.address!==expected||isPublishedTestKey(signer.address))throw new ChainError('Unauthorized','funded service signer is not configured or uses a published test key');
    const run=async()=>{try{for(let step=0;step<32;step++){
      const tx=await this.buildCommands([command],signer.address),preparation=tx.preparations?.[0];
      if(preparation){await this.send(await signer.sign({...tx,payload:preparation.payload,summary:preparation.summary,preparations:undefined}));continue;}
      return await this.send(await signer.sign(tx));
    }throw new ChainError('ChainSpecific','prerequisites did not finish within the bounded service run');}catch(e){throw solanaError(e);}};
    const result=(this.serviceQueues.get(role)??Promise.resolve()).catch(()=>{}).then(run);this.serviceQueues.set(role,result);return result;
  }
}
