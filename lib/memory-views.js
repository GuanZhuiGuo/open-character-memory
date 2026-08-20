import { db } from './db.js';
import { embedText } from './providers/index.js';
import { cosineSimilarity, hash, json, localEmbedding, nowIso, parseJson, safeText } from './utils.js';

export const MEMORY_VIEW_TYPES = Object.freeze([
  'turn', 'event', 'claim', 'episode', 'summary', 'entity_keyword'
]);

export const MEMORY_VIEW_LABELS = Object.freeze({
  turn: '原始轮次',
  event: '事件',
  claim: '原子声明',
  episode: '剧情片段',
  summary: '摘要',
  entity_keyword: '实体与关键词'
});

function eventRecord(eventId) {
  return db.prepare(`SELECT ev.*, m.content AS source_message_content, m.role AS source_message_role,
      m.created_at AS source_message_created_at
    FROM events ev LEFT JOIN messages m ON m.id = ev.source_message_id
    WHERE ev.id = ?`).get(eventId);
}

function eventClaims(eventId) {
  return db.prepare(`SELECT c.*, subject.canonical_name AS subject_name,
      object.canonical_name AS object_name
    FROM claims c
    JOIN entities subject ON subject.id = c.subject_entity_id
    LEFT JOIN entities object ON object.id = c.object_entity_id
    WHERE c.event_id = ? AND c.status = 'active' AND c.transaction_to = ''
    ORDER BY c.updated_at, c.id`).all(eventId);
}

function eventEntities(eventId) {
  return db.prepare(`SELECT DISTINCT entity.id, entity.entity_type, entity.canonical_name,
      entity.aliases_json, link.role
    FROM event_entities link JOIN entities entity ON entity.id = link.entity_id
    WHERE link.event_id = ? AND entity.status = 'active'
    ORDER BY entity.canonical_name`).all(eventId);
}

function eventRelations(eventId) {
  return db.prepare(`SELECT edge.predicate, source.canonical_name AS source_name,
      target.canonical_name AS target_name
    FROM entity_edges edge
    JOIN entities source ON source.id = edge.source_entity_id
    JOIN entities target ON target.id = edge.target_entity_id
    WHERE edge.event_id = ? AND edge.status = 'active' AND edge.transaction_to = ''
    ORDER BY edge.updated_at, edge.id`).all(eventId);
}

function compactLines(lines, fallback) {
  const result = lines.map((line) => safeText(line, 600).trim()).filter(Boolean);
  return result.length ? result.join('\n') : fallback;
}

export function buildEventMemoryViews(eventId) {
  const event = eventRecord(eventId);
  if (!event) throw new Error(`事件不存在：${eventId}`);
  const claims = eventClaims(eventId);
  const entities = eventEntities(eventId);
  const relations = eventRelations(eventId);
  const eventHeader = [
    `事件：${event.title}`,
    `类型：${event.event_type}`,
    event.story_time ? `时间：${event.story_time}` : '',
    `内容：${event.summary}`
  ].filter(Boolean).join('\n');
  const claimText = compactLines(claims.map((claim) =>
    `${claim.subject_name} / ${claim.predicate} = ${claim.object_name || claim.object_text}`
  ), eventHeader);
  const entityText = compactLines(entities.map((entity) => {
    const aliases = parseJson(entity.aliases_json, []) || [];
    return `${entity.canonical_name} [${entity.entity_type}]${aliases.length ? `；别名：${aliases.join('、')}` : ''}`;
  }), eventHeader);
  const relationText = compactLines(relations.map((relation) =>
    `${relation.source_name} --${relation.predicate}--> ${relation.target_name}`
  ), '');
  const sourceTurn = safeText(event.source_message_content || '', 4000).trim();
  const episodeParts = [eventHeader, claimText, entityText, relationText, sourceTurn].filter(Boolean);
  return [
    {
      type: 'turn',
      text: sourceTurn || eventHeader,
      metadata: { sourceRole: event.source_message_role || event.source_speaker || '' }
    },
    { type: 'event', text: eventHeader, metadata: { eventType: event.event_type } },
    { type: 'claim', text: claimText, metadata: { claimCount: claims.length } },
    {
      type: 'episode',
      text: safeText(episodeParts.join('\n\n'), 8000),
      metadata: { claimCount: claims.length, entityCount: entities.length, relationCount: relations.length }
    },
    {
      type: 'summary',
      text: compactLines([event.title, event.summary, event.story_time], eventHeader),
      metadata: { storyTime: event.story_time || '' }
    },
    {
      type: 'entity_keyword',
      text: compactLines([entityText, relationText, ...claims.map((claim) =>
        `${claim.subject_name} ${claim.predicate} ${claim.object_name || claim.object_text}`
      )], eventHeader),
      metadata: { entityCount: entities.length, relationCount: relations.length }
    }
  ];
}

