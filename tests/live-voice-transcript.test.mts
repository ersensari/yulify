import {test} from "node:test";
import assert from "node:assert/strict";
import {reduceLiveTranscript as reduce} from "../web/src/live-voice-transcript.ts";
const raw = {type:"voice.transcript",stream_id:"s",utterance_id:"u",revision:1,start_sample:32000,text:"Merhba",raw_text:"Merhba",accepted:true,speaker:"ersen",phase:"raw",final:false};
test("partial snapshots replace without appending; corrected revision wins", () => {
 const a=reduce(undefined,raw); assert.equal(a?.text,"Merhba");assert.equal(a?.final,false);
 const b=reduce(a,{...raw,text:"Merhaba",phase:"corrected"});assert.equal(b?.text,"Merhaba");assert.equal(b?.raw,"Merhba");
 assert.equal(reduce(b,raw),b);
 const c=reduce(b,{...raw,revision:2,text:"Merhba Ersen"});assert.equal(c?.text,"Merhba Ersen");
 assert.equal(reduce(c,{...raw,phase:"corrected",final:true}),c);
});
test("unverified or stale utterances cannot replace owner text",()=>{
 const a=reduce(undefined,raw);
 assert.equal(reduce(a,{...raw,accepted:false,text:"other"}),a);
 assert.equal(reduce(a,{...raw,speaker:"stranger"}),a);
 assert.equal(reduce(a,{...raw,utterance_id:"old",start_sample:0,final:true}),a);
 assert.equal(reduce(a,{...raw,revision:-1}),a);
});
test("reset clears only its utterance, connection reset clears all",()=>{
 const a=reduce(undefined,raw);
 assert.equal(reduce(a,{type:"voice.transcript.reset",stream_id:"other",utterance_id:"u"}),a);
 assert.equal(reduce(a,{type:"voice.transcript.reset",stream_id:"s",utterance_id:"u"}),undefined);
 assert.equal(reduce(a,{type:"voice.transcript.reset",stream_id:"new"}),undefined);
});

test("anonymous labels do not authenticate a speaker",()=>{
 const event={...raw,speaker:null,identity_verified:false,verification_enabled:false,speaker_label:"Speaker 2"};
 assert.equal(reduce(undefined,event)?.speakerLabel,"Speaker 2");
 assert.equal(reduce(undefined,{...event,speaker:"Speaker 2"}),undefined);
 assert.equal(reduce(undefined,{...event,identity_verified:true}),undefined);
});
