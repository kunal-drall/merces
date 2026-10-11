import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {Connection,Message,PublicKey} from '@solana/web3.js';
import {ChainError,isPublishedTestKey,type WalletSigner} from '@merces/domain';
import {assertNotMainnet,checkGenesis,type SolanaChainConfig} from './config.ts';
import {solanaError} from './transport.ts';
/** A local operator service key; issuer and attestor keys never enter the server. */
export function solanaServiceWallet(config:SolanaChainConfig,seed:Uint8Array):WalletSigner{
  assertNotMainnet(config);if(seed.length!==32)throw new ChainError('InvalidTerms','Solana service seed must contain 32 bytes');
  const privateKey=createPrivateKey({format:'der',type:'pkcs8',key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed)])}),publicKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32),address=new PublicKey(publicKey).toBase58();
  if(isPublishedTestKey(address))throw new ChainError('Unauthorized','published test keys are refused on live chains');
  const connection=new Connection(config.rpcUrl,'finalized');
  async function network(){const refusal=checkGenesis(config.cluster,await connection.getGenesisHash());if(refusal)throw new ChainError('Unauthorized',refusal);}
  return {family:'solana',address,
    async sign(tx){
      if(tx.chain!==config.chain||tx.family!=='solana'||tx.encoding!=='solana-base64'||tx.signer!==address)throw new ChainError('Unauthorized','service transaction belongs to another wallet or chain');
      let raw:Buffer;try{raw=Buffer.from(tx.payload,'base64');const message=Message.from(raw);if(message.header.numRequiredSignatures!==1||message.accountKeys[0]!.toBase58()!==address)throw new Error();}catch{throw new ChainError('Unauthorized','transaction must have exactly this service signer');}
      try{await network();return {tx,signatures:{[address]:`0x${sign(null,raw,privateKey).toString('hex')}`}};}catch(e){throw solanaError(e);}
    },
    async signMessage(message){await network();return `0x${sign(null,message,privateKey).toString('hex')}`;},
  };
}
