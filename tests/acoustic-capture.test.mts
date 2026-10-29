import test from 'node:test';
import assert from 'node:assert/strict';
import {openAcousticTap} from '../web/src/acoustic-capture.js';
function fake(settings:MediaTrackSettings,intermediate=false){
 let stopped=0;let constraints:any;
 const track={getSettings:()=>settings,stop:()=>{stopped++;}};
 const stream={getAudioTracks:()=>[track],getTracks:()=>[track]} as unknown as MediaStream;
 const media={enumerateDevices:async()=>intermediate?[{kind:'audioinput',label:'Yulify AEC intermediate',deviceId:'raw-aec'} as MediaDeviceInfo]:[],getUserMedia:async(c:any)=>{constraints=c;return stream;}};
 return {media,stream,stopped:()=>stopped,constraints:()=>constraints};
}
test('Linux uses the existing AEC intermediate before RNNoise without another browser pass',async()=>{
 const f=fake({echoCancellation:false,noiseSuppression:false,autoGainControl:false},true);
 const r=await openAcousticTap(f.media,'main');assert.equal(r.source,'pipewire-aec-before-rnnoise');
 assert.deepEqual(f.constraints().audio.deviceId,{exact:'raw-aec'});assert.equal(f.constraints().audio.echoCancellation,false);assert.equal(f.stopped(),0);
});
test('browser path requires AEC with noise suppression and AGC disabled',async()=>{
 const f=fake({echoCancellation:true,noiseSuppression:false,autoGainControl:false});
 const r=await openAcousticTap(f.media,'mac-mic');assert.equal(r.source,'browser-aec-without-ns');assert.equal(f.constraints().audio.echoCancellation,true);assert.deepEqual(f.constraints().audio.deviceId,{exact:'mac-mic'});
});
test('unsupported or still-processed tracks are stopped, never passed off as raw analysis',async()=>{
 for(const flags of [{},{echoCancellation:false,noiseSuppression:false,autoGainControl:false},{echoCancellation:true,noiseSuppression:true,autoGainControl:false},{echoCancellation:true,noiseSuppression:false,autoGainControl:true}]){
  const f=fake(flags);await assert.rejects(openAcousticTap(f.media));assert.equal(f.stopped(),1);
 }
});
test('optional tap capture failure propagates for the caller to keep voice without analysis',async()=>{
 const f=fake({});f.media.getUserMedia=async()=>{throw new Error('device unavailable');};await assert.rejects(openAcousticTap(f.media),/device unavailable/);
});
