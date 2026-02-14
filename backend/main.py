"""Mission Control — FastAPI Backend (Phase 3)"""
import os, json, time, uuid, sqlite3, glob, httpx
from datetime import datetime, timezone
from typing import Optional, List
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("MC_DB", "/data/mission_control.db")
GATEWAY_URL = os.environ.get("GATEWAY_URL", "https://100.101.174.1:18789")
GATEWAY_TOKEN = os.environ.get("GATEWAY_TOKEN", "")
OPENCLAW_HOME = os.environ.get("OPENCLAW_HOME", "/home/pc1/.openclaw")
DOCS_PATH = os.environ.get("DOCS_PATH", "/home/pc1/pc1-docs")

# ── Models ──────────────────────────────────────────────────────
class TaskCreate(BaseModel):
    title: str
    description: str = ""
    assigned_agent: str = ""
    priority: str = "medium"
    status: str = "todo"

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assigned_agent: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None

class CommentCreate(BaseModel):
    task_id: str
    agent: str = ""
    content: str = ""
    type: str = "comment"

class AgentUpdate(BaseModel):
    status: Optional[str] = None
    last_activity: Optional[str] = None
    current_task: Optional[str] = None

class WebhookEvent(BaseModel):
    runId: str = ""
    action: str = ""
    sessionKey: str = ""
    prompt: str = ""
    source: str = ""
    response: str = ""
    error: str = ""
    agent: str = ""
    model: str = ""
    duration: Optional[float] = None

class StandupCreate(BaseModel):
    title: str
    date: str = ""
    participants: List[str] = []

class StandupMessageCreate(BaseModel):
    standup_id: str
    agent: str
    content: str
    type: str = "message"  # message/action_item

class ActionItemUpdate(BaseModel):
    completed: Optional[bool] = None
    assignee: Optional[str] = None

class FileWriteRequest(BaseModel):
    content: str

class ActionItemCreate(BaseModel):
    text: str
    assignee: str = ""
    standup_id: str = ""

class ActionItemPatch(BaseModel):
    completed: Optional[bool] = None
    assignee: Optional[str] = None
    text: Optional[str] = None

