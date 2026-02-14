// Mission Control — Phase 2 Frontend
const API = '';
let tasks = [];
let agents = [];
let draggedTaskId = null;
let currentPage = 'dashboard';
let workspaces = [];
let orgExpanded = true;

// Agent display info
const AGENT_INFO = {
  main: { name: 'Mike', emoji: '🎯', color: '#ffc107' },
  trading: { name: 'Trading / AA', emoji: '📈', color: '#00E676' },
  'it-support': { name: 'IT Support', emoji: '🔧', color: '#00b0ff' },
  dev: { name: 'Dev', emoji: '💻', color: '#00bcd4' },
  voice: { name: 'Voice', emoji: '🎙️', color: '#e040fb' },
  troubleshoot: { name: 'Troubleshoot', emoji: '🔍', color: '#ff5252' },
};

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  setInterval(loadAll, 8000);
});

async function loadAll() {
  await Promise.all([loadTasks(), loadAgents()]);
}

// ── Navigation ─────────────────────────────────────────────────
// URL path → page mapping
const PATH_TO_PAGE = {
  '/': 'dashboard', '/dashboard': 'dashboard',
  '/task-manager': 'taskmanager', '/taskmanager': 'taskmanager',
  '/org-chart': 'orgchart', '/orgchart': 'orgchart',
  '/scheduled-tasks': 'scheduled', '/scheduled': 'scheduled',
  '/workspaces': 'workspaces',
  '/standups': 'standups',
};
const PAGE_TO_PATH = {
  'dashboard': '/', 'taskmanager': '/task-manager', 'orgchart': '/org-chart',
  'scheduled': '/scheduled-tasks', 'workspaces': '/workspaces', 'standups': '/standups',
};

function navigateTo(page, pushState = true) {
  currentPage = page;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  
  if (pushState) {
    const path = PAGE_TO_PATH[page] || '/';
    history.pushState({ page }, '', path);
  }

  // Load page-specific data
  if (page === 'taskmanager') loadTaskManager();
  if (page === 'orgchart') renderOrgChart();
  if (page === 'scheduled') loadScheduledTasks();
  if (page === 'workspaces') loadWorkspaces();
  if (page === 'standups') loadStandups();
}

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
  const page = (e.state && e.state.page) || PATH_TO_PAGE[location.pathname] || 'dashboard';
  navigateTo(page, false);
});

// On initial load, resolve page from URL
(function initRoute() {
  const page = PATH_TO_PAGE[location.pathname] || 'dashboard';
  if (page !== 'dashboard') {
    navigateTo(page, false);
  }
  // Replace state for initial page
  history.replaceState({ page }, '', PAGE_TO_PATH[page] || '/');
})();

// ══════════════════════════════════════════════════════════════
// DASHBOARD (original kanban)
// ══════════════════════════════════════════════════════════════

async function loadTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
    tasks = await res.json();
    if (currentPage === 'dashboard') renderBoard();
  } catch(e) { console.error('Failed to load tasks', e); }
}

function renderBoard() {
  const cols = { todo: [], in_progress: [], review: [], done: [] };
  tasks.forEach(t => {
    const status = t.status in cols ? t.status : 'todo';
    cols[status].push(t);
  });
  for (const [status, items] of Object.entries(cols)) {
    const el = document.getElementById(`col-${status}`);
    if (el) {
      el.innerHTML = items.map(t => taskCardHTML(t)).join('');
      document.getElementById(`count-${status}`).textContent = items.length;
    }
  }
  // Make cards draggable
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      draggedTaskId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.col-cards').forEach(c => c.classList.remove('drag-over'));
    });
  });
}

function taskCardHTML(t) {
  const agent = agents.find(a => a.name === t.assigned_agent);
  const agentLabel = agent ? `${agent.emoji} ${agent.display_name}` : (t.assigned_agent || 'Unassigned');
  const dur = t.duration ? formatDuration(t.duration) : '';
  return `<div class="task-card" draggable="true" data-id="${t.id}" onclick="openDetail('${t.id}')">
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="task-agent">${esc(agentLabel)}</span>
      <span class="task-priority priority-${t.priority}">${t.priority}</span>
      <span class="task-time">${timeAgo(t.created_at)}</span>
      ${dur ? `<span class="task-duration">⏱ ${dur}</span>` : ''}
    </div>
  </div>`;
}

