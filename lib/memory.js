import { db } from './db.js';
import { embedText, generateText } from './ark.js';
import {
  clamp, cosineSimilarity, extractJson, json, localEmbedding, nowIso, parseJson, safeText, uid
} from './utils.js';

const instructionBlocklist = [
  /忽略.{0,8}(系统|上面|之前).{0,8}指令/i,
  /system\s*prompt/i,
  /developer\s*(message|instruction)/i,
  /API\s*key/i,
  /输出.{0,8}(密钥|隐藏提示词|系统提示词)/i
];

export const EXTRACTION_CONTEXT_MAX_TURNS = 10;
export const EXTRACTION_CONTEXT_MAX_MESSAGES = 20;
export const RELATIONSHIP_STAGE_THRESHOLDS = [
  { minimum: 80, stage: '深度信任' },
  { minimum: 60, stage: '亲近' },
  { minimum: 30, stage: '熟悉' },
  { minimum: 0, stage: '初识' }
];

function schemaRows(scenarioType = 'all') {
  return db.prepare(`SELECT * FROM memory_schemas
    WHERE enabled = 1 AND (scenario_type = 'all' OR scenario_type = ?)
    ORDER BY sort_order, category, label`).all(scenarioType);
}

function scopeParts(schema, scope) {
  const parts = {
    userId: scope.userId,
    agentId: '',
    storyId: '',
    branchId: ''
  };
  if (schema.scope.includes('agent')) parts.agentId = scope.agentId || '';
  if (schema.scope.includes('story')) parts.storyId = scope.storyId || 'main_story';
  if (schema.scope.includes('branch')) parts.branchId = scope.branchId || 'main';
  return parts;
}

function validateInstruction(value) {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    if (instructionBlocklist.some((pattern) => pattern.test(String(item)))) {
      throw new Error('该要求包含越过系统边界或获取隐藏信息的内容，不能写入常驻记忆');
    }
  }
}

function normalizeValue(schema, value) {
  const constraints = parseJson(schema.constraints_json, {});
  if (schema.sensitivity === 'instruction') validateInstruction(value);
  switch (schema.value_type) {
    case 'string':
      return safeText(value, constraints.maxLength || 200);
    case 'number': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${schema.label}必须是数字`);
      return clamp(parsed, constraints.min ?? -Infinity, constraints.max ?? Infinity);
    }
    case 'boolean':
      return Boolean(value);
    case 'enum':
      if (!constraints.options?.includes(value)) throw new Error(`${schema.label}不在允许的选项中`);
      return value;
    case 'string_list': {
      const values = (Array.isArray(value) ? value : [value])
        .map((item) => safeText(item, constraints.maxItemLength || 120).trim())
        .filter(Boolean);
      return [...new Set(values)].slice(0, constraints.maxItems || 30);
    }
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${schema.label}必须是对象`);
      return value;
    default:
      return value;
  }
}

function syncDerivedStage(key, value, scope, options) {
  if (key !== 'relationship.intimacy' || options.skipDerived) return;
  const score = Number(value);
  const stage = RELATIONSHIP_STAGE_THRESHOLDS.find((item) => score >= item.minimum)?.stage || '初识';
  setMemoryValue('relationship.stage', stage, scope, {
    sourceType: 'derived', sourceMessageId: options.sourceMessageId || '',
    reason: '由亲密度区间派生', skipDerived: true
  });
}

export function getMemorySchema(key) {
  return db.prepare('SELECT * FROM memory_schemas WHERE key = ? AND enabled = 1').get(key);
}

export function getMemoryValue(key, scope) {
  const schema = getMemorySchema(key);
  if (!schema) return null;
  const parts = scopeParts(schema, scope);
  const row = db.prepare(`SELECT mv.*, ms.key, ms.label, ms.value_type, ms.category
    FROM memory_values mv JOIN memory_schemas ms ON ms.id = mv.schema_id
    WHERE mv.schema_id = ? AND mv.user_id = ? AND mv.agent_id = ? AND mv.story_id = ?
      AND mv.branch_id = ? AND mv.status = 'active'`)
    .get(schema.id, parts.userId, parts.agentId, parts.storyId, parts.branchId);
  if (row) return { ...row, value: parseJson(row.value_json) };
  const fallback = parseJson(schema.default_json);
  return fallback === null ? null : { ...schema, value: fallback, version: 0, source_type: 'default' };
}