function existingEventEmbedding(eventId) {
  return db.prepare(`SELECT * FROM embeddings
    WHERE owner_type = 'event' AND owner_id = ?
    ORDER BY created_at DESC LIMIT 1`).get(eventId);
}

function normalizedEmbedding(row, sourceText) {
  if (!row) {
    const vector = localEmbedding(sourceText);
    return {
      model: 'local-hash-embedding-v1', vector, fallback: true,
      fallbackReason: 'canonical_event_embedding_missing'
    };
  }
  return {
    model: row.model,
    vector: parseJson(row.vector_json, []),
    fallback: row.model === 'local-hash-embedding-v1',
    fallbackReason: ''
  };
}

function upsertView({ event, view, embedding, embeddingSource, timestamp }) {
  const id = `memory_view_${hash(`${event.id}:${view.type}`).slice(0, 32)}`;
  const contentHash = hash(view.text);
  db.prepare(`INSERT INTO memory_views
      (id, user_id, agent_id, story_id, branch_id, canonical_type, canonical_id, view_type,
       source_text, content_hash, metadata_json, status, embedding_model, embedding_dimensions,
       vector_json, embedding_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'event', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_type, canonical_id, view_type) DO UPDATE SET
      source_text = excluded.source_text, content_hash = excluded.content_hash,
      metadata_json = excluded.metadata_json, status = excluded.status,
      embedding_model = excluded.embedding_model,
      embedding_dimensions = excluded.embedding_dimensions, vector_json = excluded.vector_json,
      embedding_source = excluded.embedding_source, updated_at = excluded.updated_at`)
    .run(
      id, event.user_id, event.agent_id, event.story_id, event.branch_id, event.id, view.type,
      safeText(view.text, 12000), contentHash, json(view.metadata || {}),
      event.status === 'active' && !event.transaction_to ? 'active' : event.status,
      embedding.model, embedding.vector.length, json(embedding.vector), embeddingSource,
      timestamp, timestamp
    );
  return { id, eventId: event.id, viewType: view.type, contentHash, embeddingSource };
}

export async function syncMemoryViewsForEvent(eventId, {
  embeddingMode = 'native', eventEmbedding = null
} = {}) {
  const event = eventRecord(eventId);
  if (!event) throw new Error(`事件不存在：${eventId}`);
  const views = buildEventMemoryViews(eventId);
  const canonicalEmbedding = eventEmbedding || normalizedEmbedding(existingEventEmbedding(eventId),
    `${event.title}\n${event.summary}`);
  const embeddings = await Promise.all(views.map(async (view) => {
    if (view.type === 'event') return { embedding: canonicalEmbedding, source: 'canonical_event' };
    if (embeddingMode === 'reuse_event') {
      return { embedding: canonicalEmbedding, source: 'canonical_reuse' };
    }
    return { embedding: await embedText(view.text), source: 'native_view' };
  }));
  const timestamp = nowIso();
  const rows = views.map((view, index) => upsertView({
    event,
    view,
    embedding: embeddings[index].embedding,
    embeddingSource: embeddings[index].source,
    timestamp
  }));
  return {
    eventId,
    count: rows.length,
    nativeCount: rows.filter((row) => row.embeddingSource !== 'canonical_reuse').length,
    rows
  };
}

