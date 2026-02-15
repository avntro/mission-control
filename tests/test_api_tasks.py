"""Test Task API endpoints."""
import pytest
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))


@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    return TestClient(app)


class TestTasksCRUD:
    def test_create_task(self, client):
        resp = client.post("/api/tasks", json={
            "title": "Test Task",
            "description": "Test description",
            "priority": "high"
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Test Task"
        assert "id" in data

    def test_list_tasks(self, client):
        # Create a task first
        client.post("/api/tasks", json={"title": "List Test"})
        resp = client.get("/api/tasks")
        assert resp.status_code == 200
        tasks = resp.json()
        assert isinstance(tasks, list)

    def test_get_task(self, client):
        create_resp = client.post("/api/tasks", json={"title": "Get Test"})
        task_id = create_resp.json()["id"]
        resp = client.get(f"/api/tasks/{task_id}")
        assert resp.status_code == 200
        data = resp.json()
        # API may return {task:...} or flat object
        task = data.get("task", data)
        assert task["title"] == "Get Test"

    def test_get_nonexistent_task(self, client):
        resp = client.get("/api/tasks/nonexistent-id")
        assert resp.status_code == 404

    def test_update_task(self, client):
        create_resp = client.post("/api/tasks", json={"title": "Update Test"})
        task_id = create_resp.json()["id"]
        resp = client.patch(f"/api/tasks/{task_id}", json={"status": "done"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "done"

    def test_delete_task(self, client):
        create_resp = client.post("/api/tasks", json={"title": "Delete Test"})
        task_id = create_resp.json()["id"]
        resp = client.delete(f"/api/tasks/{task_id}")
        assert resp.status_code == 200
        # Verify deleted
        get_resp = client.get(f"/api/tasks/{task_id}")
        assert get_resp.status_code == 404

    def test_filter_tasks_by_status(self, client):
        client.post("/api/tasks", json={"title": "Todo Task", "status": "todo"})
        client.post("/api/tasks", json={"title": "Done Task", "status": "done"})
        resp = client.get("/api/tasks?status=todo")
        assert resp.status_code == 200
        tasks = resp.json()
        for t in tasks:
            assert t["status"] == "todo"


class TestComments:
    def test_create_comment(self, client):
        create_resp = client.post("/api/tasks", json={"title": "Comment Test"})
        task_id = create_resp.json()["id"]
        resp = client.post("/api/comments", json={
            "task_id": task_id,
            "agent": "dev",
            "content": "Test comment",
            "type": "comment"
        })
        assert resp.status_code == 200

    def test_comments_in_task(self, client):
        create_resp = client.post("/api/tasks", json={"title": "Comments Detail"})
        task_id = create_resp.json()["id"]
        client.post("/api/comments", json={
            "task_id": task_id,
            "agent": "dev",
            "content": "My comment"
        })
        resp = client.get(f"/api/tasks/{task_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["comments"]) >= 1
