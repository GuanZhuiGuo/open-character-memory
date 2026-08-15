import { config } from '../config.js';
import {
  getPrefixCache, getPrefixCacheCooldown, invalidatePrefixCache, markPrefixCacheUsed,
  savePrefixCache, savePrefixCacheFailure
} from '../prefix-cache.js';
import { hash, localEmbedding } from '../utils.js';
import { chatMessages, normalizeUsage, postJson, responseInput, responseText } from './shared.js';

async function post(path, body, timeoutMs = 60000) {
  if (!config.ark.apiKey) throw new Error('ARK_API_KEY 未配置');
  return postJson({
    url: `${config.ark.baseUrl}${path}`,
    headers: { Authorization: `Bearer ${config.ark.apiKey}` },
    body,
    timeoutMs,
    providerLabel: 'Ark'
  });
}

function cacheResult(status, cacheKey, contextId, usage, error = '') {
  return {
    mode: 'common_prefix',
    status,
    key: cacheKey.slice(0, 16),
    contextId: contextId ? contextId.slice(-12) : '',
    cachedTokens: usage.cachedTokens,
    inputTokens: usage.inputTokens,
    hitRate: usage.cacheHitRate,
    error
  };
}

async function regularResponse({ systemPrompt, messages, temperature, maxOutputTokens, cache }) {
  const payload = await post('/responses', {
    model: config.ark.textModel,
    stream: false,
    temperature,
    max_output_tokens: maxOutputTokens,
    input: responseInput(systemPrompt, messages)
  });
  const text = responseText(payload).trim();
  if (!text) throw new Error('Ark 文本模型未返回可读文本');
  const usage = normalizeUsage(payload);
  return {
    text,
    provider: 'ark',
    model: payload.model || config.ark.textModel,
    usage,
    cache: cache || { mode: 'off', status: 'disabled', cachedTokens: usage.cachedTokens, inputTokens: usage.inputTokens, hitRate: usage.cacheHitRate },
    responseId: payload.id || ''
  };
}

export async function generateText({
  systemPrompt, stableSystemPrompt = '', dynamicSystemPrompt = '', messages,
  temperature = 0.7, maxOutputTokens = 1200, cache = null
}) {
  const cacheEnabled = config.ark.prefixCacheMode === 'common_prefix'
    && stableSystemPrompt && dynamicSystemPrompt && cache?.key;
  if (!cacheEnabled) {
    return regularResponse({ systemPrompt, messages, temperature, maxOutputTokens });
  }

  const cacheKey = hash(`ark:${config.ark.textModel}:${cache.key}`);
  const cacheRecord = {
    cacheKey,
    provider: 'ark',
    model: config.ark.textModel,
    agentId: cache.agentId,
    profileVersion: cache.profileVersion,
    sceneConfigVersion: cache.sceneConfigVersion,
    promptHash: cache.promptHash
  };
  const cooldown = getPrefixCacheCooldown(cacheKey);
  if (cooldown) {
    return regularResponse({
      systemPrompt,
      messages,
      temperature,
      maxOutputTokens,
      cache: cacheResult('cooldown', cacheKey, '', { cachedTokens: 0, inputTokens: 0, cacheHitRate: 0 }, cooldown.last_error)
    });
  }
  let row = getPrefixCache(cacheKey);
  let created = false;
  try {
    if (!row) {
      const context = await post('/context/create', {
        model: config.ark.textModel,
        mode: 'common_prefix',
        ttl: config.ark.prefixCacheTtlSeconds,
        messages: [{ role: 'system', content: stableSystemPrompt }]
      });
      const contextId = context.id || context.context_id;
      if (!contextId) throw new Error('Ark Context API 未返回 context id');
      savePrefixCache({
        ...cacheRecord,
        contextId,
        expiresAt: new Date(Date.now() + config.ark.prefixCacheTtlSeconds * 1000).toISOString()
      });
      row = getPrefixCache(cacheKey);
      created = true;
    }
    const payload = await post('/context/chat/completions', {
      model: config.ark.textModel,
      context_id: row.context_id,
      messages: [{ role: 'system', content: dynamicSystemPrompt }, ...chatMessages(messages)],
      stream: false,
      temperature,
      max_tokens: maxOutputTokens
    });
    const text = responseText(payload).trim();
    if (!text) throw new Error('Ark Context API 未返回可读文本');
    const usage = normalizeUsage(payload);
    if (!created) markPrefixCacheUsed(cacheKey);
    return {
      text,
      provider: 'ark',
      model: payload.model || config.ark.textModel,
      usage,
      cache: cacheResult(created ? 'miss_created' : 'hit', cacheKey, row.context_id, usage),
      responseId: payload.id || ''
    };
  } catch (error) {
    if (row) invalidatePrefixCache(cacheKey, error.message);
    else savePrefixCacheFailure(cacheRecord, error.message);
    return regularResponse({
      systemPrompt,
      messages,
      temperature,
      maxOutputTokens,
      cache: cacheResult('fallback', cacheKey, row?.context_id || '', { cachedTokens: 0, inputTokens: 0, cacheHitRate: 0 }, error.message)
    });
  }
}

export async function embedText(text) {
  try {
    const payload = await post('/embeddings/multimodal', {
      model: config.ark.embeddingModel,
      input: [{ type: 'text', text: String(text).slice(0, 12000) }]
    }, 45000);
    const vector = payload?.data?.[0]?.embedding
      || payload?.data?.embedding
      || payload?.embedding
      || payload?.output?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) throw new Error('向量响应中没有 embedding');
    return { vector, model: payload.model || config.ark.embeddingModel, provider: 'ark', fallback: false };
  } catch (error) {
    return {
      vector: localEmbedding(text),
      model: 'local-hash-embedding-v1',
      provider: 'local',
      fallback: true,
      fallbackReason: error.message
    };
  }
}
