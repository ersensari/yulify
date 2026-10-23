import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";

export type DuplexRoomState = "connecting" | "connected" | "reconnecting" | "closed" | "error";
export type DuplexRoomEvent = Record<string, unknown> & { type?: string };
export type DuplexRoomHooks = {
  state?: (state: DuplexRoomState, message?: string) => void;
  event?: (event: DuplexRoomEvent) => void;
};

type RoomGrant = { url: string; room: string; token: string };

/** LiveKit transport for native MiniCPM duplex. Audio AEC/NS are browser WebRTC features. */
export class MiniCpmDuplexRoom {
  private room?: Room;
  private grant?: RoomGrant;
  private audioElements = new Set<HTMLMediaElement>();
  private disposed = false;
  private stopMeter?: () => void;
  private meterContext?: AudioContext;

  constructor(private readonly sessionId: string, private readonly hooks: DuplexRoomHooks = {}) {}

  async connect(): Promise<void> {
    this.disposed = false;
    this.meterContext = new AudioContext();
    void this.meterContext.resume().catch(() => undefined);
    this.hooks.state?.("connecting");
    const response = await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/minicpm/room`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Could not start MiniCPM voice (${response.status})`);
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
    room.on(RoomEvent.Reconnecting, () => this.hooks.state?.("reconnecting"));
    room.on(RoomEvent.Reconnected, () => this.hooks.state?.("connected"));
    room.on(RoomEvent.Disconnected, reason => {
      if (!this.disposed) this.hooks.state?.("error", `LiveKit disconnected${reason ? ` (${reason})` : ""}.`);
    });
    try {
      await room.connect(this.grant.url, this.grant.token, { autoSubscribe: true });
      await room.localParticipant.setMicrophoneEnabled(true, {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await this.monitorMicrophone();
      this.hooks.state?.("connected");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!this.room) throw new Error("MiniCPM voice is not connected");
    await this.room.localParticipant.setMicrophoneEnabled(enabled, { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  }

  /** Reacquire the existing input without restarting the model or room. */
  async reconnectMicrophone(): Promise<void> {
    void this.meterContext?.resume().catch(() => undefined);
    const room = this.room;
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!room || !track) throw new Error("Microphone track is unavailable");
    const settings = track.mediaStreamTrack.getSettings();
    const devices = await Room.getLocalDevices("audioinput", false);
    const hardware = devices.find(device => device.deviceId !== "default" && device.deviceId !== "communications" && device.groupId === settings.groupId);
    await track.restartTrack({ deviceId: hardware?.deviceId || settings.deviceId, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    await this.monitorMicrophone();
  }

  private async monitorMicrophone(): Promise<void> {
    this.stopMeter?.(); this.stopMeter = undefined;
    const room = this.room;
    const microphone = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
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
    if (!this.room) throw new Error("MiniCPM voice is not connected");
    await this.room.localParticipant.setCameraEnabled(enabled);
  }

  async close(): Promise<void> {
    this.disposed = true;
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
        await fetch(`/api/sessions/${encodeURIComponent(this.sessionId)}/voice/minicpm/room`, { method: "DELETE", keepalive: true }).catch(() => undefined);
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
