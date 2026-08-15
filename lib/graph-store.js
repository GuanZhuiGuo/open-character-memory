import neo4j from 'neo4j-driver';
import { config } from './config.js';
import { db } from './db.js';
import { nowIso, safeText, uid } from './utils.js';

let driver = null;
const runtimeState = {
  initialized: false,
  connected: false,
  lastError: '',
  lastProjectedAt: '',
  lastReadAt: '',
  nextRetryAt: ''
};

export function graphScopeKey(scope) {
  return [scope.userId, scope.agentId, scope.storyId || 'main_story', scope.branchId || 'main'].join('|');
}

function normalizedScope(scope) {
  return {
    userId: safeText(scope.userId, 100),
    agentId: safeText(scope.agentId, 100),
    storyId: safeText(scope.storyId || 'main_story', 100),
    branchId: safeText(scope.branchId || 'main', 100)
  };
}

function outboxPendingCount() {
  try {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM graph_projection_outbox WHERE status != 'succeeded'").get()?.count || 0);
  } catch {
    return 0;
  }
}

export function getGraphStoreStatus() {
  return {
    mode: config.graphStore,
    role: config.graphStore === 'neo4j' ? 'read_optimized_projection' : 'sqlite_fallback',
    configured: config.graphStore === 'sqlite' || Boolean(config.neo4j.uri && config.neo4j.username && config.neo4j.password),
    required: config.neo4j.required,
    connected: config.graphStore === 'neo4j' ? runtimeState.connected : true,
    initialized: runtimeState.initialized,
    database: config.graphStore === 'neo4j' ? config.neo4j.database : 'sqlite',
    pendingProjections: outboxPendingCount(),
    lastProjectedAt: runtimeState.lastProjectedAt,
    lastReadAt: runtimeState.lastReadAt,
    nextRetryAt: runtimeState.nextRetryAt,
    lastError: runtimeState.lastError
  };
}

function createDriver() {
  if (driver) return driver;
  driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(config.neo4j.username, config.neo4j.password),
    {
      connectionTimeout: 3000,
      connectionAcquisitionTimeout: 3000,
      maxTransactionRetryTime: 2000,
      maxConnectionPoolSize: 20
    }
  );
  return driver;
}

async function ensureConstraints() {
  const session = createDriver().session({ database: config.neo4j.database });
  try {
    for (const statement of [
      'CREATE CONSTRAINT memory_scope_key IF NOT EXISTS FOR (n:MemoryScope) REQUIRE n.scope_key IS UNIQUE',
      'CREATE CONSTRAINT memory_entity_key IF NOT EXISTS FOR (n:MemoryEntity) REQUIRE n.graph_key IS UNIQUE',
      'CREATE CONSTRAINT memory_event_key IF NOT EXISTS FOR (n:MemoryEvent) REQUIRE n.graph_key IS UNIQUE',
      'CREATE CONSTRAINT memory_claim_key IF NOT EXISTS FOR (n:MemoryClaim) REQUIRE n.graph_key IS UNIQUE'
    ]) {
      await session.run(statement);
    }
  } finally {
    await session.close();
  }
}

function discoverScopes() {
  return db.prepare(`SELECT DISTINCT user_id, agent_id, story_id, branch_id FROM (
      SELECT user_id, agent_id, story_id, branch_id FROM events
      UNION ALL SELECT user_id, agent_id, story_id, branch_id FROM entities
      UNION ALL SELECT user_id, agent_id, story_id, branch_id FROM claims
    ) WHERE user_id != '' AND agent_id != ''`).all().map((row) => ({
    userId: row.user_id,
    agentId: row.agent_id,
    storyId: row.story_id,
    branchId: row.branch_id
  }));
}

