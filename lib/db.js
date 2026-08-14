import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { json, nowIso, uid } from './utils.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

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
      trigger_point TEXT NOT NULL DEFAULT 'after_assistant_message_persisted',
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

    CREATE TABLE IF NOT EXISTS retrieval_profiles (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL UNIQUE REFERENCES scenes(id),
      name TEXT NOT NULL,
      vector_enabled INTEGER NOT NULL DEFAULT 1,
      keyword_enabled INTEGER NOT NULL DEFAULT 1,
      graph_enabled INTEGER NOT NULL DEFAULT 1,
      intent_filter_enabled INTEGER NOT NULL DEFAULT 1,
      min_similarity REAL NOT NULL DEFAULT 0.12,
      min_keyword_score REAL NOT NULL DEFAULT 0.08,
      event_top_k INTEGER NOT NULL DEFAULT 8,
      claim_top_k INTEGER NOT NULL DEFAULT 20,
      edge_top_k INTEGER NOT NULL DEFAULT 20,
      vector_weight REAL NOT NULL DEFAULT 0.70,
      keyword_weight REAL NOT NULL DEFAULT 0.16,
      importance_weight REAL NOT NULL DEFAULT 0.10,
      recency_weight REAL NOT NULL DEFAULT 0.04,
      recency_half_life_days INTEGER NOT NULL DEFAULT 30,
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

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
      source_message_id TEXT NOT NULL DEFAULT '',
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
      metadata_json TEXT NOT NULL DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS plots (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      premise TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
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

  const schemaColumns = db.prepare('PRAGMA table_info(memory_schemas)').all();
  if (!schemaColumns.some((column) => column.name === 'extraction_instruction')) {
    db.exec("ALTER TABLE memory_schemas ADD COLUMN extraction_instruction TEXT NOT NULL DEFAULT ''");
  }
  db.prepare(`UPDATE memory_schemas SET extraction_instruction = description
    WHERE extraction_instruction = '' AND description != ''`).run();

  const extractionColumns = db.prepare('PRAGMA table_info(event_extraction_profiles)').all();
  for (const column of ['event_instruction', 'entity_instruction', 'relation_instruction']) {
    if (!extractionColumns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE event_extraction_profiles ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    }
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
      customRules: '共同经历必须有用户当轮确认；助手自行生成的情节只能作为候选，不得当作已发生事实。'
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
      (id, scene_id, name, enabled, execution_mode, trigger_point, context_turns,
       include_assistant, max_events_per_turn, min_importance, allowed_event_types_json,
       update_signals_json, custom_rules, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'blocking_after_assistant', 'after_assistant_message_persisted', ?, 1, 3, 0.35, ?, ?, ?, ?, ?)`)
      .run(profile.id, profile.sceneId, profile.name, profile.contextTurns, json(profile.eventTypes),
        json(profile.updateSignals), profile.customRules, timestamp, timestamp);
  }

  const retrievalProfiles = [
    ['retrieval_companion', 'scene_companion', '陪伴混合召回'],
    ['retrieval_education', 'scene_education', '学习混合召回']
  ];
  for (const [id, sceneId, name] of retrievalProfiles) {
    db.prepare(`INSERT OR IGNORE INTO retrieval_profiles
      (id, scene_id, name, vector_enabled, keyword_enabled, graph_enabled, intent_filter_enabled,
       min_similarity, min_keyword_score, event_top_k, claim_top_k, edge_top_k,
       vector_weight, keyword_weight, importance_weight, recency_weight, recency_half_life_days,
       created_at, updated_at)
      VALUES (?, ?, ?, 1, 1, 1, 1, 0.12, 0.08, 8, 20, 20, 0.70, 0.16, 0.10, 0.04, 30, ?, ?)`)
      .run(id, sceneId, name, timestamp, timestamp);
  }

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
  db.prepare("UPDATE users SET avatar_color = '#2563eb' WHERE avatar_color = '#0f766e'").run();

  const schemas = [
    { key: 'identity.preferred_address', label: '用户称呼', category: '身份与称呼', valueType: 'string', scope: 'user_agent', description: '角色对该用户的固定称呼。', defaultValue: '', constraints: { maxLength: 20 }, promptTemplate: '称呼用户为：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'personal' },
    { key: 'identity.pronouns', label: '人称偏好', category: '身份与称呼', valueType: 'string', scope: 'user_agent', description: '用户明确指定的人称或代词。', defaultValue: '', constraints: { maxLength: 40 }, promptTemplate: '尊重用户的人称偏好：{{value}}。', pinned: true, extractionMode: 'explicit_only', sensitivity: 'personal' },
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
    ['plot_rain_letter', '雨夜来信', '两人达到熟悉阶段后解锁的克制情感剧情。', '在适合的自然节点，林晚可以提到一封一直没有寄出的信。不要强行展开，给用户选择是否追问。', 60],
    ['plot_shared_place', '共同地图', '当信任建立后，将重要共同经历组织成可回访的地图。', '当用户自然提及过往地点时，可将其与已发生的共同事件联系，但不得创造未发生的回忆。', 50]
  ];
  for (const [id, name, premise, instructions, priority] of plots) {
    db.prepare(`INSERT OR IGNORE INTO plots (id, agent_id, name, premise, instructions, priority, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, agentId, name, premise, instructions, priority, timestamp, timestamp);
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

  db.prepare(`INSERT OR IGNORE INTO triggers
    (id, agent_id, name, description, condition_json, actions_json, once_per_user, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 50, ?, ?)`)
    .run(
      'trigger_trust_60', agentId, '信任度达到 60', '解锁共同地图剧情线。',
      json({ all: [{ memory_key: 'relationship.trust', operator: '>=', value: 60 }] }),
      json([{ type: 'unlock_plot', plot_id: 'plot_shared_place' }]),
      timestamp, timestamp
    );
}

export function initializeDatabase() {
  migrate();
  seedDefaults();
}
