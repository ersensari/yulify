import assert from "node:assert/strict";
import test from "node:test";
import { inProcessHome } from "./server-harness.mjs";

// The side panel's view and input on the agent's browser tab. The page is a fake: no Chrome, no network.
inProcessHome("forgeloop-ai-yulify-browser-viewer-");

const { default: express } = await import("express");
const { browserRouter } = await import("../dist/api/browser.js");
const viewer = await import("../dist/browser/viewer.js");
const db = await import("../dist/db.js");
const { headless } = await import("../dist/extensions/browser-local.js");

const server = express();
server.use(express.json());
server.use("/api", browserRouter());
const http = server.listen(0);
const base = `http://127.0.0.1:${http.address().port}/api`;
test.after(() => {
  http.close();
  db.getDb().close();
});

/** A page that records what it was asked to do. */
function fakePage({ width = 800, height = 600, url = "https://start.test/", title = "Start" } = {}) {
  const calls = [];
  const rec = (...a) => calls.push(a);
  const state = { url, shots: 0 };
  const page = {
    calls,
    url: () => state.url,
    title: async () => title,
    isClosed: () => false,
    viewportSize: () => ({ width, height }),
    evaluate: async () => ({ width, height }),
    screenshot: async (opts) => {
      state.shots++;
      rec("screenshot", opts.type, opts.scale);
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    mouse: {
      click: async (x, y) => rec("click", x, y),
      dblclick: async (x, y) => rec("dblclick", x, y),
      wheel: async (dx, dy) => rec("wheel", dx, dy),
    },
    keyboard: {
      insertText: async (t) => rec("insertText", t),
      press: async (k) => rec("press", k),
    },
    goto: async (u) => {
      state.url = u;
      rec("goto", u);
    },
    goBack: async () => rec("goBack"),
    goForward: async () => rec("goForward"),
    reload: async () => rec("reload"),
  };
  return { page, state };
}

const useProvider = (fn) => viewer.setPageProvider(fn);
test.afterEach(() => useProvider(undefined));

const bodyError = (body) => {
  try {
    viewer.parseInput(body);
  } catch (e) {
    return e;
  }
  return null;
};

test("parseInput accepts each action with finite numbers", () => {
  assert.deepEqual(viewer.parseInput({ action: "click", x: 10, y: 20 }).action, { action: "click", x: 10, y: 20 });
  assert.deepEqual(viewer.parseInput({ action: "dblclick", x: 1, y: 2 }).action, { action: "dblclick", x: 1, y: 2 });
  assert.deepEqual(viewer.parseInput({ action: "scroll", dy: 120 }).action, { action: "scroll", dx: 0, dy: 120 });
  assert.deepEqual(viewer.parseInput({ action: "type", text: "hi" }).action, { action: "type", text: "hi" });
  assert.deepEqual(viewer.parseInput({ action: "key", key: "Enter" }).action, { action: "key", key: "Enter" });
  assert.deepEqual(viewer.parseInput({ action: "back" }).action, { action: "back" });
  assert.deepEqual(viewer.parseInput({ action: "forward" }).action, { action: "forward" });
  assert.deepEqual(viewer.parseInput({ action: "reload" }).action, { action: "reload" });
  assert.equal(viewer.parseInput({ session: "s1", action: "back" }).session, "s1");
});

test("parseInput rejects non-finite and missing coordinates", () => {
  for (const body of [
    { action: "click", x: NaN, y: 1 },
    { action: "click", x: Infinity, y: 1 },
    { action: "click", x: "10", y: 1 },
    { action: "click", x: 1 },
    { action: "scroll", dx: -Infinity },
  ]) {
    const e = bodyError(body);
    assert.ok(e, JSON.stringify(body));
    assert.equal(e.status, 400);
  }
});

test("parseInput rejects unknown actions and bad bodies", () => {
  assert.equal(bodyError({ action: "drag" })?.status, 400);
  assert.equal(bodyError({})?.status, 400);
  assert.equal(bodyError(null)?.status, 400);
  assert.equal(bodyError("click")?.status, 400);
  assert.equal(bodyError({ action: "back", session: 7 })?.status, 400);
});

test("parseInput limits typed text to 2000 characters and at least one", () => {
  assert.equal(bodyError({ action: "type", text: "" })?.status, 400);
  assert.equal(bodyError({ action: "type", text: "x".repeat(2001) })?.status, 400);
  assert.equal(bodyError({ action: "type", text: 5 })?.status, 400);
  assert.equal(viewer.parseInput({ action: "type", text: "x".repeat(2000) }).action.text.length, 2000);
});

test("parseInput allows only the listed keys", () => {
  for (const key of ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "PageDown", "Home", "End", "Control+a", "Meta+a", "Control+c", "Control+v", "Meta+c", "Meta+v"]) {
    assert.equal(viewer.parseInput({ action: "key", key }).action.key, key);
  }
  for (const key of ["F5", "Control+x", "enter", "Alt+F4", "Control+Shift+Delete", ""]) {
    assert.equal(bodyError({ action: "key", key })?.status, 400, key);
  }
});

