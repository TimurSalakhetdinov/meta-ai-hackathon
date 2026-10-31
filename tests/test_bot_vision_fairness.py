"""Fair bot vision: only player-visible signals reach the playtester.

The Buildings toggle must survive mark selection when the tutorial guide
points at it, its visible label must propagate, and think-aloud stays short.
"""
from backend.meta_client import MetaClient, select_marks, short_thought


def _target(**kw):
    base = {"target_id": "btn_buildings_toggle", "kind": "button", "x": 8, "y": 480,
            "w": 120, "h": 44, "visible": True, "locked": False, "affordable": True,
            "computed_salience": "medium", "highlighted": False, "label": "Buildings"}
    base.update(kw)
    return base


def test_buildings_toggle_box_carries_label_and_highlight():
    boxes = MetaClient._boxes_from_targets([_target(highlighted=True)])
    assert boxes and boxes[0]["target_id"] == "btn_buildings_toggle"
    assert boxes[0]["label"] == "Buildings"
    assert boxes[0]["highlighted"] is True


def test_highlighted_toggle_wins_mark_selection():
    boxes = MetaClient._boxes_from_targets([
        _target(target_id="pad_1", kind="pad", x=300, y=200, highlighted=False, label=""),
        _target(highlighted=True),
    ])
    marks = select_marks(boxes)
    toggle = [m for m in marks if m.target_id == "btn_buildings_toggle"]
    assert toggle and toggle[0].highlighted and toggle[0].label == "Buildings"


def test_buildings_toggle_survives_sam_prompt_cut():
    # 20 higher-salience pads plus the toggle: SAM only gets 16 prompts,
    # and the toggle must be one of them even when nothing guides to it.
    targets = [_target(target_id=f"pad_{i}", kind="pad", x=100 + i, y=100,
                       computed_salience="high", label="") for i in range(20)]
    targets.append(_target())
    chosen = MetaClient._sam_prompt_targets(targets)
    assert len(chosen) == 16
    assert "btn_buildings_toggle" in [t["target_id"] for t in chosen]


def test_placeable_pads_rank_with_buttons_for_sam():
    # A card is selected (pads affordable): placement marks must reach SAM
    # ahead of ordinary buildings, or the bot never sees where to click.
    targets = [_target(target_id=f"building_{i}", kind="building", x=200 + i,
                       computed_salience="high", label="hut") for i in range(20)]
    targets.append(_target(target_id="pad_3", kind="pad", x=400, y=250,
                           affordable=True, label="Empty ground: tap to place Small Home here"))
    chosen = MetaClient._sam_prompt_targets(targets)
    assert "pad_3" in [t["target_id"] for t in chosen]


def test_mark_carries_locked_and_selected_state():
    boxes = MetaClient._boxes_from_targets([
        _target(target_id="card_smelter", kind="build_card", locked=True,
                affordable=False, label="Smelter, Needs Masonry"),
        _target(target_id="card_shelter", kind="build_card", x=200,
                selected=True, label="Small Home"),
    ])
    marks = {m.target_id: m for m in select_marks(boxes)}
    assert marks["card_smelter"].locked and not marks["card_smelter"].affordable
    assert marks["card_shelter"].selected


def test_mark_carries_researched_state():
    boxes = MetaClient._boxes_from_targets([
        _target(target_id="tech_toolmaking", kind="tech", done=True,
                label="Basic Toolmaking, already learned"),
    ])
    marks = select_marks(boxes)
    assert marks and marks[0].done


def test_short_thought_caps_at_ten_words():
    long = "I am tapping this empty plot again because nothing else on screen seems to work"
    out = short_thought(long)
    assert len(out.rstrip("…").split()) <= 10
    assert short_thought("Tap the Buildings button") == "Tap the Buildings button"
