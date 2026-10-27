"""Hand-written raw event traces for metric tests."""

META = {"run_id": "run_fixture", "variant_id": "A", "patch_id": None, "persona_id": "impatient_newcomer",
        "seed": 42, "time_scale": 2.0, "provider_mode": "stub", "wall_ts_ms": 0}


def ev(t, step, event_type, **payload):
    return {**META, "sim_elapsed_sec": t, "step_id": step, "event_type": event_type,
            "bot_step_index": None, "correlation_id": None, "payload": payload}


def click(t, step, target, result):
    return ev(t, step, "click", target_id=target, result=result, x=0, y=0)


def baseline_stall_trace():
    """Variant A: woodcutter built at the handoff, Research rejected three times, then idle."""
    return [
        ev(0.0, "onb_01_shelter", "session_start"),
        ev(0.0, "onb_01_shelter", "step_enter"),
        click(3.5, "onb_01_shelter", "card_shelter", "ui"),
        click(4.0, "onb_01_shelter", "pad_1", "advanced"),
        ev(6.0, "onb_01_shelter", "step_complete"),
        ev(6.0, "onb_02_forager", "step_enter"),
        click(7.0, "onb_02_forager", "card_forager_hut", "ui"),
        click(7.5, "onb_02_forager", "pad_2", "advanced"),
        click(14.0, "onb_02_forager", "building_pad_2", "collected"),
        ev(14.0, "onb_02_forager", "step_complete"),
        ev(14.0, "onb_03_handoff", "step_enter"),
        click(15.0, "onb_03_handoff", "card_woodcutter_hut", "ui"),
        click(15.5, "onb_03_handoff", "pad_3", "advanced"),
        click(18.0, "onb_03_handoff", "btn_research", "ui"),
        click(19.0, "onb_03_handoff", "tech_toolmaking", "rejected"),
        ev(19.0, "onb_03_handoff", "action_rejected", target_id="tech_toolmaking", reason="insufficient_wood",
           wood_available=10, wood_required=30),
        click(20.0, "onb_03_handoff", "tech_toolmaking", "rejected"),
        ev(20.0, "onb_03_handoff", "action_rejected", target_id="tech_toolmaking", reason="insufficient_wood"),
        click(21.0, "onb_03_handoff", "tech_toolmaking", "rejected"),
        ev(21.0, "onb_03_handoff", "action_rejected", target_id="tech_toolmaking", reason="insufficient_wood"),
        ev(25.0, "onb_03_handoff", "heartbeat"),
        ev(30.0, "onb_03_handoff", "hint_shown", target_id="btn_research"),
        ev(40.0, "onb_03_handoff", "heartbeat"),
        ev(50.0, "onb_03_handoff", "heartbeat"),
        ev(52.0, "onb_03_handoff", "session_end", score=35),
    ]


def success_trace():
    """Variant B: clean onboarding and the first achievement."""
    return [
        ev(0.0, "onb_01_shelter", "session_start"),
        ev(0.0, "onb_01_shelter", "step_enter"),
        click(2.0, "onb_01_shelter", "card_shelter", "ui"),
        click(2.5, "onb_01_shelter", "pad_1", "advanced"),
        ev(4.5, "onb_01_shelter", "step_complete"),
        ev(4.5, "onb_02_forager", "step_enter"),
        click(5.0, "onb_02_forager", "pad_2", "advanced"),
        click(11.0, "onb_02_forager", "building_pad_2", "collected"),
        ev(11.0, "onb_02_forager", "step_complete"),
        ev(11.0, "onb_03_handoff", "step_enter"),
        click(12.0, "onb_03_handoff", "btn_research", "ui"),
        click(13.0, "onb_03_handoff", "tech_toolmaking", "advanced"),
        ev(13.0, "onb_03_handoff", "step_complete"),
        ev(13.0, "free_play", "step_enter"),
        click(40.0, "free_play", "tech_stone_age", "advanced"),
        ev(40.0, "free_play", "achievement", achievement_id="first_achievement"),
        ev(45.0, "free_play", "session_end", score=105),
    ]
