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

function normalizeProvider(value, fallback) {
  const provider = String(value || fallback).trim().toLowerCase();
  if (!['ark', 'openai', 'anthropic', 'mock'].includes(provider)) {
    throw new Error(`不支持的模型 Provider：${provider}`);
  }
  return provider;
}

function normalizeCacheMode(value) {
  const mode = String(value || 'common_prefix').trim().toLowerCase();
  if (!['off', 'common_prefix'].includes(mode)) {
    throw new Error(`ARK_PREFIX_CACHE_MODE 仅支持 off 或 common_prefix`);
  }
  return mode;
}

function normalizeAgentRuntime(value) {
  const runtime = String(value || 'pi').trim().toLowerCase();
  if (!['pi', 'legacy'].includes(runtime)) {
    throw new Error(`AGENT_RUNTIME 仅支持 pi 或 legacy`);
  }
  return runtime;
}

function normalizeToolExecution(value) {
  const mode = String(value || 'sequential').trim().toLowerCase();
  if (!['sequential', 'parallel'].includes(mode)) {
    throw new Error('AGENT_TOOL_EXECUTION 仅支持 sequential 或 parallel');
  }
  return mode;
}

function normalizeThinkingLevel(value) {
  const level = String(value || 'off').trim().toLowerCase();
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
    throw new Error('AGENT_THINKING_LEVEL 仅支持 off、minimal、low、medium、high、xhigh 或 max');
  }
  return level;
}

function envList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeGraphStore(value) {
  const store = String(value || 'sqlite').trim().toLowerCase();
  if (!['sqlite', 'neo4j'].includes(store)) {
    throw new Error(`GRAPH_STORE 仅支持 sqlite 或 neo4j`);
  }
  return store;
}

function envBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeHost(value) {
  const host = String(value || '127.0.0.1').trim();
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error('HOST 包含无效字符');
  return host;
}

function requireProductionAdminPassword() {
  const password = String(process.env.ADMIN_PASSWORD || '');
  const placeholders = new Set(['memory-admin', 'replace-me', 'replace-with-a-strong-password']);
  if (process.env.NODE_ENV === 'production' && (!password || password.length < 12 || placeholders.has(password))) {
    throw new Error('生产环境必须设置至少 12 位且非示例值的 ADMIN_PASSWORD');
  }
  return password || 'memory-admin';
}

export const config = {
  rootDir,
  host: normalizeHost(process.env.HOST),
  port: Number(process.env.PORT || 4173),
  basePath: normalizeBasePath(process.env.BASE_PATH),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH || './data/memory-agent.db'),
  adminPassword: requireProductionAdminPassword(),
  agentRuntime: normalizeAgentRuntime(process.env.AGENT_RUNTIME),
  agentLoop: {
    pattern: 'react_tool_loop',
    thinkingLevel: normalizeThinkingLevel(process.env.AGENT_THINKING_LEVEL),
    toolExecution: normalizeToolExecution(process.env.AGENT_TOOL_EXECUTION),
    maxToolCalls: Math.min(20, Math.max(1, Number(process.env.AGENT_MAX_TOOL_CALLS || 6))),
    maxModelTurns: Math.min(12, Math.max(2, Number(process.env.AGENT_MAX_MODEL_TURNS || 6)))
  },
  capabilityRuntime: {
    enabled: envBoolean(process.env.CAPABILITY_RUNTIME_ENABLED, true),
    maxToolsPerTurn: Math.min(40, Math.max(1, Number(process.env.CAPABILITY_MAX_TOOLS_PER_TURN || 16))),
    discoveryTtlMs: Math.min(3600000, Math.max(10000, Number(process.env.MCP_DISCOVERY_TTL_MS || 300000))),
    callTimeoutMs: Math.min(300000, Math.max(1000, Number(process.env.CAPABILITY_CALL_TIMEOUT_MS || 45000))),
    httpAllowedHosts: envList(process.env.CAPABILITY_HTTP_ALLOWED_HOSTS),
    allowStdio: envBoolean(process.env.MCP_ALLOW_STDIO, false),
    stdioAllowedCommands: envList(process.env.MCP_STDIO_ALLOWED_COMMANDS)
  },
  graphStore: normalizeGraphStore(process.env.GRAPH_STORE),
  neo4j: {
    uri: process.env.NEO4J_URI || 'bolt://127.0.0.1:7687',
    username: process.env.NEO4J_USERNAME || 'neo4j',
    password: process.env.NEO4J_PASSWORD || '',
    database: process.env.NEO4J_DATABASE || 'neo4j',
    required: envBoolean(process.env.NEO4J_REQUIRED, false),
    projectionBatchSize: Math.min(100, Math.max(1, Number(process.env.NEO4J_PROJECTION_BATCH_SIZE || 10)))
  },
  textProvider: normalizeProvider(process.env.TEXT_PROVIDER, 'ark'),
  embeddingProvider: normalizeProvider(process.env.EMBEDDING_PROVIDER, 'ark'),
  ark: {
    apiKey: process.env.ARK_API_KEY || '',
    baseUrl: (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, ''),
    textModel: process.env.ARK_TEXT_MODEL || 'deepseek-v4-flash-260425',
    embeddingModel: process.env.ARK_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
    prefixCacheMode: normalizeCacheMode(process.env.ARK_PREFIX_CACHE_MODE),
    prefixCacheTtlSeconds: Math.min(604800, Math.max(3600, Number(process.env.ARK_PREFIX_CACHE_TTL_SECONDS || 86400)))
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    textModel: process.env.OPENAI_TEXT_MODEL || 'gpt-5-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
    textModel: process.env.ANTHROPIC_TEXT_MODEL || 'claude-sonnet-4-5',
    version: process.env.ANTHROPIC_VERSION || '2023-06-01'
  },
  mock: {
    textModel: process.env.MOCK_TEXT_MODEL || 'mock-companion-v1',
    embeddingModel: 'local-hash-embedding-v1'
  }
};
