import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function request(baseUrl, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    cookie: response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; '),
    payload: await response.json()
  };
}

function scopeQuery(scope) {
  return new URLSearchParams(scope).toString();
}

function seedEvidence(database, scope, id, entityName) {
  const timestamp = '2026-11-03T08:00:00.000Z';
  const params = [scope.user_id, scope.agent_id, scope.story_id, scope.branch_id];
  database.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(`conversation_${id}`, ...params, timestamp, timestamp);
  database.prepare(`INSERT INTO messages (id, conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)`)
    .run(`message_${id}`, `conversation_${id}`, scope.user_id, `${entityName}去了图书馆。`, timestamp);
  database.prepare(`INSERT INTO entities
    (id, user_id, agent_id, story_id, branch_id, entity_type, canonical_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'person', ?, ?, ?)`)
    .run(`entity_${id}`, ...params, entityName, timestamp, timestamp);
  database.prepare(`INSERT INTO events
    (id, user_id, agent_id, story_id, branch_id, event_key, event_type, title, summary,
      story_time, source_message_id, valid_from, transaction_from, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'episode', ?, ?, '2026-11-03', ?, ?, ?, ?, ?)`)
    .run(`event_${id}`, ...params, `visit_${id}`, `${entityName}去图书馆`, `${entityName}去了图书馆。`,
      `message_${id}`, timestamp, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO event_entities (id, event_id, entity_id, role, source_message_id, created_at)
    VALUES (?, ?, ?, 'mentioned', ?, ?)`)
    .run(`event_entity_${id}`, `event_${id}`, `entity_${id}`, `message_${id}`, timestamp);
  return { conversationId: `conversation_${id}`, eventId: `event_${id}`, entityId: `entity_${id}` };
}

test('memory lifecycle routes authenticate users, isolate scopes, and expose read-only context status', { timeout: 30000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lifecycle-api-'));
  const databasePath = path.join(tempDir, 'api.db');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '',
      DATABASE_PATH: databasePath, TEXT_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock', GRAPH_STORE: 'sqlite',
      SANDBOX_PROVIDER: 'local', DEEP_AGENT_WORKER_MODE: 'off', MEMORY_TENANT_ID: 'lifecycle-test',
      ADMIN_PASSWORD: 'lifecycle-test-admin', MEMORY_SERVICE_API_KEY: '', ARK_API_KEY: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: ''
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErrors = '';
  child.stderr.on('data', (chunk) => { serverErrors += chunk; });
  let database;
  try {
    const deadline = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}\n${serverErrors}`);
      try { healthy = (await fetch(`${baseUrl}/api/health`)).ok; } catch { /* Server startup. */ }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(healthy, true, `Server startup timed out\n${serverErrors}`);
    const alice = await request(baseUrl, '/api/auth/register', {
      method: 'POST', body: { username: 'lifecycle_alice', display_name: 'Alice', password: 'password123' }
    });
    const bob = await request(baseUrl, '/api/auth/register', {
      method: 'POST', body: { username: 'lifecycle_bob', display_name: 'Bob', password: 'password123' }
    });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    const scope = { user_id: alice.payload.user.id, agent_id: 'agent_linwan', story_id: 'api_story', branch_id: 'main' };
    const bobScope = { ...scope, user_id: bob.payload.user.id };
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const first = seedEvidence(database, scope, 'alice_first', '王老师');
    const second = seedEvidence(database, scope, 'alice_second', '小王');
    const foreign = seedEvidence(database, bobScope, 'bob_first', '王老师');
    let reviewId;

    await t.test('anonymous callers cannot read or mutate lifecycle data', async () => {
      const reads = [
        '/api/memory/reviews', '/api/memory/reviews/unknown', '/api/memory/readiness',
        `/api/memory/entities/${first.entityId}/repair`, `/api/conversations/${first.conversationId}/context`
      ];
      for (const route of reads) {
        assert.equal((await request(baseUrl, `${route}?${scopeQuery(scope)}`)).status, 401, route);
      }
      for (const route of ['/api/memory/reviews', '/api/memory/entities/merge', '/api/memory/entities/split']) {
        assert.equal((await request(baseUrl, route, { method: 'POST', body: scope })).status, 401, route);
      }
    });

    await t.test('ordinary users generate and read their own sourced reviews', async () => {
      const generated = await request(baseUrl, '/api/memory/reviews', {
        method: 'POST', cookie: alice.cookie, body: { ...scope, period: 'weekly', date: '2026-11-05' }
      });
      assert.equal(generated.status, 200, JSON.stringify(generated.payload));
      assert.equal(generated.payload.status, 'ready');
      assert.equal(generated.payload.usableAsEvidence, true);
      assert.equal(generated.payload.sourceRefs.length, 2);
      reviewId = generated.payload.id;
      const list = await request(baseUrl, `/api/memory/reviews?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(list.status, 200);
      assert.equal(list.payload.length, 1);
      const detail = await request(baseUrl, `/api/memory/reviews/${reviewId}?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(detail.status, 200);
      assert.equal(detail.payload.sourceRefs[0].messages.length, 1);
      const readiness = await request(baseUrl, `/api/memory/readiness?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(readiness.status, 200);
      assert.equal(readiness.payload.source.chatMessages, 2);
      assert.equal(readiness.payload.configuration.mode, 'mock');
    });

    await t.test('explicit foreign users are forbidden and foreign record ids stay hidden', async () => {
      for (const route of ['/api/memory/reviews', '/api/memory/readiness', `/api/memory/reviews/${reviewId}`]) {
        assert.equal((await request(baseUrl, `${route}?${scopeQuery(bobScope)}`, { cookie: alice.cookie })).status, 403);
      }
      const crossGenerate = await request(baseUrl, '/api/memory/reviews', {
        method: 'POST', cookie: alice.cookie, body: { ...bobScope, date: '2026-11-05' }
      });
      assert.equal(crossGenerate.status, 403);
      const otherBranch = { ...scope, branch_id: 'other' };
      assert.equal((await request(baseUrl, `/api/memory/reviews/${reviewId}?${scopeQuery(otherBranch)}`,
        { cookie: alice.cookie })).status, 404);
      assert.equal((await request(baseUrl, `/api/memory/reviews/${reviewId}?${scopeQuery(bobScope)}`,
        { cookie: bob.cookie })).status, 404);
      assert.equal((await request(baseUrl, `/api/memory/entities/${first.entityId}/repair?${scopeQuery(bobScope)}`,
        { cookie: alice.cookie })).status, 403);
      assert.equal((await request(baseUrl, `/api/memory/entities/${foreign.entityId}/repair?${scopeQuery(scope)}`,
        { cookie: alice.cookie })).status, 404);
      for (const operation of ['merge', 'split']) {
        const result = await request(baseUrl, `/api/memory/entities/${operation}`, {
          method: 'POST', cookie: alice.cookie, body: {
            ...bobScope, idempotencyKey: `foreign_${operation}`, reason: '跨用户测试'
          }
        });
        assert.equal(result.status, 403);
      }
      const foreignMerge = await request(baseUrl, '/api/memory/entities/merge', {
        method: 'POST', cookie: alice.cookie, body: {
          ...scope, survivorId: first.entityId, sourceEntityIds: [foreign.entityId],
          idempotencyKey: 'foreign_entity', reason: '跨空间测试'
        }
      });
      assert.equal(foreignMerge.status, 404);
      const foreignSplit = await request(baseUrl, '/api/memory/entities/split', {
        method: 'POST', cookie: alice.cookie, body: {
          ...scope, entityId: first.entityId, canonicalName: '跨空间拆分应回滚', eventIds: [foreign.eventId],
          idempotencyKey: 'foreign_split_event', reason: '跨空间事件测试'
        }
      });
      assert.equal(foreignSplit.status, 404);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entities WHERE canonical_name = ?')
        .get('跨空间拆分应回滚').count, 0);
    });

    await t.test('ordinary users merge and split scoped entities through normal API routes', async () => {
      const merged = await request(baseUrl, '/api/memory/entities/merge', {
        method: 'POST', cookie: alice.cookie, body: {
          ...scope, survivorId: first.entityId, sourceEntityIds: [second.entityId],
          idempotencyKey: 'merge_same_person', reason: '两个称呼属于同一个人'
        }
      });
      assert.equal(merged.status, 200, JSON.stringify(merged.payload));
      assert.equal(merged.payload.targetEntityId, first.entityId);
      assert.equal(merged.payload.projection.status, 'completed');
      const repairedEventId = merged.payload.eventVersions[second.eventId];
      assert.ok(repairedEventId);
      const details = await request(baseUrl,
        `/api/memory/entities/${first.entityId}/repair?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(details.status, 200);
      assert.equal(details.payload.events.length, 2);
      const staleReview = await request(baseUrl, `/api/memory/reviews/${reviewId}?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(staleReview.payload.status, 'stale');
      assert.equal(staleReview.payload.usableAsEvidence, false);
      const split = await request(baseUrl, '/api/memory/entities/split', {
        method: 'POST', cookie: alice.cookie, body: {
          ...scope, entityId: first.entityId, canonicalName: '王老师（同事）', eventIds: [repairedEventId],
          idempotencyKey: 'split_same_name', reason: '这条经历属于同名同事'
        }
      });
      assert.equal(split.status, 200, JSON.stringify(split.payload));
      assert.notEqual(split.payload.targetEntityId, first.entityId);
      assert.equal(split.payload.projection.status, 'completed');
      const splitDetails = await request(baseUrl,
        `/api/memory/entities/${split.payload.targetEntityId}/repair?${scopeQuery(scope)}`, { cookie: alice.cookie });
      assert.equal(splitDetails.payload.events.length, 1);
      assert.equal(database.prepare('SELECT status FROM entities WHERE id = ?').get(foreign.entityId).status, 'active');
    });

    await t.test('context GET returns status without generating summaries or changing sources', async () => {
      const tables = ['conversation_context_snapshots', 'conversation_context_states', 'messages', 'events', 'memory_values'];
      const rowsBefore = tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const route = `/api/conversations/${first.conversationId}/context`;
      const status = await request(baseUrl, `${route}?user_id=${scope.user_id}`, { cookie: alice.cookie });
      assert.equal(status.status, 200, JSON.stringify(status.payload));
      assert.equal(status.payload.sourceMessageCount, 1);
      assert.equal(status.payload.snapshotCount, 0);
      const again = await request(baseUrl, `${route}?user_id=${scope.user_id}`, { cookie: alice.cookie });
      assert.deepEqual(again.payload, status.payload);
      const rowsAfter = tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      assert.deepEqual(rowsAfter, rowsBefore);
      assert.equal((await request(baseUrl, `${route}?user_id=${bobScope.user_id}`, { cookie: alice.cookie })).status, 403);
      assert.equal((await request(baseUrl, `${route}?user_id=${bobScope.user_id}`, { cookie: bob.cookie })).status, 404);
      assert.equal((await request(baseUrl, route, { method: 'POST', cookie: alice.cookie, body: scope })).status, 403);
    });
  } finally {
    database?.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
