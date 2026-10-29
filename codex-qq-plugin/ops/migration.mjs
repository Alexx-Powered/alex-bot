// Operator-only offline migration. Never expose these operations to the agent or HTTP API.
import fs from 'node:fs/promises';
import {constants as fileConstants} from 'node:fs';
import path from 'node:path';
import {randomBytes,generateKeyPairSync,publicEncrypt,privateDecrypt,constants} from 'node:crypto';
import {seal,unseal,masterKey} from '../src/secret-codec.mjs';
import {PrivateStore,protectCredential,unprotectCredential,atomicJson} from '../src/storage.mjs';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {CampusConfigStore} from '../src/campus-config.mjs';

const allowed=name=>['.private/state.json','.private/model-budget.json','.private/campus-output/latest.json','.private/campus-output/memory.json','.private/migration/cutover-state.json','config/send-limits.json','config/chat-policy.md','config/morning-report.json'].includes(name)||/^\.private\/morning-scheduler\/\d{4}-\d{2}-\d{2}\.json$/.test(name);
async function pack(value,publicFile){
  const key=randomBytes(32);
  try{return {version:1,key:publicEncrypt({key:await fs.readFile(publicFile),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),cipher:seal(value,key)};}finally{key.fill(0);}
}
function unpack(value,privateKey){
  if(value.version!==1)throw Error('INVALID_PACKAGE');
  const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(value.key,'base64'));
  try{return unseal(value.cipher,key);}finally{key.fill(0);}
}
async function collectFiles(home){
  const names=['.private/state.json','.private/model-budget.json','.private/campus-output/latest.json','.private/campus-output/memory.json','.private/migration/cutover-state.json','config/send-limits.json','config/chat-policy.md','config/morning-report.json'];
  try{for(const name of await fs.readdir(path.join(home,'.private','morning-scheduler')))if(/^\d{4}-\d{2}-\d{2}\.json$/.test(name))names.push('.private/morning-scheduler/'+name);}catch(e){if(e.code!=='ENOENT')throw e;}
  const files={};for(const name of names){try{const raw=await fs.readFile(path.join(home,name),'utf8');if(raw.length>2_000_000)throw Error('OVERSIZE');files[name]=raw;}catch(e){if(e.code!=='ENOENT')throw e;}}
  return files;
}
async function main(){
  const [mode,home,file,extra]=process.argv.slice(2);
  if(!home||!path.isAbsolute(home))throw Error('ABSOLUTE_HOME_REQUIRED');
  const migration=path.join(home,'.private','migration');
  if(mode==='prepare-local'){
    await fs.mkdir(migration,{recursive:true,mode:0o700});
    const identityFile=path.join(migration,'local-identity.json');
    try{await fs.access(identityFile);}catch{
      const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
      await atomicJson(identityFile,{cipher:await protectCredential({privateKey:pair.privateKey})});
      await fs.writeFile(path.join(migration,'local-public.pem'),pair.publicKey,{mode:0o600});
    }
  }else if(mode==='prepare-server'){
    if(process.platform!=='linux'||home!=='/var/lib/alexbot')throw Error('SERVER_ONLY');
    const folder='/etc/alexbot';await fs.mkdir(folder,{recursive:true,mode:0o700});
    try{await fs.writeFile(path.join(folder,'master.key'),randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    await fs.writeFile(path.join(folder,'migration-import.key'),pair.privateKey,{flag:'wx',mode:0o600});
    await fs.writeFile(path.join(folder,'migration-public.pem'),pair.publicKey,{mode:0o644});
  }else if(mode==='export'){
    if(process.platform!=='win32')throw Error('WINDOWS_EXPORT_ONLY');
    const secrets=extra==='state'?undefined:{qq:await new PrivateStore(home).readCredentials(),agent:await new AgentConfigStore(home).read(),campus:await new CampusConfigStore(home).read()};
    const payload={purpose:'alexbot-migration',createdAt:new Date().toISOString(),files:await collectFiles(home),...(secrets?{secrets}:{})};
    await atomicJson(path.join(migration,extra==='state'?'state-export.json':'initial-export.json'),await pack(payload,file));
  }else if(mode==='import'){
    if(home!=='/var/lib/alexbot')throw Error('SERVER_ONLY');
    const value=unpack(JSON.parse(await fs.readFile(file,'utf8')),await fs.readFile(path.join(process.env.CREDENTIALS_DIRECTORY,'import.key')));
    if(value.purpose!=='alexbot-migration'||Date.now()-Date.parse(value.createdAt)>3600_000)throw Error('INVALID_PACKAGE');
    const store=new PrivateStore(home);await store.init();
    for(const [name,raw]of Object.entries(value.files)){
      if(!allowed(name)||typeof raw!=='string'||raw.length>2_000_000)throw Error('INVALID_PACKAGE');
      const target=path.join(home,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      if(name.endsWith('.json')){
        let data=JSON.parse(raw);
        // Keep real preflight model usage when importing the final Windows snapshot.
        if(name==='.private/model-budget.json'){
          try{const prior=JSON.parse(await fs.readFile(target,'utf8'));if(prior.version===1&&data.version===1){const records=new Map([...prior.records,...data.records].map(r=>[JSON.stringify(r),r]));data={version:1,records:[...records.values()].sort((a,b)=>a.at-b.at)};}}catch(e){if(e.code!=='ENOENT')throw e;}
        }
        await atomicJson(target,data);
      }else await fs.writeFile(target,raw,{mode:0o600});
    }
    if(value.secrets){
      await store.saveCredentials(value.secrets.qq);await new AgentConfigStore(home).save(value.secrets.agent);await new CampusConfigStore(home).save(value.secrets.campus);
    }
    console.log(JSON.stringify({imported_files:Object.keys(value.files).length,credentials_imported:Boolean(value.secrets)}));return;
  }else if(mode==='export-access'){
    const store=new PrivateStore(home);await store.init();const key=await masterKey();
    try{await atomicJson(path.join(home,'.private','access-export.json'),await pack({purpose:'alexbot-access',adminToken:store.token,integrationToken:store.integrationToken,masterRecovery:key.toString('base64')},file));}finally{key.fill(0);}
  }else if(mode==='save-access'){
    const identity=await unprotectCredential(JSON.parse(await fs.readFile(path.join(migration,'local-identity.json'),'utf8')).cipher);
    const value=unpack(JSON.parse(await fs.readFile(file,'utf8')),identity.privateKey);
    if(value.purpose!=='alexbot-access'||!/^\w{64}$/.test(value.adminToken)||!/^\w{64}$/.test(value.integrationToken))throw Error('INVALID_PACKAGE');
    await atomicJson(path.join(migration,'cloud-access.json'),{cipher:await protectCredential(value)});
  }else if(mode==='activate-access'){
    const value=await unprotectCredential(JSON.parse(await fs.readFile(path.join(migration,'cloud-access.json'),'utf8')).cipher);
    for(const [name,key]of [['admin-token','adminToken'],['integration-token','integrationToken']]){
      const target=path.join(home,'.private',name);
      try{await fs.copyFile(target,path.join(migration,'previous-'+name),fileConstants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'&&e.code!=='ENOENT')throw e;}
      await fs.writeFile(target,value[key],{mode:0o600});
    }
  }else throw Error('INVALID_MODE');
  console.log(JSON.stringify({ok:true,operation:mode}));
}
main().catch(()=>{console.error('MIGRATION_OPERATION_FAILED');process.exitCode=1;});