export function setMemoryValue(key, value, scope, options = {}) {
  const schema = getMemorySchema(key);
  if (!schema) throw new Error(`未找到已启用的记忆字段：${key}`);
  const parts = scopeParts(schema, scope);
  const normalized = normalizeValue(schema, value);
  const current = db.prepare(`SELECT * FROM memory_values
    WHERE schema_id = ? AND user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?`)
    .get(schema.id, parts.userId, parts.agentId, parts.storyId, parts.branchId);
  const timestamp = nowIso();

  if (current) {
    let nextValue = normalized;
    if (options.operation === 'merge' && schema.value_type === 'string_list') {
      nextValue = normalizeValue(schema, [...(parseJson(current.value_json, []) || []), ...normalized]);
    }
    if (json(nextValue) === current.value_json) {
      syncDerivedStage(key, nextValue, scope, options);
      return { key, value: nextValue, version: current.version, operation: 'noop' };
    }
    const nextVersion = current.version + 1;
    db.prepare(`UPDATE memory_values SET value_json = ?, status = 'active', version = ?, source_type = ?,
      source_message_id = ?, confidence = ?, updated_at = ? WHERE id = ?`)
      .run(json(nextValue), nextVersion, options.sourceType || 'manual', options.sourceMessageId || '',
        options.confidence ?? 1, timestamp, current.id);
    db.prepare(`INSERT INTO memory_history
      (id, memory_value_id, schema_id, user_id, old_value_json, new_value_json, operation,
       source_type, source_message_id, reason, version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid('mh'), current.id, schema.id, parts.userId, current.value_json, json(nextValue),
        options.operation || 'update', options.sourceType || 'manual', options.sourceMessageId || '',
        options.reason || '', nextVersion, timestamp);
    syncDerivedStage(key, nextValue, scope, options);
    return { key, value: nextValue, version: nextVersion, operation: options.operation || 'update' };
  }

  const id = uid('mv');
  db.prepare(`INSERT INTO memory_values
    (id, schema_id, user_id, agent_id, story_id, branch_id, value_json, source_type,
     source_message_id, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, schema.id, parts.userId, parts.agentId, parts.storyId, parts.branchId, json(normalized),
      options.sourceType || 'manual', options.sourceMessageId || '', options.confidence ?? 1, timestamp, timestamp);
  db.prepare(`INSERT INTO memory_history
    (id, memory_value_id, schema_id, user_id, old_value_json, new_value_json, operation,
     source_type, source_message_id, reason, version, created_at)
    VALUES (?, ?, ?, ?, NULL, ?, 'create', ?, ?, ?, 1, ?)`)
    .run(uid('mh'), id, schema.id, parts.userId, json(normalized), options.sourceType || 'manual',
      options.sourceMessageId || '', options.reason || '', timestamp);
  syncDerivedStage(key, normalized, scope, options);
  return { key, value: normalized, version: 1, operation: 'create' };
}

export function applyMemoryDelta(key, delta, scope, options = {}) {
  const schema = getMemorySchema(key);
  if (!schema || schema.value_type !== 'number') throw new Error(`${key}不是可增量更新的数字字段`);
  const constraints = parseJson(schema.constraints_json, {});
  const current = getMemoryValue(key, scope)?.value ?? parseJson(schema.default_json, 0);
  const boundedDelta = clamp(Number(delta) || 0, -(constraints.maxDeltaPerTurn || 5), constraints.maxDeltaPerTurn || 5);
  return setMemoryValue(key, Number(current) + boundedDelta, scope, {
    ...options,
    operation: 'delta',
    reason: options.reason || `增量更新 ${boundedDelta >= 0 ? '+' : ''}${boundedDelta}`
  });
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join('、');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function loadMemorySnapshot(scope, scenarioType) {
  const schemas = schemaRows(scenarioType);
  return schemas.map((schema) => {
    const memory = getMemoryValue(schema.key, scope);
    return {
      schema,
      value: memory?.value ?? parseJson(schema.default_json),
      version: memory?.version ?? 0,
      sourceType: memory?.source_type || 'default',
      updatedAt: memory?.updated_at || ''
    };
  });
}

export function compilePinnedMemory(scope, scenarioType) {
  const snapshot = loadMemorySnapshot(scope, scenarioType).filter(({ schema, value }) => {
    if (!schema.pinned) return false;
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) return false;
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return false;
    return true;
  });
  const lines = snapshot.map(({ schema, value }) => {
    const rendered = schema.prompt_template
      ? schema.prompt_template.replace('{{value}}', formatValue(value))
      : `${schema.label}：${formatValue(value)}`;
    return `- [${schema.key}] ${rendered}`;
  });
  return { text: lines.join('\n'), items: snapshot.map(({ schema, ...rest }) => ({ key: schema.key, label: schema.label, ...rest })) };
}

export function detectFastControlUpdates(text, scope, sourceMessageId) {
  const updates = [];
  const normalized = String(text).trim();
  const addressMatch = normalized.match(/(?:以后|之后|接下来|别再|不要)?.{0,10}(?:叫|称呼)我(?:为)?[“”"']?([^,.，。！！!?？\s]{1,12})/);
  if (addressMatch) {
    updates.push(setMemoryValue('identity.preferred_address', addressMatch[1], scope, {
      sourceType: 'user_explicit_ooc', sourceMessageId, reason: '用户明确指定称呼'
    }));
  }
  if (/(回复|回答|说话).{0,8}(简短|简洁|短一点)|少说一点/.test(normalized)) {
    updates.push(setMemoryValue('response.verbosity', '简短', scope, {
      sourceType: 'user_explicit_ooc', sourceMessageId, reason: '用户明确调整回复长度'
    }));
  } else if (/(回复|回答|解释).{0,8}(详细|多一点)/.test(normalized)) {
    updates.push(setMemoryValue('response.verbosity', '详细', scope, {
      sourceType: 'user_explicit_ooc', sourceMessageId, reason: '用户明确调整回复长度'
    }));
  }
  const styleMatch = normalized.match(/(?:以后|之后|接下来)?.{0,8}(?:按照|用|保持)([^,，。]{1,30})(?:风格|语气)(?:回复|说话)?/);
  if (styleMatch) {
    updates.push(setMemoryValue('response.tone', [styleMatch[1].trim()], scope, {
      operation: 'merge', sourceType: 'user_explicit_ooc', sourceMessageId, reason: '用户明确设定风格'
    }));
  }
  const allergy = normalized.match(/我(?:对)?([^,，。]{1,30})过敏/);
  if (allergy) {
    updates.push(setMemoryValue('profile.safety_constraints', [`对${allergy[1].trim()}过敏`], scope, {
      operation: 'merge', sourceType: 'user_explicit', sourceMessageId, reason: '用户明确提供的安全约束'
    }));
  }
  return updates;
}

export function ensureEntity(scope, entity) {
  const name = safeText(entity.name || entity.canonical_name || entity, 120).trim();
  const type = safeText(entity.type || entity.entity_type || 'concept', 40);
  if (!name) throw new Error('实体名不能为空');
  const existing = db.prepare(`SELECT * FROM entities WHERE user_id = ? AND agent_id = ? AND story_id = ?
    AND branch_id = ? AND entity_type = ? AND canonical_name = ?`)
    .get(scope.userId, scope.agentId, scope.storyId, scope.branchId, type, name);
  if (existing) return existing;
  const row = {
    id: uid('entity'),
    user_id: scope.userId,
    agent_id: scope.agentId,
    story_id: scope.storyId,
    branch_id: scope.branchId,
    entity_type: type,
    canonical_name: name
  };
  const timestamp = nowIso();
  db.prepare(`INSERT INTO entities
    (id, user_id, agent_id, story_id, branch_id, entity_type, canonical_name, aliases_json,
     attributes_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.user_id, row.agent_id, row.story_id, row.branch_id, row.entity_type,
      row.canonical_name, json(entity.aliases || []), json(entity.attributes || {}), timestamp, timestamp);
  return row;
}

function applyClaim(claim, scope, sourceMessageId, eventId = '') {
  const subject = ensureEntity(scope, claim.subject || { name: '未指定事件', type: 'event' });
  const predicate = safeText(claim.predicate || '相关信息', 80);
  const factScope = claim.fact_scope || 'world_fact';
  const operation = claim.operation || 'create';
  const active = db.prepare(`SELECT * FROM claims WHERE user_id = ? AND agent_id = ? AND story_id = ?
    AND branch_id = ? AND subject_entity_id = ? AND predicate = ? AND fact_scope = ? AND status = 'active'
    ORDER BY version DESC LIMIT 1`)
    .get(scope.userId, scope.agentId, scope.storyId, scope.branchId, subject.id, predicate, factScope);
  const timestamp = nowIso();
  if (active && ['update', 'supersede', 'retract'].includes(operation)) {
    db.prepare(`UPDATE claims SET status = ?, updated_at = ? WHERE id = ?`)
      .run(operation === 'retract' ? 'retracted' : 'superseded', timestamp, active.id);
    if (operation === 'retract') return { operation, oldClaimId: active.id };
  }
  const id = uid('claim');
  db.prepare(`INSERT INTO claims
    (id, user_id, agent_id, story_id, branch_id, subject_entity_id, predicate, object_text,
     fact_scope, modality, status, version, supersedes_claim_id, source_speaker,
     source_message_id, event_id, confidence, story_time, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, scope.userId, scope.agentId, scope.storyId, scope.branchId, subject.id, predicate,
      safeText(claim.object || claim.object_text || '', 500), factScope, claim.modality || 'asserted',
      active ? active.version + 1 : 1, active?.id || null, claim.source_speaker || 'user', sourceMessageId,
      eventId, claim.confidence ?? 0.85, claim.story_time || '', json(claim.metadata || {}), timestamp, timestamp);
  return { id, operation: active ? 'supersede' : 'create', subject: subject.canonical_name, predicate };
}

export async function storeEvent(event, scope, sourceMessageId) {
  const timestamp = nowIso();
  const eventKey = safeText(event.event_key || `${event.event_type || 'event'}:${event.title || sourceMessageId}`, 160);
  if (['update', 'supersede'].includes(event.operation)) {
    db.prepare(`UPDATE events SET status = 'superseded', updated_at = ? WHERE user_id = ? AND agent_id = ?
      AND story_id = ? AND branch_id = ? AND event_key = ? AND status = 'active'`)
      .run(timestamp, scope.userId, scope.agentId, scope.storyId, scope.branchId, eventKey);
  }
  const id = uid('event');
  db.prepare(`INSERT INTO events
    (id, user_id, agent_id, story_id, branch_id, scene_id, event_key, event_type, title, summary,
     story_time, sequence_no, source_message_id, importance, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, scope.userId, scope.agentId, scope.storyId, scope.branchId, event.scene_id || '', eventKey,
      event.event_type || 'episode', safeText(event.title || '对话事件', 160),
      safeText(event.summary || '', 2000), event.story_time || '', event.sequence_no ?? null,
      sourceMessageId, clamp(Number(event.importance ?? 0.5), 0, 1), json(event.metadata || {}), timestamp, timestamp);

  for (const entity of event.entities || []) ensureEntity(scope, entity);
  const claimResults = [];
  for (const claim of event.claims || []) claimResults.push(applyClaim(claim, scope, sourceMessageId, id));
  const relationResults = [];
  for (const relation of event.relations || []) {
    const source = ensureEntity(scope, relation.source);
    const target = ensureEntity(scope, relation.target);
    const predicate = safeText(relation.predicate || '相关', 80);
    if (['update', 'supersede', 'retract'].includes(relation.operation)) {
      db.prepare(`UPDATE entity_edges SET status = ?, updated_at = ?
        WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
          AND source_entity_id = ? AND predicate = ? AND status = 'active'`)
        .run(relation.operation === 'retract' ? 'retracted' : 'superseded', timestamp,
          scope.userId, scope.agentId, scope.storyId, scope.branchId, source.id, predicate);
      if (relation.operation === 'retract') continue;
    }
    const edgeId = uid('edge');
    db.prepare(`INSERT INTO entity_edges
      (id, user_id, agent_id, story_id, branch_id, source_entity_id, predicate, target_entity_id,
       properties_json, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(edgeId, scope.userId, scope.agentId, scope.storyId, scope.branchId, source.id, predicate,
        target.id, json(relation.properties || {}), sourceMessageId, timestamp, timestamp);
    relationResults.push({ id: edgeId, source: source.canonical_name, predicate, target: target.canonical_name });
  }

  const embedded = await embedText(`${event.title || ''}\n${event.summary || ''}`);
  db.prepare(`INSERT OR REPLACE INTO embeddings
    (id, user_id, owner_type, owner_id, model, dimensions, vector_json, source_text, created_at)
    VALUES (?, ?, 'event', ?, ?, ?, ?, ?, ?)`)
    .run(uid('emb'), scope.userId, id, embedded.model, embedded.vector.length, json(embedded.vector),
      safeText(`${event.title || ''}\n${event.summary || ''}`, 4000), timestamp);
  return { id, eventKey, claims: claimResults, relations: relationResults, embedding: { model: embedded.model, fallback: embedded.fallback } };
}

function findRelatedActiveEvent(event, scope) {
  const candidates = db.prepare(`SELECT * FROM events WHERE user_id = ? AND agent_id = ?
    AND story_id = ? AND branch_id = ? AND event_type = ? AND status = 'active'
    ORDER BY updated_at DESC LIMIT 30`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId, event.event_type || 'episode');
  if (!candidates.length) return null;
  const entityNames = (event.entities || []).map((entity) => String(entity.name || '')).filter(Boolean);
  const scored = candidates.map((candidate) => {
    const text = `${candidate.title}\n${candidate.summary}`;
    const sharedEntities = entityNames.filter((name) => text.includes(name)).length;
    const titleOverlap = event.title && (text.includes(event.title) || event.title.includes(candidate.title)) ? 2 : 0;
    return { candidate, score: sharedEntities * 3 + titleOverlap };
  }).sort((a, b) => b.score - a.score);
  if (scored[0].score > 0) return scored[0].candidate;
  return candidates.length === 1 ? candidates[0] : null;
}

function latestMentionedPlace(event, userText) {
  const placeNames = (event.entities || [])
    .filter((entity) => entity.type === 'place' || entity.entity_type === 'place')
    .map((entity) => entity.name || entity.canonical_name)
    .filter(Boolean);
  for (const relation of event.relations || []) {
    const target = relation.target?.name || relation.target?.canonical_name;
    if (target && (relation.target?.type === 'place' || /(改为|改到|地点|位于|located)/i.test(relation.predicate || ''))) {
      placeNames.push(target);
    }
    if (relation.properties?.location) placeNames.push(relation.properties.location);
  }
  const uniquePlaces = [...new Set(placeNames)];
  const explicitChange = String(userText).match(/(?:改到|改为|换到|换成|定在|确认在)([^,.，。！!?？\s]{1,30})/);
  if (explicitChange) {
    const matched = uniquePlaces.find((place) => explicitChange[1].includes(place));
    return matched || explicitChange[1];
  }
  const mentioned = uniquePlaces
    .map((place) => ({ place, index: String(userText).lastIndexOf(place) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.index - a.index);
  return mentioned[0]?.place || uniquePlaces[0] || '';
}

export function reconcileExtractedEvent(rawEvent, userText, scope) {
  const event = {
    ...rawEvent,
    entities: [...(rawEvent.entities || [])],
    relations: [...(rawEvent.relations || [])],
    claims: [...(rawEvent.claims || [])],
    metadata: { ...(rawEvent.metadata || {}) }
  };
  const updateSignal = /(改到|改为|换到|不在|不要|取消|作废|最新|确认了|确认在)/.test(userText)
    || ['update', 'supersede', 'retract'].includes(event.operation);
  const related = updateSignal ? findRelatedActiveEvent(event, scope) : null;
  if (related) {
    event.event_key = related.event_key;
    event.operation = event.operation === 'retract' ? 'retract' : 'supersede';
    event.metadata.reconciled_from_event_id = related.id;
    event.metadata.model_event_key = rawEvent.event_key || '';
  }

  if (event.event_type === 'meeting') {
    const stableSubject = related?.title || event.title || '会面';
    const location = latestMentionedPlace(event, userText);
    const locationClaims = event.claims.filter((claim) => /(地点|location|位于)/i.test(claim.predicate || ''));
    if (locationClaims.length) {
      const canonicalClaim = locationClaims.find((claim) => claim.modality === 'asserted') || locationClaims.at(-1);
      canonicalClaim.subject = { name: stableSubject, type: 'event' };
      canonicalClaim.predicate = '地点';
      canonicalClaim.object = location || canonicalClaim.object || canonicalClaim.object_text;
      canonicalClaim.fact_scope = 'world_fact';
      canonicalClaim.modality = 'asserted';
      canonicalClaim.operation = related ? 'supersede' : (canonicalClaim.operation || 'create');
      canonicalClaim.metadata = { ...(canonicalClaim.metadata || {}), reconciled_slot: true, deduplicated_slot: locationClaims.length > 1 };
      const locationSet = new Set(locationClaims);
      event.claims = event.claims.filter((claim) => !locationSet.has(claim) || claim === canonicalClaim);
    }
    if (location && !locationClaims.length) {
      event.claims.push({
        subject: { name: stableSubject, type: 'event' },
        predicate: '地点',
        object: location,
        fact_scope: 'world_fact',
        modality: /(先约|暂定|暂时)/.test(userText) ? 'uncertain' : 'asserted',
        operation: related ? 'supersede' : 'create',
        confidence: 0.98,
        metadata: { reconciled_slot: true }
      });
    }
    const timeClaims = event.claims.filter((claim) => /(时间|time)/i.test(claim.predicate || ''));
    for (const claim of timeClaims) {
      claim.subject = { name: stableSubject, type: 'event' };
      claim.predicate = '时间';
      claim.fact_scope = 'world_fact';
      claim.operation = related ? 'supersede' : (claim.operation || 'create');
      claim.metadata = { ...(claim.metadata || {}), reconciled_slot: true };
    }
    if (event.story_time && !timeClaims.length && !updateSignal) {
      event.claims.push({
        subject: { name: stableSubject, type: 'event' }, predicate: '时间', object: event.story_time,
        fact_scope: 'world_fact', modality: 'asserted', operation: 'create', confidence: 0.9,
        metadata: { reconciled_slot: true }
      });
    }
  }
  return event;
}

export function getEventExtractionProfile(sceneId) {
  const row = db.prepare('SELECT * FROM event_extraction_profiles WHERE scene_id = ?').get(sceneId);
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(row.enabled),
    include_assistant: Boolean(row.include_assistant),
    allowed_event_types: parseJson(row.allowed_event_types_json, []),
    update_signals: parseJson(row.update_signals_json, [])
  };
}

function extractionDialogue(conversationId, contextTurns, includeAssistant) {
  if (!conversationId) return [];
  const limit = Math.max(2, Math.min(EXTRACTION_CONTEXT_MAX_MESSAGES, Number(contextTurns || 1) * 2));
  return db.prepare(`SELECT role, content, created_at FROM (
      SELECT role, content, created_at FROM messages
      WHERE conversation_id = ? AND role IN ('user', 'assistant')
      ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at`).all(conversationId, limit)
    .filter((item) => includeAssistant || item.role !== 'assistant');
}

export async function extractAndCommitMemory({
  userText, assistantText, scope, sourceMessageId, agent, conversationId = ''
}) {
  const profile = getEventExtractionProfile(agent.scene_id);
  if (!profile || !profile.enabled) {
    return { status: 'skipped', reason: 'event_extraction_disabled', changes: [], events: [] };
  }
  const schemas = schemaRows(agent.scenario_type).map((item) => ({
    key: item.key,
    type: item.value_type,
    extraction_mode: item.extraction_mode,
    description: item.description
  }));
  const currentClaims = db.prepare(`SELECT e.canonical_name AS subject, c.predicate, c.object_text, c.fact_scope
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    WHERE c.user_id = ? AND c.agent_id = ? AND c.story_id = ? AND c.branch_id = ? AND c.status = 'active'
    ORDER BY c.updated_at DESC LIMIT 30`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const currentDate = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const allowedEventTypes = profile.allowed_event_types.length
    ? profile.allowed_event_types
    : ['episode', 'trip', 'meeting', 'promise', 'relationship', 'plot'];
  const updateSignals = profile.update_signals.length
    ? profile.update_signals
    : ['改为', '取消', '作废', '确认'];
  const recentDialogue = extractionDialogue(conversationId, profile.context_turns, profile.include_assistant);
  const extractionPrompt = `你是角色陪聊 Agent 的记忆写入器。仅输出一个 JSON 对象，不要 Markdown。
当前日期是 ${currentDate}（Asia/Shanghai）。可据此解析“今天”，但不得为无法确定的时间编造具体日期。
本次只写入“当轮用户新增、更正或明确确认”的记忆；最近对话只用于指代消歧，不得重复抽取旧事件。

核心规则：
1. 仅记录未来可复用、可追溯、与当前故事或用户稳定特征相关的内容；日常碎片和无关描述放入 ignored_noise。
2. 更新信号 ${JSON.stringify(updateSignals)} 表示同一事件槽位更新，operation 必须是 supersede 或 update。
3. 区分 world_fact、character_belief、rumor、hypothetical、dream 和 ooc_instruction。某角色的说法不等于世界真相。
4. 不要将助手自行生成、用户尚未承接的情节写成用户已确认的事实。
5. 结构化字段只能使用给定 key。explicit_only 仅在用户明确要求时更新。
6. 亲密度和信任度单轮变化范围 -5 到 5，普通闲聊应为 0；只在有明确关系意义的事件时调整。
7. 会议/会面必须在 claims 中分别记录“地点”和“时间”槽位；更新时 subject 必须与旧事件一致。
8. 明确属于同一系列的有序事件，在 metadata.collection_name 中使用稳定集合名，并填写 sequence_no；无关经历不得加入该集合。
9. 每轮最多输出 ${profile.max_events_per_turn} 个事件；新建事件 importance 低于 ${profile.min_importance} 时放入 ignored_noise。
10. 本场景只允许事件类型：${allowedEventTypes.join(', ')}。
${profile.custom_rules ? `11. 场景附加规则：${profile.custom_rules}` : ''}

输出格式：
{
  "structured_updates": [{"key":"...","operation":"set|merge","value":null,"confidence":0.0,"reason":"..."}],
  "relationship_deltas": [{"key":"relationship.intimacy|relationship.trust","delta":0,"reason":"..."}],
  "events": [{
    "event_key":"稳定事件标识", "operation":"create|update|supersede", "event_type":"${allowedEventTypes.join('|')}",
    "title":"...", "summary":"...", "story_time":"", "sequence_no":null, "importance":0.0,
    "entities":[{"name":"...","type":"person|place|item|event|organization|concept"}],
    "relations":[{"source":{"name":"...","type":"..."},"predicate":"...","target":{"name":"...","type":"..."},"operation":"create|update|supersede|retract","properties":{}}],
    "claims":[{"subject":{"name":"...","type":"..."},"predicate":"...","object":"...","fact_scope":"world_fact|character_belief|rumor|hypothetical|dream|ooc_instruction","modality":"asserted|uncertain|denied","operation":"create|update|supersede|retract","confidence":0.0}]
  }],
  "ignored_noise": ["..."]
}

可用结构化字段：${JSON.stringify(schemas)}
当前有效声明：${JSON.stringify(currentClaims)}
最近 ${profile.context_turns} 轮对话（仅消歧）：${JSON.stringify(recentDialogue)}
用户本轮：${userText}
助手回复（仅用于理解上下文）：${profile.include_assistant ? assistantText : '（本场景未注入助手回复）'}`;

  const result = await generateText({
    systemPrompt: '你只输出严格 JSON。',
    messages: [{ role: 'user', content: extractionPrompt }],
    temperature: 0.1,
    maxOutputTokens: 1800
  });
  const extracted = extractJson(result.text);
  if (!extracted) throw new Error('记忆抽取模型未返回合法 JSON');

  const changes = [];
  for (const update of extracted.structured_updates || []) {
    try {
      changes.push(setMemoryValue(update.key, update.value, scope, {
        operation: update.operation === 'merge' ? 'merge' : 'update',
        sourceType: 'model_extracted',
        sourceMessageId,
        confidence: update.confidence ?? 0.7,
        reason: update.reason || ''
      }));
    } catch (error) {
      changes.push({ key: update.key, rejected: true, reason: error.message });
    }
  }
  for (const delta of extracted.relationship_deltas || []) {
    if (!['relationship.intimacy', 'relationship.trust'].includes(delta.key)) continue;
    if (!Number(delta.delta)) continue;
    changes.push(applyMemoryDelta(delta.key, delta.delta, scope, {
      sourceType: 'event_derived', sourceMessageId, confidence: 0.7, reason: delta.reason || ''
    }));
  }
  const events = [];
  const filteredEvents = [];
  for (const rawEvent of (extracted.events || []).slice(0, profile.max_events_per_turn)) {
    if (!allowedEventTypes.includes(rawEvent.event_type)) {
      filteredEvents.push({ title: rawEvent.title || '', reason: 'event_type_not_allowed' });
      continue;
    }
    const importance = Number(rawEvent.importance ?? 0.5);
    if ((rawEvent.operation || 'create') === 'create' && importance < profile.min_importance) {
      filteredEvents.push({ title: rawEvent.title || '', reason: 'below_min_importance' });
      continue;
    }
    const event = reconcileExtractedEvent(rawEvent, userText, scope);
    events.push(await storeEvent(event, scope, sourceMessageId));
  }
  return {
    status: 'success', extraction: extracted, changes, events, filteredEvents,
    profile: {
      id: profile.id, name: profile.name, executionMode: profile.execution_mode,
      triggerPoint: profile.trigger_point, contextTurns: profile.context_turns
    },
    model: result.model, usage: result.usage
  };
}

export function getRetrievalProfile(sceneId) {
  return db.prepare('SELECT * FROM retrieval_profiles WHERE scene_id = ?').get(sceneId);
}

function resolveRetrievalStrategy(scope, options = {}) {
  const row = db.prepare(`SELECT rp.* FROM agents a
    JOIN retrieval_profiles rp ON rp.scene_id = a.scene_id WHERE a.id = ?`).get(scope.agentId) || {};
  const strategy = {
    id: row.id || 'retrieval_default',
    sceneId: row.scene_id || '',
    name: row.name || '默认混合召回',
    vectorEnabled: Boolean(row.vector_enabled ?? 1),
    keywordEnabled: Boolean(row.keyword_enabled ?? 1),
    graphEnabled: Boolean(row.graph_enabled ?? 1),
    intentFilterEnabled: Boolean(row.intent_filter_enabled ?? 1),
    minSimilarity: Number(row.min_similarity ?? 0.12),
    minKeywordScore: Number(row.min_keyword_score ?? 0.08),
    eventTopK: Number(row.event_top_k ?? 8),
    claimTopK: Number(row.claim_top_k ?? 20),
    edgeTopK: Number(row.edge_top_k ?? 20),
    vectorWeight: Number(row.vector_weight ?? 0.70),
    keywordWeight: Number(row.keyword_weight ?? 0.16),
    importanceWeight: Number(row.importance_weight ?? 0.10),
    recencyWeight: Number(row.recency_weight ?? 0.04),
    recencyHalfLifeDays: Number(row.recency_half_life_days ?? 30),
    activeOnly: true
  };
  return {
    ...strategy,
    ...options,
    eventTopK: Number(options.eventTopK ?? options.eventLimit ?? strategy.eventTopK),
    minSimilarity: Number(options.minSimilarity ?? strategy.minSimilarity),
    activeOnly: true
  };
}

function keywordSimilarity(query, content) {
  const tokens = (value) => {
    const normalized = String(value || '').normalize('NFKC').toLowerCase();
    const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '');
    const result = new Set(normalized.match(/[a-z0-9]+/g) || []);
    if (compact.length === 1) result.add(compact);
    for (let index = 0; index < compact.length - 1; index += 1) result.add(compact.slice(index, index + 2));
    return result;
  };
  const left = tokens(query);
  const right = tokens(content);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.sqrt(left.size * right.size);
}

function recencyScore(timestamp, halfLifeDays) {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (Date.now() - parsed) / 86400000);
  return Math.exp(-Math.log(2) * ageDays / Math.max(1, halfLifeDays));
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + Number(value || 0) ** 2, 0));
}

function selectEventEmbeddingRows(rows, queryEmbedding) {
  const selected = new Map();
  const rank = (row) => (row.embedding_model === queryEmbedding.model ? 4 : 0)
    + (row.embedding_dimensions === queryEmbedding.vector.length ? 2 : 0);
  for (const row of rows) {
    const current = selected.get(row.owner_id);
    if (!current || rank(row) > rank(current)
      || (rank(row) === rank(current) && row.embedding_created_at > current.embedding_created_at)) {
      selected.set(row.owner_id, row);
    }
  }
  return [...selected.values()];
}

export async function retrieveMemory(query, scope, options = {}) {
  const strategy = resolveRetrievalStrategy(scope, options);
  const queryEmbedding = strategy.vectorEnabled
    ? await embedText(query)
    : { vector: [], model: 'disabled', fallback: false, fallbackReason: '' };
  const embeddingRows = db.prepare(`SELECT em.owner_id, em.model AS embedding_model,
      em.dimensions AS embedding_dimensions, em.vector_json, em.source_text,
      em.created_at AS embedding_created_at, ev.title, ev.summary, ev.event_type,
      ev.story_time, ev.sequence_no, ev.importance, ev.status, ev.metadata_json,
      ev.created_at AS event_created_at, ev.updated_at AS event_updated_at
    FROM embeddings em JOIN events ev ON ev.id = em.owner_id
    WHERE em.user_id = ? AND em.owner_type = 'event' AND ev.agent_id = ? AND ev.story_id = ?
      AND ev.branch_id = ?`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const scopedCandidates = selectEventEmbeddingRows(embeddingRows, queryEmbedding)
    .map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}) }));
  const activeCandidates = scopedCandidates.filter((row) => row.status === 'active');
  const orderedCollection = /(按.{0,6}顺序|先后|第[一二三四五六七八九十]|这[一二三四五六七八九十两\d]+次)/.test(query);
  const requestedEventType = /(出行|旅行|旅程|第一站)/.test(query) ? 'trip'
    : /(会议|会面|见客户)/.test(query) ? 'meeting'
      : '';
  const collectionTagged = activeCandidates.filter((row) => {
    const label = row.metadata?.collection_name || row.metadata?.collection || '';
    return label && query.includes(label);
  });
  let intentCandidates = activeCandidates;
  let intentRule = '';
  if (strategy.intentFilterEnabled && collectionTagged.length) {
    intentCandidates = collectionTagged;
    intentRule = 'collection';
  } else if (strategy.intentFilterEnabled && requestedEventType) {
    intentCandidates = activeCandidates.filter((row) => row.event_type === requestedEventType);
    intentRule = 'event_type';
  }

  const candidateDiagnostics = new Map(scopedCandidates.map((row) => [row.owner_id, {
    id: row.owner_id,
    title: row.title,
    status: row.status,
    eventType: row.event_type,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    vectorCompatible: strategy.vectorEnabled ? row.embedding_dimensions === queryEmbedding.vector.length : null,
    vectorSource: strategy.vectorEnabled ? 'stored' : 'disabled',
    similarity: null,
    keywordScore: null,
    importance: Number(row.importance || 0),
    recencyScore: null,
    finalScore: null,
    selected: false,
    decision: row.status === 'active' ? '待计算' : `状态硬过滤·${row.status}`
  }]));
  const intentIds = new Set(intentCandidates.map((row) => row.owner_id));
  for (const row of activeCandidates) {
    if (!intentIds.has(row.owner_id)) candidateDiagnostics.get(row.owner_id).decision = '意图硬过滤';
  }

  const scoredCandidates = intentCandidates.map((row) => {
    const storedVector = parseJson(row.vector_json, []);
    let candidateVector = storedVector;
    let vectorCompatible = strategy.vectorEnabled ? storedVector.length === queryEmbedding.vector.length : null;
    let vectorSource = strategy.vectorEnabled ? 'stored' : 'disabled';
    if (strategy.vectorEnabled && !vectorCompatible && queryEmbedding.fallback) {
      candidateVector = localEmbedding(row.source_text, queryEmbedding.vector.length);
      vectorCompatible = true;
      vectorSource = 'fallback_recomputed';
    }
    const similarity = strategy.vectorEnabled && vectorCompatible
      ? cosineSimilarity(queryEmbedding.vector, candidateVector) : 0;
    const lexicalScore = strategy.keywordEnabled ? keywordSimilarity(query, `${row.title}\n${row.summary}`) : 0;
    const freshness = recencyScore(row.event_updated_at, strategy.recencyHalfLifeDays);
    const importance = Number(row.importance || 0);
    const finalScore = similarity * strategy.vectorWeight
      + lexicalScore * strategy.keywordWeight
      + importance * strategy.importanceWeight
      + freshness * strategy.recencyWeight;
    const vectorPass = strategy.vectorEnabled && vectorCompatible && similarity >= strategy.minSimilarity;
    const keywordPass = strategy.keywordEnabled && lexicalScore >= strategy.minKeywordScore;
    const orderedPass = strategy.intentFilterEnabled && orderedCollection
      && (Boolean(collectionTagged.length) || Boolean(requestedEventType));
    const passed = vectorPass || keywordPass || orderedPass;
    let rejectionReason = '';
    if (!passed && strategy.vectorEnabled && !vectorCompatible && !strategy.keywordEnabled) rejectionReason = '向量维度不兼容';
    else if (!passed) rejectionReason = '低于召回阈值';
    return {
      id: row.owner_id,
      title: row.title,
      summary: row.summary,
      eventType: row.event_type,
      storyTime: row.story_time,
      sequenceNo: row.sequence_no,
      importance,
      similarity,
      keywordScore: lexicalScore,
      recencyScore: freshness,
      finalScore,
      vectorCompatible,
      vectorSource,
      embeddingModel: row.embedding_model,
      embeddingDimensions: row.embedding_dimensions,
      passed,
      rejectionReason
    };
  });
  const qualifiedCandidates = scoredCandidates.filter((item) => item.passed)
    .sort((a, b) => orderedCollection
      ? ((a.sequenceNo ?? Number.MAX_SAFE_INTEGER) - (b.sequenceNo ?? Number.MAX_SAFE_INTEGER))
      : b.finalScore - a.finalScore);
  const eventMatches = qualifiedCandidates.slice(0, strategy.eventTopK);
  const selectedEventIds = new Set(eventMatches.map((item) => item.id));
  for (const item of scoredCandidates) {
    Object.assign(candidateDiagnostics.get(item.id), {
      vectorCompatible: item.vectorCompatible,
      vectorSource: item.vectorSource,
      similarity: item.similarity,
      keywordScore: item.keywordScore,
      recencyScore: item.recencyScore,
      finalScore: item.finalScore,
      selected: selectedEventIds.has(item.id),
      decision: selectedEventIds.has(item.id) ? '已召回' : (item.passed ? 'TopK 截断' : item.rejectionReason)
    });
  }

  const claimRows = strategy.graphEnabled ? db.prepare(`SELECT c.*, e.canonical_name AS subject
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    WHERE c.user_id = ? AND c.agent_id = ? AND c.story_id = ? AND c.branch_id = ?
      AND c.status = 'active' ORDER BY c.updated_at DESC LIMIT 200`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId) : [];
  const claims = claimRows.map((claim) => ({
    ...claim,
    keywordScore: strategy.keywordEnabled
      ? keywordSimilarity(query, `${claim.subject} ${claim.predicate} ${claim.object_text}`) : 0,
    fromEvent: selectedEventIds.has(claim.event_id)
  })).filter((claim) => claim.fromEvent || claim.keywordScore >= strategy.minKeywordScore)
    .sort((a, b) => Number(b.fromEvent) - Number(a.fromEvent) || b.keywordScore - a.keywordScore || b.confidence - a.confidence)
    .slice(0, strategy.claimTopK);

  const entities = strategy.graphEnabled ? db.prepare(`SELECT * FROM entities WHERE user_id = ? AND agent_id = ? AND story_id = ?
    AND branch_id = ? AND status = 'active'`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId) : [];
  const relevantEntityIds = new Set(entities.filter((entity) => query.includes(entity.canonical_name)).map((entity) => entity.id));
  for (const claim of claims) {
    relevantEntityIds.add(claim.subject_entity_id);
    if (claim.object_entity_id) relevantEntityIds.add(claim.object_entity_id);
  }
  let edges = [];
  if (strategy.graphEnabled && relevantEntityIds.size) {
    edges = db.prepare(`SELECT ee.*, s.canonical_name AS source_name, t.canonical_name AS target_name
      FROM entity_edges ee JOIN entities s ON s.id = ee.source_entity_id JOIN entities t ON t.id = ee.target_entity_id
      WHERE ee.user_id = ? AND ee.agent_id = ? AND ee.story_id = ? AND ee.branch_id = ? AND ee.status = 'active'`)
      .all(scope.userId, scope.agentId, scope.storyId, scope.branchId)
      .filter((edge) => relevantEntityIds.has(edge.source_entity_id) || relevantEntityIds.has(edge.target_entity_id))
      .slice(0, strategy.edgeTopK);
  }

  return {
    strategy,
    intent: {
      orderedCollection,
      requestedEventType,
      collectionFilterApplied: Boolean(collectionTagged.length),
      ruleApplied: intentRule
    },
    queryEmbedding: {
      model: queryEmbedding.model,
      dimensions: queryEmbedding.vector.length,
      norm: vectorNorm(queryEmbedding.vector),
      vectorPreview: queryEmbedding.vector.slice(0, 10),
      fallback: queryEmbedding.fallback,
      fallbackReason: queryEmbedding.fallbackReason || ''
    },
    diagnostics: {
      pipeline: {
        scopedCandidates: scopedCandidates.length,
        afterActiveGuard: activeCandidates.length,
        afterIntentFilter: intentCandidates.length,
        afterRelevanceThreshold: qualifiedCandidates.length,
        selected: eventMatches.length
      },
      candidates: [...candidateDiagnostics.values()],
      activeClaimCandidates: claimRows.length,
      selectedClaims: claims.length,
      selectedEdges: edges.length
    },
    events: eventMatches.map(({ passed, rejectionReason, ...item }) => item),
    claims: claims.map((item) => ({
      id: item.id, subject: item.subject, predicate: item.predicate, object: item.object_text,
      factScope: item.fact_scope, modality: item.modality, version: item.version,
      confidence: item.confidence, eventId: item.event_id, keywordScore: item.keywordScore
    })),
    edges: edges.map((item) => ({
      id: item.id, source: item.source_name, predicate: item.predicate, target: item.target_name
    }))
  };
}

