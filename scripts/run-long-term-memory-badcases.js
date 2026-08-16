import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocm-long-term-eval-'));
process.env.DATABASE_PATH = path.join(tempDir, 'eval.db');
process.env.GRAPH_STORE = 'sqlite';
process.env.ARK_PREFIX_CACHE_MODE = 'off';
process.env.CAPABILITY_RUNTIME_ENABLED = 'false';

const { config } = await import('../lib/config.js');
if (config.textProvider === 'mock') {
  throw new Error('该脚本要求真实文本模型，请配置 TEXT_PROVIDER 及对应 API Key。');
}

const { db, initializeDatabase } = await import('../lib/db.js');
const { chat, createConversation, extractConversationMemoryNow } = await import('../lib/agent.js');
const { parseJson, uid } = await import('../lib/utils.js');

initializeDatabase();

const agentId = 'agent_linwan';
const storyId = 'main_story';
const branchId = 'main';
const profile = db.prepare(`SELECT ep.* FROM agents a
  JOIN event_extraction_profiles ep ON ep.scene_id = a.scene_id WHERE a.id = ?`).get(agentId);

function addEvalUser(prefix) {
  const id = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO users
    (id, name, display_name, avatar_color, status, created_at, updated_at)
    VALUES (?, ?, ?, '#2563eb', 'active', ?, ?)`).run(id, id, id, timestamp, timestamp);
  return id;
}

function addMessage(conversation, role, content, createdAt) {
  const id = uid('msg');
  db.prepare(`INSERT INTO messages
    (id, conversation_id, user_id, role, content, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?)`).run(
    id, conversation.id, conversation.user_id, role, content, createdAt
  );
  return id;
}

async function seedSession({ userId, title, timestamp, fact, noise }) {
  const conversation = createConversation({ userId, agentId, storyId, branchId, title });
  db.prepare(`INSERT INTO conversation_extraction_states
    (conversation_id, profile_id, last_extracted_message_id, last_extracted_at, created_at, updated_at)
    VALUES (?, ?, '', NULL, ?, ?)`).run(conversation.id, profile.id, timestamp, timestamp);
  const turns = [
    [noise[0], '听见了，我们继续说。'],
    [noise[1], '好，这一条我先接住。'],
    [fact, '明白了。']
  ];
  for (let index = 0; index < turns.length; index += 1) {
    const userAt = new Date(Date.parse(timestamp) + index * 2000).toISOString();
    const assistantAt = new Date(Date.parse(timestamp) + index * 2000 + 1000).toISOString();
    addMessage(conversation, 'user', turns[index][0], userAt);
    addMessage(conversation, 'assistant', turns[index][1], assistantAt);
  }
  db.prepare('UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(timestamp, new Date(Date.parse(timestamp) + 6000).toISOString(), conversation.id);
  const extraction = await extractConversationMemoryNow({ conversationId: conversation.id, userId });
  return {
    conversationId: conversation.id,
    status: extraction.result.status,
    events: extraction.result.events?.length || 0,
    filtered: extraction.result.filteredEvents?.length || 0,
    filteredEvents: extraction.result.filteredEvents || [],
    pendingAfter: extraction.status.pendingTurns
  };
}

function traceEvidence(traceId, seedFacts) {
  const spans = db.prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY created_at').all(traceId);
  const modelInput = parseJson(spans.find((item) => item.name === 'model_response')?.input_json, {}) || {};
  const retrieval = parseJson(spans.find((item) => item.name === 'hybrid_memory_retrieval')?.output_json, {}) || {};
  const shortTermText = (modelInput.messages || []).map((item) => item.content).join('\n');
  return {
    shortTermMessageCount: modelInput.messages?.length || 0,
    seedFactInShortTerm: seedFacts.some((fact) => shortTermText.includes(fact)),
    retrievedEvents: (retrieval.events || []).map((item) => ({
      title: item.title,
      storyTime: item.storyTime,
      selectedBy: item.selectedBy
    })),
    retrievedClaims: (retrieval.claims || []).map((item) =>
      `${item.subject}/${item.predicate}=${item.object}${item.storyTime ? `@${item.storyTime}` : ''}`),
    planner: retrieval.planner,
    graphSource: retrieval.diagnostics?.graphSource
  };
}

async function runTravelCase() {
  const userId = addEvalUser('eval_travel');
  const facts = [
    '清明前一周我先去了绍兴看黄酒博物馆。',
    '接着下个周末我去宁波老外滩拍夜景。',
    '月底我才去舟山看海。'
  ];
  const sessions = [];
  sessions.push(await seedSession({
    userId, title: '绍兴行程', timestamp: '2026-03-30T10:00:00+08:00', fact: facts[0],
    noise: ['我今天整理了衣柜。', '手机电量只剩23%。']
  }));
  sessions.push(await seedSession({
    userId, title: '宁波行程', timestamp: '2026-04-06T10:00:00+08:00', fact: facts[1],
    noise: ['导航 App 改了界面。', '冰箱里的酸奶快到期了。']
  }));
  sessions.push(await seedSession({
    userId, title: '舟山行程', timestamp: '2026-04-30T10:00:00+08:00', fact: facts[2],
    noise: ['我买了一打新洗碗布。', '周末出门被雨淋了。']
  }));
  const response = await chat({
    userId,
    agentId,
    message: '把我这三次短途出行按先后顺序排一下，第一站是哪？'
  });
  const answer = response.message.content;
  const indexes = ['绍兴', '宁波', '舟山'].map((name) => answer.indexOf(name));
  const trace = traceEvidence(response.traceId, facts);
  return {
    sessions,
    answer,
    score: {
      allFacts: indexes.every((index) => index >= 0),
      ordered: indexes[0] < indexes[1] && indexes[1] < indexes[2],
      firstStop: /第一站[^\n。，,]{0,12}绍兴|绍兴[^\n。]{0,12}第一站/.test(answer),
      longTermOnly: trace.shortTermMessageCount === 1 && !trace.seedFactInShortTerm
    },
    trace
  };
}

async function runPetCase() {
  const userId = addEvalUser('eval_pet');
  const facts = [
    '我家柯基七喜3月6日打了狂犬疫苗。',
    '七喜4月20日打了传染病加强针。',
    '七喜5月28日去做了洗牙，这个不算防疫。'
  ];
  const sessions = [];
  sessions.push(await seedSession({
    userId, title: '狂犬疫苗', timestamp: '2026-03-07T10:00:00+08:00', fact: facts[0],
    noise: ['阳台上的花盆积了灰。', '调味料瓶的盖子有点紧。']
  }));
  sessions.push(await seedSession({
    userId, title: '传染病加强针', timestamp: '2026-04-21T10:00:00+08:00', fact: facts[1],
    noise: ['办公室空调有点冷。', '中午的会议结论不太明确。']
  }));
  sessions.push(await seedSession({
    userId, title: '洗牙', timestamp: '2026-05-29T10:00:00+08:00', fact: facts[2],
    noise: ['猫粮快吃完了。', '空调遥控器刚换了电池。']
  }));
  const response = await chat({
    userId,
    agentId,
    message: '按七喜这几次护理记录，告诉我最近一次和防疫最相关的是哪项、发生在什么时候，并列出关键与补充信息。'
  });
  const answer = response.message.content;
  const trace = traceEvidence(response.traceId, facts);
  const latestStart = Math.max(0, answer.search(/最近一次/));
  const supplementStart = answer.search(/补充信息/);
  const latestBlock = answer.slice(latestStart, supplementStart > latestStart ? supplementStart : undefined);
  return {
    sessions,
    answer,
    score: {
      rabies: /狂犬疫苗/.test(answer) && /3\s*月\s*6\s*日|2026[-年/]0?3[-月/]0?6/.test(answer),
      booster: /传染病加强针/.test(answer) && /4\s*月\s*20\s*日|2026[-年/]0?4[-月/]20/.test(answer),
      dental: /洗牙/.test(answer) && /5\s*月\s*28\s*日|2026[-年/]0?5[-月/]28/.test(answer),
      latestPreventive: /传染病加强针/.test(latestBlock)
        && /4\s*月\s*20\s*日|2026[-年/]0?4[-月/]20/.test(latestBlock),
      dentalExcluded: /洗牙[^\n。]{0,40}(不属于|不算|非|不涉及)防疫|(不属于|不算|非|不涉及)防疫[^\n。]{0,40}洗牙/.test(answer),
      longTermOnly: trace.shortTermMessageCount === 1 && !trace.seedFactInShortTerm
    },
    trace
  };
}

let report;
try {
  report = {
    provider: config.textProvider,
    model: config[config.textProvider]?.textModel || '',
    tempDir,
    travel: await runTravelCase(),
    pet: await runPetCase()
  };
  console.log(JSON.stringify(report, null, 2));
  const failed = [report.travel.score, report.pet.score]
    .flatMap((score) => Object.entries(score).filter(([, passed]) => !passed));
  if (failed.length) process.exitCode = 1;
} finally {
  db.close();
  if (process.env.KEEP_EVAL_DB !== '1') fs.rmSync(tempDir, { recursive: true, force: true });
}
