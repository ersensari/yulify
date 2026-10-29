import { test } from "node:test";
import assert from "node:assert/strict";

// Plain erasable TypeScript, loaded as it is (voice.ts itself pulls in the page's i18n).
const { stripUnspoken } = await import("../../web/src/speech-strip.ts");
const said = (text) => stripUnspoken(text).replace(/\s+/g, " ").trim();

test("the [Audio mode] marker is never read aloud", () => {
  assert.equal(said("[Audio mode] Merhaba, nasılsın?"), "Merhaba, nasılsın?");
  assert.equal(said("Tamam. [audio mode]: hazırım"), "Tamam. hazırım");
});

test("bare web addresses are dropped", () => {
  assert.equal(said("Bak https://example.com/a?b=1 burada."), "Bak burada.");
  assert.equal(said("Kaynak: www.example.org/path, devam."), "Kaynak: , devam.");
  assert.equal(said("(bkz. https://x.example/y) tamam"), "(bkz. ) tamam");
});

test("other bracketed words and plain text are left alone", () => {
  assert.equal(said("Dedi ki [laughter] çok güzel"), "Dedi ki [laughter] çok güzel");
  assert.equal(said("example.com değil, sadece kelime"), "example.com değil, sadece kelime");
});
