// Mission Control — Phase 3 Frontend
const API = '';
let tasks = [];
let agents = [];
let agentStats = [];
let liveTasks = [];
let draggedTaskId = null;
let currentPage = 'dashboard';
let workspaces = [];
let orgExpanded = true;

function cleanTitle(title) {
  if (!title) return 'Untitled';
  let t = title;
  // Strip any bracketed timestamps: [Sat 2026-02-14 ...], [2026-02-14 ...], [cron:...], [Telegram], etc.
  t = t.replace(/\[[^\]]{0,80}\]/g, '');
  // Strip URLs (including parenthesized, with or without trailing paths)
  t = t.replace(/\(?https?:\/\/[^\s)]+\)?\s*/g, '');
  // Strip markdown bold/italic
  t = t.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  t = t.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  // Strip markdown links [text](url)
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip markdown headers
  t = t.replace(/^#+\s+/gm, '');
  // Strip CRITICAL:/URGENT:/CONTINUE/etc. prefixes
  t = t.replace(/^(?:CRITICAL|URGENT|PRIORITY|IMPORTANT|MANDATORY|CONTINUE|CONTINUOUS)(?:\s+(?:BUG|TASK|FIX|ISSUE|IMPROVING|IMPROVEMENT))?\s*:?\s*/i, '');
  // Strip DOWNLOAD/BUILD/etc. all-caps action verbs at start
  t = t.replace(/^(?:DOWNLOAD|BUILD|CREATE|SETUP|DEPLOY|UPDATE|FIX|IMPLEMENT)\s+/i, (m) => m.charAt(0) + m.slice(1).toLowerCase());
  // Clean up extra whitespace, dashes, pipes, parens
  t = t.replace(/\s*[|—–]\s*$/, '').replace(/^\s*[|—–]\s*/, '');
  t = t.replace(/\(\s*\)/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Remove trailing punctuation clutter
  t = t.replace(/^[\s,.\-—:]+/, '').replace(/[\s,.\-—:]+$/, '');
  // Truncate to ~60 chars at word boundary
  if (t.length > 60) {
    t = t.substring(0, 60).replace(/\s+\S*$/, '') + '…';
  }
  return t || 'Untitled';
}
let wsEditMode = false;
let wsCurrentAgent = null;
let wsCurrentFile = null;
let lastWorkspaceCheck = null;

// Agent display info — built dynamically from API, with color fallbacks
const AGENT_COLOR_MAP = { main:'#ffc107', trading:'#00E676', 'it-support':'#00b0ff', dev:'#00bcd4', voice:'#e040fb', troubleshoot:'#ff5252', docs:'#7c4dff', researcher:'#64ffda', security:'#ffd740' };
const AGENT_COLOR_POOL = ['#ff7043','#ab47bc','#26c6da','#9ccc65','#ef5350','#42a5f5','#ffca28','#8d6e63'];
let AGENT_INFO = {};
function rebuildAgentInfo() {
  const info = {};
  let ci = 0;
  for (const a of agents) {
    info[a.name] = { name: a.display_name || a.name, emoji: a.emoji || '🤖', color: AGENT_COLOR_MAP[a.name] || AGENT_COLOR_POOL[ci++ % AGENT_COLOR_POOL.length] };
  }
  AGENT_INFO = info;
  populateAgentSelects();
}

function populateAgentSelects() {
  // Activity filter
  const af = document.getElementById('activityFilter');
  if (af) {
    const val = af.value;
    af.innerHTML = '<option value="">All Agents</option>' + agents.map(a => `<option value="${a.name}">${a.emoji} ${a.display_name}</option>`).join('');
    af.value = val;
  }
  // Create task agent select
  const na = document.getElementById('newAgent');
  if (na) {
    const val = na.value;
    na.innerHTML = '<option value="">Unassigned</option>' + agents.map(a => `<option value="${a.name}">${a.emoji} ${a.display_name}</option>`).join('');
    na.value = val;
  }
  // Action item assignee
  const aa = document.getElementById('actionAssignee');
  if (aa) {
    const val = aa.value;
    aa.innerHTML = '<option value="">Unassigned</option>' + agents.map(a => `<option value="${a.name}">${a.emoji} ${a.display_name}</option>`).join('');
    aa.value = val;
  }
  // Standup participants checkboxes
  const sp = document.getElementById('standupParticipants');
  if (sp && sp.children.length !== agents.length) {
    sp.innerHTML = agents.map(a => `<label class="cb-label"><input type="checkbox" value="${a.name}"${a.name === 'main' ? ' checked' : ''}> ${a.emoji} ${a.display_name}</label>`).join('');
  }
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  setInterval(loadAll, 10000);
  // Live-ticking timers: update durations and "time ago" every second
  setInterval(tickTimers, 1000);
  // Workspace auto-update polling
  lastWorkspaceCheck = new Date().toISOString();
  setInterval(checkWorkspaceChanges, 5000);
});

function tickTimers() {
  // Tick task durations (active in_progress tasks)
  document.querySelectorAll('[data-created-at][data-tick-duration]').forEach(el => {
    const created = new Date(el.dataset.createdAt).getTime();
    const elapsed = (Date.now() - created) / 1000;
    if (elapsed > 0) el.textContent = '⏱ ' + formatDuration(elapsed);
  });
  // Tick "time ago" labels
  document.querySelectorAll('[data-time-ago]').forEach(el => {
    const prefix = el.dataset.timePrefix || '';
    el.textContent = prefix + timeAgo(el.dataset.timeAgo);
  });
}

async function loadAll() {
  await Promise.all([loadTasks(), loadAgents(), loadAgentStats(), loadLiveTasks()]);
  if (currentPage === 'dashboard') {
    renderBoard();
    // Poll activity if the activity tab is visible
    const actTab = document.querySelector('.tab[data-tab="activity"]');
    if (actTab && actTab.classList.contains('active')) loadActivity();
  }
}

async function loadAgentStats() {
  try {
    const res = await fetch(`${API}/api/agent-stats`);
    const data = await res.json();
    const json = JSON.stringify(data);
    const changed = json !== _lastAgentStatsJSON;
    if (changed) { _lastAgentStatsJSON = json; agentStats = data; }
    if (changed && currentPage === 'dashboard') renderAgents();
    if (currentPage === 'taskmanager') loadTaskManager();
    if (changed && currentPage === 'orgchart') renderOrgChart();
  } catch(e) { console.error('Failed to load agent stats', e); }
}

async function loadLiveTasks() {
  try { const res = await fetch(`${API}/api/live-tasks`); liveTasks = await res.json(); } catch(e) { console.error('Failed to load live tasks', e); }
}

// ── Navigation ─────────────────────────────────────────────────
const PATH_TO_PAGE = {
  '/': 'dashboard', '/dashboard': 'dashboard',
  '/task-manager': 'taskmanager', '/taskmanager': 'taskmanager',
  '/org-chart': 'orgchart', '/orgchart': 'orgchart',
  '/scheduled-tasks': 'scheduled', '/scheduled': 'scheduled',
  '/workspaces': 'workspaces', '/standups': 'standups',
  '/actions': 'actions', '/docs': 'docs', '/reports': 'reports', '/voice': 'voice',
};
const PAGE_TO_PATH = {
  'dashboard': '/', 'taskmanager': '/task-manager', 'orgchart': '/org-chart',
  'scheduled': '/scheduled-tasks', 'workspaces': '/workspaces', 'standups': '/standups',
  'actions': '/actions', 'docs': '/docs', 'reports': '/reports', 'voice': '/voice',
};

function navigateTo(page, pushState = true) {
  currentPage = page;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (pushState) {
    const path = PAGE_TO_PATH[page] || '/';
    history.pushState({ page }, '', path);
  }
  if (page === 'taskmanager') loadTaskManager();
  if (page === 'orgchart') renderOrgChart();
  if (page === 'scheduled') loadScheduledTasks();
  if (page === 'workspaces') loadWorkspaces();
  if (page === 'standups') loadStandups();
  if (page === 'actions') loadActionItems();
  if (page === 'docs') loadDocs();
  if (page === 'reports') loadReports();
}

window.addEventListener('popstate', (e) => {
  const page = (e.state && e.state.page) || PATH_TO_PAGE[location.pathname] || 'dashboard';
  navigateTo(page, false);
});

(function initRoute() {
  const page = PATH_TO_PAGE[location.pathname] || 'dashboard';
  if (page !== 'dashboard') navigateTo(page, false);
  history.replaceState({ page }, '', PAGE_TO_PATH[page] || '/');
})();

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════

async function loadTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
    tasks = await res.json();
    // Board rendering is triggered by loadAll after all data is loaded
  } catch(e) { console.error('Failed to load tasks', e); }
}

function renderBoard() {
  const cols = { todo: [], in_progress: [], review: [], done: [] };
  // Add DB tasks
  tasks.forEach(t => { const s = t.status in cols ? t.status : 'todo'; cols[s].push(t); });
  // Add live tasks (from session files)
  liveTasks.forEach(t => { const s = t.status in cols ? t.status : 'in_progress'; cols[s].push(t); });
  const CARD_LIMIT = 8;
  for (const [status, items] of Object.entries(cols)) {
    const el = document.getElementById(`col-${status}`);
    if (el) {
      const expanded = el.dataset.expanded === 'true';
      const visible = expanded ? items : items.slice(0, CARD_LIMIT);
      const hidden = items.length - visible.length;
      el.innerHTML = visible.map(t => t.is_live ? liveTaskCardHTML(t) : taskCardHTML(t)).join('');
      if (hidden > 0) {
        el.innerHTML += `<button class="btn btn-sm" style="width:100%;margin-top:4px;text-align:center;color:var(--accent)" onclick="this.parentElement.dataset.expanded='true';renderBoard()">Show ${hidden} more…</button>`;
      } else if (expanded && items.length > CARD_LIMIT) {
        el.innerHTML += `<button class="btn btn-sm" style="width:100%;margin-top:4px;text-align:center;color:var(--accent)" onclick="this.parentElement.dataset.expanded='false';renderBoard()">Show less</button>`;
      }
      document.getElementById(`count-${status}`).textContent = items.length;
    }
  }
  document.querySelectorAll('.task-card:not(.live-task)').forEach(card => {
    card.addEventListener('dragstart', e => { draggedTaskId = card.dataset.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); document.querySelectorAll('.col-cards').forEach(c => c.classList.remove('drag-over')); });
  });
}

function liveTaskCardHTML(t) {
  const info = AGENT_INFO[t.assigned_agent] || { name: t.assigned_agent, emoji: '🤖' };
  // For active tasks, calculate duration live from created_at to now
  let dur = '';
  if (t.status === 'in_progress' && t.created_at) {
    const elapsed = (Date.now() - new Date(t.created_at).getTime()) / 1000;
    if (elapsed > 0) dur = formatDuration(elapsed);
  } else if (t.duration && t.duration > 0) {
    dur = formatDuration(t.duration);
  }
  const tokens = t.tokens ? formatTokens(t.tokens) : '';
  const sourceIcon = t.source === 'cron' ? '⏰' : t.source === 'subagent' ? '🔀' : '🎮';
  const activePulse = t.status === 'in_progress' ? ' live-pulse' : '';
  const modelStr = t.model ? t.model.replace('anthropic/', '').replace('claude-', 'c-') : '—';
  const costStr = t.cost != null && t.cost > 0 ? `$${t.cost.toFixed(2)}` : '—';
  const timeRef = (t.status === 'done' || t.status === 'review') ? (t.completed_at || t.updated_at || t.created_at) : t.created_at;
  const timeLabel = (t.status === 'done' || t.status === 'review') ? 'completed ' : '';
  const badgeLabel = t.status === 'done' ? '✅ DONE' : t.status === 'review' ? '👀 REVIEW' : `${sourceIcon} LIVE`;
  const badgeClass = t.status === 'in_progress' ? 'task-live-badge' : 'task-live-badge' + (t.status === 'done' ? ' badge-done' : ' badge-review');
  return `<div class="task-card live-task${activePulse}" data-id="${t.id}" onclick="openLiveDetail('${t.id}')">
    <div class="${badgeClass}">${badgeLabel}</div>
    <div class="task-title">${esc(cleanTitle(t.title))}</div>
    <div class="task-meta">
      <span class="task-agent">${info.emoji} ${info.name}</span>
      ${tokens ? `<span class="task-tokens">🔤 ${tokens}</span>` : ''}
      ${t.status === 'in_progress' && t.created_at ? `<span class="task-duration" data-created-at="${t.created_at}" data-tick-duration>⏱ ${dur}</span>` : (dur ? `<span class="task-duration">⏱ ${dur}</span>` : '')}
      <span class="task-time" data-time-ago="${timeRef}" data-time-prefix="${timeLabel}">${timeLabel}${timeAgo(timeRef)}</span>
    </div>
    <div class="task-model-cost">${modelStr} · ${costStr}</div>
    ${t.status === 'review' ? `<div class="task-review-actions" onclick="event.stopPropagation()"><button class="btn-approve" onclick="approveTask('${t.id}')">✅ Approve</button><button class="btn-reject" onclick="rejectTask('${t.id}')">↩️ Reject</button></div>` : ''}
  </div>`;
}

