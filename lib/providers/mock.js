import { config } from '../config.js';
import { localEmbedding } from '../utils.js';

function mockJson(systemPrompt, messages) {
  if (systemPrompt.includes('你负责生成可追溯的历史对话辅助摘要')) {
    const input = JSON.parse(messages.at(-1)?.content || '{}');
    const fragments = (input.messages || []).slice(-4).map((message) =>
      `${message.role === 'user' ? '用户原话' : '助手原话'} ${String(message.content || '').slice(0, 80)}`
    );
    const source = [
      '模拟摘要，仅用于验证流程。',
      String(input.previous_summary || '').slice(-120),
      ...fragments
    ].filter(Boolean).join('\n');
    const characterBudget = Math.max(1, Math.floor(Number(input.max_summary_estimated_tokens || 1000) / 1.5));
    return JSON.stringify({ summary: Array.from(source).slice(0, characterBudget).join('') });
  }
  if (systemPrompt.includes('用户长期回复规则分类器')) {
    const input = JSON.parse(messages.at(-1)?.content || '{}');
    const text = String(input.user_text || '');
    const must = [...text.matchAll(/(?:必须|一定要)([^。！？!?,，]{1,60})/g)].map((match) => match[1].trim());
    const avoid = [...text.matchAll(/(?:不要|别再|避免)([^。！？!?,，]{1,60})/g)].map((match) => match[1].trim());
    return JSON.stringify({
      decision: must.length || avoid.length ? 'persist' : 'none',
      must_add: must,
      avoid_add: avoid,
      must_remove: [],
      avoid_remove: [],
      rejected: [],
      reason: 'Mock 模式显式规则分类'
    });
  }
  if (systemPrompt.includes('记忆召回规划器')) {
    const input = JSON.parse(messages.at(-1)?.content || '{}');
    if (input.retrieval_state?.initial_catalog_empty
      && String(input.query || '').includes('纠正式召回测试')) {
      return JSON.stringify({
        decision: 'retry',
        expand_event_ids: [],
        entity_names: [],
        follow_up_queries: ['蓝色星星纪念物'],
        reason: 'Mock 模式验证零候选 Query 改写与跨池召回'
      });
    }
    return JSON.stringify({
      decision: 'none', expand_event_ids: [], entity_names: [], follow_up_queries: [],
      reason: 'Mock 模式不执行模型二次展开'
    });
  }
  if (systemPrompt.includes('长期记忆上下文过滤器')) {
    const input = JSON.parse(messages.at(-1)?.content || '{}');
    const forceDrop = String(input.query || '').includes('过滤器证据保护测试');
    return JSON.stringify({
      keep_event_ids: forceDrop
        ? [] : (input.candidate_events || []).map((item) => item.event_id),
      evidence_sufficient: true,
      reason: forceDrop ? 'Mock 模式尝试删除全部候选' : 'Mock 模式保留全部候选'
    });
  }
  if (systemPrompt.includes('长期记忆证据充分性校验器')) {
    const input = JSON.parse(messages.at(-1)?.content || '{}');
    const query = String(input.query || '');
    const claims = input.current_active_evidence?.claims || [];
    const roleClaims = claims.filter((claim) => /(?:role|position|职位|岗位|身份)/i.test(claim.predicate || ''));
    const explicitRolePremise = /(?:new\s+role\s+as|\bas\s+(?:a|an|the)?|(?:作为|担任|新职位是))\s*([\p{L}\p{N} _-]{2,80})/iu.exec(query)?.[1] || '';
    const conflicting = explicitRolePremise ? roleClaims.filter((claim) =>
      !explicitRolePremise.toLowerCase().includes(String(claim.object || '').toLowerCase())
      && !String(claim.object || '').toLowerCase().includes(explicitRolePremise.toLowerCase())) : [];
    const currentQuestion = /(?:当前|现在|目前|currently|right now)/i.test(query);
    const onlyPlans = claims.length > 0 && claims.every((claim) =>
      ['intended', 'planned', 'scheduled', 'in_progress'].includes(claim.state_phase));
    const openRecommendation = /(?:推荐|建议|recommend|suggest)/i.test(query);
    const status = conflicting.length ? 'conflicted'
      : (currentQuestion && onlyPlans ? 'partial'
        : (openRecommendation ? 'supplemental' : (claims.length ? 'supported' : 'insufficient')));
    return JSON.stringify({
      status,
      supporting_claim_ids: conflicting.length ? [] : claims.map((claim) => claim.claim_id),
      conflicting_claim_ids: conflicting.map((claim) => claim.claim_id),
      reason: conflicting.length ? '问题角色前提与当前职位证据不一致' : 'Mock 模式证据校验'
    });
  }
  if (systemPrompt.includes('只输出严格 JSON')) {
    return JSON.stringify({
      structured_updates: [], relationship_deltas: [], semantic_claims: [], events: []
    });
  }
  return '';
}

function defaultToolArguments(schema = {}, userText = '') {
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.fromEntries(required.map((key) => {
    const property = properties[key] || {};
    if (property.default !== undefined) return [key, property.default];
    if (property.type === 'number' || property.type === 'integer') return [key, 1];
    if (property.type === 'boolean') return [key, true];
    if (property.type === 'array') return [key, []];
    if (property.type === 'object') return [key, {}];
    return [key, String(userText).slice(0, 300) || '测试'];
  }));
}

function requestedTool(tools, userText) {
  const text = String(userText || '').toLowerCase();
  if (!/(?:请|帮我|用|使用|调用|查|搜|生成|发送|执行|please|use|call|search|send|create)/i.test(text)) return null;
  const exact = (tools || []).find((tool) => {
    const name = String(tool.name || '').toLowerCase();
    return name && text.includes(name);
  });
  if (exact) return exact;
  return (tools || []).find((tool) => {
    const name = String(tool.name || '').toLowerCase();
    return name.split(/[_-]+/).some((part) => part.length >= 4 && text.includes(part));
  }) || null;
}

export async function generateText({ systemPrompt = '', messages, tools = [] }) {
  const structured = mockJson(systemPrompt, messages);
  const userText = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  const toolResult = messages.at(-1)?.role === 'toolResult' ? messages.at(-1) : null;
  const tool = !structured && !toolResult ? requestedTool(tools, userText) : null;
  const visibleToolResult = String(toolResult?.content || '').split(/\r?\n/)
    .filter((line) => !/^\s*\[[^\]]+\]\s*$/.test(line)).join('\n').trim().slice(0, 240);
  const text = structured
    || (toolResult
      ? `能力 ${toolResult.toolName || ''} 已执行完成。${visibleToolResult}`
      : tool ? ''
        : userText ? `我听见了：${String(userText).slice(0, 160)}。我们可以从这里继续。` : '我在这里。');
  return {
    text,
    toolCalls: tool ? [{
      id: `mock_tool_${Date.now()}`,
      name: tool.name,
      arguments: defaultToolArguments(tool.parameters, userText)
    }] : [],
    provider: 'mock',
    model: config.mock.textModel,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, cacheHitRate: 0 },
    cache: { mode: 'mock', status: 'disabled', cachedTokens: 0, inputTokens: 0, hitRate: 0 },
    responseId: ''
  };
}

export async function embedText(text) {
  return {
    vector: localEmbedding(text),
    model: config.mock.embeddingModel,
    provider: 'mock',
    fallback: false
  };
}
