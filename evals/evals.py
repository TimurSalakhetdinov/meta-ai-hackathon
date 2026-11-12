"""Benchmark runner: baseline (raw single-turn LLM) vs agent pipeline.

Stub mode is the default and costs $0: both variants are deterministic
stand-ins grounded in the case telemetry — the baseline is a deliberately
naive single-pass heuristic that misreads fast play and misses root causes,
the agent is the structured tool pipeline (``query_telemetry`` ->
``analyze_dropoff`` -> ``synthesize_patch``) with rule-based diagnosis over
the same events. Stub numbers are an offline CI smoke test, never portfolio
evidence.

Meta mode is the real benchmark. The baseline is one raw Muse call over the
unsorted telemetry (no tools, no memory, one shot at status + issues +
patch). The agent pipeline runs its tools for real: ``query_telemetry``
(code: sorts events and computes the drop-off summary), ``analyze_dropoff``
(a Muse analyst call over that tool output), and ``synthesize_patch``
(a second Muse designer call, only when a bottleneck was found). The patch
judge is a live Muse call too. Every live call goes through
``MetaClient.reason_json_detailed`` with the response cache bypassed, so
repeated runs measure the model; token counts, latency and cost are the
API's real usage, priced from ``configs/budget_config.json`` and charged to
its ledger caps (a preflight estimate refuses a run that would cross the
global stop).

Usage:
    python -m evals.evals --dataset evals/eval_dataset.json --runs 3 --mode stub
    python -m evals.evals --compare-baseline --output runs/evals_summary.json
    python -m evals.evals --mode meta --compare-baseline --runs 3 --output runs/evals_meta_summary.json
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Optional

from .assertions import percentile, precision_recall, run_deterministic_checks
from .judge import judge_patch
from .schemas import (CaseRunResult, CaseSummary, CheckResult, Diagnosis, EvalCase,
                      EvalDataset, EvalReport, Issue, PatchRecommendation, VariantSummary)

ROOT = Path(__file__).resolve().parents[1]
AGENT_TOOLS = ["query_telemetry", "analyze_dropoff"]
PATCH_TOOL = "synthesize_patch"
LABELS = {"baseline": "Baseline (Raw LLM)", "agent": "Agent Pipeline"}


# --------------------------------------------------------------------- data
def load_dataset(path: Path) -> EvalDataset:
    return EvalDataset.model_validate_json(Path(path).read_text())


def _pricing(configs_dir: Path) -> tuple[float, float]:
    """(input, output) USD per token for the playtester model, from budget_config."""
    try:
        budget = json.loads((Path(configs_dir) / "budget_config.json").read_text())
        rates = budget["pricing_usd"][budget["muse_model_id"]]
        return rates["input_per_1m"] / 1e6, rates["output_per_1m"] / 1e6
    except (OSError, KeyError, TypeError, ValueError):
        return 0.0, 0.0


def _tokens(case: EvalCase, variant: str) -> tuple[int, int]:
    """Deterministic token estimate: telemetry size plus per-tool overhead."""
    base = max(1, len(json.dumps([e.model_dump(mode="json") for e in case.telemetry])) // 4)
    if variant == "agent":
        return (base + 400) * 3, 220
    return base + 200, 120


def _cost(case: EvalCase, variant: str, rates: tuple[float, float]) -> tuple[int, int, float]:
    prompt, completion = _tokens(case, variant)
    return prompt, completion, round(prompt * rates[0] + completion * rates[1], 6)


def _events(case: EvalCase) -> list[dict[str, Any]]:
    """Events sorted by sim time; out-of-order arrivals (tc_07) are noise, not signal."""
    return sorted((e.model_dump(mode="json") for e in case.telemetry),
                  key=lambda e: e["sim_elapsed_sec"])


def _has_session_end(events: list[dict[str, Any]]) -> bool:
    return any(e["event_type"] == "session_end" for e in events)


# ------------------------------------------------------------------- agent
def agent_diagnose(case: EvalCase, rates: tuple[float, float]) -> Diagnosis:
    """Structured pipeline: query the telemetry, analyse the drop-off, then
    (only for a bottleneck) synthesise a patch. Rules, not case ids: each
    issue fires on telemetry signals any real session could produce."""
    t0 = time.perf_counter()
    events = _events(case)
    prompt, completion, cost = _cost(case, "agent", rates)

    if not _has_session_end(events):
        return Diagnosis(status="INCONCLUSIVE_DATA", tool_trajectory=list(AGENT_TOOLS),
                         latency_sec=time.perf_counter() - t0, prompt_tokens=prompt,
                         completion_tokens=completion, est_cost_usd=cost)

    issues: list[Issue] = []
    patch: Optional[PatchRecommendation] = None

    def add(issue: Issue, recommendation: PatchRecommendation) -> None:
        nonlocal patch
        issues.append(issue)
        if patch is None:
            patch = recommendation

    spends = [e for e in events if e["payload"].get("result") == "spend"
              and e["payload"].get("resource") == "wood" and e["payload"].get("amount", 0) >= 20]
    wood_rejections = [e for e in events if e["event_type"] == "action_rejected"
                       and e["payload"].get("reason") == "insufficient_wood"]
    if spends and wood_rejections:
        step = spends[0]["step_id"]
        add(Issue(issue_id="premature_combat_unlock_resource_starvation", step_id=step, severity="high",
                  evidence=f"spent {spends[0]['payload']['amount']} wood on a combat feature at {step}, "
                           f"then {len(wood_rejections)} insufficient_wood rejections for Basic Toolmaking"),
            PatchRecommendation(
                changes={"feature_plugin.unlock_at_step": "free_play"},
                rationale=(f"Raider Ambush unlocks at {step} and its wood cost starves Basic Toolmaking; "
                           "move the premature combat unlock to free_play (Designer rework, patch_006).")))

    idle_stalls = [e for e in events if e["payload"].get("worker_assigned") is False
                   and (e["payload"].get("idle_sec", 0) >= 30 or e["event_type"] == "stuck")]
    if idle_stalls:
        step = idle_stalls[0]["step_id"]
        add(Issue(issue_id="missing_worker_allocation_guidance", step_id=step, severity="high",
                  evidence=f"worker unassigned with {idle_stalls[0]['payload'].get('idle_sec', 0)}s idle "
                           f"and no hint shown at {step}"),
            PatchRecommendation(
                changes={"idle_hint_delay_sec": 6.0, "show_worker_warnings": True},
                rationale=(f"At {step} Elder Kaelen never explains worker allocation and the player "
                           "idles; surface the worker warning and hint sooner.")))

    flag_rejections = [e for e in events if e["event_type"] == "action_rejected"
                       and e["payload"].get("reason") == "quest_flag_missing"]
    if flag_rejections:
        step = flag_rejections[0]["step_id"]
        add(Issue(issue_id="elder_handoff_trigger_missing_fallback", step_id=step, severity="high",
                  evidence=f"{len(flag_rejections)} Elder clicks rejected with quest_flag_missing at {step}; "
                           "onb_03_handoff never entered"),
            PatchRecommendation(
                changes={"elder_handoff_fallback_enabled": True},
                rationale=(f"The Elder handoff trigger at {step} deadlocks on an unset quest flag; "
                           "add a fallback event transition into onb_03_handoff.")))

    locked_clicks = [e for e in events if e["event_type"] == "click" and e["payload"].get("locked")]
    if len(locked_clicks) >= 4:
        step = locked_clicks[0]["step_id"]
        add(Issue(issue_id="locked_ui_click_spam_frustration", step_id=step, severity="medium",
                  evidence=f"{len(locked_clicks)} rapid clicks on locked UI at {step} after timestamp reordering"),
            PatchRecommendation(
                changes={"research_button_salience": "high_pulse"},
                rationale=(f"Repeated locked-button clicks at {step} signal UI frustration; raise the "
                           "Research goal's salience so the unlocked path is the obvious one.")))

    tools = list(AGENT_TOOLS) + ([PATCH_TOOL] if patch else [])
    return Diagnosis(status="BOTTLENECK" if issues else "HEALTHY", issues=issues,
                     tool_trajectory=tools, patch=patch,
                     latency_sec=time.perf_counter() - t0, prompt_tokens=prompt,
                     completion_tokens=completion, est_cost_usd=cost)


# ---------------------------------------------------------------- baseline
def baseline_diagnose(case: EvalCase, rates: tuple[float, float]) -> Diagnosis:
    """Raw single-turn LLM stand-in: one pass, no tools, no trajectory.

    It pattern-matches surface signals, so it hallucinates on efficient play,
    names symptoms instead of root causes, and guesses on truncated logs.
    That is the uplift the agent pipeline is measured against.
    """
    t0 = time.perf_counter()
    events = _events(case)
    prompt, completion, cost = _cost(case, "baseline", rates)
    tools = ["single_turn_llm"]

    def done(status: str, issues: list[Issue], patch: Optional[PatchRecommendation]) -> Diagnosis:
        return Diagnosis(status=status, issues=issues, tool_trajectory=tools, patch=patch,
                         latency_sec=time.perf_counter() - t0, prompt_tokens=prompt,
                         completion_tokens=completion, est_cost_usd=cost)

    if not _has_session_end(events):
        return done("BOTTLENECK", [Issue(issue_id="session_drop_bottleneck",
                                         evidence="session ended early")],
                    PatchRecommendation(changes={"idle_hint_delay_sec": 6.0},
                                        rationale="The session dropped, so show hints sooner."))

    locked_clicks = [e for e in events if e["event_type"] == "click" and e["payload"].get("locked")]
    if len(locked_clicks) >= 4:
        return done("BOTTLENECK", [Issue(issue_id="locked_ui_click_spam_frustration",
                                         step_id=locked_clicks[0]["step_id"],
                                         evidence="many clicks on locked buttons")],
                    PatchRecommendation(changes={"research_button_salience": "high_pulse"},
                                        rationale="Player repeatedly clicked locked controls at "
                                                  "onb_02_forager; make Research pulse."))

    idle_stalls = [e for e in events if e["payload"].get("worker_assigned") is False
                   and e["payload"].get("idle_sec", 0) >= 30]
    if idle_stalls:
        return done("BOTTLENECK", [Issue(issue_id="missing_worker_allocation_guidance",
                                         step_id=idle_stalls[0]["step_id"],
                                         evidence="long idle with no worker assigned")],
                    PatchRecommendation(changes={"idle_hint_delay_sec": 6.0},
                                        rationale="Long idle at onb_01_shelter; show the hint sooner."))

    wood_rejections = [e for e in events if e["event_type"] == "action_rejected"
                       and e["payload"].get("reason") == "insufficient_wood"]
    if wood_rejections:
        return done("BOTTLENECK", [Issue(issue_id="wood_shortfall",
                                         step_id=wood_rejections[0]["step_id"],
                                         evidence="insufficient_wood rejections")],
                    PatchRecommendation(changes={"research_toolmaking_wood_cost": 20},
                                        rationale="Not enough wood for Basic Toolmaking; lower its cost."))

    woodcutter = [e for e in events if e["payload"].get("target_id") == "card_woodcutter_hut"]
    if woodcutter:
        return done("BOTTLENECK", [Issue(issue_id="optional_build_resource_drain",
                                         step_id=woodcutter[0]["step_id"],
                                         evidence="optional Woodcutter Hut built")],
                    PatchRecommendation(changes={"optional_woodcutter_cost": 45},
                                        rationale="The optional hut drains wood; raise its cost."))

    return done("HEALTHY", [], None)


DIAGNOSERS = {"baseline": baseline_diagnose, "agent": agent_diagnose}


# ------------------------------------------------------------- live (meta)
ISSUE_TAXONOMY = [
    "premature_combat_unlock_resource_starvation",  # paid feature spend starves a required research/build
    "missing_worker_allocation_guidance",           # idle stall, worker unassigned, no hint shown
    "elder_handoff_trigger_missing_fallback",       # quest-flag rejection blocks the Elder handoff
    "locked_ui_click_spam_frustration",             # repeated rapid clicks on locked UI
    "wood_shortfall", "optional_build_resource_drain", "unclear_next_step", "session_drop_bottleneck",
]

_DIAGNOSIS_SHAPE = ('{"status": "HEALTHY"|"BOTTLENECK"|"INCONCLUSIVE_DATA", '
                    '"issues": [{"issue_id": str, "step_id": str|null, '
                    '"severity": "low"|"medium"|"high", "evidence": str}], '
                    '"patch": {"changes": {lever: value}, "rationale": str} | null}')

BASELINE_SYSTEM = f"""You are a game UX analyst seeing ONE playtest session of the browser
city-builder Hearths of the Glen. Onboarding steps: onb_01_shelter, onb_02_forager,
onb_03_handoff, then free_play. You get the raw telemetry in a single turn: no tools,
no follow-up questions. Reply with JSON only, in exactly this shape:
{_DIAGNOSIS_SHAPE}
Rules: status is HEALTHY when onboarding completes without obstruction (report no
issues and patch null); INCONCLUSIVE_DATA when the log is truncated or has no
session_end (no guessed bottleneck, patch null); BOTTLENECK when the player stalls.
For a bottleneck pick the closest issue_id from this taxonomy (or a short snake_case
id of your own): {", ".join(ISSUE_TAXONOMY)}. Name the root cause, not just the
symptom. A patch proposes config lever changes as a flat object; use real lever
names where you can (e.g. feature_plugin.unlock_at_step, research_toolmaking_wood_cost,
idle_hint_delay_sec, show_worker_warnings, research_button_salience,
optional_woodcutter_cost, starting_wood) and say in the rationale which step and
mechanism it fixes."""

ANALYST_SYSTEM = f"""You are the Analyst agent in a playtesting pipeline for the browser
city-builder Hearths of the Glen (onboarding: onb_01_shelter, onb_02_forager,
onb_03_handoff, then free_play). You receive the output of the query_telemetry tool:
sim-time-sorted events plus a computed drop-off summary. Reply with JSON only:
{{"status": "HEALTHY"|"BOTTLENECK"|"INCONCLUSIVE_DATA",
  "issues": [{{"issue_id": str, "step_id": str|null, "severity": "low"|"medium"|"high",
               "evidence": str}}]}}
