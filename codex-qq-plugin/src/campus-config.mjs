import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,protectCredential,unprotectCredential,credentialFormat,supportedCredentialFormat} from './storage.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const username=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{4,40}$/.test(v);
const password=v=>typeof v==='string'&&v.length>=1&&v.length<=256&&!/[\u0000-\u001f\u007f]/u.test(v);
const valid=v=>object(v)&&Object.keys(v).sort().join(',')==='enabled,password,username'&&typeof v.enabled==='boolean'&&
  ((v.username===''&&v.password===''&&!v.enabled)||(username(v.username)&&password(v.password)));
const publicStatus=v=>({enabled:v.enabled,configured:Boolean(v.username&&v.password)});

// PrivateStore initializes and restricts the shared .private directory first.
export class CampusConfigStore{
  #file;#protect;#unprotect;#tail=Promise.resolve();
  constructor(home,{protect=protectCredential,unprotect=unprotectCredential}={}){
    if(typeof home!=='string'||!path.isAbsolute(home))throw fail('CAMPUS_CONFIG_INVALID');
    this.#file=path.join(home,'.private','campus-config.json');this.#protect=protect;this.#unprotect=unprotect;
  }
  #enqueue(fn){const work=this.#tail.then(fn);this.#tail=work.catch(()=>{});return work;}
  async #load(){
    let raw;try{raw=await fs.readFile(this.#file,'utf8');}catch(e){if(e.code==='ENOENT')return {enabled:false,username:'',password:''};throw fail('CAMPUS_CONFIG_UNAVAILABLE');}
    try{
      const e=JSON.parse(raw);
      if(!object(e)||Object.keys(e).sort().join(',')!=='cipher,format,version'||e.version!==1||!supportedCredentialFormat(e.format)||typeof e.cipher!=='string'||!e.cipher||e.cipher.length>65536)throw Error();
      const v=await this.#unprotect(e.cipher);if(!valid(v))throw Error();return v;
    }catch{throw fail('CAMPUS_CONFIG_UNAVAILABLE');}
  }
  read(){return this.#enqueue(()=>this.#load());}
  status(){return this.#enqueue(async()=>publicStatus(await this.#load()));}
  save(input){return this.#enqueue(async()=>{
    if(!object(input)||Object.keys(input).some(k=>!['enabled','username','password'].includes(k))||typeof input.enabled!=='boolean')throw fail('CAMPUS_CONFIG_INVALID');
    const hasUser=Object.hasOwn(input,'username'),hasPassword=Object.hasOwn(input,'password');
    if(hasUser!==hasPassword||(hasUser&&(!username(input.username)||!password(input.password))))throw fail('CAMPUS_CONFIG_INVALID');
    const v={...await this.#load(),enabled:input.enabled,...(hasUser?{username:input.username,password:input.password}:{})};
    if(!valid(v))throw fail('CAMPUS_CONFIG_INVALID');
    try{const cipher=await this.#protect(v);if(typeof cipher!=='string'||!cipher||cipher.length>65536)throw Error();await atomicJson(this.#file,{version:1,format:credentialFormat(),cipher});}
    catch{throw fail('CAMPUS_CONFIG_UNAVAILABLE');}
    return publicStatus(v);
  });}
}
