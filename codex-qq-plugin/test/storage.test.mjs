import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PrivateStore, protectCredential, unprotectCredential} from '../src/storage.mjs';

test('private storage never saves plaintext credentials and reuses access token',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-private-test-'));
  const codec={restrict:async()=>{},protect:async value=>Buffer.from(JSON.stringify(value)).toString('base64'),unprotect:async value=>JSON.parse(Buffer.from(value,'base64').toString())};
  try{
    const s=new PrivateStore(home,codec);await s.init();assert.equal(s.token.length,64);
    await s.saveCredentials({appId:'12345678',appSecret:'test-only-fake-secret'});
    const raw=await fs.readFile(path.join(home,'.private','credentials.json'),'utf8');assert.equal(raw.includes('test-only-fake-secret'),false);
    assert.equal((await s.readCredentials()).appSecret,'test-only-fake-secret');
    const s2=new PrivateStore(home,codec);await s2.init();assert.equal(s2.token,s.token);
    await s.saveState({ownerId:'x'});assert.equal((await s2.loadState()).ownerId,'x');
  }finally{await fs.rm(home,{recursive:true,force:true})}
});
test('Windows DPAPI encrypt/decrypt works for current user', {skip:process.platform!=='win32'},async()=>{
  const fake={appId:'12345678',appSecret:'FAKE-only-roundtrip-123'};
  const cipher=await protectCredential(fake);assert.equal(cipher.includes(fake.appSecret),false);
  assert.deepEqual(await unprotectCredential(cipher),fake);
});

test('Windows first-run private directory and DPAPI credential storage work together', {skip:process.platform!=='win32'},async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-private-real-test-'));
  try {
    const store=new PrivateStore(home); await store.init();
    const fake={appId:'12345678',appSecret:'FAKE-first-run-no-account'};
    await store.saveCredentials(fake);
    assert.deepEqual(await store.readCredentials(),fake);
    assert.equal((await fs.readFile(path.join(home,'.private','credentials.json'),'utf8')).includes(fake.appSecret),false);
    const again=new PrivateStore(home); await again.init(); assert.equal(again.token,store.token);
  } finally { await fs.rm(home,{recursive:true,force:true}); }
});

