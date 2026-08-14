const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const appBasePath = $('meta[name="app-base-path"]')?.content || '';

const state = {
  page: 'chat',
  bootstrap: null,
  currentUserId: localStorage.getItem('memory_studio_user') || '',
  currentAgentId: localStorage.getItem('memory_studio_agent') || '',
  currentSceneId: localStorage.getItem('memory_studio_scene') || '',
  currentConversationId: '',
  conversations: [],
  messages: [],
  memoryValues: [],
  memoryTab: 'values',
  events: [],
  eventListOrder: 'story',
  eventListIncludeHistory: false,
  graphData: null,
  graphNetwork: null,
  graphIncludeHistory: false,
  graphTypes: { entity: true, event: true, claim: true },
  retrievalProfile: null,
  retrievalTest: null,
  retrievalQuery: '我之前告诉过你我的姓名是什么？',
  schemas: [],
  schemaTab: 'fields',
  eventExtractionProfile: null,
  plots: [],
  triggers: [],
  tools: [],
  automationTab: 'triggers',
  timelineView: 'all',
  architectureOverview: null,
  architectureSources: new Map(),
  architectureAsking: false,
  sending: false
};

const pageTitles = {
  chat: '角色对话',
  memory: '记忆查询',
  schemas: '记忆设置',
  persona: '人设与剧情',
  automation: '触发与工具',
  timeline: '系统架构图'
};

const eventTypeOptions = [
  ['episode', '对话片段'], ['trip', '出行'], ['meeting', '会面'], ['promise', '约定'],
  ['relationship', '关系节点'], ['plot', '剧情'], ['learning', '学习'], ['assessment', '评测'],
  ['error', '错因'], ['achievement', '进展'], ['plan', '计划']
];

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function formatDate(value, includeTime = true) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', includeTime
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '未设置';
  if (Array.isArray(value)) return value.length ? value.join('、') : '未设置';
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : '未设置';
  return String(value);
}