export function queueGraphProjection(scope) {
  if (config.graphStore !== 'neo4j') return { queued: false, reason: 'neo4j_disabled' };
  const normalized = normalizedScope(scope);
  const scopeKey = graphScopeKey(normalized);
  const timestamp = nowIso();
  db.prepare(`INSERT INTO graph_projection_outbox
      (id, scope_key, user_id, agent_id, story_id, branch_id, status, attempts,
       last_error, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '', ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      user_id = excluded.user_id, agent_id = excluded.agent_id,
      story_id = excluded.story_id, branch_id = excluded.branch_id,
      status = 'pending', last_error = '', available_at = excluded.available_at,
      updated_at = excluded.updated_at`)
    .run(uid('graph_outbox'), scopeKey, normalized.userId, normalized.agentId,
      normalized.storyId, normalized.branchId, timestamp, timestamp, timestamp);
  return { queued: true, scopeKey };
}

function graphKey(scopeKey, id) {
  return `${scopeKey}:${id}`;
}

function projectionSnapshot(scope) {
  const scopeKey = graphScopeKey(scope);
  const params = [scope.userId, scope.agentId, scope.storyId, scope.branchId];
  const entities = db.prepare(`SELECT * FROM entities
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ? AND status = 'active'`)
    .all(...params).map((row) => ({
      graph_key: graphKey(scopeKey, row.id),
      memory_id: row.id,
      scope_key: scopeKey,
      entity_type: row.entity_type,
      canonical_name: row.canonical_name,
      aliases_json: row.aliases_json,
      attributes_json: row.attributes_json,
      updated_at: row.updated_at
    }));
  const events = db.prepare(`SELECT * FROM events
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
      AND status = 'active' AND transaction_to = ''`).all(...params).map((row) => ({
    graph_key: graphKey(scopeKey, row.id),
    memory_id: row.id,
    scope_key: scopeKey,
    event_key: row.event_key,
    event_type: row.event_type,
    title: row.title,
    summary: row.summary,
    story_time: row.story_time,
    sequence_no: row.sequence_no === null ? -1 : Number(row.sequence_no),
    importance: Number(row.importance),
    memory_space: row.memory_space,
    canonicality: row.canonicality,
    source_speaker: row.source_speaker,
    version: Number(row.version || 1),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    transaction_from: row.transaction_from,
    transaction_to: row.transaction_to,
    metadata_json: row.metadata_json,
    updated_at: row.updated_at
  }));
  const claims = db.prepare(`SELECT c.*, e.canonical_name AS subject_name FROM claims c
    JOIN entities e ON e.id = c.subject_entity_id
    WHERE c.user_id = ? AND c.agent_id = ? AND c.story_id = ? AND c.branch_id = ?
      AND c.status = 'active' AND c.transaction_to = ''`).all(...params).map((row) => ({
    graph_key: graphKey(scopeKey, row.id),
    memory_id: row.id,
    scope_key: scopeKey,
    subject_entity_id: row.subject_entity_id,
    subject_name: row.subject_name,
    predicate: row.predicate,
    object_text: row.object_text,
    fact_scope: row.fact_scope,
    modality: row.modality,
    source_speaker: row.source_speaker,
    event_id: row.event_id || '',
    confidence: Number(row.confidence),
    version: Number(row.version || 1),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    transaction_from: row.transaction_from,
    transaction_to: row.transaction_to,
    metadata_json: row.metadata_json,
    updated_at: row.updated_at
  }));
  const eventLinks = db.prepare(`SELECT ee.* FROM event_entities ee
    JOIN events ev ON ev.id = ee.event_id
    WHERE ev.user_id = ? AND ev.agent_id = ? AND ev.story_id = ? AND ev.branch_id = ?
      AND ev.status = 'active' AND ev.transaction_to = ''`).all(...params).map((row) => ({
    link_key: row.id,
    event_graph_key: graphKey(scopeKey, row.event_id),
    entity_graph_key: graphKey(scopeKey, row.entity_id),
    role: row.role,
    source_message_id: row.source_message_id
  }));
  const claimLinks = claims.map((claim) => ({
    claim_graph_key: claim.graph_key,
    entity_graph_key: graphKey(scopeKey, claim.subject_entity_id),
    event_graph_key: claim.event_id ? graphKey(scopeKey, claim.event_id) : ''
  }));
  const edges = db.prepare(`SELECT ee.*, s.canonical_name AS source_name, t.canonical_name AS target_name,
      ev.title AS evidence_event_title
    FROM entity_edges ee
    JOIN entities s ON s.id = ee.source_entity_id
    JOIN entities t ON t.id = ee.target_entity_id
    LEFT JOIN events ev ON ev.id = ee.event_id
    WHERE ee.user_id = ? AND ee.agent_id = ? AND ee.story_id = ? AND ee.branch_id = ?
      AND ee.status = 'active' AND ee.transaction_to = ''
      AND (ee.event_id = '' OR (ev.status = 'active' AND ev.transaction_to = ''))`).all(...params).map((row) => ({
    edge_key: row.id,
    source_graph_key: graphKey(scopeKey, row.source_entity_id),
    target_graph_key: graphKey(scopeKey, row.target_entity_id),
    source_entity_id: row.source_entity_id,
    target_entity_id: row.target_entity_id,
    source_name: row.source_name,
    target_name: row.target_name,
    predicate: row.predicate,
    event_id: row.event_id || '',
    evidence_event_title: row.evidence_event_title || '',
    properties_json: row.properties_json,
    version: Number(row.version || 1),
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    transaction_from: row.transaction_from,
    transaction_to: row.transaction_to,
    updated_at: row.updated_at
  }));
  return { scopeKey, scope, entities, events, claims, eventLinks, claimLinks, edges };
}

