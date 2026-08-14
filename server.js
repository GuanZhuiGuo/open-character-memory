import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chat, createConversation, DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS,
  getConversationMessages, listConversations, MAIN_MODEL_MESSAGE_LIMIT
} from './lib/agent.js';
import { answerArchitectureQuestion, getArchitectureIndexStatus } from './lib/architecture.js';
import { checkArkHealth } from './lib/ark.js';
import { config } from './lib/config.js';
import { db, initializeDatabase } from './lib/db.js';
import {
  EXTRACTION_CONTEXT_MAX_MESSAGES, EXTRACTION_CONTEXT_MAX_TURNS, EXTRACTION_INTERVAL_MAX_TURNS,
  formatRetrievedMemory,
  getEventExtractionProfile, getExtractionPromptContract, getRetrievalProfile, listEvents,
  listGraph, listMemoryForAdmin, listMemorySchemas, RELATIONSHIP_STAGE_THRESHOLDS,
  retrieveMemory, setMemoryValue
} from './lib/memory.js';
import { getTrace, listTraces } from './lib/trace.js';
import { listPlots, listTools, listTriggers } from './lib/triggers.js';
import { hash, json, nowIso, parseJson, safeText, uid } from './lib/utils.js';

initializeDatabase();

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
const ADMIN_SESSION_COOKIE = 'memory_admin_session';
const USER_SESSION_COOKIE = 'memory_user_session';
const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
const USER_SESSION_SECONDS = 7 * 24 * 60 * 60;
const CHAT_MESSAGE_MAX_CHARACTERS = 1000;
const REGISTRATION_USER_LIMIT = 15;

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function cookieHeader(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=${config.basePath || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

function clearAuthCookies() {
  return [
    cookieHeader(ADMIN_SESSION_COOKIE, '', 0),
    cookieHeader(USER_SESSION_COOKIE, '', 0)
  ];
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, account) {
  const supplied = Buffer.from(passwordDigest(password, account.password_salt), 'hex');
  const expected = Buffer.from(account.password_hash, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function normalizeUsername(value) {
  const username = safeText(value, 32).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new HttpError(400, '登录名需为 3-32 位小写字母、数字、点、下划线或短横线', 'INVALID_USERNAME');
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, '密码长度需为 8-128 个字符', 'INVALID_PASSWORD');
  }
  return password;
}

function sessionExpiry(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function createUserSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const timestamp = nowIso();
  const expiresAt = sessionExpiry(USER_SESSION_SECONDS);
  db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(timestamp);
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), userId, expiresAt, timestamp);
  return { token, expiresAt };
}

function publicUser(row) {
  return row ? {
    id: row.id || row.user_id,
    name: row.name,
    display_name: row.display_name,
    avatar_color: row.avatar_color,
    status: row.status
  } : null;
}

function getPrincipal(request) {
  const cookies = parseCookies(request);
  const adminToken = cookies[ADMIN_SESSION_COOKIE];
  if (adminToken) {
    const session = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(hash(adminToken));
    if (session && new Date(session.expires_at).getTime() > Date.now()) {
      return { role: 'admin', userId: null, displayName: '管理员' };
    }
  }
  const userToken = cookies[USER_SESSION_COOKIE];
  if (!userToken) return null;
  const row = db.prepare(`SELECT us.expires_at, ua.username, u.*
    FROM user_sessions us
    JOIN user_accounts ua ON ua.user_id = us.user_id
    JOIN users u ON u.id = us.user_id
    WHERE us.token_hash = ? AND u.status = 'active'`).get(hash(userToken));
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    role: 'user',
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    user: publicUser(row)
  };
}

function requirePrincipal(request, response) {
  const principal = getPrincipal(request);
  if (principal) return principal;
  sendJson(response, 401, { error: '请先登录', code: 'AUTH_REQUIRED' });
  return null;
}

function requireAdminPrincipal(principal, response) {
  if (principal.role === 'admin') return true;
  sendJson(response, 403, { error: '该功能仅管理员可用', code: 'ADMIN_REQUIRED' });
  return false;
}

function assertUserAccess(principal, requestedUserId) {
  const userId = safeText(requestedUserId, 100).trim();
  if (!userId) throw new HttpError(400, '缺少用户作用域', 'USER_SCOPE_REQUIRED');
  if (principal.role === 'user' && principal.userId !== userId) {
    throw new HttpError(403, '无权访问其他用户的记忆或数据', 'USER_SCOPE_FORBIDDEN');
  }
  return userId;
}

