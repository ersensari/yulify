import { openAcousticTap } from "./acoustic-capture";
import { holdDesktopCapture } from "./desktop";
import { LocalAudioTrack, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";

export type DuplexRoomState = "connecting" | "connected" | "reconnecting" | "closed" | "error";
export type DuplexRoomEvent = Record<string, unknown> & { type?: string };
export type DuplexRoomHooks = {
  state?: (state: DuplexRoomState, message?: string) => void;
  event?: (event: DuplexRoomEvent) => void;
};

type RoomGrant = { url: string; room: string; token: string };

/** LiveKit transport for Yula voice LiveKit voice. Audio AEC/NS are browser WebRTC features. */
export class MiniCpmDuplexRoom {
  private room?: Room;
  private textReady=false;
  private textPending=new Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private rejectWorkerReady?: (error: Error) => void;
  private grant?: RoomGrant;
  private audioElements = new Set<HTMLMediaElement>();
  private disposed = false;
  private stopMeter?: () => void;
  private meterContext?: AudioContext;
  private outputMeters = new Map<RemoteTrack, () => void>();
  private microphoneEnabled = true;
  private outputGain = 1;
  private recovery?: Promise<void>;
  private microphone?: LocalAudioTrack;
  private microphoneStream?: MediaStream;
  private acousticTrack?: LocalAudioTrack;
  private acousticStream?: MediaStream;

  constructor(private readonly sessionId: string, private readonly hooks: DuplexRoomHooks = {}) {}

  async connect(): Promise<void> {
    try { await holdDesktopCapture("voice:"+this.sessionId,true); await this.connectToRoom(); }
    catch(error) { await this.close(); throw error; }
  }

  private async connectToRoom(): Promise<void> {
    this.disposed = false;
    this.outputGain = 1;
    this.meterContext = new AudioContext();
    void this.meterContext.resume().catch(() => undefined);
    this.hooks.state?.("connecting");
    const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/qwen3/room`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Could not start Yula voice (${response.status})`);
    this.grant = body as RoomGrant;
    const room = this.room = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      element.volume = this.outputGain;
      element.setAttribute("playsinline", "true");
      this.audioElements.add(element);
      this.startOutputMeter(track);
      void element.play().catch(() => this.hooks.state?.("error", "Allow audio playback in the browser, then reconnect."));
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => this.detach(track));
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const workerReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.rejectWorkerReady = rejectReady;
    void workerReady.catch(() => undefined);
    const readyDeadline = setTimeout(() => rejectReady(new Error("Yula voice did not become ready. Stop voice and reconnect.")), 45_000);
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as DuplexRoomEvent;
        if (event.type === "voice.output.gain" && typeof event.gain === "number" && Number.isFinite(event.gain)) {
          this.outputGain = Math.max(0, Math.min(1, event.gain));
          for (const element of this.audioElements) element.volume = this.outputGain;
        }
        if (event.type === "session.status" && event.status === "connected") resolveReady();
        if (event.type === "session.error") rejectReady(new Error(String(event.message || "Yula voice could not start.")));
        if(event.type==='user.text.ack' && typeof event.request_id==='string'){
          const pending=this.textPending.get(event.request_id);
          if(pending){clearTimeout(pending.timer);this.textPending.delete(event.request_id);if(event.accepted===true)pending.resolve();else pending.reject(new Error(String(event.message||'Voice text was rejected.')));}
        }
        this.hooks.event?.(event);
      } catch { /* ignore malformed status packets */ }
    });
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (!this.disposed) {
        this.hooks.state?.("error", "The voice service disconnected. Start voice mode again to reconnect.");
        this.hooks.event?.({ type: "session.status", status: "closed" });
      }
    });
    room.on(RoomEvent.Reconnecting, () => this.hooks.state?.("reconnecting"));
    room.on(RoomEvent.Reconnected, () => this.hooks.state?.("connected"));
    room.on(RoomEvent.Disconnected, reason => {
      if (!this.disposed) {
        this.hooks.state?.("error", `LiveKit disconnected${reason ? ` (${reason})` : ""}.`);
        this.hooks.event?.({ type: "session.status", status: "closed" });
      }
    });
    try {
      await room.connect(this.grant.url, this.grant.token, { autoSubscribe: true });
      await this.replaceMicrophone();
      await workerReady;
      this.textReady=true;
      this.hooks.state?.("connected");
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      clearTimeout(readyDeadline);
      if (this.rejectWorkerReady === rejectReady) this.rejectWorkerReady = undefined;
    }
  }

  async sendText(text:string):Promise<void>{
    if(!this.room||!this.textReady||this.disposed)throw new Error('Voice is still connecting. Please try again when it is ready.');
    if(!text.trim()||text.length>8000||new TextEncoder().encode(text).byteLength>16000)throw new Error('Voice text must contain 1–8000 characters.');
    if(this.textPending.size>=6)throw new Error('Too many pending voice messages. Please wait.');
    const request_id=crypto.randomUUID();
    const room=this.room;
    return new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.textPending.delete(request_id);reject(new Error('Voice did not confirm your message. Check the chat before retrying.'));},10000);
      this.textPending.set(request_id,{resolve,reject,timer});
      void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({type:'text',request_id,text})),{reliable:true,topic:'yulify.voice-control'}).catch(error=>{const pending=this.textPending.get(request_id);if(pending){clearTimeout(timer);this.textPending.delete(request_id);reject(error);}});
    });
  }

  async interrupt(): Promise<void> {
    if (!this.room) return;
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "interrupt" })), { reliable: true, topic: "yulify.voice-control" });
  }

  async setMusicPlaying(playing: boolean): Promise<void> {
    await this.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "music", playing })), { reliable: true, topic: "yulify.voice-control" });
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!this.room) throw new Error("Yula voice is not connected");
    this.microphoneEnabled = enabled;
    const track = this.microphone;
    if (!track) return; // Recovery applies the most recent policy before publishing.
    if (enabled) {
      if (track.mediaStreamTrack.readyState !== "live") throw new Error("The microphone stream is closed. Reconnect the microphone.");
      await track.unmute();
    } else await track.mute();
    if(this.acousticTrack) {
      try { if(enabled)await this.acousticTrack.unmute();else {await this.acousticTrack.mute();this.hooks.event?.({type:'voice.acoustics',status:'paused'});} }
      catch {await this.stopAcoustics();this.hooks.event?.({type:'voice.acoustics',status:'unavailable'});}
    }
  }

  /** Replace a stopped capture/publication, without restarting the model or room. */
  async reconnectMicrophone(): Promise<void> {
    void this.meterContext?.resume().catch(() => undefined);
    if (this.recovery) return this.recovery;
    const work = this.replaceMicrophone();
    this.recovery = work;
    try { await work; } finally { if (this.recovery === work) this.recovery = undefined; }
  }

  private async replaceMicrophone(): Promise<void> {
    const room = this.room;
    if (!room || this.disposed) throw new Error("Yula voice is not connected");
    await this.stopAcoustics();
    const old = this.microphone;
    const deviceId = old?.mediaStreamTrack.getSettings().deviceId;
    this.stopMeter?.(); this.stopMeter = undefined;
    this.microphone = undefined;
    if (old) {
      try { await room.localParticipant.unpublishTrack(old, true); }
      finally { old.stop(); }
    }
    this.microphoneStream?.getTracks().forEach(track => track.stop());
    this.microphoneStream = undefined;
    // A local PipeWire source subtracts the actual HDMI speaker reference.
    // Use its cleaned input without a second browser AEC/AGC pass. Remote
    // clients without that source keep the normal browser WebRTC processing.
    const findAec = async () => (await navigator.mediaDevices.enumerateDevices()).find(device =>
      device.kind === "audioinput" && device.label.includes("Yulify Echo Cancelled Microphone"));
    const capture = (aec?: MediaDeviceInfo) => navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: !aec, noiseSuppression: !aec, autoGainControl: !aec,
      ...(aec ? { deviceId: { exact: aec.deviceId } } : deviceId && deviceId !== "default" ? { deviceId: { ideal: deviceId } } : {}),
    } });
    let aec = await findAec();
    // Remember this browser's chosen acoustic path. Losing its virtual source
    // must not silently switch a speaker-mode session to an uncleaned input.
    const aecPreference = "yulify.voice.nativeAec";
    let nativeExpected = false;
    try { nativeExpected = localStorage.getItem(aecPreference) === "1"; } catch { /* storage may be disabled */ }
    if (!aec && nativeExpected) throw new Error("The echo-cancelled Yulify microphone is unavailable. Reconnect the microphone once the audio service is ready.");
    let stream = await capture(aec);
    // Before first permission the browser hides device labels. Resolve again
    // once authorized and replace that initial raw capture if AEC is available.
    if (!aec) {
      try {
        aec = await findAec();
        if (aec) {
          const cleaned = await capture(aec);
          stream.getTracks().forEach(track => track.stop());
          stream = cleaned;
        }
      } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
    }
    if (aec) { try { localStorage.setItem(aecPreference, "1"); } catch { /* storage may be disabled */ } }
    const raw = stream.getAudioTracks()[0];
    if (!raw) { stream.getTracks().forEach(track => track.stop()); throw new Error("Could not create a microphone audio stream."); }
    const fresh = new LocalAudioTrack(raw, raw.getConstraints(), true);
    try {
      if (this.disposed || this.room !== room) throw new Error("Voice closed during microphone recovery");
      if (!this.microphoneEnabled) await fresh.mute();
      await room.localParticipant.publishTrack(fresh, { source: Track.Source.Microphone, stopMicTrackOnMute: false });
      if (raw.readyState !== "live") throw new Error("The microphone closed while being opened");
      this.microphone = fresh; this.microphoneStream = stream;
      // Policy may change while publication is being negotiated.
      await this.setMicrophoneEnabled(this.microphoneEnabled);
      await this.monitorMicrophone();
      await this.startAcoustics();
    } catch (error) {
      fresh.stop(); stream.getTracks().forEach(track => track.stop());
      if (this.microphone === fresh) { this.microphone = undefined; this.microphoneStream = undefined; }
      throw error;
    }
  }

  private async stopAcoustics(): Promise<void> {
    const track=this.acousticTrack;this.acousticTrack=undefined;
    track?.stop();
    this.acousticStream?.getTracks().forEach(track=>track.stop());this.acousticStream=undefined;
    if(track){try{await this.room?.localParticipant.unpublishTrack(track,true);}catch{/* room closing */}}
  }

  private async startAcoustics(): Promise<void> {
    const room=this.room;
    if(!room||this.disposed)return;
    let stream:MediaStream|undefined;let track:LocalAudioTrack|undefined;
    try {
      const opened=await openAcousticTap(navigator.mediaDevices,this.microphone?.mediaStreamTrack.getSettings().deviceId);
      stream=opened.stream;
      const raw=stream.getAudioTracks()[0];
      if(this.disposed||this.room!==room){stream.getTracks().forEach(t=>t.stop());return;}
      track=new LocalAudioTrack(raw,raw.getConstraints(),true);
      if(!this.microphoneEnabled)await track.mute();
      await room.localParticipant.publishTrack(track,{source:Track.Source.Microphone,name:opened.source==='pipewire-aec-before-rnnoise'?'yulify-acoustics-pipewire-pre-ns':'yulify-acoustics-browser-pre-ns',stopMicTrackOnMute:false,dtx:false,audioPreset:{maxBitrate:64000}});
      if(this.disposed||this.room!==room){await room.localParticipant.unpublishTrack(track,true);stream.getTracks().forEach(t=>t.stop());return;}
      this.acousticTrack=track;this.acousticStream=stream;
      const source=opened.source;
      this.hooks.event?.({type:'voice.acoustics',status:this.microphoneEnabled?'warming_up':'paused',source});
    } catch {
      if(track){try{await room.localParticipant.unpublishTrack(track,true);}catch{/* optional tap */}track.stop();}
      stream?.getTracks().forEach(t=>t.stop());
      this.acousticTrack=undefined;this.acousticStream=undefined;
      this.hooks.event?.({type:'voice.acoustics',status:'unavailable'});
    }
  }

  private async monitorMicrophone(): Promise<void> {
    this.stopMeter?.(); this.stopMeter = undefined;
    const room = this.room;
    const microphone = this.microphone?.mediaStreamTrack;
    if (!room || !microphone) return;
    const context = this.meterContext ??= new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([microphone]));
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let sentAt = 0;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const applied = microphone.getSettings();
      const processing = microphone.label.includes("Yulify Echo Cancelled Microphone") ? "pipewire-reference-aec" : "browser-webrtc";
      const event = { type: "microphone.capture", processing, echoCancellation: applied.echoCancellation, noiseSuppression: applied.noiseSuppression, autoGainControl: applied.autoGainControl, label: microphone.label, level: Math.min(1, rms * 7), rms, enabled: microphone.enabled, muted: microphone.muted, readyState: microphone.readyState, audioContext: context.state };
      this.hooks.event?.(event);
      if (microphone.readyState === "ended") this.hooks.event?.({ type: "microphone.error", message: "The microphone stream ended. Use Reconnect microphone to restore it." });
      if (Date.now() - sentAt >= 5000) {
        sentAt = Date.now();
        void room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(event)), { reliable: true, topic: "yulify.microphone" }).catch(() => undefined);
      }
    }, 200);
    this.stopMeter = () => { window.clearInterval(timer); source.disconnect(); analyser.disconnect(); };
    this.hooks.event?.({ type: "microphone.device", label: microphone.label, enabled: microphone.enabled });
    void context.resume().catch(() => undefined);
  }

  /** Camera is opt-in. Calling this explicitly creates the camera track. */
  async setCamera(enabled: boolean): Promise<void> {
    if (!this.room) throw new Error("Yula voice is not connected");
    if (enabled) throw new Error("Yula voice supports audio input only.");
  }

  async close(): Promise<void> {
    this.disposed = true;
    // Detach the room first. Unpublishing the optional acoustic tap can wait
    // indefinitely during a disconnect; it must never keep the main mic live.
    const room = this.room;
    const grant = this.grant;
    this.room = undefined;
    this.grant = undefined;
    this.textReady=false;
    for(const pending of this.textPending.values()){clearTimeout(pending.timer);pending.reject(new Error("Voice connection closed before confirming your message."));}
    this.textPending.clear();
    this.rejectWorkerReady?.(new Error("Voice connection closed."));
    this.rejectWorkerReady = undefined;
    this.microphone?.stop(); this.microphone = undefined;
    this.microphoneStream?.getTracks().forEach(track => track.stop()); this.microphoneStream = undefined;
    await this.stopAcoustics();
    this.stopMeter?.(); this.stopMeter = undefined;
    for (const stop of this.outputMeters.values()) stop();
    this.outputMeters.clear();
    this.hooks.event?.({type:'voice.output.level',level:0});
    void this.meterContext?.close(); this.meterContext = undefined;
    for (const element of this.audioElements) {
      try { element.pause(); element.srcObject = null; } catch { /* already detached */ }
    }
    this.audioElements.clear();
    try { await room?.disconnect(); } finally {
      if (grant) {
        await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/qwen3/room`, { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: grant.room }) }).catch(() => undefined);
      }
      await holdDesktopCapture("voice:"+this.sessionId,false);
      this.hooks.state?.("closed");
    }
  }

  private detach(track: RemoteTrack) {
    this.outputMeters.get(track)?.();
    this.outputMeters.delete(track);
    this.hooks.event?.({type:'voice.output.level',level:0});
    for (const element of track.detach()) {
      this.audioElements.delete(element);
      try { element.pause(); element.srcObject = null; } catch { /* already detached */ }
    }
  }

  private startOutputMeter(track: RemoteTrack) {
    const context=this.meterContext;
    if(!context || !track.mediaStreamTrack)return;
    try {
      const source=context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const analyser=context.createAnalyser();analyser.fftSize=256;source.connect(analyser);
      const samples=new Float32Array(analyser.fftSize);
      const timer=window.setInterval(()=>{
        analyser.getFloatTimeDomainData(samples);
        const rms=Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
        this.hooks.event?.({type:'voice.output.level',level:Math.min(1,rms*5*this.outputGain)});
      },100);
      this.outputMeters.set(track,()=>{window.clearInterval(timer);source.disconnect();analyser.disconnect();});
    } catch { this.hooks.event?.({type:'voice.output.level',level:0}); }
  }
}
