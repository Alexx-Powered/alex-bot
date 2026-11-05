/** Only locally generated, bounded MP4 bytes; never URL or filesystem arguments. */
export function validVideo(value){
  return !!value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===2&&Buffer.isBuffer(value.buffer)&&value.mimeType==='video/mp4'&&value.buffer.length>=32&&value.buffer.length<=4*1024*1024&&value.buffer.toString('ascii',4,8)==='ftyp'&&value.buffer.readUInt32BE(0)>=16&&value.buffer.readUInt32BE(0)<=value.buffer.length;
}
