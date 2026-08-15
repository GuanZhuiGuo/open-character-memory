import { db } from './db.js';
import { getMemoryValue, setMemoryValue } from './memory.js';
import { json, nowIso, parseJson, uid } from './utils.js';

function compare(actual, operator, expected) {
  switch (operator) {
    case '>=': return Number(actual) >= Number(expected);
    case '>': return Number(actual) > Number(expected);
    case '<=': return Number(actual) <= Number(expected);
    case '<': return Number(actual) < Number(expected);
    case '!=': return actual !== expected;
    case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual || '').includes(String(expected));
    case 'in': return Array.isArray(expected) && expected.includes(actual);
    case 'exists': return actual !== null && actual !== undefined && actual !== '';
    case '=':
    case '==':
    default: return actual === expected;
  }
}

function evaluateNode(node, scope) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.all)) return node.all.every((child) => evaluateNode(child, scope));
  if (Array.isArray(node.any)) return node.any.some((child) => evaluateNode(child, scope));
  if (node.not) return !evaluateNode(node.not, scope);
  if (node.memory_key) {
    const actual = getMemoryValue(node.memory_key, scope)?.value;
    return compare(actual, node.operator || '==', node.value);
  }
  if (node.plot_id) {
    const plotState = db.prepare(`SELECT status FROM user_plot_states
      WHERE user_id = ? AND plot_id = ? AND story_id = ? AND branch_id = ?`)
      .get(scope.userId, node.plot_id, scope.storyId, scope.branchId);
    return compare(plotState?.status || 'locked', node.operator || '==', node.value || 'unlocked');
  }
  if (node.prop_id) {
    const propState = db.prepare(`SELECT status FROM user_prop_states
      WHERE user_id = ? AND prop_id = ? AND story_id = ? AND branch_id = ?`)
      .get(scope.userId, node.prop_id, scope.storyId, scope.branchId);
    return compare(propState?.status || 'locked', node.operator || '==', node.value || 'unlocked');
  }
  return false;
}

function unlockPlot(action, scope) {
  const plot = db.prepare('SELECT * FROM plots WHERE id = ? AND enabled = 1').get(action.plot_id);
  if (!plot) throw new Error(`未找到剧情：${action.plot_id}`);
  const current = db.prepare(`SELECT * FROM user_plot_states WHERE user_id = ? AND plot_id = ?
    AND story_id = ? AND branch_id = ?`).get(scope.userId, plot.id, scope.storyId, scope.branchId);
  const timestamp = nowIso();
  if (current) {
    db.prepare(`UPDATE user_plot_states SET status = 'unlocked', unlocked_at = COALESCE(unlocked_at, ?)
      WHERE id = ?`).run(timestamp, current.id);
  } else {
    db.prepare(`INSERT INTO user_plot_states
      (id, user_id, plot_id, story_id, branch_id, status, unlocked_at)
      VALUES (?, ?, ?, ?, ?, 'unlocked', ?)`)
      .run(uid('ups'), scope.userId, plot.id, scope.storyId, scope.branchId, timestamp);
  }
  return { plotId: plot.id, plotName: plot.name, status: 'unlocked' };
}

function unlockProp(action, scope) {
  const prop = db.prepare(`SELECT * FROM capability_props
    WHERE id = ? AND agent_id = ? AND status = 'enabled'`).get(action.prop_id, scope.agentId);
  if (!prop) throw new Error(`道具不存在、未审核或不属于当前角色：${action.prop_id}`);
  const current = db.prepare(`SELECT * FROM user_prop_states WHERE user_id = ? AND prop_id = ?
    AND story_id = ? AND branch_id = ?`).get(scope.userId, prop.id, scope.storyId, scope.branchId);
  const timestamp = nowIso();
  if (current) {
    db.prepare(`UPDATE user_prop_states SET status = 'unlocked', unlocked_at = COALESCE(unlocked_at, ?)
      WHERE id = ?`).run(timestamp, current.id);
  } else {
    db.prepare(`INSERT INTO user_prop_states
      (id, user_id, prop_id, story_id, branch_id, status, unlocked_at)
      VALUES (?, ?, ?, ?, ?, 'unlocked', ?)`)
      .run(uid('upr'), scope.userId, prop.id, scope.storyId, scope.branchId, timestamp);
  }
  return { propId: prop.id, propName: prop.name, packageType: prop.package_type, status: 'unlocked' };
}

