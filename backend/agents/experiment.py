"""Experiment agent: paired A/B reruns with a canary, a worker pool and exact paired statistics.

Each (persona_id, seed) pair plays once on arm A (baseline) and once on arm B
(the approved patch). One canary session runs first; if it fails the batch stops
before any pool worker starts. Results go to `runs/ab_summary.json` and
`runs/voiceover_sheet.txt`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import random
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional

from ..bot_runner import BotRunner, SessionResult, SessionSpec, load_personas, local_server
from ..config_service import ApprovalRequiredError, ConfigService
from ..meta_client import MetaClient
from ..schemas import ExperimentConfig

BINARY_METRICS = ("onboarding_completed", "first_achievement", "stalled_at_handoff")
CONTINUOUS_METRICS = ("time_to_first_action_sec", "stuck_events", "onboarding_stuck_events", "final_score")
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 20261027
MAX_WORDS_PER_SEC = 2.0
# Narration windows from docs/video-script.md (start label, seconds).
VOICEOVER_SLOTS = {"1:50": 15.0, "2:23": 17.0}
FAILED_STOPS = ("error", "BudgetCapExceededError", "CacheMissError")

SessionFn = Callable[[SessionSpec], Awaitable[SessionResult]]


class CanaryFailedError(RuntimeError):
    pass


class MixedConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Pair:
    persona_id: str
    seed: int


# ------------------------------------------------------------------ stats
def mcnemar_exact(n10: int, n01: int) -> float:
    """Two-sided exact McNemar p-value from the discordant pair counts."""
    n = n10 + n01
    if n == 0:
        return 1.0
    k = min(n10, n01)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def paired_diff_ci(n10: int, n01: int, n: int, z: float = 1.959964) -> tuple[float, float, float]:
    """Difference in paired proportions (B minus A) with a Wald 95% CI, clipped to [-1, 1]."""
    if n == 0:
        return 0.0, 0.0, 0.0
    d = (n01 - n10) / n
    se = math.sqrt(max(0.0, (n01 + n10) - (n01 - n10) ** 2 / n)) / n
    return round(d, 4), round(max(-1.0, d - z * se), 4), round(min(1.0, d + z * se), 4)


def binary_stats(a: list[bool], b: list[bool]) -> dict[str, Any]:
    n = len(a)
    n10 = sum(1 for x, y in zip(a, b) if x and not y)  # A yes, B no
    n01 = sum(1 for x, y in zip(a, b) if y and not x)  # A no, B yes
    diff, lo, hi = paired_diff_ci(n10, n01, n)
    return {"n": n, "a_rate": round(sum(a) / n, 4) if n else None, "b_rate": round(sum(b) / n, 4) if n else None,
            "n10_a_only": n10, "n01_b_only": n01, "mcnemar_exact_p": round(mcnemar_exact(n10, n01), 6),
            "diff_b_minus_a": diff, "ci95": [lo, hi]}


def _percentile(sorted_vals: list[float], q: float) -> float:
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def paired_bootstrap(a: list[Optional[float]], b: list[Optional[float]], *, resamples: int = BOOTSTRAP_RESAMPLES,
                     seed: int = BOOTSTRAP_SEED) -> dict[str, Any]:
    """Median of paired deltas (B minus A) with a percentile bootstrap 95% CI. Pairs with a missing side drop out."""
    deltas = [y - x for x, y in zip(a, b) if x is not None and y is not None]
    if not deltas:
        return {"n": 0, "median_delta": None, "ci95": [None, None]}
    rng = random.Random(seed)
    meds = sorted(statistics.median(rng.choices(deltas, k=len(deltas))) for _ in range(resamples))
    return {"n": len(deltas), "median_delta": round(statistics.median(deltas), 4),
            "ci95": [round(_percentile(meds, 0.025), 4), round(_percentile(meds, 0.975), 4)]}


# ------------------------------------------------------------------ metrics
def session_metrics(summary: dict[str, Any]) -> dict[str, Any]:
    onb = bool(summary.get("onboarding_completed"))
    return {
        "onboarding_completed": onb,
        "first_achievement": bool(summary.get("first_achievement")),
        "stalled_at_handoff": summary.get("where_stuck") == "onb_03_handoff" and not onb,
        "time_to_first_action_sec": summary.get("time_to_first_action_sec"),
        "stuck_events": summary.get("stuck_events"),
        # The narration compares onboarding friction; free-play stalls after the handoff are a separate story.
        "onboarding_stuck_events": sum(n for step, n in (summary.get("stuck_by_step") or {}).items()
                                       if step.startswith("onb_")),
        "final_score": summary.get("final_score"),
        "where_stuck": summary.get("where_stuck"),
        "bronze_age_mastery": bool(summary.get("bronze_age_mastery")),
    }


def build_summary(rows: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, Any]:
    a = [r["A"] for r in rows]
    b = [r["B"] for r in rows]
    where = {arm: {} for arm in ("A", "B")}
    for arm, side in (("A", a), ("B", b)):
        for m in side:
            key = m.get("where_stuck") or "none"
            where[arm][key] = where[arm].get(key, 0) + 1
    return {
        **meta,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_pairs": len(rows),
        "pairs": rows,
        "binary": {k: binary_stats([m[k] for m in a], [m[k] for m in b]) for k in BINARY_METRICS},
        "continuous": {k: paired_bootstrap([m[k] for m in a], [m[k] for m in b]) for k in CONTINUOUS_METRICS},
        "where_stuck": where,
        "mean_stuck_events": {arm: _mean([m["stuck_events"] for m in side]) for arm, side in (("A", a), ("B", b))},
        "mean_onboarding_stuck_events": {arm: _mean([m["onboarding_stuck_events"] for m in side])
                                         for arm, side in (("A", a), ("B", b))},
    }


def _mean(vals: list[Optional[float]]) -> Optional[float]:
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None


# ------------------------------------------------------------------ voiceover
def voiceover_sheet(ab: dict[str, Any], demo: Optional[dict[str, Any]] = None) -> str:
    demo = demo or (ab["pairs"][0] if ab["pairs"] else None)
    demo_stuck = demo["A"]["onboarding_stuck_events"] if demo else 0
    onb = ab["binary"]["onboarding_completed"]
    lines = {
        "1:50": (f"At step onb_03_handoff, the bot logs {demo_stuck} stuck events. The analyst agent pairs "
                 "SAM 3.1 with Muse Spark and flags low Research salience and a wood shortfall."),
        "2:23": (f"The experiment agent reruns the same persona on {ab['n_pairs']} paired seeds. Stuck events go "
                 f"from {_fmt(ab['mean_onboarding_stuck_events']['A'])} to {_fmt(ab['mean_onboarding_stuck_events']['B'])}, and "
                 f"onboarding completion reaches {round((onb['b_rate'] or 0) * 100)} percent."),
    }
    out = [f"Voiceover sheet for experiment {ab.get('experiment_id')} (filled from runs/ab_summary.json)",
           "Stuck counts are onboarding steps only (mean per session at 2:23).", ""]
    for slot, text in lines.items():
        words = len(text.split())
        rate = words / VOICEOVER_SLOTS[slot]
        verdict = "OK" if rate <= MAX_WORDS_PER_SEC else "TOO LONG"
        out += [f"[{slot}] ({VOICEOVER_SLOTS[slot]:.0f} s, {words} words, {rate:.2f} words/sec, {verdict})", text, ""]
    return "\n".join(out)


def _fmt(v: Optional[float]) -> str:
    if v is None:
        return "n/a"
    return str(int(v)) if float(v).is_integer() else f"{v:.1f}"


# ------------------------------------------------------------------ runner
def check_homogeneous(clients: dict[str, MetaClient]) -> None:
    """Both arms must use the same provider mode and Muse model, or the comparison is confounded."""
    modes = {c.provider_mode for c in clients.values()}
    models = {c.muse_model_id for c in clients.values()}
    if len(modes) > 1:
        raise MixedConfigError(f"arms use different provider_mode values: {sorted(modes)}")
    if len(models) > 1:
        raise MixedConfigError(f"arms use different muse_model_id values: {sorted(models)}")


def result_failed(r: SessionResult) -> bool:
    return r.error is not None or r.stop_reason in FAILED_STOPS


class Experiment:
    def __init__(self, *, configs_dir: Path, runs_dir: Path, clients: dict[str, MetaClient],
                 run_type: str = "full_window", worker_pool_size: Optional[int] = None,
                 session_fn: Optional[SessionFn] = None, experiment_id: Optional[str] = None,
                 speed: int = 4) -> None:
        check_homogeneous(clients)
        self.configs_dir, self.runs_dir = Path(configs_dir), Path(runs_dir)
        self.clients = clients
        self.run_type = run_type
        any_client = next(iter(clients.values()))
        self.pool_size = worker_pool_size or any_client.budget.worker_pool_size
        self.session_fn = session_fn
        self.experiment_id = experiment_id or datetime.now(timezone.utc).strftime("exp_%Y%m%d_%H%M%S")
        self.speed = speed
        self.log: list[str] = []

    def pairs_from_config(self, seeds: Optional[list[int]] = None,
                          personas: Optional[list[str]] = None) -> list[Pair]:
        cfg = ExperimentConfig.model_validate_json((self.configs_dir / "experiment_config.json").read_text())
        return [Pair(p, s) for p in (personas or cfg.personas) for s in (seeds or cfg.seeds)]

    def spec(self, pair: Pair, arm: str, variant: str, patch_id: Optional[str]) -> SessionSpec:
        run_id = f"{self.experiment_id}_{arm}_{pair.persona_id}_s{pair.seed}"
        return SessionSpec(variant, pair.persona_id, pair.seed, run_id, patch_id, self.run_type, self.speed,
                           experiment_mode=True)

    async def run(self, pairs: list[Pair], *, patch_id: str, baseline_patch_id: Optional[str] = None,
                  baseline_from: Optional[Path] = None) -> dict[str, Any]:
        """Arm A plays the baseline (variant A, or an earlier approved patch); arm B plays `patch_id`."""
        service = ConfigService(self.configs_dir)
        for pid in filter(None, (patch_id, baseline_patch_id)):
            if service.load_patch(pid).status != "approved":
                raise ApprovalRequiredError(f"{pid} is not approved; the experiment only runs approved patches")
        a_variant = "B" if baseline_patch_id else "A"
        reused = self._reusable_baseline(baseline_from, baseline_patch_id)
        jobs: list[tuple[Pair, str, SessionSpec]] = []
        for pair in pairs:
            if (pair.persona_id, pair.seed) not in reused:
                jobs.append((pair, "A", self.spec(pair, "A", a_variant, baseline_patch_id)))
            jobs.append((pair, "B", self.spec(pair, "B", "B", patch_id)))
        if not jobs:
            raise ValueError("nothing to run")

        results: dict[tuple[Pair, str], SessionResult] = {}
        async with self._session_scope() as run_spec:
            canary_pair, canary_arm, canary_spec = jobs[0]
            self.log.append(f"canary {canary_spec.run_id}")
            canary = await run_spec(canary_spec, canary_arm)
            if result_failed(canary):
                raise CanaryFailedError(f"canary {canary_spec.run_id} failed: {canary.stop_reason} {canary.error}")
            results[(canary_pair, canary_arm)] = canary

            sem = asyncio.Semaphore(self.pool_size)

            async def worker(pair: Pair, arm: str, spec: SessionSpec) -> None:
                async with sem:
                    self.log.append(f"start {spec.run_id}")
                    results[(pair, arm)] = await run_spec(spec, arm)

            await asyncio.gather(*(worker(*job) for job in jobs[1:]))

        rows = []
        for pair in pairs:
            b = results[(pair, "B")]
            a_summary, a_run = reused.get((pair.persona_id, pair.seed)) or (
                results[(pair, "A")].summary, results[(pair, "A")].spec.run_id)
            rows.append({"persona_id": pair.persona_id, "seed": pair.seed,
                         "A": {"run_id": a_run, **session_metrics(a_summary)},
                         "B": {"run_id": b.spec.run_id, **session_metrics(b.summary)},
                         "errors": [r.error for r in (results.get((pair, "A")), b) if r and r.error]})
        client = next(iter(self.clients.values()))
        meta = {"experiment_id": self.experiment_id, "provider_mode": client.provider_mode,
                "muse_model_id": client.muse_model_id, "model_mode": client.model_mode,
                "run_type": self.run_type, "patch_id": patch_id, "baseline": baseline_patch_id or "variant_A",
                "baseline_reused_pairs": len(reused), "worker_pool_size": self.pool_size,
                "cost_usd": round(sum(r.cost_usd for r in results.values()), 6)}
        ab = build_summary(rows, meta)
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        (self.runs_dir / "ab_summary.json").write_text(json.dumps(ab, indent=2) + "\n")
        (self.runs_dir / "voiceover_sheet.txt").write_text(voiceover_sheet(ab))
        return ab

    def _reusable_baseline(self, baseline_from: Optional[Path],
                           baseline_patch_id: Optional[str]) -> dict[tuple[str, int], tuple[dict[str, Any], str]]:
        """Reuse the B arm of an earlier experiment as this experiment's A arm when the setup matches."""
        if not baseline_from or not baseline_patch_id or not Path(baseline_from).exists():
            return {}
        prev = json.loads(Path(baseline_from).read_text())
        client = next(iter(self.clients.values()))
        same = (prev.get("patch_id") == baseline_patch_id and prev.get("provider_mode") == client.provider_mode
                and prev.get("muse_model_id") == client.muse_model_id and prev.get("run_type") == self.run_type)
        if not same:
            raise MixedConfigError("baseline_from does not match this experiment's patch, provider, model or run type")
        return {(r["persona_id"], r["seed"]): (r["B"], r["B"]["run_id"]) for r in prev["pairs"]}

    @contextlib.asynccontextmanager
    async def _session_scope(self) -> AsyncIterator[Callable[[SessionSpec, str], Awaitable[SessionResult]]]:
        """Real sessions share one local server and one browser; each session still gets a fresh context."""
        if self.session_fn is not None:
            fn = self.session_fn

            async def injected(spec: SessionSpec, arm: str) -> SessionResult:
                return await fn(spec)
            yield injected
            return
        from playwright.async_api import async_playwright

        personas = load_personas(self.configs_dir)
        with local_server(self.configs_dir, self.runs_dir) as base_url:
            async with async_playwright() as pw:
                browser = await pw.chromium.launch()
                try:
                    async def real(spec: SessionSpec, arm: str) -> SessionResult:
                        runner = BotRunner(base_url, self._client_for(arm), personas, self.runs_dir)
                        return await runner.run_session(browser, spec)
                    yield real
                finally:
                    await browser.close()

    def _client_for(self, arm: str) -> MetaClient:
        return self.clients.get(arm) or next(iter(self.clients.values()))
