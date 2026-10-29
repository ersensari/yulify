import type { Identify } from "./speaker.js";
import type { Transcribe, Transcript } from "./session.js";
import { voiceHeaders } from "../voice-auth.js";

/** An OpenAI-compatible transcription endpoint (speaches, faster-whisper-server, audio.cpp) asked for verbose JSON. */
export function whisperTranscribe(url: string, model?: string, timeoutMs = 120000, identify?: Identify): Transcribe {
  return async (wav, { language, signal, final }) => {
    // Who is talking is asked while Whisper works, for whole utterances only (identify never rejects).
    const speaker = final && identify ? identify(wav, signal) : undefined;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "recording.wav");
    // Segments carry the confidences cleanTranscript filters on, and the language that was detected.
    form.set("response_format", "verbose_json");
    if (language) form.set("language", language);
    if (model) form.set("model", model);
    const upstream = await fetch(url, { method: "POST", body: form, headers: voiceHeaders(), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (!upstream.ok) throw new Error(`Whisper returned HTTP ${upstream.status}`);
    const body = await upstream.json() as Partial<Transcript>;
    if (typeof body.text !== "string") throw new Error("Whisper returned no transcript");
    const who = await speaker;
    return { text: body.text, language: typeof body.language === "string" ? body.language : undefined, segments: Array.isArray(body.segments) ? body.segments : undefined, ...(who ? { speaker: who } : {}) };
  };
}
