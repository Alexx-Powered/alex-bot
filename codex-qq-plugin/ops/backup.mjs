// Operator-only encrypted backup. Recovery identities stay DPAPI-protected on Windows.
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {randomBytes,publicEncrypt,privateDecrypt,createCipheriv,createDecipheriv,constants} from 'node:crypto';
import {unprotectCredential,atomicJson} from '../src/storage.mjs';
import {unseal} from '../src/secret-codec.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {collectRagBackupFiles,verifyRagBackupFiles,restoreRagBackupFiles} from './rag-backup.mjs';
const options={padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
const aad=Buffer.from('alexbot-backup-v1');
try{
  if(process.argv[2]==='create'&&process.platform==='linux'){
    const home='/var/lib/alexbot';
    const names=['.private/credentials.json','.private/agent-config.json','.private/campus-config.json','.private/campus-session.json','.private/monitoring-config.json','.private/social-config.json','.private/admin-token','.private/integration-token','.private/state.json','.private/model-budget.json','.private/campus-output/latest.json','.private/campus-output/memory.json','config/send-limits.json','config/chat-policy.md','config/morning-report.json'];
    for(const name of await fs.readdir(path.join(home,'.private/morning-scheduler')))if(/^\d{4}-\d{2}-\d{2}\.json$/.test(name))names.push('.private/morning-scheduler/'+name);
    const files={};
    for(const name of names){try{const raw=await fs.readFile(path.join(home,name));if(raw.length>2_000_000)throw Error('OVERSIZE');files[name]=raw.toString('base64');}catch(e){if(e.code!=='ENOENT')throw e;}}
    const snapshot=await promisify(execFile)('/opt/alex-bot-runtime/python/app-venv/bin/python',[fileURLToPath(new URL('../python/chat_memory_snapshot.py',import.meta.url))],{maxBuffer:6*1024*1024,timeout:15000});
    if(snapshot.stdout)files['.private/chat-memory/chat-memory.sqlite3']=snapshot.stdout;
    const ragFiles=await collectRagBackupFiles({root:home});
    for(const [name,value] of Object.entries(ragFiles)){
      if(Object.hasOwn(files,name))throw Error('BACKUP_FILE_COLLISION');
      files[name]=value;
    }
    const key=randomBytes(32),nonce=randomBytes(12),at=new Date().toISOString();
    try{
      const plain=Buffer.from(JSON.stringify({version:1,createdAt:at,files}));if(plain.length>32_000_000)throw Error('OVERSIZE');
      const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
      const encrypted=Buffer.concat([cipher.update(gzipSync(plain)),cipher.final()]);plain.fill(0);
      const publicKey=await fs.readFile(path.join(process.env.CREDENTIALS_DIRECTORY,'backup.public'));
      const target='/var/backups/alexbot/alexbot-'+at.replace(/[-:.]/g,'')+'.json';
      await atomicJson(target,{version:1,createdAt:at,wrappedKey:publicEncrypt({...options,key:publicKey},key).toString('base64'),nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')});
      console.log(JSON.stringify({ok:true,file:target,files:Object.keys(files).length}));
    }finally{key.fill(0);}
  }else if(['verify','restore-rag'].includes(process.argv[2])&&process.platform==='win32'){
    const [file,home,destination]=process.argv.slice(3);
    if(process.argv[2]==='restore-rag'&&!destination)throw Error('INVALID_MODE');
    const identity=await unprotectCredential(JSON.parse(await fs.readFile(path.join(home,'.private/migration/local-identity.json'),'utf8')).cipher);
    const recovery=await unprotectCredential(JSON.parse(await fs.readFile(path.join(home,'.private/migration/cloud-access.json'),'utf8')).cipher);
    const packet=JSON.parse(await fs.readFile(file,'utf8'));if(packet.version!==1)throw Error('FORMAT');
    const key=privateDecrypt({...options,key:identity.privateKey},Buffer.from(packet.wrappedKey,'base64'));
    try{
      const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(packet.nonce,'base64'));cipher.setAAD(aad);cipher.setAuthTag(Buffer.from(packet.tag,'base64'));
      const plain=gunzipSync(Buffer.concat([cipher.update(Buffer.from(packet.ciphertext,'base64')),cipher.final()]),{maxOutputLength:32_000_000});
      const payload=JSON.parse(plain);plain.fill(0);
      const master=Buffer.from(recovery.masterRecovery,'base64');
      const monitoringIncluded=Object.hasOwn(payload.files,'.private/monitoring-config.json');
      const socialIncluded=Object.hasOwn(payload.files,'.private/social-config.json');
      try{for(const name of ['credentials','agent-config','campus-config','campus-session',...monitoringIncluded?['monitoring-config']:[],...socialIncluded?['social-config']:[]]){const data=JSON.parse(Buffer.from(payload.files['.private/'+name+'.json'],'base64'));if(data.format!=='aes-256-gcm-v1')throw Error('FORMAT');unseal(data.cipher,master);}}finally{master.fill(0);}
      const rag=await verifyRagBackupFiles(payload.files);
      if(process.argv[2]==='restore-rag'){
        const restored=await restoreRagBackupFiles(payload.files,{root:destination});
        console.log(JSON.stringify({ok:true,...restored,plaintext_written:true}));
      }else console.log(JSON.stringify({ok:true,createdAt:payload.createdAt,files:Object.keys(payload.files).length,encrypted_credentials_recoverable:true,monitoring_config_included:monitoringIncluded,social_config_included:socialIncluded,rag,plaintext_written:false}));
    }finally{key.fill(0);}
  }else throw Error('INVALID_MODE');
}catch{console.error('BACKUP_OPERATION_FAILED');process.exitCode=1;}
