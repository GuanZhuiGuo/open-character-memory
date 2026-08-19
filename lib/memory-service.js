import {
  MEMORY_CONTRACT_VERSION, MemoryContractError, createContextPack, memoryScopeKey,
  normalizeExpandRequest, normalizeForgetRequest, normalizeMutationRequest,
  normalizeObservationRequest, normalizeRecallRequest
} from '../packages/memory-core/src/index.js';
import { config } from './config.js';
import { db } from './db.js';
import { queueGraphProjection } from './graph-store.js';
import {
  applyMemoryDelta, compilePinnedMemory, detectFastControlUpdates, extractAndCommitMemory,
  formatRetrievedMemory, getMemorySchema, getMemoryValue, getRetrievalProfile, retrieveMemory,
  setMemoryValue, storeEvent
} from './memory.js';
import { resolveMemoryTools } from './memory-tools.js';
import { hash, json, nowIso, parseJson, safeText, uid } from './utils.js';

const DEFAULT_WORKER_POLL_MS = 750;
const DEFAULT_JOB_MAX_ATTEMPTS = 3;
const MAX_CONTEXT_MESSAGES = 20;
let workerTimer = null;
let workerRunning = false;

export class MemoryServiceError extends Error {
  constructor(message, code = 'MEMORY_SERVICE_ERROR', status = 400, details = null) {
    super(message);
    this.name = 'MemoryServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function configuredTenantId() {
  return config.memoryService?.tenantId || 'default';
}

function coreDefaults() {
  return { tenantId: configuredTenantId(), extractionMode: 'async' };
}

function legacyScope(scope) {
  return {
    userId: scope.subjectId,
    agentId: scope.agentId,
    storyId: scope.spaceId,
    branchId: scope.branchId
  };
}

function assertTenant(scope) {
  if (scope.tenantId !== configuredTenantId()) {
    throw new MemoryServiceError('Memory scope does not belong to this tenant', 'MEMORY_TENANT_FORBIDDEN', 403);
  }
}

function scopeRecords(scope) {
  assertTenant(scope);
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(scope.subjectId);
  const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND enabled = 1').get(scope.agentId);
  if (!user) {
    throw new MemoryServiceError('Memory subject does not exist or is disabled', 'MEMORY_SUBJECT_NOT_FOUND', 404);
  }
  if (!agent) {
    throw new MemoryServiceError('Memory agent does not exist or is disabled', 'MEMORY_AGENT_NOT_FOUND', 404);
  }
  return { user, agent, legacy: legacyScope(scope) };
}

function transaction(task) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const output = task();
    db.exec('COMMIT');
    return output;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function requestFingerprint(request) {
  return hash(JSON.stringify(canonicalValue(request)));
}

function assertIdempotentReuse(row, request, fingerprint) {
  if (row.scope_key !== memoryScopeKey(request.scope)) {
    throw new MemoryServiceError(
      'Idempotency key was already used in another memory scope',
      'MEMORY_IDEMPOTENCY_SCOPE_CONFLICT',
      409
    );
  }
  if (row.request_hash && row.request_hash !== fingerprint) {
    throw new MemoryServiceError(
      'Idempotency key was already used with a different request payload',
      'MEMORY_IDEMPOTENCY_PAYLOAD_CONFLICT',
      409
    );
  }
}

function observationMessages(observationId) {
  return db.prepare(`SELECT id, role, content, metadata_json, created_at
    FROM memory_observation_messages WHERE observation_id = ? ORDER BY ordinal`).all(observationId)
    .map((row) => ({
      id: row.id,
      message_id: row.id,
      role: row.role,
      content: row.content,
      metadata: parseJson(row.metadata_json, {}),
      created_at: row.created_at
    }));
}

function jobReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    attempts: Number(row.attempts || 0),
    availableAt: row.available_at,
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
    result: parseJson(row.result_json, {}),
    error: row.last_error || ''
  };
}

