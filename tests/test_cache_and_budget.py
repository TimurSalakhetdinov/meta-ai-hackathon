"""SAM cache, cost ledger and budget caps (all offline, Meta adapters faked)."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest

from backend.meta_client import BudgetCapExceededError, CostLedger, load_budget
from tests.meta_fakes import frame_png, meta_client


def test_sam_cache_hit_logs_zero_cost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, fake = meta_client(tmp_path, monkeypatch)
    png = frame_png()
    first = client.segment_and_mark(png, run_id="r1", step_index=0)
    second = client.segment_and_mark(png, run_id="r1", step_index=1)
    assert fake.sam_calls == 1
    assert not first.cache_hit and first.estimated_cost_usd == pytest.approx(0.0025)
    assert second.cache_hit and second.estimated_cost_usd == 0.0
    assert [m.center for m in first.marks] == [m.center for m in second.marks]
    lines = client.ledger.entries()
    assert [e["cache_hit"] for e in lines] == [False, True]
    assert lines[1]["estimated_cost_usd"] == 0.0 and lines[1]["images"] == 0
    for key in ("timestamp_iso", "run_id", "bot_step_index", "provider_mode", "model_id", "model_mode", "bucket",
                "prompt_tokens", "completion_tokens", "images", "cache_hit", "estimated_cost_usd"):
        assert key in lines[0]
    assert (tmp_path / "runs" / "r1" / "som_masks" / "step_000.png").exists()


def test_stub_mode_spends_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client, fake = meta_client(tmp_path, monkeypatch, provider_mode="stub")
    targets = [{"target_id": "btn_research", "x": 900, "y": 490, "w": 50, "h": 40, "visible": True}]
    som = client.segment_and_mark(frame_png(), targets, run_id="s")
    assert som.vision_mode == "stub_targets" and fake.sam_calls == 0
    assert client.ledger.totals()["global"] == 0.0


def _ledger(tmp_path: Path, **overrides) -> CostLedger:
    budget = load_budget().model_copy(update=overrides)
    return CostLedger(tmp_path / "cost_ledger.jsonl", budget)


def test_per_session_cap(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    ledger.charge({"run_id": "s1", "bucket": "playtester", "estimated_cost_usd": 1.5})
    with pytest.raises(BudgetCapExceededError, match="per-session"):
        ledger.charge({"run_id": "s1", "bucket": "playtester", "estimated_cost_usd": 0.6})
    # Another session still has room.
    ledger.charge({"run_id": "s2", "bucket": "playtester", "estimated_cost_usd": 0.6})


def test_bucket_overflow(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, buckets_usd={"dev": 1.0, "playtester_runs": 1.0, "analysis": 1.0, "reserve": 1.0})
    ledger.charge({"run_id": "a", "bucket": "analysis", "estimated_cost_usd": 0.9})
    with pytest.raises(BudgetCapExceededError, match="bucket 'analysis'"):
        ledger.charge({"run_id": "b", "bucket": "analysis", "estimated_cost_usd": 0.2})
    assert ledger.totals()["buckets"]["analysis"] == pytest.approx(0.9)


def test_global_stop(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path, global_stop_usd=1.0, per_session_cap_usd=5.0)
    ledger.charge({"run_id": "a", "bucket": "dev", "estimated_cost_usd": 0.8})
    with pytest.raises(BudgetCapExceededError, match="global stop"):
        ledger.charge({"run_id": "b", "bucket": "playtester", "estimated_cost_usd": 0.3})


def test_reserve_needs_use_reserve(tmp_path: Path) -> None:
    ledger = _ledger(tmp_path)
    with pytest.raises(BudgetCapExceededError, match="use_reserve"):
        ledger.charge({"run_id": "x", "bucket": "reserve", "estimated_cost_usd": 0.01})
    ledger.charge({"run_id": "x", "bucket": "reserve", "estimated_cost_usd": 0.01}, use_reserve=True)


def test_ledger_lock_holds_under_concurrent_workers(tmp_path: Path) -> None:
    # 40 workers race to charge $0.10 against a $2.00 global stop: exactly 20 may succeed.
    ledger = _ledger(tmp_path, global_stop_usd=2.0)
    ok, refused = [], []
    barrier = threading.Barrier(40)

    def worker(i: int) -> None:
        # Separate ledger objects on the same file, like separate worker processes.
        mine = CostLedger(ledger.path, ledger.budget)
        barrier.wait()
        try:
            mine.charge({"run_id": f"w{i}", "bucket": "playtester", "estimated_cost_usd": 0.10})
            ok.append(i)
        except BudgetCapExceededError:
            refused.append(i)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(ok) == 20 and len(refused) == 20
    assert ledger.totals()["global"] == pytest.approx(2.0)
    assert len(ledger.entries()) == 20
