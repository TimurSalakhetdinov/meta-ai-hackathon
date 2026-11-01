"""Async Playwright computer-use runner for one playtester session.

Each session gets a fresh BrowserContext (no localStorage or IndexedDB carry-over)
and a fresh BotMemory. Per step the runner waits for a stable frame, screenshots
only the 960x540 game area, asks the MetaClient for set-of-mark vision and a
decision, clicks with page.mouse.click and posts a BotStepRecord.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional
from urllib.parse import urlencode

import httpx

from .meta_client import BudgetCapExceededError, CacheMissError, MetaClient, decision_record
from .schemas import BotStepRecord, Persona

MAX_BOT_STEPS = {"onboarding": 25, "full_window": 100}
SIM_WINDOW_SEC = 1200.0
FRAME_CLIP = {"x": 0, "y": 0, "width": 960, "height": 540}
VIEWPORT = {"width": 1280, "height": 540}
VOICE_DIR = Path(__file__).resolve().parents[1] / "frontend" / "static" / "assets" / "audio" / "voice"
IDLE_TIMEOUT_MS = 2500
# Sim seconds a "wait" decision lets pass before the next look.
WAIT_SIM_SEC = 4.0
# Rendered targets plus HUD boxes the analyst highlights (the wood counter is not clickable).
TARGETS_JS = """() => {
  const out = window.__GAME_DEBUG__.getRenderedTargets();
  const root = document.getElementById('game-root').getBoundingClientRect();
  const el = document.getElementById('res-wood');
  if (el) {
    const r = el.getBoundingClientRect();
    out.push({target_id: 'hud_wood', kind: 'hud', x: r.left - root.left, y: r.top - root.top, w: r.width,
              h: r.height, visible: true, clickable: false, computed_salience: 'low', label: 'Wood counter'});
  }
  return out;
}"""


@dataclass
class SessionSpec:
    variant: str
    persona_id: str
    seed: int
    run_id: str
    patch_id: Optional[str] = None
    run_type: str = "onboarding"
    speed: int = 4
    experiment_mode: bool = False
    record_video: bool = True
    # Menu play time converted to sim seconds (play_minutes x 60 x speed);
    # None keeps the default sim window.
    time_limit_sim_sec: Optional[float] = None
    # Bot ears: the bot receives a Muse Voice Transcribe transcript of each
    # Elder line as it plays. Off by default (menu choice).
    hear_voice: bool = False


@dataclass
class BotMemory:
    last_actions: list[dict[str, Any]] = field(default_factory=list)
    scratchpad: dict[str, Any] = field(default_factory=dict)


@dataclass
class SessionResult:
    spec: SessionSpec
    stop_reason: str
    steps: int
    summary: dict[str, Any]
    cost_usd: float
    memory: BotMemory
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None


def max_bot_steps(run_type: str) -> int:
    return MAX_BOT_STEPS[run_type]


def update_scratchpad(scratchpad: dict[str, Any], state: dict[str, Any], decision: Any,
                      events_tail: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Fold one bot step into the persona's working memory.

    Tracks the current tutorial step, how many bot steps were spent on it, the
    streak of clicks on the same target (a wait breaks the streak) and the last
    think-aloud mood. Returns a new dict; the caller's scratchpad is untouched.
    """
    prev = dict(scratchpad or {})
    step_id = state.get("step_id")
    if step_id == prev.get("current_step"):
        steps_here = int(prev.get("steps_in_current_stage", 0) or 0) + 1
    else:
        steps_here = 1
    target_id = getattr(decision, "target_id", None)
    if target_id is not None and target_id == prev.get("last_target_id"):
        repeats = int(prev.get("repeated_target_clicks", 0) or 0) + 1
    else:
        repeats = 1
    return {**prev, "current_step": step_id, "steps_in_current_stage": steps_here,
            "repeated_target_clicks": repeats, "last_target_id": target_id,
            "last_mood": getattr(decision, "player_mood", None)}


def session_url(base_url: str, spec: SessionSpec, provider_mode: str) -> str:
    q = {"variant": spec.variant, "seed": spec.seed, "persona": spec.persona_id, "speed": spec.speed,
         "run_id": spec.run_id, "provider": provider_mode, "bot": "external"}
    if spec.patch_id:
        q["patch_id"] = spec.patch_id
    return f"{base_url}/?{urlencode(q)}"


