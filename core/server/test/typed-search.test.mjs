import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("yulify-typedsearch-");

// Unreachable on purpose: needsTools must fall back to looksLikeToolRequest, with no network call.
process.env.LAYA_URL = "http://127.0.0.1:9/classify";
delete process.env.VOICE_SKIP_FIRST_THINKING;

const { VoiceFirstTurn, typedRequest } = await import("../dist/pi/voice-first.js");
const { looksLikeToolRequest, needsTools } = await import("../dist/pi/tool-need.js");

const TOOLS = [
  "Bunu internette ara",
  "Haberleri araştırır mısın",
  "Dosyayı aç",
  "Bu dosyayı oku",
  "Yeni bir not yaz",
  "Bunu hatırla lütfen",
  "Bugün hava durumu nasıl",
  "Google'da bak",
  "https://example.com sayfasını getir",
  "Bu konuyu web'den bul",
  "Search for the latest news",
  "Can you check my calendar?",
  "Open the file notes.txt",
  "Please fetch the page",
  "What is the price of bitcoin",
];
const CHAT = [
  "merhaba",
  "nasılsın",
  "teşekkürler",
  "tamam",
  "peki",
  "çok teşekkür ederim",
  "Hello, how are you today?",
  "Thanks a lot",
  "Good morning",
  "That is funny",
  "Okay, sounds good",
  "Bence bu fikir güzel",
  "Iyi geceler",
];

test("looksLikeToolRequest: search, lookup, file and web requests need tools in Turkish and English", () => {
  for (const text of TOOLS) assert.equal(looksLikeToolRequest(text), true, text);
  assert.ok(TOOLS.length >= 12);
});

test("looksLikeToolRequest: greetings, thanks and short acknowledgements do not", () => {
  for (const text of CHAT) assert.equal(looksLikeToolRequest(text), false, text);
  assert.ok(CHAT.length >= 12);
});

test("needsTools falls back to the deterministic check when laya is unreachable", async () => {
  assert.equal(await needsTools("bugün hava durumu nasıl"), true);
  assert.equal(await needsTools("merhaba"), false);
});

test("typedRequest strips the context tag, the now line and the speaker block", () => {
  const messages = [
    { role: "user", content: 'old question' },
    {
      role: "user",
      content: '<acp tokens="7" type="text">m00001</acp>\n<now>Monday, 19 October 2026</now>\n<speaker>Ersen</speaker>\nhava durumu nasıl',
    },
  ];
  assert.equal(typedRequest(messages), "hava durumu nasıl");
  assert.equal(typedRequest("not a list"), "");
});

/** Registers the turn's extension on a fake pi and returns its before_provider_request handler. */
function handlerOf(turn) {
  const handlers = {};
  turn.extension({ on: (name, fn) => { handlers[name] = fn; } });
  return handlers.before_provider_request;
}
const llama = { model: { provider: "llama.cpp" } };
const providers = () => ["llama.cpp"];
const yes = async () => true;
const no = async () => false;

test("a spoken turn that needs tools raises a 'none' effort unless the chat chose off", async () => {
  const payload = () => ({ messages: [{ role: "user", content: "[Audio mode]\nsearch the news" }], reasoning_effort: "none" });

  const raised = new VoiceFirstTurn(providers, yes, () => false);
  raised.arm(true);
  const out = await handlerOf(raised)({ payload: payload() }, llama);
  assert.equal(out.reasoning_effort, "medium");
  assert.equal(out.chat_template_kwargs, undefined); // the raise only flips an enable_thinking:false that is already there

  const off = new VoiceFirstTurn(providers, yes, () => true);
  off.arm(true);
  assert.equal(await handlerOf(off)({ payload: payload() }, llama), undefined);
});

test("a set level other than 'none' is left alone when tools are needed", async () => {
  const turn = new VoiceFirstTurn(providers, yes, () => false);
  turn.arm(true);
  const high = { messages: [{ role: "user", content: "[Audio mode]\nsearch the news" }], reasoning_effort: "high" };
  assert.equal(await handlerOf(turn)({ payload: high }, llama), undefined);
});

test("a typed turn that needs no tools is left unchanged, with no thinking switch-off", async () => {
  const turn = new VoiceFirstTurn(providers, no, () => false);
  turn.arm(true, true);
  const payload = { messages: [{ role: "user", content: "merhaba" }] };
  assert.equal(await handlerOf(turn)({ payload }, llama), undefined);
  assert.equal(payload.chat_template_kwargs, undefined);
});

test("a typed turn that needs tools gets the same raise as a spoken one", async () => {
  const turn = new VoiceFirstTurn(providers, yes, () => false);
  turn.arm(true, true);
  const payload = { messages: [{ role: "user", content: "bugün hava durumu nasıl" }], reasoning_effort: "none" };
  const out = await handlerOf(turn)({ payload }, llama);
  assert.equal(out.reasoning_effort, "medium");
  assert.equal(out.chat_template_kwargs, undefined); // the raise only flips an enable_thinking:false that is already there
});

test("a spoken turn that needs no tools keeps the first-call thinking switch-off", async () => {
  const turn = new VoiceFirstTurn(providers, no, () => false);
  turn.arm(true);
  const out = await handlerOf(turn)({ payload: { messages: [{ role: "user", content: "[Audio mode]\nmerhaba" }] } }, llama);
  assert.equal(out.chat_template_kwargs.enable_thinking, false);
  assert.equal(out.reasoning_effort, undefined);
});
