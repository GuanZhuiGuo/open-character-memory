export const MEMORY_CONTRACT_VERSION = 'memory-runtime/v1';

export const MEMORY_EVENT_OPERATIONS = Object.freeze([
  'create', 'enrich', 'update', 'supersede', 'retract'
]);

export const MEMORY_MUTATION_RECORD_TYPES = Object.freeze(['structured', 'event']);
export const MEMORY_EXTRACTION_MODES = Object.freeze(['async', 'sync', 'none']);

export class MemoryContractError extends Error {
  constructor(message, code = 'MEMORY_CONTRACT_INVALID', details = null) {
    super(message);
    this.name = 'MemoryContractError';
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

function text(value, field, { required = false, max = 160 } = {}) {
  const output = String(value ?? '').normalize('NFKC').trim();
  if (required && !output) {
    throw new MemoryContractError(`${field} is required`, 'MEMORY_FIELD_REQUIRED', { field });
  }
  if (output.length > max) {
    throw new MemoryContractError(`${field} exceeds ${max} characters`, 'MEMORY_FIELD_TOO_LONG', {
      field, max, actual: output.length
    });
  }
  if (/\p{Cc}/u.test(output)) {
    throw new MemoryContractError(`${field} contains control characters`, 'MEMORY_FIELD_INVALID', { field });
  }
  return output;
}

function enumValue(value, values, field, fallback) {
  const output = String(value || fallback || '').trim();
  if (!values.includes(output)) {
    throw new MemoryContractError(`${field} must be one of: ${values.join(', ')}`, 'MEMORY_ENUM_INVALID', {
      field, allowed: values, actual: output
    });
  }
  return output;
}

export function normalizeMemoryScope(input = {}, defaults = {}) {
  const scope = input && typeof input === 'object' ? input : {};
  return Object.freeze({
    tenantId: text(scope.tenantId ?? scope.tenant_id ?? defaults.tenantId ?? 'default', 'scope.tenantId', {
      required: true, max: 100
    }),
    subjectId: text(
      scope.subjectId ?? scope.subject_id ?? scope.userId ?? scope.user_id,
      'scope.subjectId',
      { required: true, max: 128 }
    ),
    agentId: text(scope.agentId ?? scope.agent_id, 'scope.agentId', { required: true, max: 128 }),
    spaceId: text(
      scope.spaceId ?? scope.space_id ?? scope.storyId ?? scope.story_id ?? defaults.spaceId ?? 'main_story',
      'scope.spaceId',
      { required: true, max: 128 }
    ),
    branchId: text(
      scope.branchId ?? scope.branch_id ?? defaults.branchId ?? 'main',
      'scope.branchId',
      { required: true, max: 128 }
    )
  });
}

export function memoryScopeKey(input) {
  const scope = normalizeMemoryScope(input);
  return [scope.tenantId, scope.subjectId, scope.agentId, scope.spaceId, scope.branchId].join(':');
}

function normalizeMessage(message, index) {
  if (!message || typeof message !== 'object') {
    throw new MemoryContractError(`messages[${index}] must be an object`, 'MEMORY_MESSAGE_INVALID');
  }
  const role = enumValue(message.role, ['user', 'assistant', 'system', 'tool'], `messages[${index}].role`);
  return Object.freeze({
    id: text(message.id || '', `messages[${index}].id`, { max: 160 }),
    role,
    content: text(message.content, `messages[${index}].content`, { required: true, max: 50000 }),
    createdAt: text(message.createdAt ?? message.created_at ?? '', `messages[${index}].createdAt`, { max: 80 }),
    metadata: message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? structuredClone(message.metadata)
      : {}
  });
}

export function normalizeObservationRequest(input = {}, defaults = {}) {
  const messages = Array.isArray(input.messages) ? input.messages.map(normalizeMessage) : [];
  if (!messages.length) {
    throw new MemoryContractError('messages must contain at least one item', 'MEMORY_MESSAGES_REQUIRED');
  }
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: normalizeMemoryScope(input.scope, defaults),
    idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey', {
      required: true, max: 200
    }),
    threadId: text(input.threadId ?? input.thread_id ?? 'default', 'threadId', { required: true, max: 160 }),
    extractionMode: enumValue(
      input.extractionMode ?? input.extraction_mode,
      MEMORY_EXTRACTION_MODES,
      'extractionMode',
      defaults.extractionMode || 'async'
    ),
    messages,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? structuredClone(input.metadata)
      : {}
  });
}

export function normalizeRecallRequest(input = {}, defaults = {}) {
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: normalizeMemoryScope(input.scope, defaults),
    query: text(input.query, 'query', { required: true, max: 12000 }),
    includePinned: options.includePinned !== false,
    includePromptText: options.includePromptText !== false,
    validAt: text(options.validAt ?? options.valid_at ?? '', 'options.validAt', { max: 80 }),
    knownAt: text(options.knownAt ?? options.known_at ?? '', 'options.knownAt', { max: 80 }),
    retrieval: options.retrieval && typeof options.retrieval === 'object'
      ? structuredClone(options.retrieval)
      : {}
  });
}

