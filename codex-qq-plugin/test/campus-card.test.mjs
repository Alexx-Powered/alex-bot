import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CampusService,campusFailure} from '../src/campus-service.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
const home=fileURLToPath(new URL('..',import.meta.url));
const report=()=>({schema_version:'buaa-recommendations.v1',ok:true,code:'OK',building:'新主楼',date:'2026-10-29',now:'2026-10-29T16:36:00+08:00',fetched_at:'2026-10-29T15:00:00+08:00',session:'下午',message:'A101可用',candidates:[{building:'新主楼',room:'A101',small:false,tier:1,start_period:9,end_period:10,usable_from:'16:36',usable_until:'18:15',available_now:true,complete_remaining:true,period5_busy:false,full_afternoon:false,just_released:true,release_pending:false}]});

test('fresh multi-region query preserves the region array through cache and recommendation without leaking credentials',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'qq-regions-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const calls=[],regions=['主M','新主楼A座'];
  const data={...campusFailure('OK','2026-10-29'),ok:true,buildings:['主楼','新主楼'],rooms:[{building:'主楼',room:'主M201',free_periods:Array.from({length:14},(_,i)=>i+1),busy_periods:[]}]};
  const worker={close(){},run:async(payload,_execute,finish)=>{
    calls.push(payload);
    return finish(payload.mode==='query'?{data,artifact_id:null}:{recommendation:{...report(),building:'组合区域',regions,missing_regions:['新主楼A座'],candidates:[{...report().candidates[0],building:'主楼',room:'主M201',region:'主M'}]}});
  }};
  const service=new CampusService({home:folder,worker,now:()=>Date.parse('2026-10-29T08:36:00Z'),configStore:{read:async()=>({enabled:true,username:'offline-student',password:'offline-password'}),status:async()=>({enabled:true,configured:true})}});
  const result=await service.execute({date:'2026-10-29',regions},{scope:'c2c'},'主M和新主楼A座');
  assert.deepEqual(result.campusRecommendation.regions,regions);assert.equal(result.campusRecommendation.candidates[0].region,'主M');
  assert.equal(calls[0].mode,'query');assert.deepEqual(calls[0].args,{date:'2026-10-29'});
  assert.deepEqual(calls[1].args.regions,regions);assert.equal(Object.hasOwn(calls[1],'credentials'),false);
  assert.doesNotMatch(JSON.stringify(result),/offline-student|offline-password/);
});

test('real private Python renderer creates a validated image; gray cannot render',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'qq-card-'));
  const worker=new PythonAgentWorker({home:folder,pythonPath:path.join(home,'.venv','Scripts','python.exe'),workerPath:path.join(home,'python','campus_worker.py'),maxLineBytes:262144});
  t.after(()=>{worker.close();return rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});});const service=new CampusService({home:folder,worker,configStore:{}});
  assert.equal(await service.renderRecommendation(report(),'去A101。',{scope:'group',access:'gray'}),null);
  const result=await service.renderRecommendation(report(),'去A101。',{scope:'c2c'});
  assert.equal(result.text,'');assert.equal(result.requiredAccess,'white');assert.equal(result.image.mimeType,'image/png');
  assert.equal(result.image.buffer.readUInt32BE(16),1080);
});

test('natural recommendation produces one image after model explanation, including fallback on model failure',async()=>{
  for(const failed of [false,true]){
    let rendered=0;
    const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
    const agent=new ConversationAgent({
      campusTools:{handle:async()=>null,recommend:async(args,_context,text)=>{assert.equal(text,'新主楼现在去哪个教室');return {text:'A101',campusRecommendation:report()};},
        renderRecommendation:async(data,explanation)=>{rendered++;assert.equal(data.building,'新主楼');assert.equal(explanation,failed?'':'去A101。');return {image,text:'',requiredAccess:'white'};}},
      toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-model-key'})},
      policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})},
      worker:{run:async(packet,execute,finish)=>{if(packet.type==='request')return execute('buaa_classroom_recommend',{building:'新主楼'});if(failed)throw Error('offline failure');return finish({source:'campus-recommendation',text:'A101可用',explanation:'去A101。'});}}
    });
    const result=await agent.handle('新主楼现在去哪个教室',{scope:'c2c'});
    assert.equal(result.image,image);assert.equal(result.text,'');assert.equal(rendered,1);
  }
});
