import { asrSettings, AsrSettingsError, requireAsrEnabled } from "../asr-settings.js";
import { replyLanguage } from "../pi/reply-language.js";
import { addVoice, listVoices, readVoice, updateVoice, deleteVoice, VoiceNotFound } from '../voice-presets.js';
import { spokenNumbers } from '../voice-numbers.js';
import { INPUT_LANGUAGES, CHATTERBOX_LANGUAGES } from '../voice-languages.js';
import { DEFAULT_CHOICE, cpuSpeechUrl, endpoints, isManagedUrl, parseChoice, speechUrl, type VoiceChoice } from '../voice-engines.js';
import { DEFAULT_KOKORO_VOICE, KOKORO_SPEEDS, isKokoroVoice } from '../kokoro-voices.js';
import { VoiceLeases } from '../extensions/voice-leases.js';
import { DEFAULT_SKIP_THINKING_PROVIDERS, DEFAULT_VOICE_INSTRUCTIONS, voiceInstructions, voiceRulesOn } from '../pi/voice-first.js';
import * as voiceService from '../extensions/voice-service.js';
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import express, { type Router } from "express";
import { answerOffer, type RtcStt } from "../voice-stt/rtc.js";
import { speakerIdUrl, speakerIdentify } from "../voice-stt/speaker.js";
import { whisperTranscribe } from "../voice-stt/whisper.js";
import { getSession, getSetting, putSetting } from "../db.js";
import { agentOf, defaultAgent } from "../agents.js";
import { voiceHeaders } from "../voice-auth.js";

const DEFAULT_VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
export interface VoiceConfig {
  vad?: typeof DEFAULT_VAD;
  enabled: boolean;
  lazyLoad?: boolean;
  whisperUrl: string;
  breezeUrl: string;
  instruction: string;
  voice: string;
  language: string;
  cfgScale: number;
  // `none`: speech recognition only. There is nothing to speak with, so no replies are spoken.
  runtime?: "breeze" | "audio-cpp" | "chatterbox" | "kokoro" | "none";
  // Sent as the OpenAI transcription "model" field. audio.cpp requires it and
  // names the loaded model; Whisper.cpp ignores unknown fields, so an empty
  // value keeps the existing Whisper contract byte for byte.
  sttModel?: string;
  // Chatterbox emotion exaggeration; its own scale, unrelated to Breeze's CFG.
  exaggeration?: number;
  // Kokoro speaks with one of its own voices, kept apart from `voice` so that
  // switching runtimes keeps the library voice the others speak with.
  kokoroVoice?: string;
  // Kokoro's speed multiplier.
  speed?: number;
  // How the agent is told to speak in voice mode. Empty means the built-in text.
  responseInstructions?: string;
  // The providers whose first call of a spoken turn goes without thinking. Absent means DEFAULT_SKIP_THINKING_PROVIDERS.
  skipThinkingProviders?: string[];
}
/** Long enough for the built-in text several times over; every voice turn carries it. */
export const MAX_RESPONSE_INSTRUCTIONS = 8000;
// The addresses of a portal with nothing set up: services of the Compose overlay, not the managed ones.
const DEFAULT_WHISPER_URL = "http://127.0.0.1:8178/inference";
const DEFAULT_BREEZE_URL = "http://127.0.0.1:7860/v1/audio/speech";
/**
 * The voice library ids the OmniVoice engine (forgeloop-ai-omnivoice, reached
 * through the audio-cpp wire shape) speaks with by name. OmniVoice has no
 * per-request reference clone on this path: `tts-server` only reads a `voice`
 * field naming a voice registered in its own registry, and `app.py` registers
 * the bundled presets there by the ids below - so a library voice is sent as
 * that name, not as a `voice_ref` clip. A voice outside this table is sent as
 * no voice at all: OmniVoice then designs one from the instructions, which is
 * what made every phrase of one reply sound like a different speaker.
 */
const OMNIVOICE_VOICES = new Map<string, string>([
  ["voice-a3cc8c3b-0237-41ac-a01f-0bacc9dcfd2c", "ersen"],
  ["voice-4f8e2a91-7c3d-4b6e-9a1f-2d5c8e6b3a09", "ersen-tr"],
  ["voice-c6f49cf4-0542-48e0-91d9-dbb83e360b9f", "emma"],
  ["voice-cb02ec68-5ccb-4cd4-98bf-59608dd99c0a", "severin"],
]);
/** The OmniVoice registry name of a voice library row: the preset's own name,
 * lower-cased - the same form `app.py` registers it with (`preset["name"].lower()`),
 * so a preset added on either side matches without touching this file. */
function omnivoiceVoice(voiceId: string, name: string): string | undefined {
  return OMNIVOICE_VOICES.get(voiceId) ?? (/^[a-z0-9][a-z0-9-]*$/.test(name) ? name : undefined);
}
/** A voice chosen from the engine's own registry has no library row: the name
 * is the registry name itself, so the lookup is tolerant of that. */
function libraryVoice(voiceId: string) {
  try { return readVoice(voiceId); } catch (e) { if (e instanceof VoiceNotFound) return undefined; throw e; }
}
/** "[style: ...]" per-sentence delivery markers: only the ForgeLoop audio engine (audio-cpp runtime) reads them; any other engine would speak them. */
const STYLE_MARKER = /\s*\[\s*style\s*:[^\]\n]{0,80}\]\s*/gi;
/** The PCM stream rates the player handles (X-Sample-Rate). */
const STREAM_RATES = new Set(["24000", "48000"]);
let rateProbe: { url: string; rate: number; at: number } | undefined;
/**
 * The rate an audio-cpp engine streams at, read from its /health `output_rate`
 * (VoxCPM2's adapter reports 48000 or 24000; OmniVoice reports none): the
 * browser opens its audio context at it so streamed speech is not resampled.
 * Cached a minute; anything unreadable means 24000, the rate every other engine sends.
 */
