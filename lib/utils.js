import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
export const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function safeText(value, max = 20000) {
  return String(value ?? '').replaceAll('\u0000', '').slice(0, max);
}

export function extractJson(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function localEmbedding(text, dimensions = 256) {
  const vector = Array(dimensions).fill(0);
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    const gram = normalized.slice(i, i + 3);
    const digest = crypto.createHash('sha256').update(gram).digest();
    const index = digest.readUInt16BE(0) % dimensions;
    vector[index] += digest[2] % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / norm);
}

export function redactSecrets(value) {
  if (value === null || value === undefined) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .replace(/ark-[a-zA-Z0-9-]{20,}/g, '[REDACTED_ARK_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{16,}/gi, 'Bearer [REDACTED]');
}
