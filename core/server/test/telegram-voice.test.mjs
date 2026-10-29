import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Fake Telegram + speech services, then the real channel module talking to them.
const calls = [];
const telegramState = { sentUpdate: false };
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

const telegram = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (result) => res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, result }));
  const method = req.url.split("/").pop();
  if (req.url.startsWith("/file/")) return res.end(Buffer.from("OggS-fake-voice"));
  calls.push({ method, body: body.toString("utf8") });
  if (method === "getMe") return json({ username: "testbot" });
  if (method === "getUpdates") {
    if (!telegramState.sentUpdate) {
      telegramState.sentUpdate = true;
      return json([
        { update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private", first_name: "E" }, from: { id: 7, first_name: "E" }, voice: { file_id: "F1", duration: 2 } } },
        { update_id: 2, message: { message_id: 2, chat: { id: 99, type: "private" }, from: { id: 99 }, voice: { file_id: "F2" } } },
      ]);
    }
    return setTimeout(() => json([]), 150);
  }
  if (method === "getFile") return json({ file_path: "voice/f1.oga" });
  return json({ message_id: 5 });
});
await new Promise((r) => telegram.listen(0, "127.0.0.1", r));

const speech = http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.url === "/stt") return res.setHeader("content-type", "application/json").end(JSON.stringify({ text: " merhaba nasılsın " }));
  if (req.url === "/tts") { calls.push({ method: "tts", body: body.toString() }); return res.setHeader("content-type", "audio/wav").end(Buffer.from("RIFF-fake-wav")); }
  if (req.url === "/ogg") return res.setHeader("content-type", "audio/ogg").end(Buffer.from("OggS-fake-opus"));
  res.statusCode = 404; res.end();
});
await new Promise((r) => speech.listen(0, "127.0.0.1", r));
const sp = `http://127.0.0.1:${speech.address().port}`;

process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${telegram.address().port}`;
process.env.TELEGRAM_STT_URL = `${sp}/stt`;
process.env.TELEGRAM_TTS_URL = `${sp}/tts`;
process.env.TELEGRAM_OGG_URL = `${sp}/ogg`;
process.env.TELEGRAM_TTS_VOICE = "severin";
const { start } = await import("../../channels/telegram/index.js");

after(() => { telegram.close(); speech.close(); });

test("a voice message is heard, answered as typed text, and the final answer is spoken back; strangers are ignored", async () => {
  const logs = [], asked = [];
  const abort = new AbortController();
  const ctx = {
    config: { botToken: "TOKEN", allowedChatIds: "7" },
    signal: abort.signal,
    log: (m) => logs.push(m),
    ask: async (text, meta) => { asked.push({ text, session: meta.session }); await meta.onReply("Merhaba! Nasıl yardımcı olabilirim?"); return ""; },
  };
  const channel = await start(ctx);
  const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25)); };
  await until(() => calls.some((c) => c.method === "sendVoice"));
  abort.abort();
  await channel.stop();

  assert.deepEqual(asked, [{ text: "merhaba nasılsın", session: "chat:7" }], "the transcript is what the agent is asked");
  const methods = calls.map((c) => c.method);
  assert.ok(methods.includes("getFile"));
  assert.equal(methods.filter((m) => m === "getFile").length, 1, "the stranger's voice message was never downloaded");
  assert.ok(logs.some((l) => l.includes("ignored a message from 99")));
  const sent = calls.filter((c) => c.method === "sendMessage").map((c) => JSON.parse(c.body).text);
  assert.ok(sent.includes("🎤 merhaba nasılsın"), "what was heard is shown");
  assert.ok(sent.includes("Merhaba! Nasıl yardımcı olabilirim?"), "the text answer still goes out");
  const tts = calls.find((c) => c.method === "tts");
  assert.deepEqual(JSON.parse(tts.body), { model: "tts", input: "Merhaba! Nasıl yardımcı olabilirim?", voice: "severin" });
  const voice = calls.find((c) => c.method === "sendVoice");
  assert.ok(voice.body.includes('name="chat_id"') && voice.body.includes("OggS-fake-opus"), "the OGG/Opus reply is uploaded to the right chat");
});