function allowDrop(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function drop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const col = e.currentTarget.id.replace('col-', '');
  if (!draggedTaskId) return;
  try {
    await fetch(`${API}/api/tasks/${draggedTaskId}`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ status: col })
    });
    await loadTasks();
  } catch(e) { console.error(e); }
  draggedTaskId = null;
}

async function loadAgents() {
  try {
    const res = await fetch(`${API}/api/agents`);
    agents = await res.json();
    renderAgents();
  } catch(e) { console.error('Failed to load agents', e); }
}

function renderAgents() {
  const el = document.getElementById('agentsList');
  if (!el) return;
  const busy = agents.filter(a => a.status === 'busy').length;
  const statusEl = document.getElementById('navStatus');
  if (statusEl) statusEl.textContent = `${agents.length} agents · ${busy} busy`;
  
  el.innerHTML = agents.map(a => {
    const lastAct = a.last_activity ? timeAgo(a.last_activity) : 'No activity';
    return `<div class="agent-card">
      <div class="agent-top">
        <span class="agent-emoji">${a.emoji}</span>
        <span class="agent-name">${esc(a.display_name)}</span>
        <span class="agent-status status-${a.status}">${a.status}</span>
      </div>
      <div class="agent-meta">
        <span>${esc(a.model)}</span>
        <span>${lastAct}</span>
      </div>
    </div>`;
  }).join('');
}

async function loadActivity() {
  const agent = document.getElementById('activityFilter').value;
  const q = agent ? `?agent=${agent}&limit=50` : '?limit=50';
  try {
    const res = await fetch(`${API}/api/activity${q}`);
    const items = await res.json();
    renderActivity(items);
  } catch(e) { console.error(e); }
}

function renderActivity(items) {
  const el = document.getElementById('activityFeed');
  if (!items.length) {
    el.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">No activity yet</p>';
    return;
  }
  const icons = { task_created:'📦', task_started:'🚀', task_completed:'✅', task_error:'❌', status_change:'🔄', comment_added:'💬' };
  el.innerHTML = items.map(a => {
    const icon = icons[a.action] || '📌';
    const agent = agents.find(ag => ag.name === a.agent);
    const agentName = agent ? agent.display_name : (a.agent || 'System');
    const successBadge = a.success ? '' : '<span class="activity-badge badge-fail">Failed</span>';
    const dur = a.duration ? `<span class="activity-badge badge-success">⏱ ${formatDuration(a.duration)}</span>` : '';
    return `<div class="activity-item">
      <div class="activity-icon">${icon}</div>
      <div class="activity-content">
        <div class="activity-action">${esc(agentName)} — ${a.action.replace(/_/g,' ')}${successBadge}${dur}</div>
        <div class="activity-details">${esc(a.details || '')}</div>
      </div>
      <div class="activity-time">${timeAgo(a.created_at)}</div>
    </div>`;
  }).join('');
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById(tab === 'board' ? 'boardView' : 'activityView').classList.add('active');
  if (tab === 'activity') loadActivity();
}

