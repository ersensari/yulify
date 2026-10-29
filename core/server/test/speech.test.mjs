import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

const home = inProcessHome("yulify-speech-");
const { createSession } = await import("../dist/db.js");
const { speechRouter } = await import("../dist/api/speech.js");

// A stand-in for forgeloop-ai-speech: records what it was sent.
const seen = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, bytes: body.length, text: body.toString("latin1") });
    if (req.url === "/v1/audio/diarize") return res.setHeader("content-type", "text/plain").end("User 1: hello\nUser 2: hi");
    res.setHeader("content-type", "application/json").end(JSON.stringify({ speakers: ["Edward"] }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const app = express();
app.use("/api", speechRouter());
const server = http.createServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.close(); upstream.close(); });

const audio = Buffer.alloc(2048, 1);
const post = (url, body = audio) => fetch(base + url, { method: "POST", body, headers: { "content-type": "audio/wav" } });

test("every route is off (503) until SPEECH_URL is set", async () => {
  delete process.env.SPEECH_URL;
  assert.equal((await fetch(base + "/speech/speakers")).status, 503);
  assert.equal((await post("/sessions/x/speech/diarize")).status, 503);
});

test("speakers are relayed to the speech service", async () => {
  process.env.SPEECH_URL = upstreamUrl;
  const list = await fetch(base + "/speech/speakers");
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { speakers: ["Edward"] });
  assert.equal((await post("/speech/speakers?name=")).status, 400, "a name is required");
  const enrolled = await post("/speech/speakers?name=Edward");
  assert.equal(enrolled.status, 200);
  const sent = seen.at(-1);
  assert.equal(sent.url, "/v1/speakers");
  assert.match(sent.text, /name="name"\r\n\r\nEdward/);
});

test("diarize relays the recording and its options, and save=1 leaves a text file in the workspace", async () => {
  process.env.SPEECH_URL = upstreamUrl;
  const workspace = path.join(home, "chat-ws");
  fs.mkdirSync(workspace, { recursive: true });
  createSession({ id: "s1", title: "t", workspace, executor: "host", auto_title: 0 });

  assert.equal((await post("/sessions/nope/speech/diarize")).status, 404);
  assert.equal((await post("/sessions/s1/speech/diarize", Buffer.alloc(3))).status, 400, "an empty/short body is refused");

  const plain = await post("/sessions/s1/speech/diarize?format=text&language=tr&num_speakers=2");
  assert.equal(plain.status, 200);
  assert.equal(await plain.text(), "User 1: hello\nUser 2: hi");
  const form = seen.at(-1).text;
  assert.match(form, /name="language"\r\n\r\ntr/);
  assert.match(form, /name="num_speakers"\r\n\r\n2/);

  const saved = await (await post("/sessions/s1/speech/diarize?save=1")).json();
  assert.equal(saved.ok, true);
  assert.match(saved.transcriptPath, /^\.meeting-notes\/diarized-.*\.txt$/);
  assert.equal(fs.readFileSync(path.join(workspace, saved.transcriptPath), "utf8"), "User 1: hello\nUser 2: hi\n");
  assert.ok(seen.at(-1).text.includes('name="format"\r\n\r\ntext'), "save asks the service for text");
});
