"""A fresh deploy with an empty runs/ still serves the committed demo runs, read-only."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app

ROOT = Path(__file__).resolve().parents[1]


def test_demo_runs_are_served(configs_dir: Path, runs_dir: Path, monkeypatch) -> None:
    monkeypatch.setenv("GAME_DEMO_RUNS_DIR", str(ROOT / "runs_demo"))
    c = TestClient(create_app(configs_dir, runs_dir))
    ids = {r["run_id"] for r in c.get("/api/runs").json()}
    assert "demo_play_A" in ids
    assert c.get("/api/runs/demo_play_A/live").json()["summary"]["where_stuck"] == "onb_03_handoff"
    analysis = c.get("/api/runs/demo_play_A/analysis").json()
    frame = c.get(analysis["stuck_frame_url"])
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/png"
    assert c.get("/api/runs/demo_play_A/artifacts/../../configs/game_config.json").status_code == 404
    assert c.get("/api/ab_summary").json()["experiment_id"] == "demo_ab"
    assert c.get("/api/runs/no_such_run/live").status_code == 404
