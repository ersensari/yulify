import { holdDesktopCapture } from "../desktop";
import { useCallback, useEffect, useRef, useState } from "react";
import { LuNotebookPen, LuLoaderCircle } from "react-icons/lu";
import { api, type MeetingSnapshot } from "../api";
import { joinSamples } from "../samples";

const time = (seconds:number) => `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(Math.floor(seconds)%60).padStart(2,"0")}`;

/** Continuous PCM with an ordered sample clock; segmentation belongs to ASR. */
export function MeetingNotes({ sessionId, record }: { sessionId: string; record?: string }) {
  const [recording,setRecording]=useState(false),[busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [snapshot,setSnapshot]=useState<MeetingSnapshot>(),[file,setFile]=useState("");
  const [ownedElsewhere,setOwnedElsewhere]=useState(false);
  const mounted=useRef(false), starting=useRef(false);
  const context=useRef<AudioContext|null>(null),stream=useRef<MediaStream|null>(null);
  const processor=useRef<ScriptProcessorNode|null>(null),buffer=useRef<Float32Array[]>([]);
  const buffered=useRef(0),sequence=useRef(0),pending=useRef(0);
  const uploads=useRef<Promise<void>>(Promise.resolve()),failure=useRef<Error|null>(null);
  const stopped=useRef(true),created=useRef(false),stopping=useRef<Promise<void>|null>(null);
  const stopRef=useRef<(summarize?:boolean)=>Promise<void>>(async()=>{});

  const enqueue=useCallback((samples:Float32Array)=>{
    if (!samples.length)return;
    if (pending.current>=8) {
      failure.current=new Error("Meeting upload is overloaded. Recording stopped; the saved transcript may be incomplete.");
      setError(failure.current.message);void stopRef.current(false);return;
    }
    const seq=sequence.current++;pending.current++;
    uploads.current=uploads.current.then(async()=>{
      if (failure.current)return;
      let last:Error|undefined;
      for(let attempt=0;attempt<3;attempt++) {
        try {setSnapshot(await api.sendMeetingChunk(sessionId,samples,seq));return;}
        catch(e) {last=e as Error;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
      }
      failure.current=last||new Error("Could not upload meeting audio");
      setError(failure.current.message);void stopRef.current(false);
    }).finally(()=>{pending.current--;});
  },[sessionId]);

  const stop=useCallback((summarize=true):Promise<void>=>{
    if(stopping.current)return stopping.current;
    if(stopped.current && !created.current)return Promise.resolve();
    stopped.current=true;
    processor.current?.disconnect();processor.current=null;
    stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;
    const closing=context.current?.close().catch(()=>{});context.current=null;
    const tail=joinSamples(buffer.current);buffer.current=[];buffered.current=0;
    if(tail.length && !failure.current)enqueue(tail);
    setRecording(false);setBusy(true);
    const work=(async()=>{
      try {
        await closing;await uploads.current;
        if(created.current) {
          const result=await api.stopMeeting(sessionId,summarize&&!failure.current,!!failure.current);
          setSnapshot(result);setFile(result.transcriptPath);created.current=false;
          if(result.error)setError(`Audio saved. Transcription is pending: ${result.error}`);
        }
      }catch(e){setError((e as Error).message);}
      finally{await holdDesktopCapture("meeting:"+sessionId,false);setBusy(false);stopping.current=null;}
    })();
    stopping.current=work;return work;
  },[sessionId,enqueue]);
  stopRef.current=stop;

  const start=useCallback(async()=>{
    if(starting.current)return;
    starting.current=true;
    setError(null);setBusy(true);
    try {
      if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)throw new Error("A microphone needs HTTPS or localhost.");
      await holdDesktopCapture("meeting:"+sessionId,true);
      const mic=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      stream.current=mic;
      if(!mounted.current)throw new Error("Meeting view closed before recording started");
      const audio=new AudioContext({sampleRate:16000});context.current=audio;
      if(audio.sampleRate!==16000)throw new Error("This browser cannot capture meeting audio at 16 kHz.");
      await audio.resume();
      const initial=await api.startMeeting(sessionId);created.current=true;
      if(!mounted.current)throw new Error("Meeting view closed before recording started");
      setSnapshot(initial);setFile(initial.transcriptPath);
      buffer.current=[];buffered.current=0;sequence.current=0;pending.current=0;
      uploads.current=Promise.resolve();failure.current=null;stopped.current=false;
      const source=audio.createMediaStreamSource(mic),node=audio.createScriptProcessor(4096,1,1);
      processor.current=node;
      node.onaudioprocess=event=>{
        if(stopped.current)return;
        const samples=new Float32Array(event.inputBuffer.getChannelData(0));
        buffer.current.push(samples);buffered.current+=samples.length;
        if(buffered.current>=16000) {
          const joined=joinSamples(buffer.current);
          enqueue(joined.slice(0,16000));
          const tail=joined.slice(16000);buffer.current=tail.length?[tail]:[];buffered.current=tail.length;
        }
      };
      const silent=audio.createGain();silent.gain.value=0;
      source.connect(node);node.connect(silent);silent.connect(audio.destination);
      setRecording(true);
    }catch(e){
      setError((e as Error).message);stopped.current=true;
      processor.current?.disconnect();processor.current=null;
      stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;
      await context.current?.close().catch(()=>{});context.current=null;
      if(created.current) {await api.stopMeeting(sessionId,false).catch(()=>{});created.current=false;}
      await holdDesktopCapture("meeting:"+sessionId,false);
    }finally{starting.current=false;if(mounted.current)setBusy(false);}
  },[sessionId,enqueue]);

  useEffect(()=>{
    if(!recording)return;
    let cancelled=false,inFlight=false;
    const timer=setInterval(()=>{
      if(inFlight)return;inFlight=true;
      void api.meetingStatus(sessionId).then(value=>{
        if(cancelled)return;setSnapshot(value);
        if(value.error)setError(`Audio is being saved. Transcription is pending: ${value.error}`);
        if(value.recording===false && !stopped.current) {
          failure.current=new Error(value.error||"The recording stopped unexpectedly");
          setError(failure.current.message);void stopRef.current(false);
        }
      },e=>{if(!cancelled)setError(e.message);}).finally(()=>{inFlight=false;});
    },2000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[recording,sessionId]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void stop();};},[stop]);
  useEffect(()=>{
    let cancelled=false;
    void api.meetingStatus(sessionId,record).then(value=>{
      if(cancelled)return;
      setSnapshot(value);setFile(value.transcriptPath||"");
      setOwnedElsewhere(value.recording===true);
    },e=>{if(!cancelled)setError(e.message);});
    return()=>{cancelled=true;};
  },[sessionId,record]);
  useEffect(()=>{
    const key=`yulify.meeting.start.${sessionId}`;
    let pending=false;
    try { pending=sessionStorage.getItem(key)==="1"; } catch { return; }
    if(record || !snapshot || !pending)return;
    const timer=window.setTimeout(()=>{
      try { if(sessionStorage.getItem(key)!=="1")return;sessionStorage.removeItem(key); } catch { return; }
      if(!snapshot.recording)void start();
    },0);
    return()=>window.clearTimeout(timer);
  },[sessionId,record,snapshot,start]);

  return <section className="rounded-xl border border-line bg-surface p-4" aria-label="Meeting notes">
    <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-medium">{snapshot?.title || "Meeting notes"}</h3><p className="text-xs text-fg-muted">{busy?"Processing":recording?"Recording":snapshot?.status||"Ready"}</p></div>
    {!record && <button type="button" className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:bg-fg/5 disabled:opacity-50" aria-pressed={recording}
      aria-label={recording?"Stop meeting notes":"Start meeting notes"}
      title={recording?"Stop recording and summarize":"Record a meeting with timestamped speaker labels"}
      disabled={busy||ownedElsewhere} onClick={()=>void(recording?stop():start())}>
      {busy?<LuLoaderCircle aria-hidden className="animate-spin"/>:<LuNotebookPen aria-hidden color={recording?"var(--danger, #e5484d)":undefined}/>}
      {recording?"Stop and summarize":"Start recording"}
    </button>}
    </div>
      {ownedElsewhere&&<p className="mt-2 text-xs text-warn">This meeting is already recording in another view. Return there to stop it.</p>}
      <p className="my-2 text-xs text-fg-muted">Audio is saved before transcription and grouped into 3-minute WAV files with transcript and summary notes. Speaker numbers apply to this recording.</p>
      {error&&<p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      {snapshot?.audio_saved&&<p role="status" className="my-2 text-xs text-fg-muted">Audio saved: {time(snapshot.recorded_seconds||0)} · {snapshot.parts?.length||0} part(s)</p>}
      {snapshot?.parts?.map(part=><p key={part.index} className="text-xs text-fg-muted">Part {part.index+1} · {time(part.start)}–{time(part.end)} · {part.summary_status||"Transcribing"}{part.error?` · ${part.error}`:""}</p>)}
      {!recording && !ownedElsewhere && file && snapshot?.parts?.some(part=>part.summary_status==='failed') && <button type="button" disabled={busy} className="mt-2 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" onClick={()=>{setBusy(true);setError(null);void api.summarizeMeetingParts(sessionId,file).then(result=>setSnapshot(old=>old?{...old,parts:old.parts?.map(part=>({...part,...result.parts.find(item=>item.index===part.index)}))}:old),e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>Retry failed part summaries</button>}
      <div className="max-h-72 overflow-y-auto space-y-2" aria-live="polite">
        {snapshot?.turns.map(turn=><p key={turn.id} className="text-xs"><span className="text-fg-muted">[{time(turn.start)}–{time(turn.end)}] {turn.speaker}{turn.overlap?" · overlap":""}: </span>{turn.text}</p>)}
        {!snapshot?.turns.length&&<p className="text-xs text-fg-muted">{recording?"Listening… speech appears after a pause.":"No transcript yet."}</p>}
      </div>
      {snapshot?.summary_status&&<p className="mt-2 text-xs text-fg-muted">Summary: {snapshot.summary_status}{snapshot.summary_error?` · ${snapshot.summary_error}`:""}</p>}
      {!recording && !ownedElsewhere && file && snapshot?.turns?.length && !snapshot.summary_text && <button type="button" disabled={busy} className="mt-2 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50" onClick={()=>{setBusy(true);setError(null);void api.summarizeMeeting(sessionId,file).then(result=>setSnapshot(old=>old?{...old,...result,summary_error:undefined}:old),e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>Create summary</button>}
      {record && snapshot?.summary_text&&<p className="mt-2 whitespace-pre-wrap text-sm">{snapshot.summary_text}</p>}
      {file&&<p className="mt-3 break-all text-xs text-fg-muted">Saved in Files: {file}</p>}
  </section>;
}
