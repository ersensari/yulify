import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {inProcessHome} from './server-harness.mjs';
const home=inProcessHome('yulify-meeting-');
const {createSession,getDb}=await import('../dist/db.js');
const {sessions}=await import('../dist/session-manager.js');
const {meetingNotesRouter}=await import('../dist/api/meeting-notes.js');
const {meetingWav,MeetingAudio}=await import('../dist/meeting-audio.js');
const workspace=path.join(home,'work');fs.mkdirSync(workspace,{recursive:true});
for(const id of ['meeting','legacy','parts','outage'])createSession({id,title:id,workspace,executor:'host',auto_title:0});
let summaryCount=0,partSummaries=0,down=false;const inputs=[],sources=new Map();
sessions.prompt=async()=>{summaryCount++;};
const upstream=http.createServer(async(req,res)=>{
  const buffers=[];for await(const b of req)buffers.push(b);
  res.setHeader('Content-Type','application/json');
  if(down){res.statusCode=503;return res.end(JSON.stringify({error:'ASR unavailable'}));}
  if(req.url==='/v1/asr/sessions'){
    const id=String(sources.size),snapshot={id,status:'recording',samples:0,sample_rate:16000,next_sequence:0,turns:[]};sources.set(id,snapshot);return res.end(JSON.stringify(snapshot));
  }
  const id=req.url.split('/')[4],snapshot=sources.get(id);if(!snapshot){res.statusCode=404;return res.end('{}');}
  if(req.url.endsWith('/audio')){
    const bytes=Buffer.concat(buffers),seconds=(bytes.length-44)/32000;
    assert.ok(seconds<=2);inputs.push({id,seq:Number(req.headers['x-audio-sequence']),seconds});
    const start=snapshot.samples/16000;snapshot.samples+=seconds*16000;snapshot.next_sequence++;
    snapshot.turns.push({id:snapshot.turns.length,speaker:'Speaker 1',start,end:snapshot.samples/16000,text:'Merhaba',start_sample:start*16000,end_sample:snapshot.samples,overlap:false});
  }
  if(req.url.endsWith('/stop'))snapshot.status='completed';
  res.end(JSON.stringify(snapshot));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));process.env.ASR_CONTROL_URL=`http://127.0.0.1:${upstream.address().port}`;
const app=express();app.use(express.json());app.use('/api',meetingNotesRouter({summarize:async()=>{partSummaries++;return 'Meeting notes';}}));
const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/sessions`;
after(()=>{server.close();upstream.close();getDb().close();});
const post=(id,route,body)=>fetch(`${base}/${id}/meeting${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
const audio=(id,seconds,sequence)=>fetch(`${base}/${id}/meeting/chunk`,{method:'POST',headers:{'Content-Type':'audio/wav',...(sequence===undefined?{}:{'X-Audio-Sequence':String(sequence)})},body:meetingWav(Buffer.alloc(32000*seconds))});
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out');}

test('cached 15-second clients are accepted, saved before decoding and recover without Start',async()=>{
  const response=await audio('legacy',15);assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.audio_saved,true);assert.equal(value.recorded_seconds,15);assert.match(value.recovery_notice,/earlier upload/i);
  const root=path.join(workspace,value.transcriptPath.replace(/\.txt$/,'-audio'));
  assert.equal(fs.statSync(path.join(root,'packet-000000.wav')).size,480044);
  const stopped=await (await post('legacy','/stop',{summarize:false})).json();assert.equal(stopped.audio_saved,true);assert.equal(stopped.parts.length,1);
  assert.ok(inputs.every(x=>x.seconds<=2));
});
test('sequence retries do not duplicate durable audio; Stop summarizes once',async()=>{
  const value=await (await post('meeting','/start')).json();assert.equal(value.recording,true);
  assert.equal((await audio('meeting',15,0)).status,200);
  const repeat=await (await audio('meeting',15,0)).json();assert.equal(repeat.recorded_seconds,15);
  assert.equal((await audio('meeting',15,2)).status,400);
  const before=summaryCount;
  assert.equal((await post('meeting','/stop')).status,200);assert.equal((await post('meeting','/stop')).status,200);assert.equal(summaryCount,before+1);
  assert.match(fs.readFileSync(path.join(workspace,value.transcriptPath),'utf8'),/Speaker 1: Merhaba/);
});
test('three-minute WAV parts, transcripts and isolated summaries are produced while recording',async()=>{
  const value=await (await post('parts','/start')).json();const before=partSummaries;
  for(let seq=0;seq<3;seq++)assert.equal((await audio('parts',60,seq)).status,200);
  const root=path.join(workspace,value.transcriptPath.replace(/\.txt$/,'-audio'));
  assert.equal(fs.statSync(path.join(root,'part-0001.wav')).size,5760044);
  await until(()=>fs.existsSync(path.join(root,'part-0001.summary.md')));
  assert.equal(partSummaries,before+1);assert.match(fs.readFileSync(path.join(root,'part-0001.txt'),'utf8'),/Merhaba/);
  const current=await (await fetch(`${base}/parts/meeting`)).json();assert.equal(current.recording,true);assert.equal(current.recorded_seconds,180);
  await post('parts','/stop',{summarize:false});
});
test('ASR failure does not stop durable capture; archives reopen after a restart',async()=>{
  const value=await (await post('outage','/start')).json();down=true;
  const response=await audio('outage',15,0);assert.equal(response.status,200);
  assert.equal((await response.json()).audio_saved,true);
  await until(async()=>!!(await (await fetch(`${base}/outage/meeting`)).json()).error);
  const state=await (await fetch(`${base}/outage/meeting`)).json();assert.equal(state.recording,true);
  const root=path.join(workspace,value.transcriptPath.replace(/\.txt$/,'-audio'));
  const archive=new MeetingAudio(root);assert.equal(archive.samples,15*16000);assert.equal(archive.packets.length,1);
  assert.equal((await audio('outage',15,1)).status,200);down=false;
  assert.equal((await post('outage','/stop',{summarize:false})).status,200);
});
