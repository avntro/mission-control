"""Mission Control — FastAPI Backend (Phase 3 + Live Data)"""
import os, json, time, uuid, sqlite3, glob, httpx, re
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
import asyncio

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
    model: str = ""
    cost: float = 0
    tokens: int = 0

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    assigned_agent: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    model: Optional[str] = None
    cost: Optional[float] = None
    tokens: Optional[int] = None

class CommentCreate(BaseModel):
    task_id: str
    agent: str = ""
    content: str = ""
    type: str = "comment"

class AttachmentCreate(BaseModel):
    task_id: str
    filename: str
    mime_type: str = "image/png"
    url: str = ""
    thumbnail_url: str = ""
    size_bytes: int = 0
    uploaded_by: str = ""

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

class ReportCreate(BaseModel):
    title: str
    date: str = ""
    author: str = ""
    source_url: str = ""
    source_type: str = "manual"  # youtube/article/manual
    tags: List[str] = []
    content: str = ""
    screenshots: List[str] = []

class ReportUpdate(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    author: Optional[str] = None
    source_url: Optional[str] = None
    source_type: Optional[str] = None
    tags: Optional[List[str]] = None
    content: Optional[str] = None
    screenshots: Optional[List[str]] = None

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

AGENT_EMOJI_MAP = {
    "main": "🎯", "trading": "📈", "it-support": "🔧", "dev": "💻",
    "voice": "🎙️", "troubleshoot": "🔍", "docs": "📚", "researcher": "🔬",
    "security": "🛡️",
}

def _sync_agents_from_config(conn):
    """Sync agents table from openclaw.json config — auto-discovers new agents."""
    config_path = os.path.join(OPENCLAW_HOME, "openclaw.json")
    try:
        with open(config_path, "r") as f:
            cfg = json.load(f)
        agent_list = cfg.get("agents", {}).get("list", [])
    except Exception:
        return
    existing = {r[0] for r in conn.execute("SELECT name FROM agents").fetchall()}
    for a in agent_list:
        aid = a.get("id", "")
        if not aid:
            continue
        display = a.get("name", aid)
        desc = a.get("description", "")
        model_raw = a.get("model", "")
        # Extract short model name
        model = model_raw.split("/")[-1] if "/" in model_raw else model_raw
        emoji = AGENT_EMOJI_MAP.get(aid, "🤖")
        if aid not in existing:
            conn.execute(
                "INSERT INTO agents (name, display_name, model, status, emoji) VALUES (?,?,?,?,?)",
                (aid, display, model, "idle", emoji)
            )
        else:
            # Update model from config (source of truth)
            conn.execute("UPDATE agents SET model = ?, display_name = ? WHERE name = ?", (model, display, aid))

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
        duration REAL,
        model TEXT DEFAULT '',
        cost REAL DEFAULT 0,
        tokens INTEGER DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        author TEXT DEFAULT '',
        source_url TEXT DEFAULT '',
        source_type TEXT DEFAULT 'manual',
        tags TEXT DEFAULT '[]',
        content_path TEXT DEFAULT '',
        screenshots TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        agent TEXT DEFAULT '',
        details TEXT DEFAULT '',
        old_value TEXT DEFAULT '',
        new_value TEXT DEFAULT '',
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT DEFAULT 'image/png',
        url TEXT DEFAULT '',
        thumbnail_url TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        uploaded_by TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    """)
    # Migrations — add columns if missing
    for col, typ in [("model", "TEXT DEFAULT ''"), ("cost", "REAL DEFAULT 0"), ("tokens", "INTEGER DEFAULT 0")]:
        try:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {typ}")
        except Exception:
            pass
    conn.commit()
    # Sync agents from OpenClaw config (auto-discover new agents)
    _sync_agents_from_config(conn)
    conn.commit()
    conn.close()

def cleanup_stale_tasks():
    """Move stale in_progress tasks to done if older than 1 hour with no gateway session."""
    conn = get_db()
    stale = conn.execute(
        "SELECT id, created_at, updated_at FROM tasks WHERE status = 'in_progress'"
    ).fetchall()
    now = datetime.now(timezone.utc)
    for row in stale:
        try:
            updated = datetime.fromisoformat(row["updated_at"])
            if (now - updated).total_seconds() > 3600:
                conn.execute(
                    "UPDATE tasks SET status = 'review', completed_at = ?, updated_at = ? WHERE id = ?",
                    (now.isoformat(), now.isoformat(), row["id"])
                )
        except:
            continue
    conn.commit()
    conn.close()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    cleanup_stale_tasks()
    sync_reports_inbox()
    yield

app = FastAPI(title="Mission Control", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["https://pc1.taildb1204.ts.net:8080", "https://pc1.taildb1204.ts.net:3334", "https://pc1.taildb1204.ts.net:8765"], allow_methods=["GET"], allow_headers=["*"])

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def add_activity(conn, agent, action, details="", task_id=None, success=True, duration=None):
    conn.execute(
        "INSERT INTO activity_feed (id, agent, action, details, task_id, success, duration, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (str(uuid.uuid4()), agent, action, details, task_id, 1 if success else 0, duration, now_iso())
    )

# ── GPU Stats ───────────────────────────────────────────────────
GPU_STATS_FILE = "/data/gpu_stats.json"
SYSTEM_STATS_FILE = "/data/system_stats.json"

@app.get("/api/system")
def get_system_stats(response: Response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    try:
        # Re-open file each time to avoid stale Docker mount caches
        fd = os.open(SYSTEM_STATS_FILE, os.O_RDONLY)
        try:
            raw = os.read(fd, 65536).decode("utf-8")
            return json.loads(raw)
        finally:
            os.close(fd)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        raise HTTPException(503, "System stats not available")

@app.get("/api/gpu")
def get_gpu_stats(response: Response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
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
    wheres = ["id NOT LIKE 'live-%'"]  # live-* tasks are served by /api/live-tasks
    if status:
        wheres.append("status = ?")
        params.append(status)
    if agent:
        wheres.append("assigned_agent = ?")
        params.append(agent)
    q += " WHERE " + " AND ".join(wheres)
    q += " ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC"
    rows = conn.execute(q, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/tasks/{task_id}")
def get_task(task_id: str):
    print(f"[get_task] called with task_id={task_id}", flush=True)
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    task = dict(row) if row else None
    print(f"[get_task] db row found: {row is not None}", flush=True)

    # For live-* tasks, merge session data from JSONL (richer than DB stub)
    if task_id.startswith("live-"):
        try:
            live_list = get_live_tasks(agents="all")
            print(f"[get_task] Looking for {task_id} in {len(live_list)} live tasks", flush=True)
            live_match = next((lt for lt in live_list if lt["id"] == task_id), None)
            print(f"[get_task] Match: {live_match is not None}", flush=True)
            if live_match:
                if task is None:
                    task = live_match
                else:
                    # Merge: live data fills in blanks, DB status wins
                    for k in ["title", "description", "assigned_agent", "model", "cost", "tokens", "duration", "created_at", "source", "session_key"]:
                        if live_match.get(k) and not task.get(k):
                            task[k] = live_match[k]
                    task["is_live"] = True
        except Exception as e:
            import traceback
            traceback.print_exc()

    if not task:
        conn.close()
        raise HTTPException(404, "Task not found")

    # Always attach comments, history, attachments (works for both live and DB tasks)
    comments = conn.execute("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    task["comments"] = [dict(c) for c in comments]
    history = conn.execute(
        "SELECT * FROM activity_feed WHERE task_id = ? ORDER BY created_at ASC", (task_id,)
    ).fetchall()
    task["history"] = [dict(h) for h in history]
    attachments = conn.execute("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    task["attachments"] = [dict(a) for a in attachments]
    events = conn.execute("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    task["events"] = [dict(e) for e in events]
    conn.close()
    return task

@app.post("/api/tasks")
def create_task(t: TaskCreate):
    conn = get_db()
    tid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO tasks (id, title, description, assigned_agent, priority, status, model, cost, tokens, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (tid, t.title, t.description, t.assigned_agent, t.priority, t.status, t.model, t.cost, t.tokens, ts, ts)
    )
    add_activity(conn, t.assigned_agent, "task_created", f"Created: {t.title}", tid)
    add_task_event(conn, tid, "created", t.assigned_agent, f"Task created: {t.title}")
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    result = dict(row)
    broadcast_sse("task_created", result)
    conn.close()
    return result

@app.patch("/api/tasks/{task_id}")
def update_task(task_id: str, t: TaskUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row and task_id.startswith("live-"):
        # Create a stub for live tasks so status changes persist
        ts = now_iso()
        conn.execute("INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)",
                     (task_id, task_id, "in_progress", ts, ts))
        conn.commit()
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Task not found")
    old = dict(row)
    updates = {}
    for field in ["title", "description", "assigned_agent", "priority", "status", "model", "cost", "tokens"]:
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
        add_task_event(conn, task_id, "status_change", old["assigned_agent"] or "",
                      f"Status changed: {old['status']} → {updates['status']}", old["status"], updates["status"])
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [task_id]
    conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    result = dict(row)
    broadcast_sse("task_updated", result)
    conn.close()
    return result

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

# ── Attachments ─────────────────────────────────────────────────
@app.get("/api/tasks/{task_id}/attachments")
def list_attachments(task_id: str):
    conn = get_db()
    rows = conn.execute("SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/tasks/{task_id}/attachments")
def add_attachment(task_id: str, a: AttachmentCreate):
    conn = get_db()
    aid = str(uuid.uuid4())[:8]
    conn.execute(
        "INSERT INTO attachments (id, task_id, filename, mime_type, url, thumbnail_url, size_bytes, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (aid, task_id, a.filename, a.mime_type, a.url, a.thumbnail_url or a.url, a.size_bytes, a.uploaded_by, now_iso())
    )
    conn.commit()
    conn.close()
    return {"id": aid}

@app.delete("/api/attachments/{attachment_id}")
def delete_attachment(attachment_id: str):
    conn = get_db()
    conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

# ── Agents ──────────────────────────────────────────────────────
@app.get("/api/agents")
async def list_agents():
    conn = get_db()
    rows = conn.execute("SELECT * FROM agents ORDER BY name").fetchall()
    agents_list = [dict(r) for r in rows]

    # Enrich with live status from agent-stats
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    now_ms = int(time.time() * 1000)
    for agent in agents_list:
        stats = _parse_session_stats(os.path.join(agents_dir, agent["name"]))
        # Agent is BUSY if any session updated in last 5 minutes
        agent_busy = stats["active"]  # _parse_session_stats already uses 5min window
        if not agent_busy:
            # Also check sessions.json directly for any session updated in last 5 min
            sessions_file = os.path.join(agents_dir, agent["name"], "sessions", "sessions.json")
            try:
                with open(sessions_file, "r") as f:
                    sess_data = json.load(f)
                for v in sess_data.values():
                    if (now_ms - v.get("updatedAt", 0)) < 300_000:
                        agent_busy = True
                        break
            except:
                pass
        if agent_busy:
            agent["status"] = "busy"
        else:
            agent["status"] = "idle"
        if stats["model"]:
            agent["model"] = stats["model"]
        # Add last activity from session updatedAt
        sessions_file = os.path.join(agents_dir, agent["name"], "sessions", "sessions.json")
        try:
            with open(sessions_file, "r") as f:
                sess_data = json.load(f)
            max_updated = max((v.get("updatedAt", 0) for v in sess_data.values()), default=0)
            if max_updated:
                agent["last_activity"] = datetime.fromtimestamp(max_updated / 1000, tz=timezone.utc).isoformat()
        except:
            pass

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

# ── Activity Feed (merged: DB + real sessions) ──────────────────
@app.get("/api/activity")
def list_activity(agent: Optional[str] = None, limit: int = 50):
    # Get DB activity
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
    db_items = [dict(r) for r in rows]

    # Merge with real overnight log entries (which come from sessions)
    # This ensures the activity feed shows real data even without webhooks
    try:
        real_entries = get_overnight_log_internal(agent)
        for entry in real_entries:
            db_items.append({
                "id": entry["id"],
                "agent": entry["agent"],
                "action": entry["tag"],
                "details": entry["description"],
                "task_id": None,
                "success": entry["success"],
                "duration": None,
                "created_at": entry["time"],
                "source": entry.get("source", "live"),
            })
    except:
        pass

    # Deduplicate by id and sort
    seen = set()
    unique = []
    for item in db_items:
        if item["id"] not in seen:
            seen.add(item["id"])
            unique.append(item)
    unique.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return unique[:limit]

def get_overnight_log_internal(agent_filter=None):
    """Internal helper for overnight log - reused by activity feed."""
    entries = []
    # Subagent runs
    try:
        with open(SUBAGENT_RUNS_FILE, "r") as f:
            data = json.load(f)
        runs = data.get("runs", {})
        for rid, r in runs.items():
            task = r.get("task", "")[:200]
            session_key = r.get("childSessionKey", "")
            agent_name = session_key.split(":")[1] if ":" in session_key else ""
            if agent_filter and agent_name != agent_filter:
                continue
            created = r.get("createdAtMs", r.get("startedAtMs", 0))
            entries.append({
                "id": rid[:8],
                "title": f"Subagent Task",
                "description": task.split("\n")[0][:150],
                "agent": agent_name,
                "tag": "subagent_run",
                "time": datetime.fromtimestamp(created / 1000, tz=timezone.utc).isoformat() if created else "",
                "success": 1,
                "source": "subagent",
            })
    except:
        pass
    # Cron runs
    try:
        with open(CRON_JOBS_FILE, "r") as f:
            data = json.load(f)
        for job in data.get("jobs", []):
            agent_name = job.get("agentId", "")
            if agent_filter and agent_name != agent_filter:
                continue
            state = job.get("state", {})
            last_run_ms = state.get("lastRunAtMs")
            if last_run_ms:
                entries.append({
                    "id": job["id"][:8],
                    "title": f"Cron: {job.get('name', 'Unknown')}",
                    "description": f"Status: {state.get('lastStatus', 'unknown')} | Duration: {state.get('lastDurationMs', 0)}ms",
                    "agent": agent_name,
                    "tag": "cron_run",
                    "time": datetime.fromtimestamp(last_run_ms / 1000, tz=timezone.utc).isoformat(),
                    "success": 1 if state.get("lastStatus") == "ok" else 0,
                    "source": "cron",
                })
    except:
        pass
    entries.sort(key=lambda e: e.get("time", ""), reverse=True)
    return entries[:30]

# ── Scheduled Tasks (REAL from OpenClaw cron store) ─────────────
CRON_JOBS_FILE = os.path.join(OPENCLAW_HOME, "cron", "jobs.json")

def _humanize_schedule(sched: dict) -> str:
    kind = sched.get("kind", "")
    if kind == "cron":
        expr = sched.get("expr", "")
        tz = sched.get("tz", "UTC")
        return f"Cron: {expr} ({tz})"
    elif kind == "at":
        at = sched.get("at", "")
        try:
            dt = datetime.fromisoformat(at.replace("Z", "+00:00"))
            return f"One-time: {dt.strftime('%b %d, %Y %H:%M')}"
        except:
            return f"At: {at}"
    elif kind == "every":
        ms = sched.get("everyMs", 0)
        if ms >= 3600000:
            return f"Every {ms // 3600000}h"
        elif ms >= 60000:
            return f"Every {ms // 60000}m"
        return f"Every {ms}ms"
    return str(sched)

def _classify_schedule(sched: dict) -> str:
    kind = sched.get("kind", "")
    if kind == "cron":
        expr = sched.get("expr", "")
        parts = expr.split()
        # Check if it runs on specific days of week
        if len(parts) >= 5 and parts[4] not in ("*", ""):
            if parts[4] in ("0", "1", "7"):
                return "weekly"
        return "daily"
    elif kind == "at":
        return "one-time"
    elif kind == "every":
        ms = sched.get("everyMs", 0)
        if ms >= 86400000:
            return "weekly"
        return "daily"
    return "daily"

@app.get("/api/scheduled-tasks")
def get_scheduled_tasks():
    try:
        with open(CRON_JOBS_FILE, "r") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

    jobs = data.get("jobs", [])
    result = []
    for job in jobs:
        state = job.get("state", {})
        sched = job.get("schedule", {})
        last_run_ms = state.get("lastRunAtMs")
        last_run = None
        if last_run_ms:
            last_run = datetime.fromtimestamp(last_run_ms / 1000, tz=timezone.utc).isoformat()
        next_run_ms = state.get("nextRunAtMs")
        next_run = None
        if next_run_ms:
            next_run = datetime.fromtimestamp(next_run_ms / 1000, tz=timezone.utc).isoformat()

        # Extract task description from payload
        payload = job.get("payload", {})
        desc = payload.get("message", payload.get("text", ""))[:200]

        result.append({
            "id": job.get("id", ""),
            "title": job.get("name", "Unnamed Job"),
            "description": desc,
            "schedule": sched.get("expr", "") or json.dumps(sched),
            "schedule_human": _humanize_schedule(sched),
            "type": _classify_schedule(sched),
            "status": "active" if job.get("enabled", True) else "disabled",
            "agent": job.get("agentId", ""),
            "last_run": last_run,
            "next_run": next_run,
            "last_status": state.get("lastStatus", "never"),
            "last_duration_ms": state.get("lastDurationMs"),
            "consecutive_errors": state.get("consecutiveErrors", 0),
            "delete_after_run": job.get("deleteAfterRun", False),
            "icon": "⏰",
        })
    return result

# ── Overnight Log (REAL from session files + subagent runs) ─────
SUBAGENT_RUNS_FILE = os.path.join(OPENCLAW_HOME, "subagents", "runs.json")

@app.get("/api/overnight-log")
def get_overnight_log():
    """Return real activity from agent sessions and subagent runs."""
    entries = get_overnight_log_internal()

    # Also add recent interactive sessions
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    for agent_name in os.listdir(agents_dir):
        sessions_file = os.path.join(agents_dir, agent_name, "sessions", "sessions.json")
        if not os.path.exists(sessions_file):
            continue
        try:
            with open(sessions_file, "r") as f:
                sessions_data = json.load(f)
        except:
            continue
        for session_key, sess_info in sessions_data.items():
            sid = sess_info.get("sessionId", "")
            updated_at = sess_info.get("updatedAt", 0)
            if not updated_at or (time.time() * 1000 - updated_at) > 86400000:
                continue
            if ":subagent:" in session_key:
                continue
            if any(x in session_key for x in [":main", ":mobile", ":webchat"]):
                jsonl_path = os.path.join(agents_dir, agent_name, "sessions", f"{sid}.jsonl")
                if not os.path.exists(jsonl_path):
                    continue
                try:
                    msg_count = sum(1 for line in open(jsonl_path, "r") if '"type":"message"' in line)
                    if msg_count > 0:
                        channel = session_key.split(":")[-1]
                        entries.append({
                            "id": sid[:8], "title": f"Session: {agent_name} ({channel})",
                            "description": f"{msg_count} messages exchanged",
                            "agent": agent_name, "tag": "session",
                            "time": datetime.fromtimestamp(updated_at / 1000, tz=timezone.utc).isoformat(),
                            "success": 1, "source": "session",
                        })
                except:
                    continue

    entries.sort(key=lambda e: e.get("time", ""), reverse=True)
    return entries[:30]

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

# ── Task Approve / Reject ───────────────────────────────────────
@app.post("/api/tasks/{task_id}/approve")
def approve_task(task_id: str):
    """Move a task from review to done. Only the user should call this."""
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    ts = now_iso()
    if row:
        conn.execute("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
                     (ts, ts, task_id))
        add_activity(conn, row["assigned_agent"] or "user", "task_approved", f"Approved: {row['title']}", task_id)
    else:
        # For live tasks, create a minimal status marker (not rendered by /api/tasks — filtered by live- prefix)
        conn.execute(
            "INSERT INTO tasks (id, title, status, created_at, updated_at, completed_at) VALUES (?,?,?,?,?,?)",
            (task_id, task_id, "done", ts, ts, ts)
        )
        add_activity(conn, "user", "task_approved", f"Approved: {task_id}", task_id)
    conn.commit()
    conn.close()
    return {"ok": True, "status": "done"}

@app.post("/api/tasks/{task_id}/reject")
def reject_task(task_id: str):
    """Move a task from review back to todo (needs rework). Preserves all session metadata."""
    conn = get_db()
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    ts = now_iso()
    if row:
        conn.execute("UPDATE tasks SET status = 'todo', updated_at = ?, completed_at = NULL WHERE id = ?",
                     (ts, task_id))
        add_activity(conn, row["assigned_agent"] or "user", "task_rejected", f"Rejected: {row['title']}", task_id)
    else:
        # For live tasks, create a minimal status marker (not rendered by /api/tasks — filtered by live- prefix)
        conn.execute(
            "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)",
            (task_id, task_id, "todo", ts, ts)
        )
        add_activity(conn, "user", "task_rejected", f"Rejected: {task_id}", task_id)
    conn.commit()
    conn.close()
    return {"ok": True, "status": "todo"}

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
            conn.execute("UPDATE tasks SET status = 'review', completed_at = ?, updated_at = ?, duration = ? WHERE id = ?",
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

# ── Agent Stats (live from session files) ───────────────────────

MODEL_CONTEXT_LIMITS = {
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-4.5": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-3-5-sonnet": 200_000,
}

def _parse_session_stats(agent_dir: str) -> Dict[str, Any]:
    """Parse session files for an agent to extract token usage and task info."""
    sessions_file = os.path.join(agent_dir, "sessions", "sessions.json")
    if not os.path.exists(sessions_file):
        return {"sessions": [], "total_tokens": 0, "total_cost": 0, "active": False, "model": ""}

    try:
        with open(sessions_file, "r") as f:
            sessions_data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"sessions": [], "total_tokens": 0, "total_cost": 0, "active": False, "model": ""}

    total_tokens = 0
    total_cost = 0.0
    model = ""
    active = False
    session_details = []
    now_ms = int(time.time() * 1000)

    for session_key, sess_info in sessions_data.items():
        sid = sess_info.get("sessionId", "")
        updated_at = sess_info.get("updatedAt", 0)
        # Consider active if updated recently
        # Sub-agents use a shorter window (2 min) — they finish quickly
        if ":subagent:" in session_key:
            is_active = (now_ms - updated_at) < 120_000
        else:
            is_active = (now_ms - updated_at) < 300_000

        # Find the jsonl file
        jsonl_path = os.path.join(agent_dir, "sessions", f"{sid}.jsonl")
        if not os.path.exists(jsonl_path):
            continue

        # Read last few lines to get latest usage
        sess_tokens = 0
        sess_cost = 0.0
        sess_model = ""
        first_user_msg = ""
        try:
            # For token usage, read the last 50 lines (usage accumulates)
            with open(jsonl_path, "rb") as f:
                # Seek to end, read backwards for efficiency
                f.seek(0, 2)
                fsize = f.tell()
                # Read last 100KB max for usage data
                read_size = min(fsize, 100_000)
                f.seek(max(0, fsize - read_size))
                tail = f.read().decode("utf-8", errors="replace")
                lines = tail.strip().split("\n")

                for line in reversed(lines):
                    try:
                        entry = json.loads(line)
                        msg = entry.get("message", {})
                        usage = msg.get("usage", {})
                        if usage and usage.get("totalTokens", 0) > sess_tokens:
                            sess_tokens = usage["totalTokens"]
                            cost_data = usage.get("cost", {})
                            sess_cost = cost_data.get("total", 0) if isinstance(cost_data, dict) else 0
                            sess_model = msg.get("model", "") or entry.get("model", "")
                            break  # Last message with usage has the highest token count
                    except (json.JSONDecodeError, KeyError):
                        continue

                # Get first user message for task description
                f.seek(0)
                for raw_line in f:
                    try:
                        entry = json.loads(raw_line)
                        if entry.get("type") == "message":
                            msg = entry.get("message", {})
                            if msg.get("role") == "user":
                                content = msg.get("content", "")
                                if isinstance(content, list):
                                    for c in content:
                                        if isinstance(c, dict) and c.get("type") == "text":
                                            first_user_msg = c["text"][:200]
                                            break
                                elif isinstance(content, str):
                                    first_user_msg = content[:200]
                                break
                    except (json.JSONDecodeError, KeyError):
                        continue
        except OSError:
            continue

        total_tokens += sess_tokens
        total_cost += sess_cost
        if sess_model:
            model = sess_model
        if is_active:
            active = True

        session_details.append({
            "key": session_key,
            "sessionId": sid[:8],
            "tokens": sess_tokens,
            "cost": round(sess_cost, 4),
            "model": sess_model,
            "active": is_active,
            "updatedAt": updated_at,
            "task": first_user_msg,
        })

    return {
        "sessions": session_details,
        "total_tokens": total_tokens,
        "total_cost": round(total_cost, 4),
        "active": active,
        "model": model,
    }


@app.get("/api/agent-stats")
def get_agent_stats():
    """Return live token usage and status for all agents from session files."""
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    # Dynamic: build agent list from DB (synced from openclaw.json config)
    conn = get_db()
    rows = conn.execute("SELECT name, display_name, emoji, model FROM agents").fetchall()
    conn.close()
    agent_names = {}
    for r in rows:
        agent_names[r[0]] = {"display": r[1], "emoji": r[2], "default_model": r[3] or ""}
    result = []
    for name, info in agent_names.items():
        agent_dir = os.path.join(agents_dir, name)
        if not os.path.isdir(agent_dir):
            continue
        stats = _parse_session_stats(agent_dir)
        # Strip provider prefix for model lookup (e.g. "anthropic/claude-opus-4-6" -> "claude-opus-4-6")
        model_key = stats["model"].split("/")[-1] if stats["model"] else ""
        # Fall back to configured default model if no model detected from sessions
        if not model_key:
            model_key = info.get("default_model", "")
        ctx_limit = MODEL_CONTEXT_LIMITS.get(model_key, 200_000)
        # Get the main session's tokens for context %
        main_session_tokens = 0
        for s in stats["sessions"]:
            if s["key"].endswith(":main") or s["key"] == f"agent:{name}:main":
                main_session_tokens = s["tokens"]
                break
        # If no main session, use the largest active session
        if not main_session_tokens:
            active_sessions = [s for s in stats["sessions"] if s["active"]]
            if active_sessions:
                main_session_tokens = max(s["tokens"] for s in active_sessions)

        result.append({
            "name": name,
            "display_name": info["display"],
            "emoji": info["emoji"],
            "model": stats["model"] or model_key,
            "active": stats["active"],
            "total_tokens": stats["total_tokens"],
            "main_session_tokens": main_session_tokens,
            "context_limit": ctx_limit,
            "context_pct": round(main_session_tokens / ctx_limit * 100, 1) if ctx_limit else 0,
            "total_cost": stats["total_cost"],
            "session_count": len(stats["sessions"]),
            "active_sessions": len([s for s in stats["sessions"] if s["active"]]),
            "subagent_count": len([s for s in stats["sessions"] if ":subagent:" in s["key"]]),
            "active_subagents": len([s for s in stats["sessions"] if ":subagent:" in s["key"] and s["active"]]),
            "sessions": [{
                "key": s["key"],
                "sessionId": s["sessionId"],
                "tokens": s["tokens"],
                "cost": s["cost"],
                "model": s["model"],
                "active": s["active"],
                "updatedAt": s["updatedAt"],
                "task": s["task"],
            } for s in stats["sessions"]],
        })
    return result


@app.get("/api/live-tasks")
def get_live_tasks(agents: str = "dev"):
    """Extract real tasks from agent session files for the kanban board.
    
    Args:
        agents: Comma-separated list of agent names to include. Default: dev.
                 Use 'all' to show all agents.
    """
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    tasks_list = []
    now_ms = int(time.time() * 1000)
    
    # Parse agent filter
    agent_filter = None
    if agents and agents.strip().lower() != "all":
        agent_filter = set(a.strip().lower() for a in agents.split(",") if a.strip())

    for agent_name in os.listdir(agents_dir):
        # Apply agent filter
        if agent_filter and agent_name.lower() not in agent_filter:
            continue
        agent_dir = os.path.join(agents_dir, agent_name)
        sessions_file = os.path.join(agent_dir, "sessions", "sessions.json")
        if not os.path.exists(sessions_file):
            continue
        try:
            with open(sessions_file, "r") as f:
                sessions_data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        for session_key, sess_info in sessions_data.items():
            sid = sess_info.get("sessionId", "")
            updated_at = sess_info.get("updatedAt", 0)
            session_label = sess_info.get("label", "")

            # Skip main/mobile sessions — they're not discrete tasks
            # Focus on subagent, cron, and control sessions
            is_subagent = ":subagent:" in session_key
            is_cron = ":cron:" in session_key and ":run:" in session_key
            is_control = ":control:" in session_key

            if not (is_subagent or is_cron or is_control):
                continue

            jsonl_path = os.path.join(agent_dir, "sessions", f"{sid}.jsonl")
            if not os.path.exists(jsonl_path):
                continue

            # Determine status — use BOTH sessions.json updatedAt AND jsonl file mtime
            # sessions.json updatedAt can be stale while the session is still actively writing
            age_ms = now_ms - updated_at
            try:
                file_mtime_ms = os.path.getmtime(jsonl_path) * 1000
                file_age_ms = now_ms - file_mtime_ms
            except OSError:
                file_age_ms = age_ms
            # Session is active if EITHER indicator shows recent activity (within 2 min)
            is_active = min(age_ms, file_age_ms) < 120_000

            # Read first user message for task title and session start time
            title = ""
            started_at = ""
            total_tokens = 0
            model = ""
            try:
                with open(jsonl_path, "r") as f:
                    for raw_line in f:
                        try:
                            entry = json.loads(raw_line)
                            if entry.get("type") == "session":
                                started_at = entry.get("timestamp", "")
                            if entry.get("type") == "message":
                                msg = entry.get("message", {})
                                if msg.get("role") == "user" and not title:
                                    content = msg.get("content", "")
                                    if isinstance(content, list):
                                        for c in content:
                                            if isinstance(c, dict) and c.get("type") == "text":
                                                title = c["text"][:3000]
                                                break
                                    elif isinstance(content, str):
                                        title = content[:3000]
                        except json.JSONDecodeError:
                            continue
                        if title and started_at:
                            break

                # Get token usage and cost from end of file
                cost = 0.0
                with open(jsonl_path, "rb") as f:
                    f.seek(0, 2)
                    fsize = f.tell()
                    read_size = min(fsize, 50_000)
                    f.seek(max(0, fsize - read_size))
                    tail = f.read().decode("utf-8", errors="replace")
                    for line in reversed(tail.strip().split("\n")):
                        try:
                            entry = json.loads(line)
                            usage = entry.get("message", {}).get("usage", {})
                            if usage and usage.get("totalTokens", 0) > total_tokens:
                                total_tokens = usage["totalTokens"]
                                model = entry.get("message", {}).get("model", "")
                                cost_data = usage.get("cost", {})
                                cost = cost_data.get("total", 0) if isinstance(cost_data, dict) else 0
                                break
                        except (json.JSONDecodeError, KeyError):
                            continue
            except OSError:
                continue

            if not title and not session_label:
                continue

            # Build full description (for modal)
            full_description = title or ""

            # Clean up raw title: remove [cron:...] and [date] prefixes
            raw_title = re.sub(r'\[cron:[^\]]+\]\s*', '', title)
            raw_title = re.sub(r'\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*', '', raw_title).strip()
            # Strip URLs early so they don't pollute any title extraction
            raw_title = re.sub(r'\(?https?://[^\s)]+\)?', '', raw_title).strip()
            # Collapse multiple spaces left by URL removal
            raw_title = re.sub(r'  +', ' ', raw_title)

            # Smart title selection: label > extracted short title > agent name
            def make_smart_title(raw: str, label: str, key: str) -> str:
                """Pick the best short title for a kanban card."""
                # 1. If session has a label, capitalize and use it
                if label:
                    t = label.strip().replace('-', ' ').replace('_', ' ')
                    return t[:60].title() if t == t.lower() else t[:60]

                if not raw:
                    parts = key.split(':')
                    agent = parts[1] if len(parts) > 1 else 'unknown'
                    kind = parts[2] if len(parts) > 2 else 'task'
                    return f"{agent.title()} {kind.title()}"

                # 2. Check first line — if it's short and clean, use it directly
                first_line = raw.split('\n')[0].strip()
                first_line = re.sub(r'\*+', '', first_line).strip()
                first_line = re.sub(r'^(?:CRITICAL|URGENT|PRIORITY|IMPORTANT|MANDATORY|CONTINUOUS IMPROVEMENT|CONTINUE IMPROVING|QUICK FIX|DOWNLOAD(?:\s*&\s*INDEX)?|RAG KNOWLEDGE BASE)(?:\s+(?:BUG|TASK|FIX|ISSUE))?\s*[:\-—–]\s*', '', first_line, flags=re.IGNORECASE).strip()
                # Strip remaining ALL-CAPS prefix words (e.g. "DOWNLOAD additional..." → "Additional...")
                first_line = re.sub(r'^[A-Z]{4,}(?:\s+[A-Z]{3,})*\s*[:\-—–]?\s*', '', first_line).strip()
                # Capitalize first letter if needed
                if first_line and first_line[0].islower():
                    first_line = first_line[0].upper() + first_line[1:]
                first_line = re.sub(r'[\s:,\-]+$', '', first_line).strip()
                if 5 < len(first_line) <= 60:
                    return first_line
                if len(first_line) > 60:
                    return _truncate(first_line)

                # 3. Search for **bold title** anywhere in text (common pattern)
                # Find ALL bold matches, pick the best one (skip short labels like "Issue:" or "Task:")
                bold_matches = re.findall(r'\*\*(.+?)\*\*', raw[:500])
                for candidate in bold_matches:
                    candidate = candidate.strip().rstrip(':')
                    # Strip CRITICAL/URGENT prefixes from bold text too
                    candidate = re.sub(r'^(?:CRITICAL|URGENT|PRIORITY|IMPORTANT|MANDATORY)(?:\s+(?:BUG|TASK|FIX|ISSUE))?\s*:\s*', '', candidate, flags=re.IGNORECASE).strip()
                    # Strip URLs from candidates
                    candidate = re.sub(r'\(?https?://[^\s)]+\)?\s*', '', candidate).strip()
                    candidate = re.sub(r'\s+', ' ', candidate).strip()
                    # Skip generic labels that aren't descriptive
                    if len(candidate) < 8 and candidate.lower() in ('issue', 'task', 'bug', 'fix', 'note', 'todo', 'goal'):
                        # Try combining label with text after **label:** 
                        label_match = re.search(r'\*\*' + re.escape(candidate) + r':?\*\*\s*(.+?)(?:\n|$)', raw[:500])
                        if label_match:
                            after = label_match.group(1).strip()
                            combined = f"{candidate}: {after}"
                            if len(combined) <= 60:
                                return combined
                            return _truncate(combined)
                        continue
                    if 5 < len(candidate) <= 60:
                        return candidate
                    if len(candidate) > 60:
                        return _truncate(candidate)

                # 3. Look for markdown headers
                header_match = re.search(r'^#+\s+(.+)', raw[:500], re.MULTILINE)
                if header_match:
                    candidate = header_match.group(1).strip()
                    if len(candidate) <= 60:
                        return candidate
                    return _truncate(candidate)

                # 4. Take first meaningful line, strip URLs and prefixes
                for line in raw.split('\n')[:5]:
                    line = line.strip()
                    if not line or line.startswith('http') or line.startswith('/'):
                        continue
                    # Strip inline URLs (including parenthesized ones)
                    line = re.sub(r'\(?https?://[^\s)]+\)?', '', line).strip()
                    # Strip leading prefix labels like "CRITICAL:", "BUG:", "PRIORITY:", compound "URGENT BUG:", etc.
                    line = re.sub(r'^(?:CRITICAL|URGENT|PRIORITY|IMPORTANT|MANDATORY|CONTINUOUS IMPROVEMENT|CONTINUE IMPROVING|QUICK FIX|DOWNLOAD(?:\s*&\s*INDEX)?|RAG KNOWLEDGE BASE)(?:\s+(?:BUG|TASK|FIX|ISSUE))?\s*[:\-—–]\s*', '', line, flags=re.IGNORECASE).strip()
                    line = re.sub(r'^(?:BUG|TASK|FIX|AUDIT\s*TASK|TODO|NOTE|ISSUE|ADDITIONAL\s*BUG|ADDITIONAL)\s*:\s*', '', line, flags=re.IGNORECASE).strip()
                    # Strip remaining ALL-CAPS prefix words
                    line = re.sub(r'^[A-Z]{4,}(?:\s+[A-Z]{3,})*\s*[:\-—–]?\s*', '', line).strip()
                    if line and line[0].islower():
                        line = line[0].upper() + line[1:]
                    # Collapse leftover double spaces
                    line = re.sub(r'  +', ' ', line)
                    # Strip markdown emphasis remnants
                    line = re.sub(r'\*+', '', line).strip()
                    # Remove trailing punctuation clusters
                    line = re.sub(r'[\s:,\-]+$', '', line).strip()
                    if not line:
                        continue
                    if len(line) <= 60:
                        return line
                    return _truncate(line)

                return _truncate(raw.split('\n')[0].strip())

            def _truncate(s: str, max_len: int = 57) -> str:
                if len(s) <= max_len + 3:
                    return s
                t = s[:max_len]
                last_space = t.rfind(' ')
                if last_space > 25:
                    return t[:last_space] + '...'
                return t + '...'

            clean_title = make_smart_title(raw_title, session_label, session_key)

            # Determine kanban status
            # Check DB for user-approved tasks (status = 'done')
            db_status = None
            try:
                db_conn = get_db()
                db_row = db_conn.execute("SELECT status FROM tasks WHERE id = ?", (f"live-{sid[:8]}",)).fetchone()
                if db_row:
                    db_status = db_row[0]
                db_conn.close()
            except:
                pass

            if db_status == "done":
                status = "done"  # User explicitly approved
            elif db_status == "todo":
                status = "todo"  # User rejected — sent back to todo
            elif is_active:
                status = "in_progress"
            else:
                status = "review"  # Needs user approval to move to done

            # Duration: parse first and last timestamps from jsonl
            duration = None
            try:
                first_ts = None
                last_ts = None
                with open(jsonl_path, "r") as jf:
                    for jline in jf:
                        try:
                            je = json.loads(jline)
                            ts_str = je.get("timestamp", "")
                            if ts_str:
                                ts_val = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
                                if first_ts is None:
                                    first_ts = ts_val
                                last_ts = ts_val
                        except:
                            continue
                if first_ts and last_ts:
                    if is_active:
                        duration = time.time() - first_ts
                    else:
                        duration = last_ts - first_ts
                    if duration < 0:
                        duration = 0
            except:
                pass

            # Determine source type
            source = "subagent" if is_subagent else "cron" if is_cron else "control"

            updated_iso = datetime.fromtimestamp(updated_at / 1000, tz=timezone.utc).isoformat() if updated_at else ""
            completed_at = updated_iso if status in ("review", "done") else None
            risk = classify_risk(full_description) if status == "review" else {"level": "LOW", "color": "#4caf50", "bg": "rgba(76,175,80,0.15)"}

            tasks_list.append({
                "id": f"live-{sid[:8]}",
                "title": clean_title,
                "description": full_description[:3000],
                "assigned_agent": agent_name,
                "status": status,
                "priority": "medium",
                "source": source,
                "session_key": session_key,
                "tokens": total_tokens,
                "cost": round(cost, 4),
                "model": model,
                "created_at": started_at,
                "updated_at": updated_iso,
                "completed_at": completed_at,
                "duration": duration,
                "is_live": True,
                "risk": risk,
            })

    # Sort: active first, then by updated_at desc
    tasks_list.sort(key=lambda t: (0 if t["status"] == "in_progress" else 1, -(t.get("duration") or 0)))
    return tasks_list


REPORTS_DIR = os.environ.get("REPORTS_DIR", os.path.join(os.path.dirname(__file__), "..", "reports"))
REPORTS_IMAGES_DIR = os.path.join(REPORTS_DIR, "images")
REPORTS_INBOX = os.environ.get("REPORTS_INBOX", "/home/pc1/.openclaw/workspace/reports")


def _parse_frontmatter(content: str):
    """Parse optional YAML frontmatter from markdown content. Returns (metadata_dict, body)."""
    if not content.startswith("---"):
        return {}, content
    end = content.find("---", 3)
    if end == -1:
        return {}, content
    front = content[3:end].strip()
    body = content[end + 3:].lstrip("\n")
    meta = {}
    for line in front.split("\n"):
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if val.startswith("[") and val.endswith("]"):
                # Parse YAML-style list
                val = [v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()]
            elif val.startswith('"') and val.endswith('"'):
                val = val[1:-1]
            meta[key] = val
    return meta, body


def _author_from_filename(filename: str) -> str:
    """Extract author from filename like 'media-agent--claude-plugins.md' → 'Media Agent'."""
    name = os.path.splitext(filename)[0]
    if "--" in name:
        author_part = name.split("--")[0]
        return author_part.replace("-", " ").title()
    return ""


def _tags_from_filename(filename: str) -> list:
    """Auto-generate tags from filename parts."""
    name = os.path.splitext(filename)[0]
    if "--" in name:
        name = name.split("--", 1)[1]
    parts = [p for p in name.split("-") if len(p) > 2 and not p.isdigit()]
    return parts[:5]


def _title_from_content(body: str) -> str:
    """Extract title from first # heading."""
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def sync_reports_inbox():
    """Scan REPORTS_INBOX for .md files, sync new/updated ones into DB."""
    if not os.path.isdir(REPORTS_INBOX):
        return
    conn = get_db()
    # Get existing inbox reports by source path
    existing = {}
    rows = conn.execute("SELECT id, content_path, updated_at FROM reports WHERE source_type = 'inbox'").fetchall()
    for r in rows:
        existing[r["content_path"]] = {"id": r["id"], "updated_at": r["updated_at"]}

    for md_file in glob.glob(os.path.join(REPORTS_INBOX, "*.md")):
        try:
            mtime = datetime.fromtimestamp(os.path.getmtime(md_file), tz=timezone.utc).isoformat()
            with open(md_file, "r", encoding="utf-8", errors="replace") as f:
                raw = f.read()

            meta, body = _parse_frontmatter(raw)
            filename = os.path.basename(md_file)

            title = meta.get("title") or _title_from_content(body) or filename
            author = meta.get("author") or _author_from_filename(filename)
            tags = meta.get("tags") if isinstance(meta.get("tags"), list) else _tags_from_filename(filename)
            date = meta.get("date") or mtime[:10]
            ts = now_iso()

            if md_file in existing:
                # Check if file was modified since last sync
                rec = existing[md_file]
                if mtime > rec["updated_at"]:
                    conn.execute(
                        "UPDATE reports SET title=?, author=?, tags=?, date=?, updated_at=? WHERE id=?",
                        (title, author, json.dumps(tags), date, ts, rec["id"])
                    )
            else:
                rid = str(uuid.uuid4())[:8]
                conn.execute(
                    "INSERT INTO reports (id, title, date, author, source_url, source_type, tags, content_path, screenshots, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, title, date, author, "", "inbox", json.dumps(tags), md_file, "[]", ts, ts)
                )
        except Exception as e:
            print(f"[inbox] Error processing {md_file}: {e}")
    conn.commit()
    conn.close()

# ── Reports CRUD ────────────────────────────────────────────────
@app.post("/api/reports/sync")
def trigger_sync():
    """Manually trigger inbox sync."""
    sync_reports_inbox()
    return {"ok": True}

@app.get("/api/reports")
def list_reports(
    tag: Optional[str] = None,
    author: Optional[str] = None,
    q: Optional[str] = None,
    source_type: Optional[str] = Query(None, alias="from_type"),
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    sort: str = "date_desc",
):
    conn = get_db()
    query = "SELECT * FROM reports"
    params = []
    wheres = []
    if tag:
        wheres.append("tags LIKE ?")
        params.append(f'%"{tag}"%')
    if author:
        wheres.append("author LIKE ?")
        params.append(f"%{author}%")
    if date_from:
        wheres.append("date >= ?")
        params.append(date_from)
    if date_to:
        wheres.append("date <= ?")
        params.append(date_to)
    if q:
        wheres.append("(title LIKE ? OR author LIKE ? OR tags LIKE ?)")
        params.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
    if wheres:
        query += " WHERE " + " AND ".join(wheres)
    if sort == "title":
        query += " ORDER BY title ASC"
    else:
        query += " ORDER BY date DESC, created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["tags"] = json.loads(d.get("tags", "[]"))
        d["screenshots"] = json.loads(d.get("screenshots", "[]"))
        result.append(d)
    return result

@app.get("/api/reports/tags")
def list_report_tags():
    conn = get_db()
    rows = conn.execute("SELECT tags FROM reports").fetchall()
    conn.close()
    all_tags = set()
    for r in rows:
        try:
            tags = json.loads(r["tags"])
            all_tags.update(tags)
        except:
            pass
    return sorted(all_tags)

@app.get("/api/reports/authors")
def list_report_authors():
    conn = get_db()
    rows = conn.execute("SELECT DISTINCT author FROM reports WHERE author != '' ORDER BY author").fetchall()
    conn.close()
    return [r["author"] for r in rows]

@app.get("/api/reports/search")
async def search_reports(q: str = ""):
    """RAG semantic search via localhost:8400"""
    if not q:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"http://localhost:8400/api/search", params={"q": q})
            if resp.status_code == 200:
                return resp.json()
    except:
        pass
    # Fallback to text search
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM reports WHERE title LIKE ? OR author LIKE ? OR tags LIKE ? ORDER BY date DESC",
        (f"%{q}%", f"%{q}%", f"%{q}%")
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["tags"] = json.loads(d.get("tags", "[]"))
        d["screenshots"] = json.loads(d.get("screenshots", "[]"))
        result.append(d)
    return result

