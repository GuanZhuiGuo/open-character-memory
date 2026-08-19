import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const dbModuleUrl = pathToFileURL(path.join(process.cwd(), 'lib/db.js')).href;

function runDatabaseProcess(databasePath, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      TEXT_PROVIDER: 'mock',
      EMBEDDING_PROVIDER: 'mock',
      GRAPH_STORE: 'sqlite'
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('existing SQLite data receives additive Headless Memory columns without replacement', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-character-memory-migration-'));
  const databasePath = path.join(tempDir, 'historical.db');
  try {
    const before = runDatabaseProcess(databasePath, `
      const { db, initializeDatabase } = await import(${JSON.stringify(dbModuleUrl)});
      initializeDatabase();
      const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      db.exec('ALTER TABLE memory_observations DROP COLUMN request_hash');
      db.exec('ALTER TABLE memory_operation_receipts DROP COLUMN request_hash');
      console.log(count);
      db.close();
    `);
    const after = runDatabaseProcess(databasePath, `
      const { db, initializeDatabase } = await import(${JSON.stringify(dbModuleUrl)});
      initializeDatabase();
      const observations = db.prepare('PRAGMA table_info(memory_observations)').all();
      const operations = db.prepare('PRAGMA table_info(memory_operation_receipts)').all();
      const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      if (!observations.some((item) => item.name === 'request_hash')) process.exit(11);
      if (!operations.some((item) => item.name === 'request_hash')) process.exit(12);
      console.log(count);
      db.close();
    `);
    assert.equal(after, before);
    assert.ok(Number(after) > 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
