import {
  MEMORY_CONTRACT_VERSION, normalizeExpandRequest, normalizeForgetRequest,
  normalizeMemoryScope, normalizeMutationRequest, normalizeObservationRequest,
  normalizeRecallRequest
} from '@open-character-memory/core';

export class MemoryClientError extends Error {
  constructor(message, { status = 0, code = 'MEMORY_CLIENT_ERROR', details = null } = {}) {
    super(message);
    this.name = 'MemoryClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function trimBaseUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!url) throw new MemoryClientError('baseUrl is required', { code: 'MEMORY_BASE_URL_REQUIRED' });
  return url;
}

function queryScope(scope) {
  const query = new URLSearchParams({
    tenant_id: scope.tenantId,
    subject_id: scope.subjectId,
    agent_id: scope.agentId,
    space_id: scope.spaceId,
    branch_id: scope.branchId
  });
  return query.toString();
}

function contextText(pack) {
  return (pack.blocks || []).map((block) => block.content).filter(Boolean).join('\n\n');
}

function mergePacks(packs) {
  const first = packs[0];
  const dedupe = (items, key = 'id') => [...new Map(items.map((item) => [item[key], item])).values()];
  return {
    ...first,
    blocks: dedupe(packs.flatMap((pack) => pack.blocks || []), 'content'),
    facts: dedupe(packs.flatMap((pack) => pack.facts || [])),
    events: dedupe(packs.flatMap((pack) => pack.events || [])),
    relations: dedupe(packs.flatMap((pack) => pack.relations || [])),
    provenance: {
      activeOnly: true,
      scopeLocked: true,
      eventIds: dedupe(packs.flatMap((pack) => pack.events || [])).map((item) => item.id),
      claimIds: dedupe(packs.flatMap((pack) => pack.facts || [])).map((item) => item.id),
      edgeIds: dedupe(packs.flatMap((pack) => pack.relations || [])).map((item) => item.id)
    },
    diagnostics: {
      mode: 'sdk_multi_query_merge',
      queryCount: packs.length,
      children: packs.map((pack) => pack.diagnostics)
    }
  };
}

export class MemoryClient {
  constructor({ baseUrl, apiKey = '', fetch: fetchImpl = globalThis.fetch, timeoutMs = 30000, headers = {} }) {
    if (typeof fetchImpl !== 'function') {
      throw new MemoryClientError('A Fetch API implementation is required', { code: 'MEMORY_FETCH_REQUIRED' });
    }
    this.baseUrl = trimBaseUrl(baseUrl);
    this.apiKey = String(apiKey || '');
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1000, Number(timeoutMs || 30000));
    this.headers = { ...headers };
  }

  async request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Memory request timed out')), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new MemoryClientError(payload.error || `Memory request failed with ${response.status}`, {
          status: response.status,
          code: payload.code || 'MEMORY_REQUEST_FAILED',
          details: payload.details || null
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof MemoryClientError) throw error;
      throw new MemoryClientError(error.message || 'Memory request failed', {
        code: error.name === 'AbortError' ? 'MEMORY_REQUEST_TIMEOUT' : 'MEMORY_NETWORK_ERROR'
      });
    } finally {
      clearTimeout(timer);
    }
  }

  capabilities() { return this.request('/v1/memory/capabilities'); }
  observe(input) { return this.request('/v1/memory/observe', { method: 'POST', body: normalizeObservationRequest(input) }); }
  recall(input) { return this.request('/v1/memory/recall', { method: 'POST', body: normalizeRecallRequest(input) }); }
  expand(input) { return this.request('/v1/memory/expand', { method: 'POST', body: normalizeExpandRequest(input) }); }
  mutate(input) { return this.request('/v1/memory/mutate', { method: 'POST', body: normalizeMutationRequest(input) }); }
  forget(input) { return this.request('/v1/memory', { method: 'DELETE', body: normalizeForgetRequest(input) }); }
  getJob(jobId, scope) {
    const normalized = normalizeMemoryScope(scope);
    return this.request(`/v1/memory/jobs/${encodeURIComponent(jobId)}?${queryScope(normalized)}`);
  }

  async waitForJob(jobId, scope, { intervalMs = 500, timeoutMs = 60000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const job = await this.getJob(jobId, scope);
      if (['succeeded', 'dead'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new MemoryClientError('Memory job did not finish before timeout', { code: 'MEMORY_JOB_TIMEOUT' });
  }

  scope(scope) { return new ScopedMemoryClient(this, normalizeMemoryScope(scope)); }
}

export class ScopedMemoryClient {
  constructor(client, scope) {
    this.client = client;
    this.scope = scope;
  }

  observe(input) { return this.client.observe({ ...input, scope: this.scope }); }
  recall(input) { return this.client.recall({ ...input, scope: this.scope }); }
  expand(input) { return this.client.expand({ ...input, scope: this.scope }); }
  mutate(input) { return this.client.mutate({ ...input, scope: this.scope }); }
  forget(input) { return this.client.forget({ ...input, scope: this.scope }); }
  getJob(jobId) { return this.client.getJob(jobId, this.scope); }
  waitForJob(jobId, options) { return this.client.waitForJob(jobId, this.scope, options); }

  readTools({ maxQueries = 3 } = {}) {
    const scoped = this;
    return [{
      name: 'memory_search',
      label: 'Search long-term memory',
      description: 'Search current active long-term memory when the supplied context is insufficient. Scope is locked by the application.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          alternative_queries: { type: 'array', items: { type: 'string' }, maxItems: Math.max(1, maxQueries - 1) },
          reason: { type: 'string' }
        },
        required: ['query'],
        additionalProperties: false
      },
      executionMode: 'sequential',
      _systemTool: { sourceType: 'system_memory', readOnly: true, scopeLocked: true },
      execute: async (_toolCallId, input = {}) => {
        const queries = [input.query, ...(input.alternative_queries || [])]
          .map((item) => String(item || '').trim()).filter(Boolean).slice(0, maxQueries);
        const packs = [];
        for (const query of queries) packs.push(await scoped.recall({ query }));
        const pack = mergePacks(packs);
        return {
          content: [{ type: 'text', text: `[Read-only active memory]\n${contextText(pack)}` }],
          details: { readOnly: true, scopeLocked: true, structuredContent: pack }
        };
      }
    }, {
      name: 'memory_expand',
      label: 'Expand memory evidence',
      description: 'Expand known event IDs or entity names into current claims and graph evidence. Scope is locked by the application.',
      parameters: {
        type: 'object',
        properties: {
          event_ids: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          entity_names: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          graph_hops: { type: 'integer', minimum: 0, maximum: 2 },
          reason: { type: 'string' }
        },
        additionalProperties: false
      },
      executionMode: 'sequential',
      _systemTool: { sourceType: 'system_memory', readOnly: true, scopeLocked: true },
      execute: async (_toolCallId, input = {}) => {
        const result = await scoped.expand({
          eventIds: input.event_ids || [],
          entityNames: input.entity_names || [],
          graphHops: input.graph_hops ?? 1
        });
        return {
          content: [{ type: 'text', text: `[Read-only active memory evidence]\n${JSON.stringify(result.evidence, null, 2)}` }],
          details: { readOnly: true, scopeLocked: true, structuredContent: result }
        };
      }
    }];
  }
}

export { MEMORY_CONTRACT_VERSION, contextText };
