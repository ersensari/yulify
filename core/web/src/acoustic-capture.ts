/** Analysis-only AEC tap. Never silently analyze a noise-suppressed stream. */
export async function openAcousticTap(media: Pick<MediaDevices,'enumerateDevices'|'getUserMedia'>, deviceId?:string):Promise<{stream:MediaStream;source:string}> {
  const devices=await media.enumerateDevices();
  const intermediate=devices.find(d=>d.kind==='audioinput'&&d.label.includes('Yulify AEC intermediate'));
  const id=intermediate?.deviceId||deviceId;
  const stream=await media.getUserMedia({audio:{channelCount:1,echoCancellation:!intermediate,noiseSuppression:false,autoGainControl:false,...(id?{deviceId:{exact:id}}:{})}});
  const track=stream.getAudioTracks()[0];const applied=track?.getSettings();
  if(!track||(!intermediate&&(applied?.echoCancellation!==true||applied.noiseSuppression!==false||applied.autoGainControl!==false))){
    stream.getTracks().forEach(t=>t.stop());
    throw new Error('A pre-noise-suppression AEC tap is unavailable');
  }
  return {stream,source:intermediate?'pipewire-aec-before-rnnoise':'browser-aec-without-ns'};
}