function observationReceipt(row, { duplicate = false } = {}) {
  const job = db.prepare('SELECT * FROM memory_jobs WHERE observation_id = ?').get(row.id);
  return {
    contractVersion: MEMORY_CONTRACT_VERSION,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    duplicate,
    scope: {
      tenantId: row.tenant_id,
      subjectId: row.user_id,
      agentId: row.agent_id,
      spaceId: row.story_id,
      branchId: row.branch_id
    },
    threadId: row.thread_id,
    extractionMode: row.extraction_mode,
    evidenceIds: observationMessages(row.id).map((item) => item.id),
    result: parseJson(row.result_json, {}),
    error: row.last_error || '',
    job: jobReceipt(job),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function operationReceipt(row, { duplicate = false } = {}) {
  return {
    contractVersion: MEMORY_CONTRACT_VERSION,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    operationType: row.operation_type,
    status: row.status,
    duplicate,
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function priorObservationContext(observation) {
  const rows = db.prepare(`SELECT mom.role, mom.content, mom.created_at
    FROM memory_observations mo
    JOIN memory_observation_messages mom ON mom.observation_id = mo.id
    WHERE mo.scope_key = ? AND mo.thread_id = ? AND mo.rowid < ?
      AND mom.role IN ('user', 'assistant')
    ORDER BY mo.rowid DESC, mom.ordinal DESC LIMIT ?`).all(
    observation.scope_key,
    observation.thread_id,
    observation.observation_rowid,
    MAX_CONTEXT_MESSAGES
  );
  return rows.reverse();
}

function retryAvailableAt(attempts) {
  const delayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, attempts - 1)));
  return new Date(Date.now() + delayMs).toISOString();
}

function jobMaxAttempts() {
  return Math.max(1, Math.min(10, Number(config.memoryService?.jobMaxAttempts || DEFAULT_JOB_MAX_ATTEMPTS)));
}

export async function processMemoryJob(jobId) {
  const timestamp = nowIso();
  const claimed = db.prepare(`UPDATE memory_jobs SET status = 'running', attempts = attempts + 1,
      started_at = ?, updated_at = ?, last_error = ''
    WHERE id = ? AND status = 'pending' AND available_at <= ?`).run(timestamp, timestamp, jobId, timestamp);
  if (!claimed.changes) {
    const existing = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(jobId);
    if (!existing) throw new MemoryServiceError('Memory job not found', 'MEMORY_JOB_NOT_FOUND', 404);
    return jobReceipt(existing);
  }

  const job = db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(jobId);
  const observation = db.prepare(`SELECT rowid AS observation_rowid, *
    FROM memory_observations WHERE id = ?`).get(job.observation_id);
  const messages = observationMessages(observation.id).filter((item) => ['user', 'assistant'].includes(item.role));
  const userMessage = [...messages].reverse().find((item) => item.role === 'user');
  const assistantMessage = [...messages].reverse().find((item) => item.role === 'assistant');
  if (!userMessage || !assistantMessage) {
    const skipped = { status: 'skipped', reason: 'complete_turn_required' };
    db.prepare(`UPDATE memory_jobs SET status = 'succeeded', completed_at = ?, result_json = ?, updated_at = ?
      WHERE id = ?`).run(nowIso(), json(skipped), nowIso(), job.id);
    db.prepare(`UPDATE memory_observations SET status = 'completed', result_json = ?, updated_at = ?
      WHERE id = ?`).run(json(skipped), nowIso(), observation.id);
    return jobReceipt(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(job.id));
  }

  try {
    const scope = {
      userId: observation.user_id,
      agentId: observation.agent_id,
      storyId: observation.story_id,
      branchId: observation.branch_id
    };
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND enabled = 1').get(scope.agentId);
    if (!agent) throw new MemoryServiceError('Memory agent no longer exists', 'MEMORY_AGENT_NOT_FOUND', 404);
    const result = await extractAndCommitMemory({
      userText: userMessage.content,
      assistantText: assistantMessage.content,
      scope,
      sourceMessageId: userMessage.id,
      agent,
      extractionBatch: messages,
      extractionContext: priorObservationContext(observation)
    });
    const completedAt = nowIso();
    const compactResult = {
      status: result.status,
      changes: result.changes || [],
      events: (result.events || []).map((item) => ({
        id: item.id, eventKey: item.eventKey, operation: item.operation || 'committed'
      })),
      filteredEvents: result.filteredEvents || [],
      profile: result.profile || null,
      model: result.model || '',
      usage: result.usage || null
    };
    db.prepare(`UPDATE memory_jobs SET status = 'succeeded', completed_at = ?, result_json = ?,
      last_error = '', updated_at = ? WHERE id = ?`)
      .run(completedAt, json(compactResult), completedAt, job.id);
    const priorResult = parseJson(observation.result_json, {});
    db.prepare(`UPDATE memory_observations SET status = 'completed', result_json = ?,
      last_error = '', updated_at = ? WHERE id = ?`)
      .run(json({ ...priorResult, extraction: compactResult }), completedAt, observation.id);
  } catch (error) {
    const attempts = Number(job.attempts || 0);
    const exhausted = attempts >= jobMaxAttempts();
    const nextStatus = exhausted ? 'dead' : 'pending';
    const updatedAt = nowIso();
    db.prepare(`UPDATE memory_jobs SET status = ?, available_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`).run(
      nextStatus,
      exhausted ? updatedAt : retryAvailableAt(attempts),
      safeText(error.message || 'Memory extraction failed', 2000),
      updatedAt,
      job.id
    );
    db.prepare(`UPDATE memory_observations SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(exhausted ? 'failed' : 'queued', safeText(error.message || '', 2000), updatedAt, observation.id);
  }
  return jobReceipt(db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(job.id));
}

export async function runPendingMemoryJobs({ limit = 4 } = {}) {
  const rows = db.prepare(`SELECT id FROM memory_jobs
    WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT ?`)
    .all(nowIso(), Math.max(1, Math.min(20, Number(limit || 4))));
  const results = [];
  for (const row of rows) results.push(await processMemoryJob(row.id));
  return results;
}

export function startMemoryJobWorker() {
  if (workerTimer) return;
  db.prepare(`UPDATE memory_jobs SET status = 'pending', started_at = '', available_at = ?, updated_at = ?
    WHERE status = 'running'`).run(nowIso(), nowIso());
  const pollMs = Math.max(250, Math.min(60_000, Number(
    config.memoryService?.workerPollMs || DEFAULT_WORKER_POLL_MS
  )));
  workerTimer = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await runPendingMemoryJobs();
    } catch {
      // Individual jobs retain their own retry state; the next poll continues processing.
    } finally {
      workerRunning = false;
    }
  }, pollMs);
  workerTimer.unref?.();
}

export function stopMemoryJobWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  workerRunning = false;
}

export async function observeMemory(input, { traceId = '' } = {}) {
  const request = normalizeObservationRequest(input, coreDefaults());
  const { agent } = scopeRecords(request.scope);
  const scopeKey = memoryScopeKey(request.scope);
  const fingerprint = requestFingerprint(request);
  const existing = db.prepare(`SELECT * FROM memory_observations
    WHERE tenant_id = ? AND idempotency_key = ?`).get(request.scope.tenantId, request.idempotencyKey);
  if (existing) {
    assertIdempotentReuse(existing, request, fingerprint);
    return observationReceipt(existing, { duplicate: true });
  }

  const observationId = uid('obs');
  const timestamp = nowIso();
  const evidence = transaction(() => {
    db.prepare(`INSERT INTO memory_observations
      (id, tenant_id, idempotency_key, request_hash, scope_key, user_id, agent_id, story_id, branch_id,
       thread_id, extraction_mode, status, trace_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`).run(
      observationId, request.scope.tenantId, request.idempotencyKey, fingerprint, scopeKey,
      request.scope.subjectId, request.scope.agentId, request.scope.spaceId, request.scope.branchId,
      request.threadId, request.extractionMode, safeText(traceId, 160), json(request.metadata), timestamp, timestamp
    );
    return request.messages.map((message, ordinal) => {
      const id = uid('evidence');
      const createdAt = message.createdAt || timestamp;
      db.prepare(`INSERT INTO memory_observation_messages
        (id, observation_id, ordinal, role, content, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        observationId,
        ordinal,
        message.role,
        message.content,
        json({ ...message.metadata, ...(message.id ? { source_message_id: message.id } : {}) }),
        createdAt
      );
      return { ...message, id, createdAt };
    });
  });

  const fastControls = [];
  for (const message of evidence.filter((item) => item.role === 'user')) {
    try {
      const result = await detectFastControlUpdates(
        message.content,
        legacyScope(request.scope),
        message.id,
        traceId
      );
      if (result.changes?.length || result.rejected?.length) fastControls.push(result);
    } catch (error) {
      fastControls.push({ changes: [], rejected: [], error: safeText(error.message || '', 1000) });
    }
  }

  const completeTurn = evidence.some((item) => item.role === 'user')
    && evidence.some((item) => item.role === 'assistant');
  let status = 'completed';
  let result = {
    acceptedMessages: evidence.length,
    fastControls,
    extraction: request.extractionMode === 'none'
      ? { status: 'skipped', reason: 'extraction_disabled_by_request' }
      : { status: 'skipped', reason: 'complete_turn_required' }
  };
  let jobId = '';
  if (completeTurn && request.extractionMode !== 'none') {
    status = 'queued';
    jobId = uid('mjob');
    db.prepare(`INSERT INTO memory_jobs
      (id, observation_id, status, available_at, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?)`).run(jobId, observationId, nowIso(), nowIso(), nowIso());
    result = { acceptedMessages: evidence.length, fastControls, extraction: { status: 'queued', jobId } };
  }
  db.prepare(`UPDATE memory_observations SET status = ?, result_json = ?, updated_at = ? WHERE id = ?`)
    .run(status, json(result), nowIso(), observationId);

  if (jobId && request.extractionMode === 'sync') await processMemoryJob(jobId);
  return observationReceipt(db.prepare('SELECT * FROM memory_observations WHERE id = ?').get(observationId));
}

