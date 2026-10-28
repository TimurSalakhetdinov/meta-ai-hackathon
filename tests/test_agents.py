"""Agent intelligence at zero Meta API cost: visual salience, scratchpad memory, persona breakdown."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image

from backend.agents import analyst
from backend.bot_runner import update_scratchpad
from backend.meta_client import MetaClient, SomResult

from tests.meta_fakes import frame_png, persona


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any live Meta call would spend credits, so every test fails loudly if one is attempted."""
    def refuse(*_: Any, **__: Any) -> None:
        raise AssertionError("live Meta API call attempted during a $0 agents test")
    for name in ("_call_sam_api", "_call_muse_api", "_call_image_api", "_client"):
        monkeypatch.setattr(MetaClient, name, refuse)


def _targets() -> list[dict[str, Any]]:
    return [
        {"target_id": "btn_research", "x": 800, "y": 470, "w": 100, "h": 50,
         "computed_salience": "low", "label": "Research"},
        {"target_id": "card_woodcutter_hut", "x": 200, "y": 300, "w": 200, "h": 150,
         "computed_salience": "high", "label": "Woodcutter Hut"},
        {"target_id": "hud_wood", "x": 230, "y": 5, "w": 70, "h": 28,
         "computed_salience": "low", "label": "Wood counter"},
    ]


# ------------------------------------------------------- visual salience ratio
def test_compute_visual_salience_measures_distractor_vs_goal() -> None:
    v = analyst.compute_visual_salience(_targets(), [])
    assert v["goal_target"] == "btn_research"
    assert v["goal_area_px"] == 100 * 50 and v["goal_salience"] == "low"
    assert v["distractor_target"] == "card_woodcutter_hut"
    assert v["distractor_area_px"] == 200 * 150 and v["distractor_salience"] == "high"
    assert v["distractor_to_goal_area_ratio"] == round(30000 / 5000, 2) == 6.0


def test_compute_visual_salience_falls_back_to_feature_button_and_masks() -> None:
    feature = {"target_id": "btn_feature_raider_ambush", "x": 400, "y": 200, "w": 120, "h": 120,
               "computed_salience": "high_pulse", "label": "Raider Ambush"}
    v = analyst.compute_visual_salience([_targets()[0], feature], [])
    assert v["distractor_target"] == "btn_feature_raider_ambush"
    assert v["distractor_to_goal_area_ratio"] == round(14400 / 5000, 2)
    # Drawn masks carry bboxes instead of w/h and no salience; they still size the ratio.
    masks = [{"rank": 1, "target_id": "btn_research", "bbox": [800, 470, 100, 50]},
             {"rank": 2, "target_id": "card_woodcutter_hut", "bbox": [200, 300, 200, 150]}]
    m = analyst.compute_visual_salience([], masks)
    assert m["distractor_to_goal_area_ratio"] == 6.0
    assert m["goal_salience"] is None
    # No goal on screen means no ratio.
    assert analyst.compute_visual_salience([], [])["distractor_to_goal_area_ratio"] is None


def test_stub_diagnosis_quotes_visual_area_ratio() -> None:
    summary = {"where_stuck": "onb_03_handoff", "stuck_events": 2}
    events = [{"event_type": "click", "step_id": "onb_03_handoff",
               "payload": {"target_id": "card_woodcutter_hut", "result": "ui"}}]
    hyps = analyst.stub_diagnosis(summary, events, _targets())["hypotheses"]
    low = next(h for h in hyps if h["id"] == "low_research_salience")
    assert "SAM visual area ratio (distractor/Research) is 6.0x." in low["evidence"]


def _frame_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (960, 540), (80, 110, 70)).save(buf, format="PNG")
    return buf.getvalue()


def _write_run(run_dir: Path) -> None:
    """Minimal stalled run: three rejected clicks at onb_03_handoff, stuck frame with targets."""
    base = {"run_id": "vs", "variant_id": "A", "persona_id": "impatient_newcomer", "seed": 42,
            "wall_ts_ms": 0, "provider_mode": "stub"}
    events: list[dict[str, Any]] = [
        {**base, "event_type": "session_start", "sim_elapsed_sec": 0.0, "step_id": "onb_01_shelter",
         "payload": {}},
        {**base, "event_type": "step_enter", "sim_elapsed_sec": 1.0, "step_id": "onb_03_handoff",
         "payload": {}},
    ]
    for i in range(3):
        events.append({**base, "event_type": "click", "sim_elapsed_sec": 5.0 + i,
                       "step_id": "onb_03_handoff", "bot_step_index": i,
                       "payload": {"target_id": "card_woodcutter_hut", "result": "rejected"}})
        events.append({**base, "event_type": "action_rejected", "sim_elapsed_sec": 5.1 + i,
                       "step_id": "onb_03_handoff", "bot_step_index": i,
                       "payload": {"target_id": "card_woodcutter_hut", "reason": "insufficient_wood"}})
    events.append({**base, "event_type": "session_end", "sim_elapsed_sec": 12.0,
                   "step_id": "onb_03_handoff", "payload": {"stop_reason": "max_steps"}})
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    (run_dir / "bot_steps.jsonl").write_text(json.dumps(
        {"bot_step_index": 2, "sim_elapsed_sec": 7.0, "thought": "Not sure what to do next.",
         "player_mood": "confused", "observation_summary": "many regions"}) + "\n")
    frames = run_dir / "frames"
    frames.mkdir(exist_ok=True)
    (frames / "step_002.png").write_bytes(_frame_png())
    (frames / "step_002.json").write_text(json.dumps(
        {"step_id": "onb_03_handoff", "sim_elapsed_sec": 7.0, "targets": _targets()}))


