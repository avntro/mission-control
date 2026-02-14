# Mission Control — OpenClaw Task Dashboard

A real-time task dashboard and agent monitoring system for OpenClaw multi-agent setups.

## Features
- **Kanban Board** — Drag & drop tasks: Todo → In Progress → Review → Done
- **Agent Overview** — Live status of all 6 agents
- **Activity Feed** — Filterable log of all agent actions
- **Task Details** — Full task view with comments, logs, history
- **Webhook API** — Auto-track OpenClaw agent runs
- **Dark Theme** — Professional command center design

## Quick Start

```bash
docker-compose up -d --build
```

Access at `http://localhost:3335`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/tasks | List tasks (filter: ?status=&agent=) |
| POST | /api/tasks | Create task |
| GET | /api/tasks/:id | Get task with comments/history |
| PATCH | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| GET | /api/agents | List agents |
| PATCH | /api/agents/:name | Update agent status |
| GET | /api/activity | Activity feed (?agent=&limit=) |
| POST | /api/comments | Add comment to task |
| POST | /api/webhook/openclaw | OpenClaw webhook |

## Tech Stack
- **Backend:** Python FastAPI + SQLite
- **Frontend:** Vanilla HTML/CSS/JS
- **Deployment:** Docker Compose
- **Port:** 3335
