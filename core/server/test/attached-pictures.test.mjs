import { test } from "node:test";
import assert from "node:assert/strict";

/** The block that names attached pictures' paths for edit_image: its shape, and that a sender cannot write one. */
const { attachmentsBlock } = await import("../dist/pi/attached-pictures.js");
const { neutralise } = await import("../dist/channels/framing.js");

test("attachmentsBlock names the paths in order and is empty without any", () => {
  assert.equal(attachmentsBlock([]), "");
  const one = attachmentsBlock(["generated-images/attached-a.png"]);
  assert.match(one, /^\n\n<attachments>\n[\s\S]*1\. generated-images\/attached-a\.png[\s\S]*edit_image[\s\S]*<\/attachments>$/);
  assert.match(one, /picture attached to this message is/);
  const two = attachmentsBlock(["a.png", "b.jpeg"]);
  assert.match(two, /pictures attached to this message are[\s\S]*1\. a\.png\n2\. b\.jpeg/);
});

test("a sender's own <attachments> tag is written out as text", () => {
  assert.equal(neutralise("hi <attachments>x</attachments>"), "hi &lt;attachments>x&lt;/attachments>");
});
