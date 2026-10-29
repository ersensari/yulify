import { api } from "./api";

type Track = { audio: HTMLAudioElement; listeners: Set<() => void>; release: () => void; touched: number };
const tracks = new Map<string, Track>();
const keyOf = (sessionId: string, jobId: string) => `${sessionId}:${jobId}`;

/** Chat, orb and its conversation window all control one audio source per song. */
export const musicAudioElement = (sessionId: string, jobId: string) => tracks.get(keyOf(sessionId, jobId))?.audio;

export const musicPlayingInSession = (sessionId: string) => [...tracks.entries()]
  .some(([key, track]) => key.startsWith(`${sessionId}:`) && !track.audio.paused && !track.audio.ended);

export function subscribeMusic(sessionId: string, jobId: string, changed: () => void): () => void {
  const key = keyOf(sessionId, jobId);
  let track = tracks.get(key);
  if (!track) {
    const audio = new Audio(api.musicAudio(sessionId, jobId));
    audio.controls = true;
    audio.preload = "metadata";
    audio.className = "w-full";
    audio.dataset.musicJob = jobId;
    audio.dataset.musicSession = sessionId;
    const listeners = new Set<() => void>();
    let wasPlaying = false;
    const update = () => {
      const playing = !audio.paused && !audio.ended;
      if (playing) { const track = tracks.get(key); if (track) track.touched = Date.now(); }
      if (playing !== wasPlaying) {
        wasPlaying = playing;
        if (playing) for (const other of tracks.values()) if (other.audio !== audio) other.audio.pause();
        window.dispatchEvent(new CustomEvent("yulify:music-playback", { detail: { sessionId, jobId, playing } }));
      }
      for (const listener of listeners) listener();
    };
    const events = ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata"];
    events.forEach(type => audio.addEventListener(type, update));
    const control = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId || detail?.jobId !== jobId) return;
      if (detail.action === "play" || (detail.action === "toggle" && audio.paused)) void audio.play().catch(() => {});
      else if (detail.action === "pause" || detail.action === "toggle") audio.pause();
    };
    window.addEventListener("yulify:music-control", control);
    track = { audio, listeners, touched: Date.now(), release: () => {
      audio.pause(); update();
      events.forEach(type => audio.removeEventListener(type, update));
      window.removeEventListener("yulify:music-control", control);
      audio.removeAttribute("src"); audio.load();
    } };
    tracks.set(key, track);
  }
  const subscribed = track;
  subscribed.listeners.add(changed);
  changed();
  return () => {
    subscribed.listeners.delete(changed);
    if (!subscribed.listeners.size) { subscribed.release(); tracks.delete(key); }
  };
}

/** The agent and visible buttons use the same audio source and preserve microphone playback events. */
export async function controlMusicPlayer(sessionId: string, action: string, jobId?: string, seconds?: number, expiresAt = Date.now() + 8000) {
  const available = [...tracks.entries()].filter(([key]) => key.startsWith(`${sessionId}:`)).map(([, track]) => track)
    .sort((a, b) => Number(!b.audio.paused) - Number(!a.audio.paused) || b.touched - a.touched);
  const track = jobId ? available.find(track => track.audio.dataset.musicJob === jobId) : available[0];
  if (!track) return { ok: false, status: "no_player", message: "No matching ready music player is loaded in this chat." };
  const audio = track.audio;
  const play = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([audio.play(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { audio.pause(); reject(new Error("Playback did not start before the control expired.")); }, Math.max(0, expiresAt - Date.now() - 500));
      })]);
    } finally { clearTimeout(timer); }
  };
  track.touched = Date.now();
  if (action === "pause") audio.pause();
  else if (action === "stop") { audio.pause(); audio.currentTime = 0; }
  else if (action === "replay") { audio.currentTime = 0; await play(); }
  else if (action === "play") await play();
  else if (action === "seek") {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid seek position");
    audio.currentTime = Number.isFinite(audio.duration) ? Math.min(seconds, audio.duration) : seconds;
  } else if (action !== "status") throw new Error("Unsupported music control");
  return { ok: true, status: "applied", action, jobId: audio.dataset.musicJob, playing: !audio.paused && !audio.ended,
    seconds: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
    availableJobs: available.map(track => track.audio.dataset.musicJob) };
}