export function deactivateMemoryViews(eventIds, status = 'superseded') {
  const ids = [...new Set((eventIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const timestamp = nowIso();
  const changes = db.prepare(`UPDATE memory_views SET status = ?, updated_at = ?
    WHERE canonical_type = 'event' AND canonical_id IN (${placeholders}) AND status = 'active'`)
    .run(status, timestamp, ...ids).changes;
  db.prepare(`UPDATE memory_associations SET status = ?, updated_at = ?
    WHERE status = 'active' AND (source_event_id IN (${placeholders})
      OR target_event_id IN (${placeholders}))`)
    .run(status, timestamp, ...ids, ...ids);
  return changes;
}

export async function ensureMemoryViewsForScope(scope) {
  const events = db.prepare(`SELECT ev.id FROM events ev
    WHERE ev.user_id = ? AND ev.agent_id = ? AND ev.story_id = ? AND ev.branch_id = ?
      AND ev.status = 'active' AND ev.transaction_to = ''
    ORDER BY ev.updated_at DESC`).all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const counts = new Map(db.prepare(`SELECT canonical_id, COUNT(*) AS count FROM memory_views
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
      AND canonical_type = 'event' AND status = 'active'
    GROUP BY canonical_id`).all(scope.userId, scope.agentId, scope.storyId, scope.branchId)
    .map((row) => [row.canonical_id, Number(row.count)]));
  const missing = events.filter((event) => counts.get(event.id) !== MEMORY_VIEW_TYPES.length);
  for (const event of missing) {
    await syncMemoryViewsForEvent(event.id, { embeddingMode: 'reuse_event' });
  }
  const associationResults = missing.map((event) =>
    rebuildMemoryAssociationsForEvent(event.id, scope));
  return {
    activeEvents: events.length,
    backfilledEvents: missing.length,
    backfilledAssociations: associationResults.reduce(
      (sum, result) => sum + Number(result.associations || 0), 0
    )
  };
}

export function listActiveMemoryViews(scope) {
  return db.prepare(`SELECT view.* FROM memory_views view
    JOIN events ev ON ev.id = view.canonical_id
    WHERE view.user_id = ? AND view.agent_id = ? AND view.story_id = ? AND view.branch_id = ?
      AND view.canonical_type = 'event' AND view.status = 'active'
      AND ev.status = 'active' AND ev.transaction_to = ''
    ORDER BY view.updated_at DESC, view.view_type`).all(
    scope.userId, scope.agentId, scope.storyId, scope.branchId
  );
}

export async function rebuildMemoryViews(scope, { nativeEmbeddings = true } = {}) {
  const events = db.prepare(`SELECT id FROM events
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
      AND status = 'active' AND transaction_to = '' ORDER BY updated_at`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const results = [];
  for (const event of events) {
    results.push(await syncMemoryViewsForEvent(event.id, {
      embeddingMode: nativeEmbeddings ? 'native' : 'reuse_event'
    }));
  }
  const associations = rebuildMemoryAssociations(scope);
  return {
    events: events.length,
    views: results.reduce((sum, result) => sum + result.count, 0),
    nativeEmbeddings,
    associations: associations.associations
  };
}

function associationProfile(scope) {
  return db.prepare(`SELECT rp.* FROM agents agent
    JOIN retrieval_profiles rp ON rp.scene_id = agent.scene_id
    WHERE agent.id = ?`).get(scope.agentId) || {};
}

function gaussianDensity(value, mean, variance) {
  const safeVariance = Math.max(1e-6, variance);
  const exponent = -((value - mean) ** 2) / (2 * safeVariance);
  return Math.exp(exponent) / Math.sqrt(2 * Math.PI * safeVariance);
}

export function selectAdaptiveAssociations(candidates, {
  minimumSimilarity = 0.5, maximum = 6
} = {}) {
  const boundedMinimum = Math.max(-1, Math.min(1, Number(minimumSimilarity) || 0));
  const boundedMaximum = Math.max(1, Math.min(20, Math.floor(Number(maximum) || 6)));
  const ranked = [...candidates].filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score);
  if (ranked.length < 4) {
    return ranked.filter((candidate) => candidate.score >= boundedMinimum).slice(0, boundedMaximum)
      .map((candidate) => ({ ...candidate, posterior: 1, method: 'adaptive_top' }));
  }
  const values = ranked.map((candidate) => candidate.score);
  let lowMean = values[Math.floor(values.length * 0.7)] ?? values.at(-1);
  let highMean = values[Math.floor(values.length * 0.2)] ?? values[0];
  let lowVariance = 0.01;
  let highVariance = 0.01;
  let highWeight = 0.5;
  let posteriors = values.map(() => 0.5);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    posteriors = values.map((value) => {
      const high = highWeight * gaussianDensity(value, highMean, highVariance);
      const low = (1 - highWeight) * gaussianDensity(value, lowMean, lowVariance);
      return high / Math.max(1e-12, high + low);
    });
    const highSum = posteriors.reduce((sum, value) => sum + value, 0) || 1;
    const lowSum = values.length - highSum || 1;
    highMean = values.reduce((sum, value, index) => sum + value * posteriors[index], 0) / highSum;
    lowMean = values.reduce((sum, value, index) => sum + value * (1 - posteriors[index]), 0) / lowSum;
    highVariance = values.reduce((sum, value, index) =>
      sum + posteriors[index] * ((value - highMean) ** 2), 0) / highSum;
    lowVariance = values.reduce((sum, value, index) =>
      sum + (1 - posteriors[index]) * ((value - lowMean) ** 2), 0) / lowSum;
    highWeight = Math.min(0.95, Math.max(0.05, highSum / values.length));
  }
  const highClusterIsHigh = highMean >= lowMean;
  const selected = ranked.map((candidate, index) => ({
    ...candidate,
    posterior: highClusterIsHigh ? posteriors[index] : 1 - posteriors[index],
    method: 'gmm_adaptive'
  })).filter((candidate) => candidate.score >= boundedMinimum && candidate.posterior >= 0.55)
    .slice(0, boundedMaximum);
  if (selected.length) return selected;
  return ranked.filter((candidate) => candidate.score >= boundedMinimum).slice(0, 1)
    .map((candidate) => ({ ...candidate, posterior: 1, method: 'adaptive_fallback' }));
}

function canonicalAssociationPair(left, right) {
  return left.id < right.id
    ? { source: left, target: right }
    : { source: right, target: left };
}

export function listActiveMemoryAssociations(scope) {
  return db.prepare(`SELECT association.* FROM memory_associations association
    JOIN memory_views source_view ON source_view.id = association.source_view_id
    JOIN memory_views target_view ON target_view.id = association.target_view_id
    JOIN events source_event ON source_event.id = association.source_event_id
    JOIN events target_event ON target_event.id = association.target_event_id
    WHERE association.user_id = ? AND association.agent_id = ?
      AND association.story_id = ? AND association.branch_id = ?
      AND association.status = 'active'
      AND source_view.status = 'active' AND target_view.status = 'active'
      AND source_event.status = 'active' AND source_event.transaction_to = ''
      AND target_event.status = 'active' AND target_event.transaction_to = ''
    ORDER BY association.score DESC`).all(
    scope.userId, scope.agentId, scope.storyId, scope.branchId
  );
}

export function rebuildMemoryAssociationsForEvent(eventId, scope, options = {}) {
  const profile = associationProfile(scope);
  const enabled = options.enabled ?? Boolean(profile.association_enabled ?? 1);
  if (!enabled) return { status: 'disabled', eventId, associations: 0 };
  const minimumSimilarity = Number(options.minimumSimilarity
    ?? profile.association_min_similarity ?? 0.5);
  const maximumDegree = Number(options.maximumDegree ?? profile.association_max_degree ?? 6);
  const sourceViews = db.prepare(`SELECT view.* FROM memory_views view JOIN events ev ON ev.id = view.canonical_id
    WHERE view.canonical_id = ? AND view.status = 'active'
      AND ev.status = 'active' AND ev.transaction_to = ''`).all(eventId);
  if (!sourceViews.length) return { status: 'skipped', eventId, reason: 'no_active_views', associations: 0 };
  const allViews = listActiveMemoryViews(scope);
  const timestamp = nowIso();
  db.prepare(`DELETE FROM memory_associations
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
      AND (source_event_id = ? OR target_event_id = ?)`)
    .run(scope.userId, scope.agentId, scope.storyId, scope.branchId, eventId, eventId);
  let inserted = 0;
  for (const source of sourceViews) {
    const bestByEvent = new Map();
    const sourceVector = parseJson(source.vector_json, []);
    for (const target of allViews) {
      if (target.canonical_id === eventId || target.embedding_model !== source.embedding_model) continue;
      const targetVector = parseJson(target.vector_json, []);
      if (!sourceVector.length || sourceVector.length !== targetVector.length) continue;
      const score = cosineSimilarity(sourceVector, targetVector);
      const current = bestByEvent.get(target.canonical_id);
      if (!current || score > current.score) bestByEvent.set(target.canonical_id, { target, score });
    }
    const selected = selectAdaptiveAssociations([...bestByEvent.values()], {
      minimumSimilarity, maximum: maximumDegree
    });
    for (const candidate of selected) {
      const pair = canonicalAssociationPair(source, candidate.target);
      const id = `memory_association_${hash(`${pair.source.id}:${pair.target.id}`).slice(0, 28)}`;
      db.prepare(`INSERT INTO memory_associations
          (id, user_id, agent_id, story_id, branch_id, source_view_id, target_view_id,
           source_event_id, target_event_id, source_view_type, target_view_type, score,
           method, embedding_model, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(source_view_id, target_view_id) DO UPDATE SET
          score = excluded.score, method = excluded.method, embedding_model = excluded.embedding_model,
          status = 'active', updated_at = excluded.updated_at`)
        .run(
          id, scope.userId, scope.agentId, scope.storyId, scope.branchId,
          pair.source.id, pair.target.id, pair.source.canonical_id, pair.target.canonical_id,
          pair.source.view_type, pair.target.view_type, candidate.score, candidate.method,
          source.embedding_model, timestamp, timestamp
        );
      inserted += 1;
    }
  }
  return {
    status: 'success', eventId, associations: inserted,
    minimumSimilarity, maximumDegree, method: 'gmm_adaptive'
  };
}

export function rebuildMemoryAssociations(scope, options = {}) {
  db.prepare(`DELETE FROM memory_associations
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?`)
    .run(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const events = db.prepare(`SELECT id FROM events
    WHERE user_id = ? AND agent_id = ? AND story_id = ? AND branch_id = ?
      AND status = 'active' AND transaction_to = '' ORDER BY updated_at`)
    .all(scope.userId, scope.agentId, scope.storyId, scope.branchId);
  const results = events.map((event) => rebuildMemoryAssociationsForEvent(event.id, scope, options));
  return {
    events: events.length,
    associations: listActiveMemoryAssociations(scope).length,
    results
  };
}

function lexicalTerms(value) {
  const normalized = String(value || '').normalize('NFKC').toLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9_./:-]{2,}/g) || []);
  const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, '');
  if (compact.length === 1) terms.add(compact);
  for (let index = 0; index < compact.length - 1; index += 1) {
    terms.add(compact.slice(index, index + 2));
  }
  return terms;
}

