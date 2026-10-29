import {realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
// Releases are launched through /opt/alex-bot/current, which is a symlink.
export async function isEntrypoint(url,argument=process.argv[1]) {
  if(!argument)return false;
  try{return pathToFileURL(await realpath(argument)).href===url;}catch{return false;}
}
