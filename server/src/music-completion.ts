import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data-dir.js";

type Pending = { sessionId: string; jobId: string; since: number };
/** Watch newly submitted jobs on the server, independently of opened chat/player views. */
export class MusicCompletion {
  private pending = new Map<string, Pending>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private file = path.join(DATA_DIR, "music-pending.json");
  private base = (process.env.MUSIC_SERVICE_URL || "http://127.0.0.1:10111").replace(/\/$/, "");
  constructor(private notify: (sessionId: string, jobId: string, error?: string) => void) {}
  resume() {
    try {
      const rows: Pending[] = JSON.parse(readFileSync(this.file, "utf8"));
      for (const row of rows) {
        if (typeof row.sessionId === "string" && /^[a-f0-9]{32}$/.test(row.jobId) && Number.isFinite(row.since)) this.start(row);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") console.error("[music] Could not restore completion watchers", error);
    }
  }
  watch(sessionId: string, result: any) {
    const text = typeof result === "string" ? result : Array.isArray(result?.content)
      ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";
    const ids = new Set<string>([...text.matchAll(/MUSIC_JOB\s+([a-f0-9]{32})\s+queued/g)].map(m => m[1]));
    for (const jobId of ids) this.start({ sessionId, jobId, since: Date.now() });
  }
  private save() {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify([...this.pending.values()]));
    renameSync(this.file + ".tmp", this.file);
  }
  private start(row: Pending) {
    const key = `${row.sessionId}:${row.jobId}`;
    if (this.pending.has(key)) return;
    this.pending.set(key, row);
    this.save();
    const poll = async () => {
      let finished = false;
      try {
        const response = await fetch(`${this.base}/v1/music/jobs/${row.jobId}`, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const job = await response.json() as { status?: string; error?: string };
          if (job.status === "done" || job.status === "error") {
            this.notify(row.sessionId, row.jobId, job.status === "error" ? job.error || "Bilinmeyen hata" : undefined);
            finished = true;
          }
        } else if (response.status === 404) {
          this.notify(row.sessionId, row.jobId, "Music job not found.");
          finished = true;
        }
        if (!finished && Date.now() - row.since > 24 * 60 * 60 * 1000) {
          this.notify(row.sessionId, row.jobId, "Music generation timed out.");
          finished = true;
        }
      } catch (error) { console.warn("[music] Completion check will retry:", String(error)); }
      if (finished) {
        this.pending.delete(key); this.timers.delete(key); this.save();
      } else {
        const timer = setTimeout(() => { void poll(); }, 2500);
        timer.unref(); this.timers.set(key, timer);
      }
    };
    void poll();
  }
}
