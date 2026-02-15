"""Test Pydantic models."""
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))


from main import TaskCreate, TaskUpdate, CommentCreate, ReportCreate, WebhookEvent


class TestTaskCreate:
    def test_minimal(self):
        t = TaskCreate(title="Test")
        assert t.title == "Test"
        assert t.priority == "medium"
        assert t.status == "todo"
        assert t.cost == 0

    def test_full(self):
        t = TaskCreate(
            title="Full Task",
            description="desc",
            assigned_agent="dev",
            priority="high",
            status="in_progress",
            model="claude-4",
            cost=0.05,
            tokens=1000
        )
        assert t.assigned_agent == "dev"
        assert t.tokens == 1000

    def test_missing_title_raises(self):
        with pytest.raises(Exception):
            TaskCreate()


class TestTaskUpdate:
    def test_all_optional(self):
        t = TaskUpdate()
        assert t.title is None
        assert t.status is None

    def test_partial(self):
        t = TaskUpdate(status="done", priority="low")
        assert t.status == "done"
        assert t.title is None


class TestCommentCreate:
    def test_defaults(self):
        c = CommentCreate(task_id="abc")
        assert c.task_id == "abc"
        assert c.type == "comment"


class TestReportCreate:
    def test_defaults(self):
        r = ReportCreate(title="Report 1")
        assert r.source_type == "manual"
        assert r.tags == []
        assert r.screenshots == []


class TestWebhookEvent:
    def test_defaults(self):
        w = WebhookEvent()
        assert w.runId == ""
        assert w.duration is None