function taskCardHTML(t) {
  const agent = agents.find(a => a.name === t.assigned_agent);
  const agentLabel = agent ? `${agent.emoji} ${agent.display_name}` : (t.assigned_agent || 'Unassigned');
  let dur = '';
  if (t.status === 'in_progress' && t.created_at) {
    const elapsed = (Date.now() - new Date(t.created_at).getTime()) / 1000;
    if (elapsed > 0) dur = formatDuration(elapsed);
  } else if (t.duration && t.duration > 0) {
    dur = formatDuration(t.duration);
  }
  const tModelStr = t.model ? t.model.replace('anthropic/', '').replace('claude-', 'c-') : '—';
  const tCostStr = t.cost != null && t.cost > 0 ? `$${t.cost.toFixed(2)}` : '—';
  const tTimeRef = (t.status === 'done' || t.status === 'review') ? (t.completed_at || t.updated_at || t.created_at) : t.created_at;
  const tTimeLabel = (t.status === 'done' || t.status === 'review') ? 'completed ' : '';
  return `<div class="task-card" draggable="true" data-id="${t.id}" onclick="openDetail('${t.id}')">
    <div class="task-title">${esc(cleanTitle(t.title))}</div>
    <div class="task-meta">
      <span class="task-agent">${esc(agentLabel)}</span>
      <span class="task-priority priority-${t.priority}">${t.priority}</span>
      <span class="task-time" data-time-ago="${tTimeRef}" data-time-prefix="${tTimeLabel}">${tTimeLabel}${timeAgo(tTimeRef)}</span>
      ${t.status === 'in_progress' && t.created_at ? `<span class="task-duration" data-created-at="${t.created_at}" data-tick-duration>⏱ ${dur}</span>` : (dur ? `<span class="task-duration">⏱ ${dur}</span>` : '')}
    </div>
    <div class="task-model-cost">${tModelStr} · ${tCostStr}</div>
    ${t.status === 'review' ? `<div class="task-review-actions" onclick="event.stopPropagation()"><button class="btn-approve" onclick="approveTask('${t.id}')">✅ Approve</button><button class="btn-reject" onclick="rejectTask('${t.id}')">↩️ Reject</button></div>` : ''}
  </div>`;
}