Rules: HEALTHY means onboarding completed without obstruction (issues empty).
INCONCLUSIVE_DATA means the telemetry is truncated or lacks session_end; never guess
a bottleneck from incomplete data. For a BOTTLENECK pick the closest issue_id from
this taxonomy (or a short snake_case id of your own): {", ".join(ISSUE_TAXONOMY)}.
Name the root cause behind the drop-off summary (what the player did, spent or
waited on before the stall), not just the symptom, and cite the step it happened at."""

DESIGNER_SYSTEM = """You are the Designer agent. Given an Analyst diagnosis of a stalled
Hearths of the Glen onboarding session, propose ONE minimal config patch. Reply with
JSON only: {"changes": {lever: value, ...}, "rationale": str}. Use real GameConfig
lever names where you can: feature_plugin.unlock_at_step (a step id or "free_play"),
feature_plugin.costs.wood, research_toolmaking_wood_cost, idle_hint_delay_sec,
show_worker_warnings, research_button_salience ("low"|"medium"|"high_pulse"),
lock_optional_builds_until_step. For a broken quest/dialogue trigger with no config
lever, a descriptive snake_case lever is acceptable. The rationale must name the
stuck step and the mechanism it fixes. Change as little as possible; never gate or
reprice unrelated onboarding content."""


def _telemetry_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    """The query_telemetry tool's computed output: what the analyst LLM reasons over."""
    counts: dict[str, int] = {}
    for e in events:
        counts[e["event_type"]] = counts.get(e["event_type"], 0) + 1
    rejections = [e["payload"].get("reason") for e in events if e["event_type"] == "action_rejected"]
    return {
        "event_count": len(events),
        "has_session_end": _has_session_end(events),
        "counts_by_type": counts,
        "steps_seen": sorted({e["step_id"] for e in events if e.get("step_id")}),
        "stuck_events": counts.get("stuck", 0),
        "rejection_reasons": sorted({r for r in rejections if r}),
        "max_idle_sec": max((e["payload"].get("idle_sec", 0) for e in events), default=0),
        "locked_click_count": sum(1 for e in events if e["event_type"] == "click"
                                  and e["payload"].get("locked")),
        "wood_spends": [e["payload"] for e in events if e["payload"].get("result") == "spend"],
        "onboarding_completed": any(e["payload"].get("onboarding_completed") for e in events),
    }


