"""PUBLIC_PLAY_ONLY=1 (public Hugging Face Space): paid endpoints refuse, play stays open."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def play_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PUBLIC_PLAY_ONLY", "1")


def test_status_reports_play_only(client: TestClient, play_only: None) -> None:
    body = client.get("/api/feature_studio/status").json()
    assert body["public_play_only"] is True


def test_bot_hunt_refused_when_play_only(client: TestClient, play_only: None) -> None:
    r = client.post("/api/bot_hunt", json={"persona": "first_time_casual", "variant": "A",
                                           "seed": 42, "speed": 1, "play_minutes": 5,
                                           "mode": "meta"})
    assert r.status_code == 403


def test_meta_playtest_refused_when_play_only(client: TestClient, play_only: None) -> None:
    r = client.post("/api/feature_studio/playtest",
                    json={"patch_id": "patch_001", "personas": [], "mode": "meta"})
    assert r.status_code == 403


def test_game_config_still_served_when_play_only(client: TestClient, play_only: None) -> None:
    r = client.get("/api/config", params={"variant": "A", "seed": 42})
    assert r.status_code == 200
