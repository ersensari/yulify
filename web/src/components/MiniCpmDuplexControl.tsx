import { useEffect, useRef, useState } from "react";
import { LuCamera, LuLoaderCircle, LuMic, LuMicOff } from "react-icons/lu";
import { MiniCpmDuplexRoom, type DuplexRoomState } from "../minicpm-duplex-room";
import { t } from "../i18n";
import { session } from "../safe-storage";

/** Explicit opt-in transport control; the existing sequential voice button remains the rollback path. */
export function MiniCpmDuplexControl({ sessionId, disabled = false, onModeChange, onStatus, onMuteControl, onMutedChange }: { sessionId: string; disabled?: boolean; onModeChange?: (active: boolean) => void; onStatus?: (state: DuplexRoomState, caption: string) => void; onMuteControl?: (control: (() => void) | null) => void; onMutedChange?: (muted: boolean) => void }) {
  const room = useRef<MiniCpmDuplexRoom>();
  const release = useRef<(() => void) | undefined>();
  const [state, setState] = useState<DuplexRoomState>("closed");
  const [message, setMessage] = useState("");
  const [caption, setCaption] = useState("");
  const [toolActivity, setToolActivity] = useState("");
  const responseId = useRef("");
  const captionRef = useRef("");
  const [camera, setCamera] = useState(false);
  const muted = useRef(false);
  const musicPaused = useRef(false);
  const busy = state === "connecting" || state === "reconnecting";

  const stop = async () => {
    release.current?.(); release.current = undefined;
    if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
    onModeChange?.(false); onMuteControl?.(null);
    const current = room.current; room.current = undefined;
    await current?.close();
    setCamera(false);
    setState("closed");
  };

  const start = () => {
    if (room.current || disabled) return;
    setMessage("");
    setCaption(""); captionRef.current = "";
    setToolActivity("");
    const run = async () => {
      try {
        const client = new MiniCpmDuplexRoom(sessionId, {
          state: (next, detail) => { setState(next); onStatus?.(next, caption); if (detail) setMessage(detail); },
          event: event => {
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
        onModeChange?.(true);
        const toggleMute = () => { muted.current = !muted.current; void client.setMicrophoneEnabled(!muted.current && !musicPaused.current); onMutedChange?.(muted.current); };
        onMuteControl?.(toggleMute);
        await client.connect();
        await client.setMicrophoneEnabled(!muted.current && !musicPaused.current);
      } catch (error) {
        const current = room.current; room.current = undefined;
        await current?.close();
        release.current?.(); release.current = undefined;
        if (session.get("voiceActive") === sessionId) session.remove("voiceActive");
        onModeChange?.(false); onMuteControl?.(null);
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
  }, [sessionId]);

  const toggleCamera = async () => {
    try { await room.current?.setCamera(!camera); setCamera(value => !value); }
    catch (error) { setMessage((error as Error).message); }
  };

  return <div className="relative flex items-center gap-1">
    {state === "connected" && <button type="button" className="prompt-action" onClick={() => void toggleCamera()} aria-label={camera ? t("Turn camera off") : t("Turn camera on")} title={camera ? t("Camera on · click to turn it off") : t("Camera off · click to opt in")}><LuCamera aria-hidden /></button>}
    {state === "closed" || state === "error" ? <button type="button" className="prompt-action" disabled={disabled} onClick={start} aria-label={t("Start MiniCPM full-duplex voice")} title={t("Start MiniCPM full-duplex voice")}><LuMic aria-hidden /></button> : <button type="button" className="prompt-action" onClick={() => void stop()} aria-label={t("Stop MiniCPM full-duplex voice")} title={message || t("Stop MiniCPM full-duplex voice")}>{busy ? <LuLoaderCircle className="animate-spin" aria-hidden /> : <LuMicOff aria-hidden />}</button>}
    {(message || toolActivity || caption) && <span role={state === "error" ? "alert" : undefined} className={`absolute bottom-full right-0 mb-3 w-72 rounded-xl border border-line bg-surface p-3 text-xs shadow-pop ${message ? "text-danger" : "text-fg"}`}>
      {message || toolActivity || <><span className="font-semibold">MiniCPM · </span>{caption}</>}
    </span>}
  </div>;
}
