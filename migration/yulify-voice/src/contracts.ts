/**
 * Migration contracts only. Nothing imports or registers these yet.
 * Keep LiveKit room ownership and authorization in the existing bridge until
 * the portal explicitly provides a supported extension ingress.
 */
export interface LegacyVoiceSettings {
  enabled: boolean;
  whisperUrl: string;
  /** Historical field name: the endpoint may serve Breeze, OmniVoice or VoxCPM. */
  breezeUrl: string;
  instruction: string;
  voice: string;
  language: string;
  cfgScale: number;
  runtime?: "breeze" | "audio-cpp" | "chatterbox" | "kokoro" | "none";
  sttModel?: string;
  exaggeration?: number;
  kokoroVoice?: string;
  speed?: number;
  responseInstructions?: string;
  skipThinkingProviders?: string[];
}

/** A library identity remains stable across a future settings migration. */
export interface LegacyVoiceIdentity {
  id: string;
  name: string;
  kind: "design" | "clone";
  instruction: string;
  transcript?: string;
}

/** Settings, credentials, voice files and engine details stay server-side. */
export interface LegacyVoiceReader {
  settings(): LegacyVoiceSettings;
  identities(): LegacyVoiceIdentity[];
}

/**
 * Interface for a future extraction from Yulify's real speech implementation.
 * It must preserve engine-specific request construction and cancellation.
 * This is not an implementation or an upstream VoiceProvider registration.
 */
export interface YulifySpeechBackend {
  transcribe(wav16kMonoS16le: Uint8Array, options: { purpose: "voice" | "dictation"; signal: AbortSignal }): Promise<string>;
  speak(text: string, options: { voiceId?: string; signal: AbortSignal }): Promise<SpeechStream>;
}

/** 48 kHz must be converted before the v0.2 VoiceProvider's 24 kHz PCM contract. */
export type SpeechStream = {
  body: ReadableStream<Uint8Array>;
  format: "pcm_s16le_mono";
  sampleRate: 24000 | 48000;
} | {
  body: ReadableStream<Uint8Array>;
  format: "wav";
};
