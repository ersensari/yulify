/** One loopback service owns Whisper, anonymous diarization and retained examples. */
export interface SpeakerTurn {
  id: number; speaker: string; start: number; end: number; text: string;
  start_sample: number; end_sample: number; overlap: boolean;
  sample_id?: string | null; language?: string | null;
}
export interface TranscriptionSnapshot {
  id: string; status: "recording" | "processing" | "completed" | "failed" | "interrupted";
  recording?:boolean;audio_saved?:boolean;recorded_seconds?:number;transcription_status?:string;recovery_notice?:string;parts?:{index:number;file:string;start:number;end:number;summary_status?:string;summary?:string;error?:string}[];
  sample_rate: number; samples: number; next_sequence: number; turns: SpeakerTurn[]; error?: string | null;
}
export const asrBase = () => (process.env.ASR_CONTROL_URL || "http://127.0.0.1:10126").replace(/\/$/, "");
export async function sharedAsr<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${asrBase()}/v1/asr${route}`, {
    ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {error?: string};
    throw new Error(body.error || `Transcription service returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
