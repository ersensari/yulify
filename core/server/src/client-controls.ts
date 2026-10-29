import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type ClientCommand = { id: string; sessionId: string; target: "voice" | "music"; action: string; jobId?: string; seconds?: number; expiresAt: number };
type Pending = { command: ClientCommand; owner?: string; resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout>; cleanup: () => void };
export const clientControlEvents = new EventEmitter();
clientControlEvents.setMaxListeners(100);
const pending = new Map<string, Pending>();
const EXPIRES_MS = 10_000;

/** Commands are live-only, expiring and acknowledged; opening history cannot replay them. */
export function requestClientControl(sessionId: string, input: Omit<ClientCommand, "id" | "sessionId" | "expiresAt">, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.resolve({ ok: false, status: "cancelled" });
  if (!clientControlEvents.listenerCount(sessionId)) return Promise.resolve({ ok: false, status: "no_client", message: "No connected client has this chat open." });
  if (pending.size >= 64) return Promise.resolve({ ok: false, status: "busy" });
  return new Promise(resolve => {
    const command: ClientCommand = { ...input, id: randomUUID(), sessionId, expiresAt: Date.now() + EXPIRES_MS };
    const done = (result: unknown) => {
      const entry = pending.get(command.id); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(command.id); entry.cleanup(); resolve(result);
    };
    const abort = () => done({ ok: false, status: "cancelled" });
    const timer = setTimeout(() => done({ ok: false, status: "unavailable", message: "No compatible active client acknowledged this control. Do not claim it succeeded." }), EXPIRES_MS);
    timer.unref();
    pending.set(command.id, { command, resolve: done, timer, cleanup: () => signal?.removeEventListener("abort", abort) });
    signal?.addEventListener("abort", abort, { once: true });
    clientControlEvents.emit(sessionId, command);
  });
}
export function claimClientControl(sessionId: string, id: string, client: string): boolean {
  const entry = pending.get(id);
  if (!entry || entry.command.sessionId !== sessionId || Date.now() >= entry.command.expiresAt || (entry.owner && entry.owner !== client)) return false;
  entry.owner = client; return true;
}
export function finishClientControl(sessionId: string, id: string, client: string, result: unknown): boolean {
  const entry = pending.get(id);
  if (!entry || entry.command.sessionId !== sessionId || entry.owner !== client || Date.now() >= entry.command.expiresAt) return false;
  entry.resolve(result); return true;
}