async function api(path, options = {}) {
  const response = await fetch(`${appBasePath}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') showLogin();
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type === 'error' ? 'error' : ''}`;
  element.textContent = message;
  $('#toastRoot').append(element);
  setTimeout(() => element.remove(), 3200);
}

function showLogin() {
  $('#loginOverlay').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#traceDrawer')?.classList.remove('open');
  const architectureAssistant = $('#architectureAssistant');
  architectureAssistant?.classList.remove('open');
  if (architectureAssistant) {
    architectureAssistant.inert = true;
    architectureAssistant.setAttribute('aria-hidden', 'true');
  }
  setTimeout(() => $('#adminPassword')?.focus(), 50);
}

function showApp() {
  $('#loginOverlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function currentUser() {
  return state.bootstrap?.users.find((item) => item.id === state.currentUserId);
}

function currentAgent() {
  return state.bootstrap?.agents.find((item) => item.id === state.currentAgentId);
}

function sceneForAgent(agent = currentAgent()) {
  return state.bootstrap?.scenes?.find((item) => item.id === agent?.scene_id)
    || state.bootstrap?.scenes?.find((item) => item.scenario_type === agent?.scenario_type);
}

function currentScene() {
  return state.bootstrap?.scenes?.find((item) => item.id === state.currentSceneId) || sceneForAgent();
}

function scenarioLabel(value) {
  return { companion: '陪伴', education: '教育', general: '通用', all: '共享基线' }[value] || value;
}

function sourceLabel(value) {
  return {
    default: '系统默认', admin_manual: '管理员校正', manual: '手动写入', model_extracted: '模型抽取',
    user_explicit_ooc: '用户明确要求', event_derived: '事件推导', derived: '规则派生'
  }[value] || value || '未知来源';
}

function scopeQuery() {
  return new URLSearchParams({
    user_id: state.currentUserId,
    agent_id: state.currentAgentId,
    story_id: 'main_story',
    branch_id: 'main'
  });
}

function emptyState(icon, text) {
  return `<div class="empty-state"><i data-lucide="${icon}"></i><span>${escapeHtml(text)}</span></div>`;
}

function openModal({ title, body, submitLabel = '保存', submitClass = 'primary', onSubmit, width = 560, showCancel = true }) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop dynamic-modal">
      <form class="modal" style="width:min(${width}px,100%)">
        <div class="modal-header"><h3>${escapeHtml(title)}</h3><button type="button" class="icon-button modal-close" aria-label="关闭"><i data-lucide="x"></i></button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-footer">${showCancel ? '<button type="button" class="button secondary modal-close">取消</button>' : ''}<button type="submit" class="button ${submitClass}">${escapeHtml(submitLabel)}</button></div>
      </form>
    </div>`;
  refreshIcons();
  $$('.modal-close', root).forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  $('.dynamic-modal', root).addEventListener('click', (event) => {
    if (event.target.classList.contains('dynamic-modal')) root.innerHTML = '';
  });
  $('form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('button[type="submit"]', root);
    submit.disabled = true;
    try {
      await onSubmit(new FormData(event.currentTarget), event.currentTarget);
      root.innerHTML = '';
    } catch (error) {
      toast(error.message, 'error');
      submit.disabled = false;
    }
  });
}

async function initialize() {
  const session = await api('/api/admin/session').catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    showLogin();
    return;
  }
  await loadBootstrap();
  showApp();
}

async function loadBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  if (!state.bootstrap.users.some((item) => item.id === state.currentUserId)) {
    state.currentUserId = state.bootstrap.users[0]?.id || '';
  }
  if (!state.bootstrap.agents.some((item) => item.id === state.currentAgentId)) {
    state.currentAgentId = state.bootstrap.agents[0]?.id || '';
  }
  if (!state.bootstrap.scenes?.some((item) => item.id === state.currentSceneId)) {
    state.currentSceneId = sceneForAgent()?.id || state.bootstrap.scenes?.[0]?.id || '';
  }
  localStorage.setItem('memory_studio_user', state.currentUserId);
  localStorage.setItem('memory_studio_agent', state.currentAgentId);
  localStorage.setItem('memory_studio_scene', state.currentSceneId);
  renderSelectors();
  renderAgentHeader();
  await loadConversations();
  refreshIcons();
}

function renderSelectors() {
  const userOptions = state.bootstrap.users.map((user) =>
    `<option value="${escapeHtml(user.id)}" ${user.id === state.currentUserId ? 'selected' : ''}>${escapeHtml(user.display_name)}</option>`
  ).join('');
  const agentOptions = state.bootstrap.agents.map((agent) =>
    `<option value="${escapeHtml(agent.id)}" ${agent.id === state.currentAgentId ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`
  ).join('');
  $('#userSelect').innerHTML = userOptions;
  $('#agentSelect').innerHTML = agentOptions;
  $('#memoryUserSelect').innerHTML = userOptions;
  $('#memoryAgentSelect').innerHTML = agentOptions;
  const user = currentUser();
  $('#userAvatar').textContent = user?.display_name?.slice(0, 1) || 'U';
  $('#userAvatar').style.background = user?.avatar_color || '#2563eb';
}

function renderAgentHeader() {
  const agent = currentAgent();
  if (!agent) return;
  $('#chatAgentName').textContent = agent.name;
  $('#chatAgentDescription').textContent = agent.description;
  $('#agentAvatar').textContent = agent.name.slice(0, 1);
  $('#agentAvatar').style.background = agent.avatar_color;
  const scene = sceneForAgent(agent);
  $('#topbarSceneName').textContent = scene?.name || scenarioLabel(agent.scenario_type);
  $('#pageMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · main_story / main`;
}

async function switchContext() {
  state.currentConversationId = '';
  state.messages = [];
  state.retrievalTest = null;
  state.graphData = null;
  state.graphNetwork?.destroy();
  state.graphNetwork = null;
  localStorage.setItem('memory_studio_user', state.currentUserId);
  localStorage.setItem('memory_studio_agent', state.currentAgentId);
  state.currentSceneId = sceneForAgent()?.id || state.currentSceneId;
  localStorage.setItem('memory_studio_scene', state.currentSceneId);
  renderSelectors();
  renderAgentHeader();
  await loadConversations();
  await loadCurrentPage();
}

async function loadConversations() {
  if (!state.currentUserId || !state.currentAgentId) return;
  const params = new URLSearchParams({ user_id: state.currentUserId, agent_id: state.currentAgentId });
  state.conversations = await api(`/api/conversations?${params}`);
  renderConversations();
  if (state.currentConversationId && state.conversations.some((item) => item.id === state.currentConversationId)) {
    await openConversation(state.currentConversationId);
  } else if (state.conversations.length) {
    await openConversation(state.conversations[0].id);
  } else {
    renderWelcome();
  }
}

function renderConversations() {
  const root = $('#conversationList');
  if (!state.conversations.length) {
    root.innerHTML = emptyState('message-square-dashed', '暂无对话');
    refreshIcons();
    return;
  }
  root.innerHTML = state.conversations.map((conversation) => `
    <button class="conversation-item ${conversation.id === state.currentConversationId ? 'active' : ''}" data-conversation-id="${conversation.id}">
      <strong>${escapeHtml(conversation.title)}</strong>
      <time>${formatDate(conversation.updated_at)}</time>
      <span>${escapeHtml(conversation.last_message || '暂无消息')}</span>
    </button>`).join('');
  $$('[data-conversation-id]', root).forEach((button) => button.addEventListener('click', () => openConversation(button.dataset.conversationId)));
}

function renderWelcome() {
  state.currentConversationId = '';
  state.messages = [];
  const agent = currentAgent();
  $('#messageList').innerHTML = `
    <div class="message-row assistant"><div><div class="message-bubble">${escapeHtml(agent?.greeting || '今天想聊什么？')}</div></div></div>`;
}

async function openConversation(id) {
  const payload = await api(`/api/conversations/${encodeURIComponent(id)}?user_id=${encodeURIComponent(state.currentUserId)}`);
  state.currentConversationId = id;
  state.messages = payload.messages;
  renderConversations();
  renderMessages();
}

function renderMessages(extraHtml = '') {
  const root = $('#messageList');
  root.innerHTML = state.messages.map((message) => `
    <div class="message-row ${message.role}">
      <div>
        <div class="message-bubble">${escapeHtml(message.content)}</div>
        <div class="message-time">${formatDate(message.created_at)}</div>
      </div>
    </div>`).join('') + extraHtml;
  root.scrollTop = root.scrollHeight;
}

async function sendMessage(text) {
  if (state.sending || !text.trim()) return;
  state.sending = true;
  $('#sendButton').disabled = true;
  $('#messageInput').value = '';
  $('#messageInput').style.height = 'auto';
  const optimistic = {
    id: `local_${Date.now()}`,
    role: 'user',
    content: text,
    created_at: new Date().toISOString()
  };
  state.messages.push(optimistic);
  renderMessages(`<div class="message-row assistant" id="thinkingRow"><div class="message-bubble thinking"><i></i><i></i><i></i></div></div>`);
  try {
    const result = await api('/api/chat', {
      method: 'POST',
      body: {
        user_id: state.currentUserId,
        agent_id: state.currentAgentId,
        conversation_id: state.currentConversationId,
        message: text
      }
    });
    state.currentConversationId = result.conversation.id;
    await loadConversations();
    const commitLabel = result.diagnostics?.memoryCommitStatus === 'skipped' ? '记忆抽取已停用' : '记忆已提交';
    toast(`${commitLabel} · Trace ${result.traceId.slice(-6)}`);
  } catch (error) {
    state.messages = state.messages.filter((item) => item.id !== optimistic.id);
    renderMessages();
    toast(error.message, 'error');
  } finally {
    state.sending = false;
    $('#sendButton').disabled = false;
    $('#messageInput').focus();
  }
}

function navigate(page) {
  state.page = page;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((item) => item.classList.toggle('active', item.id === `page-${page}`));
  $('#pageTitle').textContent = pageTitles[page];
  if (page === 'timeline') {
    $('#pageMeta').textContent = `${currentScene()?.name || '当前场景'} · runtime / memory / retrieval`;
    const frame = $('#page-timeline .timeline-frame');
    if (frame) requestAnimationFrame(() => frame.scrollTo({ top: 0, left: 0 }));
  } else {
    renderAgentHeader();
  }
  return loadCurrentPage().catch((error) => toast(error.message, 'error'));
}

async function loadCurrentPage() {
  if (state.page === 'memory') await loadMemory();
  if (state.page === 'schemas') await loadSchemas();
  if (state.page === 'persona') await loadPersona();
  if (state.page === 'automation') await loadAutomation();
  if (state.page === 'timeline') await loadArchitectureOverview();
  refreshIcons();
}

function renderArchitectureIndex(index = {}) {
  const ready = Boolean(index.ready);
  const label = ready ? '代码索引就绪' : `${Number(index.staleChunks || 0)} 个切片待更新`;
  const model = (index.models || []).join(' / ') || '首次提问时建立';
  const meta = `${Number(index.chunks || 0)}/${Number(index.expectedChunks || 0)} chunks · ${model}`;
  $('#architectureIndexBadge').textContent = label;
  $('#architectureIndexMeta').textContent = meta;
  $('#architectureAssistantIndex').textContent = label;
  $('#architectureAssistantIndexMeta').textContent = meta;
  const badge = $('.architecture-index-state');
  badge?.classList.toggle('ready', ready);
  badge?.classList.toggle('stale', !ready);
}

async function loadArchitectureOverview() {
  const sceneId = currentScene()?.id || '';
  state.architectureOverview = await api(`/api/architecture/overview?scene_id=${encodeURIComponent(sceneId)}`);
  const { thresholds, compression, timing, index, scene } = state.architectureOverview;
  const main = thresholds.mainModel;
  const extraction = thresholds.extraction;
  $('#pageMeta').textContent = `${scene.name} · runtime / memory / retrieval`;
  $('#architectureMainWindow').textContent = `${main.messageLimit} 条消息 · 约 ${main.approximateTurns} 轮`;
  $('#architectureExtractionWindow').textContent = `${extraction.contextTurns} 轮 · 最多 ${extraction.messageLimit} 条`;
  $('#architectureEventThreshold').textContent = `最多 ${extraction.maxEventsPerTurn} 个事件 · importance ≥ ${extraction.minImportance}`;
  $('#architectureCompressionStatus').textContent = compression.rollingSummaryEnabled ? '滚动摘要已启用' : '滚动摘要未启用';
  $('#architectureRecentContext').textContent = `最近 ${main.messageLimit} 条原文`;
  $('#architectureInputLimit').textContent = `0 < X ≤ ${main.messageLimit}`;
  $('#architectureMessageLimit').textContent = `X ≤ ${main.messageLimit}`;
  $('#architectureHistoryLimit').textContent = `最多 ${Math.max(0, main.messageLimit - 1)} 条 user / assistant 原文`;
  $('#architectureExtractionTrigger').textContent = timing.triggerPoint === 'after_assistant_message_persisted'
    ? 'assistant 落库后启动；同一 HTTP 请求继续等待'
    : timing.triggerPoint;
  $('#architectureDerivedRule').textContent = thresholds.relationship.stages
    .slice().reverse().map((item) => `${item.minimum} ${item.stage}`).join(' · ');
  renderArchitectureIndex(index);
}

function metrics(items) {
  $('#memorySummary').innerHTML = items.map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

function renderMemoryContext() {
  const user = currentUser();
  const agent = currentAgent();
  const scene = sceneForAgent(agent);
  if (!user || !agent) return;
  $('#memoryUserSelect').value = user.id;
  $('#memoryAgentSelect').value = agent.id;
  $('#memorySceneName').textContent = scene?.name || scenarioLabel(agent.scenario_type);
  $('#memoryInstanceKey').textContent = `${user.id} × ${agent.id}`;
  $('#memoryInstanceTitle').textContent = `${user.display_name} × ${agent.name}`;
  $('#memoryInstanceDescription').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)}场景下的独立记忆实例`;
}

function renderMemoryCategories() {
  const selected = $('#memoryCategoryFilter').value;
  const counts = state.memoryValues.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + 1;
    return result;
  }, {});
  const entries = [['', '全部记忆', state.memoryValues.length], ...Object.entries(counts).map(([name, count]) => [name, name, count])];
  $('#memoryCategoryList').innerHTML = entries.map(([value, label, count]) => `
    <button class="category-nav-item ${selected === value ? 'active' : ''}" data-memory-category="${escapeHtml(value)}">
      <span>${escapeHtml(label)}</span><b>${count}</b>
    </button>`).join('');
  $$('[data-memory-category]').forEach((button) => button.addEventListener('click', () => {
    $('#memoryCategoryFilter').value = button.dataset.memoryCategory;
    renderMemoryValues();
  }));
}

async function loadMemory() {
  renderMemoryContext();
  const valuesMode = state.memoryTab === 'values';
  if (state.memoryTab !== 'graph') {
    state.graphNetwork?.destroy();
    state.graphNetwork = null;
  }
  $('#memoryFilters').classList.toggle('hidden', !valuesMode);
  $('#memorySearch').disabled = !valuesMode;
  $('#memoryCategoryFilter').disabled = !valuesMode;
  $('#memoryCategoryList').classList.toggle('disabled', !valuesMode);
  if (state.memoryTab === 'values') {
    state.memoryValues = await api(`/api/memory/values?${scopeQuery()}`);
    const categories = [...new Set(state.memoryValues.map((item) => item.category))];
    const select = $('#memoryCategoryFilter');
    const old = select.value;
    select.innerHTML = '<option value="">全部分类</option>' + categories.map((item) => `<option>${escapeHtml(item)}</option>`).join('');
    select.value = categories.includes(old) ? old : '';
    renderMemoryValues();
  } else if (state.memoryTab === 'events') {
    const params = new URLSearchParams(scopeQuery());
    params.set('order', state.eventListOrder);
    params.set('include_history', String(state.eventListIncludeHistory));
    state.events = await api(`/api/memory/events?${params}`);
    renderEventList();
  } else if (state.memoryTab === 'graph') {
    const graph = await api(`/api/memory/graph?${scopeQuery()}`);
    renderGraph(graph);
  } else if (state.memoryTab === 'retrieval') {
    const scene = sceneForAgent();
    state.retrievalProfile = await api(`/api/scenes/${encodeURIComponent(scene.id)}/retrieval-profile`);
    renderRetrievalLab();
  } else {
    const params = new URLSearchParams({ user_id: state.currentUserId, agent_id: state.currentAgentId, key: '' });
    const history = await api(`/api/memory/history?${params}`);
    renderMemoryHistory(history);
  }
}

function renderMemoryValue(item) {
  if (item.value === null || item.value === undefined || item.value === '' || (Array.isArray(item.value) && !item.value.length)) {
    return '<span class="memory-empty-value">未设置</span>';
  }
  if (Array.isArray(item.value)) {
    return `<div class="value-tags">${item.value.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div>`;
  }
  if (item.value && typeof item.value === 'object') {
    return `<code class="object-value">${escapeHtml(JSON.stringify(item.value))}</code>`;
  }
  if (item.valueType === 'number' && String(item.key).startsWith('relationship.')) {
    const score = Math.max(0, Math.min(100, Number(item.value) || 0));
    return `<div class="score-value"><strong>${escapeHtml(item.value)}</strong><div><i style="width:${score}%"></i></div><span>/ 100</span></div>`;
  }
  return `<strong class="plain-value">${escapeHtml(item.value)}</strong>`;
}

function renderMemoryValues() {
  const query = $('#memorySearch').value.trim().toLowerCase();
  const category = $('#memoryCategoryFilter').value;
  const filtered = state.memoryValues.filter((item) => {
    const haystack = `${item.key} ${item.label} ${formatValue(item.value)}`.toLowerCase();
    return (!query || haystack.includes(query)) && (!category || item.category === category);
  });
  renderMemoryCategories();
  metrics([
    ['生效字段', state.memoryValues.length],
    ['每轮注入', state.memoryValues.filter((item) => item.pinned).length],
    ['已写入', state.memoryValues.filter((item) => item.version > 0).length],
    ['默认值', state.memoryValues.filter((item) => item.version === 0).length]
  ]);
  $('#memoryResultCount').textContent = `${filtered.length} 个字段`;
  const grouped = filtered.reduce((result, item) => {
    (result[item.category] ||= []).push(item);
    return result;
  }, {});
  $('#memoryContent').innerHTML = filtered.length ? `<div class="memory-groups">${Object.entries(grouped).map(([categoryName, items]) => `
    <section class="memory-group">
      <header><div><span class="group-icon"><i data-lucide="folder-kanban"></i></span><h4>${escapeHtml(categoryName)}</h4></div><span>${items.length} 个字段</span></header>
      <div class="memory-records">${items.map((item) => `
        <article class="memory-record">
          <div class="memory-field"><div><strong>${escapeHtml(item.label)}</strong>${item.pinned ? '<span class="badge blue">每轮注入</span>' : ''}</div><code>${escapeHtml(item.key)}</code></div>
          <div class="memory-current-value">${renderMemoryValue(item)}</div>
          <div class="memory-provenance"><span>${escapeHtml(sourceLabel(item.sourceType))}</span><small>${item.version ? `v${item.version} · ${formatDate(item.updatedAt)}` : '尚未产生用户版本'}</small></div>
          <div class="memory-record-meta"><span class="badge">${escapeHtml(item.valueType)}</span><button class="icon-button bordered edit-memory" data-key="${escapeHtml(item.key)}" title="编辑记忆" aria-label="编辑${escapeHtml(item.label)}"><i data-lucide="pencil"></i></button></div>
        </article>`).join('')}</div>
    </section>`).join('')}</div>` : emptyState('database-zap', '没有匹配的记忆');
  $$('.edit-memory').forEach((button) => button.addEventListener('click', () => editMemory(button.dataset.key)));
  refreshIcons();
}

function editMemory(key) {
  const item = state.memoryValues.find((memory) => memory.key === key);
  const complex = ['string_list', 'object'].includes(item.valueType);
  const value = complex ? JSON.stringify(item.value, null, 2) : String(item.value ?? '');
  openModal({
    title: `编辑记忆 · ${item.label}`,
    body: `
      <label><span>Key</span><input value="${escapeHtml(item.key)}" disabled></label>
      <label><span>当前值</span>${complex
        ? `<textarea name="value" rows="8" required>${escapeHtml(value)}</textarea>`
        : `<input name="value" value="${escapeHtml(value)}" required>`}</label>
      <label><span>变更原因</span><input name="reason" placeholder="管理员手动校正"></label>
      <span class="hint">修改后生成新版本，旧值保留在变更历史中。</span>`,
    onSubmit: async (formData) => {
      let nextValue = formData.get('value');
      if (item.valueType === 'number') nextValue = Number(nextValue);
      if (item.valueType === 'boolean') nextValue = nextValue === 'true';
      if (complex) {
        try { nextValue = JSON.parse(nextValue); } catch { throw new Error('请输入合法 JSON'); }
      }
      await api(`/api/memory/values/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: {
          value: nextValue,
          reason: formData.get('reason'),
          user_id: state.currentUserId,
          agent_id: state.currentAgentId,
          story_id: 'main_story',
          branch_id: 'main'
        }
      });
      await loadMemory();
      toast('记忆已生成新版本');
    }
  });
}

