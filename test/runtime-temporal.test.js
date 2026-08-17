import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-runtime-'));
process.env.DATABASE_PATH = path.join(tempDir, 'runtime.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.AGENT_RUNTIME = 'pi';
process.env.GRAPH_STORE = 'sqlite';
process.env.MCP_ALLOW_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;

const { db, initializeDatabase } = await import('../lib/db.js');
const { extractConversationMemoryNow } = await import('../lib/agent.js');
const { runAgentModel } = await import('../lib/pi-runtime.js');
const { listEvents, listGraph, storeEvent } = await import('../lib/memory.js');
const { resolveMemoryTools } = await import('../lib/memory-tools.js');
const { closeCapabilityRuntime, resolveAgentCapabilities } = await import('../lib/capabilities.js');
const { getActiveProps } = await import('../lib/triggers.js');
const { createZip } = await import('../lib/zip.js');

initializeDatabase();

const scope = {
  userId: 'user_xiaoyu',
  agentId: 'agent_linwan',
  storyId: 'main_story',
  branchId: 'main'
};

test.after(async () => {
  await closeCapabilityRuntime();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Pi runtime executes an exposed tool and feeds toolResult into a second model turn', async () => {
  let executions = 0;
  const result = await runAgentModel({
    systemPrompt: '你是测试角色。',
    messages: [{ role: 'user', content: '请调用 demo_lookup 查一下' }],
    tools: [{
      name: 'demo_lookup',
      label: '测试查找',
      description: '执行测试查找。',
      parameters: {
        type: 'object', properties: { query: { type: 'string' } }, required: ['query']
      },
      execute: async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'FOUND' }], details: { matched: true } };
      }
    }],
    sessionId: 'runtime_tool_loop_test'
  });
  assert.equal(executions, 1);
  assert.equal(result.runtime.toolLoopEnabled, true);
  assert.equal(result.runtime.toolCallCount, 1);
  assert.equal(result.runtime.providerBridge.requestCount, 2);
  assert.ok(result.runtime.lifecycle.some((item) => item.type === 'tool_execution_start'));
  assert.ok(result.runtime.lifecycle.some((item) => item.type === 'tool_execution_end' && !item.isError));
  assert.match(result.text, /执行完成/);
});

test('Pi exposes scope-locked read-only memory tools and reasons again after active recall', async () => {
  const stored = await storeEvent({
    event_key: 'runtime_memory_tool_keepsake', event_type: 'episode', title: '蓝色星星纪念物',
    summary: '小雨把蓝色星星纪念物收在书桌抽屉里。', importance: 0.8,
    entities: [{ name: '蓝色星星纪念物', type: 'item' }, { name: '书桌抽屉', type: 'place' }],
    relations: [{
      source: { name: '蓝色星星纪念物', type: 'item' }, predicate: '收在',
      target: { name: '书桌抽屉', type: 'place' }
    }]
  }, scope, 'message_runtime_memory_tool');
  const strategy = {
    agentMemoryToolsEnabled: true,
    agentMemoryMaxCalls: 2,
    agentMemoryMaxQueries: 3,
    eventTopK: 4,
    claimTopK: 20,
    edgeTopK: 20,
    graphHops: 1
  };
  const directSet = resolveMemoryTools({ scope, originalQuery: '纪念物放在哪里？', strategy });
  assert.deepEqual(directSet.tools.map((tool) => tool.name), ['memory_search', 'memory_expand']);
  assert.equal(directSet.diagnostics.scopeLocked, true);
  const direct = await directSet.tools[0].execute(
    'direct_memory_search',
    { query: '蓝色星星纪念物 书桌抽屉', alternative_queries: [] },
    new AbortController().signal
  );
  assert.equal(direct.details.readOnly, true);
  assert.ok(direct.details.structuredContent.evidence.events.some((item) => item.id === stored.id));

  const runtimeSet = resolveMemoryTools({ scope, originalQuery: '纪念物放在哪里？', strategy });
  const result = await runAgentModel({
    systemPrompt: '你是测试角色，证据不足时调用长期记忆工具。',
    messages: [{ role: 'user', content: '请调用 memory_search 搜索蓝色星星纪念物放在哪里' }],
    tools: runtimeSet.tools,
    sessionId: 'runtime_memory_tool_loop_test'
  });
  assert.equal(result.runtime.toolCallCount, 1);
  assert.equal(result.runtime.providerBridge.requestCount, 2);
  assert.ok(result.runtime.exposedTools.includes('memory_search'));
  assert.ok(result.runtime.lifecycle.some((item) => item.type === 'tool_execution_end'
    && item.toolName === 'memory_search' && !item.isError));
  assert.match(result.text, /执行完成/);
});

