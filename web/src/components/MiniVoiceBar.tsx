import { useEffect, useRef, type MutableRefObject } from 'react';
import { LuMaximize2, LuMic, LuMicOff, LuSquare, LuX } from 'react-icons/lu';
import { VoiceOrb, useOrbStyle, type VoiceLevels } from './VoiceOrb';
import { setVoiceLayout } from '../voice-layout';
import type { VoicePhase } from '../hands-free';
import { t } from '../i18n';
function VoiceWaveforms({levels,muted}:{levels:MutableRefObject<VoiceLevels>;muted:boolean}){
 const canvas=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{
  const node=canvas.current,ctx=node?.getContext('2d');if(!node||!ctx)return;
  const input=Array<number>(38).fill(0),output=Array<number>(38).fill(0);
  const draw=()=>{input.push(muted?0:levels.current.input);output.push(levels.current.output);input.shift();output.shift();ctx.clearRect(0,0,node.width,node.height);
   for(const [row,values,color] of [[7,input,'#79d7ff'],[21,output,'#c6a8ff']] as const){ctx.strokeStyle=color;ctx.lineWidth=2;for(let i=0;i<values.length;i++){const h=Math.max(1,Math.min(1,values[i]||0)*6);ctx.beginPath();ctx.moveTo(i*4,row-h);ctx.lineTo(i*4,row+h);ctx.stroke();}}
  };draw();const timer=window.setInterval(draw,100);return()=>window.clearInterval(timer);
 },[levels,muted]);
 return <div className="mini-voice-waves" aria-label="Microphone and assistant audio levels"><span>STT<br/>TTS</span><canvas ref={canvas} width="152" height="28" aria-hidden="true"/></div>;
}
export function MiniVoiceBar({acousticStatus,sessionId,levels,muted,speaking,starting,phase,caption,error,onMute,onEnd,onStop,running}:{acousticStatus?:string;sessionId:string;levels:MutableRefObject<VoiceLevels>;muted:boolean;speaking:boolean;starting:boolean;phase:VoicePhase;caption:string;error:string;onMute:()=>void;onEnd:()=>void;onStop:()=>void;running:boolean}){
 const look=useOrbStyle(sessionId);
 const status=starting?t('Connecting'):speaking?t('Speaking · Listening'):muted?t('Microphone muted'):t(phase);
 return <section className="mini-voice-bar" aria-label={t('Voice conversation')}>
  <div className="mini-voice-avatar voice-avatar"><VoiceOrb mode={muted?'muted':speaking?'output':phase==='Hearing you'?'input':'idle'} levels={levels} look={look}/></div>
  <div className="mini-voice-copy"><div className="mini-voice-brand">YULIFY <span>VOICE</span></div><div role="status">{status}</div><VoiceWaveforms levels={levels} muted={muted}/>{acousticStatus&&<small className="text-muted" title="Experimental clarity/reverberation cue; no distance gate is applied.">{acousticStatus}</small>}<p className={error?'text-danger':''}>{error||caption||t('Speak or type a message below. Replies are spoken aloud.')}</p></div>
  <div className="mini-voice-controls">
   <button type="button" aria-label={t('Expand voice view')} title={t('Expand voice view')} onClick={()=>setVoiceLayout('full')}><LuMaximize2/></button>
   <button type="button" disabled={starting} aria-label={muted?t('Unmute microphone'):t('Mute microphone')} title={muted?t('Unmute microphone'):t('Mute microphone')} aria-pressed={muted} onClick={onMute}>{muted?<LuMicOff/>:<LuMic/>}</button>
   <button type="button" disabled={!running&&!speaking} aria-label={t('Stop reply')} title={t('Stop reply')} onClick={onStop}><LuSquare/></button>
   <button type="button" className="mini-voice-end" aria-label={t('End voice mode')} title={t('End voice mode')} onClick={onEnd}><LuX/></button>
  </div>
 </section>;
}
