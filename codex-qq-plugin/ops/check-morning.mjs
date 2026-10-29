import fs from 'node:fs/promises';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {MorningReportService} from '../src/morning-report.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {getAirQuality} from '../src/air-quality.mjs';
const worker=new PythonAgentWorker({home:'/var/lib/alexbot'});
try{
  const air=async args=>{try{const data=await getAirQuality(args);console.log(JSON.stringify({air_valid_hours:data.summary.validHours}));return data;}catch(e){console.log(JSON.stringify({air_error:e.code||'CHECK_FAILED'}));throw e;}};
  const result=await new MorningReportService({commands:new WeatherCommands({air}),worker}).create();
  await fs.writeFile('/var/lib/alexbot/.private/preflight/morning.png',result.image.buffer,{mode:0o600});
  console.log(JSON.stringify({ok:true,bytes:result.image.buffer.length,windows:result.analysis.windows.length,levels:result.analysis.windows.map(r=>r.level)}));
}catch(e){console.log(JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(e.message)?e.message:'CHECK_FAILED'}));process.exitCode=1;}finally{worker.close();}
