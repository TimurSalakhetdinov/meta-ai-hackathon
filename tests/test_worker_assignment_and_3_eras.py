"""Phase 2 game depth in a real browser: worker toggles, upgrades, chapter
quests, expeditions, the modal and selection rejections, and all three eras.

The base config is made resource-rich (and the research tent fast) so the run
reaches the Bronze Age in seconds; every click still goes through the same
page.mouse.click path as the playtester.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest

from tests.e2e import Driver, Server, browser, run_server  # noqa: F401  (pytest fixtures)

SPEED = 8
RICH = {
    "starting_wood": 500, "starting_food": 500, "starting_stone": 500, "starting_workers": 4,
    "research_tent_rp_per_min": 120.0,
}


@pytest.fixture(scope="module")
def rich_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Server]:
    with run_server(tmp_path_factory.mktemp("rich"), RICH) as srv:
        yield srv


def _pad_of(d: Driver, building_type: str) -> str:
    return next(b["key"] for b in d.state()["buildings"] if b["type"] == building_type)


def _research(d: Driver, tech: str) -> None:
    d.grind_until(lambda s: d.target("btn_research") is not None, timeout=10)
    d.click("btn_research")
    d.grind_until(lambda s: (d.target(tech) or {}).get("affordable"), timeout=40)
    d.click(tech)
    if d.state()["modal_open"] == "research":
        d.click("btn_close_research")
    assert tech in d.state()["techs"]


def _open(d: Driver, rich_server: Server, run_id: str) -> None:
    d.open(f"{rich_server.base_url}/?variant=A&seed=42&speed={SPEED}&run_id={run_id}")
    d.click("btn_advisor_ok")
    d.build("shelter")
    d.grind_until(lambda s: s["step_id"] == "onb_02_forager")
    d.build("forager_hut")
    d.grind_until(lambda s: s["step_id"] == "onb_03_handoff")


def test_worker_toggle_pauses_and_resumes(rich_server: Server, browser: Any) -> None:  # noqa: F811
    d = Driver(browser.new_page(viewport={"width": 1280, "height": 540}))
    _open(d, rich_server, "p2_workers")
    pad = _pad_of(d, "forager_hut")
    target = d.target(f"building_{pad}")
    assert target["staffed"] is True

    d.click(f"worker_{pad}")
    hut = next(b for b in d.state()["buildings"] if b["key"] == pad)
    assert hut["worker"] == 0
    d.grind_until(lambda s: next(b for b in s["buildings"] if b["key"] == pad)["blocked_reason"]
                  == "Unstaffed (tap to assign worker)", timeout=5)
    assert d.target(f"building_{pad}")["staffed"] is False
    assert d.target(f"worker_{pad}")["computed_salience"] == "high"

    d.click(f"worker_{pad}")
    hut = next(b for b in d.state()["buildings"] if b["key"] == pad)
    assert hut["worker"] == 1
    d.grind_until(lambda s: next(b for b in s["buildings"] if b["key"] == pad)["blocked_reason"] is None, timeout=5)
    assert not d.errors, d.errors


def test_three_eras_upgrades_quests_and_battles(rich_server: Server, browser: Any) -> None:  # noqa: F811
    d = Driver(browser.new_page(viewport={"width": 1280, "height": 540}))
    run_id = "p2_three_eras"
    _open(d, rich_server, run_id)
    assert d.state()["era"] == "dawn_age"
    # Upgrades need Basic Toolmaking, so no chip during onboarding.
    assert not any(t["kind"] == "upgrade" for t in d.targets())
    assert d.target("btn_expedition") is None

    _research(d, "tech_toolmaking")
    assert d.state()["step_id"] == "free_play"
    d.build("woodcutter_hut")
    d.grind_until(lambda s: any(b["type"] == "woodcutter_hut" and b["status"] == "done" for b in s["buildings"]),
                  timeout=20)

    # Chapter I is complete: the reward waits for the claim button.
    st = d.state()
    assert st["quest_claimable"] and st["quest_index"] == 0
    food = st["resources"]["food"]
    d.click("btn_claim_quest")
    st = d.state()
    assert st["quest_index"] == 1 and st["resources"]["food"] >= food + 20

    # Upgrade the forager hut to Lv.2.
    pad = _pad_of(d, "forager_hut")
    score = d.state()["score"]
    d.click(f"upgrade_{pad}")
    st = d.state()
    assert next(b for b in st["buildings"] if b["key"] == pad)["level"] == 2
    assert st["score"] > score
    # Lv.3 needs the Stone Age: the chip is gone until then.
    assert d.target(f"upgrade_{pad}") is None

    # Modal open: a click on the map is rejected with modal_blocking_map.
    d.click("btn_research")
    # The Shelter card sits left of the modal box, under the dimmed backdrop.
    card = next(t for t in d.targets() if t["target_id"] == "card_shelter")
    assert not card["visible"]
    d.page.mouse.click(card["x"] + card["w"] / 2, card["y"] + card["h"] / 2)
    d.page.wait_for_timeout(150)
    assert any(e["payload"]["reason"] == "modal_blocking_map" for e in d.events("action_rejected"))
    d.click("btn_close_research")

    # Expedition: win one battle (free_play unlock, Food cost).
    d.click("btn_expedition")
    st = d.state()
    d.click("encounter_misty_river")
    after = d.state()
    assert after["battles"] == 1 and after["modal_open"] is None
    assert after["resources"]["stone"] == st["resources"]["stone"] + 15

    # Stone Age.
    _research(d, "tech_masonry")
    d.build("stone_quarry")
    _research(d, "tech_stone_age")
    st = d.grind_until(lambda s: s["achieved"], timeout=10)
    assert st["era"] == "stone_age"

    # Bronze Age: smelter, a Lv.3 upgrade, more battles, then the tech.
    d.build("smelter")
    d.build("tribal_monument")
    d.build("granary")
    d.grind_until(lambda s: all(b["status"] == "done" for b in s["buildings"]), timeout=20)
    d.click(f"upgrade_{pad}")
    assert next(b for b in d.state()["buildings"] if b["key"] == pad)["level"] == 3
    for enc in ("encounter_megalithic_ruins", "encounter_quarry_ridge"):
        d.click("btn_expedition")
        d.click(enc)
    _research(d, "tech_bronze_age")
    st = d.grind_until(lambda s: s["bronze_achieved"], timeout=20)
    assert st["era"] == "bronze_age" and st["score"] >= 220
    d.end_session()
    assert not d.errors, d.errors

    summary = rich_server.api("GET", f"/api/runs/{run_id}/live").json()["summary"]
    assert summary["first_achievement"] is True
    assert summary["bronze_age_mastery"] is True
    assert summary["battles_won"] == 3


def test_selection_blocks_harvest_when_lever_off(tmp_path_factory: pytest.TempPathFactory,
                                                 browser: Any) -> None:  # noqa: F811
    with run_server(tmp_path_factory.mktemp("sel"), {**RICH, "clear_selection_on_harvest": False}) as srv:
        d = Driver(browser.new_page(viewport={"width": 1280, "height": 540}))
        d.open(f"{srv.base_url}/?variant=A&seed=42&speed={SPEED}&run_id=p2_selection&telemetry=0")
        d.click("btn_advisor_ok")
        d.build("shelter")
        d.grind_until(lambda s: s["step_id"] == "onb_02_forager")
        d.build("forager_hut")
        d.grind_until(lambda s: any(t["kind"] == "building" and t.get("ready") for t in d.targets()), timeout=20)
        ready = next(t for t in d.targets() if t["kind"] == "building" and t.get("ready"))
        d.click("card_shelter")
        d.page.mouse.click(ready["x"] + ready["w"] / 2, ready["y"] + ready["h"] / 2)
        d.page.wait_for_timeout(150)
        reasons = [e["payload"]["reason"] for e in d.events("action_rejected")]
        assert "card_selection_blocking_harvest" in reasons, reasons