test("navigation is http or https only, and a bare host gets https", () => {
  assert.equal(viewer.normalizeUrl("example.com"), "https://example.com/");
  assert.equal(viewer.normalizeUrl("  https://example.com/a?b=1  "), "https://example.com/a?b=1");
  assert.equal(viewer.normalizeUrl("http://plain.test/"), "http://plain.test/");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "ftp://x.test/", "", "   ", 42]) {
    const e = bodyError({ action: "navigate", url });
    assert.ok(e, String(url));
    assert.equal(e.status, 400);
  }
});

test("frame returns the viewport JPEG with the page's address and size", async () => {
  const { page } = fakePage({ width: 1024, height: 768, url: "https://a.test/x", title: "Hello" });
  useProvider(async () => page);
  const f = await viewer.frame("chat-1");
  assert.equal(f.jpeg.length, 4);
  assert.equal(f.url, "https://a.test/x");
  assert.equal(f.title, "Hello");
  assert.equal(f.width, 1024);
  assert.equal(f.height, 768);
  assert.deepEqual(page.calls.find((c) => c[0] === "screenshot"), ["screenshot", "jpeg", "css"]);
});

test("frame answers undefined when the browser has no page", async () => {
  useProvider(async () => undefined);
  assert.equal(await viewer.frame(), undefined);
});

test("frame shares one capture between requests within 300 ms", async () => {
  const { page } = fakePage();
  useProvider(async () => page);
  const shots = () => page.calls.filter((c) => c[0] === "screenshot").length;
  const a = await viewer.frame();
  const b = await viewer.frame();
  assert.equal(shots(), 1);
  assert.equal(a, b);
  await new Promise((r) => setTimeout(r, 350));
  await viewer.frame();
  assert.equal(shots(), 2);
});

test("click clamps its position to the viewport", async () => {
  const { page } = fakePage({ width: 800, height: 600 });
  useProvider(async () => page);
  await viewer.performAction(undefined, { action: "click", x: 5000, y: -20 });
  assert.deepEqual(page.calls.find((c) => c[0] === "click"), ["click", 800, 0]);
  await viewer.performAction(undefined, { action: "dblclick", x: 3, y: 599.5 });
  assert.deepEqual(page.calls.find((c) => c[0] === "dblclick"), ["dblclick", 3, 599.5]);
});

test("scroll wheels by the given deltas", async () => {
  const { page } = fakePage();
  useProvider(async () => page);
  const out = await viewer.performAction(undefined, { action: "scroll", dx: 0, dy: -240 });
  assert.deepEqual(page.calls, [["wheel", 0, -240]]);
  assert.equal(out.ok, true);
});

test("type inserts text and presses Enter for each newline", async () => {
  const { page } = fakePage();
  useProvider(async () => page);
  await viewer.performAction(undefined, { action: "type", text: "ab\ncd\n\nef" });
  assert.deepEqual(page.calls, [
    ["insertText", "ab"],
    ["press", "Enter"],
    ["insertText", "cd"],
    ["press", "Enter"],
    ["press", "Enter"],
    ["insertText", "ef"],
  ]);
});

test("key, navigate, back, forward and reload act on the page and answer with its address", async () => {
  const { page, state } = fakePage({ url: "https://start.test/", title: "Start" });
  useProvider(async () => page);
  assert.deepEqual(await viewer.performAction("s", { action: "key", key: "Control+a" }), { ok: true, url: "https://start.test/", title: "Start" });
  const nav = await viewer.performAction("s", { action: "navigate", url: "https://next.test/" });
  assert.equal(nav.url, "https://next.test/");
  assert.equal(state.url, "https://next.test/");
  await viewer.performAction("s", { action: "back" });
  await viewer.performAction("s", { action: "forward" });
  await viewer.performAction("s", { action: "reload" });
  assert.deepEqual(
    page.calls.map((c) => c[0]),
    ["press", "goto", "goBack", "goForward", "reload"],
  );
  assert.deepEqual(page.calls[0], ["press", "Control+a"]);
  assert.deepEqual(page.calls[1], ["goto", "https://next.test/"]);
});