// ── Task Detail Modal ──────────────────────────────────────────
async function openDetail(id) {
  try {
    const res = await fetch(`${API}/api/tasks/${id}`);
    const t = await res.json();
    document.getElementById('detailTitle').textContent = t.title;
    const agent = agents.find(a => a.name === t.assigned_agent);
    const agentLabel = agent ? `${agent.emoji} ${agent.display_name}` : (t.assigned_agent || 'Unassigned');
    const dur = t.duration ? formatDuration(t.duration) : '—';
    
    let html = `
      <div class="detail-actions">
        ${['todo','in_progress','review','done'].map(s => 
          `<button class="btn btn-sm ${t.status===s?'btn-primary':''}" onclick="moveTask('${t.id}','${s}')">${s.replace('_',' ')}</button>`
        ).join('')}
        <button class="btn btn-sm btn-danger" onclick="deleteTask('${t.id}')">🗑 Delete</button>
      </div>
      <div class="detail-section">
        <div class="detail-meta">
          <div class="detail-meta-item"><div class="label">Agent</div><div class="value">${esc(agentLabel)}</div></div>
          <div class="detail-meta-item"><div class="label">Priority</div><div class="value"><span class="task-priority priority-${t.priority}">${t.priority}</span></div></div>
          <div class="detail-meta-item"><div class="label">Created</div><div class="value">${new Date(t.created_at).toLocaleString()}</div></div>
          <div class="detail-meta-item"><div class="label">Duration</div><div class="value">${dur}</div></div>
        </div>
      </div>`;
    if (t.description) {
      html += `<div class="detail-section"><h3>Description</h3><div class="detail-desc">${esc(t.description)}</div></div>`;
    }
    if (t.comments && t.comments.length) {
      html += `<div class="detail-section"><h3>Comments & Logs (${t.comments.length})</h3>`;
      t.comments.forEach(c => {
        const cAgent = agents.find(a => a.name === c.agent);
        const cName = cAgent ? cAgent.display_name : (c.agent || 'System');
        html += `<div class="comment-item type-${c.type}">
          <div class="comment-header"><span>${esc(cName)} · ${c.type}</span><span>${timeAgo(c.created_at)}</span></div>
          <div class="comment-content">${esc(c.content)}</div>
        </div>`;
      });
      html += '</div>';
    }
    if (t.history && t.history.length) {
      html += `<div class="detail-section"><h3>History</h3>`;
      t.history.forEach(h => {
        html += `<div class="history-item"><span class="history-time">${timeAgo(h.created_at)}</span><span>${h.action.replace(/_/g,' ')} — ${esc(h.details || '')}</span></div>`;
      });
      html += '</div>';
    }
    html += `<div class="detail-section"><h3>Add Comment</h3>
      <textarea id="commentText" rows="2" placeholder="Add a comment..." style="width:100%;padding:10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--card);color:var(--text);font-family:inherit;font-size:.83rem;margin-bottom:8px"></textarea>
      <button class="btn btn-sm btn-primary" onclick="addComment('${t.id}')">Add Comment</button>
    </div>`;
    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailModal').classList.add('open');
  } catch(e) { console.error(e); }
}

function closeDetail() { document.getElementById('detailModal').classList.remove('open'); }
function closeDetailIfOutside(e) { if (e.target === e.currentTarget) closeDetail(); }

async function moveTask(id, status) {
  await fetch(`${API}/api/tasks/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({status}) });
  closeDetail(); await loadTasks();
}
async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  await fetch(`${API}/api/tasks/${id}`, { method:'DELETE' });
  closeDetail(); await loadTasks();
}
async function addComment(taskId) {
  const text = document.getElementById('commentText').value.trim();
  if (!text) return;
  await fetch(`${API}/api/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:taskId,content:text,agent:'',type:'comment'}) });
  openDetail(taskId);
}

function openCreateModal() { document.getElementById('createModal').classList.add('open'); }
function closeCreate() { document.getElementById('createModal').classList.remove('open'); }
function closeCreateIfOutside(e) { if (e.target === e.currentTarget) closeCreate(); }

