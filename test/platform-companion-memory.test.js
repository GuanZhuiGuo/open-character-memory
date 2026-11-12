import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const subject = id => 'platform_' + crypto.createHash('sha256').update('tenant:' + id).digest('hex').slice(0, 32);
const scopeFor = (user, roleId = 'preset_zh_xiaoqing') => {
  const id = 'chat_' + crypto.createHash('sha256').update(['tenant', user, roleId].join('\0')).digest('hex').slice(0, 32);
  return { subjectId: subject(user), agentId: id, spaceId: id, branchId: 'main', roleId };
};

test('Voice and digital share role memory with a read-only library and live-user delegation',
  { timeout: 45000, skip: !process.env.PLATFORM_TEST_SDK_PATH }, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-companion-delegated-'));
    const control = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      assert.equal(request.headers.authorization, 'Bearer memory-fixture-service');
      if (request.url === '/internal/platform/session') {
        const match = /^(voice|companion|education)-(user-a|user-b|owner)$/.exec(request.headers['x-platform-actor'] || '');
        if (!match) { response.writeHead(401); response.end('{}'); return; }
        const [, source, user] = match;
        response.end(JSON.stringify({ user: { user_id: user, tenant_id: 'tenant', display_name: user, is_owner: user === 'owner' },
          ticket: 'saved-memory-ticket-' + source + '-' + user,
          delegation: { source_service: source, scope: source === 'education' ? 'memory_headless' : 'companion_memory' } }));
        return;
      }
      if (request.url === '/internal/platform/runtime') {
        response.end(JSON.stringify({ version: 1, capabilities: {
          llm2: { enabled: true, protocol: 'responses', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'fixture-text' },
          embedding: { enabled: true, protocol: 'volc_embedding', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal', model: 'fixture-vector' }
        } }));
        return;
      }
      for await (const _ of request) { /* consume fixture model request */ }
      response.end(JSON.stringify(request.url.endsWith('/embedding')
        ? { data: [{ embedding: [.1, .2, .3] }], usage: { total_tokens: 1 } }
        : { output_text: '{}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    });
    const controlPort = await listen(control);
    Object.assign(process.env, { PLATFORM_ENABLED: 'true', PLATFORM_SERVICE_ID: 'memory', PLATFORM_SERVICE_SECRET: 'memory-fixture-service',
      PLATFORM_INTERNAL_ORIGIN: `http://127.0.0.1:${controlPort}`, PLATFORM_SDK_PATH: process.env.PLATFORM_TEST_SDK_PATH,
      DATABASE_PATH: path.join(temporary, 'memory.sqlite'), PLATFORM_DELEGATION_DB: path.join(temporary, 'delegations.sqlite'),
      GRAPH_STORE: 'sqlite', TEXT_PROVIDER: 'mock', EMBEDDING_PROVIDER: 'mock', DEEP_AGENT_RUNTIME_ENABLED: 'false', BASE_PATH: '', MEMORY_TENANT_ID: 'memory-test' });
    let business, db;
    try {
      business = (await import('../server.js')).server;
      db = (await import('../lib/db.js')).db;
      const port = await listen(business);
      (await import('../lib/memory-service.js')).stopMemoryJobWorker();
      const memory = await import('../lib/memory.js');
      const base = `http://127.0.0.1:${port}`;
      const call = async (route, body, actor = 'voice-user-a', method = 'POST') => {
        const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Platform-Actor': actor },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() };
      };
      const scope = scopeFor('user-a'), otherRole = scopeFor('user-a', 'preset_zh_xiaomei');
      const legacy = db.prepare('SELECT * FROM agents WHERE id=?').get('agent_linwan');
      let result = await call('/v1/memory/bind', { scope });
      assert.equal(result.status, 200);
      assert.equal(result.value.scope.tenantId, 'memory-test');
      assert.equal(result.value.readOnlyLibrary, true);
      assert.equal((await call('/v1/memory/bind', { scope }, 'companion-user-a')).value.agent.id, scope.agentId);
      assert.equal((await call('/v1/memory/bind', { scope: otherRole })).status, 200);
      assert.deepEqual(db.prepare('SELECT * FROM agents WHERE id=?').get('agent_linwan'), legacy);
      for (const bad of [{ ...scope, subjectId: subject('user-b') }, { ...scope, roleId: 'other-role' },
        { ...scope, agentId: 'agent_linwan' }, { ...scope, tenantId: 'other-tenant' }, { ...scope, branchId: 'other' }]) {
        assert.equal((await call('/v1/memory/bind', { scope: bad })).status, 403);
      }
      assert.equal((await call('/v1/memory/bind', { scope }, 'voice-user-b')).status, 403);
      assert.equal((await call('/v1/memory/bind', { scope: scopeFor('owner') }, 'voice-owner')).status, 200);
      const observation = { scope, idempotencyKey: 'role-a-turn-1', threadId: 'same-role-conversation', extractionMode: 'none',
        messages: [{ role: 'user', content: '我喜欢周末徒步。' }, { role: 'assistant', content: '我们下次可以继续聊徒步路线。' }] };
      result = await call('/v1/memory/observe', observation);
      assert.equal(result.status, 200);
      assert.equal((await call('/v1/memory/observe', observation, 'companion-user-a')).value.id, result.value.id);
      memory.setMemoryValue('identity.preferred_address', '登山者',
        { userId: scope.subjectId, agentId: scope.agentId, storyId: scope.spaceId, branchId: 'main' }, { sourceType: 'fixture' });
      result = await call('/v1/memory/recall', { scope, query: '你还记得我吗？', includePromptText: true }, 'companion-user-a');
      assert.equal(result.status, 200);
      assert.ok(result.value.blocks.some(block => block.content.includes('登山者')));
      result = await call('/v1/memory/library', { scope }, 'companion-user-a');
      assert.equal(result.status, 200);
      assert.equal(result.value.readOnly, true);
      assert.equal(result.value.observations.length, 1);
      assert.equal(result.value.observations[0].messages[0].content, '我喜欢周末徒步。');
      assert.ok(result.value.memories.some(item => item.key === 'identity.preferred_address' && item.value === '登山者'));
      result = await call('/v1/memory/library', { scope: otherRole });
      assert.equal(result.value.observations.length, 0);
      assert.ok(!result.value.memories.some(item => item.value === '登山者'));
      const bobScope = scopeFor('user-b');
      assert.equal((await call('/v1/memory/bind', { scope: bobScope }, 'companion-user-b')).status, 200);
      result = await call('/v1/memory/library', { scope: bobScope }, 'companion-user-b');
      assert.equal(result.value.observations.length, 0);
      assert.equal((await call('/v1/memory/library', { scope }, 'companion-user-b')).status, 403);
      for (const [route, method] of [['/api/bootstrap', 'GET'], ['/api/admin/users', 'GET'], ['/v1/memory/expand', 'POST'],
        ['/v1/memory/mutate', 'POST'], ['/v1/memory', 'DELETE']]) {
        assert.equal((await call(route, method === 'GET' ? undefined : { scope }, 'voice-owner', method)).status, 403);
      }
      assert.equal((await call('/v1/memory/library', { scope }, 'education-user-a')).status, 403);
      const asynchronous = await call('/v1/memory/observe', { ...observation, idempotencyKey: 'role-a-turn-async', extractionMode: 'async' });
      assert.equal(asynchronous.status, 202);
      const query = new URLSearchParams({ subject_id: scope.subjectId, agent_id: scope.agentId,
        space_id: scope.spaceId, branch_id: scope.branchId, role_id: scope.roleId });
      assert.equal((await call('/v1/memory/jobs/' + asynchronous.value.job.id + '?' + query,
        undefined, 'companion-user-a', 'GET')).status, 200);
      assert.equal((await call('/v1/memory/jobs/' + asynchronous.value.job.id + '?' + query,
        undefined, 'voice-user-b', 'GET')).status, 403);
      const saved = new DatabaseSync(process.env.PLATFORM_DELEGATION_DB, { readOnly: true });
      try {
        const delegated = JSON.parse(saved.prepare('SELECT delegation_json FROM job_delegations WHERE job_key=?')
          .get('memory:' + asynchronous.value.job.id).delegation_json);
        assert.equal(delegated.auth.user_id, 'user-a');
        assert.equal(delegated.ticket, 'saved-memory-ticket-voice-user-a');
      } finally { saved.close(); }
      const reopened = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
      try {
        assert.equal(reopened.prepare('SELECT count(*) AS n FROM memory_observations WHERE user_id=? AND agent_id=?')
          .get(scope.subjectId, scope.agentId).n, 2);
      } finally { reopened.close(); }
    } finally {
      if (business?.listening) await close(business);
      db?.close();
      await close(control);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
