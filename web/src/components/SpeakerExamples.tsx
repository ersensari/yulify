import { useEffect, useState } from "react";
import { api, type SpeakerExample } from "../api";
import { btnCls, inputCls } from "./SettingsUi";

export function SpeakerExamples() {
  const [examples,setExamples]=useState<SpeakerExample[]>([]),[error,setError]=useState("");
  const [next,setNext]=useState<number|null>(null);
  const [busy,setBusy]=useState(false),[names,setNames]=useState<Record<string,string>>({});
  const load=async(offset=0)=>{
    setError("");
    try{const value=await api.speakerExamples(offset);setExamples(previous=>offset?[...previous,...value.examples]:value.examples);setNext(value.next_offset??null);}
    catch(e){setError((e as Error).message);}
  };
  useEffect(()=>{void load();},[]);
  const action=async(fn:()=>Promise<unknown>)=>{
    setBusy(true);setError("");
    try{await fn();await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-3" aria-label="Speaker examples">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">Speaker examples</h3><button type="button" className={btnCls} disabled={busy} onClick={()=>void load()}>Refresh</button></div>
    <p className="text-xs text-fg-muted">Clean examples from meetings and voice chat expire after 7 days. Listen, then assign a person to keep an example until you delete it. Speaker numbers are local to each recording. Saving a name enrolls a numeric voiceprint. Voiceprints also provide display names in voice chat and meetings when at least 2 seconds of clear speech closely matches. Uncertain or overlapping voices keep anonymous labels. Names do not verify identity or grant access.</p>
    {error&&<p role="alert" className="text-xs text-danger">{error}</p>}
    {!examples.length&&<p className="text-xs text-fg-muted">No retained examples. Speak for at least 2 seconds without another speaker overlapping.</p>}
    <div className="max-h-96 overflow-y-auto space-y-3">{examples.map(sample=><div key={sample.id} className="rounded-lg border border-line p-3 space-y-2">
      <div className="text-xs"><strong>{sample.person||sample.label}</strong> · {sample.seconds.toFixed(1)}s · {new Date(sample.created*1000).toLocaleString()}</div>
      <p className="text-xs text-fg-faint">Recording {sample.session_id.slice(0,8)} · {sample.expires_at?`Expires ${new Date(sample.expires_at*1000).toLocaleDateString()}`:"Kept until deleted"}</p>
      <audio controls preload="none" className="w-full h-8" src={`/api/voice/speaker-examples/${sample.id}/audio`} aria-label={`Listen to ${sample.person||sample.label}`}/>
      <div className="flex gap-2"><input className={inputCls} maxLength={64} aria-label={`Person for example ${sample.id}`} placeholder="Person name" value={names[sample.id]??sample.person??""} onChange={e=>setNames(v=>({...v,[sample.id]:e.target.value}))}/>
        <button type="button" className={btnCls} disabled={busy||!(names[sample.id]??sample.person??"").trim()} onClick={()=>void action(()=>api.assignSpeakerExample(sample.id,(names[sample.id]??sample.person??"").trim()))}>Keep</button>
        <button type="button" className={btnCls} disabled={busy} onClick={()=>void action(()=>api.deleteSpeakerExample(sample.id))}>Delete</button>
      </div>
    </div>)}</div>
    {next!==null&&<button type="button" className={btnCls} disabled={busy} onClick={()=>void load(next)}>Load more examples</button>}
    <p className="text-xs text-fg-faint">Up to 3 examples per speaker per recording, 2–10 seconds each. Storage is capped at 512 MiB. Assigned examples are not removed to make room.</p>
  </section>;
}
