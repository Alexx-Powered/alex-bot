import {loadImage} from '@napi-rs/canvas';

// Authenticated local WorkBuddy renderer only. No paths, URLs or recipients.
export async function studyImage(data){
  if(!data||Object.keys(data).some(k=>!['idempotencyKey','pngBase64'].includes(k))||
     !/^study:[0-9a-f]{64}$/.test(data.idempotencyKey||'')||typeof data.pngBase64!=='string'||
     data.pngBase64.length>2000000||data.pngBase64.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(data.pngBase64))throw Error('INVALID_INPUT');
  const buffer=Buffer.from(data.pngBase64,'base64');
  if(buffer.length<45||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
     buffer.readUInt32BE(8)!==13||buffer.toString('ascii',12,16)!=='IHDR')throw Error('INVALID_INPUT');
  const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
  if(![1080,1800].includes(width)||height<200||height>16000||width*height>28800000)throw Error('INVALID_INPUT');
  try{const decoded=await loadImage(buffer);if(decoded.width!==width||decoded.height!==height)throw Error();}
  catch{throw Error('INVALID_INPUT');}
  return {buffer,mimeType:'image/png'};
}
