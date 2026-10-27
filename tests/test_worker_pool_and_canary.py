"""The canary runs first and a failing canary stops the batch; the pool size bounds concurrency."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.agents.experiment import CanaryFailedError, Experiment, Pair
from backend.bot_runner import MAX_BOT_STEPS, BotMemory, SessionResult, SessionSpec, max_bot_steps
from backend.config_service import ConfigService
from backend.meta_client import MetaClient

DONE = {"onboarding_completed": True, "where_stuck": None, "stuck_events": 0, "final_score": 100}


def _approve(configs_dir: Path, patch_id: str = "patch_001") -> None:
    svc = ConfigService(configs_dir)
    if svc.load_patch(patch_id).status != "approved":
        svc.decide(patch_id, "approved", actor="human", note="test")


def _experiment(configs_dir: Path, runs_dir: Path, session_fn, pool: int = 2) -> Experiment:
    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
    return Experiment(configs_dir=configs_dir, runs_dir=runs_dir, clients={"A": client, "B": client},
                      worker_pool_size=pool, session_fn=session_fn, experiment_id="t")


def test_max_bot_steps() -> None:
    assert MAX_BOT_STEPS == {"onboarding": 25, "full_window": 100}
    assert max_bot_steps("onboarding") == 25 and max_bot_steps("full_window") == 100


def test_failing_canary_aborts_before_workers(configs_dir: Path, runs_dir: Path) -> None:
    _approve(configs_dir)
    started: list[str] = []

    async def session(spec: SessionSpec) -> SessionResult:
        started.append(spec.run_id)
        return SessionResult(spec, "error", 0, {}, 0.0, BotMemory(), error="boom")

    exp = _experiment(configs_dir, runs_dir, session)
    with pytest.raises(CanaryFailedError, match="boom"):
        asyncio.run(exp.run([Pair("impatient_newcomer", s) for s in (42, 43, 44)], patch_id="patch_001"))
    assert started == ["t_A_impatient_newcomer_s42"]
    assert not (runs_dir / "ab_summary.json").exists()


def test_canary_first_then_bounded_pool(configs_dir: Path, runs_dir: Path) -> None:
    _approve(configs_dir)
    order: list[str] = []
    live, peak = 0, 0

    async def session(spec: SessionSpec) -> SessionResult:
        nonlocal live, peak
        order.append(spec.run_id)
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.02)
        live -= 1
        return SessionResult(spec, "first_achievement", 3, dict(DONE), 0.0, BotMemory())

    exp = _experiment(configs_dir, runs_dir, session, pool=2)
    ab = asyncio.run(exp.run([Pair("impatient_newcomer", s) for s in (42, 43, 44)], patch_id="patch_001"))
    assert order[0] == "t_A_impatient_newcomer_s42" and exp.log[0] == "canary t_A_impatient_newcomer_s42"
    assert len(order) == 6 and len(set(order)) == 6
    assert peak == 2
    assert ab["n_pairs"] == 3 and ab["worker_pool_size"] == 2


def test_unapproved_patch_is_refused(configs_dir: Path, runs_dir: Path) -> None:
    from backend.config_service import ApprovalRequiredError

    async def session(spec: SessionSpec) -> SessionResult:
        raise AssertionError("no session may start")

    svc = ConfigService(configs_dir)
    pid = svc.propose({"starting_wood": 40}, title="t", rationale="r", target_step="onb_03_handoff",
                      actor="designer_agent").patch_id
    with pytest.raises(ApprovalRequiredError):
        asyncio.run(_experiment(configs_dir, runs_dir, session).run([Pair("impatient_newcomer", 42)], patch_id=pid))
