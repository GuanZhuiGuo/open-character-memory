import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-deep-'));
process.env.DATABASE_PATH = path.join(tempDir, 'deep-agent.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.AGENT_RUNTIME = 'pi';
process.env.GRAPH_STORE = 'sqlite';
process.env.SANDBOX_RUNTIME_ENABLED = 'false';
process.env.DEEP_AGENT_RUNTIME_ENABLED = 'true';
process.env.DEEP_AGENT_WORKER_MODE = 'off';
process.env.DEEP_AGENT_AUTO_REPLAN = 'false';
process.env.DEEP_AGENT_NODE_MAX_ATTEMPTS = '1';

const { db, initializeDatabase } = await import('../lib/db.js');
const {
  createDeepAgentRun,
  decideDeepAgentApproval,
  deepAgentRuntimeInternals,
  getDeepAgentRun,
  processDeepAgentOnce,
  resolveDeepAgentTools
} = await import('../lib/deep-agent-runtime.js');

initializeDatabase();

const scope = {
  userId: 'user_xiaoyu',
  agentId: 'agent_linwan',
  storyId: 'main_story',
  branchId: 'main'
};

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('deep-agent tool is exposed only for durable multi-stage work', () => {
  const ordinary = resolveDeepAgentTools({
    scope, conversationId: 'deep_route_ordinary', userText: '今晚继续散步吧。'
  });
  assert.equal(ordinary.tools.length, 0);

  const durable = resolveDeepAgentTools({
    scope,
    conversationId: 'deep_route_durable',
    userText: '这是一个长任务：先调研，再实现，最后测试并发布。'
  });
  assert.equal(durable.tools[0].name, 'start_durable_workflow');
  assert.equal(durable.diagnostics.mode, 'durable_plan_execute');
});

test('persistent DAG releases dependent nodes and creates checkpoints', async () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_dag_conversation',
    objective: '先收集证据，再形成结论',
    nodes: [
      { node_key: 'collect', title: '收集证据', instruction: '收集证据', tool_profile: 'none' },
      { node_key: 'write', title: '形成结论', instruction: '根据证据形成结论', depends_on: ['collect'], tool_profile: 'none' }
    ]
  });
  const executed = [];
  const executor = async (node) => {
    executed.push(node.node_key);
    return { text: `${node.node_key}-done`, details: { test: true } };
  };
  assert.equal((await processDeepAgentOnce({ ownerId: 'test-worker', executor })).claimed, true);
  assert.deepEqual(executed, ['collect']);
  assert.equal(getDeepAgentRun(run.id).nodes.find((node) => node.nodeKey === 'write').status, 'queued');

  assert.equal((await processDeepAgentOnce({ ownerId: 'test-worker', executor })).claimed, true);
  assert.deepEqual(executed, ['collect', 'write']);
  const completed = getDeepAgentRun(run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.storyId, scope.storyId);
  assert.equal(completed.branchId, scope.branchId);
  assert.ok(completed.checkpoints.some((item) => item.checkpointType === 'node_succeeded'));
  assert.ok(completed.checkpoints.some((item) => item.checkpointType === 'run_succeeded'));
});

test('approval blocks execution until the scoped user approves it', async () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_approval_conversation',
    objective: '生成一个需要人工确认的产物',
    nodes: [{
      node_key: 'publish', title: '发布', instruction: '发布产物', tool_profile: 'none',
      approval_mode: 'always', effect_mode: 'idempotent_write'
    }]
  });
  const first = await processDeepAgentOnce({
    ownerId: 'approval-worker', executor: async () => ({ text: 'should-not-run' })
  });
  assert.equal(first.claimed, false);
  const waiting = getDeepAgentRun(run.id);
  assert.equal(waiting.status, 'waiting_approval');
  assert.equal(waiting.approvals[0].status, 'pending');

  decideDeepAgentApproval({
    approvalId: waiting.approvals[0].id,
    decision: 'approved',
    decidedBy: scope.userId
  });
  await processDeepAgentOnce({
    ownerId: 'approval-worker', executor: async () => ({ text: 'published', details: { receipt: true } })
  });
  const completed = getDeepAgentRun(run.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.nodes[0].resultText, 'published');
  const receipt = db.prepare(`SELECT idempotency_key FROM deep_agent_effect_receipts
    WHERE node_id = ?`).get(completed.nodes[0].id);
  assert.equal(receipt.idempotency_key, `${completed.id}:${completed.nodes[0].id}`);
});

