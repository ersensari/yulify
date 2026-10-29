/** Optional native shell API. The browser keeps its normal behavior without it. */
export type DesktopAction = 'start-voice'|'toggle-voice'|'end-voice'|'mute-voice'|'interrupt-voice'|'open-settings';
declare global {interface Window {yulifyDesktop?: {
 onAction(callback:(action:DesktopAction)=>void):()=>void;
 onTextRequest(callback:(request:{id:string;sessionId:string;text:string})=>void):()=>void;
 textResponse(id:string,error?:string):void;
 state(value:{active:boolean;activity:string;caption?:string;muted?:boolean;input?:number}):void;
 holdCapture(key:string,on:boolean):Promise<boolean>;
}}}
export function holdDesktopCapture(key:string,on:boolean):Promise<unknown>{return window.yulifyDesktop?.holdCapture(key,on)??Promise.resolve();}
export function desktopState(value:{active:boolean;activity:string;caption?:string;muted?:boolean;input?:number}):void{window.yulifyDesktop?.state(value);}
export function onDesktopAction(callback:(action:DesktopAction)=>void):()=>void{return window.yulifyDesktop?.onAction(callback)??(()=>{});}
