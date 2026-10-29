import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The owner's own Chrome: the endpoint file, the platform profile paths, the mode switch. No Chrome, no network.
const own = await import("../dist/extensions/browser-own.js");

test("parseActivePort reads the port and the websocket path", () => {
  assert.deepEqual(own.parseActivePort("9222\n/devtools/browser/abc-123\n"), {
    port: 9222,
    ws: "ws://127.0.0.1:9222/devtools/browser/abc-123",
  });
});

test("parseActivePort accepts no trailing newline and CRLF", () => {
  assert.deepEqual(own.parseActivePort("9333\r\n/devtools/browser/x"), { port: 9333, ws: "ws://127.0.0.1:9333/devtools/browser/x" });
});

test("parseActivePort rejects a missing second line, a relative path, garbage and port 0", () => {
  assert.equal(own.parseActivePort("9222\n"), null);
  assert.equal(own.parseActivePort("9222"), null);
  assert.equal(own.parseActivePort("9222\ndevtools/browser/x"), null);
  assert.equal(own.parseActivePort("hello\n/devtools/browser/x"), null);
  assert.equal(own.parseActivePort(""), null);
  assert.equal(own.parseActivePort("0\n/devtools/browser/x"), null);
  assert.equal(own.parseActivePort("70000\n/devtools/browser/x"), null);
});

test("defaultProfileDir gives each platform its Chrome profile", () => {
  assert.equal(own.defaultProfileDir("darwin", "/Users/ersen"), "/Users/ersen/Library/Application Support/Google/Chrome");
  assert.equal(own.defaultProfileDir("linux", "/home/ersen"), "/home/ersen/.config/google-chrome");
  assert.equal(
    own.defaultProfileDir("win32", "C:\\Users\\ersen", { LOCALAPPDATA: "C:\\Users\\ersen\\AppData\\Local" }),
    "C:\\Users\\ersen\\AppData\\Local\\Google\\Chrome\\User Data",
  );
  assert.equal(own.defaultProfileDir("win32", "C:\\Users\\ersen", {}), "C:\\Users\\ersen\\AppData\\Local\\Google\\Chrome\\User Data");
});

test("ownProfileDir honours BROWSER_OWN_PROFILE", () => {
  assert.equal(own.ownProfileDir({ BROWSER_OWN_PROFILE: "/custom/profile" }), "/custom/profile");
});

test("readDebugEndpoint reads the file in a directory, and returns null without it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "own-chrome-"));
  try {
    assert.equal(own.readDebugEndpoint(dir), null);
    assert.equal(own.ownChromeReady(dir), false);
    writeFileSync(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/uuid-1\n");
    assert.deepEqual(own.readDebugEndpoint(dir), { port: 9222, ws: "ws://127.0.0.1:9222/devtools/browser/uuid-1" });
    assert.equal(own.ownChromeReady(dir), true);
    writeFileSync(path.join(dir, "DevToolsActivePort"), "garbage");
    assert.equal(own.readDebugEndpoint(dir), null);
    assert.equal(own.ownChromeReady(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDebugEndpoint returns null for a directory that does not exist", () => {
  assert.equal(own.readDebugEndpoint(path.join(os.tmpdir(), "own-chrome-does-not-exist-xyz")), null);
});

test("ownChromeEnabled is on only for 1 or true", () => {
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "1" }), true);
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "true" }), true);
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "TRUE" }), true);
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "0" }), false);
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "false" }), false);
  assert.equal(own.ownChromeEnabled({ BROWSER_OWN_CHROME: "" }), false);
  assert.equal(own.ownChromeEnabled({}), false);
});

test("the not-open message tells the owner what to switch on", () => {
  assert.match(own.OWN_CHROME_NOT_OPEN, /chrome:\/\/inspect\/#remote-debugging/);
  assert.match(own.OWN_CHROME_NOT_OPEN, /Allow remote debugging for this browser instance/);
});
