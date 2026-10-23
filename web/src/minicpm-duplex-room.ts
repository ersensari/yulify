import { LocalAudioTrack, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";

export type DuplexRoomState = "connecting" | "connected" | "reconnecting" | "closed" | "error";
export type DuplexRoomEvent = Record<string, unknown> & { type?: string };
export type DuplexRoomHooks = {
  state?: (state: DuplexRoomState, message?: string) => void;
  event?: (event: DuplexRoomEvent) => void;
};

type RoomGrant = { url: string; room: string; token: string };

/** LiveKit transport for Gemma E4B LiveKit voice. Audio AEC/NS are browser WebRTC features. */
export class MiniCpmDuplexRoom {
  private room?: Room;
  private grant?: RoomGrant;
  private audioElements = new Set<HTMLMediaElement>();
  private disposed = false;
  private stopMeter?: () => void;
  private meterContext?: AudioContext;
  private microphoneEnabled = true;
  private recovery?: Promise<void>;
  private microphone?: LocalAudioTrack;
  private microphoneStream?: MediaStream;

  constructor(private readonly sessionId: string, private readonly hooks: DuplexRoomHooks = {}) {}

  async connect(): Promise<void> {
    this.disposed = false;
    this.meterContext = new AudioContext();
    void this.meterContext.resume().catch(() => undefined);
    this.hooks.state?.("connecting");
    const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/gemma4/room`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Could not start Gemma E4B voice (${response.status})`);
    this.grant = body as RoomGrant;
    const room = this.room = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: true });
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      element.setAttribute("playsinline", "true");
      this.audioElements.add(element);
      void element.play().catch(() => this.hooks.state?.("error", "Allow audio playback in the browser, then reconnect."));
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => this.detach(track));
    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      try { this.hooks.event?.(JSON.parse(new TextDecoder().decode(payload)) as DuplexRoomEvent); } catch { /* ignore malformed status packets */ }
    });
    room.on(RoomEvent.ParticipantDisconnected, () => {
      if (!this.disposed) {
        this.hooks.state?.("error", "Ses servisi bağlantısı kapandı. Konuşmayı yeniden açabilirsin.");
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
      this.hooks.state?.("connected");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.room) return;
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: "interrupt" })), { reliable: true, topic: "yulify.voice-control" });
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!this.room) throw new Error("Gemma E4B voice is not connected");
    this.microphoneEnabled = enabled;
    const track = this.microphone;
    if (!track) return; // Recovery applies the most recent policy before publishing.
    if (enabled) {
      if (track.mediaStreamTrack.readyState !== "live") throw new Error("Mikrofon akışı kapalı. Mikrofonu yeniden bağla.");
      await track.unmute();
    } else await track.mute();
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
    if (!room || this.disposed) throw new Error("Gemma E4B voice is not connected");
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
    // Match the established sequential voice input exactly. The application owns
    // capture; LiveKit transports a user-provided track without capture defaults.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(deviceId && deviceId !== "default" ? { deviceId: { ideal: deviceId } } : {}),
    } });
    const raw = stream.getAudioTracks()[0];
    if (!raw) { stream.getTracks().forEach(track => track.stop()); throw new Error("Mikrofon ses akışı oluşturulamadı."); }
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
    } catch (error) {
      fresh.stop(); stream.getTracks().forEach(track => track.stop());
      if (this.microphone === fresh) { this.microphone = undefined; this.microphoneStream = undefined; }
      throw error;
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
      const event = { type: "microphone.capture", label: microphone.label, level: Math.min(1, rms * 7), rms, enabled: microphone.enabled, muted: microphone.muted, readyState: microphone.readyState, audioContext: context.state };
      this.hooks.event?.(event);
      if (microphone.readyState === "ended") this.hooks.event?.({ type: "microphone.error", message: "Mikrofon akışı kapandı. Mikrofonu yeniden bağla düğmesini kullan." });
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
    if (!this.room) throw new Error("Gemma E4B voice is not connected");
    if (enabled) throw new Error("Gemma E4B yalnızca ses girdisini destekliyor.");
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.microphone?.stop(); this.microphone = undefined;
    this.microphoneStream?.getTracks().forEach(track => track.stop()); this.microphoneStream = undefined;
    this.stopMeter?.(); this.stopMeter = undefined;
    void this.meterContext?.close(); this.meterContext = undefined;
    const room = this.room;
    const grant = this.grant;
    this.room = undefined;
    this.grant = undefined;
    try { await room?.disconnect(); } finally {
      for (const element of this.audioElements) {
        try { element.pause(); element.srcObject = null; } catch { /* already detached */ }
      }
      this.audioElements.clear();
      if (grant) {
        await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/gemma4/room`, { method: "DELETE", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: grant.room }) }).catch(() => undefined);
      }
      this.hooks.state?.("closed");
    }
  }

  private detach(track: RemoteTrack) {
    for (const element of track.detach()) {
      this.audioElements.delete(element);
      try { element.pause(); element.srcObject = null; } catch { /* already detached */ }
    }
  }
}
