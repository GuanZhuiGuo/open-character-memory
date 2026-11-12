import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { listEvents, listGraph, listMemoryForAdmin } from './memory.js';
import { nowIso, parseJson } from './utils.js';

const sources = new Set(['voice', 'companion']);
const reject = (message, code = 'MEMORY_COMPANION_SCOPE_FORBIDDEN', status = 403) => {
  throw Object.assign(new Error(message), { status, code });
};
export const isCompanionMemoryDelegation = principal => principal?.platformDelegated === true && sources.has(principal.delegationSource);

/** Re-derive the namespace here; a signed service still cannot choose another user's role. */
export function validateCompanionMemoryScope(principal, scope) {
  if (!isCompanionMemoryDelegation(principal)) reject('陪聊记忆需要受限平台委托');
  if (scope.tenantId !== config.memoryService.tenantId || scope.subjectId !== principal.userId
      || !principal.platformTenantId || !principal.platformUserId
      || typeof scope.roleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(scope.roleId)) {
    reject('陪聊记忆用户或角色不在委托范围内');
  }
  const id = 'chat_' + crypto.createHash('sha256')
    .update([principal.platformTenantId, principal.platformUserId, scope.roleId].join('\0')).digest('hex').slice(0, 32);
  if (scope.agentId !== id || scope.spaceId !== id || scope.branchId !== 'main') reject('陪聊记忆角色空间不匹配');
  validateCompanionMemoryAgent(scope);
  return Object.fromEntries(['tenantId', 'subjectId', 'agentId', 'spaceId', 'branchId', 'roleId'].map(key => [key, scope[key]]));
}

function validateCompanionMemoryAgent(scope, required = false) {
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(scope.agentId);
  if (!agent && !required) return null;
  const marker = parseJson(agent?.fixed_attributes_json, {})?.platformManagedMemory;
  if (!agent || agent.scene_id !== 'scene_companion' || agent.scenario_type !== 'companion' || agent.enabled !== 1
      || marker?.purpose !== 'companion_chat' || marker?.schemaVersion !== 1
      || marker?.subjectId !== scope.subjectId || marker?.roleId !== scope.roleId) {
    reject('陪聊记忆角色标识已有其他用途或已停用', 'MEMORY_COMPANION_AGENT_CONFLICT', 409);
  }
  return agent;
}

export function bindCompanionMemory(principal, rawScope) {
  const scope = validateCompanionMemoryScope(principal, rawScope);
  const timestamp = nowIso();
  const marker = { purpose: 'companion_chat', schemaVersion: 1, subjectId: scope.subjectId, roleId: scope.roleId };
  db.prepare(`INSERT OR IGNORE INTO agents(id,name,scene_id,scenario_type,description,system_prompt,
    greeting,avatar_color,enabled,fixed_attributes_json,created_at,updated_at)
    VALUES(?,?,'scene_companion','companion',?,?,'','#5969e8',1,?,?,?)`).run(scope.agentId,
    '陪聊角色 · ' + scope.roleId, '同一用户与同一角色在语音、数字人模式间共享的有证据记忆。',
    '仅从当前用户和该角色的真实对话提取有证据的偏好、共同经历和约定；区分用户自述、角色说法与待确认信息，不编造关系或经历。',
    JSON.stringify({ platformManagedMemory: marker }), timestamp, timestamp);
  const agent = validateCompanionMemoryAgent(scope, true);
  return { bound: true, scope, agent: { id: agent.id, sceneId: agent.scene_id }, readOnlyLibrary: true };
}

/** This projection exposes no write endpoint or Studio administration capability. */
export function companionMemoryLibrary(principal, rawScope) {
  const scope = validateCompanionMemoryScope(principal, rawScope);
  validateCompanionMemoryAgent(scope, true);
  const legacy = { userId: scope.subjectId, agentId: scope.agentId, storyId: scope.spaceId, branchId: scope.branchId };
  const observations = db.prepare(`SELECT id,thread_id,status,created_at,updated_at FROM memory_observations
    WHERE tenant_id=? AND user_id=? AND agent_id=? AND story_id=? AND branch_id=?
    ORDER BY created_at DESC,id DESC LIMIT 50`).all(scope.tenantId, scope.subjectId, scope.agentId, scope.spaceId, scope.branchId);
  const messages = db.prepare(`SELECT role,content,created_at FROM memory_observation_messages
    WHERE observation_id=? ORDER BY ordinal`);
  const graph = listGraph(legacy);
  for (const field of ['entities', 'edges', 'events', 'eventEntities', 'claims']) graph[field] = graph[field].slice(0, 200);
  return { readOnly: true, scope, memories: listMemoryForAdmin(legacy, 'companion'),
    events: listEvents(legacy, { order: 'created' }), graph,
    observations: observations.map(row => ({ id: row.id, threadId: row.thread_id, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, messages: messages.all(row.id).map(message => ({
        role: message.role, content: message.content, createdAt: message.created_at
      })) })) };
}