function retrievalDiagnostics(retrieval, request) {
  return {
    strategy: retrieval.strategy || null,
    intent: retrieval.intent || null,
    planner: retrieval.planner || null,
    candidateCatalog: retrieval.catalog || [],
    counts: {
      facts: retrieval.claims?.length || 0,
      events: retrieval.events?.length || 0,
      relations: retrieval.edges?.length || 0
    },
    activeOnly: true,
    scopeLocked: true,
    asOf: {
      requested: Boolean(request.validAt || request.knownAt),
      validAt: request.validAt,
      knownAt: request.knownAt,
      appliedToSemanticRecall: false
    }
  };
}

export async function recallMemory(input) {
  const request = normalizeRecallRequest(input, coreDefaults());
  const { agent, legacy } = scopeRecords(request.scope);
  if (request.validAt || request.knownAt) {
    throw new MemoryServiceError(
      'Historical as-of inspection remains available through the existing events/graph APIs; v1 semantic recall is active-only',
      'MEMORY_AS_OF_RECALL_UNSUPPORTED',
      422,
      { validAt: request.validAt, knownAt: request.knownAt }
    );
  }
  const retrieval = await retrieveMemory(request.query, legacy, request.retrieval);
  const pinned = request.includePinned ? compilePinnedMemory(legacy, agent.scenario_type) : { text: '', items: [] };
  const promptText = request.includePromptText ? formatRetrievedMemory(retrieval) : '';
  return createContextPack({
    request,
    pinned: pinned.text ? [{ kind: 'pinned_memory', content: pinned.text, priority: 100 }] : [],
    retrieval,
    promptText,
    diagnostics: {
      ...retrievalDiagnostics(retrieval, request),
      pinnedItems: pinned.items
    }
  });
}

