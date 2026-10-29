import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CampusConfigStore} from '../src/campus-config.mjs';

async function fixture(t){
  const home=await mkdtemp(join(tmpdir(),'qq-campus-config-'));await mkdir(join(home,'.private'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const codec={protect:async v=>Buffer.from(JSON.stringify(v)).toString('hex'),unprotect:async v=>JSON.parse(Buffer.from(v,'hex').toString())};
  return {home,file:join(home,'.private','campus-config.json'),store:new CampusConfigStore(home,codec),codec};
}
test('campus account and password persist only in encrypted envelope; status never includes either',async t=>{
  const f=await fixture(t);
  const value={enabled:true,username:'offline-student',password:'offline-test-password'};
  assert.deepEqual(await f.store.save(value),{enabled:true,configured:true});
  const raw=await readFile(f.file,'utf8');assert.doesNotMatch(raw,/offline-student|offline-test-password/);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),['cipher','format','version']);
  assert.deepEqual(await new CampusConfigStore(f.home,f.codec).read(),value);
  assert.deepEqual(await f.store.status(),{enabled:true,configured:true});
});
test('blank credential update preserves both values; rotating or changing account requires a complete pair',async t=>{
  const f=await fixture(t);await f.store.save({enabled:true,username:'offline-student',password:'offline-password'});
  await f.store.save({enabled:false});assert.equal((await f.store.read()).password,'offline-password');
  for(const input of [{enabled:true,username:'other-student'},{enabled:true,password:'new-offline-password'},
    {enabled:true,url:'https://example.invalid'},{enabled:true,username:'x',password:'x'}])await assert.rejects(f.store.save(input),{code:'CAMPUS_CONFIG_INVALID'});
  await f.store.save({enabled:true,username:'other-student',password:'new-offline-password'});
  assert.equal((await f.store.read()).username,'other-student');
});
test('missing or corrupted campus configuration never silently enables or leaks decryption details',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.store.status(),{enabled:false,configured:false});
  await assert.rejects(f.store.save({enabled:true}),{code:'CAMPUS_CONFIG_INVALID'});
  await writeFile(f.file,'{"version":1,"format":"windows-dpapi-v1","cipher":"corrupt"}');
  await assert.rejects(f.store.read(),{code:'CAMPUS_CONFIG_UNAVAILABLE'});
});
