/** Audio is committed to disk before acknowledgment; ASR and summaries run independently. */
import express,{type Router} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {getSession} from '../db.js';
import {sessions} from '../session-manager.js';
import {sharedAsr,type TranscriptionSnapshot} from '../shared-asr.js';
import {MeetingAudio,meetingWav,durableWrite,RATE,PART_SAMPLES} from '../meeting-audio.js';
import {summarizeMeetingPart} from '../meeting-summary.js';
interface MeetingState {
  chat:string;filePath:string;startedAt:string;audio:MeetingAudio;recording:boolean;
  source?:string;snapshot:TranscriptionSnapshot;packet:number;offset:number;sourceSequence:number;
  recovery?:string;error?:string;processing?:Promise<void>;summarizing?:Promise<void>;summary?:Promise<void>;
  watcher?:ReturnType<typeof setInterval>;
}
const active=new Map<string,MeetingState>();
const label=(seconds:number)=>`${String(Math.floor(seconds/3600)).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(Math.floor(seconds)%60).padStart(2,'0')}`;
const empty=():TranscriptionSnapshot=>({id:'',status:'recording',sample_rate:RATE,samples:0,next_sequence:0,turns:[]});
const manifest=(s:MeetingState)=>s.filePath.replace(/\.txt$/,'.state.json');
function save(s:MeetingState){
  durableWrite(manifest(s),JSON.stringify({chat:s.chat,startedAt:s.startedAt,recording:s.recording,source:s.source,packet:s.packet,offset:s.offset,sourceSequence:s.sourceSequence,recovery:s.recovery,error:s.error}));
  const text=`# Meeting started ${s.startedAt}\n# Audio: ${path.basename(s.audio.root)}\n# Recording: ${s.recording?'active':'stopped'}\n${s.recovery?`# Recording gap: ${s.recovery}\n`:''}${s.error?`# Transcription notice: ${s.error}\n`:''}\n`+s.snapshot.turns.map(t=>`[${label(t.start)} – ${label(t.end)}] ${t.speaker}${t.overlap?' (overlap)':''}: ${t.text}`).join('\n')+'\n';
  durableWrite(s.filePath,text);durableWrite(s.filePath.replace(/\.txt$/,'.json'),JSON.stringify(payload(s),null,2));
}
function payload(s:MeetingState){return {...s.snapshot,status:s.recording?'recording':s.snapshot.status,recording:s.recording,audio_saved:true,recorded_seconds:s.audio.samples/RATE,next_sequence:s.audio.packets.length,
  transcription_status:s.error?'pending':s.snapshot.status,error:s.error||s.snapshot.error,recovery_notice:s.recovery,
  parts:s.audio.parts.map(p=>({...p,file:path.posix.join(path.basename(s.audio.root),p.file)}))};}
