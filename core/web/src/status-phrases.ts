/**
 * The spoken status phrases (thinking, context compaction) in the language the
 * conversation is in. Pure: no imports, so the server tests can load it as it is.
 *
 * The English texts here are the source strings hands-free.ts has always spoken.
 * For a conversation in English the English source is used whatever the portal's
 * UI language is; for Turkish the Turkish list is used; for an unknown language
 * (null) the caller's own text (`t(...)` of the English source) is returned unchanged.
 */

export type StatusKind = "thinking" | "compaction-start" | "compaction-done" | "compaction-stopped" | "compaction-wait";
/** The language this chat's replies are expected in (GET /api/sessions/:id/voice/language); null when not known. */
export type SpokenLanguage = "tr" | "en" | null;

/** Indexed by kind; the thinking and compaction-start lists are index-aligned with hands-free.ts's English lists. */
const ENGLISH: Record<StatusKind, readonly string[]> = {
  thinking: [
    "Let me think about that for a moment.",
    "Give me a moment to think this through.",
    "Let me consider that.",
    "I’m thinking through your request.",
    "Let me take a moment with that.",
  ],
  "compaction-start": [
    "My context is getting full. Let me quickly compact our conversation before I continue.",
    "I need a little room in my context. Let me summarize our conversation, then I'll carry on.",
    "Let me do a quick context compaction so I can keep going.",
  ],
  "compaction-done": ["Context compaction is done. I'm ready to continue."],
  "compaction-stopped": ["Context compaction stopped before it finished."],
  "compaction-wait": ["I'm still compacting our conversation. Please wait a moment; I'll let you know when I'm ready."],
};

const TURKISH: Record<StatusKind, readonly string[]> = {
  thinking: [
    "Bir an düşüneyim.",
    "Bunu düşünmem için bana biraz zaman ver.",
    "Bir bakayım, üzerinde düşünüyorum.",
    "İsteğini düşünüyorum, birazdan dönerim.",
    "Bu konuda bir an kafa yoruyorum.",
  ],
  "compaction-start": [
    "Bağlamım dolmak üzere. Devam etmeden önce konuşmamızı hızlıca özetleyeyim.",
    "Bağlamımda biraz yer açmam gerekiyor. Konuşmayı özetleyip devam edeceğim.",
    "Hızlıca bağlamı toparlayayım, sonra devam ederim.",
  ],
  "compaction-done": ["Bağlam özetleme bitti, devam etmeye hazırım."],
  "compaction-stopped": ["Bağlam özetleme bitmeden durdu."],
  "compaction-wait": ["Konuşmayı hâlâ özetliyorum. Lütfen biraz bekle, hazır olunca haber veririm."],
};

/**
 * The phrase to speak for `kind` in the conversation's language.
 * `index` picks the same position in the list as the caller's own English choice
 * (so a no-repeat rule over indices holds in both languages); without it one is picked at random.
 * `english` is the caller's `t(...)` text, used only when the language is unknown.
 */
export function statusPhrase(kind: StatusKind, lang: SpokenLanguage | undefined, english: string, index?: number): string {
  if (lang !== "tr" && lang !== "en") return english;
  const list = lang === "tr" ? TURKISH[kind] : ENGLISH[kind];
  const i = index !== undefined && index >= 0 && index < list.length ? index : Math.floor(Math.random() * list.length);
  return list[i];
}
