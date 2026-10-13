import {afterEach,describe,expect,it,vi} from 'vitest';
import {decodeFunctionData,encodeFunctionResult,erc20Abi,multicall3Abi,type Hex} from 'viem';
import {EvmChain} from '../src/chain.ts';
import type {EvmChainConfig} from '../src/config.ts';

const token='0x534b2f3A21130d7a60830c2Df862319e593943A3';
const wallet='0x1111111111111111111111111111111111111111';
const config:EvmChainConfig={chain:'monad',network:'monad-testnet',chainId:10143,rpcUrl:'https://testnet-rpc.monad.xyz',contracts:{},abiDir:null,generatedDir:null,stablecoins:{USDC:token},startBlock:251450,finalityTag:'finalized',keeperAddress:null,allowlistManagerAddress:null};
afterEach(()=>vi.unstubAllGlobals());

describe('Monad finalized Multicall reads',()=>{
  it('groups getters by exact block, preserves amounts, and reads changed balances on later calls',async()=>{
    const calls:{block:string;size:number}[]=[];
    let balance=18_990_000n;
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      const reply=(rpc:{id:number;method:string;params:[{to:string;data:Hex},string]})=>{
        expect(rpc.method).toBe('eth_call');
        expect(rpc.params[0].to.toLowerCase()).toBe('0xca11bde05977b3631167028862be2a173976ca11');
        const decoded=decodeFunctionData({abi:multicall3Abi,data:rpc.params[0].data});
        expect(decoded.functionName).toBe('aggregate3');
        const group=(decoded.args as readonly [readonly {target:string;callData:Hex}[]])[0];
        calls.push({block:rpc.params[1],size:group.length});
        const result=group.map(call=>{
          expect(call.target.toLowerCase()).toBe(token.toLowerCase());
          const read=decodeFunctionData({abi:erc20Abi,data:call.callData});
          return {success:true,returnData:read.functionName==='decimals'
            ?encodeFunctionResult({abi:erc20Abi,functionName:'decimals',result:6})
            :encodeFunctionResult({abi:erc20Abi,functionName:'balanceOf',result:balance})};
        });
        return {jsonrpc:'2.0',id:rpc.id,result:encodeFunctionResult({abi:multicall3Abi,functionName:'aggregate3',result})};
      };
      return new Response(JSON.stringify(Array.isArray(body)?body.map(reply):reply(body)),{headers:{'Content-Type':'application/json'}});
    }));
    const client=new EvmChain(config).client;
    const readBalance=(blockNumber:bigint)=>client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[wallet],blockNumber});
    expect(await Promise.all([
      client.readContract({address:token,abi:erc20Abi,functionName:'decimals',blockNumber:300000n}),
      readBalance(300000n),readBalance(300001n),
    ])).toEqual([6,18_990_000n,18_990_000n]);
    expect(calls).toEqual([{block:'0x493e0',size:2},{block:'0x493e1',size:1}]);
    balance=19_990_000n;
    expect(await readBalance(300002n)).toBe(19_990_000n);
    expect(calls.at(-1)).toEqual({block:'0x493e2',size:1});
  });

  it('keeps unknown endpoints on direct reads instead of assuming a Multicall deployment',()=>{
    const client=new EvmChain({...config,rpcUrl:'http://127.0.0.1:8545'}).client;
    expect(client.batch?.multicall).toBeUndefined();
    expect(client.chain?.contracts?.multicall3).toBeUndefined();
  });
});