function userMayAccessRoute(pathname, method) {
  if (pathname === '/api/conversations' && ['GET', 'POST'].includes(method)) return true;
  if (pathname === '/api/chat' && method === 'POST') return true;
  if (pathname === '/api/feedback' && method === 'POST') return true;
  if (['/api/memory/retrieval-test', '/api/architecture/ask', '/api/admin/health/ark'].includes(pathname)
    && method === 'POST') return true;
  if (method !== 'GET') return false;
  if ([
    '/api/bootstrap', '/api/agents', '/api/scenes', '/api/memory/schemas', '/api/memory/values',
    '/api/memory/history', '/api/memory/graph', '/api/memory/events', '/api/plots', '/api/triggers',
    '/api/tools', '/api/traces', '/api/architecture/overview'
  ].includes(pathname)) return true;
  return /^\/api\/conversations\/[^/]+$/.test(pathname)
    || /^\/api\/scenes\/[^/]+\/(retrieval-profile|event-extraction-profile|extraction-contract)$/.test(pathname)
    || /^\/api\/traces\/[^/]+$/.test(pathname);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('请求体超过 2MB 限制');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function queryScope(url) {
  return {
    userId: url.searchParams.get('user_id') || '',
    agentId: url.searchParams.get('agent_id') || '',
    storyId: url.searchParams.get('story_id') || 'main_story',
    branchId: url.searchParams.get('branch_id') || 'main'
  };
}

function decodeRows(rows, fields) {
  return rows.map((row) => {
    const output = { ...row };
    for (const field of fields) output[field.replace(/_json$/, '')] = parseJson(row[field]);
    return output;
  });
}

function updateAgent(id, body) {
  const current = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!current) throw new Error('角色不存在');
  const sceneId = body.scene_id || current.scene_id || 'scene_companion';
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND enabled = 1').get(sceneId);
  if (!scene) throw new Error('角色必须归属于一个有效场景');
  const rawAttributes = body.fixed_attributes ?? parseJson(current.fixed_attributes_json, {});
  if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes)) {
    throw new Error('角色固定属性必须是键值对象');
  }
  const fixedAttributes = {};
  for (const [rawKey, rawValue] of Object.entries(rawAttributes).slice(0, 30)) {
    const key = safeText(rawKey, 60).trim();
    const value = safeText(rawValue, 600).trim();
    if (key && value) fixedAttributes[key] = value;
  }
  const nextProfile = {
    name: safeText(body.name ?? current.name, 80),
    sceneId: scene.id,
    scenarioType: scene.scenario_type,
    description: safeText(body.description ?? current.description, 500),
    systemPrompt: safeText(body.system_prompt ?? current.system_prompt, 30000),
    greeting: safeText(body.greeting ?? current.greeting, 1000),
    fixedAttributes
  };
  const currentAttributes = parseJson(current.fixed_attributes_json, {}) || {};
  const changedProtectedFields = [
    nextProfile.name !== current.name ? '角色名称' : '',
    nextProfile.sceneId !== current.scene_id ? '所属场景' : '',
    nextProfile.systemPrompt !== current.system_prompt ? '核心人设提示词' : '',
    json(fixedAttributes) !== json(currentAttributes) ? '角色固定属性' : ''
  ].filter(Boolean);
  const impact = changedProtectedFields.length ? {
    conversations: Number(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE agent_id = ?').get(id).count),
    events: Number(db.prepare('SELECT COUNT(*) AS count FROM events WHERE agent_id = ?').get(id).count),
    claims: Number(db.prepare('SELECT COUNT(*) AS count FROM claims WHERE agent_id = ?').get(id).count),
    structuredMemories: Number(db.prepare("SELECT COUNT(*) AS count FROM memory_values WHERE agent_id = ? AND status = 'active'").get(id).count)
  } : { conversations: 0, events: 0, claims: 0, structuredMemories: 0 };
  const affectedMemoryCount = impact.events + impact.claims + impact.structuredMemories;
  if (changedProtectedFields.length && (affectedMemoryCount || impact.conversations)
    && body.confirm_profile_change !== true) {
    throw new HttpError(
      409,
      '修改角色核心人设可能与已经产生的记忆和共同剧情矛盾，需要二次确认',
      'ROLE_PROFILE_CHANGE_CONFIRMATION_REQUIRED',
      { changedFields: changedProtectedFields, ...impact, currentVersion: Number(current.profile_version || 1) }
    );
  }
  const timestamp = nowIso();
  const nextVersion = changedProtectedFields.length ? Number(current.profile_version || 1) + 1 : Number(current.profile_version || 1);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE agents SET name = ?, scene_id = ?, scenario_type = ?, description = ?, system_prompt = ?,
      greeting = ?, avatar_color = ?, enabled = ?, fixed_attributes_json = ?, profile_version = ?, updated_at = ? WHERE id = ?`)
      .run(
        nextProfile.name, nextProfile.sceneId, nextProfile.scenarioType,
        nextProfile.description, nextProfile.systemPrompt, nextProfile.greeting,
        body.avatar_color || current.avatar_color,
        body.enabled === undefined ? current.enabled : Number(Boolean(body.enabled)),
        json(fixedAttributes), nextVersion, timestamp, id
      );
    if (changedProtectedFields.length) {
      db.prepare(`INSERT INTO agent_profile_history
        (id, agent_id, old_profile_json, new_profile_json, affected_memory_count,
         warning_acknowledged, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        uid('agent_profile'), id, json({
          name: current.name,
          sceneId: current.scene_id,
          scenarioType: current.scenario_type,
          systemPrompt: current.system_prompt,
          fixedAttributes: currentAttributes
        }), json(nextProfile), affectedMemoryCount, Number(Boolean(body.confirm_profile_change)), nextVersion, timestamp
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

function listScenes() {
  return db.prepare(`SELECT s.*, mp.id AS memory_profile_id, mp.name AS memory_profile_name,
    mp.description AS memory_profile_description, rp.id AS retrieval_profile_id,
    rp.name AS retrieval_profile_name, rp.min_similarity AS retrieval_min_similarity,
    rp.event_top_k AS retrieval_event_top_k,
    ep.id AS event_extraction_profile_id, ep.name AS event_extraction_profile_name,
    ep.enabled AS event_extraction_enabled, ep.context_turns AS event_extraction_context_turns,
    ep.extraction_interval_turns AS event_extraction_interval_turns,
    (SELECT COUNT(*) FROM agents a WHERE a.scene_id = s.id AND a.enabled = 1) AS character_count,
    (SELECT COUNT(*) FROM memory_schemas ms
      WHERE ms.enabled = 1 AND (ms.scenario_type = 'all' OR ms.scenario_type = s.scenario_type)) AS field_count,
    (SELECT COUNT(*) FROM memory_schemas ms
      WHERE ms.enabled = 1 AND ms.pinned = 1
        AND (ms.scenario_type = 'all' OR ms.scenario_type = s.scenario_type)) AS pinned_count
    FROM scenes s
    JOIN memory_profiles mp ON mp.scene_id = s.id
    JOIN retrieval_profiles rp ON rp.scene_id = s.id
    JOIN event_extraction_profiles ep ON ep.scene_id = s.id
    WHERE s.enabled = 1
    ORDER BY s.created_at, s.name`).all();
}

function architectureOverview(sceneId) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ? AND enabled = 1').get(sceneId)
    || db.prepare('SELECT * FROM scenes WHERE enabled = 1 ORDER BY created_at LIMIT 1').get();
  if (!scene) throw new Error('没有可用场景');
  const extraction = getEventExtractionProfile(scene.id);
  const retrieval = getRetrievalProfile(scene.id);
  const intimacySchema = db.prepare("SELECT constraints_json FROM memory_schemas WHERE key = 'relationship.intimacy'").get();
  const intimacyConstraints = parseJson(intimacySchema?.constraints_json, {});
  const extractionTurns = Number(extraction?.context_turns || 0);
  const extractionIntervalTurns = Math.max(
    1,
    Number(extraction?.extraction_interval_turns || DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS)
  );
  return {
    scene: { id: scene.id, name: scene.name, scenarioType: scene.scenario_type },
    thresholds: {
      mainModel: {
        messageLimit: MAIN_MODEL_MESSAGE_LIMIT,
        approximateTurns: Math.floor(MAIN_MODEL_MESSAGE_LIMIT / 2),
        unit: 'messages',
        overflowBehavior: '超出的旧消息不进入主模型 Input，原始消息仍保留在数据库'
      },
      extraction: {
        intervalTurns: extractionIntervalTurns,
        intervalConfigurableRange: [1, EXTRACTION_INTERVAL_MAX_TURNS],
        alignedWithShortTermMemory: extractionIntervalTurns === Math.floor(MAIN_MODEL_MESSAGE_LIMIT / 2),
        contextTurns: extractionTurns,
        messageLimit: Math.min(EXTRACTION_CONTEXT_MAX_MESSAGES, extractionTurns * 2),
        configurableRange: [1, EXTRACTION_CONTEXT_MAX_TURNS],
        maxEventsPerTurn: Number(extraction?.max_events_per_turn || 0),
        maxEventsPerBatch: Math.min(
          30,
          Number(extraction?.max_events_per_turn || 0) * extractionIntervalTurns
        ),
        minImportance: Number(extraction?.min_importance || 0),
        includeAssistant: Boolean(extraction?.include_assistant)
      },
      relationship: {
        maxDeltaPerTurn: Number(intimacyConstraints.maxDeltaPerTurn || 5),
        stages: RELATIONSHIP_STAGE_THRESHOLDS
      },
      retrieval: retrieval ? {
        eventTopK: Number(retrieval.event_top_k),
        claimTopK: Number(retrieval.claim_top_k),
        edgeTopK: Number(retrieval.edge_top_k),
        catalogMinSimilarity: Number(retrieval.catalog_min_similarity),
        vectorOnlyMinSimilarity: Number(retrieval.vector_only_min_similarity),
        minSimilarity: Number(retrieval.min_similarity),
        plannerEnabled: Boolean(retrieval.planner_enabled),
        plannerMaxCandidates: Number(retrieval.planner_max_candidates),
        graphHops: Number(retrieval.graph_hops)
      } : null
    },
    memoryOwnership: [
      { key: 'role_profile', label: '角色固定属性', scope: 'agent', injection: 'always' },
      { key: 'user_memory', label: '用户记忆', scope: 'user_agent_story_branch', injection: 'pinned_or_retrieved' },
      { key: 'shared_story', label: '我们的故事', scope: 'user_agent_story_branch', injection: 'retrieved_only' }
    ],
    compression: {
      rollingSummaryEnabled: false,
      tokenThreshold: null,
      currentBehavior: `仅取最近 ${MAIN_MODEL_MESSAGE_LIMIT} 条消息；尚未实现 token 阈值或滚动摘要`
    },
    timing: {
      sameTimePoint: false,
      sameBlockingPhase: true,
      triggerPoint: extraction?.trigger_point || 'after_every_x_assistant_messages_persisted',
      conversationBoundaryFlush: 'before_first_message_after_conversation_switch',
      extractionIntervalTurns,
      executionMode: extraction?.execution_mode || 'blocking_after_assistant',
      steps: [
        { order: 1, key: 'extract', label: `累计 ${extractionIntervalTurns} 个完整轮次，或跨对话发送前，记忆抽取模型返回结构化操作` },
        { order: 2, key: 'structured', label: '写入 structured_updates 和 relationship_deltas' },
        { order: 3, key: 'derived', label: '亲密度写入时同步重算 relationship.stage' },
        { order: 4, key: 'events', label: '对齐并写入事件、声明、图边和向量' },
        { order: 5, key: 'triggers', label: '达到阈值的轮次完成记忆写入后执行条件触发器' }
      ]
    },
    index: getArchitectureIndexStatus()
  };
}

function updateMemoryProfile(sceneId, body) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  if (!scene) throw new Error('场景不存在');
  const current = db.prepare('SELECT * FROM memory_profiles WHERE scene_id = ?').get(sceneId);
  if (!current) throw new Error('该场景尚未绑定记忆设置');
  const name = safeText(body.name ?? current.name, 100).trim();
  if (!name) throw new Error('记忆设置名称不能为空');
  db.prepare(`UPDATE memory_profiles SET name = ?, description = ?, updated_at = ? WHERE scene_id = ?`)
    .run(name, safeText(body.description ?? current.description, 500), nowIso(), sceneId);
  return listScenes().find((item) => item.id === sceneId);
}

