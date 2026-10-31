import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CITIES,HOUR_MS,localIso} from '../src/weather.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {MorningReportService} from '../src/morning-report.mjs';

const home=fileURLToPath(new URL('../',import.meta.url)),out=resolve(home,'test-output','morning-preview');
await mkdir(out,{recursive:true});
const worker=new PythonAgentWorker({home});
const scenarios=[
  {id:'workday-monday',date:'2026-10-26',hour:8},
  {id:'weekday-thursday',date:'2026-10-29',hour:8},
  {id:'holiday-tianjin',date:'2026-05-01',hour:8,sun:true},
  {id:'haze-indoor',date:'2026-10-29',hour:8,pm:120},
  {id:'missing-data',date:'2026-10-29',hour:8,missing:true},
  {id:'late-start',date:'2026-10-29',hour:23},
];
const records=[];
try{
  for(const s of scenarios){
    const now=Date.parse(`${s.date}T${String(s.hour).padStart(2,'0')}:00:00+08:00`),midnight=Date.parse(s.date+'T00:00:00+08:00');
    const commands=new WeatherCommands({now:()=>now,
      weather:async({city,days=1,exerciseFields})=>({simulated:true,city:CITIES[city],date:s.date,timezone:'Asia/Shanghai',fetchedAt:new Date(now).toISOString(),hourly:Array.from({length:days*24},(_,h)=>({time:localIso(midnight+h*HOUR_MS),periodEnd:localIso(midnight+(h+1)*HOUR_MS),temperatureC:18+Math.sin((h-6)*Math.PI/12)*6,humidityPct:55,cloudCoverPct:s.missing?null:35,precipitationMm:0,precipitationProbabilityPct:10,rainMm:0,snowfallCm:0,...(exerciseFields?{windSpeedMs:s.missing?null:2,solarRadiationWm2:h%24>=6&&h%24<19?(s.sun?650:200):0,weatherCode:0}:{})}))}),
      air:async({city})=>({city:CITIES[city],timezone:'Asia/Shanghai',fetchedAt:new Date(now).toISOString(),hourly:Array.from({length:48},(_,h)=>({time:localIso(midnight+h*HOUR_MS),pm25:s.pm??20}))}),
    });
    const report=await new MorningReportService({commands,worker,now:()=>now}).create();
    if(report.analysis.title==='运动建议暂不可用')throw new Error('Local Python analysis failed');
    const file=resolve(out,s.id+'.png');await writeFile(file,report.image.buffer);
    const record={scenario:s.id,simulated:true,noExternalRequests:true,date:report.date,city:report.cities[0],analysis:report.analysis,file};
    records.push(record);await writeFile(resolve(out,s.id+'.json'),JSON.stringify(record,null,2));
    console.log(JSON.stringify({scenario:s.id,city:report.cities[0],windows:report.analysis.windows.length,recommendation:report.analysis.recommendation,file}));
  }
  await writeFile(resolve(out,'index.json'),JSON.stringify(records,null,2));
}finally{worker.close();}