function allowDrop(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function drop(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const col = e.currentTarget.id.replace('col-', '');
  if (!draggedTaskId) return;
  try { await fetch(`${API}/api/tasks/${draggedTaskId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:col}) }); await loadTasks(); renderBoard(); } catch(e) { console.error(e); }
  draggedTaskId = null;
}

let _lastAgentsJSON = '';
let _lastAgentStatsJSON = '';
async function loadAgents() {
  try {
    const res = await fetch(`${API}/api/agents`);
    const data = await res.json();
    const json = JSON.stringify(data);
    if (json !== _lastAgentsJSON) { _lastAgentsJSON = json; agents = data; rebuildAgentInfo(); renderAgents(); if (currentPage === 'orgchart') renderOrgChart(); }
  } catch(e) { console.error('Failed to load agents', e); }
}

function renderAgents() {
  const el = document.getElementById('agentsList');
  if (!el) return;
  const activeCount = agentStats.filter(s => s.active).length;
  const statusEl = document.getElementById('navStatus');
  if (statusEl) statusEl.textContent = `${agents.length} agents · ${activeCount} active`;
  const items = agents.map(a => {
    const stats = agentStats.find(s => s.name === a.name);
    const isActive = stats ? stats.active : a.status === 'busy';
    const statusLabel = isActive ? 'active' : 'idle';
    const statusClass = isActive ? 'busy' : 'idle';
    const tokenStr = stats ? formatTokens(stats.main_session_tokens) + ' / ' + formatTokens(stats.context_limit) : '—';
    const ctxPct = stats ? stats.context_pct : 0;
    const ctxBarColor = ctxPct > 80 ? 'var(--red)' : ctxPct > 50 ? 'var(--orange)' : 'var(--green)';
    const costStr = stats && stats.total_cost > 0 ? `$${stats.total_cost.toFixed(2)}` : '$0.00';
    const modelStr = (stats && stats.model) ? stats.model.replace('anthropic/', '') : (a.model ? a.model.replace('anthropic/', '') : '—');
    const sessCount = stats ? stats.active_sessions : 0;
    const lastAct = a.last_activity ? timeAgo(a.last_activity) : 'No activity';
    // Find active live task for this agent to show duration
    const agentLiveTask = liveTasks.find(lt => lt.assigned_agent === a.name && lt.status === 'in_progress');
    const liveCreatedAt = agentLiveTask ? agentLiveTask.created_at : '';
    const liveDur = liveCreatedAt ? formatDuration((Date.now() - new Date(liveCreatedAt).getTime()) / 1000) : '';
    const subagentCount = stats ? stats.subagent_count : 0;
    const activeSubagents = stats ? stats.active_subagents : 0;
    return { name: a.name, emoji: a.emoji, displayName: a.display_name, statusLabel, statusClass, tokenStr, ctxPct, ctxBarColor, costStr, modelStr, lastAct, lastActivity: a.last_activity || '', liveCreatedAt, liveDur, sessCount, subagentCount, activeSubagents };
  });
  // Check if agent list structure changed
  const cards = el.querySelectorAll('.agent-card[data-agent]');
  const cardNames = Array.from(cards).map(c => c.dataset.agent);
  const desiredNames = items.map(d => d.name);
  if (cardNames.join(',') !== desiredNames.join(',')) {
    // Full re-render
    el.innerHTML = items.map(d => `<div class="agent-card" data-agent="${d.name}">
      <div class="agent-top"><span class="agent-emoji">${d.emoji}</span><span class="agent-name">${esc(d.displayName)}</span><span class="agent-status status-${d.statusClass}">${d.statusLabel}</span></div>
      <div class="agent-token-row"><span class="agent-token-label">Context</span><span class="agent-token-value">${d.tokenStr}</span></div>
      <div class="agent-ctx-bar"><div class="agent-ctx-fill" style="width:${Math.min(d.ctxPct,100)}%;background:${d.ctxBarColor}"></div></div>
      <div class="agent-meta-model">🧠 ${esc(d.modelStr)}</div>
      ${d.liveCreatedAt ? `<div class="agent-meta"><span data-created-at="${d.liveCreatedAt}" data-tick-duration>⏱ ${d.liveDur}</span><span>📊 ${d.sessCount} sessions</span></div>` : ''}
      ${d.subagentCount > 0 ? `<div class="agent-meta agent-subagent-row" onclick="openSubagentPanel('${d.name}',event)"><span>🔀 ${d.activeSubagents > 0 ? d.activeSubagents + ' active / ' : ''}${d.subagentCount} sub-agents</span></div>` : ''}
      <div class="agent-meta"><span>💰 ${d.costStr}</span><span ${d.lastActivity ? `data-time-ago="${d.lastActivity}" data-time-prefix="🕐 "` : ''}>🕐 ${d.lastAct}</span></div>
    </div>`).join('');
    return;
  }
  // Patch in-place — no DOM replacement, no flicker
  items.forEach((d, i) => {
    const card = cards[i];
    const statusSpan = card.querySelector('.agent-status');
    if (statusSpan.textContent !== d.statusLabel) { statusSpan.textContent = d.statusLabel; statusSpan.className = `agent-status status-${d.statusClass}`; }
    const tokenVal = card.querySelector('.agent-token-value');
    if (tokenVal) tokenVal.textContent = d.tokenStr;
    const ctxFill = card.querySelector('.agent-ctx-fill');
    if (ctxFill) { ctxFill.style.width = Math.min(d.ctxPct, 100) + '%'; ctxFill.style.background = d.ctxBarColor; }
    const modelEl = card.querySelector('.agent-meta-model');
    if (modelEl) modelEl.textContent = '🧠 ' + d.modelStr;
    const metaDivs = card.querySelectorAll('.agent-meta');
    // Last meta div has cost + time
    const lastMeta = metaDivs[metaDivs.length - 1];
    if (lastMeta) {
      const costEl = lastMeta.querySelector('span:first-child');
      if (costEl) costEl.textContent = '💰 ' + d.costStr;
      const timeEl = lastMeta.querySelector('span:last-child');
      if (timeEl && d.lastActivity) { timeEl.dataset.timeAgo = d.lastActivity; timeEl.dataset.timePrefix = '🕐 '; timeEl.textContent = '🕐 ' + d.lastAct; }
    }
  });
}

function formatTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n/1_000) + 'k';
  return String(n);
}

let _activityIds = new Set();
let _activityFilter = '';

async function loadActivity() {
  const agent = document.getElementById('activityFilter').value;
  const filterChanged = agent !== _activityFilter;
  _activityFilter = agent;
  const q = agent ? `?agent=${agent}&limit=50` : '?limit=50';
  try {
    const res = await fetch(`${API}/api/activity${q}`);
    const items = await res.json();
    if (filterChanged) { _activityIds.clear(); document.getElementById('activityFeed').innerHTML = ''; }
    renderActivity(items, filterChanged);
  } catch(e) { console.error(e); }
}

function activityItemHTML(a) {
  const ag = agents.find(x => x.name === a.agent);
  const agentEmoji = ag ? ag.emoji : '🤖';
  const agentName = ag ? ag.display_name : (a.agent || 'System');
  const agentColor = AGENT_INFO[a.agent]?.color || 'var(--accent)';
  const details = a.details || '';
  const isFail = !a.success;
  const statusCls = isFail ? 'act-fail' : 'act-ok';

  let icon, label, body;

  switch (a.action) {
    case 'status_change': {
      icon = '🔄';
      label = 'status change';
      // Parse "from → to: Task Title"
      const m = details.match(/^(\S+)\s*→\s*(\S+):\s*(.*)$/);
      if (m) {
        const fromBadge = `<span class="act-status-pill act-status-${m[1]}">${m[1].replace('_',' ')}</span>`;
        const toBadge = `<span class="act-status-pill act-status-${m[2]}">${m[2].replace('_',' ')}</span>`;
        body = `${fromBadge} <span class="act-arrow">→</span> ${toBadge}<div class="act-task-title">${esc(m[3])}</div>`;
      } else {
        body = `<div class="act-detail-text">${esc(details)}</div>`;
      }
      break;
    }
    case 'comment_added': {
      icon = '💬';
      label = 'comment';
      const taskTitle = a.task_id ? tasks.find(t => t.id === a.task_id)?.title : null;
      body = `<div class="act-comment-body">${esc(details)}</div>`;
      if (taskTitle) body += `<div class="act-task-ref">on <strong>${esc(taskTitle)}</strong></div>`;
      break;
    }
    case 'task_created': {
      icon = '📦';
      label = 'new task';
      // Parse "Created: Title"
      const title = details.replace(/^Created:\s*/i, '');
      body = `<div class="act-task-title">${esc(title)}</div>`;
      break;
    }
    case 'task_started': {
      icon = '🚀';
      label = 'started';
      body = `<div class="act-task-title">${esc(details)}</div>`;
      break;
    }
    case 'task_completed': {
      icon = '✅';
      label = 'completed';
      body = `<div class="act-task-title">${esc(details)}</div>`;
      break;
    }
    case 'task_error': {
      icon = '❌';
      label = 'error';
      body = `<div class="act-detail-text act-error-text">${esc(details)}</div>`;
      break;
    }
    case 'cron_run': {
      icon = '⏰';
      label = 'cron';
      // Parse "Status: ok | Duration: 9497ms" or "Job: name | Status: ok | Duration: 1234ms"
      const statusM = details.match(/Status:\s*(\w+)/i);
      const durM = details.match(/Duration:\s*(\d+)ms/i);
      const jobM = details.match(/Job:\s*([^|]+)/i);
      const cronStatus = statusM ? statusM[1] : 'unknown';
      const cronDurMs = durM ? parseInt(durM[1]) : null;
      const cronJob = jobM ? jobM[1].trim() : null;
      const sBadge = cronStatus === 'ok'
        ? '<span class="act-cron-badge act-cron-ok">✓ ok</span>'
        : `<span class="act-cron-badge act-cron-fail">✗ ${esc(cronStatus)}</span>`;
      const dBadge = cronDurMs != null ? `<span class="act-cron-dur">⏱ ${formatDuration(cronDurMs / 1000)}</span>` : '';
      body = `${cronJob ? `<span class="act-cron-name">${esc(cronJob)}</span>` : ''}${sBadge}${dBadge}`;
      break;
    }
    case 'subagent_spawned': {
      icon = '🔀';
      label = 'spawned sub-agent';
      body = `<div class="act-task-title">${esc(details)}</div>`;
      break;
    }
    case 'subagent_completed': {
      icon = '🏁';
      label = 'sub-agent done';
      const durM2 = details.match(/Duration:\s*(\d+)s/i);
      const durStr = durM2 ? `<span class="act-cron-dur">⏱ ${formatDuration(parseInt(durM2[1]))}</span>` : '';
      body = `<div class="act-task-title">${esc(details.replace(/\s*\|\s*Duration:.*$/, ''))}</div>${durStr}`;
      break;
    }
    default: {
      icon = '📌';
      label = a.action.replace(/_/g, ' ');
      body = details ? `<div class="act-detail-text">${esc(details)}</div>` : '';
    }
  }

  const failBadge = isFail ? '<span class="activity-badge badge-fail">FAILED</span>' : '';

  return `<div class="activity-item ${statusCls}" data-activity-id="${a.id}">
    <div class="activity-icon" style="border-color:${agentColor}">${agentEmoji}</div>
    <div class="activity-content">
      <div class="activity-header-row">
        <span class="act-agent" style="color:${agentColor}">${esc(agentName)}</span>
        <span class="act-label">${icon} ${label}</span>
        ${failBadge}
      </div>
      <div class="activity-body">${body}</div>
    </div>
    <div class="activity-time" data-time-ago="${a.created_at}">${timeAgo(a.created_at)}</div>
  </div>`;
}

function renderActivity(items, fullReplace) {
  const el = document.getElementById('activityFeed');
  if (!items.length) { el.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">No activity yet</p>'; _activityIds.clear(); return; }

  if (fullReplace || _activityIds.size === 0) {
    // Full render
    _activityIds = new Set(items.map(a => a.id));
    el.innerHTML = items.map(activityItemHTML).join('');
    return;
  }

  // Incremental: find new items not in our set
  const newItems = items.filter(a => !_activityIds.has(a.id));
  if (!newItems.length) return;

  // Add new IDs
  newItems.forEach(a => _activityIds.add(a.id));

  // Prepend new items with animation
  const fragment = document.createDocumentFragment();
  newItems.reverse().forEach(a => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = activityItemHTML(a);
    const node = wrapper.firstElementChild;
    node.classList.add('activity-new');
    fragment.appendChild(node);
  });
  el.insertBefore(fragment, el.firstChild);

  // Trigger animation after insert
  requestAnimationFrame(() => {
    el.querySelectorAll('.activity-new').forEach(n => {
      n.offsetHeight; // force reflow
      n.classList.remove('activity-new');
    });
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById(tab === 'board' ? 'boardView' : 'activityView').classList.add('active');
  if (tab === 'activity') loadActivity();
}

// ── Task Detail Modal ──────────────────────────────────────────
function buildPremiumModal(t, isLive) {
  const info = AGENT_INFO[t.assigned_agent] || { name: t.assigned_agent || 'Unassigned', emoji: '🤖', color: '#888' };
  const agentFromDB = agents.find(a => a.name === t.assigned_agent);
  const agentName = agentFromDB ? agentFromDB.display_name : info.name;
  const agentEmoji = agentFromDB ? agentFromDB.emoji : info.emoji;
  const agentColor = info.color || 'var(--accent)';
  const agentRole = t.assigned_agent ? t.assigned_agent.replace('-',' ').toUpperCase() : 'UNASSIGNED';

  const isDone = t.status === 'done' || t.status === 'review';
  const isActive = t.status === 'in_progress';

  // Duration
  let dur = '—';
  if (isActive && t.created_at) {
    const elapsed = (Date.now() - new Date(t.created_at).getTime()) / 1000;
    dur = `<span data-created-at="${t.created_at}" data-tick-duration="1">` + formatDuration(elapsed) + '</span>';
  } else if (t.duration) {
    dur = formatDuration(t.duration);
  }

  const modelStr = t.model || '—';
  const costStr = t.cost != null && t.cost > 0 ? `$${t.cost.toFixed(2)}` : '—';
  const tokens = t.tokens ? formatTokens(t.tokens) : '—';
  const startTime = t.created_at ? new Date(t.created_at).toLocaleString() : '—';
  const startAgo = t.created_at ? timeAgo(t.created_at) : '—';

  let html = '';

  // Agent block
  html += `<div class="premium-agent">
    <div class="premium-agent-icon" style="background:${agentColor}22;border:1px solid ${agentColor}44">${agentEmoji}</div>
    <div><div class="premium-agent-name">${esc(agentName)}</div><div class="premium-agent-role">${agentRole}</div></div>
  </div>`;

  // 6-cell stats grid (2×3) with SVG icons
  const svgClock = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  const svgToken = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M6 12h12"/></svg>';
  const svgCost = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>';
  const svgModel = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M9 2v2M15 20v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></svg>';
  const svgCalendar = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const svgElapsed = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><path d="M22 12A10 10 0 003.2 7.2" opacity=".4"/></svg>';

  html += `<div class="premium-grid">
    <div class="premium-stat"><div class="stat-icon" style="color:#00E676">${svgClock}</div><div class="stat-label">Duration</div><div class="stat-value">${dur}</div></div>
    <div class="premium-stat"><div class="stat-icon" style="color:#ffab40">${svgToken}</div><div class="stat-label">Tokens</div><div class="stat-value">${tokens}</div></div>
    <div class="premium-stat"><div class="stat-icon" style="color:#00bcd4">${svgCost}</div><div class="stat-label">Est. Cost</div><div class="stat-value">${costStr}</div></div>
    <div class="premium-stat"><div class="stat-icon" style="color:#e040fb">${svgModel}</div><div class="stat-label">Model</div><div class="stat-value" style="font-size:.76rem">${esc(modelStr)}</div></div>
    <div class="premium-stat"><div class="stat-icon" style="color:#6c63ff">${svgCalendar}</div><div class="stat-label">Started</div><div class="stat-value" style="font-size:.76rem">${startTime}</div></div>
    <div class="premium-stat"><div class="stat-icon" style="color:#00bcd4">${svgElapsed}</div><div class="stat-label">Elapsed</div><div class="stat-value" data-time-ago="${t.created_at || ''}" data-time-prefix="">${startAgo}</div></div>
  </div>`;

  // Session key (truncated, click to copy)
  if (t.session_key || t.id) {
    const fullKey = t.session_key || t.id;
    const shortKey = fullKey.length > 32 ? fullKey.slice(0,16) + '…' + fullKey.slice(-8) : fullKey;
    html += `<div class="premium-session" title="${esc(fullKey)}" onclick="navigator.clipboard.writeText('${esc(fullKey)}').then(()=>{this.textContent='✓ Copied!';setTimeout(()=>{this.textContent='🔑 ${esc(shortKey)}'},1500)})">🔑 ${esc(shortKey)}</div>`;
  }

  return html;
}

async function openDetail(id) {
  try {
    const res = await fetch(`${API}/api/tasks/${id}`);
    const t = await res.json();
    document.getElementById('detailTitle').textContent = t.title;
    // Add status pills to header
    const headerEl = document.querySelector('#detailModal .modal-header');
    let existingPills = headerEl.querySelector('.header-pills');
    if (!existingPills) { existingPills = document.createElement('div'); existingPills.className = 'header-pills'; headerEl.insertBefore(existingPills, headerEl.querySelector('.modal-close')); }
    const statusPillClass = t.status === 'in_progress' ? 'pill-live' : t.status === 'done' ? 'pill-done' : t.status === 'review' ? 'pill-review' : 'pill-todo';
    const statusLabel = t.status === 'in_progress' ? '🔄 LIVE' : t.status === 'done' ? '✅ Done' : t.status === 'review' ? '👀 Review' : '📋 Todo';
    const priorityPill = t.priority ? `<span class="status-pill pill-priority">${t.priority}</span>` : '';
    existingPills.innerHTML = `<span class="status-pill ${statusPillClass}">${statusLabel}</span>${priorityPill}`;

    // 1. Status buttons row
    let html = `<div class="premium-actions">${['todo','in_progress','review','done'].map(s => `<button class="btn btn-sm ${t.status===s?'btn-primary':''}" onclick="moveTask('${t.id}','${s}')">${s.replace('_',' ')}</button>`).join('')}<button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')">🗑️</button></div>`;

    // 2-6. Agent + grid + session (status badge now in header)
    html += buildPremiumModal(t, false);

    // 7. Description
    if (t.description) html += `<div class="detail-section"><h3>Description</h3><div class="detail-desc">${renderMarkdown(t.description)}</div></div>`;

    // Attachments
    html += renderAttachmentsSection(t);

    // 8. Comments & Logs
    if (t.comments && t.comments.length) {
      html += `<div class="detail-section"><h3>Comments &amp; Logs (${t.comments.length})</h3><div class="comments-scroll">`;
      t.comments.forEach(c => {
        const cA = agents.find(a => a.name === c.agent);
        const cN = cA ? cA.display_name : (c.agent || 'System');
        html += `<div class="comment-item type-${c.type}"><div class="comment-header"><span><span class="comment-agent">${esc(cN)}</span><span class="comment-type">${c.type}</span></span><span data-time-ago="${c.created_at}">${timeAgo(c.created_at)}</span></div><div class="comment-content">${esc(c.content)}</div></div>`;
      });
      html += '</div></div>';
    }

    // 9. History
    if (t.history && t.history.length) {
      html += `<div class="detail-section"><h3>History</h3><div class="history-scroll"><div class="history-list">`;
      t.history.forEach(h => {
        html += `<div class="history-item"><span class="history-time" data-time-ago="${h.created_at}">${timeAgo(h.created_at)}</span><span class="history-action">${h.action.replace(/_/g,' ')}</span><span class="history-detail">— ${esc(h.details || '')}</span></div>`;
      });
      html += '</div></div></div>';
    }

    // 10. Approve/Reject for review tasks
    if (t.status === 'review') {
      html += `<div class="detail-section"><div class="task-review-actions" style="justify-content:center"><button class="btn-approve" style="padding:10px 24px;font-size:.9rem" onclick="approveTask('${t.id}')">✅ Approve &amp; Mark Done</button><button class="btn-reject" style="padding:10px 24px;font-size:.9rem" onclick="rejectTask('${t.id}')">↩️ Reject &amp; Send Back</button></div></div>`;
    }
    // 11. Add Comment
    html += `<div class="detail-section"><h3>Add Comment</h3><textarea id="commentText" rows="3" placeholder="Add a comment..." style="width:100%;padding:10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--card);color:var(--text);font-family:inherit;font-size:.83rem;margin-bottom:8px"></textarea><button class="btn btn-sm" style="background:var(--red);color:#fff;border-color:var(--red)" onclick="addComment('${t.id}')">Add Comment</button></div>`;

    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailModal').classList.add('open');
  } catch(e) { console.error(e); }
}

// ── Attachments UI ─────────────────────────────────────────────
function renderAttachmentsSection(t) {
  const attachments = t.attachments || [];
  // Also extract image URLs from description
  const descImages = [];
  if (t.description) {
    const urlRe = /https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s"'<>]*)?/gi;
    let m; while ((m = urlRe.exec(t.description)) !== null) descImages.push(m[0]);
  }
  const allImages = [...attachments.map(a => ({ url: a.url, thumb: a.thumbnail_url || a.url, name: a.filename, id: a.id })), ...descImages.map(u => ({ url: u, thumb: u, name: u.split('/').pop().split('?')[0], id: null }))];

  let html = `<div class="detail-section" style="margin-top:20px"><h3>📎 Attachments${allImages.length ? ` (${allImages.length})` : ''}</h3>`;
  if (allImages.length) {
    html += '<div class="attachments-grid">';
    allImages.forEach(img => {
      html += `<div class="attachment-thumb" onclick="openLightbox('${esc(img.url)}')">
        <img src="${esc(img.thumb)}" alt="${esc(img.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'attachment-broken\\'>🖼️<br>${esc(img.name)}</div>'">
        <div class="attachment-name">${esc(img.name)}</div>
      </div>`;
    });
    html += '</div>';
  } else {
    html += '<div style="color:var(--muted);font-size:.83rem;padding:8px 0">No attachments yet</div>';
  }
  // Upload hint (for future use)
  if (t.id && !t.is_live) {
    html += `<div style="margin-top:8px"><button class="btn btn-sm" onclick="promptAttachmentUrl('${t.id}')">➕ Add Image URL</button></div>`;
  }
  html += '</div>';
  return html;
}

function promptAttachmentUrl(taskId) {
  const url = prompt('Enter image URL:');
  if (!url) return;
  const filename = url.split('/').pop().split('?')[0] || 'image.png';
  fetch(`${API}/api/tasks/${taskId}/attachments`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ task_id: taskId, filename, url, mime_type: 'image/png', uploaded_by: 'user' })
  }).then(() => openDetail(taskId)).catch(console.error);
}

