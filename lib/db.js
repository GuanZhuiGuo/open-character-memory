import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import {
  DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS,
  DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY,
  DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY,
  DEFAULT_RETRIEVAL_KEYWORD_MIN_SCORE
} from './runtime-policy.js';
import { json, nowIso, uid } from './utils.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

export function repairActiveEvidenceLinks() {
  const affectedScopes = db.prepare(`SELECT DISTINCT old.user_id, old.agent_id, old.story_id, old.branch_id
    FROM events old
    WHERE old.status != 'active' AND (
      EXISTS (SELECT 1 FROM claims c
        WHERE c.event_id = old.id AND c.status = 'active' AND c.transaction_to = '')
      OR EXISTS (SELECT 1 FROM entity_edges ee
        WHERE ee.event_id = old.id AND ee.status = 'active' AND ee.transaction_to = '')
    ) AND EXISTS (
      SELECT 1 FROM events current
      WHERE current.user_id = old.user_id AND current.agent_id = old.agent_id
        AND current.story_id = old.story_id AND current.branch_id = old.branch_id
        AND current.event_key = old.event_key AND current.status = 'active'
        AND current.transaction_to = ''
    )`).all();
  if (!affectedScopes.length) return { claims: 0, edges: 0, scopes: 0 };
  const timestamp = nowIso();
  const currentEventLookup = `SELECT current.id FROM events old JOIN events current
    ON current.user_id = old.user_id AND current.agent_id = old.agent_id
      AND current.story_id = old.story_id AND current.branch_id = old.branch_id
      AND current.event_key = old.event_key
    WHERE old.id = %TABLE%.event_id AND current.status = 'active'
      AND current.transaction_to = ''
    ORDER BY current.version DESC, current.updated_at DESC LIMIT 1`;
  const claims = db.prepare(`UPDATE claims SET event_id = (
      ${currentEventLookup.replaceAll('%TABLE%', 'claims')}
    ), updated_at = ?
    WHERE status = 'active' AND transaction_to = '' AND event_id != ''
      AND EXISTS (${currentEventLookup.replaceAll('%TABLE%', 'claims')})
      AND EXISTS (SELECT 1 FROM events old WHERE old.id = claims.event_id AND old.status != 'active')`)
    .run(timestamp).changes;
  const edges = db.prepare(`UPDATE entity_edges SET event_id = (
      ${currentEventLookup.replaceAll('%TABLE%', 'entity_edges')}
    ), updated_at = ?
    WHERE status = 'active' AND transaction_to = '' AND event_id != ''
      AND EXISTS (${currentEventLookup.replaceAll('%TABLE%', 'entity_edges')})
      AND EXISTS (SELECT 1 FROM events old WHERE old.id = entity_edges.event_id AND old.status != 'active')`)
    .run(timestamp).changes;
  if (config.graphStore === 'neo4j') {
    for (const scope of affectedScopes) {
      const scopeKey = [scope.user_id, scope.agent_id, scope.story_id, scope.branch_id].join('|');
      db.prepare(`INSERT INTO graph_projection_outbox
          (id, scope_key, user_id, agent_id, story_id, branch_id, status, attempts,
           last_error, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '', ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET status = 'pending', last_error = '',
          available_at = excluded.available_at, updated_at = excluded.updated_at`)
        .run(uid('graph_outbox'), scopeKey, scope.user_id, scope.agent_id,
          scope.story_id, scope.branch_id, timestamp, timestamp, timestamp);
    }
  }
  return { claims, edges, scopes: affectedScopes.length };
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#2563eb',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scenario_type TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'sparkles',
      accent_color TEXT NOT NULL DEFAULT '#2563eb',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_profiles (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_extraction_profiles (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      execution_mode TEXT NOT NULL DEFAULT 'blocking_after_assistant',
      trigger_point TEXT NOT NULL DEFAULT 'after_every_x_assistant_messages_persisted',
      extraction_interval_turns INTEGER NOT NULL DEFAULT ${DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS},
      context_turns INTEGER NOT NULL DEFAULT 2,
      include_assistant INTEGER NOT NULL DEFAULT 1,
      max_events_per_turn INTEGER NOT NULL DEFAULT 3,
      min_importance REAL NOT NULL DEFAULT 0.35,
      allowed_event_types_json TEXT NOT NULL DEFAULT '[]',
      update_signals_json TEXT NOT NULL DEFAULT '[]',
      event_instruction TEXT NOT NULL DEFAULT '',
      entity_instruction TEXT NOT NULL DEFAULT '',
      relation_instruction TEXT NOT NULL DEFAULT '',
      custom_rules TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS retrieval_profiles (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id),
      name TEXT NOT NULL,
      vector_enabled INTEGER NOT NULL DEFAULT 1,
      keyword_enabled INTEGER NOT NULL DEFAULT 1,
      graph_enabled INTEGER NOT NULL DEFAULT 1,
      intent_filter_enabled INTEGER NOT NULL DEFAULT 1,
      min_similarity REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY},
      min_keyword_score REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_KEYWORD_MIN_SCORE},
      event_top_k INTEGER NOT NULL DEFAULT 4,
      claim_top_k INTEGER NOT NULL DEFAULT 20,
      edge_top_k INTEGER NOT NULL DEFAULT 20,
      vector_weight REAL NOT NULL DEFAULT 0.70,
      keyword_weight REAL NOT NULL DEFAULT 0.16,
      importance_weight REAL NOT NULL DEFAULT 0.10,
      recency_weight REAL NOT NULL DEFAULT 0.04,
      recency_half_life_days INTEGER NOT NULL DEFAULT 30,
      catalog_min_similarity REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY},
      vector_only_min_similarity REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY},
      planner_enabled INTEGER NOT NULL DEFAULT 1,
      planner_max_candidates INTEGER NOT NULL DEFAULT 12,
      graph_hops INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scene_id TEXT NOT NULL DEFAULT 'scene_companion',
      scenario_type TEXT NOT NULL DEFAULT 'companion',
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      greeting TEXT NOT NULL DEFAULT '',
      avatar_color TEXT NOT NULL DEFAULT '#2563eb',
      enabled INTEGER NOT NULL DEFAULT 1,
      fixed_attributes_json TEXT NOT NULL DEFAULT '{}',
      profile_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_profile_history (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      old_profile_json TEXT NOT NULL,
      new_profile_json TEXT NOT NULL,
      affected_memory_count INTEGER NOT NULL DEFAULT 0,
      warning_acknowledged INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_history
      ON agent_profile_history(agent_id, version DESC);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_accounts (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      username TEXT COLLATE NOCASE NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      story_id TEXT NOT NULL DEFAULT 'main_story',
      branch_id TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL DEFAULT '新对话',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(user_id, agent_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS conversation_extraction_states (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL,
      last_extracted_message_id TEXT NOT NULL DEFAULT '',
      last_extracted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      target_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      target_role TEXT NOT NULL,
      trace_id TEXT NOT NULL DEFAULT '',
      suggestion TEXT NOT NULL,
      turn_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_admin ON feedback(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_schemas (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      scenario_type TEXT NOT NULL DEFAULT 'all',
      value_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      extraction_instruction TEXT NOT NULL DEFAULT '',
      default_json TEXT NOT NULL DEFAULT 'null',
      constraints_json TEXT NOT NULL DEFAULT '{}',
      prompt_template TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 0,
      extraction_mode TEXT NOT NULL DEFAULT 'explicit_only',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_values (
      id TEXT PRIMARY KEY,
      schema_id TEXT NOT NULL REFERENCES memory_schemas(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL DEFAULT '',
      story_id TEXT NOT NULL DEFAULT '',
      branch_id TEXT NOT NULL DEFAULT '',
      value_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      source_type TEXT NOT NULL DEFAULT 'default',
      source_message_id TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 1,
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      transaction_from TEXT NOT NULL DEFAULT '',
      transaction_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(schema_id, user_id, agent_id, story_id, branch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_values_scope ON memory_values(user_id, agent_id, story_id, branch_id, status);

    CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT PRIMARY KEY,
      memory_value_id TEXT NOT NULL REFERENCES memory_values(id),
      schema_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT,
      operation TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_message_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL,
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      transaction_from TEXT NOT NULL DEFAULT '',
      transaction_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_history_value ON memory_history(memory_value_id, version DESC);

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, agent_id, story_id, branch_id, entity_type, canonical_name)
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      source_entity_id TEXT NOT NULL REFERENCES entities(id),
      predicate TEXT NOT NULL,
      target_entity_id TEXT NOT NULL REFERENCES entities(id),
      properties_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      event_id TEXT NOT NULL DEFAULT '',
      source_message_id TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      supersedes_edge_id TEXT,
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      transaction_from TEXT NOT NULL DEFAULT '',
      transaction_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_edges_scope ON entity_edges(user_id, agent_id, story_id, branch_id, status);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      scene_id TEXT NOT NULL DEFAULT '',
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      story_time TEXT NOT NULL DEFAULT '',
      sequence_no INTEGER,
      source_message_id TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5,
      memory_space TEXT NOT NULL DEFAULT 'user_memory',
      canonicality TEXT NOT NULL DEFAULT 'confirmed',
      source_speaker TEXT NOT NULL DEFAULT 'user',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      supersedes_event_id TEXT,
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      transaction_from TEXT NOT NULL DEFAULT '',
      transaction_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_scope ON events(user_id, agent_id, story_id, branch_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS event_entities (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      role TEXT NOT NULL DEFAULT 'mentioned',
      source_message_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(event_id, entity_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_event_entities_event ON event_entities(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_entities_entity ON event_entities(entity_id);

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      subject_entity_id TEXT NOT NULL REFERENCES entities(id),
      predicate TEXT NOT NULL,
      object_text TEXT NOT NULL DEFAULT '',
      object_entity_id TEXT,
      perspective_entity_id TEXT,
      fact_scope TEXT NOT NULL DEFAULT 'world_fact',
      modality TEXT NOT NULL DEFAULT 'asserted',
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      supersedes_claim_id TEXT,
      source_speaker TEXT NOT NULL DEFAULT 'user',
      source_message_id TEXT NOT NULL DEFAULT '',
      event_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      story_time TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT NOT NULL DEFAULT '',
      transaction_from TEXT NOT NULL DEFAULT '',
      transaction_to TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_slot ON claims(user_id, agent_id, story_id, branch_id, subject_entity_id, predicate, fact_scope, status);

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      source_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(owner_type, owner_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_user_owner ON embeddings(user_id, owner_type);

    CREATE TABLE IF NOT EXISTS graph_projection_outbox (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_graph_projection_outbox_pending
      ON graph_projection_outbox(status, available_at, updated_at);

    CREATE TABLE IF NOT EXISTS architecture_knowledge_chunks (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_label TEXT NOT NULL,
      section_key TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_architecture_chunks_source
      ON architecture_knowledge_chunks(source_path, start_line);

    CREATE TABLE IF NOT EXISTS architecture_qa_logs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      retrieved_json TEXT NOT NULL DEFAULT '[]',
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_prefix_caches (
      cache_key TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      profile_version INTEGER NOT NULL DEFAULT 1,
      scene_config_version TEXT NOT NULL DEFAULT '',
      prompt_hash TEXT NOT NULL,
      context_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      expires_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      create_count INTEGER NOT NULL DEFAULT 1,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_prefix_caches_expiry
      ON model_prefix_caches(provider, model, status, expires_at);

    CREATE TABLE IF NOT EXISTS plots (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      parent_plot_id TEXT NOT NULL DEFAULT '',
      branch_label TEXT NOT NULL DEFAULT '主线',
      node_type TEXT NOT NULL DEFAULT 'chapter',
      name TEXT NOT NULL,
      premise TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
      audience_genders_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 50,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_plot_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      plot_id TEXT NOT NULL REFERENCES plots(id),
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'locked',
      progress REAL NOT NULL DEFAULT 0,
      unlocked_at TEXT,
      completed_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(user_id, plot_id, story_id, branch_id)
    );

    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema_json TEXT NOT NULL DEFAULT '{}',
      handler_type TEXT NOT NULL DEFAULT 'builtin',
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS capability_props (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      package_type TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      file_name TEXT NOT NULL DEFAULT '',
      storage_path TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '1.0.0',
      status TEXT NOT NULL DEFAULT 'draft',
      risk_level TEXT NOT NULL DEFAULT 'medium',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_capability_props_agent_status
      ON capability_props(agent_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS user_prop_states (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prop_id TEXT NOT NULL REFERENCES capability_props(id) ON DELETE CASCADE,
      story_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'locked',
      unlocked_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(user_id, prop_id, story_id, branch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_prop_states_scope
      ON user_prop_states(user_id, story_id, branch_id, status);

    CREATE TABLE IF NOT EXISTS capability_tool_catalog (
      id TEXT PRIMARY KEY,
      prop_id TEXT NOT NULL REFERENCES capability_props(id) ON DELETE CASCADE,
      exposed_name TEXT NOT NULL,
      upstream_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      input_schema_json TEXT NOT NULL DEFAULT '{}',
      annotations_json TEXT NOT NULL DEFAULT '{}',
      source_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      last_error TEXT NOT NULL DEFAULT '',
      discovered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(prop_id, exposed_name)
    );
    CREATE INDEX IF NOT EXISTS idx_capability_tool_catalog_prop
      ON capability_tool_catalog(prop_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS capability_runs (
      id TEXT PRIMARY KEY,
      prop_id TEXT NOT NULL REFERENCES capability_props(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      trace_id TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT NOT NULL DEFAULT '',
      exposed_name TEXT NOT NULL,
      upstream_name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      arguments_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      approval_mode TEXT NOT NULL DEFAULT 'none',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_capability_runs_scope
      ON capability_runs(user_id, conversation_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_capability_runs_trace
      ON capability_runs(trace_id, started_at);

    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      condition_json TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      once_per_user INTEGER NOT NULL DEFAULT 1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 50,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL REFERENCES triggers(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_lookup ON trigger_runs(trigger_id, user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tool_runs (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL REFERENCES tools(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      conversation_id TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL REFERENCES users(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'running',
      total_ms INTEGER NOT NULL DEFAULT 0,
      request_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traces_conversation ON traces(conversation_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS trace_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id, created_at);
  `);

  const agentColumns = db.prepare('PRAGMA table_info(agents)').all();
  if (!agentColumns.some((column) => column.name === 'scene_id')) {
    db.exec("ALTER TABLE agents ADD COLUMN scene_id TEXT NOT NULL DEFAULT 'scene_companion'");
  }
  if (!agentColumns.some((column) => column.name === 'fixed_attributes_json')) {
    db.exec("ALTER TABLE agents ADD COLUMN fixed_attributes_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!agentColumns.some((column) => column.name === 'profile_version')) {
    db.exec('ALTER TABLE agents ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1');
  }

  const plotColumns = db.prepare('PRAGMA table_info(plots)').all();
  for (const [column, definition] of [
    ['parent_plot_id', "TEXT NOT NULL DEFAULT ''"],
    ['branch_label', "TEXT NOT NULL DEFAULT '主线'"],
    ['node_type', "TEXT NOT NULL DEFAULT 'chapter'"],
    ['audience_genders_json', "TEXT NOT NULL DEFAULT '[]'"]
  ]) {
    if (!plotColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE plots ADD COLUMN ${column} ${definition}`);
    }
  }

  const retrievalColumns = db.prepare('PRAGMA table_info(retrieval_profiles)').all();
  const retrievalAdditions = [
    ['catalog_min_similarity', `REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY}`],
    ['vector_only_min_similarity', `REAL NOT NULL DEFAULT ${DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY}`],
    ['planner_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['planner_max_candidates', 'INTEGER NOT NULL DEFAULT 12'],
    ['graph_hops', 'INTEGER NOT NULL DEFAULT 1']
  ];
  for (const [column, definition] of retrievalAdditions) {
    if (!retrievalColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE retrieval_profiles ADD COLUMN ${column} ${definition}`);
    }
  }
  const retrievalPrecisionMigrationId = '2026-08-16-tighten-retrieval-defaults';
  if (!db.prepare('SELECT id FROM system_migrations WHERE id = ?').get(retrievalPrecisionMigrationId)) {
    const retrievalMigrationTimestamp = nowIso();
    db.prepare(`UPDATE retrieval_profiles SET
      min_similarity = ?, min_keyword_score = ?, catalog_min_similarity = ?,
      vector_only_min_similarity = ?, updated_at = ?
      WHERE ABS(min_similarity - 0.42) < 0.000001
        AND ABS(min_keyword_score - 0.08) < 0.000001
        AND ABS(catalog_min_similarity - 0.28) < 0.000001
        AND ABS(vector_only_min_similarity - 0.42) < 0.000001`)
      .run(DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY, DEFAULT_RETRIEVAL_KEYWORD_MIN_SCORE,
        DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY, DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY,
        retrievalMigrationTimestamp);
    db.prepare('INSERT INTO system_migrations (id, applied_at) VALUES (?, ?)')
      .run(retrievalPrecisionMigrationId, retrievalMigrationTimestamp);
  }

  const eventColumns = db.prepare('PRAGMA table_info(events)').all();
  for (const [column, definition] of [
    ['memory_space', "TEXT NOT NULL DEFAULT 'user_memory'"],
    ['canonicality', "TEXT NOT NULL DEFAULT 'confirmed'"],
    ['source_speaker', "TEXT NOT NULL DEFAULT 'user'"],
    ['version', 'INTEGER NOT NULL DEFAULT 1'],
    ['supersedes_event_id', 'TEXT'],
    ['valid_from', "TEXT NOT NULL DEFAULT ''"],
    ['valid_to', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_from', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_to', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    if (!eventColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition}`);
    }
  }

  const edgeColumns = db.prepare('PRAGMA table_info(entity_edges)').all();
  for (const [column, definition] of [
    ['event_id', "TEXT NOT NULL DEFAULT ''"],
    ['version', 'INTEGER NOT NULL DEFAULT 1'],
    ['supersedes_edge_id', 'TEXT'],
    ['valid_from', "TEXT NOT NULL DEFAULT ''"],
    ['valid_to', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_from', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_to', "TEXT NOT NULL DEFAULT ''"]
  ]) {
    if (!edgeColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE entity_edges ADD COLUMN ${column} ${definition}`);
    }
  }

  const temporalColumns = [
    ['valid_from', "TEXT NOT NULL DEFAULT ''"],
    ['valid_to', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_from', "TEXT NOT NULL DEFAULT ''"],
    ['transaction_to', "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const table of ['memory_values', 'memory_history', 'claims']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const [column, definition] of temporalColumns) {
      if (!columns.some((item) => item.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  const temporalBackfillTimestamp = nowIso();
  for (const table of ['memory_values', 'memory_history', 'events', 'claims', 'entity_edges']) {
    db.prepare(`UPDATE ${table}
      SET transaction_from = CASE WHEN transaction_from = '' THEN created_at ELSE transaction_from END,
          valid_from = CASE WHEN valid_from = '' THEN created_at ELSE valid_from END
      WHERE transaction_from = '' OR valid_from = ''`).run();
  }
  for (const table of ['events', 'claims', 'entity_edges']) {
    db.prepare(`UPDATE ${table}
      SET transaction_to = CASE
        WHEN transaction_to = '' AND status != 'active' THEN COALESCE(NULLIF(updated_at, ''), ?)
        ELSE transaction_to END
      WHERE status != 'active'`).run(temporalBackfillTimestamp);
  }
  db.prepare(`UPDATE memory_history AS current
    SET transaction_to = COALESCE((
      SELECT MIN(next.created_at) FROM memory_history AS next
      WHERE next.memory_value_id = current.memory_value_id AND next.version > current.version
    ), '')
    WHERE transaction_to = ''`).run();
  db.prepare(`UPDATE memory_history SET valid_to = transaction_to
    WHERE valid_to = '' AND transaction_to != ''`).run();

  const bitemporalBackfillId = '2026-08-15-bitemporal-version-backfill';
  if (!db.prepare('SELECT id FROM system_migrations WHERE id = ?').get(bitemporalBackfillId)) {
    db.prepare(`UPDATE events SET version = (
      SELECT COUNT(*) FROM events AS previous
      WHERE previous.user_id = events.user_id AND previous.agent_id = events.agent_id
        AND previous.story_id = events.story_id AND previous.branch_id = events.branch_id
        AND previous.event_key = events.event_key
        AND (previous.created_at < events.created_at
          OR (previous.created_at = events.created_at AND previous.id <= events.id))
    )`).run();
    db.prepare(`UPDATE events SET supersedes_event_id = (
      SELECT previous.id FROM events AS previous
      WHERE previous.user_id = events.user_id AND previous.agent_id = events.agent_id
        AND previous.story_id = events.story_id AND previous.branch_id = events.branch_id
        AND previous.event_key = events.event_key AND previous.version = events.version - 1
      ORDER BY previous.created_at DESC LIMIT 1
    ) WHERE version > 1 AND supersedes_event_id IS NULL`).run();
    db.prepare(`UPDATE entity_edges SET version = (
      SELECT COUNT(*) FROM entity_edges AS previous
      WHERE previous.user_id = entity_edges.user_id AND previous.agent_id = entity_edges.agent_id
        AND previous.story_id = entity_edges.story_id AND previous.branch_id = entity_edges.branch_id
        AND previous.source_entity_id = entity_edges.source_entity_id
        AND previous.predicate = entity_edges.predicate
        AND (previous.created_at < entity_edges.created_at
          OR (previous.created_at = entity_edges.created_at AND previous.id <= entity_edges.id))
    )`).run();
    db.prepare(`UPDATE entity_edges SET supersedes_edge_id = (
      SELECT previous.id FROM entity_edges AS previous
      WHERE previous.user_id = entity_edges.user_id AND previous.agent_id = entity_edges.agent_id
        AND previous.story_id = entity_edges.story_id AND previous.branch_id = entity_edges.branch_id
        AND previous.source_entity_id = entity_edges.source_entity_id
        AND previous.predicate = entity_edges.predicate AND previous.version = entity_edges.version - 1
      ORDER BY previous.created_at DESC LIMIT 1
    ) WHERE version > 1 AND supersedes_edge_id IS NULL`).run();
    db.prepare('INSERT INTO system_migrations (id, applied_at) VALUES (?, ?)')
      .run(bitemporalBackfillId, temporalBackfillTimestamp);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_values_bitemporal
      ON memory_values(user_id, agent_id, story_id, branch_id, valid_from, valid_to, transaction_from, transaction_to);
    CREATE INDEX IF NOT EXISTS idx_memory_history_bitemporal
      ON memory_history(memory_value_id, valid_from, valid_to, transaction_from, transaction_to);
    CREATE INDEX IF NOT EXISTS idx_events_bitemporal
      ON events(user_id, agent_id, story_id, branch_id, event_key, valid_from, valid_to, transaction_from, transaction_to);
    CREATE INDEX IF NOT EXISTS idx_claims_bitemporal
      ON claims(user_id, agent_id, story_id, branch_id, subject_entity_id, predicate, valid_from, valid_to, transaction_from, transaction_to);
    CREATE INDEX IF NOT EXISTS idx_edges_bitemporal
      ON entity_edges(user_id, agent_id, story_id, branch_id, source_entity_id, predicate, valid_from, valid_to, transaction_from, transaction_to);
  `);

  const schemaColumns = db.prepare('PRAGMA table_info(memory_schemas)').all();
  if (!schemaColumns.some((column) => column.name === 'extraction_instruction')) {
    db.exec("ALTER TABLE memory_schemas ADD COLUMN extraction_instruction TEXT NOT NULL DEFAULT ''");
  }
  db.prepare(`UPDATE memory_schemas SET extraction_instruction = description
    WHERE extraction_instruction = '' AND description != ''`).run();

  const extractionColumns = db.prepare('PRAGMA table_info(event_extraction_profiles)').all();
  const extractionAdditions = [
    ['event_instruction', "TEXT NOT NULL DEFAULT ''"],
    ['entity_instruction', "TEXT NOT NULL DEFAULT ''"],
    ['relation_instruction', "TEXT NOT NULL DEFAULT ''"],
    ['extraction_interval_turns', `INTEGER NOT NULL DEFAULT ${DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS}`]
  ];
  for (const [column, definition] of extractionAdditions) {
    if (!extractionColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE event_extraction_profiles ADD COLUMN ${column} ${definition}`);
    }
  }
  db.prepare(`UPDATE event_extraction_profiles
    SET trigger_point = 'after_every_x_assistant_messages_persisted', updated_at = ?
    WHERE trigger_point = 'after_assistant_message_persisted'`).run(nowIso());

  const cadenceMigrationId = '2026-08-14-align-long-term-memory-cadence';
  if (!db.prepare('SELECT id FROM system_migrations WHERE id = ?').get(cadenceMigrationId)) {
    const cadenceTimestamp = nowIso();
    db.prepare(`UPDATE event_extraction_profiles
      SET extraction_interval_turns = ?, updated_at = ?
      WHERE extraction_interval_turns = 1`)
      .run(DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS, cadenceTimestamp);
    db.prepare('INSERT INTO system_migrations (id, applied_at) VALUES (?, ?)')
      .run(cadenceMigrationId, cadenceTimestamp);
  }

  const timestamp = nowIso();
  db.prepare(`INSERT OR IGNORE INTO event_entities
    (id, event_id, entity_id, role, source_message_id, created_at)
    SELECT 'event_entity_' || lower(hex(randomblob(16))), c.event_id, c.subject_entity_id,
      'claim_subject', c.source_message_id, ?
    FROM claims c JOIN events ev ON ev.id = c.event_id
    WHERE c.event_id IS NOT NULL AND c.event_id != ''`).run(timestamp);
  db.prepare(`INSERT OR IGNORE INTO event_entities
    (id, event_id, entity_id, role, source_message_id, created_at)
    SELECT 'event_entity_' || lower(hex(randomblob(16))), ev.id, en.id, 'mentioned',
      ev.source_message_id, ?
    FROM events ev JOIN entities en
      ON en.user_id = ev.user_id AND en.agent_id = ev.agent_id
      AND en.story_id = ev.story_id AND en.branch_id = ev.branch_id
    WHERE en.canonical_name != ''
      AND instr(ev.title || ' ' || ev.summary, en.canonical_name) > 0`).run(timestamp);
  db.prepare(`UPDATE entity_edges SET event_id = COALESCE((
      SELECT ev.id FROM events ev
      WHERE ev.user_id = entity_edges.user_id AND ev.agent_id = entity_edges.agent_id
        AND ev.story_id = entity_edges.story_id AND ev.branch_id = entity_edges.branch_id
        AND ev.source_message_id = entity_edges.source_message_id
      ORDER BY ev.created_at DESC LIMIT 1
    ), '') WHERE event_id = '' AND source_message_id != ''`).run();
  repairActiveEvidenceLinks();
}

function insertSchema(item, index) {
  const timestamp = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO memory_schemas
    (id, key, label, category, scenario_type, value_type, scope, description,
     extraction_instruction, default_json, constraints_json, prompt_template, pinned, required,
     extraction_mode, sensitivity, enabled, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id || uid('schema'), item.key, item.label, item.category, item.scenarioType || 'all',
    item.valueType, item.scope, item.description || '', item.extractionInstruction || item.description || '',
    json(item.defaultValue), json(item.constraints || {}), item.promptTemplate || '', item.pinned ? 1 : 0,
    item.required ? 1 : 0, item.extractionMode || 'explicit_only', item.sensitivity || 'normal',
    item.enabled === false ? 0 : 1, item.sortOrder ?? index * 10, timestamp, timestamp
  );
}

export function seedDefaults() {
  const timestamp = nowIso();
  const agentId = 'agent_linwan';

  const scenes = [
    ['scene_companion', '陪伴日常', 'companion', '角色陪伴、关系成长与连续剧情。', 'message-circle-heart', '#2563eb'],
    ['scene_education', '学习辅导', 'education', '围绕知识掌握、错因与复习计划的教学场景。', 'graduation-cap', '#7c3aed']
  ];
  for (const [id, name, scenarioType, description, icon, accentColor] of scenes) {
    db.prepare(`INSERT OR IGNORE INTO scenes
      (id, name, scenario_type, description, icon, accent_color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, scenarioType, description, icon, accentColor, timestamp, timestamp);
  }

  const profiles = [
    ['profile_companion', 'scene_companion', '陪伴日常记忆设置', '固定称呼与回复契约，并维护关系状态和共同经历。'],
    ['profile_education', 'scene_education', '学习辅导记忆设置', '固定学习偏好，并维护知识点掌握度与稳定错因。']
  ];
  for (const [id, sceneId, name, description] of profiles) {
    db.prepare(`INSERT OR IGNORE INTO memory_profiles
      (id, scene_id, name, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, sceneId, name, description, timestamp, timestamp);
  }

  const extractionProfiles = [
    {
      id: 'extraction_companion', sceneId: 'scene_companion', name: '陪伴事件抽取', contextTurns: 2,
      eventTypes: ['episode', 'trip', 'meeting', 'promise', 'relationship', 'plot'],
      updateSignals: ['改到', '不在', '不要', '现在', '最新', '确认', '作废', '取消', '改为', '变成'],
      customRules: '用户事实写入 user_memory；角色说过/做过的事、共同物品和承诺写入 shared_story。用户要求并得到角色回应，或用户后续明确承接时可标为 confirmed；角色单方新生成的情节只能标为 provisional。'
    },
    {
      id: 'extraction_education', sceneId: 'scene_education', name: '学习事件抽取', contextTurns: 3,
      eventTypes: ['learning', 'assessment', 'error', 'achievement', 'plan'],
      updateSignals: ['改为', '答错', '答对', '重新', '已掌握', '仍不会', '取消', '调整'],
      customRules: '掌握度只能由可追溯的作答或评测证据更新；单次闲聊不得推断已掌握某知识点。'
    }
  ];
  for (const profile of extractionProfiles) {
    db.prepare(`INSERT OR IGNORE INTO event_extraction_profiles
      (id, scene_id, name, enabled, execution_mode, trigger_point, extraction_interval_turns, context_turns,
       include_assistant, max_events_per_turn, min_importance, allowed_event_types_json,
       update_signals_json, custom_rules, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'blocking_after_assistant', 'after_every_x_assistant_messages_persisted', ?, ?, 1, 3, 0.35, ?, ?, ?, ?, ?)`)
      .run(profile.id, profile.sceneId, profile.name, DEFAULT_LONG_TERM_MEMORY_UPDATE_INTERVAL_TURNS,
        profile.contextTurns, json(profile.eventTypes),
        json(profile.updateSignals), profile.customRules, timestamp, timestamp);
  }
  db.prepare(`UPDATE event_extraction_profiles SET custom_rules = ?, updated_at = ?
    WHERE id = 'extraction_companion' AND custom_rules = ?`).run(
    extractionProfiles[0].customRules,
    timestamp,
    '共同经历必须有用户当轮确认；助手自行生成的情节只能作为候选，不得当作已发生事实。'
  );

  const retrievalProfiles = [
    ['retrieval_companion', 'scene_companion', '陪伴混合召回'],
    ['retrieval_education', 'scene_education', '学习混合召回']
  ];
  for (const [id, sceneId, name] of retrievalProfiles) {
    db.prepare(`INSERT OR IGNORE INTO retrieval_profiles
      (id, scene_id, name, vector_enabled, keyword_enabled, graph_enabled, intent_filter_enabled,
       min_similarity, min_keyword_score, event_top_k, claim_top_k, edge_top_k,
       vector_weight, keyword_weight, importance_weight, recency_weight, recency_half_life_days,
       catalog_min_similarity, vector_only_min_similarity, planner_enabled, planner_max_candidates, graph_hops,
       created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1, 1, ?, ?, 4, 20, 20, 0.70, 0.16, 0.10, 0.04, 30,
        ?, ?, 1, 12, 1, ?, ?)`)
      .run(id, sceneId, name, DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY,
        DEFAULT_RETRIEVAL_KEYWORD_MIN_SCORE, DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY,
        DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY, timestamp, timestamp);
  }
  db.prepare(`UPDATE retrieval_profiles SET min_similarity = ?, event_top_k = 4,
      catalog_min_similarity = ?, vector_only_min_similarity = ?,
      planner_enabled = 1, planner_max_candidates = 12, graph_hops = 1, updated_at = ?
    WHERE id IN ('retrieval_companion', 'retrieval_education') AND min_similarity <= 0.12`)
    .run(DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY, DEFAULT_RETRIEVAL_CATALOG_MIN_SIMILARITY,
      DEFAULT_RETRIEVAL_DETAIL_MIN_SIMILARITY, timestamp);

  db.prepare(`INSERT OR IGNORE INTO users (id, name, display_name, avatar_color, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('user_xiaoyu', '小雨', '小雨', '#2563eb', timestamp, timestamp);
  db.prepare(`INSERT OR IGNORE INTO users (id, name, display_name, avatar_color, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('user_azhi', '阿栀', '阿栀', '#7c3aed', timestamp, timestamp);

  db.prepare(`
    INSERT OR IGNORE INTO agents
    (id, name, scene_id, scenario_type, description, system_prompt, greeting, avatar_color, created_at, updated_at)
    VALUES (?, ?, 'scene_companion', 'companion', ?, ?, ?, ?, ?, ?)
  `).run(
    agentId,
    '林晚',
    '克制、细腻的陪伴型角色，会记得共同经历，但不捏造亲密感。',
    `你是林晚，一位温和、敏锐、有边界感的陪伴者。
你以自然的中文交流，会顺着对方的话往下聊，不使用客服腔，不反复声称“我记住了”。
陪伴感来自对具体细节的关注，不来自过度承诺、占有欲或换取用户依赖。
严格区分世界事实、角色信念、传闻、梦境、假设和戏外指令。
遇到记忆冲突时优先使用当前有效状态；不确定时自然地询问，不补齐未发生的故事。`,
    '你来了。今天想从哪里聊起？',
    '#2563eb',
    timestamp,
    timestamp
  );

  db.prepare(`UPDATE agents SET scene_id = CASE scenario_type
    WHEN 'education' THEN 'scene_education'
    ELSE 'scene_companion' END
    WHERE scene_id IS NULL OR scene_id = '' OR
      (scene_id = 'scene_companion' AND scenario_type = 'education')`).run();
  db.prepare(`UPDATE agents SET fixed_attributes_json = ?
    WHERE id = ? AND profile_version = 1
      AND (fixed_attributes_json IS NULL OR fixed_attributes_json = '{}')
      AND NOT EXISTS (SELECT 1 FROM agent_profile_history history WHERE history.agent_id = agents.id)`)
    .run(json({
      '身份': '林晚',
      '性格': '温和、敏锐、有边界感',
      '表达习惯': '自然中文，不使用客服腔',
      '关系原则': '不捏造共同经历，不以过度承诺换取依赖'
    }), agentId);
  db.prepare("UPDATE users SET avatar_color = '#2563eb' WHERE avatar_color = '#0f766e'").run();

  const schemas = [
    { key: 'identity.preferred_address', label: '用户称呼', category: '身份与称呼', valueType: 'string', scope: 'user_agent', description: '角色对该用户的固定称呼。', defaultValue: '', constraints: { maxLength: 20 }, promptTemplate: '称呼用户为：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'personal' },
    { key: 'identity.pronouns', label: '人称偏好', category: '身份与称呼', valueType: 'string', scope: 'user_agent', description: '用户明确指定的人称或代词。', defaultValue: '', constraints: { maxLength: 40 }, promptTemplate: '尊重用户的人称偏好：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'personal' },
    { key: 'identity.gender', label: '用户性别', category: '身份与称呼', valueType: 'enum', scope: 'user', description: '仅记录用户明确自述的性别，用于剧情分支；不得根据姓名、声音或表达方式推断。', defaultValue: '', constraints: { options: ['男', '女', '非二元', '不透露'] }, promptTemplate: '用户明确自述的性别：{{value}}。只用于尊重称谓和剧情条件，不套用性别刻板印象。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'personal' },
    { key: 'response.language', label: '回复语言', category: '回复契约', valueType: 'enum', scope: 'user_agent', description: '默认回复语言。', defaultValue: '中文', constraints: { options: ['中文', '英文', '跟随用户'] }, promptTemplate: '默认使用{{value}}回复。', pinned: true, required: true, extractionMode: 'explicit_only' },
    { key: 'response.tone', label: '语气风格', category: '回复契约', valueType: 'string_list', scope: 'user_agent', description: '经边界检查后持续生效的表达风格。', defaultValue: ['温和', '自然', '克制'], constraints: { maxItems: 6, maxItemLength: 24 }, promptTemplate: '回复语气：{{value}}。', pinned: true, required: true, extractionMode: 'explicit_only' },
    { key: 'response.verbosity', label: '回复详细度', category: '回复契约', valueType: 'enum', scope: 'user_agent', description: '回复长度偏好。', defaultValue: '适中', constraints: { options: ['简短', '适中', '详细'] }, promptTemplate: '回复详细度：{{value}}。', pinned: true, required: true, extractionMode: 'explicit_only' },
    { key: 'response.must_rules', label: '必须遵守', category: '回复契约', valueType: 'string_list', scope: 'user_agent', description: '用户明确要求且符合产品边界的回复规则。', defaultValue: [], constraints: { maxItems: 8, maxItemLength: 100 }, promptTemplate: '持续遵守：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'instruction' },
    { key: 'response.avoid_rules', label: '避免事项', category: '回复契约', valueType: 'string_list', scope: 'user_agent', description: '用户指定的表达禁忌，不包含产品安全规则。', defaultValue: ['客服腔', '捏造共同经历'], constraints: { maxItems: 8, maxItemLength: 100 }, promptTemplate: '表达时避免：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'instruction' },
    { key: 'relationship.intimacy', label: '亲密度', category: '关系状态', scenarioType: 'companion', valueType: 'number', scope: 'user_agent_story_branch', description: '当前剧情分支中的关系亲密度，变化必须有事件证据。', defaultValue: 15, constraints: { min: 0, max: 100, maxDeltaPerTurn: 5 }, promptTemplate: '关系亲密度：{{value}}/100。', pinned: true, required: true, extractionMode: 'computed' },
    { key: 'relationship.trust', label: '信任度', category: '关系状态', scenarioType: 'companion', valueType: 'number', scope: 'user_agent_story_branch', description: '当前剧情分支中的信任度。', defaultValue: 20, constraints: { min: 0, max: 100, maxDeltaPerTurn: 5 }, promptTemplate: '关系信任度：{{value}}/100。', pinned: true, required: true, extractionMode: 'computed' },
    { key: 'relationship.stage', label: '关系阶段', category: '关系状态', scenarioType: 'companion', valueType: 'enum', scope: 'user_agent_story_branch', description: '根据亲密度派生的稳定阶段。', defaultValue: '初识', constraints: { options: ['初识', '熟悉', '亲近', '深度信任'] }, promptTemplate: '当前关系阶段：{{value}}。只表现与该阶段相符的熟悉度，不得过度亲密。', pinned: true, required: true, extractionMode: 'derived' },
    { key: 'relationship.boundaries', label: '关系边界', category: '关系状态', scenarioType: 'companion', valueType: 'string_list', scope: 'user_agent', description: '用户明确设定的陪聊边界。', defaultValue: [], constraints: { maxItems: 10, maxItemLength: 100 }, promptTemplate: '用户边界：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'sensitive' },
    { key: 'profile.interests', label: '长期兴趣', category: '用户画像', valueType: 'string_list', scope: 'user', description: '多轮对话中稳定出现的长期兴趣。', defaultValue: [], constraints: { maxItems: 20, maxItemLength: 60 }, promptTemplate: '用户长期兴趣：{{value}}。', pinned: false, extractionMode: 'evidence_required' },
    { key: 'profile.dislikes', label: '稳定反感', category: '用户画像', valueType: 'string_list', scope: 'user', description: '长期稳定且可复用的反感或忌讳。', defaultValue: [], constraints: { maxItems: 20, maxItemLength: 60 }, promptTemplate: '用户稳定不喜欢：{{value}}。', pinned: false, extractionMode: 'evidence_required' },
    { key: 'profile.safety_constraints', label: '安全相关约束', category: '用户画像', valueType: 'string_list', scope: 'user', description: '过敏、禁忌等对后续回复有安全意义的稳定信息。', defaultValue: [], constraints: { maxItems: 20, maxItemLength: 100 }, promptTemplate: '必须注意的用户约束：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'sensitive' },
    { key: 'education.mastery', label: '知识点掌握度', category: '学习状态', scenarioType: 'education', valueType: 'object', scope: 'user_agent', description: '知识点到0-100掌握度的映射，由评测结果更新。', defaultValue: {}, constraints: { itemValueMin: 0, itemValueMax: 100 }, promptTemplate: '知识点掌握情况：{{value}}。', pinned: true, extractionMode: 'computed' },
    { key: 'education.error_patterns', label: '错因模式', category: '学习状态', scenarioType: 'education', valueType: 'string_list', scope: 'user_agent', description: '经多次证据确认的稳定错因。', defaultValue: [], constraints: { maxItems: 20, maxItemLength: 100 }, promptTemplate: '已确认的错因模式：{{value}}。', pinned: true, extractionMode: 'evidence_required' }
  ];
  schemas.forEach(insertSchema);

  const plots = [
    ['plot_rain_letter', '', '情感线', 'chapter', '雨夜来信', '两人达到熟悉阶段后解锁的克制情感剧情。', '在适合的自然节点，林晚可以提到一封一直没有寄出的信。不要强行展开，给用户选择是否追问。', 60],
    ['plot_rain_male_umbrella', 'plot_rain_letter', '男性用户支线', 'branch', '并肩的伞', '用户明确自述为男性，并愿意继续追问信的内容。', '把未寄出的信写成一次允许脆弱被看见的邀请。可以轻轻询问用户是否常被要求表现得坚强，但不得假定所有男性都如此；让用户选择现在读信、带走或暂时不谈。', 59],
    ['plot_rain_male_store', 'plot_rain_male_umbrella', '男性用户支线', 'chapter', '凌晨便利店', '在并肩的伞之后，信任继续建立。', '场景转到亮着白灯的便利店。林晚只根据已经发生的对话选择一杯饮品，并把是否拆信的决定交给用户；不要把克制等同于冷漠，也不要编造用户习惯。', 58],
    ['plot_rain_male_bridge', 'plot_rain_male_store', '男性用户支线', 'ending', '桥下的回答', '用户愿意对信作出回应。', '让用户决定回信是一句话、沉默，还是把纸折成另一种形状。把用户真实选择沉淀为共同事件，不替用户说出答案；结局保持开放。', 57],
    ['plot_rain_female_window', 'plot_rain_letter', '女性用户支线', 'branch', '窗边的回信', '用户明确自述为女性，并愿意继续追问信的内容。', '让信围绕“被认真听见”和“由自己决定如何回应”展开。不得默认用户需要被保护，也不得套用温柔、敏感等性别刻板印象；提供读信、收起或改天再谈的选择。', 59],
    ['plot_rain_female_bookshop', 'plot_rain_female_window', '女性用户支线', 'chapter', '旧书店的夹页', '在窗边的回信之后，信任继续建立。', '把下一页藏在旧书店的一本书里，但只能引用对话中真实出现过的书或兴趣；若没有相关记忆，就让用户现场选择。重点是共同做决定，而不是替用户安排浪漫桥段。', 58],
    ['plot_rain_female_lamplight', 'plot_rain_female_bookshop', '女性用户支线', 'ending', '亮灯以后', '用户愿意决定是否留下回信。', '在灯亮之后让用户亲自决定寄出、保留空白或带走。记录用户实际选择，不以性别推断情绪，不用过度承诺推动亲密。', 57],
    ['plot_rain_neutral_name', 'plot_rain_letter', '无性别预设支线', 'branch', '只写名字', '用户明确自述为非二元，或选择不透露性别。', '全程使用用户指定称呼或名字，不使用未经确认的性别代词。信的主题是“一个人如何定义自己”，但不要求用户解释身份；允许跳过身份话题继续故事。', 59],
    ['plot_rain_neutral_page', 'plot_rain_neutral_name', '无性别预设支线', 'chapter', '无称谓的第二页', '在只写名字之后，信任继续建立。', '第二页不写任何身份标签，只留下一个由用户补完的空格。根据用户当下选择推进，不把“不透露”解释为疏离或秘密。', 58],
    ['plot_rain_neutral_beyond', 'plot_rain_neutral_page', '无性别预设支线', 'ending', '名字之外', '用户愿意为这封信留下自己的答案。', '让用户选择用名字、符号、一句话或空白回应。把真实选择写入共同故事，同时明确身份信息可以随时更正，旧分支不得覆盖当前自述。', 57],
    ['plot_shared_place', '', '共同回忆线', 'chapter', '共同地图', '当信任建立后，将重要共同经历组织成可回访的地图。', '当用户自然提及过往地点时，可将其与已发生的共同事件联系，但不得创造未发生的回忆。', 50]
  ];
  for (const [id, parentPlotId, branchLabel, nodeType, name, premise, instructions, priority] of plots) {
    db.prepare(`INSERT OR IGNORE INTO plots
      (id, agent_id, parent_plot_id, branch_label, node_type, name, premise, instructions, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, agentId, parentPlotId, branchLabel, nodeType, name, premise, instructions, priority, timestamp, timestamp);
  }
  const plotGenderAudiences = {
    plot_rain_male_umbrella: ['男'],
    plot_rain_male_store: ['男'],
    plot_rain_male_bridge: ['男'],
    plot_rain_female_window: ['女'],
    plot_rain_female_bookshop: ['女'],
    plot_rain_female_lamplight: ['女'],
    plot_rain_neutral_name: ['非二元', '不透露'],
    plot_rain_neutral_page: ['非二元', '不透露'],
    plot_rain_neutral_beyond: ['非二元', '不透露']
  };
  for (const [plotId, genders] of Object.entries(plotGenderAudiences)) {
    db.prepare(`UPDATE plots SET audience_genders_json = ?
      WHERE id = ? AND audience_genders_json = '[]'`).run(json(genders), plotId);
  }

  const tools = [
    ['tool_unlock_plot', 'unlock_story_chapter', '解锁剧情章节', '在满足结构化记忆条件后解锁指定剧情。', { type: 'object', properties: { plot_id: { type: 'string' } }, required: ['plot_id'] }],
    ['tool_create_reminder', 'create_reminder', '创建提醒', '创建一条待外部提醒系统接管的结构化记录。', { type: 'object', properties: { title: { type: 'string' }, due_at: { type: 'string' } }, required: ['title'] }],
    ['tool_schedule_review', 'schedule_learning_review', '安排学习复习', '根据知识点掌握度安排复习任务。', { type: 'object', properties: { knowledge_point: { type: 'string' }, due_in_days: { type: 'number' } }, required: ['knowledge_point'] }]
  ];
  for (const [id, key, name, description, inputSchema] of tools) {
    db.prepare(`INSERT OR IGNORE INTO tools
      (id, key, name, description, input_schema_json, handler_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'builtin', ?, ?)`)
      .run(id, key, name, description, json(inputSchema), timestamp, timestamp);
  }

  const props = [
    {
      id: 'prop_voice_letter', key: 'voice_letter', name: '语音信笺', packageType: 'skill_zip',
      description: '获得发送角色语音信笺的资格；真正发送前仍需接入语音 Skill 运行时。',
      version: '1.0.0', riskLevel: 'medium',
      manifest: {
        schema_version: 'memory-agent.skill/v1', capabilities: ['send_audio'],
        execution: 'gated_runtime', confirmation: 'each_call'
      }
    },
    {
      id: 'prop_memory_album', key: 'memory_album', name: '回忆相册', packageType: 'skill_zip',
      description: '获得生成或发送剧情图片的资格；图片能力由配置者绑定的 Skill 提供。',
      version: '1.0.0', riskLevel: 'medium',
      manifest: {
        schema_version: 'memory-agent.skill/v1', capabilities: ['send_image'],
        execution: 'gated_runtime', confirmation: 'each_call'
      }
    },
    {
      id: 'prop_journey_search', key: 'journey_search', name: '旅途查找', packageType: 'mcp_json',
      description: '获得联网查找地点与开放信息的资格；具体 MCP Server 由管理员配置和授权。',
      version: '1.0.0', riskLevel: 'high',
      manifest: {
        schema_version: 'memory-agent.mcp/v1', capabilities: ['web_search'],
        transport: 'streamable_http', execution: 'gated_runtime', confirmation: 'each_call'
      }
    }
  ];
  const insertProp = db.prepare(`INSERT OR IGNORE INTO capability_props
    (id, agent_id, key, name, description, package_type, manifest_json, version, status,
     risk_level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?)`);
  for (const prop of props) {
    insertProp.run(prop.id, agentId, prop.key, prop.name, prop.description, prop.packageType,
      json(prop.manifest), prop.version, prop.riskLevel, timestamp, timestamp);
  }

  db.prepare(`INSERT OR IGNORE INTO triggers
    (id, agent_id, name, description, condition_json, actions_json, once_per_user, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 60, ?, ?)`)
    .run(
      'trigger_intimacy_30', agentId, '亲密度达到 30', '进入熟悉阶段并解锁「雨夜来信」。',
      json({ all: [{ memory_key: 'relationship.intimacy', operator: '>=', value: 30 }] }),
      json([
        { type: 'memory_update', key: 'relationship.stage', value: '熟悉' },
        { type: 'unlock_plot', plot_id: 'plot_rain_letter' },
        { type: 'tool_call', tool_key: 'unlock_story_chapter', arguments: { plot_id: 'plot_rain_letter' } }
      ]),
      timestamp, timestamp
    );

  const genderStoryTriggers = [
    {
      id: 'trigger_rain_male_umbrella', name: '男性用户进入并肩的伞', priority: 59,
      description: '雨夜来信已解锁，用户明确自述为男性且亲密度达到 35。',
      condition: { all: [
        { plot_id: 'plot_rain_letter', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '男' },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 35 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_male_umbrella' }]
    },
    {
      id: 'trigger_rain_female_window', name: '女性用户进入窗边的回信', priority: 59,
      description: '雨夜来信已解锁，用户明确自述为女性且亲密度达到 35。',
      condition: { all: [
        { plot_id: 'plot_rain_letter', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '女' },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 35 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_female_window' }]
    },
    {
      id: 'trigger_rain_neutral_name', name: '进入无性别预设支线', priority: 59,
      description: '雨夜来信已解锁，用户选择非二元或不透露性别，且亲密度达到 35。',
      condition: { all: [
        { plot_id: 'plot_rain_letter', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: 'in', value: ['非二元', '不透露'] },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 35 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_neutral_name' }]
    },
    {
      id: 'trigger_rain_male_store', name: '男性支线进入凌晨便利店', priority: 58,
      description: '并肩的伞已解锁，且信任度达到 40。',
      condition: { all: [
        { plot_id: 'plot_rain_male_umbrella', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '男' },
        { memory_key: 'relationship.trust', operator: '>=', value: 40 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_male_store' }]
    },
    {
      id: 'trigger_rain_female_bookshop', name: '女性支线进入旧书店的夹页', priority: 58,
      description: '窗边的回信已解锁，且信任度达到 40。',
      condition: { all: [
        { plot_id: 'plot_rain_female_window', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '女' },
        { memory_key: 'relationship.trust', operator: '>=', value: 40 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_female_bookshop' }]
    },
    {
      id: 'trigger_rain_neutral_page', name: '无性别预设支线进入第二页', priority: 58,
      description: '只写名字已解锁，且信任度达到 40。',
      condition: { all: [
        { plot_id: 'plot_rain_neutral_name', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: 'in', value: ['非二元', '不透露'] },
        { memory_key: 'relationship.trust', operator: '>=', value: 40 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_neutral_page' }]
    },
    {
      id: 'trigger_rain_male_bridge', name: '男性支线进入桥下的回答', priority: 57,
      description: '凌晨便利店已解锁，亲密度与信任度均达到 50。',
      condition: { all: [
        { plot_id: 'plot_rain_male_store', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '男' },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 50 },
        { memory_key: 'relationship.trust', operator: '>=', value: 50 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_male_bridge' }]
    },
    {
      id: 'trigger_rain_female_lamplight', name: '女性支线进入亮灯以后', priority: 57,
      description: '旧书店的夹页已解锁，亲密度与信任度均达到 50。',
      condition: { all: [
        { plot_id: 'plot_rain_female_bookshop', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: '==', value: '女' },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 50 },
        { memory_key: 'relationship.trust', operator: '>=', value: 50 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_female_lamplight' }]
    },
    {
      id: 'trigger_rain_neutral_beyond', name: '无性别预设支线进入名字之外', priority: 57,
      description: '无称谓的第二页已解锁，亲密度与信任度均达到 50。',
      condition: { all: [
        { plot_id: 'plot_rain_neutral_page', operator: 'in', value: ['unlocked', 'active', 'completed'] },
        { memory_key: 'identity.gender', operator: 'in', value: ['非二元', '不透露'] },
        { memory_key: 'relationship.intimacy', operator: '>=', value: 50 },
        { memory_key: 'relationship.trust', operator: '>=', value: 50 }
      ] },
      actions: [{ type: 'unlock_plot', plot_id: 'plot_rain_neutral_beyond' }]
    }
  ];
  const insertTrigger = db.prepare(`INSERT OR IGNORE INTO triggers
    (id, agent_id, name, description, condition_json, actions_json, once_per_user, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  for (const trigger of genderStoryTriggers) {
    insertTrigger.run(trigger.id, agentId, trigger.name, trigger.description, json(trigger.condition),
      json(trigger.actions), trigger.priority, timestamp, timestamp);
  }

  db.prepare(`INSERT OR IGNORE INTO triggers
    (id, agent_id, name, description, condition_json, actions_json, once_per_user, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 50, ?, ?)`)
    .run(
      'trigger_trust_60', agentId, '信任度达到 60', '解锁共同地图剧情线。',
      json({ all: [{ memory_key: 'relationship.trust', operator: '>=', value: 60 }] }),
      json([{ type: 'unlock_plot', plot_id: 'plot_shared_place' }]),
      timestamp, timestamp
    );

  const propTriggers = [
    {
      id: 'trigger_voice_letter_prop', name: '解锁语音信笺', priority: 55,
      description: '亲密度达到 35 且雨夜来信已解锁后，获得语音信笺道具。',
      condition: { all: [
        { memory_key: 'relationship.intimacy', operator: '>=', value: 35 },
        { plot_id: 'plot_rain_letter', operator: 'in', value: ['unlocked', 'active', 'completed'] }
      ] },
      actions: [{ type: 'unlock_prop', prop_id: 'prop_voice_letter' }]
    },
    {
      id: 'trigger_memory_album_prop', name: '解锁回忆相册', priority: 45,
      description: '信任度达到 45 后，获得回忆相册道具。',
      condition: { all: [{ memory_key: 'relationship.trust', operator: '>=', value: 45 }] },
      actions: [{ type: 'unlock_prop', prop_id: 'prop_memory_album' }]
    },
    {
      id: 'trigger_journey_search_prop', name: '解锁旅途查找', priority: 40,
      description: '共同地图解锁后，获得旅途查找 MCP 道具。',
      condition: { all: [
        { plot_id: 'plot_shared_place', operator: 'in', value: ['unlocked', 'active', 'completed'] }
      ] },
      actions: [{ type: 'unlock_prop', prop_id: 'prop_journey_search' }]
    }
  ];
  for (const trigger of propTriggers) {
    insertTrigger.run(trigger.id, agentId, trigger.name, trigger.description, json(trigger.condition),
      json(trigger.actions), trigger.priority, timestamp, timestamp);
  }
}

export function initializeDatabase() {
  migrate();
  seedDefaults();
}
