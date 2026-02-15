"""Shared fixtures for Mission Control tests."""
import os
import sys
import tempfile

# Set env BEFORE any imports
_tmpdir = tempfile.mkdtemp()
os.environ["MC_DB"] = os.path.join(_tmpdir, "test_mc.db")
os.environ["GATEWAY_URL"] = "https://localhost:18789"
os.environ["GATEWAY_TOKEN"] = "test-token"
os.environ["OPENCLAW_HOME"] = tempfile.mkdtemp()
os.environ["DOCS_PATH"] = tempfile.mkdtemp()

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

# Initialize the database
from main import init_db
init_db()
