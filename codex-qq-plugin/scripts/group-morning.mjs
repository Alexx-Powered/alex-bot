import {createBridgeClient} from '../src/bridge-client.mjs';
try {
  const client=createBridgeClient();
  const result=await client.groupMorning();
  console.log(JSON.stringify({ok:result.ok,code:result.code,attempted:result.attempted,sent:result.sent}));
  if (!result.ok&&!['NO_MORNING_GROUPS','DUPLICATE','PAUSED','NOT_CONNECTED','MORNING_NOT_DUE'].includes(result.code)) process.exitCode=1;
} catch {
  console.error('GROUP_MORNING_UNAVAILABLE');
  process.exitCode=1;
}
