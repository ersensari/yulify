/**
 * The shared memory (mem0, the forgeloop-ai-yulify-mem0 container), for the Memory page.
 * The portal is the one door: the apps and the browser reach /api/mem0/* here,
 * with the portal's own login, and this forwards it to mem0's HTTP routes with
 * the bearer token. The token never leaves the server.
 *
 * Only /memories routes are forwarded. mem0's /mcp endpoint is reached by the
 * MCP gateway, not through the portal, so it stays unreachable from here.
 *
 * Off unless MEM0_BEARER_TOKEN is set: every route answers 503 without it, the
 * same way the speech routes answer without SPEECH_URL.
 */
import express, { type Router } from "express";

const DEFAULT_MEM0_URL = "http://127.0.0.1:3900";
/** Adding a memory runs mem0's fact extraction through an LLM, which can take a while. */
const UPSTREAM_TIMEOUT_MS = 120_000;

export function mem0Url(): string {
  return (process.env.MEM0_URL?.trim() || DEFAULT_MEM0_URL).replace(/\/+$/, "");
}

export function mem0Router(): Router {
  const router = express.Router();

  // Mounted at /mem0, so req.url is the rest of the path with its query string.
  router.use("/mem0", async (req, res) => {
    const token = process.env.MEM0_BEARER_TOKEN?.trim();
    if (!token) return res.status(503).json({ error: "Memory is not configured (MEM0_BEARER_TOKEN is not set)" });
    if (!/^\/memories(\/|\?|$)/.test(req.url)) return res.status(404).json({ error: "Not found" });

    const hasBody = req.method === "POST" || req.method === "PUT";
    // The portal's JSON parser has already read the body, so it is sent on as JSON.
    const body = hasBody ? JSON.stringify(req.body ?? {}) : undefined;
    try {
      const upstream = await fetch(`${mem0Url()}${req.url}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await upstream.text();
      res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
    } catch (e) {
      res.status(502).json({ error: `Memory service is unreachable: ${(e as Error).message}` });
    }
  });

  return router;
}