# ── DB Setup ────────────────────────────────────────────────────
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        assigned_agent TEXT DEFAULT '',
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'todo',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        duration REAL
    );
    CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent TEXT DEFAULT '',
        content TEXT DEFAULT '',
        type TEXT DEFAULT 'comment',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        model TEXT DEFAULT '',
        status TEXT DEFAULT 'idle',
        last_activity TEXT,
        current_task TEXT,
        emoji TEXT DEFAULT '🤖'
    );
    CREATE TABLE IF NOT EXISTS activity_feed (
        id TEXT PRIMARY KEY,
        agent TEXT DEFAULT '',
        action TEXT NOT NULL,
        details TEXT DEFAULT '',
        task_id TEXT,
        success INTEGER DEFAULT 1,
        duration REAL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS standups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        participants TEXT DEFAULT '[]',
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS standup_messages (
        id TEXT PRIMARY KEY,
        standup_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'message',
        completed INTEGER DEFAULT 0,
        assignee TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (standup_id) REFERENCES standups(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        assignee TEXT DEFAULT '',
        completed INTEGER DEFAULT 0,
        standup_id TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        completed_at TEXT
    );
    """)
    # Seed agents if empty
    existing = conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    if existing == 0:
        agents_data = [
            ("main", "Mike", "claude-opus-4-6", "idle", "🎯"),
            ("trading", "Trading / AA", "claude-opus-4-6", "idle", "📈"),
            ("it-support", "IT Support", "claude-sonnet-4.5", "idle", "🔧"),
            ("dev", "Dev", "claude-opus-4-6", "idle", "💻"),
            ("voice", "Voice", "claude-sonnet-4.5", "idle", "🎙️"),
            ("troubleshoot", "Troubleshoot", "claude-opus-4-6", "idle", "🔍"),
        ]
        conn.executemany(
            "INSERT INTO agents (name, display_name, model, status, emoji) VALUES (?,?,?,?,?)",
            agents_data
        )
    # Always update model names to correct values (migration)
    model_corrections = [
        ("main", "claude-opus-4-6"),
        ("trading", "claude-opus-4-6"),
        ("it-support", "claude-sonnet-4.5"),
        ("dev", "claude-opus-4-6"),
        ("voice", "claude-sonnet-4.5"),
        ("troubleshoot", "claude-opus-4-6"),
    ]
    for agent_name, correct_model in model_corrections:
        conn.execute("UPDATE agents SET model = ? WHERE name = ?", (correct_model, agent_name))
    conn.commit()
    conn.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="Mission Control", lifespan=lifespan)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def add_activity(conn, agent, action, details="", task_id=None, success=True, duration=None):
    conn.execute(
        "INSERT INTO activity_feed (id, agent, action, details, task_id, success, duration, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), agent, action, details, task_id, 1 if success else 0, duration, now_iso())
    )

# ── GPU Stats ───────────────────────────────────────────────────
GPU_STATS_FILE = "/data/gpu_stats.json"

@app.get("/api/gpu")
def get_gpu_stats():
    try:
        with open(GPU_STATS_FILE, "r") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        raise HTTPException(503, "GPU stats not available")
    card = raw.get("card0", {})
    vram_total = int(card.get("VRAM Total Memory (B)", 0))
    vram_used = int(card.get("VRAM Total Used Memory (B)", 0))
    sclk_raw = card.get("sclk clock speed:", "")
    mclk_raw = card.get("mclk clock speed:", "")
    sclk = int(sclk_raw.strip("()Mhz")) if sclk_raw else None
    mclk = int(mclk_raw.strip("()Mhz")) if mclk_raw else None
    return {
        "gpu_use": int(card.get("GPU use (%)", 0)),
        "temp": float(card.get("Temperature (Sensor edge) (C)", 0)),
        "power": float(card.get("Current Socket Graphics Package Power (W)", 0)),
        "vram_used": vram_used,
        "vram_total": vram_total,
        "sclk": sclk,
        "mclk": mclk,
    }

# ── Gateway Proxy ───────────────────────────────────────────────
@app.get("/api/gateway/sessions")
async def gateway_sessions():
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as client:
            headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
            resp = await client.get(f"{GATEWAY_URL}/api/sessions", headers=headers)
            if resp.status_code == 200:
                return resp.json()
            resp = await client.get(f"{GATEWAY_URL}/api/sessions",
                                     auth=("admin", GATEWAY_TOKEN))
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        pass
    return []

@app.get("/api/gateway/agents")
async def gateway_agents():
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as client:
            headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
            resp = await client.get(f"{GATEWAY_URL}/api/agents", headers=headers)
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        pass
    return []

# ── Task CRUD ───────────────────────────────────────────────────
@app.get("/api/tasks")
def list_tasks(status: Optional[str] = None, agent: Optional[str] = None):
    conn = get_db()
    q = "SELECT * FROM tasks"
    params = []
    wheres = []
    if status:
        wheres.append("status = ?")
        params.append(status)
    if agent:
        wheres.append("assigned_agent = ?")
        params.append(agent)
    if wheres:
        q += " WHERE " + " AND ".join(wheres)
    q += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/tasks/{task_id}")
def get_task(task_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Task not found")
    task = dict(row)
    comments = conn.execute("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    task["comments"] = [dict(c) for c in comments]
    history = conn.execute(
        "SELECT * FROM activity_feed WHERE task_id = ? ORDER BY created_at ASC", (task_id,)
    ).fetchall()
    task["history"] = [dict(h) for h in history]
    conn.close()
    return task

@app.post("/api/tasks")
def create_task(t: TaskCreate):
    conn = get_db()
    tid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO tasks (id, title, description, assigned_agent, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (tid, t.title, t.description, t.assigned_agent, t.priority, t.status, ts, ts)
    )
    add_activity(conn, t.assigned_agent, "task_created", f"Created: {t.title}", tid)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    conn.close()
    return dict(row)

@app.patch("/api/tasks/{task_id}")
def update_task(task_id: str, t: TaskUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Task not found")
    old = dict(row)
    updates = {}
    for field in ["title", "description", "assigned_agent", "priority", "status"]:
        val = getattr(t, field)
        if val is not None:
            updates[field] = val
    if not updates:
        conn.close()
        return old
    updates["updated_at"] = now_iso()
    if "status" in updates:
        if updates["status"] == "done" and old["status"] != "done":
            updates["completed_at"] = now_iso()
            try:
                from datetime import datetime as dt
                created = dt.fromisoformat(old["created_at"])
                completed = dt.fromisoformat(updates["completed_at"])
                updates["duration"] = (completed - created).total_seconds()
            except:
                pass
        add_activity(conn, old["assigned_agent"], "status_change",
                     f"{old['status']} → {updates['status']}: {old['title']}", task_id)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [task_id]
    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    conn.close()
    return dict(row)

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    conn = get_db()
    conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    conn.execute("DELETE FROM comments WHERE task_id = ?", (task_id,))
    conn.execute("DELETE FROM activity_feed WHERE task_id = ?", (task_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

# ── Comments ────────────────────────────────────────────────────
@app.post("/api/comments")
def create_comment(c: CommentCreate):
    conn = get_db()
    cid = str(uuid.uuid4())[:8]
    conn.execute(
        "INSERT INTO comments (id, task_id, agent, content, type, created_at) VALUES (?,?,?,?,?,?)",
        (cid, c.task_id, c.agent, c.content, c.type, now_iso())
    )
    add_activity(conn, c.agent, "comment_added", c.content[:100], c.task_id)
    conn.commit()
    conn.close()
    return {"id": cid}

# ── Agents ──────────────────────────────────────────────────────
@app.get("/api/agents")
async def list_agents():
    conn = get_db()
    rows = conn.execute("SELECT * FROM agents ORDER BY name").fetchall()
    agents_list = [dict(r) for r in rows]
    
    # Try to sync with gateway sessions for live status
    try:
        async with httpx.AsyncClient(verify=False, timeout=5) as client:
            headers = {}
            if GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"
            # Try multiple auth methods
            resp = None
            for attempt in [
                lambda: client.get(f"{GATEWAY_URL}/api/v1/sessions", headers=headers),
                lambda: client.get(f"{GATEWAY_URL}/api/sessions", headers=headers),
            ]:
                try:
                    resp = await attempt()
                    if resp.status_code == 200:
                        break
                except:
                    continue
            
            if resp and resp.status_code == 200:
                sessions = resp.json()
                # Map active sessions to agents
                active_agents = set()
                for s in sessions:
                    agent_id = s.get("agent") or s.get("agentId") or ""
                    if agent_id and s.get("status") in ("running", "active", "busy"):
                        active_agents.add(agent_id)
                
                # Update agent statuses
                for agent in agents_list:
                    if agent["name"] in active_agents:
                        agent["status"] = "busy"
                    elif agent["status"] == "busy":
                        # If DB says busy but gateway says no active session, mark idle
                        agent["status"] = "idle"
    except:
        pass  # Gateway unreachable, use DB status
    
    conn.close()
    return agents_list

@app.patch("/api/agents/{name}")
def update_agent(name: str, a: AgentUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM agents WHERE name = ?", (name,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Agent not found")
    updates = {}
    for field in ["status", "last_activity", "current_task"]:
        val = getattr(a, field)
        if val is not None:
            updates[field] = val
    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [name]
        conn.execute(f"UPDATE agents SET {set_clause} WHERE name = ?", vals)
        conn.commit()
    row = conn.execute("SELECT * FROM agents WHERE name = ?", (name,)).fetchone()
    conn.close()
    return dict(row)

# ── Activity Feed ───────────────────────────────────────────────
@app.get("/api/activity")
def list_activity(agent: Optional[str] = None, limit: int = 50):
    conn = get_db()
    q = "SELECT * FROM activity_feed"
    params = []
    if agent:
        q += " WHERE agent = ?"
        params.append(agent)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── Scheduled Tasks ─────────────────────────────────────────────
@app.get("/api/scheduled-tasks")
def get_scheduled_tasks():
    tasks = [
        {"id":"daily-memory-backup","title":"Daily Memory Backup","description":"Backup all agent MEMORY.md files","schedule":"0 3 * * *","schedule_human":"Daily at 3:00 AM","type":"daily","status":"active","agent":"it-support","last_run":None,"icon":"💾"},
        {"id":"trading-market-scan","title":"Market Open Scan","description":"Scan markets at opening for trading signals","schedule":"30 9 * * 1-5","schedule_human":"Mon-Fri at 9:30 AM","type":"daily","status":"active","agent":"trading","last_run":None,"icon":"📊"},
        {"id":"trading-close-review","title":"Market Close Review","description":"Review positions and P&L at market close","schedule":"0 16 * * 1-5","schedule_human":"Mon-Fri at 4:00 PM","type":"daily","status":"active","agent":"trading","last_run":None,"icon":"📈"},
        {"id":"health-check","title":"System Health Check","description":"Check all services, Docker containers, and disk space","schedule":"*/30 * * * *","schedule_human":"Every 30 minutes","type":"daily","status":"active","agent":"it-support","last_run":None,"icon":"🏥"},
        {"id":"overnight-summary","title":"Overnight Activity Summary","description":"Compile overnight agent activity into daily report","schedule":"0 7 * * *","schedule_human":"Daily at 7:00 AM","type":"daily","status":"active","agent":"main","last_run":None,"icon":"🌅"},
        {"id":"weekly-standup","title":"Weekly Team Standup","description":"Auto-trigger weekly standup summary for all agents","schedule":"0 9 * * 1","schedule_human":"Monday at 9:00 AM","type":"weekly","status":"active","agent":"main","last_run":None,"icon":"📋"},
        {"id":"weekly-performance","title":"Weekly Performance Report","description":"Aggregate token usage, costs, task completion rates","schedule":"0 18 * * 5","schedule_human":"Friday at 6:00 PM","type":"weekly","status":"active","agent":"dev","last_run":None,"icon":"📊"},
        {"id":"weekly-backup","title":"Weekly Full Backup","description":"Full backup of all workspaces and databases","schedule":"0 2 * * 0","schedule_human":"Sunday at 2:00 AM","type":"weekly","status":"active","agent":"it-support","last_run":None,"icon":"💿"},
    ]
    return tasks

# ── Overnight Log ───────────────────────────────────────────────
@app.get("/api/overnight-log")
def get_overnight_log():
    conn = get_db()
    rows = conn.execute("SELECT * FROM activity_feed ORDER BY created_at DESC LIMIT 20").fetchall()
    conn.close()
    entries = []
    for r in rows:
        d = dict(r)
        entries.append({
            "id": d["id"], "title": d["action"].replace("_", " ").title(),
            "description": d["details"] or "No details", "agent": d["agent"],
            "tag": d["action"], "time": d["created_at"], "success": d["success"]
        })
    if not entries:
        entries = [
            {"id":"example-1","title":"System Health Check ✅","description":"All services healthy.","agent":"it-support","tag":"health_check","time":now_iso(),"success":1},
            {"id":"example-2","title":"Dashboard Update 🔧","description":"Mission Control Phase 3 deployed.","agent":"dev","tag":"deployment","time":now_iso(),"success":1},
        ]
    return entries

# ── Workspaces (file browser + editor) ──────────────────────────
WORKSPACE_MAP = {
    "main": {"path": "workspace", "name": "Mike (Main)", "emoji": "🎯"},
    "trading": {"path": "workspace-trading", "name": "Trading / AA", "emoji": "📈"},
    "it-support": {"path": "workspace-it-support", "name": "IT Support", "emoji": "🔧"},
    "dev": {"path": "workspace-dev", "name": "Dev", "emoji": "💻"},
    "voice": {"path": "workspace-voice", "name": "Voice", "emoji": "🎙️"},
    "troubleshoot": {"path": "workspace-troubleshoot", "name": "Troubleshoot", "emoji": "🔍"},
}

ALLOWED_FILES = ["SOUL.md", "MEMORY.md", "TOOLS.md", "AGENTS.md", "IDENTITY.md"]

@app.get("/api/workspaces")
def list_workspaces():
    result = []
    for agent_id, info in WORKSPACE_MAP.items():
        ws_path = os.path.join(OPENCLAW_HOME, info["path"])
        files = []
        for fname in ALLOWED_FILES:
            fpath = os.path.join(ws_path, fname)
            if os.path.exists(fpath):
                stat = os.stat(fpath)
                files.append({
                    "name": fname,
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
                })
        result.append({
            "agent": agent_id, "name": info["name"], "emoji": info["emoji"],
            "path": ws_path, "files": files
        })
    return result

@app.get("/api/workspaces/{agent_id}/{filename}")
def read_workspace_file(agent_id: str, filename: str):
    if agent_id not in WORKSPACE_MAP:
        raise HTTPException(404, "Agent not found")
    if filename not in ALLOWED_FILES:
        raise HTTPException(403, "File not allowed")
    ws_path = os.path.join(OPENCLAW_HOME, WORKSPACE_MAP[agent_id]["path"])
    fpath = os.path.join(ws_path, filename)
    if not os.path.exists(fpath):
        raise HTTPException(404, "File not found")
    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    stat = os.stat(fpath)
    return {
        "content": content, "filename": filename, "agent": agent_id,
        "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "size": stat.st_size
    }

@app.put("/api/workspaces/{agent_id}/{filename}")
def write_workspace_file(agent_id: str, filename: str, body: FileWriteRequest):
    if agent_id not in WORKSPACE_MAP:
        raise HTTPException(404, "Agent not found")
    if filename not in ALLOWED_FILES:
        raise HTTPException(403, "File not allowed")
    ws_path = os.path.join(OPENCLAW_HOME, WORKSPACE_MAP[agent_id]["path"])
    fpath = os.path.join(ws_path, filename)
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(body.content)
    return {"ok": True, "size": len(body.content)}

# ── Workspace change detection (polling) ────────────────────────
@app.get("/api/workspaces/changes")
def workspace_changes(since: Optional[str] = None):
    """Return files modified since given ISO timestamp"""
    if not since:
        return {"changed": False, "files": []}
    try:
        since_ts = datetime.fromisoformat(since).timestamp()
    except:
        return {"changed": False, "files": []}
    changed_files = []
    for agent_id, info in WORKSPACE_MAP.items():
        ws_path = os.path.join(OPENCLAW_HOME, info["path"])
        for fname in ALLOWED_FILES:
            fpath = os.path.join(ws_path, fname)
            if os.path.exists(fpath):
                mtime = os.stat(fpath).st_mtime
                if mtime > since_ts:
                    changed_files.append({"agent": agent_id, "file": fname, "modified": datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()})
    return {"changed": len(changed_files) > 0, "files": changed_files}

# ── Standups ────────────────────────────────────────────────────
@app.get("/api/standups")
def list_standups():
    conn = get_db()
    rows = conn.execute("SELECT * FROM standups ORDER BY created_at DESC LIMIT 20").fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["participants"] = json.loads(d.get("participants", "[]"))
        msg_count = conn.execute("SELECT COUNT(*) FROM standup_messages WHERE standup_id = ?", (d["id"],)).fetchone()[0]
        d["message_count"] = msg_count
        result.append(d)
    conn.close()
    return result

@app.get("/api/standups/{standup_id}")
def get_standup(standup_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM standups WHERE id = ?", (standup_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Standup not found")
    d = dict(row)
    d["participants"] = json.loads(d.get("participants", "[]"))
    messages = conn.execute("SELECT * FROM standup_messages WHERE standup_id = ? ORDER BY created_at ASC", (standup_id,)).fetchall()
    d["messages"] = [dict(m) for m in messages]
    conn.close()
    return d

@app.post("/api/standups")
def create_standup(s: StandupCreate):
    conn = get_db()
    sid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO standups (id, title, date, participants, created_at) VALUES (?,?,?,?,?)",
        (sid, s.title, s.date or ts[:10], json.dumps(s.participants), ts)
    )
    conn.commit()
    conn.close()
    return {"id": sid}

@app.post("/api/standups/{standup_id}/messages")
def add_standup_message(standup_id: str, m: StandupMessageCreate):
    conn = get_db()
    mid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO standup_messages (id, standup_id, agent, content, type, created_at) VALUES (?,?,?,?,?,?)",
        (mid, standup_id, m.agent, m.content, m.type, ts)
    )
    conn.commit()
    conn.close()
    return {"id": mid}

@app.patch("/api/standup-messages/{message_id}")
def update_standup_message(message_id: str, a: ActionItemUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM standup_messages WHERE id = ?", (message_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Message not found")
    updates = {}
    if a.completed is not None:
        updates["completed"] = 1 if a.completed else 0
    if a.assignee is not None:
        updates["assignee"] = a.assignee
    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [message_id]
        conn.execute(f"UPDATE standup_messages SET {set_clause} WHERE id = ?", vals)
        conn.commit()
    conn.close()
    return {"ok": True}

# ── Action Items (standalone checklist) ─────────────────────────
@app.get("/api/action-items")
def list_action_items(completed: Optional[bool] = None):
    conn = get_db()
    q = "SELECT * FROM action_items"
    params = []
    if completed is not None:
        q += " WHERE completed = ?"
        params.append(1 if completed else 0)
    q += " ORDER BY completed ASC, created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/action-items")
def create_action_item(item: ActionItemCreate):
    conn = get_db()
    aid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO action_items (id, text, assignee, completed, standup_id, created_at) VALUES (?,?,?,0,?,?)",
        (aid, item.text, item.assignee, item.standup_id, ts)
    )
    conn.commit()
    conn.close()
    return {"id": aid}

@app.patch("/api/action-items/{item_id}")
def update_action_item(item_id: str, patch: ActionItemPatch):
    conn = get_db()
    row = conn.execute("SELECT * FROM action_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Action item not found")
    updates = {}
    if patch.completed is not None:
        updates["completed"] = 1 if patch.completed else 0
        if patch.completed:
            updates["completed_at"] = now_iso()
        else:
            updates["completed_at"] = None
    if patch.assignee is not None:
        updates["assignee"] = patch.assignee
    if patch.text is not None:
        updates["text"] = patch.text
    if updates:
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [item_id]
        conn.execute(f"UPDATE action_items SET {set_clause} WHERE id = ?", vals)
        conn.commit()
    row = conn.execute("SELECT * FROM action_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    return dict(row)

@app.delete("/api/action-items/{item_id}")
def delete_action_item(item_id: str):
    conn = get_db()
    conn.execute("DELETE FROM action_items WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

# ── Docs (browse pc1-docs) ──────────────────────────────────────
@app.get("/api/docs")
def list_docs(q: Optional[str] = None):
    """List all markdown docs, optionally filtered by search query"""
    docs_dir = os.path.join(DOCS_PATH, "docs")
    if not os.path.isdir(docs_dir):
        return []
    results = []
    for fname in sorted(os.listdir(docs_dir)):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(docs_dir, fname)
        stat = os.stat(fpath)
        title = fname.replace(".md", "").replace("-", " ").title()
        # Read first line for title if it starts with #
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                first_line = f.readline().strip()
                if first_line.startswith("# "):
                    title = first_line[2:].strip()
                # Search within content if query provided
                if q:
                    f.seek(0)
                    content = f.read().lower()
                    if q.lower() not in content and q.lower() not in fname.lower():
                        continue
        except:
            pass
        results.append({
            "filename": fname,
            "title": title,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        })
    # Also include README.md from root
    readme_path = os.path.join(DOCS_PATH, "README.md")
    if os.path.exists(readme_path):
        stat = os.stat(readme_path)
        include = True
        if q:
            try:
                with open(readme_path, "r") as f:
                    if q.lower() not in f.read().lower():
                        include = False
            except:
                include = False
        if include:
            results.insert(0, {
                "filename": "README.md",
                "title": "README",
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
            })
    return results

@app.get("/api/docs/{filename}")
def read_doc(filename: str):
    """Read a specific doc file"""
    # Try docs/ subdirectory first, then root
    fpath = os.path.join(DOCS_PATH, "docs", filename)
    if not os.path.exists(fpath):
        fpath = os.path.join(DOCS_PATH, filename)
    if not os.path.exists(fpath) or not filename.endswith(".md"):
        raise HTTPException(404, "Doc not found")
    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    return {"filename": filename, "content": content}

# ── Webhook (OpenClaw integration) ─────────────────────────────
@app.post("/api/webhook/openclaw")
def openclaw_webhook(event: WebhookEvent):
    conn = get_db()
    if event.action == "start":
        tid = event.runId[:8] if event.runId else str(uuid.uuid4())[:8]
        ts = now_iso()
        existing = conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not existing:
            title = event.prompt[:100] if event.prompt else f"Agent run {tid}"
            if event.source:
                title = f"[{event.source}] {title}"
            conn.execute(
                "INSERT INTO tasks (id, title, description, assigned_agent, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (tid, title, event.prompt or "", event.agent, "medium", "in_progress", ts, ts)
            )
        conn.execute("UPDATE agents SET status = 'busy', last_activity = ?, current_task = ? WHERE name = ?",
                     (ts, tid, event.agent))
        add_activity(conn, event.agent, "task_started", title if not existing else "", tid)
    elif event.action == "end":
        tid = event.runId[:8] if event.runId else ""
        ts = now_iso()
        if tid:
            conn.execute("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?, duration = ? WHERE id = ?",
                         (ts, ts, event.duration, tid))
        conn.execute("UPDATE agents SET status = 'idle', last_activity = ?, current_task = NULL WHERE name = ?",
                     (ts, event.agent))
        add_activity(conn, event.agent, "task_completed", event.response[:100] if event.response else "", tid, duration=event.duration)
    elif event.action == "error":
        tid = event.runId[:8] if event.runId else ""
        ts = now_iso()
        if tid:
            conn.execute("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?", (ts, tid))
        conn.execute("UPDATE agents SET status = 'error', last_activity = ? WHERE name = ?", (ts, event.agent))
        add_activity(conn, event.agent, "task_error", event.error[:200] if event.error else "", tid, success=False)
        if tid and event.error:
            conn.execute("INSERT INTO comments (id, task_id, agent, content, type, created_at) VALUES (?,?,?,?,?,?)",
                         (str(uuid.uuid4())[:8], tid, event.agent, event.error, "error", ts))
    elif event.action == "progress":
        tid = event.runId[:8] if event.runId else ""
        ts = now_iso()
        conn.execute("UPDATE agents SET last_activity = ? WHERE name = ?", (ts, event.agent))
        if tid and event.response:
            conn.execute("INSERT INTO comments (id, task_id, agent, content, type, created_at) VALUES (?,?,?,?,?,?)",
                         (str(uuid.uuid4())[:8], tid, event.agent, event.response[:500], "log", ts))
    conn.commit()
    conn.close()
    return {"ok": True}

# ── Static files ────────────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/{full_path:path}")
def spa_catch_all(full_path: str):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3335, reload=True)
