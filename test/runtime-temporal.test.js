import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-runtime-'));
process.env.DATABASE_PATH = path.join(tempDir, 'runtime.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.AGENT_RUNTIME = 'pi';
process.env.GRAPH_STORE = 'sqlite';

const { db, initializeDatabase } = await import('../lib/db.js');
const { runAgentModel } = await import('../lib/pi-runtime.js');
const { listEvents, listGraph, storeEvent } = await import('../lib/memory.js');

initializeDatabase();

const scope = {
  userId: 'user_xiaoyu',
  agentId: 'agent_linwan',
  storyId: 'main_story',
  branchId: 'main'
};

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Pi runtime preserves the configured provider result and emits turn lifecycle events', async () => {
  const result = await runAgentModel({
    systemPrompt: '你是测试角色。',
    messages: [{ role: 'user', content: '你好' }],
    sessionId: 'runtime_test_session'
  });
  assert.match(result.text, /你好/);
  assert.equal(result.runtime.name, 'pi-agent-core');
  assert.equal(result.runtime.version, '0.84.2');
  assert.equal(result.runtime.lifecycle[0].type, 'agent_start');
  assert.equal(result.runtime.lifecycle.at(-1).type, 'agent_end');
  assert.ok(result.runtime.lifecycle.some((item) => item.type === 'turn_end'));
});

test('双时态事件可分别回放当时认知与当前历史真值', async () => {
  const eventKey = 'bitemporal-test-meeting';
  await storeEvent({
    event_key: eventKey,
    event_type: 'meeting',
    title: '周末会面',
    summary: '会面地点是上海。',
    valid_from: '2026-01-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '上海',
      valid_from: '2026-01-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '上海', type: 'place' }, valid_from: '2026-01-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_1');
  const first = db.prepare('SELECT * FROM events WHERE event_key = ? AND status = ?').get(eventKey, 'active');
  await new Promise((resolve) => setTimeout(resolve, 12));

  await storeEvent({
    event_key: eventKey,
    operation: 'supersede',
    event_type: 'meeting',
    title: '周末会面',
    summary: '更正：地点一直是杭州。',
    valid_from: '2026-01-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '杭州',
      operation: 'supersede', valid_from: '2026-01-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '杭州', type: 'place' }, operation: 'supersede',
      valid_from: '2026-01-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_2');
  const corrected = db.prepare('SELECT * FROM events WHERE event_key = ? AND status = ?').get(eventKey, 'active');
  const knownBeforeCorrection = new Date(
    (Date.parse(first.transaction_from) + Date.parse(corrected.transaction_from)) / 2
  ).toISOString();
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z', knownAt: knownBeforeCorrection })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['会面地点是上海。']
  );
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['更正：地点一直是杭州。']
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  await storeEvent({
    event_key: eventKey,
    operation: 'update',
    event_type: 'meeting',
    title: '周末会面',
    summary: '二月起地点改到北京。',
    valid_from: '2026-02-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '北京',
      operation: 'update', valid_from: '2026-02-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '北京', type: 'place' }, operation: 'update',
      valid_from: '2026-02-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_3');

  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['更正：地点一直是杭州。']
  );
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-03-01T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['二月起地点改到北京。']
  );
  assert.deepEqual(
    listGraph(scope, { validAt: '2026-01-15T00:00:00Z' }).edges
      .filter((item) => item.predicate === '发生于').map((item) => item.target_name),
    ['杭州']
  );
  assert.deepEqual(
    listGraph(scope, { validAt: '2026-03-01T00:00:00Z' }).edges
      .filter((item) => item.predicate === '发生于').map((item) => item.target_name),
    ['北京']
  );
});
