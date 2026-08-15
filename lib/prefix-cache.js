import { db } from './db.js';
import { nowIso } from './utils.js';

export function getPrefixCache(cacheKey) {
  const row = db.prepare(`SELECT * FROM model_prefix_caches
    WHERE cache_key = ? AND status = 'ready' AND expires_at > ?`).get(cacheKey, nowIso());
  return row || null;
}

export function getPrefixCacheCooldown(cacheKey, cooldownSeconds = 300) {
  const cutoff = new Date(Date.now() - cooldownSeconds * 1000).toISOString();
  return db.prepare(`SELECT * FROM model_prefix_caches
    WHERE cache_key = ? AND status = 'invalid' AND updated_at > ?`).get(cacheKey, cutoff) || null;
}

export function savePrefixCache(record) {
  const timestamp = nowIso();
  db.prepare(`INSERT INTO model_prefix_caches
    (cache_key, provider, model, agent_id, profile_version, scene_config_version, prompt_hash,
     context_id, status, expires_at, hit_count, create_count, last_error, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0, 1, '', ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET context_id = excluded.context_id, status = 'ready',
      expires_at = excluded.expires_at, create_count = model_prefix_caches.create_count + 1,
      last_error = '', updated_at = excluded.updated_at, last_used_at = excluded.last_used_at`)
    .run(
      record.cacheKey, record.provider, record.model, record.agentId, record.profileVersion,
      record.sceneConfigVersion, record.promptHash, record.contextId, record.expiresAt,
      timestamp, timestamp, timestamp
    );
}

export function markPrefixCacheUsed(cacheKey) {
  db.prepare(`UPDATE model_prefix_caches SET hit_count = hit_count + 1,
    last_used_at = ?, updated_at = ? WHERE cache_key = ?`).run(nowIso(), nowIso(), cacheKey);
}

export function invalidatePrefixCache(cacheKey, error) {
  db.prepare(`UPDATE model_prefix_caches SET status = 'invalid', last_error = ?, updated_at = ?
    WHERE cache_key = ?`).run(String(error || '').slice(0, 500), nowIso(), cacheKey);
}

export function savePrefixCacheFailure(record, error) {
  const timestamp = nowIso();
  db.prepare(`INSERT INTO model_prefix_caches
    (cache_key, provider, model, agent_id, profile_version, scene_config_version, prompt_hash,
     context_id, status, expires_at, hit_count, create_count, last_error, created_at, updated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 'invalid', ?, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET status = 'invalid', last_error = excluded.last_error,
      updated_at = excluded.updated_at`)
    .run(
      record.cacheKey, record.provider, record.model, record.agentId, record.profileVersion,
      record.sceneConfigVersion, record.promptHash,
      new Date(Date.now() + 300_000).toISOString(), String(error || '').slice(0, 500),
      timestamp, timestamp, timestamp
    );
}
