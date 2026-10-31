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
    speed: int = 1
    play_minutes: int = 20
    record_video: bool = False
    mode: Literal["meta"] = "meta"
    bot_model: Literal["spark", "wonder"] = "wonder"
    hear_voice: bool = False
    run_type: Literal["onboarding", "full_window"] = "full_window"


class PlaytestRequest(BaseModel):
    patch_id: str
    mode: Literal["stub", "meta"] = "stub"
    bot_model: Literal["spark", "wonder"] = "wonder"
    hear_voice: bool = False
    record_video: bool = False
    personas: Optional[list[str]] = None
    seeds: Optional[list[int]] = None
    run_type: Literal["onboarding", "full_window"] = "full_window"
    speed: int = 1


class SpeakRequest(BaseModel):
    text: str
    persona_id: Optional[str] = None


class ReworkRequest(BaseModel):
    patch_id: str
    mode: Literal["stub", "meta"] = "stub"


class ExperimentRequest(BaseModel):
    patch_id: str
    patch_revision: int = 1
    title: str = ""
    plan: dict[str, Any] = {}
    parent_id: Optional[str] = None
    budget_cap_usd: Optional[float] = None


class PhaseRequest(BaseModel):
    kind: Literal["smoke", "discovery", "confirmation"] = "discovery"
    plan: dict[str, Any] = {}
    planned_pairs: int = 0
    pairs: list[dict[str, Any]] = []


