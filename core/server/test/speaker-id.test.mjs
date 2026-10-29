import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { whisperTranscribe } = await import("../dist/voice-stt/whisper.js");
const { speakerIdUrl, speakerIdentify } = await import("../dist/voice-stt/speaker.js");

// Stand-ins for Whisper (speaches) and forgeloop-ai-speech.
let whisperHits = 0, idHits = 0, idMode = "ok";
const whisper = http.createServer((req, res) => {
  whisperHits++;
  req.resume();
  req.on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ text: " merhaba dünya ", language: "tr", segments: [] })));
});
const speech = http.createServer((req, res) => {
  idHits++;
  req.resume();
  req.on("end", () => {
    if (idMode === "hang") return; // never answers: the caller's timeout must cut it
    if (idMode === "500") return res.writeHead(500).end("boom");
    res.setHeader("content-type", "application/json");
    if (idMode === "nobody") return res.end(JSON.stringify({ name: null, score: null, matched: false, reason: "no_enrolled_speakers" }));
    if (idMode === "short") return res.end(JSON.stringify({ name: null, score: null, matched: false, reason: "too_short" }));
    if (idMode === "other") return res.end(JSON.stringify({ name: "ersen", score: 0.12, matched: false, reliable: true, reason: "below_threshold" }));
    res.end(JSON.stringify({ name: "ersen", score: 0.71, matched: true, reliable: true, threshold: 0.32, scores: { ersen: 0.71 } }));
  });
});
await new Promise((r) => whisper.listen(0, "127.0.0.1", r));
await new Promise((r) => speech.listen(0, "127.0.0.1", r));
const whisperUrl = `http://127.0.0.1:${whisper.address().port}/v1/audio/transcriptions`;
const identifyUrl = `http://127.0.0.1:${speech.address().port}/v1/speakers/identify`;
after(() => { whisper.close(); speech.close(); whisper.closeAllConnections?.(); speech.closeAllConnections?.(); });
beforeEach(() => { whisperHits = 0; idHits = 0; idMode = "ok"; });

const wav = Buffer.alloc(4096, 1);
const opts = (extra = {}) => ({ language: undefined, signal: new AbortController().signal, ...extra });

test("speakerIdUrl is off unless VOICE_SPEAKER_ID is on AND SPEECH_URL is set", () => {
  delete process.env.VOICE_SPEAKER_ID; delete process.env.SPEECH_URL;
  assert.equal(speakerIdUrl(), undefined);
  process.env.SPEECH_URL = "http://127.0.0.1:10093/";
  assert.equal(speakerIdUrl(), undefined, "SPEECH_URL alone does not switch it on");
  process.env.VOICE_SPEAKER_ID = "0";
  assert.equal(speakerIdUrl(), undefined);
  process.env.VOICE_SPEAKER_ID = "1";
  assert.equal(speakerIdUrl(), "http://127.0.0.1:10093/v1/speakers/identify", "trailing slash trimmed");
  delete process.env.SPEECH_URL;
  assert.equal(speakerIdUrl(), undefined, "the flag alone does not either");
  delete process.env.VOICE_SPEAKER_ID;
});

test("a final transcript carries the speaker; Whisper's text is untouched", async () => {
  const t = await whisperTranscribe(whisperUrl, "m", 5000, speakerIdentify(identifyUrl))(wav, opts({ final: true }));
  assert.equal(t.text, " merhaba dünya ");
  assert.equal(t.language, "tr");
  assert.deepEqual(t.speaker, { name: "ersen", score: 0.71, matched: true, reliable: true });
  assert.equal(whisperHits, 1);
  assert.equal(idHits, 1);
});

test("interim previews never ask who is speaking", async () => {
  const t = await whisperTranscribe(whisperUrl, "m", 5000, speakerIdentify(identifyUrl))(wav, opts());
  assert.equal(t.speaker, undefined);
  assert.equal(idHits, 0);
  assert.equal(whisperHits, 1);
});

test("without an identify function nothing changes", async () => {
  const t = await whisperTranscribe(whisperUrl, "m", 5000)(wav, opts({ final: true }));
  assert.equal(t.speaker, undefined);
  assert.equal(idHits, 0);
});

test("a voice below the threshold is reported as unmatched, not dropped", async () => {
  idMode = "other";
  const t = await whisperTranscribe(whisperUrl, undefined, 5000, speakerIdentify(identifyUrl))(wav, opts({ final: true }));
  assert.deepEqual(t.speaker, { name: "ersen", score: 0.12, matched: false, reliable: true });
});

for (const mode of ["500", "nobody", "short"]) {
  test(`speech service answering "${mode}" gives no verdict and the transcript still arrives`, async () => {
    idMode = mode;
    const t = await whisperTranscribe(whisperUrl, undefined, 5000, speakerIdentify(identifyUrl))(wav, opts({ final: true }));
    assert.equal(t.text, " merhaba dünya ");
    assert.equal(t.speaker, undefined);
  });
}

test("a hanging speech service is cut by its own timeout and does not delay the transcript", async () => {
  idMode = "hang";
  const started = Date.now();
  const t = await whisperTranscribe(whisperUrl, undefined, 5000, speakerIdentify(identifyUrl, 300))(wav, opts({ final: true }));
  assert.equal(t.text, " merhaba dünya ");
  assert.equal(t.speaker, undefined);
  assert.ok(Date.now() - started < 3000, "bounded by the identify timeout, not by Whisper's");
});

test("an unreachable speech service is harmless", async () => {
  const t = await whisperTranscribe(whisperUrl, undefined, 5000, speakerIdentify("http://127.0.0.1:1/v1/speakers/identify", 500))(wav, opts({ final: true }));
  assert.equal(t.text, " merhaba dünya ");
  assert.equal(t.speaker, undefined);
});
