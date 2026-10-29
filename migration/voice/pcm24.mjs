/** Streaming mono s16le 24 kHz pass-through or 48 -> 24 kHz FIR decimator. */
const HALF = 31;
const CUTOFF = 0.22; // 10.56 kHz at 48 kHz; transition before the 12 kHz output Nyquist.
const taps = Float64Array.from({length: 2 * HALF + 1}, (_, i) => {
  const n = i - HALF;
  const sinc = n === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * n) / (Math.PI * n);
  return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (2 * HALF)));
});
const sum = taps.reduce((a, b) => a + b, 0);
for (let i = 0; i < taps.length; i++) taps[i] /= sum;

export function pcmTo24k(inputRate) {
  if (inputRate !== 24000 && inputRate !== 48000) throw new RangeError('Only 24000 or 48000 Hz mono PCM is supported');
  const history = new Float64Array(taps.length);
  let pos = 0, count = 0, emitted = 0, dangling, ended = false;
  function sample(value, output) {
    history[pos] = value;
    pos = (pos + 1) % history.length;
    const index = count++;
    if (index < HALF || (index - HALF) % 2 !== 0) return;
    let result = 0;
    for (let i = 0; i < taps.length; i++) result += taps[i] * history[(pos - 1 - i + history.length) % history.length];
    output.push(Math.max(-32768, Math.min(32767, Math.round(result))));
    emitted++;
  }
  function encode(output) {
    const bytes = Buffer.allocUnsafe(output.length * 2);
    output.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
    return bytes;
  }
  return {
    push(chunk) {
      if (ended) throw new Error('PCM stream already ended');
      if (!(chunk instanceof Uint8Array)) throw new TypeError('PCM chunk must be bytes');
      const bytes = dangling === undefined ? Buffer.from(chunk) : Buffer.concat([Buffer.from([dangling]), Buffer.from(chunk)]);
      const whole = bytes.length & ~1;
      dangling = whole < bytes.length ? bytes[whole] : undefined;
      if (inputRate === 24000) return bytes.subarray(0, whole);
      const output = [];
      for (let i = 0; i < whole; i += 2) sample(bytes.readInt16LE(i), output);
      return encode(output);
    },
    finish() {
      if (ended) throw new Error('PCM stream already ended');
      ended = true;
      if (dangling !== undefined) throw new Error('Truncated s16le sample');
      if (inputRate === 24000) return Buffer.alloc(0);
      const wanted = Math.ceil(count / 2);
      const output = [];
      while (emitted < wanted) sample(0, output);
      return encode(output);
    },
  };
}
