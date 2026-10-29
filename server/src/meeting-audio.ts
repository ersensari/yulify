/** Durable incoming WAV packets and playable three-minute meeting parts. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export const RATE=16000,PART_SAMPLES=180*RATE;
export function meetingPcm(wav:Buffer):Buffer {
  if(wav.length<44 || wav.toString('ascii',0,4)!=='RIFF' || wav.toString('ascii',8,12)!=='WAVE')throw new Error('A PCM WAV recording is required');
  let format=false;
  for(let at=12;at+8<=wav.length;){
    const size=wav.readUInt32LE(at+4),end=at+8+size;
    if(end>wav.length)throw new Error('Truncated WAV recording');
    const name=wav.toString('ascii',at,at+4);
    if(name==='fmt '){
      if(size<16 || wav.readUInt16LE(at+8)!==1 || wav.readUInt16LE(at+10)!==1 || wav.readUInt32LE(at+12)!==RATE || wav.readUInt16LE(at+22)!==16)throw new Error('Send mono 16 kHz 16-bit PCM WAV');
      format=true;
    }
    if(name==='data'){
      if(!format || !size || size%2)throw new Error('Invalid WAV sample data');
      return wav.subarray(at+8,end);
    }
    at=end+(size%2);
  }
  throw new Error('WAV sample data is missing');
}
export function meetingWav(pcm:Buffer):Buffer {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(RATE,24);h.writeUInt32LE(RATE*2,28);
  h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
export function durableWrite(file:string,data:string|Buffer){
  const temp=file+'.tmp',fd=fs.openSync(temp,'w',0o600);
  try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
export interface AudioPacket {sequence:number;hash:string;file:string;start:number;samples:number;created:string}
export interface AudioPart {index:number;file:string;start:number;end:number;transcript?:string;summary?:string;summary_status?:string;error?:string}
export class MeetingAudio {
  packets:AudioPacket[]=[];parts:AudioPart[]=[];samples=0;
  constructor(readonly root:string){
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const manifest=path.join(root,'index.json');
    if(fs.existsSync(manifest)){
      const value=JSON.parse(fs.readFileSync(manifest,'utf8'));this.packets=value.packets||[];this.parts=value.parts||[];
      this.samples=this.packets.reduce((n,p)=>n+p.samples,0);
    }
    // An audio file may have reached disk just before the metadata rename.
    for(;;){
      const file=`packet-${String(this.packets.length).padStart(6,'0')}.wav`;
      if(!fs.existsSync(path.join(root,file)))break;
      const bytes=fs.readFileSync(path.join(root,file)),pcm=meetingPcm(bytes);
      this.packets.push({sequence:this.packets.length,hash:createHash('sha256').update(bytes).digest('hex'),file,start:this.samples,samples:pcm.length/2,created:new Date().toISOString()});
      this.samples+=pcm.length/2;
    }
    this.save();
  }
  save(){durableWrite(path.join(this.root,'index.json'),JSON.stringify({sample_rate:RATE,samples:this.samples,packets:this.packets,parts:this.parts},null,2));}
  append(bytes:Buffer,sequence?:number){
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(sequence!==undefined && sequence<this.packets.length){
      if(this.packets[sequence]?.hash!==hash)throw new Error('Audio sequence conflicts with an already saved packet');
      return {duplicate:true,packet:this.packets[sequence]};
    }
    if(sequence!==undefined && sequence!==this.packets.length)throw new Error(`Expected audio sequence ${this.packets.length}`);
    const pcm=meetingPcm(bytes);
    if(pcm.length>RATE*300*2)throw new Error('Send no more than five minutes of audio in one upload');
    if(this.samples+pcm.length/2>RATE*7200)throw new Error('The meeting reached two hours; start another recording');
    const file=`packet-${String(this.packets.length).padStart(6,'0')}.wav`;
    durableWrite(path.join(this.root,file),bytes);
    const packet={sequence:this.packets.length,hash,file,start:this.samples,samples:pcm.length/2,created:new Date().toISOString()};
    this.packets.push(packet);this.samples+=packet.samples;this.save();this.buildParts(false);
    return {duplicate:false,packet};
  }
  read(packet:AudioPacket){return meetingPcm(fs.readFileSync(path.join(this.root,packet.file)));}
  buildParts(final:boolean){
    const count=final?Math.ceil(this.samples/PART_SAMPLES):Math.floor(this.samples/PART_SAMPLES);
    for(let index=this.parts.length;index<count;index++){
      const start=index*PART_SAMPLES,end=Math.min(this.samples,start+PART_SAMPLES),pieces:Buffer[]=[];
      for(const packet of this.packets){
        if(packet.start>=end)break;
        if(packet.start+packet.samples<=start)continue;
        pieces.push(this.read(packet).subarray(Math.max(0,start-packet.start)*2,Math.min(packet.samples,end-packet.start)*2));
      }
      const file=`part-${String(index+1).padStart(4,'0')}.wav`;
      durableWrite(path.join(this.root,file),meetingWav(Buffer.concat(pieces)));
      this.parts.push({index,file,start:start/RATE,end:end/RATE,summary_status:'waiting_for_transcript'});this.save();
    }
  }
}