def _coerce_diagnosis(raw: Any, tools: list[str], *, latency_sec: float, prompt_tokens: int,
                      completion_tokens: int, cost: float) -> tuple[Diagnosis, bool]:
    """Model JSON -> Diagnosis. Invalid pieces are dropped and flagged, never fatal:
    a malformed live reply becomes a failed schema check, not a crashed benchmark."""
    schema_ok = isinstance(raw, dict)
    raw = raw if isinstance(raw, dict) else {}
    status = raw.get("status")
    if status not in ("HEALTHY", "BOTTLENECK", "INCONCLUSIVE_DATA"):
        schema_ok, status = False, "INCONCLUSIVE_DATA"
    issues: list[Issue] = []
    for item in raw.get("issues") or []:
        try:
            issues.append(Issue.model_validate(item))
        except Exception:
            schema_ok = False
    patch = None
    if raw.get("patch") is not None:
        try:
            patch = PatchRecommendation.model_validate(raw["patch"])
        except Exception:
            schema_ok = False
    return Diagnosis(status=status, issues=issues, tool_trajectory=tools, patch=patch,
                     latency_sec=latency_sec, prompt_tokens=prompt_tokens,
                     completion_tokens=completion_tokens, est_cost_usd=round(cost, 6)), schema_ok


class LivePipeline:
    """Real Muse diagnoses over MetaClient, cache bypassed, usage measured.

    ``client`` is anything with ``reason_json_detailed`` (the real MetaClient in
    meta mode; a fake in tests, so the wiring is testable at $0).
    """

    def __init__(self, client: Any) -> None:
        self.client = client
        self.judge_costs: dict[str, float] = {}
        self.judge_context: str = "agent"      # set by the runner before each scored run
        self.judge_run_id: str = "evals-judge"

    def _call(self, system: str, user: str, run_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        detailed = self.client.reason_json_detailed(
            system, user, stub_result={}, run_id=run_id, bucket="analysis", use_cache=False)
        usage = {"prompt_tokens": int(detailed.get("prompt_tokens", 0)),
                 "completion_tokens": int(detailed.get("completion_tokens", 0)),
                 "cost": float(detailed.get("estimated_cost_usd", 0.0))}
        return detailed.get("result") or {}, usage

    @staticmethod
    def _finish(raw: Any, tools: list[str], t0: float, usages: list[dict[str, Any]],
                ) -> tuple[Diagnosis, bool]:
        return _coerce_diagnosis(
            raw, tools, latency_sec=time.perf_counter() - t0,
            prompt_tokens=sum(u["prompt_tokens"] for u in usages),
            completion_tokens=sum(u["completion_tokens"] for u in usages),
            cost=sum(u["cost"] for u in usages))

    def baseline(self, case: EvalCase, run_index: int) -> tuple[Diagnosis, bool]:
        """Raw LLM: one call over the telemetry exactly as recorded (unsorted)."""
        t0 = time.perf_counter()
        telemetry = [e.model_dump(mode="json") for e in case.telemetry]
        raw, usage = self._call(BASELINE_SYSTEM, json.dumps({"telemetry": telemetry}),
                                f"evals-baseline-{case.case_id}-r{run_index}")
        return self._finish(raw, ["single_turn_llm"], t0, [usage])

    def agent(self, case: EvalCase, run_index: int) -> tuple[Diagnosis, bool]:
        """Tool pipeline: query_telemetry (code) -> analyst LLM -> designer LLM."""
        t0 = time.perf_counter()
        run_id = f"evals-agent-{case.case_id}-r{run_index}"
        events = _events(case)  # query_telemetry tool: sort + summarise in code
        tool_output = {"events": events, "summary": _telemetry_summary(events)}
        raw, usage = self._call(ANALYST_SYSTEM, json.dumps(tool_output), run_id)
        diagnosis, schema_ok = self._finish(raw, list(AGENT_TOOLS), t0, [usage])
        if diagnosis.status != "BOTTLENECK":
            return diagnosis, schema_ok
        # synthesize_patch tool: a separate designer call over the diagnosis.
        patch_raw, patch_usage = self._call(
            DESIGNER_SYSTEM,
            json.dumps({"diagnosis": diagnosis.model_dump(mode="json"),
                        "summary": tool_output["summary"]}), run_id)
        try:
            diagnosis.patch = PatchRecommendation.model_validate(patch_raw)
        except Exception:
            schema_ok = False
        diagnosis.tool_trajectory = [*AGENT_TOOLS, PATCH_TOOL]
        diagnosis.prompt_tokens += patch_usage["prompt_tokens"]
        diagnosis.completion_tokens += patch_usage["completion_tokens"]
        diagnosis.est_cost_usd = round(diagnosis.est_cost_usd + patch_usage["cost"], 6)
        diagnosis.latency_sec = time.perf_counter() - t0
        return diagnosis, schema_ok

    def judge_reason(self, system: str, user: str) -> dict[str, Any]:
        """Live judge; its real cost is tracked per variant for the report total."""
        detailed = self.client.reason_json_detailed(
            system, user, stub_result={"verdict": "FAIL", "reasons": ["no live verdict"]},
            run_id=self.judge_run_id, bucket="analysis", use_cache=False)
        self.judge_costs[self.judge_context] = round(
            self.judge_costs.get(self.judge_context, 0.0)
            + float(detailed.get("estimated_cost_usd", 0.0)), 6)
        return detailed.get("result") or {}


def _make_live_pipeline(configs_dir: Path) -> LivePipeline:
    from backend.meta_client import MetaClient

    client = MetaClient(runs_dir=ROOT / "runs", configs_dir=configs_dir, provider_mode="meta")
    if client.provider_mode != "meta":
        raise RuntimeError("--mode meta needs META_PROVIDER=meta (or unset) and META_API_KEY in .env")
    return LivePipeline(client)


def _preflight_budget(live: LivePipeline, dataset: EvalDataset, runs: int,
                      variants: list[str]) -> float:
    """Worst-case live spend at the client's pre-call estimate; refuse to cross
    the budget's global stop. Returns the estimate in USD."""
    client = live.client
    budget = getattr(client, "budget", None)
    if budget is None:
        return 0.0
    per_call = client.muse_cost(budget.muse_est_input_tokens, budget.muse_max_output_tokens)
    calls_per_case = {"baseline": 1, "agent": 2}
    judge_calls = 1
    worst_calls = sum((calls_per_case[v] + judge_calls) * len(dataset.cases) * runs for v in variants)
    estimate = round(worst_calls * per_call, 4)
    spent = float(client.ledger.totals()["global"]) if hasattr(client, "ledger") else 0.0
    if spent + estimate > budget.global_stop_usd:
        raise RuntimeError(
            f"preflight: ledger already at ${spent:.2f}; worst-case +${estimate:.2f} would cross "
            f"the global stop ${budget.global_stop_usd:.2f} in configs/budget_config.json")
    return estimate


# ------------------------------------------------------------------ scoring
def score_run(case: EvalCase, variant: str, run_index: int, diagnosis: Diagnosis,
              mode: str, reason_fn: Optional[Any] = None, schema_valid: bool = True) -> CaseRunResult:
    checks = run_deterministic_checks(case, diagnosis)
    if not schema_valid:
        checks = [CheckResult(name="diagnosis_schema", passed=False,
                              detail="live model reply did not validate against the Diagnosis schema"),
                  *checks]
    if variant == "baseline":
        # Trajectory adherence measures the agent's tool use; a raw LLM has none to adhere to.
        checks = [c for c in checks if c.name != "tool_trajectory"]
    verdict = judge_patch(case, diagnosis, reason_fn if mode == "meta" else None)
    passed = all(c.passed for c in checks) and verdict.verdict == "PASS"
    return CaseRunResult(case_id=case.case_id, variant=variant, run_index=run_index,  # type: ignore[arg-type]
                         passed=passed, checks=checks, diagnosis=diagnosis,
                         judge_verdict=verdict.verdict, judge_reasons=verdict.reasons)


def _variant_summary(dataset: EvalDataset, results: list[CaseRunResult], variant: str) -> VariantSummary:
    mine = [r for r in results if r.variant == variant]
    case_summaries = {s.case_id: s for s in _case_summaries(dataset, results, variant)}
    precision, recall = precision_recall(dataset.cases, results, variant)
    latencies = [r.diagnosis.latency_sec for r in mine]
    return VariantSummary(
        variant=variant, label=LABELS[variant],  # type: ignore[arg-type]
        cases_passed=sum(1 for s in case_summaries.values() if s.passed),
        total_cases=len(dataset.cases),
        pass_rate=round(sum(1 for s in case_summaries.values() if s.passed) / len(dataset.cases), 4),
        precision=precision, recall=recall,
        latency_p50_sec=round(percentile(latencies, 50), 6),
        latency_p95_sec=round(percentile(latencies, 95), 6),
        est_cost_per_run_usd=round(statistics.mean(r.diagnosis.est_cost_usd for r in mine), 6) if mine else 0.0,
        tokens_per_run=round(statistics.mean(r.diagnosis.prompt_tokens + r.diagnosis.completion_tokens
                                             for r in mine), 1) if mine else 0.0,
        consistency=round(sum(1 for s in case_summaries.values() if s.consistent)
                          / max(1, len(case_summaries)), 4),
        total_cost_usd=round(sum(r.diagnosis.est_cost_usd for r in mine), 6))


def _case_summaries(dataset: EvalDataset, results: list[CaseRunResult], variant: str) -> list[CaseSummary]:
    out = []
    for case in dataset.cases:
        mine = sorted((r for r in results if r.variant == variant and r.case_id == case.case_id),
                      key=lambda r: r.run_index)
        classifications = {r.diagnosis.classification for r in mine}
        consistent = len(classifications) <= 1
        out.append(CaseSummary(case_id=case.case_id, variant=variant,  # type: ignore[arg-type]
                               runs=len(mine), runs_passed=sum(r.passed for r in mine),
                               consistent=consistent,
                               passed=bool(mine) and all(r.passed for r in mine) and consistent))
    return out


def run_benchmark(dataset: EvalDataset, *, runs: int = 3, mode: str = "stub",
                  compare_baseline: bool = False, configs_dir: Path = ROOT / "configs",
                  reason_fn: Optional[Any] = None, live: Optional[LivePipeline] = None) -> EvalReport:
    rates = _pricing(configs_dir)
    variants = ["baseline", "agent"] if compare_baseline else ["agent"]
    results: list[CaseRunResult] = []
    if mode == "meta":
        live = live or _make_live_pipeline(configs_dir)
        _preflight_budget(live, dataset, runs, variants)
        reason_fn = live.judge_reason
        for variant in variants:
            for case in dataset.cases:
                for run_index in range(runs):
                    diagnose = live.baseline if variant == "baseline" else live.agent
                    diagnosis, schema_ok = diagnose(case, run_index)
                    live.judge_context = variant
                    live.judge_run_id = f"evals-{variant}-{case.case_id}-r{run_index}"
                    results.append(score_run(case, variant, run_index, diagnosis, mode,
                                             reason_fn, schema_valid=schema_ok))
    else:
        for variant in variants:
            for case in dataset.cases:
                for run_index in range(runs):
                    diagnosis = DIAGNOSERS[variant](case, rates)
                    results.append(score_run(case, variant, run_index, diagnosis, mode, reason_fn))
    summaries = [_variant_summary(dataset, results, v) for v in variants]
    if mode == "meta" and live is not None:
        for summary in summaries:  # the report total includes the live judge's spend
            summary.total_cost_usd = round(
                summary.total_cost_usd + live.judge_costs.get(summary.variant, 0.0), 6)
    delta = None
    if compare_baseline:
        by_variant = {s.variant: s for s in summaries}
        delta = round(by_variant["agent"].pass_rate - by_variant["baseline"].pass_rate, 4)
    return EvalReport(dataset_version=dataset.dataset_version, mode=mode,  # type: ignore[arg-type]
                      runs_per_case=runs, total_cases=len(dataset.cases), variants=summaries,
                      case_summaries=[s for v in variants for s in _case_summaries(dataset, results, v)],
                      run_results=results, delta_pass_rate=delta)


# ------------------------------------------------------------------ output
def _fmt_latency(sec: float) -> str:
    """Seconds for live calls, milliseconds for sub-second stub timings."""
    return f"{sec:.2f}s" if abs(sec) >= 0.1 else f"{sec * 1000:.2f}ms"


def format_report(report: EvalReport) -> str:
    width = 118
    lines = [
        "=" * width,
        "META GAME ONBOARDING OPTIMIZER - EVALS REPORT".center(width),
        "=" * width,
        f"Mode: {report.mode.upper()} | Runs per Case: {report.runs_per_case} | "
        f"Total Test Cases: {report.total_cases}",
        "-" * width,
        f"{'System Variant':<22} | {'Pass Rate':>9} | {'Precision':>9} | {'Recall':>6} | "
        f"{'Consist.':>8} | {'Latency p50':>11} | {'Latency p95':>11} | {'Total Cost':>10} | {'Est. Cost/Run':>13}",
        "-" * width,
    ]
    for v in report.variants:
        lines.append(f"{v.label:<22} | {v.pass_rate:>8.1%} | {v.precision:>9.2f} | "
                     f"{v.recall:>6.2f} | {v.consistency:>7.0%} | {_fmt_latency(v.latency_p50_sec):>11} | "
                     f"{_fmt_latency(v.latency_p95_sec):>11} | ${v.total_cost_usd:>9.4f} | ${v.est_cost_per_run_usd:>12.4f}")
    if report.delta_pass_rate is not None and len(report.variants) == 2:
        base, agent = report.variants[0], report.variants[1]
        lines.append("-" * width)
        lines.append(f"{'Delta / Uplift':<22} | {report.delta_pass_rate:>+8.1%} | "
                     f"{agent.precision - base.precision:>+9.2f} | {agent.recall - base.recall:>+6.2f} | "
                     f"{agent.consistency - base.consistency:>+7.0%} | "
                     f"{_fmt_latency(agent.latency_p50_sec - base.latency_p50_sec):>11} | "
                     f"{_fmt_latency(agent.latency_p95_sec - base.latency_p95_sec):>11} | "
                     f"${agent.total_cost_usd - base.total_cost_usd:>+9.4f} | "
                     f"${agent.est_cost_per_run_usd - base.est_cost_per_run_usd:>+12.4f}")
    lines.append("=" * width)
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="evals", description=__doc__)
    parser.add_argument("--dataset", type=Path, default=ROOT / "evals" / "eval_dataset.json")
    parser.add_argument("--runs", type=int, default=3, help="runs per case (flakiness check)")
    parser.add_argument("--mode", choices=["stub", "meta"], default="stub")
    parser.add_argument("--compare-baseline", action="store_true",
                        help="also score the raw single-turn LLM baseline")
    parser.add_argument("--output", type=Path, default=ROOT / "runs" / "evals_summary.json")
    parser.add_argument("--configs-dir", type=Path, default=ROOT / "configs")
    args = parser.parse_args(argv)
    if args.runs < 1:
        parser.error("--runs must be >= 1")

    dataset = load_dataset(args.dataset)
    try:
        report = run_benchmark(dataset, runs=args.runs, mode=args.mode,
                               compare_baseline=args.compare_baseline,
                               configs_dir=args.configs_dir)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(format_report(report))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report.model_dump_json(indent=2) + "\n")
    print(f"Artifact generated: {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