function memoryToolStrategy(agent) {
  const row = getRetrievalProfile(agent.scene_id) || {};
  return {
    agentMemoryToolsEnabled: true,
    agentMemoryMaxCalls: Number(row.agent_memory_max_calls || 2),
    agentMemoryMaxQueries: Number(row.agent_memory_max_queries || 3),
    eventTopK: Number(row.event_top_k || 4),
    claimTopK: Number(row.claim_top_k || 20),
    edgeTopK: Number(row.edge_top_k || 20),
    graphHops: Number(row.graph_hops || 1)
  };
}

export async function expandMemory(input) {
  const request = normalizeExpandRequest(input, coreDefaults());
  const { agent, legacy } = scopeRecords(request.scope);
  const toolSet = resolveMemoryTools({
    scope: legacy,
    originalQuery: 'explicit memory evidence expansion',
    strategy: memoryToolStrategy(agent),
    initialRetrieval: null
  });
  const tool = toolSet.tools.find((item) => item.name === 'memory_expand');
  if (!tool) throw new MemoryServiceError('Memory expansion is disabled', 'MEMORY_EXPAND_DISABLED', 409);
  const result = await tool.execute('memory_service_expand', {
    event_ids: request.eventIds,
    entity_names: request.entityNames,
    graph_hops: request.graphHops,
    reason: 'Memory API explicit evidence expansion'
  }, new AbortController().signal);
  return {
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: request.scope,
    generatedAt: nowIso(),
    ...result.details.structuredContent
  };
}

