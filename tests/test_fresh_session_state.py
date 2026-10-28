"""Each bot session gets a fresh BrowserContext and empty bot memory, even on a shared browser."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend import bot_runner
from backend.bot_runner import BotRunner, SessionSpec, load_personas, local_server
from backend.meta_client import MetaClient


def test_sessions_do_not_share_storage_or_memory(configs_dir: Path, runs_dir: Path,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    from playwright.async_api import async_playwright

    monkeypatch.setitem(bot_runner.MAX_BOT_STEPS, "onboarding", 2)
    seen: list[object] = []
    original = bot_runner.assert_dock_outside_clip

    async def probe(page) -> None:
        # Read what an earlier session might have left, then leave a marker for the next one.
        seen.append(await page.evaluate("() => [localStorage.getItem('bleed'), sessionStorage.getItem('bleed')]"))
        await page.evaluate("() => { localStorage.setItem('bleed', '1'); sessionStorage.setItem('bleed', '1'); }")
        await original(page)

    monkeypatch.setattr(bot_runner, "assert_dock_outside_clip", probe)

    async def main():
        client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
        with local_server(configs_dir, runs_dir) as url:
            runner = BotRunner(url, client, load_personas(configs_dir), runs_dir)
            async with async_playwright() as pw:
                browser = await pw.chromium.launch()
                try:
                    out = []
                    for run_id in ("fresh_1", "fresh_2"):
                        out.append(await runner.run_session(browser, SessionSpec("A", "impatient_newcomer", 42, run_id)))
                        assert browser.contexts == []  # the session closed its own context
                    return out
                finally:
                    await browser.close()

    first, second = asyncio.run(main())
    assert first.ok and second.ok, (first.error, second.error)
    assert seen == [[None, None], [None, None]]
    assert first.memory is not second.memory
    assert [a["step"] for a in second.memory.last_actions] == [0, 1]
    # The scratchpad now tracks each step, but stays private to its session: two
    # steps on a fresh memory can never report more than two steps in one stage.
    assert second.memory.scratchpad["steps_in_current_stage"] <= 2
    assert second.memory.scratchpad["current_step"]
    assert first.memory.scratchpad is not second.memory.scratchpad