/**
 * Another endpoint of the engine that serves `breezeUrl`, kept under the same prefix: on the Mac the engine is reached
 * through `https://.../speech-playground/v1/audio/speech`, where `new URL("/health", ...)` dropped the prefix and asked
 * another service (so the Mac always read 24000 for the rate).
 */
export function engineUrl(breezeUrl: string, path: string): string {
  return /\/v1\/audio\/speech\/?$/.test(breezeUrl) ? breezeUrl.replace(/\/v1\/audio\/speech\/?$/, path) : new URL(path, breezeUrl).toString();
}

async function speechSampleRate(c: VoiceConfig): Promise<number> {
  if (c.runtime !== "audio-cpp" || !c.breezeUrl) return 24000;
  if (rateProbe?.url === c.breezeUrl && Date.now() - rateProbe.at < 60000) return rateProbe.rate;
  let rate = 24000;
  try {
    const r = await fetch(engineUrl(c.breezeUrl, "/health"), { headers: voiceHeaders(), redirect: "error", signal: AbortSignal.timeout(2000) });
    const body = r.ok ? await r.json() as { output_rate?: unknown } : {};
    if (body.output_rate === 48000) rate = 48000;
  } catch { /* the engine is down or answers otherwise: speech then fails on its own, with its own message */ }
  rateProbe = { url: c.breezeUrl, rate, at: Date.now() };
  return rate;
}
/** The shape OmniVoice accepts for a voice of its own registry: a lower-case name. */
const REGISTRY_VOICE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function config(): VoiceConfig {
  const stored = getSetting("voice");
  return stored ? { voice: "design", language: "auto", cfgScale: 4, ...JSON.parse(stored) } : {
    voice: "design", language: "auto", cfgScale: 4,
    enabled: false, whisperUrl: DEFAULT_WHISPER_URL,
    breezeUrl: DEFAULT_BREEZE_URL,
    instruction: "A warm, clear English voice with a calm, conversational delivery.",
  };
}
export function validateConfig(value: any): VoiceConfig {
  if (typeof value?.enabled !== "boolean") throw new Error("enabled must be a boolean");
  const runtime = value.runtime ?? "breeze";
  if (!["breeze", "audio-cpp", "chatterbox", "kokoro", "none"].includes(runtime)) throw new Error("Choose a supported speech runtime");
  for (const key of ["whisperUrl", "breezeUrl"]) {
    if (typeof value[key] !== "string") throw new Error(`${key} is required`);
    // With no speech synthesis there is no address to speak to.
    if (key === "breezeUrl" && runtime === "none" && !value[key].trim()) continue;
    const url = new URL(value[key]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error(`${key} must be an HTTP URL without credentials or a fragment`);
  }
  if (typeof value.instruction !== "string" || !value.instruction.trim() || value.instruction.length > 1000)
    throw new Error("Provide a voice description of 1–1000 characters");
  const voice = value.voice ?? "design";
  if (typeof voice !== "string") throw new Error("Choose a speaking voice");
  const preset = voice === "design" ? undefined : libraryVoice(voice);
  if (!preset && voice !== "design") {
    // OmniVoice speaks with a voice registered in its own registry, which the picker
    // lists straight from the engine: such a voice is no library row. Everywhere else
    // a voice outside the library is refused, not spoken with another one.
    if (runtime !== "audio-cpp") throw new VoiceNotFound();
    if (!REGISTRY_VOICE.test(voice)) throw new Error("Choose a voice the speech engine has registered");
  }
  const language = value.language ?? "auto";
  if (!INPUT_LANGUAGES.some(([code]) => code === language))
    throw new Error("Choose a supported input language");
  const cfgScale = value.cfgScale ?? 4;
  if (![1, 4].includes(cfgScale)) throw new Error("Choose fast or expressive speech generation");
  const sttModel = typeof value.sttModel === "string" ? value.sttModel.trim() : value.sttModel ?? "";
  if (typeof sttModel !== "string" || sttModel.length > 100 || (sttModel && !/^[\w.:-]+$/.test(sttModel)))
    throw new Error("A speech recognition model id may only contain letters, digits, dot, colon, dash or underscore");
  const exaggeration = value.exaggeration ?? 0.5;
  if (typeof exaggeration !== "number" || !Number.isFinite(exaggeration) || exaggeration < 0 || exaggeration > 2)
    throw new Error("Expressiveness must be between 0 and 2");
  const kokoroVoice = value.kokoroVoice ?? DEFAULT_KOKORO_VOICE;
  if (!isKokoroVoice(kokoroVoice)) throw new Error("Choose one of Kokoro's voices");
  const speed = value.speed ?? 1;
  if (!(KOKORO_SPEEDS as readonly number[]).includes(speed)) throw new Error("Choose a supported speaking speed");
  const responseInstructions = value.responseInstructions ?? "";
  if (typeof responseInstructions !== "string" || responseInstructions.length > MAX_RESPONSE_INSTRUCTIONS)
    throw new Error(`Speaking instructions may be at most ${MAX_RESPONSE_INSTRUCTIONS} characters`);
  const skipThinkingProviders = skipThinking(value.skipThinkingProviders);
  if (runtime === "chatterbox") {
    // Chatterbox is told a language or it refuses; it has no detection mode,
    // and the language also decides how numbers are written out for synthesis.
    if (language === "auto") throw new Error("Chatterbox needs an input language: auto-detect selects no voice");
    if (!CHATTERBOX_LANGUAGES.includes(language)) throw new Error(`Chatterbox speaks: ${CHATTERBOX_LANGUAGES.join(", ")}`);
    // Refuse a voice it cannot speak with here, rather than on every phrase.
    if (voice === "design" || (preset && !preset.audio))
      throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording");
  }
  const vad = { ...DEFAULT_VAD, ...value.vad };
  for (const [key, min, max] of [['positiveSpeechThreshold', 0.01, 1], ['negativeSpeechThreshold', 0, 0.99], ['minSpeechMs', 64, 2000], ['preSpeechPadMs', 0, 1000], ['redemptionMs', 200, 3000]] as const) {
    if (typeof vad[key] !== 'number' || !Number.isFinite(vad[key]) || vad[key] < min || vad[key] > max) throw new Error(`Invalid VAD ${key}: expected ${min}–${max}`);
  }
  if (vad.negativeSpeechThreshold >= vad.positiveSpeechThreshold) throw new Error('Speech-end threshold must be lower than speech-start threshold');
  return { vad, lazyLoad: value.lazyLoad !== false, runtime, voice, language, cfgScale, sttModel, exaggeration, kokoroVoice, speed, responseInstructions: savedInstructions(responseInstructions), skipThinkingProviders, enabled: value.enabled, whisperUrl: value.whisperUrl.trim(), breezeUrl: value.breezeUrl.trim(), instruction: value.instruction.trim() };
}
/**
 * The providers as saved: names as the model menu shows them, each once. The
 * default list is not saved, so it follows the portal's updates; an empty list
 * is, and switches the first call's thinking back on everywhere.
 */
function skipThinking(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || value.some((name) => typeof name !== "string"))
    throw new Error("Name at most 50 providers");
  const names = [...new Set((value as string[]).map((name) => name.trim()).filter(Boolean))];
  const bad = names.find((name) => name.length > 100 || !/^[\w.:@-]+$/.test(name));
  if (bad) throw new Error(`"${bad}" is not a provider name: use letters, digits, dot, colon, @, dash or underscore`);
  const same = names.length === DEFAULT_SKIP_THINKING_PROVIDERS.length && names.every((name) => DEFAULT_SKIP_THINKING_PROVIDERS.includes(name));
  return same ? undefined : names;
}
/** Text equal to the built-in instructions is not saved, so they follow the portal's updates. */
function savedInstructions(text: string): string {
  const trimmed = text.trim();
  return trimmed === DEFAULT_VOICE_INSTRUCTIONS ? "" : trimmed;
}
/**
 * The settings as the page gets them: the speaking instructions in use, whether
 * saved or built in, and the built-in ones to go back to. `off` says the portal
 * sends none at all (VOICE_RESPONSE_INSTRUCTIONS=false), saved or not.
 */
