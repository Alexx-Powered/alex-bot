import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson,protectCredential,unprotectCredential} from '../src/storage.mjs';
const dir=path.join(process.env.USERPROFILE,'.workbench'),file=path.join(dir,'config.json');
try{
  const config=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
  const original=config.profiles['alex-bot'];
  if(!original.access_key_id||!original.access_key_secret)throw Error();
  const saved={id:original.access_key_id,secret:original.access_key_secret};
  const cipher=await protectCredential(saved);
  if(JSON.stringify(await unprotectCredential(cipher))!==JSON.stringify(saved))throw Error();
  await atomicJson(path.join(dir,'credentials.dpapi.json'),{format:'windows-dpapi-v1',cipher});
  await atomicJson(path.join(dir,'config.recovery.dpapi.json'),{format:'windows-dpapi-v1',cipher:await protectCredential(config)});
  const helper=fileURLToPath(new URL('./workbench-credentials.mjs',import.meta.url));
  for(const name of ['alex-bot','default']){
    const p=config.profiles[name];if(!p||p.access_key_id!==saved.id||p.access_key_secret!==saved.secret)throw Error();
    delete p.access_key_id;delete p.access_key_secret;delete p.sts_token;
    p.mode='CredentialsCmd';p.process_command='"'+process.execPath+'" "'+helper+'"';
  }
  await atomicJson(file,config);
  console.log(JSON.stringify({configured_profiles:['alex-bot','default'],encrypted_backup:true,credential_values_printed:false}));
}catch{console.error('WORKBENCH_SECURITY_SETUP_FAILED');process.exitCode=1;}
