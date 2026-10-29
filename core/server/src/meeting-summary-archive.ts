/** Save the answer to this meeting's existing chat summary request, never a guessed older answer. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableWrite } from './meeting-audio.js';

type Event = {type:string;payload:string};
type Chat = {
  on(event:string, listener:(row:Event)=>void):unknown;
  off(event:string, listener:(row:Event)=>void):unknown;
  ask(id:string, prompt:string, options:{onStopped:()=>void}):Promise<string>;
  prompt(id:string, prompt:string):Promise<boolean>;
};

/** A started status is intentionally never retried automatically, including after a restart. */
export async function archiveMeetingSummary(chat:Chat,id:string,transcriptPath:string,workspace:string):Promise<void> {
  const statusPath=transcriptPath.replace(/\.txt$/,'.summary-status.json');
  const resultPath=transcriptPath.replace(/\.txt$/,'.summary.md');
  // Existing result/status means this meeting already has an attempt or result.
  if(fs.existsSync(statusPath)||fs.existsSync(resultPath))return;
  const requestId=randomUUID();
  const syncDir=()=>{const dir=fs.openSync(path.dirname(statusPath),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}};
  const status=(state:string,error?:string)=>{durableWrite(statusPath,JSON.stringify({version:1,meeting:path.basename(transcriptPath),requestId,state,updatedAt:new Date().toISOString(),...(error?{error}:{}),...(state==='completed'?{file:path.basename(resultPath)}:{})},null,2));syncDir();};
  const prompt=`Read ${path.relative(workspace,transcriptPath)} and its three-minute part notes in ${path.relative(workspace,transcriptPath.replace(/\.txt$/,'-audio'))}. Summarize topics, decisions and action items in the transcript language. Explicitly disclose any recording gaps. Speaker numbers are anonymous. Meeting summary request ID: ${requestId}.`;
  // Reserve before inference; a previous attempt survives restart and is never
  // retried. If storage cannot be reserved, still send the original chat turn.
  let fd:number|undefined;
  try {
    fd=fs.openSync(statusPath,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify({version:1,meeting:path.basename(transcriptPath),requestId,state:'started',updatedAt:new Date().toISOString()},null,2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDir();
  } catch(e) {
    if(fd===undefined && (e as NodeJS.ErrnoException).code==='EEXIST') return;
    console.error('Meeting summary archive could not reserve storage:',e);
    if(fd!==undefined) { try {status('failed','Could not reserve archive storage; the summary was requested only in the chat.');} catch {/* storage unavailable */} }
    await chat.prompt(id,prompt);
    return;
  }
  let otherPrompt=false, ownPrompts=0, stopped=false;
  const key=`session:${id}`;
  const onEvent=(row:Event)=>{
    if(row.type==='portal_command' || row.type==='portal_unsent'){otherPrompt=true;return;}
    if(row.type==='portal_status' || row.type==='portal_notice' || row.type==='message_end') {
      try {
        const p=JSON.parse(row.payload);
        if(p.status==='error' || p.aborted || p.error || p.message?.stopReason==='error') otherPrompt=true;
      } catch { otherPrompt=true; }
      return;
    }
    if(row.type!=='portal_prompt')return;
    try{
      const p=JSON.parse(row.payload);
      if(p.message===prompt)ownPrompts++;else otherPrompt=true;
    }catch{otherPrompt=true;}
  };
  chat.on(key,onEvent);
  try{
    const text=await chat.ask(id,prompt,{onStopped:()=>{stopped=true;}});
    if(stopped || otherPrompt || ownPrompts!==1 || !text.trim()){
      status('unavailable','The summary was stopped, empty, or the chat had another request; no answer was attributed to this meeting.');
      return;
    }
    // Once created, no later attempt overwrites a saved result.
    if(fs.existsSync(resultPath)) {status('unavailable','A summary file already exists.');return;}
    const temp=resultPath+'.'+requestId+'.tmp';
    try {
      const output=fs.openSync(temp,'wx',0o600);
      try {fs.writeFileSync(output,text.trim()+'\n');fs.fsyncSync(output);} finally {fs.closeSync(output);}
      // link is atomic and refuses to replace a summary that appeared meanwhile.
      fs.linkSync(temp,resultPath);
      syncDir();
    } finally { try{fs.unlinkSync(temp);}catch{/* no temp was created */} }
    status('completed');
  }catch(e){
    // Even if an answer was produced but its file could not be saved, never rerun it automatically.
    try{status('failed',String((e as Error).message || e));}catch{/* disk error: started status is retained */}
  }finally{chat.off(key,onEvent);}
}
