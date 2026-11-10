import { config } from './config.js';
import { db } from './db.js';
import { queueGraphProjection } from './graph-store.js';
import {
  deactivateMemoryViews, rebuildMemoryAssociationsForEvent, syncMemoryViewsForEvent
} from './memory-views.js';
import { embedText } from './providers/index.js';
import { hash, json, nowIso, parseJson, uid } from './utils.js';

const SCOPE_WHERE = 'user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?';
const CURRENT_WHERE = "status = 'active' AND transaction_to = ''";
const CLAIM_ENTITY_FIELDS = ['subject_entity_id', 'object_entity_id', 'perspective_entity_id'];
const EDGE_ENTITY_FIELDS = ['source_entity_id', 'target_entity_id'];
const DERIVED_ROLES = new Set(['claim_subject', 'claim_object', 'claim_perspective', 'relation_source', 'relation_target']);
const projectionRuns = new Map();

export class EntityRepairError extends Error {
  constructor(message, code = 'ENTITY_REPAIR_INVALID', status = 400) {
    super(message);
    this.name = 'EntityRepairError';
    this.code = code;
    this.status = status;
  }
}

export function initializeEntityRepairSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_repairs (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,
      before_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      projection_status TEXT NOT NULL DEFAULT 'pending',
      projection_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_repairs_scope
      ON entity_repairs(scope_key, created_at DESC);
    CREATE TABLE IF NOT EXISTS entity_repair_redirects (
      from_entity_id TEXT PRIMARY KEY REFERENCES entities(id),
      to_entity_id TEXT NOT NULL REFERENCES entities(id),
      scope_key TEXT NOT NULL,
      repair_id TEXT NOT NULL REFERENCES entity_repairs(id),
      created_at TEXT NOT NULL
    );
  `);
}

export const ensureEntityRepairSchema = initializeEntityRepairSchema;

function requiredText(value, name, maximum = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new EntityRepairError(`${name}不能为空且长度必须小于等于${maximum}`);
  }
  return value.trim();
}

function normalizeScope(input) {
  const scope = Object.fromEntries(['userId', 'agentId', 'storyId', 'branchId'].map((key) => {
    const value = requiredText(input?.[key], key, 100);
    if (value.includes('|')) throw new EntityRepairError(`${key}包含无效分隔符`);
    return [key, value];
  }));
  if (input.tenantId && input.tenantId !== (config.memoryService?.tenantId || 'default')) {
    throw new EntityRepairError('当前租户无权访问该记忆', 'ENTITY_REPAIR_FORBIDDEN', 403);
  }
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").get(scope.userId);
  const agent = db.prepare('SELECT id FROM agents WHERE id = ? AND enabled = 1').get(scope.agentId);
  if (!user || !agent) throw new EntityRepairError('用户或角色不存在', 'ENTITY_REPAIR_SCOPE_NOT_FOUND', 404);
  return scope;
}

function scopeParams(scope) {
  return [scope.userId, scope.agentId, scope.storyId, scope.branchId];
}

function scopeKey(scope) {
  return json(scopeParams(scope));
}

function identifiers(value, name, maximum = 200) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new EntityRepairError(`${name}格式或数量无效`);
  return [...new Set(value.map((id) => requiredText(id, name)))].sort();
}

function scopedRow(table, id, scope, { current = false } = {}) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND ${SCOPE_WHERE}`)
    .get(id, ...scopeParams(scope));
  if (!row) throw new EntityRepairError('记录不存在或不属于当前记忆空间', 'ENTITY_REPAIR_NOT_FOUND', 404);
  if (current && (row.status !== 'active' || row.transaction_to)) {
    throw new EntityRepairError('记录已发生变化，请刷新后重新选择', 'ENTITY_REPAIR_STALE', 409);
  }
  return row;
}

function activeRows(table, scope) {
  return db.prepare(`SELECT * FROM ${table} WHERE ${SCOPE_WHERE} AND ${CURRENT_WHERE}`)
    .all(...scopeParams(scope));
}

function entityResult(row) {
  return { ...row, aliases: parseJson(row.aliases_json, []), attributes: parseJson(row.attributes_json, {}) };
}

