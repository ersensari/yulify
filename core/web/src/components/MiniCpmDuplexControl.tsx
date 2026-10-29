import { registerVoiceText } from '../voice-text';
import { api } from "../api";
import { reduceLiveTranscript, type LiveVoiceTranscript } from "../live-voice-transcript";
import { useEffect, useRef, useState } from "react";
import { LuLoaderCircle, LuMic, LuMicOff } from "react-icons/lu";
import { MiniCpmDuplexRoom, type DuplexRoomState } from "../minicpm-duplex-room";
import { t } from "../i18n";
import { session } from "../safe-storage";

/** Transport lifecycle for the standard voice control. May render headlessly. */
export function MiniCpmDuplexControl({ sessionId, headless = false, disabled = false, onModeChange, onStatus, onMuteControl, onMutedChange, onInputLevel, onOutputLevel, onCaptureStatus, onReconnectControl, onActivity, onToggleControl, onLiveTranscript, onAcoustics, onError }: { sessionId: string; headless?: boolean; disabled?: boolean; onModeChange?: (active: boolean) => void; onStatus?: (state: DuplexRoomState, caption: string) => void; onMuteControl?: (control: (() => void) | null) => void; onMutedChange?: (muted: boolean) => void; onInputLevel?: (level: number) => void; onOutputLevel?: (level: number) => void; onCaptureStatus?: (status: {label: string; level: number; muted: boolean}) => void; onReconnectControl?: (fn: (() => Promise<void>) | null) => void; onActivity?: (activity: string) => void; onToggleControl?: (toggle: (() => void) | null) => void; onLiveTranscript?: (value: LiveVoiceTranscript | undefined) => void; onAcoustics?: (status:string)=>void; onError?: (message: string) => void }) {
  const liveTranscript = useRef<LiveVoiceTranscript>();
  const room = useRef<MiniCpmDuplexRoom>();
  const attemptId = useRef(0);
  const release = useRef<(() => void) | undefined>();
  const [state, setState] = useState<DuplexRoomState>("closed");
  const [message, setMessage] = useState("");
  const [caption, setCaption] = useState("");
  const [toolActivity, setToolActivity] = useState("");
  const responseId = useRef("");
  const captionRef = useRef("");
  const [microphoneLabel, setMicrophoneLabel] = useState("");
  const muted = useRef(false);
  const musicPaused = useRef(false);
  const busy = state === "connecting" || state === "reconnecting";

  const stop = async () => {
    liveTranscript.current = undefined; onLiveTranscript?.(undefined);
    attemptId.current++;
    release.current?.(); release.current = undefined;
    if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
    onModeChange?.(false); onMuteControl?.(null); onReconnectControl?.(null);
    const current = room.current; room.current = undefined;
    await current?.close();
    setState("closed"); onInputLevel?.(0); onOutputLevel?.(0); onActivity?.("listening");
  };

  const start = () => {
    if (room.current || disabled) return;
    liveTranscript.current = undefined; onLiveTranscript?.(undefined);
    setMessage(""); onError?.("");
    setCaption(""); captionRef.current = "";
    setToolActivity(""); onAcoustics?.("");
    const run = async () => {
      const attempt = ++attemptId.current;
      try {
        const client = new MiniCpmDuplexRoom(sessionId, {
          state: (next, detail) => { setState(next); onStatus?.(next, caption); if (detail) setMessage(detail); },
          event: event => {
            if (event.type === "voice.transcript" || event.type === "voice.transcript.reset") {
              liveTranscript.current = reduceLiveTranscript(liveTranscript.current, event);
              onLiveTranscript?.(liveTranscript.current);
            }
            if (event.type === "voice.activity" && typeof event.activity === "string") onActivity?.(event.activity);
            if (event.type === "voice.output.level" && typeof event.level === "number") onOutputLevel?.(event.level);
            if (event.type === "voice.speaker") {
              if (event.verification_enabled === false) setToolActivity("Transcribing audio · speaker verification off");
              else if (event.matched === true) setToolActivity("Transcribing audio…");
              else if (event.reason !== "silence_or_short_audio") setToolActivity("Speaker verification failed");
            }
            if(event.type==='voice.acoustics') {
              const status=muted.current||musicPaused.current?'paused':String(event.status||'unavailable');
              const hint=event.hint==='near_like'?'Near-like':event.hint==='far_like'?'Reverberant / far-like':'Uncertain proximity';
              onAcoustics?.(status==='measured'?`${hint} · experimental`:status==='warming_up'?'Acoustics warming up…':status==='no_speech'?'Acoustics: waiting for speech':status==='paused'?'Acoustics paused':'Acoustic analysis unavailable');
            }
            if (event.type === "voice.addressing") setToolActivity(event.addressed === true ? "" : "Waiting for speech directed at the assistant…");
            if (event.type === "response.started") { setMessage(""); setToolActivity(""); onError?.(""); }
            if (event.type === "user.transcript.final" && typeof event.text === "string" && !responseId.current.startsWith(`${String(event.response_id)}-`)) {
              captionRef.current = event.text; setCaption(event.text); onStatus?.("connected", event.text);
            }
            if (event.type === "microphone.error" && typeof event.message === "string") onError?.(event.message);
            if (event.type === "microphone.device" && typeof event.label === "string") setMicrophoneLabel(event.label);
            if (event.type === "microphone.capture" && typeof event.level === "number") {
              onInputLevel?.(Math.max(0, Math.min(1, event.level)));
              onCaptureStatus?.({label: String(event.label || "Default microphone"), level: event.level, muted: event.enabled !== true || event.muted === true});
            }
            if (event.type === "session.status") {
              const next = String(event.status || "connected");
              onStatus?.(next as DuplexRoomState, captionRef.current);
              if (next === "connected") setState("connected");
              if (next === "closed") void stop();
            }
            if (event.type === "assistant.text.delta" && typeof event.text === "string") {
              const id = String(event.response_id ?? "");
              const nextCaption = id && id !== responseId.current ? event.text : captionRef.current + event.text;
              if (id) responseId.current = id;
              captionRef.current = nextCaption; setCaption(nextCaption); onStatus?.("connected", nextCaption);
            } else if (event.type === "tool.status" && typeof event.name === "string") setToolActivity(event.name === "ask_strata" ? "Working on the detailed task…" : event.name.startsWith("music_") ? "Processing the music request…" : event.name.includes("search") ? "Searching…" : "Processing your request…");
            else if (event.type === "tool.result" && typeof event.name === "string") setToolActivity(event.status === "success" ? "" : "The operation could not be completed.");
            else if (event.type === "session.error" && typeof event.message === "string") {
              setMessage(event.message); onError?.(event.message);
              if (["duplex_failed", "minicpm_disconnected", "resource_busy", "audio_overflow", "engine_backpressure", "asr_settings_changed"].includes(String(event.code))) void stop();
            }
          },
        });
        room.current = client;
        session.set("voiceActive", sessionId);
        session.set("voiceDuplexActive", sessionId);
        onModeChange?.(true);
        const toggleMute = () => { muted.current = !muted.current; void client.setMicrophoneEnabled(!muted.current && !musicPaused.current); onMutedChange?.(muted.current); };
        onMuteControl?.(toggleMute);
        onReconnectControl?.(async () => {
          try {
            onError?.(""); setMessage("");
            await client.reconnectMicrophone();
            await client.setMicrophoneEnabled(!muted.current && !musicPaused.current);
          } catch (error) { const message = (error as Error).message; setMessage(message); onError?.(message); }
        });
        await client.connect();
        if (attempt !== attemptId.current) return;
        await client.setMicrophoneEnabled(!muted.current && !musicPaused.current);
      } catch (error) {
        if (attempt !== attemptId.current) return;
        const current = room.current; room.current = undefined;
        await current?.close();
        release.current?.(); release.current = undefined;
        if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
        onModeChange?.(false); onMuteControl?.(null); onReconnectControl?.(null);
        setMessage((error as Error).message); onError?.((error as Error).message);
        setState("error");
      }
    };
    if (!navigator.locks) { setMessage("This browser cannot prevent two voice engines from using the same chat at once."); setState("error"); return; }
    let announce!: (acquired: boolean) => void;
    const acquired = new Promise<boolean>(resolve => { announce = resolve; });
    void navigator.locks.request(`voice:${sessionId}`, { ifAvailable: true }, async lock => {
      if (!lock) { announce(false); return; }
      announce(true);
      await new Promise<void>(resolve => { release.current = resolve; });
    }).catch(error => { setMessage((error as Error).message); setState("error"); announce(false); });
    void acquired.then(ok => {
      if (!ok) { setMessage("Voice is already active for this chat."); setState("error"); return; }
      void run();
    });
  };

  useEffect(() => {
    onToggleControl?.(() => { if (room.current) void stop(); else start(); });
    return () => onToggleControl?.(null);
  });

  useEffect(() => {
    const changed=() => { if (room.current) void stop(); };
    const check=() => { if (room.current) void api.asrSettings().then(value => {
      if (!value.settings.enabled) { setMessage("Speech recognition is disabled in Settings > Voice."); void stop(); }
    }).catch(() => { /* transport reports its own connection failure */ }); };
    window.addEventListener("yulify:asr-settings-changed",changed);
    const timer=window.setInterval(check,10000);
    return () => { window.removeEventListener("yulify:asr-settings-changed",changed); window.clearInterval(timer); };
  }, [sessionId]);

  useEffect(()=>registerVoiceText(sessionId,text=>{const client=room.current;if(!client)return Promise.reject(new Error('Voice is not connected.'));return client.sendText(text);}),[sessionId]);

  useEffect(() => {
    const end = (event: Event) => {
      const detail = (event as CustomEvent<{sessionId:string;completion?:Promise<void>}>).detail;
      if (detail?.sessionId !== sessionId || session.get("voiceActive") !== sessionId) return;
      const closing = stop();
      detail.completion = closing;
      void closing.catch(error => { const message = (error as Error).message; setMessage(message); onError?.(message); });
    };
    const interrupt = (event: Event) => { if ((event as CustomEvent).detail?.sessionId === sessionId) void room.current?.interrupt(); };
    const playback = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId) return;
      musicPaused.current = !!detail.playing;
      void room.current?.setMusicPlaying(musicPaused.current);
      void room.current?.setMicrophoneEnabled(!musicPaused.current && !muted.current);
      onStatus?.(state, caption);
    };
    window.addEventListener("yulify:interrupt-voice", interrupt);
    window.addEventListener("yulify:end-voice", end);
    window.addEventListener("yulify:music-playback", playback);
    return () => { window.removeEventListener("yulify:interrupt-voice", interrupt); window.removeEventListener("yulify:end-voice", end); window.removeEventListener("yulify:music-playback", playback); };
  }, [sessionId, state, caption]);

  useEffect(() => () => {
    release.current?.(); release.current = undefined;
    void room.current?.close(); room.current = undefined;
    if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
  }, [sessionId]);

  if (headless) return null;
  return <div className="relative flex items-center gap-1">
    {state === "closed" || state === "error" ? <button type="button" className="prompt-action" disabled={disabled} onClick={start} aria-label={t("Start Yula voice")} title={t("Start Yula voice")}><LuMic aria-hidden /></button> : <button type="button" className="prompt-action" onClick={() => void stop()} aria-label={t("Stop Yula voice")} title={message || `${t("Stop Yula voice")} · ${microphoneLabel}`}>{busy ? <LuLoaderCircle className="animate-spin" aria-hidden /> : <LuMicOff aria-hidden />}</button>}
    {(message || toolActivity || caption) && <span role={state === "error" ? "alert" : undefined} className={`absolute bottom-full right-0 mb-3 w-72 rounded-xl border border-line bg-surface p-3 text-xs shadow-pop ${message ? "text-danger" : "text-fg"}`}>
      {message || toolActivity || <><span className="font-semibold">Yula voice · </span>{caption}</>}
    </span>}
  </div>;
}
