import { config } from '../config.js';
import { normalizeUsage, postJson, responseText } from './shared.js';

export async function generateText({
  systemPrompt, stableSystemPrompt = '', dynamicSystemPrompt = '', messages,
  temperature = 0.7, maxOutputTokens = 1200
}) {
  if (!config.anthropic.apiKey) throw new Error('ANTHROPIC_API_KEY 未配置');
  const stable = stableSystemPrompt || systemPrompt;
  const system = [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } }];
  if (dynamicSystemPrompt) system.push({ type: 'text', text: dynamicSystemPrompt });
  const payload = await postJson({
    url: `${config.anthropic.baseUrl}/messages`,
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': config.anthropic.version
    },
    body: {
      model: config.anthropic.textModel,
      system,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature,
      max_tokens: maxOutputTokens
    },
    providerLabel: 'Anthropic'
  });
  const text = responseText(payload).trim();
  if (!text) throw new Error('Anthropic 文本模型未返回可读文本');
  const usage = normalizeUsage(payload);
  return {
    text,
    provider: 'anthropic',
    model: payload.model || config.anthropic.textModel,
    usage,
    cache: {
      mode: 'provider_managed',
      status: usage.cachedTokens > 0 ? 'hit' : usage.cacheCreationTokens > 0 ? 'miss_created' : 'miss',
      cachedTokens: usage.cachedTokens,
      inputTokens: usage.inputTokens,
      hitRate: usage.cacheHitRate
    },
    responseId: payload.id || ''
  };
}
