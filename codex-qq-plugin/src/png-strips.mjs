import {createDeflate} from 'node:zlib';
import {Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const crcTable=Uint32Array.from({length:256},(_,value)=>{
  for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;
  return value>>>0;
});
function chunk(type,data=Buffer.alloc(0)) {
  const name=Buffer.from(type,'ascii'),out=Buffer.allocUnsafe(data.length+12);
  out.writeUInt32BE(data.length,0);name.copy(out,4);data.copy(out,8);
  let crc=0xffffffff;
  for(const byte of out.subarray(4,-4))crc=crcTable[(crc^byte)&255]^(crc>>>8);
  out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);
  return out;
}

/** Lossless RGBA PNG, read in short strips instead of making a second full-size bitmap. */
export async function encodePngTiles({width,height,renderTile}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>20_000_000)
    throw new Error('PNG_DIMENSIONS_INVALID');
  const stride=width*4;
  function* scanlines() {
    for(let tileTop=0;tileTop<height;tileTop+=512) {
      const tileHeight=Math.min(512,height-tileTop),tile=renderTile(tileTop,tileHeight);
      if(tile.length!==stride*tileHeight)throw new Error('PNG_TILE_INVALID');
      for(let top=0;top<tileHeight;top+=16) {
      const rows=Math.min(16,tileHeight-top),data=tile.subarray(top*stride,(top+rows)*stride);
      const bytes=Buffer.allocUnsafe((stride+1)*rows);
      for(let row=0;row<rows;row++) {
        const source=row*stride,destination=row*(stride+1);
        bytes[destination]=1; // PNG Sub filter; lossless, one preceding pixel per byte channel.
        for(let x=0;x<stride;x++)bytes[destination+1+x]=(data[source+x]-(x>=4?data[source+x-4]:0))&255;
      }
      yield bytes;
      }
    }
  }
  const parts=[];
  await pipeline(Readable.from(scanlines(),{objectMode:false}),createDeflate({level:6}),
    new Writable({write(data,encoding,done){parts.push(data);done();}}));
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);
  header[8]=8;header[9]=6; // 8-bit RGBA, standard compression/filtering, no interlace.
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    ...parts.map(data=>chunk('IDAT',data)),chunk('IEND')]);
}
