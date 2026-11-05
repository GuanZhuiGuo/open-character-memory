import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-context-http-'));
process.env.DATABASE_PATH = path.join(tempDir, 'context-http.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'sqlite';
process.env.AGENT_RUNTIME = 'pi';
process.env.BASE_PATH = '';
process.env.DEEP_AGENT_WORKER_MODE = 'off';
process.env.SANDBOX_RUNTIME_ENABLED = 'false';
process.env.ARTIFACT_ROOT = path.join(tempDir, 'artifacts');

const { server } = await import('../server.js');
const { db } = await import('../lib/db.js');

async function request(baseUrl, pathname, { body, cookie = '' } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    body: await response.json(),
    cookie: response.headers.getSetCookie().map((item) => item.split(';', 1)[0]).join('; ')
  };
}

test('HTTP chat compacts history, exposes provenance, and keeps diagnostic and deterministic paths summary-free', {
  timeout: 30_000
}, async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const registered = await request(baseUrl, '/api/auth/register', {
      body: { username: 'context_http_user', display_name: 'Context HTTP', password: 'context-http-password' }
    });
    assert.equal(registered.status, 201);
    const userId = registered.body.user.id;
    const cookie = registered.cookie;
    let conversationId = '';
    let latestChat;
    for (let turn = 1; turn <= 14; turn += 1) {
      latestChat = await request(baseUrl, '/api/chat', {
        cookie,
        body: {
          user_id: userId, agent_id: 'agent_linwan', conversation_id: conversationId,
          message: `我们继续轻松聊天，这是第${turn}段闲聊。`
        }
      });
      assert.equal(latestChat.status, 200, JSON.stringify(latestChat.body));
      conversationId = latestChat.body.conversation.id;
    }
    const contextPath = `/api/conversations/${conversationId}/context?user_id=${userId}`;
    const context = await request(baseUrl, contextPath, { cookie });
    assert.equal(context.status, 200);
    assert.equal(context.body.status, 'ready');
    assert.ok(context.body.snapshotCount >= 1);
    assert.ok(context.body.summarizedMessageCount >= 8);
    assert.equal(context.body.sourceMessageCount, 28);
    assert.match(context.body.snapshot.summary, /模拟摘要，仅用于验证流程/);

    const trace = await request(baseUrl, `/api/traces/${latestChat.body.traceId}`, { cookie });
    assert.equal(trace.status, 200);
    const contextSpan = trace.body.spans.find((span) => span.name === 'conversation_context');
    const contextOutput = JSON.parse(contextSpan.output_json);
    assert.equal(contextOutput.snapshot.id, context.body.snapshot.id);
    assert.match(contextOutput.snapshot.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(contextOutput.snapshot.coveredMessageIds.length, context.body.summarizedMessageCount);
    const promptSpan = trace.body.spans.find((span) => span.name === 'prompt_compilation');
    const prompt = JSON.parse(promptSpan.output_json).promptComposition;
    assert.match(prompt.stablePrefix, /辅助摘要只用于话题衔接/);
    assert.match(prompt.dynamicMemory, /<conversation_history_summary>/);
    const modelSpan = trace.body.spans.find((span) => span.name === 'model_response');
    const modelInput = JSON.parse(modelSpan.input_json);
    assert.equal(modelInput.messages.length, 27 - context.body.summarizedMessageCount);
    assert.equal(modelInput.messages.at(-1).content, '我们继续轻松聊天，这是第14段闲聊。');

    const otherUser = await request(baseUrl, '/api/auth/register', {
      body: { username: 'context_http_other', display_name: 'Other User', password: 'context-http-password' }
    });
    const forbidden = await request(baseUrl, contextPath, { cookie: otherUser.cookie });
    assert.equal(forbidden.status, 403);

    const replay = await request(baseUrl, `/api/traces/${latestChat.body.traceId}/replay-no-short-term`, {
      cookie, body: {}
    });
    assert.equal(replay.status, 201);
    const replayTrace = await request(baseUrl, `/api/traces/${replay.body.traceId}`, { cookie });
    assert.equal(replayTrace.body.spans.some((span) => span.name === 'conversation_context'), false);
    const replayPrompt = JSON.parse(replayTrace.body.spans.find((span) => span.name === 'prompt_compilation').output_json);
    assert.doesNotMatch(replayPrompt.promptComposition.dynamicMemory, /<conversation_history_summary>/);
    const replayModel = JSON.parse(replayTrace.body.spans.find((span) => span.name === 'model_response').input_json);
    assert.deepEqual(replayModel.messages, [{ role: 'user', content: '我们继续轻松聊天，这是第14段闲聊。' }]);
    const afterReplay = await request(baseUrl, contextPath, { cookie });
    assert.deepEqual(afterReplay.body, context.body);

    const deterministic = await request(baseUrl, '/api/chat', {
      cookie,
      body: {
        user_id: userId, agent_id: 'agent_linwan', conversation_id: conversationId,
        message: '2026 年 11月总共出差多少次？'
      }
    });
    assert.equal(deterministic.status, 200);
    const deterministicTrace = await request(baseUrl, `/api/traces/${deterministic.body.traceId}`, { cookie });
    assert.equal(deterministicTrace.body.spans.some((span) => span.name === 'conversation_context'), false);
    const deterministicModel = JSON.parse(deterministicTrace.body.spans.find((span) => span.name === 'model_response').input_json);
    assert.equal(deterministicModel.runtime, 'deterministic_grounding_guard');
    assert.equal(deterministicModel.messages.length, 1);
    const deterministicPrompt = JSON.parse(deterministicTrace.body.spans.find((span) => span.name === 'prompt_compilation').output_json);
    assert.doesNotMatch(deterministicPrompt.promptComposition.dynamicMemory, /<conversation_history_summary>/);
    const finalContext = await request(baseUrl, contextPath, { cookie });
    assert.equal(finalContext.body.snapshot.id, context.body.snapshot.id);
    assert.equal(finalContext.body.snapshotCount, context.body.snapshotCount);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