test('a worker cannot commit a late result after losing its node lease', async () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_lost_lease',
    objective: '验证租约所有权',
    nodes: [{ node_key: 'slow', title: '慢任务', instruction: '模拟慢任务', tool_profile: 'none' }]
  });
  await processDeepAgentOnce({
    ownerId: 'worker-original',
    executor: async (node) => {
      db.prepare(`UPDATE deep_agent_nodes SET lease_owner = 'worker-takeover' WHERE id = ?`).run(node.id);
      return { text: '迟到结果不应落库' };
    }
  });
  const current = getDeepAgentRun(run.id);
  assert.equal(current.nodes[0].status, 'running');
  assert.equal(current.nodes[0].resultText, '');
  assert.ok(current.events.some((item) => item.eventType === 'node_result_discarded_after_lease_loss'));
  db.prepare(`UPDATE deep_agent_nodes SET status = 'cancelled', lease_owner = '', lease_expires_at = ''
    WHERE run_id = ?`).run(run.id);
  db.prepare(`UPDATE deep_agent_runs SET status = 'cancelled', cancel_requested = 1 WHERE id = ?`).run(run.id);
});

test('an expired synthesis lease is recovered from persisted node results', async () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_synthesis_recovery',
    objective: '恢复最终汇总',
    nodes: [{ node_key: 'done', title: '已完成', instruction: '输出证据', tool_profile: 'none' }]
  });
  db.prepare(`UPDATE deep_agent_nodes SET status = 'succeeded', result_text = '持久节点证据',
    ended_at = ?, updated_at = ? WHERE run_id = ?`).run(
    new Date().toISOString(), new Date().toISOString(), run.id
  );
  db.prepare(`UPDATE deep_agent_runs SET status = 'synthesizing', operation_kind = 'synthesis',
    operation_owner = 'dead-worker', operation_expires_at = '2000-01-01T00:00:00.000Z'
    WHERE id = ?`).run(run.id);
  await processDeepAgentOnce({ ownerId: 'recovery-worker' });
  const recovered = getDeepAgentRun(run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.ok(recovered.events.some((item) => item.eventType === 'synthesis_lease_recovered'));
});

test('an expired replan lease is reclaimed and the validated patch resumes the run', async () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_replan_recovery',
    objective: '恢复重规划',
    nodes: [{ node_key: 'failed', title: '失败节点', instruction: '模拟失败', tool_profile: 'none' }]
  });
  db.prepare(`UPDATE deep_agent_nodes SET status = 'failed', error = '原 Worker 中断',
    ended_at = ?, updated_at = ? WHERE run_id = ?`).run(
    new Date().toISOString(), new Date().toISOString(), run.id
  );
  db.prepare(`UPDATE deep_agent_runs SET status = 'replanning', operation_kind = 'replan',
    operation_owner = 'dead-worker', operation_expires_at = '2000-01-01T00:00:00.000Z'
    WHERE id = ?`).run(run.id);
  await processDeepAgentOnce({
    ownerId: 'replan-recovery-worker',
    replanProvider: async () => ({ decision: 'skip', reason: '允许降级继续' })
  });
  const recovered = getDeepAgentRun(run.id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.planVersion, 2);
  assert.equal(recovered.replanCount, 1);
  assert.ok(recovered.events.some((item) => item.eventType === 'replan_lease_recovered'));
  assert.ok(recovered.events.some((item) => item.eventType === 'plan_revised'));
});

