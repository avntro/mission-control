"""Test Agent API endpoints."""
import pytest
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))


@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    return TestClient(app)


class TestAgentsAPI:
    def test_list_agents(self, client):
        resp = client.get("/api/agents")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_update_agent(self, client):
        # First get agents to find a name
        agents = client.get("/api/agents").json()
        if agents:
            name = agents[0]["name"]
            resp = client.patch(f"/api/agents/{name}", json={
                "status": "busy",
                "current_task": "Testing"
            })
            assert resp.status_code == 200


class TestActivityAPI:
    def test_list_activity(self, client):
        resp = client.get("/api/activity")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_activity_with_limit(self, client):
        resp = client.get("/api/activity?limit=5")
        assert resp.status_code == 200
