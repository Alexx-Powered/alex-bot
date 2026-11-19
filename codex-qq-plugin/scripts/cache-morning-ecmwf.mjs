import {captureMorningEc} from '../src/morning-ecmwf.mjs';
import {morningPlan} from '../src/morning-calendar.mjs';
import {createBridgeClient} from '../src/bridge-client.mjs';

const home=process.env.QQ_BRIDGE_HOME;
if (!home) throw Error('MORNING_EC_HOME_REQUIRED');
const now=Date.now();
const {city}=morningPlan(now+24*3600000);
try {
  const groups=await createBridgeClient({home,timeoutMs:3000}).morningWeatherGroups();
  const result=groups ? await captureMorningEc({home,city,now}) : {ok:true,code:'NO_MORNING_WEATHER_GROUPS'};
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({code:error?.code||'MORNING_EC_CACHE_UNAVAILABLE'}));
  process.exitCode=1;
}
