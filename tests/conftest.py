import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def configs_dir(tmp_path: Path) -> Path:
    """A private copy of configs/ so tests never touch the repo's audit log."""
    dst = tmp_path / "configs"
    shutil.copytree(ROOT / "configs", dst, ignore=shutil.ignore_patterns("audit_log.jsonl"))
    return dst


@pytest.fixture
def runs_dir(tmp_path: Path) -> Path:
    return tmp_path / "runs"


@pytest.fixture
def client(configs_dir: Path, runs_dir: Path) -> TestClient:
    return TestClient(create_app(configs_dir, runs_dir))
