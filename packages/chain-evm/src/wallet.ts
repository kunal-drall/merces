import {createWalletClient,http,getAddress,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ChainError,isPublishedTestKey,type WalletSigner,type SignedTx,type UnsignedTx} from '@merces/domain';
import {assertNotMainnet,type EvmChainConfig} from './config.ts';
import {evmError} from './abi.ts';
import type {EvmPayload} from './transport.ts';

/** Operator-provided local service key. No issuer or attestor key is loaded by this adapter. */
export function evmServiceWallet(config:EvmChainConfig,privateKey:Hex):WalletSigner {
  assertNotMainnet(config);
  let account:ReturnType<typeof privateKeyToAccount>;
  try{account=privateKeyToAccount(privateKey);}catch{throw new ChainError('InvalidTerms','invalid EVM service key');}
  const address=account.address.toLowerCase();
  if(isPublishedTestKey(address))throw new ChainError('Unauthorized','published test keys are refused on live chains');
  const chain={id:config.chainId,name:config.network,nativeCurrency:{name:'native',symbol:'NATIVE',decimals:18},rpcUrls:{default:{http:[config.rpcUrl]}}};
  const client=createWalletClient({account,chain,transport:http(config.rpcUrl)});
  async function verify(){if(await client.getChainId()!==config.chainId)throw new ChainError('Unauthorized','refusing: service signer RPC chain id differs from configured testnet');}
  return {family:'evm',address,
    async sign(tx:UnsignedTx):Promise<SignedTx>{
      if(tx.chain!==config.chain||tx.family!=='evm'||tx.encoding!=='evm-json'||tx.signer.toLowerCase()!==address)throw new ChainError('Unauthorized','service transaction belongs to another wallet or chain');
      let p:EvmPayload;try{p=JSON.parse(tx.payload) as EvmPayload;}catch{throw new ChainError('InvalidTerms','invalid EVM payload');}
      if(p.chainId!==config.chainId)throw new ChainError('Unauthorized','refusing: transaction chain id differs from configured testnet');
      try{await verify();const request=await client.prepareTransactionRequest({account,chain,to:getAddress(p.to),data:p.data,value:BigInt(p.value)});const raw=await client.signTransaction(request);return {tx,signatures:{[address]:raw}};}catch(e){throw evmError(e);}
    },
    async signMessage(message:Uint8Array){await verify();return account.signMessage({message:{raw:message}});},
  };
}