test("the provider gets the session, and a missing tab is a 409", async () => {
  const seen = [];
  useProvider(async (s) => {
    seen.push(s);
    return undefined;
  });
  await assert.rejects(viewer.performAction("chat-9", { action: "back" }), (e) => e.status === 409);
  assert.deepEqual(seen, ["chat-9"]);
});

test("an unreachable browser is a 503 from frame and from input", async () => {
  useProvider(async () => {
    throw new Error("The browser is not reachable at http://127.0.0.1:9222");
  });
  await assert.rejects(viewer.frame(), (e) => e.status === 503);
  await assert.rejects(viewer.performAction(undefined, { action: "back" }), (e) => e.status === 503);
});

test("headless follows BROWSER_HEADLESS when it is set, else the display", () => {
  const saved = { headless: process.env.BROWSER_HEADLESS, display: process.env.DISPLAY };
  try {
    delete process.env.DISPLAY;
    delete process.env.BROWSER_HEADLESS;
    assert.equal(headless(), true);
    process.env.BROWSER_HEADLESS = "0";
    assert.equal(headless(), false);
    process.env.BROWSER_HEADLESS = "false";
    assert.equal(headless(), false);
    process.env.BROWSER_HEADLESS = "1";
    assert.equal(headless(), true);
    process.env.DISPLAY = ":0";
    delete process.env.BROWSER_HEADLESS;
    assert.equal(headless(), false);
  } finally {
    if (saved.headless === undefined) delete process.env.BROWSER_HEADLESS;
    else process.env.BROWSER_HEADLESS = saved.headless;
    if (saved.display === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = saved.display;
  }
});

test("GET /browser/frame answers 200 with the JPEG and its headers", async () => {
  const { page } = fakePage({ width: 900, height: 500, url: "https://a.test/?q=ä b", title: "Título" });
  const asked = [];
  useProvider(async (s) => {
    asked.push(s);
    return page;
  });
  const res = await fetch(`${base}/browser/frame?session=chat-2&w=640`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(decodeURIComponent(res.headers.get("x-page-url")), "https://a.test/?q=ä b");
  assert.equal(decodeURIComponent(res.headers.get("x-page-title")), "Título");
  assert.equal(res.headers.get("x-page-width"), "900");
  assert.equal(res.headers.get("x-page-height"), "500");
  assert.equal((await res.arrayBuffer()).byteLength, 4);
  assert.deepEqual(asked, ["chat-2"]);
});

test("GET /browser/frame answers 204 with no page and 503 when unreachable", async () => {
  useProvider(async () => undefined);
  const none = await fetch(`${base}/browser/frame`);
  assert.equal(none.status, 204);
  useProvider(async () => {
    throw new Error("not reachable");
  });
  const down = await fetch(`${base}/browser/frame`);
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /not reachable/);
});

test("POST /browser/input answers 200 with the tab, and 400 for a bad body", async () => {
  const { page } = fakePage({ url: "https://start.test/", title: "Start" });
  useProvider(async () => page);
  const ok = await fetch(`${base}/browser/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "chat-3", action: "click", x: 4, y: 5 }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, url: "https://start.test/", title: "Start" });
  assert.deepEqual(page.calls.find((c) => c[0] === "click"), ["click", 4, 5]);

  const bad = await fetch(`${base}/browser/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "click", x: "four", y: 5 }),
  });
  assert.equal(bad.status, 400);
});

test("POST /browser/input answers 503 when the browser is unreachable", async () => {
  useProvider(async () => {
    throw new Error("not reachable");
  });
  const res = await fetch(`${base}/browser/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "back" }),
  });
  assert.equal(res.status, 503);
});

test("POST /browser/input refuses a navigation the allowlist forbids, with 403", async () => {
  const { page } = fakePage();
  useProvider(async () => page);
  db.setBrowserAllowlist("allowed.test");
  try {
    const refused = await fetch(`${base}/browser/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "navigate", url: "example.com" }),
    });
    assert.equal(refused.status, 403);
    assert.equal(page.calls.filter((c) => c[0] === "goto").length, 0);

    const allowed = await fetch(`${base}/browser/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "navigate", url: "https://allowed.test/page" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).url, "https://allowed.test/page");
  } finally {
    db.setBrowserAllowlist("");
  }
});

test("POST /browser/input refuses file: navigation with 400, before the allowlist", async () => {
  const { page } = fakePage();
  useProvider(async () => page);
  const res = await fetch(`${base}/browser/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "navigate", url: "file:///etc/passwd" }),
  });
  assert.equal(res.status, 400);
  assert.equal(page.calls.length, 0);
});
