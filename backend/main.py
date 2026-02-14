"""Mission Control — FastAPI Backend (Phase 3 + Live Data)"""
import os, json, time, uuid, sqlite3, glob, httpx, re
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
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
                    "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
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
SYSTEM_STATS_FILE = "/data/system_stats.json"

@app.get("/api/system")
def get_system_stats():
    try:
        with open(SYSTEM_STATS_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        raise HTTPException(503, "System stats not available")

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
        # Consider active if updated in last 5 minutes
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
    agent_names = {
        "main": {"display": "Mike", "emoji": "🎯", "default_model": "claude-opus-4-6"},
        "dev": {"display": "Dev", "emoji": "💻", "default_model": "claude-opus-4-6"},
        "trading": {"display": "Trading / AA", "emoji": "📈", "default_model": "claude-opus-4-6"},
        "it-support": {"display": "IT Support", "emoji": "🔧", "default_model": "claude-sonnet-4-20250514"},
        "voice": {"display": "Voice", "emoji": "🎙️", "default_model": "claude-sonnet-4-20250514"},
        "troubleshoot": {"display": "Troubleshoot", "emoji": "🔍", "default_model": "claude-opus-4-6"},
    }
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
        })
    return result


@app.get("/api/live-tasks")
def get_live_tasks():
    """Extract real tasks from agent session files for the kanban board."""
    agents_dir = os.path.join(OPENCLAW_HOME, "agents")
    tasks_list = []
    now_ms = int(time.time() * 1000)

    for agent_name in os.listdir(agents_dir):
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

            # Determine status
            age_ms = now_ms - updated_at
            is_active = age_ms < 60_000

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
                                                title = c["text"][:300]
                                                break
                                    elif isinstance(content, str):
                                        title = content[:300]
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

            if not title:
                continue

            # Clean up title: remove [cron:...] and [date] prefixes, take first line
            clean_title = re.sub(r'\[cron:[^\]]+\]\s*', '', title)
            clean_title = re.sub(r'\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*', '', clean_title)
            clean_title = clean_title.split('\n')[0][:150]

            # Determine kanban status
            # Check for deleted sessions (completed)
            if is_active:
                status = "in_progress"
            elif age_ms < 300_000:  # last 5 min
                status = "review"  # recently finished, needs review
            else:
                status = "done"

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

            tasks_list.append({
                "id": f"live-{sid[:8]}",
                "title": clean_title,
                "assigned_agent": agent_name,
                "status": status,
                "priority": "medium",
                "source": source,
                "session_key": session_key,
                "tokens": total_tokens,
                "cost": round(cost, 4),
                "model": model,
                "created_at": started_at,
                "updated_at": datetime.fromtimestamp(updated_at / 1000, tz=timezone.utc).isoformat() if updated_at else "",
                "duration": duration,
                "is_live": True,
            })

    # Sort: active first, then by updated_at desc
    tasks_list.sort(key=lambda t: (0 if t["status"] == "in_progress" else 1, -(t.get("duration") or 0)))
    return tasks_list


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

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/{full_path:path}")
def spa_catch_all(full_path: str):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=3335, reload=True)
