import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {seal,unseal} from '../src/secret-codec.mjs';
import {pythonEnvironment} from '../src/python-agent.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {isEntrypoint} from '../src/entrypoint.mjs';
import {mkdtemp,writeFile,symlink,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('server and scheduler recognize an executable started via the release directory symlink',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qq-entry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'entry.mjs'),'');
  await symlink(dir,dir+'-link',process.platform==='win32'?'junction':'dir');t.after(()=>rm(dir+'-link',{recursive:true,force:true}));
  const url=pathToFileURL(await realpath(path.join(dir,'entry.mjs'))).href;
  assert.equal(await isEntrypoint(url,path.join(dir+'-link','entry.mjs')),true);
  assert.equal(await isEntrypoint(url,path.join(dir,'missing.mjs')),false);
});

test('authenticated secret storage roundtrips without plaintext and refuses corruption or wrong keys',()=>{
  const key=randomBytes(32),value={password:'offline-only-password',apiKey:'offline-api-key'};
  const encrypted=seal(value,key);assert.deepEqual(unseal(encrypted,key),value);
  assert.equal(encrypted.includes(value.password),false);assert.notEqual(seal(value,key),encrypted);
  assert.throws(()=>unseal(encrypted,randomBytes(32)),/PRIVATE_STORAGE_UNAVAILABLE/);
  const pieces=encrypted.split(':');const data=Buffer.from(pieces[3],'base64');data[0]^=1;pieces[3]=data.toString('base64');
  assert.throws(()=>unseal(pieces.join(':'),key),/PRIVATE_STORAGE_UNAVAILABLE/);
});

test('Python gets Linux runtime paths but never master-key or service credentials',()=>{
  const env=pythonEnvironment({HOME:'/var/lib/alexbot',TMPDIR:'/run/alexbot',PLAYWRIGHT_BROWSERS_PATH:'/opt/browsers',CREDENTIALS_DIRECTORY:'/run/credentials',QQ_MASTER_KEY_FILE:'/etc/master.key',DEEPSEEK_API_KEY:'secret'});
  assert.equal(env.HOME,'/var/lib/alexbot');assert.equal(env.TMPDIR,'/run/alexbot');
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,'/opt/browsers');assert.equal(env.CREDENTIALS_DIRECTORY,undefined);assert.equal(env.QQ_MASTER_KEY_FILE,undefined);assert.equal(env.DEEPSEEK_API_KEY,undefined);
});

test('integration token can read status but cannot read or change admin configuration and pause',async()=>{
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const app=await createBridgeServer({port:0,store,adapterFactory:()=>({status:()=>({state:'disconnected'}),disconnect:async()=>{}})});
  try{
    const port=await app.listen(),headers={Authorization:'Bearer '+store.integrationToken,'Content-Type':'application/json'};
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`,{headers})).status,200);
    for(const route of ['config','agent/config','campus/config','pause','connect','group/remove']){
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/${route}`,{method:'POST',headers,body:'{}'})).status,403);
    }
  }finally{await app.close();}
});
