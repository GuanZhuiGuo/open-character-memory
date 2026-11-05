import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-entity-repair-'));
process.env.DATABASE_PATH = path.join(directory, 'memory.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'neo4j';

const { db, initializeDatabase } = await import('../lib/db.js');
const { storeEvent, listGraph, ensureEntity } = await import('../lib/memory.js');
const {
  ensureEntityRepairSchema, getEntityRepairDetails, mergeEntities, splitEntity,
  resolveRepairedEntity, replayEntityRepairProjections
} = await import('../lib/entity-repair.js');

initializeDatabase();
ensureEntityRepairSchema();
let nextId = 0;
const unique = (prefix) => `${prefix}_${++nextId}`;
const scopeFor = (storyId) => ({ userId: 'user_xiaoyu', agentId: 'agent_linwan', storyId, branchId: 'main' });

test.after(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function entity(scope, name, type = 'person') {
  return db.prepare(`SELECT * FROM entities WHERE user_id = ? AND agent_id = ? AND story_id = ?
    AND branch_id = ? AND canonical_name = ? AND entity_type = ?`)
    .get(scope.userId, scope.agentId, scope.storyId, scope.branchId, name, type);
}

async function eventWithPerson(scope, name, place, { claim = true } = {}) {
  const messageId = unique('message');
  const conversationId = unique('conversation');
  const time = '2026-01-01T10:00:00.000Z';
  db.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '实体纠错测试', ?, ?)`)
    .run(conversationId, scope.userId, scope.agentId, scope.storyId, scope.branchId, time, time);
  db.prepare(`INSERT INTO messages(id, conversation_id, user_id, role, content, created_at)
    VALUES (?, ?, ?, 'user', ?, ?)`)
    .run(messageId, conversationId, scope.userId, `${name}去了${place}，喜欢摄影。`, time);
  const result = await storeEvent({
    event_key: unique('visit'), event_type: 'episode', title: `${name}去${place}`,
    summary: `${name}去了${place}，喜欢摄影。`, valid_from: time,
    entities: [{ name, type: 'person' }, { name: place, type: 'place' }],
    relations: [{ source: { name, type: 'person' }, predicate: 'located_at', target: { name: place, type: 'place' } }],
    claims: claim ? [{ subject: { name, type: 'person' }, predicate: '爱好', object: '摄影', valid_from: time }] : []
  }, scope, messageId, { projectGraph: false });
  for (const table of ['events', 'claims', 'entity_edges']) {
    db.prepare(`UPDATE ${table} SET transaction_from = ?, valid_from = ? WHERE story_id = ?`)
      .run(time, time, scope.storyId);
  }
  return {
    id: result.id, person: entity(scope, name), place: entity(scope, place, 'place'), messageId,
    edge: db.prepare("SELECT * FROM entity_edges WHERE event_id = ? AND status = 'active'").get(result.id),
    claim: db.prepare("SELECT * FROM claims WHERE event_id = ? AND status = 'active'").get(result.id)
  };
}

function mergeInput(survivor, source, key = unique('merge')) {
  return { survivorId: survivor.id, sourceEntityIds: [source.id], reason: '同一人的不同称呼', idempotencyKey: key };
}

function tableCount(table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

test('merge versions event, relation, claim and evidence while preserving known-at history', async () => {
  const scope = scopeFor('repair_merge_history');
  const first = await eventWithPerson(scope, '王老师', '图书馆');
  const second = await eventWithPerson(scope, '小王', '公园');
  db.prepare(`INSERT INTO claim_evidence
    (id, claim_id, message_id, evidence_role, evidence_kind, created_at) VALUES (?, ?, ?, 'user', 'explicit', ?)`)
    .run(unique('evidence'), second.claim.id, second.messageId, '2026-01-01T10:00:00.000Z');
  const originalEventLinkIds = db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ? ORDER BY entity_id')
    .all(second.id);
  const repaired = await mergeEntities(scope, mergeInput(first.person, second.person));
  assert.equal(repaired.projection.status, 'completed');
  const newEventId = repaired.eventVersions[second.id];
  const oldEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(second.id);
  const newEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(newEventId);
  assert.equal(oldEvent.status, 'superseded');
  assert.ok(oldEvent.transaction_to);
  assert.equal(oldEvent.valid_to, '');
  assert.equal(newEvent.valid_from, oldEvent.valid_from);
  assert.equal(newEvent.supersedes_event_id, second.id);
  assert.equal(newEvent.version, oldEvent.version + 1);
  assert.deepEqual(db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ? ORDER BY entity_id')
    .all(second.id), originalEventLinkIds);
  const newEdge = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(repaired.edgeVersions[second.edge.id]);
  assert.equal(newEdge.source_entity_id, first.person.id);
  assert.equal(newEdge.event_id, newEventId);
  assert.equal(db.prepare('SELECT source_entity_id FROM entity_edges WHERE id = ?').get(second.edge.id).source_entity_id, second.person.id);
  const newClaim = db.prepare('SELECT * FROM claims WHERE id = ?').get(repaired.claimVersions[second.claim.id]);
  assert.equal(newClaim.subject_entity_id, first.person.id);
  assert.equal(db.prepare('SELECT message_id FROM claim_evidence WHERE claim_id = ?').get(newClaim.id).message_id, second.messageId);
  assert.equal(db.prepare('SELECT message_id FROM claim_evidence WHERE claim_id = ?').get(second.claim.id).message_id, second.messageId);
  const past = listGraph(scope, { knownAt: '2026-06-01T00:00:00.000Z' });
  assert.ok(past.edges.some((edge) => edge.id === second.edge.id && edge.source_name === '小王'));
  assert.ok(past.events.some((event) => event.id === second.id));
  assert.ok(!past.edges.some((edge) => edge.id === newEdge.id));
  assert.equal(resolveRepairedEntity(scope, second.person.id).id, first.person.id);
  assert.equal(ensureEntity(scope, { name: '小王', type: 'person' }).id, first.person.id);
  assert.ok(JSON.parse(entity(scope, '王老师').aliases_json).includes('小王'));
  assert.match(db.prepare("SELECT source_text FROM memory_views WHERE canonical_id = ? AND view_type = 'entity_keyword'")
    .get(first.id).source_text, /别名：小王/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_views WHERE canonical_id = ? AND status = 'active'").get(newEventId).count, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_views WHERE canonical_id = ? AND status = 'active'").get(second.id).count, 0);
  assert.equal(db.prepare('SELECT status FROM graph_projection_outbox WHERE scope_key = ?')
    .get([scope.userId, scope.agentId, scope.storyId, scope.branchId].join('|')).status, 'pending');
  const details = getEntityRepairDetails(scope, first.person.id);
  assert.ok(details.events.some((event) => event.id === newEventId));
  assert.ok(details.relations.some((edge) => edge.evidence?.id === second.messageId));
  assert.equal(details.repairs[0].reason, '同一人的不同称呼');
});

test('split selected event moves its evidence and keeps unrelated events on the original entity', async () => {
  const scope = scopeFor('repair_split_event');
  const university = await eventWithPerson(scope, '张伟', '大学');
  const office = await eventWithPerson(scope, '张伟', '办公室');
  const result = await splitEntity(scope, {
    entityId: university.person.id, canonicalName: '张伟（大学同学）', aliases: ['大学的张伟'],
    eventIds: [university.id], reason: '大学同学与同事同名', idempotencyKey: unique('split')
  });
  assert.equal(result.projection.status, 'completed');
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(office.id).status, 'active');
  assert.equal(db.prepare('SELECT source_entity_id FROM entity_edges WHERE id = ?').get(office.edge.id).source_entity_id, university.person.id);
  assert.equal(db.prepare('SELECT subject_entity_id FROM claims WHERE id = ?')
    .get(result.claimVersions[university.claim.id]).subject_entity_id, result.targetEntityId);
  assert.equal(db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ? AND role = ?')
    .get(result.eventVersions[university.id], 'claim_subject').entity_id, result.targetEntityId);
  assert.equal(entity(scope, '张伟').status, 'active');
});

test('split a single relation preserves other relation and claim assignments in the same event', async () => {
  const scope = scopeFor('repair_split_edge');
  const initial = await eventWithPerson(scope, '李明', '图书馆');
  const targetId = unique('entity');
  db.prepare(`INSERT INTO entities
    (id, user_id, agent_id, story_id, branch_id, entity_type, canonical_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'place', '画室', ?, ?)`)
    .run(targetId, scope.userId, scope.agentId, scope.storyId, scope.branchId, now(), now());
  const otherEdge = { ...initial.edge, id: unique('edge'), target_entity_id: targetId, predicate: 'related_to' };
  const keys = Object.keys(otherEdge);
  db.prepare(`INSERT INTO entity_edges (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(otherEdge));
  const result = await splitEntity(scope, {
    entityId: initial.person.id, canonicalName: '李明（朋友）', edgeIds: [initial.edge.id],
    reason: '图书馆这段关系属于朋友', idempotencyKey: unique('split')
  });
  const moved = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(result.edgeVersions[initial.edge.id]);
  const kept = db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(result.edgeVersions[otherEdge.id]);
  assert.equal(moved.source_entity_id, result.targetEntityId);
  assert.equal(kept.source_entity_id, initial.person.id);
  assert.equal(db.prepare('SELECT subject_entity_id FROM claims WHERE id = ?')
    .get(result.claimVersions[initial.claim.id]).subject_entity_id, initial.person.id);
  const subjects = db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ? AND role = ?')
    .all(result.eventVersions[initial.id], 'relation_source').map((row) => row.entity_id);
  assert.deepEqual(new Set(subjects), new Set([initial.person.id, result.targetEntityId]));
});