def test_analyze_run_saves_visual_salience(configs_dir: Path, runs_dir: Path) -> None:
    _write_run(runs_dir / "vs")
    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
    analysis = analyst.analyze_run("vs", runs_dir=runs_dir, configs_dir=configs_dir, client=client)
    assert analysis["where_stuck"] == "onb_03_handoff"
    assert analysis["visual_salience"]["distractor_to_goal_area_ratio"] == 6.0
    assert {m["target_id"] for m in analysis["sam_masks"]} >= {"btn_research", "card_woodcutter_hut"}
    saved = json.loads((runs_dir / "vs" / "analysis.json").read_text())
    assert saved["visual_salience"]["goal_target"] == "btn_research"
    low = next(h for h in saved["hypotheses"] if h["id"] == "low_research_salience")
    assert "6.0x" in low["evidence"]


def test_analyze_run_without_frames_preserves_committed_visual_evidence(
        configs_dir: Path, runs_dir: Path) -> None:
    """Committed demo runs ship without frames/: re-analysis must keep their masks and stuck frame."""
    run_dir = runs_dir / "demo"
    _write_run(run_dir)
    shutil.rmtree(run_dir / "frames")
    masks = [{"rank": 1, "target_id": "btn_research", "bbox": [916, 498, 30, 30], "label": "Research"},
             {"rank": 2, "target_id": "card_woodcutter_hut", "bbox": [208, 454.3, 80, 76],
              "label": "Woodcutter"}]
    (run_dir / "analysis.json").write_text(json.dumps({"sam_masks": masks, "stuck_frame": "stuck_frame.png"}))
    (run_dir / "stuck_frame.png").write_bytes(_frame_png())
    (run_dir / "resolved_config.json").write_text(json.dumps({"research_button_salience": "low"}))
    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
    analysis = analyst.analyze_run("demo", runs_dir=runs_dir, configs_dir=configs_dir, client=client)
    assert analysis["sam_masks"] == masks
    assert analysis["stuck_frame"] == "stuck_frame.png"
    assert analysis["visual_salience"]["distractor_to_goal_area_ratio"] == 6.76
    low = next(h for h in analysis["hypotheses"] if h["id"] == "low_research_salience")
    assert "6.76x" in low["evidence"]


def test_draw_stuck_frame_highlights_feature_button() -> None:
    targets = [t for t in _targets() if t["target_id"] != "card_woodcutter_hut"] + [
        {"target_id": "btn_feature_raider_ambush", "x": 400, "y": 200, "w": 120, "h": 120,
         "computed_salience": "high_pulse", "label": "Raider Ambush"}]
    _, masks = analyst.draw_stuck_frame(_frame_png(), targets)
    assert [m["target_id"] for m in masks] == ["btn_research", "btn_feature_raider_ambush", "hud_wood"]


# ------------------------------------------------------------- scratchpad memory
def _decision(target_id: Any, mood: str = "engaged") -> SimpleNamespace:
    return SimpleNamespace(target_id=target_id, player_mood=mood)


def test_update_scratchpad_tracks_stage_steps_repeats_and_mood() -> None:
    mem: dict[str, Any] = {}
    mem = update_scratchpad(mem, {"step_id": "onb_01_shelter"}, _decision("card_shelter"))
    assert mem == {"current_step": "onb_01_shelter", "steps_in_current_stage": 1,
                   "repeated_target_clicks": 1, "last_target_id": "card_shelter",
                   "last_mood": "engaged"}
    mem = update_scratchpad(mem, {"step_id": "onb_01_shelter"}, _decision("card_shelter", "confused"))
    assert mem["steps_in_current_stage"] == 2
    assert mem["repeated_target_clicks"] == 2 and mem["last_mood"] == "confused"
    mem = update_scratchpad(mem, {"step_id": "onb_01_shelter"}, _decision("res_berries"))
    assert mem["steps_in_current_stage"] == 3 and mem["repeated_target_clicks"] == 1
    mem = update_scratchpad(mem, {"step_id": "onb_02_forager"}, _decision("res_berries"))
    assert mem["current_step"] == "onb_02_forager" and mem["steps_in_current_stage"] == 1
    assert mem["repeated_target_clicks"] == 2  # same target across the step boundary still streaks
    mem = update_scratchpad(mem, {"step_id": "onb_02_forager"}, _decision(None, "bored"))
    assert mem["repeated_target_clicks"] == 1  # a wait breaks the click streak


def test_messages_include_working_memory_but_cache_key_ignores_it(tmp_path: Path) -> None:
    client = MetaClient(runs_dir=tmp_path / "runs", provider_mode="stub")
    som = SomResult("abc123", [], "stub_targets", False, 1.0, 0.0, frame_png())
    scratch = {"current_step": "onb_02_forager", "steps_in_current_stage": 3, "last_mood": "confused"}
    text = client._messages(som, persona(), [], 12.0, scratch)[1]["content"][0]["text"]
    assert "\nWorking memory: step=onb_02_forager, steps_here=3, last_mood=confused." in text
    plain = client._messages(som, persona(), [], 12.0)[1]["content"][0]["text"]
    assert "Working memory" not in plain
    assert "Working memory" not in client._messages(som, persona(), [], 12.0, {})[1]["content"][0]["text"]

    keyed = client.cache_key(persona().persona_id, som.frame_phash, [])
    first = client.decide_action(som=som, persona=persona(), last_actions=[], run_id="mem",
                                 stub_decision={"target_id": None, "thought": "wait"})
    second = client.decide_action(som=som, persona=persona(), last_actions=[], run_id="mem",
                                  stub_decision={"target_id": None, "thought": "wait"},
                                  scratchpad=scratch)
    assert first.cache_key == second.cache_key == keyed
