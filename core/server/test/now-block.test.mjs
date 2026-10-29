import test from "node:test";
import assert from "node:assert/strict";
import { nowText, withNow } from "../dist/pi/now-block.js";

test("the date and time go ahead of the message, in the given zone", () => {
  const at = new Date("2026-10-19T11:46:00Z");
  assert.equal(nowText(at, "Australia/Melbourne"), "Monday, 19 October 2026 at 22:46 GMT+11:00 (Australia/Melbourne)");
});

test("commands are left alone", () => {
  assert.equal(withNow("/compact", new Date(), "UTC"), "/compact");
  assert.match(withNow("what is on my calendar?", new Date("2026-10-19T11:46:00Z"), "UTC"), /^<now>Monday, 19 October 2026.*<\/now>\n\nwhat is on my calendar\?$/s);
});
