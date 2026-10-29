import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const vad = dirname(require.resolve('@ricky0123/vad-web'));
const ort = dirname(require.resolve('onnxruntime-web/wasm'));
const noise = dirname(require.resolve('@sapphi-red/web-noise-suppressor'));
const output = resolve(import.meta.dirname, '../public/voice-assets');
await mkdir(output, { recursive: true });
for (const [base, files] of [
  [vad, ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']],
  [ort, ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']],
]) {
  for (const file of files) await copyFile(resolve(base, file), resolve(output, file));
}
// Noise suppression (web/src/noise.ts): the worklets run beside the VAD and are fetched with it.
for (const [from, to] of [['rnnoise/workletProcessor.js', 'rnnoise-worklet.js'], ['gtcrn/workletProcessor.js', 'gtcrn-worklet.js'], ['rnnoise.wasm', 'rnnoise.wasm'], ['rnnoise_simd.wasm', 'rnnoise_simd.wasm'], ['gtcrn.wasm', 'gtcrn.wasm']]) {
  await copyFile(resolve(noise, from), resolve(output, to));
}
// The licences of those files travel with them. Not copying them breaks the build,
// so a missing notice cannot ship unseen.
await copyFile(resolve(import.meta.dirname, '../../../THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'));
