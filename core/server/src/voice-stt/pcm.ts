/**
 * 48 kHz mono s16le -> 16 kHz: what Opus decodes to and what Whisper takes.
 * A windowed-sinc low-pass (cut-off 7 kHz at 48 kHz) then every third sample;
 * the filter keeps its history between calls, so chunk borders leave no seam.
 */
const TAPS = 49;
const KERNEL = (() => {
  const k = new Float64Array(TAPS), fc = 7000 / 48000, mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    k[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)));
    sum += k[i];
  }
  for (let i = 0; i < TAPS; i++) k[i] /= sum;
  return k;
})();

export class Downsampler48to16 {
  private history = new Float64Array(TAPS - 1);
  private phase = 0;
  push(input: Int16Array): Int16Array {
    const n = input.length, buf = new Float64Array(TAPS - 1 + n);
    buf.set(this.history); for (let i = 0; i < n; i++) buf[TAPS - 1 + i] = input[i];
    const out: number[] = [];
    let i = this.phase;
    for (; i < n; i += 3) {
      let acc = 0;
      for (let t = 0; t < TAPS; t++) acc += buf[i + t] * KERNEL[TAPS - 1 - t];
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
    }
    this.phase = i - n;
    this.history = buf.slice(n);
    return Int16Array.from(out);
  }
}

/** A mono 16-bit WAV of `pcm` at `rate`. */
export function wav16(pcm: Int16Array, rate = 16000): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