test('memory backlog is committed in configured turn batches instead of one growing prompt', async () => {
  const conversationId = 'conversation_extraction_backlog';
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO conversations
    (id, user_id, agent_id, story_id, branch_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '抽取积压测试', ?, ?)`)
    .run(conversationId, scope.userId, scope.agentId, scope.storyId, scope.branchId, timestamp, timestamp);
  const insertMessage = db.prepare(`INSERT INTO messages
    (id, conversation_id, user_id, role, content, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?)`);
  for (let turn = 1; turn <= 5; turn += 1) {
    insertMessage.run(`backlog_user_${turn}`, conversationId, scope.userId, 'user', `用户消息 ${turn}`,
      new Date(Date.now() + turn * 2).toISOString());
    insertMessage.run(`backlog_assistant_${turn}`, conversationId, scope.userId, 'assistant', `角色回复 ${turn}`,
      new Date(Date.now() + turn * 2 + 1).toISOString());
  }
  db.prepare(`INSERT INTO conversation_extraction_states
    (conversation_id, profile_id, last_extracted_message_id, last_extracted_at, created_at, updated_at)
    VALUES (?, 'extraction_companion', '', NULL, ?, ?)`)
    .run(conversationId, timestamp, timestamp);
  db.prepare(`UPDATE event_extraction_profiles SET extraction_interval_turns = 2
    WHERE id = 'extraction_companion'`).run();

  const first = await extractConversationMemoryNow({ conversationId, userId: scope.userId });
  assert.equal(first.result.profile.batchTurnCount, 2);
  assert.equal(first.status.pendingTurns, 3);
  const second = await extractConversationMemoryNow({ conversationId, userId: scope.userId });
  assert.equal(second.result.profile.batchTurnCount, 2);
  assert.equal(second.status.pendingTurns, 1);
  const tail = await extractConversationMemoryNow({ conversationId, userId: scope.userId });
  assert.equal(tail.result.profile.batchTurnCount, 1);
  assert.equal(tail.status.pendingTurns, 0);
  db.prepare(`UPDATE event_extraction_profiles SET extraction_interval_turns = 8
    WHERE id = 'extraction_companion'`).run();
});

test('unlocked Skill ZIP tools are exposed, executed, and recorded', async () => {
  const propId = 'prop_runtime_skill_test';
  const skillPath = path.join(tempDir, 'runtime-skill.zip');
  const manifest = {
    schema_version: 'memory-agent.skill/v1',
    key: 'runtime_skill',
    name: '运行时 Skill',
    version: '1.0.0',
    entry: 'SKILL.md',
    tools: [{
      name: 'compose_note',
      description: '生成测试便签。',
      input_schema: {
        type: 'object', properties: { message: { type: 'string' } }, required: ['message']
      },
      execution: { type: 'template', template: 'NOTE:{{message}}' },
      confirmation: 'none'
    }]
  };
  fs.writeFileSync(skillPath, createZip([
    { name: 'skill.json', content: JSON.stringify(manifest) },
    { name: 'SKILL.md', content: '# Test Skill\n\nUse compose_note.' }
  ]));
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO capability_props
    (id, agent_id, key, name, description, package_type, manifest_json, file_name,
     storage_path, content_hash, version, status, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'skill_zip', ?, ?, ?, ?, '1.0.0', 'enabled', 'medium', ?, ?)`).run(
    propId, scope.agentId, 'runtime_skill', '运行时 Skill', '测试 Skill 运行时',
    JSON.stringify(manifest), 'runtime-skill.zip', skillPath, 'runtime-skill-hash', timestamp, timestamp
  );
  db.prepare(`INSERT INTO user_prop_states
    (id, user_id, prop_id, story_id, branch_id, status, unlocked_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, 'unlocked', ?, '{}')`).run(
    'user_prop_runtime_skill_test', scope.userId, propId, scope.storyId, scope.branchId, timestamp
  );

  const capabilitySet = await resolveAgentCapabilities({
    props: getActiveProps(scope), scope, conversationId: 'runtime_skill_conversation',
    traceId: 'runtime_skill_trace', userText: '请调用 runtime_skill__compose_note'
  });
  const tool = capabilitySet.tools.find((item) => item.name === 'runtime_skill__compose_note');
  assert.ok(tool);
  const result = await runAgentModel({
    systemPrompt: '你是测试角色。',
    messages: [{ role: 'user', content: '请调用 runtime_skill__compose_note' }],
    tools: [tool],
    sessionId: 'runtime_skill_conversation'
  });
  assert.equal(result.runtime.toolCallCount, 1);
  assert.equal(
    db.prepare('SELECT status FROM capability_runs WHERE prop_id = ? ORDER BY started_at DESC LIMIT 1').get(propId).status,
    'success'
  );
});

