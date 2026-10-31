"""Bug hunting menu: the Meta bot starts from the browser and its run is saved for analysis."""
import json
import time

from fastapi.testclient import TestClient

from backend.app import create_app


def _wait_done(client, job_id):
    for _ in range(100):
        job = client.get(f"/api/bot_hunt/{job_id}").json()
        if job["status"] in ("done", "failed"):
            return job
        time.sleep(0.05)
    raise AssertionError("bot hunt job never finished")


def test_meta_bot_hunt_runs_from_menu_and_saves_run(configs_dir, runs_dir):
    app = create_app(configs_dir, runs_dir)
    calls = {}

    def fake_hunt(spec):
        calls["spec"] = spec
        d = runs_dir / spec["run_id"]
        (d / "frames").mkdir(parents=True)
        (d / "frames" / "step_000.png").write_bytes(b"png")
        (d / "events.jsonl").write_text('{"run_id": "%s"}\n' % spec["run_id"])
        (d / "bot_steps.jsonl").write_text('{"run_id": "%s", "thought": "t"}\n' % spec["run_id"])
        return {"stop_reason": "stuck_abort", "steps": 3, "cost_usd": 0.01,
                "error": None, "summary": {"where_stuck": "onb_03_handoff", "stuck_events": 1}}

    def fake_analyze(run_id):
        calls["analyzed"] = run_id
        (runs_dir / run_id / "analysis.json").write_text(json.dumps({"where_stuck": "onb_03_handoff"}))
        return {"where_stuck": "onb_03_handoff"}

    app.state.bot_hunt_fn = fake_hunt
    app.state.bot_hunt_analyze_fn = fake_analyze
    client = TestClient(app)

    r = client.post("/api/bot_hunt", json={"persona": "impatient_newcomer", "variant": "A",
                                           "seed": 42, "speed": 4, "play_minutes": 5,
                                           "record_video": False, "mode": "meta"})
    assert r.status_code == 202, r.text
    job = _wait_done(client, r.json()["job_id"])
    assert job["status"] == "done", job
    assert job["run_id"].startswith("meta_impatient_newcomer_s42")
    assert calls["spec"]["persona_id"] == "impatient_newcomer"
    assert calls["analyzed"] == job["run_id"]

    saved = json.loads((runs_dir / job["run_id"] / "bot_result.json").read_text())
    assert saved["stop_reason"] == "stuck_abort"
    assert saved["summary"]["where_stuck"] == "onb_03_handoff"
    analysis = client.get(f"/api/runs/{job['run_id']}/analysis")
    assert analysis.status_code == 200, analysis.text
