/**
 * Whether a spoken request needs tools (a search, a lookup, a file or browser
 * action) or is plain conversation. forgeloop-ai's laya-multilingual answers it
 * in ~50ms with per-label scores, the same service server.ts uses for
 * "serious" delegation (LAYA_URL).
 *
 * Why it exists: a small local model that thinks before a spoken reply is slow
 * for chat, but one that does not think often announces a search ("I'll look
 * that up") and ends the turn without calling the tool, or asks a clarifying
 * question instead. So thinking is spent only on requests that need tools.
 *
 * Fails toward thinking: when the classifier is down or answers oddly, a slower
 * reply is better than a tool call that never happens.
 */
const LAYA_URL = process.env.LAYA_URL || "http://127.0.0.1:10085/classify";
const LAYA_TIMEOUT_MS = 2000;
/**
 * Below this score for "tools" a request counts as chat. Measured on this
 * classifier: real tool requests (search, weather, memory lookup) score 0.73-0.98,
 * greetings, thanks and "peki" 0.00-0.42, so 0.6 sits in the gap.
 */
const TOOLS_THRESHOLD = 0.6;
const CRITERIA = {
  tools: "the user asks to search the web, look something up, find, check, remember, open, run, read, create, edit or change something, which needs tools or research",
  chat: "casual conversation, a greeting, thanks, an opinion, or a simple question that can be answered from general knowledge without looking anything up",
};

/**
 * Deterministic fallback for when laya is down or answers without a verdict:
 * a request that asks for a search, a lookup, a file or browser action, or names
 * the web, needs tools; greetings, thanks and short acknowledgements do not.
 * Lower-cased with the Turkish locale first, so "İ"/"I" match the Turkish forms.
 * Word boundaries are Unicode-aware, since \b would split on "ç" and "ş".
 */
const TOOL_WORDS = /(?<!\p{L})(?:ara\p{L}*|arar m[ıi]s[ıi]n|araştır\p{L}*|bul(?:ur musun)?|bak(?:ar m[ıi]s[ıi]n)?|kontrol et\p{L}*|getir\p{L}*|göster\p{L}*|aç|çalıştır\p{L}*|oku\p{L}*|yaz\p{L}*|düzenle\p{L}*|ekle\p{L}*|sil\p{L}*|hatırla\p{L}*|indir\p{L}*|search|look ?up|google|find|check|open|run|read|write|edit|create|remember|fetch|download|browse|web|internet|haber\p{L}*|hava durumu|fiyat\p{L}*|news|weather|price)(?!\p{L})|https?:\/\//u;

export function looksLikeToolRequest(text: string): boolean {
  return TOOL_WORDS.test(text.toLocaleLowerCase("tr"));
}

export async function needsTools(text: string): Promise<boolean> {
  try {
    const upstream = await fetch(LAYA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, criteria: CRITERIA }),
      signal: AbortSignal.timeout(LAYA_TIMEOUT_MS),
    });
    if (!upstream.ok) return looksLikeToolRequest(text);
    const body = await upstream.json() as { choice?: unknown; labels?: unknown; scores?: unknown };
    if (Array.isArray(body.labels) && Array.isArray(body.scores)) {
      const score = body.scores[body.labels.indexOf("tools")];
      if (typeof score === "number") return score >= TOOLS_THRESHOLD;
    }
    if (typeof body.choice === "string") return body.choice !== "chat";
    return looksLikeToolRequest(text);
  } catch {
    return looksLikeToolRequest(text);
  }
}
