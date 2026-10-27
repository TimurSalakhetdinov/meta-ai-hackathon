"""Closed loop in stub mode: play A, analyze, design, human approval, paired A/B rerun. Spends $0."""

from __future__ import annotations

import json
from pathlib import Path

from backend.cli import run_closed_loop
from backend.config_service import ConfigService

# Stub B reaches the Stone Age on seeds 42 and 44; on 43 and 45 it completes onboarding but stalls later.
SEEDS = [42, 44]


def test_closed_loop_stub(configs_dir: Path, runs_dir: Path) -> None:
    asked: list[str] = []

    def approver(patch) -> bool:
        asked.append(patch.patch_id)
        assert patch.status == "validated"  # nothing is applied before the human says yes
        return True

    r = run_closed_loop(mode="stub", seeds=SEEDS, configs_dir=configs_dir, runs_dir=runs_dir,
                        human_approver=approver, loop_id="e2e")
    play = runs_dir / r["play_run_id"]
    analysis = json.loads((play / "analysis.json").read_text())
    assert (play / "stuck_frame.png").exists()
    assert analysis["where_stuck"] == "onb_03_handoff"
    assert {m["target_id"] for m in analysis["sam_masks"]} >= {"btn_research", "card_woodcutter_hut"}
    assert analysis["playtester_quotes"]

    assert asked == [r["patch_id"]] and r["approved"]
    assert ConfigService(configs_dir).load_patch(r["patch_id"]).status == "approved"

    ab = json.loads((runs_dir / "ab_summary.json").read_text())
    assert ab["patch_id"] == r["patch_id"] and ab["provider_mode"] == "stub" and ab["n_pairs"] == len(SEEDS)
    for row in ab["pairs"]:
        assert row["A"]["where_stuck"] == "onb_03_handoff" and not row["A"]["onboarding_completed"]
        assert row["B"]["onboarding_completed"] and row["B"]["first_achievement"]
    assert ab["cost_usd"] == 0.0
    assert (runs_dir / "voiceover_sheet.txt").exists()


def test_closed_loop_stops_when_human_rejects(configs_dir: Path, runs_dir: Path) -> None:
    r = run_closed_loop(mode="stub", seeds=[42], configs_dir=configs_dir, runs_dir=runs_dir,
                        human_approver=lambda patch: False, loop_id="rej")
    assert not r["approved"] and r["ab_summary"] is None
    assert ConfigService(configs_dir).load_patch(r["patch_id"]).status == "rejected"
    assert not (runs_dir / "ab_summary.json").exists()
