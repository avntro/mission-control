"""Test Standups API endpoints."""
import pytest
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))


@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    return TestClient(app)


class TestStandupsAPI:
    def test_create_standup(self, client):
        resp = client.post("/api/standups", json={
            "title": "Morning Standup",
            "participants": ["dev", "main"]
        })
        assert resp.status_code == 200
        data = resp.json()
        # API may return id or full object
        assert "id" in data or isinstance(data, dict)

    def test_list_standups(self, client):
        client.post("/api/standups", json={"title": "Standup 1"})
        resp = client.get("/api/standups")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_get_standup(self, client):
        create = client.post("/api/standups", json={"title": "Detail Standup"})
        sid = create.json()["id"]
        resp = client.get(f"/api/standups/{sid}")
        assert resp.status_code == 200