class BotRunner:
    def __init__(self, base_url: str, client: MetaClient, personas: dict[str, Persona], runs_dir: Path) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = client
        self.personas = personas
        self.runs_dir = Path(runs_dir)

    async def run_session(self, browser: Any, spec: SessionSpec) -> SessionResult:
        persona = self.personas[spec.persona_id]
        memory = BotMemory()
        video_tmp = self.runs_dir / spec.run_id / "video_tmp"
        context_kwargs: dict[str, Any] = {"viewport": VIEWPORT, "device_scale_factor": 1}
        if spec.record_video:
            context_kwargs["record_video_dir"] = str(video_tmp)
            context_kwargs["record_video_size"] = VIEWPORT
        context = await browser.new_context(**context_kwargs)
        page = await context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        steps, cost, stop, error = 0, 0.0, "max_steps", None
        heard_file, heard_text = None, None
        frames = self.runs_dir / spec.run_id / "frames"
        frames.mkdir(parents=True, exist_ok=True)
        try:
            await page.goto(session_url(self.base_url, spec, self.client.provider_mode))
            await page.wait_for_function("() => window.__GAME_STATE__?.ready && window.__BOT_HOOKS__", timeout=15000)
            await assert_dock_outside_clip(page)
            step_entered_at, last_step_id = 0.0, None
            async with httpx.AsyncClient(base_url=self.base_url, timeout=10) as http:
                for i in range(max_bot_steps(spec.run_type)):
                    # Stop flag checked before the expensive SAM/model calls,
                    # not only after a whole step completes.
                    if (self.runs_dir / spec.run_id / "stop_requested").exists():
                        stop = "stopped_by_tester"
                        break
                    await wait_idle(page)
                    state = await page.evaluate("window.__GAME_STATE__")
                    if state["step_id"] != last_step_id:
                        step_entered_at, last_step_id = state["sim_elapsed_sec"], state["step_id"]
                    png = await page.screenshot(clip=FRAME_CLIP)
                    (frames / f"step_{i:03d}.png").write_bytes(png)
                    targets = await page.evaluate(TARGETS_JS)
                    (frames / f"step_{i:03d}.json").write_text(json.dumps(
                        {"step_id": state["step_id"], "sim_elapsed_sec": state["sim_elapsed_sec"], "targets": targets}))
                    som = self.client.segment_and_mark(png, targets, run_id=spec.run_id, step_index=i)
                    stub = await page.evaluate("window.__BOT_HOOKS__.plan()") \
                        if self.client.provider_mode == "stub" else None
                    # Bot ears (menu choice, off by default): when a new Elder
                    # line played, the bot gets its Muse Voice Transcribe
                    # transcript, never the written script.
                    if spec.hear_voice:
                        log = await page.evaluate("window.__VOICE_LOG__ || (window.__LAST_VOICE__ ? [window.__LAST_VOICE__] : [])")
                        for voice in (log or []):
                            if voice and voice.get("file") and voice["file"] != heard_file:
                                heard_file = voice["file"]
                                with contextlib.suppress(Exception):
                                    heard_text = self.client.transcribe_audio(
                                        VOICE_DIR / heard_file, run_id=spec.run_id) or heard_text
                    visible_text = await page.evaluate("""() => {
                      const text = (id) => (document.getElementById(id)?.innerText || '').replace(/\s+/g, ' ').trim();
                      const res = [...document.querySelectorAll('#hud .res')].map(
                        (e) => `${e.title}: ${e.querySelector('b')?.textContent || ''}`).join(', ');
                      return { Advisor: text('advisor-text'), Quest: text('quest-card'), 'Top bar': res };
                    }""")
                    decision = self.client.decide_action(
                        som=som, persona=persona, last_actions=memory.last_actions, run_id=spec.run_id,
                        step_index=i, experiment_mode=spec.experiment_mode, stub_decision=stub,
                        sec_in_step=state["sim_elapsed_sec"] - step_entered_at,
                        scratchpad=memory.scratchpad, heard=heard_text, visible_text=visible_text)
                    corr = f"{spec.run_id}_b{i:03d}"
                    # A chosen mark that SAM tied to a rendered target clicks
                    # that target's exact DOM centre, not SAM's box centre:
                    # box drift was landing clicks on neighbours (top bar).
                    clicked_target = None
                    mark = som.mark(decision.mark_id) if decision.action == "click_mark" else None
                    if mark is not None and mark.target_id:
                        clicked_target = next((t for t in targets
                                               if t.get("target_id") == mark.target_id), None)
                    if decision.xy:
                        x, y = decision.xy
                        if clicked_target:
                            x = clicked_target["x"] + clicked_target["w"] / 2
                            y = clicked_target["y"] + clicked_target["h"] / 2
                        await page.evaluate(
                            "([i, c, x, y]) => { window.__BOT_CTX__ = {bot_step_index: i, correlation_id: c};"
                            " window.__BOT_HOOKS__.ring(x, y, 'hit'); }", [i, corr, x, y])
                        await page.mouse.click(x, y)
                        await page.evaluate("() => { window.__BOT_CTX__ = {bot_step_index: null, correlation_id: null}; }")
                    else:
                        await page.wait_for_timeout(int(WAIT_SIM_SEC / spec.speed * 1000))
                    rec = decision_record(decision, som)
                    if clicked_target:
                        rec["target_id"] = clicked_target["target_id"]
                        rec["target_xy"] = [round(x, 1), round(y, 1)]
                    record = BotStepRecord(
                        run_id=spec.run_id, bot_step_index=i, correlation_id=corr,
                        sim_elapsed_sec=state["sim_elapsed_sec"], provider_mode=self.client.provider_mode,
                        persona_id=spec.persona_id, **rec)
                    await http.post(f"/api/runs/{spec.run_id}/bot_steps", json=record.model_dump(mode="json"))
                    await page.evaluate("(r) => window.__BOT_HOOKS__.thought(r)", {
                        "index": i, "thought": decision.thought, "target_id": decision.target_id,
                        "mood": decision.player_mood})
                    memory.last_actions = (memory.last_actions + [{
                        "step": i, "action": decision.action, "mark_id": decision.mark_id,
                        "summary": f"{decision.action} #{decision.mark_id}" if decision.mark_id else decision.action,
                    }])[-3:]
                    memory.scratchpad = update_scratchpad(memory.scratchpad, state, decision)
                    cost += record.estimated_cost_usd or 0.0
                    steps = i + 1
                    stop = await self._stop_reason(page, http, spec)
                    if stop:
                        break
                else:
                    stop = "max_steps"
        except (BudgetCapExceededError, CacheMissError) as exc:
            stop, error = type(exc).__name__, str(exc)
        except Exception as exc:  # recorded on the result; the experiment decides what to do
            stop, error = "error", f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        finally:
            summary = await self._end(page, spec, stop)
            await context.close()
            # Playwright finalizes the webm only when the context closes:
            # keep it as the run's video.webm and drop the temp folder.
            if spec.record_video and video_tmp.exists():
                webms = sorted(video_tmp.rglob("*.webm"))
                if webms:
                    webms[-1].replace(self.runs_dir / spec.run_id / "video.webm")
                import shutil
                shutil.rmtree(video_tmp, ignore_errors=True)
        if errors and error is None:
            error = f"page errors: {errors[:3]}"
        return SessionResult(spec, stop, steps, summary, round(cost, 6), memory, error)

    async def _stop_reason(self, page: Any, http: httpx.AsyncClient, spec: SessionSpec) -> Optional[str]:
        # Tester pressed "Stop bot" in the Studio (flag file next to the run).
        if (self.runs_dir / spec.run_id / "stop_requested").exists():
            return "stopped_by_tester"
        state = await page.evaluate("window.__GAME_STATE__")
        await page.evaluate("window.__GAME_DEBUG__.flush()")
        summary = (await http.get(f"/api/runs/{spec.run_id}/live")).json().get("summary") or {}
        # Bug hunts (full_window) exist to watch the bot struggle: a stuck
        # patch is evidence, not the end. Only onboarding runs stop there.
        if summary.get("stuck_abort") and spec.run_type == "onboarding":
            return "stuck_abort"
        if spec.run_type == "onboarding":
            return "first_achievement" if state["achieved"] else None
        if (state.get("quest_index") or 0) >= 6:
            return "journey_complete"
        if state.get("bronze_achieved"):
            return "bronze_age_mastery"
        if state["sim_elapsed_sec"] >= (spec.time_limit_sim_sec or SIM_WINDOW_SEC):
            return "time_limit"
        return None

    async def _end(self, page: Any, spec: SessionSpec, reason: str) -> dict[str, Any]:
        with contextlib.suppress(Exception):
            await page.evaluate("(r) => window.__GAME_DEBUG__.endSession(r)", reason)
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=10) as http:
                return (await http.get(f"/api/runs/{spec.run_id}/live")).json().get("summary") or {}
        except Exception:
            return {}


