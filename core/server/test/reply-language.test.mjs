import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("yulify-replylang-");

const { noteMessage, replyLanguage, forgetReplyLanguage } = await import("../dist/pi/reply-language.js");
const { engineUrl } = await import("../dist/api/voice.js");

/** laya answers by what the text asks; the engine guesses the language by Turkish letters or a few words. */
function fakes(log = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    log.push(String(url));
    if (String(url).includes("classify")) {
      const t = body.text.toLocaleLowerCase("tr");
      const label = /ingilizce (cevap|konuş)|in english/.test(t) ? "en" : /türkçe (devam|konuş)|in turkish/.test(t) ? "tr" : "none";
      return new Response(JSON.stringify({ labels: [label], scores: [0.9] }), { status: 200 });
    }
    const tr = /[çğışöüİ]|rica|peki|harika/i.test(body.input);
    return new Response(JSON.stringify({ language: tr ? "tr" : "en" }), { status: 200 });
  };
}

test("the reply language follows the message, and an explicit request holds until another one", async () => {
  const id = "rl-1";
  forgetReplyLanguage(id);
  const log = [];
  const f = fakes(log);
  await noteMessage(id, "<now>Monday</now> Rica ederim", "http://engine/v1/normalize", f);
  assert.equal(replyLanguage(id), "tr");
  // A message that names no language is not asked of laya.
  assert.ok(!log.some((u) => u.includes("classify")));
  await noteMessage(id, "How are you?", "http://engine/v1/normalize", f);
  assert.equal(replyLanguage(id), "en");
  await noteMessage(id, "Bana İngilizce cevap ver lütfen", "http://engine/v1/normalize", f);
  assert.equal(replyLanguage(id), "en");
  // Asked for English: a Turkish message does not undo it.
  await noteMessage(id, "Peki, nasıl gidiyor?", "http://engine/v1/normalize", f);
  assert.equal(replyLanguage(id), "en");
  await noteMessage(id, "Türkçe devam edelim", "http://engine/v1/normalize", f);
  assert.equal(replyLanguage(id), "tr");
});

test("without the engine or laya, Turkish letters decide and nothing throws", async () => {
  const id = "rl-2";
  forgetReplyLanguage(id);
  const down = async () => { throw new Error("down"); };
  await noteMessage(id, "Güle güle", undefined, down);
  assert.equal(replyLanguage(id), "tr");
  // laya down: the plain way of asking still counts.
  await noteMessage(id, "İngilizce konuşalım", "http://engine/v1/normalize", down);
  assert.equal(replyLanguage(id), "en");
  await noteMessage(id, "Türkçe devam et", "http://engine/v1/normalize", down);
  assert.equal(replyLanguage(id), "tr");
  await noteMessage(id, "   ", undefined, down);
  assert.equal(replyLanguage(id), "tr");
});

test("engine endpoints keep the prefix the engine is reached under", () => {
  assert.equal(engineUrl("https://h/speech-playground/v1/audio/speech", "/health"), "https://h/speech-playground/health");
  assert.equal(engineUrl("http://127.0.0.1:10108/v1/audio/speech", "/v1/normalize"), "http://127.0.0.1:10108/v1/normalize");
  assert.equal(engineUrl("http://127.0.0.1:10108/", "/health"), "http://127.0.0.1:10108/health");
});

test("the voice language endpoint answers with the chat's language, or null", async () => {
  const { default: express } = await import("express");
  const { voiceRouter } = await import("../dist/api/voice.js");
  const { putSetting, createSession } = await import("../dist/db.js");
  putSetting("voice", JSON.stringify({ enabled: true }));
  createSession({ id: "rl-9", title: "rl", workspace: "/tmp", executor: "host" });
  const app = express();
  app.use("/api", voiceRouter());
  const server = app.listen(0);
  try {
    const url = (id) => `http://127.0.0.1:${server.address().port}/api/sessions/${id}/voice/language`;
    forgetReplyLanguage("rl-9");
    assert.deepEqual(await (await fetch(url("rl-9"))).json(), { language: null });
    await noteMessage("rl-9", "Bana İngilizce cevap ver", undefined, fakes());
    assert.deepEqual(await (await fetch(url("rl-9"))).json(), { language: "en" });
  } finally {
    server.close();
  }
});
