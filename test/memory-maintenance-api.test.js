import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function request(base, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    cookie: response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; '),
    payload: await response.json()
  };
}

function seedTurn(database, scope, suffix, text) {
  const timestamp = '2026-11-01T08:00:00.000Z';
  const conversationId = `maintenance_api_conversation_${suffix}`;
  database.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, scope.user_id, scope.agent_id, scope.story_id, scope.branch_id, timestamp, timestamp);
  const insert = database.prepare(`INSERT INTO messages (id, conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(`maintenance_api_user_${suffix}`, conversationId, scope.user_id, 'user', text, timestamp);
  insert.run(`maintenance_api_assistant_${suffix}`, conversationId, scope.user_id, 'assistant', '收到，具体安排待确认。', timestamp);
}

function snapshot(database) {
  const base = ['messages', 'events', 'claims', 'entities', 'memory_values', 'memory_history',
    'user_plot_states', 'user_prop_states', 'trigger_runs', 'tool_runs'];
  const maintenance = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_maintenance_%' ORDER BY name")
    .all().map((row) => row.name);
  return Object.fromEntries([...base, ...maintenance].map((table) =>
    [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('maintenance HTTP routes enforce identity and preserve read-only inspection', { timeout: 30000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-api-'));
  const databasePath = path.join(directory, 'memory.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const environment = {
      ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), BASE_PATH: '',
      DATABASE_PATH: databasePath, TEXT_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock', GRAPH_STORE: 'sqlite',
      SANDBOX_PROVIDER: 'local', DEEP_AGENT_WORKER_MODE: 'off', MEMORY_TENANT_ID: 'maintenance-http-test',
      MEMORY_MAINTENANCE_ENABLED: 'true', MEMORY_MAINTENANCE_WORKER_POLL_MS: '3600000',
      ADMIN_PASSWORD: 'maintenance-http-admin', MEMORY_SERVICE_API_KEY: '', ARK_API_KEY: '',
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: ''
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: environment, stdio: ['ignore', 'ignore', 'pipe']
  });
  let serverErrors = '';
  child.stderr.on('data', (chunk) => { serverErrors += chunk; });
  let database;
  let fixtureDatabase;
  try {
    const deadline = Date.now() + 10000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}\n${serverErrors}`);
      try { healthy = (await fetch(`${base}/api/health`)).ok; } catch { /* Await startup. */ }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(healthy, true, serverErrors);
    const alice = await request(base, '/api/auth/register', {
      method: 'POST', body: { username: 'maintenance_alice', display_name: 'Alice', password: 'password123' }
    });
    const bob = await request(base, '/api/auth/register', {
      method: 'POST', body: { username: 'maintenance_bob', display_name: 'Bob', password: 'password123' }
    });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    const scope = { user_id: alice.payload.user.id, agent_id: 'agent_linwan', story_id: 'maintenance_api', branch_id: 'main' };
    const otherScope = { ...scope, user_id: bob.payload.user.id };
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    seedTurn(database, scope, 'alice', '我计划去公园，但还没有出发。');
    seedTurn(database, otherScope, 'bob', '另一用户的私密计划。');
    const query = (value) => new URLSearchParams(value).toString();

    await t.test('anonymous callers cannot read, enqueue, approve or dismiss', async () => {
      assert.equal((await request(base, `/api/memory/maintenance?${query(scope)}`)).status, 401);
      for (const [route, body] of [
        ['/api/memory/maintenance/run', scope],
        ['/api/memory/maintenance/proposals/unknown/decision', { ...scope, decision: 'apply' }],
        ['/api/memory/maintenance/proposals/unknown/decision', { ...scope, decision: 'dismiss' }]
      ]) assert.equal((await request(base, route, { method: 'POST', body })).status, 401);
    });

    await t.test('GET does not discover activity, enqueue or modify canonical and derived rows', async () => {
      const before = snapshot(database);
      const first = await request(base, `/api/memory/maintenance?${query(scope)}`, { cookie: alice.cookie });
      assert.equal(first.status, 200, JSON.stringify(first.payload));
      const second = await request(base, `/api/memory/maintenance?${query(scope)}`, { cookie: alice.cookie });
      assert.equal(second.status, 200);
      assert.deepEqual(snapshot(database), before);
      assert.deepEqual(second.payload.topics, first.payload.topics);
      assert.deepEqual(second.payload.proposals, first.payload.proposals);
    });

    await t.test('explicit foreign user IDs cannot read or mutate another account', async () => {
      const before = snapshot(database);
      assert.equal((await request(base, `/api/memory/maintenance?${query(otherScope)}`, { cookie: alice.cookie })).status, 403);
      assert.equal((await request(base, `/api/memory/maintenance?${query({ ...scope, tenant_id: 'foreign-tenant' })}`,
        { cookie: alice.cookie })).status, 403);
      for (const [route, body] of [
        ['/api/memory/maintenance/run', otherScope],
        ['/api/memory/maintenance/proposals/unknown/decision', { ...otherScope, decision: 'apply' }],
        ['/api/memory/maintenance/proposals/unknown/decision', { ...otherScope, decision: 'dismiss' }]
      ]) assert.equal((await request(base, route, { method: 'POST', cookie: alice.cookie, body })).status, 403);
      assert.deepEqual(snapshot(database), before);
    });

    await t.test('manual runs ignore client-injected proposals and do not mutate canonical business state', async () => {
      const before = snapshot(database);
      const result = await request(base, '/api/memory/maintenance/run', {
        method: 'POST', cookie: alice.cookie, body: {
          ...scope, actorId: bob.payload.user.id,
          proposals: [{ type: 'entity_merge', sourceMessageIds: ['maintenance_api_user_bob'], payload: { survivorId: 'foreign', sourceEntityIds: ['other'] } }]
        }
      });
      assert.equal(result.status, 200, JSON.stringify(result.payload));
      assert.ok(result.payload.maintenance);
      for (const [table, rows] of Object.entries(before)) {
        if (!table.startsWith('memory_maintenance_')) assert.deepEqual(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table);
      }
      assert.doesNotMatch(JSON.stringify(result.payload.maintenance), /另一用户的私密计划|maintenance_api_user_bob/);
      const repeat = await request(base, '/api/memory/maintenance/run', { method: 'POST', cookie: alice.cookie, body: scope });
      assert.equal(repeat.status, 200, JSON.stringify(repeat.payload));
      assert.equal(repeat.payload.status, 'skipped');
      assert.match(repeat.payload.reason, /no_new/);
    });

    await t.test('real sourced candidates are hidden across users and branches and apply exactly once with the authenticated actor', async () => {
      Object.assign(process.env, environment);
      const { db, initializeDatabase } = await import('../lib/db.js');
      fixtureDatabase = db;
      initializeDatabase();
      const { storeEvent } = await import('../lib/memory.js');
      const { discoverMaintenanceActivity, enqueueMemoryMaintenance, processMemoryMaintenanceRun,
        listMemoryMaintenanceCandidates } = await import('../lib/memory-maintenance.js');
      const candidateScope = { ...scope, story_id: 'maintenance_api_candidate' };
      const localScope = { userId: scope.user_id, agentId: scope.agent_id, storyId: candidateScope.story_id, branchId: scope.branch_id };
      seedTurn(database, candidateScope, 'candidate_first', '王老师去了图书馆。');
      seedTurn(database, candidateScope, 'candidate_second', '小王是王老师，也去了操场。');
      for (const [name, suffix] of [['王老师', 'first'], ['小王', 'second']]) {
        await storeEvent({ event_key: `http_candidate_${suffix}`, event_type: 'episode', title: `${name}的经历`,
          summary: `${name}是用户认识的老师。`, entities: [{ name, type: 'person' }] }, localScope,
        `maintenance_api_user_candidate_${suffix}`, { projectGraph: false });
      }
      const person = (name) => database.prepare(`SELECT id FROM entities WHERE user_id = ? AND agent_id = ?
        AND story_id = ? AND branch_id = ? AND canonical_name = ?`).get(scope.user_id, scope.agent_id,
      candidateScope.story_id, scope.branch_id, name).id;
      const survivorId = person('王老师');
      const sourceId = person('小王');
      discoverMaintenanceActivity({ limit: 100 });
      const queued = enqueueMemoryMaintenance(localScope, { reason: 'manual' });
      assert.equal(queued.status, 'queued');
      const prepared = await processMemoryMaintenanceRun(queued.run.id, { generate: async () => ({
        provider: 'test', model: 'http-candidate-fixture', text: JSON.stringify({ topics: [], openItems: [], proposals: [{
          type: 'entity_merge', title: '核对两个称呼', reason: '用户明确说明小王就是王老师。',
          sourceMessageIds: ['maintenance_api_user_candidate_first', 'maintenance_api_user_candidate_second'],
          payload: { survivorId, sourceEntityIds: [sourceId] }
        }] })
      }) });
      assert.equal(prepared.status, 'succeeded', JSON.stringify(prepared));
      const candidate = listMemoryMaintenanceCandidates(localScope, {})[0];
      assert.ok(candidate.id);
      const route = `/api/memory/maintenance/proposals/${candidate.id}/decision`;
      const before = snapshot(database);
      for (const [cookie, requestScope] of [
        [alice.cookie, { ...candidateScope, branch_id: 'foreign' }],
        [bob.cookie, { ...candidateScope, user_id: bob.payload.user.id }]
      ]) {
        const hidden = await request(base, route, { method: 'POST', cookie, body: { ...requestScope, decision: 'apply' } });
        assert.equal(hidden.status, 404, JSON.stringify(hidden.payload));
      }
      assert.deepEqual(snapshot(database), before);
      const applied = await request(base, route, { method: 'POST', cookie: alice.cookie, body: {
        ...candidateScope, decision: 'apply', actorId: bob.payload.user.id, idempotencyKey: 'client-forged-key'
      } });
      assert.equal(applied.status, 200, JSON.stringify(applied.payload));
      assert.equal(applied.payload.status, 'applied');
      assert.equal(applied.payload.actorId, alice.payload.user.id);
      assert.equal(database.prepare('SELECT status FROM entities WHERE id = ?').get(sourceId).status, 'merged');
      const rowsAfter = snapshot(database);
      const repairCount = database.prepare('SELECT COUNT(*) AS count FROM entity_repairs').get().count;
      const repeated = await request(base, route, { method: 'POST', cookie: alice.cookie, body: {
        ...candidateScope, decision: 'apply', idempotencyKey: 'different-client-key'
      } });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.payload.receipt.id, applied.payload.receipt.id);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entity_repairs').get().count, repairCount);
      assert.deepEqual(snapshot(database), rowsAfter);
      assert.equal((await request(base, route, { method: 'POST', cookie: alice.cookie,
        body: { ...candidateScope, decision: 'dismiss' } })).status, 409);
    });

    await t.test('unknown candidate IDs stay hidden and invalid decisions do not write anything', async () => {
      const before = snapshot(database);
      const absent = await request(base, '/api/memory/maintenance/proposals/unknown/decision', {
        method: 'POST', cookie: alice.cookie, body: { ...scope, decision: 'apply' }
      });
      assert.equal(absent.status, 404, JSON.stringify(absent.payload));
      const invalid = await request(base, '/api/memory/maintenance/proposals/unknown/decision', {
        method: 'POST', cookie: alice.cookie, body: { ...scope, decision: 'auto_apply_everything' }
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(snapshot(database), before);
    });
  } finally {
    fixtureDatabase?.close();
    database?.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
