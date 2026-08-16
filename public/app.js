const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const appBasePath = $('meta[name="app-base-path"]')?.content || '';
const CHAT_MESSAGE_MAX_CHARACTERS = 1000;
const CONTEXT_SWITCHABLE_PAGES = new Set(['chat', 'memory', 'persona', 'automation']);

const state = {
  page: 'chat',
  portalMode: localStorage.getItem('memory_studio_portal') || '',
  role: null,
  session: null,
  bootstrap: null,
  currentUserId: localStorage.getItem('memory_studio_user') || '',
  currentAgentId: localStorage.getItem('memory_studio_agent') || '',
  currentSceneId: localStorage.getItem('memory_studio_scene') || '',
  currentConversationId: '',
  previousConversationId: '',
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
  extractionContractError: '',
  plots: [],
  props: [],
  selectedPlotId: '__root__',
  triggers: [],
  tools: [],
  automationTab: 'story',
  timelineView: 'all',
  architectureOverview: null,
  architectureSources: new Map(),
  architectureAsking: false,
  adminUsers: [],
  feedback: [],
  sending: false,
  extractingMemory: false,
  extractionStatus: null
};

const pageTitles = {
  chat: '角色对话',
  memory: '记忆查询',
  schemas: '记忆设置',
  persona: '角色设置',
  automation: '剧情与道具',
  timeline: '系统架构图',
  users: '用户列表',
  feedback: '反馈列表'
};

const userPageTitles = {
  chat: '见字如面',
  memory: '我们的故事',
  persona: '角色清单',
  automation: '剧情与道具'
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

function renderMarkdown(value) {
  const source = String(value ?? '');
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return escapeHtml(source).replaceAll('\n', '<br>');
  }
  const markup = window.marked.parse(source, { gfm: true, breaks: true, async: false });
  return window.DOMPurify.sanitize(markup, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'option']
  });
}

