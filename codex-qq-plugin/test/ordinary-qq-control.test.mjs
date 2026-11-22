import test from 'node:test';
import assert from 'node:assert/strict';
import {OrdinaryQQControl} from '../src/ordinary-qq-control.mjs';

function fixture() {
  const data = {time:5_000, roster:0, calls:[], info:{yogurt:'active', nonebot:'active',
    listening:true, invocation:'old', qrVersion:'old-file', qrTime:1_000, png:'old-image'}};
  const control = new OrdinaryQQControl({now:() => data.time, roster:() => data.roster,
    call:async op => { data.calls.push(op); return {...data.info}; }});
  return {data, control};
}

test('online requires both active units, exact listener and a live roster from these processes', async () => {
  const {data,control} = fixture();
  assert.equal((await control.status()).state,'verifying');
  data.roster = 4_500;
  const online = await control.status();
  assert.equal(online.state,'online');
  assert.equal(online.png,undefined);
  data.info.started = 4_800;
  assert.equal((await control.status()).state,'verifying');
  data.info.yogurt = 'inactive';
  assert.equal((await control.status()).state,'offline');
});

test('concurrent starts restart once, old QR stays private, fresh roster ends the attempt', async () => {
  const {data,control} = fixture();
  data.roster = data.time - 1;
  await Promise.all([control.startLogin(), control.startLogin(), control.status()]);
  assert.deepEqual(data.calls,['start']);
  data.time += 100;
  assert.equal((await control.status()).png,undefined);
  data.info.invocation = 'new';
  assert.equal((await control.status()).state,'verifying');
  data.info.qrVersion = 'new-file';
  data.info.qrTime = ++data.time;
  data.info.png = 'new-image';
  assert.equal((await control.status()).png,'new-image');
  assert.equal((await control.startLogin()).state,'waiting_scan');
  data.roster = ++data.time;
  assert.equal((await control.status()).state,'online');
  assert.equal((await control.status()).png,undefined);
  assert.equal(data.calls.filter(op => op === 'start').length,1);
});

test('expired QR and explicit login failure disappear, retry captures a new baseline', async () => {
  const {data,control} = fixture();
  await control.startLogin();
  Object.assign(data.info,{invocation:'new',qrTime:++data.time,qrVersion:'new-file',png:'new'});
  assert.equal((await control.status()).state,'waiting_scan');
  data.time += 115_001;
  const expired = await control.status();
  assert.equal(expired.state,'expired');
  assert.equal(expired.png,undefined);
  assert.equal((await control.startLogin()).state,'starting');
  Object.assign(data.info,{invocation:'newer',loginEvent:'failed',eventTime:++data.time});
  assert.equal((await control.status()).state,'failed');
});

test('status helpers fail closed without exposing their error or old QR', async () => {
  const control = new OrdinaryQQControl({call:async () => { throw new Error('private output'); }});
  assert.deepEqual(await control.status(),{ok:false,state:'unavailable'});
  assert.deepEqual(await control.startLogin(),{ok:false,state:'unavailable'});
});
