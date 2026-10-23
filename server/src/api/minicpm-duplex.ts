import express, { type Router } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource, ServerError } from "livekit-server-sdk";
import { nanoid } from "nanoid";
import { getSession, getVoiceInstructions, getSettings } from "../db.js";
import { voiceInstructions, voiceRulesOn } from "../pi/voice-first.js";
import { CLIENT_CONTROL_RULE } from "../pi/client-control-tools.js";
import { readAgentFile } from "../agent-setup.js";
import { agentHome } from "../agent-home.js";
import { CONTEXT_FILES, SHARED_FILES } from "../pi/context-files.js";
import { understoryOn } from "../features.js";
import { sessions } from "../session-manager.js";

const AGENT_NAME = "yulify-gemma4";
const MAX_ACTIVE = 1;
type ActiveRoom = { room: string; dispatchId: string; sessionId: string; bridgeToken: string; createdAt: number; lastSeenAt: number; calls: Map<string, { controller: AbortController; signature: string; promise: Promise<any> }> };
const active = new Map<string, ActiveRoom>();
const completed = new Map<string, { signature: string; result: any; expiresAt: number }>();
const ROOM_IDLE_TTL_MS = 6 * 60_000; // Worker heartbeat renews live rooms; prune only after six minutes without activity.
let starting = false;

function pruneExpiredRooms() {
  const now = Date.now();
  for (const [id, room] of active) if (now - room.lastSeenAt > ROOM_IDLE_TTL_MS) {
    for (const call of room.calls.values()) call.controller.abort(new Error("Voice room expired."));
    active.delete(id);
  }
  for (const [id, result] of completed) if (result.expiresAt <= now) completed.delete(id);
}

function liveKitConfig() {
  const publicUrl = process.env.LIVEKIT_PUBLIC_URL?.trim();
  const serverUrl = process.env.LIVEKIT_SERVER_URL?.trim();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!publicUrl || !serverUrl || !key || !secret) throw new Error("LiveKit is not configured for Gemma E4B duplex");
  if (!/^wss?:\/\//i.test(publicUrl) || !/^https?:\/\//i.test(serverUrl)) throw new Error("LiveKit public/server URLs use unsupported protocols");
  return { publicUrl, serverUrl, key, secret };
}