function secureRenderedLinks(root) {
  $$('a[href]', root).forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
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

async function streamApi(path, options = {}, onEvent = () => {}) {
  const response = await fetch(`${appBasePath}${path}`, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const authRequest = ['/api/auth/login', '/api/auth/register', '/api/admin/login'].includes(path);
    if (response.status === 401 && !authRequest) showLogin();
    const error = new Error(payload.error || `请求失败 (${response.status})`);
    error.status = response.status;
    error.code = payload.code || 'REQUEST_FAILED';
    error.details = payload.details || null;
    throw error;
  }
  if (!response.body) throw new Error('浏览器不支持流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = null;
  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      const error = new Error(event.error?.message || '流式回复失败');
      error.code = event.error?.code || 'STREAM_FAILED';
      error.details = event.error?.details || null;
      throw error;
    }
    onEvent(event);
    if (event.type === 'complete') completed = event.result;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  if (!completed) throw new Error('流式回复在完成事件前结束');
  return completed;
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
  updateTopbarContextUi();
  const memoryProfileLabel = $('#editMemoryProfileButton span');
  if (memoryProfileLabel) memoryProfileLabel.textContent = admin ? '配置说明' : '查看说明';
  const retrievalProfileLabel = $('#editRetrievalProfileButton span');
  if (retrievalProfileLabel) retrievalProfileLabel.textContent = admin ? '召回策略' : '查看召回策略';
}

function setModelConnectionStatus(label, error = false) {
  const button = $('#modelHealth');
  if (!button) return;
  const description = `模型连接：${label}，点击重新检查`;
  button.classList.toggle('error', error);
  button.title = description;
  button.setAttribute('aria-label', description);
}

function updateTopbarContextUi() {
  const contextSwitchable = CONTEXT_SWITCHABLE_PAGES.has(state.page);
  const admin = isAdmin();
  const selectedUser = currentUser();
  const sessionUser = state.session?.user;
  const accountUser = admin && contextSwitchable ? selectedUser : sessionUser;
  $('#topbarContext')?.classList.toggle('hidden', !contextSwitchable);
  $('#userSelect')?.classList.toggle('hidden', !admin || !contextSwitchable);
  $('#accountName')?.classList.toggle('hidden', admin && contextSwitchable);
  if ($('#accountName')) $('#accountName').textContent = admin ? '管理员' : (sessionUser?.display_name || '普通用户');
  const avatar = $('#userAvatar');
  if (avatar) {
    avatar.textContent = accountUser?.display_name?.slice(0, 1) || (admin ? '管' : '用');
    avatar.style.background = accountUser?.avatar_color || '#2563eb';
  }
  const accountLabel = admin
    ? (contextSwitchable ? `管理员正在查看 ${selectedUser?.display_name || '未选择用户'}` : '管理员账户')
    : `${sessionUser?.display_name || '普通用户'}账户`;
  $('#accountControl').title = accountLabel;
  $('#logoutButton').title = `退出${admin ? '管理员' : ''}登录`;
  $('#logoutButton').setAttribute('aria-label', `退出${admin ? '管理员' : ''}登录`);
}

function applyPortalUi() {
  const userMode = state.portalMode === 'user';
  document.body.dataset.portalMode = state.portalMode;
  $('#managementNav').classList.toggle('hidden', userMode);
  $('#userNav').classList.toggle('hidden', !userMode);
  $$('[data-portal-mode]').forEach((button) => {
    const active = button.dataset.portalMode === state.portalMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#pageTitle').textContent = (userMode ? userPageTitles : pageTitles)[state.page] || pageTitles[state.page] || '';
}

async function switchPortalMode(mode) {
  if (!['management', 'user'].includes(mode) || mode === state.portalMode) return;
  state.portalMode = mode;
  localStorage.setItem('memory_studio_portal', mode);
  if (mode === 'user' && !Object.hasOwn(userPageTitles, state.page)) state.page = 'chat';
  applyPortalUi();
  await navigate(state.page);
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
  if (!['management', 'user'].includes(state.portalMode)) {
    state.portalMode = state.role === 'admin' ? 'management' : 'user';
    localStorage.setItem('memory_studio_portal', state.portalMode);
  }
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
  const providerName = state.bootstrap.models?.textProvider || 'model';
  setModelConnectionStatus(providerName === 'mock' ? 'Mock 模式' : `${providerName.toUpperCase()} 已配置`);
  renderSelectors();
  renderAgentHeader();
  applyRoleUi();
  applyPortalUi();
  await loadConversations();
  refreshIcons();
}

function renderSelectors() {
  const userOptions = state.bootstrap.users.map((user) =>
    `<option value="${escapeHtml(user.id)}" ${user.id === state.currentUserId ? 'selected' : ''}>${escapeHtml(user.display_name)}</option>`
  ).join('');
  const agentOptions = state.bootstrap.agents.map((agent) => {
    const scene = sceneForAgent(agent);
    const label = `${scene?.name || scenarioLabel(agent.scenario_type)} · ${agent.name}`;
    return `<option value="${escapeHtml(agent.id)}" ${agent.id === state.currentAgentId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  $('#userSelect').innerHTML = userOptions;
  $('#agentSelect').innerHTML = agentOptions;
  $('#memoryUserSelect').innerHTML = userOptions;
  $('#memoryAgentSelect').innerHTML = agentOptions;
  updateTopbarContextUi();
}

function renderAgentHeader() {
  const agent = currentAgent();
  if (!agent) return;
  $('#chatAgentName').textContent = agent.name;
  $('#chatAgentDescription').textContent = agent.description;
  $('#agentAvatar').textContent = agent.name.slice(0, 1);
  $('#agentAvatar').style.background = agent.avatar_color;
  const scene = sceneForAgent(agent);
  $('#pageMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · main_story / main`;
}

async function switchContext() {
  state.currentConversationId = '';
  state.previousConversationId = '';
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
  state.extractionStatus = null;
  const agent = currentAgent();
  const user = currentUser();
  $('#messageList').innerHTML = `
    <div class="message-row assistant"><span class="message-avatar" style="background:${escapeHtml(agent?.avatar_color || '#2563eb')}">${escapeHtml(agent?.name?.slice(0, 1) || '角')}</span><div class="message-body"><div class="message-bubble markdown-body">${renderMarkdown(agent?.greeting || '今天想聊什么？')}</div></div></div>`;
  secureRenderedLinks($('#messageList'));
  renderExtractionStatus();
  loadUnlockedCatalog().catch(() => {});
}

async function openConversation(id) {
  if (state.currentConversationId && state.currentConversationId !== id) {
    state.previousConversationId = state.currentConversationId;
  }
  const payload = await api(`/api/conversations/${encodeURIComponent(id)}?user_id=${encodeURIComponent(state.currentUserId)}`);
  state.currentConversationId = id;
  state.messages = payload.messages;
  renderConversations();
  renderMessages();
  await loadChatUtilities();
}

function renderMessages(extraHtml = '') {
  const root = $('#messageList');
  const agent = currentAgent();
  const user = currentUser();
  root.innerHTML = state.messages.map((message) => `
    <div class="message-row ${message.role}">
      <span class="message-avatar" style="background:${escapeHtml(message.role === 'assistant' ? (agent?.avatar_color || '#2563eb') : (user?.avatar_color || '#2563eb'))}">${escapeHtml(message.role === 'assistant' ? (agent?.name?.slice(0, 1) || '角') : (user?.display_name?.slice(0, 1) || '你'))}</span>
      <div class="message-body">
        <div class="message-bubble markdown-body">${renderMarkdown(message.content)}</div>
        <div class="message-meta"><time>${formatDate(message.created_at)}</time>${String(message.id).startsWith('local_') ? '' : `<button class="message-feedback-button" data-feedback-message="${escapeHtml(message.id)}" title="对这条消息提反馈" aria-label="对这条消息提反馈"><i data-lucide="message-square-warning"></i></button>`}</div>
      </div>
    </div>`).join('') + extraHtml;
  secureRenderedLinks(root);
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

function updateMessageLength() {
  const count = Array.from($('#messageInput').value).length;
  const label = $('#messageLength');
  label.textContent = `${count} / ${CHAT_MESSAGE_MAX_CHARACTERS}`;
  label.classList.toggle('over-limit', count > CHAT_MESSAGE_MAX_CHARACTERS);
}

function updateComposerAvailability() {
  const frozen = state.sending || state.extractingMemory;
  $('#sendButton').disabled = frozen;
  $('#messageInput').disabled = state.extractingMemory;
  $('#memoryExtractionButton').disabled = frozen || !state.extractionStatus?.canExtract;
  $('#composerForm').classList.toggle('frozen', state.extractingMemory);
}

function renderExtractionStatus() {
  const status = state.extractionStatus || {
    pendingTurns: 0,
    intervalTurns: Number(state.eventExtractionProfile?.extraction_interval_turns || 8),
    progress: 0,
    canExtract: false
  };
  const progress = Math.max(0, Math.min(1, Number(status.progress || 0)));
  $('#memoryExtractionProgress').style.setProperty('--progress', `${Math.round(progress * 360)}deg`);
  const button = $('#memoryExtractionButton');
  const title = state.extractingMemory
    ? '正在更新长期记忆'
    : `长期记忆进度 ${Number(status.pendingTurns || 0)} / ${Number(status.intervalTurns || 0)} 轮，点击立即更新`;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.classList.toggle('extracting', state.extractingMemory);
  updateComposerAvailability();
}

function scopedCatalogQuery() {
  return new URLSearchParams({
    user_id: state.currentUserId,
    agent_id: state.currentAgentId,
    story_id: 'main_story',
    branch_id: 'main'
  });
}

async function loadUnlockedCatalog() {
  if (!state.currentUserId || !state.currentAgentId) return;
  const query = scopedCatalogQuery();
  const [plots, props] = await Promise.all([
    api(`/api/plots?${query}`),
    api(`/api/props?${query}`)
  ]);
  state.plots = plots;
  state.props = props;
  const unlockedPlotCount = plots.filter((item) => ['unlocked', 'active', 'completed'].includes(item.user_status)).length;
  const unlockedPropCount = props.filter((item) => ['unlocked', 'active'].includes(item.user_status)).length;
  $('#unlockedPlotsCount').textContent = unlockedPlotCount;
  $('#unlockedPropsCount').textContent = unlockedPropCount;
}

async function loadChatUtilities() {
  const tasks = [loadUnlockedCatalog()];
  if (state.currentConversationId) {
    tasks.push(api(`/api/conversations/${encodeURIComponent(state.currentConversationId)}/memory-extraction`)
      .then((status) => { state.extractionStatus = status; }));
  } else {
    state.extractionStatus = null;
  }
  await Promise.all(tasks);
  renderExtractionStatus();
}

async function extractMemoryNow() {
  if (!state.currentConversationId) return;
  if (!state.extractionStatus?.canExtract || state.sending || state.extractingMemory) return;
  state.extractingMemory = true;
  renderExtractionStatus();
  try {
    const result = await api(`/api/conversations/${encodeURIComponent(state.currentConversationId)}/memory-extraction`, {
      method: 'POST'
    });
    state.extractionStatus = result.status;
    renderExtractionStatus();
    await loadUnlockedCatalog();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.extractingMemory = false;
    renderExtractionStatus();
    $('#messageInput').focus();
  }
}

function openUnlockedProps() {
  const items = state.props.filter((item) => ['unlocked', 'active'].includes(item.user_status));
  openModal({
    title: '已解锁道具',
    readOnly: true,
    width: 680,
    body: items.length ? `<div class="unlocked-quick-list">${items.map((item) => {
      const presentation = userPropPresentation(item);
      return `<article><span class="quick-item-icon"><i data-lucide="${presentation.icon}"></i></span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(presentation.description)}</p><small>${escapeHtml(presentation.label)} · 已可在剧情中使用</small></div><span class="badge blue">已解锁</span></article>`;
    }).join('')}</div>`
      : emptyState('package-open', '还没有解锁道具')
  });
}

function openUnlockedPlots() {
  const items = state.plots.filter((item) => ['unlocked', 'active', 'completed'].includes(item.user_status));
  openModal({
    title: '已解锁剧情',
    readOnly: true,
    width: 680,
    body: items.length ? `<div class="unlocked-quick-list">${items.map((item) => `
      <article><span class="quick-item-icon"><i data-lucide="scroll-text"></i></span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.premise || '剧情已经向你打开。')}</p><small>${escapeHtml(item.branch_label || '主线')} · ${formatDate(item.unlocked_at)}</small></div><span class="badge blue">${escapeHtml(item.user_status === 'completed' ? '已完成' : '已解锁')}</span></article>`).join('')}</div>`
      : emptyState('scroll-text', '还没有解锁剧情')
  });
}

async function sendMessage(text) {
  const message = text.trim();
  if (state.sending || state.extractingMemory || !message) return;
  const messageCharacters = Array.from(message).length;
  if (messageCharacters > CHAT_MESSAGE_MAX_CHARACTERS) {
    toast(`单条消息最多 ${CHAT_MESSAGE_MAX_CHARACTERS} 字，当前为 ${messageCharacters} 字`, 'error');
    $('#messageInput').focus();
    return;
  }
  state.sending = true;
  updateComposerAvailability();
  $('#messageInput').value = '';
  $('#messageInput').style.height = 'auto';
  updateMessageLength();
  const optimistic = {
    id: `local_${Date.now()}`,
    role: 'user',
    content: message,
    created_at: new Date().toISOString()
  };
  state.messages.push(optimistic);
  const agent = currentAgent();
  renderMessages(`<div class="message-row assistant" id="streamingRow"><span class="message-avatar" style="background:${escapeHtml(agent?.avatar_color || '#2563eb')}">${escapeHtml(agent?.name?.slice(0, 1) || '角')}</span><div class="message-body"><div class="message-bubble thinking" id="streamingBubble"><i></i><i></i><i></i></div></div></div>`);
  let streamedText = '';
  const renderStreamedText = () => {
    const bubble = $('#streamingBubble');
    if (!bubble) return;
    if (!streamedText) {
      bubble.classList.add('thinking');
      bubble.classList.remove('markdown-body');
      bubble.innerHTML = '<i></i><i></i><i></i>';
    } else {
      bubble.classList.remove('thinking');
      bubble.classList.add('markdown-body');
      bubble.innerHTML = renderMarkdown(streamedText);
      secureRenderedLinks(bubble);
    }
    const messageList = $('#messageList');
    messageList.scrollTop = messageList.scrollHeight;
  };
  try {
    const result = await streamApi('/api/chat', {
      method: 'POST',
      body: {
        user_id: state.currentUserId,
        agent_id: state.currentAgentId,
        conversation_id: state.currentConversationId,
        previous_conversation_id: state.previousConversationId,
        message
      }
    }, (event) => {
      if (event.type === 'turn_start') {
        streamedText = '';
        renderStreamedText();
      }
      if (event.type === 'delta' && event.delta) {
        streamedText += event.delta;
        renderStreamedText();
      }
    });
    streamedText = String(result.message?.content || streamedText);
    renderStreamedText();
    state.currentConversationId = result.conversation.id;
    state.extractionStatus = result.memoryExtraction || state.extractionStatus;
    renderExtractionStatus();
    if (result.diagnostics?.previousMemoryFlushStatus !== 'degraded') state.previousConversationId = '';
    await loadConversations();
  } catch (error) {
    state.messages = state.messages.filter((item) => item.id !== optimistic.id);
    renderMessages();
    toast(error.message, 'error');
  } finally {
    state.sending = false;
    updateComposerAvailability();
    $('#messageInput').focus();
  }
}

function navigate(page) {
  if (!isAdmin() && ['users', 'feedback'].includes(page)) page = 'chat';
  if (state.portalMode === 'user' && !Object.hasOwn(userPageTitles, page)) page = 'chat';
  state.page = page;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $$('.page').forEach((item) => item.classList.toggle('active', item.id === `page-${page}`));
  $('#pageTitle').textContent = (state.portalMode === 'user' ? userPageTitles : pageTitles)[page] || pageTitles[page];
  updateTopbarContextUi();
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
  if (state.page === 'chat') await loadChatUtilities();
  if (state.page === 'memory') await loadMemory();
  if (state.page === 'schemas') await loadSchemas();
  if (state.page === 'persona') await loadPersona();
  if (state.page === 'automation') await loadAutomation();
  if (state.page === 'timeline') await loadArchitectureOverview();
  if (state.page === 'users') await loadAdminUsers();
  if (state.page === 'feedback') await loadAdminFeedback();
  applyRoleUi();
  applyPortalUi();
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
  const {
    thresholds, compression, timing, index, scene, runtime = {}, capabilities = {}, graphStore = {}, temporal = {}
  } = state.architectureOverview;
  const main = thresholds.mainModel;
  const extraction = thresholds.extraction;
  const extractionInterval = Math.max(1, Number(extraction.intervalTurns || 1));
  $('#pageMeta').textContent = `${scene.name} · runtime / memory / retrieval`;
  $('#architectureMainWindow').textContent = `最近 ${main.messageLimit} 条消息 · 约 ${main.approximateTurns} 轮`;
  $('#architectureExtractionWindow').textContent = `批次前 ${extraction.contextTurns} 轮 · 最多 ${extraction.messageLimit} 条`;
  $('#architectureEventThreshold').textContent = `每 ${extractionInterval} 轮 · 跨对话补齐尾批次 · 最多 ${extraction.maxEventsPerBatch} 个事件`;
  $('#architectureRuntimeExtractionMode').textContent = `阻塞式 · 每 ${extractionInterval} 轮 / 跨对话更新`;
  $('#architectureRuntimeName').textContent = runtime.name === 'pi-agent-core'
    ? `Pi Agent Core ${runtime.version ? `v${runtime.version}` : ''}` : 'Legacy Runtime';
  $('#architecturePiNodeMeta').textContent = runtime.name === 'pi-agent-core'
    ? `ReAct 工具循环已启用 · 最多 ${Number(runtime.maxToolCalls || 0)} 次工具 / ${Number(runtime.maxModelTurns || 0)} 次模型请求 · ${capabilities.mcpClient || 'MCP Client'}`
    : 'Legacy 模式 · 可通过 AGENT_RUNTIME=pi 启用';
  $('#architectureTemporalNodeMeta').textContent = temporal.model === 'bitemporal'
    ? '抽取 → 双时态版本 → Neo4j 投影 → 触发'
    : '抽取 → 结构化派生 → 事件图谱 → 触发';
  $('#architectureSqliteNodeMeta').textContent = '双时态账本、向量、Trace、outbox；大规模混合检索可增 OpenSearch';
  const graphReady = graphStore.mode === 'neo4j' && graphStore.connected;
  $('#architectureNeo4jNodeMeta').textContent = graphStore.mode === 'neo4j'
    ? `${graphReady ? '已连接' : '降级回退'} · 待投影 ${Number(graphStore.pendingProjections || 0)} 个 scope`
    : (graphStore.mode === 'sqlite'
      ? 'SQLite 降级模式 · 设置 GRAPH_STORE=neo4j 后启用投影'
      : '运行态未连接 · Compose/生产环境默认启用 Neo4j');
  $('#architectureExtractionNodeTitle').textContent = `长期记忆更新（每 ${extractionInterval} 轮）`;
  $('#architectureExtractionStepTitle').textContent = '长期记忆更新';
  $('#architectureCompressionStatus').textContent = compression.rollingSummaryEnabled ? '滚动摘要已启用' : '滚动摘要未启用';
  $('#architectureRecentContext').textContent = `最近 ${main.messageLimit} 条原文`;
  $('#architectureInputLimit').textContent = `0 < X ≤ ${main.messageLimit}`;
  $('#architectureMessageLimit').textContent = `X ≤ ${main.messageLimit}`;
  $('#architectureHistoryLimit').textContent = `最多 ${Math.max(0, main.messageLimit - 1)} 条 user / assistant 原文`;
  $('#architectureExtractionTrigger').textContent = `累计 ${extractionInterval} 轮，或跨对话发送前，抽取并更新长期记忆`;
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
  const userMode = state.portalMode === 'user';
  $('#memoryUserView').classList.toggle('hidden', !userMode);
  $('#memoryAdminView').classList.toggle('hidden', userMode);
  if (userMode) {
    const params = new URLSearchParams(scopeQuery());
    params.set('order', 'story');
    [state.memoryValues, state.events] = await Promise.all([
      api(`/api/memory/values?${scopeQuery()}`),
      api(`/api/memory/events?${params}`)
    ]);
    await loadUnlockedCatalog();
    renderUserStoryView();
    return;
  }
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

function memoryValueByKey(key) {
  return state.memoryValues.find((item) => item.key === key)?.value;
}

function renderUserStoryView() {
  const user = currentUser();
  const agent = currentAgent();
  const stage = memoryValueByKey('relationship.stage') || '初识';
  const intimacy = Number(memoryValueByKey('relationship.intimacy') || 0);
  const trust = Number(memoryValueByKey('relationship.trust') || 0);
  const address = memoryValueByKey('identity.preferred_address') || user?.display_name || '你';
  const sharedEvents = state.events.filter((item) => item.memory_space === 'shared_story');
  const storyEvents = (sharedEvents.length ? sharedEvents : state.events).slice(0, 12);
  const activePlots = state.plots.filter((item) => ['unlocked', 'active', 'completed'].includes(item.user_status));
  const activeProps = state.props.filter((item) => ['unlocked', 'active'].includes(item.user_status));
  const mustRules = memoryValueByKey('response.must_rules') || [];
  const boundaries = memoryValueByKey('relationship.boundaries') || [];
  $('#pageMeta').textContent = `${user?.display_name || ''} × ${agent?.name || ''} · main_story`;
  $('#memoryUserView').innerHTML = `
    <header class="user-story-hero">
      <div class="story-portrait-pair"><span style="background:${escapeHtml(user?.avatar_color || '#2563eb')}">${escapeHtml(user?.display_name?.slice(0, 1) || '你')}</span><i data-lucide="sparkles"></i><span style="background:${escapeHtml(agent?.avatar_color || '#2563eb')}">${escapeHtml(agent?.name?.slice(0, 1) || '角')}</span></div>
      <div><span class="eyebrow">OUR STORY</span><h3>${escapeHtml(address)}与${escapeHtml(agent?.name || '角色')}的故事</h3><p>那些被你确认、被时间留下的片段，会在这里继续生长。</p></div>
      <span class="relationship-stage">${escapeHtml(stage)}</span>
    </header>
    <section class="relationship-ribbon" aria-label="关系状态">
      <div><span>亲密度</span><strong>${intimacy}</strong><i><b style="width:${Math.min(100, intimacy)}%"></b></i></div>
      <div><span>信任度</span><strong>${trust}</strong><i><b style="width:${Math.min(100, trust)}%"></b></i></div>
      <div><span>已解锁剧情</span><strong>${activePlots.length}</strong><small>个故事节点</small></div>
      <div><span>已拥有道具</span><strong>${activeProps.length}</strong><small>件能力道具</small></div>
    </section>
    <div class="user-story-layout">
      <section class="story-memory-stream">
        <header><div><span class="eyebrow">MOMENTS</span><h4>故事片段</h4></div><span>${storyEvents.length} 个片段</span></header>
        <div class="story-moment-list">${storyEvents.length ? storyEvents.map((event, index) => `
          <article><span class="moment-index">${String(index + 1).padStart(2, '0')}</span><div><time>${escapeHtml(event.story_time || formatDate(event.created_at, false))}</time><h5>${escapeHtml(event.title)}</h5><p>${escapeHtml(event.summary)}</p><span>${event.memory_space === 'shared_story' ? '共同故事' : '长期记忆'} · ${escapeHtml(event.event_type)}</span></div></article>`).join('') : emptyState('book-dashed', '还没有被确认的共同故事')}</div>
      </section>
      <aside class="story-keepsakes">
        <section><header><i data-lucide="hand-heart"></i><h4>彼此的约定</h4></header>${[...mustRules, ...boundaries].length ? `<ul>${[...mustRules, ...boundaries].slice(0, 8).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>还没有写下长期约定。</p>'}</section>
        <section><header><i data-lucide="scroll-text"></i><h4>正在展开</h4></header>${activePlots.length ? activePlots.slice(0, 4).map((plot) => `<div class="keepsake-line"><span>${escapeHtml(plot.branch_label || '主线')}</span><strong>${escapeHtml(plot.name)}</strong></div>`).join('') : '<p>新的剧情尚未解锁。</p>'}</section>
      </aside>
    </div>`;
  refreshIcons();
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
      <header><div><i data-lucide="binary"></i><strong>Query Embedding</strong></div><span class="badge ${embedding.fallback ? 'red' : 'blue'}">${embedding.fallback ? '本地降级' : `${escapeHtml((embedding.provider || 'provider').toUpperCase())} 实时请求`}</span></header>
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
    state.extractionContractError = '';
    return;
  }
  const [profileResult, contractResult] = await Promise.allSettled([
    api(`/api/scenes/${encodeURIComponent(sceneId)}/event-extraction-profile`),
    api(`/api/scenes/${encodeURIComponent(sceneId)}/extraction-contract`)
  ]);
  if (profileResult.status === 'rejected') throw profileResult.reason;
  state.eventExtractionProfile = profileResult.value;
  state.extractionContract = contractResult.status === 'fulfilled' ? contractResult.value : null;
  state.extractionContractError = contractResult.status === 'rejected' ? contractResult.reason.message : '';
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

function addScene() {
  if (!isAdmin()) return;
  openModal({
    title: '新建场景',
    width: 620,
    submitLabel: '创建场景与记忆设置',
    body: `<label><span>场景名称</span><input name="name" maxlength="80" placeholder="例如：远行书信" required autofocus></label>
      <label><span>场景说明</span><textarea name="description" rows="3" maxlength="1000" placeholder="说明该场景的关系、任务或故事边界"></textarea></label>
      <div class="form-grid two"><label><span>场景图标</span><select name="icon"><option value="sparkles">星光</option><option value="book-heart">故事</option><option value="graduation-cap">学习</option><option value="map">旅途</option><option value="briefcase-business">工作</option></select></label><label><span>强调色</span><input name="accent_color" type="color" value="#2563eb"></label></div>
      <div class="creation-bundle-note"><i data-lucide="layers-3"></i><span><strong>系统会同步创建</strong><small>1 份结构化记忆设置、1 份长期记忆抽取配置、1 份混合召回策略。</small></span></div>`,
    onSubmit: async (formData) => {
      const scene = await api('/api/scenes', { method: 'POST', body: Object.fromEntries(formData.entries()) });
      state.currentSceneId = scene.id;
      localStorage.setItem('memory_studio_scene', state.currentSceneId);
      await loadBootstrap();
      await navigate('schemas');
      toast('场景与配套记忆设置已创建');
    }
  });
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
    ['长期记忆更新', `每 ${profile.extraction_interval_turns || 8} 轮`],
    ['抽取辅助上下文', `批次前 ${profile.context_turns} 轮 / 最多 ${contract?.runtime?.historyMessageLimit || profile.context_turns * 2} 条`],
    ['批次写入上限', `${contract?.runtime?.maxEventsPerBatch || Math.min(30, (profile.extraction_interval_turns || 8) * profile.max_events_per_turn)} 事件`]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('#schemaResultCount').textContent = '4 类抽取对象';

  const configuredTypes = profile.allowed_event_types || [];
  const knownTypes = new Set(eventTypeOptions.map(([value]) => value));
  const options = [...eventTypeOptions, ...configuredTypes.filter((value) => !knownTypes.has(value)).map((value) => [value, value])];
  const fieldInstructions = contract?.fieldInstructions || [];
  const promptSystem = contract?.prompt?.system || '当前无可用预览';
  const promptUser = contract?.prompt?.user || (state.extractionContractError
    ? `完整 Input 预览加载失败：${state.extractionContractError}`
    : '当前无可用预览');
  $('#schemaTable').innerHTML = `<section class="extraction-settings">
    <div class="extraction-runtime-contract">
      <div><span>TURN END</span><i data-lucide="message-square"></i><strong>assistant 回复落库</strong><small>1 轮 = user 消息 + assistant 回复</small></div>
      <i data-lucide="arrow-right"></i>
      <div class="active"><span>EVERY ${profile.extraction_interval_turns || 8} TURNS</span><i data-lucide="scan-text"></i><strong>长期记忆更新</strong><small>抽取结构字段、事件与图谱，统一对齐逐条消息证据</small></div>
      <i data-lucide="arrow-right"></i>
      <div><span>COMMIT BARRIER</span><i data-lucide="database"></i><strong>状态派生与图谱提交</strong><small>提交完成后 /api/chat 才返回</small></div>
    </div>
    <form id="eventExtractionForm" class="extraction-form" data-config-form>
      <section class="extraction-form-section">
        <header><span>01</span><div><strong>短期记忆与长期更新机制</strong><small>短期对话每轮直接进入主模型；达到阈值后，待抽取批次与批次前的辅助上下文分开传入抽取模型</small></div></header>
        <div class="turn-definition-banner">
          <div><i data-lucide="repeat-2"></i><span><strong>一轮如何计算</strong><small>1 条 user 消息 + 1 条 assistant 回复</small></span></div>
          <div><i data-lucide="flag"></i><span><strong>一轮何时结束</strong><small>assistant 回复成功写入 messages 表</small></span></div>
          <div><i data-lucide="lock-keyhole"></i><span><strong>长期更新屏障</strong><small>第 X 轮或跨对话尾批次提交完成后才解锁</small></span></div>
        </div>
        <div class="form-grid two extraction-runtime-fields">
          <label><span>每 X 轮更新长期记忆</span><input id="extractionIntervalTurns" name="extraction_interval_turns" type="number" min="1" max="${contract?.runtime?.extractionIntervalMaxTurns || 8}" step="1" value="${profile.extraction_interval_turns || 8}" required><small>短期记忆上限约 ${contract?.runtime?.shortTermMemoryTurnCapacity || 8} 轮；X 可调低但不能超过上限。未满 X 轮就切换或新建对话时，会在下一次发送前补写旧对话尾批次</small></label>
          <label><span>抽取辅助上下文（轮）</span><input id="extractionContextTurns" name="context_turns" type="number" min="1" max="10" step="1" value="${profile.context_turns}" required><small id="turnWindowMessageLimit">取待抽取批次之前的只读对话，用来理解“它、那件事、还是改到银座”等代词或省略表达；最多 ${contract?.runtime?.historyMessageLimit || profile.context_turns * 2} 条，不会重复写入长期记忆</small></label>
          <label><span>触发点（系统固定）</span><input id="extractionTriggerPreview" value="累计 ${profile.extraction_interval_turns || 8} 轮；或跨对话发送前" disabled><small>threshold_or_conversation_boundary</small></label>
          <label><span>执行模式（系统固定）</span><input value="同一请求同步阻塞" disabled><small>blocking_after_assistant</small></label>
        </div>
        <div class="extraction-switches">
          <label class="strategy-toggle"><span><strong>启用长期记忆更新</strong><small>关闭后只保留短期原始对话与用户显式控制快通道</small></span><span class="toggle-control"><input name="enabled" type="checkbox" ${profile.enabled ? 'checked' : ''}><i></i></span></label>
          <label class="strategy-toggle"><span><strong>将 assistant 回复传入抽取模型</strong><small>用于识别角色言行与共同故事，不能单独写成用户事实</small></span><span class="toggle-control"><input name="include_assistant" type="checkbox" ${profile.include_assistant ? 'checked' : ''}><i></i></span></label>
        </div>
        <div class="strategy-locked-guard"><i data-lucide="pin"></i><div><strong>显式长期规则快通道</strong><span>“必须 / 一定要 / 不要 / 别再”等明确要求会先区分长期规则与剧情台词，通过边界校验后立即写入“必须遵守 / 避免事项”并固定注入，不等待 X 轮。</span></div><span class="badge blue">同步</span></div>
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
          <label><span>每轮最大事件数</span><input name="max_events_per_turn" type="number" min="1" max="10" step="1" value="${profile.max_events_per_turn}" required><small>单次批次硬上限 = 每轮上限 × 实际批次轮数，最高 30</small></label>
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
          <span><i data-lucide="shield-check"></i><strong>只写待抽取批次</strong><small>批次前的辅助上下文只用于理解代词、省略和承接关系</small></span>
          <span><i data-lucide="shield-check"></i><strong>旧值标记为“已被新版本替代”</strong><small>当前有效版本才进入默认回答</small></span>
          <span><i data-lucide="shield-check"></i><strong>助手情节不等于用户事实</strong><small>必须有用户承接证据</small></span>
          <span><i data-lucide="shield-check"></i><strong>作用域硬隔离</strong><small>user / agent / story / branch</small></span>
        </div>
      </section>
      <section class="extraction-form-section prompt-preview-section">
        <header><span>05</span><div><strong>当前生效的完整模型 Input</strong><small>来自同一个服务端编译器，与真实抽取共用代码；运行时占位符会替换为待抽取批次</small></div><button id="copyExtractionPrompt" class="button secondary compact" type="button"><i data-lucide="copy"></i>复制 Input</button></header>
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
    $('#turnWindowMessageLimit').textContent = `最多读取 ${Math.min(20, turns * 2)} 条批次前的只读辅助消息，不含待抽取批次，也不会重复写入长期记忆`;
  });
  const intervalTurnsInput = $('#extractionIntervalTurns');
  intervalTurnsInput?.addEventListener('input', () => {
    const maximum = contract?.runtime?.extractionIntervalMaxTurns || 8;
    const turns = Math.max(1, Math.min(maximum, Number(intervalTurnsInput.value) || 1));
    $('#extractionTriggerPreview').value = `累计 ${turns} 轮；或跨对话发送前`;
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
        extraction_interval_turns: Number(formData.get('extraction_interval_turns')),
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
  const userMode = state.portalMode === 'user';
  $('#personaUserView').classList.toggle('hidden', !userMode);
  $('#personaAdminView').classList.toggle('hidden', userMode);
  if (userMode) {
    renderUserRoleCatalog();
    return;
  }
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
  $('#personaHeaderMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · 人设 v${Number(agent.profile_version || 1)} · 每轮固定注入`;
  $('#personaAvatar').textContent = agent.name.slice(0, 1);
  $('#personaAvatar').style.background = agent.avatar_color;
  $('#pageMeta').textContent = `${scene?.name || scenarioLabel(agent.scenario_type)} · ${agent.name}专属配置`;
  applyRoleUi();
}

function renderUserRoleCatalog() {
  const selectedAgent = currentAgent();
  $('#pageMeta').textContent = `${state.bootstrap.agents.length} 位角色 · 选择一段相遇`;
  $('#personaUserView').innerHTML = `
    <header class="user-role-hero"><span class="eyebrow">CHARACTER BOOK</span><h3>想和谁继续写信？</h3><p>每个角色有自己的性格、场景与故事记忆。切换角色不会串联彼此的私密经历。</p></header>
    <div class="user-role-grid">${state.bootstrap.agents.filter((agent) => agent.enabled).map((agent) => {
      const scene = sceneForAgent(agent);
      const selected = agent.id === selectedAgent?.id;
      const attributes = Object.entries(parseJson(agent.fixed_attributes_json, {})).slice(0, 3);
      return `<article class="user-role-card ${selected ? 'selected' : ''}" style="--role-color:${escapeHtml(agent.avatar_color || '#2563eb')}">
        <header><span class="role-card-avatar" style="background:${escapeHtml(agent.avatar_color || '#2563eb')}">${escapeHtml(agent.name.slice(0, 1))}</span><span class="role-scene">${escapeHtml(scene?.name || scenarioLabel(agent.scenario_type))}</span>${selected ? '<span class="badge blue">当前角色</span>' : ''}</header>
        <div><h4>${escapeHtml(agent.name)}</h4><p>${escapeHtml(agent.description)}</p></div>
        <div class="role-attribute-chips">${attributes.map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('')}</div>
        <blockquote>${escapeHtml(agent.greeting || '今天想聊什么？')}</blockquote>
        <button class="button ${selected ? 'secondary' : 'primary'} wide choose-user-role" data-role-id="${escapeHtml(agent.id)}"><i data-lucide="mail-open"></i><span>${selected ? '继续见字' : '与 TA 见字'}</span></button>
      </article>`;
    }).join('')}</div>`;
  $$('.choose-user-role', $('#personaUserView')).forEach((button) => button.addEventListener('click', async () => {
    if (button.dataset.roleId !== state.currentAgentId) {
      state.currentAgentId = button.dataset.roleId;
      await switchContext();
    }
    await navigate('chat');
  }));
  refreshIcons();
}

function addAgent() {
  if (!isAdmin()) return;
  openModal({
    title: '新建角色',
    width: 720,
    submitLabel: '创建角色',
    body: `<div class="form-grid two"><label><span>角色名称</span><input name="name" maxlength="80" required autofocus></label><label><span>所属场景</span><select name="scene_id" required>${state.bootstrap.scenes.map((scene) => `<option value="${escapeHtml(scene.id)}">${escapeHtml(scene.name)}</option>`).join('')}</select></label></div>
      <label><span>角色摘要</span><input name="description" maxlength="500" placeholder="一句话说明角色气质和陪伴方式"></label>
      <label><span>开场语</span><textarea name="greeting" rows="2" placeholder="你来了。今天想从哪里聊起？"></textarea></label>
      <label><span>核心人设提示词</span><textarea name="system_prompt" rows="10" required placeholder="定义角色身份、表达方式、关系边界和事实约束"></textarea></label>
      <div class="form-grid two"><label><span>头像颜色</span><input name="avatar_color" type="color" value="#2563eb"></label><label><span>初始固定属性</span><input name="identity" placeholder="例如：独立书店主理人"></label></div>`,
    onSubmit: async (formData) => {
      const identity = String(formData.get('identity') || '').trim();
      const agent = await api('/api/agents', {
        method: 'POST',
        body: {
          ...Object.fromEntries(formData.entries()),
          fixed_attributes: identity ? { 身份: identity } : {}
        }
      });
      state.currentAgentId = agent.id;
      await loadBootstrap();
      await navigate('persona');
      toast('角色已创建');
    }
  });
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

const storyNodeMeta = {
  chapter: { label: '章节', icon: 'book-open' },
  branch: { label: '分支', icon: 'git-branch' },
  ending: { label: '结局', icon: 'flag' }
};

const memoryKeyLabels = {
  'identity.gender': '用户性别',
  'relationship.intimacy': '亲密度',
  'relationship.trust': '信任度',
  'relationship.stage': '关系阶段',
  'education.mastery': '知识点掌握度'
};

function plotById(id) {
  return state.plots.find((plot) => plot.id === id);
}

function triggersForPlot(plotId) {
  return state.triggers.filter((trigger) => (trigger.actions || []).some((action) =>
    ['unlock_plot', 'unlock_story_chapter'].includes(action.type) && action.plot_id === plotId));
}

function plotTargetsForTrigger(trigger) {
  return (trigger.actions || [])
    .filter((action) => ['unlock_plot', 'unlock_story_chapter'].includes(action.type) && action.plot_id)
    .map((action) => plotById(action.plot_id))
    .filter(Boolean);
}

function formatConditionValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function describeCondition(condition) {
  if (!condition || typeof condition !== 'object') return '未配置条件';
  if (Array.isArray(condition.all)) return condition.all.map(describeCondition).join(' 且 ');
  if (Array.isArray(condition.any)) return condition.any.map(describeCondition).join(' 或 ');
  if (condition.not) return `非（${describeCondition(condition.not)}）`;
  if (condition.memory_key) {
    const label = memoryKeyLabels[condition.memory_key] || condition.memory_key;
    return `${label} ${condition.operator || '=='} ${formatConditionValue(condition.value)}`;
  }
  if (condition.plot_id) {
    const plot = plotById(condition.plot_id);
    return `剧情「${plot?.name || condition.plot_id}」状态 ${condition.operator || '=='} ${formatConditionValue(condition.value || 'unlocked')}`;
  }
  if (condition.prop_id) {
    const prop = state.props.find((item) => item.id === condition.prop_id);
    return `道具「${prop?.name || condition.prop_id}」状态 ${condition.operator || '=='} ${formatConditionValue(condition.value || 'unlocked')}`;
  }
  return '自定义条件';
}

function describeAction(action) {
  if (action.type === 'unlock_plot') return `解锁剧情：${plotById(action.plot_id)?.name || action.plot_id}`;
  if (action.type === 'unlock_prop') return `解锁道具：${state.props.find((item) => item.id === action.prop_id)?.name || action.prop_id}`;
  if (action.type === 'memory_update') return `更新记忆：${memoryKeyLabels[action.key] || action.key}`;
  if (action.type === 'tool_call') return `调用工具：${action.tool_key}`;
  return action.type || '未知动作';
}

function storyTreeLevels() {
  const byId = new Map(state.plots.map((plot) => [plot.id, plot]));
  const memo = new Map();
  const depthOf = (plot, visiting = new Set()) => {
    if (memo.has(plot.id)) return memo.get(plot.id);
    if (!plot.parent_plot_id || !byId.has(plot.parent_plot_id) || visiting.has(plot.id)) return 1;
    const nextVisiting = new Set(visiting).add(plot.id);
    const depth = Math.min(8, depthOf(byId.get(plot.parent_plot_id), nextVisiting) + 1);
    memo.set(plot.id, depth);
    return depth;
  };
  const levels = [[{ id: '__root__', name: '故事起点', node_type: 'root' }]];
  state.plots.forEach((plot) => {
    const depth = depthOf(plot);
    if (!levels[depth]) levels[depth] = [];
    levels[depth].push(plot);
  });
  levels.slice(1).forEach((level) => level?.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'zh-CN')));
  return levels.filter(Boolean);
}

function renderStoryOverview() {
  const active = state.plots.filter((plot) => plot.enabled).length;
  const branches = new Set(state.plots.map((plot) => plot.branch_label).filter(Boolean)).size;
  const covered = state.plots.filter((plot) => triggersForPlot(plot.id).length).length;
  $('#storyOverview').innerHTML = `
    <div><span>剧情节点</span><strong>${state.plots.length}</strong><small>${active} 个已启用</small></div>
    <div><span>故事分支</span><strong>${branches}</strong><small>按前置节点连接</small></div>
    <div><span>已配触发</span><strong>${covered}/${state.plots.length || 0}</strong><small>节点有解锁条件</small></div>
    <div><span>道具能力</span><strong>${state.props.filter((prop) => prop.status === 'enabled').length}</strong><small>${state.props.filter((prop) => prop.status === 'draft').length} 个待审核</small></div>`;
}

function renderStoryNode(plot) {
  if (plot.id === '__root__') {
    return `<button class="story-node root ${state.selectedPlotId === '__root__' ? 'selected' : ''}" data-plot-node="__root__">
      <span class="story-node-orb"><i data-lucide="sparkles"></i></span>
      <span class="story-node-copy"><span>STORY ROOT</span><strong>故事起点</strong><small>main_story / main</small></span>
    </button>`;
  }
  const meta = storyNodeMeta[plot.node_type] || storyNodeMeta.chapter;
  const triggers = triggersForPlot(plot.id);
  const condition = triggers[0] ? describeCondition(triggers[0].condition) : '未配置解锁条件';
  return `<button class="story-node ${escapeHtml(plot.node_type || 'chapter')} ${plot.enabled ? '' : 'disabled'} ${triggers.length ? 'configured' : 'unconfigured'} ${state.selectedPlotId === plot.id ? 'selected' : ''}" data-plot-node="${escapeHtml(plot.id)}">
    <span class="story-node-orb"><i data-lucide="${meta.icon}"></i></span>
    <span class="story-node-copy"><span>${escapeHtml(plot.branch_label || '主线')} · ${meta.label}</span><strong>${escapeHtml(plot.name)}</strong><small>${escapeHtml(condition)}</small></span>
    <span class="story-node-state" title="${triggers.length ? '解锁条件已配置' : '尚未配置解锁条件'}"><i data-lucide="${triggers.length ? 'check' : 'minus'}"></i></span>
  </button>`;
}

function drawStoryTreeEdges() {
  const viewport = $('#storyTreeViewport');
  const canvas = $('#storyTreeCanvas');
  const svg = $('#storyTreeEdges');
  if (!viewport || !canvas || !svg || state.automationTab !== 'story') return;
  const width = Math.max(canvas.scrollWidth, viewport.clientWidth);
  const height = Math.max(canvas.scrollHeight, viewport.clientHeight);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  const viewportRect = viewport.getBoundingClientRect();
  const nodeCenter = (id, side) => {
    const node = $(`[data-plot-node="${CSS.escape(id)}"]`, canvas);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: (side === 'right' ? rect.right : rect.left) - viewportRect.left + viewport.scrollLeft,
      y: rect.top - viewportRect.top + viewport.scrollTop + rect.height / 2
    };
  };
  svg.innerHTML = state.plots.map((plot) => {
    const parentId = plotById(plot.parent_plot_id) ? plot.parent_plot_id : '__root__';
    const start = nodeCenter(parentId, 'right');
    const end = nodeCenter(plot.id, 'left');
    if (!start || !end) return '';
    const bend = Math.max(32, (end.x - start.x) * 0.46);
    return `<path d="M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}" />`;
  }).join('');
}

function selectStoryNode(id) {
  state.selectedPlotId = id;
  $$('.story-node', $('#storyTreeCanvas')).forEach((node) => node.classList.toggle('selected', node.dataset.plotNode === id));
  renderStoryInspector();
}

function renderStoryInspector() {
  const root = $('#storyInspector');
  const plot = plotById(state.selectedPlotId);
  if (!plot) {
    root.innerHTML = `<div class="story-inspector-root"><span class="story-inspector-icon"><i data-lucide="sparkles"></i></span><span class="eyebrow">STORY ROOT</span><h3>故事起点</h3><p>这里是当前角色的剧情根节点。新建的首级剧情会从此处分支，实际是否解锁由节点的触发条件决定。</p>
      <dl class="story-facts"><div><dt>角色</dt><dd>${escapeHtml(currentAgent()?.name || '-')}</dd></div><div><dt>故事空间</dt><dd>main_story / main</dd></div><div><dt>直接分支</dt><dd>${state.plots.filter((item) => !plotById(item.parent_plot_id)).length}</dd></div></dl>
      ${isAdmin() ? '<button class="button primary wide" id="addRootPlot"><i data-lucide="plus"></i><span>添加首级剧情</span></button>' : '<span class="readonly-note"><i data-lucide="eye"></i>当前为只读视图</span>'}</div>`;
    $('#addRootPlot')?.addEventListener('click', () => editPlot());
    refreshIcons();
    return;
  }
  const meta = storyNodeMeta[plot.node_type] || storyNodeMeta.chapter;
  const parent = plotById(plot.parent_plot_id);
  const children = state.plots.filter((item) => item.parent_plot_id === plot.id);
  const triggers = triggersForPlot(plot.id);
  root.innerHTML = `<div class="story-inspector-head"><div><span class="story-node-kind ${escapeHtml(plot.node_type)}">${meta.label}</span><span class="badge ${plot.enabled ? 'blue' : 'red'}">${plot.enabled ? '已启用' : '已停用'}</span></div>${isAdmin() ? `<button class="icon-button bordered" id="editSelectedPlot" title="编辑剧情节点"><i data-lucide="pencil"></i></button>` : ''}</div>
    <span class="story-branch-name">${escapeHtml(plot.branch_label || '主线')}</span><h3>${escapeHtml(plot.name)}</h3><p>${escapeHtml(plot.premise || '未填写剧情前提')}</p>
    <section class="story-inspector-section"><header><span>注入主模型的剧情指令</span><code>plot.instructions</code></header><div class="story-prompt-preview">${escapeHtml(plot.instructions)}</div></section>
    <section class="story-inspector-section"><header><span>解锁条件与动作</span><b>${triggers.length} 组</b></header>${triggers.length ? triggers.map((trigger) => `<article class="story-trigger-brief"><div><i data-lucide="zap"></i><span><strong>${escapeHtml(trigger.name)}</strong><small>${escapeHtml(describeCondition(trigger.condition))}</small></span></div><p>${escapeHtml((trigger.actions || []).map(describeAction).join(' · '))}</p>${isAdmin() ? `<button class="text-action edit-trigger" data-id="${escapeHtml(trigger.id)}">编辑触发配置<i data-lucide="arrow-up-right"></i></button>` : ''}</article>`).join('') : `<div class="story-inline-empty"><i data-lucide="circle-dashed"></i><span>还没有解锁条件，该节点不会自动进入用户剧情。</span>${isAdmin() ? '<button id="addPlotTrigger" class="button secondary compact">配置触发</button>' : ''}</div>`}</section>
    <dl class="story-facts"><div><dt>前置节点</dt><dd>${escapeHtml(parent?.name || '故事起点')}</dd></div><div><dt>适用性别</dt><dd>${escapeHtml((plot.audience_genders || []).join('、') || '不限')}</dd></div><div><dt>后继分支</dt><dd>${children.length}</dd></div><div><dt>优先级</dt><dd>${Number(plot.priority)}</dd></div></dl>
    ${isAdmin() ? `<div class="story-inspector-actions"><button class="button secondary" id="addChildPlot"><i data-lucide="git-branch-plus"></i><span>添加后继分支</span></button><button class="button secondary" id="addAnotherTrigger"><i data-lucide="zap"></i><span>新增触发</span></button></div>` : '<span class="readonly-note"><i data-lucide="eye"></i>当前为只读视图</span>'}`;
  $('#editSelectedPlot')?.addEventListener('click', () => editPlot(plot.id));
  $('#addChildPlot')?.addEventListener('click', () => editPlot('', plot.id));
  $('#addPlotTrigger')?.addEventListener('click', () => editTrigger('', plot.id));
  $('#addAnotherTrigger')?.addEventListener('click', () => editTrigger('', plot.id));
  $$('.edit-trigger', root).forEach((button) => button.addEventListener('click', () => editTrigger(button.dataset.id)));
  applyRoleUi();
  refreshIcons();
}

function renderStoryTree() {
  const levels = storyTreeLevels();
  $('#storyTreeCanvas').innerHTML = levels.map((level, index) => `<div class="story-tree-level" data-story-depth="${index}">${level.map(renderStoryNode).join('')}</div>`).join('');
  $$('[data-plot-node]', $('#storyTreeCanvas')).forEach((node) => node.addEventListener('click', () => selectStoryNode(node.dataset.plotNode)));
  renderStoryInspector();
  refreshIcons();
  requestAnimationFrame(drawStoryTreeEdges);
}

function plotDescendantIds(plotId) {
  const descendants = new Set();
  const visit = (id) => state.plots.filter((plot) => plot.parent_plot_id === id).forEach((child) => {
    if (descendants.has(child.id)) return;
    descendants.add(child.id);
    visit(child.id);
  });
  visit(plotId);
  return descendants;
}

function editPlot(id = '', defaultParentId = '') {
  if (!isAdmin()) return;
  const plot = plotById(id) || {
    name: '', premise: '', instructions: '', parent_plot_id: defaultParentId,
    branch_label: defaultParentId ? '新分支' : '主线', node_type: defaultParentId ? 'branch' : 'chapter',
    audience_genders: [], priority: 50, enabled: 1
  };
  const excluded = id ? plotDescendantIds(id) : new Set();
  const parentOptions = state.plots.filter((item) => item.id !== id && !excluded.has(item.id));
  openModal({
    title: id ? '编辑剧情节点' : '新建剧情节点', width: 740,
    body: `<div class="form-grid two"><label><span>剧情节点名称</span><input name="name" value="${escapeHtml(plot.name)}" required></label><label><span>节点类型</span><select name="node_type">${Object.entries(storyNodeMeta).map(([value, meta]) => `<option value="${value}" ${plot.node_type === value ? 'selected' : ''}>${meta.label}</option>`).join('')}</select></label></div>
      <div class="form-grid two"><label><span>前置剧情节点</span><select name="parent_plot_id"><option value="">故事起点</option>${parentOptions.map((item) => `<option value="${escapeHtml(item.id)}" ${plot.parent_plot_id === item.id ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select><small>仅表示剧情结构；实际解锁仍由触发条件决定。</small></label><label><span>分支名称</span><input name="branch_label" value="${escapeHtml(plot.branch_label || '主线')}" placeholder="例如：情感线" required></label></div>
      <label><span>剧情前提</span><textarea name="premise" rows="3" placeholder="说明这个节点的故事意图与进入时机">${escapeHtml(plot.premise)}</textarea></label>
      <label><span>进入主模型 Input 的剧情指令</span><textarea name="instructions" rows="7" required placeholder="角色在该剧情中可以做什么、不能做什么，如何给用户选择空间">${escapeHtml(plot.instructions)}</textarea><small>节点解锁后，这段内容会编译进当前角色的 System Prompt。</small></label>
      <fieldset><legend>适用性别</legend><div class="checkbox-grid"><label class="checkbox-row"><input name="audience_genders" type="checkbox" value="男" ${(plot.audience_genders || []).includes('男') ? 'checked' : ''}><span>男</span></label><label class="checkbox-row"><input name="audience_genders" type="checkbox" value="女" ${(plot.audience_genders || []).includes('女') ? 'checked' : ''}><span>女</span></label><label class="checkbox-row"><input name="audience_genders" type="checkbox" value="非二元" ${(plot.audience_genders || []).includes('非二元') ? 'checked' : ''}><span>非二元</span></label><label class="checkbox-row"><input name="audience_genders" type="checkbox" value="不透露" ${(plot.audience_genders || []).includes('不透露') ? 'checked' : ''}><span>不透露</span></label></div><small>不选择表示不限。运行时按当前有效结构化记忆过滤，旧支线状态仅保留审计。</small></fieldset>
      <div class="form-grid two"><label><span>注入优先级</span><input name="priority" type="number" value="${Number(plot.priority)}" min="0" max="100"></label><label class="checkbox-row"><input name="enabled" type="checkbox" ${plot.enabled ? 'checked' : ''}><span>启用该剧情节点</span></label></div>`,
    onSubmit: async (formData) => {
      const body = { ...Object.fromEntries(formData.entries()), agent_id: state.currentAgentId, audience_genders: formData.getAll('audience_genders'), enabled: formData.has('enabled'), priority: Number(formData.get('priority')) };
      const saved = await api(id ? `/api/plots/${id}` : '/api/plots', { method: id ? 'PUT' : 'POST', body });
      state.selectedPlotId = saved.id;
      await loadAutomation();
      toast('剧情节点已保存');
    }
  });
}

function renderTriggerConfiguration() {
  $('#automationContent').innerHTML = `<section class="story-config-surface"><header class="story-subview-header"><div><span class="eyebrow">UNLOCK RULES</span><h3>触发配置</h3><p>读取结构化记忆和剧情状态，命中后解锁节点、更新状态或调用工具。</p></div></header>
    <div class="trigger-config-list">${state.triggers.length ? state.triggers.map((trigger) => {
      const targets = plotTargetsForTrigger(trigger);
      return `<article class="trigger-config-row ${trigger.enabled ? '' : 'disabled'}"><span class="trigger-status-icon"><i data-lucide="zap"></i></span><div class="trigger-config-copy"><div><strong>${escapeHtml(trigger.name)}</strong><span class="badge ${trigger.enabled ? 'blue' : 'red'}">${trigger.enabled ? '启用' : '停用'}</span></div><p>${escapeHtml(trigger.description || '未填写说明')}</p></div><div class="trigger-flow-block"><span>IF</span><strong>${escapeHtml(describeCondition(trigger.condition))}</strong></div><i class="trigger-flow-arrow" data-lucide="arrow-right"></i><div class="trigger-flow-block action"><span>THEN</span><strong>${escapeHtml((trigger.actions || []).map(describeAction).join(' · ') || '未配置动作')}</strong>${targets.map((plot) => `<button class="target-plot-link" data-open-plot="${escapeHtml(plot.id)}">${escapeHtml(plot.name)}<i data-lucide="locate-fixed"></i></button>`).join('')}</div><div class="trigger-policy"><span>${trigger.once_per_user ? '每用户一次' : `冷却 ${Number(trigger.cooldown_seconds)}s`}</span><small>优先级 ${Number(trigger.priority)}</small></div>${isAdmin() ? `<button class="icon-button bordered edit-trigger" data-id="${escapeHtml(trigger.id)}" title="编辑触发配置"><i data-lucide="pencil"></i></button>` : '<span class="badge">只读</span>'}</article>`;
    }).join('') : emptyState('workflow', '尚无触发配置')}</div></section>`;
  $$('.edit-trigger', $('#automationContent')).forEach((button) => button.addEventListener('click', () => editTrigger(button.dataset.id)));
  $$('[data-open-plot]', $('#automationContent')).forEach((button) => button.addEventListener('click', () => {
    state.automationTab = 'story';
    $$('[data-automation-tab]').forEach((item) => item.classList.toggle('active', item.dataset.automationTab === 'story'));
    state.selectedPlotId = button.dataset.openPlot;
    renderAutomation();
  }));
}

function propTypeLabel(value) {
  return value === 'mcp_json' ? 'MCP Server' : 'Skill ZIP';
}

function partiallyRevealName(value) {
  const characters = Array.from(String(value || '').trim());
  if (!characters.length) return '未知线索';
  const visibleCount = characters.length <= 3 ? 1 : 2;
  return `${characters.slice(0, visibleCount).join('')}${'·'.repeat(Math.min(3, Math.max(2, characters.length - visibleCount)))}`;
}

function propCapabilityKeys(prop) {
  const capabilities = Array.isArray(prop?.manifest?.capabilities) ? prop.manifest.capabilities : [];
  return capabilities.map((item) => String(typeof item === 'string' ? item : item?.key || '').toLowerCase()).filter(Boolean);
}

function userPropPresentation(prop) {
  const capabilities = propCapabilityKeys(prop);
  if (capabilities.some((key) => /audio|voice|speech/.test(key))) {
    return { label: '声音信物', icon: 'audio-lines', description: '把想说的话寄成一封可以听见的信。' };
  }
  if (capabilities.some((key) => /image|photo|picture|album/.test(key))) {
    return { label: '影像信物', icon: 'images', description: '把共同经历收进一页可以重温的画面。' };
  }
  if (capabilities.some((key) => /search|browse|place|travel|map/.test(key))) {
    return { label: '远行线索', icon: 'compass', description: '为你们尚未抵达的地方寻找公开线索。' };
  }
  if (capabilities.some((key) => /generate|write|create/.test(key))) {
    return { label: '创作信物', icon: 'wand-sparkles', description: '把故事里的灵感变成一份新的作品。' };
  }
  return { label: '特别道具', icon: 'sparkles', description: '它会在合适的剧情中回应你的选择。' };
}

function propStatusLabel(value) {
  return ({ draft: '待审核', enabled: '已启用', disabled: '已停用' })[value] || value;
}

function renderPropLibrary() {
  $('#automationContent').innerHTML = `<section class="story-config-surface"><header class="story-subview-header prop-library-header"><div><span class="eyebrow">CAPABILITY INVENTORY</span><h3>道具库</h3><p>剧情解锁的是使用资格。Skill 与 MCP 经管理员审核后，才可交给服务端能力网关执行。</p></div><div class="template-downloads"><a class="button secondary compact" href="${appBasePath}/api/props/templates/skill.zip" download><i data-lucide="download"></i><span>Skill 模版</span></a><a class="button secondary compact" href="${appBasePath}/api/props/templates/mcp.json" download><i data-lucide="download"></i><span>MCP 模版</span></a></div></header>
    <div class="capability-boundary"><i data-lucide="shield-check"></i><div><strong>上传不等于执行</strong><span>新包默认待审核；密钥必须使用 secret_ref，触发器只能授予资格，不能绕过授权、确认与审计。</span></div></div>
    <div class="prop-library-grid">${state.props.length ? state.props.map((prop) => `
      <article class="prop-library-card ${escapeHtml(prop.status)}">
        <header><span class="prop-package-icon"><i data-lucide="${prop.package_type === 'mcp_json' ? 'server-cog' : 'package-open'}"></i></span><div><span>${escapeHtml(propTypeLabel(prop.package_type))}</span><strong>${escapeHtml(prop.name)}</strong></div><span class="badge ${prop.status === 'enabled' ? 'blue' : prop.status === 'draft' ? '' : 'red'}">${escapeHtml(propStatusLabel(prop.status))}</span></header>
        <p>${escapeHtml(prop.description)}</p>
        <dl><div><dt>Key</dt><dd><code>${escapeHtml(prop.key)}</code></dd></div><div><dt>版本</dt><dd>${escapeHtml(prop.version)}</dd></div><div><dt>风险</dt><dd>${prop.risk_level === 'high' ? '高 · 逐次确认' : '中 · 网关审核'}</dd></div><div><dt>用户状态</dt><dd>${prop.user_status === 'locked' ? '未解锁' : '已解锁'}</dd></div></dl>
        <footer><span>${prop.content_hash ? `SHA256 ${escapeHtml(prop.content_hash.slice(0, 10))}…` : '内置能力描述'}</span>${isAdmin() ? `<button class="button secondary compact edit-prop" data-prop-id="${escapeHtml(prop.id)}"><i data-lucide="settings-2"></i><span>审核与设置</span></button>` : '<span class="badge">只读</span>'}</footer>
      </article>`).join('') : emptyState('package-open', '还没有道具能力包')}</div></section>`;
  $$('.edit-prop', $('#automationContent')).forEach((button) => button.addEventListener('click', () => editProp(button.dataset.propId)));
}

function renderUserAdventureView() {
  const agent = currentAgent();
  const unlockedPlots = state.plots.filter((item) => ['unlocked', 'active', 'completed'].includes(item.user_status));
  const lockedPlots = state.plots.filter((item) => item.enabled && item.user_status === 'locked');
  const enabledProps = state.props.filter((item) => item.status === 'enabled');
  const unlockedProps = enabledProps.filter((item) => ['unlocked', 'active'].includes(item.user_status));
  $('#pageMeta').textContent = `${agent?.name || '当前角色'} · ${unlockedPlots.length} 段剧情 · ${unlockedProps.length} 件道具`;
  $('#automationUserView').innerHTML = `
    <header class="user-adventure-hero" style="--adventure-color:${escapeHtml(agent?.avatar_color || '#2563eb')}">
      <span class="adventure-avatar" style="background:${escapeHtml(agent?.avatar_color || '#2563eb')}">${escapeHtml(agent?.name?.slice(0, 1) || '角')}</span>
      <div><span class="eyebrow">STORY & KEEPSAKES</span><h3>${escapeHtml(agent?.name || '角色')}与你的剧情与道具</h3><p>故事会根据你们真实建立的关系和选择逐步打开。</p></div>
      <div class="adventure-tally"><span><strong>${unlockedPlots.length}</strong>剧情</span><span><strong>${unlockedProps.length}</strong>道具</span></div>
    </header>
    <section class="user-plot-section"><header><div><span class="eyebrow">CHAPTERS</span><h4>已经打开的篇章</h4></div></header>
      <div class="user-plot-path">${unlockedPlots.length ? unlockedPlots.map((plot, index) => `
        <article><span class="plot-path-index">${String(index + 1).padStart(2, '0')}</span><div><span>${escapeHtml(plot.branch_label || '主线')} · ${escapeHtml(storyNodeMeta[plot.node_type]?.label || '章节')}</span><h5>${escapeHtml(plot.name)}</h5><p>${escapeHtml(plot.premise || '这一段故事已经向你打开。')}</p></div><i data-lucide="${plot.user_status === 'completed' ? 'circle-check-big' : 'book-open'}"></i></article>`).join('') : emptyState('book-dashed', '故事的第一章还在等待')}</div>
      ${lockedPlots.length ? `<div class="locked-chapter-preview"><div class="locked-chapter-hint"><i data-lucide="lock-keyhole"></i><span>还有 ${lockedPlots.length} 个篇章会随关系与选择逐步打开</span></div><div class="locked-chapter-teasers">${lockedPlots.slice(0, 3).map((plot) => `<span><i data-lucide="sparkles"></i><small>未开启篇章</small><strong>${escapeHtml(partiallyRevealName(plot.name))}</strong></span>`).join('')}</div>${lockedPlots.length > 3 ? `<small class="locked-chapter-more">另有 ${lockedPlots.length - 3} 条线索仍未显露</small>` : ''}</div>` : ''}
    </section>
    <section class="user-prop-section"><header><div><span class="eyebrow">KEEPSAKES</span><h4>道具匣</h4></div><span>${unlockedProps.length} / ${enabledProps.length}</span></header>
      <div class="user-prop-grid">${enabledProps.length ? enabledProps.map((prop) => {
        const unlocked = ['unlocked', 'active'].includes(prop.user_status);
        const presentation = userPropPresentation(prop);
        return `<article class="user-prop-item ${unlocked ? 'unlocked' : 'locked'}"><span class="user-prop-icon"><i data-lucide="${unlocked ? presentation.icon : 'lock-keyhole'}"></i></span><div><span>${escapeHtml(presentation.label)}</span><h5>${escapeHtml(unlocked ? prop.name : partiallyRevealName(prop.name))}</h5><p>${escapeHtml(unlocked ? presentation.description : '名字只显露了一角，真正用途会在解锁时出现。')}</p></div>${unlocked ? '<span class="badge blue">已拥有</span>' : ''}</article>`;
      }).join('') : emptyState('package-open', '角色还没有可解锁道具')}</div>
    </section>`;
  refreshIcons();
}

function openPropTypeChooser() {
  if (!isAdmin()) return;
  openModal({
    title: '新建道具',
    readOnly: true,
    width: 680,
    body: `<div class="prop-type-chooser"><button type="button" data-prop-upload="skill_zip"><i data-lucide="package-open"></i><span><strong>上传 Skill ZIP</strong><small>适合语音、图片、内容生成等受控能力包</small></span><i data-lucide="arrow-right"></i></button><button type="button" data-prop-upload="mcp_json"><i data-lucide="server-cog"></i><span><strong>上传 MCP JSON</strong><small>适合联网搜索、业务系统和外部工具服务</small></span><i data-lucide="arrow-right"></i></button></div>`
  });
  $$('[data-prop-upload]', $('#modalRoot')).forEach((button) => button.addEventListener('click', () => {
    const type = button.dataset.propUpload;
    $('#modalRoot').innerHTML = '';
    openPropUpload(type);
  }));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function openPropUpload(type) {
  const skill = type === 'skill_zip';
  openModal({
    title: skill ? '上传 Skill ZIP' : '上传 MCP JSON',
    width: 720,
    submitLabel: '上传为待审核道具',
    body: `<div class="form-grid two"><label><span>道具名称</span><input name="name" required autofocus placeholder="例如：语音信笺"></label><label><span>道具 Key</span><input name="key" required pattern="[a-z][a-z0-9_-]{2,59}" placeholder="voice_letter"></label></div>
      <label><span>道具说明</span><textarea name="description" rows="3" required placeholder="说明用户获得什么能力，以及使用时的边界"></textarea></label>
      <div class="form-grid two"><label><span>版本</span><input name="version" value="1.0.0" required></label><label><span>${skill ? 'Skill ZIP' : 'MCP JSON'}</span><input name="package_file" type="file" accept="${skill ? '.zip,application/zip' : '.json,application/json'}" required></label></div>
      ${skill ? `<fieldset><legend>能力声明</legend><div class="checkbox-grid"><label class="checkbox-row"><input name="capabilities" type="checkbox" value="send_audio"><span>发送语音</span></label><label class="checkbox-row"><input name="capabilities" type="checkbox" value="send_image"><span>发送图片</span></label><label class="checkbox-row"><input name="capabilities" type="checkbox" value="generate_content"><span>生成内容</span></label></div></fieldset>` : ''}
      <div class="upload-security-note"><i data-lucide="shield-check"></i><span>${skill ? 'ZIP 仅存储并计算哈希，不会在上传时解压或执行。' : '明文 token、API Key 和 Authorization 会被拒绝，请使用 secret_ref。'}</span></div>`,
    onSubmit: async (formData) => {
      const file = formData.get('package_file');
      if (!(file instanceof File) || !file.size) throw new Error('请选择上传文件');
      if (file.size > 5 * 1024 * 1024) throw new Error('文件不能超过 5MB');
      let manifest;
      let fileBase64 = '';
      if (skill) {
        fileBase64 = arrayBufferToBase64(await file.arrayBuffer());
        manifest = {
          schema_version: 'memory-agent.skill/v1',
          key: formData.get('key'),
          name: formData.get('name'),
          version: formData.get('version'),
          capabilities: formData.getAll('capabilities'),
          execution: 'gated_runtime',
          confirmation: 'each_call'
        };
      } else {
        try { manifest = JSON.parse(await file.text()); } catch { throw new Error('MCP 文件不是合法 JSON'); }
      }
      await api('/api/props', {
        method: 'POST',
        body: {
          agent_id: state.currentAgentId,
          package_type: type,
          name: formData.get('name'),
          key: formData.get('key'),
          description: formData.get('description'),
          version: formData.get('version'),
          file_name: file.name,
          file_base64: fileBase64,
          manifest
        }
      });
      await loadAutomation();
      toast('道具已上传，当前为待审核状态');
    }
  });
}

function editProp(id) {
  if (!isAdmin()) return;
  const prop = state.props.find((item) => item.id === id);
  if (!prop) return;
  openModal({
    title: `审核道具 · ${prop.name}`,
    width: 680,
    submitLabel: '保存审核结果',
    body: `<div class="prop-review-summary"><span class="prop-package-icon"><i data-lucide="${prop.package_type === 'mcp_json' ? 'server-cog' : 'package-open'}"></i></span><div><strong>${escapeHtml(propTypeLabel(prop.package_type))}</strong><code>${escapeHtml(prop.content_hash || '内置能力')}</code></div><span class="badge ${prop.risk_level === 'high' ? 'red' : ''}">${prop.risk_level === 'high' ? '高风险' : '中风险'}</span></div>
      <div class="form-grid two"><label><span>道具名称</span><input name="name" value="${escapeHtml(prop.name)}" required></label><label><span>版本</span><input name="version" value="${escapeHtml(prop.version)}" required></label></div>
      <label><span>道具说明</span><textarea name="description" rows="4" required>${escapeHtml(prop.description)}</textarea></label>
      <label><span>审核状态</span><select name="status"><option value="draft" ${prop.status === 'draft' ? 'selected' : ''}>待审核</option><option value="enabled" ${prop.status === 'enabled' ? 'selected' : ''}>审核通过并启用</option><option value="disabled" ${prop.status === 'disabled' ? 'selected' : ''}>停用</option></select></label>
      <details class="advanced-config"><summary>能力清单预览</summary><pre class="code-block">${escapeHtml(JSON.stringify(prop.manifest || {}, null, 2))}</pre></details>`,
    onSubmit: async (formData) => {
      await api(`/api/props/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: {
          name: formData.get('name'),
          description: formData.get('description'),
          version: formData.get('version'),
          status: formData.get('status')
        }
      });
      await loadAutomation();
      toast('道具审核状态已更新');
    }
  });
}

async function loadAutomation() {
  const catalogQuery = scopedCatalogQuery();
  [state.plots, state.triggers, state.tools, state.props, state.schemas] = await Promise.all([
    api(`/api/plots?${catalogQuery}`),
    api(`/api/triggers?agent_id=${encodeURIComponent(state.currentAgentId)}`),
    api('/api/tools'),
    api(`/api/props?${catalogQuery}`),
    api('/api/memory/schemas')
  ]);
  if (state.selectedPlotId !== '__root__' && !plotById(state.selectedPlotId)) state.selectedPlotId = '__root__';
  const agent = currentAgent();
  const scene = sceneForAgent(agent);
  $('#storyAvatar').textContent = agent?.name?.slice(0, 1) || '剧';
  $('#storyAvatar').style.background = agent?.avatar_color || '#2563eb';
  $('#storyHeaderMeta').textContent = `${scene?.name || scenarioLabel(agent?.scenario_type)} · ${agent?.name || '当前角色'}专属剧情 · user / agent / story / branch 隔离`;
  $('#storyTreeTitle').textContent = `${agent?.name || '当前角色'}的主故事线`;
  $('#pageMeta').textContent = `${scene?.name || '当前场景'} · ${agent?.name || '当前角色'} · main_story / main`;
  const userMode = state.portalMode === 'user';
  $('#automationUserView').classList.toggle('hidden', !userMode);
  $('#automationAdminView').classList.toggle('hidden', userMode);
  if (userMode) {
    renderUserAdventureView();
    return;
  }
  renderStoryOverview();
  renderAutomation();
}

function renderAutomation() {
  const storyMode = state.automationTab === 'story';
  $('#storyTreeView').classList.toggle('hidden', !storyMode);
  $('#automationContent').classList.toggle('hidden', storyMode);
  $('#addPlotButton').classList.toggle('hidden', !storyMode || !isAdmin());
  $('#addTriggerButton').classList.toggle('hidden', state.automationTab !== 'triggers' || !isAdmin());
  $('#addPropButton').classList.toggle('hidden', state.automationTab !== 'props' || !isAdmin());
  if (storyMode) renderStoryTree();
  else if (state.automationTab === 'triggers') renderTriggerConfiguration();
  else renderPropLibrary();
  applyRoleUi();
  refreshIcons();
}

function effectiveTriggerSchemas() {
  const scenarioType = sceneForAgent()?.scenario_type;
  return state.schemas.filter((schema) => schema.enabled
    && (schema.scenario_type === 'all' || schema.scenario_type === scenarioType));
}

function conditionSource(condition = {}) {
  if (condition.plot_id) return 'plot';
  if (condition.prop_id) return 'prop';
  return 'memory';
}

function conditionTargetOptions(source, selected = '') {
  if (source === 'plot') {
    return state.plots.map((plot) => `<option value="${escapeHtml(plot.id)}" ${plot.id === selected ? 'selected' : ''}>${escapeHtml(plot.branch_label || '主线')} / ${escapeHtml(plot.name)}</option>`).join('');
  }
  if (source === 'prop') {
    return state.props.map((prop) => `<option value="${escapeHtml(prop.id)}" ${prop.id === selected ? 'selected' : ''}>${escapeHtml(prop.name)} · ${escapeHtml(propStatusLabel(prop.status))}</option>`).join('');
  }
  return effectiveTriggerSchemas().map((schema) => `<option value="${escapeHtml(schema.key)}" ${schema.key === selected ? 'selected' : ''}>${escapeHtml(schema.category)} / ${escapeHtml(schema.label)}</option>`).join('');
}

function conditionRowHtml(condition = {}) {
  const source = conditionSource(condition);
  const target = condition.memory_key || condition.plot_id || condition.prop_id || '';
  const value = Array.isArray(condition.value) ? condition.value.join(', ') : (condition.value ?? '');
  const operator = condition.operator || '==';
  return `<div class="lowcode-rule-row" data-condition-row>
    <span class="rule-row-grip"><i data-lucide="grip-vertical"></i></span>
    <label><span>来源</span><select data-condition-source><option value="memory" ${source === 'memory' ? 'selected' : ''}>结构化记忆</option><option value="plot" ${source === 'plot' ? 'selected' : ''}>剧情状态</option><option value="prop" ${source === 'prop' ? 'selected' : ''}>道具状态</option></select></label>
    <label class="rule-target"><span>字段 / 对象</span><select data-condition-target>${conditionTargetOptions(source, target)}</select></label>
    <label><span>判断</span><select data-condition-operator>${[['==','等于'],['!=','不等于'],['>=','大于等于'],['>','大于'],['<=','小于等于'],['<','小于'],['contains','包含'],['in','属于其中之一'],['exists','已有值']].map(([key, label]) => `<option value="${key}" ${operator === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label class="rule-value"><span>值</span><input data-condition-value value="${escapeHtml(value)}" placeholder="输入判断值" ${operator === 'exists' ? 'disabled' : ''}></label>
    <button type="button" class="icon-button remove-condition" title="删除条件" aria-label="删除条件"><i data-lucide="trash-2"></i></button>
  </div>`;
}

function actionTargetOptions(type, selected = '') {
  if (type === 'unlock_plot') return state.plots.map((plot) => `<option value="${escapeHtml(plot.id)}" ${plot.id === selected ? 'selected' : ''}>${escapeHtml(plot.branch_label || '主线')} / ${escapeHtml(plot.name)}</option>`).join('');
  if (type === 'unlock_prop') return state.props.map((prop) => `<option value="${escapeHtml(prop.id)}" ${prop.id === selected ? 'selected' : ''}>${escapeHtml(prop.name)} · ${escapeHtml(propStatusLabel(prop.status))}</option>`).join('');
  if (type === 'memory_update') return effectiveTriggerSchemas().map((schema) => `<option value="${escapeHtml(schema.key)}" ${schema.key === selected ? 'selected' : ''}>${escapeHtml(schema.category)} / ${escapeHtml(schema.label)}</option>`).join('');
  return state.tools.filter((tool) => tool.enabled).map((tool) => `<option value="${escapeHtml(tool.key)}" ${tool.key === selected ? 'selected' : ''}>${escapeHtml(tool.name)}</option>`).join('');
}

function toolArgumentFields(toolKey, args = {}) {
  const tool = state.tools.find((item) => item.key === toolKey);
  return Object.entries(tool?.input_schema?.properties || {}).map(([key, definition]) => {
    const value = args[key] ?? '';
    if (key === 'plot_id') {
      return `<label><span>${escapeHtml(key)}</span><select data-tool-argument="${escapeHtml(key)}" data-value-type="string">${actionTargetOptions('unlock_plot', value)}</select></label>`;
    }
    return `<label><span>${escapeHtml(key)}</span><input data-tool-argument="${escapeHtml(key)}" data-value-type="${escapeHtml(definition.type || 'string')}" type="${definition.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}" ${tool.input_schema?.required?.includes(key) ? 'required' : ''}></label>`;
  }).join('') || '<span class="rule-no-arguments">此工具没有入参</span>';
}

function actionFieldsHtml(action = {}) {
  const type = action.type || 'unlock_plot';
  const target = action.plot_id || action.prop_id || action.key || action.tool_key || '';
  if (type === 'tool_call') {
    const toolKey = target || state.tools.find((tool) => tool.enabled)?.key || '';
    return `<label><span>工具</span><select data-action-target>${actionTargetOptions(type, toolKey)}</select></label><div class="tool-argument-grid" data-tool-arguments>${toolArgumentFields(toolKey, action.arguments || {})}</div>`;
  }
  if (type === 'memory_update') {
    const memoryKey = target || effectiveTriggerSchemas()[0]?.key || '';
    return `<label><span>字段</span><select data-action-target>${actionTargetOptions(type, memoryKey)}</select></label><label><span>写入值</span><input data-action-value value="${escapeHtml(Array.isArray(action.value) ? action.value.join(', ') : (action.value ?? ''))}" required></label>`;
  }
  return `<label><span>${type === 'unlock_prop' ? '道具' : '剧情节点'}</span><select data-action-target>${actionTargetOptions(type, target)}</select></label>`;
}

function actionRowHtml(action = {}) {
  const type = action.type || 'unlock_plot';
  return `<div class="lowcode-action-row" data-action-row>
    <span class="action-arrow"><i data-lucide="arrow-right"></i></span>
    <label><span>动作</span><select data-action-type><option value="unlock_plot" ${type === 'unlock_plot' ? 'selected' : ''}>解锁剧情</option><option value="unlock_prop" ${type === 'unlock_prop' ? 'selected' : ''}>解锁道具</option><option value="memory_update" ${type === 'memory_update' ? 'selected' : ''}>更新结构化记忆</option><option value="tool_call" ${type === 'tool_call' ? 'selected' : ''}>调用登记工具</option></select></label>
    <div class="lowcode-action-fields">${actionFieldsHtml(action)}</div>
    <button type="button" class="icon-button remove-action" title="删除动作" aria-label="删除动作"><i data-lucide="trash-2"></i></button>
  </div>`;
}

function parseRuleValue(rawValue, memoryKey, operator) {
  if (operator === 'exists') return undefined;
  const raw = String(rawValue ?? '').trim();
  if (operator === 'in') return raw.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  const schema = effectiveTriggerSchemas().find((item) => item.key === memoryKey);
  if (schema?.value_type === 'number' || ['>=', '>', '<=', '<'].includes(operator)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('数值条件必须填写有效数字');
    return value;
  }
  if (schema?.value_type === 'boolean') return raw === 'true' || raw === '是';
  return raw;
}

function collectLowCodeCondition(root) {
  const mode = $('[name="condition_mode"]', root).value;
  const rows = $$('[data-condition-row]', root);
  if (!rows.length) throw new Error('至少配置一个触发条件');
  const conditions = rows.map((row) => {
    const source = $('[data-condition-source]', row).value;
    const target = $('[data-condition-target]', row).value;
    const operator = $('[data-condition-operator]', row).value;
    if (!target) throw new Error('请选择条件字段或对象');
    const condition = { operator };
    if (source === 'memory') condition.memory_key = target;
    if (source === 'plot') condition.plot_id = target;
    if (source === 'prop') condition.prop_id = target;
    const value = parseRuleValue($('[data-condition-value]', row)?.value, source === 'memory' ? target : '', operator);
    if (value !== undefined) condition.value = value;
    return condition;
  });
  return { [mode]: conditions };
}

function collectLowCodeActions(root) {
  const rows = $$('[data-action-row]', root);
  if (!rows.length) throw new Error('至少配置一个触发动作');
  return rows.map((row) => {
    const type = $('[data-action-type]', row).value;
    const target = $('[data-action-target]', row)?.value || '';
    if (!target) throw new Error('请选择动作目标');
    if (type === 'unlock_plot') return { type, plot_id: target };
    if (type === 'unlock_prop') return { type, prop_id: target };
    if (type === 'memory_update') {
      return { type, key: target, value: parseRuleValue($('[data-action-value]', row).value, target, '==') };
    }
    const args = {};
    $$('[data-tool-argument]', row).forEach((input) => {
      const raw = input.value;
      if (raw === '') return;
      args[input.dataset.toolArgument] = input.dataset.valueType === 'number' ? Number(raw) : raw;
    });
    return { type: 'tool_call', tool_key: target, arguments: args };
  });
}

function bindTriggerEditor() {
  const root = $('#modalRoot');
  const conditionList = $('#triggerConditionList', root);
  const actionList = $('#triggerActionList', root);
  const bindCondition = (row) => {
    $('[data-condition-source]', row).addEventListener('change', (event) => {
      $('[data-condition-target]', row).innerHTML = conditionTargetOptions(event.target.value);
      updateTriggerRulePreview();
    });
    $('[data-condition-operator]', row).addEventListener('change', (event) => {
      $('[data-condition-value]', row).disabled = event.target.value === 'exists';
      updateTriggerRulePreview();
    });
    $('.remove-condition', row).addEventListener('click', () => { row.remove(); updateTriggerRulePreview(); });
    $$('select, input', row).forEach((input) => input.addEventListener('input', updateTriggerRulePreview));
  };
  const bindAction = (row) => {
    $('[data-action-type]', row).addEventListener('change', (event) => {
      $('.lowcode-action-fields', row).innerHTML = actionFieldsHtml({ type: event.target.value });
      bindActionFields(row);
      updateTriggerRulePreview();
    });
    $('.remove-action', row).addEventListener('click', () => { row.remove(); updateTriggerRulePreview(); });
    bindActionFields(row);
  };
  const bindActionFields = (row) => {
    const target = $('[data-action-target]', row);
    target?.addEventListener('change', () => {
      if ($('[data-action-type]', row).value === 'tool_call') {
        $('[data-tool-arguments]', row).innerHTML = toolArgumentFields(target.value);
      }
      updateTriggerRulePreview();
    });
    $$('input, select', $('.lowcode-action-fields', row)).forEach((input) => input.addEventListener('input', updateTriggerRulePreview));
  };
  $$('[data-condition-row]', conditionList).forEach(bindCondition);
  $$('[data-action-row]', actionList).forEach(bindAction);
  $('#addConditionRow', root).addEventListener('click', () => {
    conditionList.insertAdjacentHTML('beforeend', conditionRowHtml({ memory_key: effectiveTriggerSchemas()[0]?.key || '', operator: '==', value: '' }));
    bindCondition(conditionList.lastElementChild);
    refreshIcons();
    updateTriggerRulePreview();
  });
  $('#addActionRow', root).addEventListener('click', () => {
    actionList.insertAdjacentHTML('beforeend', actionRowHtml({ type: 'unlock_plot' }));
    bindAction(actionList.lastElementChild);
    refreshIcons();
    updateTriggerRulePreview();
  });
  $('[name="condition_mode"]', root).addEventListener('change', updateTriggerRulePreview);
  updateTriggerRulePreview();
}

function updateTriggerRulePreview() {
  const root = $('#modalRoot');
  const preview = $('#triggerRulePreview', root);
  if (!preview) return;
  try {
    const condition = collectLowCodeCondition(root);
    const actions = collectLowCodeActions(root);
    preview.innerHTML = `<span>当</span><strong>${escapeHtml(describeCondition(condition))}</strong><i data-lucide="arrow-right"></i><span>执行</span><strong>${escapeHtml(actions.map(describeAction).join('、'))}</strong>`;
    refreshIcons();
  } catch {
    preview.innerHTML = '<span>补全条件与动作后，这里会显示自然语言规则。</span>';
  }
}

function editTrigger(id = '', defaultPlotId = '') {
  if (!isAdmin()) return;
  const trigger = state.triggers.find((item) => item.id === id) || {
    name: '', description: '', condition: { all: [{ memory_key: 'relationship.intimacy', operator: '>=', value: 30 }] },
    actions: defaultPlotId ? [{ type: 'unlock_plot', plot_id: defaultPlotId }] : [{ type: 'unlock_plot' }],
    once_per_user: 1, cooldown_seconds: 0, priority: 50, enabled: 1
  };
  const conditionMode = Array.isArray(trigger.condition?.any) ? 'any' : 'all';
  const conditions = trigger.condition?.[conditionMode] || [trigger.condition];
  const actions = (trigger.actions || []).length ? trigger.actions : [{ type: 'unlock_plot', plot_id: defaultPlotId }];
  openModal({
    title: id ? '编辑触发配置' : '新建触发配置',
    width: 980,
    body: `<div class="form-grid two"><label><span>配置名称</span><input name="name" value="${escapeHtml(trigger.name)}" required></label><label><span>配置说明</span><input name="description" value="${escapeHtml(trigger.description)}" placeholder="例如：关系进入熟悉阶段后打开雨夜来信"></label></div>
      <section class="lowcode-builder-section"><header><div><span>01</span><strong>当这些条件满足</strong></div><select name="condition_mode" aria-label="条件组合方式"><option value="all" ${conditionMode === 'all' ? 'selected' : ''}>同时满足全部条件</option><option value="any" ${conditionMode === 'any' ? 'selected' : ''}>满足任意一个条件</option></select></header><div id="triggerConditionList" class="lowcode-rule-list">${conditions.map(conditionRowHtml).join('')}</div><button id="addConditionRow" type="button" class="button secondary compact"><i data-lucide="plus"></i><span>增加条件</span></button></section>
      <section class="lowcode-builder-section action-builder"><header><div><span>02</span><strong>就执行这些动作</strong></div><small>道具必须先审核启用</small></header><div id="triggerActionList" class="lowcode-action-list">${actions.map(actionRowHtml).join('')}</div><button id="addActionRow" type="button" class="button secondary compact"><i data-lucide="plus"></i><span>增加动作</span></button></section>
      <div id="triggerRulePreview" class="trigger-rule-preview"></div>
      <div class="form-grid two"><label><span>冷却时间（秒）</span><input name="cooldown_seconds" type="number" min="0" value="${Number(trigger.cooldown_seconds || 0)}"></label><label><span>执行优先级</span><input name="priority" type="number" min="0" max="100" value="${Number(trigger.priority)}"></label></div>
      <div class="form-grid two"><label class="checkbox-row"><input name="once_per_user" type="checkbox" ${trigger.once_per_user ? 'checked' : ''}><span>每个用户仅触发一次</span></label><label class="checkbox-row"><input name="enabled" type="checkbox" ${trigger.enabled ? 'checked' : ''}><span>启用该触发配置</span></label></div>`,
    onSubmit: async (formData, form) => {
      const condition = collectLowCodeCondition(form);
      const triggerActions = collectLowCodeActions(form);
      const body = {
        name: formData.get('name'), description: formData.get('description'), agent_id: state.currentAgentId,
        condition, actions: triggerActions,
        once_per_user: formData.has('once_per_user'), enabled: formData.has('enabled'),
        cooldown_seconds: Number(formData.get('cooldown_seconds')), priority: Number(formData.get('priority'))
      };
      await api(id ? `/api/triggers/${id}` : '/api/triggers', { method: id ? 'PUT' : 'POST', body });
      await loadAutomation();
      toast('触发配置已保存');
    }
  });
  bindTriggerEditor();
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

const TRACE_SPAN_LABELS = {
  previous_conversation_memory_flush: '跨会话记忆收尾',
  persistent_instruction_classifier: '长期指令判定',
  control_memory_fast_path: '固定记忆快速通道',
  trigger_evaluation_pre_response: '回复前条件触发',
  pinned_memory_load: '常驻记忆载入',
  memory_retrieval_planner: '二次召回规划',
  hybrid_memory_retrieval: '混合记忆召回',
  capability_resolution: '已解锁能力解析',
  prompt_compilation: '模型输入编译',
  model_response: 'Pi Runtime 与 LLM 协作',
  post_turn_memory_commit: '长期记忆更新',
  trigger_evaluation_post_commit: '记忆更新后条件触发',
  response_complete: '本轮收口'
};

const TRACE_RUNTIME_EVENT_LABELS = {
  agent_start: 'Agent 启动',
  turn_start: 'Turn 开始',
  message_start: '消息开始',
  message_update: '消息更新',
  message_end: '消息完成',
  tool_execution_start: '工具开始',
  tool_execution_update: '工具进度',
  tool_execution_end: '工具完成',
  turn_end: 'Turn 完成',
  agent_end: 'Agent 收口'
};

function traceSpanLabel(name) {
  return TRACE_SPAN_LABELS[name] || name.replaceAll('_', ' ');
}

function traceMs(value, prefix = '') {
  const number = Number(value);
  return Number.isFinite(number) ? `${prefix}${number} ms` : '—';
}

function traceCollaborationHtml(trace, modelSpan, modelOutput) {
  const runtime = modelOutput.runtime || {};
  const bridge = runtime.providerBridge || {};
  const providerCalls = Array.isArray(bridge.calls) ? bridge.calls : [];
  const lifecycle = Array.isArray(runtime.lifecycle) ? runtime.lifecycle : [];
  const modelInput = parseJson(modelSpan?.input_json, {});
  const promptSpan = trace.spans.find((span) => span.name === 'prompt_compilation');
  const retrievalSpan = trace.spans.find((span) => span.name === 'hybrid_memory_retrieval');
  const capabilitySpan = trace.spans.find((span) => span.name === 'capability_resolution');
  const memorySpan = trace.spans.find((span) => span.name === 'post_turn_memory_commit');
  const memoryOutput = parseJson(memorySpan?.output_json, {});
  const retrievalOutput = parseJson(retrievalSpan?.output_json, {});
  const capabilityOutput = parseJson(capabilitySpan?.output_json, {});
  const usage = modelOutput.usage || {};
  const provider = bridge.provider || modelOutput.provider || '未记录';
  const model = bridge.model || modelOutput.model || '未记录';
  const runtimeName = runtime.name || modelInput.runtime || 'legacy';
  const runtimeVersion = runtime.version ? ` ${runtime.version}` : '';
  const messageCount = Array.isArray(modelInput.messages) ? modelInput.messages.length : 0;
  const promptChars = String(modelInput.systemPrompt || '').length;
  const selectedMemories = Array.isArray(retrievalOutput.selected) ? retrievalOutput.selected.length
    : Number(retrievalOutput.selectedCount || retrievalOutput.selected_count || 0);
  const firstEvent = lifecycle[0] || {};
  const lastEvent = lifecycle.at(-1) || {};
  const bridgeStatus = bridge.status || (modelSpan?.status === 'success' ? 'success' : modelSpan?.status || '未知');
  const agentTurnEnabled = runtime.name === 'pi-agent-core';
  const toolLoopEnabled = runtime.toolLoopEnabled === true;
  const exposedTools = Array.isArray(capabilityOutput.exposedTools) ? capabilityOutput.exposedTools : [];
  const toolExecutions = lifecycle.filter((event) => event.type === 'tool_execution_end');
  const callCount = Number(bridge.requestCount || providerCalls.length || (bridge.status ? 1 : 0));
  const reactLoopHtml = toolLoopEnabled ? providerCalls.map((call, index) => {
    const nextCall = providerCalls[index + 1];
    const executions = nextCall ? toolExecutions.filter((event) =>
      Number(event.atMs) >= Number(call.responseAtMs ?? call.requestAtMs ?? 0)
      && Number(event.atMs) <= Number(nextCall.requestAtMs ?? Number.POSITIVE_INFINITY)) : [];
    const modelNode = `<div class="trace-react-node model"><span>MODEL ${index + 1}</span><strong>${escapeHtml(call.provider || provider)} / ${escapeHtml(call.model || model)}</strong><small>${escapeHtml(call.stopReason || call.status || 'pending')} · ${traceMs(call.durationMs)}</small></div>`;
    const toolNodes = executions.map((event) => `<i data-lucide="arrow-right"></i><div class="trace-react-node tool ${event.isError ? 'error' : ''}"><span>TOOL</span><strong>${escapeHtml(event.toolName || 'unknown')}</strong><small>${event.isError ? '执行失败' : '执行成功'} · ${traceMs(event.atMs, '+')}</small></div>`).join('');
    return `${index ? '<i data-lucide="arrow-right"></i>' : ''}${modelNode}${toolNodes}`;
  }).join('') : '';
  const lifecycleHtml = lifecycle.length
    ? lifecycle.map((event) => `<span><b>${escapeHtml(TRACE_RUNTIME_EVENT_LABELS[event.type] || event.type)}</b><small>${traceMs(event.atMs, '+')}</small></span>`).join('')
    : '<span><b>无生命周期事件</b><small>legacy runtime</small></span>';

  return `
    <section class="trace-collaboration" aria-label="Runtime 与模型协作视图">
      <header class="trace-collaboration-header">
        <div><span class="eyebrow">RUNTIME × MODEL</span><h4>本次回复的真实协作链</h4></div>
        <div class="trace-mode-badges"><span class="badge ${agentTurnEnabled ? 'blue' : 'amber'}">${agentTurnEnabled ? 'Agent Turn 已启用' : 'Legacy 调用链'}</span><span class="badge ${toolLoopEnabled ? 'blue' : 'amber'}">${toolLoopEnabled ? 'ReAct 工具循环' : '本轮无工具'}</span></div>
      </header>
      <div class="trace-collaboration-flow">
        <div class="trace-actor pipeline"><i data-lucide="route"></i><span><small>会话编排</small><strong>Memory Agent Turn Pipeline</strong><em>${messageCount} 条短期记忆 · ${promptChars.toLocaleString()} 字符系统输入</em></span></div>
        <i class="trace-flow-arrow" data-lucide="arrow-right"></i>
        <div class="trace-actor runtime"><i data-lucide="orbit"></i><span><small>具体 Runtime</small><strong>${escapeHtml(runtimeName + runtimeVersion)}</strong><em>${escapeHtml(runtime.loopPattern || 'single turn')} · ${lifecycle.length} 个事件</em></span></div>
        <i class="trace-flow-arrow" data-lucide="arrow-right"></i>
        <div class="trace-actor bridge"><i data-lucide="network"></i><span><small>Provider Bridge</small><strong>${escapeHtml(bridge.name || 'memory-agent-provider')}</strong><em>${callCount} 次模型请求 · ${escapeHtml(bridgeStatus)}</em></span></div>
        <i class="trace-flow-arrow" data-lucide="arrow-right"></i>
        <div class="trace-actor llm"><i data-lucide="sparkles"></i><span><small>具体 LLM</small><strong>${escapeHtml(provider)} / ${escapeHtml(model)}</strong><em>${Number(usage.inputTokens || 0).toLocaleString()} in · ${Number(usage.outputTokens || 0).toLocaleString()} out</em></span></div>
      </div>
      <div class="trace-sequence">
        <div><span class="trace-sequence-index">01</span><strong>Turn Pipeline 组装输入</strong><small>常驻记忆、召回结果、角色人设与短期记忆被编译为模型输入。</small><time>${traceMs(promptSpan?.duration_ms)}</time></div>
        <div><span class="trace-sequence-index">02</span><strong>${escapeHtml(runtimeName)} 接管本轮</strong><small>${escapeHtml(TRACE_RUNTIME_EVENT_LABELS[firstEvent.type] || firstEvent.type || '启动')} → ${escapeHtml(TRACE_RUNTIME_EVENT_LABELS[lastEvent.type] || lastEvent.type || '收口')}，维护 Agent state 与消息生命周期。</small><time>${traceMs(firstEvent.atMs, '+')}</time></div>
        <div><span class="trace-sequence-index">03</span><strong>暴露 ${exposedTools.length} 个当轮工具</strong><small>${exposedTools.length ? escapeHtml(exposedTools.map((tool) => tool.name).join('、')) : '没有已解锁且可连接的 Skill / MCP 工具，本轮直接生成文本。'}</small><time>${traceMs(capabilitySpan?.duration_ms)}</time></div>
        <div><span class="trace-sequence-index">04</span><strong>Provider Bridge 发起 ${callCount} 次模型请求</strong><small>${toolLoopEnabled ? '模型可自主选择 tool call；能力网关执行后，Pi 把 toolResult 追加到上下文并继续请求模型。' : `Pi 将统一消息请求交给 ${escapeHtml(model)}，模型直接返回最终文本。`}</small><time>${traceMs(bridge.responseAtMs, '+')}</time></div>
        <div><span class="trace-sequence-index">05</span><strong>Turn Pipeline 完成轮后处理</strong><small>长期记忆更新：${escapeHtml(memoryOutput.status || '未触发')}；本轮召回 ${Number.isFinite(selectedMemories) ? selectedMemories : 0} 条候选记忆。</small><time>${traceMs(memorySpan?.duration_ms)}</time></div>
      </div>
      ${toolLoopEnabled ? `<div class="trace-react-loop"><span class="trace-lifecycle-label">ReAct 调用链</span><div>${reactLoopHtml || '<span>本轮暴露了工具，但模型没有调用。</span>'}</div></div>` : ''}
      <div class="trace-lifecycle"><span class="trace-lifecycle-label">Pi 生命周期</span><div>${lifecycleHtml}</div></div>
    </section>`;
}

async function loadTraceDetail(id) {
  $$('[data-trace-id]').forEach((button) => button.classList.toggle('active', button.dataset.traceId === id));
  const trace = await api(`/api/traces/${encodeURIComponent(id)}`);
  const modelSpan = trace.spans.find((span) => span.name === 'model_response');
  const modelOutput = parseJson(modelSpan?.output_json, {});
  const usage = modelOutput.usage || {};
  const cache = modelOutput.cache || {};
  const inputTokens = Number(usage.inputTokens || cache.inputTokens || 0);
  const cachedTokens = Number(usage.cachedTokens || cache.cachedTokens || 0);
  const hitRate = Number(usage.cacheHitRate ?? cache.hitRate ?? (inputTokens ? cachedTokens / inputTokens : 0));
  const cacheStatus = cache.status || '未启用';
  $('#traceDetail').innerHTML = `
    <div class="trace-overview"><div><span>状态</span><strong>${escapeHtml(trace.status)}</strong></div><div><span>总耗时</span><strong>${trace.total_ms} ms</strong></div><div><span>Provider</span><strong>${escapeHtml(modelOutput.provider || '—')}</strong></div><div><span>输入 Token</span><strong>${inputTokens || '—'}</strong></div><div><span>缓存 Token</span><strong>${cachedTokens || '—'}</strong></div><div><span>缓存状态 / 命中率</span><strong>${escapeHtml(cacheStatus)} · ${(hitRate * 100).toFixed(1)}%</strong></div></div>
    ${traceCollaborationHtml(trace, modelSpan, modelOutput)}
    <details class="trace-raw-panel"><summary><span><i data-lucide="braces"></i><strong>原始 Span</strong></span><small>${trace.spans.length} 个节点 · 完整 Input / Output</small><i data-lucide="chevron-down"></i></summary><div class="trace-raw-spans">${trace.spans.map((span, index) => {
      const input = parseJson(span.input_json, {});
      const output = parseJson(span.output_json, {});
      return `<details class="span-item"><summary><span class="span-status ${span.status === 'error' ? 'error' : ''}"></span><span><b>${index + 1}. ${escapeHtml(traceSpanLabel(span.name))}</b><code>${escapeHtml(span.name)}</code></span><time>${span.duration_ms} ms</time></summary><div class="span-body"><span class="code-label">Input</span><pre class="code-block">${escapeHtml(JSON.stringify(input, null, 2))}</pre><span class="code-label">Output</span><pre class="code-block">${escapeHtml(JSON.stringify(output, null, 2))}</pre></div></details>`;
    }).join('')}</div></details>`;
  refreshIcons();
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
$$('[data-portal-mode]').forEach((button) => button.addEventListener('click', () => switchPortalMode(button.dataset.portalMode)));
$('#userSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#agentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#memoryUserSelect').addEventListener('change', async (event) => { state.currentUserId = event.target.value; await switchContext(); });
$('#memoryAgentSelect').addEventListener('change', async (event) => { state.currentAgentId = event.target.value; await switchContext(); });
$('#usersAddButton').addEventListener('click', addUser);
$('#newConversationButton').addEventListener('click', () => {
  if (state.currentConversationId) state.previousConversationId = state.currentConversationId;
  state.currentConversationId = '';
  state.extractionStatus = null;
  renderConversations();
  renderWelcome();
  $('#messageInput').focus();
});
$('#composerForm').addEventListener('submit', (event) => { event.preventDefault(); sendMessage($('#messageInput').value); });
$('#memoryExtractionButton').addEventListener('click', extractMemoryNow);
$('#unlockedPropsButton').addEventListener('click', openUnlockedProps);
$('#unlockedPlotsButton').addEventListener('click', openUnlockedPlots);
$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composerForm').requestSubmit(); }
});
$('#messageInput').addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  updateMessageLength();
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
    const result = await api('/api/admin/health/models', { method: 'POST' });
    setModelConnectionStatus(result.embeddingFallback ? '本地向量降级' : `${result.embeddingDimensions} 维向量`, result.embeddingFallback);
    toast(result.embeddingFallback ? result.fallbackReason : `${result.embeddingProvider} Embedding 连接正常`, result.embeddingFallback ? 'error' : 'success');
  } catch (error) { setModelConnectionStatus('连接异常', true); toast(error.message, 'error'); }
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
$('#addSceneButton').addEventListener('click', addScene);
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
$('#addAgentButton').addEventListener('click', addAgent);
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
$('#addPropButton').addEventListener('click', openPropTypeChooser);
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
window.addEventListener('resize', () => requestAnimationFrame(drawStoryTreeEdges));

initialize().then(refreshIcons).catch((error) => {
  showLogin();
  $('#loginError').textContent = error.message;
});
