"""Mission Control — FastAPI Backend"""
import os, json, time, uuid, sqlite3
from datetime import datetime, timezone
from typing import Optional, List
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("MC_DB", "/data/mission_control.db")

# ── Models ──────────────────────────────────────────────────────
class TaskCreate(BaseModel):
    title: str
    description: str = ""
    assigned_agent: str = ""
    priority: str = "medium"  # low/medium/high/critical
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
    type: str = "comment"  # comment/log/status_change/error

class AgentUpdate(BaseModel):
    status: Optional[str] = None  # idle/busy/error
    last_activity: Optional[str] = None
    current_task: Optional[str] = None

class WebhookEvent(BaseModel):
    runId: str = ""
    action: str = ""  # start/end/error/progress
    sessionKey: str = ""
    prompt: str = ""
    source: str = ""
    response: str = ""
    error: str = ""
    agent: str = ""
    model: str = ""
    duration: Optional[float] = None

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
    """)
    # Seed agents if empty
    existing = conn.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
    if existing == 0:
        agents = [
            ("main", "Mike", "anthropic/claude-sonnet-4-20250514", "idle", "🎯"),
            ("trading", "Trading / AA", "anthropic/claude-sonnet-4-20250514", "idle", "📈"),
            ("it-support", "IT Support", "anthropic/claude-sonnet-4-20250514", "idle", "🔧"),
            ("dev", "Dev", "anthropic/claude-opus-4-6", "idle", "💻"),
            ("voice", "Voice", "anthropic/claude-sonnet-4-20250514", "idle", "🎙️"),
            ("troubleshoot", "Troubleshoot", "anthropic/claude-sonnet-4-20250514", "idle", "🔍"),
        ]
        conn.executemany(
            "INSERT INTO agents (name, display_name, model, status, emoji) VALUES (?,?,?,?,?)",
            agents
        )
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
    # Status history from activity feed
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
            # Calculate duration
            from datetime import datetime as dt
            try:
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
def list_agents():
    conn = get_db()
    rows = conn.execute("SELECT * FROM agents ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]

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

# ── Webhook (OpenClaw integration) ─────────────────────────────
@app.post("/api/webhook/openclaw")
def openclaw_webhook(event: WebhookEvent):
    conn = get_db()
    if event.action == "start":
        tid = event.runId[:8] if event.runId else str(uuid.uuid4())[:8]
        ts = now_iso()
        # Check if task exists
        existing = conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone()
        if not existing:
            title = event.prompt[:100] if event.prompt else f"Agent run {tid}"
            if event.source:
                title = f"[{event.source}] {title}"
            conn.execute(
                "INSERT INTO tasks (id, title, description, assigned_agent, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (tid, title, event.prompt or "", event.agent, "medium", "in_progress", ts, ts)
            )
        # Update agent status
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3335, reload=True)
