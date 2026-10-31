"""FastAPI app: config/patch service with the human approval gate, telemetry sink, static game.

Run with `uvicorn backend.app:app`. Paths can be overridden with GAME_CONFIGS_DIR and
GAME_RUNS_DIR (tests use temporary copies).
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Literal, Optional, Union

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
from . import feature_studio
from .meta_client import MetaClient
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


class FeatureProposeRequest(BaseModel):
    prompt: str = ""
    mode: Literal["stub", "meta"] = "stub"
    preset_id: Optional[str] = None


class BotHuntRequest(BaseModel):
    persona: str = "impatient_newcomer"
    variant: Literal["A", "B"] = "A"
    seed: int = 42
    speed: int = 4
    play_minutes: int = 20
    record_video: bool = False
    mode: Literal["meta"] = "meta"
    run_type: Literal["onboarding", "full_window"] = "full_window"


class PlaytestRequest(BaseModel):
    patch_id: str
    mode: Literal["stub", "meta"] = "stub"
    personas: Optional[list[str]] = None
    seeds: Optional[list[int]] = None
    run_type: Literal["onboarding", "full_window"] = "full_window"
    speed: int = 4


class ReworkRequest(BaseModel):
    patch_id: str
    mode: Literal["stub", "meta"] = "stub"


def create_app(configs_dir: Optional[Path] = None, runs_dir: Optional[Path] = None) -> FastAPI:
    configs_dir = Path(configs_dir or os.environ.get("GAME_CONFIGS_DIR", ROOT / "configs"))
    runs_dir = Path(runs_dir or os.environ.get("GAME_RUNS_DIR", ROOT / "runs"))
    analysis = AnalysisConfig.model_validate_json((configs_dir / "analysis_config.json").read_text())
    configs = ConfigService(configs_dir)
    store = TelemetryStore(runs_dir, analysis, configs)
    # Committed demo runs, read-only, so a fresh deploy can show results without running bots.
    demo_dir = Path(os.environ.get("GAME_DEMO_RUNS_DIR", ROOT / "runs_demo"))
    demo_store = TelemetryStore(demo_dir, analysis, configs)

    app = FastAPI(title="Meta Game Onboarding Optimizer", version="0.1.0")
    app.state.configs = configs
    app.state.store = store

    def patch_or_404(patch_id: str):
        try:
            return configs.load_patch(patch_id)
        except PatchNotFoundError:
            raise HTTPException(404, f"Unknown patch {patch_id}")

    def locate(run_id: str) -> tuple[TelemetryStore, Path]:
        for s in (store, demo_store):
            try:
                d = s.run_dir(run_id)
            except ValueError:
                raise HTTPException(400, "invalid run_id")
            if (d / "events.jsonl").exists():
                return s, d
        raise HTTPException(404, f"Unknown run {run_id}")

    def run_or_404(run_id: str) -> Path:
        return locate(run_id)[1]

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

    @app.post("/api/runs/{run_id}/video")
    async def post_run_video(run_id: str, request: Request):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty video")
        d = store.run_dir(run_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "video.webm").write_bytes(body)
        return {"ok": True, "bytes": len(body)}

    @app.post("/api/runs/{run_id}/bot_steps")
    def post_bot_step(run_id: str, step: BotStepRecord):
        if step.run_id != run_id:
            raise HTTPException(400, "run_id mismatch")
        store.append_bot_step(step)
        return {"ok": True}

    @app.get("/api/runs")
    def list_runs():
        live = store.list_runs()
        seen = {r.get("run_id") for r in live}
        demo = [r for r in demo_store.list_runs() if r.get("run_id") not in seen] if demo_dir.exists() else []
        return live + demo

    @app.get("/api/runs/{run_id}/live")
    def run_live(run_id: str, since: int = Query(0, ge=0), bot_since: int = Query(0, ge=0)):
        src, _ = locate(run_id)
        events = src.read_events(run_id)
        bot_steps = src.read_bot_steps(run_id)
        return {"events": events[since:], "next": len(events), "bot_steps": bot_steps[bot_since:],
                "bot_next": len(bot_steps), "summary": src.summary(run_id)}

    @app.get("/api/runs/{run_id}/recording")
    def run_recording(run_id: str):
        """Everything the replay player needs: meta, resolved config, events, bot steps, summary."""
        src, d = locate(run_id)
        resolved = d / "resolved_config.json"
        return {"meta": src.meta(run_id), "summary": src.summary(run_id),
                "resolved_config": json.loads(resolved.read_text()) if resolved.exists() else None,
                "events": src.read_events(run_id), "bot_steps": src.read_bot_steps(run_id)}

    @app.get("/api/runs/{run_id}/analysis")
    def run_analysis(run_id: str):
        p = run_or_404(run_id) / "analysis.json"
        if not p.exists():
            raise HTTPException(404, "No analyst output for this run yet")
        out = json.loads(p.read_text())
        if out.get("stuck_frame"):
            out["stuck_frame_url"] = f"/api/runs/{run_id}/artifacts/{out['stuck_frame']}"
        return out

    @app.get("/api/runs/{run_id}/artifacts/{name:path}")
    def run_artifact(run_id: str, name: str):
        """PNG artifacts of a run: stuck_frame.png, frames/step_NNN.png, som_masks/step_NNN.png."""
        d = run_or_404(run_id)
        f = (d / name).resolve()
        if d.resolve() not in f.parents or f.suffix != ".png" or not f.exists():
            raise HTTPException(404, "No such artifact")
        return FileResponse(f, media_type="image/png")

    @app.get("/api/ab_summary")
    def ab_summary():
        for p in (runs_dir / "ab_summary.json", demo_dir / "ab_summary.json"):
            if p.exists():
                return json.loads(p.read_text())
        raise HTTPException(404, "No A/B experiment has been run yet")

    @app.get("/api/personas")
    def personas():
        rows = json.loads((configs_dir / "personas.json").read_text())
        return [Persona.model_validate(r).model_dump() for r in rows]

    # Bug hunting (Meta bot from the browser menu) ----------------------
    bot_hunt_jobs: dict[str, dict[str, Any]] = {}
    app.state.bot_hunt_jobs = bot_hunt_jobs
    # Tests inject fakes here so no browser or model starts.
    app.state.bot_hunt_fn = None
    app.state.bot_hunt_analyze_fn = None

    def _run_bot_hunt(job: dict[str, Any], req: BotHuntRequest) -> None:
        """Playwright Meta-bot session; every artifact lands in runs/<run_id>/
        (frames, bot steps with thoughts, telemetry, video, analysis)."""
        from .bot_runner import SessionSpec, run_session_sync
        run_id = job["run_id"]
        spec = {"variant": req.variant, "persona_id": req.persona, "seed": req.seed,
                "run_id": run_id, "run_type": req.run_type, "speed": req.speed,
                "record_video": req.record_video}
        try:
            if app.state.bot_hunt_fn is not None:
                result = app.state.bot_hunt_fn(spec)
            else:
                client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="meta")
                r = run_session_sync(SessionSpec(**spec), client=client,
                                     configs_dir=configs_dir, runs_dir=runs_dir)
                result = {"stop_reason": r.stop_reason, "steps": r.steps, "cost_usd": r.cost_usd,
                          "error": r.error, "summary": r.summary}
            d = runs_dir / run_id
            artifacts = {
                "frames": len(list((d / "frames").glob("step_*.png"))) if (d / "frames").exists() else 0,
                "bot_steps": len(store.read_bot_steps(run_id)) if d.exists() else 0,
                "events": len(store.read_events(run_id)) if d.exists() else 0,
                "video": (d / "video.webm").exists(),
            }
            saved = {**result, "run_id": run_id, "persona": req.persona, "variant": req.variant,
                     "seed": req.seed, "artifacts": artifacts}
            d.mkdir(parents=True, exist_ok=True)
            (d / "bot_result.json").write_text(json.dumps(saved, indent=2))
            job.update(status="done", stop_reason=result.get("stop_reason"),
                       steps=result.get("steps"), cost_usd=result.get("cost_usd"),
                       artifacts=artifacts)
            if result.get("error"):
                job.update(status="failed", error=result["error"])
                return
            # Save the analyst diagnosis next to the run for the Report step.
            try:
                if app.state.bot_hunt_analyze_fn is not None:
                    app.state.bot_hunt_analyze_fn(run_id)
                else:
                    from .agents.analyst import analyze_run
                    analyze_run(run_id, runs_dir=runs_dir, configs_dir=configs_dir,
                                client=MetaClient(runs_dir=runs_dir, configs_dir=configs_dir,
                                                  provider_mode="stub"))
                job["analysis"] = True
            except Exception as exc:  # the run itself is still saved and usable
                job["analysis_error"] = str(exc)
        except Exception as exc:  # surfaced in the menu, never silent
            job.update(status="failed", error=f"{type(exc).__name__}: {exc}")

    @app.post("/api/bot_hunt", status_code=202)
    def start_bot_hunt(req: BotHuntRequest):
        job_id = uuid.uuid4().hex[:12]
        run_id = f"meta_{req.persona}_s{req.seed}_{job_id[:6]}"
        job = bot_hunt_jobs[job_id] = {"job_id": job_id, "run_id": run_id, "status": "running",
                                       "error": None}
        threading.Thread(target=_run_bot_hunt, args=(job, req), daemon=True).start()
        return job

    @app.get("/api/bot_hunt/{job_id}")
    def bot_hunt_status(job_id: str):
        job = bot_hunt_jobs.get(job_id)
        if job is None:
            raise HTTPException(404, f"Unknown bot hunt {job_id}")
        return job

    # Feature studio ---------------------------------------------------
    jobs: dict[str, dict[str, Any]] = {}
    app.state.studio_jobs = jobs
    # Tests inject a fake session function here so no browser starts.
    app.state.studio_session_fn = None
    app.state.generated_dir = Path(os.environ.get("GAME_GENERATED_DIR", STATIC_DIR / "assets" / "generated"))

    def studio_client(mode: str) -> MetaClient:
        return MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode=mode)

    @app.post("/api/feature_studio/propose", status_code=201)
    def studio_propose(req: FeatureProposeRequest):
        try:
            return feature_studio.propose_feature(req.prompt, configs_dir=configs_dir, client=studio_client(req.mode),
                                                  generated_dir=app.state.generated_dir, preset_id=req.preset_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @app.get("/api/feature_studio/presets")
    def studio_presets():
        """Prebuilt feature ideas for the Game Manager menu, with the plugin fields a card shows."""
        return [{**{k: p[k] for k in ("preset_id", "label", "icon", "summary", "prompt", "recorded_from")},
                 **{k: p["plugin"][k] for k in ("unlock_at_step", "costs", "rewards")}}
                for p in feature_studio.load_presets(configs_dir)]

    @app.get("/api/feature_studio/status")
    def studio_status():
        """Whether a custom idea goes to live Muse Spark or the offline stub designer."""
        client = studio_client("stub")
        return {"meta_ready": bool(os.environ.get("META_API_KEY")), "muse_model_id": client.muse_model_id}

    @app.post("/api/feature_studio/playtest", status_code=202)
    def studio_playtest(req: PlaytestRequest):
        record = patch_or_404(req.patch_id)
        if "feature_plugin" not in record.body:
            raise HTTPException(400, f"{req.patch_id} carries no feature_plugin")
        if record.status != "approved":
            raise HTTPException(403, f"Human approval required: {req.patch_id} is {record.status}")
        job_id = uuid.uuid4().hex[:12]
        log: list[str] = []
        n_pairs = len(req.personas or json.loads((configs_dir / "personas.json").read_text())) * len(req.seeds or [42])
        job = jobs[job_id] = {"job_id": job_id, "patch_id": req.patch_id, "status": "running", "log": log,
                              "sessions_total": 2 * n_pairs, "error": None}

        def work() -> None:
            try:
                feature_studio.run_playtest(req.patch_id, configs_dir=configs_dir, runs_dir=runs_dir,
                                            client=studio_client(req.mode), personas=req.personas,
                                            seeds=req.seeds, run_type=req.run_type, speed=req.speed,
                                            session_fn=app.state.studio_session_fn, on_log=log)
                job["status"] = "done"
            except Exception as exc:  # surfaced to the studio UI
                job.update(status="failed", error=str(exc))
        threading.Thread(target=work, daemon=True).start()
        return studio_job(job_id)

    @app.get("/api/feature_studio/jobs/{job_id}")
    def studio_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, f"Unknown job {job_id}")
        started = [line.split(" ", 1)[1] for line in job["log"] if line.startswith(("start ", "canary "))]
        done = {line.split(" ", 1)[1] for line in job["log"] if line.startswith("done ")}
        sessions = []
        for run_id in started:
            last = (studio_bot_steps(run_id) or [{}])[-1] if run_id in done else {}
            sessions.append({"run_id": run_id, "state": "done" if run_id in done else "playing",
                             "thought": last.get("thought"), "mood": last.get("player_mood")})
        return {**{k: v for k, v in job.items() if k != "log"}, "sessions_started": len(started),
                "sessions": sessions}

    def studio_bot_steps(run_id: str) -> list[dict[str, Any]]:
        """Think-aloud lines, live first, then the committed demo bundle."""
        return store.read_bot_steps(run_id) or demo_store.read_bot_steps(run_id)

    @app.get("/api/feature_studio/report/{patch_id}")
    def studio_report(patch_id: str):
        patch_or_404(patch_id)
        report = feature_studio.build_report(patch_id, configs_dir=configs_dir, runs_dir=runs_dir,
                                             read_bot_steps=studio_bot_steps, demo_dir=demo_dir)
        if report is None:
            raise HTTPException(404, f"No playtest has run for {patch_id} yet")
        return report

    @app.get("/api/feature_studio/demos")
    def studio_demos():
        """Every switchable studio report: live runs first, then the pre-baked `runs_demo/` bundle.

        Powers the 1-click pill bar in the Council Report so judges can flip between
        the naive HURTS rollout and the POSITIVE rework at $0 runtime cost.
        """
        found: dict[str, dict[str, Any]] = {}
        for base, source in ((demo_dir, "demo"), (runs_dir, "live")):
            if not Path(base).exists():
                continue
            for path in sorted(Path(base).glob("studio_*_ab.json")):
                pid = path.name[len("studio_"):-len("_ab.json")]
                if pid in found and found[pid]["source"] == "live":
                    continue
                try:
                    record = configs.load_patch(pid)
                except PatchNotFoundError:
                    continue
                report = feature_studio.build_report(pid, configs_dir=configs_dir, runs_dir=runs_dir,
                                                     read_bot_steps=studio_bot_steps, demo_dir=demo_dir)
                if report is None:
                    continue
                short = ("Council Rework" if record.title.startswith("Rework:")
                         else "Naive Feature" if record.title.startswith("Feature:") else record.title)
                found[pid] = {"patch_id": pid, "title": record.title, "short": short,
                              "verdict_key": report["key"], "verdict_label": report["label"],
                              "source": source, "n_pairs": report.get("n_pairs")}
        return [found[pid] for pid in sorted(found)]

    @app.post("/api/feature_studio/rework", status_code=201)
    def studio_rework(req: ReworkRequest):
        report = studio_report(req.patch_id)
        return feature_studio.propose_rework(report["plugin"], report, configs_dir=configs_dir,
                                             client=studio_client(req.mode))

    @app.exception_handler(ValidationError)
    def on_validation_error(_, exc: ValidationError):
        return JSONResponse(status_code=422, content={"detail": exc.errors(include_url=False)})

    # Static game --------------------------------------------------------
    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.middleware("http")
    async def static_no_cache(request, call_next):
        # Game assets change often during development; always revalidate so
        # players never hear stale cached music or sounds.
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    return app


app = create_app()
