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
  const mode = String(value || 'provider_managed').trim().toLowerCase();
  if (!['off', 'provider_managed', 'common_prefix'].includes(mode)) {
    throw new Error(`ARK_PREFIX_CACHE_MODE 仅支持 off、provider_managed 或 common_prefix`);
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

function normalizeSandboxProvider(value) {
  const provider = String(value || (process.env.NODE_ENV === 'production' ? 'opensandbox' : 'local'))
    .trim().toLowerCase();
  if (!['opensandbox', 'local'].includes(provider)) {
    throw new Error('SANDBOX_PROVIDER 仅支持 opensandbox 或 local');
  }
  if (process.env.NODE_ENV === 'production' && provider === 'local') {
    throw new Error('生产环境禁止 SANDBOX_PROVIDER=local，请使用 OpenSandbox');
  }
  return provider;
}

function normalizeSubagentDepth(value) {
  const depth = Number(value || 1);
  if (depth !== 1) {
    throw new Error('当前版本 SUBAGENT_MAX_DEPTH 仅支持 1，子 Agent 不允许递归派生');
  }
  return depth;
}

function normalizeDeepAgentWorkerMode(value) {
  const mode = String(value || 'inline').trim().toLowerCase();
  if (!['inline', 'external', 'off'].includes(mode)) {
    throw new Error('DEEP_AGENT_WORKER_MODE 仅支持 inline、external 或 off');
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

function normalizeTenantId(value) {
  const tenantId = String(value || 'default').normalize('NFKC').trim();
  if (!tenantId || tenantId.length > 100 || /[\u0000-\u001f\u007f]/.test(tenantId)) {
    throw new Error('MEMORY_TENANT_ID 必须是 1-100 位且不含控制字符');
  }
  return tenantId;
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
  memoryService: {
    tenantId: normalizeTenantId(process.env.MEMORY_TENANT_ID),
    apiKey: process.env.MEMORY_SERVICE_API_KEY || '',
    workerPollMs: Math.min(60000, Math.max(250, Number(process.env.MEMORY_WORKER_POLL_MS || 750))),
    jobMaxAttempts: Math.min(10, Math.max(1, Number(process.env.MEMORY_JOB_MAX_ATTEMPTS || 3)))
  },
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
  sandboxRuntime: {
    enabled: envBoolean(process.env.SANDBOX_RUNTIME_ENABLED, false),
    provider: normalizeSandboxProvider(process.env.SANDBOX_PROVIDER),
    workspaceRoot: path.resolve(rootDir, process.env.SANDBOX_WORKSPACE_ROOT || './data/sandboxes'),
    artifactRoot: path.resolve(rootDir, process.env.ARTIFACT_ROOT || './data/artifacts'),
    image: process.env.SANDBOX_IMAGE || 'open-character-memory/sandbox:0.1.0',
    timeoutSeconds: Math.min(3600, Math.max(60, Number(process.env.SANDBOX_TIMEOUT_SECONDS || 900))),
    commandTimeoutMs: Math.min(300000, Math.max(1000, Number(process.env.SANDBOX_COMMAND_TIMEOUT_MS || 60000))),
    maxOutputCharacters: Math.min(100000, Math.max(1000, Number(process.env.SANDBOX_MAX_OUTPUT_CHARACTERS || 24000))),
    maxArtifactBytes: Math.min(50 * 1024 * 1024, Math.max(1024, Number(
      process.env.SANDBOX_MAX_ARTIFACT_BYTES || 10 * 1024 * 1024
    ))),
    allowedPrograms: envList(process.env.SANDBOX_ALLOWED_PROGRAMS || 'bash,python,python3,node,sh'),
    localUnsafeCommands: envBoolean(process.env.SANDBOX_LOCAL_UNSAFE_COMMANDS, false),
    networkAllowedHosts: envList(process.env.SANDBOX_NETWORK_ALLOWED_HOSTS),
    openSandbox: {
      domain: process.env.OPEN_SANDBOX_DOMAIN || '127.0.0.1:8080',
      protocol: process.env.OPEN_SANDBOX_PROTOCOL || 'http',
      apiKey: process.env.OPEN_SANDBOX_API_KEY || '',
      useServerProxy: envBoolean(process.env.OPEN_SANDBOX_USE_SERVER_PROXY, true)
    }
  },
  subagentRuntime: {
    enabled: envBoolean(process.env.SUBAGENT_RUNTIME_ENABLED, true),
    maxConcurrency: Math.min(8, Math.max(1, Number(process.env.SUBAGENT_MAX_CONCURRENCY || 3))),
    maxTasksPerCall: Math.min(8, Math.max(2, Number(process.env.SUBAGENT_MAX_TASKS_PER_CALL || 4))),
    maxDepth: normalizeSubagentDepth(process.env.SUBAGENT_MAX_DEPTH),
    maxModelTurns: Math.min(8, Math.max(2, Number(process.env.SUBAGENT_MAX_MODEL_TURNS || 4))),
    maxOutputCharacters: Math.min(30000, Math.max(1000, Number(
      process.env.SUBAGENT_MAX_OUTPUT_CHARACTERS || 8000
    )))
  },
  deepAgentRuntime: {
    enabled: envBoolean(process.env.DEEP_AGENT_RUNTIME_ENABLED, true),
    workerMode: normalizeDeepAgentWorkerMode(process.env.DEEP_AGENT_WORKER_MODE),
    workerPollMs: Math.min(60000, Math.max(250, Number(process.env.DEEP_AGENT_WORKER_POLL_MS || 1000))),
    maxConcurrency: Math.min(8, Math.max(1, Number(process.env.DEEP_AGENT_MAX_CONCURRENCY || 2))),
    maxNodesPerRun: Math.min(64, Math.max(2, Number(process.env.DEEP_AGENT_MAX_NODES || 16))),
    maxReplans: Math.min(5, Math.max(0, Number(process.env.DEEP_AGENT_MAX_REPLANS || 2))),
    maxAttemptsPerNode: Math.min(5, Math.max(1, Number(process.env.DEEP_AGENT_NODE_MAX_ATTEMPTS || 2))),
    leaseSeconds: Math.min(3600, Math.max(30, Number(process.env.DEEP_AGENT_LEASE_SECONDS || 180))),
    approvalTtlSeconds: Math.min(604800, Math.max(300, Number(
      process.env.DEEP_AGENT_APPROVAL_TTL_SECONDS || 86400
    ))),
    autoReplan: envBoolean(process.env.DEEP_AGENT_AUTO_REPLAN, true),
    maxModelTurns: Math.min(12, Math.max(2, Number(process.env.DEEP_AGENT_MAX_MODEL_TURNS || 6))),
    maxOutputCharacters: Math.min(100000, Math.max(2000, Number(
      process.env.DEEP_AGENT_MAX_OUTPUT_CHARACTERS || 16000
    )))
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
    textModel: process.env.ARK_TEXT_MODEL || 'deepseek-v4-flash-ga-260731',
    embeddingModel: process.env.ARK_EMBEDDING_MODEL || 'doubao-embedding-vision-250615',
    requestTimeoutMs: Math.min(300000, Math.max(30000, Number(
      process.env.ARK_REQUEST_TIMEOUT_MS || 180000
    ))),
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
