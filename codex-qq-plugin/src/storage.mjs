import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {seal,unseal,masterKey} from './secret-codec.mjs';

export const credentialFormat=()=>process.platform==='win32'?'windows-dpapi-v1':'aes-256-gcm-v1';
export const supportedCredentialFormat=value=>['windows-dpapi-v1','aes-256-gcm-v1'].includes(value);

async function powershell(script, input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 10000, maxBuffer: 131072 },
      (error, stdout) => error ? reject(new Error('PRIVATE_STORAGE_UNAVAILABLE')) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function restrictDirectory(dir) {
  if (process.platform !== 'win32') { await fs.chmod(dir, 0o700); return; }
  const script = '$ErrorActionPreference="Stop"; $p=$env:QQ_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[System.IO.Directory]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$false); foreach($r in @($acl.Access)){$acl.RemoveAccessRuleSpecific($r)}; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit",[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)';
  await powershell(script, '', { QQ_PRIVATE_DIR: dir });
}

export async function protectCredential(value) {
  if(process.platform!=='win32'){const key=await masterKey();try{return seal(value,key);}finally{key.fill(0);}}
  return powershell('$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($p); $c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($c))', JSON.stringify(value));
}
export async function unprotectCredential(cipher) {
  if(process.platform!=='win32'){const key=await masterKey();try{return unseal(cipher,key);}finally{key.fill(0);}}
  const script = '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Security; $c=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Text.Encoding]::UTF8.GetString($b))';
  return JSON.parse(await powershell(script, cipher));
}

export async function atomicJson(file, value) {
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, file); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

export class PrivateStore {
  constructor(home, { protect = protectCredential, unprotect = unprotectCredential, restrict = restrictDirectory } = {}) {
    this.dir = path.join(home, '.private');
    this.protect = protect; this.unprotect = unprotect; this.restrict = restrict;
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.restrict(this.dir);
    const tokenFile = path.join(this.dir, 'admin-token');
    try { this.token = (await fs.readFile(tokenFile, 'utf8')).trim(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.token = randomBytes(32).toString('hex');
      await fs.writeFile(tokenFile, this.token, { flag: 'wx', mode: 0o600 });
    }
    if (!/^[0-9a-f]{64}$/.test(this.token)) throw new Error('INVALID_LOCAL_TOKEN');
    const integrationFile=path.join(this.dir,'integration-token');
    try{this.integrationToken=(await fs.readFile(integrationFile,'utf8')).trim();}
    catch(error){if(error.code!=='ENOENT')throw error;this.integrationToken=randomBytes(32).toString('hex');await fs.writeFile(integrationFile,this.integrationToken,{flag:'wx',mode:0o600});}
    if(!/^[0-9a-f]{64}$/.test(this.integrationToken))throw Error('INVALID_LOCAL_TOKEN');
  }
  async readCredentials() {
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.dir, 'credentials.json'), 'utf8'));
      if (!supportedCredentialFormat(data.format)) throw new Error('INVALID_CREDENTIAL_FORMAT');
      return await this.unprotect(data.cipher);
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('CREDENTIAL_READ_FAILED'); }
  }
  async saveCredentials(credentials) {
    const cipher = await this.protect(credentials);
    await atomicJson(path.join(this.dir, 'credentials.json'), { format: credentialFormat(), cipher });
  }
  async loadState() {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('STATE_READ_FAILED'); }
  }
  async saveState(value) { await atomicJson(path.join(this.dir, 'state.json'), value); }
}

