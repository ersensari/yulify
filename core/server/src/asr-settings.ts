/** Production Whisper settings live in the ASR service's persistent volume. */
export interface AsrSettings {
  enabled: boolean;
  speaker_verification_enabled: boolean;
  segmentation_mode: "vad" | "fixed_interval";
  interval_seconds: number;
  silence_ms: number;
  speech_start_threshold: number;
  speech_end_threshold: number;
  min_speech_ms: number;
  pre_roll_ms: number;
  tail_ms: number;
  max_utterance_seconds: number;
  language: "auto" | "tr" | "en";
  cpu_threads: number;
  barge_in_enabled: boolean;
  diarization_enabled: boolean;
}
export interface AsrSettingsResponse {
  settings: AsrSettings;
  limits: Record<string, [number, number, number]>;
  status: "enabled" | "disabled";
  identity: { required: boolean; minimum_seconds: number; threshold: number; policy: string };
  model: string;
  vad_frame_ms: number;
}
const endpoint = () => `${(process.env.ASR_CONTROL_URL || "http://127.0.0.1:10126").replace(/\/$/, "")}/v1/asr/settings`;
export class AsrSettingsError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
export async function asrSettings(value?: unknown): Promise<AsrSettingsResponse> {
  let response: Response;
  try {
    response = await fetch(endpoint(), {
      method: value === undefined ? "GET" : "PUT",
      ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new AsrSettingsError("Speech recognition service is unavailable. Settings were not changed.", 503); }
  const body = await response.json();
  if (!response.ok) throw new AsrSettingsError(body.error || "Could not update speech recognition settings", response.status === 400 ? 400 : 503);
  return body as AsrSettingsResponse;
}
export async function requireAsrEnabled(): Promise<AsrSettingsResponse> {
  const value=await asrSettings();
  if (!value.settings.enabled)
    throw new AsrSettingsError("Speech recognition is disabled. Enable it in Settings > Voice.", 403);
  return value;
}
