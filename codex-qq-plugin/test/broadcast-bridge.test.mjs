import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.mjs';
import { createBridgeClient,projectBroadcast } from '../src/bridge-client.mjs';

const summary={ok:false,code:'RATE_LIMIT_DAY',results:[{destination:'owner',ok:false,code:'RATE_LIMIT_DAY'},
  {destination:'测试群',ok:false,code:'RATE_LIMIT_DAY'}],attempted:0,sent:0};
const parse=result=>JSON.parse(result.content.find(item=>item.type==='text').text);

test('broadcast response projection exposes per-target results without IDs or raw backend data',()=>{
  const projected=projectBroadcast({...summary,ownerId:'PRIVATE_OWNER',appSecret:'SECRET',raw:'SECRET',
    results:summary.results.map(row=>({...row,groupId:'PRIVATE_GROUP',credentials:'SECRET'}))});
  assert.deepEqual(projected,summary);assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_|SECRET|credentials/);
  assert.deepEqual(projectBroadcast({...summary,code:'PRIVATE_ERROR',results:[{destination:'owner',ok:false,code:'PRIVATE_ERROR',deliveryState:'uncertain'}]}),
    {...summary,code:'UNKNOWN',results:[{destination:'owner',ok:false,code:'UNKNOWN',deliveryState:'uncertain'}]});
  for(const results of [undefined,Array(12).fill(summary.results[0]),[{destination:'bad\nname',ok:true,code:'SENT'}]]){
    assert.throws(()=>projectBroadcast({...summary,results}),{code:'BRIDGE_INVALID_RESPONSE'});
  }
});

test('bridge broadcast has one fixed route and strips target arguments; daily default leaves city to server',async t=>{
  const home=await mkdtemp(join(tmpdir(),'qq-broadcast-bridge-'));
  await mkdir(join(home,'.private'));await writeFile(join(home,'.private','admin-token'),'a'.repeat(64));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const requests=[];
  t.mock.method(http,'request',(url,options)=>{
    const req=new EventEmitter();req.destroy=()=>{};
    req.end=body=>{
      requests.push({url:url.href,method:options.method,body:JSON.parse(body)});
      queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};
        req.emit('response',res);
        const output=url.pathname==='/api/notify-all-allowed'?summary:{ok:true,code:'SENT'};
        res.emit('data',Buffer.from(JSON.stringify(output)));res.emit('end');
      });
    };
    return req;
  });
  const client=createBridgeClient({home});
  assert.deepEqual(await client.broadcast({text:'完成摘要',idempotencyKey:'operation-1',groupId:'ATTACKER',ownerId:'ATTACKER',proactiveGroup:true}),summary);
  assert.deepEqual(requests[0],{url:'http://127.0.0.1:19327/api/notify-all-allowed',method:'POST',body:{text:'完成摘要',idempotencyKey:'operation-1'}});
  await assert.rejects(client.broadcast({text:' ',idempotencyKey:'operation-2'}),{code:'BRIDGE_INVALID_INPUT'});assert.equal(requests.length,1);
  await client.weatherBriefing();assert.deepEqual(requests.at(-1).body,{mode:'daily'});
  await client.weatherBriefing({mode:'test'});assert.deepEqual(requests.at(-1).body,{mode:'test',cities:['beijing']});
  await client.weatherBriefing({mode:'daily',cities:['天津']});assert.deepEqual(requests.at(-1).body,{mode:'daily',cities:['天津']});
});

test('MCP broadcast has strict owner-and-whitelist contract and reports quota failure as an error',async t=>{
  const calls=[];
  const server=createMcpServer({broadcast:async args=>{calls.push(args);return summary;},
    weatherBriefing:async args=>{calls.push(args);return {ok:true,code:'SENT'};},weatherPreview:async args=>{calls.push(args);return {ok:true,text:'preview'};}});
  const client=new Client({name:'offline-broadcast-test',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  t.after(async()=>{await client.close();await server.close();});
  const {tools}=await client.listTools();const broadcast=tools.find(item=>item.name==='qq_broadcast');
  assert.deepEqual(Object.keys(broadcast.inputSchema.properties).sort(),['idempotencyKey','text']);
  assert.equal(broadcast.inputSchema.additionalProperties,false);
  assert.match(broadcast.description,/人类用户明确授权本次/);assert.match(broadcast.description,/先调用 qq_status/);
  assert.match(broadcast.description,/不是每日天气群发/);
  const result=await client.callTool({name:'qq_broadcast',arguments:{text:'完成摘要',idempotencyKey:'summary-1'}});
  assert.equal(result.isError,true);assert.deepEqual(parse(result),summary);
  const before=calls.length;
  for(const extra of [{groupId:'FAKE_GROUP'},{ownerId:'FAKE_OWNER'},{proactiveGroup:true},{replyTarget:{scope:'group'}}]){
    const denied=await client.callTool({name:'qq_broadcast',arguments:{text:'摘要',idempotencyKey:'summary-1',...extra}});
    assert.equal(denied.isError,true);
  }
  assert.equal(calls.length,before);
  await client.callTool({name:'qq_weather_briefing',arguments:{}});assert.deepEqual(calls.at(-1),{mode:'daily'});
  await client.callTool({name:'qq_weather_briefing',arguments:{mode:'daily',cities:['天津']}});assert.deepEqual(calls.at(-1),{mode:'daily',cities:['天津']});
  await client.callTool({name:'qq_weather_preview',arguments:{}});assert.deepEqual(calls.at(-1),{cities:['beijing']});
});
