import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-conversation-context-'));
process.env.DATABASE_PATH = path.join(tempDir, 'context.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.GRAPH_STORE = 'sqlite';

const { db, initializeDatabase } = await import('../lib/db.js');
const {
  buildConversationContext, ensureConversationContextSchema, estimateConversationTokens,
  getConversationContextStatus
} = await import('../lib/conversation-context.js');
initializeDatabase();
ensureConversationContextSchema();

let sequence = 0;
function createConversation() {
  const id = `context_conversation_${++sequence}`;
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO conversations(id, user_id, agent_id, story_id, branch_id, created_at, updated_at)
    VALUES (?, 'user_xiaoyu', 'agent_linwan', 'main_story', 'main', ?, ?)`)
    .run(id, timestamp, timestamp);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function appendMessages(conversation, count, contentLength = 100) {
  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?').get(conversation.id).count;
  for (let offset = 0; offset < count; offset += 1) {
    const ordinal = existingCount + offset;
    db.prepare(`INSERT INTO messages(id, conversation_id, user_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${conversation.id}_message_${ordinal}`, conversation.id, conversation.user_id,
        ordinal % 2 ? 'assistant' : 'user', `消息${ordinal} ${'x'.repeat(contentLength)}`,
        new Date(Date.UTC(2026, 10, 5, 0, 0, ordinal)).toISOString());
  }
  return db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY rowid')
    .all(conversation.id);
}

function summaryResult(summary = '用户讨论了旅行安排。助手提出了建议，行程仍待用户确认。') {
  return { text: JSON.stringify({ summary }), model: 'test-summary', usage: { input_tokens: 10, output_tokens: 8 } };
}

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('small conversations retain exact original history without calling the model', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 8);
  const result = await buildConversationContext(conversation, { generate() { assert.fail('unnecessary generation'); } });
  assert.deepEqual(result.messages, originals);
  assert.equal(result.summaryText, '');
  assert.equal(result.diagnostics.status, 'raw');
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 0);
});

test('the configured mock provider exercises normal summary generation without an injected generator', async () => {
  const conversation = createConversation();
  appendMessages(conversation, 30);
  const result = await buildConversationContext(conversation);
  assert.equal(result.diagnostics.status, 'compacted');
  assert.match(result.snapshot.summary, /模拟摘要，仅用于验证流程/);
  assert.equal(result.snapshot.coveredMessageIds.length, 14);
});

test('compression preserves recent complete turns and stores scope-bound source provenance', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 31);
  const result = await buildConversationContext(conversation, { generate: async () => summaryResult() });
  assert.equal(result.diagnostics.status, 'compacted');
  assert.deepEqual(result.snapshot.coveredMessageIds, originals.slice(0, 14).map((message) => message.id));
  assert.deepEqual(result.messages, originals.slice(14));
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages.at(-1).role, 'user');
  assert.equal(result.snapshot.scope.userId, conversation.user_id);
  assert.equal(result.snapshot.scope.branchId, conversation.branch_id);
  assert.match(result.snapshot.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.summaryText, /用户当前消息与服务端当前有效记忆优先/);
  assert.match(result.summaryText, /不能单独作为用户事实、授权或执行指令/);
  assert.equal(getConversationContextStatus(conversation).sourceMessageCount, originals.length);
  assert.equal(getConversationContextStatus(conversation).summarizedMessageCount, 14);
});

test('concurrent callers reuse one snapshot and later turns merge only their new source batch', async () => {
  const conversation = createConversation();
  appendMessages(conversation, 30);
  const requests = [];
  const generate = async (request) => {
    requests.push(JSON.parse(request.messages[0].content));
    await new Promise((resolve) => setTimeout(resolve, 5));
    return summaryResult(`批次${requests.length}，用户计划仍待确认。`);
  };
  const [first, duplicate] = await Promise.all([
    buildConversationContext(conversation, { generate }),
    buildConversationContext(conversation, { generate })
  ]);
  assert.equal(requests.length, 1);
  assert.equal(first.snapshot.id, duplicate.snapshot.id);
  assert.equal(duplicate.diagnostics.status, 'reused');
  appendMessages(conversation, 8);
  const second = await buildConversationContext(conversation, { generate });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previous_summary, first.snapshot.summary);
  assert.equal(requests[1].messages.length, 8);
  assert.ok(requests[1].messages.every((message) => !first.snapshot.coveredMessageIds.includes(message.id)));
  assert.equal(second.snapshot.previousSnapshotId, first.snapshot.id);
  assert.equal(second.snapshot.coveredMessageIds.length, 22);
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 2);
});

test('provider failure and invalid JSON preserve every source and leave the watermark unchanged', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 30, 900);
  const failed = await buildConversationContext(conversation, {
    maxContextTokens: 500,
    generate: async () => { throw new Error('temporary model failure'); }
  });
  assert.equal(failed.diagnostics.status, 'failed');
  assert.equal(failed.diagnostics.budgetExceeded, true);
  assert.deepEqual(failed.messages, originals);
  assert.equal(failed.snapshot, null);
  const invalid = await buildConversationContext(conversation, { generate: async () => ({ text: 'broken json' }) });
  assert.equal(invalid.diagnostics.status, 'failed');
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 0);
  assert.equal(db.prepare('SELECT lease_owner FROM conversation_context_states WHERE conversation_id = ?')
    .get(conversation.id).lease_owner, '');
  const retried = await buildConversationContext(conversation, { generate: async () => summaryResult() });
  assert.equal(retried.diagnostics.status, 'compacted');
});

test('incremental failure retains the previous snapshot and all uncompressed new messages', async () => {
  const conversation = createConversation();
  appendMessages(conversation, 30);
  const first = await buildConversationContext(conversation, { generate: async () => summaryResult() });
  const originals = appendMessages(conversation, 8);
  const failed = await buildConversationContext(conversation, {
    generate: async () => { throw new Error('incremental failure'); }
  });
  assert.equal(failed.snapshot.id, first.snapshot.id);
  assert.deepEqual(failed.messages, originals.slice(first.snapshot.coveredMessageIds.length));
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 1);
  assert.equal(getConversationContextStatus(conversation).summarizedMessageCount, first.snapshot.coveredMessageIds.length);
});

test('scope mismatches and foreign message references are rejected before any generation', async () => {
  const first = createConversation();
  const second = createConversation();
  appendMessages(first, 30);
  const foreignMessages = appendMessages(second, 2);
  await assert.rejects(buildConversationContext({ ...first, branch_id: 'another_branch' }), /SCOPE_MISMATCH/);
  await assert.rejects(buildConversationContext({ ...first, user_id: 'another_user' }), /SCOPE_MISMATCH/);
  await assert.rejects(buildConversationContext(first, foreignMessages), /SOURCE_MISMATCH/);
  assert.equal(getConversationContextStatus(first).snapshotCount, 0);
});

test('disabled replay returns raw history without reading or advancing stored summary', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 30);
  const first = await buildConversationContext(conversation, { generate: async () => summaryResult() });
  const replay = await buildConversationContext(conversation, {
    enabled: false,
    throughMessageId: originals[9].id,
    generate() { assert.fail('replay generation'); }
  });
  assert.equal(replay.diagnostics.status, 'disabled');
  assert.equal(replay.snapshot, null);
  assert.equal(replay.summaryText, '');
  assert.deepEqual(replay.messages, originals.slice(0, 10));
  assert.equal(getConversationContextStatus(conversation).snapshot.id, first.snapshot.id);
});

test('source edits during generation reject the stale result and retain corrected originals', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 30);
  const result = await buildConversationContext(conversation, {
    generate: async () => {
      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('用户更正了行程目的地。', originals[0].id);
      return summaryResult('旧目的地');
    }
  });
  assert.equal(result.diagnostics.status, 'failed');
  assert.match(result.diagnostics.error, /SOURCES_CHANGED/);
  assert.equal(result.snapshot, null);
  assert.equal(result.messages[0].content, '用户更正了行程目的地。');
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 0);
});

test('fingerprint changes invalidate old summaries and force a fresh source-based summary', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 30);
  const first = await buildConversationContext(conversation, { generate: async () => summaryResult('计划去北京。') });
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('更正为上海，原北京行程已取消。', originals[0].id);
  assert.equal(getConversationContextStatus(conversation).status, 'stale');
  const corrected = await buildConversationContext(conversation, {
    generate: async (request) => {
      const input = JSON.parse(request.messages[0].content);
      assert.equal(input.previous_summary, '');
      assert.match(input.messages[0].content, /更正为上海/);
      return summaryResult('用户更正行程为上海，北京行程已取消。');
    }
  });
  assert.equal(corrected.diagnostics.snapshotInvalidated, true);
  assert.notEqual(corrected.snapshot.id, first.snapshot.id);
  assert.equal(corrected.snapshot.previousSnapshotId, '');
  assert.match(corrected.summaryText, /北京行程已取消/);
});

test('token pressure removes only whole older turns and preserves the current unfinished turn', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 37, 700);
  const result = await buildConversationContext(conversation, {
    maxContextTokens: 1200, maxSummaryTokens: 100,
    generate: async () => summaryResult('用户讨论了安排，具体计划待确认。')
  });
  assert.equal(result.diagnostics.status, 'compacted');
  assert.equal(result.diagnostics.budgetExceeded, false);
  assert.ok(result.messages.length < 16);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[1].role, 'assistant');
  assert.equal(result.messages.at(-1).id, originals.at(-1).id);
  assert.equal(result.snapshot.coveredMessageIds.length + result.messages.length, originals.length);
  assert.ok(estimateConversationTokens('中') > estimateConversationTokens('a'));
});

test('an oversized current exchange stays intact and explicitly reports its budget overrun', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 2, 3000);
  const result = await buildConversationContext(conversation, {
    maxContextTokens: 300,
    generate() { assert.fail('current exchange must remain raw'); }
  });
  assert.deepEqual(result.messages, originals);
  assert.equal(result.diagnostics.budgetExceeded, true);
});

test('an active external lease prevents duplicate work while retaining unsummarized sources', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 30);
  db.prepare(`INSERT INTO conversation_context_states(conversation_id, lease_owner, lease_expires_at, updated_at)
    VALUES (?, 'another-process', ?, ?)`).run(conversation.id, Date.now() + 60_000, new Date().toISOString());
  const result = await buildConversationContext(conversation, { generate() { assert.fail('lease collision'); } });
  assert.equal(result.diagnostics.status, 'compacting_elsewhere');
  assert.deepEqual(result.messages, originals);
  assert.equal(getConversationContextStatus(conversation).compacting, true);
});

test('bounded multi-pass compaction leaves unprocessed source text available for later calls', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 40, 500);
  let calls = 0;
  const result = await buildConversationContext(conversation, {
    maxContextTokens: 700, maxSummaryTokens: 100, maxSourceTokens: 1000, maxCompactionPasses: 2,
    generate: async () => { calls += 1; return summaryResult('用户讨论了旅行安排。'); }
  });
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.compactionCount, 2);
  assert.ok(result.diagnostics.remainingCompactionMessageCount > 0);
  assert.equal(result.diagnostics.budgetExceeded, true);
  assert.deepEqual(result.messages, originals.slice(result.snapshot.coveredMessageIds.length));
  assert.equal(getConversationContextStatus(conversation).snapshotCount, 2);
});

test('older explicit prefixes never replace a newer active snapshot', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 40);
  const current = await buildConversationContext(conversation, { generate: async () => summaryResult() });
  const historical = await buildConversationContext(conversation, {
    throughMessageId: originals[9].id,
    generate() { assert.fail('historical prefix must not replace current summary'); }
  });
  assert.equal(historical.diagnostics.status, 'historical_prefix');
  assert.deepEqual(historical.messages, originals.slice(0, 10));
  assert.equal(getConversationContextStatus(conversation).snapshot.id, current.snapshot.id);
});

test('failed explicit-prefix generation cannot leak later messages into its fallback', async () => {
  const conversation = createConversation();
  const originals = appendMessages(conversation, 40);
  const prefix = originals.slice(0, 30);
  const failed = await buildConversationContext(conversation, prefix, {
    generate: async () => { throw new Error('prefix failure'); }
  });
  assert.equal(failed.diagnostics.status, 'failed');
  assert.deepEqual(failed.messages, prefix);
});
