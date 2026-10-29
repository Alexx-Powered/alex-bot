import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const APP_ROOT=fileURLToPath(new URL('../',import.meta.url));
export function pythonExecutable(){
  return process.env.QQ_PYTHON || path.join(APP_ROOT,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
}
