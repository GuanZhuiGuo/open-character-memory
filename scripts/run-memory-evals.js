import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-eval-'));
process.env.DATABASE_PATH = path.join(tempDir, 'eval.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';

const { db, initializeDatabase } = await import('../lib/db.js');
const {
  ensureEntity, getMemoryValue, retrieveMemory, setMemoryValue, storeEvent
} = await import('../lib/memory.js');
const { evaluateTriggers, getActivePlots } = await import('../lib/triggers.js');
const { nowIso, uid } = await import('../lib/utils.js');

initializeDatabase();

const cases = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../evals/memory-regression.json'), 'utf8'));
const byId = new Map(cases.map((item) => [item.id, item]));
const baseScope = { userId: 'user_xiaoyu', agentId: 'agent_linwan', storyId: 'main_story', branchId: 'main' };
const results = [];

async function run(id, handler) {
  const startedAt = Date.now();
  try {
    await handler();
    results.push({ id, name: byId.get(id)?.name || id, status: 'passed', durationMs: Date.now() - startedAt });
  } catch (error) {
    results.push({ id, name: byId.get(id)?.name || id, status: 'failed', durationMs: Date.now() - startedAt, error: error.message });
  }
}

await run('stale-correction', async () => {
  const subject = ensureEntity(baseScope, { name: '周末见面', type: 'event' });
  const timestamp = nowIso();
  db.prepare(`INSERT INTO claims
    (id, user_id, agent_id, story_id, branch_id, subject_entity_id, predicate, object_text,
     fact_scope, modality, status, version, source_speaker, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '地点', '新宿', 'world_fact', 'asserted', 'superseded', 1, 'user', 1, ?, ?)`)
    .run(uid('claim'), baseScope.userId, baseScope.agentId, baseScope.storyId, baseScope.branchId, subject.id, timestamp, timestamp);
  db.prepare(`INSERT INTO claims
    (id, user_id, agent_id, story_id, branch_id, subject_entity_id, predicate, object_text,
     fact_scope, modality, status, version, source_speaker, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '地点', '银座', 'world_fact', 'asserted', 'active', 2, 'user', 1, ?, ?)`)
    .run(uid('claim'), baseScope.userId, baseScope.agentId, baseScope.storyId, baseScope.branchId, subject.id, timestamp, timestamp);
  const memory = await retrieveMemory('周末见面在哪里', baseScope);
  assert.deepEqual(memory.claims.map((claim) => claim.object), ['银座']);
});

await run('noise-rejection', async () => {
  await storeEvent({
    event_key: 'dream_white_swan', event_type: 'dream', title: '白色天鹅的梦',
    summary: '用户梦见白色天鹅在有雾气的湖面游远。', importance: 0.6,
    entities: [{ name: '白色天鹅', type: 'animal' }], claims: []
  }, baseScope, 'eval_noise_source');
  const memory = await retrieveMemory('纸条上的诗写了什么', baseScope);
  assert.equal(memory.events.some((event) => event.eventKey === 'dream_white_swan'), false);
});

await run('cross-user-isolation', async () => {
  const privateEvent = await storeEvent({
    event_key: 'private_birthday_plan', event_type: 'plan', title: '小雨的生日计划',
    summary: '小雨计划周日去海边。', importance: 0.8,
    entities: [{ name: '海边', type: 'place' }], claims: []
  }, baseScope, 'eval_private_source');
  const otherScope = { ...baseScope, userId: 'user_azhi' };
  const memory = await retrieveMemory('生日去海边的计划', otherScope);
  assert.equal(memory.events.some((event) => event.id === privateEvent.id), false);
});

await run('role-shared-story', async () => {
  const shared = await storeEvent({
    event_key: 'linwan_letter_promise', event_type: 'promise', title: '林晚答应写信',
    summary: '林晚答应下次见面时带来一封亲手写的信。', importance: 0.9,
    memory_space: 'shared_story', canonicality: 'confirmed', source_speaker: 'assistant',
    entities: [{ name: '林晚', type: 'character' }, { name: '亲手写的信', type: 'object' }], claims: []
  }, baseScope, 'eval_role_promise');
  const stored = db.prepare('SELECT memory_space, source_speaker FROM events WHERE id = ?').get(shared.id);
  assert.equal(stored.memory_space, 'shared_story');
  assert.equal(stored.source_speaker, 'assistant');
  const memory = await retrieveMemory('林晚答应带来的那封信', baseScope);
  assert.equal(memory.events.some((event) => event.id === shared.id), true);
});

await run('plot-branch-conflict', async () => {
  const scope = { ...baseScope, userId: 'user_azhi' };
  setMemoryValue('identity.gender', '女', scope, { sourceType: 'eval' });
  setMemoryValue('relationship.intimacy', 36, scope, { sourceType: 'eval' });
  evaluateTriggers(scope, 'eval_plot_female');
  assert.equal(getActivePlots(scope).some((plot) => plot.id === 'plot_rain_female_window'), true);

  setMemoryValue('identity.gender', '男', scope, { sourceType: 'eval' });
  evaluateTriggers(scope, 'eval_plot_male');
  const active = getActivePlots(scope).map((plot) => plot.id);
  assert.equal(active.includes('plot_rain_male_umbrella'), true);
  assert.equal(active.includes('plot_rain_female_window'), false);
  assert.equal(getMemoryValue('identity.gender', scope).value, '男');
});

for (const result of results) {
  console.log(`${result.status === 'passed' ? 'PASS' : 'FAIL'} ${result.id} ${result.durationMs}ms${result.error ? `: ${result.error}` : ''}`);
}
const failed = results.filter((result) => result.status === 'failed');
console.log(`\nMemory evals: ${results.length - failed.length}/${results.length} passed.`);
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
