import { json } from "./api";
import { session } from "./safe-storage";
import { controlMusicPlayer } from "./music-playback";

const client = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const received = new Set<string>();
type Command = { id: string; sessionId: string; target: string; action: string; jobId?: string; seconds?: number; expiresAt: number };
export async function handleClientControl(sessionId: string, command: Command) {
  if (command.sessionId !== sessionId || command.expiresAt <= Date.now() || received.has(command.id)) return;
  if (command.target === "voice" && (session.get("voiceActive") !== sessionId || command.action !== "end")) return;
  if (command.target !== "voice" && command.target !== "music") return;
  // Prefer the visible player tab; a background voice tab still handles ending its own voice mode.
  if (command.target === "music" && document.visibilityState !== "visible" && session.get("voiceActive") !== sessionId) return;
  received.add(command.id);
  if (received.size > 256) received.delete(received.values().next().value!);
  const base = `/api/sessions/${sessionId}/client-controls/${command.id}`;
  const { claimed } = await json<{ claimed: boolean }>(base + "/claim", { method: "POST", body: JSON.stringify({ client }) });
  if (!claimed || command.expiresAt <= Date.now()) return;
  let result: object;
  try {
    if (command.target === "voice") {
      const detail: {sessionId:string;completion?:Promise<void>} = {sessionId};
      window.dispatchEvent(new CustomEvent("yulify:end-voice", { detail }));
      if (!detail.completion) result = { ok: false, status: "unavailable", message: "No active voice controller handled the close request." };
      else {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([detail.completion, new Promise<never>((_,reject) => { timeout = setTimeout(() => reject(new Error("Voice is still closing.")), 8000); })]);
          result = session.get("voiceActive") !== sessionId
            ? { ok: true, status: "applied", voiceActive: false }
            : { ok: false, status: "unavailable", message: "The active voice controller did not close." };
        } finally { if (timeout) clearTimeout(timeout); }
      }
    } else result = await controlMusicPlayer(sessionId, command.action, command.jobId, command.seconds, command.expiresAt);
  } catch (error) {
    result = { ok: false, status: "blocked", message: (error as Error).message || "Playback requires a click in this browser." };
  }
  await json(base + "/result", { method: "POST", body: JSON.stringify({ client, result }) });
}
