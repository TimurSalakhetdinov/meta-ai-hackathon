"""Designer agent: turn an analysis into a config patch behind the human approval gate.

The patch goes through `ConfigService.propose`, which validates it and stops at
`validated`. Only a human approval moves it further; this module never approves.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from ..config_service import ConfigService
from ..meta_client import MetaClient
from ..schemas import PatchRecord

# Design values per lever (not results). Used in stub mode and as the fallback for meta mode.
LEVER_DEFAULTS: dict[str, Any] = {
    "lock_optional_builds_until_step": "onb_03_handoff",
    "research_button_salience": "high_pulse",
    "starting_wood": 120,
    "idle_hint_delay_sec": 6.0,
}

DESIGNER_SYSTEM = (
    "You are a game designer. Given an analyst diagnosis and the allowed GameConfig levers, propose the "
    "smallest config patch that removes the friction. Return {\"title\": str, \"rationale\": str, "
    "\"body\": {lever: value}} using only these levers: " + ", ".join(LEVER_DEFAULTS) + "."
)


def stub_proposal(analysis: dict[str, Any]) -> dict[str, Any]:
    levers = [lv for lv in analysis.get("suggested_levers", []) if lv in LEVER_DEFAULTS] or list(LEVER_DEFAULTS)
    body = {lv: LEVER_DEFAULTS[lv] for lv in levers}
    where = analysis.get("where_stuck") or "the stuck step"
    hyps = ", ".join(h["id"] for h in analysis.get("hypotheses", []))
    return {
        "title": f"Guard the {where} step",
        "rationale": (f"Analyst run {analysis.get('run_id')}: {analysis.get('diagnosis')} "
                      f"Hypotheses: {hyps}. Change only the levers that address them."),
        "body": body,
    }


def propose_patch(analysis: dict[str, Any], *, configs_dir: Path,
                  client: Optional[MetaClient] = None) -> PatchRecord:
    client = client or MetaClient(configs_dir=configs_dir)
    stub = stub_proposal(analysis)
    user = json.dumps({k: analysis.get(k) for k in ("where_stuck", "diagnosis", "hypotheses", "suggested_levers")})
    out = client.reason_json(DESIGNER_SYSTEM, user, stub_result=stub, run_id=analysis.get("run_id", "designer"),
                             bucket="analysis", model_id=client.designer_model_id)
    body = {k: v for k, v in (out.get("body") or {}).items() if k in LEVER_DEFAULTS} or stub["body"]
    return ConfigService(configs_dir).propose(
        body, title=out.get("title") or stub["title"], rationale=out.get("rationale") or stub["rationale"],
        target_step=analysis.get("where_stuck"), actor="designer_agent")
