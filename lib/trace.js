import { db } from './db.js';
import { json, nowIso, redactSecrets, uid } from './utils.js';

function clean(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value)));
  } catch {
    return redactSecrets(String(value));
  }
}

export function createTrace({ conversationId, userId, agentId, request }) {
  const id = uid('trace');
  db.prepare(`INSERT INTO traces
    (id, conversation_id, user_id, agent_id, request_json, started_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, conversationId, userId, agentId, json(clean(request)), nowIso());
  return { id, startedAt: Date.now() };
}

export async function withSpan(traceId, name, input, handler, { projectOutput = null } = {}) {
  const startedAt = Date.now();
  try {
    const output = await handler();
    const traceOutput = typeof projectOutput === 'function' ? projectOutput(output) : output;
    db.prepare(`INSERT INTO trace_spans
      (id, trace_id, name, status, duration_ms, input_json, output_json, created_at)
      VALUES (?, ?, ?, 'success', ?, ?, ?, ?)`)
      .run(uid('span'), traceId, name, Date.now() - startedAt, json(clean(input)), json(clean(traceOutput)), nowIso());
    return output;
  } catch (error) {
    db.prepare(`INSERT INTO trace_spans
      (id, trace_id, name, status, duration_ms, input_json, output_json, created_at)
      VALUES (?, ?, ?, 'error', ?, ?, ?, ?)`)
      .run(
        uid('span'), traceId, name, Date.now() - startedAt, json(clean(input)),
        json(clean({ error: error.message, stack: error.stack?.split('\n').slice(0, 4) })), nowIso()
      );
    throw error;
  }
}

export function addSpan(traceId, name, input, output, status = 'success', durationMs = 0) {
  db.prepare(`INSERT INTO trace_spans
    (id, trace_id, name, status, duration_ms, input_json, output_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid('span'), traceId, name, status, durationMs, json(clean(input)), json(clean(output)), nowIso());
}

export function finishTrace(trace, status, messageId = '') {
  db.prepare(`UPDATE traces SET status = ?, total_ms = ?, message_id = ?, ended_at = ? WHERE id = ?`)
    .run(status, Date.now() - trace.startedAt, messageId, nowIso(), trace.id);
}

export function listTraces(conversationId, limit = 50) {
  return db.prepare(`SELECT * FROM traces WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?`)
    .all(conversationId, Number(limit));
}

export function getTrace(traceId) {
  const trace = db.prepare('SELECT * FROM traces WHERE id = ?').get(traceId);
  if (!trace) return null;
  const spans = db.prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY created_at').all(traceId);
  return { ...trace, spans };
}
