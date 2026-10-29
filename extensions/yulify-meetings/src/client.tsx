import { useEffect, useState } from 'react';
import type { Portal } from '@pithagoras/extension-api';

type Row = {id:string;chatId:string;chatTitle:string;name:string;startedAt:string;recording:boolean;orphaned?:boolean};
type Part = {index:number;start:number;end:number;hasAudio:boolean;hasTranscript:boolean;hasSummary:boolean;summaryStatus:string};
type Detail = Row & {transcript:string;parts:Part[];fullSummary?:string;fullSummaryStatus?:string};
let portal:Portal;
const at = (r:Row) => `/meetings/${encodeURIComponent(r.chatId)}/${encodeURIComponent(r.id)}`;
const call = <T,>(url:string, init?:RequestInit) => portal.api.json<T>(portal.api.url(url),init);
function Page() {
  const [rows,setRows]=useState<Row[]>([]), [selected,setSelected]=useState<Detail|null>(null), [error,setError]=useState(''), [title,setTitle]=useState(''), [text,setText]=useState('');
  async function list(){ try { const r=await call<{meetings:Row[];warnings:string[]}>('/meetings'); setRows(r.meetings); setError(r.warnings.join('; ')); } catch(e){setError(String(e));} }
  async function open(row:Row){try {const item=await call<Detail>(at(row)); setSelected(item); setTitle(item.name); setText('');} catch(e){setError(String(e));}}
  useEffect(()=>{void list();},[]);
  async function rename(){if(!selected)return;try {await call(at(selected),{method:'PATCH',body:JSON.stringify({name:title})});await list();await open({...selected,name:title});}catch(e){setError(String(e));}}
  async function showPart(p:Part,kind:'transcript'|'summary'){
    if(!selected)return; try { const response=await fetch(portal.api.url(`${at(selected)}/parts/${p.index}/${kind}`),{credentials:'same-origin'}); if(!response.ok)throw new Error(`HTTP ${response.status}`); setText(await response.text()); } catch(e){setError(String(e));}
  }
  return <main style={{padding:24,overflow:'auto',height:'100%'}}><h1>Meetings</h1>{error&&<p role="alert">{error}</p>}<button type="button" onClick={()=>void list()}>Refresh</button><div style={{display:'flex',gap:24,flexWrap:'wrap'}}><section aria-label="Saved meetings" style={{minWidth:240}}>{rows.length===0&&<p>No saved meetings found.</p>}{rows.map(row=><p key={`${row.chatId}/${row.id}`}><button type="button" onClick={()=>void open(row)}>{row.name||new Date(row.startedAt).toLocaleString()} {row.recording?'●':''}</button><br/><small>{row.chatTitle}{row.orphaned?" · chat deleted":""}</small></p>)}</section>{selected&&<section style={{flex:1,minWidth:280}}><label>Meeting name <input value={title} maxLength={160} onChange={e=>setTitle(e.target.value)}/></label> <button type="button" onClick={()=>void rename()}>Save name</button><h2>{selected.name||new Date(selected.startedAt).toLocaleString()}</h2><p>{selected.recording?'Recording':'Saved'}</p><h3>Meeting summary</h3>{selected.fullSummary!==undefined?<pre style={{whiteSpace:'pre-wrap'}}>{selected.fullSummary}</pre>:<p>{selected.fullSummaryStatus==='started'?'Summary is being prepared.':selected.fullSummaryStatus==='failed'||selected.fullSummaryStatus==='unavailable'?'A verified summary is unavailable.':'No saved meeting summary.'}</p>}<h3>Transcript</h3><pre style={{whiteSpace:'pre-wrap'}}>{selected.transcript||'No transcript yet.'}</pre><h3>Recording parts</h3>{selected.parts.map(p=><div key={p.index}><p>Part {p.index+1} · {Math.round(p.start)}–{Math.round(p.end)} s</p>{p.hasAudio&&<audio controls preload="none" src={portal.api.url(`${at(selected)}/parts/${p.index}/audio`)}/>}<p>{p.hasTranscript&&<button type="button" onClick={()=>void showPart(p,'transcript')}>Part transcript</button>} {p.hasSummary&&<button type="button" onClick={()=>void showPart(p,'summary')}>Part summary</button>} {!p.hasSummary&&p.summaryStatus}</p></div>)}{text&&<pre style={{whiteSpace:'pre-wrap'}}>{text}</pre>}</section>}</div></main>;
}
export default function meetings(given:Portal){portal=given;portal.slots.register('nav.page',{id:'meetings',title:'Meetings',component:Page});}
