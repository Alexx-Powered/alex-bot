import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {credentialFormat} from '../src/storage.mjs';
import {MonitoringConfigStore} from '../src/monitoring-config.mjs';

const KEY='FAKE-langsmith-key-for-tests';
const defaults={enabled:false,apiKey:'',project:'alex-bot',endpoint:'https://api.smith.langchain.com',workspaceId:''};
const status={enabled:false,configured:false,project:defaults.project,endpoint:defaults.endpoint,workspaceId:''};
const code=expected=>error=>{assert.equal(error.code,expected);assert.equal(error.message,expected);return true;};
async function fixture(t,{privateDir=true}={}){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-monitor-config-'));
  t.after(async()=>{assert.equal(path.dirname(home),path.resolve(os.tmpdir()));assert.ok(path.basename(home).startsWith('qq-monitor-config-'));await fs.rm(home,{recursive:true,force:true});});
  if(privateDir)await fs.mkdir(path.join(home,'.private'),{mode:0o700});
  const data=new Map();const codec={protect:async value=>{const cipher='fake-'+randomUUID();data.set(cipher,structuredClone(value));return cipher;},unprotect:async cipher=>{if(!data.has(cipher))throw Error(KEY);return structuredClone(data.get(cipher));}};
  return {home,file:path.join(home,'.private/monitoring-config.json'),codec,store:new MonitoringConfigStore(home,codec)};
}

test('monitoring defaults are disabled and read/status do not create files',async t=>{
  const f=await fixture(t,{privateDir:false});assert.deepEqual(await f.store.read(),defaults);assert.deepEqual(await f.store.status(),status);
  await assert.rejects(fs.stat(path.join(f.home,'.private')),{code:'ENOENT'});
});
test('encrypted save, public status and reload never expose the key or cipher',async t=>{
  const f=await fixture(t);const saved=await f.store.save({enabled:true,apiKey:KEY,project:'亚历克斯 Bot',endpoint:'https://eu.api.smith.langchain.com',workspaceId:'12345678-1234-4321-abcd-123456789abc'});
  const raw=await fs.readFile(f.file,'utf8'),envelope=JSON.parse(raw);
  assert.equal(raw.includes(KEY),false);assert.equal(envelope.format,credentialFormat());assert.equal(Object.hasOwn(saved,'apiKey'),false);assert.equal(JSON.stringify(saved).includes(envelope.cipher),false);
  assert.equal((await new MonitoringConfigStore(f.home,f.codec).read()).apiKey,KEY);assert.deepEqual(await f.store.status(),saved);
});
test('blank key preserves the saved key while disabling, project changes and rotation work',async t=>{
  const f=await fixture(t);await f.store.save({enabled:true,apiKey:KEY});
  for(const apiKey of [undefined,'','   ']){await f.store.save({enabled:false,project:'another-project',...(apiKey===undefined?{}:{apiKey})});assert.equal((await f.store.read()).apiKey,KEY);}
  await f.store.save({enabled:true,apiKey:'FAKE-rotated-langsmith-key'});assert.equal((await f.store.read()).apiKey,'FAKE-rotated-langsmith-key');
});
test('enable requires a saved key and endpoint/project/workspace inputs are restricted',async t=>{
  const f=await fixture(t);await assert.rejects(f.store.save({enabled:true}),code('MONITORING_CONFIG_INVALID'));
  await f.store.save({enabled:true,apiKey:KEY});const before=await fs.readFile(f.file,'utf8');
  const invalid=[null,[],{}, {enabled:'true'}, {enabled:true,apiKey:'short'}, {enabled:true,apiKey:'has a space in it'}, {enabled:true,apiKey:'a'.repeat(513)},
    {enabled:true,endpoint:'http://api.smith.langchain.com'}, {enabled:true,endpoint:'https://api.smith.langchain.com/'},{enabled:true,endpoint:'https://api.smith.langchain.com.attacker.invalid'},
    {enabled:true,project:'x/y'}, {enabled:true,project:' '},{enabled:true,project:'p'.repeat(81)},{enabled:true,project:'bad\nname'},
    {enabled:true,workspaceId:'not-a-uuid'}, {enabled:true,workspaceId:null},{enabled:true,otherUser:'someone'}];
  for(const input of invalid)await assert.rejects(f.store.save(input),code('MONITORING_CONFIG_INVALID'));
  assert.equal(await fs.readFile(f.file,'utf8'),before);
});
test('corruption and codec failures return only fixed errors, never recover silently',async t=>{
  const f=await fixture(t);
  for(const raw of ['bad-json',JSON.stringify({version:1,format:'plaintext',apiKey:KEY}),JSON.stringify({version:1,format:credentialFormat(),cipher:'secret-cipher'})]){
    await fs.writeFile(f.file,raw);await assert.rejects(f.store.read(),code('MONITORING_CONFIG_UNAVAILABLE'));await assert.rejects(f.store.status(),code('MONITORING_CONFIG_UNAVAILABLE'));await assert.rejects(f.store.save({enabled:false}),code('MONITORING_CONFIG_UNAVAILABLE'));
  }
  await fs.unlink(f.file);
  const broken=new MonitoringConfigStore(f.home,{...f.codec,protect:async()=>{throw Error(KEY);}});
  await assert.rejects(broken.save({enabled:false}),code('MONITORING_CONFIG_UNAVAILABLE'));
  await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
});
test('concurrent saves serialize and retain the key, and missing private directory is not created',async t=>{
  const f=await fixture(t);await Promise.all([f.store.save({enabled:true,apiKey:KEY}),f.store.save({enabled:false,project:'queued-project'})]);
  assert.equal((await f.store.read()).apiKey,KEY);assert.equal((await f.store.read()).project,'queued-project');
  const empty=await fixture(t,{privateDir:false});await assert.rejects(empty.store.save({enabled:false}),code('MONITORING_CONFIG_UNAVAILABLE'));
});