export function resolveRepairedEntity(scopeInput, entityId) {
  initializeEntityRepairSchema();
  const scope = normalizeScope(scopeInput);
  const visited = new Set();
  let row = scopedRow('entities', entityId, scope);
  while (row.status === 'merged') {
    if (visited.has(row.id)) throw new EntityRepairError('实体合并映射存在循环', 'ENTITY_REPAIR_MAPPING_INVALID', 409);
    visited.add(row.id);
    const redirect = db.prepare(`SELECT to_entity_id FROM entity_repair_redirects
      WHERE from_entity_id = ? AND scope_key = ?`).get(row.id, scopeKey(scope));
    if (!redirect) throw new EntityRepairError('实体合并映射缺失', 'ENTITY_REPAIR_MAPPING_INVALID', 409);
    row = scopedRow('entities', redirect.to_entity_id, scope);
  }
  if (row.status !== 'active') throw new EntityRepairError('该实体当前不可用', 'ENTITY_REPAIR_STALE', 409);
  return row;
}

function sourceMessage(scope, messageId) {
  if (!messageId) return null;
  return db.prepare(`SELECT m.id, m.role, m.content, m.created_at FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = ? AND m.user_id = ? AND c.user_id = ? AND c.agent_id = ?
      AND c.story_id = ? AND c.branch_id = ?`)
    .get(messageId, scope.userId, ...scopeParams(scope)) || null;
}

export function getEntityRepairDetails(scopeInput, entityId) {
  initializeEntityRepairSchema();
  const scope = normalizeScope(scopeInput);
  const entity = scopedRow('entities', requiredText(entityId, 'entityId'), scope);
  const names = new Map(db.prepare(`SELECT id, canonical_name FROM entities WHERE ${SCOPE_WHERE}`)
    .all(...scopeParams(scope)).map((row) => [row.id, row.canonical_name]));
  const events = activeRows('events', scope).filter((event) => db.prepare(
    'SELECT 1 FROM event_entities WHERE event_id = ? AND entity_id = ?'
  ).get(event.id, entity.id));
  const relations = activeRows('entity_edges', scope)
    .filter((row) => EDGE_ENTITY_FIELDS.some((field) => row[field] === entity.id))
    .map((row) => ({
      ...row, sourceName: names.get(row.source_entity_id), targetName: names.get(row.target_entity_id),
      evidence: sourceMessage(scope, row.source_message_id)
    }));
  const claims = activeRows('claims', scope)
    .filter((row) => CLAIM_ENTITY_FIELDS.some((field) => row[field] === entity.id))
    .map((row) => ({ ...row, subjectName: names.get(row.subject_entity_id), evidence: sourceMessage(scope, row.source_message_id) }));
  validateReferences(scope, relations, EDGE_ENTITY_FIELDS);
  validateReferences(scope, claims, CLAIM_ENTITY_FIELDS);
  const repairs = db.prepare(`SELECT id, operation_type, request_json, result_json, created_at,
      projection_status, projection_error FROM entity_repairs WHERE scope_key = ? ORDER BY created_at DESC`)
    .all(scopeKey(scope)).filter((row) => {
      const result = parseJson(row.result_json, {});
      return result.entityIds?.includes(entity.id);
    }).slice(0, 30).map((row) => ({
      id: row.id, operation: row.operation_type, reason: parseJson(row.request_json, {}).reason,
      createdAt: row.created_at, projectionStatus: row.projection_status, projectionError: row.projection_error
    }));
  return { entity: entityResult(entity), events, relations, claims, repairs };
}

function normalizeRequest(operation, input) {
  const common = {
    operation,
    idempotencyKey: requiredText(input?.idempotencyKey, 'idempotencyKey'),
    reason: requiredText(input?.reason, 'reason', 1000)
  };
  if (operation === 'merge') {
    const sourceEntityIds = identifiers(input.sourceEntityIds, 'sourceEntityIds', 20);
    const survivorId = requiredText(input.survivorId, 'survivorId');
    if (!sourceEntityIds.length || sourceEntityIds.includes(survivorId)) {
      throw new EntityRepairError('请选择要合并的其他实体');
    }
    return { ...common, survivorId, sourceEntityIds };
  }
  const eventIds = identifiers(input.eventIds, 'eventIds');
  const edgeIds = identifiers(input.edgeIds, 'edgeIds');
  const claimIds = identifiers(input.claimIds, 'claimIds');
  if (!eventIds.length && !edgeIds.length && !claimIds.length) {
    throw new EntityRepairError('请至少选择一条事件、关系或声明进行拆分');
  }
  return {
    ...common,
    entityId: requiredText(input.entityId, 'entityId'),
    canonicalName: requiredText(input.canonicalName, 'canonicalName', 120),
    aliases: identifiers(input.aliases, 'aliases', 20),
    eventIds, edgeIds, claimIds
  };
}