function existingOperationReceipt(tenantId, idempotencyKey) {
  return db.prepare(`SELECT * FROM memory_operation_receipts
    WHERE tenant_id = ? AND idempotency_key = ?`).get(tenantId, idempotencyKey);
}

function saveOperationReceipt(request, operationType, result, fingerprint = requestFingerprint(request)) {
  const id = uid('mreceipt');
  const timestamp = nowIso();
  db.prepare(`INSERT INTO memory_operation_receipts
    (id, tenant_id, idempotency_key, request_hash, operation_type, scope_key, user_id, agent_id,
     story_id, branch_id, request_json, result_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?)`).run(
    id,
    request.scope.tenantId,
    request.idempotencyKey,
    fingerprint,
    operationType,
    memoryScopeKey(request.scope),
    request.scope.subjectId,
    request.scope.agentId,
    request.scope.spaceId,
    request.scope.branchId,
    json({
      recordType: request.recordType,
      operation: request.operation || request.mode,
      reason: request.reason,
      sourceEvidenceId: request.sourceEvidenceId || '',
      selector: request.recordType === 'event' ? request.recordId || request.payload?.event_key : request.key || request.payload?.key
    }),
    json(result),
    timestamp,
    timestamp
  );
  return db.prepare('SELECT * FROM memory_operation_receipts WHERE id = ?').get(id);
}

export async function mutateMemory(input, { actorType = 'application' } = {}) {
  const request = normalizeMutationRequest(input, coreDefaults());
  const { legacy } = scopeRecords(request.scope);
  if (actorType === 'model' || actorType === 'model_proposal') {
    throw new MemoryServiceError(
      'Model proposals must be validated by the extraction pipeline before commit',
      'MEMORY_MODEL_WRITE_FORBIDDEN',
      403
    );
  }
  const fingerprint = requestFingerprint(request);
  const existing = existingOperationReceipt(request.scope.tenantId, request.idempotencyKey);
  if (existing) {
    assertIdempotentReuse(existing, request, fingerprint);
    return operationReceipt(existing, { duplicate: true });
  }

  let result;
  if (request.recordType === 'structured') {
    const options = {
      operation: request.operation === 'merge' ? 'merge' : 'update',
      sourceType: `api_${safeText(actorType, 40)}`,
      sourceMessageId: request.sourceEvidenceId,
      reason: request.reason
    };
    result = request.operation === 'delta'
      ? applyMemoryDelta(request.payload.key, request.payload.delta, legacy, options)
      : setMemoryValue(request.payload.key, request.payload.value, legacy, options);
  } else {
    result = await storeEvent({
      ...request.payload,
      event_key: request.payload.event_key,
      operation: request.operation,
      metadata: {
        ...(request.payload.metadata || {}),
        committed_by: actorType,
        commit_reason: request.reason
      }
    }, legacy, request.sourceEvidenceId || `api:${request.idempotencyKey}`);
  }
  return operationReceipt(saveOperationReceipt(request, 'mutate', result, fingerprint));
}

function forgetStructured(request, legacy) {
  const schema = getMemorySchema(request.key);
  if (!schema) throw new MemoryServiceError('Structured memory field not found', 'MEMORY_SCHEMA_NOT_FOUND', 404);
  const current = getMemoryValue(request.key, legacy);
  if (!current?.id || Number(current.version || 0) === 0) {
    return { recordType: 'structured', key: request.key, operation: 'noop' };
  }
  const timestamp = nowIso();
  if (request.mode === 'erase') {
    transaction(() => {
      db.prepare('DELETE FROM memory_history WHERE memory_value_id = ?').run(current.id);
      db.prepare('DELETE FROM memory_values WHERE id = ?').run(current.id);
    });
    return { recordType: 'structured', key: request.key, operation: 'erased' };
  }
  transaction(() => {
    db.prepare(`UPDATE memory_history SET transaction_to = ?
      WHERE memory_value_id = ? AND transaction_to = ''`).run(timestamp, current.id);
    db.prepare(`UPDATE memory_values SET status = 'retracted', transaction_to = ?, updated_at = ?
      WHERE id = ?`).run(timestamp, timestamp, current.id);
    db.prepare(`INSERT INTO memory_history
      (id, memory_value_id, schema_id, user_id, old_value_json, new_value_json, operation,
       source_type, source_message_id, reason, version, valid_from, valid_to,
       transaction_from, transaction_to, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'retract', 'api_forget', '', ?, ?, ?, ?, ?, ?, ?)`).run(
      uid('mh'), current.id, current.schema_id, legacy.userId, current.value_json,
      request.reason, Number(current.version || 0) + 1, current.valid_from || timestamp,
      current.valid_to || '', timestamp, timestamp, timestamp
    );
  });
  return { recordType: 'structured', key: request.key, operation: 'retracted' };
}

