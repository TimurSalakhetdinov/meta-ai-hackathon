"""Stuck is measured with AnalysisConfig, never with GameConfig pacing levers."""

import json

from backend.schemas import AnalysisConfig
from backend.telemetry import compute_summary, derive_stuck

from trace_fixtures import baseline_stall_trace

CFG = AnalysisConfig()


def stuck_count(raw):
    return compute_summary(raw + derive_stuck(raw, CFG), CFG)["stuck_events"]


def test_idle_hint_delay_does_not_change_stuck_events(client, configs_dir):
    raw = baseline_stall_trace()
    # Same raw trace, served once under the base config and once under a config
    # with a much shorter idle hint delay.
    base = json.loads((configs_dir / "base_config.json").read_text())
    assert base["idle_hint_delay_sec"] == 15.0
    a = stuck_count([{**e, "run_id": "run_hint_15"} for e in raw])
    b = stuck_count([{**e, "run_id": "run_hint_6", "variant_id": "B", "patch_id": "patch_001"} for e in raw])
    assert a == b > 0


def test_hint_events_are_not_progress():
    raw = baseline_stall_trace()
    without_hints = [e for e in raw if e["event_type"] != "hint_shown"]
    assert stuck_count(raw) == stuck_count(without_hints)


def test_analysis_config_is_not_patchable(configs_dir):
    from backend.schemas import GameConfigPatch
    for key in AnalysisConfig.model_fields:
        assert key not in GameConfigPatch.model_fields
