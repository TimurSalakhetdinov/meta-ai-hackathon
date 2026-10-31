"""Bug hunts: stuck is evidence (no early end), and the bug report is saved."""

import asyncio
import json

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.bug_report import build_bug_report, save_bug_report
from backend.bot_runner import BotRunner, SessionSpec


class _Page:
    async def evaluate(self, _js):
        return {"step_id": "onb_01_shelter", "achieved": False, "sim_elapsed_sec": 30.0}


class _Resp:
    def json(self):
        return {"summary": {"stuck_abort": True}}


class _Http:
    async def get(self, _url):
        return _Resp()


def test_full_window_hunt_does_not_end_on_stuck(tmp_path):
    runner = BotRunner("http://x", client=None, personas={}, runs_dir=tmp_path)
    spec = SessionSpec(variant="A", seed=42, persona_id="p", run_id="r1", run_type="full_window")
    assert asyncio.run(runner._stop_reason(_Page(), _Http(), spec)) is None
    spec_onb = SessionSpec(variant="A", seed=42, persona_id="p", run_id="r1", run_type="onboarding")
    assert asyncio.run(runner._stop_reason(_Page(), _Http(), spec_onb)) == "stuck_abort"
    # The menu play time is a real limit: 30 sim-seconds in, a 10-second
    # budget is spent, a 10-minute budget is not.
    spec_short = SessionSpec(variant="A", seed=42, persona_id="p", run_id="r1",
                             run_type="full_window", time_limit_sim_sec=10)
    assert asyncio.run(runner._stop_reason(_Page(), _Http(), spec_short)) == "time_limit"
    spec_long = SessionSpec(variant="A", seed=42, persona_id="p", run_id="r1",
                            run_type="full_window", time_limit_sim_sec=600)
    assert asyncio.run(runner._stop_reason(_Page(), _Http(), spec_long)) is None


def test_bug_report_saved_next_to_run(configs_dir, runs_dir):
    d = runs_dir / "run_bug1"
    d.mkdir(parents=True)
    (d / "summary.json").write_text(json.dumps(
        {"persona_id": "impatient_newcomer", "where_stuck": "onb_01_shelter",
         "stuck_events": 3, "session_ended": True}))
    (d / "analysis.json").write_text(json.dumps(
        {"where_stuck": "onb_01_shelter", "stuck_frame": "stuck_frame.png",
         "diagnosis": "Players stall at onb_01_shelter.",
         "hypotheses": [{"id": "H1", "confidence": 0.5, "evidence": "e"}],
         "playtester_quotes": [{"thought": "t", "bot_step_index": 1}]}))
    (d / "events.jsonl").write_text("{}\n")

    report = save_bug_report(runs_dir, "run_bug1")
    assert report["status"] == "Finished"
    assert report["diagnosis"].startswith("Players stall")
    assert report["proposed_fixes"][0]["hypothesis_only"] is True
    assert (d / "bug_report.json").exists()
    assert build_bug_report(runs_dir, "run_bug1")["run_id"] == "run_bug1"

    client = TestClient(create_app(configs_dir, runs_dir))
    r = client.get("/api/runs/run_bug1/bug-report")
    assert r.status_code == 200, r.text
    assert r.json()["run_id"] == "run_bug1"
    assert client.get("/api/runs/nope/bug-report").status_code in (400, 404)


def test_analyze_endpoint_writes_report(configs_dir, runs_dir):
    """Opening a finished hunt's Report asks the analyst once and saves both
    the analysis-backed diagnosis and the bug report for the run."""
    app = create_app(configs_dir, runs_dir)
    calls = {}

    def fake_analyze(run_id):
        calls["run_id"] = run_id
        (runs_dir / run_id / "analysis.json").write_text(json.dumps(
            {"run_id": run_id, "where_stuck": "onb_02_forager",
             "diagnosis": "Meta-written diagnosis.", "hypotheses": [],
             "playtester_quotes": []}))
        return {"run_id": run_id, "diagnosis": "Meta-written diagnosis."}

    app.state.analyze_fn = fake_analyze
    client = TestClient(app)
    d = runs_dir / "run_bug1"  # created by the saved-report test data shape
    d.mkdir(parents=True, exist_ok=True)
    (d / "events.jsonl").write_text("{}\n")
    r = client.post("/api/runs/run_bug1/analyze")
    assert r.status_code == 200, r.text
    assert calls["run_id"] == "run_bug1"
    assert r.json()["diagnosis"] == "Meta-written diagnosis."
    assert client.get("/api/runs/run_bug1/bug-report").json()["diagnosis"] == "Meta-written diagnosis."


def test_live_summary_exists_before_session_end(configs_dir, runs_dir):
    """The Studio may only open the Report on session end: /live returns a
    summary dict from the first event on, with session_ended still false."""
    client = TestClient(create_app(configs_dir, runs_dir))
    base = {"run_id": "run_live1", "variant_id": "A", "seed": 42, "step_id": "onb_01_shelter"}
    assert client.post("/api/events", json=[
        {**base, "event_type": "session_start", "sim_elapsed_sec": 0.0},
        {**base, "event_type": "step_enter", "sim_elapsed_sec": 0.0},
    ]).status_code == 200
    live = client.get("/api/runs/run_live1/live").json()
    assert live["summary"] is not None
    assert live["summary"]["session_ended"] is False
    assert client.post("/api/events", json=[
        {**base, "event_type": "session_end", "sim_elapsed_sec": 9.0},
    ]).status_code == 200
    live = client.get("/api/runs/run_live1/live").json()
    assert live["summary"]["session_ended"] is True