export function formatRetrievedMemory(retrieval) {
  const sections = [];
  if (retrieval.claims.length) {
    sections.push('[当前有效声明]\n' + retrieval.claims.map((claim) =>
      `- ${claim.subject} / ${claim.predicate} = ${claim.object}（${claim.factScope}，v${claim.version}）`
    ).join('\n'));
  }
  if (retrieval.events.length) {
    sections.push('[相关事件]\n' + retrieval.events.map((event) =>
      `- ${event.title}：${event.summary}${event.storyTime ? `（${event.storyTime}）` : ''}`
    ).join('\n'));
  }
  if (retrieval.edges.length) {
    sections.push('[相关图谱关系]\n' + retrieval.edges.map((edge) =>
      `- ${edge.source} --${edge.predicate}--> ${edge.target}`
    ).join('\n'));
  }
  return sections.join('\n\n') || '（本轮未召回到相关历史事件）';
}

export function listMemoryForAdmin(scope, scenarioType) {
  return loadMemorySnapshot(scope, scenarioType).map(({ schema, ...item }) => ({
    id: schema.id,
    key: schema.key,
    label: schema.label,
    category: schema.category,
    scenarioType: schema.scenario_type,
    valueType: schema.value_type,
    scope: schema.scope,
    pinned: Boolean(schema.pinned),
    sensitivity: schema.sensitivity,
    extractionMode: schema.extraction_mode,
    ...item
  }));
}

