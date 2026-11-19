import {createBridgeClient} from '../src/bridge-client.mjs';
const client=createBridgeClient({timeoutMs:60000});
const scheduledTest=process.argv[2]==='--scheduled-test';
const mode=process.argv.includes('--test')?'test':'daily';
try{
  const status=await client.status();
  if(!status.configured||!status.core?.paired||status.core.paused||status.transport?.state!=='connected'){
    console.log(JSON.stringify({ok:false,code:'QQ_NOT_READY',status}));process.exitCode=1;
  }else{
    const result=scheduledTest?await client.morningWeatherTest({idempotencyKey:process.argv[3]}):
      await client.weatherBriefing(mode==='test'?{cities:['beijing'],mode}:{mode});
    console.log(JSON.stringify(result));
    if(!result.ok&&result.code!=='DUPLICATE')process.exitCode=1;
  }
}catch(error){console.log(JSON.stringify({ok:false,code:error.code||'WEATHER_DELIVERY_FAILED'}));process.exitCode=1;}
