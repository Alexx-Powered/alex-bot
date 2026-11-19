import {loadImage} from '@napi-rs/canvas';

export async function studyImage(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length>1_500_000||buffer.length<45||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
     buffer.readUInt32BE(8)!==13||buffer.toString('ascii',12,16)!=='IHDR')throw Error('INVALID_INPUT');
  const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
  if(![1080,1800].includes(width)||height<200||height>16000||width*height>28800000)throw Error('INVALID_INPUT');
  try{const decoded=await loadImage(buffer);if(decoded.width!==width||decoded.height!==height)throw Error();}
  catch{throw Error('INVALID_INPUT');}
  return {buffer,mimeType:'image/png'};
}