function insertRow(table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

function versionRow(table, row, changes, repairId, timestamp) {
  const prefix = { events: 'event', claims: 'claim', entity_edges: 'edge' }[table];
  const metadataField = table === 'entity_edges' ? 'properties_json' : 'metadata_json';
  const next = {
    ...row, ...changes, id: uid(prefix), version: Number(row.version || 1) + 1,
    [`supersedes_${prefix}_id`]: row.id,
    transaction_from: timestamp, transaction_to: '', created_at: timestamp, updated_at: timestamp,
    [metadataField]: json({ ...parseJson(row[metadataField], {}), entity_repair_id: repairId })
  };
  db.prepare(`UPDATE ${table} SET status = 'superseded', transaction_to = ?, updated_at = ? WHERE id = ?`)
    .run(timestamp, timestamp, row.id);
  insertRow(table, next);
  return next;
}

function copyEmbeddings(ownerType, oldId, newId, timestamp) {
  for (const row of db.prepare('SELECT * FROM embeddings WHERE owner_type = ? AND owner_id = ?').all(ownerType, oldId)) {
    insertRow('embeddings', { ...row, id: uid('emb'), owner_id: newId, created_at: timestamp });
  }
}

function linkEntity(eventId, entityId, role, messageId, timestamp) {
  if (!entityId) return;
  db.prepare(`INSERT OR IGNORE INTO event_entities
    (id, event_id, entity_id, role, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uid('event_entity'), eventId, entityId, role, messageId || '', timestamp);
}

function validateReferences(scope, rows, fields) {
  const ids = new Set(rows.flatMap((row) => fields.map((field) => row[field])).filter(Boolean));
  for (const id of ids) scopedRow('entities', id, scope);
  for (const row of rows) {
    if (row.source_message_id && db.prepare('SELECT id FROM messages WHERE id = ?').get(row.source_message_id)
      && !sourceMessage(scope, row.source_message_id)) {
      throw new EntityRepairError('原始消息不属于当前记忆空间', 'ENTITY_REPAIR_FORBIDDEN', 403);
    }
  }
}

function rejectForeignReferences(scope, entityIds) {
  for (const entityId of entityIds) {
    for (const [table, fields] of [['claims', CLAIM_ENTITY_FIELDS], ['entity_edges', EDGE_ENTITY_FIELDS]]) {
      const foreign = db.prepare(`SELECT id FROM ${table} WHERE (${fields.map((field) => `${field} = ?`).join(' OR ')})
        AND NOT (${SCOPE_WHERE}) LIMIT 1`).get(...fields.map(() => entityId), ...scopeParams(scope));
      if (foreign) throw new EntityRepairError('实体存在跨空间引用，请先修复数据归属', 'ENTITY_REPAIR_FORBIDDEN', 403);
    }
    const foreignLink = db.prepare(`SELECT link.id FROM event_entities link JOIN events ev ON ev.id = link.event_id
      WHERE link.entity_id = ? AND NOT (ev.user_id = ? AND ev.agent_id = ? AND ev.story_id = ? AND ev.branch_id = ?)
      LIMIT 1`).get(entityId, ...scopeParams(scope));
    if (foreignLink) throw new EntityRepairError('实体存在跨空间引用，请先修复数据归属', 'ENTITY_REPAIR_FORBIDDEN', 403);
  }
}

function repairRecords(scope, request, fromIds, targetId, repairId, timestamp) {
  const from = new Set(fromIds);
  const events = activeRows('events', scope);
  const edges = activeRows('entity_edges', scope);
  const claims = activeRows('claims', scope);
  const eventById = new Map(events.map((row) => [row.id, row]));
  const selectedEvents = new Set(request.eventIds || []);
  const selectedEdges = new Set(request.edgeIds || []);
  const selectedClaims = new Set(request.claimIds || []);
  const touches = (row, fields) => fields.some((field) => from.has(row[field]));
  const shouldMap = (row, fields, selected) => touches(row, fields)
    && (request.operation === 'merge' || selected.has(row.id) || selectedEvents.has(row.event_id));
  for (const eventId of selectedEvents) {
    const event = scopedRow('events', eventId, scope, { current: true });
    const linked = db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ?').all(event.id);
    if (!linked.some((link) => from.has(link.entity_id))) throw new EntityRepairError('所选事件未关联待拆分实体');
  }
  for (const [table, selected, fields] of [
    ['entity_edges', selectedEdges, EDGE_ENTITY_FIELDS], ['claims', selectedClaims, CLAIM_ENTITY_FIELDS]
  ]) {
    for (const id of selected) {
      if (!touches(scopedRow(table, id, scope, { current: true }), fields)) {
        throw new EntityRepairError('所选证据未关联待拆分实体');
      }
    }
  }
  const mappedEdges = edges.filter((row) => shouldMap(row, EDGE_ENTITY_FIELDS, selectedEdges));
  const mappedClaims = claims.filter((row) => shouldMap(row, CLAIM_ENTITY_FIELDS, selectedClaims));
  const affectedEventIds = new Set(selectedEvents);
  for (const row of [...mappedEdges, ...mappedClaims]) {
    if (!row.event_id) continue;
    if (!eventById.has(row.event_id)) throw new EntityRepairError('证据关联了无效或其他空间的事件，请先修复证据链');
    affectedEventIds.add(row.event_id);
  }
  if (request.operation === 'merge') {
    for (const event of events) {
      const links = db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ?').all(event.id);
      if (links.some((link) => from.has(link.entity_id))) affectedEventIds.add(event.id);
    }
  }
  const affectedEdges = edges.filter((row) => affectedEventIds.has(row.event_id) || mappedEdges.includes(row));
  const affectedClaims = claims.filter((row) => affectedEventIds.has(row.event_id) || mappedClaims.includes(row));
  validateReferences(scope, [...affectedEventIds].map((id) => eventById.get(id)), []);
  validateReferences(scope, affectedEdges, EDGE_ENTITY_FIELDS);
  validateReferences(scope, affectedClaims, CLAIM_ENTITY_FIELDS);
  const eventMap = new Map();
  const claimMap = new Map();
  const edgeMap = new Map();
  const mapId = (id) => from.has(id) ? targetId : id;
  for (const eventId of affectedEventIds) {
    const old = eventById.get(eventId);
    const next = versionRow('events', old, {}, repairId, timestamp);
    eventMap.set(old.id, next.id);
    copyEmbeddings('event', old.id, next.id, timestamp);
    const moveAllLinks = request.operation === 'merge' || selectedEvents.has(old.id);
    for (const link of db.prepare('SELECT * FROM event_entities WHERE event_id = ?').all(old.id)) {
      scopedRow('entities', link.entity_id, scope);
      if (!DERIVED_ROLES.has(link.role)) {
        linkEntity(next.id, moveAllLinks ? mapId(link.entity_id) : link.entity_id,
          link.role, link.source_message_id, timestamp);
      }
    }
  }
  for (const [table, rows, fields, selected, resultMap] of [
    ['claims', affectedClaims, CLAIM_ENTITY_FIELDS, selectedClaims, claimMap],
    ['entity_edges', affectedEdges, EDGE_ENTITY_FIELDS, selectedEdges, edgeMap]
  ]) {
    for (const old of rows) {
      const changes = { event_id: eventMap.get(old.event_id) || old.event_id };
      if (shouldMap(old, fields, selected)) {
        for (const field of fields) changes[field] = mapId(old[field]);
      }
      const next = versionRow(table, old, changes, repairId, timestamp);
      resultMap.set(old.id, next.id);
      if (table === 'claims') {
        for (const evidence of db.prepare('SELECT * FROM claim_evidence WHERE claim_id = ?').all(old.id)) {
          if (!sourceMessage(scope, evidence.message_id)) throw new EntityRepairError('声明证据不属于当前记忆空间');
          insertRow('claim_evidence', { ...evidence, id: uid('claim_evidence'), claim_id: next.id });
        }
        if (!shouldMap(old, fields, selected)) copyEmbeddings('claim', old.id, next.id, timestamp);
      }
      if (next.event_id) {
        const roles = table === 'claims'
          ? ['claim_subject', 'claim_object', 'claim_perspective'] : ['relation_source', 'relation_target'];
        fields.forEach((field, index) => linkEntity(next.event_id, next[field], roles[index], next.source_message_id, timestamp));
      }
    }
  }
  deactivateMemoryViews([...eventMap.keys()]);
  return {
    eventVersions: Object.fromEntries(eventMap), claimVersions: Object.fromEntries(claimMap),
    edgeVersions: Object.fromEntries(edgeMap),
    before: { events: [...affectedEventIds].map((id) => eventById.get(id)), claims: affectedClaims, edges: affectedEdges }
  };
}

function performRepair(scope, request) {
  const requestHash = hash(json(request));
  const prior = db.prepare('SELECT * FROM entity_repairs WHERE scope_key = ? AND idempotency_key = ?')
    .get(scopeKey(scope), request.idempotencyKey);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new EntityRepairError('该请求标识已用于不同的纠错内容', 'ENTITY_REPAIR_IDEMPOTENCY_CONFLICT', 409);
    return { ...parseJson(prior.result_json), duplicate: true };
  }
  const timestamp = nowIso();
  const repairId = uid('entity_repair');
  let target;
  let sources;
  if (request.operation === 'merge') {
    target = scopedRow('entities', request.survivorId, scope, { current: true });
    sources = request.sourceEntityIds.map((id) => scopedRow('entities', id, scope, { current: true }));
    if (sources.some((row) => row.entity_type !== target.entity_type)) throw new EntityRepairError('只允许合并同类型实体');
  } else {
    sources = [scopedRow('entities', request.entityId, scope, { current: true })];
    const existing = db.prepare(`SELECT id FROM entities WHERE ${SCOPE_WHERE} AND entity_type = ? AND canonical_name = ?`)
      .get(...scopeParams(scope), sources[0].entity_type, request.canonicalName);
    if (existing) throw new EntityRepairError('请使用能够区分新实体的名称', 'ENTITY_REPAIR_NAME_CONFLICT', 409);
    target = {
      ...sources[0], id: uid('entity'), canonical_name: request.canonicalName, aliases_json: json(request.aliases),
      attributes_json: json({ repair_source_entity_id: sources[0].id, entity_repair_id: repairId }),
      created_at: timestamp, updated_at: timestamp
    };
    insertRow('entities', target);
  }
  rejectForeignReferences(scope, [target.id, ...sources.map((row) => row.id)]);
  const records = repairRecords(scope, request, sources.map((row) => row.id), target.id, repairId, timestamp);
  if (request.operation === 'merge') {
    const aliases = [...new Set([
      ...parseJson(target.aliases_json, []),
      ...sources.flatMap((row) => [row.canonical_name, ...parseJson(row.aliases_json, [])])
    ])].filter((name) => name !== target.canonical_name);
    db.prepare('UPDATE entities SET aliases_json = ?, updated_at = ? WHERE id = ?').run(json(aliases), timestamp, target.id);
    for (const source of sources) {
      db.prepare("UPDATE entities SET status = 'merged', updated_at = ? WHERE id = ?").run(timestamp, source.id);
    }
  }
  // Changing survivor aliases also changes the keyword/episode views of its existing events.
  const rebuildEventIds = new Set(Object.values(records.eventVersions));
  if (request.operation === 'merge') {
    const targetEvents = db.prepare(`SELECT DISTINCT ev.id FROM events ev
      JOIN event_entities link ON link.event_id = ev.id
      WHERE ev.user_id = ? AND ev.agent_id = ? AND ev.story_id = ? AND ev.branch_id = ?
        AND ev.status = 'active' AND ev.transaction_to = '' AND link.entity_id = ?`)
      .all(...scopeParams(scope), target.id);
    for (const event of targetEvents) {
      validateReferences(scope, [scopedRow('events', event.id, scope)], []);
      for (const link of db.prepare('SELECT entity_id FROM event_entities WHERE event_id = ?').all(event.id)) {
        scopedRow('entities', link.entity_id, scope);
      }
      rebuildEventIds.add(event.id);
    }
    deactivateMemoryViews([...rebuildEventIds]);
  }
  const result = {
    id: repairId, operation: request.operation, targetEntityId: target.id,
    sourceEntityIds: sources.map((row) => row.id), entityIds: [target.id, ...sources.map((row) => row.id)],
    eventVersions: records.eventVersions, claimVersions: records.claimVersions, edgeVersions: records.edgeVersions,
    rebuildEventIds: [...rebuildEventIds],
    createdAt: timestamp, duplicate: false
  };
  insertRow('entity_repairs', {
    id: repairId, scope_key: scopeKey(scope), user_id: scope.userId, agent_id: scope.agentId,
    story_id: scope.storyId, branch_id: scope.branchId, operation_type: request.operation,
    idempotency_key: request.idempotencyKey, request_hash: requestHash, request_json: json(request),
    before_json: json({ entities: [target, ...sources], ...records.before }), result_json: json(result),
    projection_status: 'pending', projection_error: '', created_at: timestamp, updated_at: timestamp
  });
  if (request.operation === 'merge') {
    for (const source of sources) insertRow('entity_repair_redirects', {
      from_entity_id: source.id, to_entity_id: target.id, scope_key: scopeKey(scope), repair_id: repairId, created_at: timestamp
    });
  }
  queueGraphProjection(scope);
  return result;
}

async function refreshProjection(scope, repairId) {
  const row = db.prepare('SELECT * FROM entity_repairs WHERE id = ? AND scope_key = ?').get(repairId, scopeKey(scope));
  if (!row) throw new EntityRepairError('纠错记录不存在', 'ENTITY_REPAIR_NOT_FOUND', 404);
  if (row.projection_status === 'completed') return { status: 'completed', embeddingMode: 'reuse_event' };
  const result = parseJson(row.result_json, {});
  try {
    for (const claimId of Object.values(result.claimVersions || {})) {
      const claim = scopedRow('claims', claimId, scope);
      if (claim.status !== 'active' || claim.transaction_to) continue;
      const subject = scopedRow('entities', claim.subject_entity_id, scope);
      const objectName = claim.object_entity_id ? scopedRow('entities', claim.object_entity_id, scope).canonical_name : '';
      const text = [subject.canonical_name, claim.predicate, objectName || claim.object_text,
        `memory_kind:${claim.memory_kind}`, `state_phase:${claim.state_phase}`,
        claim.story_time ? `story_time:${claim.story_time}` : ''].join('\n');
      const embedding = await embedText(text);
      const current = scopedRow('claims', claimId, scope);
      if (current.status !== 'active' || current.transaction_to) continue;
      db.prepare(`INSERT INTO embeddings
        (id, user_id, owner_type, owner_id, model, dimensions, vector_json, source_text, created_at)
        VALUES (?, ?, 'claim', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET dimensions = excluded.dimensions,
          vector_json = excluded.vector_json, source_text = excluded.source_text, created_at = excluded.created_at`)
        .run(uid('emb'), scope.userId, claimId, embedding.model, embedding.vector.length, json(embedding.vector), text, nowIso());
    }
    const activeEvents = (result.rebuildEventIds || Object.values(result.eventVersions || {})).filter((eventId) => {
      const event = scopedRow('events', eventId, scope);
      return event.status === 'active' && !event.transaction_to;
    });
    for (const eventId of activeEvents) await syncMemoryViewsForEvent(eventId, { embeddingMode: 'reuse_event' });
    for (const eventId of activeEvents) rebuildMemoryAssociationsForEvent(eventId, scope);
    queueGraphProjection(scope);
    db.prepare("UPDATE entity_repairs SET projection_status = 'completed', projection_error = '', updated_at = ? WHERE id = ?")
      .run(nowIso(), repairId);
    return { status: 'completed', embeddingMode: 'reuse_event', eventCount: activeEvents.length };
  } catch (error) {
    db.prepare("UPDATE entity_repairs SET projection_status = 'pending', projection_error = ?, updated_at = ? WHERE id = ?")
      .run(String(error.message).slice(0, 1000), nowIso(), repairId);
    return { status: 'pending', error: String(error.message), retryable: true };
  }
}

function refreshOnce(scope, repairId) {
  if (projectionRuns.has(repairId)) return projectionRuns.get(repairId);
  const running = refreshProjection(scope, repairId).finally(() => projectionRuns.delete(repairId));
  projectionRuns.set(repairId, running);
  return running;
}

async function repair(scopeInput, input, operation, { validateBeforeCommit } = {}) {
  initializeEntityRepairSchema();
  const scope = normalizeScope(scopeInput);
  const request = normalizeRequest(operation, input);
  db.exec('BEGIN IMMEDIATE');
  let result;
  try {
    validateBeforeCommit?.();
    result = performRepair(scope, request);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ...result, projection: await refreshOnce(scope, result.id) };
}

export async function mergeEntities(scope, input, options) {
  return repair(scope, input, 'merge', options);
}

export async function splitEntity(scope, input, options) {
  return repair(scope, input, 'split', options);
}

export async function replayEntityRepairProjections(scopeInput) {
  initializeEntityRepairSchema();
  const scope = normalizeScope(scopeInput);
  const rows = db.prepare("SELECT id FROM entity_repairs WHERE scope_key = ? AND projection_status = 'pending' ORDER BY created_at")
    .all(scopeKey(scope));
  const results = [];
  for (const row of rows) results.push({ id: row.id, ...await refreshOnce(scope, row.id) });
  return results;
}
