const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const appBasePath = $('meta[name="app-base-path"]')?.content || '';

const state = {
  page: 'chat',
  role: null,
  session: null,
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
  graphNodeDetails: new Map(),
  graphIncludeHistory: false,
  graphTypes: { entity: true, event: true, claim: true },
  retrievalProfile: null,
  retrievalTest: null,
  retrievalQuery: '我之前告诉过你我的姓名是什么？',
  schemas: [],
  schemaTab: 'fields',
  eventExtractionProfile: null,
  extractionContract: null,
  plots: [],
  triggers: [],
  tools: [],
  automationTab: 'triggers',
  timelineView: 'all',
  architectureOverview: null,
  architectureSources: new Map(),
  architectureAsking: false,
  adminUsers: [],
  feedback: [],
  sending: false
};

const pageTitles = {
  chat: '角色对话',
  memory: '记忆查询',
  schemas: '记忆设置',
  persona: '人设与剧情',
  automation: '触发与工具',
  timeline: '系统架构图',
  users: '用户列表',
  feedback: '反馈列表'
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
    const authRequest = ['/api/auth/login', '/api/auth/register', '/api/admin/login'].includes(path);
    if (response.status === 401 && !authRequest) showLogin();
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload.code || 'REQUEST_FAILED';
    error.details = payload.details || null;
    throw error;
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
  closeTraceDrawer();
  const architectureAssistant = $('#architectureAssistant');
  architectureAssistant?.classList.remove('open');
  if (architectureAssistant) {
    architectureAssistant.inert = true;
    architectureAssistant.setAttribute('aria-hidden', 'true');
  }
  setTimeout(() => $('[data-auth-panel]:not(.hidden) input:not(.hidden)')?.focus(), 50);
}

function showTraceDrawer() {
  const drawer = $('#traceDrawer');
  drawer.inert = false;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
}

function closeTraceDrawer() {
  const drawer = $('#traceDrawer');
  if (!drawer) return;
  drawer.classList.remove('open');
  drawer.inert = true;
  drawer.setAttribute('aria-hidden', 'true');
}

