import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const datasetPath = process.argv[2] || '/tmp/longmemeval_oracle.json';
const outputPath = process.argv[3] || path.resolve('output/benchmarks/longmemeval-oracle-pilot.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocm-longmemeval-'));
const includeExtractionDetails = process.env.PILOT_INCLUDE_EXTRACTION_DETAILS === '1';

process.env.DATABASE_PATH = path.join(tempDir, 'eval.db');
process.env.GRAPH_STORE = 'sqlite';
process.env.ARK_PREFIX_CACHE_MODE = 'off';
process.env.CAPABILITY_RUNTIME_ENABLED = 'false';

const { config } = await import('../lib/config.js');
const { db, initializeDatabase } = await import('../lib/db.js');
const {
  chat, createConversation, extractConversationMemoryNow,
  getConversationMemoryExtractionStatus
} = await import('../lib/agent.js');
const { generateText } = await import('../lib/providers/index.js');
const { parseJson, uid } = await import('../lib/utils.js');

if (config.textProvider === 'mock') {
  throw new Error('LongMemEval pilot requires a real text provider.');
}

initializeDatabase();

const agentId = 'agent_linwan';
const storyId = 'main_story';
const branchId = 'main';
const extractionProfile = db.prepare(`SELECT profile.* FROM agents agent
  JOIN event_extraction_profiles profile ON profile.scene_id = agent.scene_id
  WHERE agent.id = ?`).get(agentId);
const benchmark = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const questionTypes = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'knowledge-update',
  'temporal-reasoning'
];

function stableRank(item) {
  return createHash('sha256').update(item.question_id).digest('hex');
}

function selectPilotItems() {
  return questionTypes.flatMap((type) => {
    const items = benchmark.filter((item) => item.question_type === type)
      .sort((left, right) => stableRank(left).localeCompare(stableRank(right)));
    const answerable = items.filter((item) => !item.question_id.endsWith('_abs'));
    const abstention = items.filter((item) => item.question_id.endsWith('_abs'));
    return abstention.length ? [answerable[0], abstention[0]] : answerable.slice(0, 2);
  });
}

function addEvalUser(questionId) {
  const id = `lme_${questionId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(0, 20)}_${randomUUID().slice(0, 6)}`;
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO users
    (id, name, display_name, avatar_color, status, created_at, updated_at)
    VALUES (?, ?, ?, '#2563eb', 'active', ?, ?)`).run(id, id, id, timestamp, timestamp);
  return id;
}

function isoTimestamp(value, offsetSeconds = 0) {
  const match = String(value || '').match(/(\d{4})\/(\d{2})\/(\d{2}).*?(\d{2}):(\d{2})/);
  if (!match) return new Date(Date.now() + offsetSeconds * 1000).toISOString();
  const [, year, month, day, hour, minute] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`).toISOString();
}

