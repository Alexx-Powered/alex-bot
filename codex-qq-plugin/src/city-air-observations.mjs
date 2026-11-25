const knownCities={beijing:'北京',tianjin:'天津',guangzhou:'广州'};
let pending,cacheDate,expires=0;

export function citySamples(csv,date,name,now){
  const [header,...rows]=csv.trim().split(/\r?\n/);
  const columns=header.replace(/^\uFEFF/,'').split(',');
  const column=columns.indexOf(name), samples=new Map();
  if(column<3||columns.slice(0,3).join(',')!=='date,hour,type')return samples;
  const day=date.replaceAll('-',''), start=Date.parse(date+'T00:00:00+08:00');
  for(const row of rows){
    const fields=row.split(',');
    if(fields[0]!==day||fields[2]!=='PM2.5'||!/^([01]?\d|2[0-3])$/.test(fields[1]))continue;
    const hour=Number(fields[1]),value=fields[column];
    if(!/^\d+(\.\d+)?$/.test(value)||Number(value)>5000||start+hour*3600000>now)continue;
    samples.set(hour,Number(value));
  }
  if(!samples.size||now-start-Math.max(...samples.keys())*3600000>3*3600000)samples.clear();
  return samples;
}

export async function currentCitySamples(date,city,place,now=Date.now()){
  const name=Object.hasOwn(knownCities,city)?knownCities[city]:place?.id===city?place.name:null;
  if(typeof name!=='string'||new Date(now+8*3600000).toISOString().slice(0,10)!==date)return new Map();
  if(cacheDate!==date||now>=expires){
    cacheDate=date;expires=now+300000;
    pending=fetch('https://quotsoft.net/air/data/china_cities_'+date.replaceAll('-','')+'.csv',
      {signal:AbortSignal.timeout(4000)}).then(async response=>{
        if(!response.ok)return '';
        return response.text();
      }).catch(()=>'');
  }
  return citySamples(await pending,date,name,now);
}