function showApp() {
  $('#loginOverlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function applyRoleUi() {
  const admin = isAdmin();
  document.body.dataset.role = state.role || '';
  $$('[data-admin-only]').forEach((element) => element.classList.toggle('hidden', !admin));
  $$('[data-write-only]').forEach((element) => element.classList.toggle('hidden', !admin));
  ['#userSelect', '#memoryUserSelect'].forEach((selector) => {
    const element = $(selector);
    if (element) element.disabled = !admin;
  });
  $$('[data-config-form] input, [data-config-form] textarea, [data-config-form] select').forEach((element) => {
    element.disabled = !admin;
  });
  $('#sessionRoleLabel').textContent = admin ? '管理员' : (state.session?.user?.display_name || '普通用户');
  $('#sessionIdentityMeta').textContent = admin ? '全量管理权限' : '配置只读 · 数据隔离';
  const memoryProfileLabel = $('#editMemoryProfileButton span');
  if (memoryProfileLabel) memoryProfileLabel.textContent = admin ? '配置说明' : '查看说明';
  const retrievalProfileLabel = $('#editRetrievalProfileButton span');
  if (retrievalProfileLabel) retrievalProfileLabel.textContent = admin ? '召回策略' : '查看召回策略';
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

function isAdmin() {
  return state.role === 'admin';
}

function statusInfo(value) {
  return ({
    active: { label: '当前有效', detail: '默认参与召回和回答' },
    superseded: { label: '已被新版本替代', detail: '保留历史证据，不再参与回答' },
    retracted: { label: '已撤回 / 已取消', detail: '原结论被明确否定，没有可用的当前版本' }
  })[value] || { label: value || '未知', detail: '' };
}

function statusLabel(value) {
  return statusInfo(value).label;
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

function openModal({ title, body, submitLabel = '保存', submitClass = 'primary', onSubmit, width = 560, showCancel = true, readOnly = false }) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop dynamic-modal">
      <form class="modal" style="width:min(${width}px,100%)">
        <div class="modal-header"><h3>${escapeHtml(title)}</h3><button type="button" class="icon-button modal-close" aria-label="关闭"><i data-lucide="x"></i></button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-footer">${readOnly ? '<button type="button" class="button secondary modal-close">关闭</button>' : `${showCancel ? '<button type="button" class="button secondary modal-close">取消</button>' : ''}<button type="submit" class="button ${submitClass}">${escapeHtml(submitLabel)}</button>`}</div>
      </form>
    </div>`;
  if (readOnly) {
    $$('input, textarea, select', root).forEach((element) => { element.disabled = true; });
  }
  refreshIcons();
  $$('.modal-close', root).forEach((button) => button.addEventListener('click', () => { root.innerHTML = ''; }));
  $('.dynamic-modal', root).addEventListener('click', (event) => {
    if (event.target.classList.contains('dynamic-modal')) root.innerHTML = '';
  });
  $('form', root).addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readOnly || !onSubmit) return;
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
  const session = await api('/api/auth/session').catch(() => ({ authenticated: false }));
  if (!session.authenticated) {
    showLogin();
    return;
  }
  state.session = session;
  state.role = session.role;
  await loadBootstrap();
  showApp();
}

async function loadBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  state.role = state.bootstrap.role || state.role || 'user';
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
  applyRoleUi();
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
        <div class="message-meta"><time>${formatDate(message.created_at)}</time>${String(message.id).startsWith('local_') ? '' : `<button class="message-feedback-button" data-feedback-message="${escapeHtml(message.id)}" title="对这条消息提反馈" aria-label="对这条消息提反馈"><i data-lucide="message-square-warning"></i></button>`}</div>
      </div>
    </div>`).join('') + extraHtml;
  $$('[data-feedback-message]', root).forEach((button) => button.addEventListener('click', () => {
    openMessageFeedback(button.dataset.feedbackMessage);
  }));
  refreshIcons();
  root.scrollTop = root.scrollHeight;
}

function openMessageFeedback(messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  openModal({
    title: '反馈这条消息',
    submitLabel: '提交反馈',
    body: `<div class="feedback-target-preview"><span>${message.role === 'assistant' ? '角色回复' : '用户消息'}</span><p>${escapeHtml(message.content)}</p></div>
      <label><span>不满或改进建议</span><textarea name="suggestion" rows="5" maxlength="2000" placeholder="例如：这里使用了已过期的地点，应以我刚才更正的地点为准。" required autofocus></textarea></label>
      <p class="feedback-capture-note"><i data-lucide="paperclip"></i><span>直接提交即可。系统会在服务端自动抓取该消息所在的完整轮次、作用域和 Trace ID。</span></p>`,
    onSubmit: async (formData) => {
      const result = await api('/api/feedback', {
        method: 'POST',
        body: { message_id: messageId, suggestion: formData.get('suggestion') }
      });
      const traceText = result.traceId ? ` · Trace ${result.traceId.slice(-8)}` : '';
      toast(`反馈已提交 · 已抓取 ${result.capturedMessages} 条轮次消息${traceText}`);
    }
  });
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
  if (!isAdmin() && ['users', 'feedback'].includes(page)) page = 'chat';
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
  if (state.page === 'users') await loadAdminUsers();
  if (state.page === 'feedback') await loadAdminFeedback();
  applyRoleUi();
  refreshIcons();
}

function renderArchitectureIndex(index = {}) {
  const ready = Boolean(index.ready);
  const version = index.systemVersion ? `v${index.systemVersion}` : '版本未知';
  const label = `${version} · ${ready ? '代码索引就绪' : `${Number(index.staleChunks || 0)} 个切片待更新`}`;
  const model = (index.models || []).join(' / ') || '首次提问时建立';
  const embeddedAt = index.codeEmbeddingUpdatedAt || index.updatedAt;
  const meta = `${Number(index.chunks || 0)}/${Number(index.expectedChunks || 0)} chunks · ${model} · Embedding ${embeddedAt ? formatDate(embeddedAt) : '未生成'}`;
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
          <div class="memory-record-meta"><span class="badge">${escapeHtml(item.valueType)}</span>${isAdmin() ? `<button class="icon-button bordered edit-memory" data-key="${escapeHtml(item.key)}" title="编辑记忆" aria-label="编辑${escapeHtml(item.label)}"><i data-lucide="pencil"></i></button>` : '<span class="badge">只读</span>'}</div>
        </article>`).join('')}</div>
    </section>`).join('')}</div>` : emptyState('database-zap', '没有匹配的记忆');
  $$('.edit-memory').forEach((button) => button.addEventListener('click', () => editMemory(button.dataset.key)));
  refreshIcons();
}

function editMemory(key) {
  if (!isAdmin()) return;
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
    ['用户记忆', events.filter((item) => item.memory_space !== 'shared_story').length],
    ['我们的故事', events.filter((item) => item.memory_space === 'shared_story').length],
    ['有效声明', events.reduce((sum, item) => sum + item.claims.filter((claim) => claim.status === 'active').length, 0)]
  ]);
  $('#memoryResultCount').textContent = `${events.length} 个事件`;
  $('#memoryContent').innerHTML = `<section class="event-list-workbench">
    <header class="event-list-toolbar">
      <div class="event-order-switch segmented" role="group" aria-label="事件排序">
        <button class="${state.eventListOrder === 'story' ? 'active' : ''}" data-event-order="story">剧情时间</button>
        <button class="${state.eventListOrder === 'created' ? 'active' : ''}" data-event-order="created">写入时间</button>
      </div>
      <label class="event-history-toggle"><span><strong>历史版本</strong><small>显示已被新版本替代、已撤回的事件</small></span><span class="toggle-control"><input type="checkbox" id="eventHistoryToggle" ${state.eventListIncludeHistory ? 'checked' : ''}><i></i></span></label>
    </header>
    <div class="memory-status-guide">
      <span><i class="status-dot active"></i><strong>当前有效</strong><small>会参与召回和回答</small></span>
      <span><i class="status-dot superseded"></i><strong>已被新版本替代</strong><small>只保留历史证据</small></span>
      <span><i class="status-dot retracted"></i><strong>已撤回 / 已取消</strong><small>当前没有可用结论</small></span>
    </div>
    <div class="event-time-axis">${events.length ? events.map((item, index) => {
      const claims = item.claims || [];
      const collection = item.metadata?.collection_name || '';
      const primaryTime = state.eventListOrder === 'story'
        ? (item.story_time || '未标注剧情时间')
        : formatDate(item.created_at);
      return `<article class="event-timeline-row ${item.status !== 'active' ? 'history' : ''}">
        <div class="event-time-marker"><time>${escapeHtml(primaryTime)}</time><span>${escapeHtml(formatDate(item.created_at))}</span><i>${String(index + 1).padStart(2, '0')}</i></div>
        <div class="event-list-record">
          <header><div><span class="badge blue">${escapeHtml(eventTypeLabel(item.event_type))}</span><span class="badge ${item.memory_space === 'shared_story' ? 'amber' : ''}">${item.memory_space === 'shared_story' ? '我们的故事' : '用户记忆'}</span><span class="badge ${item.canonicality === 'provisional' ? 'amber' : 'blue'}">${item.canonicality === 'provisional' ? '待用户承接' : '已确认'}</span><span class="badge ${item.status === 'active' ? '' : 'red'}" title="${escapeHtml(statusInfo(item.status).detail)}">${escapeHtml(statusLabel(item.status))}</span>${collection ? `<span class="badge">${escapeHtml(collection)}${item.sequence_no !== null ? ` · #${item.sequence_no}` : ''}</span>` : ''}</div><span class="event-importance">importance ${Number(item.importance).toFixed(2)}</span></header>
          <h4>${escapeHtml(item.title)}</h4>
          <p>${escapeHtml(item.summary || '无事件摘要')}</p>
          ${claims.length ? `<div class="event-claim-list">${claims.map((claim) => `<span><b>${escapeHtml(claim.subject)}</b><i>${escapeHtml(claim.predicate)}</i><strong>${escapeHtml(claim.object_name || claim.object_text)}</strong><em title="${escapeHtml(statusInfo(claim.status).detail)}">${escapeHtml(statusLabel(claim.status))}</em></span>`).join('')}</div>` : '<div class="event-no-claims">未产生声明槽位</div>'}
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
  state.graphNodeDetails = new Map();
  metrics([
    ['实体', graph.entities.length],
    ['关系边', graph.edges.length],
    ['剧情事件', graph.events.length],
    ['事件实体链接', (graph.eventEntities || []).length],
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

function graphEventEntityRole(role) {
  return ({
    mentioned: '事件涉及',
    claim_subject: '声明主体',
    relation_source: '关系源点',
    relation_target: '关系终点'
  })[role] || role;
}

function renderGraphInspector(node) {
  const root = $('#graphInspector');
  if (!root || !node) return;
  root.innerHTML = `<div class="graph-inspector-head">
      <span class="graph-node-kind ${escapeHtml(node.kind)}">${escapeHtml(node.kindLabel)}</span>
      <span class="badge ${node.status === 'active' ? 'blue' : 'red'}" title="${escapeHtml(statusInfo(node.status).detail)}">${escapeHtml(statusLabel(node.status))}</span>
    </div>
    <h4>${escapeHtml(node.title)}</h4>
    ${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}
    <dl>${node.fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '-')}</dd></div>`).join('')}</dl>
    ${node.relatedEvents?.length ? `<section class="graph-related-section"><header><span>关联事件</span><b>${node.relatedEvents.length}</b></header>${node.relatedEvents.map((item) => `<button type="button" data-focus-graph-node="${escapeHtml(item.nodeId)}"><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.storyTime || '未设定剧情时间')}</small></span><em>${escapeHtml(item.roles.join('·'))}</em><i data-lucide="locate-fixed"></i></button>`).join('')}</section>` : ''}
    ${node.relatedEntities?.length ? `<section class="graph-related-section"><header><span>关联实体</span><b>${node.relatedEntities.length}</b></header>${node.relatedEntities.map((item) => `<button type="button" data-focus-graph-node="${escapeHtml(item.nodeId)}"><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.type)}</small></span><em>${escapeHtml(item.roles.join('·'))}</em><i data-lucide="locate-fixed"></i></button>`).join('')}</section>` : ''}`;
  $$('[data-focus-graph-node]', root).forEach((button) => button.addEventListener('click', () => {
    const nodeId = button.dataset.focusGraphNode;
    if (!state.graphNetwork || !state.graphNodeDetails.has(nodeId)) return;
    state.graphNetwork.selectNodes([nodeId]);
    state.graphNetwork.focus(nodeId, { scale: Math.max(state.graphNetwork.getScale(), 0.9), animation: { duration: 260 } });
    renderGraphInspector(state.graphNodeDetails.get(nodeId));
  }));
  refreshIcons();
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
  const eventEntityLinks = new Map();
  const relatedEventsByEntity = new Map();
  const relatedEntitiesByEvent = new Map();
  for (const association of graph.eventEntities || []) {
    if (!state.graphIncludeHistory && association.event_status !== 'active') continue;
    const pairKey = `${association.event_id}:${association.entity_id}`;
    const pair = eventEntityLinks.get(pairKey) || { ...association, roles: [] };
    const roleLabel = graphEventEntityRole(association.role);
    if (!pair.roles.includes(roleLabel)) pair.roles.push(roleLabel);
    eventEntityLinks.set(pairKey, pair);

    const entityEvents = relatedEventsByEntity.get(association.entity_id) || new Map();
    const relatedEvent = entityEvents.get(association.event_id) || {
      nodeId: `event:${association.event_id}`,
      title: association.event_title,
      storyTime: association.story_time,
      status: association.event_status,
      roles: []
    };
    if (!relatedEvent.roles.includes(roleLabel)) relatedEvent.roles.push(roleLabel);
    entityEvents.set(association.event_id, relatedEvent);
    relatedEventsByEntity.set(association.entity_id, entityEvents);

    const eventEntities = relatedEntitiesByEvent.get(association.event_id) || new Map();
    const relatedEntity = eventEntities.get(association.entity_id) || {
      nodeId: `entity:${association.entity_id}`,
      name: association.entity_name,
      type: association.entity_type,
      roles: []
    };
    if (!relatedEntity.roles.includes(roleLabel)) relatedEntity.roles.push(roleLabel);
    eventEntities.set(association.entity_id, relatedEntity);
    relatedEntitiesByEvent.set(association.event_id, eventEntities);
  }

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
        description: '', fields: [['类型', entity.entity_type], ['别名', aliases.join('、')], ['更新', formatDate(entity.updated_at)]],
        relatedEvents: [...(relatedEventsByEntity.get(entity.id)?.values() || [])]
      });
    }
  }
  if (state.graphTypes.event) {
    for (const event of graph.events.filter(visible)) {
      const id = `event:${event.id}`;
      visibleNodeIds.add(id);
      nodes.push({
        id, label: graphNodeLabel(event.title), shape: 'box', margin: 12,
        color: event.status === 'active' ? (event.memory_space === 'shared_story'
          ? { background: '#7c3aed', border: '#6d28d9', highlight: { background: '#6d28d9', border: '#5b21b6' } }
          : { background: '#2563eb', border: '#1d4ed8', highlight: { background: '#1d4ed8', border: '#1e40af' } }) : inactiveColor,
        font: { color: event.status === 'active' ? '#ffffff' : '#475569', size: 13, face: '-apple-system', bold: { color: '#ffffff' } },
        borderWidth: 1.5, title: `${event.title}\n${event.summary}`
      });
      nodeDetails.set(id, {
        kind: 'event', kindLabel: '事件', title: event.title, status: event.status,
        description: event.summary, fields: [['记忆空间', event.memory_space === 'shared_story' ? '我们的故事' : '用户记忆'], ['确认状态', event.canonicality === 'provisional' ? '待用户承接' : '已确认'], ['来源说话者', event.source_speaker], ['事件类型', event.event_type], ['剧情时间', event.story_time], ['重要度', event.importance], ['事件 Key', event.event_key]],
        relatedEntities: [...(relatedEntitiesByEvent.get(event.id)?.values() || [])]
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
  for (const association of eventEntityLinks.values()) {
    const from = `event:${association.event_id}`;
    const to = `entity:${association.entity_id}`;
    if (visibleNodeIds.has(from) && visibleNodeIds.has(to)) {
      edges.push({
        id: `event-entity:${association.event_id}:${association.entity_id}`,
        from,
        to,
        label: association.roles.join('·'),
        status: association.event_status
      });
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
  state.graphNodeDetails = nodeDetails;
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
  const planner = retrieval.planner || {};
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
        <div><span>轻量目录</span><strong>${pipeline.afterCatalogThreshold}</strong></div><i data-lucide="chevron-right"></i>
        <div><span>可展开详情</span><strong>${pipeline.expansionEligible}</strong></div><i data-lucide="chevron-right"></i>
        <div><span>二阶段合并</span><strong>${pipeline.afterRelevanceThreshold}</strong></div><i data-lucide="chevron-right"></i>
        <div class="selected"><span>最终 TopK</span><strong>${pipeline.selected}</strong></div>
      </div>
      <div class="retrieval-planner-result">
        <span class="strategy-icon"><i data-lucide="brain-circuit"></i></span>
        <div><strong>LLM 二次召回规划器 · ${escapeHtml(planner.status || '未运行')}</strong><small>${escapeHtml(planner.reason || '当前没有候选需要展开')}</small></div>
        <div class="planner-facts"><span>决策 <b>${escapeHtml(planner.decision || 'none')}</b></span><span>指定事件 <b>${(planner.expandEventIds || []).length}</b></span><span>二次 Query <b>${(planner.followUpQueries || []).length}</b></span></div>
      </div>
      <div class="retrieval-candidate-table data-surface">${candidates.length ? `
        <table class="data-table"><thead><tr><th style="width:21%">事件候选</th><th style="width:9%">向量相似度</th><th style="width:8%">关键词</th><th style="width:8%">重要度</th><th style="width:8%">时效性</th><th style="width:9%">综合分</th><th style="width:11%">召回阶段</th><th style="width:12%">向量状态</th><th style="width:14%">决策</th></tr></thead>
        <tbody>${candidates.map((item) => `<tr class="${item.selected ? 'selected-row' : ''}">
          <td><span class="cell-main">${escapeHtml(item.title)}</span><span class="cell-sub">${escapeHtml(item.eventType)} · ${escapeHtml(statusLabel(item.status))}</span></td>
          <td><code>${scoreText(item.similarity)}</code></td><td><code>${scoreText(item.keywordScore)}</code></td>
          <td>${scoreText(item.importance)}</td><td>${scoreText(item.recencyScore)}</td><td><strong>${scoreText(item.finalScore)}</strong></td>
          <td><span class="badge ${item.selected ? 'blue' : (item.expansionEligible ? 'amber' : '')}">${item.selected ? '已展开' : (item.expansionEligible ? '可展开' : (item.inCatalog ? '仅目录' : '未入目录'))}</span></td>
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
      ['轻量目录', result.retrieval.diagnostics.pipeline.afterCatalogThreshold],
      ['最终事件', result.retrieval.events.length],
      ['耗时', `${result.durationMs} ms`]
    ]);
  } else {
    metrics([
      ['召回通道', retrievalChannelNames(profile)],
      ['目录 / 详情门槛', `${profile.catalog_min_similarity} / ${profile.vector_only_min_similarity}`],
      ['事件 TopK', profile.event_top_k],
      ['二次规划', profile.planner_enabled ? '已启用' : '关闭']
    ]);
  }
  $('#memoryResultCount').textContent = result ? `${result.retrieval.events.length} 个事件召回` : '待测试';
  $('#memoryContent').innerHTML = `<section class="retrieval-lab">
    <form id="retrievalTestForm" class="retrieval-console">
      <label class="retrieval-query-field"><span>TEST QUERY</span><textarea id="retrievalQuery" rows="2" required>${escapeHtml(state.retrievalQuery)}</textarea></label>
      <button id="runRetrievalButton" class="button primary" type="submit"><i data-lucide="play"></i><span>运行召回</span></button>
    </form>
    <div class="retrieval-strategy-bar">
      <div><span class="strategy-icon"><i data-lucide="sliders-horizontal"></i></span><div><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(retrievalChannelNames(profile))} · 目录 ${profile.catalog_min_similarity} → 详情 ${profile.vector_only_min_similarity} · ${profile.planner_enabled ? 'LLM 二次规划' : '确定性召回'} · TopK ${profile.event_top_k}</small></div></div>
      <button class="button secondary compact" data-open-retrieval-settings><i data-lucide="external-link"></i><span>${isAdmin() ? '召回策略' : '查看召回策略'}</span></button>
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
        branch_id: 'main',
        conversation_id: state.currentConversationId || ''
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

async function loadExtractionConfiguration(sceneId) {
  if (!sceneId) {
    state.eventExtractionProfile = null;
    state.extractionContract = null;
    return;
  }
  [state.eventExtractionProfile, state.extractionContract] = await Promise.all([
    api(`/api/scenes/${encodeURIComponent(sceneId)}/event-extraction-profile`),
    api(`/api/scenes/${encodeURIComponent(sceneId)}/extraction-contract`)
  ]);
}

async function loadSchemas() {
  const [schemas, scenes] = await Promise.all([api('/api/memory/schemas'), api('/api/scenes')]);
  state.schemas = schemas;
  state.bootstrap.scenes = scenes;
  if (!scenes.some((scene) => scene.id === state.currentSceneId)) {
    state.currentSceneId = sceneForAgent()?.id || scenes[0]?.id || '';
  }
  await loadExtractionConfiguration(state.currentSceneId);
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
    await loadExtractionConfiguration(state.currentSceneId);
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
  $('#addSchemaButton').classList.toggle('hidden', !fieldsMode || !isAdmin());
  $('#schemaModeHint').textContent = fieldsMode
    ? '定义字段、独立抽取说明与回复注入模板'
    : '设置轮次窗口，并编排结构化字段、事件、实体和关系的实际提示词';
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
        <td><span class="cell-main">${escapeHtml(item.label)}</span><code>${escapeHtml(item.key)}</code><span class="cell-sub schema-description"><b>字段说明</b>${escapeHtml(item.description || '暂无说明')}</span><span class="cell-sub schema-extraction-note"><b>抽取说明</b>${escapeHtml(item.extraction_instruction || item.description || '未配置')}</span></td>
        <td>${escapeHtml(item.category)}</td><td><span class="badge ${item.scenario_type === 'all' ? '' : 'blue'}">${item.scenario_type === 'all' ? '共享基线' : '当前场景'}</span></td>
        <td><span class="cell-main">${escapeHtml(item.value_type)}</span><span class="cell-sub">${escapeHtml(item.scope)}</span></td>
        <td><code>${escapeHtml(item.extraction_mode)}</code></td><td>${item.pinned ? '<span class="badge blue">每轮</span>' : '<span class="badge">按需</span>'}</td>
        <td><div class="row-actions">${isAdmin() ? `<button class="icon-button edit-schema" data-id="${item.id}" title="编辑"><i data-lucide="pencil"></i></button>` : '<span class="badge">只读</span>'}</div></td>
      </tr>`).join('')}</tbody></table>` : emptyState('list-filter', '没有匹配的字段');
  $$('.edit-schema').forEach((button) => button.addEventListener('click', () => editSchema(button.dataset.id)));
  refreshIcons();
}

function renderEventExtractionSettings() {
  const profile = state.eventExtractionProfile;
  const contract = state.extractionContract;
  if (!profile) {
    $('#schemaSummary').innerHTML = '';
    $('#schemaTable').innerHTML = emptyState('scan-text', '当前场景尚无事件抽取配置');
    refreshIcons();
    return;
  }
  $('#schemaSummary').innerHTML = [
    ['状态', profile.enabled ? '已启用' : '已停用'],
    ['轮结束点', 'assistant 落库'],
    ['历史理解窗口', `${profile.context_turns} 轮 / 最多 ${contract?.runtime?.historyMessageLimit || profile.context_turns * 2} 条`],
    ['单轮写入上限', `${profile.max_events_per_turn} 事件`]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('#schemaResultCount').textContent = '4 类抽取对象';

  const configuredTypes = profile.allowed_event_types || [];
  const knownTypes = new Set(eventTypeOptions.map(([value]) => value));
  const options = [...eventTypeOptions, ...configuredTypes.filter((value) => !knownTypes.has(value)).map((value) => [value, value])];
  const fieldInstructions = contract?.fieldInstructions || [];
  const promptSystem = contract?.prompt?.system || '当前无可用预览';
  const promptUser = contract?.prompt?.user || '当前无可用预览';
  $('#schemaTable').innerHTML = `<section class="extraction-settings">
    <div class="extraction-runtime-contract">
      <div><span>TURN END</span><i data-lucide="message-square"></i><strong>assistant 回复落库</strong><small>1 轮 = user 消息 + assistant 回复</small></div>
      <i data-lucide="arrow-right"></i>
      <div class="active"><span>ONE MODEL OUTPUT</span><i data-lucide="scan-text"></i><strong>结构字段 + 事件 + 图谱</strong><small>同一次抽取，统一对齐当轮证据</small></div>
      <i data-lucide="arrow-right"></i>
      <div><span>COMMIT BARRIER</span><i data-lucide="database"></i><strong>状态派生与图谱提交</strong><small>提交完成后 /api/chat 才返回</small></div>
    </div>
    <form id="eventExtractionForm" class="extraction-form" data-config-form>
      <section class="extraction-form-section">
        <header><span>01</span><div><strong>轮次、结束点与触发机制</strong><small>场景内所有角色共用，当轮内容与历史理解窗口分开传入</small></div></header>
        <div class="turn-definition-banner">
          <div><i data-lucide="repeat-2"></i><span><strong>一轮如何计算</strong><small>1 条 user 消息 + 1 条 assistant 回复</small></span></div>
          <div><i data-lucide="flag"></i><span><strong>一轮何时结束</strong><small>assistant 回复成功写入 messages 表</small></span></div>
          <div><i data-lucide="lock-keyhole"></i><span><strong>下一轮屏障</strong><small>同步抽取与提交完成后才解锁</small></span></div>
        </div>
        <div class="form-grid three extraction-runtime-fields">
          <label><span>历史理解窗口（指代消歧，轮）</span><input id="extractionContextTurns" name="context_turns" type="number" min="1" max="10" step="1" value="${profile.context_turns}" required><small id="turnWindowMessageLimit">例如“还是改到银座吧”需要历史才知道改的是哪次会面；最多读取 ${contract?.runtime?.historyMessageLimit || profile.context_turns * 2} 条，不会重复抽取旧事件</small></label>
          <label><span>触发点（系统固定）</span><input value="assistant 回复落库后" disabled><small>after_assistant_message_persisted</small></label>
          <label><span>执行模式（系统固定）</span><input value="同一请求同步阻塞" disabled><small>blocking_after_assistant</small></label>
        </div>
        <div class="extraction-switches">
          <label class="strategy-toggle"><span><strong>启用轮后抽取</strong><small>关闭后仅保留用户显式控制快通道</small></span><span class="toggle-control"><input name="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>将 assistant 回复传入抽取模型</strong><small>只用于理解当轮上下文，不能单独作为用户事实</small></span><span class="toggle-control"><input name="include_assistant" type="checkbox" ${profile.include_assistant ? 'checked' : ''}><i></i></span></label>
        </div>
      </section>
      <section class="extraction-form-section">
        <header><span>02</span><div><strong>四类抽取对象与提示词来源</strong><small>字段级指令与场景级指令最终编译为同一次模型 Input</small></div></header>
        <div class="extraction-object-grid">
          <article><span class="object-sequence">A</span><i data-lucide="list-tree"></i><div><strong>结构化字段</strong><small>${fieldInstructions.length} 个字段，使用每个字段的“抽取说明”</small><code>structured_updates[]</code></div><button class="icon-button bordered" type="button" id="openStructuredFields" title="管理字段抽取说明"><i data-lucide="arrow-up-right"></i></button></article>
          <article><span class="object-sequence">B</span><i data-lucide="calendar-clock"></i><div><strong>事件</strong><small>经历、约定、关系节点与剧情进展</small><code>events[]</code></div></article>
          <article><span class="object-sequence">C</span><i data-lucide="circle-dot"></i><div><strong>实体</strong><small>存在于事件内，写入 entities 并建立事件链接</small><code>events[].entities[]</code></div></article>
          <article><span class="object-sequence">D</span><i data-lucide="git-branch"></i><div><strong>关系与声明</strong><small>稳定边写 relations，可版本化事实写 claims</small><code>relations[] + claims[]</code></div></article>
        </div>
        <div class="object-instruction-stack">
          <label><span>事件抽取指令</span><textarea name="event_instruction" rows="3">${escapeHtml(profile.event_instruction || '')}</textarea><small>与系统硬规则、事件类型白名单共同生效。</small></label>
          <label><span>实体抽取指令</span><textarea name="entity_instruction" rows="3">${escapeHtml(profile.entity_instruction || '')}</textarea><small>实体不独立漂浮，只有被事件接受后才写库并关联。</small></label>
          <label><span>关系与声明抽取指令</span><textarea name="relation_instruction" rows="3">${escapeHtml(profile.relation_instruction || '')}</textarea><small>relations 是实体边；claims 是可“被新版本替代 / 撤回”的有效事实槽位。</small></label>
        </div>
      </section>
      <section class="extraction-form-section">
        <header><span>03</span><div><strong>事件阈值、类型与更新判定</strong><small>模型先按提示词生成候选，服务端再执行白名单、上限和重要度硬过滤</small></div></header>
        <div class="form-grid three">
          <label><span>配置名称</span><input name="name" value="${escapeHtml(profile.name)}" required></label>
          <label><span>单轮最大事件数</span><input name="max_events_per_turn" type="number" min="1" max="10" step="1" value="${profile.max_events_per_turn}" required></label>
          <label><span>新建事件最低重要度</span><input name="min_importance" type="number" min="0" max="1" step="0.05" value="${profile.min_importance}" required></label>
        </div>
        <div class="event-type-field"><span>允许的事件类型</span><div class="event-type-options">${options.map(([value, label]) => `<label><input type="checkbox" name="allowed_event_types" value="${escapeHtml(value)}" ${configuredTypes.includes(value) ? 'checked' : ''}><span><code>${escapeHtml(value)}</code>${escapeHtml(label)}</span></label>`).join('')}</div></div>
        <label><span>事件更新信号（换行或逗号分隔）</span><textarea name="update_signals" rows="3">${escapeHtml((profile.update_signals || []).join('\n'))}</textarea></label>
        <label><span>场景全局附加规则</span><textarea name="custom_rules" rows="4">${escapeHtml(profile.custom_rules || '')}</textarea><small>同时约束四类抽取对象，不能覆盖系统硬保护。</small></label>
      </section>
      <section class="extraction-form-section guard-section">
        <header><span>04</span><div><strong>字段指令清单与系统硬保护</strong><small>这些字段指令会被逐条编译进模型 Input，manual / derived 还会被服务端拒绝写入</small></div></header>
        <div class="field-instruction-list">${fieldInstructions.map((item) => `<div><span><strong>${escapeHtml(item.label)}</strong><code>${escapeHtml(item.key)}</code></span><em>${escapeHtml(item.extraction_mode)}</em><p>${escapeHtml(item.extraction_instruction || '未配置抽取说明')}</p></div>`).join('')}</div>
        <div class="extraction-guards">
          <span><i data-lucide="shield-check"></i><strong>只写当轮新增或更正</strong><small>历史上下文只用于理解指代</small></span>
          <span><i data-lucide="shield-check"></i><strong>旧值标记为“已被新版本替代”</strong><small>当前有效版本才进入默认回答</small></span>
          <span><i data-lucide="shield-check"></i><strong>助手情节不等于用户事实</strong><small>必须有用户承接证据</small></span>
          <span><i data-lucide="shield-check"></i><strong>作用域硬隔离</strong><small>user / agent / story / branch</small></span>
        </div>
      </section>
      <section class="extraction-form-section prompt-preview-section">
        <header><span>05</span><div><strong>当前生效的完整模型 Input</strong><small>来自同一个服务端编译器，与真实抽取共用代码；运行时占位符会替换为当轮数据</small></div><button id="copyExtractionPrompt" class="button secondary compact" type="button"><i data-lucide="copy"></i>复制 Input</button></header>
        <details class="compiled-prompt" open>
          <summary><span><i data-lucide="terminal-square"></i>查看 System + User Input</span><small>当前已生效版本，未保存的表单修改尚未编译</small></summary>
          <div class="compiled-prompt-layer"><span>SYSTEM</span><pre>${escapeHtml(promptSystem)}</pre></div>
          <div class="compiled-prompt-layer"><span>USER INPUT</span><pre>${escapeHtml(promptUser)}</pre></div>
        </details>
      </section>
      <footer class="extraction-form-actions"><span><i data-lucide="info"></i>${isAdmin() ? '保存后立即重新编译预览，并从下一轮开始生效。' : '当前为普通用户只读视图，可查看完整配置但不能修改。'}</span>${isAdmin() ? '<button class="button primary" type="submit"><i data-lucide="save"></i>保存抽取配置</button>' : '<span class="badge blue">只读</span>'}</footer>
    </form>
  </section>`;
  $('#openStructuredFields')?.addEventListener('click', () => {
    state.schemaTab = 'fields';
    renderSchemas();
    $('#schemaTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#copyExtractionPrompt')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`SYSTEM\n${promptSystem}\n\nUSER INPUT\n${promptUser}`);
    toast('已复制当前生效的抽取 Input');
  });
  const contextTurnsInput = $('#extractionContextTurns');
  contextTurnsInput?.addEventListener('input', () => {
    const turns = Math.max(1, Math.min(10, Number(contextTurnsInput.value) || 1));
    $('#turnWindowMessageLimit').textContent = `最多注入 ${Math.min(20, turns * 2)} 条历史消息，不含当轮`;
  });
  $('#eventExtractionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isAdmin()) return;
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
        event_instruction: formData.get('event_instruction'),
        entity_instruction: formData.get('entity_instruction'),
        relation_instruction: formData.get('relation_instruction'),
        custom_rules: formData.get('custom_rules')
      }
    });
    await loadExtractionConfiguration(state.currentSceneId);
    toast('抽取配置已生效，完整 Input 已重新编译');
    renderSchemas();
  });
  applyRoleUi();
  refreshIcons();
}

function editMemoryProfile() {
  const scene = currentScene();
  if (!scene) return;
  openModal({
    title: `配置说明 · ${scene.name}`,
    readOnly: !isAdmin(),
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
    readOnly: !isAdmin(),
    body: `<div class="strategy-modal">
      <section class="strategy-modal-section">
        <div class="strategy-section-title"><span>01</span><div><strong>策略与通道</strong><small>${escapeHtml(scene.name)} 场景内所有角色共用</small></div></div>
        <label><span>策略名称</span><input name="name" value="${escapeHtml(profile.name)}" required></label>
        <div class="strategy-toggle-grid">
          <label class="strategy-toggle"><span><strong>向量召回</strong><small>Embedding + cosine similarity</small></span><span class="toggle-control"><input name="vector_enabled" type="checkbox" ${profile.vector_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>关键词召回</strong><small>文本重叠候选</small></span><span class="toggle-control"><input name="keyword_enabled" type="checkbox" ${profile.keyword_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>图谱扩展</strong><small>Claims + entity edges</small></span><span class="toggle-control"><input name="graph_enabled" type="checkbox" ${profile.graph_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>意图硬过滤</strong><small>事件类型与 collection</small></span><span class="toggle-control"><input name="intent_filter_enabled" type="checkbox" ${profile.intent_filter_enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>LLM 二次规划</strong><small>先看轻量目录，按需展开详情</small></span><span class="toggle-control"><input name="planner_enabled" type="checkbox" ${profile.planner_enabled ? 'checked' : ''}><i></i></span></label>
        </div>
        <div class="strategy-locked-guard"><i data-lucide="lock-keyhole"></i><div><strong>仅当前有效版本</strong><span>已被新版本替代、已撤回的记录永不进入回答候选</span></div><span class="badge blue">强制开启</span></div>
      </section>
      <section class="strategy-modal-section">
        <div class="strategy-section-title"><span>02</span><div><strong>两阶段门槛与 TopK</strong><small>进入目录不等于注入详情</small></div></div>
        <div class="retrieval-stage-note"><span><b>阶段 1</b> 只给规划器事件名、实体和关系</span><i data-lucide="arrow-right"></i><span><b>阶段 2</b> 仅展开通过严格证据门槛的详情</span></div>
        <div class="form-grid strategy-number-grid">
          <label><span>轻量目录相似度</span><input name="catalog_min_similarity" type="number" min="0" max="1" step="0.01" value="${profile.catalog_min_similarity}" required><small>宽进，只暴露名称和关系</small></label>
          <label><span>纯向量详情相似度</span><input name="vector_only_min_similarity" type="number" min="0" max="1" step="0.01" value="${profile.vector_only_min_similarity}" required><small>无关键词或图谱证据时的硬门槛</small></label>
          <label><span>关键词详情阈值</span><input name="min_keyword_score" type="number" min="0" max="1" step="0.01" value="${profile.min_keyword_score}" required></label>
          <label><span>规划器候选上限</span><input name="planner_max_candidates" type="number" min="1" max="30" step="1" value="${profile.planner_max_candidates}" required></label>
          <label><span>图谱扩展跳数</span><input name="graph_hops" type="number" min="0" max="2" step="1" value="${profile.graph_hops}" required></label>
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
        intent_filter_enabled: formData.has('intent_filter_enabled'),
        planner_enabled: formData.has('planner_enabled'),
        min_similarity: Number(formData.get('vector_only_min_similarity'))
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
  if (!isAdmin()) return;
  const scene = currentScene();
  const item = state.schemas.find((schema) => schema.id === id) || {
    key: '', label: '', category: '自定义', scenario_type: scene?.scenario_type || 'all', value_type: 'string', scope: 'user_agent',
    description: '', extraction_instruction: '', default: null, constraints: {}, prompt_template: '', pinned: 0, required: 0,
    extraction_mode: 'explicit_only', sensitivity: 'normal', enabled: 1
  };
  openModal({
    title: id ? '编辑记忆字段' : `新建记忆字段 · ${scene?.name || ''}`, width: 680,
    body: `
      <div class="form-grid two"><label><span>Key</span><input name="key" value="${escapeHtml(item.key)}" placeholder="profile.favorite_topic" required></label><label><span>显示名称</span><input name="label" value="${escapeHtml(item.label)}" required></label></div>
      <div class="form-grid two"><label><span>分类</span><input name="category" value="${escapeHtml(item.category)}" required></label><label><span>字段归属</span><select name="scenario_type"><option value="${escapeHtml(scene?.scenario_type || 'all')}" ${item.scenario_type === scene?.scenario_type ? 'selected' : ''}>当前场景 · ${escapeHtml(scene?.name || '')}</option><option value="all" ${item.scenario_type === 'all' ? 'selected' : ''}>所有场景 · 共享基线</option></select></label></div>
      <div class="form-grid two"><label><span>值类型</span><select name="value_type">${['string','number','boolean','enum','string_list','object'].map((value) => `<option ${item.value_type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label><span>作用域</span><select name="scope">${['user','user_agent','user_agent_story','user_agent_story_branch'].map((value) => `<option ${item.scope === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
      <label><span>字段说明</span><textarea name="description" rows="2">${escapeHtml(item.description)}</textarea><small>仅用于管理后台解释字段含义，不直接发给抽取模型。</small></label>
      <label class="extraction-instruction-field"><span>抽取说明</span><textarea name="extraction_instruction" rows="3" placeholder="明确什么证据可以写入、什么情况必须更新或忽略">${escapeHtml(item.extraction_instruction || item.description || '')}</textarea><small>会连同 Key、类型、作用域、抽取模式和约束一起编译进记忆抽取 Input。</small></label>
      <div class="form-grid two"><label><span>默认值 JSON</span><textarea name="default_value" rows="4">${escapeHtml(JSON.stringify(item.default, null, 2))}</textarea></label><label><span>约束 JSON</span><textarea name="constraints" rows="4">${escapeHtml(JSON.stringify(item.constraints || {}, null, 2))}</textarea></label></div>
      <label><span>回复 Prompt 注入模板</span><input name="prompt_template" value="${escapeHtml(item.prompt_template)}" placeholder="用户偏好：{{value}}。"><small>只在聊天回复前将已存储的值注入主模型，不参与记忆抽取。</small></label>
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
  renderPersonaFixedAttributes(parseJson(agent.fixed_attributes_json, {}));
  $('#personaScenario').textContent = scene?.name || scenarioLabel(agent.scenario_type);
  $('#personaHeaderName').textContent = agent.name;
  $('#personaHeaderMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · 人设 v${Number(agent.profile_version || 1)} · 专属剧情配置`;
  $('#personaAvatar').textContent = agent.name.slice(0, 1);
  $('#personaAvatar').style.background = agent.avatar_color;
  $('#pageMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · ${agent.name}专属配置`;
  state.plots = await api(`/api/plots?agent_id=${encodeURIComponent(state.currentAgentId)}`);
  renderPlots();
  applyRoleUi();
}

function renderPersonaFixedAttributes(attributes = {}) {
  const entries = Object.entries(attributes || {});
  $('#personaFixedAttributes').innerHTML = (entries.length ? entries : [['', '']]).map(([key, value]) => `
    <div class="persona-attribute-row">
      <input class="persona-attribute-key" value="${escapeHtml(key)}" maxlength="60" placeholder="属性名，例如 身份">
      <input class="persona-attribute-value" value="${escapeHtml(value)}" maxlength="600" placeholder="固定值">
      <button type="button" class="icon-button bordered remove-persona-attribute" title="删除属性" aria-label="删除属性" data-write-only><i data-lucide="trash-2"></i></button>
    </div>`).join('');
  $$('.remove-persona-attribute', $('#personaFixedAttributes')).forEach((button) => button.addEventListener('click', () => {
    button.closest('.persona-attribute-row')?.remove();
    if (!$('#personaFixedAttributes').children.length) renderPersonaFixedAttributes({});
  }));
  refreshIcons();
}

function collectPersonaFixedAttributes() {
  const attributes = {};
  $$('.persona-attribute-row', $('#personaFixedAttributes')).forEach((row) => {
    const key = $('.persona-attribute-key', row).value.trim();
    const value = $('.persona-attribute-value', row).value.trim();
    if (key && value) attributes[key] = value;
  });
  return attributes;
}

async function persistPersona(confirmProfileChange = false) {
  await api(`/api/agents/${encodeURIComponent(state.currentAgentId)}`, {
    method: 'PUT',
    body: {
      name: $('#personaName').value,
      scene_id: $('#personaScene').value,
      description: $('#personaDescription').value,
      greeting: $('#personaGreeting').value,
      system_prompt: $('#personaPrompt').value,
      fixed_attributes: collectPersonaFixedAttributes(),
      confirm_profile_change: confirmProfileChange
    }
  });
  await loadBootstrap();
  await navigate('persona');
  toast('角色人设已保存');
}

function confirmPersonaProfileChange(error) {
  const details = error.details || {};
  const changedFields = (details.changedFields || []).join('、') || '角色核心人设';
  openModal({
    title: '确认修改角色核心人设',
    submitLabel: '确认修改并保留历史',
    width: 620,
    body: `<div class="profile-change-warning"><i data-lucide="triangle-alert"></i><div><strong>这次修改可能与既有故事产生矛盾</strong><p>将修改：${escapeHtml(changedFields)}。系统不会自动改写既有用户记忆，而会保留本次人设版本记录。</p></div></div>
      <div class="impact-metrics">
        <div><span>相关会话</span><strong>${Number(details.conversations || 0)}</strong></div>
        <div><span>事件记忆</span><strong>${Number(details.events || 0)}</strong></div>
        <div><span>有效声明</span><strong>${Number(details.claims || 0)}</strong></div>
        <div><span>结构化记忆</span><strong>${Number(details.structuredMemories || 0)}</strong></div>
      </div>
      <p class="modal-note">建议先确认新设定是否会改变角色身份、核心性格或与用户已经共同经历的事实。确认后角色版本将升级，旧记忆仍可追溯。</p>`,
    onSubmit: async () => persistPersona(true)
  });
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
    <article class="plot-item"><div class="plot-item-head"><div><span class="plot-index">${String(state.plots.indexOf(plot) + 1).padStart(2, '0')}</span><strong>${escapeHtml(plot.name)}</strong></div>${isAdmin() ? `<button class="icon-button bordered edit-plot" data-id="${plot.id}" title="编辑剧情" aria-label="编辑${escapeHtml(plot.name)}"><i data-lucide="pencil"></i></button>` : '<span class="badge">只读</span>'}</div>
      <p>${escapeHtml(plot.premise)}</p><div class="plot-instruction">${escapeHtml(plot.instructions)}</div><div class="plot-item-meta"><span class="badge ${plot.enabled ? 'blue' : 'red'}">${plot.enabled ? '已启用' : '已停用'}</span><span class="badge">优先级 ${plot.priority}</span></div></article>`).join('') : emptyState('book-open', '尚无剧情');
  $$('.edit-plot').forEach((button) => button.addEventListener('click', () => editPlot(button.dataset.id)));
  refreshIcons();
}

function editPlot(id = '') {
  if (!isAdmin()) return;
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
  $('#addTriggerButton').classList.toggle('hidden', state.automationTab !== 'triggers' || !isAdmin());
  if (state.automationTab === 'tools') {
    $('#automationContent').innerHTML = `
      <table class="data-table"><thead><tr><th style="width:24%">工具</th><th style="width:38%">用途</th><th style="width:15%">执行器</th><th style="width:14%">状态</th><th style="width:9%">入参</th></tr></thead><tbody>${state.tools.map((tool) => `
        <tr><td><span class="cell-main">${escapeHtml(tool.name)}</span><code>${escapeHtml(tool.key)}</code></td><td>${escapeHtml(tool.description)}</td><td><span class="badge">${escapeHtml(tool.handler_type)}</span></td><td><span class="badge ${tool.enabled ? 'blue' : 'red'}">${tool.enabled ? '启用' : '停用'}</span></td><td>${Object.keys(tool.input_schema?.properties || {}).length}</td></tr>`).join('')}</tbody></table>`;
  } else {
    $('#automationContent').innerHTML = state.triggers.length ? `
      <table class="data-table"><thead><tr><th style="width:23%">触发器</th><th style="width:27%">条件</th><th style="width:25%">动作</th><th style="width:10%">策略</th><th style="width:8%">状态</th><th style="width:7%;text-align:right">操作</th></tr></thead><tbody>${state.triggers.map((trigger) => `
        <tr><td><span class="cell-main">${escapeHtml(trigger.name)}</span><span class="cell-sub">${escapeHtml(trigger.description)}</span></td><td><code class="trigger-condition">${escapeHtml(JSON.stringify(trigger.condition))}</code></td><td class="value-cell">${escapeHtml((trigger.actions || []).map((action) => action.type).join(' · '))}</td><td><span class="badge">${trigger.once_per_user ? '单次' : `${trigger.cooldown_seconds}s`}</span></td><td><span class="badge ${trigger.enabled ? 'blue' : 'red'}">${trigger.enabled ? '启用' : '停用'}</span></td><td><div class="row-actions">${isAdmin() ? `<button class="icon-button edit-trigger" data-id="${trigger.id}" title="编辑"><i data-lucide="pencil"></i></button>` : '<span class="badge">只读</span>'}</div></td></tr>`).join('')}</tbody></table>` : emptyState('workflow', '尚无触发器');
    $$('.edit-trigger').forEach((button) => button.addEventListener('click', () => editTrigger(button.dataset.id)));
  }
  refreshIcons();
}

function editTrigger(id = '') {
  if (!isAdmin()) return;
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
  closeTraceDrawer();
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

function metricStripMarkup(items) {
  return items.map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}

async function loadAdminUsers() {
  if (!isAdmin()) return;
  state.adminUsers = await api('/api/admin/users');
  $('#pageMeta').textContent = '账号权限 · 数据所有权';
  $('#usersSummary').innerHTML = metricStripMarkup([
    ['全部用户', state.adminUsers.length],
    ['可登录账号', state.adminUsers.filter((item) => item.can_login).length],
    ['仅管理档案', state.adminUsers.filter((item) => !item.can_login).length],
    ['累计反馈', state.adminUsers.reduce((sum, item) => sum + Number(item.feedback_count || 0), 0)]
  ]);
  $('#usersContent').innerHTML = state.adminUsers.length ? `<table class="data-table admin-user-table">
    <thead><tr><th style="width:23%">用户</th><th style="width:17%">登录账号</th><th style="width:12%">账号类型</th><th style="width:10%">对话</th><th style="width:10%">消息</th><th style="width:10%">记忆值</th><th style="width:9%">反馈</th><th style="width:9%;text-align:right">操作</th></tr></thead>
    <tbody>${state.adminUsers.map((user) => `<tr>
      <td><span class="user-cell"><i style="background:${escapeHtml(user.avatar_color)}">${escapeHtml(user.display_name.slice(0, 1))}</i><span><strong>${escapeHtml(user.display_name)}</strong><code>${escapeHtml(user.id)}</code></span></span></td>
      <td>${user.username ? `<code>${escapeHtml(user.username)}</code>` : '<span class="cell-sub">未开通</span>'}</td>
      <td><span class="badge ${user.can_login ? 'blue' : ''}">${user.can_login ? '注册账号' : '仅数据档案'}</span></td>
      <td>${user.conversation_count}</td><td>${user.message_count}</td><td>${user.memory_count}</td><td>${user.feedback_count}</td>
      <td><div class="row-actions"><button class="icon-button bordered" data-inspect-user="${escapeHtml(user.id)}" title="查看该用户记忆" aria-label="查看${escapeHtml(user.display_name)}的记忆"><i data-lucide="database"></i></button></div></td>
    </tr>`).join('')}</tbody></table>` : emptyState('users', '尚无用户');
  $$('[data-inspect-user]').forEach((button) => button.addEventListener('click', async () => {
    state.currentUserId = button.dataset.inspectUser;
    await switchContext();
    await navigate('memory');
  }));
  refreshIcons();
}

function renderFeedbackTurn(turn) {
  const messages = turn?.messages || [];
  return messages.map((message) => `<div class="feedback-turn-message ${escapeHtml(message.role)}"><span>${message.role === 'assistant' ? '角色' : '用户'}</span><p>${escapeHtml(message.content)}</p></div>`).join('');
}

async function loadAdminFeedback() {
  if (!isAdmin()) return;
  state.feedback = await api('/api/admin/feedback');
  $('#pageMeta').textContent = '轮次快照 · Trace 证据';
  $('#feedbackResultCount').textContent = `${state.feedback.length} 条反馈`;
  $('#feedbackSummary').innerHTML = metricStripMarkup([
    ['全部反馈', state.feedback.length],
    ['待处理', state.feedback.filter((item) => item.status === 'open').length],
    ['含 Trace', state.feedback.filter((item) => item.trace_id).length],
    ['反馈用户', new Set(state.feedback.map((item) => item.user_id)).size]
  ]);
  $('#feedbackContent').innerHTML = state.feedback.length ? state.feedback.map((item) => `
    <article class="feedback-record">
      <header><span class="user-cell"><i style="background:${escapeHtml(item.avatar_color)}">${escapeHtml(item.user_name.slice(0, 1))}</i><span><strong>${escapeHtml(item.user_name)} · ${escapeHtml(item.agent_name)}</strong><small>${formatDate(item.created_at)} · ${escapeHtml(item.conversation_title)}</small></span></span><span class="badge blue">${item.status === 'open' ? '待处理' : escapeHtml(item.status)}</span></header>
      <section class="feedback-suggestion"><span>用户建议</span><p>${escapeHtml(item.suggestion)}</p></section>
      <div class="feedback-target-line"><span>目标消息 · ${item.target_role === 'assistant' ? '角色回复' : '用户消息'}</span><p>${escapeHtml(item.target_content)}</p></div>
      <details class="feedback-turn"><summary><span><i data-lucide="messages-square"></i>查看自动抓取的完整轮次</span><b>${item.turn?.messages?.length || 0} 条消息</b></summary><div>${renderFeedbackTurn(item.turn)}</div></details>
      <footer><code>${escapeHtml(item.trace_id || '未匹配 Trace')}</code><button class="button secondary compact" data-feedback-trace="${escapeHtml(item.trace_id)}" ${item.trace_id ? '' : 'disabled'}><i data-lucide="scan-search"></i><span>查看 Trace</span></button></footer>
    </article>`).join('') : emptyState('message-square-warning', '尚无用户反馈');
  $$('[data-feedback-trace]').forEach((button) => button.addEventListener('click', () => {
    openTraceById(button.dataset.feedbackTrace).catch((error) => toast(error.message, 'error'));
  }));
  refreshIcons();
}

async function openTraceById(traceId) {
  if (!traceId) return;
  closeArchitectureAssistant();
  showTraceDrawer();
  $('#traceDrawerMeta').textContent = `反馈证据 · ${traceId.slice(-8)}`;
  $('#traceList').innerHTML = `<button class="trace-item active" data-trace-id="${escapeHtml(traceId)}"><strong><span>${escapeHtml(traceId.slice(-8))}</span><span class="badge blue">反馈关联</span></strong><span>服务端自动抓取</span></button>`;
  await loadTraceDetail(traceId);
}

async function openTraceDrawer() {
  closeArchitectureAssistant();
  showTraceDrawer();
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
    title: '新增用户数据档案',
    body: `<p class="feedback-capture-note"><i data-lucide="info"></i><span>这里只创建可用于记忆调试的数据档案，不会开通登录账号。真实用户请在登录页自助注册。</span></p><label><span>用户名</span><input name="name" required autofocus></label><label><span>显示名称</span><input name="display_name" placeholder="与用户名相同可留空"></label><label><span>标识色</span><input name="avatar_color" type="color" value="#2563eb"></label>`,
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

function setAuthMode(mode) {
  $$('[data-auth-mode]').forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
  $$('[data-auth-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.authPanel !== mode));
  $('#loginError').textContent = '';
  setTimeout(() => $(`[data-auth-panel="${mode}"] input:not(.hidden)`)?.focus(), 30);
}

async function finishAuthentication(result, fallbackRole) {
  state.session = { authenticated: true, role: result.role || fallbackRole, user: result.user || null };
  state.role = state.session.role;
  state.currentConversationId = '';
  await loadBootstrap();
  await navigate('chat');
  showApp();
}

$$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));

$('#userLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#loginUsername').value, password: $('#loginPassword').value }
    });
    $('#loginPassword').value = '';
    await finishAuthentication(result, 'user');
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  const password = $('#registerPassword').value;
  if (password !== $('#registerPasswordConfirm').value) {
    $('#loginError').textContent = '两次输入的密码不一致';
    return;
  }
  try {
    const result = await api('/api/auth/register', {
      method: 'POST',
      body: {
        username: $('#registerUsername').value,
        display_name: $('#registerDisplayName').value,
        password
      }
    });
    $('#registerPassword').value = '';
    $('#registerPasswordConfirm').value = '';
    await finishAuthentication(result, 'user');
    toast('注册成功，已进入你的独立记忆空间');
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#adminLoginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: { password: $('#adminPassword').value } });
    $('#adminPassword').value = '';
    await finishAuthentication(result, 'admin');
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.role = null;
  state.session = null;
  state.bootstrap = null;
  setAuthMode('user');
  showLogin();
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
$('#userSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#agentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#memoryUserSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#memoryAgentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#addUserButton').addEventListener('click', addUser);
$('#usersAddButton').addEventListener('click', addUser);
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
$('#closeTraceButton').addEventListener('click', closeTraceDrawer);
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
  if (!isAdmin()) return;
  try {
    await persistPersona(false);
  } catch (error) {
    if (error.code === 'ROLE_PROFILE_CHANGE_CONFIRMATION_REQUIRED') confirmPersonaProfileChange(error);
    else toast(error.message, 'error');
  }
});
$('#addPersonaAttribute').addEventListener('click', () => {
  const row = document.createElement('div');
  row.className = 'persona-attribute-row';
  row.innerHTML = `<input class="persona-attribute-key" maxlength="60" placeholder="属性名，例如 身份">
    <input class="persona-attribute-value" maxlength="600" placeholder="固定值">
    <button type="button" class="icon-button bordered remove-persona-attribute" title="删除属性" aria-label="删除属性" data-write-only><i data-lucide="trash-2"></i></button>`;
  $('.remove-persona-attribute', row).addEventListener('click', () => row.remove());
  $('#personaFixedAttributes').append(row);
  refreshIcons();
  $('.persona-attribute-key', row).focus();
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
