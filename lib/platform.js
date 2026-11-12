// Platform integration is opt-in; legacy data and standalone operation remain intact.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const require = createRequire(import.meta.url);
export const platformEnabled = () => process.env.PLATFORM_ENABLED === 'true';
const sdk = platformEnabled() ? require(process.env.PLATFORM_SDK_PATH || '/opt/demo-platform/deploy/service-sdk/node-platform.cjs') : null;
const MODEL_ORIGIN = 'https://platform-model.invalid';
const originalFetch = globalThis.fetch.bind(globalThis);
let delegationDb;

export function platformActor() { return sdk?.currentActor() || null; }
export function platformCacheScope() { return platformEnabled() ? platformActor()?.user_id || 'unauthenticated' : ''; }
export function platformWorkspaceRequest(request, response) { return sdk ? sdk.handleWorkspaceRequest(request, response) : false; }
export function platformWorkspaceShell(markup) { return sdk ? sdk.injectWorkspaceShell(markup) : markup; }
export function platformLoginUrl() {
  const origin = (process.env.PLATFORM_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  const destination = (process.env.PLATFORM_SERVICE_PATH || '').replace(/\/$/, '') + '/';
  return origin + '/login?next=' + encodeURIComponent(destination);
}

function applyRuntime(value) {
  for (const provider of ['ark', 'openai', 'anthropic']) config[provider].apiKey = '';
  const text = value.capabilities?.llm2;
  const embedding = value.capabilities?.embedding;
  if (text) {
    const native = text.protocol === 'ark_context_chat' || /ark\.|volces\.com/.test(text.endpoint);
    const provider = native ? 'ark' : 'openai';
    config.textProvider = provider;
    Object.assign(config[provider], { apiKey: 'platform-managed', baseUrl: MODEL_ORIGIN + '/v1', textModel: text.model });
    if (native) config.ark.prefixCacheMode = text.protocol === 'ark_context_chat' ? 'common_prefix' : 'provider_managed';
  } else {
    // A disabled central capability must never fall back to a local credential.
    config.textProvider = 'ark';
    config.ark.baseUrl = MODEL_ORIGIN + '/v1';
    config.ark.textModel = '';
  }
  if (embedding) {
    const provider = embedding.protocol === 'volc_embedding' ? 'ark' : 'openai';
    config.embeddingProvider = provider;
    Object.assign(config[provider], { apiKey: 'platform-managed', baseUrl: MODEL_ORIGIN + '/v1', embeddingModel: embedding.model });
  } else {
    config.embeddingProvider = 'ark';
    config.ark.embeddingModel = '';
  }
}

export async function refreshPlatformRuntime() {
  if (!platformEnabled()) return;
  applyRuntime(await sdk.refreshRuntime());
}

// Both the handwritten providers and Pi's own SDK target this dedicated host.
// Internal platform fetches use the SDK's captured originalFetch, so there is no
// recursive interception and no provider credential reaches this process.
if (platformEnabled()) {
  for (const provider of ['ark', 'openai', 'anthropic']) config[provider].apiKey = '';
  globalThis.fetch = function platformFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== MODEL_ORIGIN) return originalFetch(input, init);
    const capability = url.pathname.includes('/embeddings') ? 'embedding' : 'llm2';
    return (async () => {
      if (!sdk.runtimeSnapshot().capabilities?.[capability]) throw new Error(`Platform capability ${capability} is disabled`);
      const request = input instanceof Request ? input : null;
      const prepared = request ? { method: request.method, headers: request.headers, body: ['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), signal: request.signal, ...init } : init;
      return sdk.modelFetch(capability, url.href, prepared);
    })();
  };
}

export async function protectPlatformRequest(request, response, callback) {
  if (!platformEnabled()) return callback();
  if (request.headers['x-platform-actor']) {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const allowed = request.method === 'POST' && ['/v1/memory/bind', '/v1/memory/observe', '/v1/memory/recall', '/v1/memory/library'].includes(pathname)
      || request.method === 'GET' && /^\/v1\/memory\/jobs\/[A-Za-z0-9_-]+$/.test(pathname);
    if (!allowed) {
      response.writeHead(403, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
      response.end(JSON.stringify({ error:'服务委托仅可访问指定记忆契约', code:'PLATFORM_DELEGATION_SCOPE_FORBIDDEN' }));
      return;
    }
  }
  if (!await sdk.protect(request, response)) return;
  if (request.headers['x-platform-actor'] && !(request.platformDelegated === true && ['education', 'voice', 'companion'].includes(request.platformDelegationSource))) {
    response.writeHead(403, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
    response.end(JSON.stringify({ error:'记忆委托未经平台核验', code:'PLATFORM_DELEGATION_INVALID' }));
    return;
  }
  applyRuntime(sdk.runtimeSnapshot());
  return sdk.withRequest(request, callback);
}

export function platformPrincipal(db, request) {
  if (!platformEnabled()) return null;
  const actor = request.platformAuth;
  if (!actor?.user_id) return null;
  const guest = actor.identity_type === 'guest';
  let historyNotice = '';
  if (guest && actor.legacy_subject_id != null && !request.platformDelegated) {
    const legacyId = actor.legacy_subject_id;
    if (typeof legacyId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(legacyId) || legacyId.startsWith('platform_')) {
      throw Object.assign(new Error('访客历史档案绑定无效，请联系工作台负责人。'), {status:403,code:'LEGACY_SUBJECT_UNAVAILABLE'});
    }
    const row = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(legacyId);
    if (row) {
      return {role:'user',userId:row.id,username:actor.username || '',displayName:String(actor.display_name || '访客').slice(0,60),
        identityType:'guest',legacySubjectId:row.id,platformDelegated:false,delegationSource:'',platformUserId:actor.user_id,
        user:{id:row.id,name:row.name,display_name:row.display_name,avatar_color:row.avatar_color,status:row.status}};
    }
    historyNotice = '历史档案在当前环境不可用，已进入当前访客的独立个人空间。';
  }
  const userId = 'platform_' + crypto.createHash('sha256').update(String(actor.tenant_id) + ':' + actor.user_id).digest('hex').slice(0, 32);
  const timestamp = new Date().toISOString();
  const name = String(actor.display_name || actor.username || '飞书用户').slice(0, 60);
  db.prepare(`INSERT INTO users (id,name,display_name,avatar_color,created_at,updated_at)
    VALUES (?,?,?,'#2563eb',?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,updated_at=excluded.updated_at`).run(userId,name,name,timestamp,timestamp);
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (row.status !== 'active') return null;
  const delegated = request.platformDelegated === true && ['education', 'voice', 'companion'].includes(request.platformDelegationSource);
  return {role: !guest && !delegated && actor.is_owner === true ? 'admin' : 'user', userId, username: actor.username || '', displayName: name,
    identityType:guest ? 'guest' : 'feishu',historyNotice,
    platformDelegated: delegated, delegationSource: delegated ? request.platformDelegationSource : '',
    user:{id:userId,name:row.name,display_name:name,avatar_color:row.avatar_color,status:row.status}, platformUserId:actor.user_id,platformTenantId:actor.tenant_id};
}

function privateDelegations() {
  if (delegationDb) return delegationDb;
  const filename = process.env.PLATFORM_DELEGATION_DB || path.join(path.dirname(config.databasePath), 'platform-delegations.sqlite');
  fs.mkdirSync(path.dirname(filename), { recursive:true, mode:0o700 });
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd); fs.chmodSync(filename,0o600);
  delegationDb = new DatabaseSync(filename);
  delegationDb.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS job_delegations(job_key TEXT PRIMARY KEY, delegation_json TEXT NOT NULL, created_at TEXT NOT NULL)');
  return delegationDb;
}

export function capturePlatformJob(jobKey) {
  if (!platformEnabled()) return;
  const value = sdk.captureDelegation();
  if (!value.auth?.user_id || !value.ticket) throw new Error('Authenticated platform delegation required');
  privateDelegations().prepare('INSERT INTO job_delegations(job_key,delegation_json,created_at) VALUES(?,?,?) ON CONFLICT(job_key) DO UPDATE SET delegation_json=excluded.delegation_json,created_at=excluded.created_at').run(jobKey,JSON.stringify(value),new Date().toISOString());
}

export function hasPlatformJob(jobKey) {
  if (!platformEnabled()) return true;
  const filename = process.env.PLATFORM_DELEGATION_DB
    || path.join(path.dirname(config.databasePath), 'platform-delegations.sqlite');
  if (!fs.existsSync(filename)) return false;
  const reader = new DatabaseSync(filename, { readOnly: true });
  try {
    const table = reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='job_delegations'").get();
    return Boolean(table && reader.prepare('SELECT 1 FROM job_delegations WHERE job_key=?').get(jobKey));
  } finally {
    reader.close();
  }
}

export async function withPlatformJob(jobKey, callback) {
  if (!platformEnabled()) return callback();
  const row = privateDelegations().prepare('SELECT delegation_json FROM job_delegations WHERE job_key=?').get(jobKey);
  if (!row) throw new Error('后台任务缺少平台用户授权，请登录后重新发起任务。');
  const delegation = JSON.parse(row.delegation_json);
  await refreshPlatformRuntime();
  return sdk.withDelegation(delegation, callback);
}