function openLightbox(url) {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox-overlay';
    lb.onclick = closeLightbox;
    lb.innerHTML = '<div class="lightbox-content" onclick="event.stopPropagation()"><img id="lightboxImg" src=""><button class="lightbox-close" onclick="closeLightbox()">✕</button></div>';
    document.body.appendChild(lb);
  }
  document.getElementById('lightboxImg').src = url;
  lb.classList.add('open');
}

function closeLightbox() {
  const lb = document.getElementById('lightbox');
  if (lb) lb.classList.remove('open');
}

function closeDetail() { document.getElementById('detailModal').classList.remove('open'); const pills = document.querySelector('#detailModal .header-pills'); if (pills) pills.remove(); }
function closeDetailIfOutside(e) { if (e.target === e.currentTarget) closeDetail(); }

function openLiveDetail(id) {
  const t = liveTasks.find(lt => lt.id === id);
  if (!t) return;
  document.getElementById('detailTitle').textContent = t.title;
  // Add status pills to header
  const headerEl = document.querySelector('#detailModal .modal-header');
  let existingPills = headerEl.querySelector('.header-pills');
  if (!existingPills) { existingPills = document.createElement('div'); existingPills.className = 'header-pills'; headerEl.insertBefore(existingPills, headerEl.querySelector('.modal-close')); }
  const statusPillClass = t.status === 'in_progress' ? 'pill-live' : t.status === 'done' ? 'pill-done' : 'pill-review';
  const statusLabel = t.status === 'in_progress' ? '🔄 LIVE' : t.status === 'done' ? '✅ Done' : '👀 Review';
  const sourceIcon = t.source === 'cron' ? '⏰' : t.source === 'subagent' ? '🔀' : '🎮';
  const sourceLabel = t.source === 'cron' ? 'Cron Job' : t.source === 'subagent' ? 'Sub-agent' : 'Interactive';
  existingPills.innerHTML = `<span class="status-pill ${statusPillClass}">${statusLabel}</span><span class="status-pill pill-priority">${sourceIcon} ${sourceLabel}</span>`;

  let html = '';

  // Status badge + agent + grid + session
  html += buildPremiumModal(t, true);

  // Description
  if (t.description) html += `<div class="detail-section"><h3>Description</h3><div class="detail-desc">${renderMarkdown(t.description)}</div></div>`;
  html += renderAttachmentsSection(t);

  // Live session info
  html += `<div class="detail-section"><h3>Live Session Info</h3><div style="font-size:.83rem;color:var(--muted);line-height:1.8">
    <div>📡 <strong>Source:</strong> ${sourceLabel}</div>
    ${t.updated_at ? `<div>🔄 <strong>Last Update:</strong> <span data-time-ago="${t.updated_at}">${timeAgo(t.updated_at)}</span></div>` : ''}
    ${t.priority ? `<div>📊 <strong>Priority:</strong> ${t.priority}</div>` : ''}
  </div></div>`;

  // Approve/Reject buttons for review tasks
  if (t.status === 'review') {
    html += `<div class="detail-section"><div class="task-review-actions" style="justify-content:center"><button class="btn-approve" style="padding:10px 24px;font-size:.9rem" onclick="approveTask('${t.id}')">✅ Approve &amp; Mark Done</button><button class="btn-reject" style="padding:10px 24px;font-size:.9rem" onclick="rejectTask('${t.id}')">↩️ Reject &amp; Send Back</button></div></div>`;
  }

  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailModal').classList.add('open');
}
async function moveTask(id, status) { await fetch(`${API}/api/tasks/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status}) }); closeDetail(); await loadTasks(); renderBoard(); }
async function deleteTask(id) { if (!confirm('Delete this task?')) return; await fetch(`${API}/api/tasks/${id}`, { method:'DELETE' }); closeDetail(); await loadTasks(); renderBoard(); }
async function approveTask(id) { await fetch(`${API}/api/tasks/${id}/approve`, { method:'POST' }); closeDetail(); await loadTasks(); renderBoard(); }
async function rejectTask(id) { await fetch(`${API}/api/tasks/${id}/reject`, { method:'POST' }); closeDetail(); await loadTasks(); renderBoard(); }
async function addComment(taskId) { const text = document.getElementById('commentText').value.trim(); if (!text) return; await fetch(`${API}/api/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:taskId,content:text,agent:'',type:'comment'}) }); openDetail(taskId); }

