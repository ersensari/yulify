import { useEffect, useMemo, useState } from "react";
import { api, type SpeakerExample } from "../api";
import { btnCls, inputCls } from "./SettingsUi";

export function SpeakerExamples() {
  const [examples,setExamples]=useState<SpeakerExample[]>([]),[error,setError]=useState("");
  const [next,setNext]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[names,setNames]=useState<Record<string,string>>({});
  const [selected,setSelected]=useState<Record<string,boolean>>({}),[bulkName,setBulkName]=useState("");
  const [result,setResult]=useState("");
  const [suggestions,setSuggestions]=useState<Record<string,{person:string;score:number}>>({});
  const [suggestionsRequested,setSuggestionsRequested]=useState(false),[suggestionNext,setSuggestionNext]=useState<number|null>(null);
  const load=async(offset=0)=>{
    const value=await api.speakerExamples(offset);
    setExamples(previous=>offset?[...previous,...value.examples]:value.examples);
    setNext(value.next_offset??null);
  };
  const refresh=async(offset=0)=>{
    setError("");
    try{await load(offset);}catch(e){setError((e as Error).message);}
  };
  useEffect(()=>{void refresh();},[]);
  const action=async(fn:()=>Promise<unknown>,id:string,deleted=false)=>{
    setBusy(true);setError("");setResult("");
    try{
      await fn();
      if(deleted){setExamples(previous=>previous.filter(sample=>sample.id!==id));setSelected(previous=>{const copy={...previous};delete copy[id];return copy;});}
      else setExamples(previous=>previous.map(sample=>sample.id===id?{...sample,person:(names[id]??sample.person??"").trim(),expires_at:null}:sample));
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const groups=useMemo(()=>{
    const sessions=new Map<string,SpeakerExample[]>();
    for(const sample of examples){const group=sessions.get(sample.session_id)??[];group.push(sample);sessions.set(sample.session_id,group);}
    return [...sessions.entries()];
  },[examples]);
  const people=useMemo(()=>[...new Set(examples.map(sample=>sample.person).filter((person):person is string=>!!person))].sort(),[examples]);
  const selectedSamples=examples.filter(sample=>selected[sample.id]);
  const loadSuggestions=async(offset=0)=>{
    setBusy(true);setError("");
    try{
      const value=await api.speakerExampleSuggestions(offset);
      setSuggestions(previous=>{
        const updated=offset?{...previous}:{};
        for(const suggestion of value.suggestions)updated[suggestion.id]={person:suggestion.person,score:suggestion.score};
        return updated;
      });
      setSuggestionNext(value.next_offset??null);setSuggestionsRequested(true);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const keepSelected=async()=>{
    const person=bulkName.trim();
    if(!person||!selectedSamples.length)return;
    setBusy(true);setError("");setResult("");
    const succeeded:string[]=[];
    const failures:string[]=[];
    try{
      for(const sample of selectedSamples){
        try{await api.assignSpeakerExample(sample.id,person);succeeded.push(sample.id);}
        catch(e){failures.push(`${sample.label} (${sample.id.slice(0,8)}): ${(e as Error).message}`);}
      }
      const done=new Set(succeeded);
      setExamples(previous=>previous.map(sample=>done.has(sample.id)?{...sample,person,expires_at:null}:sample));
      setNames(previous=>{const updated={...previous};for(const id of succeeded)delete updated[id];return updated;});
      setSelected(previous=>{const updated={...previous};for(const id of succeeded)delete updated[id];return updated;});
      setResult(`${succeeded.length} example${succeeded.length===1?"":"s"} kept as ${person}.${failures.length?` ${failures.length} failed; they remain selected.`:""}`);
      if(failures.length)setError(failures.join("; "));
    }finally{setBusy(false);}
  };
  return <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-3" aria-label="Speaker examples">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Speaker examples</h3><button type="button" className={btnCls} disabled={busy} onClick={()=>void refresh()}>Refresh</button></div>
    <p className="text-xs text-fg-muted">Clean examples from meetings and voice chat expire after 7 days. Listen, then assign a person to keep an example until you delete it. Speaker numbers are local to each recording and do not identify the same person across recordings. Saving a name enrolls a numeric voiceprint. Voiceprints provide display names when at least 2 seconds of clear speech closely matches. Uncertain or overlapping voices keep anonymous labels. Names do not verify identity or grant access.</p>
    {error&&<p role="alert" className="text-xs text-danger">{error}</p>}
    {result&&<p role="status" className="text-xs text-fg-muted">{result}</p>}
    {!!examples.length&&<div className="space-y-1">
      <button type="button" className={btnCls} disabled={busy} onClick={()=>void loadSuggestions()}>Find name suggestions</button>
      {suggestionsRequested&&<p className="text-xs text-fg-muted">Suggestions are similarity scores, not identity verification. Listen and confirm a name with Keep. Load more examples to see suggestions for later recordings.</p>}
      {suggestionsRequested&&suggestionNext!==null&&<button type="button" className={btnCls} disabled={busy} onClick={()=>void loadSuggestions(suggestionNext)}>Load more suggestions</button>}
    </div>}
    {!examples.length&&<p className="text-xs text-fg-muted">No retained examples. Speak for at least 2 seconds without another speaker overlapping.</p>}
    {!!examples.length&&<div className="rounded-lg border border-line p-3 space-y-2">
      <p className="text-xs text-fg-muted">Select the examples you have listened to, then keep them under one name. Nothing is assigned automatically.</p>
      <div className="flex flex-wrap gap-2"><input className={inputCls} list="speaker-example-people" maxLength={64} aria-label="Person for selected examples" placeholder="Person name" value={bulkName} onChange={e=>setBulkName(e.target.value)}/>
        <datalist id="speaker-example-people">{people.map(person=><option key={person} value={person}/>)}</datalist>
        <button type="button" className={btnCls} disabled={busy||!bulkName.trim()||!selectedSamples.length} onClick={()=>void keepSelected()}>Keep selected ({selectedSamples.length})</button>
      </div>
    </div>}
    <div className="max-h-96 overflow-y-auto space-y-4">{groups.map(([session,samples])=><section key={session} className="space-y-2" aria-label={`Recording ${session}`}>
      <h4 className="text-xs font-medium">Recording {session.slice(0,8)} · {new Date(samples[0].created*1000).toLocaleString()}</h4>
      {samples.map(sample=><div key={sample.id} className="rounded-lg border border-line p-3 space-y-2">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={busy} checked={!!selected[sample.id]} onChange={e=>setSelected(previous=>({...previous,[sample.id]:e.target.checked}))}/><strong>{sample.person||sample.label}</strong> · {sample.seconds.toFixed(1)}s · {new Date(sample.created*1000).toLocaleString()}</label>
        <p className="text-xs text-fg-faint">{sample.person?`${sample.label} · `:""}{sample.expires_at?`Expires ${new Date(sample.expires_at*1000).toLocaleDateString()}`:"Kept until deleted"}</p>
        <audio controls preload="none" className="w-full h-8" src={`/api/voice/speaker-examples/${sample.id}/audio`} aria-label={`Listen to ${sample.person||sample.label}`}/>
        {!sample.person&&suggestions[sample.id]&&<p className="text-xs text-fg-muted">Suggested: {suggestions[sample.id].person} · similarity {suggestions[sample.id].score.toFixed(2)} <button type="button" className={btnCls} disabled={busy} onClick={()=>setNames(previous=>({...previous,[sample.id]:suggestions[sample.id].person}))}>Use suggested name</button></p>}
        <div className="flex gap-2"><input className={inputCls} list="speaker-example-people" maxLength={64} aria-label={`Person for example ${sample.id}`} placeholder="Person name" value={names[sample.id]??sample.person??""} onChange={e=>setNames(v=>({...v,[sample.id]:e.target.value}))}/>
          <button type="button" className={btnCls} disabled={busy||!(names[sample.id]??sample.person??"").trim()} onClick={()=>void action(()=>api.assignSpeakerExample(sample.id,(names[sample.id]??sample.person??"").trim()),sample.id)}>Keep</button>
          <button type="button" className={btnCls} disabled={busy} onClick={()=>void action(()=>api.deleteSpeakerExample(sample.id),sample.id,true)}>Delete</button>
        </div>
      </div>)}
    </section>)}</div>
    {next!==null&&<button type="button" className={btnCls} disabled={busy} onClick={()=>void refresh(next)}>Load more examples</button>}
    <p className="text-xs text-fg-faint">Up to 3 examples per speaker per recording, 2–10 seconds each. Storage is capped at 512 MiB. Assigned examples are not removed to make room.</p>
  </section>;
}
