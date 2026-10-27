"""Exact McNemar, paired Wald CI and paired bootstrap on fixture pairs; summary files are written."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from backend.agents.experiment import (Experiment, Pair, binary_stats, mcnemar_exact, paired_bootstrap,
                                       paired_diff_ci)
from backend.bot_runner import BotMemory, SessionResult, SessionSpec
from backend.config_service import ConfigService
from backend.meta_client import MetaClient


def test_mcnemar_exact_values() -> None:
    assert mcnemar_exact(0, 0) == 1.0
    assert mcnemar_exact(0, 6) == pytest.approx(2 / 64)
    assert mcnemar_exact(2, 8) == pytest.approx(2 * (1 + 10 + 45) / 1024)
    assert mcnemar_exact(5, 5) == 1.0
    assert mcnemar_exact(3, 1) == mcnemar_exact(1, 3)


def test_paired_wald_ci() -> None:
    d, lo, hi = paired_diff_ci(0, 6, 8)
    assert d == 0.75
    assert lo == pytest.approx(0.75 - 1.959964 * (1.5 ** 0.5) / 8, abs=1e-4)
    assert hi == 1.0  # clipped
    s = binary_stats([False] * 6 + [True, False], [True] * 6 + [True, False])
    assert (s["a_rate"], s["b_rate"], s["n10_a_only"], s["n01_b_only"]) == (0.125, 0.875, 0, 6)
    assert s["mcnemar_exact_p"] == pytest.approx(0.03125)


def test_paired_bootstrap() -> None:
    a = [10.0, 12.0, 9.0, 11.0, None]
    b = [7.0, 9.0, 6.0, 8.0, 5.0]
    out = paired_bootstrap(a, b)
    assert out == {"n": 4, "median_delta": -3.0, "ci95": [-3.0, -3.0]}  # every delta is -3
    spread = paired_bootstrap([0.0] * 8, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0])
    assert spread["median_delta"] == 4.5
    lo, hi = spread["ci95"]
    assert 1.0 <= lo < 4.5 < hi <= 8.0
    assert paired_bootstrap([0.0] * 8, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]) == spread  # fixed seed
    assert paired_bootstrap([None], [1.0])["n"] == 0


def test_experiment_writes_summary_and_voiceover(configs_dir: Path, runs_dir: Path) -> None:
    ConfigService(configs_dir).decide("patch_001", "approved", actor="human", note="test")

    async def session(spec: SessionSpec) -> SessionResult:
        if spec.variant == "A":
            s = {"onboarding_completed": False, "where_stuck": "onb_03_handoff", "stuck_events": 3,
                 "stuck_by_step": {"onb_03_handoff": 3}, "final_score": 40, "time_to_first_action_sec": 2.0}
        else:
            s = {"onboarding_completed": True, "first_achievement": True, "where_stuck": None, "stuck_events": 0,
                 "stuck_by_step": {}, "final_score": 180, "time_to_first_action_sec": 1.5}
        return SessionResult(spec, "x", 5, s, 0.0, BotMemory())

    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
    exp = Experiment(configs_dir=configs_dir, runs_dir=runs_dir, clients={"A": client, "B": client},
                     session_fn=session, experiment_id="stats")
    ab = asyncio.run(exp.run([Pair("impatient_newcomer", s) for s in (42, 43, 44, 45, 46, 47)],
                             patch_id="patch_001"))
    saved = json.loads((runs_dir / "ab_summary.json").read_text())
    assert saved["experiment_id"] == ab["experiment_id"] == "stats"
    onb = saved["binary"]["onboarding_completed"]
    assert (onb["a_rate"], onb["b_rate"], onb["n01_b_only"]) == (0.0, 1.0, 6)
    assert onb["mcnemar_exact_p"] == pytest.approx(2 / 64)
    assert saved["binary"]["stalled_at_handoff"]["a_rate"] == 1.0
    assert saved["continuous"]["final_score"]["median_delta"] == 140.0
    assert saved["where_stuck"] == {"A": {"onb_03_handoff": 6}, "B": {"none": 6}}
    sheet = (runs_dir / "voiceover_sheet.txt").read_text()
    assert "[1:50]" in sheet and "[2:23]" in sheet and "6 paired seeds" in sheet and "from 3 to 0" in sheet
