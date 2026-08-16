export function responseText(payload) {
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
  if (Array.isArray(payload?.content)) return payload.content.map((item) => item.text || '').join('');
  return '';
}

export function normalizeUsage(payload) {
  const usage = payload?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const cachedTokens = Number(
    usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? 0
  );
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
    cachedTokens,
    cacheCreationTokens,
    cacheHitRate: inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(4)) : 0
  };
}

export async function postJson({ url, headers, body, timeoutMs = 60000, providerLabel }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`${providerLabel} API 返回了非 JSON 内容 (${response.status})`);
  }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 500);
    throw new Error(`${providerLabel} API ${response.status}: ${detail}`);
  }
  return payload;
}

export async function postSse({ url, headers, body, timeoutMs = 60000, providerLabel, onEvent }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw.slice(0, 500);
    try {
      const payload = JSON.parse(raw);
      detail = payload?.error?.message || payload?.message || detail;
    } catch {
      // Keep the bounded raw response for diagnostics.
    }
    throw new Error(`${providerLabel} API ${response.status}: ${detail}`);
  }
  if (!response.body) throw new Error(`${providerLabel} API 未返回流式响应体`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  const dispatch = () => {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    const currentEventName = eventName;
    eventName = '';
    if (data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error(`${providerLabel} API 返回了无法解析的 SSE 数据`);
    }
    onEvent(payload, currentEventName);
  };
  const consumeLine = (line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!normalized) {
      dispatch();
      return;
    }
    if (normalized.startsWith('event:')) eventName = normalized.slice(6).trim();
    if (normalized.startsWith('data:')) dataLines.push(normalized.slice(5).trimStart());
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  dispatch();
}

export function responseInput(systemPrompt, messages) {
  return [
    { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
    ...messages.map((message) => ({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }]
    }))
  ];
}

export function chatMessages(messages) {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