async function replaceScopeProjection(snapshot) {
  const session = createDriver().session({ database: config.neo4j.database });
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`MERGE (scope:MemoryScope {scope_key: $scopeKey})
        SET scope.user_id = $userId, scope.agent_id = $agentId,
            scope.story_id = $storyId, scope.branch_id = $branchId, scope.updated_at = $updatedAt`, {
        scopeKey: snapshot.scopeKey,
        userId: snapshot.scope.userId,
        agentId: snapshot.scope.agentId,
        storyId: snapshot.scope.storyId,
        branchId: snapshot.scope.branchId,
        updatedAt: nowIso()
      });
      await tx.run(`MATCH (scope:MemoryScope {scope_key: $scopeKey})-[:HAS_ENTITY|HAS_EVENT|HAS_CLAIM]->(node)
        DETACH DELETE node`, { scopeKey: snapshot.scopeKey });
      await tx.run(`MATCH (scope:MemoryScope {scope_key: $scopeKey})
        UNWIND $rows AS row
        MERGE (node:MemoryEntity {graph_key: row.graph_key}) SET node += row
        MERGE (scope)-[:HAS_ENTITY]->(node)`, { scopeKey: snapshot.scopeKey, rows: snapshot.entities });
      await tx.run(`MATCH (scope:MemoryScope {scope_key: $scopeKey})
        UNWIND $rows AS row
        MERGE (node:MemoryEvent {graph_key: row.graph_key}) SET node += row
        MERGE (scope)-[:HAS_EVENT]->(node)`, { scopeKey: snapshot.scopeKey, rows: snapshot.events });
      await tx.run(`MATCH (scope:MemoryScope {scope_key: $scopeKey})
        UNWIND $rows AS row
        MERGE (node:MemoryClaim {graph_key: row.graph_key}) SET node += row
        MERGE (scope)-[:HAS_CLAIM]->(node)`, { scopeKey: snapshot.scopeKey, rows: snapshot.claims });
      await tx.run(`UNWIND $rows AS row
        MATCH (event:MemoryEvent {graph_key: row.event_graph_key})
        MATCH (entity:MemoryEntity {graph_key: row.entity_graph_key})
        MERGE (event)-[link:INVOLVES {link_key: row.link_key}]->(entity)
        SET link.role = row.role, link.source_message_id = row.source_message_id`, { rows: snapshot.eventLinks });
      await tx.run(`UNWIND $rows AS row
        MATCH (claim:MemoryClaim {graph_key: row.claim_graph_key})
        MATCH (entity:MemoryEntity {graph_key: row.entity_graph_key})
        MERGE (claim)-[:SUBJECT]->(entity)
        WITH claim, row WHERE row.event_graph_key <> ''
        MATCH (event:MemoryEvent {graph_key: row.event_graph_key})
        MERGE (claim)-[:EVIDENCE]->(event)`, { rows: snapshot.claimLinks });
      await tx.run(`UNWIND $rows AS row
        MATCH (source:MemoryEntity {graph_key: row.source_graph_key})
        MATCH (target:MemoryEntity {graph_key: row.target_graph_key})
        MERGE (source)-[edge:RELATED {edge_key: row.edge_key}]->(target)
        SET edge += row`, { rows: snapshot.edges });
    });
  } finally {
    await session.close();
  }
}