function writeParts(s:MeetingState,through:number,summarize:(id:string,text:string)=>Promise<string>){
  for(const part of s.audio.parts){
    if(part.transcript||part.end>through)continue;
    const turns=s.snapshot.turns.filter(t=>t.start<part.end&&t.end>part.start);
    const text=`# Meeting excerpt ${label(part.start)} – ${label(part.end)}\n${s.recovery?`# Earlier recording gap: ${s.recovery}\n`:''}\n`+turns.map(t=>`[${label(t.start)}] ${t.speaker}: ${t.text}`).join('\n');
    part.transcript=part.file.replace(/\.wav$/,'.txt');durableWrite(path.join(s.audio.root,part.transcript),text);
    if(!turns.length){part.summary_status='no_speech';s.audio.save();continue;}
    part.summary_status='queued';s.audio.save();
    s.summarizing=(s.summarizing??Promise.resolve()).then(async()=>{
      try{
        part.summary_status='summarizing';s.audio.save();const notes=await summarize(s.chat,text);
        part.summary=part.file.replace(/\.wav$/,'.summary.md');durableWrite(path.join(s.audio.root,part.summary),notes+'\n');part.summary_status='completed';delete part.error;
      }catch(e){part.summary_status='failed';part.error=(e as Error).message;}
      s.audio.save();save(s);
    }).catch(e=>{s.error=`Could not save part summary: ${(e as Error).message}`;});
  }
}
async function processAudio(s:MeetingState,summarize:(id:string,text:string)=>Promise<string>){
  if(s.processing)return s.processing;
  if(!s.audio.packets.length || (s.packet>=s.audio.packets.length&&s.snapshot.status==='completed'))return;
  const task=(async()=>{
    try{
      if(s.source){
        try{s.snapshot=await sharedAsr<TranscriptionSnapshot>(`/sessions/${s.source}`);}
        catch{s.source=undefined;}
        if(!['recording','processing'].includes(s.snapshot.status))s.source=undefined;
      }
      if(!s.source){
        const value=await sharedAsr<TranscriptionSnapshot>('/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        s.source=value.id;s.snapshot=value;s.packet=0;s.offset=0;s.sourceSequence=0;save(s);
      }
      delete s.error;
      while(s.packet<s.audio.packets.length){
        const packet=s.audio.packets[s.packet],pcm=s.audio.read(packet);
        while(s.offset<pcm.length){
          const absolute=packet.start+s.offset/2;
          const untilBoundary=(Math.floor(absolute/PART_SAMPLES)+1)*PART_SAMPLES-absolute;
          const end=Math.min(pcm.length,s.offset+Math.min(RATE*2,untilBoundary)*2);
          const bytes=meetingWav(pcm.subarray(s.offset,end));
          let result:TranscriptionSnapshot|undefined;
          for(let attempt=0;attempt<60;attempt++){
            try{result=await sharedAsr<TranscriptionSnapshot>(`/sessions/${s.source}/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-Audio-Sequence':String(s.sourceSequence)},body:new Uint8Array(bytes)});break;}
            catch(e){if(!(e as Error).message.includes('overloaded')||attempt===59)throw e;await new Promise(r=>setTimeout(r,200));}
          }
          if(!result)throw new Error('Transcription queue is unavailable');
          s.snapshot=result;s.sourceSequence++;s.offset=end;save(s);
          const sent=packet.start+s.offset/2;
          if(sent%PART_SAMPLES===0){
            s.snapshot=await sharedAsr<TranscriptionSnapshot>(`/sessions/${s.source}/checkpoint`,{method:'POST'});
            writeParts(s,sent/RATE,summarize);save(s);
          }
        }
        s.packet++;s.offset=0;save(s);
      }
    }catch(e){s.error=(e as Error).message;save(s);}
  })();
  s.processing=task;
  await task;s.processing=undefined;
}
function watch(s:MeetingState,summarize:(id:string,text:string)=>Promise<string>){
  clearInterval(s.watcher);
  s.watcher=setInterval(()=>{
    if(!s.recording){clearInterval(s.watcher);return;}
    if(s.packet<s.audio.packets.length)void processAudio(s,summarize);
    else if(s.source&&!s.processing)void sharedAsr<TranscriptionSnapshot>(`/sessions/${s.source}`).then(value=>{s.snapshot=value;save(s);}).catch(e=>{s.error=(e as Error).message;});
  },2000);s.watcher.unref();
}
function recover(chat:string,workspace:string):MeetingState|undefined {
  const dir=path.join(workspace,'.meeting-notes');if(!fs.existsSync(dir))return;
  const names=fs.readdirSync(dir).filter(n=>n.endsWith('.state.json')).sort().reverse();
  for(const name of names.slice(0,20)){
    const file=path.join(dir,name),value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(value.chat!==chat||!value.recording)continue;
    const filePath=file.replace(/\.state\.json$/,'.txt');
    const snapshotFile=filePath.replace(/\.txt$/,'.json');
    const snapshot=fs.existsSync(snapshotFile)?JSON.parse(fs.readFileSync(snapshotFile,'utf8')):empty();
    return {...value,chat,filePath,audio:new MeetingAudio(filePath.replace(/\.txt$/,'-audio')),snapshot};
  }
}

/** Reprocess a saved meeting without changing its original audio or transcript on failure. */
export async function reprocessMeeting(chat:string,workspace:string,transcriptName?:string,
  summarize:(id:string,text:string)=>Promise<string>=summarizeMeetingPart){
  const dir=path.join(workspace,'.meeting-notes');
  const names=fs.readdirSync(dir).filter(n=>/^meeting-.*\.state\.json$/.test(n)).sort().reverse();
  const selected=transcriptName?transcriptName.replace(/\.txt$/,''):names[0]?.replace(/\.state\.json$/,'');
  if(!selected||!/^meeting-[\w.-]+$/.test(selected))throw new Error('No valid saved meeting was selected');
  const statePath=path.join(dir,`${selected}.state.json`),filePath=path.join(dir,`${selected}.txt`);
  if(!fs.existsSync(statePath)||!fs.existsSync(filePath))throw new Error('Saved meeting not found');
  const meta=JSON.parse(fs.readFileSync(statePath,'utf8')) as {chat?:string;recording?:boolean};
  if(meta.chat!==chat)throw new Error('Saved meeting belongs to another chat');
  if(meta.recording)throw new Error('Stop the meeting before reprocessing it');
  const audio=new MeetingAudio(filePath.replace(/\.txt$/,'-audio'));
  if(!audio.packets.length)throw new Error('This meeting has no saved audio packets');
  const state:MeetingState={...meta,chat,filePath,startedAt:'',audio,recording:false,snapshot:empty(),packet:0,offset:0,sourceSequence:0};
  const previous=JSON.parse(fs.readFileSync(filePath.replace(/\.txt$/,'.json'),'utf8')) as TranscriptionSnapshot;
  try{
    const source=await sharedAsr<TranscriptionSnapshot>('/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    state.source=source.id;state.snapshot=source;
    while(state.packet<audio.packets.length){
      const packet=audio.packets[state.packet],pcm=audio.read(packet);
      while(state.offset<pcm.length){
        const absolute=packet.start+state.offset/2,boundary=(Math.floor(absolute/PART_SAMPLES)+1)*PART_SAMPLES-absolute;
        const end=Math.min(pcm.length,state.offset+Math.min(RATE*2,boundary)*2);
        const sequence=state.sourceSequence++;let result:TranscriptionSnapshot|undefined;
        for(let attempt=0;attempt<60;attempt++){
          try{result=await sharedAsr<TranscriptionSnapshot>(`/sessions/${state.source}/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-Audio-Sequence':String(sequence)},body:new Uint8Array(meetingWav(pcm.subarray(state.offset,end)))});break;}
          catch(error){if(!(error as Error).message.toLowerCase().includes('overloaded')||attempt===59)throw error;await new Promise(resolve=>setTimeout(resolve,200));}
        }
        if(!result)throw new Error('Transcription queue is unavailable');
        state.snapshot=result;
        state.offset=end;
      }
      state.packet++;state.offset=0;
    }
    state.snapshot=await sharedAsr<TranscriptionSnapshot>(`/sessions/${state.source}/stop`,{method:'POST'});
    state.packet=audio.packets.length;state.offset=0;delete state.error;
    // Keep the original files intact until all retries have succeeded; write each
    // refreshed part beside it and publish the replacement transcript last.
    const original=state.filePath;
    state.filePath=original.replace(/\.txt$/,'-reprocessed.txt');
    for(const part of audio.parts){delete part.transcript;delete part.summary;delete part.error;part.summary_status='waiting_for_transcript';}
    writeParts(state,audio.samples/RATE,summarize);save(state);
    if(state.summarizing)await state.summarizing;
    return {ok:true,transcriptPath:path.relative(workspace,state.filePath),recorded_seconds:audio.samples/RATE,turns:state.snapshot.turns.length,parts:audio.parts.map(p=>({index:p.index,start:p.start,end:p.end,summary_status:p.summary_status,error:p.error}))};
  }catch(error){
    // Preserve the first-pass transcript if a retry is interrupted or the STT service fails.
    const current=state.snapshot;
    if(current.turns?.length)durableWrite(filePath.replace(/\.txt$/,'-reprocess-failed.json'),JSON.stringify({error:(error as Error).message,turns:current.turns},null,2));
    else durableWrite(filePath.replace(/\.txt$/,'-reprocess-failed.json'),JSON.stringify({error:(error as Error).message,previous_turns:previous.turns?.length??0},null,2));
    throw error;
  }
}
function create(chat:string,workspace:string,recovery?:string):MeetingState {
  const dir=path.join(workspace,'.meeting-notes');fs.mkdirSync(dir,{recursive:true});const startedAt=new Date().toISOString();
  const filePath=path.join(dir,`meeting-${startedAt.replace(/[:.]/g,'-')}.txt`);
  const s:MeetingState={chat,filePath,startedAt,audio:new MeetingAudio(filePath.replace(/\.txt$/,'-audio')),recording:true,snapshot:empty(),packet:0,offset:0,sourceSequence:0,recovery};save(s);return s;
}
export function meetingNotesRouter(options:{summarize?:(id:string,text:string)=>Promise<string>}={}):Router{
  const router=express.Router(),summarize=options.summarize??summarizeMeetingPart;
  const get=(chat:string,workspace:string)=>{
    let s=active.get(chat);
    if(!s){s=recover(chat,workspace);if(s){active.set(chat,s);watch(s,summarize);}}
    return s;
  };
  router.post('/sessions/:id/meeting/start',async(req,res)=>{
    const session=getSession(String(req.params.id));if(!session)return res.status(404).json({error:'Session not found'});
    try{
      const old=get(session.id,session.workspace);if(old?.recording)return res.status(409).json({error:'A meeting is already being recorded in this chat'});
      const s=create(session.id,session.workspace);active.set(session.id,s);watch(s,summarize);
      res.json({ok:true,...payload(s),transcriptPath:path.relative(session.workspace,s.filePath)});
    }catch(e){res.status(503).json({error:(e as Error).message});}
  });
  router.get('/sessions/:id/meeting',async(req,res)=>{
    const session=getSession(String(req.params.id));if(!session)return res.status(404).json({error:'Session not found'});
    try{const s=get(session.id,session.workspace);res.json(s?{...payload(s),transcriptPath:path.relative(session.workspace,s.filePath)}:{status:'idle',recording:false,turns:[]});}
    catch(e){res.status(502).json({error:(e as Error).message});}
  });
  // Accept cached 15s clients and up to 5-minute packets. ASR still receives <=2s.
  router.post('/sessions/:id/meeting/chunk',express.raw({type:'audio/wav',limit:'12mb'}),async(req,res)=>{
    const session=getSession(String(req.params.id));if(!session)return res.status(404).json({error:'Session not found'});
    try{
      if(!Buffer.isBuffer(req.body))return res.status(400).json({error:'A WAV recording is required'});
      const header=req.header('X-Audio-Sequence');
      if(header!==undefined&&!/^\d+$/.test(header))return res.status(400).json({error:'Invalid audio sequence'});
      // Validate before creating a recovery recording or touching disk.
      const {meetingPcm}=await import('../meeting-audio.js');meetingPcm(req.body);
      let s=get(session.id,session.workspace);
      if(!s||!s.recording){
        if(header!==undefined)return res.status(409).json({error:'No meeting is being recorded in this chat'});
        s=create(session.id,session.workspace,'The earlier upload protocol rejected audio. Only audio received after recovery is available.');
        active.set(session.id,s);watch(s,summarize);
      }
      s.audio.append(req.body,header===undefined?undefined:Number(header));save(s);
      res.json({...payload(s),ok:true,transcriptPath:path.relative(session.workspace,s.filePath)});
      void processAudio(s,summarize);
    }catch(e){res.status(400).json({error:(e as Error).message});}
  });
  router.post('/sessions/:id/meeting/stop',async(req,res)=>{
    const session=getSession(String(req.params.id));if(!session)return res.status(404).json({error:'Session not found'});
    const s=get(session.id,session.workspace);if(!s)return res.status(409).json({error:'No meeting is being recorded in this chat'});
    try{
      if(req.body?.incomplete===true)s.recovery=[s.recovery,'Capture or upload ended with an error; only received audio is available.'].filter(Boolean).join(' ');
      s.recording=false;clearInterval(s.watcher);s.audio.buildParts(true);save(s);
      await processAudio(s,summarize);
      if(s.source&&!s.error)s.snapshot=await sharedAsr<TranscriptionSnapshot>(`/sessions/${s.source}/stop`,{method:'POST'});
      if(!s.audio.samples)s.snapshot.status='completed';
      if(!s.error){writeParts(s,s.audio.samples/RATE,summarize);save(s);}
      if(req.body?.summarize!==false&&!s.error&&!s.summary&&s.snapshot.turns.length){
        s.summary=sessions.prompt(session.id,`Read ${path.relative(session.workspace,s.filePath)} and its three-minute part notes in ${path.relative(session.workspace,s.audio.root)}. Summarize topics, decisions and action items in the transcript language. Explicitly disclose any recording gaps. Speaker numbers are anonymous.`).then(()=>{});
        s.summary.catch(()=>{s.summary=undefined;});
      }
      if(s.summary)await s.summary;
      res.json({ok:true,...payload(s),transcriptPath:path.relative(session.workspace,s.filePath)});
    }catch(e){s.error=(e as Error).message;save(s);res.status(502).json({error:s.error,audio_saved:true,transcriptPath:path.relative(session.workspace,s.filePath)});}
  });
  return router;
}
