/** Extract the exact spoken text, including from an incomplete voice envelope. */
export function stripLeadingVoiceStyle(text: string, done: boolean): string {
  const marker = /^\s*\[\s*style\s*:[^\]\n]{0,500}\]\s*/i;
  if (marker.test(text)) return text.replace(marker, '');
  if (!done && /^\s*\[\s*(?:s(?:t(?:y(?:l(?:e(?:\s*:[^\]\n]*)?)?)?)?)?)?$/i.test(text)) return '';
  return text;
}

export function voiceEnvelopeText(raw: string): string | undefined {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!candidate.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(candidate);
    if (typeof value?.tts?.text === 'string' && typeof value?.tts?.language === 'string' && typeof value?.tts?.style === 'string') return value.tts.text;
    return undefined;
  } catch {
    const tts = /"tts"\s*:\s*\{/.exec(candidate);
    if (!tts) return /^\{\s*"(?:chat|tts)"\s*:/.test(candidate) ? '' : undefined;
    const body = candidate.slice(tts.index + tts[0].length);
    const match = /"text"\s*:\s*"((?:\\.|[^"\\])*)/s.exec(body);
    if (!match) return '';
    for (let trim = 0; trim <= Math.min(6, match[1].length); trim++) {
      try {
        const text = JSON.parse('"' + (trim ? match[1].slice(0, -trim) : match[1]) + '"') as string;
        return text.replace(/[\uD800-\uDBFF]$/, '');
      } catch { /* wait for the rest of a JSON escape */ }
    }
    return '';
  }
}
