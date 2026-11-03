"""Browser-driven A/B playtest: the visitor's tab plays A then B; the server pairs the saved runs."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

PROMPT = "Add a Raider Ambush button at tutorial step 2 that costs wood and rewards score"


def _approve(configs_dir: Path, pid: str, client: TestClient) -> None:
    r = client.post(f"/api/patches/{pid}/approve")
    assert r.status_code == 200, r.text


def test_external_playtest_pairs_browser_sessions(client: TestClient, configs_dir: Path,
                                                  runs_dir: Path) -> None:
    _approve(configs_dir, "patch_001", client)
    pid = client.post("/api/feature_studio/propose",
                      json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    _approve(configs_dir, pid, client)

    job = client.post("/api/feature_studio/playtest_external",
                      json={"patch_id": pid, "personas": ["impatient_newcomer"],
                            "seeds": [42]}).json()
    sessions = job["sessions"]
    assert [(s["arm"], s["run_id"]) for s in sessions] == [
        ("A", f"studio_{pid}_A_impatient_newcomer_s42"),
        ("B", f"studio_{pid}_B_impatient_newcomer_s42"),
    ]
    assert sessions[1]["patch_id"] == pid

    # A session with nothing saved cannot be marked done.
    r = client.post(f"/api/feature_studio/playtest_external/{job['job_id']}/session_done",
                    json={"run_id": sessions[0]["run_id"]})
    assert r.status_code == 400

    for s in sessions:
        d = runs_dir / s["run_id"]
        d.mkdir(parents=True)
        (d / "summary.json").write_text(json.dumps(
            {"onboarding_completed": True, "final_score": 120, "stuck_events": 1,
             "feature_uses": 2 if s["arm"] == "B" else 0}))
        r = client.post(f"/api/feature_studio/playtest_external/{job['job_id']}/session_done",
                        json={"run_id": s["run_id"]})
        assert r.status_code == 200, r.text

    done = client.get(f"/api/feature_studio/playtest_external/{job['job_id']}").json()
    assert done["status"] == "done"
    report = client.get(f"/api/feature_studio/report/{pid}")
    assert report.status_code == 200
    assert report.json()["n_pairs"] == 1
