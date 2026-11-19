import {createBridgeClient} from '../src/bridge-client.mjs';
try {
  const client=createBridgeClient();
  if(process.argv.slice(2).some(arg=>arg!=='--prepare'))throw Error('INVALID_ARGUMENT');
  const result=await (process.argv.includes('--prepare')?client.prepareGroupMorning():client.groupMorning());
  console.log(JSON.stringify(result));
  if (!result.ok&&!['NO_MORNING_GROUPS','DUPLICATE','PAUSED','NOT_CONNECTED','MORNING_NOT_DUE'].includes(result.code)) process.exitCode=1;
} catch {
  console.error('GROUP_MORNING_UNAVAILABLE');
  process.exitCode=1;
}
