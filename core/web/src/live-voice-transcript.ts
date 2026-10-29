export type LiveVoiceTranscript = {
  streamId: string; utteranceId: string; revision: number; startSample: number;
  speakerLabel?: string; raw: string; text: string; final: boolean; corrected: boolean; status: string;
};

/** Snapshot replacement: never append repeated native ASR hypotheses. */
export function reduceLiveTranscript(previous: LiveVoiceTranscript | undefined, event: Record<string, unknown>): LiveVoiceTranscript | undefined {
  if (event.type === "voice.transcript.reset") {
    if (!event.utterance_id || (previous?.streamId === event.stream_id && previous?.utteranceId === event.utterance_id)) return undefined;
    return previous;
  }
  if (event.type !== "voice.transcript" || event.accepted !== true || !(event.speaker === "ersen" || (event.speaker === null && event.identity_verified === false && event.verification_enabled === false)) || typeof event.text !== "string" || typeof event.raw_text !== "string" || typeof event.stream_id !== "string" || typeof event.utterance_id !== "string" || !Number.isInteger(event.revision) || Number(event.revision) < 0) return previous;
  const startSample = Number(event.start_sample) || 0;
  const revision = Number(event.revision);
  const corrected = event.phase === "corrected";
  if (previous?.streamId === event.stream_id) {
    if (startSample < previous.startSample) return previous;
    if (previous.utteranceId === event.utterance_id && (revision < previous.revision || (revision === previous.revision && previous.corrected && !corrected))) return previous;
  }
  return {streamId: event.stream_id, utteranceId: event.utterance_id, revision, startSample,
    speakerLabel: typeof event.speaker_label === "string" ? event.speaker_label : undefined, raw: event.raw_text.slice(-3000), text: event.text.slice(-3000), final: event.final === true,
    corrected, status: String(event.correction_status || "pending")};
}
