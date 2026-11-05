import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {encodePngTiles} from '../src/png-strips.mjs';

test('tile PNG roundtrips all pixel bytes and rejects oversized output',async()=>{
  const canvas=createCanvas(53,37),context=canvas.getContext('2d');
  const gradient=context.createLinearGradient(0,0,53,37);gradient.addColorStop(0,'#f4f6f3');gradient.addColorStop(1,'#145257');
  context.fillStyle=gradient;context.fillRect(0,0,53,37);context.clearRect(2,3,5,7);
  context.fillStyle='#dca42a88';context.fillRect(20,10,15,18);
  const expected=context.getImageData(0,0,53,37).data;
  const requests=[];
  const encoded=await encodePngTiles({width:53,height:37,renderTile:(y,h)=>{
    requests.push(h);return context.getImageData(0,y,53,h).data;
  }}),decoded=await loadImage(encoded);
  const result=createCanvas(53,37);result.getContext('2d').drawImage(decoded,0,0);
  assert.deepEqual(result.getContext('2d').getImageData(0,0,53,37).data,expected);
  assert.deepEqual(requests,[37]);
  await assert.rejects(()=>encodePngTiles({width:10000,height:10000}),/DIMENSIONS/);
});

test('long PNG joins tiles without dropping or repeating boundary rows',async()=>{
  const requests=[];
  const buffer=await encodePngTiles({width:2,height:4101,renderTile:(top,height)=>{
    requests.push([top,height]);const bytes=new Uint8ClampedArray(2*height*4);
    for(let row=0;row<height;row++)for(let x=0;x<2;x++)bytes.set([(top+row)%256,Math.floor((top+row)/256),x,255],(row*2+x)*4);
    return bytes;
  }});
  assert.deepEqual(requests,[...Array.from({length:8},(_,i)=>[i*512,512]),[4096,5]]);
  const decoded=await loadImage(buffer),canvas=createCanvas(2,4101),c=canvas.getContext('2d');c.drawImage(decoded,0,0);
  for(const y of [0,511,512,2047,2048,4095,4096,4100])assert.deepEqual([...c.getImageData(0,y,1,1).data],[y%256,Math.floor(y/256),0,255]);
});
