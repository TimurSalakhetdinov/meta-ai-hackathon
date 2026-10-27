"""Experiment sessions must not share Muse decisions; SAM masks may be shared; cache-only replays cost nothing."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.meta_client import CacheMissError, MetaClient
from tests.meta_fakes import FakeMeta, frame_png, meta_client, persona


def _step(client: MetaClient, run_id: str, *, experiment_mode: bool):
    som = client.segment_and_mark(frame_png(), run_id=run_id, step_index=0)
    d = client.decide_action(som=som, persona=persona(), last_actions=[], run_id=run_id, step_index=0,
                             experiment_mode=experiment_mode)
    return som, d


def test_experiment_sessions_do_not_share_muse_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, fake = meta_client(tmp_path, monkeypatch)
    som1, d1 = _step(client, "exp_A_s42", experiment_mode=True)
    som2, d2 = _step(client, "exp_B_s42", experiment_mode=True)
    assert som1.frame_phash == som2.frame_phash
    assert not som1.cache_hit and som2.cache_hit  # SAM masks are shared
    assert not d1.cache_hit and not d2.cache_hit  # Muse decisions are not
    assert fake.sam_calls == 1 and fake.muse_calls == 2
    assert d1.estimated_cost_usd > 0 and d2.estimated_cost_usd > 0


def test_dev_sessions_reuse_muse_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, fake = meta_client(tmp_path, monkeypatch)
    _step(client, "dev1", experiment_mode=False)
    _, d = _step(client, "dev2", experiment_mode=False)
    assert d.cache_hit and d.estimated_cost_usd == 0.0 and fake.muse_calls == 1


def test_cache_only_replays_at_zero_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = meta_client(tmp_path, monkeypatch)
    _, live = _step(client, "take1", experiment_mode=True)
    spent = client.ledger.totals()["global"]

    monkeypatch.setenv("META_CACHE_ONLY", "1")
    replay = MetaClient(runs_dir=tmp_path / "runs", provider_mode="meta")
    fake = FakeMeta(monkeypatch, replay)
    _, d = _step(replay, "take1_replay", experiment_mode=True)
    assert d.cache_hit and d.estimated_cost_usd == 0.0
    assert (d.mark_id, d.thought) == (live.mark_id, live.thought)
    assert fake.sam_calls == 0 and fake.muse_calls == 0
    assert replay.ledger.totals()["global"] == pytest.approx(spent)

    other = frame_png(shade=10)
    with pytest.raises(CacheMissError):
        replay.segment_and_mark(other, run_id="miss")