function runBuiltinTool(tool, args, scope, conversationId) {
  switch (tool.key) {
    case 'unlock_story_chapter':
      return unlockPlot({ plot_id: args.plot_id }, scope);
    case 'create_reminder':
      return { accepted: true, reminder: { title: args.title, dueAt: args.due_at || '', state: 'pending_external_delivery' } };
    case 'schedule_learning_review':
      return {
        accepted: true,
        review: { knowledgePoint: args.knowledge_point, dueInDays: args.due_in_days || 1, state: 'scheduled' }
      };
    default:
      return { accepted: false, reason: `未实现的内置工具：${tool.key}` };
  }
}

export function executeTool(toolKey, args, scope, conversationId) {
  const tool = db.prepare('SELECT * FROM tools WHERE key = ? AND enabled = 1').get(toolKey);
  if (!tool) throw new Error(`工具不存在或已停用：${toolKey}`);
  const timestamp = nowIso();
  let result;
  let status = 'success';
  try {
    result = tool.handler_type === 'builtin'
      ? runBuiltinTool(tool, args || {}, scope, conversationId)
      : { accepted: false, reason: '当前版本尚未开启外部 webhook 执行' };
  } catch (error) {
    status = 'error';
    result = { error: error.message };
  }
  db.prepare(`INSERT INTO tool_runs
    (id, tool_id, user_id, conversation_id, arguments_json, result_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid('toolrun'), tool.id, scope.userId, conversationId, json(args || {}), json(result), status, timestamp);
  return { toolKey, toolName: tool.name, status, result };
}

export function evaluateTriggers(scope, conversationId) {
  const triggers = db.prepare(`SELECT * FROM triggers WHERE agent_id = ? AND enabled = 1 ORDER BY priority DESC`)
    .all(scope.agentId);
  const evaluated = [];
  const fired = [];
  for (const trigger of triggers) {
    const condition = parseJson(trigger.condition_json, {});
    const matched = evaluateNode(condition, scope);
    const previous = db.prepare(`SELECT * FROM trigger_runs WHERE trigger_id = ? AND user_id = ?
      ORDER BY created_at DESC LIMIT 1`).get(trigger.id, scope.userId);
    let eligible = matched;
    let reason = matched ? '条件匹配' : '条件未匹配';
    if (eligible && trigger.once_per_user && previous?.status === 'success') {
      eligible = false;
      reason = '该用户已触发过一次';
    }
    if (eligible && previous && trigger.cooldown_seconds > 0) {
      const elapsed = (Date.now() - new Date(previous.created_at).getTime()) / 1000;
      if (elapsed < trigger.cooldown_seconds) {
        eligible = false;
        reason = '仍在冷却期';
      }
    }
    evaluated.push({ id: trigger.id, name: trigger.name, matched, eligible, reason, condition });
    if (!eligible) continue;

    const results = [];
    let status = 'success';
    for (const action of parseJson(trigger.actions_json, [])) {
      try {
        if (action.type === 'memory_update') {
          results.push(setMemoryValue(action.key, action.value, scope, {
            sourceType: 'trigger', reason: `触发器：${trigger.name}`
          }));
        } else if (action.type === 'unlock_plot') {
          results.push(unlockPlot(action, scope));
        } else if (action.type === 'unlock_prop') {
          results.push(unlockProp(action, scope));
        } else if (action.type === 'tool_call') {
          results.push(executeTool(action.tool_key, action.arguments || {}, scope, conversationId));
        }
      } catch (error) {
        status = 'error';
        results.push({ action, error: error.message });
      }
    }
    db.prepare(`INSERT INTO trigger_runs
      (id, trigger_id, user_id, conversation_id, status, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(uid('trun'), trigger.id, scope.userId, conversationId, status, json(results), nowIso());
    fired.push({ id: trigger.id, name: trigger.name, status, results });
  }
  return { evaluated, fired };
}

export function getActivePlots(scope) {
  const rows = db.prepare(`SELECT p.*, ups.status AS user_status, ups.progress, ups.unlocked_at
    FROM user_plot_states ups JOIN plots p ON p.id = ups.plot_id
    WHERE ups.user_id = ? AND p.agent_id = ? AND ups.story_id = ? AND ups.branch_id = ?
      AND p.enabled = 1 AND ups.status IN ('unlocked', 'active')
    ORDER BY p.priority DESC`).all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const currentGender = getMemoryValue('identity.gender', scope)?.value || '';
  return rows.map((row) => ({ ...row, audience_genders: parseJson(row.audience_genders_json, []) }))
    .filter((row) => !row.audience_genders.length || row.audience_genders.includes(currentGender));
}

export function getActiveProps(scope) {
  return db.prepare(`SELECT cp.id, cp.key, cp.name, cp.description, cp.package_type, cp.manifest_json,
      cp.version, cp.risk_level, ups.status AS user_status, ups.unlocked_at
    FROM user_prop_states ups JOIN capability_props cp ON cp.id = ups.prop_id
    WHERE ups.user_id = ? AND cp.agent_id = ? AND ups.story_id = ? AND ups.branch_id = ?
      AND cp.status = 'enabled' AND ups.status IN ('unlocked', 'active')
    ORDER BY ups.unlocked_at DESC, cp.name`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId)
    .map((row) => ({ ...row, manifest: parseJson(row.manifest_json, {}) }));
}

export function listPlots(agentId, scope = null) {
  const rows = db.prepare('SELECT * FROM plots WHERE agent_id = ? ORDER BY priority DESC, created_at DESC').all(agentId);
  return rows.map((row) => {
    const userState = scope ? db.prepare(`SELECT status, progress, unlocked_at, completed_at
      FROM user_plot_states WHERE user_id = ? AND plot_id = ? AND story_id = ? AND branch_id = ?`)
      .get(scope.userId, row.id, scope.storyId, scope.branchId) : null;
    return {
      ...row,
      audience_genders: parseJson(row.audience_genders_json, []),
      user_status: userState?.status || 'locked',
      user_progress: Number(userState?.progress || 0),
      unlocked_at: userState?.unlocked_at || null,
      completed_at: userState?.completed_at || null
    };
  });
}

export function listTriggers(agentId) {
  return db.prepare('SELECT * FROM triggers WHERE agent_id = ? ORDER BY priority DESC, created_at DESC').all(agentId);
}

export function listTools() {
  return db.prepare('SELECT * FROM tools ORDER BY name').all();
}

export function listProps(agentId, scope = null, { includeDrafts = false } = {}) {
  const rows = db.prepare(`SELECT id, agent_id, key, name, description, package_type, manifest_json,
      file_name, content_hash, version, status, risk_level, created_at, updated_at
    FROM capability_props WHERE agent_id = ? ${includeDrafts ? '' : "AND status = 'enabled'"}
    ORDER BY updated_at DESC, name`).all(agentId);
  return rows.map((row) => {
    const userState = scope ? db.prepare(`SELECT status, unlocked_at, metadata_json
      FROM user_prop_states WHERE user_id = ? AND prop_id = ? AND story_id = ? AND branch_id = ?`)
      .get(scope.userId, row.id, scope.storyId, scope.branchId) : null;
    return {
      ...row,
      manifest: parseJson(row.manifest_json, {}),
      user_status: userState?.status || 'locked',
      unlocked_at: userState?.unlocked_at || null,
      user_metadata: parseJson(userState?.metadata_json, {})
    };
  });
}
