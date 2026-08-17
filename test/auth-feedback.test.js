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
      const requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const systemPrompt = requestBody.input?.[0]?.content?.[0]?.text || '';
      if (systemPrompt.includes('用户长期回复规则分类器')) {
        response.end(JSON.stringify({
          id: 'mock-rule-classifier',
          model: 'mock-text',
          output_text: JSON.stringify({
            decision: 'persist',
            must_add: ['每句话附带动作描写'],
            avoid_add: ['使用反问句'],
            must_remove: [],
            avoid_remove: [],
            rejected: [],
            reason: '用户明确设置长期回复规则'
          })
        }));
        return;
      }
      if (systemPrompt.includes('只输出严格 JSON')) {
        response.end(JSON.stringify({
          id: 'mock-extraction',
          model: 'mock-text',
          output_text: '{"structured_updates":[],"relationship_deltas":[],"events":[]}'
        }));
        return;
      }
      response.end(JSON.stringify({
        id: 'mock-response',
        model: 'mock-text',
        output_text: '这是一次模拟回复。'
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
    assert.match(bootstrap.payload.systemVersion, /^\d+\.\d+\.\d+$/);
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
      '/api/props?agent_id=agent_linwan',
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

    const extractionStatus = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}/memory-extraction`, { cookie: aliceCookie });
    assert.equal(extractionStatus.status, 200);
    assert.equal(extractionStatus.payload.pendingTurns, 1);
    assert.equal(extractionStatus.payload.canExtract, true);
    const manualExtraction = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}/memory-extraction`, {
        method: 'POST', cookie: aliceCookie
      });
    assert.equal(manualExtraction.status, 200);
    assert.equal(manualExtraction.payload.result.reason, 'manual_flush');
    assert.equal(manualExtraction.payload.status.pendingTurns, 0);

    const ownTrace = await request(baseUrl, `/api/traces/${chat.payload.traceId}`, { cookie: aliceCookie });
    assert.equal(ownTrace.status, 200);
    const modelSpan = ownTrace.payload.spans.find((span) => span.name === 'model_response');
    const modelInput = JSON.parse(modelSpan.input_json);
    const promptSpan = ownTrace.payload.spans.find((span) => span.name === 'prompt_compilation');
    const promptOutput = JSON.parse(promptSpan.output_json);
    const assembledPrompt = `${promptOutput.promptComposition.stablePrefix}\n\n${promptOutput.promptComposition.dynamicMemory}`;
    assert.match(assembledPrompt, /## 角色固定属性/);
    assert.match(assembledPrompt, /## 服务器当前时间/);
    assert.match(assembledPrompt, /Asia\/Shanghai/);
    assert.match(assembledPrompt, /\[身份\] 林晚/);
    assert.equal(promptOutput.prompt, undefined);
    assert.equal(promptOutput.sections, undefined);
    assert.equal(promptOutput.sectionReferences.pinnedMemory.sourceSpan, 'pinned_memory_load');
    assert.equal(promptOutput.sectionReferences.retrieval.sourceSpan, 'hybrid_memory_retrieval');
    assert.equal(typeof modelInput.systemPrompt, 'object');
    assert.equal(modelInput.systemPrompt.reference, 'prompt_compilation.output.promptComposition');
    assert.equal(modelInput.systemPrompt.assembledCharacters, assembledPrompt.length);
    const crossUserTrace = await request(baseUrl, `/api/traces/${chat.payload.traceId}`, { cookie: bobCookie });
    assert.equal(crossUserTrace.status, 403);

    const conversationBeforeReplay = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}?user_id=${alice.id}`, { cookie: aliceCookie });
    assert.equal(conversationBeforeReplay.status, 200);
    const extractionBeforeReplay = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}/memory-extraction`, { cookie: aliceCookie });
    assert.equal(extractionBeforeReplay.payload.pendingTurns, 0);
    const replay = await request(baseUrl,
      `/api/traces/${chat.payload.traceId}/replay-no-short-term`, {
        method: 'POST', cookie: aliceCookie
      });
    assert.equal(replay.status, 201);
    assert.notEqual(replay.payload.traceId, chat.payload.traceId);
    assert.equal(replay.payload.sourceTraceId, chat.payload.traceId);
    assert.equal(replay.payload.query, '我今天想去看展览。');
    assert.equal(replay.payload.diagnostics.shortTermHistoryMessages, 0);
    assert.equal(replay.payload.diagnostics.currentQueryMessages, 1);
    assert.equal(replay.payload.diagnostics.businessStateMutated, false);
    assert.equal(replay.payload.diagnostics.toolCallCount, 0);

    const replayTrace = await request(baseUrl, `/api/traces/${replay.payload.traceId}`, { cookie: aliceCookie });
    assert.equal(replayTrace.status, 200);
    const replayRequest = JSON.parse(replayTrace.payload.request_json);
    assert.equal(replayRequest.debugReplay.mode, 'no_short_term_memory');
    assert.equal(replayRequest.debugReplay.sourceTraceId, chat.payload.traceId);
    assert.equal(replayRequest.debugReplay.businessStateReadOnly, true);
    const replaySpanNames = replayTrace.payload.spans.map((span) => span.name);
    assert.ok(replaySpanNames.includes('debug_replay_policy'));
    assert.ok(replaySpanNames.includes('short_term_history_policy'));
    assert.equal(replaySpanNames.includes('control_memory_fast_path'), false);
    assert.equal(replaySpanNames.includes('trigger_evaluation_pre_response'), false);
    assert.equal(replaySpanNames.includes('post_turn_memory_commit'), false);
    assert.equal(replaySpanNames.includes('trigger_evaluation_post_commit'), false);
    const replayRetrievalSpan = replayTrace.payload.spans.find((span) => span.name === 'hybrid_memory_retrieval');
    assert.equal(JSON.parse(replayRetrievalSpan.input_json).retrievalPlannerContextMessages, 0);
    const replayHistorySpan = replayTrace.payload.spans.find((span) => span.name === 'short_term_history_policy');
    const replayHistoryOutput = JSON.parse(replayHistorySpan.output_json);
    assert.equal(replayHistoryOutput.mode, 'forced_no_short_term_memory');
    assert.equal(replayHistoryOutput.recentDialogueMessages, 0);
    const replayModelSpan = replayTrace.payload.spans.find((span) => span.name === 'model_response');
    const replayModelInput = JSON.parse(replayModelSpan.input_json);
    assert.deepEqual(replayModelInput.capabilityTools, []);
    assert.equal(replayModelInput.shortTermHistory.mode, 'forced_no_short_term_memory');
    assert.deepEqual(replayModelInput.messages, [{ role: 'user', content: '我今天想去看展览。' }]);

    const conversationAfterReplay = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}?user_id=${alice.id}`, { cookie: aliceCookie });
    assert.equal(conversationAfterReplay.status, 200);
    assert.equal(conversationAfterReplay.payload.messages.length, conversationBeforeReplay.payload.messages.length);
    const extractionAfterReplay = await request(baseUrl,
      `/api/conversations/${chat.payload.conversation.id}/memory-extraction`, { cookie: aliceCookie });
    assert.equal(extractionAfterReplay.payload.pendingTurns, extractionBeforeReplay.payload.pendingTurns);
    const crossUserReplay = await request(baseUrl,
      `/api/traces/${chat.payload.traceId}/replay-no-short-term`, {
        method: 'POST', cookie: bobCookie
      });
    assert.equal(crossUserReplay.status, 403);
    const traceListAfterReplay = await request(baseUrl,
      `/api/traces?conversation_id=${chat.payload.conversation.id}`, { cookie: aliceCookie });
    assert.equal(traceListAfterReplay.status, 200);
    assert.ok(traceListAfterReplay.payload.some((traceItem) => traceItem.id === replay.payload.traceId));

    const ruleChat = await request(baseUrl, '/api/chat', {
      method: 'POST',
      cookie: aliceCookie,
      body: {
        user_id: alice.id,
        agent_id: 'agent_linwan',
        conversation_id: chat.payload.conversation.id,
        message: '以后每句话必须附带动作描写，不要使用反问句。'
      }
    });
    assert.equal(ruleChat.status, 200);
    assert.equal(ruleChat.payload.diagnostics.fastUpdates, 2);
    const ruleTrace = await request(baseUrl, `/api/traces/${ruleChat.payload.traceId}`, { cookie: aliceCookie });
    assert.equal(ruleTrace.status, 200);
    const classifierSpan = ruleTrace.payload.spans.find((span) => span.name === 'persistent_instruction_classifier');
    assert.ok(classifierSpan);
    const rulePromptSpan = ruleTrace.payload.spans.find((span) => span.name === 'prompt_compilation');
    const rulePromptOutput = JSON.parse(rulePromptSpan.output_json);
    const ruleAssembledPrompt = `${rulePromptOutput.promptComposition.stablePrefix}\n\n${rulePromptOutput.promptComposition.dynamicMemory}`;
    assert.match(ruleAssembledPrompt, /每句话附带动作描写/);
    assert.match(ruleAssembledPrompt, /使用反问句/);

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
    const customScene = await request(baseUrl, '/api/scenes', {
      method: 'POST', cookie: adminLogin.cookie,
      body: { name: '雨后书店', description: '用于验证场景与记忆设置一对一创建。' }
    });
    assert.equal(customScene.status, 201);
    assert.ok(customScene.payload.memory_profile_id);
    assert.ok(customScene.payload.retrieval_profile_id);
    assert.ok(customScene.payload.event_extraction_profile_id);

    const customAgent = await request(baseUrl, '/api/agents', {
      method: 'POST', cookie: adminLogin.cookie,
      body: {
        scene_id: customScene.payload.id,
        name: '沈砂',
        description: '书店中的陪伴角色。',
        system_prompt: '你是沈砂，以克制、自然的中文交流。',
        greeting: '雨停了，进来坐坐吧。'
      }
    });
    assert.equal(customAgent.status, 201);
    assert.equal(customAgent.payload.scene_id, customScene.payload.id);

    const mcpProp = await request(baseUrl, '/api/props', {
      method: 'POST', cookie: adminLogin.cookie,
      body: {
        agent_id: customAgent.payload.id,
        package_type: 'mcp_json',
        key: 'book_search',
        name: '书目查找',
        description: '用于查找公开书目信息。',
        manifest: {
          server: {
            transport: 'streamable_http',
            url: 'https://mcp.example.com/mcp',
            authorization: { type: 'oauth2', secret_ref: '${secret:TEST_BOOK_MCP}' }
          },
          allowed_tools: ['search_books']
        }
      }
    });
    assert.equal(mcpProp.status, 201);
    assert.equal(mcpProp.payload.status, 'draft');
    assert.equal(mcpProp.payload.risk_level, 'high');
    const enabledProp = await request(baseUrl, `/api/props/${mcpProp.payload.id}`, {
      method: 'PUT', cookie: adminLogin.cookie, body: { status: 'enabled' }
    });
    assert.equal(enabledProp.status, 200);
    assert.equal(enabledProp.payload.status, 'enabled');

    const storyNode = await request(baseUrl, '/api/plots', {
      method: 'POST', cookie: adminLogin.cookie,
      body: {
        agent_id: 'agent_linwan',
        parent_plot_id: 'plot_rain_letter',
        branch_label: '回信分支',
        node_type: 'branch',
        name: '写下回信',
        premise: '用户决定回应那封信。',
        instructions: '给用户保留是否寄出回信的选择。',
        priority: 55,
        enabled: true
      }
    });
    assert.equal(storyNode.status, 201);
    assert.equal(storyNode.payload.parent_plot_id, 'plot_rain_letter');
    assert.equal(storyNode.payload.node_type, 'branch');
    const cyclicStory = await request(baseUrl, '/api/plots/plot_rain_letter', {
      method: 'PUT', cookie: adminLogin.cookie,
      body: { parent_plot_id: storyNode.payload.id }
    });
    assert.equal(cyclicStory.status, 400);
    assert.match(cyclicStory.payload.error, /循环分支/);
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
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    await close(mockArk);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(serverErrors, '');
});
