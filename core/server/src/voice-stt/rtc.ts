import { RTCPeerConnection, useOPUS, type MediaStreamTrack, type RTCDataChannel } from "werift";
import OpusScript from "opusscript";
import { Downsampler48to16 } from "./pcm.js";
import { SttSession, type SttMessage, type SttOptions, type Transcribe } from "./session.js";

export interface RtcSttOptions extends SttOptions {
  transcribe: Transcribe;
  /** UDP ports the media may use, `[min, max]`; open them where a firewall is in the way. */
  portRange?: [number, number];
  /** Addresses to offer besides the interfaces' own (a public or Tailscale address behind NAT). */
  extraAddresses?: string[];
  /** Gives up on a peer that never connects. */
  connectTimeoutMs?: number;
  /** Called once the peer is gone, however it went. */
  onClose?: () => void;
}

export interface RtcStt {
  /** The SDP answer to send back. It already holds every ICE candidate: there is no trickle. */
  answer: string;
  close(): void;
  readonly session: SttSession;
}

const OPUS_RATE = 48000;
/** Packets this far apart are a restart of the stream, not a loss to fill in. */
const MAX_GAP = 25;

/**
 * Answers a browser's WebRTC offer for speech recognition. The browser sends
 * its microphone as an Opus audio track and opens a data channel (any label):
 * `{t:"start",id}` / `{t:"end",id}` / `{t:"cancel"}` frame the utterances its
 * VAD finds, and the interim and final transcripts come back on the same
 * channel as JSON.
 *
 * WebRTC gives what a plain upload lacks: Opus survives a poor link, the
 * jitter buffer and congestion control are the browser's own, and audio keeps
 * flowing while the person is still speaking, so the server hears an
 * utterance as it happens instead of after it.
 */
export async function answerOffer(offerSdp: string, options: RtcSttOptions): Promise<RtcStt> {
  const pc = new RTCPeerConnection({
    codecs: { audio: [useOPUS()] },
    iceUseIpv6: false,
    ...(options.portRange ? { icePortRange: options.portRange } : {}),
    ...(options.extraAddresses?.length ? { iceAdditionalHostAddresses: options.extraAddresses } : {}),
  });
  let channel: RTCDataChannel | undefined, closed = false;
  const outbox: string[] = [];
  const send = (m: SttMessage | { t: "ready" }) => {
    const text = JSON.stringify(m);
    if (channel?.readyState === "open") channel.send(text); else outbox.push(text);
  };
  const session = new SttSession(options.transcribe, send, options);
  const close = () => {
    if (closed) return; closed = true;
    clearTimeout(timer); session.close();
    void pc.close().catch(() => {}); options.onClose?.();
  };
  const timer = setTimeout(() => { if (pc.connectionState !== "connected") close(); }, options.connectTimeoutMs ?? 15000);

  pc.onDataChannel.subscribe(ch => {
    channel = ch;
    const open = () => { for (const m of outbox.splice(0)) ch.send(m); ch.send(JSON.stringify({ t: "ready" })); };
    if (ch.readyState === "open") open(); else { const sub = ch.stateChanged.subscribe(st => { if (st === "open") { sub.unSubscribe(); open(); } }); }
    ch.onMessage.subscribe(data => {
      let msg: any;
      try { msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString()); } catch { return; }
      if (typeof msg?.t !== "string") return;
      const id = typeof msg.id === "string" ? msg.id.slice(0, 64) : "";
      if (msg.t === "start") session.start(id);
      else if (msg.t === "end") void session.end(id);
      else if (msg.t === "cancel") session.cancel();
    });
  });
  pc.onTrack.subscribe(track => { if (track.kind === "audio") receive(track, session); });
  pc.connectionStateChange.subscribe(state => { if (state === "failed" || state === "closed" || state === "disconnected") close(); });

  try {
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>(resolve => {
        const sub = pc.iceGatheringStateChange.subscribe(s => { if (s === "complete") { sub.unSubscribe(); resolve(); } });
        setTimeout(resolve, 4000);
      });
    }
  } catch (e) { close(); throw e; }
  return { answer: pc.localDescription!.sdp, close, session };
}

/** RTP in, 16 kHz PCM out: puts the packets in order, fills a loss with silence, decodes, and resamples. */
function receive(track: MediaStreamTrack, session: SttSession) {
  const decoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
  const down = new Downsampler48to16();
  let last: number | undefined;
  track.onReceiveRtp.subscribe(rtp => {
    const seq = rtp.header.sequenceNumber;
    if (last !== undefined) {
      const gap = (seq - last) & 0xffff;
      if (gap === 0 || gap > 0x8000) return; // a duplicate or one that came too late
      if (gap > 1 && gap <= MAX_GAP) session.push(down.push(new Int16Array((gap - 1) * 960)));
    }
    last = seq;
    if (!rtp.payload.length) return;
    try {
      const pcm = decoder.decode(rtp.payload);
      const samples = new Int16Array(pcm.length >> 1);
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
      session.push(down.push(samples));
    } catch { /* a packet that does not decode is a loss */ }
  });
}
