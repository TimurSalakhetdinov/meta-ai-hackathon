"""Unit tests for the Dawn of Empires Visual & Gameplay Overhaul.

Verifies:
- EventType additions: battle_lost, hero_leveled, territory_expanded
- _is_progress behavior (battle_lost is never progress)
- compute_summary fields: battles_lost and hero_levelups
- analyst.stub_diagnosis combat wall detection on Stage 6 Sabertooth wipe
- analyst.draw_stuck_frame combat-recovery target highlighting
- configs/personas.json schema integrity and stub_policy fields
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from pydantic import ValidationError

from backend.agents.analyst import draw_stuck_frame, stub_diagnosis
from backend.schemas import AnalysisConfig, EventType, Persona, TelemetryEvent
from backend.telemetry import _is_progress, compute_summary


def test_event_types_schema() -> None:
    """Verify new EventType literals are accepted in TelemetryEvent."""
    base: dict[str, Any] = {
        "run_id": "test_run_001",
        "variant_id": "A",
        "sim_elapsed_sec": 12.5,
    }

    ev_lost = TelemetryEvent(**base, event_type="battle_lost", payload={"stage_id": "stage_6"})
    assert ev_lost.event_type == "battle_lost"
    assert ev_lost.payload["stage_id"] == "stage_6"

    ev_hero = TelemetryEvent(**base, event_type="hero_leveled", payload={"hero_id": "vaelen", "level": 2})
    assert ev_hero.event_type == "hero_leveled"

    ev_exp = TelemetryEvent(**base, event_type="territory_expanded", payload={"sector_id": "exp_1"})
    assert ev_exp.event_type == "territory_expanded"

    with pytest.raises(ValidationError):
        TelemetryEvent(**base, event_type="invalid_event_type")  # type: ignore[arg-type]


def test_is_progress_rules() -> None:
    """Verify battle_lost is NOT progress, while hero_leveled and territory_expanded are."""
    assert not _is_progress({"event_type": "battle_lost", "payload": {"stage_id": "stage_6"}})
    assert _is_progress({"event_type": "hero_leveled", "payload": {"hero_id": "vaelen", "level": 2}})
    assert _is_progress({"event_type": "territory_expanded", "payload": {"sector_id": "exp_1"}})
    assert _is_progress({"event_type": "battle_won", "payload": {"stage_id": "stage_1"}})
    assert _is_progress({"event_type": "step_complete", "step_id": "onb_01_shelter"})
    assert _is_progress({"event_type": "achievement", "payload": {"achievement_id": "first_achievement"}})
    assert _is_progress({"event_type": "click", "payload": {"result": "advanced"}})
    assert not _is_progress({"event_type": "click", "payload": {"result": "rejected"}})


def test_compute_summary_counts() -> None:
    """Verify battles_lost and hero_levelups counters in compute_summary."""
    cfg = AnalysisConfig()
    events: list[dict[str, Any]] = [
        {"event_type": "session_start", "run_id": "run_test", "sim_elapsed_sec": 0.0},
        {"event_type": "step_enter", "step_id": "free_play", "sim_elapsed_sec": 1.0},
        {"event_type": "hero_leveled", "step_id": "free_play", "sim_elapsed_sec": 5.0, "payload": {"hero_id": "vaelen", "level": 2}},
        {"event_type": "hero_leveled", "step_id": "free_play", "sim_elapsed_sec": 8.0, "payload": {"hero_id": "lyra", "level": 2}},
        {"event_type": "hero_leveled", "step_id": "free_play", "sim_elapsed_sec": 12.0, "payload": {"hero_id": "vaelen", "level": 3}},
        {"event_type": "battle_won", "step_id": "free_play", "sim_elapsed_sec": 15.0, "payload": {"stage_id": "stage_1"}},
        {"event_type": "battle_won", "step_id": "free_play", "sim_elapsed_sec": 20.0, "payload": {"stage_id": "stage_2"}},
        {"event_type": "battle_lost", "step_id": "free_play", "sim_elapsed_sec": 25.0, "payload": {"stage_id": "stage_6"}},
        {"event_type": "battle_lost", "step_id": "free_play", "sim_elapsed_sec": 30.0, "payload": {"stage_id": "stage_6"}},
        {"event_type": "territory_expanded", "step_id": "free_play", "sim_elapsed_sec": 35.0, "payload": {"sector_id": "exp_1"}},
        {"event_type": "session_end", "step_id": "free_play", "sim_elapsed_sec": 40.0, "payload": {"score": 210}},
    ]

    summary = compute_summary(events, cfg)
    assert summary["battles_won"] == 2
    assert summary["battles_lost"] == 2
    assert summary["hero_levelups"] == 3


def test_analyst_stub_diagnosis_combat_wall() -> None:
    """Verify analyst diagnoses under-leveled heroes combat wall on Stage 6 Sabertooth wipe."""
    summary: dict[str, Any] = {
        "where_stuck": "free_play",
        "stuck_events": 2,
        "action_rejected": 0,
    }
    events: list[dict[str, Any]] = [
        {"event_type": "step_enter", "step_id": "free_play", "sim_elapsed_sec": 10.0},
        {"event_type": "battle_lost", "step_id": "free_play", "sim_elapsed_sec": 18.0, "payload": {"stage_id": "stage_6"}},
        {"event_type": "battle_lost", "step_id": "free_play", "sim_elapsed_sec": 25.0, "payload": {"stage_id": "stage_6"}},
        {"event_type": "stuck", "step_id": "free_play", "sim_elapsed_sec": 48.0, "payload": {"reason": "idle"}},
    ]
    frame_targets: list[dict[str, Any]] = [
        {"target_id": "btn_defeat_heroes", "label": "Level Up Your Team", "x": 380, "y": 320, "w": 200, "h": 44},
        {"target_id": "btn_battle_continue", "label": "Return to Valley", "x": 380, "y": 380, "w": 200, "h": 44},
    ]

    res = stub_diagnosis(summary, events, frame_targets)
    assert "hypotheses" in res
    hypo_ids = [h["id"] for h in res["hypotheses"]]
    assert "combat_wall_underleveled_heroes" in hypo_ids

    combat_hypo = next(h for h in res["hypotheses"] if h["id"] == "combat_wall_underleveled_heroes")
    assert combat_hypo["confidence"] >= 0.8
    assert "stage_6" in combat_hypo["evidence"]
    assert "Heroes need level-ups" in combat_hypo["evidence"]

    assert any(lever in res["suggested_levers"] for lever in ("starting_food", "forager_food_yield"))
    assert "combat wall" in res["diagnosis"].lower() or "under-leveled" in res["diagnosis"].lower()


def test_analyst_draw_stuck_frame_combat_recovery() -> None:
    """Verify draw_stuck_frame prioritizes combat recovery buttons when present."""
    # Create a small test image
    img = Image.new("RGB", (960, 540), color=(30, 40, 50))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    raw_png = buf.getvalue()

    combat_targets: list[dict[str, Any]] = [
        {"target_id": "btn_defeat_heroes", "label": "Level Up Your Team", "x": 380, "y": 320, "w": 200, "h": 44},
        {"target_id": "btn_hero_levelup", "label": "Level Up", "x": 500, "y": 200, "w": 120, "h": 36},
        {"target_id": "btn_heroes", "label": "Heroes Hall", "x": 60, "y": 480, "w": 90, "h": 40},
        {"target_id": "btn_research", "label": "Research", "x": 800, "y": 480, "w": 90, "h": 40},
    ]

    out_png, masks = draw_stuck_frame(raw_png, combat_targets)
    assert isinstance(out_png, bytes)
    assert len(masks) == 3
    mask_ids = [m["target_id"] for m in masks]
    assert mask_ids == ["btn_defeat_heroes", "btn_hero_levelup", "btn_heroes"]

    # In tutorial onb_03_handoff, combat targets are not visible, so standard focus targets are used
    tutorial_targets: list[dict[str, Any]] = [
        {"target_id": "btn_research", "label": "Research", "x": 800, "y": 480, "w": 90, "h": 40},
        {"target_id": "card_woodcutter_hut", "label": "Woodcutter", "x": 200, "y": 480, "w": 80, "h": 40},
        {"target_id": "hud_wood", "label": "Wood HUD", "x": 380, "y": 20, "w": 60, "h": 24},
    ]
    _, tut_masks = draw_stuck_frame(raw_png, tutorial_targets)
    tut_mask_ids = [m["target_id"] for m in tut_masks]
    assert tut_mask_ids == ["btn_research", "card_woodcutter_hut", "hud_wood"]


def test_personas_schema_and_policies() -> None:
    """Verify configs/personas.json schema validity and new stub_policy fields."""
    path = Path("configs/personas.json")
    assert path.exists()

    data = json.loads(path.read_text())
    assert isinstance(data, list)
    assert len(data) == 5

    required_ids = [
        "impatient_newcomer",
        "first_time_casual",
        "optimizer",
        "curious_explorer",
        "cautious_hoarder",
    ]
    ids = [p["persona_id"] for p in data]
    assert ids == required_ids

    required_policy_fields = [
        "instant_finish",
        "rush_campaign",
        "level_heroes",
        "target_hero_level",
        "culture_adjacency",
        "explore_modals",
        "hoard_food_threshold",
    ]

    for raw in data:
        persona = Persona.model_validate(raw)
        assert persona.persona_id in required_ids
        assert len(persona.grounding) >= 1
        policy = persona.stub_policy

        for field in required_policy_fields:
            assert field in policy, f"{persona.persona_id} missing {field}"

    # Specific persona policies
    personas_by_id = {p["persona_id"]: p["stub_policy"] for p in data}

    # Impatient newcomer rushes campaign and uses instant finish
    assert personas_by_id["impatient_newcomer"]["rush_campaign"] is True
    assert personas_by_id["impatient_newcomer"]["instant_finish"] is True
    assert personas_by_id["impatient_newcomer"]["level_heroes"] is False

    # Optimizer levels heroes and optimizes culture adjacency
    assert personas_by_id["optimizer"]["level_heroes"] is True
    assert personas_by_id["optimizer"]["culture_adjacency"] is True
    assert personas_by_id["optimizer"]["target_hero_level"] >= 3

    # Curious explorer explores modals
    assert personas_by_id["curious_explorer"]["explore_modals"] is True
    assert personas_by_id["curious_explorer"]["curiosity"] == 1.0

    # Cautious hoarder hoards food before upgrading
    assert personas_by_id["cautious_hoarder"]["hoard_food_threshold"] > 0
    assert personas_by_id["cautious_hoarder"]["harvest"] == 0.95