const now = () => new Date().toISOString();

test('same idempotency key reuses receipt and rejects changed content', async () => {
  const scope = scopeFor('repair_idempotent');
  const a = await eventWithPerson(scope, '刘老师', '教室');
  const b = await eventWithPerson(scope, '小刘', '操场');
  const input = mergeInput(a.person, b.person);
  const first = await mergeEntities(scope, input);
  const counts = ['events', 'claims', 'entity_edges', 'entity_repairs'].map(tableCount);
  const repeated = await mergeEntities(scope, input);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(['events', 'claims', 'entity_edges', 'entity_repairs'].map(tableCount), counts);
  await assert.rejects(mergeEntities(scope, { ...input, reason: '不同请求' }), { code: 'ENTITY_REPAIR_IDEMPOTENCY_CONFLICT' });
});

test('scope restrictions reject cross-user, agent, story, branch, tenant and foreign evidence', async () => {
  const scope = scopeFor('repair_scope');
  const a = await eventWithPerson(scope, '本地实体', '本地地点');
  const foreign = await eventWithPerson({ ...scope, branchId: 'foreign' }, '外部分支实体', '外部地点');
  await assert.rejects(mergeEntities(scope, mergeInput(a.person, foreign.person)), { code: 'ENTITY_REPAIR_NOT_FOUND' });
  for (const change of [{ storyId: 'other_story' }, { branchId: 'other_branch' }, { agentId: 'agent_unknown' }, { userId: 'user_unknown' }]) {
    assert.throws(() => getEntityRepairDetails({ ...scope, ...change }, a.person.id), (error) => error.status === 404);
  }
  assert.throws(() => getEntityRepairDetails({ ...scope, tenantId: 'other_tenant' }, a.person.id), { status: 403 });
  await assert.rejects(splitEntity(scope, {
    entityId: a.person.id, canonicalName: '新实体', edgeIds: [foreign.edge.id],
    reason: '越界证据', idempotencyKey: unique('scope')
  }), { status: 404 });
  assert.equal(entity(scope, '新实体'), undefined);
  assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(foreign.person.id).status, 'active');
});

