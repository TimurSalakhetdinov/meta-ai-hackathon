"""SQLite store for AI Playtest Studio experiments.

One experiment = one frozen plan for one patch revision. Phases hold the
sample plan, pairs hold the matched A/B runs, decisions are the append-only
human log (test approval and shipping approval are separate kinds).
Large artifacts stay in per-run folders; this database only links them.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS patches (
  patch_id TEXT NOT NULL, revision INTEGER NOT NULL, idea TEXT,
  config_diff TEXT NOT NULL, base_hash TEXT, patch_hash TEXT NOT NULL,
  validation TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (patch_id, revision));
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY, parent_id TEXT, patch_id TEXT NOT NULL,
  patch_revision INTEGER NOT NULL, title TEXT, plan TEXT NOT NULL,
  plan_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  active_phase TEXT, budget_cap_usd REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS phases (
  phase_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, kind TEXT NOT NULL,
  plan TEXT NOT NULL, planned_pairs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairs (
  pair_id TEXT PRIMARY KEY, phase_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  game_seed INTEGER NOT NULL, repetition INTEGER NOT NULL DEFAULT 1,
  run_order TEXT, status TEXT NOT NULL DEFAULT 'planned');
CREATE TABLE IF NOT EXISTS run_links (
  run_id TEXT PRIMARY KEY, pair_id TEXT NOT NULL, variant TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1, selected INTEGER NOT NULL DEFAULT 1,
  exclusion_reason TEXT);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, phase_id TEXT,
  kind TEXT NOT NULL, actor TEXT NOT NULL, patch_hash TEXT, plan_hash TEXT,
  reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (
  report_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, phase_id TEXT,
  metric_version TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cost_ledger (
  entry_id TEXT PRIMARY KEY, experiment_id TEXT, run_id TEXT, request_id TEXT,
  provider TEXT, reserved_usd REAL, actual_usd REAL, status TEXT);
CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL,
  decision_id TEXT, before_hash TEXT, after_hash TEXT, state TEXT NOT NULL,
  actor TEXT, created_at TEXT NOT NULL, rollback_ref TEXT);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:16]


class StudioStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ------------------------------------------------------------- patches
    def save_patch(self, patch_id: str, diff: dict, *, idea: str = "",
                   base_hash: str = "", validation: Optional[dict] = None) -> dict:
        row = self.conn.execute(
            "SELECT MAX(revision) AS r FROM patches WHERE patch_id = ?", (patch_id,)).fetchone()
        revision = (row["r"] or 0) + 1
        patch_hash = _hash({"patch_id": patch_id, "revision": revision, "diff": diff})
        self.conn.execute(
            "INSERT INTO patches VALUES (?,?,?,?,?,?,?,?)",
            (patch_id, revision, idea, json.dumps(diff), base_hash, patch_hash,
             json.dumps(validation) if validation is not None else None, _now()))
        self.conn.commit()
        return {"patch_id": patch_id, "revision": revision, "patch_hash": patch_hash}

    # --------------------------------------------------------- experiments
    def create_experiment(self, *, patch_id: str, patch_revision: int, title: str,
                          plan: dict, parent_id: Optional[str] = None,
                          budget_cap_usd: Optional[float] = None) -> dict:
        exp_id = f"exp_{uuid.uuid4().hex[:8]}"
        self.conn.execute(
            "INSERT INTO experiments (experiment_id, parent_id, patch_id, patch_revision,"
            " title, plan, plan_hash, budget_cap_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (exp_id, parent_id, patch_id, patch_revision, title, json.dumps(plan),
             _hash(plan), budget_cap_usd, _now()))
        self.conn.commit()
        return self.get_experiment(exp_id)

    def get_experiment(self, experiment_id: str) -> Optional[dict]:
        row = self.conn.execute(
            "SELECT * FROM experiments WHERE experiment_id = ?", (experiment_id,)).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["plan"] = json.loads(out["plan"])
        out["decisions"] = self.list_decisions(experiment_id)
        out["phases"] = self.list_phases(experiment_id)
        return out

    def list_experiments(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT experiment_id, parent_id, patch_id, patch_revision, title, status,"
            " active_phase, budget_cap_usd, created_at FROM experiments ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

    def set_status(self, experiment_id: str, status: str) -> None:
        self.conn.execute("UPDATE experiments SET status = ? WHERE experiment_id = ?",
                          (status, experiment_id))
        self.conn.commit()

    # -------------------------------------------------------------- phases
    def create_phase(self, experiment_id: str, *, kind: str, plan: dict,
                     planned_pairs: int) -> dict:
        phase_id = f"ph_{uuid.uuid4().hex[:8]}"
        self.conn.execute(
            "INSERT INTO phases VALUES (?,?,?,?,?,?,?)",
            (phase_id, experiment_id, kind, json.dumps(plan), planned_pairs, "planned", _now()))
        self.conn.execute("UPDATE experiments SET active_phase = ? WHERE experiment_id = ?",
                          (phase_id, experiment_id))
        self.conn.commit()
        return {"phase_id": phase_id, "experiment_id": experiment_id, "kind": kind,
                "planned_pairs": planned_pairs, "status": "planned"}

    def list_phases(self, experiment_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM phases WHERE experiment_id = ? ORDER BY created_at", (experiment_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["plan"] = json.loads(d["plan"])
            out.append(d)
        return out

    def set_phase_status(self, phase_id: str, status: str) -> None:
        self.conn.execute("UPDATE phases SET status = ? WHERE phase_id = ?", (status, phase_id))
        self.conn.commit()

    # --------------------------------------------------------------- pairs
    def add_pair(self, phase_id: str, *, persona_id: str, game_seed: int,
                 repetition: int = 1, run_order: str = "AB") -> str:
        pair_id = f"pair_{uuid.uuid4().hex[:8]}"
        self.conn.execute("INSERT INTO pairs VALUES (?,?,?,?,?,?,?)",
                          (pair_id, phase_id, persona_id, game_seed, repetition, run_order, "planned"))
        self.conn.commit()
        return pair_id

    def link_run(self, pair_id: str, run_id: str, variant: str, *, attempt: int = 1,
                 selected: bool = True, exclusion_reason: Optional[str] = None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO run_links VALUES (?,?,?,?,?,?)",
            (run_id, pair_id, variant, attempt, 1 if selected else 0, exclusion_reason))
        self.conn.commit()

    def phase_runs(self, phase_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT p.pair_id, p.persona_id, p.game_seed, p.repetition, p.run_order, p.status,"
            " l.run_id, l.variant, l.attempt, l.selected, l.exclusion_reason"
            " FROM pairs p LEFT JOIN run_links l ON l.pair_id = p.pair_id"
            " WHERE p.phase_id = ? ORDER BY p.persona_id, p.game_seed, l.variant", (phase_id,)).fetchall()
        return [dict(r) for r in rows]

    # ----------------------------------------------------------- decisions
    def add_decision(self, experiment_id: str, *, kind: str, actor: str = "human",
                     phase_id: Optional[str] = None, patch_hash: Optional[str] = None,
                     plan_hash: Optional[str] = None, reason: str = "") -> dict:
        dec = {"decision_id": f"dec_{uuid.uuid4().hex[:8]}", "experiment_id": experiment_id,
               "phase_id": phase_id, "kind": kind, "actor": actor, "patch_hash": patch_hash,
               "plan_hash": plan_hash, "reason": reason, "created_at": _now()}
        self.conn.execute(
            "INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?)",
            (dec["decision_id"], experiment_id, phase_id, kind, actor, patch_hash,
             plan_hash, reason, dec["created_at"]))
        # Lifecycle follows the human decisions; the verdict never moves it.
        if kind == "approve_test":
            self.set_status(experiment_id, "approved")
        elif kind == "reject":
            self.set_status(experiment_id, "rejected")
        self.conn.commit()
        return dec

    def list_decisions(self, experiment_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM decisions WHERE experiment_id = ? ORDER BY created_at",
            (experiment_id,)).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- reports
    def save_report(self, experiment_id: str, phase_id: Optional[str], result: dict,
                    metric_version: str = "metrics_v1") -> dict:
        rep = {"report_id": f"rep_{uuid.uuid4().hex[:8]}", "experiment_id": experiment_id,
               "phase_id": phase_id, "metric_version": metric_version,
               "created_at": _now(), "result": result}
        self.conn.execute("INSERT INTO reports VALUES (?,?,?,?,?,?)",
                          (rep["report_id"], experiment_id, phase_id, metric_version,
                           json.dumps(result), rep["created_at"]))
        self.conn.commit()
        return rep
