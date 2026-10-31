"""Saved experiments: frozen plans, human decisions, fixed-sample verdicts."""

from fastapi.testclient import TestClient

from backend.agents.experiment import phase_verdict
from backend.app import create_app
from backend.studio_store import StudioStore


def test_phase_verdict_rules():
    # Short sample never produces a winner.
    v = phase_verdict([False], [True], planned_pairs=10)
    assert v["verdict"] == "incomplete"
    # Complete sample, B-only wins in every discordant pair: better.
    v = phase_verdict([False] * 10, [True] * 10, planned_pairs=10)
    assert v["verdict"] == "better" and v["n01_b_only"] == 10
    # Complete sample, no difference: inconclusive, not "equal".
    v = phase_verdict([True] * 10, [True] * 10, planned_pairs=10)
    assert v["verdict"] == "inconclusive"
    # Confirmed B-only critical regression: worse even with a small sample effect.
    v = phase_verdict([True] * 10, [True] * 10, planned_pairs=10, critical_b_regression=True)
    assert v["verdict"] == "worse"


def test_studio_store_roundtrip(tmp_path):
    store = StudioStore(tmp_path / "studio.sqlite")
    patch = store.save_patch("patch_x", {"a": 1}, idea="idea")
    assert patch["revision"] == 1
    exp = store.create_experiment(patch_id="patch_x", patch_revision=1, title="T",
                                  plan={"primary_metric": "onboarding_completed"})
    assert exp["status"] == "draft" and exp["plan_hash"]
    dec = store.add_decision(exp["experiment_id"], kind="approve_test")
    assert dec["kind"] == "approve_test"
    assert store.get_experiment(exp["experiment_id"])["status"] == "approved"
    phase = store.create_phase(exp["experiment_id"], kind="smoke", plan={}, planned_pairs=1)
    pair_id = store.add_pair(phase["phase_id"], persona_id="p1", game_seed=42)
    store.link_run(pair_id, "run_a", "A")
    runs = store.phase_runs(phase["phase_id"])
    assert runs[0]["run_id"] == "run_a" and runs[0]["variant"] == "A"
    store.close()


def test_experiment_endpoints(configs_dir, runs_dir):
    client = TestClient(create_app(configs_dir, runs_dir))
    r = client.post("/api/experiments", json={
        "patch_id": "patch_001", "title": "Faster start",
        "plan": {"primary_metric": "onboarding_completed", "improvement_threshold": 0.1}})
    assert r.status_code == 201, r.text
    exp = r.json()
    assert exp["status"] == "draft"

    r = client.post(f"/api/experiments/{exp['experiment_id']}/decisions",
                    json={"kind": "approve_test", "reason": "ok"})
    assert r.status_code == 201, r.text
    assert client.get(f"/api/experiments/{exp['experiment_id']}").json()["status"] == "approved"

    r = client.post(f"/api/experiments/{exp['experiment_id']}/phases", json={
        "kind": "smoke", "planned_pairs": 2,
        "pairs": [{"persona_id": "impatient_newcomer", "game_seed": 42}]})
    assert r.status_code == 201, r.text

    rep = client.get(f"/api/experiments/{exp['experiment_id']}/report").json()
    assert rep["verdict"]["verdict"] == "incomplete"
    assert rep["verdict"]["planned_pairs"] == 2
    listed = client.get("/api/experiments").json()
    assert listed[0]["experiment_id"] == exp["experiment_id"]
