import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const home=fileURLToPath(new URL('..',import.meta.url));
function run(script,extra={}){return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; . (Join-Path $env:QQ_TEST_HOME 'scripts/service-process.ps1'); "+script],{windowsHide:true,encoding:'utf8',env:{...process.env,QQ_TEST_HOME:home,...extra}}).trim();}

test('listener identity comes from port ownership, not a stale PID file',()=>{
  assert.equal(run(`function Get-NetTCPConnection { param($State) [pscustomobject]@{LocalPort=19327;OwningProcess=123} }
function Get-CimInstance { param($ClassName,$Filter) [pscustomobject]@{ProcessId=123;Name='node.exe';CommandLine='"node.exe" "'+(Join-Path $env:QQ_TEST_HOME 'src/server.mjs')+'" --connect'} }
(Get-QQBridgeListener -ServerFile (Join-Path $env:QQ_TEST_HOME 'src/server.mjs')).ProcessId`),'123');
});

test('another server on the same port is refused; no listener means no process',()=>{
  assert.equal(run(`function Get-NetTCPConnection { param($State) [pscustomobject]@{LocalPort=19327;OwningProcess=999} }
function Get-CimInstance { param($ClassName,$Filter) [pscustomobject]@{ProcessId=999;Name='node.exe';CommandLine='"node.exe" "D:\Other\server.mjs"'} }
try { Get-QQBridgeListener -ServerFile (Join-Path $env:QQ_TEST_HOME 'src/server.mjs'); throw 'unexpected success' } catch { if ($_.Exception.Message -like '*another service*') { 'REFUSED' } else { throw } }`),'REFUSED');
  assert.equal(run(`function Get-NetTCPConnection { param($State) }
if ($null -eq (Get-QQBridgeListener -ServerFile (Join-Path $env:QQ_TEST_HOME 'src/server.mjs'))) { 'NONE' }`),'NONE');
});

test('lifecycle file lock excludes concurrent starts and is reusable after disposal',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'qq-service-lock-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  assert.equal(run(`$first=Lock-QQBridgeLifecycle -PrivateDirectory $env:QQ_TEST_DIRECTORY
try {
 try { $second=[IO.File]::Open((Join-Path $env:QQ_TEST_DIRECTORY 'service-lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $second.Dispose(); throw 'lock not held' } catch [IO.IOException] { }
} finally { $first.Dispose() }
$again=Lock-QQBridgeLifecycle -PrivateDirectory $env:QQ_TEST_DIRECTORY; $again.Dispose(); 'LOCKED'`,{QQ_TEST_DIRECTORY:folder}),'LOCKED');
});
