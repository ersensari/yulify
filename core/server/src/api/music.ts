import express, { type Router } from "express";
import { Readable } from "node:stream";
import { getSession } from "../db.js";

const BASE = (process.env.MUSIC_SERVICE_URL || "http://127.0.0.1:10111").replace(/\/$/, "");

export function musicRouter(): Router {
  const router = express.Router();
  router.use("/sessions/:id/music/jobs/:jobId", (req, res, next) => {
    if (!getSession(req.params.id)) return res.status(404).json({ error: "Session not found" });
    if (!/^[a-f0-9]{32}$/.test(req.params.jobId)) return res.status(400).json({ error: "Invalid music job" });
    next();
  });
  router.get("/sessions/:id/music/jobs/:jobId", async (req, res) => {
    try {
      const upstream = await fetch(`${BASE}/v1/music/jobs/${req.params.jobId}`, { signal: AbortSignal.timeout(5000) });
      res.status(upstream.status).type("application/json").send(await upstream.text());
    } catch { res.status(503).json({ error: "Music service is unavailable" }); }
  });
  router.post("/sessions/:id/music/jobs/:jobId/score/canvas", async (req, res) => {
    const session = String(req.params.id), jobId = String(req.params.jobId);
    try {
      const upstream = await fetch(`${BASE}/v1/music/jobs/${jobId}`, { signal: AbortSignal.timeout(5000) });
      if (!upstream.ok) return res.status(upstream.status).json({ error: "Music job is unavailable" });
      const job = await upstream.json() as { status?: string; abc?: string; request?: { abc?: string; style?: string } };
      if (job.status !== "done") return res.status(409).json({ error: "Music is not ready" });
      const abc = typeof job.abc === "string" ? job.abc : job.request?.abc;
      if (typeof abc !== "string" || !abc.trim()) return res.status(404).json({ error: "No score available for this song" });
      if (abc.length > 64000 || abc.includes("\0")) return res.status(422).json({ error: "Invalid music score" });
      if (/^```/m.test(abc)) return res.status(422).json({ error: "Invalid ABC score delimiter" });
      // Canvas now belongs to a separate extension and database. The old
      // in-core write/event bridge cannot safely be used against that store.
      return res.status(501).json({ error: "Opening music scores in Canvas is not available yet in this integration." });
    } catch { return res.status(503).json({ error: "Could not open the music score" }); }
  });
  router.get("/sessions/:id/music/jobs/:jobId/audio", async (req, res) => {
    let upstream: Response;
    try {
      upstream = await fetch(`${BASE}/v1/music/jobs/${req.params.jobId}/audio`, { signal: AbortSignal.timeout(15000) });
    } catch { return res.status(503).json({ error: "Music service is unavailable" }); }
    if (!upstream.ok || !upstream.body) return res.status(upstream.status).json({ error: "Music is not ready" });
    res.status(200).set({
      "Content-Type": "audio/ogg",
      "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="yula-song-${req.params.jobId}.ogg"`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length")! } : {}),
    });
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  });
  return router;
}
