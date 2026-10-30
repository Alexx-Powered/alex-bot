import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,protectCredential,unprotectCredential,credentialFormat,supportedCredentialFormat} from './storage.mjs';
const defaults=()=>({enabled:true,autoWhiteImages:true,autoMemes:true,asrEnabled:false,apiKey:''});
const keys=Object.keys(defaults());
function valid(v){return v&&keys.every(k=>k==='apiKey'?typeof v[k]==='string'&&(v[k]===''||/^\S{8,512}$/u.test(v[k])):typeof v[k]==='boolean')&&Object.keys(v).every(k=>keys.includes(k))&&(!v.asrEnabled||v.apiKey);}
const error=()=>Object.assign(Error('SOCIAL_CONFIG_INVALID'),{code:'SOCIAL_CONFIG_INVALID'});
export class SocialConfigStore{
  #tail=Promise.resolve();
  constructor(home,{protect=protectCredential,unprotect=unprotectCredential}={}){this.file=path.join(home,'.private/social-config.json');Object.assign(this,{protect,unprotect});}
  async read(){
    let v;try{v=JSON.parse(await fs.readFile(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return defaults();throw error();}
    if(v.version!==1||!supportedCredentialFormat(v.format)||typeof v.cipher!=='string'||v.cipher.length>65536)throw error();
    const c=await this.unprotect(v.cipher);if(!valid(c))throw error();return c;
  }
  async status(){const {apiKey,...v}=await this.read();return {...v,asrConfigured:Boolean(apiKey),asrModel:'qwen3-asr-flash',visionModel:'deepseek-flash'};}
  save(input){const work=this.#tail.then(async()=>{
    if(!input||Object.keys(input).some(k=>!keys.includes(k)))throw error();
    const next={...await this.read(),...input};if(!valid(next))throw error();
    const cipher=await this.protect(next);await atomicJson(this.file,{version:1,format:credentialFormat(),cipher});return this.status();
  });this.#tail=work.catch(()=>{});return work;}
}
