/**
 * Ogg/Opus speech, decoded as it arrives (2026-10-19).
 *
 * 48 kHz s16le speech is 768 kbit/s; the same stream as Opus is ~80 kbit/s and
 * keeps the full band. The browser asks for it (`Accept: audio/ogg`) only where
 * WebCodecs can decode Opus, and turns the stream back into 48 kHz s16le bytes
 * here, so everything after it (pcm-stream.ts: the cushion, time-stretch,
 * repeat) is the same code that plays raw PCM. Where AudioDecoder is missing
 * the portal keeps sending PCM.
 */

/** Opus always decodes at 48 kHz. */
export const OPUS_RATE = 48000;

let support: Promise<boolean> | undefined;
/** Whether this browser can decode an Opus stream with WebCodecs. Asked once. */
export function opusSupported(): Promise<boolean> {
  support ??= (async () => {
    if (typeof AudioDecoder === "undefined") return false;
    try {
      const { supported } = await AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1 });
      return supported === true;
    } catch { return false; }
  })();
  return support;
}

/**
 * Splits an Ogg byte stream into its packets. A page is "OggS", a header of
 * 27 bytes, a segment table and the segments; a packet ends at the first
 * segment shorter than 255 bytes and may run on into the next page.
 */
export class OggPackets {
  private buf = new Uint8Array(0);
  private partial: Uint8Array[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf); joined.set(chunk, this.buf.length);
    this.buf = joined;
    const packets: Uint8Array[] = [];
    while (this.buf.length >= 27) {
      if (this.buf[0] !== 0x4f || this.buf[1] !== 0x67 || this.buf[2] !== 0x67 || this.buf[3] !== 0x53)
        throw new Error("Not an Ogg stream");
      const segments = this.buf[26];
      if (this.buf.length < 27 + segments) break;
      const table = this.buf.subarray(27, 27 + segments);
      const size = table.reduce((n, s) => n + s, 0);
      const end = 27 + segments + size;
      if (this.buf.length < end) break;
      let at = 27 + segments;
      for (const s of table) {
        this.partial.push(this.buf.slice(at, at + s)); at += s;
        if (s < 255) {
          const length = this.partial.reduce((n, p) => n + p.length, 0), packet = new Uint8Array(length);
          let o = 0; for (const p of this.partial) { packet.set(p, o); o += p.length; }
          packets.push(packet); this.partial = [];
        }
      }
      this.buf = this.buf.slice(end);
    }
    return packets;
  }
}

const isHead = (p: Uint8Array) => p.length >= 19 && String.fromCharCode(...p.subarray(0, 8)) === "OpusHead";
const isTags = (p: Uint8Array) => p.length >= 8 && String.fromCharCode(...p.subarray(0, 8)) === "OpusTags";

/** Float samples to 16-bit little-endian bytes, what the PCM player reads. */
function s16le(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2), view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return out;
}

/**
 * An Ogg/Opus response body as a 48 kHz mono s16le byte stream. The encoder's
 * pre-skip is not cut here: the decoder applies it from the OpusHead given as
 * `description` (checked in Chromium against ffmpeg: cutting it again lost
 * the first 6.5 ms).
 */
export function oggOpusToPcm(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  let decoder: AudioDecoder | undefined;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    // A push source: the network is read as fast as it delivers and decoded
    // samples are queued as they come out (a few seconds of speech is small).
    start(out) {
      const ogg = new OggPackets();
      let timestamp = 0, failure: unknown;
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (failure) throw failure;
            if (done) break;
            for (const packet of ogg.push(value)) {
              if (!decoder) {
                if (!isHead(packet)) throw new Error("The speech stream is not Opus");
                decoder = new AudioDecoder({
                  output: (data) => {
                    const samples = new Float32Array(data.numberOfFrames);
                    data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
                    data.close();
                    if (samples.length) try { out.enqueue(s16le(samples)); } catch { /* the player cancelled */ }
                  },
                  error: (e) => { failure = e; },
                });
                decoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: packet[9] || 1, description: packet });
                continue;
              }
              if (isTags(packet)) continue;
              decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data: packet }));
              timestamp += 20000;   // µs; it only has to grow, the decoder reads each frame's real length from the packet
            }
          }
          if (decoder) { await decoder.flush(); decoder.close(); }
          if (failure) throw failure;
          out.close();
        } catch (e) {
          try { decoder?.close(); } catch { /* already closed */ }
          out.error(e);
        }
      })();
    },
    cancel(reason) { void reader.cancel(reason).catch(() => {}); try { decoder?.close(); } catch { /* already closed */ } },
  });
}
