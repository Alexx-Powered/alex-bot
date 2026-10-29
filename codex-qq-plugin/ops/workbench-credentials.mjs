// Only Workbench invokes this helper; never run it in a tool that displays stdout.
import fs from 'node:fs/promises';
import path from 'node:path';
import {unprotectCredential} from '../src/storage.mjs';
try{
  if(process.platform!=='win32')throw Error();
  const file=path.join(process.env.USERPROFILE,'.workbench','credentials.dpapi.json');
  const saved=await unprotectCredential(JSON.parse(await fs.readFile(file,'utf8')).cipher);
  process.stdout.write(JSON.stringify({mode:'AK',access_key_id:saved.id,access_key_secret:saved.secret}));
}catch{process.stderr.write('WORKBENCH_CREDENTIAL_UNAVAILABLE\n');process.exitCode=1;}