test('expired leases resume safe work but reconcile non-idempotent writes', () => {
  const safeRun = createDeepAgentRun({
    scope,
    conversationId: 'deep_resume_safe',
    objective: '恢复只读节点',
    nodes: [{ node_key: 'read', title: '读取', instruction: '读取', tool_profile: 'none' }]
  });
  const safeNode = safeRun.nodes[0];
  db.prepare(`UPDATE deep_agent_nodes SET status = 'running', lease_owner = 'dead-worker',
    lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(safeNode.id);

  const writeRun = createDeepAgentRun({
    scope,
    conversationId: 'deep_resume_write',
    objective: '恢复不可幂等写节点',
    nodes: [{
      node_key: 'charge', title: '写入', instruction: '执行外部写入', tool_profile: 'none',
      approval_mode: 'external_write', effect_mode: 'non_idempotent_write'
    }]
  });
  const writeNode = writeRun.nodes[0];
  db.prepare(`UPDATE deep_agent_nodes SET status = 'running', lease_owner = 'dead-worker',
    lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(writeNode.id);

  deepAgentRuntimeInternals.recoverExpiredWork();
  assert.equal(getDeepAgentRun(safeRun.id).nodes[0].status, 'queued');
  assert.equal(getDeepAgentRun(writeRun.id).nodes[0].status, 'reconciling');
  assert.equal(getDeepAgentRun(writeRun.id).status, 'reconciling');
});

test('validated replan can replace a failed node and preserve downstream dependencies', () => {
  const run = createDeepAgentRun({
    scope,
    conversationId: 'deep_replan_conversation',
    objective: '失败后拆成恢复步骤',
    nodes: [
      { node_key: 'prepare', title: '准备', instruction: '准备', tool_profile: 'none' },
      { node_key: 'build', title: '构建', instruction: '构建', depends_on: ['prepare'], tool_profile: 'none' },
      { node_key: 'verify', title: '验证', instruction: '验证', depends_on: ['build'], tool_profile: 'none' }
    ]
  });
  const build = run.nodes.find((node) => node.nodeKey === 'build');
  db.prepare(`UPDATE deep_agent_nodes SET status = 'failed', error = 'build failed' WHERE id = ?`).run(build.id);
  db.prepare(`UPDATE deep_agent_runs SET status = 'replanning' WHERE id = ?`).run(run.id);
  deepAgentRuntimeInternals.applyReplanPatch(run.id, build.id, {
    decision: 'replace',
    reason: '拆分诊断和修复',
    nodes: [
      { node_key: 'diagnose', title: '诊断', instruction: '诊断失败', tool_profile: 'none' },
      { node_key: 'repair', title: '修复', instruction: '执行修复', depends_on: ['diagnose'], tool_profile: 'none' }
    ]
  }, 'test');
  const revised = getDeepAgentRun(run.id);
  assert.equal(revised.planVersion, 2);
  assert.equal(revised.replanCount, 1);
  assert.equal(revised.nodes.find((node) => node.nodeKey === 'build').status, 'superseded');
  const repair = revised.nodes.find((node) => node.nodeKey === 'r1_repair');
  const verify = revised.nodes.find((node) => node.nodeKey === 'verify');
  assert.ok(revised.edges.some((edge) => edge.fromNodeId === repair.id && edge.toNodeId === verify.id));
});

test('cyclic plans are rejected before persistence', () => {
  assert.throws(() => createDeepAgentRun({
    scope,
    conversationId: 'deep_cycle_conversation',
    objective: '非法环计划',
    nodes: [
      { node_key: 'a', title: 'A', instruction: 'A', depends_on: ['b'] },
      { node_key: 'b', title: 'B', instruction: 'B', depends_on: ['a'] }
    ]
  }), /计划包含环/);
});
