"""Command line entry points for sessions, analysis and the closed loop.

    python -m backend.cli run-session --variant A --persona impatient_newcomer --seed 42 --mode stub [--headed]
    python -m backend.cli run-closed-loop --mode stub --seeds 42,43
    python -m backend.cli analyze --run-id <run_id>
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from .agents.analyst import analyze_run
from .agents.designer import propose_patch
from .agents.experiment import Experiment, Pair
from .bot_runner import SessionSpec, run_one
from .config_service import ConfigService
from .meta_client import MetaClient
from .schemas import ExperimentConfig, PatchRecord

ROOT = Path(__file__).resolve().parents[1]
HumanApprover = Callable[[PatchRecord], bool]


def cli_approver(patch: PatchRecord) -> bool:
    print(f"\n{patch.patch_id}: {patch.title}\n{patch.rationale}\n{json.dumps(patch.body, indent=2)}")
    return input(f"[Approve {patch.patch_id}? y/N] ").strip().lower() in ("y", "yes")


def run_closed_loop(*, mode: str, seeds: list[int], personas: Optional[list[str]] = None,
                    configs_dir: Path = ROOT / "configs", runs_dir: Path = ROOT / "runs",
                    human_approver: HumanApprover = cli_approver, run_type: str = "full_window",
                    worker_pool_size: Optional[int] = None, loop_id: Optional[str] = None) -> dict[str, Any]:
    """Play A, analyze, propose a patch, wait for a human, then rerun paired A/B."""
    cfg = ExperimentConfig.model_validate_json((Path(configs_dir) / "experiment_config.json").read_text())
    personas = personas or ["impatient_newcomer"]
    loop_id = loop_id or datetime.now(timezone.utc).strftime("loop_%Y%m%d_%H%M%S")
    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode=mode)

    play = SessionSpec("A", personas[0], seeds[0] if seeds else cfg.demo_seed, f"{loop_id}_play_A",
                       run_type="onboarding")
    played = asyncio.run(run_one(play, client=client, configs_dir=configs_dir, runs_dir=runs_dir))
    print(f"play A: {play.run_id} stop={played.stop_reason} where_stuck={played.summary.get('where_stuck')}")

    analysis = analyze_run(play.run_id, runs_dir=runs_dir, configs_dir=configs_dir, client=client)
    print(f"analyst: {analysis['diagnosis']}")

    patch = propose_patch(analysis, configs_dir=configs_dir, client=client)
    print(f"designer: {patch.patch_id} status={patch.status}")
    result: dict[str, Any] = {"loop_id": loop_id, "play_run_id": play.run_id, "analysis": analysis,
                              "patch_id": patch.patch_id, "approved": False, "ab_summary": None}
    if patch.status != "validated":
        print(f"{patch.patch_id} did not validate; stopping before the approval gate")
        return result
    if not human_approver(patch):
        ConfigService(configs_dir).decide(patch.patch_id, "rejected", actor="human", note="rejected at CLI gate")
        print(f"{patch.patch_id} rejected by the human; nothing changes")
        return result
    ConfigService(configs_dir).decide(patch.patch_id, "approved", actor="human", note="approved at CLI gate")
    result["approved"] = True

    exp = Experiment(configs_dir=configs_dir, runs_dir=runs_dir, clients={"A": client, "B": client},
                     run_type=run_type, worker_pool_size=worker_pool_size, experiment_id=f"{loop_id}_ab")
    ab = asyncio.run(exp.run([Pair(p, s) for p in personas for s in seeds], patch_id=patch.patch_id))
    result["ab_summary"] = ab
    onb = ab["binary"]["onboarding_completed"]
    print(f"experiment: {ab['n_pairs']} pairs, onboarding A {onb['a_rate']} -> B {onb['b_rate']}, "
          f"where_stuck A {ab['where_stuck']['A']}")
    return result


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run-session", "run-closed-loop", "analyze"):
        p = sub.add_parser(name)
        p.add_argument("--configs-dir", type=Path, default=ROOT / "configs")
        p.add_argument("--runs-dir", type=Path, default=ROOT / "runs")
        if name != "analyze":
            p.add_argument("--mode", choices=["stub", "open_weights", "meta"], default="stub")
            p.add_argument("--run-type", choices=["onboarding", "full_window"],
                           default="onboarding" if name == "run-session" else "full_window")
        if name == "run-session":
            p.add_argument("--variant", choices=["A", "B"], default="A")
            p.add_argument("--patch-id")
            p.add_argument("--persona", default="impatient_newcomer")
            p.add_argument("--seed", type=int, default=42)
            p.add_argument("--run-id")
            p.add_argument("--headed", action="store_true")
        elif name == "run-closed-loop":
            p.add_argument("--seeds", default="42,43")
            p.add_argument("--personas", default="impatient_newcomer")
            p.add_argument("--workers", type=int)
        else:
            p.add_argument("--run-id", required=True)
            p.add_argument("--mode", choices=["stub", "open_weights", "meta"], default="stub")
    args = ap.parse_args(argv)

    if args.cmd == "run-session":
        run_id = args.run_id or f"cli_{args.variant}_{args.persona}_s{args.seed}"
        spec = SessionSpec(args.variant, args.persona, args.seed, run_id, args.patch_id, args.run_type)
        client = MetaClient(runs_dir=args.runs_dir, configs_dir=args.configs_dir, provider_mode=args.mode)
        r = asyncio.run(run_one(spec, client=client, configs_dir=args.configs_dir, runs_dir=args.runs_dir,
                                headed=args.headed))
        print(json.dumps({"run_id": run_id, "stop_reason": r.stop_reason, "steps": r.steps, "error": r.error,
                          "cost_usd": r.cost_usd, **{k: r.summary.get(k) for k in (
                              "where_stuck", "stuck_events", "onboarding_completed", "first_achievement")}}, indent=2))
        return 0 if r.ok else 1
    if args.cmd == "analyze":
        client = MetaClient(runs_dir=args.runs_dir, configs_dir=args.configs_dir, provider_mode=args.mode)
        a = analyze_run(args.run_id, runs_dir=args.runs_dir, configs_dir=args.configs_dir, client=client)
        print(json.dumps({k: a[k] for k in ("where_stuck", "diagnosis", "suggested_levers", "stuck_frame")}, indent=2))
        return 0
    run_closed_loop(mode=args.mode, seeds=[int(s) for s in args.seeds.split(",")],
                    personas=args.personas.split(","), configs_dir=args.configs_dir, runs_dir=args.runs_dir,
                    run_type=args.run_type, worker_pool_size=args.workers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
