import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(filename) {
  const envPath = path.join(rootDir, filename);
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile('.env.local');

function normalizeBasePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
  if (!/^\/[a-zA-Z0-9._~/-]+$/.test(normalized) || normalized.includes('..')) {
    throw new Error('BASE_PATH 只能包含安全的 URL 路径字符');
  }
  return normalized;
}

export const config = {
  rootDir,
  port: Number(process.env.PORT || 4173),
  basePath: normalizeBasePath(process.env.BASE_PATH),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || './data/memory-agent.db'),
  adminPassword: process.env.ADMIN_PASSWORD || 'memory-admin',
  ark: {
    apiKey: process.env.ARK_API_KEY || '',
    baseUrl: (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, ''),
    textModel: process.env.ARK_TEXT_MODEL || 'deepseek-v4-flash-260425',
    embeddingModel: process.env.ARK_EMBEDDING_MODEL || 'doubao-embedding-vision-250615'
  }
};