function booleanSetting(value, fallback) {
  if (value === undefined) return Number(Boolean(fallback));
  return Number(value === true || value === 1 || value === '1' || value === 'true');
}

function numericSetting(body, key, fallback, minimum, maximum, integer = false) {
  const value = Number(body[key] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} 必须在 ${minimum} - ${maximum} 之间`);
  }
  return integer ? Math.round(value) : value;
}

function stringListSetting(value, label, { maximumItems = 20, maximumLength = 80 } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  const items = [...new Set(value.map((item) => safeText(item, maximumLength).trim()).filter(Boolean))];
  if (!items.length || items.length > maximumItems) throw new Error(`${label} 需要 1 - ${maximumItems} 项`);
  return items;
}

function updateEventExtractionProfile(sceneId, body) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  if (!scene) throw new Error('场景不存在');
  const current = getEventExtractionProfile(sceneId);
  if (!current) throw new Error('该场景尚未绑定事件抽取配置');
  const eventTypes = stringListSetting(
    body.allowed_event_types ?? current.allowed_event_types,
    '允许的事件类型', { maximumItems: 12, maximumLength: 40 }
  );
  if (eventTypes.some((item) => !/^[a-z][a-z0-9_]*$/.test(item))) {
    throw new Error('事件类型只能使用小写字母、数字和下划线');
  }
  const updateSignals = stringListSetting(
    body.update_signals ?? current.update_signals,
    '事件更新信号', { maximumItems: 20, maximumLength: 30 }
  );
  const name = safeText(body.name ?? current.name, 100).trim();
  if (!name) throw new Error('事件抽取配置名称不能为空');
  db.prepare(`UPDATE event_extraction_profiles SET
    name = ?, enabled = ?, extraction_interval_turns = ?, context_turns = ?,
    include_assistant = ?, max_events_per_turn = ?,
    min_importance = ?, allowed_event_types_json = ?, update_signals_json = ?,
    event_instruction = ?, entity_instruction = ?, relation_instruction = ?, custom_rules = ?, updated_at = ?
    WHERE scene_id = ?`).run(
    name,
    booleanSetting(body.enabled, current.enabled),
    numericSetting(
      body,
      'extraction_interval_turns',
      current.extraction_interval_turns,
      1,
      EXTRACTION_INTERVAL_MAX_TURNS,
      true
    ),
    numericSetting(body, 'context_turns', current.context_turns, 1, EXTRACTION_CONTEXT_MAX_TURNS, true),
    booleanSetting(body.include_assistant, current.include_assistant),
    numericSetting(body, 'max_events_per_turn', current.max_events_per_turn, 1, 10, true),
    numericSetting(body, 'min_importance', current.min_importance, 0, 1),
    json(eventTypes), json(updateSignals),
    safeText(body.event_instruction ?? current.event_instruction, 4000),
    safeText(body.entity_instruction ?? current.entity_instruction, 4000),
    safeText(body.relation_instruction ?? current.relation_instruction, 4000),
    safeText(body.custom_rules ?? current.custom_rules, 4000),
    nowIso(), sceneId
  );
  return getEventExtractionProfile(sceneId);
}

function updateRetrievalProfile(sceneId, body) {
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  if (!scene) throw new Error('场景不存在');
  const current = getRetrievalProfile(sceneId);
  if (!current) throw new Error('该场景尚未绑定召回策略');
  const values = {
    name: safeText(body.name ?? current.name, 100).trim(),
    vectorEnabled: booleanSetting(body.vector_enabled, current.vector_enabled),
    keywordEnabled: booleanSetting(body.keyword_enabled, current.keyword_enabled),
    graphEnabled: booleanSetting(body.graph_enabled, current.graph_enabled),
    intentFilterEnabled: booleanSetting(body.intent_filter_enabled, current.intent_filter_enabled),
    minSimilarity: numericSetting(body, 'min_similarity', current.min_similarity, 0, 1),
    catalogMinSimilarity: numericSetting(body, 'catalog_min_similarity', current.catalog_min_similarity, 0, 1),
    vectorOnlyMinSimilarity: numericSetting(body, 'vector_only_min_similarity', current.vector_only_min_similarity, 0, 1),
    plannerEnabled: booleanSetting(body.planner_enabled, current.planner_enabled),
    plannerMaxCandidates: numericSetting(body, 'planner_max_candidates', current.planner_max_candidates, 1, 30, true),
    graphHops: numericSetting(body, 'graph_hops', current.graph_hops, 0, 2, true),
    minKeywordScore: numericSetting(body, 'min_keyword_score', current.min_keyword_score, 0, 1),
    eventTopK: numericSetting(body, 'event_top_k', current.event_top_k, 1, 50, true),
    claimTopK: numericSetting(body, 'claim_top_k', current.claim_top_k, 1, 100, true),
    edgeTopK: numericSetting(body, 'edge_top_k', current.edge_top_k, 1, 100, true),
    vectorWeight: numericSetting(body, 'vector_weight', current.vector_weight, 0, 2),
    keywordWeight: numericSetting(body, 'keyword_weight', current.keyword_weight, 0, 2),
    importanceWeight: numericSetting(body, 'importance_weight', current.importance_weight, 0, 2),
    recencyWeight: numericSetting(body, 'recency_weight', current.recency_weight, 0, 2),
    recencyHalfLifeDays: numericSetting(body, 'recency_half_life_days', current.recency_half_life_days, 1, 3650, true)
  };
  if (!values.name) throw new Error('召回策略名称不能为空');
  if (!values.vectorEnabled && !values.keywordEnabled && !values.graphEnabled) {
    throw new Error('至少启用一种召回通道');
  }
  if (values.catalogMinSimilarity > values.vectorOnlyMinSimilarity) {
    throw new Error('轻量候选目录阈值不能高于纯向量详情阈值');
  }
  db.prepare(`UPDATE retrieval_profiles SET name = ?, vector_enabled = ?, keyword_enabled = ?,
    graph_enabled = ?, intent_filter_enabled = ?, min_similarity = ?, min_keyword_score = ?,
    event_top_k = ?, claim_top_k = ?, edge_top_k = ?, vector_weight = ?, keyword_weight = ?,
    importance_weight = ?, recency_weight = ?, recency_half_life_days = ?,
    catalog_min_similarity = ?, vector_only_min_similarity = ?, planner_enabled = ?,
    planner_max_candidates = ?, graph_hops = ?, updated_at = ?
    WHERE scene_id = ?`).run(
    values.name, values.vectorEnabled, values.keywordEnabled, values.graphEnabled,
    values.intentFilterEnabled, values.minSimilarity, values.minKeywordScore, values.eventTopK,
    values.claimTopK, values.edgeTopK, values.vectorWeight, values.keywordWeight,
    values.importanceWeight, values.recencyWeight, values.recencyHalfLifeDays,
    values.catalogMinSimilarity, values.vectorOnlyMinSimilarity, values.plannerEnabled,
    values.plannerMaxCandidates, values.graphHops, nowIso(), sceneId
  );
  return getRetrievalProfile(sceneId);
}

function saveSchema(body, id = null) {
  const current = id ? db.prepare('SELECT * FROM memory_schemas WHERE id = ?').get(id) : null;
  const key = safeText(body.key ?? current?.key, 100);
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(key)) throw new Error('字段 Key 必须是如 relationship.intimacy 的小写分段格式');
  const values = {
    id: id || uid('schema'),
    key,
    label: safeText(body.label ?? current?.label, 80),
    category: safeText(body.category ?? current?.category ?? '自定义', 80),
    scenarioType: body.scenario_type ?? current?.scenario_type ?? 'all',
    valueType: body.value_type ?? current?.value_type ?? 'string',
    scope: body.scope ?? current?.scope ?? 'user_agent',
    description: safeText(body.description ?? current?.description ?? '', 1000),
    extractionInstruction: safeText(
      body.extraction_instruction ?? current?.extraction_instruction ?? body.description ?? current?.description ?? '',
      2000
    ),
    defaultJson: json(body.default_value ?? parseJson(current?.default_json)),
    constraintsJson: json(body.constraints ?? parseJson(current?.constraints_json, {})),
    promptTemplate: safeText(body.prompt_template ?? current?.prompt_template ?? '', 1000),
    pinned: Number(Boolean(body.pinned ?? current?.pinned)),
    required: Number(Boolean(body.required ?? current?.required)),
    extractionMode: body.extraction_mode ?? current?.extraction_mode ?? 'explicit_only',
    sensitivity: body.sensitivity ?? current?.sensitivity ?? 'normal',
    enabled: Number(Boolean(body.enabled ?? current?.enabled ?? true)),
    sortOrder: Number(body.sort_order ?? current?.sort_order ?? 1000)
  };
  if (!values.label) throw new Error('字段名称不能为空');
  const timestamp = nowIso();
  if (current) {
    db.prepare(`UPDATE memory_schemas SET key = ?, label = ?, category = ?, scenario_type = ?,
      value_type = ?, scope = ?, description = ?, extraction_instruction = ?, default_json = ?,
      constraints_json = ?, prompt_template = ?, pinned = ?, required = ?, extraction_mode = ?,
      sensitivity = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`)
      .run(values.key, values.label, values.category, values.scenarioType, values.valueType, values.scope,
        values.description, values.extractionInstruction, values.defaultJson, values.constraintsJson,
        values.promptTemplate, values.pinned, values.required, values.extractionMode, values.sensitivity,
        values.enabled, values.sortOrder, timestamp, id);
  } else {
    db.prepare(`INSERT INTO memory_schemas
      (id, key, label, category, scenario_type, value_type, scope, description,
       extraction_instruction, default_json, constraints_json, prompt_template, pinned, required,
       extraction_mode, sensitivity, enabled, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(values.id, values.key, values.label, values.category, values.scenarioType, values.valueType,
        values.scope, values.description, values.extractionInstruction, values.defaultJson,
        values.constraintsJson, values.promptTemplate, values.pinned, values.required,
        values.extractionMode, values.sensitivity, values.enabled,
        values.sortOrder, timestamp, timestamp);
  }
  return db.prepare('SELECT * FROM memory_schemas WHERE id = ?').get(values.id);
}

