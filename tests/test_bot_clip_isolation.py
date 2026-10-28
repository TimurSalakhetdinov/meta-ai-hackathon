"""The playtester's 960x540 screenshot clip never contains the dock, and every
rendered target is a clean, well-separated box inside that clip."""

from __future__ import annotations

from itertools import combinations
from typing import Any

import pytest

from tests.e2e import Driver, Server, browser, server  # noqa: F401  (pytest fixtures)

CLIP = {"x": 0, "y": 0, "width": 960, "height": 540}
MIN_GAP = 16


def _gap(a: dict[str, Any], b: dict[str, Any]) -> float:
    dx = max(b["x"] - (a["x"] + a["w"]), a["x"] - (b["x"] + b["w"]), 0)
    dy = max(b["y"] - (a["y"] + a["h"]), a["y"] - (b["y"] + b["h"]), 0)
    return max(dx, dy)


def _check_targets(d: Driver) -> list[dict[str, Any]]:
    targets = [t for t in d.targets() if t["visible"]]
    assert targets
    for t in targets:
        assert t["w"] > 0 and t["h"] > 0, t
        assert 0 <= t["x"] and t["x"] + t["w"] <= CLIP["width"], t
        assert 0 <= t["y"] and t["y"] + t["h"] <= CLIP["height"], t
        assert t["computed_salience"] in {"low", "medium", "high", "high_pulse"}, t
    ui = [t for t in targets if t["kind"] in ("button", "build_card", "tech")]
    for a, b in combinations(ui, 2):
        assert _gap(a, b) >= MIN_GAP, f"{a['target_id']} and {b['target_id']} are {_gap(a, b)} px apart"
    return targets


@pytest.mark.parametrize("query", ["variant=A", "variant=B&patch_id=patch_001"])
def test_dock_outside_clip_and_targets_inside(server: Server, browser: Any, query: str) -> None:  # noqa: F811
    if "patch_id" in query and server.api("GET", "/api/patches/patch_001").json()["patch"]["status"] != "approved":
        server.api("POST", "/api/patches/patch_001/approve", json={"note": "clip test"})
    page = browser.new_page(viewport={"width": 1280, "height": 540}, device_scale_factor=1)
    d = Driver(page)
    d.open(f"{server.base_url}/?{query}&seed=42&telemetry=0")

    # Humans get a slide-out dock that starts closed; otherwise it sits right of the clip.
    if page.is_visible("#right-dock"):
        dock = page.locator("#right-dock").bounding_box()
        assert dock["x"] >= 960 and dock["x"] + dock["width"] <= 1280
    # No visible dock descendant may intersect the game clip.
    leaks = page.evaluate("""() => [...document.querySelectorAll('#right-dock *')]
        .filter((el) => getComputedStyle(el).visibility !== 'hidden')
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.left < 960).length""")
    assert leaks == 0
    root = page.locator("#game-root").bounding_box()
    assert root == {"x": 0, "y": 0, "width": 960, "height": 540}

    welcome = _check_targets(d)
    welcome_ids = {t["target_id"] for t in welcome}
    # The welcome modal covers the playfield; only it and the top HUD stay clickable.
    assert "btn_advisor_ok" in welcome_ids and "btn_research" not in welcome_ids
    assert not any(t["kind"] in ("build_card", "pad") for t in welcome)

    d.click("btn_advisor_ok")
    main = _check_targets(d)
    ids = {t["target_id"] for t in main}
    assert {"btn_research", "btn_speed", "btn_inspect", "card_shelter", "building_town_center"} <= ids

    d.click("card_shelter")
    assert any(t["kind"] == "pad" for t in _check_targets(d))

    d.click("btn_research")
    techs = [t for t in _check_targets(d) if t["kind"] == "tech"]
    assert len(techs) == 7
    assert not d.errors, d.errors
    page.close()
