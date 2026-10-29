/**
 * Speaker-diarized transcripts for voice notes and recorded meetings, backed by
 * forgeloop-ai-speech (docker/speech in the forgeloop-ai repo). Off unless
 * SPEECH_URL is set (e.g. http://127.0.0.1:10093): every route answers 503
 * without it, so a deployment that does not run the service is unchanged.
 *
 * Meeting notes (meeting-notes.ts) transcribe fixed ~15 s chunks and cannot tell
 * speakers apart, because telling them apart needs the whole recording. This is
 * the whole-recording path: the client uploads the finished audio, gets
 * "User 1: ... User 2: ..." back, and `save=1` also leaves it as a text file in
 * the chat's workspace so the agent can read and summarize it like any file.
 *
 * Nothing here keeps the audio: the body is held in memory only while it is
 * forwarded, the same rule as the meeting-notes chunk route.
 */
import express, { type Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { getSession } from "../db.js";
import { asrBase, sharedAsr } from "../shared-asr.js";
import { voiceHeaders } from "../voice-auth.js";

const MAX_AUDIO = "512mb";

const speechUrl = (): string | undefined => process.env.SPEECH_URL?.trim().replace(/\/+$/, "") || undefined;

/** One-line, filesystem-safe stamp for a saved transcript. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export function speechRouter(): Router {
  const router = express.Router();
  const raw = express.raw({ type: () => true, limit: MAX_AUDIO });

  const guard = (res: express.Response) => {
    const base = speechUrl();
    if (!base) res.status(503).json({ error: "Speaker recognition is not configured (SPEECH_URL)" });
    return base;
  };

  const audioForm = (body: unknown): FormData | undefined => {
    if (!Buffer.isBuffer(body) || body.length < 44) return undefined;
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(body)], { type: "application/octet-stream" }), "audio");
    return form;
  };

  const relay = async (res: express.Response, url: string, init: RequestInit) => {
    try {
      const upstream = await fetch(url, { ...init, headers: voiceHeaders(init.headers as Record<string, string> | undefined), redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
      const text = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  };

  /** Raw audio body (any format ffmpeg reads). Query: language, num_speakers, format=json|text|srt, save=1. */
  router.post("/sessions/:id/speech/diarize", raw, async (req, res) => {
    const base = guard(res);
    if (!base) return;
    const session = getSession(String(req.params.id));
    if (!session) return res.status(404).json({ error: "Session not found" });
    const form = audioForm(req.body);
    if (!form) return res.status(400).json({ error: "An audio recording is required as the request body" });
    const format = ["json", "text", "srt"].includes(String(req.query.format)) ? String(req.query.format) : "json";
    form.set("format", format === "json" && req.query.save === "1" ? "text" : format);
    if (typeof req.query.language === "string" && /^[a-z]{2,3}$/.test(req.query.language)) form.set("language", req.query.language);
    const n = Number(req.query.num_speakers);
    if (Number.isInteger(n) && n > 0 && n <= 20) form.set("num_speakers", String(n));

    if (req.query.save !== "1") return relay(res, `${base}/v1/audio/diarize`, { method: "POST", body: form });
    try {
      const upstream = await fetch(`${base}/v1/audio/diarize`, { method: "POST", body: form, headers: voiceHeaders(), redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
      if (!upstream.ok) throw new Error(`Speech service returned HTTP ${upstream.status}`);
      const text = await upstream.text();
      const dir = path.join(session.workspace, ".meeting-notes");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `diarized-${stamp()}.txt`);
      fs.writeFileSync(file, `${text}\n`);
      res.json({ ok: true, transcriptPath: path.relative(session.workspace, file), text });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  /** Enrolled voices, so "me" is named in transcripts. */
  router.get("/speech/speakers", async (_req, res) => {
    const base = guard(res);
    if (base) await relay(res, `${base}/v1/speakers`, { method: "GET" });
  });

  router.post("/speech/speakers", raw, async (req, res) => {
    const base = guard(res);
    if (!base) return;
    const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!name || name.length > 64) return res.status(400).json({ error: "name (1-64 chars) is required" });
    const form = audioForm(req.body);
    if (!form) return res.status(400).json({ error: "An audio recording of the speaker is required as the request body" });
    form.set("name", name);
    await relay(res, `${base}/v1/speakers`, { method: "POST", body: form });
  });

  router.delete("/speech/speakers/:name", async (req, res) => {
    const base = guard(res);
    if (base) await relay(res, `${base}/v1/speakers/${encodeURIComponent(String(req.params.name))}`, { method: "DELETE" });
  });

  router.get("/voice/speaker-examples", async (req,res) => {
    const offset=Number(req.query.offset||0);
    if(!Number.isInteger(offset)||offset<0||offset>10000)return res.status(400).json({error:"Invalid page offset"});
    try {res.json(await sharedAsr(`/examples?offset=${offset}`));}
    catch(e) {res.status(502).json({error:(e as Error).message});}
  });
  router.get("/voice/speaker-examples/suggestions", async (req,res) => {
    const offset=Number(req.query.offset||0);
    if(!Number.isInteger(offset)||offset<0||offset>10000)return res.status(400).json({error:"Invalid page offset"});
    try {res.json(await sharedAsr(`/examples/suggestions?offset=${offset}`));}
    catch(e) {res.status(502).json({error:(e as Error).message});}
  });
  router.get("/voice/speaker-examples/:id/audio", async(req,res) => {
    if (!/^[a-f0-9]{32}$/.test(String(req.params.id)))return res.status(400).json({error:"Invalid example id"});
    try {
      const upstream=await fetch(`${asrBase()}/v1/asr/examples/${req.params.id}/audio`,{redirect:"error",signal:AbortSignal.timeout(15_000)});
      if(!upstream.ok)return res.status(upstream.status).json({error:"Speaker example not found or expired"});
      res.setHeader("Cache-Control","no-store");res.type("audio/wav").send(Buffer.from(await upstream.arrayBuffer()));
    }catch(e){res.status(502).json({error:(e as Error).message});}
  });
  router.put("/voice/speaker-examples/:id", async(req,res)=>{
    if (!/^[a-f0-9]{32}$/.test(String(req.params.id)))return res.status(400).json({error:"Invalid example id"});
    try{res.json(await sharedAsr(`/examples/${req.params.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({person:req.body?.person})}));}
    catch(e){res.status(502).json({error:(e as Error).message});}
  });
  router.delete("/voice/speaker-examples/:id", async(req,res)=>{
    if (!/^[a-f0-9]{32}$/.test(String(req.params.id)))return res.status(400).json({error:"Invalid example id"});
    try{res.json(await sharedAsr(`/examples/${req.params.id}`,{method:"DELETE"}));}
    catch(e){res.status(502).json({error:(e as Error).message});}
  });

  return router;
}
