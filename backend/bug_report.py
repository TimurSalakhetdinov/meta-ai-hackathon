"""Bug-hunting Report A, saved next to its run.

Built only from this run's own artifacts (summary, analyst output, bot
result). Saved as `runs/<run_id>/bug_report.json` when a hunt finishes and
served at `GET /api/runs/{run_id}/bug-report`. No other run is ever read.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _read(path: Path) -> Optional[dict[str, Any]]:
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def build_bug_report(runs_dir: Path, run_id: str) -> Optional[dict[str, Any]]:
    d = Path(runs_dir) / run_id
    summary = _read(d / "summary.json")
    analysis = _read(d / "analysis.json")
    bot = _read(d / "bot_result.json")
    if summary is None and analysis is None:
        return None
    summary = summary or {}
    analysis = analysis or {}
    stop_reason = (bot or {}).get("stop_reason")
    if stop_reason == "stopped_by_tester":
        status = "Stopped by tester: partial coverage"
    elif (bot or {}).get("error"):
        status = "Runner failed"
    elif summary.get("session_ended"):
        status = "Finished"
    else:
        status = "Running"
    return {
        "kind": "bug_report",
        "run_id": run_id,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": status,
        "stop_reason": stop_reason,
        "persona": summary.get("persona_id") or (bot or {}).get("persona"),
        "where_stuck": analysis.get("where_stuck") or summary.get("where_stuck"),
        "stuck_events": summary.get("stuck_events"),
        "stuck_frame": analysis.get("stuck_frame"),
        "visual_salience": analysis.get("visual_salience"),
        "diagnosis": analysis.get("diagnosis"),
        "diagnosis_status": "ready" if analysis.get("diagnosis") else "pending",
        "proposed_fixes": [
            {"id": h.get("id"), "confidence": h.get("confidence"),
             "evidence": h.get("evidence"), "hypothesis_only": True}
            for h in analysis.get("hypotheses") or []],
        "think_aloud": analysis.get("playtester_quotes") or [],
    }


def save_bug_report(runs_dir: Path, run_id: str) -> Optional[dict[str, Any]]:
    report = build_bug_report(runs_dir, run_id)
    if report is None:
        return None
    (Path(runs_dir) / run_id / "bug_report.json").write_text(json.dumps(report, indent=2))
    return report