function openCreateModal() { document.getElementById('createModal').classList.add('open'); }
function closeCreate() { document.getElementById('createModal').classList.remove('open'); }
function closeCreateIfOutside(e) { if (e.target === e.currentTarget) closeCreate(); }
async function createTask(e) {
  e.preventDefault();
  const data = { title: document.getElementById('newTitle').value, description: document.getElementById('newDesc').value, assigned_agent: document.getElementById('newAgent').value, priority: document.getElementById('newPriority').value, status: 'todo' };
  await fetch(`${API}/api/tasks`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  closeCreate(); document.getElementById('newTitle').value = ''; document.getElementById('newDesc').value = ''; await loadTasks(); renderBoard();
}

// ══════════════════════════════════════════════════════════════
// TASK MANAGER
// ══════════════════════════════════════════════════════════════

async function loadTaskManager() {
  const activeCount = agentStats.filter(s => s.active).length;
  const idleCount = agents.length - activeCount;
  const error = agents.filter(a => a.status === 'error').length;
  document.getElementById('stat-total').textContent = agents.length;
  document.getElementById('stat-active').textContent = activeCount;
  document.getElementById('stat-idle').textContent = idleCount;
  document.getElementById('stat-busy').textContent = activeCount;
  document.getElementById('stat-error').textContent = error;
  const totalSubagents = agentStats.reduce((sum, s) => sum + (s.subagent_count || 0), 0);
  const activeSubagentsTotal = agentStats.reduce((sum, s) => sum + (s.active_subagents || 0), 0);
  const subEl = document.getElementById('stat-subagents');
  if (subEl) subEl.textContent = activeSubagentsTotal > 0 ? `${activeSubagentsTotal}/${totalSubagents}` : totalSubagents;
  const row = document.getElementById('agentCardsRow');
  row.innerHTML = agents.map(a => {
    const stats = agentStats.find(s => s.name === a.name);
    const isActive = stats ? stats.active : false;
    const statusLabel = isActive ? 'active' : 'idle';
    const sc = isActive ? 'background:rgba(255,171,64,.15);color:#ffab40' : 'background:rgba(0,188,212,.15);color:#00bcd4';
    const tokenStr = stats ? formatTokens(stats.main_session_tokens) + ' / ' + formatTokens(stats.context_limit) : '—';
    const ctxPct = stats ? stats.context_pct : 0;
    const ctxColor = ctxPct > 80 ? 'var(--red)' : ctxPct > 50 ? 'var(--orange)' : 'var(--green)';
    const costStr = stats ? `$${stats.total_cost.toFixed(2)}` : '$0.00';
    const sessCount = stats ? stats.session_count : 0;
    const activeSess = stats ? stats.active_sessions : 0;
    return `<div class="agent-card-lg" onclick="openAgentSessions('${a.name}')"><div class="agent-card-lg-top"><div class="agent-avatar">${a.emoji}</div><div class="agent-card-lg-info"><h3>${esc(a.display_name)}</h3><div class="model-tag">${esc(stats?.model || a.model)}</div></div><span class="agent-status-pill" style="${sc}">${statusLabel}</span></div>
    <div class="agent-ctx-row"><span>Context: ${tokenStr}</span><span style="color:${ctxColor}">${ctxPct}%</span></div>
    <div class="agent-ctx-bar-lg"><div class="agent-ctx-fill" style="width:${Math.min(ctxPct,100)}%;background:${ctxColor}"></div></div>
    <div class="agent-card-lg-stats"><div class="agent-stat"><span class="num">${sessCount}</span><span class="lbl">Sessions</span></div><div class="agent-stat"><span class="num">${activeSess}</span><span class="lbl">Active</span></div><div class="agent-stat"><span class="num">${costStr}</span><span class="lbl">Cost</span></div></div>
    ${stats && stats.subagent_count > 0 ? `<div class="agent-subagent-badge" onclick="event.stopPropagation();openSubagentPanel('${a.name}',event)">🔀 ${stats.active_subagents > 0 ? stats.active_subagents + ' active / ' : ''}${stats.subagent_count} sub-agents</div>` : ''}</div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// ORG CHART (with stats bar)
// ══════════════════════════════════════════════════════════════

function renderOrgChart() {
  // Stats bar — use both sources for accuracy
  const activeFromStats = agentStats.filter(s => s.active).length;
  const activeFromAgents = agents.filter(a => a.status === 'busy').length;
  const active = Math.max(activeFromStats, activeFromAgents);
  const idle = agents.length - active;
  const error = agents.filter(a => a.status === 'error').length;
  const statsBar = document.getElementById('orgStatsBar');
  statsBar.innerHTML = `
    <div class="org-stat-item"><span class="org-stat-dot" style="background:#6c63ff;box-shadow:0 0 6px #6c63ff"></span><div><div class="org-stat-value">${agents.length}</div><div class="org-stat-label">Total</div></div></div>
    <div class="org-stat-item"><span class="org-stat-dot" style="background:#00E676;box-shadow:0 0 6px #00E676"></span><div><div class="org-stat-value">${active}</div><div class="org-stat-label">Active</div></div></div>
    <div class="org-stat-item"><span class="org-stat-dot" style="background:#00bcd4;box-shadow:0 0 6px #00bcd4"></span><div><div class="org-stat-value">${idle}</div><div class="org-stat-label">Idle</div></div></div>
    <div class="org-stat-item"><span class="org-stat-dot" style="background:#ffab40;box-shadow:0 0 6px #ffab40"></span><div><div class="org-stat-value">${active}</div><div class="org-stat-label">Busy</div></div></div>
    <div class="org-stat-item"><span class="org-stat-dot" style="background:#ff5252;box-shadow:0 0 6px #ff5252"></span><div><div class="org-stat-value">${error}</div><div class="org-stat-label">Error</div></div></div>
  `;

  const tree = document.getElementById('orgTree');
  const getStatus = (name) => { const s = agentStats.find(s => s.name === name); if (s && s.active) return 'busy'; const a = agents.find(a => a.name === name); return a ? a.status : 'idle'; };
  const statusDot = (s) => { const color = s === 'busy' ? '#ffab40' : s === 'error' ? '#ff5252' : '#00E676'; return `<span class="dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>`; };
  // Dynamic: derive child agents from live agents data (exclude 'main' which is Mike/COO)
  const childAgents = agents.filter(a => a.name !== 'main').map(a => {
    const st = agentStats.find(s => s.name === a.name);
    return {
      id: a.name,
      name: a.display_name || a.name,
      role: a.current_task || '',
      emoji: a.emoji || '🤖',
      model: a.model || 'unknown',
      subagentCount: st ? st.subagent_count : 0,
      activeSubagents: st ? st.active_subagents : 0,
    };
  });
  const collapsed = orgExpanded ? '' : 'collapsed';
  tree.innerHTML = `
    <div class="org-level"><div class="org-node" onclick="toggleOrgChildren('mike-children')"><div class="org-node-avatar">👤</div><div class="org-node-name">Argyris</div><div class="org-node-role">Owner · CEO · Vision & Strategy</div><div class="org-node-status">${statusDot('idle')} <span style="color:var(--green)">Online</span></div></div></div>
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    <div class="org-level"><div class="org-node" onclick="toggleOrgChildren('agent-children')"><div class="org-node-avatar">🎯</div><div class="org-node-name">Mike</div><div class="org-node-role">COO · Facilitator · Task Delegation</div><div class="org-node-model">anthropic/claude-opus-4-6</div>${(() => { const ms = agentStats.find(s => s.name === 'main'); return ms && ms.subagent_count > 0 ? `<div class="org-node-subagents" onclick="event.stopPropagation();openSubagentPanel('main',event)">🔀 ${ms.active_subagents > 0 ? ms.active_subagents + ' active / ' : ''}${ms.subagent_count} sub-agents</div>` : ''; })()}<div class="org-node-status">${statusDot(getStatus('main'))} <span>${getStatus('main')}</span></div></div></div>
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    <div class="org-children ${collapsed}" id="agent-children">${childAgents.map(a => `<div class="org-connector"><div class="org-node"><div class="org-node-avatar">${a.emoji}</div><div class="org-node-name">${a.name}</div><div class="org-node-role">${a.role}</div><div class="org-node-model">${a.model}</div>${a.subagentCount > 0 ? `<div class="org-node-subagents" onclick="event.stopPropagation();openSubagentPanel('${a.id}',event)">🔀 ${a.activeSubagents > 0 ? a.activeSubagents + ' active / ' : ''}${a.subagentCount} sub-agents</div>` : ''}<div class="org-node-status">${statusDot(getStatus(a.id))} <span>${getStatus(a.id)}</span></div></div></div>`).join('')}</div>`;
}

function toggleOrgChildren(id) { const el = document.getElementById(id); if (el) el.classList.toggle('collapsed'); }
function expandAllOrg() { orgExpanded = true; document.querySelectorAll('.org-children').forEach(el => el.classList.remove('collapsed')); }
function collapseAllOrg() { orgExpanded = false; document.querySelectorAll('.org-children').forEach(el => el.classList.add('collapsed')); }

// ══════════════════════════════════════════════════════════════
// SCHEDULED TASKS
// ══════════════════════════════════════════════════════════════

async function loadScheduledTasks() {
  try {
    const [tasksRes, logRes] = await Promise.all([fetch(`${API}/api/scheduled-tasks`), fetch(`${API}/api/overnight-log`)]);
    const scheduledTasks = await tasksRes.json();
    const overnightLog = await logRes.json();
    const daily = scheduledTasks.filter(t => t.type === 'daily');
    const weekly = scheduledTasks.filter(t => t.type === 'weekly');
    const oneTime = scheduledTasks.filter(t => t.type === 'one-time');
    document.getElementById('dailyJobs').innerHTML = daily.length ? daily.map(jobRowHTML).join('') : '<p style="color:var(--muted);padding:12px;font-size:.85rem">No daily jobs</p>';
    document.getElementById('weeklyJobs').innerHTML = (weekly.length || oneTime.length) ? [...weekly, ...oneTime].map(jobRowHTML).join('') : '<p style="color:var(--muted);padding:12px;font-size:.85rem">No weekly jobs</p>';
    document.getElementById('overnightLog').innerHTML = overnightLog.length ?
      overnightLog.map(logEntryHTML).join('') :
      '<p style="text-align:center;color:var(--muted);padding:20px">No activity in last 24h</p>';
  } catch(e) { console.error(e); }
}

function jobRowHTML(job) {
  const info = AGENT_INFO[job.agent] || { name: job.agent, emoji: '🤖' };
  const statusDot = job.status === 'active' ? '#00E676' : '#888';
  const lastIcon = job.last_status === 'ok' ? '✅' : job.last_status === 'error' ? '❌' : '⏳';
  const lastRun = job.last_run ? timeAgo(job.last_run) : 'Never';
  const nextRun = job.next_run ? timeAgo(job.next_run) : '';
  const durStr = job.last_duration_ms ? `${(job.last_duration_ms/1000).toFixed(1)}s` : '';
  const oneTimeBadge = job.delete_after_run ? '<span class="job-onetime-badge">ONE-TIME</span>' : '';
  return `<div class="job-row">
    <span class="job-icon">${lastIcon}</span>
    <span class="job-status-dot" style="background:${statusDot}"></span>
    <div class="job-info">
      <div class="job-title">${esc(job.title)} ${oneTimeBadge}</div>
      <div class="job-desc">${esc(job.description)}</div>
      <div class="job-run-info">Last: ${lastRun}${durStr ? ' ('+durStr+')' : ''} ${nextRun ? '· Next: '+nextRun : ''}</div>
    </div>
    <span class="job-agent-pill">${info.emoji} ${info.name}</span>
    <span class="job-schedule">${esc(job.schedule_human)}</span>
  </div>`;
}

function logEntryHTML(e) {
  const info = AGENT_INFO[e.agent] || { name: e.agent || 'System', emoji: '🤖' };
  const sourceIcon = e.source === 'cron' ? '⏰' : e.source === 'subagent' ? '🔀' : e.source === 'session' ? '💬' : '📌';
  const successBadge = e.success ? '' : '<span class="log-fail-badge">FAILED</span>';
  return `<div class="log-entry">
    <div class="log-entry-header">
      <span class="log-entry-icon">${sourceIcon}</span>
      <span class="log-entry-title">${esc(e.title)} ${successBadge}</span>
      <span class="log-entry-tag">${info.emoji} ${info.name}</span>
    </div>
    <div class="log-entry-body">${esc(e.description)}</div>
    <div class="log-entry-time">${e.time ? timeAgo(e.time) : ''}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// WORKSPACES (with inline editor)
// ══════════════════════════════════════════════════════════════

async function loadWorkspaces() {
  try { const res = await fetch(`${API}/api/workspaces`); workspaces = await res.json(); renderWorkspaceSidebar(); } catch(e) { console.error(e); }
}

function renderWorkspaceSidebar() {
  const el = document.getElementById('wsAgentList');
  el.innerHTML = workspaces.map(ws => {
    const filesHtml = ws.files.map(f => `<div class="ws-file" onclick="loadWorkspaceFile('${ws.agent}','${f.name}',this)">📄 ${f.name}</div>`).join('');
    return `<div class="ws-agent"><div class="ws-agent-name" onclick="this.parentElement.querySelector('.ws-files').classList.toggle('collapsed')">${ws.emoji} ${ws.name}<span style="font-size:.65rem;color:var(--muted);margin-left:auto">${ws.files.length} files</span></div><div class="ws-files">${filesHtml}</div></div>`;
  }).join('');
}

async function loadWorkspaceFile(agentId, filename, el) {
  document.querySelectorAll('.ws-file').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  wsCurrentAgent = agentId;
  wsCurrentFile = filename;
  wsEditMode = false;
  const content = document.getElementById('wsContent');
  content.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">Loading...</p>';
  try {
    const res = await fetch(`${API}/api/workspaces/${agentId}/${filename}`);
    const data = await res.json();
    const info = AGENT_INFO[agentId] || { name: agentId, emoji: '🤖' };
    const rendered = renderMarkdown(data.content);
    content.innerHTML = `
      <div class="ws-file-header">
        <span class="ws-file-title">${info.emoji} ${info.name} / ${filename}</span>
        <div class="ws-file-meta">
          <span>${(data.content.length / 1024).toFixed(1)} KB</span>
          <button class="btn btn-sm" onclick="toggleWsEdit('${agentId}','${filename}')">✏️ Edit</button>
        </div>
      </div>
      <div id="wsViewMode" class="ws-file-content">${rendered}</div>
      <div id="wsEditMode" style="display:none">
        <textarea class="ws-editor" id="wsEditor">${esc(data.content)}</textarea>
        <div class="ws-editor-actions">
          <button class="btn btn-primary btn-sm" onclick="saveWorkspaceFile('${agentId}','${filename}')">💾 Save</button>
          <button class="btn btn-sm" onclick="toggleWsEdit('${agentId}','${filename}')">Cancel</button>
          <span class="ws-save-indicator" id="wsSaveIndicator">✅ Saved!</span>
        </div>
      </div>`;
  } catch(e) { content.innerHTML = '<p style="text-align:center;color:var(--red);padding:40px">Failed to load file</p>'; }
}

function toggleWsEdit(agentId, filename) {
  wsEditMode = !wsEditMode;
  document.getElementById('wsViewMode').style.display = wsEditMode ? 'none' : 'block';
  document.getElementById('wsEditMode').style.display = wsEditMode ? 'block' : 'none';
}

async function saveWorkspaceFile(agentId, filename) {
  const content = document.getElementById('wsEditor').value;
  try {
    await fetch(`${API}/api/workspaces/${agentId}/${filename}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ content })
    });
    const indicator = document.getElementById('wsSaveIndicator');
    indicator.classList.add('visible');
    setTimeout(() => indicator.classList.remove('visible'), 2000);
    // Update view mode
    document.getElementById('wsViewMode').innerHTML = renderMarkdown(content);
  } catch(e) { alert('Failed to save file'); }
}

// Workspace auto-update polling
async function checkWorkspaceChanges() {
  if (currentPage !== 'workspaces' || !lastWorkspaceCheck) return;
  try {
    const res = await fetch(`${API}/api/workspaces/changes?since=${encodeURIComponent(lastWorkspaceCheck)}`);
    const data = await res.json();
    lastWorkspaceCheck = new Date().toISOString();
    if (data.changed && wsCurrentAgent && wsCurrentFile && !wsEditMode) {
      // Check if current file changed
      const match = data.files.find(f => f.agent === wsCurrentAgent && f.file === wsCurrentFile);
      if (match) loadWorkspaceFile(wsCurrentAgent, wsCurrentFile, null);
    }
  } catch(e) { /* ignore */ }
}

