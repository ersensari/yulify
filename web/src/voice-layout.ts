import { useSyncExternalStore } from 'react';
import { local } from './safe-storage';
export type VoiceLayout = 'full' | 'mini';
const KEY='yulify.voiceLayout', EVENT='yulify:voice-layout';
export const getVoiceLayout=():VoiceLayout=>local.get(KEY)==='mini'?'mini':'full';
export function setVoiceLayout(value:VoiceLayout){local.set(KEY,value);window.dispatchEvent(new Event(EVENT));}
function subscribe(update:()=>void){window.addEventListener(EVENT,update);window.addEventListener('storage',update);return()=>{window.removeEventListener(EVENT,update);window.removeEventListener('storage',update);};}
export const useVoiceLayout=()=>useSyncExternalStore(subscribe,getVoiceLayout,()=> 'full' as VoiceLayout);