export function listGraph(scope) {
  const entities = db.prepare(`SELECT * FROM entities WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const edges = db.prepare(`SELECT ee.*, s.canonical_name AS source_name, t.canonical_name AS target_name
    FROM entity_edges ee JOIN entities s ON s.id = ee.source_entity_id JOIN entities t ON t.id = ee.target_entity_id
    WHERE ee.user_id = ? AND ee.agent_id = ? AND ee.story_id = ? AND ee.branch_id = ?`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const events = db.prepare(`SELECT * FROM events WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
    ORDER BY created_at DESC LIMIT 100`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const claims = db.prepare(`SELECT c.*, e.canonical_name AS subject,
      oe.canonical_name AS object_name, pe.canonical_name AS perspective_name
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    LEFT JOIN entities oe ON oe.id = c.object_entity_id
    LEFT JOIN entities pe ON pe.id = c.perspective_entity_id
    WHERE c.user_id = ? AND c.agent_id = ? AND c.story_id = ? AND c.branch_id = ? ORDER BY c.updated_at DESC LIMIT 200`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  return { entities, edges, events, claims };
}

export function listEvents(scope, { includeHistory = false, order = 'story' } = {}) {
  const statusFilter = includeHistory ? '' : "AND status = 'active'";
  const orderBy = order === 'created'
    ? 'created_at ASC, id ASC'
    : "CASE WHEN story_time = '' THEN 1 ELSE 0 END, story_time ASC, CASE WHEN sequence_no IS NULL THEN 1 ELSE 0 END, sequence_no ASC, created_at ASC";
  const events = db.prepare(`SELECT * FROM events
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ? ${statusFilter}
    ORDER BY ${orderBy} LIMIT 200`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const claimStatement = db.prepare(`SELECT c.*, e.canonical_name AS subject,
      oe.canonical_name AS object_name
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    LEFT JOIN entities oe ON oe.id = c.object_entity_id
    WHERE c.event_id = ? AND (? = 1 OR c.status = 'active')
    ORDER BY c.updated_at ASC`);
  return events.map((event) => ({
    ...event,
    metadata: parseJson(event.metadata_json, {}),
    claims: claimStatement.all(event.id, includeHistory ? 1 : 0)
  }));
}

export function listMemorySchemas() {
  return db.prepare('SELECT * FROM memory_schemas ORDER BY sort_order, category, label').all();
}