async function createTask(e) {
  e.preventDefault();
  const data = {
    title: document.getElementById('newTitle').value,
    description: document.getElementById('newDesc').value,
    assigned_agent: document.getElementById('newAgent').value,
    priority: document.getElementById('newPriority').value,
    status: 'todo'
  };
  await fetch(`${API}/api/tasks`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  closeCreate();
  document.getElementById('newTitle').value = '';
  document.getElementById('newDesc').value = '';
  await loadTasks();
}

// ══════════════════════════════════════════════════════════════
// TASK MANAGER
// ══════════════════════════════════════════════════════════════

async function loadTaskManager() {
  // Update stats from agents
  const active = agents.filter(a => a.status === 'busy').length;
  const idle = agents.filter(a => a.status === 'idle').length;
  const error = agents.filter(a => a.status === 'error').length;
  
  document.getElementById('stat-total').textContent = agents.length;
  document.getElementById('stat-active').textContent = active;
  document.getElementById('stat-idle').textContent = idle;
  document.getElementById('stat-busy').textContent = active;
  document.getElementById('stat-error').textContent = error;
  
  // Render agent cards
  const row = document.getElementById('agentCardsRow');
  
  // Count tasks per agent
  const taskCounts = {};
  tasks.forEach(t => {
    if (t.assigned_agent) {
      taskCounts[t.assigned_agent] = (taskCounts[t.assigned_agent] || 0) + 1;
    }
  });
  const doneCounts = {};
  tasks.filter(t => t.status === 'done').forEach(t => {
    if (t.assigned_agent) {
      doneCounts[t.assigned_agent] = (doneCounts[t.assigned_agent] || 0) + 1;
    }
  });
  
  row.innerHTML = agents.map(a => {
    const statusClass = a.status === 'busy' ? 'background:rgba(255,171,64,.15);color:#ffab40' :
                        a.status === 'error' ? 'background:rgba(255,82,82,.15);color:#ff5252' :
                        'background:rgba(0,188,212,.15);color:#00bcd4';
    const totalTasks = taskCounts[a.name] || 0;
    const done = doneCounts[a.name] || 0;
    const lastAct = a.last_activity ? timeAgo(a.last_activity) : 'Never';
    
    return `<div class="agent-card-lg">
      <div class="agent-card-lg-top">
        <div class="agent-avatar">${a.emoji}</div>
        <div class="agent-card-lg-info">
          <h3>${esc(a.display_name)}</h3>
          <div class="model-tag">${esc(a.model)}</div>
        </div>
        <span class="agent-status-pill" style="${statusClass}">${a.status}</span>
      </div>
      <div class="agent-card-lg-stats">
        <div class="agent-stat"><span class="num">${totalTasks}</span><span class="lbl">Tasks</span></div>
        <div class="agent-stat"><span class="num">${done}</span><span class="lbl">Done</span></div>
        <div class="agent-stat"><span class="num">${lastAct}</span><span class="lbl">Last Active</span></div>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// ORG CHART
// ══════════════════════════════════════════════════════════════

function renderOrgChart() {
  const tree = document.getElementById('orgTree');
  const getStatus = (name) => {
    const a = agents.find(a => a.name === name);
    return a ? a.status : 'idle';
  };
  const statusDot = (s) => {
    const color = s === 'busy' ? '#ffab40' : s === 'error' ? '#ff5252' : '#00E676';
    return `<span class="dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>`;
  };
  
  const childAgents = [
    { id: 'trading', name: 'Trading / AA', role: 'Trading Specialist', emoji: '📈', model: 'claude-opus-4-6' },
    { id: 'it-support', name: 'IT Support', role: 'Infrastructure', emoji: '🔧', model: 'claude-sonnet-4-5' },
    { id: 'dev', name: 'Dev', role: 'Software Development', emoji: '💻', model: 'claude-opus-4-6' },
    { id: 'voice', name: 'Voice', role: 'Voice Assistant', emoji: '🎙️', model: 'claude-sonnet-4-5' },
    { id: 'troubleshoot', name: 'Troubleshoot', role: 'Troubleshooting', emoji: '🔍', model: 'claude-sonnet-4-5' },
  ];
  
  const collapsed = orgExpanded ? '' : 'collapsed';
  
  tree.innerHTML = `
    <!-- Level 1: Owner -->
    <div class="org-level">
      <div class="org-node" onclick="toggleOrgChildren('mike-children')">
        <div class="org-node-avatar">👤</div>
        <div class="org-node-name">Argyris</div>
        <div class="org-node-role">Owner · CEO · Vision & Strategy</div>
        <div class="org-node-status">${statusDot('idle')} <span style="color:var(--green)">Online</span></div>
      </div>
    </div>
    
    <!-- Connector line -->
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    
    <!-- Level 2: Facilitator -->
    <div class="org-level">
      <div class="org-node" onclick="toggleOrgChildren('agent-children')">
        <div class="org-node-avatar">🎯</div>
        <div class="org-node-name">Mike</div>
        <div class="org-node-role">COO · Facilitator · Task Delegation</div>
        <div class="org-node-model">claude-opus-4-6</div>
        <div class="org-node-status">${statusDot(getStatus('main'))} <span>${getStatus('main')}</span></div>
      </div>
    </div>
    
    <!-- Connector line -->
    <div style="display:flex;justify-content:center"><div style="width:2px;height:30px;background:var(--border-hover)"></div></div>
    
    <!-- Level 3: Agents -->
    <div class="org-children ${collapsed}" id="agent-children">
      ${childAgents.map(a => `
        <div class="org-connector">
          <div class="org-node">
            <div class="org-node-avatar">${a.emoji}</div>
            <div class="org-node-name">${a.name}</div>
            <div class="org-node-role">${a.role}</div>
            <div class="org-node-model">${a.model}</div>
            <div class="org-node-status">${statusDot(getStatus(a.id))} <span>${getStatus(a.id)}</span></div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function toggleOrgChildren(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed');
}

function expandAllOrg() {
  orgExpanded = true;
  document.querySelectorAll('.org-children').forEach(el => el.classList.remove('collapsed'));
}

function collapseAllOrg() {
  orgExpanded = false;
  document.querySelectorAll('.org-children').forEach(el => el.classList.add('collapsed'));
}

// ══════════════════════════════════════════════════════════════
// SCHEDULED TASKS
// ══════════════════════════════════════════════════════════════

async function loadScheduledTasks() {
  try {
    const [tasksRes, logRes] = await Promise.all([
      fetch(`${API}/api/scheduled-tasks`),
      fetch(`${API}/api/overnight-log`)
    ]);
    const scheduledTasks = await tasksRes.json();
    const overnightLog = await logRes.json();
    
    const daily = scheduledTasks.filter(t => t.type === 'daily');
    const weekly = scheduledTasks.filter(t => t.type === 'weekly');
    
    document.getElementById('dailyJobs').innerHTML = daily.map(jobRowHTML).join('');
    document.getElementById('weeklyJobs').innerHTML = weekly.map(jobRowHTML).join('');
    
    document.getElementById('overnightLog').innerHTML = overnightLog.length ?
      overnightLog.map(e => {
        const info = AGENT_INFO[e.agent] || { name: e.agent, emoji: '🤖' };
        return `<div class="log-entry">
          <div class="log-entry-header">
            <span class="log-entry-title">${esc(e.title)}</span>
            <span class="log-entry-tag">${info.emoji} ${info.name}</span>
          </div>
          <div class="log-entry-body">${esc(e.description)}</div>
          <div class="log-entry-time">${e.time ? timeAgo(e.time) : ''}</div>
        </div>`;
      }).join('') :
      '<p style="text-align:center;color:var(--muted);padding:20px">No overnight log entries</p>';
  } catch(e) { console.error(e); }
}

function jobRowHTML(job) {
  const info = AGENT_INFO[job.agent] || { name: job.agent, emoji: '🤖' };
  return `<div class="job-row">
    <span class="job-icon">${job.icon || '⚙️'}</span>
    <span class="job-status-dot" style="background:${job.status === 'active' ? '#00E676' : '#888'}"></span>
    <div class="job-info">
      <div class="job-title">${esc(job.title)}</div>
      <div class="job-desc">${esc(job.description)}</div>
    </div>
    <span class="job-agent-pill">${info.emoji} ${info.name}</span>
    <span class="job-schedule">${esc(job.schedule_human)}</span>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// WORKSPACES
// ══════════════════════════════════════════════════════════════

async function loadWorkspaces() {
  try {
    const res = await fetch(`${API}/api/workspaces`);
    workspaces = await res.json();
    renderWorkspaceSidebar();
  } catch(e) { console.error(e); }
}

function renderWorkspaceSidebar() {
  const el = document.getElementById('wsAgentList');
  el.innerHTML = workspaces.map(ws => {
    const filesHtml = ws.files.map(f => 
      `<div class="ws-file" onclick="loadWorkspaceFile('${ws.agent}','${f.name}',this)">📄 ${f.name}</div>`
    ).join('');
    return `<div class="ws-agent">
      <div class="ws-agent-name" onclick="this.parentElement.querySelector('.ws-files').classList.toggle('collapsed')">
        ${ws.emoji} ${ws.name}
        <span style="font-size:.65rem;color:var(--muted);margin-left:auto">${ws.files.length} files</span>
      </div>
      <div class="ws-files">${filesHtml}</div>
    </div>`;
  }).join('');
}

async function loadWorkspaceFile(agentId, filename, el) {
  // Highlight active
  document.querySelectorAll('.ws-file').forEach(f => f.classList.remove('active'));
  if (el) el.classList.add('active');
  
  const content = document.getElementById('wsContent');
  content.innerHTML = '<p style="text-align:center;color:var(--muted);padding:40px">Loading...</p>';
  
  try {
    const res = await fetch(`${API}/api/workspaces/${agentId}/${filename}`);
    const data = await res.json();
    const info = AGENT_INFO[agentId] || { name: agentId, emoji: '🤖' };
    
    // Simple markdown rendering
    const rendered = renderMarkdown(data.content);
    
    content.innerHTML = `
      <div class="ws-file-header">
        <span class="ws-file-title">${info.emoji} ${info.name} / ${filename}</span>
        <span class="ws-file-meta">${(data.content.length / 1024).toFixed(1)} KB</span>
      </div>
      <div class="ws-file-content">${rendered}</div>
    `;
  } catch(e) {
    content.innerHTML = '<p style="text-align:center;color:var(--red);padding:40px">Failed to load file</p>';
  }
}

function renderMarkdown(text) {
  // Basic markdown to HTML
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
// STANDUPS
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
      const pills = (s.participants || []).map(p => {
        const info = AGENT_INFO[p] || { name: p };
        return `<span class="participant-pill pill-${p}">${info.name}</span>`;
      }).join('');
      return `<div class="standup-list-item" onclick="openStandup('${s.id}')">
        <div class="standup-list-title">${esc(s.title)}</div>
        <div class="standup-list-date">${s.date} · ${s.message_count || 0} messages</div>
        <div class="standup-list-participants">${pills}</div>
      </div>`;
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
    
    const pills = (s.participants || []).map(p => {
      const info = AGENT_INFO[p] || { name: p };
      return `<span class="participant-pill pill-${p}">${info.name}</span>`;
    }).join('');
    
    const messages = (s.messages || []).map(m => {
      const info = AGENT_INFO[m.agent] || { name: m.agent, emoji: '🤖' };
      const isAction = m.type === 'action_item';
      const doneClass = m.completed ? 'action-done' : '';
      const checkbox = isAction ? 
        `<input type="checkbox" class="action-checkbox" ${m.completed ? 'checked' : ''} onchange="toggleActionItem('${m.id}', this.checked)">` : '';
      
      return `<div class="standup-msg">
        <div class="standup-msg-avatar">${info.emoji}</div>
        <div class="standup-msg-content">
          <div class="standup-msg-header">
            <span class="standup-msg-name" style="color:${info.color || 'var(--accent)'}">${info.name}</span>
            <span class="standup-msg-time">${timeAgo(m.created_at)}</span>
          </div>
          <div class="standup-msg-body ${isAction ? 'action-item' : ''} ${doneClass}">
            ${checkbox}${esc(m.content)}
          </div>
        </div>
      </div>`;
    }).join('');
    
    detail.innerHTML = `
      <span class="standup-back" onclick="loadStandups()">← Back to Standups</span>
      <h2 style="margin:12px 0 4px">${esc(s.title)}</h2>
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:4px">${s.date}</div>
      <div class="standup-list-participants" style="margin-bottom:20px">${pills}</div>
      <div class="standup-thread">${messages || '<p style="color:var(--muted)">No messages yet</p>'}</div>
      <div class="standup-add-msg">
        <select id="msgAgent">
          ${Object.entries(AGENT_INFO).map(([k,v]) => `<option value="${k}">${v.emoji} ${v.name}</option>`).join('')}
        </select>
        <input type="text" id="msgContent" placeholder="Add message..." onkeydown="if(event.key==='Enter')sendStandupMsg('${s.id}','message')">
        <button class="btn btn-sm btn-primary" onclick="sendStandupMsg('${s.id}','message')">Send</button>
        <button class="btn btn-sm" onclick="sendStandupMsg('${s.id}','action_item')" title="Add as action item">☑️</button>
      </div>
    `;
  } catch(e) { console.error(e); }
}

async function sendStandupMsg(standupId, type) {
  const agent = document.getElementById('msgAgent').value;
  const content = document.getElementById('msgContent').value.trim();
  if (!content) return;
  await fetch(`${API}/api/standups/${standupId}/messages`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ standup_id: standupId, agent, content, type })
  });
  document.getElementById('msgContent').value = '';
  openStandup(standupId);
}

async function toggleActionItem(msgId, completed) {
  await fetch(`${API}/api/standup-messages/${msgId}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ completed })
  });
}

