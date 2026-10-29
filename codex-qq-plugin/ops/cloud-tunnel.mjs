import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {atomicJson,protectCredential,unprotectCredential} from '../src/storage.mjs';

const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const dir=path.join(root,'.private','migration');
const destination='alexbridge@182.92.164.251';
const ssh=path.join(process.env.SystemRoot,'System32','OpenSSH','ssh.exe');
const sshKeygen=path.join(process.env.SystemRoot,'System32','OpenSSH','ssh-keygen.exe');
const keyFile=path.join(dir,'tunnel-identity.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function probe(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});}
async function start(port){
  const value=await unprotectCredential(JSON.parse(await fs.readFile(keyFile,'utf8')).cipher);
  const temporary=path.join(dir,'ssh-'+randomUUID()+'.key');await fs.writeFile(temporary,value.privateKey,{flag:'wx',mode:0o600});
  let child;
  try{
    child=spawn(ssh,['-N','-T','-i',temporary,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile="'+path.join(dir,'known_hosts').replaceAll('\\','/')+'"','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-o','ConnectTimeout=12','-L',`127.0.0.1:${port}:127.0.0.1:19327`,destination],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let diagnostic='';child.stderr.on('data',data=>{diagnostic=(diagnostic+data).slice(-4096);});let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});
    for(let i=0;i<60&&!exited;i++){await delay(250);if(await probe(port)){await atomicJson(path.join(dir,'tunnel-status.json'),{pid:child.pid,port,startedAt:new Date().toISOString()});break;}}
    if(exited){const reasons=[[/bad permissions|unprotected private key/i,'KEY_PERMISSIONS'],[/host key verification failed/i,'HOST_KEY'],[/permission denied/i,'AUTH_DENIED'],[/connection (?:reset|closed)/i,'CONNECTION_RESET'],[/timed out/i,'TIMEOUT'],[/connection refused/i,'REFUSED'],[/invalid format|error in libcrypto/i,'KEY_FORMAT']];throw Error('TUNNEL_'+(reasons.find(([pattern])=>pattern.test(diagnostic))?.[1]||'CONNECT_FAILED'));}
    if(!await probe(port)){child.kill();throw Error('TUNNEL_CONNECT_FAILED');}
    return child;
  }finally{await fs.rm(temporary,{force:true});}
}
async function main(){
  if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
  const mode=process.argv[2]||'run',port=Number(process.argv[3]||19327);
  if(![19327,19329].includes(port))throw Error('INVALID_LOCAL_PORT');
  if(mode==='key'){
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    try{await fs.access(keyFile);console.log('TUNNEL_IDENTITY_EXISTS');return;}catch{}
    const pair=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    const temporary=path.join(dir,'initial-key.tmp');await fs.writeFile(temporary,pair.privateKey,{flag:'wx',mode:0o600});
    try{const output=await run(sshKeygen,['-y','-f',temporary],{windowsHide:true});await fs.writeFile(path.join(dir,'tunnel-public.pub'),output.stdout.trim()+'\n');await atomicJson(keyFile,{cipher:await protectCredential({privateKey:pair.privateKey})});}finally{await fs.rm(temporary,{force:true});}
    console.log('TUNNEL_IDENTITY_ENCRYPTED');return;
  }
  let stopped=false,active;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;active?.kill();});
  while(!stopped){
    if(await probe(port)){if(mode==='once')throw Error('LOCAL_PORT_OCCUPIED');await delay(10000);continue;}
    try{active=await start(port);console.log('CLOUD_TUNNEL_READY');if(active.exitCode===null)await new Promise(resolve=>active.once('exit',resolve));}
    catch(e){console.error(/^TUNNEL_[A-Z_]+$/.test(e.message)?e.message:'TUNNEL_CONNECT_FAILED');if(mode==='once'){process.exitCode=1;return;}}
    if(mode==='once')return;if(!stopped)await delay(5000);
  }
}
main().catch(()=>{console.error('CLOUD_TUNNEL_FAILED');process.exitCode=1;});
