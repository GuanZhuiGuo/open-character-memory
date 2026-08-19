import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-character-memory-service-'));
process.env.DATABASE_PATH = path.join(tempDir, 'memory-service.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'sqlite';
process.env.MEMORY_SERVICE_API_KEY = 'memory-service-test-key';
process.env.MEMORY_TENANT_ID = 'test-tenant';

const { db, initializeDatabase } = await import('../lib/db.js');
const {
  forgetMemory, getMemoryJob, getMemoryServiceCapabilities, mutateMemory, observeMemory,
  processMemoryJob, recallMemory
} = await import('../lib/memory-service.js');
const { normalizeMemoryScope, normalizeObservationRequest } = await import('../packages/memory-core/src/index.js');
const { MemoryClient } = await import('../packages/sdk/index.js');
const { createPiMemoryAdapter } = await import('../packages/adapters/pi/index.js');
const { Client: McpClient, InMemoryTransport } = await import('@modelcontextprotocol/client');
const { createMemoryMcpServer } = await import('../packages/mcp-server/index.js');

initializeDatabase();

const scope = {
  tenantId: 'test-tenant',
  subjectId: 'user_xiaoyu',
  agentId: 'agent_linwan',
  spaceId: 'main_story',
  branchId: 'main'
};

let server;

test.after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, 'close');
  }
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('memory core normalizes generic subject scope without exposing product-specific user naming', () => {
  assert.deepEqual(normalizeMemoryScope({
    tenant_id: 'test-tenant', subject_id: 'subject_a', agent_id: 'agent_a', space_id: 'space_a'
  }), {
    tenantId: 'test-tenant', subjectId: 'subject_a', agentId: 'agent_a', spaceId: 'space_a', branchId: 'main'
  });
  const request = normalizeObservationRequest({
    scope,
    idempotencyKey: 'contract-normalization',
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.equal(request.contractVersion, 'memory-runtime/v1');
  assert.equal(request.extractionMode, 'async');
});

test('observe appends immutable evidence once and queues a persistent extraction job', async () => {
  const input = {
    scope,
    idempotencyKey: 'observation-idempotency-1',
    threadId: 'thread-atomic-api',
    extractionMode: 'async',
    messages: [
      { id: 'external-user-message-1', role: 'user', content: '今天去公园散步了。' },
      { id: 'external-assistant-message-1', role: 'assistant', content: '听起来是个很放松的下午。' }
    ]
  };
  const accepted = await observeMemory(input);
  assert.equal(accepted.status, 'queued');
  assert.equal(accepted.evidenceIds.length, 2);
  assert.equal(accepted.job.status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_observations').get().count, 1);

  const duplicate = await observeMemory(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, accepted.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_observations').get().count, 1);
  await assert.rejects(
    observeMemory({
      ...input,
      messages: [{ role: 'user', content: '这不是原来的请求内容。' }]
    }),
    (error) => error.code === 'MEMORY_IDEMPOTENCY_PAYLOAD_CONFLICT' && error.status === 409
  );

  const completed = await processMemoryJob(accepted.job.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(getMemoryJob(accepted.job.id, scope).status, 'succeeded');
});

test('deterministic mutations are idempotent, active-only, and model direct writes are refused', async () => {
  const request = {
    scope,
    idempotencyKey: 'mutation-event-1',
    recordType: 'event',
    operation: 'create',
    reason: '受信应用写入已确认事件',
    payload: {
      event_key: 'daughter_prefers_blue_stars',
      event_type: 'episode',
      title: '女儿喜欢蓝色星星',
      summary: '用户的女儿喜欢蓝色和星星图案的文具。',
      memory_space: 'user_memory',
      entities: [
        { name: '用户的女儿', type: 'person' },
        { name: '蓝色星星文具', type: 'item' }
      ],
      relations: [{
        source: { name: '用户的女儿', type: 'person' },
        predicate: '喜欢',
        target: { name: '蓝色星星文具', type: 'item' }
      }],
      claims: [{
        subject: { name: '用户的女儿', type: 'person' },
        predicate: '喜欢',
        object: '蓝色和星星图案的文具',
        fact_scope: 'world_fact',
        source_speaker: 'user'
      }]
    }
  };
  const mutation = await mutateMemory(request, { actorType: 'service' });
  assert.equal(mutation.status, 'succeeded');
  assert.ok(mutation.result.id);
  const duplicate = await mutateMemory(request, { actorType: 'service' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, mutation.id);
  await assert.rejects(
    mutateMemory({
      ...request,
      payload: { ...request.payload, summary: '不同的事件内容。' }
    }, { actorType: 'service' }),
    (error) => error.code === 'MEMORY_IDEMPOTENCY_PAYLOAD_CONFLICT' && error.status === 409
  );

  const recalled = await recallMemory({ scope, query: '女儿喜欢的蓝色星星文具' });
  assert.equal(recalled.provenance.activeOnly, true);
  assert.equal(recalled.provenance.scopeLocked, true);
  assert.ok(recalled.events.some((item) => item.title === '女儿喜欢蓝色星星'));
  assert.ok(recalled.facts.some((item) => item.object.includes('蓝色')));

  await assert.rejects(
    mutateMemory({ ...request, idempotencyKey: 'model-write-forbidden' }, { actorType: 'model_proposal' }),
    (error) => error.code === 'MEMORY_MODEL_WRITE_FORBIDDEN'
  );

  const forgotten = await forgetMemory({
    scope,
    idempotencyKey: 'forget-event-1',
    recordType: 'event',
    recordId: mutation.result.id,
    mode: 'retract',
    reason: '用户要求忘记'
  });
  assert.equal(forgotten.status, 'succeeded');
  const afterForget = await recallMemory({ scope, query: '女儿喜欢的蓝色星星文具' });
  assert.equal(afterForget.events.some((item) => item.id === mutation.result.id), false);
});

test('structured memory can be written and retracted without deleting its audit history', async () => {
  const written = await mutateMemory({
    scope,
    idempotencyKey: 'mutation-structured-1',
    recordType: 'structured',
    operation: 'set',
    reason: '受信应用写入用户回复要求',
    payload: { key: 'response.verbosity', value: '简短' }
  }, { actorType: 'service' });
  assert.equal(written.status, 'succeeded');

  const forgotten = await forgetMemory({
    scope,
    idempotencyKey: 'forget-structured-1',
    recordType: 'structured',
    key: 'response.verbosity',
    mode: 'retract',
    reason: '用户撤回该要求'
  });
  assert.equal(forgotten.result.operation, 'retracted');
  const current = db.prepare(`SELECT status, transaction_to FROM memory_values
    WHERE user_id = ? AND agent_id = ?
      AND schema_id = (SELECT id FROM memory_schemas WHERE key = 'response.verbosity')`).get(
    scope.subjectId, scope.agentId
  );
  assert.equal(current.status, 'retracted');
  assert.ok(current.transaction_to);
  assert.ok(db.prepare(`SELECT COUNT(*) AS count FROM memory_history
    WHERE memory_value_id = (SELECT id FROM memory_values
      WHERE user_id = ? AND agent_id = ?
        AND schema_id = (SELECT id FROM memory_schemas WHERE key = 'response.verbosity'))`).get(
    scope.subjectId, scope.agentId
  ).count >= 2);
});

test('TypeScript SDK, Pi adapter, and read-only MCP use the versioned HTTP contract end to end', async () => {
  ({ server } = await import('../server.js'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const client = new MemoryClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'memory-service-test-key'
  });
  const capabilities = await client.capabilities();
  assert.equal(capabilities.contractVersion, 'memory-runtime/v1');
  assert.equal(capabilities.features.modelDirectWrites, false);

  const blockedResponse = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`, {
    headers: { Authorization: 'Bearer memory-service-test-key' }
  });
  assert.equal(blockedResponse.status, 403);
  assert.equal((await blockedResponse.json()).code, 'MEMORY_SERVICE_SCOPE_ONLY');
  const blockedPublicResponse = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
    headers: { Authorization: 'Bearer memory-service-test-key' }
  });
  assert.equal(blockedPublicResponse.status, 403);

  const scoped = client.scope(scope);
  const observation = await scoped.observe({
    idempotencyKey: 'sdk-observation-1',
    extractionMode: 'none',
    messages: [{ role: 'user', content: 'SDK evidence' }]
  });
  assert.equal(observation.status, 'completed');
  const pack = await scoped.recall({ query: '默认用什么语言回复？' });
  assert.ok(pack.blocks.some((item) => item.kind === 'pinned_memory'));

  const adapter = createPiMemoryAdapter({ client, scope, exposeReadTools: true });
  const prepared = await adapter.prepareTurn({ query: '你还记得什么？' });
  assert.deepEqual(prepared.tools.map((item) => item.name), ['memory_search', 'memory_expand']);
  assert.match(prepared.systemContext, /response\.language/);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const memoryMcpServer = createMemoryMcpServer({ client, scope });
  const mcpClient = new McpClient({ name: 'memory-contract-test', version: '1.0.0' });
  await Promise.all([memoryMcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
  const listed = await mcpClient.listTools();
  assert.deepEqual(listed.tools.map((item) => item.name), ['memory_search', 'memory_expand']);
  const called = await mcpClient.callTool({
    name: 'memory_search',
    arguments: { query: '默认用什么语言回复？' }
  });
  assert.match(called.content[0].text, /response\.language/);
  await mcpClient.close();
  await memoryMcpServer.close();
});

test('OpenAPI contract documents every atomic runtime operation', () => {
  const contract = fs.readFileSync(path.join(process.cwd(), 'openapi/memory-v1.yaml'), 'utf8');
  for (const pathName of [
    '/v1/memory/observe', '/v1/memory/recall', '/v1/memory/expand',
    '/v1/memory/mutate', '/v1/memory:', '/v1/memory/jobs/{jobId}'
  ]) assert.match(contract, new RegExp(pathName.replace(/[{}]/g, '\\$&')));
  assert.match(contract, /memory-runtime\/v1/);
  assert.match(contract, /Model-generated proposals are not\n\s+accepted as direct writes/);
  assert.deepEqual(getMemoryServiceCapabilities().operations, ['observe', 'recall', 'expand', 'mutate', 'forget']);
});