/** Authenticated room issuance for the dedicated Gemma E4B LiveKit voice worker. */
export function minicpmDuplexRouter(): Router {
  const router = express.Router();
  router.post("/sessions/:id/voice/gemma4/room", async (req, res) => {
    pruneExpiredRooms();
    const sessionId = String(req.params.id);
    if (!getSession(sessionId)) return res.status(404).json({ error: { code: "session_not_found", message: "Chat session not found", retryable: false } });
    if (starting) return res.status(429).json({ error: { code: "duplex_busy", message: "The Gemma E4B voice session is busy. Try again after it closes.", retryable: true } });
    if (sessions.isBusy(sessionId)) return res.status(409).json({ error: { code: "chat_busy", message: "Finish the current Yulify chat operation before starting voice tools.", retryable: true } });
    starting = true;
    try {
      // Native Gemma audio input with session-authorized tool execution.
      const cfg = liveKitConfig();
      const rooms = new RoomServiceClient(cfg.serverUrl, cfg.key, cfg.secret);
      const dispatches = new AgentDispatchClient(cfg.serverUrl, cfg.key, cfg.secret);
      const current = active.get(sessionId);
      if (current) {
        // A worker restart leaves the browser in the room with no agent. Check
        // LiveKit rather than making the owner wait for the six-minute TTL.
        const found = await rooms.listRooms([current.room]);
        const participants = found.length ? await rooms.listParticipants(current.room) : [];
        const hasAgent = participants.some(p => p.kind === 4); // LiveKit ParticipantInfo.Kind.AGENT
        const recentlyCreated = Date.now() - current.createdAt < 30_000;
        const heartbeatFresh = Date.now() - current.lastSeenAt < 90_000;
        if (found.length && (recentlyCreated || (hasAgent && heartbeatFresh))) {
          return res.status(409).json({ error: { code: "duplex_already_active", message: "This chat already has an active Gemma E4B voice room. Stop it before reconnecting.", retryable: true } });
        }
        if (found.length) await rooms.deleteRoom(current.room);
        for (const call of current.calls.values()) call.controller.abort(new Error("Stale voice room replaced."));
        active.delete(sessionId);
      }
      if (active.size >= MAX_ACTIVE) return res.status(429).json({ error: { code: "duplex_busy", message: "The Gemma E4B voice session is busy. Try again after it closes.", retryable: true } });
      const room = `yulify-${nanoid(20).toLowerCase()}`;
      const identity = `browser-${nanoid(16).toLowerCase()}`;
      await rooms.createRoom({ name: room, emptyTimeout: 60, departureTimeout: 20, maxParticipants: 2 });
      let dispatchId = "";
      try {
        const bridgeToken = randomBytes(32).toString("base64url");
        const dispatch = await dispatches.createDispatch(room, AGENT_NAME, { metadata: JSON.stringify({ sessionId, protocol: "gemma4-duplex-v1", bridgeToken }) });
        dispatchId = dispatch.id;
        const token = new AccessToken(cfg.key, cfg.secret, {
          identity,
          name: "Yulify voice",
          ttl: "5m",
          metadata: JSON.stringify({ sessionId, runtime: "gemma4" }),
          attributes: { "yulify.session_id": sessionId, "yulify.runtime": "gemma4" },
        });
        token.addGrant({
          roomJoin: true,
          room,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: true,
        });
        const jwt = await token.toJwt();
        active.set(sessionId, { room, dispatchId, sessionId, bridgeToken, createdAt: Date.now(), lastSeenAt: Date.now(), calls: new Map() });
        return res.json({ url: cfg.publicUrl, room, identity, token: jwt, expiresInSeconds: 300, capabilities: { audio: true, camera: false, userTranscript: true, tools: true } });
      } catch (error) {
        if (dispatchId) await dispatches.deleteDispatch(dispatchId, room).catch(() => undefined);
        await rooms.deleteRoom(room).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const message = (error as Error).message;
      const missingConfig = message.includes("not configured");
      return res.status(missingConfig ? 503 : 502).json({ error: { code: missingConfig ? "duplex_unavailable" : "room_start_failed", message: missingConfig ? message : "Gemma E4B voice room could not start. Check LiveKit and worker availability.", retryable: !missingConfig } });
    } finally {
      starting = false;
    }
  });

  router.delete("/sessions/:id/voice/gemma4/room", async (req, res) => {
    pruneExpiredRooms();
    const sessionId = String(req.params.id);
    const current = active.get(sessionId);
    if (!current) return res.json({ ok: true });
    // A delayed close from an old browser transport must not close its replacement.
    if (req.body?.room && req.body.room !== current.room) return res.json({ ok: true, replaced: true });
    for (const call of current.calls.values()) call.controller.abort(new Error("Voice room closed."));
    try {
      const cfg = liveKitConfig();
      const rooms = new RoomServiceClient(cfg.serverUrl, cfg.key, cfg.secret);
      const dispatches = new AgentDispatchClient(cfg.serverUrl, cfg.key, cfg.secret);
      await dispatches.deleteDispatch(current.dispatchId, current.room).catch(() => undefined);
      try { await rooms.deleteRoom(current.room); }
      catch (error) { if (!(error instanceof ServerError) || error.code !== "not_found") throw error; }
      if (active.get(sessionId) === current) active.delete(sessionId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(502).json({ error: { code: "room_close_failed", message: "Gemma E4B voice room could not be fully closed. The room expires automatically after its empty timeout.", retryable: true } });
    }
  });
  return router;
}

function authorizedRoom(req: express.Request, sessionId: string): ActiveRoom | undefined {
  pruneExpiredRooms();
  const room = active.get(sessionId);
  const match = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""));
  if (!room || !match) return undefined;
  const got = Buffer.from(match[1]);
  const expected = Buffer.from(room.bridgeToken);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  room.lastSeenAt = Date.now();
  return room;
}

