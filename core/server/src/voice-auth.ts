/**
 * The voice service (forgeloop-ai-voice: STT, TTS, speakers, convert) wants `Authorization: Bearer <key>` on every request.
 * VOICE_API_KEY holds that key; unset = no header (older keyless engines keep working). Every fetch to a voice endpoint
 * (transcription, speech, speaker identify/enroll/diarize, Telegram STT/TTS/OGG) merges these headers.
 */
export function voiceHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.VOICE_API_KEY?.trim();
  return { ...(extra ?? {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}