function outboxRows({ limit, scopeKey = '' }) {
  const query = scopeKey
    ? `SELECT * FROM graph_projection_outbox WHERE scope_key = ? AND status != 'succeeded'
       AND available_at <= ? ORDER BY updated_at ASC LIMIT ?`
    : `SELECT * FROM graph_projection_outbox WHERE status != 'succeeded'
       AND available_at <= ? ORDER BY updated_at ASC LIMIT ?`;
  return scopeKey
    ? db.prepare(query).all(scopeKey, nowIso(), limit)
    : db.prepare(query).all(nowIso(), limit);
}

export async function flushGraphProjectionOutbox({ limit = config.neo4j.projectionBatchSize, scopeKey = '' } = {}) {
  if (config.graphStore !== 'neo4j') return { status: 'disabled', projected: 0, failed: 0 };
  if (!runtimeState.connected) {
    if (runtimeState.nextRetryAt && runtimeState.nextRetryAt > nowIso()) {
      return {
        status: 'degraded', projected: 0, failed: 0, error: runtimeState.lastError,
        nextRetryAt: runtimeState.nextRetryAt
      };
    }
    try {
      await createDriver().verifyConnectivity();
      runtimeState.connected = true;
      runtimeState.lastError = '';
      runtimeState.nextRetryAt = '';
    } catch (error) {
      runtimeState.lastError = error.message;
      runtimeState.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
      if (config.neo4j.required) throw error;
      return { status: 'degraded', projected: 0, failed: 0, error: error.message };
    }
  }
  let projected = 0;
  let failed = 0;
  for (const row of outboxRows({ limit, scopeKey })) {
    const scope = { userId: row.user_id, agentId: row.agent_id, storyId: row.story_id, branchId: row.branch_id };
    try {
      db.prepare("UPDATE graph_projection_outbox SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      await replaceScopeProjection(projectionSnapshot(scope));
      const timestamp = nowIso();
      db.prepare(`UPDATE graph_projection_outbox SET status = 'succeeded', last_error = '', updated_at = ? WHERE id = ?`)
        .run(timestamp, row.id);
      runtimeState.lastProjectedAt = timestamp;
      runtimeState.connected = true;
      runtimeState.lastError = '';
      runtimeState.nextRetryAt = '';
      projected += 1;
    } catch (error) {
      const delaySeconds = Math.min(60, 2 ** Math.min(6, Number(row.attempts || 0) + 1));
      const availableAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      db.prepare(`UPDATE graph_projection_outbox
        SET status = 'pending', last_error = ?, available_at = ?, updated_at = ? WHERE id = ?`)
        .run(safeText(error.message, 1000), availableAt, nowIso(), row.id);
      runtimeState.connected = false;
      runtimeState.lastError = error.message;
      runtimeState.nextRetryAt = availableAt;
      failed += 1;
      if (config.neo4j.required) throw error;
    }
  }
  return { status: failed ? 'degraded' : 'ready', projected, failed };
}

export async function projectGraphScope(scope) {
  const queued = queueGraphProjection(scope);
  if (!queued.queued) return { status: 'disabled', ...queued };
  return flushGraphProjectionOutbox({ limit: 1, scopeKey: queued.scopeKey });
}

export async function initializeGraphStore() {
  runtimeState.initialized = true;
  if (config.graphStore !== 'neo4j') return getGraphStoreStatus();
  if (!config.neo4j.password) {
    runtimeState.lastError = 'NEO4J_PASSWORD 未配置';
    runtimeState.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
    if (config.neo4j.required) throw new Error(runtimeState.lastError);
    return getGraphStoreStatus();
  }
  try {
    await createDriver().verifyConnectivity();
    runtimeState.connected = true;
    runtimeState.nextRetryAt = '';
    await ensureConstraints();
    for (const scope of discoverScopes()) queueGraphProjection(scope);
    await flushGraphProjectionOutbox();
  } catch (error) {
    runtimeState.connected = false;
    runtimeState.lastError = error.message;
    runtimeState.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
    if (config.neo4j.required) throw error;
  }
  return getGraphStoreStatus();
}

export async function readGraphProjection(scope) {
  if (config.graphStore !== 'neo4j' || !runtimeState.connected) return null;
  const scopeKey = graphScopeKey(normalizedScope(scope));
  const session = createDriver().session({ database: config.neo4j.database });
  try {
    const [entityResult, eventLinkResult, edgeResult] = await session.executeRead(async (tx) => {
      const entities = await tx.run(`MATCH (:MemoryScope {scope_key: $scopeKey})-[:HAS_ENTITY]->(entity:MemoryEntity)
        RETURN entity`, { scopeKey });
      const eventLinks = await tx.run(`MATCH (:MemoryScope {scope_key: $scopeKey})-[:HAS_EVENT]->(event:MemoryEvent)
        MATCH (event)-[link:INVOLVES]->(entity:MemoryEntity)
        RETURN event.memory_id AS event_id, entity.memory_id AS entity_id, link.role AS role,
          entity.canonical_name AS canonical_name, entity.entity_type AS entity_type`, { scopeKey });
      const edges = await tx.run(`MATCH (:MemoryScope {scope_key: $scopeKey})-[:HAS_ENTITY]->(source:MemoryEntity)
        MATCH (source)-[edge:RELATED]->(target:MemoryEntity)
        RETURN edge, source.canonical_name AS source_name, target.canonical_name AS target_name`, { scopeKey });
      return [entities, eventLinks, edges];
    });
    runtimeState.lastReadAt = nowIso();
    return {
      source: 'neo4j',
      entities: entityResult.records.map((record) => {
        const properties = record.get('entity').properties;
        return {
          id: properties.memory_id,
          canonical_name: properties.canonical_name,
          entity_type: properties.entity_type,
          aliases_json: properties.aliases_json || '[]',
          attributes_json: properties.attributes_json || '{}',
          status: 'active'
        };
      }),
      eventEntityRows: eventLinkResult.records.map((record) => ({
        event_id: record.get('event_id'),
        entity_id: record.get('entity_id'),
        role: record.get('role'),
        canonical_name: record.get('canonical_name'),
        entity_type: record.get('entity_type')
      })),
      graphRows: edgeResult.records.map((record) => {
        const properties = record.get('edge').properties;
        return {
          id: properties.edge_key,
          source_entity_id: properties.source_entity_id,
          target_entity_id: properties.target_entity_id,
          predicate: properties.predicate,
          event_id: properties.event_id || '',
          properties_json: properties.properties_json || '{}',
          source_name: record.get('source_name'),
          target_name: record.get('target_name'),
          evidence_event_title: properties.evidence_event_title || '',
          evidence_event_status: 'active',
          status: 'active',
          transaction_to: ''
        };
      })
    };
  } catch (error) {
    runtimeState.connected = false;
    runtimeState.lastError = error.message;
    runtimeState.nextRetryAt = new Date(Date.now() + 30_000).toISOString();
    return null;
  } finally {
    await session.close();
  }
}

export async function closeGraphStore() {
  if (!driver) return;
  await driver.close();
  driver = null;
  runtimeState.connected = false;
}