function savePlot(body, id = null) {
  const current = id ? db.prepare('SELECT * FROM plots WHERE id = ?').get(id) : null;
  const row = {
    id: id || uid('plot'),
    agentId: body.agent_id ?? current?.agent_id,
    parentPlotId: safeText(body.parent_plot_id ?? current?.parent_plot_id ?? '', 100),
    branchLabel: safeText(body.branch_label ?? current?.branch_label ?? '主线', 60) || '主线',
    nodeType: safeText(body.node_type ?? current?.node_type ?? 'chapter', 30),
    name: safeText(body.name ?? current?.name, 100),
    premise: safeText(body.premise ?? current?.premise ?? '', 1000),
    instructions: safeText(body.instructions ?? current?.instructions, 10000),
    priority: Number(body.priority ?? current?.priority ?? 50),
    enabled: Number(Boolean(body.enabled ?? current?.enabled ?? true))
  };
  if (!row.agentId || !row.name || !row.instructions) throw new Error('角色、剧情名和剧情指令不能为空');
  if (row.parentPlotId === row.id) throw new Error('剧情节点不能以自己作为前置节点');
  if (!['chapter', 'branch', 'ending'].includes(row.nodeType)) throw new Error('剧情节点类型无效');
  if (row.parentPlotId) {
    const parent = db.prepare('SELECT id FROM plots WHERE id = ? AND agent_id = ?').get(row.parentPlotId, row.agentId);
    if (!parent) throw new Error('前置剧情节点不存在或不属于当前角色');
    const visited = new Set([row.id]);
    let cursor = row.parentPlotId;
    while (cursor) {
      if (visited.has(cursor)) throw new Error('前置剧情不能形成循环分支');
      visited.add(cursor);
      cursor = db.prepare('SELECT parent_plot_id FROM plots WHERE id = ?').get(cursor)?.parent_plot_id || '';
    }
  }
  const timestamp = nowIso();
  if (current) {
    db.prepare(`UPDATE plots SET agent_id = ?, parent_plot_id = ?, branch_label = ?, node_type = ?,
      name = ?, premise = ?, instructions = ?, priority = ?, enabled = ?, updated_at = ? WHERE id = ?`)
      .run(row.agentId, row.parentPlotId, row.branchLabel, row.nodeType, row.name, row.premise,
        row.instructions, row.priority, row.enabled, timestamp, id);
  } else {
    db.prepare(`INSERT INTO plots
      (id, agent_id, parent_plot_id, branch_label, node_type, name, premise, instructions, priority,
       enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.agentId, row.parentPlotId, row.branchLabel, row.nodeType, row.name,
        row.premise, row.instructions, row.priority, row.enabled, timestamp, timestamp);
  }
  return db.prepare('SELECT * FROM plots WHERE id = ?').get(row.id);
}

function saveTrigger(body, id = null) {
  const current = id ? db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) : null;
  const row = {
    id: id || uid('trigger'),
    agentId: body.agent_id ?? current?.agent_id,
    name: safeText(body.name ?? current?.name, 100),
    description: safeText(body.description ?? current?.description ?? '', 1000),
    conditionJson: json(body.condition ?? parseJson(current?.condition_json, {})),
    actionsJson: json(body.actions ?? parseJson(current?.actions_json, [])),
    oncePerUser: Number(Boolean(body.once_per_user ?? current?.once_per_user ?? true)),
    cooldownSeconds: Number(body.cooldown_seconds ?? current?.cooldown_seconds ?? 0),
    priority: Number(body.priority ?? current?.priority ?? 50),
    enabled: Number(Boolean(body.enabled ?? current?.enabled ?? true))
  };
  if (!row.agentId || !row.name) throw new Error('触发器的角色和名称不能为空');
  const timestamp = nowIso();
  if (current) {
    db.prepare(`UPDATE triggers SET agent_id = ?, name = ?, description = ?, condition_json = ?,
      actions_json = ?, once_per_user = ?, cooldown_seconds = ?, priority = ?, enabled = ?,
      updated_at = ? WHERE id = ?`)
      .run(row.agentId, row.name, row.description, row.conditionJson, row.actionsJson, row.oncePerUser,
        row.cooldownSeconds, row.priority, row.enabled, timestamp, id);
  } else {
    db.prepare(`INSERT INTO triggers
      (id, agent_id, name, description, condition_json, actions_json, once_per_user,
       cooldown_seconds, priority, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.agentId, row.name, row.description, row.conditionJson, row.actionsJson,
        row.oncePerUser, row.cooldownSeconds, row.priority, row.enabled, timestamp, timestamp);
  }
  return db.prepare('SELECT * FROM triggers WHERE id = ?').get(row.id);
}

function createFeedback(principal, body) {
  const messageId = safeText(body.message_id, 100).trim();
  const suggestion = safeText(body.suggestion, 2000).trim();
  if (!messageId) throw new HttpError(400, '缺少反馈所属消息', 'MESSAGE_REQUIRED');
  if (!suggestion) throw new HttpError(400, '请填写不满或改进建议', 'SUGGESTION_REQUIRED');
  const target = db.prepare(`SELECT m.*, c.agent_id, c.story_id, c.branch_id, c.title AS conversation_title
    FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`).get(messageId);
  if (!target) throw new HttpError(404, '反馈所属消息不存在', 'MESSAGE_NOT_FOUND');
  assertUserAccess(principal, target.user_id);
  const messages = db.prepare(`SELECT rowid AS ordinal, id, role, content, metadata_json, created_at
    FROM messages WHERE conversation_id = ? ORDER BY rowid`).all(target.conversation_id);
  const targetIndex = messages.findIndex((item) => item.id === target.id);
  let start = targetIndex;
  while (start > 0 && messages[start].role !== 'user') start -= 1;
  let end = Math.max(start, targetIndex);
  while (end + 1 < messages.length && messages[end + 1].role !== 'user') end += 1;
  const turnMessages = messages.slice(start, end + 1);
  const assistantWithTrace = [...turnMessages].reverse().find((item) => {
    const metadata = parseJson(item.metadata_json, {});
    return item.role === 'assistant' && metadata.traceId;
  });
  let traceId = parseJson(assistantWithTrace?.metadata_json, {})?.traceId || '';
  if (!traceId) {
    traceId = db.prepare(`SELECT id FROM traces WHERE conversation_id = ? AND user_id = ?
      AND started_at >= ? ORDER BY started_at LIMIT 1`)
      .get(target.conversation_id, target.user_id, turnMessages[0]?.created_at || target.created_at)?.id || '';
  }
  const timestamp = nowIso();
  const id = uid('feedback');
  const snapshot = {
    conversation: {
      id: target.conversation_id,
      title: target.conversation_title,
      agentId: target.agent_id,
      storyId: target.story_id,
      branchId: target.branch_id
    },
    targetMessageId: target.id,
    messages: turnMessages.map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
      createdAt: item.created_at
    }))
  };
  db.prepare(`INSERT INTO feedback
    (id, user_id, agent_id, conversation_id, target_message_id, target_role, trace_id,
     suggestion, turn_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
    id, target.user_id, target.agent_id, target.conversation_id, target.id, target.role,
    traceId, suggestion, json(snapshot), timestamp, timestamp
  );
  return { id, traceId, capturedMessages: turnMessages.length, status: 'open', createdAt: timestamp };
}

function listAdminUsers() {
  return db.prepare(`SELECT u.id, u.name, u.display_name, u.avatar_color, u.status, u.created_at, u.updated_at,
    ua.username, CASE WHEN ua.user_id IS NULL THEN 0 ELSE 1 END AS can_login,
    (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count,
    (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS message_count,
    (SELECT COUNT(*) FROM memory_values mv WHERE mv.user_id = u.id) AS memory_count,
    (SELECT COUNT(*) FROM feedback f WHERE f.user_id = u.id) AS feedback_count
    FROM users u LEFT JOIN user_accounts ua ON ua.user_id = u.id
    ORDER BY u.created_at DESC`).all();
}

function listAdminFeedback() {
  return decodeRows(db.prepare(`SELECT f.*, u.display_name AS user_name, u.avatar_color,
    a.name AS agent_name, c.title AS conversation_title,
    substr(m.content, 1, 240) AS target_content
    FROM feedback f
    JOIN users u ON u.id = f.user_id
    JOIN agents a ON a.id = f.agent_id
    JOIN conversations c ON c.id = f.conversation_id
    JOIN messages m ON m.id = f.target_message_id
    ORDER BY f.created_at DESC LIMIT 500`).all(), ['turn_json']);
}

async function handleApi(request, response, url) {
  const method = request.method || 'GET';
  const pathname = url.pathname;

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readBody(request);
    const userCount = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
    if (userCount >= REGISTRATION_USER_LIMIT) {
      throw new HttpError(
        409,
        '当前体验用户已满，请联系韩康获得体验账户。',
        'REGISTRATION_USER_LIMIT_REACHED',
        { limit: REGISTRATION_USER_LIMIT }
      );
    }
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);
    const displayName = safeText(body.display_name, 60).trim();
    if (!displayName) throw new HttpError(400, '显示名称不能为空', 'INVALID_DISPLAY_NAME');
    if (db.prepare('SELECT 1 FROM user_accounts WHERE username = ?').get(username)) {
      throw new HttpError(409, '该登录名已被使用', 'USERNAME_EXISTS');
    }
    const userId = uid('user');
    const timestamp = nowIso();
    const salt = crypto.randomBytes(16).toString('hex');
    const digest = passwordDigest(password, salt);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO users (id, name, display_name, avatar_color, created_at, updated_at)
        VALUES (?, ?, ?, '#2563eb', ?, ?)`).run(userId, displayName, displayName, timestamp, timestamp);
      db.prepare(`INSERT INTO user_accounts
        (user_id, username, password_hash, password_salt, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, username, digest, salt, timestamp, timestamp);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw new HttpError(409, '该登录名已被使用', 'USERNAME_EXISTS');
      }
      throw error;
    }
    const session = createUserSession(userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    sendJson(response, 201, { ok: true, role: 'user', user: publicUser(user), expiresAt: session.expiresAt }, {
      'Set-Cookie': [
        cookieHeader(USER_SESSION_COOKIE, session.token, USER_SESSION_SECONDS),
        cookieHeader(ADMIN_SESSION_COOKIE, '', 0)
      ]
    });
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(request);
    const username = normalizeUsername(body.username);
    const account = db.prepare(`SELECT ua.*, u.id, u.name, u.display_name, u.avatar_color, u.status
      FROM user_accounts ua JOIN users u ON u.id = ua.user_id
      WHERE ua.username = ? AND u.status = 'active'`).get(username);
    if (!account || !verifyPassword(String(body.password || ''), account)) {
      sendJson(response, 401, { error: '登录名或密码错误', code: 'INVALID_CREDENTIALS' });
      return;
    }
    const session = createUserSession(account.user_id);
    sendJson(response, 200, { ok: true, role: 'user', user: publicUser(account), expiresAt: session.expiresAt }, {
      'Set-Cookie': [
        cookieHeader(USER_SESSION_COOKIE, session.token, USER_SESSION_SECONDS),
        cookieHeader(ADMIN_SESSION_COOKIE, '', 0)
      ]
    });
    return;
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readBody(request);
    const supplied = Buffer.from(hash(body.password || ''));
    const expected = Buffer.from(hash(config.adminPassword));
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      sendJson(response, 401, { error: '管理员密码错误' });
      return;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const timestamp = nowIso();
    const expiresAt = sessionExpiry(ADMIN_SESSION_SECONDS);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(timestamp);
    db.prepare('INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
      .run(hash(token), expiresAt, timestamp);
    sendJson(response, 200, { ok: true, expiresAt }, {
      'Set-Cookie': [
        cookieHeader(ADMIN_SESSION_COOKIE, token, ADMIN_SESSION_SECONDS),
        cookieHeader(USER_SESSION_COOKIE, '', 0)
      ]
    });
    return;
  }

  if (['/api/auth/logout', '/api/admin/logout'].includes(pathname) && method === 'POST') {
    const cookies = parseCookies(request);
    if (cookies[ADMIN_SESSION_COOKIE]) {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash(cookies[ADMIN_SESSION_COOKIE]));
    }
    if (cookies[USER_SESSION_COOKIE]) {
      db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hash(cookies[USER_SESSION_COOKIE]));
    }
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': clearAuthCookies()
    });
    return;
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    const principal = getPrincipal(request);
    sendJson(response, 200, principal ? {
      authenticated: true,
      role: principal.role,
      username: principal.username || null,
      user: principal.user || null
    } : { authenticated: false, role: null, user: null });
    return;
  }

  if (pathname === '/api/admin/session' && method === 'GET') {
    sendJson(response, 200, { authenticated: getPrincipal(request)?.role === 'admin' });
    return;
  }

  if (pathname === '/api/health' && method === 'GET') {
    sendJson(response, 200, { ok: true, database: 'sqlite', textModel: config.ark.textModel });
    return;
  }

  const principal = requirePrincipal(request, response);
  if (!principal) return;
  if (principal.role === 'user' && !userMayAccessRoute(pathname, method)) {
    requireAdminPrincipal(principal, response);
    return;
  }

  if (pathname === '/api/admin/health/ark' && method === 'POST') {
    sendJson(response, 200, await checkArkHealth());
    return;
  }

  if (pathname === '/api/bootstrap' && method === 'GET') {
    if (principal.role === 'user') {
      sendJson(response, 200, {
        role: 'user',
        users: [principal.user],
        agents: db.prepare('SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at').all(),
        scenes: listScenes(),
        database: { engine: 'SQLite', productionTarget: 'PostgreSQL + pgvector' },
        models: { text: config.ark.textModel, embedding: config.ark.embeddingModel }
      });
      return;
    }
    sendJson(response, 200, {
      role: 'admin',
      users: db.prepare("SELECT * FROM users WHERE status = 'active' ORDER BY created_at").all(),
      agents: db.prepare('SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at').all(),
      scenes: listScenes(),
      database: { engine: 'SQLite', productionTarget: 'PostgreSQL + pgvector' },
      models: { text: config.ark.textModel, embedding: config.ark.embeddingModel }
    });
    return;
  }

  if (pathname === '/api/users' && method === 'GET') {
    sendJson(response, 200, db.prepare('SELECT * FROM users ORDER BY created_at').all());
    return;
  }
  if (pathname === '/api/admin/users' && method === 'GET') {
    sendJson(response, 200, listAdminUsers());
    return;
  }
  if (pathname === '/api/admin/feedback' && method === 'GET') {
    sendJson(response, 200, listAdminFeedback());
    return;
  }
  if (pathname === '/api/users' && method === 'POST') {
    const body = await readBody(request);
    const id = uid('user');
    const timestamp = nowIso();
    const name = safeText(body.name, 60).trim();
    if (!name) throw new Error('用户名不能为空');
    db.prepare(`INSERT INTO users (id, name, display_name, avatar_color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name, safeText(body.display_name || name, 60), body.avatar_color || '#2563eb', timestamp, timestamp);
    sendJson(response, 201, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return;
  }

  if (pathname === '/api/agents' && method === 'GET') {
    sendJson(response, 200, principal.role === 'admin'
      ? db.prepare('SELECT * FROM agents ORDER BY created_at').all()
      : db.prepare('SELECT * FROM agents WHERE enabled = 1 ORDER BY created_at').all());
    return;
  }

  if (pathname === '/api/scenes' && method === 'GET') {
    sendJson(response, 200, listScenes());
    return;
  }
  const memoryProfileMatch = pathname.match(/^\/api\/scenes\/([^/]+)\/memory-profile$/);
  if (memoryProfileMatch && method === 'PUT') {
    sendJson(response, 200, updateMemoryProfile(memoryProfileMatch[1], await readBody(request)));
    return;
  }
  const retrievalProfileMatch = pathname.match(/^\/api\/scenes\/([^/]+)\/retrieval-profile$/);
  if (retrievalProfileMatch && method === 'GET') {
    const profile = getRetrievalProfile(retrievalProfileMatch[1]);
    if (!profile) throw new Error('召回策略不存在');
    sendJson(response, 200, profile);
    return;
  }
  if (retrievalProfileMatch && method === 'PUT') {
    sendJson(response, 200, updateRetrievalProfile(retrievalProfileMatch[1], await readBody(request)));
    return;
  }
  const extractionProfileMatch = pathname.match(/^\/api\/scenes\/([^/]+)\/event-extraction-profile$/);
  if (extractionProfileMatch && method === 'GET') {
    const profile = getEventExtractionProfile(extractionProfileMatch[1]);
    if (!profile) throw new Error('事件抽取配置不存在');
    sendJson(response, 200, profile);
    return;
  }
  if (extractionProfileMatch && method === 'PUT') {
    sendJson(response, 200, updateEventExtractionProfile(extractionProfileMatch[1], await readBody(request)));
    return;
  }
  const extractionContractMatch = pathname.match(/^\/api\/scenes\/([^/]+)\/extraction-contract$/);
  if (extractionContractMatch && method === 'GET') {
    sendJson(response, 200, getExtractionPromptContract(extractionContractMatch[1]));
    return;
  }
  if (pathname === '/api/architecture/overview' && method === 'GET') {
    sendJson(response, 200, architectureOverview(url.searchParams.get('scene_id') || ''));
    return;
  }
  if (pathname === '/api/architecture/ask' && method === 'POST') {
    const body = await readBody(request);
    const startedAt = performance.now();
    const result = await answerArchitectureQuestion(body.question);
    sendJson(response, 200, { ...result, durationMs: Math.round(performance.now() - startedAt) });
    return;
  }
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch && method === 'PUT') {
    sendJson(response, 200, updateAgent(agentMatch[1], await readBody(request)));
    return;
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    const userId = assertUserAccess(principal, url.searchParams.get('user_id'));
    sendJson(response, 200, listConversations(userId, url.searchParams.get('agent_id')));
    return;
  }
  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(request);
    const userId = assertUserAccess(principal, body.user_id);
    sendJson(response, 201, createConversation({
      userId,
      agentId: body.agent_id,
      storyId: body.story_id,
      branchId: body.branch_id,
      title: body.title
    }));
    return;
  }
  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch && method === 'GET') {
    const userId = assertUserAccess(principal, url.searchParams.get('user_id'));
    sendJson(response, 200, getConversationMessages(conversationMatch[1], userId));
    return;
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readBody(request);
    const message = String(body.message || '').trim();
    if (!message) throw new HttpError(400, '消息不能为空', 'EMPTY_MESSAGE');
    const messageCharacters = Array.from(message).length;
    if (messageCharacters > CHAT_MESSAGE_MAX_CHARACTERS) {
      throw new HttpError(
        400,
        `单条消息最多 ${CHAT_MESSAGE_MAX_CHARACTERS} 字，当前为 ${messageCharacters} 字。`,
        'CHAT_MESSAGE_TOO_LONG',
        { limit: CHAT_MESSAGE_MAX_CHARACTERS, actual: messageCharacters }
      );
    }
    const userId = assertUserAccess(principal, body.user_id);
    sendJson(response, 200, await chat({
      userId,
      agentId: body.agent_id,
      conversationId: body.conversation_id || '',
      previousConversationId: body.previous_conversation_id || '',
      message
    }));
    return;
  }

  if (pathname === '/api/feedback' && method === 'POST') {
    sendJson(response, 201, createFeedback(principal, await readBody(request)));
    return;
  }

  if (pathname === '/api/memory/schemas' && method === 'GET') {
    sendJson(response, 200, decodeRows(listMemorySchemas(), ['default_json', 'constraints_json']));
    return;
  }
  if (pathname === '/api/memory/schemas' && method === 'POST') {
    sendJson(response, 201, saveSchema(await readBody(request)));
    return;
  }
  const schemaMatch = pathname.match(/^\/api\/memory\/schemas\/([^/]+)$/);
  if (schemaMatch && method === 'PUT') {
    sendJson(response, 200, saveSchema(await readBody(request), schemaMatch[1]));
    return;
  }

  if (pathname === '/api/memory/values' && method === 'GET') {
    const scope = queryScope(url);
    scope.userId = assertUserAccess(principal, scope.userId);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(scope.agentId);
    if (!scope.userId || !agent) throw new Error('查询记忆需要有效的 user_id 和 agent_id');
    sendJson(response, 200, listMemoryForAdmin(scope, agent.scenario_type));
    return;
  }
  const memoryValueMatch = pathname.match(/^\/api\/memory\/values\/(.+)$/);
  if (memoryValueMatch && method === 'PUT') {
    const body = await readBody(request);
    sendJson(response, 200, setMemoryValue(decodeURIComponent(memoryValueMatch[1]), body.value, {
      userId: body.user_id,
      agentId: body.agent_id,
      storyId: body.story_id || 'main_story',
      branchId: body.branch_id || 'main'
    }, { sourceType: 'admin_manual', reason: body.reason || '管理员手动修改' }));
    return;
  }
  if (pathname === '/api/memory/history' && method === 'GET') {
    const userId = assertUserAccess(principal, url.searchParams.get('user_id'));
    const agentId = url.searchParams.get('agent_id') || '';
    const key = url.searchParams.get('key');
    const rows = db.prepare(`SELECT mh.*, ms.key, ms.label, mv.agent_id, mv.story_id, mv.branch_id
      FROM memory_history mh
      JOIN memory_schemas ms ON ms.id = mh.schema_id
      JOIN memory_values mv ON mv.id = mh.memory_value_id
      WHERE mh.user_id = ? AND (mv.agent_id = '' OR mv.agent_id = ?)
        AND (? = '' OR ms.key = ?) ORDER BY mh.created_at DESC LIMIT 200`)
      .all(userId, agentId, key || '', key || '');
    sendJson(response, 200, decodeRows(rows, ['old_value_json', 'new_value_json']));
    return;
  }
  if (pathname === '/api/memory/graph' && method === 'GET') {
    const scope = queryScope(url);
    scope.userId = assertUserAccess(principal, scope.userId);
    sendJson(response, 200, listGraph(scope));
    return;
  }
  if (pathname === '/api/memory/events' && method === 'GET') {
    const scope = queryScope(url);
    scope.userId = assertUserAccess(principal, scope.userId);
    sendJson(response, 200, listEvents(scope, {
      includeHistory: url.searchParams.get('include_history') === 'true',
      order: url.searchParams.get('order') === 'created' ? 'created' : 'story'
    }));
    return;
  }
  if (pathname === '/api/memory/retrieval-test' && method === 'POST') {
    const body = await readBody(request);
    const query = safeText(body.query, 12000).trim();
    const scope = {
      userId: assertUserAccess(principal, body.user_id),
      agentId: body.agent_id || '',
      storyId: body.story_id || 'main_story',
      branchId: body.branch_id || 'main'
    };
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND status = 'active'").get(scope.userId);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ? AND enabled = 1').get(scope.agentId);
    if (!query) throw new Error('请输入召回测试 Query');
    if (!user || !agent) throw new Error('召回测试需要有效的用户和角色');
    let contextMessages = [];
    if (body.conversation_id) {
      const conversation = db.prepare(`SELECT * FROM conversations
        WHERE id = ? AND user_id = ? AND agent_id = ?`).get(body.conversation_id, scope.userId, scope.agentId);
      if (conversation) {
        contextMessages = db.prepare(`SELECT role, content, created_at FROM (
          SELECT role, content, created_at FROM messages WHERE conversation_id = ?
          ORDER BY created_at DESC LIMIT 6) ORDER BY created_at`).all(conversation.id);
      }
    }
    const startedAt = performance.now();
    const retrieval = await retrieveMemory(query, scope, { contextMessages });
    const scene = db.prepare('SELECT id, name FROM scenes WHERE id = ?').get(agent.scene_id);
    sendJson(response, 200, {
      query,
      scope,
      scene,
      durationMs: Math.round(performance.now() - startedAt),
      retrieval,
      injectionPreview: formatRetrievedMemory(retrieval)
    });
    return;
  }

  if (pathname === '/api/plots' && method === 'GET') {
    sendJson(response, 200, listPlots(url.searchParams.get('agent_id')));
    return;
  }
  if (pathname === '/api/plots' && method === 'POST') {
    sendJson(response, 201, savePlot(await readBody(request)));
    return;
  }
  const plotMatch = pathname.match(/^\/api\/plots\/([^/]+)$/);
  if (plotMatch && method === 'PUT') {
    sendJson(response, 200, savePlot(await readBody(request), plotMatch[1]));
    return;
  }

  if (pathname === '/api/triggers' && method === 'GET') {
    sendJson(response, 200, decodeRows(listTriggers(url.searchParams.get('agent_id')), ['condition_json', 'actions_json']));
    return;
  }
  if (pathname === '/api/triggers' && method === 'POST') {
    sendJson(response, 201, saveTrigger(await readBody(request)));
    return;
  }
  const triggerMatch = pathname.match(/^\/api\/triggers\/([^/]+)$/);
  if (triggerMatch && method === 'PUT') {
    sendJson(response, 200, saveTrigger(await readBody(request), triggerMatch[1]));
    return;
  }

  if (pathname === '/api/tools' && method === 'GET') {
    sendJson(response, 200, decodeRows(listTools(), ['input_schema_json', 'config_json']));
    return;
  }

  if (pathname === '/api/traces' && method === 'GET') {
    const conversationId = url.searchParams.get('conversation_id');
    const conversation = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversationId);
    if (!conversation) throw new HttpError(404, '会话不存在', 'CONVERSATION_NOT_FOUND');
    assertUserAccess(principal, conversation.user_id);
    sendJson(response, 200, listTraces(conversationId, url.searchParams.get('limit') || 50));
    return;
  }
  const traceMatch = pathname.match(/^\/api\/traces\/([^/]+)$/);
  if (traceMatch && method === 'GET') {
    const trace = getTrace(traceMatch[1]);
    if (!trace) {
      sendJson(response, 404, { error: 'Trace 不存在' });
      return;
    }
    assertUserAccess(principal, trace.user_id);
    sendJson(response, 200, trace);
    return;
  }

  sendJson(response, 404, { error: '接口不存在' });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendJson(response, 404, { error: '页面不存在' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  });
  if (filePath === path.join(publicDir, 'index.html')) {
    const markup = fs.readFileSync(filePath, 'utf8').replaceAll('__APP_BASE_PATH__', config.basePath);
    response.end(markup);
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  try {
    if (config.basePath && url.pathname === config.basePath) {
      response.writeHead(308, { Location: `${config.basePath}/` });
      response.end();
      return;
    }
    const routedUrl = new URL(url);
    if (config.basePath && url.pathname.startsWith(`${config.basePath}/`)) {
      routedUrl.pathname = url.pathname.slice(config.basePath.length) || '/';
    }
    if (routedUrl.pathname.startsWith('/api/')) await handleApi(request, response, routedUrl);
    else serveStatic(response, routedUrl.pathname);
  } catch (error) {
    sendJson(response, error.status || 400, {
      error: error.message || '请求处理失败',
      code: error.code || 'REQUEST_FAILED',
      ...(error.details ? { details: error.details } : {})
    });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Memory Agent Studio: http://127.0.0.1:${config.port}${config.basePath || '/'}`);
  });
}
