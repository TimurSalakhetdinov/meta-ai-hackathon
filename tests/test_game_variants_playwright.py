"""End-to-end variant behaviour in a real browser.

A (base config): the player builds the unlocked Woodcutter Hut at the handoff,
drops below the wood that Basic Toolmaking needs, gets action_rejected
insufficient_wood and stalls at onb_03_handoff.

B (patch_001, approved by a human): the woodcutter stays locked until the
handoff is done, Research pulses, and the same player reaches the Stone Age
first achievement.

Metrics are read back from the server, so this also checks that the telemetry
sink derives stuck events and the summary from raw events.
"""

from __future__ import annotations

from typing import Any

import pytest

from tests.e2e import Driver, Server, browser, server  # noqa: F401  (pytest fixtures)

SPEED = 4


def _page(browser: Any) -> Driver:  # noqa: F811
    return Driver(browser.new_page(viewport={"width": 1280, "height": 540}))


def _onboarding_first_two_steps(d: Driver) -> None:
    d.click("btn_advisor_ok")
    d.build("shelter")
    d.grind_until(lambda s: s["step_id"] == "onb_02_forager")
    d.build("forager_hut")
    d.grind_until(lambda s: s["step_id"] == "onb_03_handoff")


def test_variant_a_stalls_at_handoff(server: Server, browser: Any) -> None:  # noqa: F811
    d = _page(browser)
    run_id = "e2e_variant_a"
    d.open(f"{server.base_url}/?variant=A&seed=42&speed={SPEED}&run_id={run_id}")
    _onboarding_first_two_steps(d)

    card = d.target("card_woodcutter_hut")
    assert card and not card["locked"] and card["affordable"], card
    d.build("woodcutter_hut")
    assert d.state()["resources"]["wood"] == 10

    d.click("btn_research")
    d.click("tech_toolmaking")
    d.click("btn_close_research")
    d.click("card_woodcutter_hut")
    # Nothing produces wood any more: wait out the idle window, then end.
    d.page.wait_for_timeout(int(36 / SPEED * 1000))
    snap = d.end_session()
    assert snap["step_id"] == "onb_03_handoff"
    assert not d.errors, d.errors

    events = server.api("GET", f"/api/runs/{run_id}/recording").json()["events"]
    rejected = [e for e in events if e["event_type"] == "action_rejected"]
    assert any(e["payload"]["target_id"] == "tech_toolmaking" and e["payload"]["reason"] == "insufficient_wood"
               and e["payload"]["wood_available"] == 10 and e["payload"]["wood_required"] == 30 for e in rejected), rejected
    summary = server.api("GET", f"/api/runs/{run_id}/live").json()["summary"]
    assert summary["where_stuck"] == "onb_03_handoff"
    assert summary["stuck_events"] >= 1
    assert summary["onboarding_completed"] is False
    assert summary["first_achievement"] is False


def test_variant_b_requires_approval(server: Server) -> None:  # noqa: F811
    # Runs before the approval below (tests in a module run in file order).
    assert server.api("GET", "/api/patches/patch_001").json()["patch"]["status"] == "validated"
    assert server.api("GET", "/api/config?variant=B&patch_id=patch_001").status_code == 403


def test_variant_b_reaches_stone_age(server: Server, browser: Any) -> None:  # noqa: F811
    status = server.api("GET", "/api/patches/patch_001").json()["patch"]["status"]
    if status != "approved":
        assert server.api("POST", "/api/patches/patch_001/approve", json={"note": "e2e"}).status_code == 200

    d = _page(browser)
    run_id = "e2e_variant_b"
    d.open(f"{server.base_url}/?variant=B&patch_id=patch_001&seed=42&speed={SPEED}&run_id={run_id}")
    _onboarding_first_two_steps(d)
    research = d.target("btn_research")
    assert research and research["computed_salience"] == "high_pulse"

    card = d.target("card_woodcutter_hut")
    assert card and card["locked"], card
    d.click("btn_research")
    d.click("tech_toolmaking")
    d.click("btn_close_research")
    assert d.state()["step_id"] == "free_play"

    d.build("woodcutter_hut")
    d.grind_until(lambda s: s["resources"]["wood"] >= 35 and s["resources"]["rp"] >= 5, timeout=40)
    d.click("btn_research")
    d.click("tech_masonry")
    d.click("btn_close_research")
    d.grind_until(lambda s: s["resources"]["wood"] >= 35 and s["resources"]["food"] >= 20, timeout=40)
    d.build("stone_quarry")
    d.grind_until(lambda s: s["resources"]["stone"] >= 20 and s["resources"]["food"] >= 50
                  and s["resources"]["rp"] >= 10, timeout=60)
    d.click("btn_research")
    d.click("tech_stone_age")
    st = d.grind_until(lambda s: s["achieved"], timeout=10)
    assert st["era"] == "stone_age"
    assert st["score"] >= 100
    d.end_session()
    assert not d.errors, d.errors

    summary = server.api("GET", f"/api/runs/{run_id}/live").json()["summary"]
    assert summary["onboarding_completed"] is True
    assert summary["first_achievement"] is True
    assert summary["where_stuck"] is None
    assert summary["variant_id"] == "B" and summary["patch_id"] == "patch_001"
