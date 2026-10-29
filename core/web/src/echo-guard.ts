/**
 * Tells the assistant's own voice, coming back into the microphone while it
 * speaks, from a person talking over it.
 *
 * The browser's echo cancellation leaves a residue the VAD takes for speech,
 * and how much of it depends on the room, the speakers and the browser: no
 * level or ratio told the two apart reliably. So the reply is asked instead.
 * When the VAD hears speech while a reply plays, the reply is turned down
 * (ducked) for a moment and the VAD is watched. An echo goes with the sound
 * that made it, within a fraction of a second; a person goes on talking. The
 * ducked reply is turned back up when it was only the echo, and stopped, as
 * a barge-in, when it was a person.
 */
export interface EchoProbeOptions {
  /** After the reply is turned down, how long the echo and the room's tail are given to die away, ms; start() may say longer. */
  settle: number;
  /** How long the VAD is then watched before it is decided, ms. */
  window: number;
  /** The mean speech probability over the window at which it is a person. */
  person: number;
  /** Frames needed after settling to say anything at all. */
  minFrames: number;
}
export const ECHO_PROBE: EchoProbeOptions = { settle: 300, window: 300, person: 0.5, minFrames: 3 };

/**
 * How long to give the sound already on its way to die away once the reply is turned down:
 * what is queued in the browser and the sound server keeps playing for the output latency after
 * the gain is zero, and the room's tail comes on top. Not shorter than the default.
 */
export function settleFor(outputLatencySeconds: number | undefined, base = ECHO_PROBE.settle): number {
  const latency = Number.isFinite(outputLatencySeconds) && outputLatencySeconds! > 0 ? outputLatencySeconds! * 1000 : 0;
  return Math.min(900, Math.max(base, latency + 200));
}
export type EchoVerdict = "wait" | "person" | "echo";

export class EchoProbe {
  private from = -1;
  private settle = ECHO_PROBE.settle;
  private seen: number[] = [];
  constructor(private readonly options: EchoProbeOptions = ECHO_PROBE) {}
  get active() { return this.from >= 0; }
  /** The reply has just been turned down. */
  start(now: number, settle = this.options.settle) { this.from = now; this.settle = settle; this.seen = []; }
  stop() { this.from = -1; this.seen = []; }
  private mean() { return this.seen.reduce((a, b) => a + b, 0) / this.seen.length; }
  /** One VAD frame while probing. Stops probing once it has decided. */
  frame(now: number, speech: number): EchoVerdict {
    if (!this.active) return "wait";
    const elapsed = now - this.from;
    if (elapsed < this.settle) return "wait";
    this.seen.push(speech);
    if (this.seen.length >= this.options.minFrames && this.mean() < 0.15) return this.done("echo");
    if (elapsed < this.settle + this.options.window) return "wait";
    return this.done(this.mean() >= this.options.person ? "person" : "echo");
  }
  /** The VAD's speech ended while probing: decided with what there is. */
  end(): EchoVerdict {
    if (!this.active) return "person";
    return this.done(this.seen.length >= this.options.minFrames && this.mean() >= this.options.person ? "person" : "echo");
  }
  private done(verdict: EchoVerdict): EchoVerdict { this.stop(); return verdict; }
}