function eventTypeLabel(type) {
  return ({
    episode: '片段', trip: '出行', meeting: '会面', promise: '约定', relationship: '关系', plot: '剧情',
    learning: '学习', assessment: '评测', error: '错因', achievement: '进展', plan: '计划'
  })[type] || type;
}

function renderEventList() {
  const events = state.events;
  metrics([
    ['事件', events.length],
    ['当前有效', events.filter((item) => item.status === 'active').length],
    ['历史版本', events.filter((item) => item.status !== 'active').length],
    ['有效声明', events.reduce((sum, item) => sum + item.claims.filter((claim) => claim.status === 'active').length, 0)]
  ]);
  $('#memoryResultCount').textContent = `${events.length} 个事件`;
  $('#memoryContent').innerHTML = `<section class="event-list-workbench">
    <header class="event-list-toolbar">
      <div class="event-order-switch segmented" role="group" aria-label="事件排序">
        <button class="${state.eventListOrder === 'story' ? 'active' : ''}" data-event-order="story">剧情时间</button>
        <button class="${state.eventListOrder === 'created' ? 'active' : ''}" data-event-order="created">写入时间</button>
      </div>
      <label class="event-history-toggle"><span><strong>历史版本</strong><small>显示 superseded / retracted 事件</small></span><span class="toggle-control"><input type="checkbox" id="eventHistoryToggle" ${state.eventListIncludeHistory ? 'checked' : ''}><i></i></span></label>
    </header>
    <div class="event-time-axis">${events.length ? events.map((item, index) => {
      const claims = item.claims || [];
      const collection = item.metadata?.collection_name || '';
      const primaryTime = state.eventListOrder === 'story'
        ? (item.story_time || '未标注剧情时间')
        : formatDate(item.created_at);
      return `<article class="event-timeline-row ${item.status !== 'active' ? 'history' : ''}">
        <div class="event-time-marker"><time>${escapeHtml(primaryTime)}</time><span>${escapeHtml(formatDate(item.created_at))}</span><i>${String(index + 1).padStart(2, '0')}</i></div>
        <div class="event-list-record">
          <header><div><span class="badge blue">${escapeHtml(eventTypeLabel(item.event_type))}</span><span class="badge ${item.status === 'active' ? '' : 'red'}">${escapeHtml(item.status)}</span>${collection ? `<span class="badge">${escapeHtml(collection)}${item.sequence_no !== null ? ` · #${item.sequence_no}` : ''}</span>` : ''}</div><span class="event-importance">importance ${Number(item.importance).toFixed(2)}</span></header>
          <h4>${escapeHtml(item.title)}</h4>
          <p>${escapeHtml(item.summary || '无事件摘要')}</p>
          ${claims.length ? `<div class="event-claim-list">${claims.map((claim) => `<span><b>${escapeHtml(claim.subject)}</b><i>${escapeHtml(claim.predicate)}</i><strong>${escapeHtml(claim.object_name || claim.object_text)}</strong><em>${escapeHtml(claim.status)}</em></span>`).join('')}</div>` : '<div class="event-no-claims">未产生声明槽位</div>'}
          <footer><code>${escapeHtml(item.event_key)}</code><span>evidence ${escapeHtml(String(item.source_message_id || '').slice(-8) || '-')}</span></footer>
        </div>
      </article>`;
    }).join('') : emptyState('calendar-clock', '当前作用域尚无事件')}</div>
  </section>`;
  $$('[data-event-order]').forEach((button) => button.addEventListener('click', async () => {
    state.eventListOrder = button.dataset.eventOrder;
    await loadMemory();
  }));
  $('#eventHistoryToggle')?.addEventListener('change', async (event) => {
    state.eventListIncludeHistory = event.target.checked;
    await loadMemory();
  });
  refreshIcons();
}

function renderGraph(graph) {
  state.graphData = graph;
  state.graphNetwork?.destroy();
  state.graphNetwork = null;
  metrics([
    ['实体', graph.entities.length],
    ['关系边', graph.edges.length],
    ['剧情事件', graph.events.length],
    ['有效声明', graph.claims.filter((item) => item.status === 'active').length]
  ]);
  const visible = (item) => state.graphIncludeHistory || item.status === 'active';
  const visibleCount = graph.entities.filter(visible).length + graph.events.filter(visible).length
    + graph.claims.filter(visible).length;
  $('#memoryResultCount').textContent = `${visibleCount} 个可视节点`;
  $('#memoryContent').innerHTML = `<section class="graph-workbench">
    <header class="graph-toolbar">
      <div class="graph-view-switch" role="group" aria-label="图谱状态视图">
        <button class="${state.graphIncludeHistory ? '' : 'active'}" data-graph-history="false">当前有效</button>
        <button class="${state.graphIncludeHistory ? 'active' : ''}" data-graph-history="true">含历史版本</button>
      </div>
      <div class="graph-type-filters" aria-label="节点类型">
        <label><input type="checkbox" data-graph-type="entity" ${state.graphTypes.entity ? 'checked' : ''}><i class="graph-swatch entity"></i><span>实体</span></label>
        <label><input type="checkbox" data-graph-type="event" ${state.graphTypes.event ? 'checked' : ''}><i class="graph-swatch event"></i><span>事件</span></label>
        <label><input type="checkbox" data-graph-type="claim" ${state.graphTypes.claim ? 'checked' : ''}><i class="graph-swatch claim"></i><span>声明</span></label>
      </div>
      <div class="graph-zoom-actions">
        <button class="icon-button bordered" data-graph-action="zoom-out" title="缩小" aria-label="缩小"><i data-lucide="minus"></i></button>
        <button class="icon-button bordered" data-graph-action="zoom-in" title="放大" aria-label="放大"><i data-lucide="plus"></i></button>
        <button class="icon-button bordered" data-graph-action="fit" title="适应画布" aria-label="适应画布"><i data-lucide="maximize-2"></i></button>
      </div>
    </header>
    <div class="graph-stage">
      <div id="memoryGraphCanvas" class="graph-canvas" role="img" aria-label="当前用户和角色的记忆关系网络"></div>
      <aside id="graphInspector" class="graph-inspector">
        <div class="graph-inspector-empty"><i data-lucide="mouse-pointer-2"></i><span>选择节点</span></div>
      </aside>
    </div>
    <footer class="graph-legend">
      <span><i class="graph-line solid"></i>当前关系</span>
      <span><i class="graph-line history"></i>历史版本</span>
      <span class="graph-scope"><i data-lucide="shield-check"></i>${escapeHtml(state.currentUserId)} / ${escapeHtml(state.currentAgentId)} / main_story / main</span>
    </footer>
  </section>`;
  $$('[data-graph-history]').forEach((button) => button.addEventListener('click', () => {
    state.graphIncludeHistory = button.dataset.graphHistory === 'true';
    renderGraph(state.graphData);
  }));
  $$('[data-graph-type]').forEach((input) => input.addEventListener('change', () => {
    state.graphTypes[input.dataset.graphType] = input.checked;
    renderGraph(state.graphData);
  }));
  $$('[data-graph-action]').forEach((button) => button.addEventListener('click', () => {
    if (!state.graphNetwork) return;
    if (button.dataset.graphAction === 'fit') state.graphNetwork.fit({ animation: { duration: 280 } });
    else {
      const factor = button.dataset.graphAction === 'zoom-in' ? 1.22 : 0.82;
      state.graphNetwork.moveTo({ scale: state.graphNetwork.getScale() * factor, animation: { duration: 180 } });
    }
  }));
  refreshIcons();
  requestAnimationFrame(() => buildGraphNetwork(graph));
}

function graphNodeLabel(value, limit = 22) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function renderGraphInspector(node) {
  const root = $('#graphInspector');
  if (!root || !node) return;
  root.innerHTML = `<div class="graph-inspector-head">
      <span class="graph-node-kind ${escapeHtml(node.kind)}">${escapeHtml(node.kindLabel)}</span>
      <span class="badge ${node.status === 'active' ? 'blue' : 'red'}">${escapeHtml(node.status)}</span>
    </div>
    <h4>${escapeHtml(node.title)}</h4>
    ${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}
    <dl>${node.fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '-')}</dd></div>`).join('')}</dl>`;
}

function buildGraphNetwork(graph) {
  const canvas = $('#memoryGraphCanvas');
  if (!canvas) return;
  const visible = (item) => state.graphIncludeHistory || item.status === 'active';
  const nodes = [];
  const edges = [];
  const nodeDetails = new Map();
  const visibleNodeIds = new Set();
  const inactiveColor = { background: '#f1f5f9', border: '#94a3b8', highlight: { background: '#e2e8f0', border: '#64748b' } };

  if (state.graphTypes.entity) {
    for (const entity of graph.entities.filter(visible)) {
      const id = `entity:${entity.id}`;
      visibleNodeIds.add(id);
      nodes.push({
        id, label: graphNodeLabel(entity.canonical_name), shape: 'dot', size: 22,
        color: entity.status === 'active' ? { background: '#eaf2ff', border: '#3b82f6', highlight: { background: '#dbeafe', border: '#1d4ed8' } } : inactiveColor,
        font: { color: '#1e3a5f', size: 13, face: '-apple-system' }, borderWidth: 2,
        title: `${entity.canonical_name}\n${entity.entity_type}`
      });
      const aliases = parseJson(entity.aliases_json, []);
      nodeDetails.set(id, {
        kind: 'entity', kindLabel: '实体', title: entity.canonical_name, status: entity.status,
        description: '', fields: [['类型', entity.entity_type], ['别名', aliases.join('、')], ['更新', formatDate(entity.updated_at)]]
      });
    }
  }
  if (state.graphTypes.event) {
    for (const event of graph.events.filter(visible)) {
      const id = `event:${event.id}`;
      visibleNodeIds.add(id);
      nodes.push({
        id, label: graphNodeLabel(event.title), shape: 'box', margin: 12,
        color: event.status === 'active' ? { background: '#2563eb', border: '#1d4ed8', highlight: { background: '#1d4ed8', border: '#1e40af' } } : inactiveColor,
        font: { color: event.status === 'active' ? '#ffffff' : '#475569', size: 13, face: '-apple-system', bold: { color: '#ffffff' } },
        borderWidth: 1.5, title: `${event.title}\n${event.summary}`
      });
      nodeDetails.set(id, {
        kind: 'event', kindLabel: '事件', title: event.title, status: event.status,
        description: event.summary, fields: [['事件类型', event.event_type], ['剧情时间', event.story_time], ['重要度', event.importance], ['事件 Key', event.event_key]]
      });
    }
  }
  if (state.graphTypes.claim) {
    for (const claim of graph.claims.filter(visible)) {
      const id = `claim:${claim.id}`;
      visibleNodeIds.add(id);
      nodes.push({
        id, label: graphNodeLabel(`${claim.predicate}：${claim.object_name || claim.object_text}`, 26), shape: 'ellipse', margin: 10,
        color: claim.status === 'active' ? { background: '#fff4df', border: '#d97706', highlight: { background: '#ffedd5', border: '#b45309' } } : inactiveColor,
        font: { color: claim.status === 'active' ? '#7c3f0c' : '#475569', size: 12, face: '-apple-system' },
        borderWidth: 1.5, title: `${claim.subject} / ${claim.predicate} = ${claim.object_name || claim.object_text}`
      });
      nodeDetails.set(id, {
        kind: 'claim', kindLabel: '声明', title: `${claim.subject} / ${claim.predicate}`, status: claim.status,
        description: claim.object_name || claim.object_text,
        fields: [['事实作用域', claim.fact_scope], ['模态', claim.modality], ['版本', `v${claim.version}`], ['置信度', claim.confidence], ['剧情时间', claim.story_time]]
      });
    }
  }

  for (const relation of graph.edges.filter(visible)) {
    const from = `entity:${relation.source_entity_id}`;
    const to = `entity:${relation.target_entity_id}`;
    if (visibleNodeIds.has(from) && visibleNodeIds.has(to)) {
      edges.push({ id: `edge:${relation.id}`, from, to, label: relation.predicate, status: relation.status });
    }
  }
  for (const claim of graph.claims.filter(visible)) {
    const claimId = `claim:${claim.id}`;
    const subjectId = `entity:${claim.subject_entity_id}`;
    const eventId = `event:${claim.event_id}`;
    const objectId = `entity:${claim.object_entity_id}`;
    if (visibleNodeIds.has(subjectId) && visibleNodeIds.has(claimId)) {
      edges.push({ id: `claim-subject:${claim.id}`, from: subjectId, to: claimId, label: claim.predicate, status: claim.status });
    }
    if (claim.event_id && visibleNodeIds.has(eventId) && visibleNodeIds.has(claimId)) {
      edges.push({ id: `claim-event:${claim.id}`, from: eventId, to: claimId, label: '证据', status: claim.status });
    }
    if (claim.object_entity_id && visibleNodeIds.has(claimId) && visibleNodeIds.has(objectId)) {
      edges.push({ id: `claim-object:${claim.id}`, from: claimId, to: objectId, label: '对象', status: claim.status });
    }
  }

  if (!nodes.length) {
    canvas.innerHTML = emptyState('network', '当前筛选下没有图谱节点');
    refreshIcons();
    return;
  }
  if (!window.vis?.Network || !window.vis?.DataSet) {
    canvas.innerHTML = emptyState('triangle-alert', '图谱渲染组件加载失败');
    refreshIcons();
    return;
  }
  const networkEdges = edges.map((edge) => ({
    ...edge,
    arrows: { to: { enabled: true, scaleFactor: 0.55 } },
    color: edge.status === 'active'
      ? { color: '#8aa5cc', highlight: '#2563eb', hover: '#4f7fc4' }
      : { color: '#cbd5e1', highlight: '#94a3b8', hover: '#94a3b8' },
    dashes: edge.status !== 'active', width: 1.2,
    font: { color: '#64748b', size: 9, background: '#ffffff', strokeWidth: 0, align: 'middle' },
    smooth: { enabled: true, type: 'dynamic', roundness: 0.3 }
  }));
  state.graphNetwork = new window.vis.Network(canvas, {
    nodes: new window.vis.DataSet(nodes), edges: new window.vis.DataSet(networkEdges)
  }, {
    autoResize: true,
    interaction: { hover: true, keyboard: true, tooltipDelay: 180, multiselect: false },
    physics: {
      enabled: true,
      stabilization: { enabled: true, iterations: 180, updateInterval: 25 },
      barnesHut: { gravitationalConstant: -4100, centralGravity: 0.18, springLength: 150, springConstant: 0.035, damping: 0.25 }
    },
    layout: { improvedLayout: true },
    edges: { selectionWidth: 1.8 },
    nodes: { chosen: true }
  });
  state.graphNetwork.once('stabilizationIterationsDone', () => {
    state.graphNetwork?.setOptions({ physics: false });
    state.graphNetwork?.fit({ animation: { duration: 260 } });
  });
  state.graphNetwork.on('selectNode', ({ nodes: selected }) => renderGraphInspector(nodeDetails.get(selected[0])));
  state.graphNetwork.on('deselectNode', () => {
    const root = $('#graphInspector');
    if (root) root.innerHTML = '<div class="graph-inspector-empty"><i data-lucide="mouse-pointer-2"></i><span>选择节点</span></div>';
    refreshIcons();
  });
  const initialNode = nodes.find((node) => node.id.startsWith('event:')) || nodes[0];
  state.graphNetwork.selectNodes([initialNode.id]);
  renderGraphInspector(nodeDetails.get(initialNode.id));
}

function retrievalChannelNames(strategy) {
  const channels = [];
  if (strategy.vectorEnabled ?? strategy.vector_enabled) channels.push('向量');
  if (strategy.keywordEnabled ?? strategy.keyword_enabled) channels.push('关键词');
  if (strategy.graphEnabled ?? strategy.graph_enabled) channels.push('图谱');
  return channels.join(' + ') || '未启用';
}

function scoreText(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : '-';
}

function renderRetrievalResult(payload) {
  const retrieval = payload.retrieval;
  const embedding = retrieval.queryEmbedding;
  const pipeline = retrieval.diagnostics.pipeline;
  const candidates = retrieval.diagnostics.candidates;
  const preview = embedding.vectorPreview.map((value) => Number(value).toFixed(6)).join(', ');
  return `<div class="retrieval-result">
    <section class="retrieval-section embedding-section">
      <header><div><i data-lucide="binary"></i><strong>Query Embedding</strong></div><span class="badge ${embedding.fallback ? 'red' : 'blue'}">${embedding.fallback ? '本地降级' : 'Ark 实时请求'}</span></header>
      <div class="embedding-facts">
        <div><span>模型</span><strong>${escapeHtml(embedding.model)}</strong></div>
        <div><span>维度</span><strong>${embedding.dimensions}</strong></div>
        <div><span>L2 Norm</span><strong>${scoreText(embedding.norm)}</strong></div>
        <div><span>请求耗时</span><strong>${payload.durationMs} ms</strong></div>
      </div>
      <div class="vector-preview"><span>vector[0:10]</span><code>[${escapeHtml(preview)}]</code></div>
      ${embedding.fallbackReason ? `<div class="retrieval-warning"><i data-lucide="triangle-alert"></i><span>${escapeHtml(embedding.fallbackReason)}</span></div>` : ''}
    </section>
    <section class="retrieval-section pipeline-section">
      <header><div><i data-lucide="route"></i><strong>候选过滤与排序</strong></div><span>${escapeHtml(retrieval.strategy.name)}</span></header>
      <div class="retrieval-pipeline">
        <div><span>作用域候选</span><strong>${pipeline.scopedCandidates}</strong></div><i data-lucide="chevron-right"></i>
        <div><span>Active 硬过滤</span><strong>${pipeline.afterActiveGuard}</strong></div><i data-lucide="chevron-right"></i>
        <div><span>意图过滤</span><strong>${pipeline.afterIntentFilter}</strong></div><i data-lucide="chevron-right"></i>
        <div><span>阈值通过</span><strong>${pipeline.afterRelevanceThreshold}</strong></div><i data-lucide="chevron-right"></i>
        <div class="selected"><span>最终 TopK</span><strong>${pipeline.selected}</strong></div>
      </div>
      <div class="retrieval-candidate-table data-surface">${candidates.length ? `
        <table class="data-table"><thead><tr><th style="width:24%">事件候选</th><th style="width:11%">向量相似度</th><th style="width:11%">关键词</th><th style="width:10%">重要度</th><th style="width:10%">时效性</th><th style="width:11%">综合分</th><th style="width:13%">向量状态</th><th style="width:12%">决策</th></tr></thead>
        <tbody>${candidates.map((item) => `<tr class="${item.selected ? 'selected-row' : ''}">
          <td><span class="cell-main">${escapeHtml(item.title)}</span><span class="cell-sub">${escapeHtml(item.eventType)} · ${escapeHtml(item.status)}</span></td>
          <td><code>${scoreText(item.similarity)}</code></td><td><code>${scoreText(item.keywordScore)}</code></td>
          <td>${scoreText(item.importance)}</td><td>${scoreText(item.recencyScore)}</td><td><strong>${scoreText(item.finalScore)}</strong></td>
          <td><span class="badge ${item.vectorSource === 'disabled' ? '' : (item.vectorCompatible ? 'blue' : 'red')}">${item.vectorSource === 'disabled' ? '通道关闭' : (item.vectorCompatible ? (item.vectorSource === 'stored' ? '已存向量' : '降级重算') : '维度不兼容')}</span></td>
          <td><span class="badge ${item.selected ? 'blue' : (item.decision.includes('硬过滤') ? 'red' : 'amber')}">${escapeHtml(item.decision)}</span></td>
        </tr>`).join('')}</tbody></table>` : emptyState('scan-search', '作用域内没有可计算的事件向量')}</div>
    </section>
    <section class="retrieval-section injection-section">
      <header><div><i data-lucide="braces"></i><strong>最终记忆注入</strong></div><span>${retrieval.events.length} 事件 · ${retrieval.claims.length} 声明 · ${retrieval.edges.length} 关系</span></header>
      <pre>${escapeHtml(payload.injectionPreview)}</pre>
    </section>
  </div>`;
}

function renderRetrievalLab() {
  state.graphNetwork?.destroy();
  state.graphNetwork = null;
  const profile = state.retrievalProfile;
  const result = state.retrievalTest;
  if (result) {
    metrics([
      ['Embedding', result.retrieval.queryEmbedding.fallback ? '本地降级' : `${result.retrieval.queryEmbedding.dimensions} 维`],
      ['作用域候选', result.retrieval.diagnostics.pipeline.scopedCandidates],
      ['最终事件', result.retrieval.events.length],
      ['耗时', `${result.durationMs} ms`]
    ]);
  } else {
    metrics([
      ['召回通道', retrievalChannelNames(profile)],
      ['向量阈值', profile.min_similarity],
      ['事件 TopK', profile.event_top_k],
      ['状态保护', 'Active Only']
    ]);
  }
  $('#memoryResultCount').textContent = result ? `${result.retrieval.events.length} 个事件召回` : '待测试';
  $('#memoryContent').innerHTML = `<section class="retrieval-lab">
    <form id="retrievalTestForm" class="retrieval-console">
      <label class="retrieval-query-field"><span>TEST QUERY</span><textarea id="retrievalQuery" rows="2" required>${escapeHtml(state.retrievalQuery)}</textarea></label>
      <button id="runRetrievalButton" class="button primary" type="submit"><i data-lucide="play"></i><span>运行召回</span></button>
    </form>
    <div class="retrieval-strategy-bar">
      <div><span class="strategy-icon"><i data-lucide="sliders-horizontal"></i></span><div><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(retrievalChannelNames(profile))} · similarity ≥ ${profile.min_similarity} · TopK ${profile.event_top_k}</small></div></div>
      <button class="button secondary compact" data-open-retrieval-settings><i data-lucide="external-link"></i><span>召回策略</span></button>
    </div>
    <div id="retrievalOutput">${result ? renderRetrievalResult(result) : '<div class="retrieval-empty"><i data-lucide="scan-search"></i><strong>尚未运行召回测试</strong></div>'}</div>
  </section>`;
  $('#retrievalTestForm').addEventListener('submit', runRetrievalTest);
  $$('[data-open-retrieval-settings]').forEach((button) => button.addEventListener('click', () => {
    jumpToRetrievalSettings().catch((error) => toast(error.message, 'error'));
  }));
  refreshIcons();
}

async function runRetrievalTest(event) {
  event.preventDefault();
  const query = $('#retrievalQuery').value.trim();
  if (!query) return;
  state.retrievalQuery = query;
  const button = $('#runRetrievalButton');
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i><span>计算中</span>';
  button.classList.add('loading');
  refreshIcons();
  try {
    state.retrievalTest = await api('/api/memory/retrieval-test', {
      method: 'POST',
      body: {
        query,
        user_id: state.currentUserId,
        agent_id: state.currentAgentId,
        story_id: 'main_story',
        branch_id: 'main'
      }
    });
    renderRetrievalLab();
    toast('召回测试已完成');
  } catch (error) {
    button.disabled = false;
    button.classList.remove('loading');
    button.innerHTML = '<i data-lucide="play"></i><span>运行召回</span>';
    refreshIcons();
    toast(error.message, 'error');
  }
}

async function jumpToRetrievalSettings() {
  const scene = sceneForAgent();
  state.currentSceneId = scene.id;
  localStorage.setItem('memory_studio_scene', state.currentSceneId);
  await navigate('schemas');
  await editRetrievalProfile();
}

function renderMemoryHistory(history) {
  metrics([
    ['变更记录', history.length],
    ['新建', history.filter((item) => item.operation === 'create').length],
    ['更新', history.filter((item) => item.operation !== 'create').length],
    ['模型抽取', history.filter((item) => item.source_type === 'model_extracted').length]
  ]);
  $('#memoryResultCount').textContent = `${history.length} 条变更记录`;
  $('#memoryContent').innerHTML = history.length ? `<div class="data-surface">
    <table class="data-table"><thead><tr><th style="width:23%">字段</th><th style="width:22%">旧值</th><th style="width:22%">新值</th><th style="width:12%">操作</th><th style="width:11%">版本</th><th style="width:14%">时间</th></tr></thead>
    <tbody>${history.map((item) => `<tr><td><span class="cell-main">${escapeHtml(item.label)}</span><code>${escapeHtml(item.key)}</code></td><td class="value-cell">${escapeHtml(formatValue(item.old_value))}</td><td class="value-cell">${escapeHtml(formatValue(item.new_value))}</td><td><span class="badge">${escapeHtml(item.operation)}</span></td><td>v${item.version}<span class="cell-sub">${escapeHtml(sourceLabel(item.source_type))}</span></td><td>${formatDate(item.created_at)}</td></tr>`).join('')}</tbody></table></div>`
    : emptyState('history', '尚无变更记录');
  refreshIcons();
}

async function loadSchemas() {
  const [schemas, scenes] = await Promise.all([api('/api/memory/schemas'), api('/api/scenes')]);
  state.schemas = schemas;
  state.bootstrap.scenes = scenes;
  if (!scenes.some((scene) => scene.id === state.currentSceneId)) {
    state.currentSceneId = sceneForAgent()?.id || scenes[0]?.id || '';
  }
  state.eventExtractionProfile = state.currentSceneId
    ? await api(`/api/scenes/${encodeURIComponent(state.currentSceneId)}/event-extraction-profile`)
    : null;
  renderSchemas();
}

function renderSceneList() {
  const scenes = state.bootstrap.scenes || [];
  $('#sceneList').innerHTML = scenes.map((scene) => {
    const characters = state.bootstrap.agents.filter((agent) => agent.scene_id === scene.id);
    return `<button class="object-list-item ${scene.id === state.currentSceneId ? 'active' : ''}" data-scene-id="${escapeHtml(scene.id)}">
      <span class="object-list-icon" style="--item-accent:${escapeHtml(scene.accent_color)}"><i data-lucide="${escapeHtml(scene.icon || 'layout-template')}"></i></span>
      <span class="object-list-copy"><strong>${escapeHtml(scene.name)}</strong><small>${characters.length ? characters.map((agent) => agent.name).join('、') : '暂无角色'}</small></span>
      <span class="object-list-count">${scene.field_count}</span>
    </button>`;
  }).join('');
  $$('[data-scene-id]').forEach((button) => button.addEventListener('click', async () => {
    state.currentSceneId = button.dataset.sceneId;
    localStorage.setItem('memory_studio_scene', state.currentSceneId);
    $('#schemaCategoryFilter').value = '';
    state.eventExtractionProfile = await api(`/api/scenes/${encodeURIComponent(state.currentSceneId)}/event-extraction-profile`);
    renderSchemas();
  }));
}

function renderSchemas() {
  const scene = currentScene();
  if (!scene) return;
  renderSceneList();
  const query = $('#schemaSearch').value.trim().toLowerCase();
  const effective = state.schemas.filter((item) => item.scenario_type === 'all' || item.scenario_type === scene.scenario_type);
  const categories = [...new Set(effective.map((item) => item.category))];
  const categorySelect = $('#schemaCategoryFilter');
  const oldCategory = categorySelect.value;
  categorySelect.innerHTML = '<option value="">全部分类</option>' + categories.map((item) => `<option>${escapeHtml(item)}</option>`).join('');
  categorySelect.value = categories.includes(oldCategory) ? oldCategory : '';
  const filtered = effective.filter((item) => {
    const match = `${item.key} ${item.label} ${item.category}`.toLowerCase().includes(query);
    return match && (!categorySelect.value || item.category === categorySelect.value);
  });
  $('#schemaSceneIcon').innerHTML = `<i data-lucide="${escapeHtml(scene.icon || 'layout-template')}"></i>`;
  $('#schemaSceneIcon').style.background = `${scene.accent_color}14`;
  $('#schemaSceneIcon').style.color = scene.accent_color;
  $('#schemaProfileName').textContent = scene.memory_profile_name;
  $('#schemaProfileDescription').textContent = scene.memory_profile_description;
  $('#schemaScenarioBadge').textContent = scenarioLabel(scene.scenario_type);
  $('#schemaSceneName').textContent = scene.name;
  $('#schemaProfileShortName').textContent = scene.memory_profile_name;
  $('#schemaCharacterCount').textContent = `${scene.character_count} 个`;
  $('#schemaResultCount').textContent = `${filtered.length} 个字段`;
  $('#pageMeta').textContent = `${scene.name} · 唯一记忆设置`;
  const fieldsMode = state.schemaTab === 'fields';
  $$('[data-schema-tab]').forEach((button) => button.classList.toggle('active', button.dataset.schemaTab === state.schemaTab));
  $('#schemaFieldToolbar').classList.toggle('hidden', !fieldsMode);
  $('#addSchemaButton').classList.toggle('hidden', !fieldsMode);
  $('#schemaModeHint').textContent = fieldsMode
    ? '定义当前场景的固定字段与更新策略'
    : '定义一轮结束后哪些内容进入事件图谱';
  if (!fieldsMode) {
    renderEventExtractionSettings();
    return;
  }
  $('#schemaSummary').innerHTML = [
    ['生效字段', effective.length],
    ['场景专属', effective.filter((item) => item.scenario_type === scene.scenario_type).length],
    ['共享基线', effective.filter((item) => item.scenario_type === 'all').length],
    ['每轮注入', effective.filter((item) => item.pinned).length]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('#schemaTable').innerHTML = filtered.length ? `
    <table class="data-table schema-table"><thead><tr><th style="width:28%">字段</th><th style="width:13%">分类</th><th style="width:13%">归属</th><th style="width:15%">类型 / 作用域</th><th style="width:15%">更新策略</th><th style="width:9%">注入</th><th style="width:7%;text-align:right">操作</th></tr></thead>
      <tbody>${filtered.map((item) => `<tr>
        <td><span class="cell-main">${escapeHtml(item.label)}</span><code>${escapeHtml(item.key)}</code><span class="cell-sub schema-description">${escapeHtml(item.description || '暂无说明')}</span></td>
        <td>${escapeHtml(item.category)}</td><td><span class="badge ${item.scenario_type === 'all' ? '' : 'blue'}">${item.scenario_type === 'all' ? '共享基线' : '当前场景'}</span></td>
        <td><span class="cell-main">${escapeHtml(item.value_type)}</span><span class="cell-sub">${escapeHtml(item.scope)}</span></td>
        <td><code>${escapeHtml(item.extraction_mode)}</code></td><td>${item.pinned ? '<span class="badge blue">每轮</span>' : '<span class="badge">按需</span>'}</td>
        <td><div class="row-actions"><button class="icon-button edit-schema" data-id="${item.id}" title="编辑"><i data-lucide="pencil"></i></button></div></td>
      </tr>`).join('')}</tbody></table>` : emptyState('list-filter', '没有匹配的字段');
  $$('.edit-schema').forEach((button) => button.addEventListener('click', () => editSchema(button.dataset.id)));
  refreshIcons();
}

function renderEventExtractionSettings() {
  const profile = state.eventExtractionProfile;
  if (!profile) {
    $('#schemaSummary').innerHTML = '';
    $('#schemaTable').innerHTML = emptyState('scan-text', '当前场景尚无事件抽取配置');
    refreshIcons();
    return;
  }
  $('#schemaSummary').innerHTML = [
    ['状态', profile.enabled ? '已启用' : '已停用'],
    ['执行方式', '同步阻塞'],
    ['消歧上下文', `${profile.context_turns} 轮`],
    ['单轮上限', `${profile.max_events_per_turn} 事件`]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');

  const configuredTypes = profile.allowed_event_types || [];
  const knownTypes = new Set(eventTypeOptions.map(([value]) => value));
  const options = [...eventTypeOptions, ...configuredTypes.filter((value) => !knownTypes.has(value)).map((value) => [value, value])];
  $('#schemaTable').innerHTML = `<section class="extraction-settings">
    <div class="extraction-runtime-contract">
      <div><span>A</span><i data-lucide="message-square"></i><strong>assistant 消息落库</strong><small>语义轮结束，立即触发抽取</small></div>
      <i data-lucide="arrow-right"></i>
      <div class="active"><span>BLOCKING</span><i data-lucide="scan-text"></i><strong>抽取与事件对齐</strong><small>仍在同一 /api/chat 请求</small></div>
      <i data-lucide="arrow-right"></i>
      <div><span>B</span><i data-lucide="database"></i><strong>提交后返回</strong><small>触发器完成，下一轮解锁</small></div>
    </div>
    <form id="eventExtractionForm" class="extraction-form">
      <section class="extraction-form-section">
        <header><span>01</span><div><strong>运行契约</strong><small>场景内所有角色共用</small></div></header>
        <div class="form-grid two">
          <label><span>配置名称</span><input name="name" value="${escapeHtml(profile.name)}" required></label>
          <label><span>执行模式</span><input value="blocking_after_assistant" disabled></label>
        </div>
        <div class="extraction-switches">
          <label class="strategy-toggle"><span><strong>启用轮后抽取</strong><small>关闭后仅保留用户显式控制快通道</small></span><span class="toggle-control"><input name="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>注入助手回复</strong><small>只用于消歧，不作为用户事实证据</small></span><span class="toggle-control"><input name="include_assistant" type="checkbox" ${profile.include_assistant ? 'checked' : ''}><i></i></span></label>
        </div>
      </section>
      <section class="extraction-form-section">
        <header><span>02</span><div><strong>候选范围</strong><small>控制模型能看到的上下文与单轮写入量</small></div></header>
        <div class="form-grid three">
          <label><span>消歧上下文（轮）</span><input name="context_turns" type="number" min="1" max="10" step="1" value="${profile.context_turns}" required></label>
          <label><span>单轮最大事件数</span><input name="max_events_per_turn" type="number" min="1" max="10" step="1" value="${profile.max_events_per_turn}" required></label>
          <label><span>新建事件最低重要度</span><input name="min_importance" type="number" min="0" max="1" step="0.05" value="${profile.min_importance}" required></label>
        </div>
        <div class="event-type-field"><span>允许的事件类型</span><div class="event-type-options">${options.map(([value, label]) => `<label><input type="checkbox" name="allowed_event_types" value="${escapeHtml(value)}" ${configuredTypes.includes(value) ? 'checked' : ''}><span><code>${escapeHtml(value)}</code>${escapeHtml(label)}</span></label>`).join('')}</div></div>
      </section>
      <section class="extraction-form-section">
        <header><span>03</span><div><strong>更新判定</strong><small>把“又记一条”改为对原事件槽位的更新</small></div></header>
        <label><span>事件更新信号（换行或逗号分隔）</span><textarea name="update_signals" rows="3">${escapeHtml((profile.update_signals || []).join('\n'))}</textarea></label>
        <label><span>场景附加抽取规则</span><textarea name="custom_rules" rows="5">${escapeHtml(profile.custom_rules || '')}</textarea></label>
      </section>
      <section class="extraction-form-section guard-section">
        <header><span>04</span><div><strong>系统硬保护</strong><small>管理员配置不能覆盖</small></div></header>
        <div class="extraction-guards">
          <span><i data-lucide="shield-check"></i><strong>只写当轮新增或更正</strong><small>历史上下文只消歧</small></span>
          <span><i data-lucide="shield-check"></i><strong>旧值保留为 superseded</strong><small>active 是默认回答视图</small></span>
          <span><i data-lucide="shield-check"></i><strong>助手情节不等于用户事实</strong><small>必须有用户承接证据</small></span>
          <span><i data-lucide="shield-check"></i><strong>作用域硬隔离</strong><small>user / agent / story / branch</small></span>
        </div>
      </section>
      <footer class="extraction-form-actions"><span><i data-lucide="info"></i>配置将参与下一轮抽取 Prompt 和服务端过滤。</span><button class="button primary" type="submit"><i data-lucide="save"></i>保存事件抽取</button></footer>
    </form>
  </section>`;
  $('#eventExtractionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const updateSignals = String(formData.get('update_signals') || '').split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
    state.eventExtractionProfile = await api(`/api/scenes/${encodeURIComponent(state.currentSceneId)}/event-extraction-profile`, {
      method: 'PUT',
      body: {
        name: formData.get('name'),
        enabled: formData.has('enabled'),
        include_assistant: formData.has('include_assistant'),
        context_turns: Number(formData.get('context_turns')),
        max_events_per_turn: Number(formData.get('max_events_per_turn')),
        min_importance: Number(formData.get('min_importance')),
        allowed_event_types: formData.getAll('allowed_event_types'),
        update_signals: updateSignals,
        custom_rules: formData.get('custom_rules')
      }
    });
    toast('事件抽取配置已生效');
    renderSchemas();
  });
  refreshIcons();
}

function editMemoryProfile() {
  const scene = currentScene();
  if (!scene) return;
  openModal({
    title: `配置说明 · ${scene.name}`,
    body: `<label><span>记忆设置名称</span><input name="name" value="${escapeHtml(scene.memory_profile_name)}" required></label>
      <label><span>配置说明</span><textarea name="description" rows="4">${escapeHtml(scene.memory_profile_description)}</textarea></label>
      <span class="hint">该配置与「${escapeHtml(scene.name)}」一对一绑定，场景内所有角色使用同一套字段定义。</span>`,
    onSubmit: async (formData) => {
      await api(`/api/scenes/${encodeURIComponent(scene.id)}/memory-profile`, {
        method: 'PUT', body: Object.fromEntries(formData.entries())
      });
      await loadSchemas();
      toast('记忆设置说明已更新');
    }
  });
}

async function editRetrievalProfile() {
  const scene = currentScene();
  if (!scene) return;
  const profile = await api(`/api/scenes/${encodeURIComponent(scene.id)}/retrieval-profile`);
  openModal({
    title: `召回策略 · ${scene.name}`,
    width: 760,
    body: `<div class="strategy-modal">
      <section class="strategy-modal-section">
        <div class="strategy-section-title"><span>01</span><div><strong>策略与通道</strong><small>${escapeHtml(scene.name)} 场景内所有角色共用</small></div></div>
        <label><span>策略名称</span><input name="name" value="${escapeHtml(profile.name)}" required></label>
        <div class="strategy-toggle-grid">
          <label class="strategy-toggle"><span><strong>向量召回</strong><small>Embedding + cosine similarity</small></span><span class="toggle-control"><input name="vector_enabled" type="checkbox" ${profile.vector_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>关键词召回</strong><small>文本重叠候选</small></span><span class="toggle-control"><input name="keyword_enabled" type="checkbox" ${profile.keyword_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>图谱扩展</strong><small>Claims + entity edges</small></span><span class="toggle-control"><input name="graph_enabled" type="checkbox" ${profile.graph_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>意图硬过滤</strong><small>事件类型与 collection</small></span><span class="toggle-control"><input name="intent_filter_enabled" type="checkbox" ${profile.intent_filter_enabled ? 'checked' : ''}><i></i></span></label>
        </div>
        <div class="strategy-locked-guard"><i data-lucide="lock-keyhole"></i><div><strong>Active Only</strong><span>superseded / retracted 永不进入回答候选</span></div><span class="badge blue">强制开启</span></div>
      </section>
      <section class="strategy-modal-section">
        <div class="strategy-section-title"><span>02</span><div><strong>阈值与 TopK</strong><small>候选进入与最终截断</small></div></div>
        <div class="form-grid strategy-number-grid">
          <label><span>向量相似度阈值</span><input name="min_similarity" type="number" min="0" max="1" step="0.01" value="${profile.min_similarity}" required></label>
          <label><span>关键词阈值</span><input name="min_keyword_score" type="number" min="0" max="1" step="0.01" value="${profile.min_keyword_score}" required></label>
          <label><span>事件 TopK</span><input name="event_top_k" type="number" min="1" max="50" step="1" value="${profile.event_top_k}" required></label>
          <label><span>声明 TopK</span><input name="claim_top_k" type="number" min="1" max="100" step="1" value="${profile.claim_top_k}" required></label>
          <label><span>关系边 TopK</span><input name="edge_top_k" type="number" min="1" max="100" step="1" value="${profile.edge_top_k}" required></label>
          <label><span>时效半衰期（天）</span><input name="recency_half_life_days" type="number" min="1" max="3650" step="1" value="${profile.recency_half_life_days}" required></label>
        </div>
      </section>
      <section class="strategy-modal-section">
        <div class="strategy-section-title"><span>03</span><div><strong>排序权重</strong><small>final score 组成</small></div></div>
        <div class="form-grid strategy-weight-grid">
          <label><span>向量权重</span><input name="vector_weight" type="number" min="0" max="2" step="0.01" value="${profile.vector_weight}" required></label>
          <label><span>关键词权重</span><input name="keyword_weight" type="number" min="0" max="2" step="0.01" value="${profile.keyword_weight}" required></label>
          <label><span>重要度权重</span><input name="importance_weight" type="number" min="0" max="2" step="0.01" value="${profile.importance_weight}" required></label>
          <label><span>时效性权重</span><input name="recency_weight" type="number" min="0" max="2" step="0.01" value="${profile.recency_weight}" required></label>
        </div>
        <code class="strategy-formula">score = vector × w1 + keyword × w2 + importance × w3 + recency × w4</code>
      </section>
    </div>`,
    submitLabel: '保存策略',
    onSubmit: async (formData) => {
      const body = Object.fromEntries(formData.entries());
      Object.assign(body, {
        vector_enabled: formData.has('vector_enabled'),
        keyword_enabled: formData.has('keyword_enabled'),
        graph_enabled: formData.has('graph_enabled'),
        intent_filter_enabled: formData.has('intent_filter_enabled')
      });
      state.retrievalProfile = await api(`/api/scenes/${encodeURIComponent(scene.id)}/retrieval-profile`, {
        method: 'PUT', body
      });
      state.retrievalTest = null;
      await loadSchemas();
      toast('召回策略已更新');
    }
  });
}

function editSchema(id = '') {
  const scene = currentScene();
  const item = state.schemas.find((schema) => schema.id === id) || {
    key: '', label: '', category: '自定义', scenario_type: scene?.scenario_type || 'all', value_type: 'string', scope: 'user_agent',
    description: '', default: null, constraints: {}, prompt_template: '', pinned: 0, required: 0,
    extraction_mode: 'explicit_only', sensitivity: 'normal', enabled: 1
  };
  openModal({
    title: id ? '编辑记忆字段' : `新建记忆字段 · ${scene?.name || ''}`, width: 680,
    body: `
      <div class="form-grid two"><label><span>Key</span><input name="key" value="${escapeHtml(item.key)}" placeholder="profile.favorite_topic" required></label><label><span>显示名称</span><input name="label" value="${escapeHtml(item.label)}" required></label></div>
      <div class="form-grid two"><label><span>分类</span><input name="category" value="${escapeHtml(item.category)}" required></label><label><span>字段归属</span><select name="scenario_type"><option value="${escapeHtml(scene?.scenario_type || 'all')}" ${item.scenario_type === scene?.scenario_type ? 'selected' : ''}>当前场景 · ${escapeHtml(scene?.name || '')}</option><option value="all" ${item.scenario_type === 'all' ? 'selected' : ''}>所有场景 · 共享基线</option></select></label></div>
      <div class="form-grid two"><label><span>值类型</span><select name="value_type">${['string','number','boolean','enum','string_list','object'].map((value) => `<option ${item.value_type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label><span>作用域</span><select name="scope">${['user','user_agent','user_agent_story','user_agent_story_branch'].map((value) => `<option ${item.scope === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
      <label><span>字段说明</span><textarea name="description" rows="2">${escapeHtml(item.description)}</textarea></label>
      <div class="form-grid two"><label><span>默认值 JSON</span><textarea name="default_value" rows="4">${escapeHtml(JSON.stringify(item.default, null, 2))}</textarea></label><label><span>约束 JSON</span><textarea name="constraints" rows="4">${escapeHtml(JSON.stringify(item.constraints || {}, null, 2))}</textarea></label></div>
      <label><span>Prompt 注入模板</span><input name="prompt_template" value="${escapeHtml(item.prompt_template)}" placeholder="用户偏好：{{value}}。"></label>
      <div class="form-grid two"><label><span>抽取策略</span><select name="extraction_mode">${['explicit_only','evidence_required','computed','derived','manual'].map((value) => `<option ${item.extraction_mode === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label><span>敏感级别</span><select name="sensitivity">${['normal','personal','instruction','sensitive'].map((value) => `<option ${item.sensitivity === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
      <div class="form-grid two"><label class="checkbox-row"><input name="pinned" type="checkbox" ${item.pinned ? 'checked' : ''}><span>每轮常驻注入</span></label><label class="checkbox-row"><input name="required" type="checkbox" ${item.required ? 'checked' : ''}><span>必填字段</span></label></div>`,
    onSubmit: async (formData) => {
      let defaultValue;
      let constraints;
      try {
        defaultValue = JSON.parse(formData.get('default_value') || 'null');
        constraints = JSON.parse(formData.get('constraints') || '{}');
      } catch { throw new Error('默认值和约束必须是合法 JSON'); }
      const body = Object.fromEntries(formData.entries());
      Object.assign(body, { default_value: defaultValue, constraints, pinned: formData.has('pinned'), required: formData.has('required'), enabled: true });
      await api(id ? `/api/memory/schemas/${id}` : '/api/memory/schemas', { method: id ? 'PUT' : 'POST', body });
      await loadSchemas();
      toast(id ? '记忆字段已更新' : '记忆字段已创建');
    }
  });
}

async function loadPersona() {
  state.bootstrap.agents = await api('/api/agents');
  renderSelectors();
  renderPersonaAgentList();
  const agent = currentAgent();
  if (!agent) return;
  const scene = sceneForAgent(agent);
  $('#personaScene').innerHTML = state.bootstrap.scenes.map((item) =>
    `<option value="${escapeHtml(item.id)}" ${item.id === scene?.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
  ).join('');
  $('#personaName').value = agent.name;
  $('#personaDescription').value = agent.description;
  $('#personaGreeting').value = agent.greeting;
  $('#personaPrompt').value = agent.system_prompt;
  $('#personaScenario').textContent = scene?.name || scenarioLabel(agent.scenario_type);
  $('#personaHeaderName').textContent = agent.name;
  $('#personaHeaderMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · 专属人设与剧情配置`;
  $('#personaAvatar').textContent = agent.name.slice(0, 1);
  $('#personaAvatar').style.background = agent.avatar_color;
  $('#pageMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · ${agent.name}专属配置`;
  state.plots = await api(`/api/plots?agent_id=${encodeURIComponent(state.currentAgentId)}`);
  renderPlots();
}

function renderPersonaAgentList() {
  const scenes = state.bootstrap.scenes || [];
  $('#personaAgentList').innerHTML = scenes.map((scene) => {
    const agents = state.bootstrap.agents.filter((agent) => agent.scene_id === scene.id && agent.enabled);
    if (!agents.length) return '';
    return `<div class="object-list-group"><span>${escapeHtml(scene.name)}</span>${agents.map((agent) => `
      <button class="object-list-item ${agent.id === state.currentAgentId ? 'active' : ''}" data-persona-agent="${escapeHtml(agent.id)}">
        <span class="list-avatar" style="background:${escapeHtml(agent.avatar_color)}">${escapeHtml(agent.name.slice(0, 1))}</span>
        <span class="object-list-copy"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.description)}</small></span>
        <i data-lucide="chevron-right"></i>
      </button>`).join('')}</div>`;
  }).join('');
  $$('[data-persona-agent]').forEach((button) => button.addEventListener('click', async () => {
    if (button.dataset.personaAgent === state.currentAgentId) return;
    state.currentAgentId = button.dataset.personaAgent;
    await switchContext();
  }));
  refreshIcons();
}

function renderPlots() {
  $('#plotCount').textContent = `${state.plots.length} 条`;
  $('#plotList').innerHTML = state.plots.length ? state.plots.map((plot) => `
    <article class="plot-item"><div class="plot-item-head"><div><span class="plot-index">${String(state.plots.indexOf(plot) + 1).padStart(2, '0')}</span><strong>${escapeHtml(plot.name)}</strong></div><button class="icon-button bordered edit-plot" data-id="${plot.id}" title="编辑剧情" aria-label="编辑${escapeHtml(plot.name)}"><i data-lucide="pencil"></i></button></div>
      <p>${escapeHtml(plot.premise)}</p><div class="plot-instruction">${escapeHtml(plot.instructions)}</div><div class="plot-item-meta"><span class="badge ${plot.enabled ? 'blue' : 'red'}">${plot.enabled ? '已启用' : '已停用'}</span><span class="badge">优先级 ${plot.priority}</span></div></article>`).join('') : emptyState('book-open', '尚无剧情');
  $$('.edit-plot').forEach((button) => button.addEventListener('click', () => editPlot(button.dataset.id)));
  refreshIcons();
}

function editPlot(id = '') {
  const plot = state.plots.find((item) => item.id === id) || { name: '', premise: '', instructions: '', priority: 50, enabled: 1 };
  openModal({
    title: id ? '编辑剧情' : '新建剧情',
    body: `<label><span>剧情名称</span><input name="name" value="${escapeHtml(plot.name)}" required></label><label><span>剧情前提</span><textarea name="premise" rows="3">${escapeHtml(plot.premise)}</textarea></label><label><span>注入指令</span><textarea name="instructions" rows="7" required>${escapeHtml(plot.instructions)}</textarea></label><div class="form-grid two"><label><span>优先级</span><input name="priority" type="number" value="${plot.priority}" min="0" max="100"></label><label class="checkbox-row"><input name="enabled" type="checkbox" ${plot.enabled ? 'checked' : ''}><span>启用</span></label></div>`,
    onSubmit: async (formData) => {
      const body = { ...Object.fromEntries(formData.entries()), agent_id: state.currentAgentId, enabled: formData.has('enabled'), priority: Number(formData.get('priority')) };
      await api(id ? `/api/plots/${id}` : '/api/plots', { method: id ? 'PUT' : 'POST', body });
      state.plots = await api(`/api/plots?agent_id=${encodeURIComponent(state.currentAgentId)}`);
      renderPlots();
      toast('剧情已保存');
    }
  });
}

async function loadAutomation() {
  state.triggers = await api(`/api/triggers?agent_id=${encodeURIComponent(state.currentAgentId)}`);
  state.tools = await api('/api/tools');
  renderAutomation();
}

function renderAutomation() {
  $('#addTriggerButton').classList.toggle('hidden', state.automationTab !== 'triggers');
  if (state.automationTab === 'tools') {
    $('#automationContent').innerHTML = `
      <table class="data-table"><thead><tr><th style="width:24%">工具</th><th style="width:38%">用途</th><th style="width:15%">执行器</th><th style="width:14%">状态</th><th style="width:9%">入参</th></tr></thead><tbody>${state.tools.map((tool) => `
        <tr><td><span class="cell-main">${escapeHtml(tool.name)}</span><code>${escapeHtml(tool.key)}</code></td><td>${escapeHtml(tool.description)}</td><td><span class="badge">${escapeHtml(tool.handler_type)}</span></td><td><span class="badge ${tool.enabled ? 'blue' : 'red'}">${tool.enabled ? '启用' : '停用'}</span></td><td>${Object.keys(tool.input_schema?.properties || {}).length}</td></tr>`).join('')}</tbody></table>`;
  } else {
    $('#automationContent').innerHTML = state.triggers.length ? `
      <table class="data-table"><thead><tr><th style="width:23%">触发器</th><th style="width:27%">条件</th><th style="width:25%">动作</th><th style="width:10%">策略</th><th style="width:8%">状态</th><th style="width:7%;text-align:right">操作</th></tr></thead><tbody>${state.triggers.map((trigger) => `
        <tr><td><span class="cell-main">${escapeHtml(trigger.name)}</span><span class="cell-sub">${escapeHtml(trigger.description)}</span></td><td><code class="trigger-condition">${escapeHtml(JSON.stringify(trigger.condition))}</code></td><td class="value-cell">${escapeHtml((trigger.actions || []).map((action) => action.type).join(' · '))}</td><td><span class="badge">${trigger.once_per_user ? '单次' : `${trigger.cooldown_seconds}s`}</span></td><td><span class="badge ${trigger.enabled ? 'blue' : 'red'}">${trigger.enabled ? '启用' : '停用'}</span></td><td><div class="row-actions"><button class="icon-button edit-trigger" data-id="${trigger.id}" title="编辑"><i data-lucide="pencil"></i></button></div></td></tr>`).join('')}</tbody></table>` : emptyState('workflow', '尚无触发器');
    $$('.edit-trigger').forEach((button) => button.addEventListener('click', () => editTrigger(button.dataset.id)));
  }
  refreshIcons();
}

function editTrigger(id = '') {
  const trigger = state.triggers.find((item) => item.id === id) || {
    name: '', description: '', condition: { all: [{ memory_key: 'relationship.intimacy', operator: '>=', value: 30 }] },
    actions: [{ type: 'unlock_plot', plot_id: state.plots[0]?.id || 'plot_rain_letter' }], once_per_user: 1,
    cooldown_seconds: 0, priority: 50, enabled: 1
  };
  openModal({
    title: id ? '编辑触发器' : '新建触发器', width: 680,
    body: `<div class="form-grid two"><label><span>名称</span><input name="name" value="${escapeHtml(trigger.name)}" required></label><label><span>优先级</span><input name="priority" type="number" min="0" max="100" value="${trigger.priority}"></label></div><label><span>说明</span><input name="description" value="${escapeHtml(trigger.description)}"></label><label><span>条件 JSON</span><textarea name="condition" rows="7" required>${escapeHtml(JSON.stringify(trigger.condition, null, 2))}</textarea></label><label><span>动作 JSON</span><textarea name="actions" rows="8" required>${escapeHtml(JSON.stringify(trigger.actions, null, 2))}</textarea></label><div class="form-grid two"><label class="checkbox-row"><input name="once_per_user" type="checkbox" ${trigger.once_per_user ? 'checked' : ''}><span>每个用户仅触发一次</span></label><label class="checkbox-row"><input name="enabled" type="checkbox" ${trigger.enabled ? 'checked' : ''}><span>启用</span></label></div>`,
    onSubmit: async (formData) => {
      let condition;
      let actions;
      try { condition = JSON.parse(formData.get('condition')); actions = JSON.parse(formData.get('actions')); } catch { throw new Error('条件和动作必须是合法 JSON'); }
      const body = { ...Object.fromEntries(formData.entries()), agent_id: state.currentAgentId, condition, actions, once_per_user: formData.has('once_per_user'), enabled: formData.has('enabled'), priority: Number(formData.get('priority')) };
      await api(id ? `/api/triggers/${id}` : '/api/triggers', { method: id ? 'PUT' : 'POST', body });
      await loadAutomation();
      toast('触发器已保存');
    }
  });
}

function scrollArchitectureAssistant() {
  const root = $('#architectureAssistantMessages');
  root.scrollTop = root.scrollHeight;
}

function showArchitectureSource(sourceId) {
  const source = state.architectureSources.get(sourceId);
  if (!source) return;
  openModal({
    title: `证据 ${source.evidence} · ${source.title}`,
    width: 820,
    submitLabel: '关闭',
    showCancel: false,
    body: `<div class="architecture-source-meta"><code>${escapeHtml(source.sourcePath)}:L${source.startLine}-L${source.endLine}</code><span>综合 ${source.score} · 向量 ${source.vectorScore} · 关键词 ${source.keywordScore}</span></div><pre class="code-block architecture-source-preview">${escapeHtml(source.excerpt)}</pre>`,
    onSubmit: async () => {}
  });
}

function appendArchitectureQuestion(question) {
  $('#architectureAssistantMessages').insertAdjacentHTML('beforeend', `
    <article class="architecture-answer user">
      <div class="architecture-answer-role"><span>管理员</span><i data-lucide="user-round"></i></div>
      <div class="architecture-answer-content">${escapeHtml(question)}</div>
    </article>`);
}

function renderArchitectureText(value) {
  const blocks = escapeHtml(value).split('```');
  return blocks.map((block, index) => {
    if (index % 2 === 1) {
      const code = block.replace(/^[a-z0-9_+-]+\n/i, '').trim();
      return `<pre class="architecture-answer-code"><code>${code}</code></pre>`;
    }
    return block
      .replace(/^#{1,4}\s+(.+)$/gm, '<strong class="architecture-answer-heading">$1</strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }).join('');
}

function appendArchitectureAnswer(result) {
  const sourceButtons = (result.sources || []).map((source) => {
    state.architectureSources.set(source.id, source);
    return `<button type="button" class="architecture-source-button" data-architecture-source="${escapeHtml(source.id)}" title="查看召回代码片段"><i data-lucide="file-code-2"></i><span>[证据${source.evidence}] ${escapeHtml(source.sourcePath)} · L${source.startLine}-${source.endLine}</span></button>`;
  }).join('');
  const meta = result.restricted
    ? '范围限制 · 未调用文本模型'
    : `${escapeHtml(result.model || 'configured model')} · ${Number(result.durationMs || 0)} ms · ${(result.sources || []).length} 个代码证据`;
  $('#architectureAssistantMessages').insertAdjacentHTML('beforeend', `
    <article class="architecture-answer assistant">
      <div class="architecture-answer-role"><i data-lucide="bot"></i><span>架构助手</span></div>
      <div class="architecture-answer-content">${renderArchitectureText(result.answer)}</div>
      <div class="architecture-answer-meta">${meta}</div>
      ${sourceButtons ? `<div class="architecture-answer-sources">${sourceButtons}</div>` : ''}
    </article>`);
  $$('[data-architecture-source]', $('#architectureAssistantMessages')).forEach((button) => {
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', () => showArchitectureSource(button.dataset.architectureSource));
  });
}

async function openArchitectureAssistant() {
  $('#traceDrawer').classList.remove('open');
  const drawer = $('#architectureAssistant');
  drawer.inert = false;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  try {
    await loadArchitectureOverview();
  } catch (error) {
    toast(error.message, 'error');
  }
  refreshIcons();
  setTimeout(() => $('#architectureQuestion').focus(), 120);
}

function closeArchitectureAssistant() {
  const drawer = $('#architectureAssistant');
  drawer.classList.remove('open');
  drawer.inert = true;
  drawer.setAttribute('aria-hidden', 'true');
}

async function askArchitectureQuestion(rawQuestion) {
  const question = String(rawQuestion || '').trim();
  if (!question || state.architectureAsking) return;
  state.architectureAsking = true;
  $('#architectureQuestion').value = '';
  $('#askArchitectureButton').disabled = true;
  $$('[data-architecture-question]').forEach((button) => { button.disabled = true; });
  appendArchitectureQuestion(question);
  const loadingId = `architectureLoading${Date.now()}`;
  $('#architectureAssistantMessages').insertAdjacentHTML('beforeend', `
    <article id="${loadingId}" class="architecture-answer assistant loading">
      <div class="architecture-answer-role"><i data-lucide="bot"></i><span>架构助手</span></div>
      <div class="architecture-answer-content"><i data-lucide="loader-circle"></i><span>正在检索代码切片并核对证据…</span></div>
    </article>`);
  refreshIcons();
  scrollArchitectureAssistant();
  try {
    const result = await api('/api/architecture/ask', { method: 'POST', body: { question } });
    $(`#${loadingId}`)?.remove();
    appendArchitectureAnswer(result);
    renderArchitectureIndex(result.index);
  } catch (error) {
    $(`#${loadingId}`)?.remove();
    appendArchitectureAnswer({ answer: `请求失败：${error.message}`, restricted: true, sources: [] });
  } finally {
    state.architectureAsking = false;
    $('#askArchitectureButton').disabled = false;
    $$('[data-architecture-question]').forEach((button) => { button.disabled = false; });
    refreshIcons();
    scrollArchitectureAssistant();
    $('#architectureQuestion').focus();
  }
}

async function openTraceDrawer() {
  closeArchitectureAssistant();
  $('#traceDrawer').classList.add('open');
  await loadTraces();
  refreshIcons();
}

async function loadTraces() {
  if (!state.currentConversationId) {
    $('#traceList').innerHTML = emptyState('scan-search', '当前无对话');
    return;
  }
  const traces = await api(`/api/traces?conversation_id=${encodeURIComponent(state.currentConversationId)}`);
  $('#traceDrawerMeta').textContent = `${traces.length} 次调度`;
  $('#traceList').innerHTML = traces.length ? traces.map((trace, index) => `
    <button class="trace-item ${index === 0 ? 'active' : ''}" data-trace-id="${trace.id}"><strong><span>${escapeHtml(trace.id.slice(-8))}</span><span class="badge ${trace.status === 'success' ? 'blue' : 'red'}">${escapeHtml(trace.status)}</span></strong><span>${formatDate(trace.started_at)} · ${trace.total_ms}ms</span></button>`).join('') : emptyState('scan-search', '尚无 Trace');
  $$('[data-trace-id]').forEach((button) => button.addEventListener('click', () => loadTraceDetail(button.dataset.traceId)));
  if (traces[0]) await loadTraceDetail(traces[0].id);
}

async function loadTraceDetail(id) {
  $$('[data-trace-id]').forEach((button) => button.classList.toggle('active', button.dataset.traceId === id));
  const trace = await api(`/api/traces/${encodeURIComponent(id)}`);
  $('#traceDetail').innerHTML = `
    <div class="trace-overview"><div><span>状态</span><strong>${escapeHtml(trace.status)}</strong></div><div><span>总耗时</span><strong>${trace.total_ms} ms</strong></div><div><span>Spans</span><strong>${trace.spans.length}</strong></div></div>
    ${trace.spans.map((span, index) => {
      const input = parseJson(span.input_json, {});
      const output = parseJson(span.output_json, {});
      return `<details class="span-item" ${['prompt_compilation','model_response'].includes(span.name) ? 'open' : ''}><summary><span class="span-status ${span.status === 'error' ? 'error' : ''}"></span><span>${index + 1}. ${escapeHtml(span.name)}</span><time>${span.duration_ms} ms</time></summary><div class="span-body"><span class="code-label">Input</span><pre class="code-block">${escapeHtml(JSON.stringify(input, null, 2))}</pre><span class="code-label">Output</span><pre class="code-block">${escapeHtml(JSON.stringify(output, null, 2))}</pre></div></details>`;
    }).join('')}`;
}

function addUser() {
  openModal({
    title: '新增用户',
    body: `<label><span>用户名</span><input name="name" required autofocus></label><label><span>显示名称</span><input name="display_name" placeholder="与用户名相同可留空"></label><label><span>标识色</span><input name="avatar_color" type="color" value="#2563eb"></label>`,
    submitLabel: '创建',
    onSubmit: async (formData) => {
      const user = await api('/api/users', { method: 'POST', body: Object.fromEntries(formData.entries()) });
      await loadBootstrap();
      state.currentUserId = user.id;
      await switchContext();
      toast('用户已创建');
    }
  });
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#adminPassword').value } });
    $('#adminPassword').value = '';
    await loadBootstrap();
    showApp();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
$('#userSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#agentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#memoryUserSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#memoryAgentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#addUserButton').addEventListener('click', addUser);
$('#newConversationButton').addEventListener('click', () => { state.currentConversationId = ''; renderConversations(); renderWelcome(); $('#messageInput').focus(); });
$('#composerForm').addEventListener('submit', (event) => { event.preventDefault(); sendMessage($('#messageInput').value); });
$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composerForm').requestSubmit(); }
});
$('#messageInput').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
});
$('#openTraceButton').addEventListener('click', () => openTraceDrawer().catch((error) => toast(error.message, 'error')));
$('#closeTraceButton').addEventListener('click', () => $('#traceDrawer').classList.remove('open'));
$$('[data-open-architecture-assistant]').forEach((button) => button.addEventListener('click', () => openArchitectureAssistant()));
$('#closeArchitectureAssistant').addEventListener('click', closeArchitectureAssistant);
$('#architectureAssistantForm').addEventListener('submit', (event) => {
  event.preventDefault();
  askArchitectureQuestion($('#architectureQuestion').value);
});
$('#architectureQuestion').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#architectureAssistantForm').requestSubmit();
  }
});
$('#architectureQuestion').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 110)}px`;
});
$$('[data-architecture-question]').forEach((button) => button.addEventListener('click', () => {
  askArchitectureQuestion(button.dataset.architectureQuestion);
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#architectureAssistant').classList.contains('open')) closeArchitectureAssistant();
});
$('#modelHealth').addEventListener('click', async () => {
  const button = $('#modelHealth');
  button.disabled = true;
  try {
    const result = await api('/api/admin/health/ark', { method: 'POST' });
    button.classList.toggle('error', result.embeddingFallback);
    $('span:last-child', button).textContent = result.embeddingFallback ? '本地向量降级' : `${result.embeddingDimensions} 维向量`;
    toast(result.embeddingFallback ? result.fallbackReason : 'Ark Embedding 连接正常', result.embeddingFallback ? 'error' : 'success');
  } catch (error) { button.classList.add('error'); toast(error.message, 'error'); }
  finally { button.disabled = false; }
});

$$('[data-memory-tab]').forEach((button) => button.addEventListener('click', async () => {
  state.memoryTab = button.dataset.memoryTab;
  $$('[data-memory-tab]').forEach((item) => item.classList.toggle('active', item === button));
  await loadMemory();
  refreshIcons();
}));
$('#memorySearch').addEventListener('input', () => { if (state.memoryTab === 'values') renderMemoryValues(); });
$('#memoryCategoryFilter').addEventListener('change', renderMemoryValues);
$('#schemaSearch').addEventListener('input', renderSchemas);
$('#schemaCategoryFilter').addEventListener('change', renderSchemas);
$$('[data-schema-tab]').forEach((button) => button.addEventListener('click', () => {
  state.schemaTab = button.dataset.schemaTab;
  renderSchemas();
}));
$('#addSchemaButton').addEventListener('click', () => editSchema());
$('#editMemoryProfileButton').addEventListener('click', editMemoryProfile);
$('#editRetrievalProfileButton').addEventListener('click', () => editRetrievalProfile().catch((error) => toast(error.message, 'error')));
$('#personaForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await api(`/api/agents/${encodeURIComponent(state.currentAgentId)}`, {
    method: 'PUT',
    body: {
      name: $('#personaName').value,
      scene_id: $('#personaScene').value,
      description: $('#personaDescription').value,
      greeting: $('#personaGreeting').value,
      system_prompt: $('#personaPrompt').value
    }
  });
  await loadBootstrap();
  navigate('persona');
  toast('角色人设已保存');
});
$('#personaScene').addEventListener('change', (event) => {
  const scene = state.bootstrap.scenes.find((item) => item.id === event.target.value);
  $('#personaScenario').textContent = scene?.name || '-';
  $('#personaHeaderMeta').textContent = `${scene?.name || '-'} · 保存后更新角色归属`;
});
$('#addPlotButton').addEventListener('click', () => editPlot());
$$('[data-automation-tab]').forEach((button) => button.addEventListener('click', () => {
  state.automationTab = button.dataset.automationTab;
  $$('[data-automation-tab]').forEach((item) => item.classList.toggle('active', item === button));
  renderAutomation();
}));
$$('[data-timeline-view]').forEach((button) => button.addEventListener('click', () => {
  state.timelineView = button.dataset.timelineView;
  $('#timelineCanvas').dataset.focus = state.timelineView;
  $$('[data-timeline-view]').forEach((item) => {
    const active = item === button;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  });
}));
$$('[data-config-link]').forEach((link) => link.addEventListener('click', async (event) => {
  event.preventDefault();
  const page = link.dataset.jumpPage;
  const tab = link.dataset.jumpTab;
  const schemaTab = link.dataset.jumpSchemaTab;
  if (page === 'memory' && tab) {
    state.memoryTab = tab;
    $$('[data-memory-tab]').forEach((item) => item.classList.toggle('active', item.dataset.memoryTab === tab));
  }
  if (page === 'automation' && tab) {
    state.automationTab = tab;
    $$('[data-automation-tab]').forEach((item) => item.classList.toggle('active', item.dataset.automationTab === tab));
  }
  if (page === 'schemas' && schemaTab) state.schemaTab = schemaTab;
  await navigate(page);
  const target = $(link.dataset.jumpTarget);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('source-highlight');
    setTimeout(() => target.classList.remove('source-highlight'), 5000);
  }
  history.replaceState(null, '', link.getAttribute('href'));
}));
$('#addTriggerButton').addEventListener('click', () => editTrigger());

initialize().then(refreshIcons).catch((error) => {
  showLogin();
  $('#loginError').textContent = error.message;
});
