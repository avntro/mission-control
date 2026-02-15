"""Test Reports API endpoints."""
import pytest
import sys, os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))


@pytest.fixture
def client():
    from main import app
    from fastapi.testclient import TestClient
    return TestClient(app)


class TestReportsAPI:
    def test_create_report(self, client):
        resp = client.post("/api/reports", json={
            "title": "Test Report",
            "content": "# Test\nSome content here",
            "author": "dev",
            "tags": ["testing", "ci"]
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["title"] == "Test Report"
        assert "id" in data

    def test_list_reports(self, client):
        client.post("/api/reports", json={"title": "Report A", "content": "AAA"})
        resp = client.get("/api/reports")
        assert resp.status_code == 200
        data = resp.json()
        # API returns list directly or {reports: [...]}
        assert isinstance(data, (list, dict))

    def test_get_report(self, client):
        create = client.post("/api/reports", json={
            "title": "Detail Report", "content": "Detail"
        })
        rid = create.json()["id"]
        resp = client.get(f"/api/reports/{rid}")
        assert resp.status_code == 200
        assert resp.json()["title"] == "Detail Report"

    def test_update_report(self, client):
        create = client.post("/api/reports", json={
            "title": "Update Me", "content": "Old"
        })
        rid = create.json()["id"]
        resp = client.put(f"/api/reports/{rid}", json={
            "title": "Updated", "content": "New content"
        })
        assert resp.status_code == 200

    def test_delete_report(self, client):
        create = client.post("/api/reports", json={
            "title": "Delete Me", "content": "Bye"
        })
        rid = create.json()["id"]
        resp = client.delete(f"/api/reports/{rid}")
        assert resp.status_code == 200

    def test_list_tags(self, client):
        resp = client.get("/api/reports/tags")
        assert resp.status_code == 200

    def test_list_authors(self, client):
        resp = client.get("/api/reports/authors")
        assert resp.status_code == 200

    def test_export_report_md(self, client):
        create = client.post("/api/reports", json={
            "title": "Export Test", "content": "# Export\nContent"
        })
        rid = create.json()["id"]
        resp = client.get(f"/api/reports/{rid}/export?format=md")
        assert resp.status_code == 200
