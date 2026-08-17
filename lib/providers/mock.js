import { config } from '../config.js';
import { localEmbedding } from '../utils.js';

function mockJson(systemPrompt, messages) {
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
  if (systemPrompt.includes('只输出严格 JSON')) {
    return JSON.stringify({ structured_updates: [], relationship_deltas: [], events: [] });
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
