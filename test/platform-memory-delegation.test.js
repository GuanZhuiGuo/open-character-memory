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

test('education delegation binds isolated roles and enforces owner, scope, route and job boundaries', { timeout:45000, skip:!process.env.PLATFORM_TEST_SDK_PATH }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-delegated-'));
  const sessions = [];
  const control = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    assert.equal(request.headers.authorization, 'Bearer memory-fixture-service');
    if (request.url === '/internal/platform/session') {
      const ticket = request.headers['x-platform-actor'];
      const id = ticket === 'education-owner' ? 'owner' : ticket === 'education-b' ? 'user-b' : ticket === 'education-a' ? 'user-a' : null;
      const cookieOwner = !ticket && request.headers.cookie === 'mia_session=owner';
      if (!id && !cookieOwner) { response.writeHead(401); response.end('{}'); return; }
      const userId = id || 'owner';
      sessions.push({ ticket, userId });
      response.end(JSON.stringify({ user:{ user_id:userId, tenant_id:'tenant', display_name:userId, is_owner:userId === 'owner' },
        ticket:'memory-ticket-' + userId, ...(id ? { delegation:{ scope:'memory_headless', source_service:'education' } } : {}) }));
      return;
    }
    if (request.url === '/internal/platform/runtime') {
      response.end(JSON.stringify({ version:1, capabilities:{
        llm2:{ enabled:true, protocol:'responses', endpoint:'https://ark.cn-beijing.volces.com/api/v3', model:'fixture-text', secret_values:{api_key:'platform-managed'} },
        embedding:{ enabled:true, protocol:'volc_embedding', endpoint:'https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal', model:'fixture-vector', secret_values:{api_key:'platform-managed'} }
      } }));
      return;
    }
    for await (const _ of request) { /* Fixture consumes the request body. */ }
    if (request.url.endsWith('/embedding')) {
      response.end(JSON.stringify({ data:[{embedding:[0.1, 0.2, 0.3]}], usage:{total_tokens:1} }));
    } else response.end(JSON.stringify({ output_text:'{}', usage:{input_tokens:1, output_tokens:1, total_tokens:2} }));
  });
  const controlPort = await listen(control);
  Object.assign(process.env, { PLATFORM_ENABLED:'true', PLATFORM_SERVICE_ID:'memory', PLATFORM_SERVICE_SECRET:'memory-fixture-service',
    PLATFORM_INTERNAL_ORIGIN:`http://127.0.0.1:${controlPort}`, PLATFORM_SDK_PATH:process.env.PLATFORM_TEST_SDK_PATH,
    DATABASE_PATH:path.join(temporary, 'memory.sqlite'), PLATFORM_DELEGATION_DB:path.join(temporary, 'delegations.sqlite'),
    GRAPH_STORE:'sqlite', TEXT_PROVIDER:'mock', EMBEDDING_PROVIDER:'mock', DEEP_AGENT_RUNTIME_ENABLED:'false', BASE_PATH:'', MEMORY_TENANT_ID:'memory-test' });
  let business, db;
  try {
    business = (await import('../server.js')).server;
    db = (await import('../lib/db.js')).db;
    const port = await listen(business);
    const service = await import('../lib/memory-service.js');
    service.stopMemoryJobWorker();
    const base = `http://127.0.0.1:${port}`;
    const scope = { subjectId:subject('user-a'), agentId:'edu-learning', spaceId:'learning-' + 'a'.repeat(24), branchId:'main' };
    const call = async (route, body, actor='education-a', method='POST', extras={}) => {
      const response = await fetch(base + route, { method, headers:{ 'Content-Type':'application/json',
        ...(actor ? {'X-Platform-Actor':actor} : {}), ...extras }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
      return { status:response.status, value:await response.json() };
    };
    const legacyAgent = db.prepare('SELECT * FROM agents WHERE id=?').get('agent_linwan');
    assert.equal((await call('/v1/memory/bind', {scope}, null)).status, 401);
    assert.equal((await call('/v1/memory/bind', {scope:{...scope, subjectId:subject('owner')}}, null, 'POST', {Cookie:'mia_session=owner'})).status, 403);
    assert.equal((await call('/v1/memory/bind', {scope}, 'invalid-ticket')).status, 401);
    let result = await call('/v1/memory/bind', {scope});
    assert.equal(result.status, 200);
    assert.equal(result.value.bound, true);
    assert.equal(result.value.scope.tenantId, 'memory-test');
    assert.equal(result.value.agent.sceneId, 'scene_education');
    assert.equal((await call('/v1/memory/bind', {scope})).status, 200);
    const authoring = {...scope, agentId:'edu-authoring', spaceId:'authoring-' + 'b'.repeat(24)};
    assert.equal((await call('/v1/memory/bind', {scope:authoring})).status, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM agents WHERE id IN ('edu-learning','edu-authoring')").get().n, 2);
    assert.deepEqual(db.prepare('SELECT * FROM agents WHERE id=?').get('agent_linwan'), legacyAgent);
    for (const bad of [
      {...scope, subjectId:subject('user-b')}, {...scope, tenantId:'other-tenant'}, {...scope, agentId:'agent_linwan'},
      {...scope, agentId:'constructor'}, {...scope, spaceId:'main_story'}, {...scope, spaceId:'authoring-' + 'c'.repeat(24)}, {...scope, branchId:'other'}
    ]) assert.equal((await call('/v1/memory/bind', {scope:bad})).status, 403);
    assert.equal((await call('/v1/memory/bind', {scope}, 'education-owner')).status, 403);
    const ownerScope = {...scope, subjectId:subject('owner')};
    assert.equal((await call('/v1/memory/bind', {scope:ownerScope}, 'education-owner')).status, 200);
    for (const [route, method] of [['/api/auth/session','GET'], ['/api/admin/session','GET'], ['/api/bootstrap','GET'],
      ['/v1/memory/capabilities','GET'], ['/v1/memory/expand','POST'], ['/v1/memory/mutate','POST'], ['/v1/memory','DELETE']]) {
      const before = sessions.length;
      assert.equal((await call(route, method === 'GET' ? undefined : {scope}, 'education-owner', method, {Cookie:'mia_session=owner'})).status, 403);
      assert.equal(sessions.length, before);
    }
    const observation = {scope, idempotencyKey:'delegated-evidence-a', threadId:'thread-a', extractionMode:'none', messages:[{role:'assistant',content:'记录测试学习上下文。'}]};
    result = await call('/v1/memory/observe', observation);
    assert.equal(result.status, 200);
    const firstId = result.value.id;
    assert.equal((await call('/v1/memory/observe', observation)).value.id, firstId);
    assert.equal((await call('/v1/memory/recall', {scope, query:'学习上下文'})).status, 200);
    assert.equal((await call('/v1/memory/recall', {scope, query:'学习上下文'}, 'education-b')).status, 403);
    result = await call('/v1/memory/observe', {...observation, idempotencyKey:'delegated-job-a', extractionMode:'async', messages:[{role:'user',content:'请记录这次学习目标。'}]});
    assert.equal(result.status, 202);
    const jobId = result.value.job.id;
    const query = new URLSearchParams({subject_id:scope.subjectId, agent_id:scope.agentId, space_id:scope.spaceId, branch_id:'main'});
    assert.equal((await call('/v1/memory/jobs/' + jobId + '?' + query, undefined, 'education-a', 'GET')).status, 200);
    assert.equal((await call('/v1/memory/jobs/' + jobId + '?' + query, undefined, 'education-owner', 'GET')).status, 403);
    query.set('subject_id', subject('user-b'));
    assert.equal((await call('/v1/memory/jobs/' + jobId + '?' + query, undefined, 'education-b', 'GET')).status, 404);
    const saved = new DatabaseSync(process.env.PLATFORM_DELEGATION_DB, {readOnly:true});
    try {
      const delegation = JSON.parse(saved.prepare('SELECT delegation_json FROM job_delegations WHERE job_key=?').get('memory:' + jobId).delegation_json);
      assert.equal(delegation.auth.user_id, 'user-a');
      assert.equal(delegation.ticket, 'memory-ticket-user-a');
    } finally { saved.close(); }
    db.prepare("UPDATE agents SET fixed_attributes_json='{}' WHERE id='edu-learning'").run();
    assert.equal((await call('/v1/memory/bind', {scope})).status, 409);
    assert.equal((await call('/v1/memory/recall', {scope, query:'学习上下文'})).status, 409);
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_observations WHERE user_id=?').get(scope.subjectId).n, 2);
  } finally {
    if (business?.listening) await close(business);
    db?.close();
    await close(control);
    fs.rmSync(temporary, {recursive:true, force:true});
  }
});
