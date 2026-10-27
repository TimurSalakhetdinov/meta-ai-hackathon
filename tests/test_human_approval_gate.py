import json

from backend.config_service import ApprovalRequiredError, ConfigService

import pytest


def audit_rows(configs_dir):
    path = configs_dir / "patches" / "audit_log.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []


def test_variant_a_is_served(client):
    r = client.get("/api/config", params={"variant": "A"})
    assert r.status_code == 200
    assert r.json()["config"]["research_button_salience"] == "low"


def test_unapproved_patch_is_refused_then_approved(client, configs_dir):
    r = client.get("/api/config", params={"variant": "B", "patch_id": "patch_001"})
    assert r.status_code == 403
    assert "Human approval required" in r.json()["detail"]

    r = client.post("/api/patches/patch_001/approve", json={"note": "approved in test"})
    assert r.status_code == 200
    assert r.json()["patch"]["status"] == "approved"

    rows = audit_rows(configs_dir)
    assert rows[-1]["patch_id"] == "patch_001"
    assert (rows[-1]["from_state"], rows[-1]["to_state"], rows[-1]["actor"]) == ("validated", "approved", "human")
    assert set(rows[-1]["diff"]) >= {"starting_wood", "research_button_salience"}
    assert len(rows[-1]["base_config_sha256"]) == 64

    r = client.get("/api/config", params={"variant": "B", "patch_id": "patch_001"})
    assert r.status_code == 200
    cfg = r.json()["config"]
    assert cfg["research_button_salience"] == "high_pulse"
    assert cfg["lock_optional_builds_until_step"] == "onb_03_handoff"


def test_rejected_patch_stays_blocked(client):
    assert client.post("/api/patches/patch_001/reject").status_code == 200
    assert client.get("/api/config", params={"variant": "B", "patch_id": "patch_001"}).status_code == 403
    # A decided patch cannot be decided again.
    assert client.post("/api/patches/patch_001/approve").status_code == 409


def test_base_file_is_never_modified(client, configs_dir):
    before = (configs_dir / "base_config.json").read_bytes()
    client.post("/api/patches/patch_001/approve")
    assert (configs_dir / "base_config.json").read_bytes() == before


def test_designer_proposal_lifecycle(client, configs_dir):
    r = client.post("/api/patches", json={"body": {"starting_wood": 100}, "title": "more wood"})
    assert r.status_code == 201
    patch = r.json()["patch"]
    assert patch["status"] == "validated"
    assert client.get("/api/config", params={"variant": "B", "patch_id": patch["patch_id"]}).status_code == 403
    actors = [(row["from_state"], row["to_state"], row["actor"]) for row in audit_rows(configs_dir)
              if row["patch_id"] == patch["patch_id"]]
    assert actors == [(None, "proposed", "designer_agent"), ("proposed", "validated", "validator")]


def test_invalid_proposal_cannot_be_approved(client):
    r = client.post("/api/patches", json={"body": {"starting_wood": 9999}})
    patch = r.json()["patch"]
    assert patch["status"] == "invalid"
    assert client.post(f"/api/patches/{patch['patch_id']}/approve").status_code == 409


def test_service_raises_approval_required(configs_dir):
    with pytest.raises(ApprovalRequiredError):
        ConfigService(configs_dir).resolve("B", "patch_001")


def test_patch_id_path_traversal_rejected(client):
    assert client.get("/api/patches/..%2Fbase_config").status_code == 404
    assert client.get("/api/config", params={"variant": "B", "patch_id": "../base_config"}).status_code == 404
