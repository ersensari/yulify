import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { legacyDataNeedsMigration } from '../dist/legacy-data-guard.js';

test('legacy tables block the upstream destructive handoffs', () => {
  for (const table of ['voice_presets', 'canvases', 'images', 'videos']) {
    const db = new Database(':memory:');
    try {
      assert.equal(legacyDataNeedsMigration(db), false);
      db.exec(`CREATE TABLE ${table}(id TEXT)`);
      assert.equal(legacyDataNeedsMigration(db), true, table);
    } finally { db.close(); }
  }
});

test('legacy or unreadable voice settings block migration; v0.2 settings do not', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
    const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)');
    set.run('voice', JSON.stringify({ provider: 'pithagoras-voice' }));
    assert.equal(legacyDataNeedsMigration(db), false);
    set.run('voice', JSON.stringify({ breezeUrl: 'https://example.test/voice' }));
    assert.equal(legacyDataNeedsMigration(db), true);
    set.run('voice', '{invalid');
    assert.equal(legacyDataNeedsMigration(db), true);
  } finally { db.close(); }
});