function renderMarkdown(text) {
  // Code blocks first (preserve content)
  let codeBlocks = [];
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code class="lang-${lang||'text'}">${esc(code.trimEnd())}</code></pre>`);
    return `%%CODEBLOCK_${codeBlocks.length-1}%%`;
  });
  out = esc(out);
  // Inline code
  out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
  // Headers
  out = out.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  out = out.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold + italic
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bare URLs
  out = out.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  // Lists
  out = out.replace(/^- (.+)$/gm, '• $1');
  // Line breaks
  out = out.replace(/\n/g, '<br>');
  // Restore code blocks
  codeBlocks.forEach((block, i) => { out = out.replace(`%%CODEBLOCK_${i}%%`, block); });
  return out;
}

// ══════════════════════════════════════════════════════════════
// STANDUPS (chat-style thread view)
// ══════════════════════════════════════════════════════════════

async function loadStandups() {
  try {
    const res = await fetch(`${API}/api/standups`);
    const standups = await res.json();
    const list = document.getElementById('standupsList');
    const detail = document.getElementById('standupDetail');
    detail.style.display = 'none';
    list.style.display = 'block';
    if (!standups.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">No standups yet. Create one to get started!</p>';
      return;
    }
    list.innerHTML = standups.map(s => {
      const pills = (s.participants || []).map(p => { const info = AGENT_INFO[p] || { name: p }; return `<span class="participant-pill pill-${p}">${info.name}</span>`; }).join('');
      return `<div class="standup-list-item" onclick="openStandup('${s.id}')"><div class="standup-list-title">${esc(s.title)}</div><div class="standup-list-date">${s.date} · ${s.message_count || 0} messages</div><div class="standup-list-participants">${pills}</div></div>`;
    }).join('');
  } catch(e) { console.error(e); }
}

async function openStandup(id) {
  try {
    const res = await fetch(`${API}/api/standups/${id}`);
    const s = await res.json();
    document.getElementById('standupsList').style.display = 'none';
    const detail = document.getElementById('standupDetail');
    detail.style.display = 'block';
    const pills = (s.participants || []).map(p => { const info = AGENT_INFO[p] || { name: p }; return `<span class="participant-pill pill-${p}">${info.name}</span>`; }).join('');
    const messages = (s.messages || []).map(m => {
      const info = AGENT_INFO[m.agent] || { name: m.agent, emoji: '🤖', color: '#888' };
      const isAction = m.type === 'action_item';
      const doneClass = m.completed ? 'action-done' : '';
      const checkbox = isAction ? `<input type="checkbox" class="action-checkbox" ${m.completed ? 'checked' : ''} onchange="toggleActionItem('${m.id}', this.checked)">` : '';
      return `<div class="standup-msg">
        <div class="standup-msg-avatar" style="border-color:${info.color}">${info.emoji}</div>
        <div class="standup-msg-content">
          <div class="standup-msg-header"><span class="standup-msg-name" style="color:${info.color}">${info.name}</span><span class="standup-msg-time">${timeAgo(m.created_at)}</span></div>
          <div class="standup-msg-body ${isAction ? 'action-item' : ''} ${doneClass}">${checkbox}${esc(m.content)}</div>
        </div>
      </div>`;
    }).join('');
    detail.innerHTML = `
      <span class="standup-back" onclick="loadStandups()">← Back to Standups</span>
      <h2 style="margin:12px 0 4px">${esc(s.title)}</h2>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:4px">${s.date}</div>
      <div class="standup-list-participants" style="margin-bottom:20px">${pills}</div>
      <div class="standup-thread">${messages || '<p style="color:var(--muted)">No messages yet. Start the conversation!</p>'}</div>
      <div class="standup-add-msg">
        <select id="msgAgent">${Object.entries(AGENT_INFO).map(([k,v]) => `<option value="${k}">${v.emoji} ${v.name}</option>`).join('')}</select>
        <input type="text" id="msgContent" placeholder="Add message..." onkeydown="if(event.key==='Enter')sendStandupMsg('${s.id}','message')">
        <button class="btn btn-sm btn-primary" onclick="sendStandupMsg('${s.id}','message')">Send</button>
        <button class="btn btn-sm" onclick="sendStandupMsg('${s.id}','action_item')" title="Add as action item">☑️</button>
      </div>`;
  } catch(e) { console.error(e); }
}

async function sendStandupMsg(standupId, type) {
  const agent = document.getElementById('msgAgent').value;
  const content = document.getElementById('msgContent').value.trim();
  if (!content) return;
  await fetch(`${API}/api/standups/${standupId}/messages`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ standup_id: standupId, agent, content, type }) });
  document.getElementById('msgContent').value = '';
  openStandup(standupId);
}

async function toggleActionItem(msgId, completed) {
  await fetch(`${API}/api/standup-messages/${msgId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ completed }) });
}

function openStandupModal() { document.getElementById('standupModal').classList.add('open'); }

async function createStandup(e) {
  e.preventDefault();
  const title = document.getElementById('standupTitle').value;
  const checkboxes = document.querySelectorAll('#standupModal .checkbox-group input:checked');
  const participants = Array.from(checkboxes).map(cb => cb.value);
  await fetch(`${API}/api/standups`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ title, participants, date: new Date().toISOString().slice(0,10) }) });
  document.getElementById('standupModal').classList.remove('open');
  document.getElementById('standupTitle').value = '';
  loadStandups();
}

// ══════════════════════════════════════════════════════════════
// ACTION ITEMS
// ══════════════════════════════════════════════════════════════

async function loadActionItems() {
  try {
    const res = await fetch(`${API}/api/action-items`);
    const items = await res.json();
    const pending = items.filter(i => !i.completed);
    const completed = items.filter(i => i.completed);
    document.getElementById('actionsPending').innerHTML = `
      <div class="action-section">
        <div class="action-section-title">📋 Pending (${pending.length})</div>
        ${pending.length ? pending.map(actionItemHTML).join('') : '<p style="color:var(--muted);padding:12px;font-size:.85rem">No pending action items. Create one!</p>'}
      </div>`;
    document.getElementById('actionsCompleted').innerHTML = `
      <div class="action-section">
        <div class="action-section-title">✅ Completed (${completed.length})</div>
        ${completed.length ? completed.map(actionItemHTML).join('') : '<p style="color:var(--muted);padding:12px;font-size:.85rem">No completed items yet</p>'}
      </div>`;
  } catch(e) { console.error(e); }
}

function actionItemHTML(item) {
  const info = AGENT_INFO[item.assignee] || null;
  const assigneePill = info ? `<span class="action-item-assignee pill-${item.assignee}">${info.emoji} ${info.name}</span>` : (item.assignee ? `<span class="action-item-assignee" style="background:var(--card);color:var(--muted)">${item.assignee}</span>` : '');
  return `<div class="action-item-row ${item.completed ? 'completed' : ''}">
    <input type="checkbox" class="action-item-check" ${item.completed ? 'checked' : ''} onchange="toggleAction('${item.id}', this.checked)">
    <span class="action-item-text">${esc(item.text)}</span>
    ${assigneePill}
    <button class="action-item-delete" onclick="deleteAction('${item.id}')" title="Delete">🗑</button>
  </div>`;
}

