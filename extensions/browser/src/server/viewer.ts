import type { Page } from "playwright-core";
import { browserPage, browserTab } from "./tools.js";

/**
 * A live view of the agent's browser tab, and a way to act on it, for the native
 * app's side panel. The agent drives the same tab through tools.ts; this is the
 * person's hand on it, so it does nothing the agent could not do on the same page.
 */

/** An error with the HTTP status the route should answer with. */
export class BrowserViewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Frame {
  jpeg: Buffer;
  url: string;
  title: string;
  width: number;
  height: number;
}

export type ViewerAction =
  | { action: "click" | "dblclick"; x: number; y: number }
  | { action: "scroll"; dx: number; dy: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string }
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" };

export interface ViewerInput {
  session?: string;
  action: ViewerAction;
}

export type PageProvider = (sessionId?: string) => Promise<Page | undefined>;

/** Replaceable for tests; the default is the tab the agent's tools use. */
let provider: PageProvider = browserPage;
/** Opens a tab when there is none; off while a test provider is set. */
let opener: PageProvider | undefined = (id) => browserTab(id ?? "viewer");
export function setPageProvider(next?: PageProvider): void {
  provider = next ?? browserPage;
  opener = next ? undefined : (id) => browserTab(id ?? "viewer");
}

/** An unreachable browser is a 503 for the caller, whatever the transport error said. */
async function providePage(sessionId?: string): Promise<Page | undefined> {
  try {
    return await provider(sessionId);
  } catch (e) {
    throw new BrowserViewError(503, (e as Error).message);
  }
}

const CACHE_MS = 300;
const cache = new WeakMap<Page, { at: number; frame: Frame }>();

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  const size = page.viewportSize();
  if (size) return size;
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

/**
 * The viewport of the tab as a JPEG. Not downscaled: Playwright cannot resize a
 * capture, and the image library is not a dependency, so maxWidth is accepted
 * but the image is the page's own size. Two panels asking within 300 ms share one capture.
 */
export async function frame(sessionId?: string, maxWidth = 1100): Promise<Frame | undefined> {
  const page = await providePage(sessionId);
  if (!page) return undefined;
  const hit = cache.get(page);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.frame;
  const size = await viewport(page);
  const jpeg = await page.screenshot({ type: "jpeg", quality: 55, scale: "css" });
  const result: Frame = { jpeg, url: page.url(), title: await page.title(), width: size.width, height: size.height };
  cache.set(page, { at: Date.now(), frame: result });
  return result;
}

const KEYS = new Set([
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "PageUp", "PageDown", "Home", "End",
  "Control+a", "Meta+a", "Control+c", "Control+v", "Meta+c", "Meta+v",
]);

const TEXT_MAX = 2000;

const bad = (message: string) => new BrowserViewError(400, message);

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`${name} must be a finite number`);
  return value;
}

/**
 * http and https only. A bare host like "example.com" gets https://; anything
 * else with a scheme (file:, javascript:, data:) is refused, not repaired.
 */
export function normalizeUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw bad("url required");
  const s = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw bad(`"${raw}" is not a web address`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(`Only http and https addresses can be opened, not ${u.protocol}`);
  return u.href;
}

/** Checks a request body, and returns what it asks for. Throws a 400 BrowserViewError. */
export function parseInput(body: unknown): ViewerInput {
  if (!body || typeof body !== "object") throw bad("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (b.session !== undefined && typeof b.session !== "string") throw bad("session must be a string");
  const session = typeof b.session === "string" ? b.session : undefined;
  let action: ViewerAction;
  switch (b.action) {
    case "click":
    case "dblclick":
      action = { action: b.action, x: finite(b.x, "x"), y: finite(b.y, "y") };
      break;
    case "scroll":
      action = { action: "scroll", dx: finite(b.dx ?? 0, "dx"), dy: finite(b.dy ?? 0, "dy") };
      break;
    case "type":
      if (typeof b.text !== "string" || b.text.length < 1 || b.text.length > TEXT_MAX) throw bad(`text must be 1-${TEXT_MAX} characters`);
      action = { action: "type", text: b.text };
      break;
    case "key":
      if (typeof b.key !== "string" || !KEYS.has(b.key)) throw bad(`key must be one of: ${[...KEYS].join(", ")}`);
      action = { action: "key", key: b.key };
      break;
    case "navigate":
      action = { action: "navigate", url: normalizeUrl(b.url) };
      break;
    case "back":
    case "forward":
    case "reload":
      action = { action: b.action };
      break;
    default:
      throw bad(`unknown action "${String(b.action)}"`);
  }
  return { session, action };
}

const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** Performs one validated action on the chat's tab and answers with where it ended up. */
export async function performAction(sessionId: string | undefined, input: ViewerAction): Promise<{ ok: true; url: string; title: string }> {
  let page = await providePage(sessionId);
  if (!page && input.action === "navigate" && opener) {
    try {
      page = await opener(sessionId);
    } catch (e) {
      throw new BrowserViewError(503, (e as Error).message);
    }
  }
  if (!page) throw new BrowserViewError(409, "The browser has no tab open");
  switch (input.action) {
    case "click":
    case "dblclick": {
      const size = await viewport(page);
      const x = clamp(input.x, size.width);
      const y = clamp(input.y, size.height);
      if (input.action === "click") await page.mouse.click(x, y);
      else await page.mouse.dblclick(x, y);
      await settle(page);
      break;
    }
    case "scroll":
      await page.mouse.wheel(input.dx, input.dy);
      break;
    case "type": {
      // Newlines are Enter presses; the rest is inserted as text.
      const lines = input.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await page.keyboard.press("Enter");
        if (lines[i]) await page.keyboard.insertText(lines[i]);
      }
      break;
    }
    case "key":
      await page.keyboard.press(input.key);
      await settle(page);
      break;
    case "navigate":
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      break;
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      break;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      break;
  }
  return { ok: true, url: page.url(), title: await page.title() };
}
