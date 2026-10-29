// The composer joins the existing live voice room; it never starts a second Pi turn.
const senders=new Map<string,(text:string)=>Promise<void>>();
export function registerVoiceText(sessionId:string,send:(text:string)=>Promise<void>){senders.set(sessionId,send);return()=>{if(senders.get(sessionId)===send)senders.delete(sessionId);};}
export function sendVoiceText(sessionId:string,text:string){const send=senders.get(sessionId);if(!send)return Promise.reject(new Error('Voice is still connecting. Please try again when it is ready.'));return send(text);}
if(typeof window!=='undefined')window.yulifyDesktop?.onTextRequest?.(async ({id,sessionId,text})=>{
 try{await sendVoiceText(sessionId,text);window.yulifyDesktop?.textResponse(id);}
 catch(error){window.yulifyDesktop?.textResponse(id,error instanceof Error?error.message:String(error));}
});
