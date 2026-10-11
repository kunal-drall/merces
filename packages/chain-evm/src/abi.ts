import {decodeErrorResult,encodeFunctionData,getAddress,type Abi,type Address,type Hex} from 'viem';
import {ChainError,stage1ChainError,parseSeriesId} from '@merces/domain';
import * as generated from '../../stage1-sync/generated/evm/index.ts';

export const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
export const ZERO20 = `0x${'00'.repeat(20)}` as Address;
export type EvmModule = 'Registry'|'Auction'|'Income'|'Vault'|'Treasury'|'Window'|'Router'|'FxAccumulator'|'UnitToken';
export const abiOf = (name:EvmModule):Abi => (generated as Record<string,unknown>)[`Merces${name}Abi`] as Abi;
export function moduleAddress(contracts:Record<string,string>,name:EvmModule):Address {
  const address=contracts[`Merces${name}`] ?? contracts[name] ?? contracts[name[0]!.toLowerCase()+name.slice(1)];
  if(!address)throw new ChainError('ChainSpecific',`missing deployment module: Merces${name}`);
  return getAddress(address);
}
export function seriesNumber(seriesId:string,chain:string):bigint {
  const parsed=parseSeriesId(seriesId);
  if(parsed.chain!==chain || !/^(?:0x[0-9a-fA-F]{1,64}|[0-9]+)$/.test(parsed.address))throw new ChainError('InvalidTerms','invalid EVM series identifier');
  const n=BigInt(parsed.address);
  if(n<=0n || n>=(1n<<256n))throw new ChainError('InvalidTerms','invalid EVM series identifier');
  return n;
}
export const calldata=(module:EvmModule,name:string,args:readonly unknown[]=[]):Hex => encodeFunctionData({abi:abiOf(module),functionName:name,args});

/** Preserve protocol error names, never RPC request bodies, signatures, revert args or raw income. */
export function evmError(error:unknown):ChainError {
  if(error instanceof ChainError)return error;
  let item=error as {cause?:unknown;data?:unknown;errorName?:unknown};
  for(let i=0;item && i<8;i++,item=item.cause as typeof item) {
    if(typeof item.errorName==='string')return stage1ChainError(item.errorName);
    if(typeof item.data==='string' && /^0x[0-9a-f]+$/i.test(item.data)) {
      for(const module of ['Registry','Auction','Income','Vault','Treasury','Window','Router','FxAccumulator'] as const)try {
        const decoded=decodeErrorResult({abi:abiOf(module),data:item.data as Hex});
        return stage1ChainError(decoded.errorName);
      } catch {}
    }
  }
  return new ChainError('ChainSpecific','EVM RPC operation failed');
}
