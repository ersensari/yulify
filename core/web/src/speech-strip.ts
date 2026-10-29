/**
 * What is never read aloud: the portal's own [Audio mode] marker when the model echoes it,
 * and bare web addresses (a markdown link's address is already gone by the time this runs).
 */
export function stripUnspoken(text: string): string {
  return stripReasoningTags(text).replace(/\[\s*audio mode\s*\]:?/gi, "").replace(/\b(?:https?:\/\/|www\.)[^\s<>)\]]*[^\s<>)\].,;:!?'\"]/gi, "");
}

/**
 * A reasoning channel the model's chat template leaked into the reply text: "<|channel>thought<|channel><channel|>"
 * (an empty thought, Gemma 4-style tags, seen on minicpm-v-4-7 replies 2026-10-19). Read aloud as "thought".
 */
export function stripReasoningTags(text: string): string {
  return text.replace(/<\|channel\|?>[\s\S]*?<channel\|>/g, "").replace(/<\|?\/?channel\|?>/g, "");
}
