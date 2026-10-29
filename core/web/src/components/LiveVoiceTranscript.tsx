import type { LiveVoiceTranscript as Transcript } from "../live-voice-transcript";

export function LiveVoiceTranscript({ value }: { value?: Transcript }) {
  if (!value?.raw) return null;
  return <p className="voice-input-transcript" aria-label="Live transcription" aria-live="polite">{value.speakerLabel && <span>{value.speakerLabel}: </span>}{value.raw}</p>;
}