/** Worker-only bridge. It is mounted before portal cookie auth, but each request needs its room-scoped random bearer token. */
export function minicpmDuplexBridgeRouter(): Router {
  const router = express.Router();
  router.post("/sessions/:id/voice/gemma4/bridge/heartbeat", (req, res) => {
    const sessionId = String(req.params.id);
    const room = authorizedRoom(req, sessionId);
    if (!room) return res.status(401).json({ error: "invalid voice bridge credential" });
    room.lastSeenAt = Date.now();
    return res.json({ ok: true, idle_ttl_seconds: ROOM_IDLE_TTL_MS / 1000 });
  });

  router.get("/sessions/:id/voice/gemma4/bridge/tools", async (req, res) => {
    const sessionId = String(req.params.id);
    if (!authorizedRoom(req, sessionId)) return res.status(401).json({ error: "invalid voice bridge credential" });
    try {
      const tools = await sessions.duplexToolSchemas(sessionId);
      const voice_instructions = voiceRulesOn() ? voiceInstructions(getVoiceInstructions()) : "";
      const sessionRow = getSession(sessionId)!;
      const home = agentHome(sessionRow.workspace);
      const role = sessions.speakerRole(sessionId);
      const canonicalFiles = role === "primary" ? (understoryOn() ? CONTEXT_FILES.filter(name => name !== "MEMORY.md") : CONTEXT_FILES) : SHARED_FILES;
      const canonical_context = canonicalFiles.map(name => {
        const content = readAgentFile(name, home).trim();
        return content ? `## ${name}\n${content.slice(0, 700)}` : "";
      }).filter(Boolean).join("\n\n");
      if (Buffer.byteLength(voice_instructions, "utf8") > 8_000) return res.status(413).json({ error: "Yulify voice instructions exceed the duplex context budget; shorten the configured voice instructions." });
      return res.json({ session_id: sessionId, tools, voice_instructions, client_control_instructions: CLIENT_CONTROL_RULE, canonical_context });
    } catch (error) {
      return res.status(503).json({ error: (error as Error).message });
    }
  });

  router.post("/sessions/:id/voice/gemma4/bridge/tools/:callId", async (req, res) => {
    const sessionId = String(req.params.id);
    const room = authorizedRoom(req, sessionId);
    if (!room) return res.status(401).json({ error: "invalid voice bridge credential" });
    const callId = String(req.params.callId);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(callId)) return res.status(400).json({ error: "invalid call_id" });
    const { response_id: responseId, name, arguments: args } = req.body ?? {};
    if (typeof responseId !== "string" || responseId.length > 256 || typeof name !== "string" || name.length > 128 || !args || typeof args !== "object" || Array.isArray(args)) return res.status(400).json({ error: "invalid tool call" });
    const signature = JSON.stringify({ responseId, name, args });
    const cacheKey = `${sessionId}:${callId}`;
    const prior = completed.get(cacheKey);
    if (prior) return prior.signature === signature ? res.json(prior.result) : res.status(409).json({ error: "call_id reused with a different payload" });
    const running = room.calls.get(callId);
    if (running) return running.signature === signature ? res.json(await running.promise) : res.status(409).json({ error: "call_id reused with a different payload" });
    if (room.calls.size >= 4) return res.status(429).json({ error: "too many in-flight voice tool calls" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Voice tool timed out after 120 seconds.")), 120_000);
    const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort(new Error("Worker disconnected.")); };
    res.once("close", abortOnDisconnect);
    const promise = (async () => {
      try {
        const result = await sessions.executeDuplexTool(sessionId, name, args, callId, controller.signal);
        return { call_id: callId, response_id: responseId, name, status: result.isError ? "error" : "success", content: result.content, is_error: result.isError };
      } catch (error) {
        const isCancelled = controller.signal.aborted;
        return { call_id: callId, response_id: responseId, name, status: isCancelled ? "cancelled" : "error", content: [{ type: "text", text: String((error as Error).message || "Tool execution failed.").slice(0, 2000) }], is_error: true };
      } finally {
        clearTimeout(timer);
        res.off("close", abortOnDisconnect);
        room.calls.delete(callId);
      }
    })();
    room.calls.set(callId, { controller, signature, promise });
    const result = await promise;
    completed.set(cacheKey, { signature, result, expiresAt: Date.now() + ROOM_IDLE_TTL_MS });
    while (completed.size > 256) completed.delete(completed.keys().next().value!);
    if (!res.headersSent) return res.json(result);
  });

  router.get("/sessions/:id/voice/gemma4/bridge/config", (req, res) => {
    const sessionId = String(req.params.id);
    if (!authorizedRoom(req, sessionId)) return res.status(401).json({ error: "invalid voice bridge credential" });
    const level = getSession(sessionId)?.thinking_level || getSettings().thinkingLevel || "off";
    return res.json({ thinking_enabled: level !== "off" && level !== "none" });
  });

  router.post("/sessions/:id/voice/gemma4/bridge/events", (req, res) => {
    const sessionId = String(req.params.id);
    if (!authorizedRoom(req, sessionId)) return res.status(401).json({ error: "invalid voice bridge credential" });
    const { response_id: responseId, type, text } = req.body ?? {};
    if (!(["assistant.final", "user.final"].includes(type)) || typeof responseId !== "string" || !responseId || responseId.length > 256 || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "only a final transcript or assistant response is accepted" });
    if (Buffer.byteLength(text, "utf8") > 16_384) return res.status(413).json({ error: "assistant response exceeds the transcript limit" });
    const recorded = type === "user.final" ? sessions.recordDuplexUser(sessionId, responseId, text) : sessions.recordDuplexAssistant(sessionId, responseId, text);
    return res.json({ ok: true, recorded });
  });

  router.delete("/sessions/:id/voice/gemma4/bridge/tools/:callId", (req, res) => {
    const sessionId = String(req.params.id);
    const room = authorizedRoom(req, sessionId);
    if (!room) return res.status(401).json({ error: "invalid voice bridge credential" });
    room.calls.get(String(req.params.callId))?.controller.abort(new Error("Tool call cancelled by duplex worker."));
    return res.json({ ok: true });
  });
  router.delete("/sessions/:id/voice/gemma4/bridge/tools", (req, res) => {
    const sessionId = String(req.params.id);
    const room = authorizedRoom(req, sessionId);
    if (!room) return res.status(401).json({ error: "invalid voice bridge credential" });
    for (const call of room.calls.values()) call.controller.abort(new Error("Duplex worker disconnected."));
    return res.json({ ok: true });
  });
  return router;
}