class ExperimentDecisionRequest(BaseModel):
    kind: Literal["approve_test", "reject", "approve_shipping"]
    actor: str = "human"
    phase_id: Optional[str] = None
    reason: str = ""


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

    # Bot voice: ElevenLabs speaks a bot's think-aloud in its persona voice.
    # Generated once per (voice, line) and cached under runs/.cache/tts.
    tts_dir = runs_dir / ".cache" / "tts"

    @app.post("/api/speak")
    def speak(req: SpeakRequest):
        import hashlib
        import httpx as _httpx
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env", override=False)
        key = os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            raise HTTPException(503, "No ELEVENLABS_API_KEY in .env")
        personas = {r["persona_id"]: r for r in json.loads((configs_dir / "personas.json").read_text())}
        voice_id = (personas.get(req.persona_id or "") or {}).get("voice_id") or "B52raBK48m23qWYbwchQ"
        text = req.text.strip()[:200]
        if not text:
            raise HTTPException(400, "Nothing to speak")
        name = hashlib.sha256(f"{voice_id}:{text}".encode()).hexdigest()[:24] + ".mp3"
        tts_dir.mkdir(parents=True, exist_ok=True)
        out = tts_dir / name
        if not out.exists():
            r = _httpx.post(f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
                            headers={"xi-api-key": key, "Content-Type": "application/json"},
                            json={"text": text, "model_id": "eleven_v4",
                                  "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}},
                            timeout=60)
            if r.status_code != 200:
                raise HTTPException(502, f"ElevenLabs failed: HTTP {r.status_code}")
            out.write_bytes(r.content)
        return {"url": f"/api/tts/{name}"}

    @app.get("/api/tts/{name}")
    def tts_file(name: str):
        if not name.endswith(".mp3") or "/" in name or ".." in name:
            raise HTTPException(404, "No such audio")
        f = tts_dir / name
        if not f.exists():
            raise HTTPException(404, "No such audio")
        return FileResponse(f, media_type="audio/mpeg")

    @app.get("/api/runs/{run_id}/bug-report")
    def run_bug_report(run_id: str):
        """Report A for this run only: the saved snapshot if present, else
        built from this run's artifacts and saved. Never another run's data."""
        d = run_or_404(run_id)
        from .bug_report import build_bug_report, save_bug_report
        saved = d / "bug_report.json"
        if saved.exists():
            return json.loads(saved.read_text())
        report = save_bug_report(runs_dir, run_id) or build_bug_report(demo_dir, run_id)
        if report is None:
            raise HTTPException(404, "No bug report for this run yet")
        return report

    app.state.analyze_fn = None

    @app.post("/api/runs/{run_id}/analyze")
    def run_analyze(run_id: str):
        """Write this run's diagnosis with the analyst (Meta model when the
        key is present), then save the bug report next to the run."""
        run_or_404(run_id)
        try:
            if app.state.analyze_fn is not None:
                analysis = app.state.analyze_fn(run_id)
            else:
                from .agents.analyst import analyze_run
                analysis = analyze_run(run_id, runs_dir=runs_dir, configs_dir=configs_dir,
                                       client=analyst_client())
        except Exception as exc:
            raise HTTPException(502, f"Analyst failed: {type(exc).__name__}: {exc}")
        from .bug_report import save_bug_report
        save_bug_report(runs_dir, run_id)
        return analysis

    @app.get("/api/runs/{run_id}/analysis")
    def run_analysis(run_id: str):
        p = run_or_404(run_id) / "analysis.json"
        if not p.exists():
            raise HTTPException(404, "No analyst output for this run yet")
        out = json.loads(p.read_text())
        if out.get("stuck_frame"):
            out["stuck_frame_url"] = f"/api/runs/{run_id}/artifacts/{out['stuck_frame']}"
        return out

    @app.post("/api/runs/{run_id}/stop_hunt")
    def stop_hunt(run_id: str):
        """Stop bot button: the runner polls this flag file each step, ends
        the session, and the saved run still gets its analyst Report."""
        d = run_or_404(run_id)
        (d / "stop_requested").write_text("stopped_by_tester")
        for job in bot_hunt_jobs.values():
            if job.get("run_id") == run_id:
                job["stop_requested"] = True
        return {"run_id": run_id, "stop_requested": True}

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

    def analyst_client() -> MetaClient:
        """The Report is written by the Meta model when the key is present;
        offline stub reasoning only when there is no key."""
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env", override=False)
        mode = "meta" if os.environ.get("META_API_KEY") else "stub"
        return MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode=mode)

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
                "record_video": req.record_video, "hear_voice": req.hear_voice,
                "time_limit_sim_sec": req.play_minutes * 60 * req.speed}
        try:
            if app.state.bot_hunt_fn is not None:
                result = app.state.bot_hunt_fn(spec)
            else:
                client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="meta")
                if req.bot_model == "wonder":
                    client.use_model(client.designer_model_id)
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
                                client=analyst_client())
                job["analysis"] = True
            except Exception as exc:  # the run itself is still saved and usable
                job["analysis_error"] = str(exc)
            # The bug report is saved too, next to the run, like the analysis.
            try:
                from .bug_report import save_bug_report
                if save_bug_report(runs_dir, run_id):
                    job["bug_report"] = True
            except Exception as exc:
                job["bug_report_error"] = str(exc)
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
        return {"meta_ready": bool(os.environ.get("META_API_KEY")), "muse_model_id": client.muse_model_id,
                "designer_model_id": client.designer_model_id}

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
                client = studio_client(req.mode)
                if req.bot_model == "wonder":
                    client.use_model(client.designer_model_id)
                feature_studio.run_playtest(req.patch_id, configs_dir=configs_dir, runs_dir=runs_dir,
                                            client=client, personas=req.personas,
                                            seeds=req.seeds, run_type=req.run_type, speed=req.speed,
                                            session_fn=app.state.studio_session_fn, on_log=log,
                                            hear_voice=req.hear_voice,
                                            record_video=req.record_video)
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

    # Experiments: saved, frozen A/B plans (Astra studio design, section 3).
    from .studio_store import StudioStore
    studio = StudioStore(runs_dir / "studio.sqlite")
    app.state.studio_store = studio

    def experiment_or_404(experiment_id: str) -> dict[str, Any]:
        exp = studio.get_experiment(experiment_id)
        if exp is None:
            raise HTTPException(404, f"Unknown experiment {experiment_id}")
        return exp

    @app.post("/api/experiments", status_code=201)
    def create_experiment(req: ExperimentRequest):
        return studio.create_experiment(patch_id=req.patch_id, patch_revision=req.patch_revision,
                                        title=req.title, plan=req.plan, parent_id=req.parent_id,
                                        budget_cap_usd=req.budget_cap_usd)

    @app.get("/api/experiments")
    def list_experiments():
        return studio.list_experiments()

    @app.get("/api/bug_reports")
    def list_bug_reports():
        """Past bug hunts with a saved report, newest first."""
        from .bug_report import build_bug_report
        from datetime import datetime, timezone
        out = []
        if runs_dir.exists():
            for d in (x for x in runs_dir.iterdir() if x.is_dir()):
                saved = d / "bug_report.json"
                analysis = d / "analysis.json"
                stamp = saved if saved.exists() else analysis if analysis.exists() else None
                if stamp is None:
                    continue
                saved_at = datetime.fromtimestamp(stamp.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
                if saved.exists():
                    try:
                        report = json.loads(saved.read_text())
                    except Exception:
                        continue
                else:
                    report = build_bug_report(runs_dir, d.name)
                    if not report:
                        continue
                # The listing time is when the report was saved, not when
                # this list was rendered.
                report = {**report, "generated_at": saved_at, "saved_at": saved_at}
                out.append(report)
            out.sort(key=lambda r: r["saved_at"], reverse=True)
        return out[:20]

    @app.get("/api/experiments/{experiment_id}")
    def get_experiment(experiment_id: str):
        return experiment_or_404(experiment_id)

    @app.post("/api/experiments/{experiment_id}/decisions", status_code=201)
    def experiment_decision(experiment_id: str, req: ExperimentDecisionRequest):
        exp = experiment_or_404(experiment_id)
        return studio.add_decision(experiment_id, kind=req.kind, actor=req.actor,
                                   phase_id=req.phase_id, plan_hash=exp["plan_hash"],
                                   reason=req.reason)

    @app.post("/api/experiments/{experiment_id}/phases", status_code=201)
    def create_phase(experiment_id: str, req: PhaseRequest):
        experiment_or_404(experiment_id)
        phase = studio.create_phase(experiment_id, kind=req.kind, plan=req.plan,
                                    planned_pairs=req.planned_pairs or len(req.pairs))
        for spec in req.pairs:
            studio.add_pair(phase["phase_id"], persona_id=spec["persona_id"],
                            game_seed=int(spec["game_seed"]),
                            repetition=int(spec.get("repetition", 1)),
                            run_order=spec.get("run_order", "AB"))
        return {**phase, "pairs": studio.phase_runs(phase["phase_id"])}

    @app.post("/api/experiments/{experiment_id}/phases/{phase_id}/link", status_code=201)
    def link_phase_run(experiment_id: str, phase_id: str, body: dict[str, Any] = Body(...)):
        experiment_or_404(experiment_id)
        studio.link_run(body["pair_id"], body["run_id"], body["variant"],
                        attempt=int(body.get("attempt", 1)),
                        selected=bool(body.get("selected", True)),
                        exclusion_reason=body.get("exclusion_reason"))
        return {"linked": body["run_id"], "pair_id": body["pair_id"]}

    @app.get("/api/experiments/{experiment_id}/runs")
    def experiment_runs(experiment_id: str):
        exp = experiment_or_404(experiment_id)
        phase_id = exp.get("active_phase")
        return studio.phase_runs(phase_id) if phase_id else []

    @app.get("/api/experiments/{experiment_id}/report")
    def experiment_report(experiment_id: str):
        from .agents.experiment import phase_verdict, session_metrics
        exp = experiment_or_404(experiment_id)
        phase_id = exp.get("active_phase")
        if not phase_id:
            return {**exp, "verdict": {"verdict": "incomplete", "reason": "No phase planned yet",
                                       "planned_pairs": 0, "n": 0}}
        phase = next(p for p in exp["phases"] if p["phase_id"] == phase_id)
        by_pair: dict[str, dict[str, Any]] = {}
        inventory = []
        for link in studio.phase_runs(phase_id):
            if not link.get("run_id"):
                continue
            summary = store.summary(link["run_id"]) or {}
            metrics = session_metrics(summary)
            inventory.append({**link, "metrics": metrics})
            if link["selected"]:
                by_pair.setdefault(link["pair_id"], {})[link["variant"]] = metrics
        complete = [p for p in by_pair.values() if "A" in p and "B" in p]
        a = [bool(p["A"]["onboarding_completed"]) for p in complete]
        b = [bool(p["B"]["onboarding_completed"]) for p in complete]
        verdict = phase_verdict(a, b, int(phase["planned_pairs"]),
                                threshold=float(exp["plan"].get("improvement_threshold", 0.10)))
        result = {"experiment_id": experiment_id, "title": exp["title"], "status": exp["status"],
                  "patch_id": exp["patch_id"], "patch_revision": exp["patch_revision"],
                  "phase": {"phase_id": phase_id, "kind": phase["kind"],
                            "planned_pairs": phase["planned_pairs"]},
                  "primary_metric": exp["plan"].get("primary_metric", "onboarding_completed"),
                  "verdict": verdict, "run_inventory": inventory,
                  "decisions": exp["decisions"]}
        studio.save_report(experiment_id, phase_id, result)
        return result

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
