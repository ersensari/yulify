#!/usr/bin/env node
/** Offline canvas import from an explicitly prepared, independent portal copy. */
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const COLUMNS = ['id', 'session_id', 'title', 'content', 'revision', 'status', 'active_call', 'agent_read_revision', 'updated_at', 'previous_content'];
const usage = 'Usage: node scripts/migrate-yulify-canvas.mjs --source /absolute/path/to/copied/portal.db --output /absolute/path/to/new/empty-directory';
function options(args) {
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--output') throw new Error(usage);
  if (!path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('Both paths must be absolute. ' + usage);
  return { source: path.resolve(args[1]), output: path.resolve(args[3]) };
}
function hasJournal(file) { return ['-wal', '-shm', '-journal'].some(suffix => existsSync(file + suffix)); }
function sameStat(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
function copySnapshot(source, output) {
  if (hasJournal(source)) throw new Error('Source has SQLite sidecar files; prepare a quiescent, standalone copy first.');
  if (!lstatSync(source).isFile()) throw new Error('Source must be a regular file, not a symlink.');
  const from = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let to;
  try {
    const before = fstatSync(from);
    if (!before.isFile() || before.nlink !== 1) throw new Error('Source must be an independent regular file without hard links.');
    to = openSync(output, 'wx', 0o600);
    const hash = createHash('sha256');
    const block = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const size = readSync(from, block, 0, block.length, null);
      if (!size) break;
      hash.update(block.subarray(0, size));
      let at = 0;
      while (at < size) at += writeSync(to, block, at, size - at);
    }
    fsyncSync(to);
    if (!sameStat(before, fstatSync(from)) || hasJournal(source)) throw new Error('Source changed or SQLite sidecars appeared during copying.');
    return hash.digest('hex');
  } finally { if (to !== undefined) closeSync(to); closeSync(from); }
}
function migrate(source, output) {
  if (existsSync(output)) throw new Error('Output directory must not exist; existing data is never overwritten.');
  const sourceParent = realpathSync(path.dirname(source));
  const outputParent = realpathSync(path.dirname(output));
  const relative = path.relative(sourceParent, outputParent);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Output must be outside the source copy directory.');
  }
  mkdirSync(output, { mode: 0o700 });
  const snapshot = path.join(output, '.source-copy.db');
  const staged = path.join(output, '.canvases.db');
  const target = path.join(output, 'canvases.db');
  let src, dst;
  try {
    const sha256 = copySnapshot(source, snapshot);
    src = new Database(snapshot, { readonly: true, fileMustExist: true });
    if (src.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The source SQLite snapshot failed quick_check.');
    const columns = new Set(src.prepare('PRAGMA table_info(canvases)').all().map(c => c.name));
    for (const column of COLUMNS) if (!columns.has(column)) throw new Error(`Source canvases table is missing ${column}.`);
    if (!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) throw new Error('Source has no sessions table.');
    const rows = src.prepare(`SELECT ${COLUMNS.join(', ')} FROM canvases ORDER BY id`).all();
    const hasSession = src.prepare('SELECT 1 FROM sessions WHERE id = ?');
    const ids = new Set();
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Canvas IDs are empty or duplicated.');
      if (typeof row.session_id !== 'string' || !hasSession.get(row.session_id)) throw new Error(`Canvas ${row.id} has no matching session; resolve it in the copy first.`);
      ids.add(row.id);
    }
    dst = new Database(staged);
    dst.exec(`CREATE TABLE canvases (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'saved', active_call TEXT, agent_read_revision INTEGER, updated_at TEXT NOT NULL, previous_content TEXT); CREATE INDEX idx_canvases_session ON canvases(session_id);`);
    const insert = dst.prepare(`INSERT INTO canvases (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    dst.transaction(() => { for (const row of rows) insert.run(...COLUMNS.map(column => row[column])); })();
    if (dst.pragma('quick_check', { simple: true }) !== 'ok' || dst.prepare('SELECT COUNT(*) AS n FROM canvases').get().n !== rows.length) throw new Error('Destination verification failed.');
    const inserted = dst.prepare(`SELECT ${COLUMNS.join(', ')} FROM canvases ORDER BY id`).all();
    if (JSON.stringify(rows) !== JSON.stringify(inserted)) throw new Error('Destination rows do not match the source.');
    dst.close(); dst = undefined;
    src.close(); src = undefined;
    unlinkSync(snapshot);
    // link() fails atomically if a target was introduced while importing.
    linkSync(staged, target); unlinkSync(staged);
    writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ format: 1, sourceSnapshotSha256: sha256, canvasCount: rows.length, note: 'Canvas only; voice and media still require a separate migration.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Prepared ${rows.length} canvas records in ${target}. This does not migrate voice or media.`);
  } catch (error) {
    try { dst?.close(); } catch {}
    try { src?.close(); } catch {}
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
try { const { source, output } = options(process.argv.slice(2)); migrate(source, output); }
catch (error) { console.error((error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
