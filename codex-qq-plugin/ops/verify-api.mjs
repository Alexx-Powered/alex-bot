// Read-only status and scope verification; --campus performs a real query, never sends QQ.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {unprotectCredential} from '../src/storage.mjs';
import {projectStatus} from '../src/bridge-client.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const home=process.platform==='win32'?root:'/var/lib/alexbot';
const port=process.argv.includes('--stage')?19329:19327;
let tokens;
if(process.platform==='win32'&&process.argv.includes('--stage'))tokens=await unprotectCredential(JSON.parse(await fs.readFile(path.join(home,'.private/migration/cloud-access.json'),'utf8')).cipher);
else tokens={adminToken:(await fs.readFile(path.join(home,'.private/admin-token'),'utf8')).trim(),integrationToken:(await fs.readFile(path.join(home,'.private/integration-token'),'utf8')).trim()};
async function request(route,token,body){return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path:route,method:body?'POST':'GET',headers:{Host:'127.0.0.1:19327',Authorization:'Bearer '+token,...body?{'Content-Type':'application/json'}:{}}},res=>{
    const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>2_000_000)res.destroy(Error('RESPONSE_TOO_LARGE'));else chunks.push(c);});
    res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch{reject(Error('INVALID_RESPONSE'));}});
  });req.setTimeout(130000,()=>req.destroy(Error('TIMEOUT')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
});}
try{
  const status=await request('/api/status',tokens.integrationToken);
  if(status.status!==200)throw Error('STATUS_FAILED');console.log(JSON.stringify(projectStatus(status.body)));
  const denied=await request('/api/agent/config',tokens.integrationToken,{});
  if(denied.status!==403||denied.body.code!=='INTEGRATION_SCOPE_DENIED')throw Error('INTEGRATION_SCOPE_FAILED');
  console.log(JSON.stringify({integration_scope:true}));
  if(process.argv.includes('--campus')){
    const r=await request('/api/campus/query',tokens.adminToken,{});
    const data=r.body.data??r.body;
    console.log(JSON.stringify({campus_http:r.status,ok:data.ok,rooms:data.rooms?.length,code:data.code}));
    if(r.status!==200||data.ok!==true||!data.rooms?.length)throw Error('CAMPUS_API_FAILED');
  }
}catch{console.error('API_VERIFICATION_FAILED');process.exitCode=1;}