function addMessage(conversation, turn, createdAt, benchmarkMeta) {
  db.prepare(`INSERT INTO messages
    (id, conversation_id, user_id, role, content, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    uid('msg'), conversation.id, conversation.user_id, turn.role, turn.content,
    JSON.stringify(benchmarkMeta), createdAt
  );
}

async function extractAllPending(conversation, userId) {
  const flushes = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = getConversationMemoryExtractionStatus(conversation.id, userId);
    if (!before.canExtract || before.pendingTurns <= 0) break;
    const extraction = await extractConversationMemoryNow({ conversationId: conversation.id, userId });
    const flush = {
      status: extraction.result?.status,
      events: extraction.result?.events?.length || 0,
      filtered: extraction.result?.filteredEvents?.length || 0,
      semanticClaims: extraction.result?.semanticClaims?.length || 0,
      filteredSemanticClaims: extraction.result?.filteredSemanticClaims?.length || 0,
      pipelines: extraction.result?.pipelines || {},
      pendingAfter: extraction.status?.pendingTurns || 0
    };
    if (includeExtractionDetails) {
      flush.rawSemanticClaims = (extraction.result?.extraction?.semantic_claims || []).map((claim) => ({
        subject: claim.subject?.name || '', predicate: claim.predicate || '',
        object: claim.object || claim.object_text || '', statePhase: claim.state_phase || '',
        evidenceMessageIds: claim.evidence_message_ids || [],
        evidenceKeywords: claim.evidence_keywords || [],
        extractionSource: claim.metadata?.extraction_source || 'model'
      }));
      flush.committedSemanticClaims = (extraction.result?.semanticClaims || []).map((claim) => ({
        id: claim.id, subject: claim.subject || '', predicate: claim.predicate || '',
        object: claim.object || '', statePhase: claim.statePhase || '',
        metadata: claim.metadata || {}
      }));
    }
    flushes.push(flush);
    if ((extraction.status?.pendingTurns || 0) >= before.pendingTurns) break;
  }
  return flushes;
}

async function ingestItem(item, userId) {
  const sessionStats = [];
  for (let index = 0; index < item.haystack_sessions.length; index += 1) {
    const session = item.haystack_sessions[index];
    const sessionDate = item.haystack_dates[index];
    const conversation = createConversation({
      userId,
      agentId,
      storyId,
      branchId,
      title: `LongMemEval ${item.haystack_session_ids[index]}`
    });
    const sessionCreatedAt = isoTimestamp(sessionDate);
    db.prepare(`INSERT INTO conversation_extraction_states
      (conversation_id, profile_id, last_extracted_message_id, last_extracted_at, created_at, updated_at)
      VALUES (?, ?, '', NULL, ?, ?)`).run(
      conversation.id, extractionProfile.id, sessionCreatedAt, sessionCreatedAt
    );
    session.forEach((turn, turnIndex) => addMessage(
      conversation,
      turn,
      isoTimestamp(sessionDate, turnIndex),
      {
        benchmark: 'LongMemEval',
        questionId: item.question_id,
        sessionId: item.haystack_session_ids[index],
        hasAnswer: Boolean(turn.has_answer)
      }
    ));
    const lastTimestamp = isoTimestamp(sessionDate, session.length + 1);
    db.prepare('UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(sessionCreatedAt, lastTimestamp, conversation.id);
    sessionStats.push({
      sessionId: item.haystack_session_ids[index],
      turns: session.length,
      flushes: await extractAllPending(conversation, userId)
    });
  }
  return sessionStats;
}

function judgePrompt(item, response) {
  if (item.question_id.endsWith('_abs')) {
    return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${item.question}\n\nExplanation: ${item.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  if (item.question_type === 'single-session-preference') {
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${item.question}\n\nRubric: ${item.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  }
  const temporalRule = item.question_type === 'temporal-reasoning'
    ? ' In addition, do not penalize off-by-one errors for elapsed days, weeks, or months.'
    : '';
  const updateRule = item.question_type === 'knowledge-update'
    ? ' If previous information is also mentioned, count the response as correct when the required updated answer is clearly present.'
    : '';
  return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. Equivalent wording or all required intermediate steps count as correct. A response containing only a subset of required information is incorrect.${temporalRule}${updateRule}\n\nQuestion: ${item.question}\n\nCorrect Answer: ${item.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

function tokens(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function tokenF1(reference, hypothesis) {
  const expected = tokens(reference);
  const actual = tokens(hypothesis);
  if (!expected.length || !actual.length) return 0;
  const counts = new Map();
  expected.forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  let overlap = 0;
  actual.forEach((token) => {
    const remaining = counts.get(token) || 0;
    if (remaining > 0) {
      overlap += 1;
      counts.set(token, remaining - 1);
    }
  });
  const precision = overlap / actual.length;
  const recall = overlap / expected.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function retrievalDiagnostics(traceId) {
  const spanOutput = (name) => {
    const span = db.prepare(`SELECT output_json FROM trace_spans
    WHERE trace_id = ? AND name = ?
    ORDER BY created_at DESC LIMIT 1`).get(traceId, name);
    return parseJson(span?.output_json, {}) || {};
  };
  const output = spanOutput('hybrid_memory_retrieval');
  const answerability = spanOutput('memory_answerability_gate');
  return {
    events: output.events?.length || 0,
    claims: output.claims?.length || 0,
    edges: output.edges?.length || 0,
    planner: output.planner?.mode || output.planner?.status || '',
    viewCount: output.diagnostics?.multiGranularityProjection?.activeViews || 0,
    plannerDecision: output.planner?.decision || '',
    plannerFollowUpQueries: output.planner?.followUpQueries || [],
    claimQueryVariants: output.diagnostics?.claimQueryVariants || [],
    adaptiveProfileThreshold: output.diagnostics?.adaptiveProfileThreshold ?? null,
    answerability,
    eventEvidence: (output.events || []).map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      storyTime: event.storyTime || '',
      relativeTime: event.metadata?.relative_time_expression || '',
      sourceTimeAnchor: event.metadata?.source_message_created_at || '',
      selectedBy: event.selectedBy || ''
    })),
    claimEvidence: (output.claims || []).map((claim) => ({
      id: claim.id,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      memoryKind: claim.memoryKind,
      statePhase: claim.statePhase,
      storyTime: claim.storyTime || '',
      relativeTime: claim.relativeTime || '',
      sourceTimeAnchor: claim.sourceTimeAnchor || '',
      evidenceLevel: claim.evidenceLevel,
      vectorSimilarity: claim.vectorSimilarity,
      selectedBy: claim.selectedBy,
      matchedQuery: claim.matchedQuery || ''
    }))
  };
}

const requestedQuestionIds = String(process.env.PILOT_QUESTION_IDS || '')
  .split(',').map((item) => item.trim()).filter(Boolean);
const selected = requestedQuestionIds.length
  ? requestedQuestionIds.map((id) => benchmark.find((item) => item.question_id === id)).filter(Boolean)
  : selectPilotItems();
const results = [];

try {
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const userId = addEvalUser(item.question_id);
    const sessions = await ingestItem(item, userId);
    if (includeExtractionDetails) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(`${outputPath}.extraction`, `${JSON.stringify({
        questionId: item.question_id, sessions
      }, null, 2)}\n`);
    }
    const queryConversation = createConversation({
      userId,
      agentId,
      storyId,
      branchId,
      title: `LongMemEval query ${item.question_id}`
    });
    const response = await chat({
      userId,
      agentId,
      conversationId: queryConversation.id,
      message: `Current Date: ${item.question_date}\nQuestion: ${item.question}`
    });
    const hypothesis = response.message.content;
    const judged = await generateText({
      systemPrompt: 'You are a strict benchmark judge. Follow the requested yes/no output format.',
      messages: [{ role: 'user', content: judgePrompt(item, hypothesis) }],
      temperature: 0,
      maxOutputTokens: 1200
    });
    const judgeText = judged.text.trim();
    const result = {
      index: index + 1,
      questionId: item.question_id,
      questionType: item.question_type,
      abstention: item.question_id.endsWith('_abs'),
      question: item.question,
      reference: item.answer,
      hypothesis,
      judgeText,
      judgePass: /^yes\b/i.test(judgeText),
      tokenF1: tokenF1(item.answer, hypothesis),
      sessions,
      retrieval: retrievalDiagnostics(response.traceId)
    };
    results.push(result);
    fs.writeFileSync(`${outputPath}.partial`, `${JSON.stringify({
      benchmark: 'LongMemEval cleaned oracle',
      status: 'running_non_official_stratified_pilot',
      completed: results.length,
      total: selected.length,
      results
    }, null, 2)}\n`);
    console.log(`[${index + 1}/${selected.length}] ${result.questionType}${result.abstention ? ':abs' : ''} ${result.judgePass ? 'PASS' : 'FAIL'}`);
  }

  const byType = Object.fromEntries(questionTypes.map((type) => {
    const rows = results.filter((row) => row.questionType === type);
    return [type, {
      passed: rows.filter((row) => row.judgePass).length,
      total: rows.length,
      accuracy: rows.length ? rows.filter((row) => row.judgePass).length / rows.length : 0,
      meanTokenF1: rows.length ? rows.reduce((sum, row) => sum + row.tokenF1, 0) / rows.length : 0
    }];
  }));
  const report = {
    benchmark: 'LongMemEval cleaned oracle',
    status: 'non_official_stratified_pilot',
    caveats: [
      'Uses oracle evidence sessions rather than LongMemEval-S distractor histories.',
      'Uses the configured Ark model as judge, not the official gpt-4o-2024-08-06 judge.',
      'The 12-item deterministic sample is a compatibility gate, not a leaderboard score.'
    ],
    provider: config.textProvider,
    textModel: config[config.textProvider]?.textModel || '',
    datasetPath,
    sampleSize: results.length,
    passed: results.filter((row) => row.judgePass).length,
    accuracy: results.length ? results.filter((row) => row.judgePass).length / results.length : 0,
    meanTokenF1: results.length ? results.reduce((sum, row) => sum + row.tokenF1, 0) / results.length : 0,
    byType,
    results
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(`${outputPath}.partial`, { force: true });
  console.log(JSON.stringify({ outputPath, ...report, results: undefined }, null, 2));
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
