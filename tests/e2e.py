"""Shared helpers for the browser tests: a real uvicorn server and a click driver.

Every click goes through page.mouse.click at a target centre taken from
window.__GAME_DEBUG__.getRenderedTargets(), so the tests exercise the same
input path as a human or the Playwright playtester.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Server:
    base_url: str
    configs_dir: Path
    runs_dir: Path

    def api(self, method: str, path: str, **kw: Any) -> httpx.Response:
        return httpx.request(method, self.base_url + path, timeout=10, **kw)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextmanager
def run_server(tmp: Path, base_overrides: Optional[dict[str, Any]] = None) -> Iterator[Server]:
    """Start uvicorn on a copy of configs/, optionally with base config overrides."""
    configs = tmp / "configs"
    shutil.copytree(ROOT / "configs", configs, ignore=shutil.ignore_patterns("audit_log.jsonl"))
    if base_overrides:
        base_path = configs / "base_config.json"
        base_path.write_text(json.dumps({**json.loads(base_path.read_text()), **base_overrides}, indent=2))
    runs = tmp / "runs"
    port = _free_port()
    env = {**os.environ, "GAME_CONFIGS_DIR": str(configs), "GAME_RUNS_DIR": str(runs)}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(base + "/api/config", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("uvicorn did not start")
    try:
        yield Server(base, configs, runs)
    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.fixture(scope="module")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Server]:
    with run_server(tmp_path_factory.mktemp("e2e")) as srv:
        yield srv


@pytest.fixture(scope="module")
def browser() -> Iterator[Any]:
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


class Driver:
    """Thin wrapper over a page that clicks rendered targets by id."""

    def __init__(self, page: Any) -> None:
        self.page = page
        self.errors: list[str] = []
        page.on("pageerror", lambda e: self.errors.append(str(e)))

    def open(self, url: str) -> None:
        self.page.goto(url)
        self.page.wait_for_function("window.__GAME_STATE__ && window.__GAME_STATE__.ready")

    def state(self) -> dict[str, Any]:
        return self.page.evaluate("window.__GAME_STATE__")

    def targets(self) -> list[dict[str, Any]]:
        return self.page.evaluate("window.__GAME_DEBUG__.getRenderedTargets()")

    def target(self, target_id: str) -> dict[str, Any] | None:
        return next((t for t in self.targets() if t["target_id"] == target_id and t["visible"]), None)

    def click(self, target_id: str, timeout: float = 5.0) -> None:
        deadline = time.time() + timeout
        while True:
            t = self.target(target_id)
            if t is not None:
                break
            if time.time() > deadline:
                raise AssertionError(f"target {target_id} not visible; state={self.state()}")
            self.page.wait_for_timeout(100)
        seq = self.state()["last_click_seq"]
        self.page.mouse.click(t["x"] + t["w"] / 2, t["y"] + t["h"] / 2)
        self.page.wait_for_function(f"window.__GAME_STATE__.last_click_seq > {seq}", timeout=3000)

    def build(self, building: str) -> str:
        """Select a build card, then click the first free plot. Returns the plot id."""
        self.click(f"card_{building}")
        pad = next(t for t in self.targets() if t["kind"] == "pad" and t["visible"])
        self.click(pad["target_id"])
        return pad["target_id"]

    def harvest_ready(self) -> int:
        ready = [t["target_id"] for t in self.targets() if t["kind"] == "building" and t.get("ready") and t["visible"]]
        for target_id in ready:
            self.click(target_id)
        return len(ready)

    def grind_until(self, cond: Callable[[dict[str, Any]], bool], timeout: float = 30.0) -> dict[str, Any]:
        """Harvest whatever is ready until cond(state) holds."""
        deadline = time.time() + timeout
        while True:
            st = self.state()
            if cond(st):
                return st
            if time.time() > deadline:
                raise AssertionError(f"condition not reached; state={st}")
            self.harvest_ready()
            self.page.wait_for_timeout(150)

    def events(self, event_type: Optional[str] = None) -> list[dict[str, Any]]:
        evs = self.page.evaluate("window.__GAME_DEBUG__.events()")
        return [e for e in evs if event_type is None or e["event_type"] == event_type]

    def end_session(self) -> dict[str, Any]:
        return self.page.evaluate("window.__GAME_DEBUG__.endSession('test_end')")
