"""Telemetry sink and metrics.

The game emits raw events only. `stuck` is derived here with a fixed, versioned
AnalysisConfig that is not part of GameConfig, so patching pacing levers such as
`idle_hint_delay_sec` cannot change how stuck is measured. Derivation is a pure
function of the raw trace and is prefix-stable: new raw events only ever append
new derived events, so they can be written incrementally to events.jsonl.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Iterable, Optional

from .schemas import AnalysisConfig, BotStepRecord, TelemetryEvent

RUN_ID_RE = re.compile(r"[A-Za-z0-9_\-]{1,120}")

# Click results that count towards the rejected streak. "ui" clicks (opening a
# panel, selecting a build card) and "collected" clicks (a harvest that made no
# new build or research affordable) neither count nor reset the streak, and are
# not progress. The game reports a harvest that opens a new option as "advanced".
UNPRODUCTIVE_RESULTS = {"rejected", "noop"}
RUN_META_KEYS = ("run_id", "variant_id", "patch_id", "persona_id", "seed", "time_scale", "provider_mode")


def _is_progress(ev: dict[str, Any]) -> bool:
    et = ev["event_type"]
    if et in ("step_enter", "step_complete", "achievement", "session_start"):
        return True
    return et == "click" and ev.get("payload", {}).get("result") == "advanced"


def derive_stuck(events: Iterable[dict[str, Any]], cfg: AnalysisConfig) -> list[dict[str, Any]]:
    """Derive `stuck` events from raw events (any existing `stuck` events are ignored).

    Rules (per analysis_version):
    - idle: no state-advancing action for `stuck_idle_sim_sec` of simulated time.
      Fires once per full idle interval, at the moment it is observed.
    - rejected_streak: `stuck_rejected_streak` consecutive rejected or no-op clicks
      without progress in between. The streak restarts after firing.
    """
    out: list[dict[str, Any]] = []
    last_progress: Optional[float] = None
    idle_fired = 0
    streak = 0
    for ev in events:
        if ev["event_type"] == "stuck":
            continue
        t = float(ev.get("sim_elapsed_sec", 0.0))
        if last_progress is None:
            last_progress = t
        # Idle check uses the time observed at this event, before applying it.
        while t - last_progress >= cfg.stuck_idle_sim_sec * (idle_fired + 1):
            idle_fired += 1
            at = last_progress + cfg.stuck_idle_sim_sec * idle_fired
            out.append(_stuck(ev, at, "idle", {"idle_sim_sec": round(at - last_progress, 3)}, cfg))
        if ev["event_type"] == "session_end":
            continue
        if _is_progress(ev):
            last_progress, idle_fired, streak = t, 0, 0
            continue
        if ev["event_type"] == "click" and ev.get("payload", {}).get("result") in UNPRODUCTIVE_RESULTS:
            streak += 1
            if streak >= cfg.stuck_rejected_streak:
                out.append(_stuck(ev, t, "rejected_streak", {"streak": streak,
                                  "last_target_id": ev.get("payload", {}).get("target_id")}, cfg))
                streak = 0
    return out


def _stuck(src: dict[str, Any], at: float, reason: str, extra: dict[str, Any], cfg: AnalysisConfig) -> dict[str, Any]:
    ev = {k: src.get(k) for k in RUN_META_KEYS}
    ev.update(
        wall_ts_ms=src.get("wall_ts_ms", 0),
        sim_elapsed_sec=round(at, 3),
        step_id=src.get("step_id"),
        event_type="stuck",
        bot_step_index=src.get("bot_step_index"),
        correlation_id=src.get("correlation_id"),
        payload={"reason": reason, "analysis_version": cfg.analysis_version, **extra},
    )
    return ev


def compute_summary(events: list[dict[str, Any]], cfg: AnalysisConfig) -> dict[str, Any]:
    """Metrics from a full events list (raw + derived)."""
    clicks = [e for e in events if e["event_type"] == "click"]
    stuck = [e for e in events if e["event_type"] == "stuck"]
    per_step: dict[str, int] = {}
    for e in stuck:
        per_step[e.get("step_id") or "unknown"] = per_step.get(e.get("step_id") or "unknown", 0) + 1
    onboarding_completed = any(
        e["event_type"] == "step_complete" and e.get("step_id") == "onb_03_handoff" for e in events
    )
    achievement = next(
        (e for e in events if e["event_type"] == "achievement"
         and e.get("payload", {}).get("achievement_id") == "first_achievement"), None
    )
    end = next((e for e in reversed(events) if e["event_type"] == "session_end"), None)
    if per_step:
        # Most stuck events; ties go to the step that got stuck first.
        order = list(dict.fromkeys(e.get("step_id") or "unknown" for e in stuck))
        where_stuck: Optional[str] = max(order, key=lambda s: (per_step[s], -order.index(s)))
    elif end is not None and not onboarding_completed:
        where_stuck = end.get("step_id")
    else:
        where_stuck = None
    last = events[-1] if events else {}
    first = events[0] if events else {}
    return {
        **{k: first.get(k) for k in RUN_META_KEYS},
        "analysis_version": cfg.analysis_version,
        "time_to_first_action_sec": round(clicks[0]["sim_elapsed_sec"], 3) if clicks else None,
        "stuck_events": len(stuck),
        "stuck_by_step": per_step,
        "stuck_abort": any(n >= cfg.stuck_abort_per_step for n in per_step.values()),
        "where_stuck": where_stuck,
        "onboarding_completed": onboarding_completed,
        "first_achievement": achievement is not None,
        "first_achievement_sim_sec": achievement["sim_elapsed_sec"] if achievement else None,
        "bronze_age_mastery": any(e["event_type"] == "achievement"
                                  and e.get("payload", {}).get("achievement_id") == "bronze_age_mastery" for e in events),
        "battles_won": sum(1 for e in events if e["event_type"] == "battle_won"),
        "action_rejected": sum(1 for e in events if e["event_type"] == "action_rejected"),
        "clicks": len(clicks),
        "session_ended": end is not None,
        "last_step_id": last.get("step_id"),
        "sim_elapsed_sec": last.get("sim_elapsed_sec"),
        "final_score": (end or {}).get("payload", {}).get("score"),
        "step_log": [
            {"sim_elapsed_sec": e["sim_elapsed_sec"], "step_id": e.get("step_id"),
             "event_type": e["event_type"], "summary": _event_summary(e)}
            for e in events if e["event_type"] not in ("heartbeat", "click")
        ],
    }


def _event_summary(e: dict[str, Any]) -> str:
    p = e.get("payload", {})
    et = e["event_type"]
    if et == "stuck":
        return f"STUCK ({p.get('reason')})"
    if et == "action_rejected":
        return f"{p.get('target_id')}: {p.get('reason')}"
    if et in ("step_enter", "step_complete"):
        return f"{et} {e.get('step_id')}"
    if et == "achievement":
        return p.get("achievement_id", "achievement")
    if et == "hint_shown":
        return f"hint -> {p.get('target_id')}"
    return et


def _write_atomic(path: Path, text: str) -> None:
    """Replace the file in one step so lock-free readers never see it half written."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