@app.get("/api/reports/{report_id}")
def get_report(report_id: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Report not found")
    d = dict(row)
    d["tags"] = json.loads(d.get("tags", "[]"))
    d["screenshots"] = json.loads(d.get("screenshots", "[]"))
    # Read markdown content
    content_path = d.get("content_path", "")
    if content_path and os.path.exists(content_path):
        with open(content_path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read()
        # Strip frontmatter for display
        _, body = _parse_frontmatter(raw)
        d["content"] = body
    else:
        d["content"] = ""
    conn.close()
    return d

@app.post("/api/reports")
def create_report(r: ReportCreate):
    conn = get_db()
    rid = str(uuid.uuid4())[:8]
    ts = now_iso()
    date = r.date or ts[:10]
    # Save markdown file
    slug = re.sub(r'[^a-z0-9]+', '-', r.title.lower()).strip('-')[:60]
    filename = f"{slug}-{rid}.md"
    os.makedirs(REPORTS_DIR, exist_ok=True)
    content_path = os.path.join(REPORTS_DIR, filename)
    with open(content_path, "w", encoding="utf-8") as f:
        f.write(r.content)
    conn.execute(
        "INSERT INTO reports (id, title, date, author, source_url, source_type, tags, content_path, screenshots, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (rid, r.title, date, r.author, r.source_url, r.source_type,
         json.dumps(r.tags), content_path, json.dumps(r.screenshots), ts, ts)
    )
    conn.commit()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (rid,)).fetchone()
    conn.close()
    d = dict(row)
    d["tags"] = json.loads(d.get("tags", "[]"))
    d["screenshots"] = json.loads(d.get("screenshots", "[]"))
    return d

