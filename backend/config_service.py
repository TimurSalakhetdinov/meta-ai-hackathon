"""Config and patch service: immutable base config, flat patches, human approval gate.

Patch files in configs/patches/ hold the body and the initial status. Every
lifecycle transition is appended to configs/patches/audit_log.jsonl; the current
status of a patch is the last transition in that log (or the file status if the
log has none). The base config file is never written.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import ValidationError

from .schemas import AuditEntry, GameConfig, GameConfigPatch, PatchRecord

Actor = Literal["designer_agent", "validator", "human"]
PATCH_ID_RE = re.compile(r"patch_[0-9]{3,}(?:_[a-z0-9]+)*")

# Allowed transitions and who may make them. Only a human approves or rejects.
TRANSITIONS: dict[tuple[Optional[str], str], set[str]] = {
    (None, "proposed"): {"designer_agent", "human"},
    ("proposed", "validated"): {"validator"},
    ("proposed", "invalid"): {"validator"},
    ("validated", "approved"): {"human"},
    ("validated", "rejected"): {"human"},
}


class ApprovalRequiredError(Exception):
    """Raised when an unapproved patch is requested for play or experiments."""


class PatchNotFoundError(Exception):
    pass


class TransitionError(Exception):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ConfigService:
    def __init__(self, configs_dir: Path) -> None:
        self.configs_dir = Path(configs_dir)
        self.patches_dir = self.configs_dir / "patches"
        self.audit_path = self.patches_dir / "audit_log.jsonl"
        self._lock = threading.Lock()

    # Base config -------------------------------------------------------
    def base_raw(self) -> dict[str, Any]:
        return json.loads((self.configs_dir / "base_config.json").read_text())

    def base_config(self) -> GameConfig:
        return GameConfig.model_validate(self.base_raw())

    def base_sha256(self) -> str:
        return hashlib.sha256((self.configs_dir / "base_config.json").read_bytes()).hexdigest()

    # Merge -------------------------------------------------------------
    @staticmethod
    def merge(base: GameConfig, patch_body: dict[str, Any]) -> GameConfig:
        """Flat merge. Omitted keys stay unchanged; an explicit null is kept as a value."""
        patch = GameConfigPatch.model_validate(patch_body)
        merged = base.model_dump() | patch.model_dump(exclude_unset=True)
        return GameConfig.model_validate(merged)

    @staticmethod
    def diff(base: GameConfig, merged: GameConfig) -> dict[str, dict[str, Any]]:
        b, m = base.model_dump(), merged.model_dump()
        return {k: {"from": b[k], "to": m[k]} for k in m if b[k] != m[k]}

    # Patches -----------------------------------------------------------
    def _patch_path(self, patch_id: str) -> Path:
        if not PATCH_ID_RE.fullmatch(patch_id):  # also guards against path traversal
            raise PatchNotFoundError(patch_id)
        return self.patches_dir / f"{patch_id}.json"

    def load_patch(self, patch_id: str) -> PatchRecord:
        path = self._patch_path(patch_id)
        if not path.exists():
            raise PatchNotFoundError(patch_id)
        record = PatchRecord.model_validate_json(path.read_text())
        status = self._status_from_audit(patch_id)
        if status:
            record.status = status  # type: ignore[assignment]
        return record

    def list_patches(self) -> list[PatchRecord]:
        out = []
        for path in sorted(self.patches_dir.glob("patch_*.json")):
            out.append(self.load_patch(path.stem))
        return out

    def audit_entries(self, patch_id: Optional[str] = None) -> list[dict[str, Any]]:
        if not self.audit_path.exists():
            return []
        rows = [json.loads(line) for line in self.audit_path.read_text().splitlines() if line.strip()]
        return [r for r in rows if patch_id is None or r["patch_id"] == patch_id]

    def _status_from_audit(self, patch_id: str) -> Optional[str]:
        entries = self.audit_entries(patch_id)
        return entries[-1]["to_state"] if entries else None

    def validation_report(self, record: PatchRecord) -> dict[str, Any]:
        base = self.base_config()
        try:
            merged = self.merge(base, record.body)
        except ValidationError as exc:
            return {"valid": False, "errors": exc.errors(include_url=False, include_context=False)}
        return {"valid": True, "errors": [], "diff": self.diff(base, merged)}

    def _append_audit(
        self, record: PatchRecord, from_state: Optional[str], to_state: str, actor: Actor, note: str
    ) -> AuditEntry:
        key = (from_state, to_state)
        allowed = TRANSITIONS.get(key)
        if allowed is None:
            raise TransitionError(f"Transition {from_state} -> {to_state} is not allowed")
        if actor not in allowed:
            raise TransitionError(f"Actor {actor} may not move a patch {from_state} -> {to_state}")
        report = self.validation_report(record)
        entry = AuditEntry(
            timestamp_iso=_now_iso(),
            patch_id=record.patch_id,
            from_state=from_state,  # type: ignore[arg-type]
            to_state=to_state,  # type: ignore[arg-type]
            actor=actor,
            diff=report.get("diff", {}),
            base_config_sha256=self.base_sha256(),
            note=note,
        )
        self.patches_dir.mkdir(parents=True, exist_ok=True)
        with self.audit_path.open("a") as fh:
            fh.write(entry.model_dump_json() + "\n")
        return entry

    def propose(self, body: dict[str, Any], *, title: str = "", rationale: str = "",
                target_step: Optional[str] = None, actor: Actor = "designer_agent") -> PatchRecord:
        """Write a new patch file as `proposed`, then run validation (validator actor)."""
        with self._lock:
            existing = [int(p.stem.split("_")[1]) for p in self.patches_dir.glob("patch_*.json")]
            patch_id = f"patch_{(max(existing, default=0) + 1):03d}"
            record = PatchRecord(
                patch_id=patch_id, status="proposed", created_by=actor, created_at=_now_iso(),
                title=title, rationale=rationale, target_step=target_step, body=body,  # type: ignore[arg-type]
            )
            self._patch_path(patch_id).write_text(record.model_dump_json(indent=2) + "\n")
            self._append_audit(record, None, "proposed", actor, "patch proposed")
        return self.validate(patch_id)

    def validate(self, patch_id: str) -> PatchRecord:
        with self._lock:
            record = self.load_patch(patch_id)
            if record.status != "proposed":
                return record
            report = self.validation_report(record)
            to_state = "validated" if report["valid"] else "invalid"
            self._append_audit(record, "proposed", to_state, "validator",
                               "Pydantic accepted merged config" if report["valid"] else "Pydantic rejected patch")
        return self.load_patch(patch_id)

    def decide(self, patch_id: str, decision: Literal["approved", "rejected"], *, actor: Actor,
               note: str = "") -> PatchRecord:
        with self._lock:
            record = self.load_patch(patch_id)
            if record.status != "validated":
                raise TransitionError(f"{patch_id} is {record.status}; only validated patches can be decided")
            self._append_audit(record, "validated", decision, actor, note or f"human {decision}")
        return self.load_patch(patch_id)

    # Serving -----------------------------------------------------------
    def resolve(self, variant: str, patch_id: Optional[str]) -> tuple[GameConfig, dict[str, Any]]:
        """Config for a variant. Variant B requires an approved patch."""
        base = self.base_config()
        if variant == "A":
            if patch_id:
                raise ValueError("Variant A is the baseline and takes no patch_id")
            return base, {"variant": "A", "patch_id": None, "base_config_sha256": self.base_sha256()}
        if variant != "B":
            raise ValueError(f"Unknown variant {variant!r}")
        if not patch_id:
            raise ValueError("Variant B needs a patch_id")
        record = self.load_patch(patch_id)
        if record.status != "approved":
            raise ApprovalRequiredError(f"Human approval required: {patch_id} is {record.status}")
        merged = self.merge(base, record.body)
        meta = {"variant": "B", "patch_id": patch_id, "base_config_sha256": self.base_sha256(),
                "diff": self.diff(base, merged)}
        return merged, meta
