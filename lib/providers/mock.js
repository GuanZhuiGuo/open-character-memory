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

export async function generateText({ systemPrompt = '', messages }) {
  const structured = mockJson(systemPrompt, messages);
  const userText = [...messages].reverse().find((message) => message.role === 'user')?.content || '';
  return {
    text: structured || (userText ? `我听见了：${String(userText).slice(0, 160)}。我们可以从这里继续。` : '我在这里。'),
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