async function forgetEvent(request, legacy) {
  const event = db.prepare(`SELECT * FROM events WHERE id = ? AND user_id = ? AND agent_id = ?
    AND story_id = ? AND branch_id = ?`).get(
    request.recordId, legacy.userId, legacy.agentId, legacy.storyId, legacy.branchId
  );
  if (!event) throw new MemoryServiceError('Memory event not found', 'MEMORY_EVENT_NOT_FOUND', 404);
  if (request.mode === 'retract') {
    return storeEvent({
      event_key: event.event_key,
      event_type: event.event_type,
      title: event.title,
      summary: event.summary,
      operation: 'retract',
      memory_space: event.memory_space,
      canonicality: event.canonicality,
      source_speaker: event.source_speaker,
      metadata: { forget_reason: request.reason }
    }, legacy, `api:${request.idempotencyKey}`);
  }
  transaction(() => {
    db.prepare("DELETE FROM embeddings WHERE owner_type = 'event' AND owner_id = ?").run(event.id);
    db.prepare('DELETE FROM event_entities WHERE event_id = ?').run(event.id);
    db.prepare('DELETE FROM claims WHERE event_id = ?').run(event.id);
    db.prepare('DELETE FROM entity_edges WHERE event_id = ?').run(event.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  });
  queueGraphProjection(legacy);
  return { recordType: 'event', recordId: event.id, operation: 'erased' };
}

export async function forgetMemory(input) {
  const request = normalizeForgetRequest(input, coreDefaults());
  const { legacy } = scopeRecords(request.scope);
  const fingerprint = requestFingerprint(request);
  const existing = existingOperationReceipt(request.scope.tenantId, request.idempotencyKey);
  if (existing) {
    assertIdempotentReuse(existing, request, fingerprint);
    return operationReceipt(existing, { duplicate: true });
  }
  const result = request.recordType === 'structured'
    ? forgetStructured(request, legacy)
    : await forgetEvent(request, legacy);
  return operationReceipt(saveOperationReceipt(request, 'forget', result, fingerprint));
}

export function getMemoryJob(jobId, scopeInput) {
  const scope = normalizeRecallRequest({ scope: scopeInput, query: 'job lookup' }, coreDefaults()).scope;
  scopeRecords(scope);
  const row = db.prepare(`SELECT mj.* FROM memory_jobs mj
    JOIN memory_observations mo ON mo.id = mj.observation_id
    WHERE mj.id = ? AND mo.scope_key = ?`).get(jobId, memoryScopeKey(scope));
  if (!row) throw new MemoryServiceError('Memory job not found', 'MEMORY_JOB_NOT_FOUND', 404);
  return { contractVersion: MEMORY_CONTRACT_VERSION, ...jobReceipt(row) };
}

export function getMemoryServiceCapabilities() {
  return {
    contractVersion: MEMORY_CONTRACT_VERSION,
    service: 'open-character-memory',
    mode: 'headless_with_legacy_store_adapter',
    operations: ['observe', 'recall', 'expand', 'mutate', 'forget'],
    extractionModes: ['async', 'sync', 'none'],
    features: {
      idempotentEvidence: true,
      persistentExtractionQueue: true,
      synchronousExplicitControls: true,
      activeOnlyRecall: true,
      bitemporalLedger: true,
      graphProjection: true,
      scopeLockedTools: true,
      modelDirectWrites: false
    },
    scope: {
      fields: ['tenantId', 'subjectId', 'agentId', 'spaceId', 'branchId'],
      tenantId: configuredTenantId(),
      serverAuthoritative: true
    }
  };
}

export function isMemoryContractError(error) {
  return error instanceof MemoryContractError || error instanceof MemoryServiceError;
}
