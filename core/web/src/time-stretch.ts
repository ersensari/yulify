/**
 * Faster speech without a higher voice.
 *
 * Playing samples faster (an AudioBufferSourceNode's playbackRate) raises the
 * pitch with the speed, and at 1.5× a voice sounds like a cartoon. This is
 * WSOLA instead: the output is built from overlapping, windowed pieces of the
 * input, taken further apart than they are laid down, and each piece is
 * nudged to where it lines up best with the one before it so that the
 * waveform stays continuous. The pieces are short (40 ms at 24 kHz), which is
 * what keeps a voice's pitch; the nudge is what keeps it from buzzing.
 *
 * It streams: samples go in as they arrive from the speech service and
 * finished output comes out behind them, so a streamed reply starts about as
 * early as it did. `flush` gives what is left at the end.
 */

import { joinSamples } from "./samples";

/**
 * The piece sizes, in samples, at a sample rate: a piece is 40 ms, it may move
 * 10 ms either way to line up, and half a piece is compared while lining up
 * (every other sample: enough to find the period, cheap enough for a phone).
 * At 24 kHz that is 960 / 240 / 480 samples; 48 kHz speech gets the same times.
 */
interface Sizes { FRAME: number; HOP: number; TOLERANCE: number; COMPARE: number; WINDOW: Float32Array }
const sizes = new Map<number, Sizes>();
function sizesAt(sampleRate: number): Sizes {
  let s = sizes.get(sampleRate);
  if (!s) {
    const FRAME = 2 * Math.round(0.02 * sampleRate), HOP = FRAME / 2;
    // A periodic Hann window: two of them half a frame apart add up to exactly one.
    const WINDOW = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
    s = { FRAME, HOP, TOLERANCE: Math.round(0.01 * sampleRate), COMPARE: HOP, WINDOW };
    sizes.set(sampleRate, s);
  }
  return s;
}

export class TimeStretch {
  private readonly s: Sizes;
  /** Input so far, after half a frame of silence (so the first piece does not fade in). */
  private input: Float32Array;
  private length: number;
  /** Real samples taken in, and output given out, for the length the whole comes to. */
  private taken = 0;
  private given = 0;
  /** The next piece to lay down. */
  private frame = 0;
  /** Where the last piece was taken from, in `input`. */
  private previous = 0;
  /** The half-finished half-frame at the end of the output, still to be overlapped. */
  private tail: Float32Array;
  /** The first half-frame of output is the silence put in front: it is not given out. */
  private skip: number;

  constructor(readonly rate: number, readonly sampleRate = 24000) {
    if (!(rate > 0)) throw new Error("The rate must be above zero");
    if (!(sampleRate >= 8000)) throw new Error("The sample rate must be at least 8 kHz");
    this.s = sizesAt(sampleRate);
    this.input = new Float32Array(this.s.HOP);
    this.length = this.s.HOP;
    this.tail = new Float32Array(this.s.HOP);
    this.skip = this.s.HOP;
  }

  private append(samples: Float32Array) {
    if (this.length + samples.length > this.input.length) {
      const grown = new Float32Array(Math.max(this.input.length * 2, this.length + samples.length));
      grown.set(this.input.subarray(0, this.length));
      this.input = grown;
    }
    this.input.set(samples, this.length);
    this.length += samples.length;
  }

  /** Where the next piece lines up best with what the last one would have gone on to. */
  private align(ideal: number, limit: number): number {
    if (this.frame === 0) return 0;
    const { HOP, TOLERANCE, COMPARE } = this.s;
    const natural = this.previous + HOP;
    let best = ideal, score = -Infinity;
    const from = Math.max(0, ideal - TOLERANCE), to = Math.min(limit, ideal + TOLERANCE);
    for (let at = from; at <= to; at++) {
      let sum = 0;
      for (let i = 0; i < COMPARE; i += 2) sum += this.input[natural + i] * this.input[at + i];
      if (sum > score) { score = sum; best = at; }
    }
    return best;
  }

  /** Lay down every piece the input so far is enough for. */
  private run(end: boolean): Float32Array {
    const { FRAME, HOP, TOLERANCE, WINDOW } = this.s;
    const out: Float32Array[] = [];
    while (true) {
      const ideal = Math.round(this.frame * HOP * this.rate);
      // Past the end of what there is to read, with the silence at the end counted.
      if (end ? ideal >= this.length : ideal + TOLERANCE + FRAME > this.length || this.previous + HOP + FRAME > this.length) break;
      const at = this.align(ideal, Math.max(0, Math.min(this.length - FRAME, ideal + TOLERANCE)));
      const piece = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) piece[i] = (this.input[at + i] ?? 0) * WINDOW[i];
      const done = new Float32Array(HOP);
      for (let i = 0; i < HOP; i++) done[i] = this.tail[i] + piece[i];
      this.tail = piece.slice(HOP);
      this.previous = at;
      this.frame++;
      out.push(done);
    }
    let result = joinSamples(out);
    if (this.skip) {
      const cut = Math.min(this.skip, result.length);
      this.skip -= cut; result = result.subarray(cut);
    }
    const total = result.length;
    if (end) {
      // As long as the input made faster, not a piece's worth longer.
      const wanted = Math.max(0, Math.round(this.taken / this.rate) - this.given);
      result = result.subarray(0, Math.min(total, wanted));
    }
    this.given += result.length;
    return result;
  }

  push(samples: Float32Array): Float32Array {
    if (this.rate === 1) { this.given += samples.length; return samples; }
    this.taken += samples.length;
    this.append(samples);
    return this.run(false);
  }

  flush(): Float32Array {
    if (this.rate === 1) return new Float32Array(0);
    // Silence after the end, so the last pieces have something to overlap with.
    this.append(new Float32Array(this.s.FRAME + this.s.TOLERANCE + this.s.HOP));
    return this.run(true);
  }
}

/** One whole recording, made `rate` times as fast. */
export function stretch(samples: Float32Array, rate: number, sampleRate = 24000): Float32Array {
  if (rate === 1) return samples;
  const s = new TimeStretch(rate, sampleRate);
  return joinSamples([s.push(samples), s.flush()]);
}

/** Half a second at 24 kHz: a few milliseconds of work at a time. */
const STEP = 12000;

/**
 * `stretch` a little at a time, letting the page carry on in between: a
 * whole reply in one go holds up the orb and the microphone for a moment.
 */
export async function stretchInSteps(samples: Float32Array, rate: number, signal: AbortSignal, sampleRate = 24000): Promise<Float32Array> {
  if (rate === 1) return samples;
  const s = new TimeStretch(rate, sampleRate), out: Float32Array[] = [];
  for (let at = 0; at < samples.length; at += STEP) {
    out.push(s.push(samples.subarray(at, at + STEP)));
    await new Promise(resolve => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
  out.push(s.flush());
  return joinSamples(out);
}
