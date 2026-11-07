import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {collectRagBackupFiles,verifyRagBackupFiles,restoreRagBackupFiles} from '../ops/rag-backup.mjs';
const python=process.env.QQ_PYTHON??(process.platform==='win32'?fileURLToPath(new URL('../.venv/Scripts/python.exe',import.meta.url)):'python3');
const moduleDir=fileURLToPath(new URL('../python',import.meta.url));

test('encrypted-backup bridge snapshots and verifies canonical data then stages an isolated restore',async t=>{
  const temp=await mkdtemp(path.join(tmpdir(),'alex-rag-backup-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,'source'),privateDir=path.join(root,'.private');await mkdir(privateDir,{recursive:true});
  const store=path.join(privateDir,'rag.sqlite3'),climate=path.join(privateDir,'climate.sqlite3');
  await promisify(execFile)(python,['-c',`import sys;sys.path.insert(0,sys.argv[1]);from rag_store import RagStore;from climate_history import ClimateHistory;RagStore(sys.argv[2]).put_document(namespace='shared',domain='outdoor',visibility='shared',title='共享资料',text='测试共享知识',source_ref='fixture');c=ClimateHistory(sys.argv[3]);db=c._db();db.__enter__();db.__exit__(None,None,None)`,moduleDir,store,climate]);
  await writeFile(path.join(privateDir,'rag-config.json'),JSON.stringify({enabled:true,store_path:store,outdoor:{climate_path:climate},vector:{uri:path.join(privateDir,'vectors.db')}}));
  const files=await collectRagBackupFiles({root,python,env:{...process.env,QQ_RAG_CONFIG:''}});
  assert.equal(Object.keys(files).length,4);
  const verified=await verifyRagBackupFiles(files,{python});assert.equal(verified.databases.rag.shared_documents,1);
  const result=await restoreRagBackupFiles(files,{root:path.join(temp,'restored'),python});
  const config=JSON.parse(await readFile(result.config_path,'utf8'));assert.equal(config.vector,undefined);
  assert.equal(result.sending_enabled_by_restore,false);
  await assert.rejects(restoreRagBackupFiles(files,{root:path.join(temp,'restored'),python}),/RAG_BACKUP_OPERATION_FAILED/);
});

test('legacy backups remain verifiable and missing configured database is never silently omitted',async t=>{
  assert.deepEqual(await verifyRagBackupFiles({}),{included:false});
  const root=await mkdtemp(path.join(tmpdir(),'alex-rag-backup-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'.private'));
  const config=path.join(root,'.private','rag-config.json');
  await writeFile(config,JSON.stringify({enabled:true,store_path:path.join(root,'.private','missing.sqlite3'),api_key:'private-sentinel'}));
  await assert.rejects(collectRagBackupFiles({root,config,python}),error=>error.message==='RAG_BACKUP_OPERATION_FAILED'&&!error.message.includes('private-sentinel'));
});
