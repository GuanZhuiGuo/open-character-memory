import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-sandbox-'));
process.env.DATABASE_PATH = path.join(tempDir, 'sandbox.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.AGENT_RUNTIME = 'pi';
process.env.GRAPH_STORE = 'sqlite';
process.env.SANDBOX_RUNTIME_ENABLED = 'true';
process.env.SANDBOX_PROVIDER = 'local';
process.env.SANDBOX_LOCAL_UNSAFE_COMMANDS = 'false';
process.env.SANDBOX_WORKSPACE_ROOT = path.join(tempDir, 'workspaces');
process.env.ARTIFACT_ROOT = path.join(tempDir, 'artifacts');
process.env.SUBAGENT_RUNTIME_ENABLED = 'true';
process.env.SUBAGENT_MAX_CONCURRENCY = '2';
process.env.SUBAGENT_MAX_TASKS_PER_CALL = '3';
process.env.SUBAGENT_MAX_DEPTH = '1';

const { db, initializeDatabase } = await import('../lib/db.js');
const { getArtifactsForUser } = await import('../lib/artifacts.js');
const {
  closeSandboxRuntime, getSandboxRuntimeStatus, resolveSandboxTools
} = await import('../lib/sandbox-runtime.js');
const { listSubagentTasks, resolveSubagentTools } = await import('../lib/subagent-runtime.js');

initializeDatabase();

const scope = {
  userId: 'user_xiaoyu',
  agentId: 'agent_linwan',
  storyId: 'main_story',
  branchId: 'main'
};

test.after(async () => {
  await closeSandboxRuntime();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('sandbox tools are routed by explicit intent and do not leak into ordinary roleplay', async () => {
  const ordinary = await resolveSandboxTools({
    scope, conversationId: 'sandbox_route_ordinary', userText: '今晚的风很舒服，我们继续散步吧。'
  });
  assert.equal(ordinary.tools.length, 0);
  assert.equal(ordinary.diagnostics.routedForThisTurn, false);

  const document = await resolveSandboxTools({
    scope,
    conversationId: 'sandbox_route_document',
    userText: '请生成一份 Markdown 文档并导出文件。',
    toolProfile: 'workspace'
  });
  assert.equal(document.diagnostics.effectiveToolProfile, 'document');
  assert.ok(document.tools.some((tool) => tool.name === 'sandbox_document_create'));
  assert.ok(!document.tools.some((tool) => tool.name === 'sandbox_run_command'));

  const command = await resolveSandboxTools({
    scope,
    conversationId: 'sandbox_route_command',
    userText: '请在 bash 沙箱里运行脚本并检查输出。',
    toolProfile: 'workspace'
  });
  assert.equal(command.diagnostics.effectiveToolProfile, 'workspace');
  assert.ok(command.tools.some((tool) => tool.name === 'sandbox_run_command'));
});

test('sandbox creates a scoped downloadable document and records an audit run', async () => {
  const traceId = 'trace_sandbox_document';
  const toolSet = await resolveSandboxTools({
    scope,
    conversationId: 'sandbox_document_conversation',
    traceId,
    userText: '请生成一份 Markdown 文档并导出文件。',
    toolProfile: 'document'
  });
  const createTool = toolSet.tools.find((tool) => tool.name === 'sandbox_document_create');
  assert.ok(createTool);
  const result = await createTool.execute('sandbox_document_call', {
    path: 'memory-report', format: 'md', title: '记忆报告', content: '# 结论\n\n沙箱文档生成成功。'
  }, new AbortController().signal);
  const artifact = result.details.structuredContent.artifact;
  assert.match(artifact.downloadUrl, /\/api\/artifacts\//);
  assert.equal(getArtifactsForUser([artifact.id], scope.userId).length, 1);
  assert.equal(getArtifactsForUser([artifact.id], 'user_azhi').length, 0);
  assert.equal(
    db.prepare('SELECT status FROM sandbox_runs WHERE trace_id = ?').get(traceId).status,
    'success'
  );
  assert.equal(getSandboxRuntimeStatus().runs.succeeded, 1);
});

test('subagent routing is bounded and child tasks overlap under the concurrency limit', async () => {
  const ordinary = resolveSubagentTools({
    scope, conversationId: 'subagent_ordinary', userText: '你今天过得怎么样？'
  });
  assert.equal(ordinary.tools.length, 0);
  assert.equal(ordinary.diagnostics.routedForThisTurn, false);

  const traceId = 'trace_parallel_subagents';
  const routed = resolveSubagentTools({
    scope,
    conversationId: 'subagent_parallel',
    traceId,
    userText: '请并行处理两个问题：1、分析方案 A；2、核对方案 B。'
  });
  assert.equal(routed.tools.length, 1);
  assert.deepEqual(routed.diagnostics.routingSignals.includes('explicit_parallel'), true);
  const updates = [];
  const result = await routed.tools[0].execute('delegate_call', {
    reason: '两个任务互不依赖',
    tasks: [
      { task_name: '分析方案 A', role: 'analyst', instruction: '给出方案 A 的三点结论。', tool_profile: 'none' },
      { task_name: '核对方案 B', role: 'verifier', instruction: '核对方案 B 的边界与风险。', tool_profile: 'none' }
    ]
  }, new AbortController().signal, (update) => {
    updates.push(JSON.parse(JSON.stringify(update.details || {})));
  });
  assert.equal(result.details.succeeded, 2);
  assert.equal(result.details.failed, 0);
  assert.equal(listSubagentTasks(traceId).length, 2);
  assert.ok(updates.some((update) => (update.tasks || []).filter((item) => item.status === 'running').length === 2));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_task_runs WHERE trace_id = ? AND status = 'success'")
    .get(traceId).count, 2);
});

