"""Feature Studio dock in a real browser: forge, approve, playtest, report, rework, approve, playtest.

Every step is a DOM click in #right-dock, opened from its slide-out toggle. The server runs in-process so the
playtest can use the fake playtester from test_feature_studio, which keeps the
run at zero Meta API cost and a few seconds long. The test also fails on any
page error, console error or horizontal overflow inside the dock.
"""

from __future__ import annotations

import shutil
import socket
import threading
import time
from pathlib import Path
from typing import Any, Iterator

import pytest

from backend.app import create_app
from tests.test_feature_studio import fake_session, no_network  # noqa: F401  (autouse fixture)

ROOT = Path(__file__).resolve().parents[1]
PROMPT = "Add a Raider Ambush button at tutorial step 2 that costs wood and rewards score"

OVERFLOW_JS = """() => {
  const dock = document.getElementById('right-dock');
  const right = dock.getBoundingClientRect().right + 1;
  const wide = [...dock.querySelectorAll('*')]
    .filter((e) => e.offsetParent && e.getBoundingClientRect().right > right)
    .map((e) => `${e.tagName}.${e.className}#${e.id}`);
  return { scroll: dock.scrollWidth - dock.clientWidth, wide };
}"""


@pytest.fixture(scope="module")
def studio_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    uvicorn = pytest.importorskip("uvicorn")
    tmp = tmp_path_factory.mktemp("studio_ui")
    configs = tmp / "configs"
    shutil.copytree(ROOT / "configs", configs, ignore=shutil.ignore_patterns("audit_log.jsonl"))
    runs = tmp / "runs"
    app = create_app(configs, runs)
    app.state.studio_session_fn = fake_session(runs, configs)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("uvicorn did not start")
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def _expected_404(response: Any) -> bool:
    """The onboarding section reports a missing run analysis or A/B summary as a note, not an error."""
    url = response.url.split("?")[0]
    return response.status == 404 and (url.endswith("/analysis") or url.endswith("/api/ab_summary"))


@pytest.fixture(scope="module")
def page(studio_url: str) -> Iterator[Any]:
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": 1400, "height": 800})
        pg.errors = []
        pg.on("pageerror", lambda e: pg.errors.append(f"pageerror: {e}"))
        # Resource failures are checked per URL below; the console line does not say which one.
        pg.on("console", lambda m: m.type == "error" and not m.text.startswith("Failed to load resource")
              and pg.errors.append(f"console: {m.text}"))
        pg.on("response", lambda r: r.status >= 400 and not _expected_404(r)
              and pg.errors.append(f"http {r.status}: {r.url}"))
        pg.goto(f"{studio_url}/?variant=A&seed=42")
        pg.wait_for_function("window.__GAME_STATE__ && window.__GAME_STATE__.ready")
        # Human mode: the studio is a slide-out panel, closed while playing.
        assert not pg.is_visible("#forge-btn")
        pg.click("#council-toggle")
        yield pg
        browser.close()


def _no_overflow(page: Any) -> None:
    out = page.evaluate(OVERFLOW_JS)
    assert out["scroll"] <= 0 and not out["wide"], out


def _approve_and_playtest(page: Any) -> str:
    page.click("#decree-approve")
    page.wait_for_selector("#decree .decree.approved")
    assert not page.is_disabled("#summon-btn")
    page.click("#summon-btn")
    page.wait_for_selector("#tab-report:not([hidden]) .verdict", timeout=30_000)
    _no_overflow(page)
    return page.inner_text("#tab-report .verdict")


def test_forge_approve_playtest_rework_loop(page: Any) -> None:
    page.fill("#forge-prompt", PROMPT)
    # Nobody is preselected; pick all five playtesters.
    assert page.locator("#guild .medallion.on").count() == 0
    for i in range(5):
        page.locator("#guild .medallion").nth(i).dispatch_event("click")
    assert page.locator("#guild .medallion.on").count() == 5
    page.click("#forge-btn")

    page.wait_for_selector("#decree .decree.validated")
    assert page.inner_text("#decree .decree-title") == "Raider Ambush"
    page.wait_for_function("() => { const i = document.querySelector('#decree .emblem img');"
                           " return i && i.complete && i.naturalWidth > 0; }")
    # Stub mode draws the emblem procedurally and must not claim Muse Image made it.
    assert page.inner_text("#decree .gen-badge") == "Procedural stub emblem"
    # The approval gate: nothing can be playtested before a human approves.
    assert page.is_disabled("#summon-btn")
    _no_overflow(page)

    assert "HURTS ONBOARDING" in _approve_and_playtest(page)
    assert page.locator("#tab-report .plaque").count() == 4
    assert page.locator("#tab-report .speech").count() >= 1
    assert not page.is_disabled("#rework-btn")

    page.click("#rework-btn")
    page.wait_for_selector("#tab-forge:not([hidden]) #decree .decree.validated")
    assert page.inner_text("#decree .decree-step").startswith("After the tutorial")
    assert page.is_disabled("#summon-btn")

    assert "POSITIVE IMPACT" in _approve_and_playtest(page)
    assert page.is_disabled("#rework-btn")
    assert not page.errors, page.errors


def test_game_manager_approve_and_play(studio_url: str, page: Any) -> None:
    """A plain visit opens the Game Manager; Approve & play switches the feature on in the open game."""
    page.goto(f"{studio_url}/?seed=42")
    page.wait_for_function("window.__GAME_STATE__ && window.__GAME_STATE__.ready")
    assert page.locator("#mgr-cards .mgr-card").count() == 3
    page.click("#mgr-cards button[data-id='harvest_festival']")
    page.wait_for_selector("#manager", state="detached")
    assert page.inner_text("#decree .wax-seal") == "✔ Approved"
    assert page.is_visible("#summon-btn")
    assert "Harvest Festival is live" in page.inner_text("body")
    assert not page.errors, page.errors
