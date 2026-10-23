import { useEffect, useRef, useState } from "react";
import { LuLoaderCircle, LuMic, LuMicOff } from "react-icons/lu";
import { MiniCpmDuplexRoom, type DuplexRoomState } from "../minicpm-duplex-room";
import { t } from "../i18n";
import { session } from "../safe-storage";

/** Explicit opt-in transport control; the existing sequential voice button remains the rollback path. */
export function MiniCpmDuplexControl({ sessionId, disabled = false, onModeChange, onStatus, onMuteControl, onMutedChange, onInputLevel, onCaptureStatus, onReconnectControl, onError }: { sessionId: string; disabled?: boolean; onModeChange?: (active: boolean) => void; onStatus?: (state: DuplexRoomState, caption: string) => void; onMuteControl?: (control: (() => void) | null) => void; onMutedChange?: (muted: boolean) => void; onInputLevel?: (level: number) => void; onCaptureStatus?: (status: {label: string; level: number; muted: boolean}) => void; onReconnectControl?: (fn: (() => Promise<void>) | null) => void; onError?: (message: string) => void }) {
  const room = useRef<MiniCpmDuplexRoom>();
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
    release.current?.(); release.current = undefined;
    if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
    onModeChange?.(false); onMuteControl?.(null); onReconnectControl?.(null);
    const current = room.current; room.current = undefined;
    await current?.close();
    setState("closed"); onInputLevel?.(0);
  };

  const start = () => {
    if (room.current || disabled) return;
    setMessage(""); onError?.("");
    setCaption(""); captionRef.current = "";
    setToolActivity("");
    const run = async () => {
      try {
        const client = new MiniCpmDuplexRoom(sessionId, {
          state: (next, detail) => { setState(next); onStatus?.(next, caption); if (detail) setMessage(detail); },
          event: event => {
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
            } else if (event.type === "tool.status" && typeof event.name === "string") setToolActivity(`Using ${event.name}…`);
            else if (event.type === "tool.result" && typeof event.name === "string") setToolActivity(`${event.name}: ${String(event.status ?? "finished")}`);
            else if (event.type === "session.error" && typeof event.message === "string") {
              setMessage(event.message);
              if (["duplex_failed", "minicpm_disconnected", "resource_busy", "audio_overflow", "engine_backpressure"].includes(String(event.code))) void stop();
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
        await client.setMicrophoneEnabled(!muted.current && !musicPaused.current);
      } catch (error) {
        const current = room.current; room.current = undefined;
        await current?.close();
        release.current?.(); release.current = undefined;
        if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
        onModeChange?.(false); onMuteControl?.(null); onReconnectControl?.(null);
        setMessage((error as Error).message);
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
    const end = (event: Event) => { if ((event as CustomEvent).detail?.sessionId === sessionId && session.get("voiceActive") === sessionId) void stop(); };
    const playback = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId) return;
      musicPaused.current = !!detail.playing;
      void room.current?.setMicrophoneEnabled(!musicPaused.current && !muted.current);
      onStatus?.(state, caption);
    };
    window.addEventListener("yulify:end-voice", end);
    window.addEventListener("yulify:music-playback", playback);
    return () => { window.removeEventListener("yulify:end-voice", end); window.removeEventListener("yulify:music-playback", playback); };
  }, [sessionId, state, caption]);

  useEffect(() => () => {
    release.current?.(); release.current = undefined;
    void room.current?.close(); room.current = undefined;
    if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    if (session.get("voiceDuplexActive") === sessionId) session.remove("voiceDuplexActive");
  }, [sessionId]);

  return <div className="relative flex items-center gap-1">
    {state === "closed" || state === "error" ? <button type="button" className="prompt-action" disabled={disabled} onClick={start} aria-label={t("Start Gemma E4B full-duplex voice")} title={t("Start Gemma E4B full-duplex voice")}><LuMic aria-hidden /></button> : <button type="button" className="prompt-action" onClick={() => void stop()} aria-label={t("Stop Gemma E4B full-duplex voice")} title={message || `${t("Stop Gemma E4B full-duplex voice")} · ${microphoneLabel}`}>{busy ? <LuLoaderCircle className="animate-spin" aria-hidden /> : <LuMicOff aria-hidden />}</button>}
    {(message || toolActivity || caption) && <span role={state === "error" ? "alert" : undefined} className={`absolute bottom-full right-0 mb-3 w-72 rounded-xl border border-line bg-surface p-3 text-xs shadow-pop ${message ? "text-danger" : "text-fg"}`}>
      {message || toolActivity || <><span className="font-semibold">Gemma E4B · </span>{caption}</>}
    </span>}
  </div>;
}