export function normalizeExpandRequest(input = {}, defaults = {}) {
  const eventIds = Array.isArray(input.eventIds ?? input.event_ids) ? (input.eventIds ?? input.event_ids) : [];
  const entityNames = Array.isArray(input.entityNames ?? input.entity_names)
    ? (input.entityNames ?? input.entity_names)
    : [];
  if (!eventIds.length && !entityNames.length) {
    throw new MemoryContractError('eventIds or entityNames is required', 'MEMORY_EXPAND_TARGET_REQUIRED');
  }
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: normalizeMemoryScope(input.scope, defaults),
    eventIds: eventIds.map((item, index) => text(item, `eventIds[${index}]`, { required: true, max: 160 })).slice(0, 8),
    entityNames: entityNames
      .map((item, index) => text(item, `entityNames[${index}]`, { required: true, max: 160 })).slice(0, 8),
    graphHops: Math.max(0, Math.min(2, Math.round(Number(input.graphHops ?? input.graph_hops ?? 1))))
  });
}

export function normalizeMutationRequest(input = {}, defaults = {}) {
  const recordType = enumValue(
    input.recordType ?? input.record_type,
    MEMORY_MUTATION_RECORD_TYPES,
    'recordType'
  );
  const operation = recordType === 'event'
    ? enumValue(input.operation, MEMORY_EVENT_OPERATIONS, 'operation', 'create')
    : enumValue(input.operation, ['set', 'merge', 'delta'], 'operation', 'set');
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
    ? structuredClone(input.payload)
    : {};
  if (recordType === 'structured') {
    payload.key = text(payload.key, 'payload.key', { required: true, max: 160 });
    if (operation === 'delta' && !Number.isFinite(Number(payload.delta))) {
      throw new MemoryContractError('payload.delta must be numeric', 'MEMORY_DELTA_INVALID');
    }
    if (operation !== 'delta' && !Object.hasOwn(payload, 'value')) {
      throw new MemoryContractError('payload.value is required', 'MEMORY_VALUE_REQUIRED');
    }
  }
  if (recordType === 'event') {
    payload.event_key = text(
      payload.event_key ?? payload.eventKey,
      'payload.event_key',
      { required: true, max: 160 }
    );
  }
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: normalizeMemoryScope(input.scope, defaults),
    idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey', {
      required: true, max: 200
    }),
    recordType,
    operation,
    payload,
    reason: text(input.reason || '', 'reason', { max: 1000 }),
    sourceEvidenceId: text(
      input.sourceEvidenceId ?? input.source_evidence_id ?? '',
      'sourceEvidenceId',
      { max: 160 }
    )
  });
}

export function normalizeForgetRequest(input = {}, defaults = {}) {
  const recordType = enumValue(
    input.recordType ?? input.record_type,
    ['structured', 'event'],
    'recordType'
  );
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    scope: normalizeMemoryScope(input.scope, defaults),
    idempotencyKey: text(input.idempotencyKey ?? input.idempotency_key, 'idempotencyKey', {
      required: true, max: 200
    }),
    recordType,
    recordId: text(input.recordId ?? input.record_id ?? '', 'recordId', {
      required: recordType === 'event', max: 160
    }),
    key: text(input.key ?? '', 'key', { required: recordType === 'structured', max: 160 }),
    mode: enumValue(input.mode, ['retract', 'erase'], 'mode', 'retract'),
    reason: text(input.reason || '', 'reason', { max: 1000 })
  });
}

export function createContextPack({ request, pinned = [], retrieval = {}, promptText = '', diagnostics = {} }) {
  const blocks = [];
  for (const item of pinned) {
    if (!item?.content) continue;
    blocks.push({ kind: item.kind || 'pinned', content: String(item.content), priority: item.priority ?? 100 });
  }
  if (promptText) blocks.push({ kind: 'retrieved_memory', content: String(promptText), priority: 60 });
  return Object.freeze({
    contractVersion: MEMORY_CONTRACT_VERSION,
    query: request.query,
    scope: request.scope,
    generatedAt: new Date().toISOString(),
    blocks,
    facts: retrieval.claims || [],
    events: retrieval.events || [],
    relations: retrieval.edges || [],
    provenance: {
      activeOnly: true,
      scopeLocked: true,
      eventIds: (retrieval.events || []).map((item) => item.id),
      claimIds: (retrieval.claims || []).map((item) => item.id),
      edgeIds: (retrieval.edges || []).map((item) => item.id)
    },
    diagnostics
  });
}

export class MemoryRuntime {
  constructor(ports = {}) {
    for (const operation of ['observe', 'recall', 'expand', 'mutate', 'forget']) {
      if (typeof ports[operation] !== 'function') {
        throw new MemoryContractError(`MemoryRuntime port ${operation} is required`, 'MEMORY_PORT_REQUIRED', {
          operation
        });
      }
    }
    this.ports = Object.freeze({ ...ports });
  }

  observe(input) { return this.ports.observe(normalizeObservationRequest(input)); }
  recall(input) { return this.ports.recall(normalizeRecallRequest(input)); }
  expand(input) { return this.ports.expand(normalizeExpandRequest(input)); }
  mutate(input) { return this.ports.mutate(normalizeMutationRequest(input)); }
  forget(input) { return this.ports.forget(normalizeForgetRequest(input)); }
}