class TelemetryStore:
    """File-backed run store: runs/<run_id>/{events.jsonl, bot_steps.jsonl, summary.json, ...}."""

    def __init__(self, runs_dir: Path, analysis: AnalysisConfig, config_service: Any = None) -> None:
        self.runs_dir = Path(runs_dir)
        self.analysis = analysis
        self.config_service = config_service
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, run_id: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(run_id, threading.Lock())

    def run_dir(self, run_id: str) -> Path:
        if not RUN_ID_RE.fullmatch(run_id):
            raise ValueError(f"invalid run_id {run_id!r}")
        return self.runs_dir / run_id

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        # Readers do not take the run lock, so skip a trailing line that is still being written.
        complete = path.read_text().rpartition("\n")[0]
        return [json.loads(line) for line in complete.splitlines() if line.strip()]

    def read_events(self, run_id: str) -> list[dict[str, Any]]:
        return self._read_jsonl(self.run_dir(run_id) / "events.jsonl")

    def read_bot_steps(self, run_id: str) -> list[dict[str, Any]]:
        return self._read_jsonl(self.run_dir(run_id) / "bot_steps.jsonl")

    def ingest(self, events: list[TelemetryEvent]) -> dict[str, int]:
        by_run: dict[str, list[dict[str, Any]]] = {}
        for ev in events:
            by_run.setdefault(ev.run_id, []).append(ev.model_dump(mode="json"))
        counts = {}
        for run_id, new in by_run.items():
            with self._lock(run_id):
                counts[run_id] = self._ingest_run(run_id, new)
        return counts

    def _ingest_run(self, run_id: str, new: list[dict[str, Any]]) -> int:
        d = self.run_dir(run_id)
        d.mkdir(parents=True, exist_ok=True)
        for ev in new:
            if ev["event_type"] == "stuck":
                raise ValueError("stuck events are derived server-side and cannot be posted")
            if ev["event_type"] == "session_start":
                self._write_run_meta(d, ev)
        existing = self.read_events(run_id)
        raw = [e for e in existing if e["event_type"] != "stuck"] + new
        already = sum(1 for e in existing if e["event_type"] == "stuck")
        derived = derive_stuck(raw, self.analysis)[already:]
        with (d / "events.jsonl").open("a") as fh:
            for ev in new:
                fh.write(json.dumps(ev) + "\n")
            for ev in derived:
                fh.write(json.dumps(ev) + "\n")
        summary = compute_summary(existing + new + derived, self.analysis)
        _write_atomic(d / "summary.json", json.dumps(summary, indent=2) + "\n")
        return len(new) + len(derived)

    def _write_run_meta(self, d: Path, ev: dict[str, Any]) -> None:
        meta = {k: ev.get(k) for k in RUN_META_KEYS}
        meta["started_wall_ts_ms"] = ev.get("wall_ts_ms")
        meta["analysis_config"] = self.analysis.model_dump()
        if self.config_service is not None:
            try:
                cfg, info = self.config_service.resolve(ev.get("variant_id") or "A", ev.get("patch_id"))
                _write_atomic(d / "resolved_config.json", cfg.model_dump_json(indent=2) + "\n")
                meta["config"] = info
            except Exception as exc:  # recorded, never silently ignored
                meta["config_error"] = str(exc)
        _write_atomic(d / "meta.json", json.dumps(meta, indent=2) + "\n")

    def append_bot_step(self, step: BotStepRecord) -> None:
        d = self.run_dir(step.run_id)
        d.mkdir(parents=True, exist_ok=True)
        with self._lock(step.run_id), (d / "bot_steps.jsonl").open("a") as fh:
            fh.write(step.model_dump_json() + "\n")

    def summary(self, run_id: str) -> Optional[dict[str, Any]]:
        p = self.run_dir(run_id) / "summary.json"
        return json.loads(p.read_text()) if p.exists() else None

    def meta(self, run_id: str) -> Optional[dict[str, Any]]:
        p = self.run_dir(run_id) / "meta.json"
        return json.loads(p.read_text()) if p.exists() else None

    def list_runs(self) -> list[dict[str, Any]]:
        if not self.runs_dir.exists():
            return []
        out = []
        for d in sorted(self.runs_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if d.is_dir() and (d / "events.jsonl").exists():
                s = self.summary(d.name) or {}
                out.append({k: s.get(k) for k in (*RUN_META_KEYS, "where_stuck", "stuck_events",
                                                  "onboarding_completed", "first_achievement")})
        return out
