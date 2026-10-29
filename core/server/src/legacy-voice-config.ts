import { getDb, getSetting } from './db.js';

/** Settings used by the existing Yulify LiveKit bridge until its provider migration. */
export function legacyVoiceConfig(): { voice: string; language: string; instruction: string; runtime?: string; breezeUrl: string } {
  const stored = getSetting('voice');
  const voice = stored ? JSON.parse(stored) : {};
  return {
    voice: typeof voice.voice === 'string' ? voice.voice : 'design',
    language: typeof voice.language === 'string' ? voice.language : 'auto',
    instruction: typeof voice.instruction === 'string' ? voice.instruction : 'A warm, clear English voice with a calm, conversational delivery.',
    runtime: typeof voice.runtime === 'string' ? voice.runtime : undefined,
    breezeUrl: typeof voice.breezeUrl === 'string' ? voice.breezeUrl : 'http://127.0.0.1:7860/v1/audio/speech',
  };
}

export function legacyVoiceName(id: string): string {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_presets'").get()) return id;
  const row = db.prepare('SELECT name FROM voice_presets WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? id;
}

export function engineUrl(breezeUrl: string, path: string): string {
  return /\/v1\/audio\/speech\/?$/.test(breezeUrl) ? breezeUrl.replace(/\/v1\/audio\/speech\/?$/, path) : new URL(path, breezeUrl).toString();
}
