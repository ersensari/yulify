import { test } from "node:test";
import assert from "node:assert/strict";

// Plain erasable TypeScript, loaded as it is (the module has no imports).
const { statusPhrase } = await import("../../web/src/status-phrases.ts");

const TR_THINKING = [
  "Bir an düşüneyim.",
  "Bunu düşünmem için bana biraz zaman ver.",
  "Bir bakayım, üzerinde düşünüyorum.",
  "İsteğini düşünüyorum, birazdan dönerim.",
  "Bu konuda bir an kafa yoruyorum.",
];

test("Turkish conversations get the Turkish phrases, by index", () => {
  TR_THINKING.forEach((text, i) => assert.equal(statusPhrase("thinking", "tr", "unused", i), text));
});

test("the still-compacting Turkish text is exact", () => {
  assert.equal(
    statusPhrase("compaction-wait", "tr", "unused"),
    "Konuşmayı hâlâ özetliyorum. Lütfen biraz bekle, hazır olunca haber veririm.",
  );
});

test("a random Turkish thinking phrase is one of the list", () => {
  for (let n = 0; n < 20; n++) assert.ok(TR_THINKING.includes(statusPhrase("thinking", "tr", "unused")));
});

test("English conversations get the English source, not the portal's translation", () => {
  assert.equal(
    statusPhrase("compaction-done", "en", "Bağlam (translated)"),
    "Context compaction is done. I'm ready to continue.",
  );
  assert.equal(statusPhrase("thinking", "en", "translated", 2), "Let me consider that.");
});

test("an unknown language keeps the caller's text unchanged", () => {
  assert.equal(statusPhrase("compaction-stopped", null, "Context compaction stopped before it finished."), "Context compaction stopped before it finished.");
  assert.equal(statusPhrase("thinking", undefined, "Let me think.", 0), "Let me think.");
});
