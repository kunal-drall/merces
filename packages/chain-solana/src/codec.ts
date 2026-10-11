import {PublicKey,TransactionInstruction,type AccountMeta} from '@solana/web3.js';
import {ChainError} from '@merces/domain';
import * as generated from '../../stage1-sync/generated/solana/index.ts';

export type SolModule='registry'|'protocol'|'hook';
export type Row=Record<string,unknown>;
export type IdlType=string|{array:[IdlType,number]}|{vec:IdlType}|{option:IdlType}|{defined:{name:string}};
interface Field {name:string;type:IdlType;}
interface Definition {name:string;serialization?:string;type:{kind:'struct'|'enum';fields?:Field[];variants?:{name:string;fields?:Field[]|IdlType[]}[]};}
export interface Seed {kind:'const'|'arg'|'account';value?:number[];path?:string;account?:string;}
export interface IdlAccount {name:string;writable?:boolean;signer?:boolean;optional?:boolean;address?:string;pda?:{seeds:Seed[];program?:Seed};}
export interface IdlInstruction {name:string;discriminator:number[];accounts:IdlAccount[];args:Field[];}
export interface Idl {address:string;instructions:IdlInstruction[];types:Definition[];accounts:{name:string;discriminator:number[]}[];events:{name:string;discriminator:number[]}[];errors?:{code:number;name:string}[];}
export const idlOf=(module:SolModule):Idl=>(generated as unknown as Record<string,{idl:unknown}>)[`merces_${module}`]!.idl as Idl;
export const hex=(v:unknown)=>`0x${Buffer.from(v as Uint8Array).toString('hex')}`;
export function bytes(v:unknown,length?:number):Buffer {
  const out=typeof v==='string'&&/^0x(?:[0-9a-f]{2})*$/i.test(v)?Buffer.from(v.slice(2),'hex'):Buffer.from(v as Uint8Array);
  if(length!==undefined&&out.length!==length)throw new ChainError('InvalidTerms','invalid fixed byte length');return out;
}
export function integer(value:unknown,size:number,signed=false):Buffer{
  let x=BigInt(value as bigint|string|number),bits=BigInt(size*8),min=signed?-(1n<<(bits-1n)):0n,max=signed?(1n<<(bits-1n))-1n:(1n<<bits)-1n;
  if(x<min||x>max)throw new ChainError('InvalidTerms','instruction integer is outside its declared width');if(x<0)x+=1n<<bits;
  const out=Buffer.alloc(size);for(let i=0;i<size;i++){out[i]=Number(x&255n);x>>=8n;}return out;
}
function definition(idl:Idl,name:string):Definition{const t=idl.types.find((t)=>t.name===name);if(!t)throw new ChainError('ChainSpecific','missing IDL type',{type:name});return t;}
/** Borsh with explicit integer widths; the zero-copy Ledger's fields are already grouped/aligned by Stage 1. */
export function encodeType(idl:Idl,type:IdlType,value:unknown):Buffer {
  if(typeof type==='string'){
    if(/^[ui](8|16|32|64|128)$/.test(type))return integer(value,Number(type.slice(1))/8,type[0]==='i');
    if(type==='bool'){if(typeof value!=='boolean')throw new ChainError('InvalidTerms','expected boolean');return Buffer.from([value?1:0]);}
    if(type==='pubkey')return new PublicKey(value as string).toBuffer();
    if(type==='string'||type==='bytes'){const data=type==='string'?Buffer.from(String(value),'utf8'):bytes(value);return Buffer.concat([integer(data.length,4),data]);}
    throw new ChainError('ChainSpecific','unsupported IDL primitive',{type});
  }
  if('array' in type){if(type.array[0]==='u8')return bytes(value,type.array[1]);const values=value as unknown[];if(values.length!==type.array[1])throw new ChainError('InvalidTerms','invalid array length');return Buffer.concat(values.map((v)=>encodeType(idl,type.array[0],v)));}
  if('vec' in type){const values=value as unknown[];return Buffer.concat([integer(values.length,4),...values.map((v)=>encodeType(idl,type.vec,v))]);}
  if('option' in type)return value===null||value===undefined?Buffer.from([0]):Buffer.concat([Buffer.from([1]),encodeType(idl,type.option,value)]);
  const t=definition(idl,type.defined.name);
  if(t.type.kind==='struct')return Buffer.concat((t.type.fields??[]).map((f)=>encodeType(idl,f.type,(value as Row)[f.name])));
  const input=value as {variant:string;fields?:unknown[]|Row},index=t.type.variants?.findIndex((v)=>v.name===input.variant)??-1;
  if(index<0)throw new ChainError('InvalidTerms','invalid enum variant');const fields=t.type.variants![index]!.fields??[];
  return Buffer.concat([Buffer.from([index]),...fields.map((f,i)=>encodeType(idl,typeof f==='object'&&'name' in f?f.type:f as IdlType,Array.isArray(input.fields)?input.fields[i]:(input.fields as Row)?.[(f as Field).name]))]);
}
export class Decoder {
  offset=0;
  constructor(readonly idl:Idl,readonly data:Buffer){}
  take(size:number):Buffer{if(!Number.isSafeInteger(size)||size<0||this.offset+size>this.data.length)throw new ChainError('ChainSpecific','truncated account, instruction or event');const out=this.data.subarray(this.offset,this.offset+size);this.offset+=size;return out;}
  read(type:IdlType):unknown{
    if(typeof type==='string'){
      if(/^[ui](8|16|32|64|128)$/.test(type)){const size=Number(type.slice(1))/8,data=this.take(size);let x=0n;for(let i=size-1;i>=0;i--)x=(x<<8n)+BigInt(data[i]!);if(type[0]==='i'&&(data[size-1]!&128))x-=1n<<BigInt(size*8);return size<=4?Number(x):x;}
      if(type==='bool'){const x=this.take(1)[0];if(x!==0&&x!==1)throw new ChainError('ChainSpecific','noncanonical Borsh boolean');return x===1;}
      if(type==='pubkey')return new PublicKey(this.take(32)).toBase58();
      if(type==='string'||type==='bytes'){const data=this.take(Number(this.read('u32')));return type==='string'?data.toString('utf8'):data;}
      throw new ChainError('ChainSpecific','unsupported IDL primitive',{type});
    }
    if('array' in type)return type.array[0]==='u8'?this.take(type.array[1]):Array.from({length:type.array[1]},()=>this.read(type.array[0]));
    if('vec' in type){const len=Number(this.read('u32'));if(len>this.data.length)throw new ChainError('ChainSpecific','invalid vector length');return Array.from({length:len},()=>this.read(type.vec));}
    if('option' in type){const tag=this.take(1)[0];if(tag!==0&&tag!==1)throw new ChainError('ChainSpecific','noncanonical Borsh option');return tag?this.read(type.option):null;}
    const def=definition(this.idl,type.defined.name);
    if(def.type.kind==='struct')return Object.fromEntries((def.type.fields??[]).map((f)=>[f.name,this.read(f.type)]));
    const variant=def.type.variants?.[this.take(1)[0]!];if(!variant)throw new ChainError('ChainSpecific','unknown enum discriminator');
    return {variant:variant.name,fields:(variant.fields??[]).map((f)=>this.read(typeof f==='object'&&'name' in f?f.type:f as IdlType))};
  }
}
export function encodeInstruction(module:SolModule,name:string,args:Row):Buffer {
  const idl=idlOf(module),ix=idl.instructions.find((i)=>i.name===name);if(!ix)throw new ChainError('ChainSpecific','instruction is absent from pinned IDL',{module,name});
  return Buffer.concat([Buffer.from(ix.discriminator),...ix.args.map((f)=>encodeType(idl,f.type,args[f.name]))]);
}
export function decodeInstruction(module:SolModule,data:Buffer):{name:string;args:Row}|null{
  const idl=idlOf(module),ix=idl.instructions.find((i)=>Buffer.from(i.discriminator).equals(data.subarray(0,8)));if(!ix)return null;
  const d=new Decoder(idl,data.subarray(8)),args=Object.fromEntries(ix.args.map((f)=>[f.name,d.read(f.type)]));if(d.offset!==data.length-8)throw new ChainError('ChainSpecific','instruction has trailing data');return {name:ix.name,args};
}
export function decodeAccount(module:SolModule,data:Buffer):{type:string;value:Row}|null{
  const idl=idlOf(module),a=idl.accounts.find((x)=>Buffer.from(x.discriminator).equals(data.subarray(0,8)));if(!a)return null;
  return {type:a.name,value:new Decoder(idl,data.subarray(8)).read({defined:{name:a.name}}) as Row};
}
export function decodeEvent(module:SolModule,data:Buffer):{name:string;args:Row}|null{
  const idl=idlOf(module),e=idl.events.find((x)=>Buffer.from(x.discriminator).equals(data.subarray(0,8)));if(!e)return null;
  const d=new Decoder(idl,data.subarray(8)),args=d.read({defined:{name:e.name}}) as Row;if(d.offset!==data.length-8)throw new ChainError('ChainSpecific','event has trailing data');return {name:e.name,args};
}
export function instruction(module:SolModule,program:string,name:string,args:Row,accounts:Record<string,string|null>,remaining:AccountMeta[]=[]):TransactionInstruction{
  const ix=idlOf(module).instructions.find((i)=>i.name===name);if(!ix)throw new ChainError('ChainSpecific','missing IDL instruction');
  const keys=ix.accounts.map((a)=>{const value=Object.hasOwn(accounts,a.name)?accounts[a.name]:a.address;if(value===undefined&&!a.optional)throw new ChainError('ChainSpecific','instruction account unresolved',{instruction:name,account:a.name});return {pubkey:new PublicKey(value??program),isSigner:a.signer??false,isWritable:value===null||value===undefined?false:a.writable??false};});
  return new TransactionInstruction({programId:new PublicKey(program),keys:[...keys,...remaining],data:encodeInstruction(module,name,args)});
}
