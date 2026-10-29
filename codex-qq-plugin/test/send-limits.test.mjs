import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseSendLimits,loadSendLimits} from '../src/send-limits.mjs';
import {projectStatus} from '../src/bridge-client.mjs';
test('send limit configuration defaults, BOM, validation and bad files fail closed',async()=>{
  const home=await mkdtemp(join(tmpdir(),'alex-limits-'));
  try{
    assert.deepEqual(await loadSendLimits(home),{dailyAttempts:200,minuteAttempts:3,reservedNotifications:10});
    await mkdir(join(home,'config'));const file=join(home,'config/send-limits.json');
    await writeFile(file,'\uFEFF'+JSON.stringify({dailyAttempts:300,minuteAttempts:3,reservedNotifications:20}));
    assert.equal((await loadSendLimits(home)).dailyAttempts,300);
    for(const raw of ['{bad',JSON.stringify({dailyAttempts:0,minuteAttempts:3,reservedNotifications:0}),' '.repeat(2049)]){await writeFile(file,raw);await assert.rejects(loadSendLimits(home),/SEND_LIMITS_CONFIG_INVALID/);}
    for(const limits of [{dailyAttempts:200,minuteAttempts:0,reservedNotifications:10},{dailyAttempts:200,minuteAttempts:3,reservedNotifications:200},{dailyAttempts:1001,minuteAttempts:3,reservedNotifications:10},{dailyAttempts:200,minuteAttempts:3,reservedNotifications:10,secret:'not allowed'}])assert.throws(()=>parseSendLimits(limits));
  }finally{await rm(home,{recursive:true,force:true});}
});
test('MCP status exposes only fixed quota fields and preserves the reserved limit code',()=>{
  const s=projectStatus({ok:true,core:{dailyAttempts:2,remainingDailyAttempts:198,limits:{dailyAttempts:200,minuteAttempts:3,reservedNotifications:10,replyDailyAttempts:190,privateToken:'secret'}}});
  assert.deepEqual(s.core.limits,{dailyAttempts:200,minuteAttempts:3,reservedNotifications:10,replyDailyAttempts:190});assert.equal(s.core.remainingDailyAttempts,198);assert.doesNotMatch(JSON.stringify(s),/privateToken|secret/);
});


test('expanded local sending supports fifteen per minute while retaining a bounded maximum',()=>{
 assert.deepEqual(parseSendLimits({dailyAttempts:300,minuteAttempts:15,reservedNotifications:10}),{dailyAttempts:300,minuteAttempts:15,reservedNotifications:10});
 assert.throws(()=>parseSendLimits({dailyAttempts:300,minuteAttempts:31,reservedNotifications:10}));
});
