import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

// A stand-in for the mem0 container: records what the proxy sent it.
const seen = [];
let nextStatus = 200;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    const status = nextStatus;
    nextStatus = 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: status === 200, path: req.url }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const { mem0Router, mem0Url } = await import("../dist/api/mem0.js");

// Mounted the way server.ts mounts it, with the portal's JSON parser in front.
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", mem0Router());
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/api/mem0`;
after(() => {
  server.close();
  upstream.close();
});

test("the upstream defaults to the mem0 container on loopback and trims a trailing slash", () => {
  delete process.env.MEM0_URL;
  assert.equal(mem0Url(), "http://127.0.0.1:3900");
  process.env.MEM0_URL = `${upstreamUrl}/`;
  assert.equal(mem0Url(), upstreamUrl);
});

test("every route answers 503 with a clear error when MEM0_BEARER_TOKEN is unset", async () => {
  process.env.MEM0_URL = upstreamUrl;
  delete process.env.MEM0_BEARER_TOKEN;
  const before = seen.length;
  const res = await fetch(`${base}/memories?limit=5`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /MEM0_BEARER_TOKEN/);
  assert.equal((await fetch(`${base}/memories`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
  assert.equal(seen.length, before, "nothing is forwarded without a token");
});

test("list, search, add, update and delete are forwarded with the bearer token", async () => {
  process.env.MEM0_URL = upstreamUrl;
  process.env.MEM0_BEARER_TOKEN = "t0ken";

  const list = await fetch(`${base}/memories?limit=5&offset=10`);
  assert.equal(list.status, 200);
  const listed = seen.at(-1);
  assert.equal(listed.method, "GET");
  assert.equal(listed.url, "/memories?limit=5&offset=10");
  assert.equal(listed.auth, "Bearer t0ken");

  await fetch(`${base}/memories/search?q=coffee&limit=3`);
  assert.equal(seen.at(-1).url, "/memories/search?q=coffee&limit=3");

  const added = await fetch(`${base}/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Likes espresso" }),
  });
  assert.equal(added.status, 200);
  const post = seen.at(-1);
  assert.equal(post.method, "POST");
  assert.equal(post.contentType, "application/json");
  assert.deepEqual(JSON.parse(post.body), { content: "Likes espresso" });

  await fetch(`${base}/memories/abc-123`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Likes ristretto" }),
  });
  assert.equal(seen.at(-1).method, "PUT");
  assert.equal(seen.at(-1).url, "/memories/abc-123");
  assert.deepEqual(JSON.parse(seen.at(-1).body), { content: "Likes ristretto" });

  const del = await fetch(`${base}/memories/abc-123`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(seen.at(-1).method, "DELETE");
  assert.equal(seen.at(-1).url, "/memories/abc-123");
});

test("upstream status codes pass through unchanged", async () => {
  process.env.MEM0_URL = upstreamUrl;
  process.env.MEM0_BEARER_TOKEN = "t0ken";
  nextStatus = 404;
  const res = await fetch(`${base}/memories/missing`, { method: "DELETE" });
  assert.equal(res.status, 404);
});

test("paths other than /memories are not forwarded (the MCP endpoint stays private)", async () => {
  process.env.MEM0_URL = upstreamUrl;
  process.env.MEM0_BEARER_TOKEN = "t0ken";
  const before = seen.length;
  assert.equal((await fetch(`${base}/mcp`)).status, 404);
  assert.equal((await fetch(`${base}/memoriesX`)).status, 404);
  assert.equal(seen.length, before);
});

test("an unreachable memory service answers 502, not a crash", async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  process.env.MEM0_URL = `http://127.0.0.1:${port}`;
  process.env.MEM0_BEARER_TOKEN = "t0ken";
  const res = await fetch(`${base}/memories`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unreachable/);
});
