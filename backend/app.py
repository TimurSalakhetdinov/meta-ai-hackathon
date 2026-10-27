"""FastAPI app: config/patch service with the human approval gate, telemetry sink, static game.

Run with `uvicorn backend.app:app`. Paths can be overridden with GAME_CONFIGS_DIR and
GAME_RUNS_DIR (tests use temporary copies).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional, Union

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from .config_service import (
    ApprovalRequiredError,
    ConfigService,
    PatchNotFoundError,
    TransitionError,
)
from .schemas import AnalysisConfig, BotStepRecord, GameConfig, Persona, TelemetryEvent
from .telemetry import TelemetryStore

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "frontend" / "static"


class ProposeRequest(BaseModel):
    body: dict[str, Any]
    title: str = ""
    rationale: str = ""
    target_step: Optional[str] = None


class DecisionRequest(BaseModel):
    note: str = ""


def create_app(configs_dir: Optional[Path] = None, runs_dir: Optional[Path] = None) -> FastAPI:
    configs_dir = Path(configs_dir or os.environ.get("GAME_CONFIGS_DIR", ROOT / "configs"))
    runs_dir = Path(runs_dir or os.environ.get("GAME_RUNS_DIR", ROOT / "runs"))
    analysis = AnalysisConfig.model_validate_json((configs_dir / "analysis_config.json").read_text())
    configs = ConfigService(configs_dir)
    store = TelemetryStore(runs_dir, analysis, configs)

    app = FastAPI(title="Meta Game Onboarding Optimizer", version="0.1.0")
    app.state.configs = configs
    app.state.store = store

    def patch_or_404(patch_id: str):
        try:
            return configs.load_patch(patch_id)
        except PatchNotFoundError:
            raise HTTPException(404, f"Unknown patch {patch_id}")

    def run_or_404(run_id: str):
        try:
            d = store.run_dir(run_id)
        except ValueError:
            raise HTTPException(400, "invalid run_id")
        if not (d / "events.jsonl").exists():
            raise HTTPException(404, f"Unknown run {run_id}")
        return d

    # Config ------------------------------------------------------------
    @app.get("/api/config")
    def get_config(variant: str = "A", patch_id: Optional[str] = None):
        try:
            cfg, meta = configs.resolve(variant, patch_id or None)
        except ApprovalRequiredError as exc:
            raise HTTPException(403, str(exc))
        except PatchNotFoundError:
            raise HTTPException(404, f"Unknown patch {patch_id}")
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {"config": cfg.model_dump(), "meta": meta}

    @app.get("/api/config/schema")
    def config_schema():
        return GameConfig.model_json_schema()

    # Patches and approval gate ------------------------------------------
    @app.get("/api/patches")
    def list_patches():
        return [p.model_dump() for p in configs.list_patches()]

    @app.get("/api/patches/{patch_id}")
    def get_patch(patch_id: str):
        record = patch_or_404(patch_id)
        return {"patch": record.model_dump(), "validation": configs.validation_report(record),
                "audit": configs.audit_entries(patch_id)}

    @app.post("/api/patches", status_code=201)
    def propose_patch(req: ProposeRequest):
        record = configs.propose(req.body, title=req.title, rationale=req.rationale,
                                 target_step=req.target_step, actor="designer_agent")
        return {"patch": record.model_dump(), "validation": configs.validation_report(record)}

    @app.post("/api/patches/{patch_id}/validate")
    def validate_patch(patch_id: str):
        patch_or_404(patch_id)
        return {"patch": configs.validate(patch_id).model_dump()}

    def decide(patch_id: str, decision: str, req: Optional[DecisionRequest]):
        patch_or_404(patch_id)
        try:
            record = configs.decide(patch_id, decision, actor="human", note=(req.note if req else ""))  # type: ignore[arg-type]
        except TransitionError as exc:
            raise HTTPException(409, str(exc))
        return {"patch": record.model_dump(), "audit": configs.audit_entries(patch_id)}

    @app.post("/api/patches/{patch_id}/approve")
    def approve_patch(patch_id: str, req: Optional[DecisionRequest] = Body(None)):
        return decide(patch_id, "approved", req)

    @app.post("/api/patches/{patch_id}/reject")
    def reject_patch(patch_id: str, req: Optional[DecisionRequest] = Body(None)):
        return decide(patch_id, "rejected", req)

    # Telemetry -----------------------------------------------------------
    @app.post("/api/events")
    def post_events(events: Union[list[TelemetryEvent], TelemetryEvent]):
        batch = events if isinstance(events, list) else [events]
        try:
            return {"written": store.ingest(batch)}
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/runs/{run_id}/bot_steps")
    def post_bot_step(run_id: str, step: BotStepRecord):
        if step.run_id != run_id:
            raise HTTPException(400, "run_id mismatch")
        store.append_bot_step(step)
        return {"ok": True}

    @app.get("/api/runs")
    def list_runs():
        return store.list_runs()

    @app.get("/api/runs/{run_id}/live")
    def run_live(run_id: str, since: int = Query(0, ge=0), bot_since: int = Query(0, ge=0)):
        run_or_404(run_id)
        events = store.read_events(run_id)
        bot_steps = store.read_bot_steps(run_id)
        return {"events": events[since:], "next": len(events), "bot_steps": bot_steps[bot_since:],
                "bot_next": len(bot_steps), "summary": store.summary(run_id)}

    @app.get("/api/runs/{run_id}/recording")
    def run_recording(run_id: str):
        """Everything the replay player needs: meta, resolved config, events, bot steps, summary."""
        d = run_or_404(run_id)
        resolved = d / "resolved_config.json"
        return {"meta": store.meta(run_id), "summary": store.summary(run_id),
                "resolved_config": json.loads(resolved.read_text()) if resolved.exists() else None,
                "events": store.read_events(run_id), "bot_steps": store.read_bot_steps(run_id)}

    @app.get("/api/runs/{run_id}/analysis")
    def run_analysis(run_id: str):
        p = run_or_404(run_id) / "analysis.json"
        if not p.exists():
            raise HTTPException(404, "No analyst output for this run yet")
        return json.loads(p.read_text())

    @app.get("/api/ab_summary")
    def ab_summary():
        p = runs_dir / "ab_summary.json"
        if not p.exists():
            raise HTTPException(404, "No A/B experiment has been run yet")
        return json.loads(p.read_text())

    @app.get("/api/personas")
    def personas():
        rows = json.loads((configs_dir / "personas.json").read_text())
        return [Persona.model_validate(r).model_dump() for r in rows]

    @app.exception_handler(ValidationError)
    def on_validation_error(_, exc: ValidationError):
        return JSONResponse(status_code=422, content={"detail": exc.errors(include_url=False)})

    # Static game --------------------------------------------------------
    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
