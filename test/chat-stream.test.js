import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    assert.ok(events.some((event) => event.type === 'turn_start' && event.turn === 1));
    assert.ok(events.some((event) => event.type === 'delta' && event.delta));
    const completed = events.find((event) => event.type === 'complete');
    assert.ok(completed?.result.message.id);
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

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
