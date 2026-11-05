// Render only: no QQ send, running bot, network or deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {renderProviderStatusImage,PROVIDER_BRANDS} from '../src/provider-status-image.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out=path.join(root,'test-output/status-providers');
await fs.mkdir(out,{recursive:true});
const manifest=[],headers=[];
for(const provider of Object.keys(PROVIDER_BRANDS)){
  const {report}=JSON.parse(await fs.readFile(path.join(out,provider+'-source.json'),'utf8'));
  const result=await renderProviderStatusImage(report);
  const file=path.join(out,report.title+'状态_品牌版预览.png');await fs.writeFile(file,result.buffer);
  const review=await renderProviderStatusImage(report,{scale:1.5});await fs.writeFile(path.join(out,provider+'-review.png'),review.buffer);
  const full=await loadImage(review.buffer);headers.push(full);
  manifest.push({provider,file,width:result.width,height:result.height,bytes:result.buffer.length,checkedAt:report.checkedAt,overall:report.overall});
}
// One compact color/identity overview; full status images remain available.
const gallery=createCanvas(1380,906),g=gallery.getContext('2d');
g.fillStyle='#f4f6f3';g.fillRect(0,0,gallery.width,gallery.height);
g.fillStyle='#142a32';g.font='700 28px "Weather Noto"';g.fillText('AI 服务状态 · 品牌配色预览',30,46);
g.fillStyle='#63736c';g.font='400 15px "Weather Noto"';g.fillText('官方 Logo · 独立品牌色 · 主卡片节选',30,75);
for(let i=0;i<headers.length;i++){
  const x=i<3?20+i*450:245+(i-3)*450,y=100+Math.floor(i/3)*400;
  g.drawImage(headers[i],0,0,660,534,x,y,440,356);
}
await fs.writeFile(path.join(out,'五家服务状态_配色总览.png'),gallery.toBuffer('image/png'));
// Reuse the previously verified historical fixtures with the new brand marks.
const history=JSON.parse(await fs.readFile(path.join(root,'test-output/status-style-preview/v2/preview-data.json'),'utf8'));
for(const model of history.filter(m=>m.mode==='historical')){
  const provider=model.title.toLowerCase(),report={...model,provider};
  const result=await renderProviderStatusImage(report);
  const file=path.join(out,model.title+'状态_历史故障品牌版预览.png');await fs.writeFile(file,result.buffer);
  const review=await renderProviderStatusImage(report,{scale:1.5});await fs.writeFile(path.join(out,provider+'-incident-review.png'),review.buffer);
  manifest.push({provider,file,mode:'historical',width:result.width,height:result.height,bytes:result.buffer.length});
}
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
