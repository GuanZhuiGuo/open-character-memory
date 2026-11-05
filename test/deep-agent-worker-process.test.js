import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('external Deep Agent worker stays alive until it receives a shutdown signal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-worker-'));
  const child = spawn(process.execPath, ['scripts/deep-agent-worker.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATABASE_PATH: path.join(tempDir, 'worker.db'),
      TEXT_PROVIDER: 'mock',
      EMBEDDING_PROVIDER: 'mock',
      GRAPH_STORE: 'sqlite',
      SANDBOX_RUNTIME_ENABLED: 'false',
      DEEP_AGENT_RUNTIME_ENABLED: 'true',
      DEEP_AGENT_WORKER_MODE: 'external',
      DEEP_AGENT_WORKER_POLL_MS: '50'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Worker did not start: ${output}`)), 5000);
      const inspect = () => {
        if (output.includes('deep_agent_worker_started')) {
          clearTimeout(deadline);
          resolve();
        }
      };
      child.stdout.on('data', inspect);
      child.once('exit', (code) => {
        clearTimeout(deadline);
        reject(new Error(`Worker exited during startup with code ${code}: ${output}`));
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, output);

    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal(exit.code, 0, output);
    assert.match(output, /deep_agent_worker_stopping/);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
