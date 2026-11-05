import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-review-'));
process.env.DATABASE_PATH = path.join(tempDir, 'reviews.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'sqlite';
process.env.MEMORY_TENANT_ID = 'review-tenant';

const { db, initializeDatabase } = await import('../lib/db.js');
const { storeEvent } = await import('../lib/memory.js');
const { observeMemory } = await import('../lib/memory-service.js');
const { uid, nowIso } = await import('../lib/utils.js');
const {
  migrateMemoryReviews, generateMemoryReview, getMemoryReview, listMemoryReviews, getMemoryReadiness
} = await import('../lib/memory-review.js');

initializeDatabase();
migrateMemoryReviews();

const baseScope = {
  userId: 'user_xiaoyu', agentId: 'agent_linwan', storyId: 'review_story', branchId: 'main'
};
const period = { period: 'weekly', date: '2026-11-05' };

function newScope(label) {
  return { ...baseScope, storyId: `review_${label}` };
}

function addMessage(scope, content = '我和你在公园散步。') {
  const conversationId = uid('review_conversation');
  const id = uid('review_message');
  const timestamp = nowIso();
  db.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(conversationId, scope.userId, scope.agentId, scope.storyId, scope.branchId, timestamp, timestamp);
  db.prepare(`INSERT INTO messages (id, conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)`)
    .run(id, conversationId, scope.userId, content, timestamp);
  return id;
}

async function addEvent(scope, overrides = {}, messageId = '') {
  return storeEvent({
    event_key: uid('review_event_key'), event_type: 'episode', title: '共同散步',
    summary: '用户和角色在公园散步。', story_time: '2026-11-03',
    valid_from: '2026-11-03T00:00:00.000Z', ...overrides
  }, scope, messageId, { projectGraph: false });
}

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('weekly and monthly reviews use active events and server-bound versioned sources', async () => {
  const scope = newScope('periods');
  const messageId = addMessage(scope);
  const first = await addEvent(scope, { event_key: 'walk' }, messageId);
  await addEvent(scope, { title: '看电影', story_time: '2026-11-01' });
  await addEvent({ ...scope, branchId: 'alternate' }, { title: '另一个分支的私密事件' });
  const weekly = await generateMemoryReview(scope, period);
  assert.equal(weekly.status, 'ready');
  assert.equal(weekly.usableAsEvidence, true);
  assert.equal(weekly.provider, 'mock');
  assert.equal(weekly.startDate, '2026-11-02');
  assert.equal(weekly.endDate, '2026-11-08');
  assert.equal(weekly.sourceRefs.length, 1);
  assert.equal(weekly.sourceRefs[0].eventId, first.id);
  assert.equal(weekly.sourceRefs[0].version, 1);
  assert.equal(weekly.sourceRefs[0].messages[0].id, messageId);
  assert.match(weekly.content, /共同散步/);
  assert.doesNotMatch(weekly.content, /私密|电影/);
  const monthly = await generateMemoryReview(scope, { period: 'monthly', date: '2026-11-05' });
  assert.equal(monthly.sourceRefs.length, 2);
  assert.equal(monthly.startDate, '2026-11-01');
  assert.equal(monthly.endDate, '2026-11-30');
});

test('same request is idempotent and force refresh uses the provider again', async () => {
  const scope = newScope('idempotency');
  await addEvent(scope);
  let calls = 0;
  const generate = async () => ({ text: `回顾 ${++calls}`, provider: 'test', model: 'test-model', sourceRefs: ['invented'] });
  const first = await generateMemoryReview(scope, period, { generate });
  const second = await generateMemoryReview(scope, period, { generate });
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  assert.equal(first.sourceRefs[0].eventId.startsWith('event_'), true);
  const refreshed = await generateMemoryReview(scope, { ...period, force: true }, { generate });
  assert.equal(refreshed.content, '回顾 2');
  assert.equal(listMemoryReviews(scope).length, 1);
});

test('correction and retraction mark summaries stale and refresh current evidence', async () => {
  const scope = newScope('correction');
  await addEvent(scope, { event_key: 'destination', summary: '我们去了公园。' });
  const first = await generateMemoryReview(scope, period);
  const corrected = await addEvent(scope, { event_key: 'destination', operation: 'supersede', summary: '更正，我们去了博物馆。' });
  const stale = getMemoryReview(first.id, scope);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.usableAsEvidence, false);
  assert.equal(stale.stale, true);
  const fresh = await generateMemoryReview(scope, period);
  assert.equal(fresh.sourceRefs.length, 1);
  assert.equal(fresh.sourceRefs[0].eventId, corrected.id);
  assert.equal(fresh.sourceRefs[0].version, 2);
  assert.match(fresh.content, /博物馆/);
  await addEvent(scope, { event_key: 'destination', operation: 'retract' });
  assert.equal(getMemoryReview(first.id, scope).usableAsEvidence, false);
  const empty = await generateMemoryReview(scope, period);
  assert.equal(empty.status, 'empty');
  assert.equal(empty.content, '');
  assert.equal(empty.usableAsEvidence, false);
  assert.equal((await generateMemoryReview(scope, period)).reused, true);
  await addEvent(scope, { title: '范围内后来加入的事件' });
  assert.equal(getMemoryReview(first.id, scope).status, 'stale');
});

