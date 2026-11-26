import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {BridgeCore} from '../src/core.mjs';
import {QQAdapter} from '../src/qq-adapter.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';

// Replace only the model/data response and remote SDK network. Exercise the
// production renderer, agent, admission, reply deadline, upload and submission.
class OfflineBot {
  handlers=new Map(); uploads=[]; messages=[]; texts=[];
  api={post:async(path,body)=>{this.uploads.push({path,body});return {file_info:'offline-hiking-file'};}};
  on(name,fn){this.handlers.set(name,fn);}
  start(){return new Promise(resolve=>{this.finish=resolve;});}
  stop(){this.finish?.();}
  async emit(name,...args){return this.handlers.get(name)?.(...args);}
  async send(value){this.messages.push(value);return {id:'offline-image'};}
  async sendText(target,text){this.texts.push({target,text});return {id:'offline-text'};}
}

for(const scope of ['c2c','group'])for(const natural of [false,true]){
  test(`hiking delivery ${scope} ${natural?'natural':'fixed'} uploads and submits one PNG`,async()=>{
    const now=Date.parse('2026-11-07T16:22:00Z'),bot=new OfflineBot(),calls=[];
    const features={...defaultGroupFeatures('white'),chat:false};
    let state={version:1,ownerId:'OWNER',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
      allowedGroups:[{id:'GROUP',name:'离线测试群',enabled:true,features}],grayGroups:[]};
    const worker={async run(packet,rpc,finish){calls.push(packet.type);return finish({kind:'rag',requiredFeature:'weather',text:'',
      hikingCard:{schema:'hiking.card.v1',topic:'库拉岗日',days:[],nights:[],message:'测试资料待补充。'}});}};
    const agent=new ConversationAgent({worker,ragEnabled:true,toolbox:{handle:async()=>null},
      configStore:{read:async()=>({enabled:natural,apiKey:'offline-fixture'})},
      policyLoader:async()=>({enabled:false,topics:[],instructions:'',maxChars:600}),modelBudget:{acquire:async()=>({ok:true})}});
    let outcome,core;
    const adapter=new QQAdapter({createBot:()=>bot,now:()=>now,
      canSend:args=>core.canDeliver(args),onMessage:async(message,expires)=>{outcome=await core.handleMessage(message,expires);}});
    core=new BridgeCore({loadState:async()=>structuredClone(state),saveState:async next=>{state=structuredClone(next);},
      now:()=>now,send:request=>adapter.send(request),commandHandler:(text,context)=>agent.handle(text,context)});
    await core.init();await adapter.connect({appId:'123',appSecret:'offline-fixture'});await bot.emit('ready',{});
    try{
      const id='hiking-test',targetId=scope==='group'?'GROUP':'OWNER';
      const content=natural?'明天库拉岗日徒步':'发 徒步 库拉岗日';
      const inbound={kind:scope,rawEventType:scope==='group'?'GROUP_AT_MESSAGE_CREATE':'C2C_MESSAGE_CREATE',senderId:'OWNER',
        messageId:id,timestamp:new Date(now).toISOString(),content,...(scope==='group'?{groupOpenid:'GROUP'}:{}),
        replyTarget:{scope,targetId,msgId:id}};
      await bot.emit('message',{},inbound);
      assert.equal(outcome?.code,'SENT',JSON.stringify(outcome));
      assert.deepEqual(calls,[natural?'request':'rag']);
      assert.equal(bot.uploads.length,1);assert.equal(bot.messages.length,1);assert.equal(bot.texts.length,0);
      assert.equal(bot.uploads[0].path,scope==='group'?'/v2/groups/GROUP/files':'/v2/users/OWNER/files');
      assert.equal(bot.uploads[0].body.file_type,1);assert.equal(bot.uploads[0].body.srv_send_msg,false);
      assert.deepEqual([...Buffer.from(bot.uploads[0].body.file_data,'base64').subarray(0,8)],[137,80,78,71,13,10,26,10]);
      assert.equal(bot.messages[0].msgType,7);assert.equal(bot.messages[0].content,undefined);
      assert.equal(state.deliveries[0].state,'sent');assert.equal(state.attempts.length,1);
      await bot.emit('message',{},inbound);
      assert.equal(bot.uploads.length,1);assert.equal(bot.messages.length,1,'duplicate must not send again');
    }finally{await adapter.disconnect();}
  });
}
