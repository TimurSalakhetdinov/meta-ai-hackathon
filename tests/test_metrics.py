from backend.schemas import AnalysisConfig
from backend.telemetry import compute_summary, derive_stuck

from trace_fixtures import baseline_stall_trace, click, ev, success_trace

CFG = AnalysisConfig(stuck_idle_sim_sec=30.0, stuck_rejected_streak=3)


def summarize(raw):
    return compute_summary(raw + derive_stuck(raw, CFG), CFG)


def test_baseline_stall_metrics():
    s = summarize(baseline_stall_trace())
    assert s["time_to_first_action_sec"] == 3.5
    # One rejected streak (3 rejected clicks) plus one idle interval (15.5 -> 45.5).
    assert s["stuck_events"] == 2
    assert s["stuck_by_step"] == {"onb_03_handoff": 2}
    assert s["where_stuck"] == "onb_03_handoff"
    assert s["onboarding_completed"] is False
    assert s["first_achievement"] is False
    assert s["action_rejected"] == 3


def test_success_metrics():
    s = summarize(success_trace())
    assert s["time_to_first_action_sec"] == 2.0
    assert s["stuck_events"] == 0
    assert s["where_stuck"] is None
    assert s["onboarding_completed"] is True
    assert s["first_achievement"] is True
    assert s["first_achievement_sim_sec"] == 40.0


def test_unfinished_step_is_where_stuck_without_stuck_events():
    raw = [ev(0.0, "onb_01_shelter", "session_start"), ev(0.0, "onb_01_shelter", "step_enter"),
           click(2.0, "onb_01_shelter", "card_shelter", "ui"), ev(10.0, "onb_01_shelter", "session_end")]
    s = summarize(raw)
    assert s["stuck_events"] == 0
    assert s["where_stuck"] == "onb_01_shelter"


def test_no_clicks_means_no_first_action():
    raw = [ev(0.0, "onb_01_shelter", "session_start"), ev(0.0, "onb_01_shelter", "session_end")]
    assert summarize(raw)["time_to_first_action_sec"] is None


def test_ui_clicks_do_not_break_a_rejected_streak():
    raw = [ev(0.0, "onb_03_handoff", "step_enter"),
           click(1, "onb_03_handoff", "tech_toolmaking", "rejected"),
           click(2, "onb_03_handoff", "btn_research", "ui"),
           click(3, "onb_03_handoff", "tech_toolmaking", "rejected"),
           click(4, "onb_03_handoff", "empty", "noop")]
    stuck = derive_stuck(raw, CFG)
    assert [s["payload"]["reason"] for s in stuck] == ["rejected_streak"]


def test_derivation_is_prefix_stable():
    raw = baseline_stall_trace()
    full = derive_stuck(raw, CFG)
    for n in range(len(raw)):
        part = derive_stuck(raw[:n], CFG)
        assert full[: len(part)] == part


def test_server_writes_derived_stuck_and_summary(client, runs_dir):
    raw = baseline_stall_trace()
    for i in range(0, len(raw), 4):  # incremental batches, like the game's flush loop
        assert client.post("/api/events", json=raw[i:i + 4]).status_code == 200
    live = client.get("/api/runs/run_fixture/live").json()
    types = [e["event_type"] for e in live["events"]]
    assert types.count("stuck") == 2
    assert live["summary"]["where_stuck"] == "onb_03_handoff"
    assert (runs_dir / "run_fixture" / "summary.json").exists()
    assert (runs_dir / "run_fixture" / "resolved_config.json").exists()


def test_posting_stuck_is_refused(client):
    bad = ev(1.0, "onb_01_shelter", "stuck")
    assert client.post("/api/events", json=[bad]).status_code == 400
