import { initializeDatabase } from '../lib/db.js';
import {
  getDeepAgentRuntimeStatus,
  startDeepAgentWorker,
  stopDeepAgentWorker
} from '../lib/deep-agent-runtime.js';

initializeDatabase();
startDeepAgentWorker({ force: true });

console.log(JSON.stringify({ event: 'deep_agent_worker_started', ...getDeepAgentRuntimeStatus() }));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'deep_agent_worker_stopping', signal }));
  await stopDeepAgentWorker();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

setInterval(() => {
  console.log(JSON.stringify({ event: 'deep_agent_worker_heartbeat', ...getDeepAgentRuntimeStatus() }));
}, 60_000).unref();