async function toggleAction(id, completed) {
  await fetch(`${API}/api/action-items/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ completed }) });
  loadActionItems();
}

async function deleteAction(id) {
  if (!confirm('Delete this action item?')) return;
  await fetch(`${API}/api/action-items/${id}`, { method:'DELETE' });
  loadActionItems();
}

function openActionModal() { document.getElementById('actionModal').classList.add('open'); }

async function createActionItem(e) {
  e.preventDefault();
  const text = document.getElementById('actionText').value;
  const assignee = document.getElementById('actionAssignee').value;
  await fetch(`${API}/api/action-items`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text, assignee }) });
  document.getElementById('actionModal').classList.remove('open');
  document.getElementById('actionText').value = '';
  loadActionItems();
}

// ══════════════════════════════════════════════════════════════
// DOCS
// ══════════════════════════════════════════════════════════════

let docsCache = [];

async function loadDocs() {
  try {
    const res = await fetch(`${API}/api/docs`);
    docsCache = await res.json();
    renderDocsSidebar(docsCache);
  } catch(e) { console.error(e); }
}

function renderDocsSidebar(docs) {
  const el = document.getElementById('docsFileList');
  el.innerHTML = docs.map(d => `<div class="doc-file-item" onclick="loadDoc('${esc(d.filename)}',this)">📄 ${esc(d.title)}</div>`).join('');
}

async function loadDoc(filename, el) {
  document.querySelectorAll('.doc-file-item').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  const content = document.getElementById('docsContent');
  content.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">Loading...</p>';
  try {
    const res = await fetch(`${API}/api/docs/${encodeURIComponent(filename)}`);
    const data = await res.json();
    content.innerHTML = `<div class="ws-file-header"><span class="ws-file-title">📚 ${esc(filename)}</span></div><div class="doc-content">${renderDocMarkdown(data.content)}</div>`;
  } catch(e) { content.innerHTML = '<p style="text-align:center;color:var(--red);padding:40px">Failed to load document</p>'; }
}

function renderDocMarkdown(text) {
  // Enhanced markdown rendering for docs
  let html = esc(text);
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');
  // Bold, italic, code
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Tables (pipe-delimited)
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, function(tableBlock) {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return tableBlock;
    let t = '<table class="md-table">';
    rows.forEach((row, i) => {
      if (row.replace(/[|\-\s:]/g, '') === '') return; // skip separator row
      const cells = row.split('|').filter((c, j, a) => j > 0 && j < a.length - 1);
      const tag = i === 0 ? 'th' : 'td';
      t += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    t += '</table>';
    return t;
  });
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*?<\/li>\s*)+)/gs, '<ul>$1</ul>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

function searchDocs() {
  const q = document.getElementById('docsSearch').value.trim();
  if (!q) { renderDocsSidebar(docsCache); return; }
  // Client-side filter first, then server if needed
  const filtered = docsCache.filter(d => d.title.toLowerCase().includes(q.toLowerCase()) || d.filename.toLowerCase().includes(q.toLowerCase()));
  if (filtered.length > 0) { renderDocsSidebar(filtered); return; }
  // Server-side search
  fetch(`${API}/api/docs?q=${encodeURIComponent(q)}`).then(r => r.json()).then(docs => renderDocsSidebar(docs)).catch(console.error);
}

// ══════════════════════════════════════════════════════════════
// SYSTEM STATS
// ══════════════════════════════════════════════════════════════

async function loadSystemStats() {
  try {
    const res = await fetch(`${API}/api/system?_=${Date.now()}`);
    if (!res.ok) throw new Error('System stats unavailable');
    const s = await res.json();
    renderSystemWidget(s);
  } catch(e) { document.getElementById('systemWidget').innerHTML = '<div class="gpu-loading">System stats offline</div>'; }
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB/s';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB/s';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB/s';
  return bytes + ' B/s';
}

function formatKB(kb) {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + ' GB';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
  return kb + ' KB';
}

function formatUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderSystemWidget(s) {
  const el = document.getElementById('systemWidget');
  if (!el) return;
  const cpu = s.cpu || {};
  const ram = s.ram || {};
  const swap = s.swap || {};
  const disk = s.disk || {};
  const net = s.network || {};

  const cpuColor = cpu.usage_pct >= 90 ? 'red' : cpu.usage_pct >= 70 ? 'yellow' : 'green';
  const cpuBarColor = cpuColor === 'red' ? 'var(--red)' : cpuColor === 'yellow' ? 'var(--orange)' : 'var(--green)';

  const ramPct = ram.total_kb ? Math.round(ram.used_kb / ram.total_kb * 100) : 0;
  const ramColor = ramPct >= 90 ? 'red' : ramPct >= 70 ? 'yellow' : 'green';
  const ramBarColor = ramColor === 'red' ? 'var(--red)' : ramColor === 'yellow' ? 'var(--orange)' : 'var(--green)';

  const swapPct = swap.total_kb ? Math.round(swap.used_kb / swap.total_kb * 100) : 0;
  const swapColor = swapPct >= 80 ? 'red' : swapPct >= 50 ? 'yellow' : 'green';
  const swapBarColor = swapColor === 'red' ? 'var(--red)' : swapColor === 'yellow' ? 'var(--orange)' : 'var(--green)';

  const diskColor = disk.usage_pct >= 90 ? 'red' : disk.usage_pct >= 80 ? 'yellow' : 'green';
  const diskBarColor = diskColor === 'red' ? 'var(--red)' : diskColor === 'yellow' ? 'var(--orange)' : 'var(--green)';

  let netHtml = '';
  for (const [iface, data] of Object.entries(net)) {
    const label = iface === 'eno1' ? 'LAN' : iface === 'tailscale0' ? 'Tailscale' : iface;
    netHtml += `<div class="gpu-row"><span class="gpu-label">${label}</span><span class="gpu-value" style="font-size:.68rem">↓${formatBytes(data.rx_bytes_sec)} ↑${formatBytes(data.tx_bytes_sec)}</span></div>`;
  }

  el.innerHTML = `
    <div class="gpu-row"><span class="gpu-label">CPU (${cpu.cores} cores)</span><span class="gpu-value gpu-indicator-${cpuColor}">${cpu.usage_pct}%</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${cpu.usage_pct}%;background:${cpuBarColor}"></div></div>
    <div class="gpu-row" style="margin-top:2px"><span class="gpu-label" style="font-size:.68rem">Load</span><span class="gpu-value" style="font-size:.68rem">${cpu.load_1} / ${cpu.load_5} / ${cpu.load_15}</span></div>
    <div class="gpu-row" style="margin-top:8px"><span class="gpu-label">RAM</span><span class="gpu-value gpu-indicator-${ramColor}">${formatKB(ram.used_kb)} / ${formatKB(ram.total_kb)}</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${ramPct}%;background:${ramBarColor}"></div></div>
    <div class="gpu-row" style="margin-top:4px"><span class="gpu-label">Swap</span><span class="gpu-value gpu-indicator-${swapColor}">${formatKB(swap.used_kb)} / ${formatKB(swap.total_kb)}</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${swapPct}%;background:${swapBarColor}"></div></div>
    <div class="gpu-row" style="margin-top:8px"><span class="gpu-label">Disk /</span><span class="gpu-value gpu-indicator-${diskColor}">${disk.used_gb}G / ${disk.total_gb}G (${disk.usage_pct}%)</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${disk.usage_pct}%;background:${diskBarColor}"></div></div>
    ${netHtml ? '<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:6px">' + netHtml + '</div>' : ''}
    <div class="gpu-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px"><span class="gpu-label">Uptime</span><span class="gpu-value">${formatUptime(s.uptime_secs)}</span></div>`;
}

setInterval(loadSystemStats, 5000);
document.addEventListener('DOMContentLoaded', () => setTimeout(loadSystemStats, 300));

// ══════════════════════════════════════════════════════════════
// GPU STATS
// ══════════════════════════════════════════════════════════════
const gpuHistory = [];
const GPU_HISTORY_MAX = 60;

async function loadGpuStats() {
  try {
    const res = await fetch(`${API}/api/gpu?_=${Date.now()}`);
    if (!res.ok) throw new Error('GPU unavailable');
    const g = await res.json();
    gpuHistory.push(g.gpu_use);
    if (gpuHistory.length > GPU_HISTORY_MAX) gpuHistory.shift();
    renderGpuWidget(g);
  } catch(e) { document.getElementById('gpuWidget').innerHTML = '<div class="gpu-loading">GPU offline</div>'; }
}

function renderGpuWidget(g) {
  const el = document.getElementById('gpuWidget');
  if (!el) return;
  const vramGB = (g.vram_used / 1073741824).toFixed(1);
  const vramTotalGB = (g.vram_total / 1073741824).toFixed(1);
  const vramPct = g.vram_total ? Math.round(g.vram_used / g.vram_total * 100) : 0;
  const tempColor = g.temp >= 85 ? 'red' : g.temp >= 70 ? 'yellow' : 'green';
  const vramColor = vramPct >= 90 ? 'red' : vramPct >= 70 ? 'yellow' : 'green';
  const useColor = g.gpu_use >= 90 ? 'red' : g.gpu_use >= 70 ? 'yellow' : 'green';
  const barColor = useColor === 'red' ? 'var(--red)' : useColor === 'yellow' ? 'var(--orange)' : 'var(--green)';
  const vramBarColor = vramColor === 'red' ? 'var(--red)' : vramColor === 'yellow' ? 'var(--orange)' : 'var(--green)';
  const sparkBars = gpuHistory.map(v => `<div class="gpu-spark-bar" style="height:${Math.max(v, 2)}%"></div>`).join('');
  el.innerHTML = `
    <div class="gpu-row"><span class="gpu-label">Utilization</span><span class="gpu-value gpu-indicator-${useColor}">${g.gpu_use}%</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${g.gpu_use}%;background:${barColor}"></div></div>
    <div class="gpu-sparkline">${sparkBars}</div>
    <div class="gpu-row" style="margin-top:8px"><span class="gpu-label">VRAM</span><span class="gpu-value gpu-indicator-${vramColor}">${vramGB} / ${vramTotalGB} GB</span></div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${vramPct}%;background:${vramBarColor}"></div></div>
    <div class="gpu-row" style="margin-top:6px"><span class="gpu-label">Temp</span><span class="gpu-value gpu-indicator-${tempColor}">${g.temp}°C</span></div>
    <div class="gpu-row"><span class="gpu-label">Power</span><span class="gpu-value">${g.power.toFixed(0)} W</span></div>
    <div class="gpu-row"><span class="gpu-label">GPU Clock</span><span class="gpu-value">${g.sclk != null ? g.sclk + ' MHz' : 'N/A'}</span></div>
    <div class="gpu-row"><span class="gpu-label">MEM Clock</span><span class="gpu-value">${g.mclk != null ? g.mclk + ' MHz' : 'N/A'}</span></div>`;
}

setInterval(loadGpuStats, 5000);
document.addEventListener('DOMContentLoaded', () => setTimeout(loadGpuStats, 500));

// ══════════════════════════════════════════════════════════════
// AGENT SESSIONS DRILL-DOWN (Task Manager)
// ══════════════════════════════════════════════════════════════

function openAgentSessions(agentName) {
  const info = AGENT_INFO[agentName] || { name: agentName, emoji: '🤖', color: '#888' };
  const stats = agentStats.find(s => s.name === agentName);
  const sessions = (stats && stats.sessions) ? stats.sessions : [];

  // Classify sessions
  const classified = sessions.map(s => {
    const isSubagent = s.key.includes(':subagent:');
    const isCron = s.key.includes(':cron:');
    const isMain = s.key.endsWith(':main');
    const isMobile = s.key.endsWith(':mobile');
    const isWebchat = s.key.endsWith(':webchat');
    let typeIcon, typeLabel;
    if (isSubagent) { typeIcon = '🔀'; typeLabel = 'Sub-agent'; }
    else if (isCron) { typeIcon = '⏰'; typeLabel = 'Cron'; }
    else if (isMain) { typeIcon = '🎮'; typeLabel = 'Main'; }
    else if (isMobile) { typeIcon = '📱'; typeLabel = 'Mobile'; }
    else if (isWebchat) { typeIcon = '💬'; typeLabel = 'Webchat'; }
    else { typeIcon = '📡'; typeLabel = 'Session'; }

    // Try to find matching live task for richer detail
    const liveMatch = liveTasks.find(lt => lt.session_key === s.key);

    return { ...s, typeIcon, typeLabel, isSubagent, isCron, liveMatch };
  });

  // Sort: active first, then by updatedAt desc
  classified.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (b.active && !a.active) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  const activeCount = classified.filter(s => s.active).length;
  const totalTokens = classified.reduce((sum, s) => sum + (s.tokens || 0), 0);
  const totalCost = classified.reduce((sum, s) => sum + (s.cost || 0), 0);

  document.getElementById('subagentModalTitle').innerHTML =
    `${info.emoji} ${esc(info.name)} — All Sessions`;

  let html = '';

  // Summary
  html += `<div class="subagent-summary">
    <span class="subagent-summary-item"><span class="subagent-dot dot-active"></span>${activeCount} active</span>
    <span class="subagent-summary-item"><span class="subagent-dot dot-done"></span>${classified.length - activeCount} idle</span>
    <span class="subagent-summary-item">📊 ${classified.length} total</span>
    <span class="subagent-summary-item">🔤 ${formatTokens(totalTokens)}</span>
    <span class="subagent-summary-item">💰 $${totalCost.toFixed(2)}</span>
  </div>`;

  if (!classified.length) {
    html += '<p style="text-align:center;color:var(--muted);padding:32px 0">No sessions found.</p>';
  } else {
    html += '<div class="subagent-list">';
    for (const s of classified) {
      const statusClass = s.active ? 'running' : 'done';
      const statusIcon = s.active ? '🔄' : '✅';
      const statusLabel = s.active ? 'Active' : 'Idle';
      const modelStr = s.model ? s.model.replace('anthropic/', '').replace('claude-', 'c-') : '—';
      const costStr = s.cost > 0 ? `$${s.cost.toFixed(2)}` : '—';
      const tokStr = s.tokens ? formatTokens(s.tokens) : '—';
      const updatedIso = s.updatedAt ? new Date(s.updatedAt).toISOString() : '';

      // Title: prefer live task title, then session task snippet, then key
      const title = (s.liveMatch && s.liveMatch.title) ? s.liveMatch.title : (s.task || s.key);

      // Duration from live task if available
      let durHtml = '';
      if (s.liveMatch) {
        if (s.active && s.liveMatch.created_at) {
          const elapsed = (Date.now() - new Date(s.liveMatch.created_at).getTime()) / 1000;
          durHtml = `<span class="subagent-dur" data-created-at="${s.liveMatch.created_at}" data-tick-duration>⏱ ${formatDuration(elapsed)}</span>`;
        } else if (s.liveMatch.duration) {
          durHtml = `<span class="subagent-dur">⏱ ${formatDuration(s.liveMatch.duration)}</span>`;
        }
      }

      // Click handler: if there's a live task, open its detail; otherwise just visual
      const liveId = s.liveMatch ? s.liveMatch.id : '';
      const clickAttr = liveId
        ? `onclick="document.getElementById('subagentModal').classList.remove('open');openLiveDetail('${liveId}')"`
        : '';
      const clickClass = liveId ? ' clickable' : '';

      html += `<div class="subagent-row subagent-${statusClass}${clickClass}" ${clickAttr}>
        <div class="subagent-row-top">
          <span class="subagent-type-badge">${s.typeIcon} ${s.typeLabel}</span>
          <span class="subagent-status-badge status-${statusClass}">${statusIcon} ${statusLabel}</span>
          ${durHtml}
          ${updatedIso ? `<span class="subagent-time" data-time-ago="${updatedIso}">${timeAgo(updatedIso)}</span>` : ''}
        </div>
        <div class="subagent-row-title">${esc(title)}</div>
        <div class="subagent-row-stats">
          <span>🔤 ${tokStr}</span>
          <span>💰 ${costStr}</span>
          <span>🧠 ${esc(modelStr)}</span>
          <span class="subagent-session-key">🔑 ${esc(s.sessionId)}</span>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  document.getElementById('subagentModalBody').innerHTML = html;
  document.getElementById('subagentModal').classList.add('open');
}

// ══════════════════════════════════════════════════════════════
// SUB-AGENT DRILL-DOWN
// ══════════════════════════════════════════════════════════════

function openSubagentPanel(agentName, evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  const info = AGENT_INFO[agentName] || { name: agentName, emoji: '🤖', color: '#888' };
  const subs = liveTasks.filter(t => t.source === 'subagent' && t.assigned_agent === agentName);

  // Sort: active first, then by created_at desc
  subs.sort((a, b) => {
    if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
    if (b.status === 'in_progress' && a.status !== 'in_progress') return 1;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  const activeCount = subs.filter(s => s.status === 'in_progress').length;
  const doneCount = subs.length - activeCount;

  document.getElementById('subagentModalTitle').innerHTML =
    `${info.emoji} ${esc(info.name)} — Sub-agents`;

  let html = '';

  // Summary bar
  html += `<div class="subagent-summary">
    <span class="subagent-summary-item"><span class="subagent-dot dot-active"></span>${activeCount} running</span>
    <span class="subagent-summary-item"><span class="subagent-dot dot-done"></span>${doneCount} completed</span>
    <span class="subagent-summary-item">📊 ${subs.length} total</span>
  </div>`;

  if (!subs.length) {
    html += '<p style="text-align:center;color:var(--muted);padding:32px 0">No sub-agents found for this agent.</p>';
  } else {
    html += '<div class="subagent-list subagent-scroll">';
    for (const s of subs) {
      const isActive = s.status === 'in_progress';
      const statusIcon = isActive ? '🔄' : s.status === 'review' ? '👀' : '✅';
      const statusLabel = isActive ? 'Running' : s.status === 'review' ? 'Review' : 'Done';
      const statusClass = isActive ? 'running' : s.status === 'review' ? 'review' : 'done';

      // Duration
      let durHtml = '';
      if (isActive && s.created_at) {
        const elapsed = (Date.now() - new Date(s.created_at).getTime()) / 1000;
        durHtml = `<span class="subagent-dur" data-created-at="${s.created_at}" data-tick-duration>⏱ ${formatDuration(elapsed)}</span>`;
      } else if (s.duration) {
        durHtml = `<span class="subagent-dur">⏱ ${formatDuration(s.duration)}</span>`;
      }

      const modelStr = s.model ? s.model.replace('anthropic/', '').replace('claude-', 'c-') : '—';
      const costStr = s.cost != null && s.cost > 0 ? `$${s.cost.toFixed(2)}` : '—';
      const tokStr = s.tokens ? formatTokens(s.tokens) : '—';
      const timeStr = s.created_at ? timeAgo(s.created_at) : '';

      html += `<div class="subagent-row subagent-${statusClass}" onclick="document.getElementById('subagentModal').classList.remove('open');openLiveDetail('${s.id}')">
        <div class="subagent-row-top">
          <span class="subagent-status-badge status-${statusClass}">${statusIcon} ${statusLabel}</span>
          ${durHtml}
          <span class="subagent-time" ${s.created_at ? `data-time-ago="${s.created_at}"` : ''}>${timeStr}</span>
        </div>
        <div class="subagent-row-title">${esc(s.title)}</div>
        <div class="subagent-row-stats">
          <span>🔤 ${tokStr}</span>
          <span>💰 ${costStr}</span>
          <span>🧠 ${esc(modelStr)}</span>
        </div>
      </div>`;
    }
    html += '</div>';

    // Totals footer
    const totalTokens = subs.reduce((sum, s) => sum + (s.tokens || 0), 0);
    const totalCost = subs.reduce((sum, s) => sum + (s.cost || 0), 0);
    html += `<div class="subagent-footer">
      <span>Total: 🔤 ${formatTokens(totalTokens)}</span>
      <span>💰 $${totalCost.toFixed(2)}</span>
    </div>`;
  }

  document.getElementById('subagentModalBody').innerHTML = html;
  document.getElementById('subagentModal').classList.add('open');
}

// ══════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════

let reportsCache = [];
let reportsTags = [];
let reportsAuthors = [];

async function loadReports() {
  try {
    const [reportsRes, tagsRes, authorsRes] = await Promise.all([
      fetch(`${API}/api/reports`),
      fetch(`${API}/api/reports/tags`),
      fetch(`${API}/api/reports/authors`)
    ]);
    reportsCache = await reportsRes.json();
    reportsTags = await tagsRes.json();
    reportsAuthors = await authorsRes.json();
    // Populate filter dropdowns
    const tagSel = document.getElementById('reportTagFilter');
    tagSel.innerHTML = '<option value="">All Tags</option>' + reportsTags.map(t => `<option value="${t}">${t}</option>`).join('');
    const authSel = document.getElementById('reportAuthorFilter');
    authSel.innerHTML = '<option value="">All Authors</option>' + reportsAuthors.map(a => `<option value="${a}">${a}</option>`).join('');
    renderReportsList(reportsCache);
  } catch(e) { console.error('Failed to load reports', e); }
}

function filterReports() {
  const q = document.getElementById('reportSearchBox').value.trim().toLowerCase();
  const tag = document.getElementById('reportTagFilter').value;
  const author = document.getElementById('reportAuthorFilter').value;
  const dateFrom = document.getElementById('reportDateFrom').value;
  const dateTo = document.getElementById('reportDateTo').value;
  const sort = document.getElementById('reportSortBy').value;
  let filtered = reportsCache.filter(r => {
    if (q && !r.title.toLowerCase().includes(q) && !r.author.toLowerCase().includes(q) && !r.tags.some(t => t.toLowerCase().includes(q))) return false;
    if (tag && !r.tags.includes(tag)) return false;
    if (author && r.author !== author) return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo && r.date > dateTo) return false;
    return true;
  });
  if (sort === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title));
  else filtered.sort((a, b) => b.date.localeCompare(a.date));
  renderReportsList(filtered);
}

function renderReportsList(reports) {
  const el = document.getElementById('reportsList');
  const detail = document.getElementById('reportDetail');
  detail.style.display = 'none';
  el.style.display = 'block';
  document.getElementById('reportsFilterBar').style.display = 'flex';
  if (!reports.length) {
    el.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">No reports found.</p>';
    return;
  }
  el.innerHTML = '<div class="reports-grid">' + reports.map(r => {
    const sourceIcon = r.source_type === 'youtube' ? '🎬' : r.source_type === 'article' ? '📄' : '✏️';
    const tagPills = (r.tags || []).map(t => `<span class="report-tag-pill">${esc(t)}</span>`).join('');
    return `<div class="report-card" onclick="openReport('${r.id}')">
      <div class="report-card-header">
        <span class="report-source-icon">${sourceIcon}</span>
        <span class="report-card-date">${r.date}</span>
      </div>
      <div class="report-card-title">${esc(r.title)}</div>
      <div class="report-card-author">${esc(r.author || 'Unknown')}</div>
      <div class="report-card-tags">${tagPills}</div>
    </div>`;
  }).join('') + '</div>';
}

async function openReport(id) {
  try {
    const res = await fetch(`${API}/api/reports/${id}`);
    const r = await res.json();
    document.getElementById('reportsList').style.display = 'none';
    document.getElementById('reportsFilterBar').style.display = 'none';
    const detail = document.getElementById('reportDetail');
    detail.style.display = 'block';
    const sourceIcon = r.source_type === 'youtube' ? '🎬' : r.source_type === 'article' ? '📄' : '✏️';
    const tagPills = (r.tags || []).map(t => `<span class="report-tag-pill">${esc(t)}</span>`).join('');
    const screenshots = (r.screenshots || []).map(s => `<div class="report-screenshot"><img src="${esc(s)}" alt="Screenshot" loading="lazy" onclick="openLightbox('${esc(s)}')"></div>`).join('');
    const sourceLink = r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source_url)}</a>` : '—';
    detail.innerHTML = `
      <span class="standup-back" onclick="loadReports()">← Back to Reports</span>
      <div class="report-detail-layout">
        <div class="report-detail-main">
          <h2 style="margin:12px 0 16px;font-size:1.3rem">${esc(r.title)}</h2>
          <div class="doc-content">${renderDocMarkdown((r.content || '').replace(/^# .+\n+/, ''))}</div>
          ${screenshots ? `<div class="report-screenshots"><h3 style="font-size:.85rem;color:var(--muted);margin:20px 0 10px">📷 Screenshots</h3><div class="report-screenshots-grid">${screenshots}</div></div>` : ''}
        </div>
        <aside class="report-detail-sidebar">
          <div class="report-meta-block">
            <div class="report-meta-row"><span class="report-meta-label">Date</span><span>${esc(r.date)}</span></div>
            <div class="report-meta-row"><span class="report-meta-label">Author</span><span>${esc(r.author || 'Unknown')}</span></div>
            <div class="report-meta-row"><span class="report-meta-label">Source</span><span>${sourceIcon} ${esc(r.source_type)}</span></div>
            <div class="report-meta-row"><span class="report-meta-label">URL</span><span style="font-size:.75rem;word-break:break-all">${sourceLink}</span></div>
            <div class="report-meta-row"><span class="report-meta-label">Tags</span><div class="report-card-tags">${tagPills}</div></div>
          </div>
          <div class="report-actions">
            <a class="btn btn-sm" href="${API}/api/reports/${r.id}/export?format=md" download>📄 Export MD</a>
            <a class="btn btn-sm" href="${API}/api/reports/${r.id}/export?format=pdf" download>📑 Export PDF</a>
            <button class="btn btn-sm" onclick="editReport('${r.id}')">✏️ Edit</button>
            <button class="btn btn-sm btn-danger" onclick="deleteReport('${r.id}')">🗑️ Delete</button>
          </div>
        </aside>
      </div>`;
  } catch(e) { console.error(e); }
}

function openReportCreateModal() {
  document.getElementById('reportEditId').value = '';
  document.getElementById('reportModalTitle').textContent = 'New Report';
  document.getElementById('reportTitle').value = '';
  document.getElementById('reportAuthor').value = '';
  document.getElementById('reportSourceUrl').value = '';
  document.getElementById('reportSourceType').value = 'manual';
  document.getElementById('reportTags').value = '';
  document.getElementById('reportContent').value = '';
  document.getElementById('reportScreenshots').value = '';
  document.getElementById('reportModal').classList.add('open');
}

async function editReport(id) {
  const res = await fetch(`${API}/api/reports/${id}`);
  const r = await res.json();
  document.getElementById('reportEditId').value = r.id;
  document.getElementById('reportModalTitle').textContent = 'Edit Report';
  document.getElementById('reportTitle').value = r.title;
  document.getElementById('reportAuthor').value = r.author;
  document.getElementById('reportSourceUrl').value = r.source_url;
  document.getElementById('reportSourceType').value = r.source_type;
  document.getElementById('reportTags').value = (r.tags || []).join(', ');
  document.getElementById('reportContent').value = r.content || '';
  document.getElementById('reportScreenshots').value = (r.screenshots || []).join('\n');
  document.getElementById('reportModal').classList.add('open');
}

async function submitReport(e) {
  e.preventDefault();
  const editId = document.getElementById('reportEditId').value;
  const data = {
    title: document.getElementById('reportTitle').value,
    author: document.getElementById('reportAuthor').value,
    source_url: document.getElementById('reportSourceUrl').value,
    source_type: document.getElementById('reportSourceType').value,
    tags: document.getElementById('reportTags').value.split(',').map(t => t.trim()).filter(Boolean),
    content: document.getElementById('reportContent').value,
    screenshots: document.getElementById('reportScreenshots').value.split('\n').map(s => s.trim()).filter(Boolean),
  };
  const url = editId ? `${API}/api/reports/${editId}` : `${API}/api/reports`;
  const method = editId ? 'PUT' : 'POST';
  await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  document.getElementById('reportModal').classList.remove('open');
  loadReports();
}

async function deleteReport(id) {
  if (!confirm('Delete this report?')) return;
  await fetch(`${API}/api/reports/${id}`, { method: 'DELETE' });
  loadReports();
}

// ── Helpers ────────────────────────────────────────────────────
// ── Keyboard Shortcuts ──────────────────────────────────────
document.addEventListener('keydown', e => {
  // Don't trigger shortcuts when typing in inputs/textareas
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  // Escape closes modals
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    const lb = document.getElementById('lightbox');
    if (lb) lb.classList.remove('open');
    return;
  }
  // Number keys 1-9 navigate to pages
  const pages = ['dashboard','taskmanager','orgchart','scheduled','workspaces','standups','actions','docs','reports','voice'];
  const num = parseInt(e.key);
  if (num >= 1 && num <= 9 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const page = pages[num - 1];
    if (page) navigateTo(page);
  }
});

// ── Nav Tab Scroll Indicators ───────────────────────────────
function updateNavScrollIndicators() {
  const tabs = document.querySelector('.topnav-tabs');
  if (!tabs) return;
  const hasRight = tabs.scrollWidth - tabs.scrollLeft - tabs.clientWidth > 4;
  const hasLeft = tabs.scrollLeft > 4;
  tabs.classList.toggle('has-overflow-right', hasRight);
  tabs.classList.toggle('has-overflow-left', hasLeft);
}
document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelector('.topnav-tabs');
  if (tabs) {
    tabs.addEventListener('scroll', updateNavScrollIndicators);
    window.addEventListener('resize', updateNavScrollIndicators);
    setTimeout(updateNavScrollIndicators, 100);
  }
});

// ── API Latency Tracking ────────────────────────────────────
let _apiLatency = 0;
const _origFetch = window.fetch;
window.fetch = async function(...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
  if (url.includes('/api/')) {
    const start = performance.now();
    const res = await _origFetch.apply(this, args);
    _apiLatency = Math.round(performance.now() - start);
    const statusEl = document.getElementById('navStatus');
    if (statusEl) {
      const latencyColor = _apiLatency > 500 ? 'var(--red)' : _apiLatency > 200 ? 'var(--orange)' : 'var(--green)';
      const dot = statusEl.previousElementSibling;
      if (dot) dot.style.background = latencyColor;
      const latEl = document.getElementById('navLatency');
      if (latEl) latEl.textContent = `${_apiLatency}ms`;
    }
    return res;
  }
  return _origFetch.apply(this, args);
};

function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(iso) { if (!iso) return ''; const diff = (Date.now() - new Date(iso).getTime()) / 1000; if (diff < 0) { const f = -diff; if (f < 60) return 'in <1m'; if (f < 3600) return `in ${Math.floor(f/60)}m`; if (f < 86400) return `in ${Math.floor(f/3600)}h`; return `in ${Math.floor(f/86400)}d`; } if (diff < 60) return 'just now'; if (diff < 3600) return `${Math.floor(diff/60)}m ago`; if (diff < 86400) return `${Math.floor(diff/3600)}h ago`; return `${Math.floor(diff/86400)}d ago`; }
function formatDuration(secs) { if (!secs) return ''; secs = Math.round(secs); if (secs < 60) return `${secs}s`; if (secs < 3600) { const m = Math.floor(secs/60), s = secs%60; return s > 0 ? `${m}m ${s}s` : `${m}m`; } const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60); return m > 0 ? `${h}h ${m}m` : `${h}h`; }
