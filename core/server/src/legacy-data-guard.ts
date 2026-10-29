import type Database from "better-sqlite3";

/**
 * The upstream v0.2 handoffs move files, drop legacy tables and rewrite the
 * voice settings. Until Yulify has a verified copy-based migration, opening
 * an old data directory must not run those handoffs implicitly.
 */
export function legacyDataNeedsMigration(db: Database.Database): boolean {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const table of ["voice_presets", "canvases", "images", "videos"]) {
    if (exists.get(table)) return true;
  }
  if (!exists.get("settings")) return false;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'voice'").get() as { value: string } | undefined;
  if (!row) return false;
  try {
    const voice = JSON.parse(row.value);
    return !!voice && typeof voice === "object" && ["breezeUrl", "whisperUrl", "instruction", "voice", "runtime"].some((key) => Object.hasOwn(voice, key));
  } catch {
    // Unknown legacy settings are not safe to hand to a schema that rewrites them.
    return true;
  }
}
