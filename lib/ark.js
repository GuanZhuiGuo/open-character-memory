import { config } from './config.js';
import { localEmbedding } from './utils.js';

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  if (Array.isArray(payload?.output)) {
    const chunks = [];
    for (const item of payload.output) {
      if (typeof item?.text === 'string') chunks.push(item.text);
      for (const content of item?.content || []) {
        if (typeof content?.text === 'string') chunks.push(content.text);
      }
    }
    if (chunks.length) return chunks.join('\n');
  }
  const choiceContent = payload?.choices?.[0]?.message?.content;
  if (typeof choiceContent === 'string') return choiceContent;
  if (Array.isArray(choiceContent)) return choiceContent.map((item) => item.text || '').join('');
  return '';
}

async function post(path, body, timeoutMs = 60000) {
  if (!config.ark.apiKey) throw new Error('ARK_API_KEY 未配置');
  const response = await fetch(`${config.ark.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ark.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Ark API 返回了非 JSON 内容 (${response.status})`);
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`Ark API ${response.status}: ${detail}`);
  }
  return payload;
}

export async function generateText({ systemPrompt, messages, temperature = 0.7, maxOutputTokens = 1200 }) {
  const input = [
    { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
    ...messages.map((message) => ({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }]
    }))
  ];
  const payload = await post('/responses', {
    model: config.ark.textModel,
    stream: false,
    temperature,
    max_output_tokens: maxOutputTokens,
    input
  });
  const text = responseText(payload).trim();
  if (!text) throw new Error('Ark 文本模型未返回可读文本');
  return {
    text,
    model: payload.model || config.ark.textModel,
    usage: payload.usage || null,
    responseId: payload.id || ''
  };
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
    return { vector, model: payload.model || config.ark.embeddingModel, fallback: false };
  } catch (error) {
    return {
      vector: localEmbedding(text),
      model: 'local-hash-embedding-v1',
      fallback: true,
      fallbackReason: error.message
    };
  }
}

export async function checkArkHealth() {
  const embedding = await embedText('记忆系统健康检查');
  return {
    configured: Boolean(config.ark.apiKey),
    embeddingModel: embedding.model,
    embeddingDimensions: embedding.vector.length,
    embeddingFallback: embedding.fallback,
    fallbackReason: embedding.fallbackReason || ''
  };
}
