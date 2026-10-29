/**
 * The language a chat's replies are expected in (tr/en), for the speech engine.
 *
 * ForgeLoop audio picks the reference prompt (and the number words) by the text's
 * language, and a short reply ("Rica ederim", "Okay") does not say which one it
 * is: it was read with the wrong accent (2026-10-20). So the language is decided
 * from the person's message and sent with every phrase of the reply; the engine
 * uses it for short or mixed text and keeps the text's own language when that is
 * clear.
 *
 * - A message that names a language ("İngilizce cevap ver", "let's continue in
 *   Turkish") is asked of laya-multilingual: an explicit request holds for the
 *   rest of the chat until another one. Only such messages are asked: laya takes
 *   any mention for a request otherwise ("İngiltere'nin başkenti" came back as
 *   English, measured).
 * - Any other message sets the language it is written in, unless an explicit
 *   request is in force. That is the engine's own guess (/v1/normalize), the same
 *   one it makes for the reply's text.
 */

const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:10085/classify";
const TIMEOUT_MS = 2000;
/** A request needs this much of laya's vote; below it the message counts as not asking. */
const ASK_THRESHOLD = 0.6;
const CRITERIA = {
  en: "the user asks the assistant to answer, speak, talk, explain, write or sing in English",
  tr: "the user asks the assistant to answer, speak, talk, explain, write or sing in Turkish",
  none: "the user does not ask for any particular language",
};
const NAMES_LANGUAGE = /(ingilizce|english|türkçe|turkce|turkish)/;
const TR_LETTERS = /[çğışöüÇĞİŞÖÜ]/;
/** Where laya cannot be reached (the Mac's portal: it listens on the server's loopback only), the plain ways of asking. */
const ASK_EN = /(ingilizce\s+(cevap|yanıt|konuş|anlat|söyle|yaz|devam|oku|söyl)|in english|speak english|switch to english|english please)/;
const ASK_TR = /(türkçe\s+(cevap|yanıt|konuş|anlat|söyle|yaz|devam|oku|söyl)|in turkish|speak turkish|switch to turkish|turkish please)/;

export type ReplyLanguage = "tr" | "en";
type Fetch = typeof fetch;

const chats = new Map<string, { lang: ReplyLanguage; asked: boolean }>();

/** The language the next replies in this chat are expected in, when one is known. */
export function replyLanguage(sessionId: string): ReplyLanguage | undefined {
  return chats.get(sessionId)?.lang;
}

function askedPlainly(lower: string): ReplyLanguage | undefined {
  return ASK_EN.test(lower) ? "en" : ASK_TR.test(lower) ? "tr" : undefined;
}

/** What the person asked for, if the message asks for a language at all. */
async function askedFor(text: string, fetcher: Fetch): Promise<ReplyLanguage | undefined> {
  const lower = text.toLocaleLowerCase("tr");
  if (!NAMES_LANGUAGE.test(lower)) return undefined;
  try {
    const r = await fetcher(LAYA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, criteria: CRITERIA }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return askedPlainly(lower);
    const body = (await r.json()) as { labels?: unknown; scores?: unknown };
    if (!Array.isArray(body.labels) || !Array.isArray(body.scores)) return askedPlainly(lower);
    const label = body.labels[0];
    const score = body.scores[0];
    return (label === "en" || label === "tr") && typeof score === "number" && score >= ASK_THRESHOLD ? label : undefined;
  } catch {
    return askedPlainly(lower);
  }
}

/** The language the message is written in: the speech engine's guess, else Turkish letters decide. */
async function writtenIn(text: string, normalizeUrl: string | undefined, fetcher: Fetch): Promise<ReplyLanguage> {
  if (normalizeUrl) {
    try {
      const r = await fetcher(normalizeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = r.ok ? ((await r.json()) as { language?: unknown }) : {};
      if (body.language === "tr" || body.language === "en") return body.language;
    } catch { /* the engine's guess is a help; the letters below decide without it */ }
  }
  return TR_LETTERS.test(text) ? "tr" : "en";
}

/** The person's message as they wrote or said it: the blocks the portal puts in front of it are not theirs. */
function ownWords(message: string): string {
  return message
    .replace(/<now>[\s\S]*?<\/now>/g, " ")
    .replace(/<speaker>[\s\S]*?<\/speaker>/g, " ")
    .replace(/\[audio mode\]:?/gi, " ")
    .trim();
}

/** Notes a message the person sent to this chat. Never throws; a message with no words leaves the language as it was. */
export async function noteMessage(sessionId: string, message: string, normalizeUrl?: string, fetcher: Fetch = fetch): Promise<void> {
  const text = ownWords(message);
  if (!/\p{L}/u.test(text)) return;
  const asked = await askedFor(text, fetcher);
  if (asked) {
    chats.set(sessionId, { lang: asked, asked: true });
    return;
  }
  if (chats.get(sessionId)?.asked) return;
  chats.set(sessionId, { lang: await writtenIn(text, normalizeUrl, fetcher), asked: false });
}

/** Forgets a chat (deleted, or for tests). */
export function forgetReplyLanguage(sessionId: string): void {
  chats.delete(sessionId);
}
