import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import meetings from '../server.js';

test('task, non-task and orphan archives in a permitted folder are readable without modifying them', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yulify-meetings-'));
  const dir=path.join(root,'.meeting-notes'); fs.mkdirSync(dir);
  const save=(id,chat)=>{
    fs.writeFileSync(path.join(dir,id+'.state.json'),JSON.stringify({chat,startedAt:'2026-10-29T03:00:00Z',recording:false}));
    fs.writeFileSync(path.join(dir,id+'.txt'),'transcript fixture');
    fs.mkdirSync(path.join(dir,id+'-audio'));
    fs.writeFileSync(path.join(dir,id+'-audio/index.json'),JSON.stringify({parts:[{index:0,file:'part-0001.wav',transcript:'part-0001.txt',summary:'part-0001.summary.md'}]}));
    fs.writeFileSync(path.join(dir,id+'-audio/part-0001.txt'),'part transcript');
    fs.writeFileSync(path.join(dir,id+'-audio/part-0001.summary.md'),'summary fixture');
  };
  save('meeting-task','c1'); save('meeting-agent','c2'); save('meeting-orphan','deleted');
  const before=fs.readFileSync(path.join(dir,'meeting-orphan.state.json'),'utf8');
  const chatRows=[{id:'c1',title:'Task'}, {id:'c2',title:'Agent'}];
  const chats={list:()=>[chatRows[0]],get:id=>chatRows.find(c=>c.id===id),folder:()=>root,inFolder:()=>chatRows};
  const files={list:(b,r)=>({entries:fs.readdirSync(path.join(b,r),{withFileTypes:true}).map(x=>({name:x.name,type:x.isDirectory()?'dir':'file'})),truncated:false}),read:(b,r)=>({binary:false,content:fs.readFileSync(path.join(b,r),'utf8')})};
  const folder={path:root,name:'Home',kind:'agent'}; const router=express.Router();
  meetings({router,http:{json:express.json,send(){}},chats,files,folders:{list:()=>[folder],allowed:p=>p===root},dataDir:()=>path.join(root,'extension-data')});
  const app=express(); app.use(router); const server=app.listen(0);
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    let listing=await (await fetch(origin+'/meetings')).json();
    assert.equal(listing.meetings.length,3); assert.equal(listing.meetings.find(x=>x.id==='meeting-agent').chatTitle,'Agent');
    const orphan=listing.meetings.find(x=>x.id==='meeting-orphan'); assert.equal(orphan.orphaned,true);
    const base=`${origin}/meetings/${orphan.chatId}/${orphan.id}`;
    let res=await fetch(base,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Review'})}); assert.equal(res.status,200);
    const detail=await (await fetch(base)).json(); assert.equal(detail.name,'Review'); assert.equal(detail.transcript,'transcript fixture');
    assert.equal(await (await fetch(base+'/parts/0/summary')).text(),'summary fixture');
    assert.equal(fs.readFileSync(path.join(dir,'meeting-orphan.state.json'),'utf8'),before);
    assert.equal((await fetch(origin+'/meetings/invalid/meeting-task')).status,404);
  } finally { await new Promise(resolve=>server.close(resolve)); fs.rmSync(root,{recursive:true,force:true}); }
});