function viewKeywordScore(query, text) {
  const queryTerms = lexicalTerms(query);
  const viewTerms = lexicalTerms(text);
  if (!queryTerms.size || !viewTerms.size) return 0;
  let overlap = 0;
  for (const term of queryTerms) if (viewTerms.has(term)) overlap += 1;
  return overlap / Math.sqrt(queryTerms.size * viewTerms.size);
}

function viewVectorScore(queryEmbedding, view) {
  const stored = parseJson(view.vector_json, []);
  if (stored.length === queryEmbedding.vector.length) {
    return { score: cosineSimilarity(queryEmbedding.vector, stored), compatible: true, source: 'stored' };
  }
  if (queryEmbedding.fallback) {
    const local = localEmbedding(view.source_text, queryEmbedding.vector.length);
    return { score: cosineSimilarity(queryEmbedding.vector, local), compatible: true, source: 'fallback_recomputed' };
  }
  return { score: 0, compatible: false, source: 'incompatible' };
}

function normalizedEntropy(values) {
  if (values.length <= 1) return 0;
  const maximum = Math.max(...values);
  const exponentials = values.map((value) => Math.exp((value - maximum) / 0.08));
  const sum = exponentials.reduce((total, value) => total + value, 0) || 1;
  const probabilities = exponentials.map((value) => value / sum);
  const entropy = -probabilities.reduce((total, value) =>
    total + (value > 0 ? value * Math.log(value) : 0), 0);
  return entropy / Math.log(values.length);
}