async def wait_idle(page: Any) -> None:
    with contextlib.suppress(Exception):
        await page.wait_for_function("() => window.__GAME_STATE__?.ready && window.__GAME_STATE__.idle",
                                     timeout=IDLE_TIMEOUT_MS)


async def assert_dock_outside_clip(page: Any) -> None:
    box = await page.locator("#right-dock").bounding_box()
    if box is None or box["x"] < FRAME_CLIP["width"]:
        raise AssertionError(f"#right-dock intersects the bot's 960x540 frame: {box}")


# ------------------------------------------------------------------ server
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def local_server(configs_dir: Path, runs_dir: Path) -> Iterator[str]:
    """Serve the game and API in a background thread for CLI runs and tests."""
    import uvicorn

    from .app import create_app

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(configs_dir, runs_dir), port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("local server did not start")
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def load_personas(configs_dir: Path) -> dict[str, Persona]:
    rows = json.loads((Path(configs_dir) / "personas.json").read_text())
    return {r["persona_id"]: Persona.model_validate(r) for r in rows}


async def run_one(spec: SessionSpec, *, client: MetaClient, configs_dir: Path, runs_dir: Path,
                  base_url: Optional[str] = None, headed: bool = False) -> SessionResult:
    """One session with its own browser; starts a local server unless base_url is given."""
    from playwright.async_api import async_playwright

    with contextlib.ExitStack() as stack:
        url = base_url or stack.enter_context(local_server(configs_dir, runs_dir))
        runner = BotRunner(url, client, load_personas(configs_dir), runs_dir)
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=not headed)
            try:
                return await runner.run_session(browser, spec)
            finally:
                await browser.close()


def run_session_sync(spec: SessionSpec, **kw: Any) -> SessionResult:
    return asyncio.run(run_one(spec, **kw))