test('existing users and agents cannot be mixed across any scope dimension', async () => {
  const scope = scopeFor('repair_existing_scopes');
  const local = await eventWithPerson(scope, '同名人物', '本地空间');
  db.prepare(`INSERT INTO users(id, name, display_name, created_at, updated_at)
    VALUES ('repair_other_user', '其他用户', '其他用户', ?, ?)`).run(now(), now());
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(scope.agentId);
  agent.id = 'repair_other_agent';
  const keys = Object.keys(agent);
  db.prepare(`INSERT INTO agents (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(agent));
  for (const difference of [
    { userId: 'repair_other_user' }, { agentId: 'repair_other_agent' },
    { storyId: 'repair_other_story' }, { branchId: 'repair_other_branch' }
  ]) {
    const otherScope = { ...scope, ...difference };
    const other = await eventWithPerson(otherScope, '同名人物', unique('外部空间'));
    assert.throws(() => getEntityRepairDetails(otherScope, local.person.id), { code: 'ENTITY_REPAIR_NOT_FOUND' });
    await assert.rejects(mergeEntities(scope, mergeInput(local.person, other.person)), { code: 'ENTITY_REPAIR_NOT_FOUND' });
    assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(other.person.id).status, 'active');
  }
});

test('corrupt cross-scope entity and source-message links fail closed and roll back', async () => {
  const scope = scopeFor('repair_corrupt_links');
  const local = await eventWithPerson(scope, '本地甲', '本地房间');
  const survivor = await eventWithPerson(scope, '本地乙', '本地楼道');
  const foreign = await eventWithPerson({ ...scope, branchId: 'foreign' }, '其他人', '私密房间');
  db.prepare('UPDATE entity_edges SET target_entity_id = ? WHERE id = ?').run(foreign.place.id, local.edge.id);
  await assert.rejects(mergeEntities(scope, mergeInput(survivor.person, local.person)), { code: 'ENTITY_REPAIR_NOT_FOUND' });
  assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(local.person.id).status, 'active');
  db.prepare('UPDATE entity_edges SET target_entity_id = ? WHERE id = ?').run(local.place.id, local.edge.id);
  db.prepare('UPDATE events SET source_message_id = ? WHERE id = ?').run(foreign.messageId, local.id);
  await assert.rejects(mergeEntities(scope, mergeInput(survivor.person, local.person)), { code: 'ENTITY_REPAIR_FORBIDDEN' });
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(local.id).status, 'active');
  db.prepare('UPDATE events SET source_message_id = ? WHERE id = ?').run(local.messageId, local.id);
  db.prepare(`INSERT INTO event_entities(id, event_id, entity_id, role, created_at)
    VALUES (?, ?, ?, 'mentioned', ?)`).run(unique('foreign_link'), foreign.id, local.person.id, now());
  await assert.rejects(mergeEntities(scope, mergeInput(survivor.person, local.person)), { code: 'ENTITY_REPAIR_FORBIDDEN' });
  assert.equal(db.prepare('SELECT status FROM entities WHERE id = ?').get(local.person.id).status, 'active');
});

test('empty, unrelated and stale selections leave no new entities or audit records', async () => {
  const scope = scopeFor('repair_validation');
  const a = await eventWithPerson(scope, '甲', '甲地');
  const b = await eventWithPerson(scope, '乙', '乙地');
  const before = tableCount('entity_repairs');
  await assert.rejects(splitEntity(scope, {
    entityId: a.person.id, canonicalName: '甲二', reason: '拆分', idempotencyKey: unique('invalid')
  }), { status: 400 });
  await assert.rejects(splitEntity(scope, {
    entityId: a.person.id, canonicalName: '甲二', eventIds: [b.id], reason: '拆分', idempotencyKey: unique('invalid')
  }), { status: 400 });
  await assert.rejects(mergeEntities(scope, mergeInput(a.person, a.person)), { status: 400 });
  await assert.rejects(mergeEntities(scope, mergeInput(a.person, a.place)), { status: 400 });
  assert.equal(tableCount('entity_repairs'), before);
  assert.equal(entity(scope, '甲二'), undefined);
  await mergeEntities(scope, mergeInput(a.person, b.person));
  await assert.rejects(splitEntity(scope, {
    entityId: b.person.id, canonicalName: '乙二', eventIds: [b.id], reason: '旧页面', idempotencyKey: unique('invalid')
  }), { code: 'ENTITY_REPAIR_STALE' });
});

test('failure late in the transaction rolls back versions, aliases, redirects, views and outbox', async () => {
  const scope = scopeFor('repair_rollback');
  const a = await eventWithPerson(scope, '陈老师', '礼堂');
  const b = await eventWithPerson(scope, '小陈', '走廊');
  const snapshot = () => ['entities', 'events', 'claims', 'entity_edges', 'event_entities', 'memory_views', 'embeddings',
    'entity_repairs', 'entity_repair_redirects', 'graph_projection_outbox']
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  db.exec(`CREATE TEMP TRIGGER reject_entity_repair BEFORE INSERT ON entity_repairs
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  try {
    await assert.rejects(mergeEntities(scope, mergeInput(a.person, b.person)), /injected audit failure/);
  } finally {
    db.exec('DROP TRIGGER reject_entity_repair');
  }
  assert.deepEqual(snapshot(), before);
});

test('projection failures remain durable and retry without duplicating canonical mutations', async () => {
  const scope = scopeFor('repair_projection_retry');
  const a = await eventWithPerson(scope, '何老师', '食堂');
  const b = await eventWithPerson(scope, '小何', '宿舍');
  const input = mergeInput(a.person, b.person);
  db.exec(`CREATE TEMP TRIGGER reject_repair_view BEFORE INSERT ON memory_views
    BEGIN SELECT RAISE(ABORT, 'injected view failure'); END;`);
  let receipt;
  try {
    receipt = await mergeEntities(scope, input);
  } finally {
    db.exec('DROP TRIGGER reject_repair_view');
  }
  assert.equal(receipt.projection.status, 'pending');
  const eventCount = tableCount('events');
  const pending = db.prepare('SELECT projection_status, projection_error FROM entity_repairs WHERE id = ?').get(receipt.id);
  assert.equal(pending.projection_status, 'pending');
  assert.match(pending.projection_error, /injected view failure/);
  const retried = await replayEntityRepairProjections(scope);
  assert.equal(retried[0].status, 'completed');
  assert.equal(tableCount('events'), eventCount);
  assert.equal((await mergeEntities(scope, input)).duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memory_views WHERE canonical_id = ? AND status = 'active'")
    .get(receipt.eventVersions[b.id]).count, 6);
});

test('split handles standalone claims and preserves object and perspective entity assignments', async () => {
  const scope = scopeFor('repair_standalone');
  const a = await eventWithPerson(scope, '赵明', '展馆');
  db.prepare('UPDATE claims SET event_id = NULL, object_entity_id = ?, perspective_entity_id = ? WHERE id = ?')
    .run(a.person.id, a.person.id, a.claim.id);
  const result = await splitEntity(scope, {
    entityId: a.person.id, canonicalName: '赵明（朋友）', claimIds: [a.claim.id],
    reason: '这条声明描述朋友', idempotencyKey: unique('split')
  });
  const next = db.prepare('SELECT * FROM claims WHERE id = ?').get(result.claimVersions[a.claim.id]);
  assert.equal(next.subject_entity_id, result.targetEntityId);
  assert.equal(next.object_entity_id, result.targetEntityId);
  assert.equal(next.perspective_entity_id, result.targetEntityId);
  assert.equal(next.event_id, null);
  assert.deepEqual(result.eventVersions, {});
  assert.equal(db.prepare('SELECT object_entity_id FROM claims WHERE id = ?').get(a.claim.id).object_entity_id, a.person.id);
});

test('concurrent retries share one canonical repair and redirect chains resolve to latest survivor', async () => {
  const scope = scopeFor('repair_concurrent');
  const a = await eventWithPerson(scope, '周老师', '东楼');
  const b = await eventWithPerson(scope, '小周', '西楼');
  const c = await eventWithPerson(scope, '老周', '南楼');
  const input = mergeInput(a.person, b.person);
  const results = await Promise.all([mergeEntities(scope, input), mergeEntities(scope, input)]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results.filter((row) => row.duplicate).length, 1);
  await mergeEntities(scope, mergeInput(c.person, a.person));
  assert.equal(resolveRepairedEntity(scope, b.person.id).id, c.person.id);
});
