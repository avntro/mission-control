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
  if (currentPage === 'dashboard') renderBoard();
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
  '/actions': 'actions', '/docs': 'docs', '/voice': 'voice',
};
const PAGE_TO_PATH = {
  'dashboard': '/', 'taskmanager': '/task-manager', 'orgchart': '/org-chart',
  'scheduled': '/scheduled-tasks', 'workspaces': '/workspaces', 'standups': '/standups',
  'actions': '/actions', 'docs': '/docs', 'voice': '/voice',
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
  for (const [status, items] of Object.entries(cols)) {
    const el = document.getElementById(`col-${status}`);
    if (el) {
      el.innerHTML = items.map(t => t.is_live ? liveTaskCardHTML(t) : taskCardHTML(t)).join('');
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
  return `<div class="task-card live-task${activePulse}" data-id="${t.id}" onclick="openLiveDetail('${t.id}')">
    <div class="task-live-badge">${sourceIcon} LIVE</div>
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="task-agent">${info.emoji} ${info.name}</span>
      ${tokens ? `<span class="task-tokens">🔤 ${tokens}</span>` : ''}
      ${t.status === 'in_progress' && t.created_at ? `<span class="task-duration" data-created-at="${t.created_at}" data-tick-duration>⏱ ${dur}</span>` : (dur ? `<span class="task-duration">⏱ ${dur}</span>` : '')}
      <span class="task-time" data-time-ago="${timeRef}" data-time-prefix="${timeLabel}">${timeLabel}${timeAgo(timeRef)}</span>
    </div>
    <div class="task-model-cost">${modelStr} · ${costStr}</div>
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
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="task-agent">${esc(agentLabel)}</span>
      <span class="task-priority priority-${t.priority}">${t.priority}</span>
      <span class="task-time" data-time-ago="${tTimeRef}" data-time-prefix="${tTimeLabel}">${tTimeLabel}${timeAgo(tTimeRef)}</span>
      ${t.status === 'in_progress' && t.created_at ? `<span class="task-duration" data-created-at="${t.created_at}" data-tick-duration>⏱ ${dur}</span>` : (dur ? `<span class="task-duration">⏱ ${dur}</span>` : '')}
    </div>
    <div class="task-model-cost">${tModelStr} · ${tCostStr}</div>
  </div>`;
}

function allowDrop(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function drop(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  const col = e.currentTarget.id.replace('col-', '');
  if (!draggedTaskId) return;
  try { await fetch(`${API}/api/tasks/${draggedTaskId}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:col}) }); await loadTasks(); } catch(e) { console.error(e); }
  draggedTaskId = null;
}

let _lastAgentsJSON = '';
let _lastAgentStatsJSON = '';
async function loadAgents() {
  try {
    const res = await fetch(`${API}/api/agents`);
    const data = await res.json();
    const json = JSON.stringify(data);
    if (json !== _lastAgentsJSON) { _lastAgentsJSON = json; agents = data; rebuildAgentInfo(); renderAgents(); }
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
    const costStr = stats && stats.total_cost > 0 ? `$${stats.total_cost.toFixed(2)}` : '—';
    const modelStr = (stats && stats.model) ? stats.model.replace('anthropic/', '') : (a.model ? a.model.replace('anthropic/', '') : '—');
    const sessCount = stats ? stats.active_sessions : 0;
    const lastAct = a.last_activity ? timeAgo(a.last_activity) : 'No activity';
    // Find active live task for this agent to show duration
    const agentLiveTask = liveTasks.find(lt => lt.assigned_agent === a.name && lt.status === 'in_progress');
    const liveCreatedAt = agentLiveTask ? agentLiveTask.created_at : '';
    const liveDur = liveCreatedAt ? formatDuration((Date.now() - new Date(liveCreatedAt).getTime()) / 1000) : '';
    return { name: a.name, emoji: a.emoji, displayName: a.display_name, statusLabel, statusClass, tokenStr, ctxPct, ctxBarColor, costStr, modelStr, lastAct, lastActivity: a.last_activity || '', liveCreatedAt, liveDur, sessCount };
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

async function loadActivity() {
  const agent = document.getElementById('activityFilter').value;
  const q = agent ? `?agent=${agent}&limit=50` : '?limit=50';
  try { const res = await fetch(`${API}/api/activity${q}`); renderActivity(await res.json()); } catch(e) { console.error(e); }
}

function renderActivity(items) {
  const el = document.getElementById('activityFeed');
  if (!items.length) { el.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">No activity yet</p>'; return; }
  const icons = { task_created:'📦', task_started:'🚀', task_completed:'✅', task_error:'❌', status_change:'🔄', comment_added:'💬' };
  el.innerHTML = items.map(a => {
    const icon = icons[a.action] || '📌';
    const agent = agents.find(ag => ag.name === a.agent);
    const agentName = agent ? agent.display_name : (a.agent || 'System');
    const successBadge = a.success ? '' : '<span class="activity-badge badge-fail">Failed</span>';
    const dur = a.duration ? `<span class="activity-badge badge-success">⏱ ${formatDuration(a.duration)}</span>` : '';
    return `<div class="activity-item"><div class="activity-icon">${icon}</div><div class="activity-content"><div class="activity-action">${esc(agentName)} — ${a.action.replace(/_/g,' ')}${successBadge}${dur}</div><div class="activity-details">${esc(a.details || '')}</div></div><div class="activity-time">${timeAgo(a.created_at)}</div></div>`;
  }).join('');
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
  const statusBadge = isActive
    ? `<div class="premium-status-badge live">🔄 LIVE</div>`
    : `<div class="premium-status-badge completed">✅ ${(t.status || 'done').replace('_',' ').toUpperCase()}</div>`;

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

  // Status badge
  html += statusBadge;

  // Agent block
  html += `<div class="premium-agent">
    <div class="premium-agent-icon" style="background:${agentColor}22;border:1px solid ${agentColor}44">${agentEmoji}</div>
    <div><div class="premium-agent-name">${esc(agentName)}</div><div class="premium-agent-role">${agentRole}</div></div>
  </div>`;

  // 6-cell stats grid (2×3)
  html += `<div class="premium-grid">
    <div class="premium-stat"><div class="stat-icon">⏱</div><div class="stat-label">Duration</div><div class="stat-value">${dur}</div></div>
    <div class="premium-stat"><div class="stat-icon">🟡</div><div class="stat-label">Tokens</div><div class="stat-value">${tokens}</div></div>
    <div class="premium-stat"><div class="stat-icon">🔥</div><div class="stat-label">Est. Cost</div><div class="stat-value">${costStr}</div></div>
    <div class="premium-stat"><div class="stat-icon">🖥️</div><div class="stat-label">Model</div><div class="stat-value" style="font-size:.76rem">${esc(modelStr)}</div></div>
    <div class="premium-stat"><div class="stat-icon">📅</div><div class="stat-label">Started</div><div class="stat-value" style="font-size:.76rem">${startTime}</div></div>
    <div class="premium-stat"><div class="stat-icon">🕐</div><div class="stat-label">Ago</div><div class="stat-value" data-time-ago="${t.created_at || ''}" data-time-prefix="">${startAgo}</div></div>
  </div>`;

  // Session key
  if (t.session_key || t.id) {
    html += `<div class="premium-session">🔑 ${esc(t.session_key || t.id)}</div>`;
  }

  return html;
}

async function openDetail(id) {
  try {
    const res = await fetch(`${API}/api/tasks/${id}`);
    const t = await res.json();
    document.getElementById('detailTitle').textContent = t.title;

    // 1. Status buttons row
    let html = `<div class="premium-actions">${['todo','in_progress','review','done'].map(s => `<button class="btn btn-sm ${t.status===s?'btn-primary':''}" onclick="moveTask('${t.id}','${s}')">${s.replace('_',' ')}</button>`).join('')}<button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')">🗑️</button></div>`;

    // 2-6. Status badge + agent + grid + session
    html += buildPremiumModal(t, false);

    // 7. Description
    if (t.description) html += `<div class="detail-section"><h3>Description</h3><div class="detail-desc">${esc(t.description)}</div></div>`;

    // Attachments
    html += renderAttachmentsSection(t);

    // 8. Comments & Logs
    if (t.comments && t.comments.length) {
      html += `<div class="detail-section"><h3>Comments &amp; Logs (${t.comments.length})</h3>`;
      t.comments.forEach(c => {
        const cA = agents.find(a => a.name === c.agent);
        const cN = cA ? cA.display_name : (c.agent || 'System');
        html += `<div class="comment-item type-${c.type}"><div class="comment-header"><span><span class="comment-agent">${esc(cN)}</span><span class="comment-type">${c.type}</span></span><span data-time-ago="${c.created_at}">${timeAgo(c.created_at)}</span></div><div class="comment-content">${esc(c.content)}</div></div>`;
      });
      html += '</div>';
    }

    // 9. History
    if (t.history && t.history.length) {
      html += `<div class="detail-section"><h3>History</h3><div class="history-list">`;
      t.history.forEach(h => {
        html += `<div class="history-item"><span class="history-time" data-time-ago="${h.created_at}">${timeAgo(h.created_at)}</span><span class="history-action">${h.action.replace(/_/g,' ')}</span><span class="history-detail">— ${esc(h.details || '')}</span></div>`;
      });
      html += '</div></div>';
    }

    // 10. Add Comment
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

function closeDetail() { document.getElementById('detailModal').classList.remove('open'); }
function closeDetailIfOutside(e) { if (e.target === e.currentTarget) closeDetail(); }

function openLiveDetail(id) {
  const t = liveTasks.find(lt => lt.id === id);
  if (!t) return;
  document.getElementById('detailTitle').textContent = t.title;

  // Source badge row
  const sourceIcon = t.source === 'cron' ? '⏰' : t.source === 'subagent' ? '🔀' : '🎮';
  const sourceLabel = t.source === 'cron' ? 'Cron Job' : t.source === 'subagent' ? 'Sub-agent' : 'Interactive';
  let html = `<div class="premium-actions"><span class="live-source-badge">${sourceIcon} ${sourceLabel}</span></div>`;

  // Status badge + agent + grid + session
  html += buildPremiumModal(t, true);

  // Description
  if (t.description) html += `<div class="detail-section"><h3>Description</h3><div class="detail-desc">${esc(t.description)}</div></div>`;
  html += renderAttachmentsSection(t);

  // Live session info
  html += `<div class="detail-section"><h3>Live Session Info</h3><div style="font-size:.83rem;color:var(--muted);line-height:1.8">
    <div>📡 <strong>Source:</strong> ${sourceLabel}</div>
    ${t.updated_at ? `<div>🔄 <strong>Last Update:</strong> <span data-time-ago="${t.updated_at}">${timeAgo(t.updated_at)}</span></div>` : ''}
    ${t.priority ? `<div>📊 <strong>Priority:</strong> ${t.priority}</div>` : ''}
  </div></div>`;

  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailModal').classList.add('open');
}
async function moveTask(id, status) { await fetch(`${API}/api/tasks/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status}) }); closeDetail(); await loadTasks(); }
async function deleteTask(id) { if (!confirm('Delete this task?')) return; await fetch(`${API}/api/tasks/${id}`, { method:'DELETE' }); closeDetail(); await loadTasks(); }
async function addComment(taskId) { const text = document.getElementById('commentText').value.trim(); if (!text) return; await fetch(`${API}/api/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:taskId,content:text,agent:'',type:'comment'}) }); openDetail(taskId); }

function openCreateModal() { document.getElementById('createModal').classList.add('open'); }
function closeCreate() { document.getElementById('createModal').classList.remove('open'); }
function closeCreateIfOutside(e) { if (e.target === e.currentTarget) closeCreate(); }
async function createTask(e) {
  e.preventDefault();
  const data = { title: document.getElementById('newTitle').value, description: document.getElementById('newDesc').value, assigned_agent: document.getElementById('newAgent').value, priority: document.getElementById('newPriority').value, status: 'todo' };
  await fetch(`${API}/api/tasks`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  closeCreate(); document.getElementById('newTitle').value = ''; document.getElementById('newDesc').value = ''; await loadTasks();
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
    return `<div class="agent-card-lg"><div class="agent-card-lg-top"><div class="agent-avatar">${a.emoji}</div><div class="agent-card-lg-info"><h3>${esc(a.display_name)}</h3><div class="model-tag">${esc(stats?.model || a.model)}</div></div><span class="agent-status-pill" style="${sc}">${statusLabel}</span></div>
    <div class="agent-ctx-row"><span>Context: ${tokenStr}</span><span style="color:${ctxColor}">${ctxPct}%</span></div>
    <div class="agent-ctx-bar-lg"><div class="agent-ctx-fill" style="width:${Math.min(ctxPct,100)}%;background:${ctxColor}"></div></div>
    <div class="agent-card-lg-stats"><div class="agent-stat"><span class="num">${sessCount}</span><span class="lbl">Sessions</span></div><div class="agent-stat"><span class="num">${activeSess}</span><span class="lbl">Active</span></div><div class="agent-stat"><span class="num">${costStr}</span><span class="lbl">Cost</span></div></div></div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// ORG CHART (with stats bar)
// ══════════════════════════════════════════════════════════════

function renderOrgChart() {
  // Stats bar
  const active = agents.filter(a => a.status === 'busy').length;
  const idle = agents.filter(a => a.status === 'idle').length;
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
  const getStatus = (name) => { const a = agents.find(a => a.name === name); return a ? a.status : 'idle'; };
  const statusDot = (s) => { const color = s === 'busy' ? '#ffab40' : s === 'error' ? '#ff5252' : '#00E676'; return `<span class="dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>`; };
  // Dynamic: derive child agents from live agents data (exclude 'main' which is Mike/COO)
  const childAgents = agents.filter(a => a.name !== 'main').map(a => ({
    id: a.name,
    name: a.display_name || a.name,
    role: a.current_task || '',
    emoji: a.emoji || '🤖',
    model: a.model || 'unknown',
  }));
  const collapsed = orgExpanded ? '' : 'collapsed';
  tree.innerHTML = `
    <div class="org-level"><div class="org-node" onclick="toggleOrgChildren('mike-children')"><div class="org-node-avatar">👤</div><div class="org-node-name">Argyris</div><div class="org-node-role">Owner · CEO · Vision & Strategy</div><div class="org-node-status">${statusDot('idle')} <span style="color:var(--green)">Online</span></div></div></div>
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    <div class="org-level"><div class="org-node" onclick="toggleOrgChildren('agent-children')"><div class="org-node-avatar">🎯</div><div class="org-node-name">Mike</div><div class="org-node-role">COO · Facilitator · Task Delegation</div><div class="org-node-model">anthropic/claude-opus-4-6</div><div class="org-node-status">${statusDot(getStatus('main'))} <span>${getStatus('main')}</span></div></div></div>
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    <div class="org-children ${collapsed}" id="agent-children">${childAgents.map(a => `<div class="org-connector"><div class="org-node"><div class="org-node-avatar">${a.emoji}</div><div class="org-node-name">${a.name}</div><div class="org-node-role">${a.role}</div><div class="org-node-model">${a.model}</div><div class="org-node-status">${statusDot(getStatus(a.id))} <span>${getStatus(a.id)}</span></div></div></div>`).join('')}</div>`;
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
  return esc(text)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
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
  // Bold, italic, code
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
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
    const res = await fetch(`${API}/api/system`);
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
    const res = await fetch(`${API}/api/gpu`);
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

// ── Helpers ────────────────────────────────────────────────────
function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(iso) { if (!iso) return ''; const diff = (Date.now() - new Date(iso).getTime()) / 1000; if (diff < 60) return 'just now'; if (diff < 3600) return `${Math.floor(diff/60)}m ago`; if (diff < 86400) return `${Math.floor(diff/3600)}h ago`; return `${Math.floor(diff/86400)}d ago`; }
function formatDuration(secs) { if (!secs) return ''; if (secs < 60) return `${Math.round(secs)}s`; if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.round(secs%60)}s`; return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`; }