test('original text edits invalidate a summary even if event id did not change', async () => {
  const scope = newScope('raw_change');
  const messageId = addMessage(scope);
  await addEvent(scope, {}, messageId);
  const review = await generateMemoryReview(scope, period);
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('原文已更正。', messageId);
  assert.equal(getMemoryReview(review.id, scope).status, 'stale');
});

test('failed regeneration retains prior content but blocks use as current evidence', async () => {
  const scope = newScope('failure');
  await addEvent(scope);
  const first = await generateMemoryReview(scope, period);
  const failed = await generateMemoryReview(scope, { ...period, force: true }, {
    generate: async () => { throw new Error('secret API response'); }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.content, first.content);
  assert.equal(failed.usableAsEvidence, false);
  assert.doesNotMatch(failed.lastError, /secret/);
  assert.equal((await generateMemoryReview(scope, period)).status, 'ready');
});

test('concurrent generation has one owner and detects sources changed during generation', async () => {
  const scope = newScope('concurrent');
  await addEvent(scope, { event_key: 'live_change' });
  let finish;
  const pending = generateMemoryReview(scope, period, {
    generate: () => new Promise((resolve) => { finish = resolve; })
  });
  const duplicate = await generateMemoryReview(scope, { ...period, force: true });
  assert.equal(duplicate.inProgress, true);
  assert.equal(duplicate.reused, true);
  await addEvent(scope, { event_key: 'live_change', operation: 'supersede', summary: '新内容' });
  finish({ text: '旧来源生成的回顾', provider: 'test' });
  const stale = await pending;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.usableAsEvidence, false);
});

test('scope and raw evidence are isolated and invalid ranges are rejected', async () => {
  const scope = newScope('isolation');
  const other = { ...scope, branchId: 'other' };
  const foreignMessage = addMessage(other, '另一分支的秘密');
  await addEvent(scope, {}, foreignMessage);
  const review = await generateMemoryReview(scope, period);
  assert.equal(review.sourceRefs[0].messages.length, 0);
  assert.equal(getMemoryReview(review.id, other), null);
  assert.deepEqual(listMemoryReviews(other), []);
  assert.throws(() => getMemoryReadiness({ ...scope, tenantId: 'foreign' }), { code: 'MEMORY_TENANT_FORBIDDEN' });
  await assert.rejects(generateMemoryReview(scope, { date: '2026-02-30' }), { code: 'MEMORY_REVIEW_DATE_INVALID' });
  await assert.rejects(generateMemoryReview(scope, { startDate: '2026-11-01' }), { code: 'MEMORY_REVIEW_RANGE_INVALID' });
  const filtered = await generateMemoryReview(scope, { ...period, topic: '不存在的主题' });
  assert.equal(filtered.status, 'empty');
});

test('readiness separates saved sources, persisted jobs, usable indexes and model configuration', async () => {
  const scope = newScope('readiness');
  addMessage(scope);
  const event = await addEvent(scope);
  const queued = await observeMemory({
    scope, idempotencyKey: 'review-readiness-job', extractionMode: 'async',
    messages: [{ role: 'user', content: '保存原文' }, { role: 'assistant', content: '收到' }]
  });
  const pending = getMemoryReadiness(scope);
  assert.equal(pending.source.status, 'saved');
  assert.equal(pending.source.observationMessages, 2);
  assert.equal(pending.extraction.pending, 1);
  assert.equal(pending.index.activeEvents, 1);
  assert.equal(pending.index.vectorIndexed, 1);
  assert.equal(pending.configuration.connectionVerified, false);
  assert.equal(pending.configuration.mode, 'mock');
  db.prepare("UPDATE memory_jobs SET status = 'dead', last_error = 'failed' WHERE id = ?").run(queued.job.id);
  db.prepare("DELETE FROM embeddings WHERE owner_type = 'event' AND owner_id = ?").run(event.id);
  const failed = getMemoryReadiness(scope);
  assert.equal(failed.extraction.failed, 1);
  assert.equal(failed.index.pending, 1);
  assert.equal(failed.index.failed, null);
  assert.equal(getMemoryReadiness({ ...scope, branchId: 'empty' }).source.status, 'empty');
});