test('unlocked MCP props perform tools/list and tools/call through the official client', async () => {
  const propId = 'prop_runtime_mcp_test';
  const timestamp = new Date().toISOString();
  const manifest = {
    schema_version: 'memory-agent.mcp/v1',
    server: {
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(import.meta.dirname, '..', 'scripts', 'test-fixtures', 'mcp-stdio-server.js')]
    },
    allowed_tools: ['lookup_memory'],
    approval: 'none'
  };
  db.prepare(`INSERT INTO capability_props
    (id, agent_id, key, name, description, package_type, manifest_json, version,
     status, risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'mcp_json', ?, '1.0.0', 'enabled', 'high', ?, ?)`).run(
    propId, scope.agentId, 'runtime_mcp', '运行时 MCP', '测试 MCP 运行时',
    JSON.stringify(manifest), timestamp, timestamp
  );
  db.prepare(`INSERT INTO user_prop_states
    (id, user_id, prop_id, story_id, branch_id, status, unlocked_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, 'unlocked', ?, '{}')`).run(
    'user_prop_runtime_mcp_test', scope.userId, propId, scope.storyId, scope.branchId, timestamp
  );

  const capabilitySet = await resolveAgentCapabilities({
    props: getActiveProps(scope).filter((item) => item.id === propId),
    scope,
    conversationId: 'runtime_mcp_conversation',
    traceId: 'runtime_mcp_trace',
    userText: '请调用 runtime_mcp__lookup_memory'
  });
  assert.deepEqual(capabilitySet.diagnostics.skipped, []);
  const tool = capabilitySet.tools.find((item) => item.name === 'runtime_mcp__lookup_memory');
  assert.ok(tool);
  const result = await tool.execute('mcp_call_test', { query: '雨夜来信' }, new AbortController().signal);
  assert.match(result.content.map((item) => item.text || '').join('\n'), /MCP_RESULT:雨夜来信/);
  assert.equal(
    db.prepare('SELECT status FROM capability_runs WHERE prop_id = ? ORDER BY started_at DESC LIMIT 1').get(propId).status,
    'success'
  );
});

