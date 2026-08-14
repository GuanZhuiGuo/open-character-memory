import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function responseCookies(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function request(baseUrl, pathname, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    cookie: responseCookies(response),
    payload: await response.json()
  };
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('server health check timed out');
}

test('registered users get read-only configuration, isolated data, own traces, and captured feedback', { timeout: 30_000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-auth-'));
  const mockArk = http.createServer((request_, response) => {
    const chunks = [];
    request_.on('data', (chunk) => chunks.push(chunk));
    request_.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request_.url.endsWith('/embeddings/multimodal')) {
        response.end(JSON.stringify({ model: 'mock-embedding', data: [{ embedding: [0.5, 0.5, 0.5, 0.5] }] }));
        return;
      }
      response.end(JSON.stringify({
        id: 'mock-response',
        model: 'mock-text',
        output_text: '{"structured_updates":[],"relationship_deltas":[],"events":[]}'
      }));
    });
  });
  const arkPort = await listen(mockArk);
  const probe = http.createServer();
  const appPort = await listen(probe);
  await close(probe);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      DATABASE_PATH: path.join(tempDir, 'test.db'),
      ADMIN_PASSWORD: 'test-admin',
      ARK_API_KEY: 'test-key',
      ARK_BASE_URL: `http://127.0.0.1:${arkPort}/api/v3`,
      BASE_PATH: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverErrors = '';
  child.stderr.on('data', (chunk) => { serverErrors += chunk; });
  const baseUrl = `http://127.0.0.1:${appPort}`;

  try {
    await waitForHealth(baseUrl, child);
    const aliceRegistration = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'alice_test', display_name: 'Alice', password: 'password123' }
    });
    assert.equal(aliceRegistration.status, 201);
    const alice = aliceRegistration.payload.user;
    const aliceCookie = aliceRegistration.cookie;

    const bobRegistration = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { username: 'bob_test', display_name: 'Bob', password: 'password123' }
    });
    assert.equal(bobRegistration.status, 201);
    const bob = bobRegistration.payload.user;
    const bobCookie = bobRegistration.cookie;

    const bootstrap = await request(baseUrl, '/api/bootstrap', { cookie: aliceCookie });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.payload.role, 'user');
    assert.deepEqual(bootstrap.payload.users.map((item) => item.id), [alice.id]);
    assert.ok(bootstrap.payload.agents[0].system_prompt);

    const readableConfigPaths = [
      '/api/agents',
      '/api/scenes',
      '/api/memory/schemas',
      '/api/scenes/scene_companion/retrieval-profile',
      '/api/scenes/scene_companion/event-extraction-profile',
      '/api/scenes/scene_companion/extraction-contract',
      '/api/plots',
      '/api/triggers',
      '/api/tools',
      '/api/architecture/overview?scene_id=scene_companion'
    ];
    for (const configPath of readableConfigPaths) {
      const configRead = await request(baseUrl, configPath, { cookie: aliceCookie });
      assert.equal(configRead.status, 200, `${configPath} should be readable`);
    }
    const configWrite = await request(baseUrl, '/api/agents/agent_linwan', {
      method: 'PUT', cookie: aliceCookie, body: { name: 'Unauthorized edit' }
    });
    assert.equal(configWrite.status, 403);

    const crossUserMemory = await request(baseUrl,
      `/api/memory/values?user_id=${bob.id}&agent_id=agent_linwan&story_id=main_story&branch_id=main`,
      { cookie: aliceCookie });
    assert.equal(crossUserMemory.status, 403);

    const chat = await request(baseUrl, '/api/chat', {
      method: 'POST',
      cookie: aliceCookie,
      body: { user_id: alice.id, agent_id: 'agent_linwan', message: '我今天想去看展览。' }
    });
    assert.equal(chat.status, 200);
    assert.ok(chat.payload.traceId);
    assert.ok(chat.payload.message.id);

    const ownTrace = await request(baseUrl, `/api/traces/${chat.payload.traceId}`, { cookie: aliceCookie });
    assert.equal(ownTrace.status, 200);
    const modelSpan = ownTrace.payload.spans.find((span) => span.name === 'model_response');
    const modelInput = JSON.parse(modelSpan.input_json);
    assert.match(modelInput.systemPrompt, /## 角色固定属性/);
    assert.match(modelInput.systemPrompt, /\[身份\] 林晚/);
    const crossUserTrace = await request(baseUrl, `/api/traces/${chat.payload.traceId}`, { cookie: bobCookie });
    assert.equal(crossUserTrace.status, 403);

    const feedback = await request(baseUrl, '/api/feedback', {
      method: 'POST',
      cookie: aliceCookie,
      body: { message_id: chat.payload.message.id, suggestion: '回复太像结构化数据，应该更自然。' }
    });
    assert.equal(feedback.status, 201);
    assert.equal(feedback.payload.traceId, chat.payload.traceId);
    assert.equal(feedback.payload.capturedMessages, 2);

    const forgedFeedback = await request(baseUrl, '/api/feedback', {
      method: 'POST', cookie: bobCookie,
      body: { message_id: chat.payload.message.id, suggestion: '尝试跨用户反馈' }
    });
    assert.equal(forgedFeedback.status, 403);

    const adminLogin = await request(baseUrl, '/api/admin/login', {
      method: 'POST', body: { password: 'test-admin' }
    });
    assert.equal(adminLogin.status, 200);
    const profileWarning = await request(baseUrl, '/api/agents/agent_linwan', {
      method: 'PUT', cookie: adminLogin.cookie,
      body: { system_prompt: `${bootstrap.payload.agents[0].system_prompt}\n新增核心设定` }
    });
    assert.equal(profileWarning.status, 409);
    assert.equal(profileWarning.payload.code, 'ROLE_PROFILE_CHANGE_CONFIRMATION_REQUIRED');
    assert.ok(profileWarning.payload.details.conversations >= 1);
    const confirmedProfile = await request(baseUrl, '/api/agents/agent_linwan', {
      method: 'PUT', cookie: adminLogin.cookie,
      body: {
        system_prompt: `${bootstrap.payload.agents[0].system_prompt}\n新增核心设定`,
        confirm_profile_change: true
      }
    });
    assert.equal(confirmedProfile.status, 200);
    assert.equal(confirmedProfile.payload.profile_version, 2);
    const adminUsers = await request(baseUrl, '/api/admin/users', { cookie: adminLogin.cookie });
    assert.equal(adminUsers.status, 200);
    assert.ok(adminUsers.payload.some((item) => item.id === alice.id && item.username === 'alice_test'));
    assert.ok(adminUsers.payload.some((item) => item.id === bob.id && item.username === 'bob_test'));
    assert.equal('password_hash' in adminUsers.payload.find((item) => item.id === alice.id), false);

    const adminFeedback = await request(baseUrl, '/api/admin/feedback', { cookie: adminLogin.cookie });
    assert.equal(adminFeedback.status, 200);
    assert.equal(adminFeedback.payload.length, 1);
    assert.equal(adminFeedback.payload[0].trace_id, chat.payload.traceId);
    assert.equal(adminFeedback.payload[0].turn.messages.length, 2);

    const userAdminList = await request(baseUrl, '/api/admin/users', { cookie: aliceCookie });
    assert.equal(userAdminList.status, 403);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await close(mockArk);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(serverErrors, '');
});
