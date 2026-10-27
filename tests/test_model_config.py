"""Muse Spark model selection and the experiment's refusal to mix configurations."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.agents.experiment import Experiment, MixedConfigError
from backend.meta_client import MetaClient, load_budget
from tests.meta_fakes import frame_png, meta_client, persona


def test_default_model_is_contributor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = meta_client(tmp_path, monkeypatch)
    assert client.muse_model_id == "muse-spark-1.3-contributor"
    assert client.model_mode == "contributor"
    som = client.segment_and_mark(frame_png(), run_id="m")
    d = client.decide_action(som=som, persona=persona(), last_actions=[], run_id="m")
    assert d.model_mode == "contributor"
    muse = [e for e in client.ledger.entries() if e["model_id"] == "muse-spark-1.3-contributor"]
    assert muse and all(e["model_mode"] == "contributor" for e in muse)
    # Contributor price: 2000 * 0.10 / 1M + 300 * 0.20 / 1M.
    assert d.estimated_cost_usd == pytest.approx(0.00026)


def test_standard_model_logs_standard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    budget = load_budget().model_copy(update={"muse_model_id": "muse-spark-1.3"})
    client, _ = meta_client(tmp_path, monkeypatch, budget=budget)
    som = client.segment_and_mark(frame_png(), run_id="s")
    d = client.decide_action(som=som, persona=persona(), last_actions=[], run_id="s")
    assert d.model_mode == "standard"
    assert any(e["model_id"] == "muse-spark-1.3" and e["model_mode"] == "standard" for e in client.ledger.entries())
    assert d.estimated_cost_usd == pytest.approx(2000 * 1.25 / 1e6 + 300 * 4.25 / 1e6)


def test_experiment_refuses_mixed_model_ids(tmp_path: Path) -> None:
    a = MetaClient(runs_dir=tmp_path, provider_mode="stub")
    b = MetaClient(runs_dir=tmp_path, provider_mode="stub",
                   budget=load_budget().model_copy(update={"muse_model_id": "muse-spark-1.3"}))
    with pytest.raises(MixedConfigError, match="muse_model_id"):
        Experiment(configs_dir=tmp_path, runs_dir=tmp_path, clients={"A": a, "B": b})


def test_experiment_refuses_mixed_provider_modes(tmp_path: Path) -> None:
    a = MetaClient(runs_dir=tmp_path, provider_mode="stub")
    b = MetaClient(runs_dir=tmp_path, provider_mode="meta")
    with pytest.raises(MixedConfigError, match="provider_mode"):
        Experiment(configs_dir=tmp_path, runs_dir=tmp_path, clients={"A": a, "B": b})
