import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson,protectCredential,unprotectCredential,credentialFormat,supportedCredentialFormat} from './storage.mjs';

const DEFAULTS=Object.freeze({enabled:false,apiKey:'',project:'alex-bot',endpoint:'https://api.smith.langchain.com',workspaceId:''});
const KEYS=['enabled','apiKey','project','endpoint','workspaceId'];
const ENDPOINTS=new Set(['https://api.smith.langchain.com','https://eu.api.smith.langchain.com']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>Object.assign(new Error(code),{code});
const validProject=value=>typeof value==='string'&&value===value.trim()&&/^[\p{L}\p{N} _.-]{1,80}$/u.test(value);
const validWorkspace=value=>typeof value==='string'&&(value===''||/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value));
const validKey=value=>typeof value==='string'&&(value===''||/^\S{8,512}$/u.test(value));
const valid=value=>object(value)&&Object.keys(value).length===KEYS.length&&KEYS.every(key=>Object.hasOwn(value,key))&&
  typeof value.enabled==='boolean'&&validKey(value.apiKey)&&(!value.enabled||value.apiKey!=='')&&validProject(value.project)&&ENDPOINTS.has(value.endpoint)&&validWorkspace(value.workspaceId);
const publicStatus=value=>({enabled:value.enabled,configured:Boolean(value.apiKey),project:value.project,endpoint:value.endpoint,workspaceId:value.workspaceId});

// PrivateStore establishes the shared private directory and its ACL before use.
export class MonitoringConfigStore {
  #file;#protect;#unprotect;#tail=Promise.resolve();
  constructor(home,{protect=protectCredential,unprotect=unprotectCredential}={}){
    if(typeof home!=='string'||!path.isAbsolute(home)||typeof protect!=='function'||typeof unprotect!=='function')throw fail('MONITORING_CONFIG_INVALID');
    this.#file=path.join(home,'.private','monitoring-config.json');this.#protect=protect;this.#unprotect=unprotect;
  }
  #enqueue(fn){const work=this.#tail.then(fn);this.#tail=work.catch(()=>{});return work;}
  async #load(){
    let raw;
    try{raw=await fs.readFile(this.#file,'utf8');}catch(error){if(error.code==='ENOENT')return {...DEFAULTS};throw fail('MONITORING_CONFIG_UNAVAILABLE');}
    try{
      if(Buffer.byteLength(raw)>131072)throw Error();
      const envelope=JSON.parse(raw);
      if(!object(envelope)||Object.keys(envelope).sort().join(',')!=='cipher,format,version'||envelope.version!==1||!supportedCredentialFormat(envelope.format)||typeof envelope.cipher!=='string'||envelope.cipher.length<1||envelope.cipher.length>65536)throw Error();
      const value=await this.#unprotect(envelope.cipher);if(!valid(value))throw Error();
      return Object.fromEntries(KEYS.map(key=>[key,value[key]]));
    }catch{throw fail('MONITORING_CONFIG_UNAVAILABLE');}
  }
  read(){return this.#enqueue(()=>this.#load());}
  status(){return this.#enqueue(async()=>publicStatus(await this.#load()));}
  save(input){return this.#enqueue(async()=>{
    if(!object(input)||Object.keys(input).some(key=>!KEYS.includes(key))||typeof input.enabled!=='boolean')throw fail('MONITORING_CONFIG_INVALID');
    if(Object.hasOwn(input,'project')&&!validProject(input.project)||Object.hasOwn(input,'endpoint')&&!ENDPOINTS.has(input.endpoint)||Object.hasOwn(input,'workspaceId')&&!validWorkspace(input.workspaceId))throw fail('MONITORING_CONFIG_INVALID');
    const hasKey=Object.hasOwn(input,'apiKey');
    if(hasKey&&(typeof input.apiKey!=='string'||(!/^\s*$/u.test(input.apiKey)&&!validKey(input.apiKey))))throw fail('MONITORING_CONFIG_INVALID');
    const current=await this.#load();
    const next={...current,...input,apiKey:hasKey&&input.apiKey.trim()?input.apiKey:current.apiKey};
    if(!valid(next))throw fail('MONITORING_CONFIG_INVALID');
    try{
      const cipher=await this.#protect(next);if(typeof cipher!=='string'||cipher.length<1||cipher.length>65536)throw Error();
      await atomicJson(this.#file,{version:1,format:credentialFormat(),cipher});
    }catch{throw fail('MONITORING_CONFIG_UNAVAILABLE');}
    return publicStatus(next);
  });}
}
