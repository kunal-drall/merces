import { createDecipheriv, createCipheriv, privateDecrypt, constants, randomBytes } from 'node:crypto';

/** The request id binds both directions. Neither plaintext nor the reply key is stored by the relay. */
export function openOperatorEnvelope(privateKey:string,id:string,envelope:{wrappedKey:string;iv:string;ciphertext:string}) {
  const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,'base64'));
  if(key.length!==32)throw Error('envelope-key-refused');
  try {
    const sealed=Buffer.from(envelope.ciphertext,'base64'),iv=Buffer.from(envelope.iv,'base64');
    if(iv.length!==12||sealed.length<16)throw Error('envelope-refused');
    const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('merces/operator/request/v1:'+id));decipher.setAuthTag(sealed.subarray(-16));
    const bytes=Buffer.concat([decipher.update(sealed.subarray(0,-16)),decipher.final()]);
    let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
    return {value,seal:(result:unknown)=>{
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('merces/operator/reply/v1:'+id));
      const plaintext=Buffer.from(JSON.stringify(result));
      try{return {v:1,iv:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]).toString('base64')};}finally{plaintext.fill(0);key.fill(0);}
    },clear:()=>key.fill(0)};
  }catch{key.fill(0);throw Error('envelope-refused');}
}
