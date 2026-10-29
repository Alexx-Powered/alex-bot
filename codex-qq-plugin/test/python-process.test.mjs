import {pythonExecutable} from '../src/runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversionToolbox,CONVERSION_HELP} from '../src/conversion-tools.mjs';
const home=fileURLToPath(new URL('../',import.meta.url));

test('real Python LangChain conversion tool runs offline, including reversals, without QQ RPC or key',async t=>{
  if(!existsSync(pythonExecutable())){t.skip('Install Python environment first');return;}
  const worker=new PythonAgentWorker({home});const tools=new ConversionToolbox(worker);
  try{
    for(const [text,expected] of [['0.6HU$换人民币','0.6 HU$ = 70 元'],['70元换古月币','70 元 = 0.6 HU$'],
      ['1马里换公里','1 马里 = 3.08 km'],['3.08km换马里','3.08 km = 1 马里'],
      ['1马时换小时','1 马时 = 1.5 小时'],['1.5h换马时','1.5 小时 = 1 马时'],
      ['1马里换马时',CONVERSION_HELP]])assert.deepEqual(await tools.handle(text),{text:expected},text);
  }finally{worker.close();}
});
test('real Python LangChain process executes fixed weather and morning tools without a model key',async t=>{
  if(!existsSync(pythonExecutable())){t.skip('Install Python environment first');return;}
  const worker=new PythonAgentWorker({home});let calls=0;
  try{
    for(const name of ['weather_image','local_weather_briefing']){
      const args=name==='weather_image'?{city:'北京'}:{cities:['beijing'],renderImage:true};
      const result=await worker.run({type:'execute',name,args},async(n,a)=>{assert.equal(n,name);assert.deepEqual(a,args);calls++;return {text:'',image:{buffer:Buffer.alloc(16,1),mimeType:'image/png'}};});
      assert.ok(Buffer.isBuffer(result.image.buffer));
    }
    assert.equal(calls,2);
    const ignored=await worker.run({type:'request',text:'你好',sessionKey:'local-test',config:{enabled:false}},async()=>{throw Error('Must not call tool');});
    assert.equal(ignored,null);
  }finally{worker.close();}
});