function openStandupModal() { document.getElementById('standupModal').classList.add('open'); }

async function createStandup(e) {
  e.preventDefault();
  const title = document.getElementById('standupTitle').value;
  const checkboxes = document.querySelectorAll('#standupModal .checkbox-group input:checked');
  const participants = Array.from(checkboxes).map(cb => cb.value);
  
  await fetch(`${API}/api/standups`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ title, participants, date: new Date().toISOString().slice(0,10) })
  });
  document.getElementById('standupModal').classList.remove('open');
  document.getElementById('standupTitle').value = '';
  loadStandups();
}

// ══════════════════════════════════════════════════════════════
// GPU STATS WIDGET
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
  } catch(e) {
    document.getElementById('gpuWidget').innerHTML = '<div class="gpu-loading">GPU offline</div>';
  }
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

  const sparkBars = gpuHistory.map(v =>
    `<div class="gpu-spark-bar" style="height:${Math.max(v, 2)}%"></div>`
  ).join('');

  el.innerHTML = `
    <div class="gpu-row">
      <span class="gpu-label">Utilization</span>
      <span class="gpu-value gpu-indicator-${useColor}">${g.gpu_use}%</span>
    </div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${g.gpu_use}%;background:${barColor}"></div></div>
    <div class="gpu-sparkline">${sparkBars}</div>
    <div class="gpu-row" style="margin-top:8px">
      <span class="gpu-label">VRAM</span>
      <span class="gpu-value gpu-indicator-${vramColor}">${vramGB} / ${vramTotalGB} GB</span>
    </div>
    <div class="gpu-bar-wrap"><div class="gpu-bar" style="width:${vramPct}%;background:${vramBarColor}"></div></div>
    <div class="gpu-row" style="margin-top:6px">
      <span class="gpu-label">Temp</span>
      <span class="gpu-value gpu-indicator-${tempColor}">${g.temp}°C</span>
    </div>
    <div class="gpu-row">
      <span class="gpu-label">Power</span>
      <span class="gpu-value">${g.power.toFixed(0)} W</span>
    </div>
    <div class="gpu-row">
      <span class="gpu-label">GPU Clock</span>
      <span class="gpu-value">${g.sclk != null ? g.sclk + ' MHz' : 'N/A'}</span>
    </div>
    <div class="gpu-row">
      <span class="gpu-label">MEM Clock</span>
      <span class="gpu-value">${g.mclk != null ? g.mclk + ' MHz' : 'N/A'}</span>
    </div>
  `;
}

// Start GPU polling
setInterval(loadGpuStats, 5000);
document.addEventListener('DOMContentLoaded', () => setTimeout(loadGpuStats, 500));

// ── Helpers ────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function formatDuration(secs) {
  if (!secs) return '';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.round(secs%60)}s`;
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
}
