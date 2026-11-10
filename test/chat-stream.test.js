import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-stream-'));
process.env.DATABASE_PATH = path.join(tempDir, 'stream.db');
process.env.TEXT_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';
process.env.AGENT_RUNTIME = 'pi';
process.env.GRAPH_STORE = 'sqlite';
process.env.BASE_PATH = '';
process.env.ARTIFACT_ROOT = path.join(tempDir, 'artifacts');

const { server } = await import('../server.js');
const { db } = await import('../lib/db.js');
const { config } = await import('../lib/config.js');

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close() {
  return new Promise((resolve) => server.close(resolve));
}

test('chat NDJSON streams runtime deltas and completes with current extraction progress', async () => {
  const port = await listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'stream_user', display_name: 'Stream User', password: 'password123'
      })
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    const cookie = registration.headers.getSetCookie()[0].split(';', 1)[0];
    const upload = await fetch(`${baseUrl}/api/artifacts/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        user_id: registered.user.id,
        agent_id: 'agent_linwan',
        file_name: 'notes.md',
        mime_type: 'text/markdown',
        data_base64: Buffer.from('# Notes\n\nScoped attachment.').toString('base64')
      })
    });
    assert.equal(upload.status, 201);
    const artifact = await upload.json();
    const download = await fetch(`${baseUrl}${artifact.downloadUrl}`, { headers: { Cookie: cookie } });
    assert.equal(download.status, 200);
    assert.match(await download.text(), /Scoped attachment/);
    const secondRegistration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'stream_user_2', display_name: 'Other User', password: 'password123'
      })
    });
    assert.equal(secondRegistration.status, 201);
    const secondCookie = secondRegistration.headers.getSetCookie()[0].split(';', 1)[0];
    const forbiddenDownload = await fetch(`${baseUrl}${artifact.downloadUrl}`, {
      headers: { Cookie: secondCookie }
    });
    assert.equal(forbiddenDownload.status, 403);
    db.prepare(`UPDATE event_extraction_profiles SET extraction_interval_turns = 1
      WHERE scene_id = 'scene_companion'`).run();

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        Cookie: cookie
      },
      body: JSON.stringify({
        user_id: registered.user.id,
        agent_id: 'agent_linwan',
        message: '请用 **Markdown** 回答。',
        attachment_ids: [artifact.id]
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');

    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'ready');
    const metadata = events.find(event => event.type === 'conversation');
    assert.ok(metadata?.conversation_id);
    assert.ok(metadata?.trace_id);
    assert.ok(events.some((event) => event.type === 'turn_start' && event.turn === 1));
    assert.ok(events.some((event) => event.type === 'delta' && event.delta));
    const completed = events.find((event) => event.type === 'complete');
    assert.ok(completed?.result.message.id);
    assert.equal(metadata.conversation_id, completed.result.conversation.id);
    assert.equal(metadata.trace_id, completed.result.traceId);
    assert.equal(completed.result.memoryExtraction.pendingTurns, 0);
    assert.equal(completed.result.memoryExtraction.progress, 0);
    assert.equal(completed.result.memoryExtraction.canExtract, false);
    const storedArtifact = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifact.id);
    assert.equal(storedArtifact.user_id, registered.user.id);
    assert.equal(storedArtifact.agent_id, 'agent_linwan');
    assert.equal(storedArtifact.conversation_id, completed.result.conversation.id);

    for (const asset of ['/vendor/marked.umd.js', '/vendor/purify.min.js']) {
      const assetResponse = await fetch(`${baseUrl}${asset}`);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get('content-type'), /javascript/);
      assert.ok((await assetResponse.text()).length > 1000);
    }
  } finally {
    await close();
  }
});

test('long pre-response work emits heartbeat and disconnect preserves one persisted turn', {timeout:30_000}, async () => {
  const port = await listen();
  const baseUrl = `http://127.0.0.1:${port}`;
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalConfig = {textProvider:config.textProvider, embeddingProvider:config.embeddingProvider, agentRuntime:config.agentRuntime, ark:{...config.ark}};
  const heartbeatTimers = new Set();
  let release;
  let gate;
  let blockNext = false;
  let proxyTimeouts = 0;
  const proxy = http.createServer((request,response) => {
    const upstream = http.request(baseUrl+request.url,{method:request.method,headers:request.headers},result => {
      response.writeHead(result.statusCode,result.headers);
      result.pipe(response);
    });
    upstream.setTimeout(120,() => { proxyTimeouts += 1; upstream.destroy(); });
    upstream.on('error',() => response.destroy());
    response.once('close',() => upstream.destroy());
    request.pipe(upstream);
  });
  const proxyPort = await new Promise(resolve => proxy.listen(0,'127.0.0.1',() => resolve(proxy.address().port)));
  globalThis.setInterval = (callback, delay, ...args) => {
    const timer = originalInterval(callback, delay === 15_000 ? 25 : delay, ...args);
    if (delay === 15_000) heartbeatTimers.add(timer);
    return timer;
  };
  globalThis.clearInterval = timer => { heartbeatTimers.delete(timer); return originalClear(timer); };
  config.textProvider = 'ark';
  config.embeddingProvider = 'mock';
  config.agentRuntime = 'legacy';
  Object.assign(config.ark, {apiKey:'private-fixture',baseUrl:'http://stream-fixture.invalid',prefixCacheMode:'off'});
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('http://stream-fixture.invalid/')) return originalFetch(url,init);
    if (blockNext) { blockNext = false; await gate; }
    const body = JSON.parse(init.body);
    const prompt = body.input?.[0]?.content?.[0]?.text || '';
    const text = prompt.includes('只输出严格 JSON')
      ? JSON.stringify({decision:'none',must_add:[],avoid_add:[],must_remove:[],avoid_remove:[],rejected:[],expand_event_ids:[],entity_names:[],follow_up_queries:[],reason:'fixture'})
      : '持久会话测试回复';
    return new Response(JSON.stringify({id:'fixture-response',model:'fixture-text',output_text:text,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}), {headers:{'Content-Type':'application/json'}});
  };
  const waitUntil = async predicate => {
    for (let attempt=0;attempt<100;attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.fail('private fixture did not reach the expected state');
  };
  try {
    for (const [index, disconnect] of [false,true].entries()) {
      const registration = await originalFetch(baseUrl+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'durable_stream_'+index,display_name:'Stream fixture',password:'password123'})});
      const user = (await registration.json()).user;
      const cookie = registration.headers.getSetCookie()[0].split(';',1)[0];
      gate = new Promise(resolve => { release = resolve; });
      blockNext = true;
      const response = await originalFetch(`http://127.0.0.1:${proxyPort}/api/chat`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson',Cookie:cookie},
        body:JSON.stringify({user_id:user.id,agent_id:'agent_linwan',message:'请回复持久会话测试。'}),signal:AbortSignal.timeout(5_000)});
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const events = [];
      let buffer = '';
      let metadataReady;
      let heartbeatReady;
      const metadata = new Promise(resolve => { metadataReady = resolve; });
      const heartbeat = new Promise(resolve => { heartbeatReady = resolve; });
      const consume = (async () => {
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value || new Uint8Array(),{stream:!chunk.done});
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line); events.push(event);
            if (event.type === 'conversation') metadataReady(event);
            if (event.type === 'heartbeat') heartbeatReady(event);
          }
          if (chunk.done) return;
        }
      })();
      const early = await metadata;
      assert.ok(early.conversation_id);
      assert.equal(db.prepare('SELECT count(*) AS n FROM conversations WHERE user_id=?').get(user.id).n,1);
      if (disconnect) {
        await reader.cancel();
        await consume;
        await waitUntil(() => heartbeatTimers.size === 0);
      } else {
        await heartbeat;
        await new Promise(resolve => setTimeout(resolve,250));
        assert.equal(events.some(event => event.type === 'turn_start'),false);
        assert.equal(proxyTimeouts,0);
      }
      release();
      if (!disconnect) {
        await consume;
        const complete = events.find(event => event.type === 'complete');
        assert.equal(complete.result.conversation.id,early.conversation_id);
        assert.equal(complete.result.traceId,early.trace_id);
      }
      await waitUntil(() => db.prepare('SELECT status FROM traces WHERE id=?').get(early.trace_id)?.status === 'success');
      assert.equal(heartbeatTimers.size,0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM conversations WHERE user_id=?').get(user.id).n,1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='user'").get(early.conversation_id).n,1);
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=? AND role='assistant'").get(early.conversation_id).n,1);
    }
  } finally {
    release?.();
    for (const timer of heartbeatTimers) originalClear(timer);
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
    Object.assign(config,originalConfig);
    await new Promise(resolve => proxy.close(resolve));
    await close();
  }
});

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
