import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-'));
process.env.DATABASE_PATH = path.join(directory, 'memory.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'sqlite';
process.env.MEMORY_TENANT_ID = 'maintenance-test';
process.env.MEMORY_MAINTENANCE_ENABLED = 'true';
process.env.MEMORY_MAINTENANCE_IDLE_MS = String(15 * 60_000);
process.env.MEMORY_MAINTENANCE_MIN_NEW_TURNS = '24';
process.env.MEMORY_MAINTENANCE_MAX_WAIT_MS = String(24 * 60 * 60_000);
process.env.MEMORY_MAINTENANCE_COOLDOWN_MS = String(60 * 60_000);
process.env.MEMORY_MAINTENANCE_MAX_ATTEMPTS = '3';
process.env.MEMORY_MAINTENANCE_MAX_DAILY_CALLS = '1000';
process.env.MEMORY_MAINTENANCE_MAX_SCOPE_DAILY_CALLS = '100';
process.env.MEMORY_MAINTENANCE_MAX_DAILY_OUTPUT_TOKENS = '1000000';

const { db, initializeDatabase } = await import('../lib/db.js');
const { storeEvent } = await import('../lib/memory.js');
const { observeMemory, processMemoryJob } = await import('../lib/memory-service.js');
const { resolveMemoryTools } = await import('../lib/memory-tools.js');
const maintenance = await import('../lib/memory-maintenance.js');
const {
  ensureMemoryMaintenanceSchema, discoverMaintenanceActivity, getMemoryMaintenanceStatus,
  enqueueMemoryMaintenance, processMemoryMaintenanceRun, listMemoryMaintenanceCandidates,
  applyMemoryMaintenanceCandidate, rejectMemoryMaintenanceCandidate,
  beginMemoryMaintenanceTurn, endMemoryMaintenanceTurn
} = maintenance;

initializeDatabase();
ensureMemoryMaintenanceSchema();
let sequence = 0;
const uid = (prefix) => `${prefix}_${++sequence}`;
const BASE_TIME = Date.parse('2026-11-10T08:00:00.000Z');
const IDLE_TIME = BASE_TIME + 16 * 60_000;
const iso = (value) => new Date(value).toISOString();
const scopeFor = (label) => ({
  tenantId: 'maintenance-test', userId: 'user_xiaoyu', agentId: 'agent_linwan',
  storyId: `maintenance_${label}_${++sequence}`, branchId: 'main'
});
const generated = (output = {}) => ({
  text: JSON.stringify({ topics: [], openItems: [], proposals: [], ...output }),
  provider: 'test', model: 'maintenance-test', usage: { input_tokens: 12, output_tokens: 8 }
});
const rowCount = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
const protectedTables = [
  'messages', 'events', 'claims', 'entities', 'entity_edges', 'event_entities',
  'memory_values', 'memory_history', 'user_plot_states', 'user_prop_states', 'trigger_runs', 'tool_runs'
];
const snapshot = (tables = protectedTables) => Object.fromEntries(tables.map((table) =>
  [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

function addTurn(scope, { conversationId, at = BASE_TIME, userText = '计划周末去公园，尚未出发。', assistantText = '收到，计划仍待确认。' } = {}) {
  const id = conversationId || uid('maintenance_conversation');
  if (!conversationId) db.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, scope.userId, scope.agentId, scope.storyId, scope.branchId, iso(at), iso(at));
  const userId = uid('maintenance_user_message');
  const assistantId = uid('maintenance_assistant_message');
  const insert = db.prepare(`INSERT INTO messages (id, conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run(userId, id, scope.userId, 'user', userText, iso(at));
  insert.run(assistantId, id, scope.userId, 'assistant', assistantText, iso(at + 1000));
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(iso(at + 1000), id);
  return { conversationId: id, userId, assistantId, messageIds: [userId, assistantId] };
}

async function evidence(scope, name, place) {
  const turn = addTurn(scope, { userText: `${name}去了${place}，喜欢摄影。` });
  const event = await storeEvent({
    event_key: uid('maintenance_event'), event_type: 'episode', title: `${name}去${place}`,
    summary: `${name}去了${place}，喜欢摄影。`, valid_from: iso(BASE_TIME),
    entities: [{ name, type: 'person' }, { name: place, type: 'place' }],
    relations: [{ source: { name, type: 'person' }, predicate: 'located_at', target: { name: place, type: 'place' } }],
    claims: [{ subject: { name, type: 'person' }, predicate: '爱好', object: '摄影', valid_from: iso(BASE_TIME) }]
  }, scope, turn.userId, { projectGraph: false });
  const entity = db.prepare(`SELECT * FROM entities WHERE user_id = ? AND agent_id = ?
    AND story_id = ? AND branch_id = ? AND canonical_name = ? AND entity_type = 'person'`)
    .get(scope.userId, scope.agentId, scope.storyId, scope.branchId, name);
  return { ...turn, eventId: event.id, entityId: entity.id };
}

function scan(now = IDLE_TIME) {
  return discoverMaintenanceActivity({ limit: 1000, now: () => now });
}

async function queued(scope, now = IDLE_TIME) {
  await scan(now);
  const result = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => now });
  assert.equal(result.status, 'queued', JSON.stringify(result));
  assert.ok(result.run?.id);
  return result.run;
}

async function completedProposal(scope, first, second) {
  const run = await queued(scope);
  const result = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => generated({ proposals: [{
      type: 'entity_merge', title: '核对同一人的两个称呼', reason: '用户明确说明为同一人，待确认。',
      sourceMessageIds: [first.userId, second.userId],
      payload: { survivorId: first.entityId, sourceEntityIds: [second.entityId] }
    }] })
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const candidates = listMemoryMaintenanceCandidates(scope, {});
  assert.equal(candidates.length, 1);
  return candidates[0];
}

test.after(() => {
  maintenance.stopMemoryMaintenanceWorker();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('no new activity never enqueues work, including an explicit manual request', async () => {
  const scope = scopeFor('empty');
  const before = snapshot();
  const result = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => IDLE_TIME });
  assert.equal(result.status, 'skipped');
  assert.equal(result.run, null);
  assert.deepEqual(snapshot(), before);
  assert.equal(getMemoryMaintenanceStatus(scope).state.pendingUnits, 0);
});

test('one completed turn becomes eligible after idle time without requiring 24 turns', async () => {
  const scope = scopeFor('single_idle');
  addTurn(scope);
  await scan(BASE_TIME + 5 * 60_000);
  const early = await enqueueMemoryMaintenance(scope, { reason: 'idle', now: () => BASE_TIME + 5 * 60_000 });
  assert.equal(early.status, 'skipped');
  const eligible = await enqueueMemoryMaintenance(scope, { reason: 'idle', now: () => IDLE_TIME });
  assert.equal(eligible.status, 'queued', JSON.stringify(eligible));
});

test('an active turn blocks maintenance across branches and manual requests', async () => {
  const scope = scopeFor('busy');
  addTurn(scope);
  await scan();
  const turnToken = beginMemoryMaintenanceTurn({ ...scope, branchId: 'other' });
  try {
    const blocked = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => Date.now() });
    assert.equal(blocked.status, 'skipped');
    assert.equal(blocked.run, null);
    assert.equal(getMemoryMaintenanceStatus(scope).state.busy, true);
  } finally {
    endMemoryMaintenanceTurn(turnToken);
  }
  assert.equal((await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => Date.now() })).status, 'queued');
});

test('successful derived output does not mutate canonical memories or business triggers and reuses its watermark', async () => {
  const scope = scopeFor('derived_only');
  const turn = addTurn(scope);
  const run = await queued(scope);
  const before = snapshot();
  let calls = 0;
  const result = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => { calls += 1; return generated({
      topics: [{ title: '周末计划', summary: '周末去公园仍是计划，尚未发生。', sourceMessageIds: [turn.userId] }],
      openItems: [{ title: '确认周末安排', description: '时间尚待确认。', sourceMessageIds: [turn.userId] }]
    }); }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(calls, 1);
  assert.deepEqual(snapshot(), before);
  const status = getMemoryMaintenanceStatus(scope);
  assert.equal(status.topics.length, 1);
  assert.equal(status.openItems.length, 1);
  assert.equal(status.state.pendingUnits, 0);
  const repeat = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => IDLE_TIME + 3600_000 });
  assert.equal(repeat.status, 'skipped');
  await processMemoryMaintenanceRun(run.id, { generate() { assert.fail('completed run must not call the model twice'); } });
  assert.equal(getMemoryMaintenanceStatus(scope).topics.length, 1);
});

test('one lease owner generates while duplicate processing remains inert', async () => {
  const scope = scopeFor('lease');
  addTurn(scope);
  const run = await queued(scope);
  let resolveGeneration;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const pending = processMemoryMaintenanceRun(run.id, { now: () => IDLE_TIME, generate: () => {
    calls += 1; started();
    return new Promise((resolve) => { resolveGeneration = resolve; });
  } });
  await entered;
  const duplicate = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME, generate() { assert.fail('duplicate lease owner called model'); }
  });
  assert.equal(duplicate.status, 'running');
  resolveGeneration(generated());
  assert.equal((await pending).status, 'succeeded');
  assert.equal(calls, 1);
});

test('new activity arriving during generation remains beyond the fixed run watermark', async () => {
  const scope = scopeFor('fixed_watermark');
  const first = addTurn(scope);
  const run = await queued(scope);
  let second;
  const result = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => {
      second = addTurn(scope, { conversationId: first.conversationId, at: IDLE_TIME + 1000, userText: '后来补充：周末改去博物馆。' });
      await scan(IDLE_TIME + 2000);
      return generated({ topics: [{ title: '原计划', summary: '原先计划去公园。', sourceMessageIds: [first.userId] }] });
    }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const status = getMemoryMaintenanceStatus(scope);
  assert.equal(status.state.pendingTurns, 1);
  assert.equal(status.topics.length, 1);
  assert.doesNotMatch(JSON.stringify(status.topics), new RegExp(second.userId));
  const next = await queued(scope, IDLE_TIME + 3600_000);
  assert.notEqual(next.id, run.id);
});

test('edits to covered source text mark an in-flight run stale without consuming the source', async () => {
  const scope = scopeFor('edit_inflight');
  const turn = addTurn(scope);
  const run = await queued(scope);
  const pendingBefore = getMemoryMaintenanceStatus(scope).state.pendingUnits;
  const result = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => {
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('更正：公园计划已取消。', turn.userId);
      return generated({ topics: [{ title: '旧计划', summary: '准备去公园。', sourceMessageIds: [turn.userId] }] });
    }
  });
  assert.equal(result.status, 'stale', JSON.stringify(result));
  const status = getMemoryMaintenanceStatus(scope);
  assert.equal(status.topics.length, 0);
  assert.equal(status.state.pendingUnits, pendingBefore);
});

test('generation failure preserves source progress and retry does not duplicate derived output', async () => {
  const scope = scopeFor('retry');
  const turn = addTurn(scope);
  const run = await queued(scope);
  const before = getMemoryMaintenanceStatus(scope).state.pendingUnits;
  const failed = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME, generate: async () => { throw new Error('private upstream response: dummy-private-token-value'); }
  });
  assert.equal(failed.status, 'retry', JSON.stringify(failed));
  assert.doesNotMatch(JSON.stringify(failed), /dummy-private-token-value|private upstream response/);
  assert.equal(getMemoryMaintenanceStatus(scope).state.pendingUnits, before);
  const retried = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME + 24 * 3600_000,
    generate: async () => generated({ topics: [{ title: '计划', summary: '尚未发生。', sourceMessageIds: [turn.userId] }] })
  });
  assert.equal(retried.id, run.id);
  assert.equal(retried.status, 'succeeded', JSON.stringify(retried));
  assert.equal(getMemoryMaintenanceStatus(scope).topics.length, 1);
  assert.equal(getMemoryMaintenanceStatus(scope).state.pendingUnits, 0);
});

test('model-injected foreign evidence and foreign entity payloads are independently rejected', async () => {
  for (const injectForeignMessage of [true, false]) {
    const scope = scopeFor(`foreign_candidate_${injectForeignMessage}`);
    const first = await evidence(scope, '本地甲', '本地公园');
    const foreign = await evidence({ ...scope, branchId: 'foreign' }, '外部分支乙', '私密地点');
    const run = await queued(scope);
    const before = snapshot();
    await processMemoryMaintenanceRun(run.id, {
      now: () => IDLE_TIME,
      generate: async () => generated({ proposals: [{
        type: 'entity_merge', title: '越界提议', reason: '测试不可信模型输出',
        sourceMessageIds: injectForeignMessage ? [first.userId, foreign.userId] : [first.userId],
        payload: { survivorId: first.entityId, sourceEntityIds: [foreign.entityId] }
      }] })
    });
    assert.deepEqual(snapshot(), before);
    assert.equal(listMemoryMaintenanceCandidates(scope, {}).length, 0);
  }
});

test('only explicit candidate application uses entity repair and repeated approval is idempotent', async () => {
  const scope = scopeFor('apply');
  const first = await evidence(scope, '王老师', '教室');
  const second = await evidence(scope, '小王', '操场');
  const beforeGeneration = snapshot();
  const candidate = await completedProposal(scope, first, second);
  assert.deepEqual(snapshot(), beforeGeneration);
  const businessTables = ['memory_values', 'memory_history', 'user_plot_states', 'user_prop_states', 'trigger_runs', 'tool_runs'];
  const beforeBusiness = snapshot(businessTables);
  await assert.rejects(async () => applyMemoryMaintenanceCandidate({ ...scope, branchId: 'foreign' }, candidate.id, {
    actorId: scope.userId, idempotencyKey: `approval_${candidate.id}`, now: () => IDLE_TIME
  }), (error) => error.status === 404 || error.status === 403);
  const firstApplied = await applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: `approval_${candidate.id}`, now: () => IDLE_TIME
  });
  assert.ok(firstApplied);
  assert.deepEqual(snapshot(businessTables), beforeBusiness);
  const after = snapshot();
  const repairs = rowCount('entity_repairs');
  await applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: `approval_${candidate.id}`, now: () => IDLE_TIME
  });
  assert.deepEqual(snapshot(), after);
  assert.equal(rowCount('entity_repairs'), repairs);
  assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(second.entityId).status, 'merged');
});

test('source edits invalidate a pending candidate before any canonical repair', async () => {
  const scope = scopeFor('stale_approval');
  const first = await evidence(scope, '赵老师', '东楼');
  const second = await evidence(scope, '小赵', '西楼');
  const candidate = await completedProposal(scope, first, second);
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('更正：赵老师和小赵不是同一个人。', first.userId);
  const before = snapshot();
  const repairs = rowCount('entity_repairs');
  await assert.rejects(async () => applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: `approval_${candidate.id}`, now: () => IDLE_TIME
  }));
  assert.deepEqual(snapshot(), before);
  assert.equal(rowCount('entity_repairs'), repairs);
});

test('dismissing a candidate cannot mutate facts or invoke business triggers', async () => {
  const scope = scopeFor('dismiss');
  const first = await evidence(scope, '刘老师', '画室');
  const second = await evidence(scope, '小刘', '礼堂');
  const candidate = await completedProposal(scope, first, second);
  const before = snapshot();
  await rejectMemoryMaintenanceCandidate(scope, candidate.id, { actorId: scope.userId, note: '并非同一人', now: () => IDLE_TIME });
  assert.deepEqual(snapshot(), before);
  await assert.rejects(async () => applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: `approval_${candidate.id}`, now: () => IDLE_TIME
  }));
});

test('24 new turns can trigger before idle while cooldown still controls the next automatic run', async () => {
  const scope = scopeFor('batch_threshold');
  for (let index = 0; index < 24; index += 1) addTurn(scope, { at: BASE_TIME + index * 2000 });
  await scan(BASE_TIME + 60_000);
  const batch = await enqueueMemoryMaintenance(scope, { reason: 'idle', now: () => BASE_TIME + 60_000 });
  assert.equal(batch.status, 'queued');
  assert.equal((await processMemoryMaintenanceRun(batch.run.id, {
    now: () => BASE_TIME + 60_000, generate: async () => generated()
  })).status, 'succeeded');
  addTurn(scope, { at: BASE_TIME + 120_000 });
  await scan(BASE_TIME + 20 * 60_000);
  const cooldown = await enqueueMemoryMaintenance(scope, { reason: 'idle', now: () => BASE_TIME + 20 * 60_000 });
  assert.equal(cooldown.status, 'skipped');
  assert.equal(cooldown.reason, 'cooldown');
});

test('maximum wait handles old pending dialogue even when another recent turn resets idle time', async () => {
  const scope = scopeFor('maximum_wait');
  addTurn(scope, { at: BASE_TIME });
  const now = BASE_TIME + 25 * 3600_000;
  addTurn(scope, { at: now - 60_000 });
  await scan(now);
  assert.equal((await enqueueMemoryMaintenance(scope, { reason: 'idle', now: () => now })).status, 'queued');
});

test('accepted headless observations retain old-experience and preference source text without extracting facts', async () => {
  const scope = scopeFor('headless');
  const observation = await observeMemory({ scope, idempotencyKey: uid('observation'), extractionMode: 'async', messages: [
    { role: 'user', content: '补充一段去年的经历：2025年我去过成都。我平时不喜欢喝咖啡。' }
  ] });
  await processMemoryJob(observation.job.id);
  const run = await queued(scope);
  const before = snapshot();
  const result = await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async (request) => {
      const input = JSON.parse(request.messages[0].content);
      const raw = input.units.flatMap((unit) => unit.messages);
      assert.equal(raw.length, 1);
      assert.match(raw[0].content, /2025年.*成都.*不喜欢喝咖啡/);
      return generated({ topics: [{ title: '旅行经历与饮食偏好', summary: '用户补充2025年到访成都，明确不喜欢咖啡。', sourceMessageIds: [raw[0].id] }] });
    }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.deepEqual(snapshot(), before);
  const topic = getMemoryMaintenanceStatus(scope).topics[0];
  assert.equal(topic.sourceMessages.length, 1);
  assert.match(topic.sourceMessages[0].content, /2025年/);
});

test('a new active turn during generation defers commit and reuses prepared output without another model call', async () => {
  const scope = scopeFor('busy_at_commit');
  const turn = addTurn(scope);
  let clock = Date.now();
  const run = await queued(scope, clock);
  let token;
  try {
    const deferred = await processMemoryMaintenanceRun(run.id, {
      now: () => clock,
      generate: async () => {
        token = beginMemoryMaintenanceTurn(scope);
        return generated({ topics: [{ title: '待写入主题', summary: '计划尚待确认。', sourceMessageIds: [turn.userId] }] });
      }
    });
    assert.equal(deferred.status, 'retry');
    assert.equal(getMemoryMaintenanceStatus(scope).topics.length, 0);
    assert.equal(getMemoryMaintenanceStatus(scope).state.pendingTurns, 1);
  } finally { endMemoryMaintenanceTurn(token); }
  clock += maintenance.getMemoryMaintenancePolicy().workerPollMs + 1;
  const completed = await processMemoryMaintenanceRun(run.id, {
    now: () => clock, generate() { assert.fail('prepared output must be reused'); }
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(getMemoryMaintenanceStatus(scope).topics.length, 1);
});

test('an expired lease cannot let its late response overwrite the new owner result', async () => {
  const scope = scopeFor('lease_takeover');
  const turn = addTurn(scope);
  let clock = IDLE_TIME;
  const run = await queued(scope, clock);
  let finishOld;
  let enterOld;
  const started = new Promise((resolve) => { enterOld = resolve; });
  const old = processMemoryMaintenanceRun(run.id, {
    now: () => clock,
    generate: () => { enterOld(); return new Promise((resolve) => { finishOld = resolve; }); }
  });
  await started;
  clock += maintenance.getMemoryMaintenancePolicy().leaseMs + 1;
  const latest = await processMemoryMaintenanceRun(run.id, {
    now: () => clock,
    generate: async () => generated({ topics: [{ title: '新租约结果', summary: '有效结果', sourceMessageIds: [turn.userId] }] })
  });
  assert.equal(latest.status, 'succeeded');
  finishOld(generated({ topics: [{ title: '迟到的旧结果', summary: '不能覆盖', sourceMessageIds: [turn.userId] }] }));
  await old;
  const topics = getMemoryMaintenanceStatus(scope).topics;
  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, '新租约结果');
});

test('a candidate cannot be dismissed after its repair committed but before projection returned', async () => {
  const scope = scopeFor('concurrent_decision');
  const first = await evidence(scope, '张老师', '车站');
  const second = await evidence(scope, '小张', '机场');
  const candidate = await completedProposal(scope, first, second);
  const pendingApply = applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: uid('approval'), now: () => IDLE_TIME
  });
  try {
    assert.throws(() => rejectMemoryMaintenanceCandidate(scope, candidate.id, {
      actorId: scope.userId, note: '迟到的拒绝', now: () => IDLE_TIME
    }), (error) => error.status === 409);
  } finally { await pendingApply; }
  assert.equal(listMemoryMaintenanceCandidates(scope, {})[0].status, 'applied');
});

test('fact conflict suggestions remain review-only and never enter canonical repair', async () => {
  const scope = scopeFor('fact_conflict');
  const turn = addTurn(scope, { userText: '之前说的周末时间可能有误，需要核对原文。' });
  const run = await queued(scope);
  assert.equal((await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => generated({ proposals: [{ type: 'fact_conflict', title: '核对时间', reason: '用户明确表示不确定。', sourceMessageIds: [turn.userId], payload: {} }] })
  })).status, 'succeeded');
  const candidate = listMemoryMaintenanceCandidates(scope, {})[0];
  const before = snapshot();
  await assert.rejects(applyMemoryMaintenanceCandidate(scope, candidate.id, {
    actorId: scope.userId, idempotencyKey: uid('approval'), now: () => IDLE_TIME
  }), { status: 409 });
  assert.deepEqual(snapshot(), before);
});

test('daily reservations block a second concurrent model call and preserve that run for the next day', async () => {
  const priorBudget = process.env.MEMORY_MAINTENANCE_MAX_DAILY_CALLS;
  process.env.MEMORY_MAINTENANCE_MAX_DAILY_CALLS = '1';
  let clock = Date.parse('2030-01-01T12:00:00.000Z');
  const firstScope = scopeFor('daily_first');
  const nextScope = scopeFor('daily_next');
  addTurn(firstScope); addTurn(nextScope);
  let finish;
  let pending;
  try {
    const firstRun = await queued(firstScope, clock);
    const nextRun = await queued(nextScope, clock);
    let enter;
    const started = new Promise((resolve) => { enter = resolve; });
    pending = processMemoryMaintenanceRun(firstRun.id, { now: () => clock, generate: () => {
      enter(); return new Promise((resolve) => { finish = resolve; });
    } });
    await started;
    const limited = await processMemoryMaintenanceRun(nextRun.id, {
      now: () => clock, generate() { assert.fail('daily reservation must prevent the second call'); }
    });
    assert.equal(limited.status, 'retry');
    assert.equal(limited.attempts, 0);
    assert.equal(getMemoryMaintenanceStatus(nextScope).state.pendingTurns, 1);
    finish(generated());
    assert.equal((await pending).status, 'succeeded');
    clock += 86400_000;
    let calls = 0;
    const resumed = await processMemoryMaintenanceRun(nextRun.id, {
      now: () => clock, generate: async () => { calls += 1; return generated(); }
    });
    assert.equal(resumed.status, 'succeeded');
    assert.equal(calls, 1);
  } finally {
    if (finish) finish(generated());
    if (pending) await pending;
    process.env.MEMORY_MAINTENANCE_MAX_DAILY_CALLS = priorBudget;
  }
});

test('manual requests cannot bypass the source-size limit or consume oversized originals', async () => {
  const scope = scopeFor('source_budget');
  addTurn(scope, { userText: '不能截断的完整原文'.repeat(300) });
  await scan();
  const previous = process.env.MEMORY_MAINTENANCE_MAX_SOURCE_CHARS;
  process.env.MEMORY_MAINTENANCE_MAX_SOURCE_CHARS = '500';
  try {
    const result = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => IDLE_TIME });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'source_budget_exceeded');
    assert.equal(getMemoryMaintenanceStatus(scope).state.pendingTurns, 1);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_MAINTENANCE_MAX_SOURCE_CHARS;
    else process.env.MEMORY_MAINTENANCE_MAX_SOURCE_CHARS = previous;
  }
});

test('later corrections receive prior sourced context and closed items stop being recalled as open', async () => {
  const scope = scopeFor('prior_context');
  const first = addTurn(scope, { userText: '周末去公园的计划还没完成。' });
  const firstRun = await queued(scope);
  assert.equal((await processMemoryMaintenanceRun(firstRun.id, {
    now: () => IDLE_TIME,
    generate: async () => generated({ openItems: [{ title: '周末公园', description: '计划尚未完成。', status: 'open', sourceMessageIds: [first.userId] }] })
  })).status, 'succeeded');
  const second = addTurn(scope, { conversationId: first.conversationId, at: IDLE_TIME + 3600_000,
    userText: '取消去公园，我改去博物馆，时间还没定。' });
  const nextRun = await queued(scope, IDLE_TIME + 7200_000);
  const next = await processMemoryMaintenanceRun(nextRun.id, {
    now: () => IDLE_TIME + 7200_000,
    generate: async (request) => {
      const input = JSON.parse(request.messages[0].content);
      assert.equal(input.previous.openItems[0].title, '周末公园');
      assert.ok(input.previous.units.some((unit) => unit.messages.some((message) => message.id === first.userId)));
      return generated({ openItems: [
        { title: '周末公园', description: '用户已经取消。', status: 'cancelled', sourceMessageIds: [first.userId, second.userId] },
        { title: '博物馆', description: '时间待定。', status: 'open', sourceMessageIds: [second.userId] }
      ] });
    }
  });
  assert.equal(next.status, 'succeeded', JSON.stringify(next));
  const recalled = maintenance.searchMaintenanceMemory(scope, '周末公园');
  assert.equal(recalled.filter((item) => item.kind === 'open_item').length, 0);
  assert.equal(maintenance.searchMaintenanceMemory(scope, '博物馆').some((item) => item.kind === 'open_item'), true);
  const third = addTurn(scope, { conversationId: first.conversationId, at: IDLE_TIME + 10800_000,
    userText: '今天已经去过博物馆了，这件事完成。' });
  const finalRun = await queued(scope, IDLE_TIME + 14400_000);
  const final = await processMemoryMaintenanceRun(finalRun.id, {
    now: () => IDLE_TIME + 14400_000,
    generate: async (request) => {
      const input = JSON.parse(request.messages[0].content);
      assert.equal(input.previous.openItems.find((item) => item.title === '博物馆').status, 'open');
      return generated({ openItems: [
        { title: '博物馆', description: '用户明确说明已经完成。', status: 'completed', sourceMessageIds: [second.userId, third.userId] }
      ] });
    }
  });
  assert.equal(final.status, 'succeeded', JSON.stringify(final));
  assert.equal(getMemoryMaintenanceStatus(scope).openItems.find((item) => item.title === '博物馆').status, 'completed');
  assert.equal(maintenance.searchMaintenanceMemory(scope, '博物馆').filter((item) => item.kind === 'open_item').length, 0);
});

test('headless extraction none and unfinished extraction jobs never become maintenance sources', async () => {
  const disabledScope = scopeFor('observation_none');
  await observeMemory({ scope: disabledScope, idempotencyKey: uid('none'), extractionMode: 'none', messages: [
    { role: 'user', content: '仅存原文，调用者禁用了抽取。' }
  ] });
  await scan();
  const disabled = await enqueueMemoryMaintenance(disabledScope, { reason: 'manual', now: () => IDLE_TIME });
  assert.equal(disabled.status, 'skipped');
  assert.equal(disabled.reason, 'no_new_activity');

  const pendingScope = scopeFor('observation_pending');
  const observation = await observeMemory({ scope: pendingScope, idempotencyKey: uid('pending'), extractionMode: 'async', messages: [
    { role: 'user', content: '上游原文仍在抽取队列中。' }
  ] });
  for (const status of ['queued', 'running']) {
    assert.equal(db.prepare('UPDATE memory_observations SET status = ? WHERE id = ?').run(status, observation.id).changes, 1);
    await scan();
    const skipped = await enqueueMemoryMaintenance(pendingScope, { reason: 'manual', now: () => IDLE_TIME });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'no_new_activity');
  }
});

test('a disabled extraction profile blocks automatic discovery and manual model work', async () => {
  const scope = scopeFor('disabled_profile');
  addTurn(scope);
  const profile = db.prepare(`SELECT ep.id, ep.enabled FROM event_extraction_profiles ep JOIN agents a ON a.scene_id=ep.scene_id
    WHERE a.id=?`).get(scope.agentId);
  assert.ok(profile);
  db.prepare('UPDATE event_extraction_profiles SET enabled=0 WHERE id=?').run(profile.id);
  try {
    await scan();
    const result = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => IDLE_TIME });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'extraction_disabled');
    assert.equal(getMemoryMaintenanceStatus(scope).state.pendingUnits, 0);
  } finally {
    db.prepare('UPDATE event_extraction_profiles SET enabled=? WHERE id=?').run(profile.enabled, profile.id);
  }
});

test('normal memory_search returns scoped derived items with bounded original evidence and drops stale or completed items', async () => {
  const scope = scopeFor('normal_memory_tool');
  const original = '青松摄影计划的时间还没有确定，器材准备已经完成。' + '原文证据'.repeat(600) + 'SOURCE_TAIL_OUTSIDE_TOOL_BUDGET';
  const turn = addTurn(scope, { userText: original });
  const run = await queued(scope);
  assert.equal((await processMemoryMaintenanceRun(run.id, {
    now: () => IDLE_TIME,
    generate: async () => generated({
      topics: [{ title: '青松摄影主题', summary: '用户讨论了青松摄影计划，时间待确认。', sourceMessageIds: [turn.userId] }],
      openItems: [
        { title: '青松摄影出行', description: '确认出行时间。', status: 'open', sourceMessageIds: [turn.userId] },
        { title: '青松摄影器材准备', description: '器材准备已经完成。', status: 'completed', sourceMessageIds: [turn.userId] }
      ]
    })
  })).status, 'succeeded');

  const foreignScope = { ...scope, branchId: 'foreign' };
  const foreign = addTurn(foreignScope, { userText: '外部分支青松摄影私密安排。' });
  const foreignRun = await queued(foreignScope);
  assert.equal((await processMemoryMaintenanceRun(foreignRun.id, {
    now: () => IDLE_TIME,
    generate: async () => generated({ topics: [{ title: '青松摄影外部分支', summary: '外部分支私密安排', sourceMessageIds: [foreign.userId] }] })
  })).status, 'succeeded');

  const search = async () => {
    const resolved = resolveMemoryTools({ scope, originalQuery: '还记得之前青松摄影的计划吗？', strategy: {
      agentMemoryToolsEnabled: true, agentMemoryMaxCalls: 2, agentMemoryMaxQueries: 3,
      eventTopK: 4, claimTopK: 20, edgeTopK: 20, graphHops: 1
    } });
    const tool = resolved.tools.find((item) => item.name === 'memory_search');
    assert.ok(tool);
    assert.equal(resolved.diagnostics.scopeLocked, true);
    return tool.execute(uid('maintenance_tool_call'), { query: '青松摄影', alternative_queries: [] }, new AbortController().signal);
  };
  const result = await search();
  assert.equal(result.details.readOnly, true);
  const structured = result.details.structuredContent;
  assert.equal(structured.scopeLocked, true);
  assert.deepEqual(new Set(structured.derivedMemory.map((item) => item.kind)), new Set(['topic', 'open_item']));
  assert.equal(structured.derivedMemory.length, 2);
  for (const item of structured.derivedMemory) {
    assert.equal(item.sourceRefs.length, 1);
    assert.equal(item.sourceRefs[0].id, turn.userId);
    assert.equal(item.sourceMessages.length, 1);
    assert.equal(item.sourceMessages[0].id, turn.userId);
    assert.equal(item.sourceMessages[0].content, original.slice(0, 2000));
  }
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  assert.match(text, /后台整理的辅助主题与未完成事项/);
  assert.match(text, /青松摄影计划的时间还没有确定，器材准备已经完成/);
  assert.match(text, /"sourceMessages"/);
  assert.doesNotMatch(text, /SOURCE_TAIL_OUTSIDE_TOOL_BUDGET|外部分支私密安排|"title":"青松摄影器材准备"/);
  assert.doesNotMatch(JSON.stringify(structured.derivedMemory), new RegExp(foreign.userId));

  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('更正：青松摄影计划已经取消。', turn.userId);
  const afterEdit = await search();
  assert.deepEqual(afterEdit.details.structuredContent.derivedMemory, []);
  const afterText = afterEdit.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  assert.doesNotMatch(afterText, /用户讨论了青松摄影计划|确认出行时间|外部分支私密安排|"kind":"open_item"/);
});

test('deleted pending sources are quarantined without advancing success and later valid edits are freshly processed', async () => {
  const scope = scopeFor('deleted_source_recovery');
  const first = addTurn(scope, { userText: '此前已经整理的有效对话。' });
  const baselineRun = await queued(scope);
  assert.equal((await processMemoryMaintenanceRun(baselineRun.id, {
    now: () => IDLE_TIME, generate: async () => generated()
  })).status, 'succeeded');
  const successfulVersion = getMemoryMaintenanceStatus(scope).state.lastSuccessVersion;

  const deleted = addTurn(scope, { conversationId: first.conversationId, at: IDLE_TIME + 3600_000,
    userText: '这段尚未整理的原文稍后会被删除。' });
  const staleRun = await queued(scope, IDLE_TIME + 7200_000);
  const runBefore = db.prepare('SELECT * FROM memory_maintenance_runs WHERE id=?').get(staleRun.id);
  assert.equal(db.prepare('DELETE FROM messages WHERE id=?').run(deleted.userId).changes, 1);
  const valid = addTurn(scope, { conversationId: first.conversationId, at: IDLE_TIME + 10800_000,
    userText: '后续有效对话：准备参观科技馆。' });

  const maintenanceTables = ['memory_maintenance_sources', 'memory_maintenance_states', 'memory_maintenance_runs', 'memory_maintenance_proposals'];
  const beforeRead = snapshot(maintenanceTables);
  getMemoryMaintenanceStatus(scope);
  assert.deepEqual(snapshot(maintenanceTables), beforeRead);
  const discovered = await scan(IDLE_TIME + 14400_000);
  assert.ok(discovered.discarded >= 1);
  const quarantined = db.prepare('SELECT * FROM memory_maintenance_sources WHERE source_key=?').get(`chat:${deleted.assistantId}`);
  assert.equal(quarantined.discard_reason, 'source_deleted_or_out_of_scope');
  assert.ok(quarantined.discarded_at);
  assert.equal(quarantined.processed_run_id, '');
  assert.deepEqual(db.prepare('SELECT * FROM memory_maintenance_runs WHERE id=?').get(staleRun.id), runBefore);
  assert.equal(getMemoryMaintenanceStatus(scope).state.lastSuccessVersion, successfulVersion);
  assert.equal(db.prepare('SELECT status FROM memory_maintenance_runs WHERE id=?').get(baselineRun.id).status, 'succeeded');
  assert.equal((await processMemoryMaintenanceRun(staleRun.id, {
    now: () => IDLE_TIME + 14400_000, generate() { assert.fail('deleted source must never reach the model'); }
  })).status, 'stale');
  assert.equal(getMemoryMaintenanceStatus(scope).state.lastSuccessVersion, successfulVersion);

  const corrected = '后续有效对话已更正：准备参观自然博物馆，尚未出发。';
  db.prepare('UPDATE messages SET content=? WHERE id=?').run(corrected, valid.userId);
  await scan(IDLE_TIME + 14400_000);
  const validSource = db.prepare('SELECT * FROM memory_maintenance_sources WHERE source_key=?').get(`chat:${valid.assistantId}`);
  assert.equal(validSource.discard_reason, '');
  const next = await queued(scope, IDLE_TIME + 14400_000);
  const result = await processMemoryMaintenanceRun(next.id, {
    now: () => IDLE_TIME + 14400_000,
    generate: async (request) => {
      const input = JSON.parse(request.messages[0].content);
      const sources = input.units.flatMap((unit) => unit.messages);
      assert.equal(sources.some((message) => message.id === deleted.userId), false);
      assert.equal(sources.find((message) => message.id === valid.userId).content, corrected);
      return generated({ topics: [{ title: '自然博物馆计划', summary: '尚未出发。', sourceMessageIds: [valid.userId] }] });
    }
  });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(getMemoryMaintenanceStatus(scope).state.pendingUnits, 0);
  assert.ok(getMemoryMaintenanceStatus(scope).state.lastSuccessVersion > successfulVersion);
  assert.equal(db.prepare('SELECT processed_run_id FROM memory_maintenance_sources WHERE seq=?').get(validSource.seq).processed_run_id, next.id);
  assert.equal(db.prepare('SELECT processed_run_id FROM memory_maintenance_sources WHERE seq=?').get(quarantined.seq).processed_run_id, '');
});

test('runtime authorization rejects historical work without capture, queueing, model calls or budget consumption', async () => {
  const scope = scopeFor('authorization_missing');
  addTurn(scope);
  let captures = 0;
  let calls = 0;
  maintenance.configureMemoryMaintenanceRuntime({
    capture() { captures += 1; },
    canRun() { return false; },
    run() { assert.fail('unauthorized work must never enter its execution context'); }
  });
  try {
    await scan();
    const result = await enqueueMemoryMaintenance(scope, { reason: 'manual', now: () => IDLE_TIME });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'authorization_required');
    assert.equal(result.run, null);
    const observedTables = ['memory_maintenance_sources', 'memory_maintenance_states', 'memory_maintenance_runs',
      'memory_maintenance_proposals', 'memory_maintenance_model_calls'];
    const beforeRead = snapshot(observedTables);
    assert.equal(getMemoryMaintenanceStatus(scope).state.eligibility.reason, 'authorization_required');
    getMemoryMaintenanceStatus(scope);
    assert.deepEqual(snapshot(observedTables), beforeRead);
    const callsBefore = rowCount('memory_maintenance_model_calls');
    const runsBefore = rowCount('memory_maintenance_runs');
    await maintenance.runMemoryMaintenanceTick({ limit: 20, now: () => IDLE_TIME,
      generate: async () => { calls += 1; return generated(); } });
    assert.equal(calls, 0);
    assert.equal(captures, 0);
    assert.equal(rowCount('memory_maintenance_model_calls'), callsBefore);
    assert.equal(rowCount('memory_maintenance_runs'), runsBefore);
    assert.deepEqual(maintenance.listMemoryMaintenanceRuns(scope), []);
  } finally { maintenance.configureMemoryMaintenanceRuntime({}); }
});

test('captured scope actors are restored for generation and missing retry authorization consumes no attempt or budget', async () => {
  const scope = scopeFor('captured_actor');
  const otherScope = { ...scope, branchId: 'another_branch' };
  const first = addTurn(scope);
  const second = addTurn(otherScope);
  const storage = new AsyncLocalStorage();
  const captured = new Map();
  const capturedScopes = [];
  const scopeKey = (value) => JSON.stringify([value.tenantId, value.subjectId, value.agentId, value.spaceId, value.branchId]);
  maintenance.configureMemoryMaintenanceRuntime({
    capture(value) {
      capturedScopes.push(value);
      const actor = storage.getStore();
      if (actor) captured.set(scopeKey(value), actor);
    },
    canRun(value) { return captured.has(scopeKey(value)); },
    run(value, callback) {
      const actor = captured.get(scopeKey(value));
      assert.ok(actor, 'execution must have a captured actor');
      return storage.run(actor, callback);
    }
  });
  try {
    const token = storage.run({ id: 'actor-first' }, () => beginMemoryMaintenanceTurn(scope, { now: () => IDLE_TIME }));
    endMemoryMaintenanceTurn(token);
    storage.run({ id: 'actor-second' }, () => maintenance.captureMemoryMaintenanceContext(otherScope));
    assert.equal(capturedScopes.length, 2);
    assert.equal(capturedScopes[0].subjectId, scope.userId);
    assert.equal(capturedScopes[0].spaceId, scope.storyId);
    assert.notEqual(scopeKey(capturedScopes[0]), scopeKey(capturedScopes[1]));
    const run = await queued(scope);
    const failed = await processMemoryMaintenanceRun(run.id, {
      now: () => IDLE_TIME,
      generate: async () => {
        assert.equal(storage.getStore()?.id, 'actor-first');
        throw new Error('simulated provider failure');
      }
    });
    assert.equal(failed.status, 'retry');
    assert.equal(storage.getStore(), undefined);
    captured.delete(scopeKey(capturedScopes[0]));
    const before = db.prepare('SELECT * FROM memory_maintenance_runs WHERE id=?').get(run.id);
    const callsBefore = rowCount('memory_maintenance_model_calls');
    await processMemoryMaintenanceRun(run.id, {
      now: () => IDLE_TIME + 60_000,
      generate() { assert.fail('missing actor must not issue a retry request'); }
    });
    assert.deepEqual(db.prepare('SELECT * FROM memory_maintenance_runs WHERE id=?').get(run.id), before);
    assert.equal(rowCount('memory_maintenance_model_calls'), callsBefore);
    const readonlyTables = ['memory_maintenance_sources', 'memory_maintenance_states', 'memory_maintenance_runs', 'memory_maintenance_model_calls'];
    const beforeRead = snapshot(readonlyTables);
    getMemoryMaintenanceStatus(scope);
    assert.deepEqual(snapshot(readonlyTables), beforeRead);
    assert.equal(capturedScopes.length, 2);

    storage.run({ id: 'actor-first-renewed' }, () => maintenance.captureMemoryMaintenanceContext(scope));
    const resumed = await processMemoryMaintenanceRun(run.id, {
      now: () => IDLE_TIME + 60_000,
      generate: async () => {
        assert.equal(storage.getStore()?.id, 'actor-first-renewed');
        return generated({ topics: [{ title: '身份恢复后的主题', summary: '计划待确认。', sourceMessageIds: [first.userId] }] });
      }
    });
    assert.equal(resumed.status, 'succeeded');
    const otherRun = await queued(otherScope, IDLE_TIME + 60_000);
    assert.equal((await processMemoryMaintenanceRun(otherRun.id, {
      now: () => IDLE_TIME + 60_000,
      generate: async () => {
        assert.equal(storage.getStore()?.id, 'actor-second');
        return generated({ topics: [{ title: '另一个分支的主题', summary: '独立身份上下文。', sourceMessageIds: [second.userId] }] });
      }
    })).status, 'succeeded');
    assert.equal(storage.getStore(), undefined);
  } finally { maintenance.configureMemoryMaintenanceRuntime({}); }
});