test('Pi runtime preserves the configured provider result and emits turn lifecycle events', async () => {
  const streamed = [];
  const result = await runAgentModel({
    systemPrompt: '你是测试角色。',
    messages: [{ role: 'user', content: '你好' }],
    sessionId: 'runtime_test_session',
    onStreamEvent: (event) => streamed.push(event)
  });
  assert.match(result.text, /你好/);
  assert.equal(result.runtime.name, 'pi-agent-core');
  assert.equal(result.runtime.version, '0.84.2');
  assert.equal(result.runtime.lifecycle[0].type, 'agent_start');
  assert.equal(result.runtime.lifecycle.at(-1).type, 'agent_end');
  assert.ok(result.runtime.lifecycle.some((item) => item.type === 'turn_end'));
  assert.ok(result.runtime.lifecycle.every((item, index) => item.sequence === index + 1));
  assert.ok(result.runtime.lifecycle.every((item) => Number.isFinite(item.atMs)));
  assert.equal(result.runtime.providerBridge.name, 'memory-agent-provider');
  assert.equal(result.runtime.providerBridge.status, 'success');
  assert.equal(result.runtime.providerBridge.provider, 'mock');
  assert.ok(Number.isFinite(result.runtime.providerBridge.durationMs));
  assert.equal(result.runtime.toolLoopEnabled, false);
  assert.deepEqual(streamed.map((item) => item.type), ['turn_start', 'delta']);
  assert.equal(streamed[0].turn, 1);
  assert.equal(streamed[1].delta, result.text);
});

test('双时态事件可分别回放当时认知与当前历史真值', async () => {
  const eventKey = 'bitemporal-test-meeting';
  await storeEvent({
    event_key: eventKey,
    event_type: 'meeting',
    title: '周末会面',
    summary: '会面地点是上海。',
    valid_from: '2026-01-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '上海',
      valid_from: '2026-01-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '上海', type: 'place' }, valid_from: '2026-01-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_1');
  const first = db.prepare('SELECT * FROM events WHERE event_key = ? AND status = ?').get(eventKey, 'active');
  await new Promise((resolve) => setTimeout(resolve, 12));

  await storeEvent({
    event_key: eventKey,
    operation: 'supersede',
    event_type: 'meeting',
    title: '周末会面',
    summary: '更正：地点一直是杭州。',
    valid_from: '2026-01-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '杭州',
      operation: 'supersede', valid_from: '2026-01-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '杭州', type: 'place' }, operation: 'supersede',
      valid_from: '2026-01-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_2');
  const corrected = db.prepare('SELECT * FROM events WHERE event_key = ? AND status = ?').get(eventKey, 'active');
  const knownBeforeCorrection = new Date(
    (Date.parse(first.transaction_from) + Date.parse(corrected.transaction_from)) / 2
  ).toISOString();
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z', knownAt: knownBeforeCorrection })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['会面地点是上海。']
  );
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['更正：地点一直是杭州。']
  );

  await new Promise((resolve) => setTimeout(resolve, 12));
  await storeEvent({
    event_key: eventKey,
    operation: 'update',
    event_type: 'meeting',
    title: '周末会面',
    summary: '二月起地点改到北京。',
    valid_from: '2026-02-01T00:00:00Z',
    claims: [{
      subject: { name: '周末会面', type: 'event' }, predicate: '地点', object: '北京',
      operation: 'update', valid_from: '2026-02-01T00:00:00Z'
    }],
    relations: [{
      source: { name: '周末会面', type: 'event' }, predicate: '发生于',
      target: { name: '北京', type: 'place' }, operation: 'update',
      valid_from: '2026-02-01T00:00:00Z'
    }]
  }, scope, 'message_temporal_3');

  assert.deepEqual(
    listEvents(scope, { validAt: '2026-01-15T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['更正：地点一直是杭州。']
  );
  assert.deepEqual(
    listEvents(scope, { validAt: '2026-03-01T00:00:00Z' })
      .filter((item) => item.event_key === eventKey).map((item) => item.summary),
    ['二月起地点改到北京。']
  );
  assert.deepEqual(
    listGraph(scope, { validAt: '2026-01-15T00:00:00Z' }).edges
      .filter((item) => item.predicate === '发生于').map((item) => item.target_name),
    ['杭州']
  );
  assert.deepEqual(
    listGraph(scope, { validAt: '2026-03-01T00:00:00Z' }).edges
      .filter((item) => item.predicate === '发生于').map((item) => item.target_name),
    ['北京']
  );
});