@app.put("/api/reports/{report_id}")
def update_report(report_id: str, r: ReportUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Report not found")
    old = dict(row)
    updates = {"updated_at": now_iso()}
    for field in ["title", "date", "author", "source_url", "source_type"]:
        val = getattr(r, field)
        if val is not None:
            updates[field] = val
    if r.tags is not None:
        updates["tags"] = json.dumps(r.tags)
    if r.screenshots is not None:
        updates["screenshots"] = json.dumps(r.screenshots)
    if r.content is not None:
        content_path = old.get("content_path", "")
        if content_path:
            with open(content_path, "w", encoding="utf-8") as f:
                f.write(r.content)
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    vals = list(updates.values()) + [report_id]
    conn.execute(f"UPDATE reports SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    conn.close()
    d = dict(row)
    d["tags"] = json.loads(d.get("tags", "[]"))
    d["screenshots"] = json.loads(d.get("screenshots", "[]"))
    return d

@app.delete("/api/reports/{report_id}")
def delete_report(report_id: str):
    conn = get_db()
    row = conn.execute("SELECT content_path FROM reports WHERE id = ?", (report_id,)).fetchone()
    if row and row["content_path"] and os.path.exists(row["content_path"]):
        os.remove(row["content_path"])
    conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/api/reports/{report_id}/export")
def export_report(report_id: str, format: str = "md"):
    conn = get_db()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Report not found")
    d = dict(row)
    content_path = d.get("content_path", "")
    content = ""
    if content_path and os.path.exists(content_path):
        with open(content_path, "r", encoding="utf-8") as f:
            raw = f.read()
        _, content = _parse_frontmatter(raw)
    conn.close()
    # Sanitize title for Content-Disposition header (latin-1 safe)
    safe_title = d["title"].encode("ascii", "ignore").decode("ascii").strip() or "report"
    safe_title = safe_title.replace('"', "'")[:80]
    if format == "md":
        return Response(content=content, media_type="text/markdown",
                       headers={"Content-Disposition": f'attachment; filename="{safe_title}.md"'})
    elif format == "pdf":
        import subprocess, tempfile
        # Write md to temp, convert with nano-pdf
        with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        pdf_path = tmp_path.replace(".md", ".pdf")
        try:
            from fpdf import FPDF
            pdf = FPDF()
            pdf.set_auto_page_break(auto=True, margin=15)
            pdf.add_page()
            # Use DejaVu for Unicode support
            dejavu = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
            dejavu_b = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
            if os.path.exists(dejavu):
                pdf.add_font("DejaVu", "", dejavu, uni=True)
                pdf.add_font("DejaVu", "B", dejavu_b, uni=True)
                _fn = "DejaVu"
            else:
                _fn = "Helvetica"
            pdf.set_font(_fn, size=11)
            import re
            def _mc(h, txt):
                """multi_cell wrapper that resets X after each call"""
                pdf.multi_cell(0, h, txt)
                pdf.set_x(pdf.l_margin)
            for line in content.split("\n"):
                stripped = line.strip()
                if stripped.startswith("---"):
                    pdf.ln(4)
                    continue
                if stripped.startswith("|"):
                    # Table row — render as plain text
                    clean = stripped.replace("|", "  ").strip()
                    if clean and not all(c in "-– " for c in clean):
                        _mc(6, clean)
                    continue
                try:
                    if stripped.startswith("### "):
                        pdf.set_font(_fn, "B", 13)
                        _mc(8, stripped[4:])
                        pdf.set_font(_fn, size=11)
                    elif stripped.startswith("## "):
                        pdf.set_font(_fn, "B", 15)
                        _mc(10, stripped[3:])
                        pdf.set_font(_fn, size=11)
                    elif stripped.startswith("# "):
                        pdf.set_font(_fn, "B", 18)
                        _mc(12, stripped[2:])
                        pdf.set_font(_fn, size=11)
                    elif stripped.startswith("- "):
                        clean = re.sub(r'\*\*(.+?)\*\*', r'\1', stripped[2:])
                        _mc(6, "  - " + clean)
                    elif stripped == "":
                        pdf.ln(4)
                    else:
                        clean = re.sub(r'\*\*(.+?)\*\*', r'\1', stripped)
                        clean = re.sub(r'(\S{60})', r'\1 ', clean)
                        _mc(6, clean)
                except Exception:
                    try:
                        _mc(6, stripped.encode("ascii", "replace").decode()[:200])
                    except Exception:
                        pdf.ln(4)
            # --- Embed report screenshots/images ---
            screenshots = json.loads(d.get("screenshots", "[]"))
            if screenshots:
                pdf.add_page()
                pdf.set_font(_fn, "B", 15)
                _mc(10, "Screenshots & Charts")
                pdf.set_font(_fn, size=11)
                pdf.ln(4)
                for img_url in screenshots:
                    # img_url is like /reports/images/filename.jpg
                    img_filename = os.path.basename(img_url)
                    img_path = os.path.join(REPORTS_IMAGES_DIR, img_filename)
                    if not os.path.exists(img_path):
                        continue
                    try:
                        # Check if we need a new page (leave 60mm margin)
                        if pdf.get_y() > pdf.h - 80:
                            pdf.add_page()
                        # Caption
                        caption = img_filename.replace(".jpg", "").replace("_", " ").title()
                        pdf.set_font(_fn, "B", 10)
                        _mc(6, caption)
                        pdf.set_font(_fn, size=11)
                        # Insert image - fit to page width with some margin
                        img_w = pdf.w - pdf.l_margin - pdf.r_margin
                        pdf.image(img_path, x=pdf.l_margin, y=pdf.get_y(), w=img_w)
                        # Move Y down based on image aspect ratio
                        from PIL import Image as PILImage
                        with PILImage.open(img_path) as pimg:
                            iw, ih = pimg.size
                        img_h = img_w * (ih / iw)
                        pdf.set_y(pdf.get_y() + img_h + 6)
                    except Exception:
                        pass  # skip broken images

            pdf_bytes = pdf.output()
            os.unlink(tmp_path)
            return Response(content=bytes(pdf_bytes), media_type="application/pdf",
                           headers={"Content-Disposition": f'attachment; filename="{safe_title}.pdf"'})
        except Exception as e:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise HTTPException(500, f"PDF generation failed: {str(e)}")
    raise HTTPException(400, "Invalid format. Use 'md' or 'pdf'.")

# Serve report images
@app.get("/reports/images/{filename}")
def serve_report_image(filename: str):
    fpath = os.path.join(REPORTS_IMAGES_DIR, filename)
    if not os.path.exists(fpath):
        raise HTTPException(404, "Image not found")
    return FileResponse(fpath)

# ── SSE Event Bus ───────────────────────────────────────────
_sse_clients: list = []

def broadcast_sse(event_type: str, payload: dict):
    """Push event to all connected SSE clients."""
    data = json.dumps({"type": event_type, "payload": payload})
    for q in list(_sse_clients):
        try:
            q.put_nowait(data)
        except:
            pass

async def sse_generator(request: Request):
    q = asyncio.Queue()
    _sse_clients.append(q)
    try:
        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.wait_for(q.get(), timeout=30)
                yield f"data: {data}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        _sse_clients.remove(q)

@app.get("/api/events/stream")
async def sse_stream(request: Request):
    return StreamingResponse(sse_generator(request), media_type="text/event-stream",
                            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# ── Task Events (Activity Timeline) ────────────────────────────
def add_task_event(conn, task_id, event_type, agent="", details="", old_value="", new_value=""):
    eid = str(uuid.uuid4())[:8]
    ts = now_iso()
    conn.execute(
        "INSERT INTO task_events (id, task_id, event_type, agent, details, old_value, new_value, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (eid, task_id, event_type, agent, details, old_value, new_value, ts)
    )
    broadcast_sse("task_event", {"task_id": task_id, "event_type": event_type, "agent": agent, "details": details, "created_at": ts})

@app.get("/api/tasks/{task_id}/events")
def get_task_events(task_id: str):
    conn = get_db()
    rows = conn.execute("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC", (task_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── Risk Classification ─────────────────────────────────────────
def classify_risk(text: str) -> dict:
    """Classify command/text risk level."""
    if not text:
        return {"level": "LOW", "color": "#4caf50", "bg": "rgba(76,175,80,0.15)"}
    t = text.lower()
    high_patterns = ["rm ", "rm -rf", "sudo ", "docker ", "kill ", "chmod ", "mkfs", "drop ", "delete from", "truncate ", "format "]
    medium_patterns = ["npm install", "pip install", "apt ", "brew ", "curl ", "wget ", "git push", "config", "mv ", "cp -r", "chown"]
    for p in high_patterns:
        if p in t:
            return {"level": "HIGH", "color": "#ff5252", "bg": "rgba(255,82,82,0.15)"}
    for p in medium_patterns:
        if p in t:
            return {"level": "MEDIUM", "color": "#ffab40", "bg": "rgba(255,171,64,0.15)"}
    return {"level": "LOW", "color": "#4caf50", "bg": "rgba(76,175,80,0.15)"}

# ── Approval Center (Gateway approvals proxy) ──────────────────
@app.get("/api/approvals")
async def get_approvals():
    """Fetch pending approvals from OpenClaw gateway."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as client:
            headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
            resp = await client.get(f"{GATEWAY_URL}/api/approvals", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                items = data if isinstance(data, list) else data.get("approvals", [])
                # Enrich with risk levels
                for item in items:
                    cmd = item.get("command", item.get("cmd", ""))
                    item["risk"] = classify_risk(cmd)
                return {"approvals": items}
    except Exception:
        pass
    return {"approvals": []}

@app.post("/api/approvals/{approval_id}/resolve")
async def resolve_approval(approval_id: str, body: dict):
    """Forward approval decision to gateway."""
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as client:
            headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
            resp = await client.post(f"{GATEWAY_URL}/api/approvals/{approval_id}/resolve",
                                     headers=headers, json=body)
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        pass
    raise HTTPException(502, "Failed to resolve approval")

# ── Cost Dashboard ──────────────────────────────────────────────
@app.get("/api/cost-dashboard")
def get_cost_dashboard():
    """Aggregate token/cost data per agent from session files."""
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    result = {"agents": [], "total_tokens": 0, "total_cost": 0.0, "daily": []}
    daily_buckets = {}
    
    for agent_name in os.listdir(agents_dir):
        agent_dir = os.path.join(agents_dir, agent_name)
        sessions_file = os.path.join(agent_dir, "sessions", "sessions.json")
        if not os.path.exists(sessions_file):
            continue
        try:
            with open(sessions_file, "r") as f:
                sessions_data = json.load(f)
        except:
            continue
        
        agent_tokens = 0
        agent_cost = 0.0
        agent_sessions = 0
        
        for session_key, sess_info in sessions_data.items():
            sid = sess_info.get("sessionId", "")
            jsonl_path = os.path.join(agent_dir, "sessions", f"{sid}.jsonl")
            if not os.path.exists(jsonl_path):
                continue
            agent_sessions += 1
            sess_tokens = 0
            sess_cost = 0.0
            sess_date = ""
            try:
                with open(jsonl_path, "rb") as f:
                    f.seek(0, 2)
                    fsize = f.tell()
                    read_size = min(fsize, 50_000)
                    f.seek(max(0, fsize - read_size))
                    tail = f.read().decode("utf-8", errors="replace")
                    for line in reversed(tail.strip().split("\n")):
                        try:
                            entry = json.loads(line)
                            usage = entry.get("message", {}).get("usage", {})
                            if usage and usage.get("totalTokens", 0) > sess_tokens:
                                sess_tokens = usage["totalTokens"]
                                cost_data = usage.get("cost", {})
                                sess_cost = cost_data.get("total", 0) if isinstance(cost_data, dict) else 0
                                break
                        except:
                            continue
                # Get session date from first line
                with open(jsonl_path, "r") as f:
                    first = f.readline()
                    try:
                        entry = json.loads(first)
                        ts = entry.get("timestamp", "")
                        if ts:
                            sess_date = ts[:10]
                    except:
                        pass
            except:
                continue
            
            agent_tokens += sess_tokens
            agent_cost += sess_cost
            if sess_date:
                if sess_date not in daily_buckets:
                    daily_buckets[sess_date] = {"date": sess_date, "tokens": 0, "cost": 0.0, "agents": {}}
                daily_buckets[sess_date]["tokens"] += sess_tokens
                daily_buckets[sess_date]["cost"] += sess_cost
                daily_buckets[sess_date]["agents"][agent_name] = daily_buckets[sess_date]["agents"].get(agent_name, 0) + sess_tokens
        
        if agent_tokens > 0 or agent_sessions > 0:
            # Get agent display info
            conn = get_db()
            row = conn.execute("SELECT display_name, emoji FROM agents WHERE name = ?", (agent_name,)).fetchone()
            conn.close()
            result["agents"].append({
                "name": agent_name,
                "display_name": row["display_name"] if row else agent_name,
                "emoji": row["emoji"] if row else "🤖",
                "tokens": agent_tokens,
                "cost": round(agent_cost, 4),
                "sessions": agent_sessions,
            })
            result["total_tokens"] += agent_tokens
            result["total_cost"] += agent_cost
    
    result["total_cost"] = round(result["total_cost"], 4)
    result["daily"] = sorted(daily_buckets.values(), key=lambda x: x["date"], reverse=True)[:30]
    result["agents"].sort(key=lambda x: x["tokens"], reverse=True)
    return result

# ── Chat with Agents ────────────────────────────────────────────
class ChatMessage(BaseModel):
    message: str
    agent: str = "main"
    session_key: str = ""

@app.post("/api/chat/send")
async def chat_send(msg: ChatMessage):
    """Send a message to an agent via OpenClaw chat completions API."""
    session_key = msg.session_key or f"mission-control:chat:{msg.agent}"
    try:
        async with httpx.AsyncClient(verify=False, timeout=120) as client:
            headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}
            resp = await client.post(f"{GATEWAY_URL}/v1/chat/completions", headers=headers, json={
                "model": msg.agent,
                "messages": [{"role": "user", "content": msg.message}],
                "stream": False,
                "metadata": {"sessionKey": session_key}
            })
            if resp.status_code == 200:
                data = resp.json()
                content = ""
                if "choices" in data and data["choices"]:
                    content = data["choices"][0].get("message", {}).get("content", "")
                return {"response": content, "session_key": session_key}
    except Exception as e:
        raise HTTPException(502, f"Chat failed: {str(e)}")
    raise HTTPException(502, "Chat request failed")

@app.get("/api/chat/history")
async def chat_history(session_key: str = "", agent: str = "main", limit: int = 50):
    """Get chat history from session file."""
    sk = session_key or f"mission-control:chat:{agent}"
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    agent_dir = os.path.join(agents_dir, agent)
    sessions_file = os.path.join(agent_dir, "sessions", "sessions.json")
    messages = []
    if not os.path.exists(sessions_file):
        return {"messages": messages}
    try:
        with open(sessions_file, "r") as f:
            sessions_data = json.load(f)
        sess_info = sessions_data.get(sk)
        if not sess_info:
            return {"messages": messages}
        sid = sess_info.get("sessionId", "")
        jsonl_path = os.path.join(agent_dir, "sessions", f"{sid}.jsonl")
        if not os.path.exists(jsonl_path):
            return {"messages": messages}
        with open(jsonl_path, "r") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if entry.get("type") == "message":
                        msg = entry.get("message", {})
                        role = msg.get("role", "")
                        if role in ("user", "assistant"):
                            content = msg.get("content", "")
                            if isinstance(content, list):
                                text_parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
                                content = "\n".join(text_parts)
                            messages.append({"role": role, "content": content, "timestamp": entry.get("timestamp", "")})
                except:
                    continue
    except:
        pass
    return {"messages": messages[-limit:]}

# ── No-cache middleware for static assets ───────────────────────
class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

app.add_middleware(NoCacheStaticMiddleware)

# ── Static files ────────────────────────────────────────────────
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/manifest.json")
def manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"), media_type="application/manifest+json")

@app.get("/sw.js")
def service_worker():
    from starlette.responses import Response
    sw_path = os.path.join(STATIC_DIR, "sw.js")
    with open(sw_path, "r") as f:
        content = f.read()
    return Response(content=content, media_type="application/javascript", headers={"Service-Worker-Allowed": "/"})

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/{full_path:path}")
def spa_catch_all(full_path: str):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3335, reload=True)
