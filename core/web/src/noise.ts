import { GtcrnWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

/**
 * What cleans the microphone before the VAD and the recognizer hear it, on top
 * of the browser's own suppression (which handles steady noise such as a fan
 * well, and a TV or a second voice poorly).
 *   rnnoise: a small recurrent network, light on CPU.
 *   gtcrn:   a small neural speech enhancer, heavier, better with voices in the background.
 */
export type NoiseModel = "off" | "rnnoise" | "gtcrn";
export const NOISE_MODELS: readonly NoiseModel[] = ["off", "rnnoise", "gtcrn"];

export interface Suppressed { stream: MediaStream; close(): void }

/**
 * The microphone through `model`. Falls back to the microphone itself (never
 * throws) where the browser has no AudioWorklet or a file does not load: a
 * noisy recording is better than none.
 */
export async function suppressNoise(mic: MediaStream, model: NoiseModel, base = "/voice-assets/"): Promise<Suppressed> {
  const raw: Suppressed = { stream: mic, close() {} };
  if (model === "off" || typeof AudioWorkletNode === "undefined") return raw;
  let ctx: AudioContext | undefined;
  try {
    // Both models take 48 kHz, whatever the microphone gives.
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const source = ctx.createMediaStreamSource(mic), sink = ctx.createMediaStreamDestination();
    let node: AudioWorkletNode & { destroy(): void };
    if (model === "gtcrn") {
      const wasmBinary = await loadGtcrn({ url: `${base}gtcrn.wasm` });
      await ctx.audioWorklet.addModule(`${base}gtcrn-worklet.js`);
      node = new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    } else {
      const wasmBinary = await loadRnnoise({ url: `${base}rnnoise.wasm`, simdUrl: `${base}rnnoise_simd.wasm` });
      await ctx.audioWorklet.addModule(`${base}rnnoise-worklet.js`);
      node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    }
    source.connect(node); node.connect(sink);
    await ctx.resume();
    const context = ctx;
    // A suspended context (background tab, output device change, power saving) turns the stream to silence for good: the VAD and the orb hear nothing and nothing says why. Bring it back.
    const revive = () => { if (context.state !== "running" && context.state !== "closed") void context.resume().catch(() => {}); };
    context.addEventListener("statechange", revive);
    document.addEventListener("visibilitychange", revive);
    const watchdog = setInterval(revive, 2000);
    return { stream: sink.stream, close() { clearInterval(watchdog); document.removeEventListener("visibilitychange", revive); try { node.destroy(); } catch { /* gone */ } void context.close().catch(() => {}); } };
  } catch {
    void ctx?.close().catch(() => {});
    return raw;
  }
}
