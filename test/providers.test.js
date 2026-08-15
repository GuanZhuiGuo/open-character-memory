import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('Ark common-prefix cache reuses the stable role prefix and reports usage', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-provider-'));
  const calls = { create: 0, chat: 0, regular: 0 };
  const mockArk = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (request.url.endsWith('/context/create')) {
        calls.create += 1;
        assert.equal(body.mode, 'common_prefix');
        assert.match(body.messages[0].content, /稳定角色前缀/);
        response.end(JSON.stringify({ id: 'context_test_001' }));
        return;
      }
      if (request.url.endsWith('/context/chat/completions')) {
        calls.chat += 1;
        assert.equal(body.context_id, 'context_test_001');
        assert.match(body.messages[0].content, /动态记忆/);
        response.end(JSON.stringify({
          id: `response_${calls.chat}`,
          model: 'mock-ark-text',
          choices: [{ message: { content: '缓存回复' } }],
          usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108, prompt_tokens_details: { cached_tokens: 70 } }
        }));
        return;
      }
      calls.regular += 1;
      response.end(JSON.stringify({ id: 'regular', model: 'mock-ark-text', output_text: '普通回复' }));
    });
  });
  const port = await listen(mockArk);
  process.env.DATABASE_PATH = path.join(tempDir, 'provider.db');
  process.env.TEXT_PROVIDER = 'ark';
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.ARK_API_KEY = 'test-key';
  process.env.ARK_BASE_URL = `http://127.0.0.1:${port}/api/v3`;
  process.env.ARK_PREFIX_CACHE_MODE = 'common_prefix';

  const { db, initializeDatabase } = await import('../lib/db.js');
  const { generateText } = await import('../lib/providers/index.js');
  initializeDatabase();
  const options = {
    systemPrompt: '稳定角色前缀\n\n动态记忆',
    stableSystemPrompt: '稳定角色前缀',
    dynamicSystemPrompt: '动态记忆',
    messages: [{ role: 'user', content: '你好' }],
    cache: {
      key: 'agent:1:scene:prompt', agentId: 'agent_test', profileVersion: 1,
      sceneConfigVersion: 'scene-v1', promptHash: 'prompt-v1'
    }
  };
  try {
    const first = await generateText(options);
    const second = await generateText(options);
    assert.equal(first.cache.status, 'miss_created');
    assert.equal(second.cache.status, 'hit');
    assert.equal(second.usage.cachedTokens, 70);
    assert.equal(second.usage.cacheHitRate, 0.7);
    assert.deepEqual(calls, { create: 1, chat: 2, regular: 0 });
    const cacheRow = db.prepare('SELECT hit_count, create_count, status FROM model_prefix_caches').get();
    assert.deepEqual({ ...cacheRow }, { hit_count: 1, create_count: 1, status: 'ready' });
  } finally {
    db.close();
    await close(mockArk);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('production startup rejects the default administrator password', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./lib/config.js')"], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', ADMIN_PASSWORD: 'memory-admin' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /生产环境必须设置至少 12 位/);
});
