import { useEffect, useRef, useState } from "react";
import { LuDownload, LuLoaderCircle, LuPause, LuPlay, LuShare2, LuMusic2 } from "react-icons/lu";
import { api, json } from "../api";
import { musicAudioElement, subscribeMusic } from "../music-playback";
import { canvasMessage } from "../canvas-feed";
import { t } from "../i18n";

type Job = { id: string; status: "queued" | "waiting_for_gpu" | "loading" | "running" | "done" | "error"; error?: string; abc?: string; request?: { abc?: string } };

export function musicJobId(output?: string): string | undefined {
  return output?.match(/MUSIC_JOB\s+([a-f0-9]{32})/)?.[1];
}

export function MusicPlayer({ sessionId, jobId, compact = false, controlsOnly = false, onPlay }: {
  sessionId: string; jobId: string; compact?: boolean; controlsOnly?: boolean; onPlay?: (playing: boolean) => void;
}) {
  const [job, setJob] = useState<Job>({ id: jobId, status: "queued" });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const sourceAudio = () => musicAudioElement(sessionId, jobId);
  const [openingScore, setOpeningScore] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const audioHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(api.musicJob(sessionId, jobId));
        if (!response.ok) throw new Error(`Music job status returned HTTP ${response.status}`);
        const next = await response.json() as Job;
        if (!live) return;
        setJob(next);
        if (next.status !== "done" && next.status !== "error") timer = window.setTimeout(poll, 2500);
      } catch {
        if (live) timer = window.setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [sessionId, jobId]);
  useEffect(() => {
    if (job.status !== "done") return;
    const release = subscribeMusic(sessionId, jobId, () => {
      const element = musicAudioElement(sessionId, jobId);
      if (!element) return;
      setPlaying(!element.paused && !element.ended);
      setPosition(element.currentTime);
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
    });
    const element = musicAudioElement(sessionId, jobId)!;
    const host = audioHost.current;
    if (!controlsOnly && host) host.appendChild(element);
    return () => {
      if (element.parentNode === host) element.remove();
      release();
    };
  }, [controlsOnly, sessionId, jobId, job.status]);
  useEffect(() => {
    onPlay?.(playing);
    return () => { onPlay?.(false); };
  }, [playing, onPlay]);
  const openScore = async () => {
    setOpeningScore(true); setScoreError("");
    try {
      const canvas = await json<{ id: string; [key: string]: unknown }>(api.musicScoreCanvas(sessionId, jobId), { method: "POST" });
      canvasMessage(sessionId, { type: "focus", canvas });
    } catch (error) { setScoreError((error as Error).message); }
    finally { setOpeningScore(false); }
  };
  const share = async () => {
    const response = await fetch(api.musicAudio(sessionId, jobId));
    if (!response.ok) throw new Error("Music file is not ready to share");
    const file = new File([await response.blob()], `yula-song-${jobId}.ogg`, { type: "audio/ogg" });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Yula song" });
    else window.location.assign(api.musicAudio(sessionId, jobId, true));
  };
  if (job.status === "error") return <div className="my-2 rounded-xl border border-danger/25 bg-danger/5 p-3 text-sm text-danger">{job.error || t("Music generation failed")}</div>;
  if (job.status !== "done") {
    const label = job.status === "loading" ? t("Loading music model")
      : job.status === "running" ? t("Composing music")
      : job.status === "waiting_for_gpu" ? t("Waiting for GPU") : t("Music queued");
    return <div className={`my-2 flex items-center gap-2 rounded-xl border border-line bg-raised/60 p-3 text-sm text-fg-muted${compact ? " max-w-sm" : ""}`}><LuLoaderCircle className="animate-spin" aria-hidden />{label}</div>;
  }
  const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const remoteControls = <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
    <button type="button" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent hover:bg-accent/20" aria-label={t(playing ? "Pause" : "Play")} title={t(playing ? "Pause" : "Play")} onClick={() => window.dispatchEvent(new CustomEvent("yulify:music-control", { detail: { sessionId, jobId, action: "toggle" } }))}>{playing ? <LuPause aria-hidden /> : <LuPlay aria-hidden />}</button>
    {compact ? <span className="min-w-0 flex-1 truncate">{t(playing ? "Music playing" : "Play")}</span> : <>
      <span className="shrink-0 tabular-nums">{clock(position)}</span>
      <input type="range" className="min-w-0 flex-1 accent-accent" aria-label={t("Playback position")} min={0} max={duration || 0} step={0.1} value={Math.min(position, duration)} disabled={!duration} onChange={event => { const element = sourceAudio(); if (element) { element.currentTime = Number(event.target.value); setPosition(element.currentTime); } }} />
      <span className="shrink-0 tabular-nums">{clock(duration)}</span>
    </>}
  </div>;
  if (controlsOnly && compact) return <div className="my-2 max-w-sm rounded-xl border border-line bg-raised/60 p-2">{remoteControls}</div>;
  return <div className={`my-2 rounded-xl border border-line bg-raised/60 p-3${compact ? " max-w-sm" : ""}`}>
    {controlsOnly ? remoteControls : <div ref={audioHost} />}
    {scoreError && <p role="alert" className="mt-2 text-xs text-danger">{scoreError}</p>}
    <div className="mt-2 flex flex-wrap justify-end gap-2">
      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5 disabled:opacity-50" disabled={openingScore || !(job.abc || job.request?.abc)} title={job.abc || job.request?.abc ? t("View score in canvas") : t("No score available for this song")} onClick={() => void openScore()}>{openingScore ? <LuLoaderCircle className="animate-spin" aria-hidden /> : <LuMusic2 aria-hidden />}{t("View score in canvas")}</button>
      <a className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5" href={api.musicAudio(sessionId, jobId, true)} download><LuDownload aria-hidden />{t("Download")}</a>
      <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-fg-muted hover:bg-fg/5" onClick={() => void share()}><LuShare2 aria-hidden />{t("Share")}</button>
    </div>
  </div>;
}