function withInstructions<T extends { responseInstructions?: string; skipThinkingProviders?: string[] }>(value: T) {
  return { ...value, responseInstructions: voiceInstructions(value.responseInstructions), defaultResponseInstructions: DEFAULT_VOICE_INSTRUCTIONS, responseInstructionsOff: !voiceRulesOn(),
    skipThinkingProviders: value.skipThinkingProviders ?? [...DEFAULT_SKIP_THINKING_PROVIDERS], defaultSkipThinkingProviders: [...DEFAULT_SKIP_THINKING_PROVIDERS] };
}
/** The samples of a RIFF/WAVE buffer, checked to be what the player expects. */
export function wavPcm(wav: Buffer, runtime = "Chatterbox"): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${runtime} returned invalid WAV audio`);
  let format = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString("ascii", at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") {
      if (size < 16 || at + 24 > wav.length || wav.readUInt16LE(at + 8) !== 1 || wav.readUInt16LE(at + 10) !== 1 || wav.readUInt32LE(at + 12) !== 24000 || wav.readUInt16LE(at + 22) !== 16)
        throw new Error(`Expected mono 24 kHz 16-bit audio from ${runtime}`);
      format = true;
    }
    if (id === "data") {
      // Samples are only meaningful once the fmt chunk has described them.
      if (!format) throw new Error(`Expected mono 24 kHz 16-bit audio from ${runtime}`);
      // A writer that does not know the length up front leaves a placeholder
      // size behind. The response is fully buffered, so its end is the truth.
      const end = size && at + 8 + size <= wav.length ? at + 8 + size : wav.length;
      const pcm = wav.subarray(at + 8, end);
      if (!pcm.length || pcm.length % 2) throw new Error(`${runtime} returned invalid PCM audio`);
      return pcm;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${runtime} returned no audio data`);
}
export function pcmWav(pcm: Buffer, sampleRate = 24000): Buffer {
  if (!pcm.length || pcm.length % 2) throw new Error("Breeze returned invalid PCM audio");
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
// Speech is in the GPU process, or in the CPU one where Kokoro is put on the CPU.
const managedVoice = () => ['audio-cpp', 'chatterbox', 'kokoro'].includes(config().runtime ?? '') && [speechUrl, cpuSpeechUrl].includes(config().breezeUrl);
const managedPort = () => Number(new URL(config().breezeUrl).port);
// The lease loads the speech model the saved runtime speaks with. Recognition loads itself on its first request.
const managedEngine = () => { const runtime = config().runtime; return runtime === 'chatterbox' || runtime === 'kokoro' ? runtime : 'breeze'; };
const leases = new VoiceLeases(()=>voiceService.modelAction('load', managedEngine(), managedPort()),()=>voiceService.modelAction('unload', managedEngine(), managedPort()));
/**
 * A setup that was started here and has finished is connected to, once: what the page's Install did not wait for.
 * Taken up wherever the finished service is first seen, which is the timer or the page asking after it.
 */
function adoptFinishedInstall(service: Awaited<ReturnType<typeof voiceService.status>>) {
  if (service.state !== 'running' || getSetting('voice_setup_pending') !== '1') return;
  connectManagedVoice(service.choice);
  putSetting('voice_setup_pending', '');
}
async function maintainManagedVoice() {
  // Also reconciles running legacy containers after portal updates, without
  // requiring the settings modal to be opened. Stopped add-ons stay stopped.
  adoptFinishedInstall(await voiceService.status());
  if (managedVoice()) await leases.sweep(config().lazyLoad !== false);
}
const maintain = () => { void maintainManagedVoice().catch(e => console.error('[voice] maintenance:', (e as Error).message)); };
const leaseTimer = setInterval(maintain, 30000);
leaseTimer.unref();
// Wait until module initialization finishes before accessing configuration.
setImmediate(maintain);

/**
 * What the portal keeps of the settings a connect overwrites, for the uninstall to put back. Kept for each side on its own, so
 * that an address the user sets up after the install is remembered as well: `listening` is the recognition address with its
 * model, `speaking` the speech address with its runtime. A side is there once it held something that was not the managed
 * service's, with whether voice was on then: that goes with the side, as the connect itself saves voice as on, and a side that
 * stays the service's while the other is set up again must not take the other's flag over. `noSpeech`: the last connect saved
 * no speech address, which is how recognition alone leaves the speech side, and which is then the managed service's and not the user's.
 */
interface Remembered {
  listening?: { whisperUrl: string; sttModel: string; enabled: boolean };
  speaking?: { breezeUrl: string; runtime: NonNullable<VoiceConfig["runtime"]>; enabled: boolean };
  noSpeech?: boolean;
}
const REMEMBERED_KEY = "voice_before_managed";
function saveVoice(value: VoiceConfig) {
  putSetting("voice", JSON.stringify(value));
}
function remembered(): Remembered {
  try {
    const value = JSON.parse(getSetting(REMEMBERED_KEY) ?? "{}");
    const { listening, speaking } = value;
    return {
      ...(typeof listening?.whisperUrl === "string" ? { listening: { whisperUrl: listening.whisperUrl, sttModel: typeof listening.sttModel === "string" ? listening.sttModel : "", enabled: listening.enabled === true } } : {}),
      ...(typeof speaking?.breezeUrl === "string" && typeof speaking.runtime === "string" ? { speaking: { breezeUrl: speaking.breezeUrl, runtime: speaking.runtime, enabled: speaking.enabled === true } } : {}),
      ...(typeof value.noSpeech === "boolean" ? { noSpeech: value.noSpeech } : {}),
    };
  } catch { return {}; }
}
/** Which sides of the saved settings are the managed service's, as far as the portal can tell. */
function managedSides(c: VoiceConfig, noSpeech: boolean | undefined) {
  const listening = isManagedUrl(c.whisperUrl);
  // No speech address and the runtime none is the service's where a connect saved it. Where nothing says (a service connected by an older portal), it is when the recognition is.
  const speaking = isManagedUrl(c.breezeUrl) || (c.runtime === "none" && !c.breezeUrl && (noSpeech ?? listening));
  return { listening, speaking };
}
/** Do the saved settings still point at the managed service, in either side? */
export const pointsAtManagedVoice = () => { const { listening, speaking } = managedSides(config(), remembered().noSpeech); return listening || speaking; };
/** Point the saved config at the managed services, for the engines they were built with. */
export function connectManagedVoice(choice: VoiceChoice = DEFAULT_CHOICE) {
  const { runtime, ...urls } = endpoints(choice);
  const current = config();
  // What is about to be overwritten is kept for the uninstall, side by side: a side that is the managed service's already (a
  // rebuild, a second connect) keeps what was remembered of it, as the service is not what there was before it.
  const kept = remembered();
  const { listening, speaking } = managedSides(current, kept.noSpeech);
  const next: Remembered = { ...kept, noSpeech: runtime === "none" };
  if (!listening) next.listening = { whisperUrl: current.whisperUrl, sttModel: current.sttModel ?? "", enabled: current.enabled };
  if (!speaking) next.speaking = { breezeUrl: current.breezeUrl, runtime: current.runtime ?? "breeze", enabled: current.enabled };
  putSetting(REMEMBERED_KEY, JSON.stringify(next));
  // Chatterbox is told a language and has no detection mode; keep one it speaks rather than save a setting it refuses.
  const language = runtime === 'chatterbox' && !CHATTERBOX_LANGUAGES.includes(current.language) ? 'en' : current.language;
  // Whisper.cpp serves one model and is sent no model field: an id left over
  // from another runtime would reach it in the multipart body.
  const saved = { ...current, language, enabled: true, runtime, ...urls };
  saveVoice(saved);
  return {...saved, managed:true};
}
/**
 * Takes the managed service out of the saved settings after it has been uninstalled: what the connect overwrote is put back, or,
 * where nothing was remembered of a side (the service was connected before the portal did), what points at it is reset to a portal
 * with nothing set up. Only what points at the managed service is touched: an address the user set up themselves stays as it is,
 * and so do the voice, the speech detection and the rest.
 */
export function disconnectManagedVoice() {
  const current = config();
  const kept = remembered();
  putSetting(REMEMBERED_KEY, "");
  const { listening, speaking } = managedSides(current, kept.noSpeech);
  if (!listening && !speaking) return current;
  const back = {
    ...(listening ? { whisperUrl: kept.listening?.whisperUrl ?? DEFAULT_WHISPER_URL, sttModel: kept.listening?.sttModel ?? "" } : {}),
    ...(speaking ? { breezeUrl: kept.speaking?.breezeUrl ?? DEFAULT_BREEZE_URL, runtime: kept.speaking?.runtime ?? "breeze" } : {}),
  };
  // Voice was switched on by the connect, and is left on only where everything put back is what the user had, it was on when each
  // part of it was, and it has not been turned off since; an address that is only a default is no use switched on.
  const on = (!listening || kept.listening?.enabled === true) && (!speaking || kept.speaking?.enabled === true);
  const saved: VoiceConfig = { ...current, ...back, enabled: on && current.enabled };
  saveVoice(saved);
  return saved;
}
export function voiceRouter(): Router {
  const router = express.Router();
  router.get('/voice/asr-settings', async (_req, res) => {
    try { res.set('Cache-Control','no-store').json(await asrSettings()); }
    catch (error) { res.status(error instanceof AsrSettingsError ? error.status : 502).json({ error: (error as Error).message }); }
  });
  router.put('/voice/asr-settings', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({error:'Speech recognition settings must be an object'});
    try {
      const result=await asrSettings(req.body);
      // Existing browser dictation peers must stop too when recognition is off.
      if (!result.settings.enabled) { for (const peer of rtc.values()) peer.close(); rtc.clear(); }
      res.json(result);
    } catch (error) { res.status(error instanceof AsrSettingsError ? error.status : 502).json({ error: (error as Error).message }); }
  });
  // The stored GPU choice, in place before anything asks the service to start.
  voiceService.useGpu(getSetting('voice_gpu') ?? '');
  /** Choose the GPU by UUID, or "" to leave it to VOICE_GPU and then the card with the most room. A running voice moves now; a stopped one on its next start. */
  router.put('/voice/gpu', async (req, res) => {
    const id = req.body?.gpu;
    if (typeof id !== 'string') return res.status(400).json({ error: 'gpu must be a GPU UUID, or empty to choose automatically' });
    try {
      // Before anything is saved or stopped: a card that is not there, or that cannot hold the engines installed, leaves the service where it is.
      if (id) await voiceService.checkGpu(id);
      putSetting('voice_gpu', id);
      voiceService.useGpu(id);
      const restarting = ['running', 'starting'].includes((await voiceService.status()).state);
      if (restarting) {
        // Saved either way: a setup already under way picks the new GPU up on the next start.
        try { await voiceService.install(); }
        catch (e) { return res.status(409).json({ error: `GPU choice saved, but voice could not restart on it now: ${(e as Error).message}. It moves on the next start.` }); }
      }
      res.json({ selected: id, restarting });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get('/voice/presets',(_req,res)=>res.json(listVoices()));
  router.post('/voice/presets',(req,res)=>{try{res.json(addVoice(req.body));}catch(e){res.status(400).json({error:(e as Error).message});}});
  router.patch('/voice/presets/:id',(req,res)=>{try{res.json(updateVoice(String(req.params.id),req.body));}catch(e){res.status(e instanceof VoiceNotFound?404:400).json({error:(e as Error).message});}});
  router.get('/voice/presets/:id/audio',(req,res)=>{try{const row=readVoice(String(req.params.id));if(!row.audio)return res.sendStatus(404);res.set({'Content-Type':'audio/wav','Cache-Control':'no-store'}).send(row.audio);}catch{res.sendStatus(404);}});
  router.delete('/voice/presets/:id',(req,res)=>{try{deleteVoice(String(req.params.id));res.json({ok:true});}catch(e){res.status(404).json({error:(e as Error).message});}});
  router.get('/voice/install', async (_req, res) => {
    try {
      const state = await voiceService.status();
      adoptFinishedInstall(state);
      // `connected`: the saved settings point at the service, whether or not it is there, so that they can be put right after the container was removed by hand.
      res.json({ ...state, connected: pointsAtManagedVoice() });
    } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  router.get('/voice/hardware', async (_req, res) => {
    try { res.json(await voiceService.hardware()); } catch (e) { res.status(503).json({ error: (e as Error).message }); }
  });
  for (const action of ['install', 'start', 'stop'] as const) router.post(`/voice/${action}`, async (req, res) => {
    try {
      // Install takes the engines to build for; without them it keeps what is installed, or picks for the GPU.
      if (action === 'install') await voiceService.install(Object.keys(req.body ?? {}).length ? parseChoice(req.body) : undefined);
      else await voiceService[action]();
      putSetting('voice_setup_pending', action !== 'stop' ? '1' : '');
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  // The container goes, and with it the settings that point at it. The downloads stay unless `removeData` says they go too.
  router.post('/voice/uninstall', async (req, res) => {
    try {
      const removeData = req.body?.removeData ?? false;
      if (typeof removeData !== 'boolean') throw new Error('removeData must be true or false');
      // The container being gone is what the settings follow, whether or not the downloads could be deleted after it.
      let kept: Error | undefined;
      try { await voiceService.uninstall(removeData); }
      catch (e) { if (!(e instanceof voiceService.DataNotRemoved)) throw e; kept = e; }
      putSetting('voice_setup_pending', '');
      disconnectManagedVoice();
      if (kept) return res.status(409).json({ error: kept.message });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.post('/voice/connect', async (_req, res) => {
    try {
      const state = await voiceService.status();
      if (state.state !== 'running') throw new Error('Wait for voice setup to finish before connecting');
      res.json(withInstructions(connectManagedVoice(state.choice)));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.get("/voice", async (_req, res) => res.json({...withInstructions(config()),speechSampleRate:await speechSampleRate(config()),managed:managedVoice(),speech:config().runtime!=="none",comparison:process.env.VOICE_COMPARISON === "true",statusSpeech:process.env.VOICE_STATUS_SPEECH !== "false",ttsPrefetch:process.env.VOICE_TTS_PREFETCH === "true",sentenceChunks:process.env.VOICE_SENTENCE_CHUNKS === "true",pipelineMode:process.env.VOICE_PIPELINE_MODE === "sequential" ? "sequential" : "parallel",sttWebrtc:process.env.VOICE_STT_WEBRTC !== 'false',noiseModel:['off','gtcrn','rnnoise'].includes(process.env.VOICE_NOISE_MODEL ?? '')?process.env.VOICE_NOISE_MODEL:'rnnoise',mergeReplies:process.env.VOICE_MERGE_REPLIES === "true" || (process.env.VOICE_MERGE_REPLIES !== "false" && config().runtime === "audio-cpp")}));
  // The voices the speech engine has registered in its own registry. OmniVoice
  // speaks only with these, and a voice added on the engine's side has to be
  // pickable here without a code change, so the list is read from the engine.
  router.get("/voice/engines", async (_req, res) => {
    const settings = config();
    const runtime = settings.runtime ?? "breeze";
    if (runtime !== "audio-cpp") return res.json({ runtime, voices: [] });
    try {
      const url = new URL(settings.breezeUrl);
      url.pathname = url.pathname.replace(/\/[^/]*$/, "/voices");
      const upstream = await fetch(url.href, { headers: voiceHeaders(), redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!upstream.ok) throw new Error(`The speech engine returned HTTP ${upstream.status}`);
      const body = await upstream.json() as { voices?: { name?: unknown }[] };
      res.json({ runtime, voices: (body.voices ?? []).map(v => (typeof v?.name === "string" ? v.name : "")).filter(Boolean) });
    } catch (e) { res.json({ runtime, voices: [], error: (e as Error).message }); }
  });
  router.put("/voice", (req, res) => {
    try {
      const saved = validateConfig(req.body);
      saveVoice(saved);
      res.json(withInstructions(saved));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  router.use("/sessions/:id/voice", (req, res, next) => {
    if (!config().enabled) return res.status(409).json({ error: "Enable Voice in Settings → Add-ons first" });
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Session not found" });
    next();
  });
  router.post('/sessions/:id/voice/connection', async (req,res)=>{
    const {client,active}=req.body??{};
    if(typeof client!=='string'||client.length>100||!client||typeof active!=='boolean')return res.status(400).json({error:'A client ID and active flag are required'});
    if(!managedVoice())return res.json({managed:false});
    try {
      const key=String(req.params.id)+':'+client;
      if(active)await leases.acquire(key);else await leases.release(key,config().lazyLoad!==false);
      res.json({managed:true});
    } catch(e){res.status(503).json({error:(e as Error).message});}
  });
  router.post("/sessions/:id/voice/transcribe", express.raw({ type: "audio/wav", limit: "12mb" }), async (req, res) => {
    try { await requireAsrEnabled(); }
    catch (error) { return res.status(error instanceof AsrSettingsError ? error.status : 503).json({error:(error as Error).message}); }
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF")
      return res.status(400).json({ error: "A WAV recording is required" });
    const settings = config();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "recording.wav");
    form.set("response_format", "json");
    // Recognition services name a language with its own code and detect one when
    // the field is absent; "auto" is not a code any of them accepts, and sending
    // it fails the request before the audio is looked at.
    if (settings.language !== "auto") form.set("language", settings.language);
    // OpenAI-compatible recognition services (audio.cpp, Qwen3-ASR) name the
    // loaded model here; Whisper.cpp has one model and ignores the field.
    if (settings.sttModel) form.set("model", settings.sttModel);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const sttStarted=performance.now();
      // Who is talking is asked while Whisper works (opt-in VOICE_SPEAKER_ID + SPEECH_URL); it never fails the request.
      const idUrl = (await requireAsrEnabled()).settings.speaker_verification_enabled ? speakerIdUrl() : undefined;
      const speakerP = idUrl ? speakerIdentify(idUrl)(req.body, controller.signal) : undefined;
      const upstream = await fetch(settings.whisperUrl, { method: "POST", body: form, headers: voiceHeaders(), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
      if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
      const result = await upstream.json() as { text?: unknown };
      if (typeof result.text !== "string") throw new Error("Whisper returned no transcript");
      res.set("Server-Timing", `whisper_upstream;dur=${(performance.now()-sttStarted).toFixed(1)}`);
      const speaker = await speakerP;
      await requireAsrEnabled();
      res.json({ text: result.text.trim(), ...(speaker ? { speaker } : {}) });
    } catch (e) { if (!res.destroyed) res.status(502).json({ error: (e as Error).message }); }
  });
  // Streaming recognition over WebRTC: the browser sends its microphone as Opus and the VAD's start/end markers on a
  // data channel, and gets interim and final transcripts back on it. One live connection per chat; a new offer for a
  // chat replaces its old one. The media goes over UDP straight to this host (set VOICE_RTC_PORT_MIN/MAX to pin the
  // ports, VOICE_RTC_ADDRESSES for an address that is not on an interface), only this signalling goes through the proxy.
  const rtc = new Map<string, RtcStt>();
  router.post("/sessions/:id/voice/rtc", express.json({ limit: "64kb" }), async (req, res) => {
    try { await requireAsrEnabled(); }
    catch (error) { return res.status(error instanceof AsrSettingsError ? error.status : 503).json({error:(error as Error).message}); }
    const offer = req.body?.sdp;
    if (req.body?.type !== "offer" || typeof offer !== "string" || offer.length > 32768) return res.status(400).json({ error: "An SDP offer is required" });
    const id = String(req.params.id);
    if (!rtc.has(id) && rtc.size >= 8) return res.status(429).json({ error: "Too many live recognition connections" });
    const settings = config();
    const min = Number(process.env.VOICE_RTC_PORT_MIN), max = Number(process.env.VOICE_RTC_PORT_MAX);
    try {
      rtc.get(id)?.close();
      let peer: RtcStt | undefined;
      peer = await answerOffer(offer, {
        transcribe: async (...args) => {
          const current=await requireAsrEnabled();
          const identify=current.settings.speaker_verification_enabled && speakerIdUrl() ? speakerIdentify(speakerIdUrl()!) : undefined;
          const result=await whisperTranscribe(settings.whisperUrl, settings.sttModel || undefined, 120000, identify)(...args);
          const after=await requireAsrEnabled();
          if (!after.settings.speaker_verification_enabled) delete result.speaker;
          return result;
        },
        // The chat's own language setting, where it is one; and the languages that count as speech where VOICE_STT_LANGUAGES lists them (en,tr).
        ...(settings.language && settings.language !== "auto" ? { language: settings.language } : {}),
        languages: (process.env.VOICE_STT_LANGUAGES ?? "").split(",").map(l => l.trim().toLowerCase()).filter(Boolean),
        ...(min > 0 && max >= min ? { portRange: [min, max] as [number, number] } : {}),
        ...(process.env.VOICE_RTC_ADDRESSES ? { extraAddresses: process.env.VOICE_RTC_ADDRESSES.split(",").map(a => a.trim()).filter(Boolean) } : {}),
        onClose: () => { if (rtc.get(id) === peer) rtc.delete(id); },
      });
      rtc.set(id, peer);
      res.json({ type: "answer", sdp: peer.answer });
    } catch (e) { res.status(502).json({ error: (e as Error).message }); }
  });
  /**
   * The language this chat's replies are expected in (pi/reply-language.ts), for what a client says by itself while it
   * waits (the "let me think" and context-compaction phrases): null until a message has been seen.
   */
  router.get("/sessions/:id/voice/language", (req, res) => {
    res.json({ language: replyLanguage(req.params.id) ?? null });
  });

  router.post("/sessions/:id/voice/speech", async (req, res) => {
    // Recognition alone has nothing to speak with: say so, rather than send the text to an address that is not there.
    if (config().runtime === "none") return res.status(409).json({ error: "Speech synthesis is not installed: replies are not spoken" });
    const speechStarted=performance.now();
    let busyMs=0;
    const text = req.body?.text;
    // Merged speech phrases on audio-cpp go in up to 2000 characters; music has its own MCP player path.
    const maxChars = config().runtime === "audio-cpp" ? 2000 : 600;
    if (typeof text !== "string" || !text.trim() || text.length > maxChars)
      return res.status(400).json({ error: `Speech text must contain 1–${maxChars} characters` });
    // The voice of the agent the chat is with, where it has one of its own: the
    // first agent's for a chat in a project, as its avatar is.
    // An agent's voice is one of Kokoro's or one from the library, and is used by the runtime it belongs to.
    const own = (agentOf(getSession(req.params.id)?.workspace) ?? defaultAgent()).voice;
    const saved = config();
    const settings = { ...saved, ...(own && saved.runtime === "kokoro" && isKokoroVoice(own) ? { kokoroVoice: own } : own && !isKokoroVoice(own) ? { voice: own } : {}) };
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    // What the player takes: raw PCM, and Ogg/Opus where its browser can decode it (WebCodecs). Only an
    // audio-cpp engine is asked for Ogg; any other engine answers PCM or WAV, which the player still reads.
    const accepts = req.get("accept") ?? "";
    const wantsPcm = /\baudio\/pcm\b/.test(accepts);
    const wantsOgg = /\baudio\/ogg\b/.test(accepts);
    try {
      // Resolve the voice once: a reference clip is up to a megabyte, and only
      // the runtime that is about to be called should pay to carry it.
      let instruction = settings.instruction;
      let reference: { audio: Buffer; transcript: string; filename: string } | undefined;
      // Kokoro speaks with a voice of its own and reads no library voice.
      if (settings.runtime !== "kokoro" && settings.voice !== "design") {
        const preset = libraryVoice(settings.voice);
        // A voice of OmniVoice's own registry has no library row; anywhere else it is
        // a voice this portal does not have, and speaking with another one is a lie.
        if (!preset && settings.runtime !== "audio-cpp") throw new VoiceNotFound();
        if (preset) {
          instruction = preset.instruction;
          if (preset.audio) reference = { audio: preset.audio, transcript: preset.transcript, filename: "reference.wav" };
        }
      }
      // Chatterbox clones a speaker; it has no designed or built-in voice.
      // validateConfig refuses this combination on save; a config written before
      // that check, or by the managed connect, still reaches here.
      if (settings.runtime === "chatterbox" && !reference)
        throw new Error("Chatterbox speaks with a reference clone: choose a voice with a recording");
      let form: FormData | undefined;
      let json: Record<string, unknown> | undefined;
      if (settings.runtime === "kokoro") {
        // Kokoro reads sound tags such as [laughter] (OmniVoice's) aloud as words, so they are removed here; its own
        // stress/phoneme markup [word](+2) / [word](/.../) is kept. A phrase that was only a tag is spoken as a short silence.
        const spoken = text.replace(STYLE_MARKER, " ").replace(/\s*\[[a-z][a-z-]*\](?!\()\s*/gi, " ").replace(/\s{2,}/g, " ").trim();
        if (!spoken) {
          const pcm = Buffer.alloc(24000 * 2 / 10);                       // 100 ms of silence, 24 kHz s16le
          if (wantsPcm) return res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store" }).send(pcm);
          const h = Buffer.alloc(44);
          h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
          h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
          h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
          return res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(Buffer.concat([h, pcm]));
        }
        // Kokoro is fast enough that a phrase is ready soon after it is asked for. The voice names the language, so none is sent.
        // Kokoro is deterministic and takes no seed; the voice service refuses fields an engine does not have.
        json = { model: "kokoro", input: spoken, voice: settings.kokoroVoice ?? DEFAULT_KOKORO_VOICE, speed: settings.speed ?? 1, response_format: "wav" };
      } else if (settings.runtime === "chatterbox") {
        // Chatterbox has no streaming mode in audio.cpp: one phrase, one WAV.
        // The browser buffers each phrase before playing it either way.
        json = { model: "chatterbox", input: spokenNumbers(text.replace(STYLE_MARKER, " "), settings.language), language: settings.language,
          response_format: "wav", options: { exaggeration: String(settings.exaggeration ?? 0.5), seed: "42" },
          voice_ref: { type: "base64", data: reference!.audio.toString("base64") } };
      } else if (settings.runtime === "audio-cpp") {
        // OmniVoice (the engine this address serves) names a voice registered in
        // its own registry; it reads no reference clip, no instruction and no
        // guidance from a phrase request. Seed is fixed so the sampler stays on
        // one speaker across the phrases a reply is spoken in. A library voice
        // outside that registry is sent as no voice at all - OmniVoice then
        // designs one from the instructions, which is what made every phrase of
        // one reply sound like a different speaker.
        json = { model: "breeze", input: text, stream: true, stream_format: "audio", response_format: "pcm",
          seed: 9, temperature: 0.3, guidance_scale: 4, steps: 32,
          options: { instruction, guidance_scale: String(settings.cfgScale), seed: "42", stream_frames_per_event: "8", stream_lookahead_margin: "4" } };
        const voiceName = settings.voice === "design" ? undefined : omnivoiceVoice(settings.voice, libraryVoice(settings.voice)?.name ?? settings.voice);
        if (voiceName) json.voice = voiceName;
        // The language the reply is expected in, from the person's message (pi/reply-language.ts): the engine reads short
        // or mixed phrases in it, so "Rica ederim" is not read with the English voice prompt.
        const lang = replyLanguage(req.params.id);
        if (lang) json.language = lang;
      } else {
        form = new FormData();
        form.set("text", text); form.set("instruction", instruction); form.set("cfg_scale", String(settings.cfgScale));
        if (reference) {
          form.set("ref_audio", new Blob([new Uint8Array(reference.audio)], { type: "audio/wav" }), reference.filename);
          form.set("ref_text", reference.transcript);
        }
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      let upstream: Response;
      // Cancellation may leave Breeze finishing its current GPU operation.
      // Keep one browser request pending instead of exposing normal contention.
      do {
        const attemptStarted=performance.now();
        upstream = await fetch(settings.breezeUrl, { method: "POST", body: json ? JSON.stringify(json) : form!, headers: voiceHeaders(json ? { "Content-Type": "application/json", ...(wantsOgg && settings.runtime === "audio-cpp" ? { Accept: "audio/ogg, audio/pcm;q=0.9" } : {}) } : undefined), redirect: "error", signal });
        if (upstream.status !== 409) break;
        await upstream.body?.cancel();
        await delay(750, undefined, { signal });
        busyMs+=performance.now()-attemptStarted;
      } while (true);
      const runtimeName = settings.runtime === "chatterbox" ? "Chatterbox" : settings.runtime === "kokoro" ? "Kokoro" : "Breeze";
      if (!upstream.ok) throw new Error(`${runtimeName} returned HTTP ${upstream.status}`);
      // Yue2 returns a complete WAV rather than a streaming TTS/PCM response.
      // Keep the existing voice route and let the browser's normal audio decoder play it.
      if (upstream.headers.get("content-type")?.startsWith("audio/wav")) {
        const wav = Buffer.from(await upstream.arrayBuffer());
        if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
          throw new Error("Yue2 returned an invalid WAV file");
        return res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
      }
      if (settings.runtime === "chatterbox" || settings.runtime === "kokoro") {
        if (!/^audio\/(wav|x-wav|wave|vnd\.wave)\b/.test(upstream.headers.get("content-type") ?? "")) throw new Error(`Expected WAV audio from the ${runtimeName} API`);
        const wav = Buffer.from(await upstream.arrayBuffer());
        // Validate before either branch, so a malformed WAV is never passed on.
        const pcm = wavPcm(wav, runtimeName);
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        if (!wantsPcm) return res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
        return res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Sample-Format": "s16le", "Cache-Control": "no-store" }).send(pcm);
      }
      if (wantsOgg && upstream.headers.get("content-type")?.startsWith("audio/ogg")) {
        // Passed on as it comes: the engine flushes one Ogg page per 20 ms Opus frame.
        if (!upstream.body) throw new Error("Breeze returned no audio stream");
        res.set({ "Content-Type": "audio/ogg; codecs=opus", "X-Sample-Rate": "48000", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Voice-Streaming": "true" });
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        res.flushHeaders();
        const reader = upstream.body.getReader();
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
          }
          if (!bytes) throw new Error("Breeze returned no audio");
          res.end();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return;
      }
      if (!upstream.headers.get("content-type")?.startsWith("audio/pcm") && !(settings.runtime === "audio-cpp" && upstream.headers.get("content-type")?.startsWith("application/octet-stream"))) throw new Error("Expected PCM audio from the Breeze API");
      // 24 kHz unless the engine says otherwise; VoxCPM2's adapter streams 48 kHz, passed on untouched.
      const rate = upstream.headers.get("x-sample-rate") ?? "24000";
      if (!STREAM_RATES.has(rate)) throw new Error(`Unsupported Breeze sample rate: ${rate}`);
      if (wantsPcm) {
        if (!upstream.body) throw new Error("Breeze returned no audio stream");
        res.set({ "Content-Type": "audio/pcm", "X-Sample-Rate": rate, "X-Sample-Format": "s16le", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        if (settings.runtime === "audio-cpp") res.set("X-Voice-Streaming", "true");
        res.set("Server-Timing", `tts_headers;dur=${(performance.now()-speechStarted).toFixed(1)}, tts_busy;dur=${busyMs.toFixed(1)}`);
        res.flushHeaders();
        const reader = upstream.body.getReader();
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (!res.write(value)) await once(res, "drain", { signal: controller.signal });
          }
          if (!bytes || bytes % 2) throw new Error("Breeze returned invalid PCM audio");
          res.end();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return;
      }
      const wav = pcmWav(Buffer.from(await upstream.arrayBuffer()), Number(rate));
      res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
    } catch (e) {
      // Logged so a "Failed to fetch" / broken reply in the browser can be traced (nothing was logged before, 2026-10-19).
      // A cancel from the page itself (barge-in, a newer reply) is the normal case and stays quiet.
      if (!controller.signal.aborted) console.warn(`voice speech failed after ${Math.round(performance.now() - speechStarted)} ms (${res.headersSent ? "mid-stream" : "before audio"}, ${String(text).length} chars): ${(e as Error).message}`);
      if (!res.destroyed) {
        if (res.headersSent) res.destroy(e as Error);
        else res.status(502).json({ error: (e as Error).message });
      }
    }
  });
  return router;
}
