// Mission Control — Frontend
const API = '';
let tasks = [];
let agents = [];
let draggedTaskId = null;

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  setInterval(loadAll, 5000); // Poll every 5s
});

async function loadAll() {
  await Promise.all([loadTasks(), loadAgents()]);
}

// ── Tasks ──────────────────────────────────────────────────────
async function loadTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
    tasks = await res.json();
    renderBoard();
  } catch(e) { console.error('Failed to load tasks', e); }
}

function renderBoard() {
  const cols = { todo: [], in_progress: [], review: [], done: [] };
  tasks.forEach(t => {
    const status = t.status in cols ? t.status : 'todo';
    cols[status].push(t);
  });
  
  let total = 0;
  for (const [status, items] of Object.entries(cols)) {
    const el = document.getElementById(`col-${status}`);
    el.innerHTML = items.map(t => taskCardHTML(t)).join('');
    document.getElementById(`count-${status}`).textContent = items.length;
    total += items.length;
  }
  document.getElementById('taskCount').textContent = `${total} tasks`;
  
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
  const time = timeAgo(t.created_at);
  return `<div class="task-card" draggable="true" data-id="${t.id}" onclick="openDetail('${t.id}')">
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="task-agent">${esc(agentLabel)}</span>
      <span class="task-priority priority-${t.priority}">${t.priority}</span>
      <span class="task-time">${time}</span>
      ${dur ? `<span class="task-duration">⏱ ${dur}</span>` : ''}
    </div>
  </div>`;
}

// ── Drag & Drop ────────────────────────────────────────────────
function allowDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
}
function dragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}
async function drop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const col = e.currentTarget.id.replace('col-', '');
  if (!draggedTaskId) return;
  try {
    await fetch(`${API}/api/tasks/${draggedTaskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: col })
    });
    await loadTasks();
  } catch(e) { console.error(e); }
  draggedTaskId = null;
}

// ── Agents ─────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const res = await fetch(`${API}/api/agents`);
    agents = await res.json();
    renderAgents();
  } catch(e) { console.error('Failed to load agents', e); }
}

function renderAgents() {
  const el = document.getElementById('agentsList');
  const busy = agents.filter(a => a.status === 'busy').length;
  document.getElementById('agentStatusSummary').textContent = `${agents.length} agents · ${busy} busy`;
  
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

// ── Activity Feed ──────────────────────────────────────────────
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
  const icons = { task_created: '📦', task_started: '🚀', task_completed: '✅', task_error: '❌', status_change: '🔄', comment_added: '💬' };
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

// ── Tabs ───────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById(tab === 'board' ? 'boardView' : 'activityView').classList.add('active');
  if (tab === 'activity') loadActivity();
}

// ── Task Detail ────────────────────────────────────────────────
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
    
    // Add comment form
    html += `<div class="detail-section"><h3>Add Comment</h3>
      <textarea id="commentText" rows="2" placeholder="Add a comment..." style="width:100%;padding:10px;border-radius:var(--radius);border:1px solid var(--border);background:var(--card);color:var(--text);font-family:inherit;font-size:.85rem;margin-bottom:8px"></textarea>
      <button class="btn btn-sm btn-primary" onclick="addComment('${t.id}')">Add Comment</button>
    </div>`;
    
    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailModal').classList.add('open');
  } catch(e) { console.error(e); }
}

function closeDetail() { document.getElementById('detailModal').classList.remove('open'); }
function closeDetailIfOutside(e) { if (e.target === e.currentTarget) closeDetail(); }

async function moveTask(id, status) {
  await fetch(`${API}/api/tasks/${id}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({status})
  });
  closeDetail();
  await loadTasks();
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' });
  closeDetail();
  await loadTasks();
}

async function addComment(taskId) {
  const text = document.getElementById('commentText').value.trim();
  if (!text) return;
  await fetch(`${API}/api/comments`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ task_id: taskId, content: text, agent: '', type: 'comment' })
  });
  openDetail(taskId); // Refresh
}

// ── Create Task ────────────────────────────────────────────────
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
  await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  });
  closeCreate();
  document.getElementById('newTitle').value = '';
  document.getElementById('newDesc').value = '';
  await loadTasks();
}

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
