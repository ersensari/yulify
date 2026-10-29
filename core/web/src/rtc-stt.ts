/**
 * Streaming recognition over WebRTC: the microphone goes to the portal as an
 * Opus track while the person speaks, and the data channel carries the VAD's
 * start/end markers one way and interim and final transcripts the other.
 * Nothing here decides anything about speech: the portal does the recognizing.
 */
/** Who spoke, where the portal identifies voices (VOICE_SPEAKER_ID): `matched` is the service's own verdict, `reliable` says the clip was long enough. */
export type RtcSpeaker = { name: string | null; score: number | null; matched: boolean; reliable: boolean; clip?: string };
export type RtcResult = { text: string; language?: string; speaker?: RtcSpeaker };
type Message =
  | { t: "ready" }
  | { t: "interim"; id: string; text: string; language?: string }
  | { t: "final"; id: string; text: string; language?: string; speaker?: RtcSpeaker }
  | { t: "error"; id: string; error: string };

export interface RtcSttHooks {
  /** An interim transcript of the utterance `id` so far. */
  interim?: (id: string, text: string, language?: string) => void;
  /** The connection came up (`true`) or went away (`false`). */
  state?: (up: boolean) => void;
}

export class RtcStt {
  private pc: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private up = false;
  private results = new Map<string, RtcResult | Error>();
  private waiting = new Map<string, () => void>();

  /** `signal` trades the offer for the portal's answer. */
  constructor(private readonly signal: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>, private readonly hooks: RtcSttHooks = {}) {}

  /** Whether markers sent now reach the portal. */
  get ready() { return this.up; }

  async connect(mic: MediaStream, timeoutMs = 10000): Promise<void> {
    const pc = this.pc = new RTCPeerConnection();
    const track = mic.getAudioTracks()[0];
    if (!track) throw new Error("No microphone track");
    pc.addTransceiver(track, { direction: "sendonly", streams: [mic] });
    const channel = this.channel = pc.createDataChannel("stt");
    channel.onmessage = event => this.message(String(event.data));
    channel.onclose = () => this.down();
    pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.down(); };
    await pc.setLocalDescription(await pc.createOffer());
    // The portal answers with every candidate in it, so the offer should hold its own: no trickle either way.
    if (pc.iceGatheringState !== "complete") await new Promise<void>(resolve => {
      const done = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", done); resolve(); } };
      pc.addEventListener("icegatheringstatechange", done); setTimeout(resolve, 3000);
    });
    const answer = await this.signal(pc.localDescription!);
    await pc.setRemoteDescription(answer);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Live recognition did not connect")), timeoutMs);
      const check = () => { if (this.up) { clearTimeout(timer); resolve(); } else if (pc.connectionState === "failed" || pc.connectionState === "closed") { clearTimeout(timer); reject(new Error("Live recognition failed to connect")); } else setTimeout(check, 50); };
      check();
    }).catch(e => { this.close(); throw e; });
  }

  start(id: string) { this.mark({ t: "start", id }); }
  end(id: string) { this.mark({ t: "end", id }); }
  cancel(id = "") { this.mark({ t: "cancel", id }); this.results.delete(id); }

  /** The final transcript of an utterance that was ended; rejects when the portal could not make one. */
  final(id: string, signal?: AbortSignal, timeoutMs = 15000): Promise<RtcResult> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        const result = this.results.get(id);
        if (!result) return false;
        this.results.delete(id); this.waiting.delete(id); clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (result instanceof Error) reject(result); else resolve(result);
        return true;
      };
      const abort = () => { this.waiting.delete(id); clearTimeout(timer); reject(signal!.reason ?? new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { this.waiting.delete(id); signal?.removeEventListener("abort", abort); reject(new Error("Live recognition timed out")); }, timeoutMs);
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (!settle()) this.waiting.set(id, settle as () => void);
    });
  }

  close() {
    this.down();
    try { this.channel?.close(); } catch { /* already closed */ }
    try { this.pc?.close(); } catch { /* already closed */ }
    this.channel = this.pc = undefined;
  }

  private mark(m: { t: "start" | "end" | "cancel"; id: string }) {
    if (this.up && this.channel?.readyState === "open") this.channel.send(JSON.stringify(m));
  }

  private down() {
    const was = this.up; this.up = false;
    // Whoever waits on a final that can no longer come is told, and falls back to the plain upload.
    for (const [id, settle] of [...this.waiting]) { this.results.set(id, new Error("Live recognition disconnected")); settle(); }
    if (was) this.hooks.state?.(false);
  }

  private message(raw: string) {
    let m: Message;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "ready") { this.up = true; this.hooks.state?.(true); }
    else if (m.t === "interim") this.hooks.interim?.(m.id, m.text, m.language);
    else if (m.t === "final") this.finish(m.id, { text: m.text, language: m.language, ...(m.speaker ? { speaker: m.speaker } : {}) });
    else if (m.t === "error") this.finish(m.id, new Error(m.error));
  }

  private finish(id: string, result: RtcResult | Error) {
    this.results.set(id, result);
    this.waiting.get(id)?.();
    // A final nobody asked for (the utterance was dropped) must not pile up.
    if (this.results.size > 16) this.results.delete(this.results.keys().next().value!);
  }
}
