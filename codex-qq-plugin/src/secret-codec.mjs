import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const aad=Buffer.from('alexbot-private-config:v1');
export function seal(value,key){
  if(!Buffer.isBuffer(key)||key.length!==32)throw Error('PRIVATE_STORAGE_UNAVAILABLE');
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(aad);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['gcm1',nonce.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join(':');
}
export function unseal(value,key){
  try{
    if(typeof value!=='string'||value.length>2_000_000||!Buffer.isBuffer(key)||key.length!==32)throw Error();
    const parts=value.split(':');if(parts.length!==4||parts[0]!=='gcm1')throw Error();
    const [nonce,tag,data]=parts.slice(1).map(x=>Buffer.from(x,'base64'));
    if(nonce.length!==12||tag.length!==16)throw Error();
    const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8'));
  }catch{throw Error('PRIVATE_STORAGE_UNAVAILABLE');}
}
export async function masterKey(){
  const file=process.env.QQ_MASTER_KEY_FILE||(process.env.CREDENTIALS_DIRECTORY&&path.join(process.env.CREDENTIALS_DIRECTORY,'master.key'));
  if(!file||!path.isAbsolute(file))throw Error('PRIVATE_STORAGE_UNAVAILABLE');
  const stat=await fs.stat(file);
  if(!stat.isFile()||stat.size!==32||(process.platform!=='win32'&&(stat.mode&0o077)))throw Error('PRIVATE_STORAGE_UNAVAILABLE');
  return fs.readFile(file);
}
