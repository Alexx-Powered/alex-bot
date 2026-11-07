// Operator-only subprocess bridge; private payloads never appear in argv/logs.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PrivateStore} from '../src/storage.mjs';
const script=fileURLToPath(new URL('./rag_backup.py',import.meta.url));
const manifest='.private/rag-backup-manifest.json';
const defaultPython=process.platform==='win32'
  ?fileURLToPath(new URL('../.venv/Scripts/python.exe',import.meta.url))
  :'/opt/alex-bot-runtime/python/app-venv/bin/python';

async function run(mode,{root,config,python=defaultPython,env=process.env,input}={}){
  return new Promise((resolve,reject)=>{
    const args=[script,mode,...root?['--root',root]:[],...config?['--config',config]:[]];
    const child=spawn(python,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill();},45_000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>24*1024*1024){failed=true;child.kill();}else chunks.push(chunk);});
    // Helper failures are fixed codes; never surface exception bodies or data.
    child.stderr.resume();
    child.on('error',()=>{clearTimeout(timer);reject(Error('RAG_BACKUP_OPERATION_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||failed)return reject(Error('RAG_BACKUP_OPERATION_FAILED'));
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('RAG_BACKUP_OPERATION_FAILED'));}});
    child.stdin.on('error',()=>{});
    child.stdin.end(input===undefined?'':JSON.stringify(input));
  });
}

function subset(files){
  if(!Object.hasOwn(files,manifest))return {};
  const data=JSON.parse(Buffer.from(files[manifest],'base64'));
  const result={[manifest]:files[manifest]};
  for(const entry of Object.values(data.entries??{})){
    if(typeof entry.name!=='string'||!Object.hasOwn(files,entry.name))throw Error('RAG_BACKUP_OPERATION_FAILED');
    result[entry.name]=files[entry.name];
  }
  return result;
}

export async function collectRagBackupFiles(options={}){
  const result=await run('snapshot',options);
  if(!result||typeof result.files!=='object'||Array.isArray(result.files))throw Error('RAG_BACKUP_OPERATION_FAILED');
  return result.files;
}
export async function verifyRagBackupFiles(files,options={}){
  if(!Object.hasOwn(files,manifest))return {included:false};
  return run('verify',{...options,input:subset(files)});
}
export async function restoreRagBackupFiles(files,options){
  if(!options?.root)throw Error('RAG_BACKUP_OPERATION_FAILED');
  // Secure the empty staging directory before any plaintext is written. Reuse
  // the existing NTFS-current-user/POSIX permission helper without init(),
  // which would create unrelated QQ administration tokens.
  const root=options.root;
  if(!path.isAbsolute(root)||root.split(/[\\/]/).includes('..'))throw Error('RAG_BACKUP_OPERATION_FAILED');
  for(let candidate=path.resolve(root);;candidate=path.dirname(candidate)){
    try{if((await fs.lstat(candidate)).isSymbolicLink())throw Error('RAG_BACKUP_OPERATION_FAILED');}
    catch(error){if(error.code!=='ENOENT')throw Error('RAG_BACKUP_OPERATION_FAILED');}
    if(candidate===path.dirname(candidate))break;
  }
  try{if((await fs.readdir(root)).length)throw Error('RAG_BACKUP_OPERATION_FAILED');}
  catch(error){if(error.code!=='ENOENT')throw Error('RAG_BACKUP_OPERATION_FAILED');}
  await fs.mkdir(root,{recursive:true,mode:0o700});
  await new PrivateStore(root).restrict(root);
  return run('restore',{...options,input:subset(files)});
}
