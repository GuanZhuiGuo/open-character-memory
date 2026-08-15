import { config } from '../config.js';
import { normalizeUsage, postJson, responseInput, responseText } from './shared.js';

async function post(path, body, timeoutMs = 60000) {
  if (!config.openai.apiKey) throw new Error('OPENAI_API_KEY 未配置');
  return postJson({
    url: `${config.openai.baseUrl}${path}`,
    headers: { Authorization: `Bearer ${config.openai.apiKey}` },
    body,
    timeoutMs,
    providerLabel: 'OpenAI'
  });
}

export async function generateText({ systemPrompt, messages, temperature = 0.7, maxOutputTokens = 1200 }) {
  const payload = await post('/responses', {
    model: config.openai.textModel,
    temperature,
    max_output_tokens: maxOutputTokens,
    input: responseInput(systemPrompt, messages)
  });
  const text = responseText(payload).trim();
  if (!text) throw new Error('OpenAI 文本模型未返回可读文本');
  const usage = normalizeUsage(payload);
  return {
    text,
    provider: 'openai',
    model: payload.model || config.openai.textModel,
    usage,
    cache: {
      mode: 'provider_managed',
      status: usage.cachedTokens > 0 ? 'hit' : 'miss',
      cachedTokens: usage.cachedTokens,
      inputTokens: usage.inputTokens,
      hitRate: usage.cacheHitRate
    },
    responseId: payload.id || ''
  };
}

export async function embedText(text) {
  const payload = await post('/embeddings', {
    model: config.openai.embeddingModel,
    input: String(text).slice(0, 12000)
  }, 45000);
  const vector = payload?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error('OpenAI 向量响应中没有 embedding');
  return { vector, model: payload.model || config.openai.embeddingModel, provider: 'openai', fallback: false };
}