function queryViewPrior(query, viewType) {
  const rules = {
    turn: /(原话|当时怎么说|说过什么|原文|哪句话|exact words|quote)/i,
    event: /(什么时候|哪天|哪里|地点|先后|第一|最近一次|发生|when|where|first|latest)/i,
    claim: /(喜欢|偏好|是谁|是什么|多大|叫什么|状态|要求|likes|preference|who is)/i,
    episode: /(那件事|后来|接着|经过|细节|那段|怎么回事|what happened|later)/i,
    summary: /(总结|回顾|最近都|这段时间|概括|进展|summary|recap)/i,
    entity_keyword: /(我的|女儿|儿子|孩子|父母|朋友|关系|有关|相关|还有什么|related|daughter|son|friend)/i
  };
  return rules[viewType]?.test(query) ? 1.65 : 1;
}

function routerBucket(scope) {
  const value = hash([
    scope.userId, scope.agentId, scope.storyId || 'main_story', scope.branchId || 'main'
  ].join('|')).slice(0, 8);
  return Number.parseInt(value, 16) % 100;
}

export function evaluateGranularityRouter({
  query, queryEmbedding, views, eventIds, strategy, scope
}) {
  const allowedEventIds = eventIds instanceof Set ? eventIds : new Set(eventIds || []);
  const scoredViews = views.filter((view) => allowedEventIds.has(view.canonical_id)).map((view) => {
    const vector = strategy.vectorEnabled
      ? viewVectorScore(queryEmbedding, view)
      : { score: 0, compatible: null, source: 'disabled' };
    const keyword = strategy.keywordEnabled ? viewKeywordScore(query, view.source_text) : 0;
    return {
      id: view.id,
      eventId: view.canonical_id,
      viewType: view.view_type,
      vectorScore: vector.score,
      vectorCompatible: vector.compatible,
      vectorSource: vector.source,
      keywordScore: keyword,
      score: Math.max(0, vector.score) * 0.82 + keyword * 0.18,
      embeddingSource: view.embedding_source
    };
  });
  const stats = MEMORY_VIEW_TYPES.map((viewType) => {
    const candidates = scoredViews.filter((view) => view.viewType === viewType)
      .sort((left, right) => right.score - left.score);
    const values = candidates.slice(0, Math.max(2, strategy.plannerMaxCandidates || 12))
      .map((candidate) => candidate.score);
    const entropy = normalizedEntropy(values);
    const topScore = values[0] || 0;
    const secondScore = values[1] || 0;
    const margin = Math.max(0, topScore - secondScore);
    const coverage = candidates.length
      ? candidates.filter((candidate) => candidate.vectorScore >= strategy.catalogMinSimilarity
        || candidate.keywordScore >= strategy.minKeywordScore).length / candidates.length
      : 0;
    const prior = queryViewPrior(query, viewType);
    const confidence = 1 - entropy;
    const rawWeight = candidates.length
      ? (0.20 + confidence * 0.45 + Math.min(1, margin) * 0.25 + coverage * 0.10) * prior
      : 0;
    return {
      viewType,
      label: MEMORY_VIEW_LABELS[viewType],
      candidateCount: candidates.length,
      compatibleCount: candidates.filter((candidate) => candidate.vectorCompatible !== false).length,
      entropy,
      confidence,
      margin,
      coverage,
      prior,
      rawWeight,
      topHits: candidates.slice(0, 3).map((candidate) => ({
        viewId: candidate.id,
        eventId: candidate.eventId,
        viewType: candidate.viewType,
        score: candidate.score,
        vectorScore: candidate.vectorScore,
        keywordScore: candidate.keywordScore
      }))
    };
  });
  const weightTotal = stats.reduce((sum, item) => sum + item.rawWeight, 0) || 1;
  for (const item of stats) item.weight = item.rawWeight / weightTotal;
  const weights = new Map(stats.map((item) => [item.viewType, item.weight]));
  const eventScoreMap = new Map();
  for (const view of scoredViews) {
    const eventScore = eventScoreMap.get(view.eventId) || {
      eventId: view.eventId,
      score: 0,
      vectorMax: 0,
      keywordMax: 0,
      bestViewType: '',
      bestViewScore: -1,
      views: []
    };
    eventScore.score += view.score * (weights.get(view.viewType) || 0);
    eventScore.vectorMax = Math.max(eventScore.vectorMax, view.vectorScore);
    eventScore.keywordMax = Math.max(eventScore.keywordMax, view.keywordScore);
    if (view.score > eventScore.bestViewScore) {
      eventScore.bestViewScore = view.score;
      eventScore.bestViewType = view.viewType;
    }
    eventScore.views.push(view);
    eventScoreMap.set(view.eventId, eventScore);
  }
  const requestedMode = strategy.granularityRouterMode || 'shadow';
  const bucket = routerBucket(scope);
  const abPercent = Number(strategy.granularityAbPercent ?? 50);
  const effectiveMode = requestedMode === 'ab'
    ? (bucket < abPercent ? 'dynamic' : 'fixed')
    : requestedMode;
  const seedMap = new Map();
  for (const item of stats) {
    const qualifying = item.topHits.filter((hit) =>
      hit.vectorScore >= strategy.catalogMinSimilarity
        || hit.keywordScore >= strategy.minKeywordScore).slice(0, 2);
    const chosen = qualifying.length ? qualifying : item.topHits.slice(0, 1);
    for (const hit of chosen) {
      const current = seedMap.get(hit.viewId);
      if (!current || hit.score > current.score) seedMap.set(hit.viewId, hit);
    }
  }
  return {
    enabled: strategy.granularityEnabled !== false,
    requestedMode,
    effectiveMode,
    affectsRanking: strategy.granularityEnabled !== false && effectiveMode === 'dynamic',
    ab: { bucket, dynamicPercent: abPercent },
    viewCount: scoredViews.length,
    seeds: [...seedMap.values()].map((view) => ({
      viewId: view.viewId,
      eventId: view.eventId,
      viewType: view.viewType,
      score: view.score
    })),
    stats: stats.map(({ rawWeight, ...item }) => item),
    events: [...eventScoreMap.values()].map((event) => ({
      eventId: event.eventId,
      score: event.score,
      vectorMax: event.vectorMax,
      keywordMax: event.keywordMax,
      bestViewType: event.bestViewType,
      bestViewScore: event.bestViewScore
    }))
  };
}

