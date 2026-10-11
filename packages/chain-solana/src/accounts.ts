import {PublicKey,TransactionInstruction,type AccountMeta} from '@solana/web3.js';
import {ChainError} from '@merces/domain';
import {encodeType,idlOf,integer,type IdlType,type Row,type SolModule} from './codec.ts';
import type {SolanaChainConfig} from './config.ts';
export const SYSTEM='11111111111111111111111111111111';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export function programOf(config:Pick<SolanaChainConfig,'programs'>,module:SolModule):string {
  const value=config.programs[`merces_${module}`]??config.programs[module];if(!value)throw new ChainError('ChainSpecific','deployment program is missing',{module});return new PublicKey(value).toBase58();
}
export function assertIdlPrograms(config:Pick<SolanaChainConfig,'programs'>):void {
  for(const module of ['registry','protocol','hook'] as const)if(programOf(config,module)!==idlOf(module).address)throw new ChainError('ChainSpecific','deployment program differs from the pinned IDL; run stage1:sync',{module});
}
export const pda=(program:string,prefix:string,...seeds:(string|Uint8Array)[])=>PublicKey.findProgramAddressSync([Buffer.from(prefix),...seeds.map((s)=>typeof s==='string'?new PublicKey(s).toBuffer():Buffer.from(s))],new PublicKey(program))[0].toBase58();
export const ata=(owner:string,mint:string,tokenProgram:string)=>PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),new PublicKey(tokenProgram).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(ASSOCIATED_TOKEN))[0].toBase58();
export const meta=(pubkey:string,isWritable=false):AccountMeta=>({pubkey:new PublicKey(pubkey),isSigner:false,isWritable});
export function createAta(payer:string,owner:string,mint:string,tokenProgram:string):TransactionInstruction{
  return new TransactionInstruction({programId:new PublicKey(ASSOCIATED_TOKEN),keys:[{...meta(payer,true),isSigner:true},meta(ata(owner,mint,tokenProgram),true),meta(owner),meta(mint),meta(SYSTEM),meta(tokenProgram)],data:Buffer.from([1])});
}
/** Resolve the actual IDL seeds, including account-field widths and the next FX checkpoint. */
export function resolveAccounts(config:SolanaChainConfig,module:SolModule,name:string,args:Row,known:Record<string,string|null>,rows:Record<string,Row>):Record<string,string|null>{
  const idl=idlOf(module),ix=idl.instructions.find((i)=>i.name===name);if(!ix)throw new ChainError('ChainSpecific','unknown instruction');
  const result={...known},program=programOf(config,module);
  function fieldType(type:IdlType,path:string[]):IdlType{
    if(!path.length)return type;
    if(typeof type==='string'||!('defined' in type))throw new ChainError('ChainSpecific','IDL seed field type is invalid');
    const t=idl.types.find((t)=>t.name===type.defined.name),field=t?.type.fields?.find((f)=>f.name===path[0]);if(!field)throw new ChainError('ChainSpecific','IDL seed field is missing');
    return fieldType(field.type,path.slice(1));
  }
  for(let pass=0;pass<ix.accounts.length;pass++){
    let changed=false;
    for(const a of ix.accounts){
      if(Object.hasOwn(result,a.name))continue;
      if(a.address){result[a.name]=a.address;changed=true;continue;}
      if(!a.pda)continue;
      const seeds:Buffer[]=[];let ready=true;
      for(const seed of a.pda.seeds){
        if(seed.kind==='const'){seeds.push(Buffer.from(seed.value!));continue;}
        const increment=seed.path!.endsWith('.saturating_add(1)'),path=(increment?seed.path!.slice(0,-'.saturating_add(1)'.length):seed.path!).split('.');
        let value:unknown,type:IdlType;
        if(seed.kind==='arg'){
          const arg=ix.args.find((x)=>x.name===path[0]);if(!arg)throw new ChainError('ChainSpecific','unknown IDL argument seed');
          type=fieldType(arg.type,path.slice(1));value=args[path[0]!];for(const key of path.slice(1))value=(value as Row)?.[key];
        }else if(path.length===1){type='pubkey';value=result[path[0]!];}
        else {type=fieldType({defined:{name:seed.account!}},path.slice(1));value=rows[path[0]!];for(const key of path.slice(1))value=(value as Row)?.[key];}
        if(value===undefined||value===null){ready=false;break;}
        if(increment)value=BigInt(value as string|number|bigint)+1n;
        seeds.push(encodeType(idl,type,value));
      }
      if(!ready)continue;
      const owner=a.pda.program?.kind==='const'?new PublicKey(a.pda.program.value!).toBase58():program;
      result[a.name]=PublicKey.findProgramAddressSync(seeds,new PublicKey(owner))[0].toBase58();changed=true;
    }
    if(!changed)break;
  }
  for(const a of ix.accounts)if(!Object.hasOwn(result,a.name)&&a.optional)result[a.name]=null;
  return result;
}
export function unitHookAccounts(config:SolanaChainConfig,series:string,unitMint:string):AccountMeta[]{
  const hook=programOf(config,'hook'),protocol=programOf(config,'protocol');
  return [meta(hook),meta(pda(hook,'extra-account-metas',unitMint)),meta(pda(programOf(config,'registry'),'config')),meta(series),meta(pda(protocol,'escrow_arm',unitMint))];
}
export const seriesPda=(config:SolanaChainConfig,index:bigint)=>pda(programOf(config,'registry'),'series',integer(index,8));
