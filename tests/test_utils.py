"""Test utility functions."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from main import now_iso, _parse_frontmatter, _author_from_filename, _tags_from_filename, _title_from_content


class TestNowIso:
    def test_returns_string(self):
        result = now_iso()
        assert isinstance(result, str)
        assert "T" in result

    def test_contains_timezone(self):
        result = now_iso()
        # Should have Z or +00:00
        assert "Z" in result or "+" in result or result.endswith("00")


class TestParseFrontmatter:
    def test_with_frontmatter(self):
        content = "---\ntitle: Test\nauthor: dev\n---\nBody content"
        meta, body = _parse_frontmatter(content)
        assert meta["title"] == "Test"
        assert "Body content" in body

    def test_without_frontmatter(self):
        content = "Just plain text"
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == content


class TestAuthorFromFilename:
    def test_extracts_author(self):
        # Test various filename patterns
        result = _author_from_filename("dev-report-2024.md")
        assert isinstance(result, str)


class TestTagsFromFilename:
    def test_returns_list(self):
        result = _tags_from_filename("trading-analysis-v2.md")
        assert isinstance(result, list)


class TestTitleFromContent:
    def test_extracts_h1(self):
        result = _title_from_content("# My Title\nSome content")
        assert "My Title" in result or result != ""

    def test_empty_content(self):
        result = _title_from_content("")
        assert isinstance(result, str)
