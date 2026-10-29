import { useEffect, useState } from "react";
import { api, type AsrSettings, type AsrSettingsResponse } from "../api";
import { useUnsavedDraft } from "./Modal";
import { btnCls, inputCls } from "./SettingsUi";

const NUMBERS: [keyof AsrSettings, string, string][] = [
  ["silence_ms", "End-of-turn silence (ms)", "Wait this long after speech ends before submitting the transcript."],
  ["interval_seconds", "Transcription interval (seconds)", "Transcribe during speech at this interval. The chunks accumulate until the silence limit; a cut may fall inside a word."],
  ["speech_start_threshold", "Speech-start threshold", "Higher values reject more noise but may miss quiet speech."],
  ["speech_end_threshold", "Speech-end threshold", "Must be lower than the speech-start threshold."],
  ["min_speech_ms", "Minimum voiced audio (ms)", "Ignore shorter sounds. This does not change the owner verification minimum shown below."],
  ["pre_roll_ms", "Audio before speech (ms)", "Keep the beginning of words before speech is detected."],
  ["tail_ms", "Audio after speech (ms)", "Keep captured trailing audio with the transcript segment."],
  ["max_utterance_seconds", "Maximum segment length (seconds)", "Split long speech to bound memory and processing time."],
  ["cpu_threads", "Whisper CPU threads", "CPU work used alongside CUDA decoding. GPU placement is unchanged."],
];

export function SpeechRecognitionSettings({ onPending, saving }: {
  onPending: (save: (() => Promise<void>) | null) => void;
  saving: boolean;
}) {
  const [response, setResponse] = useState<AsrSettingsResponse>();
  const [draft, setDraft] = useState<AsrSettings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const edited = !!draft && JSON.stringify(draft) !== JSON.stringify(response?.settings);
  useUnsavedDraft(edited);
  const load = () => { setError(""); void api.asrSettings().then(value => { setResponse(value); setDraft(value.settings); }, e => setError(e.message)); };
  useEffect(load, []);
  const update = (patch: Partial<AsrSettings>) => { setDraft(value => value && ({...value, ...patch}));  };
  const save = async () => {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const value = await api.setAsrSettings(draft);
      setResponse(value); setDraft(value.settings);
      window.dispatchEvent(new CustomEvent("yulify:asr-settings-changed", {detail:value.settings}));
    } catch (e) { setError((e as Error).message); throw e; }
    finally { setBusy(false); }
  };
  // One Save button owns the entire Voice page. Register this draft with it,
  // and clear only after the ASR service confirms the persisted settings.
  useEffect(() => {
    onPending(edited ? save : null);
    return () => onPending(null);
  }, [edited, draft, onPending]);
  return <section className="rounded-xl border border-line bg-surface/50 p-4 space-y-4" aria-label="Transcription and speaker verification">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium">Transcription and speaker verification</h3>
      <span role="status" className="text-xs text-fg-muted">{response ? (response.settings.enabled ? "Enabled" : "Disabled") : "Unavailable"}</span>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    {!draft || !response ? <button type="button" className={btnCls} onClick={load}>Reload recognition settings</button> : <>
      <fieldset disabled={busy || saving} className="space-y-4">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.enabled} onChange={e => update({enabled:e.target.checked})} />Enable transcription and voice input</label>
        <p className="text-xs text-fg-muted">Applies to live voice and dictation. Saving changes closes active recognition streams; reconnect voice to use the saved settings. Speech playback remains available.</p>
        <div className="rounded-lg border border-line p-3 space-y-2" role="group" aria-label="Speaker verification">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.speaker_verification_enabled} onChange={e => update({speaker_verification_enabled:e.target.checked})} />Speaker verification · recognize my voice</label>
          <p className="text-xs text-fg-muted">{draft.speaker_verification_enabled ? "Check that the enrolled owner is speaking before transcription. Other voices are rejected." : "Transcribe microphone speech without checking who is speaking. Voice identification and the owner-specific VoiceFilter are off; echo cancellation remains active."}</p>
          <p role="status" className="text-xs text-fg-faint">Saved speaker verification: {response.settings.speaker_verification_enabled ? "On" : "Off"}</p>
        </div>
        <label className="block text-xs text-fg-muted">Transcription mode
          <select className={`mt-1.5 ${inputCls}`} value={draft.segmentation_mode} onChange={e => update({segmentation_mode:e.target.value as AsrSettings["segmentation_mode"]})}>
            <option value="vad">VAD · transcribe after silence</option>
            <option value="fixed_interval">Interval previews · submit after silence</option>
          </select>
        </label>
        <p className="text-xs text-fg-faint">Both modes submit after the silence limit. Interval mode displays accumulating previews. Timing is rounded up to {response.vad_frame_ms} ms frames.</p>
        <label className="block text-xs text-fg-muted">Recognition language
          <select className={`mt-1.5 ${inputCls}`} value={draft.language} onChange={e => update({language:e.target.value as AsrSettings["language"]})}>
            <option value="auto">Automatic</option><option value="tr">Turkish</option><option value="en">English</option>
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">{NUMBERS.map(([key, label, help]) => {
          const bounds=response.limits[key];
          const inactive=key==="interval_seconds" && draft.segmentation_mode!=="fixed_interval";
          return <label key={key} className="block text-xs text-fg-muted">{label}
            <input type="number" className={`mt-1.5 ${inputCls}`} min={bounds[0]} max={bounds[1]} step="any" disabled={inactive} value={Number.isFinite(draft[key]) ? Number(draft[key]) : ""} onChange={e => update({[key]:e.target.valueAsNumber})} />
            <span className="mt-1 block text-fg-faint">{help} Range: {bounds[0]}–{bounds[1]}.</span>
          </label>;
        })}</div>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={!draft.speaker_verification_enabled} checked={draft.barge_in_enabled} onChange={e => update({barge_in_enabled:e.target.checked})} />Pause playback on verified speech onset (requires speaker verification)</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.diarization_enabled} onChange={e => update({diarization_enabled:e.target.checked})} />Publish speaker turn labels</label>
        <p className="text-xs text-fg-faint">When speaker verification is on: {response.identity.minimum_seconds}s minimum audio; similarity threshold {response.identity.threshold} (read only). When off, these identity checks and their waiting time are skipped. Model: {response.model}.</p>
      </fieldset>
      {edited && <p role="status" className="text-xs text-fg-muted">Unsaved changes · use Save voice settings below.</p>}
    </>}
  </section>;
}