export function runBoundedPersonalizedPageRank({
  seeds, associations, damping = 0.85, iterations = 12, topK = 8, maxHops = 2, maxNodes = 240
}) {
  const boundedMaxNodes = Math.max(8, Math.min(500, Math.floor(Number(maxNodes) || 240)));
  const boundedMaxHops = Math.max(0, Math.min(3, Math.floor(Number(maxHops) || 0)));
  const boundedDamping = Math.max(0.5, Math.min(0.99, Number(damping) || 0.85));
  const boundedTopK = Math.max(1, Math.min(30, Math.floor(Number(topK) || 8)));
  const seedRows = (seeds || []).filter((seed) => Number(seed.score) > 0)
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, boundedMaxNodes);
  if (!seedRows.length || !(associations || []).length) {
    return {
      status: 'skipped', reason: seedRows.length ? 'association_graph_empty' : 'no_positive_seeds',
      nodesVisited: 0, edgesUsed: 0, iterations: 0, events: [], expandedEventIds: []
    };
  }
  const adjacency = new Map();
  const viewEventIds = new Map(seedRows.map((seed) => [seed.viewId, seed.eventId]));
  const addNeighbor = (source, target, weight) => {
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source).push({ id: target, weight });
  };
  for (const association of associations) {
    const weight = Math.max(0, Number(association.score || 0));
    if (!weight) continue;
    addNeighbor(association.source_view_id, association.target_view_id, weight);
    addNeighbor(association.target_view_id, association.source_view_id, weight);
    viewEventIds.set(association.source_view_id, association.source_event_id);
    viewEventIds.set(association.target_view_id, association.target_event_id);
  }
  const allowed = new Set(seedRows.map((seed) => seed.viewId));
  let frontier = new Set(allowed);
  for (let hop = 0; hop < boundedMaxHops && frontier.size && allowed.size < boundedMaxNodes; hop += 1) {
    const next = new Set();
    for (const nodeId of frontier) {
      for (const neighbor of adjacency.get(nodeId) || []) {
        if (allowed.size >= boundedMaxNodes) break;
        if (!allowed.has(neighbor.id)) next.add(neighbor.id);
        allowed.add(neighbor.id);
      }
    }
    frontier = next;
  }
  const personalization = new Map();
  const seedTotal = seedRows.reduce((sum, seed) => sum + Number(seed.score), 0) || 1;
  for (const seed of seedRows) {
    if (allowed.has(seed.viewId)) {
      personalization.set(seed.viewId, (personalization.get(seed.viewId) || 0) + Number(seed.score) / seedTotal);
    }
  }
  let rank = new Map([...allowed].map((nodeId) => [nodeId, personalization.get(nodeId) || 0]));
  const boundedIterations = Math.max(1, Math.min(50, Number(iterations) || 12));
  for (let iteration = 0; iteration < boundedIterations; iteration += 1) {
    const next = new Map([...allowed].map((nodeId) => [
      nodeId, (1 - boundedDamping) * (personalization.get(nodeId) || 0)
    ]));
    for (const source of allowed) {
      const neighbors = (adjacency.get(source) || []).filter((neighbor) => allowed.has(neighbor.id));
      const weightTotal = neighbors.reduce((sum, neighbor) => sum + neighbor.weight, 0);
      if (!weightTotal) continue;
      for (const neighbor of neighbors) {
        next.set(neighbor.id, (next.get(neighbor.id) || 0)
          + boundedDamping * (rank.get(source) || 0) * neighbor.weight / weightTotal);
      }
    }
    rank = next;
  }
  const eventRanks = new Map();
  for (const [viewId, score] of rank) {
    const eventId = viewEventIds.get(viewId);
    if (!eventId) continue;
    eventRanks.set(eventId, (eventRanks.get(eventId) || 0) + score);
  }
  const maximumEventScore = Math.max(0, ...eventRanks.values()) || 1;
  const seedEventIds = new Set(seedRows.map((seed) => seed.eventId));
  const events = [...eventRanks].map(([eventId, score]) => ({
    eventId,
    score: score / maximumEventScore,
    rawScore: score,
    seed: seedEventIds.has(eventId)
  })).sort((left, right) => right.score - left.score).slice(0, boundedTopK);
  return {
    status: 'success',
    nodesVisited: allowed.size,
    edgesUsed: (associations || []).filter((association) =>
      allowed.has(association.source_view_id) && allowed.has(association.target_view_id)).length,
    iterations: boundedIterations,
    damping: boundedDamping,
    maxHops: boundedMaxHops,
    maxNodes: boundedMaxNodes,
    events,
    expandedEventIds: events.filter((event) => !event.seed).map((event) => event.eventId)
  };
}
