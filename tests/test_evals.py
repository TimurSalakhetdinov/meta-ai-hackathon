"""Unit tests for the eval framework itself: $0, offline, deterministic."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from evals import evals as runner
from evals.assertions import (check_no_hallucination, check_tool_trajectory,
                              percentile, precision_recall, validate_diagnosis_schema)
from evals.judge import JudgeVerdict, judge_patch, rubric_judge
from evals.schemas import Diagnosis, Issue, PatchRecommendation

from backend.meta_client import MetaClient

ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / "evals" / "eval_dataset.json"
RATES = (0.1 / 1e6, 0.2 / 1e6)  # muse-spark contributor rates, per token


@pytest.fixture(scope="module")
def dataset():
    return runner.load_dataset(DATASET_PATH)


def _case(dataset, case_id: str):
    return next(c for c in dataset.cases if c.case_id == case_id)


# ------------------------------------------------------------------ dataset
def test_dataset_has_seven_cases_across_three_tiers(dataset) -> None:
    assert len(dataset.cases) == 7
    assert [sum(1 for c in dataset.cases if c.tier == t) for t in (1, 2, 3)] == [2, 3, 2]
    assert len({c.case_id for c in dataset.cases}) == 7
    assert {c.persona_id for c in dataset.cases} <= {
        "impatient_newcomer", "first_time_casual", "optimizer"}


def test_dataset_cases_are_well_formed(dataset) -> None:
    for case in dataset.cases:
        steps = {e.step_id for e in case.telemetry if e.step_id}
        assert steps <= {"onb_01_shelter", "onb_02_forager", "onb_03_handoff", "free_play"}
        if case.expected.status == "BOTTLENECK":
            assert case.expected.primary_issue_id and case.expected.step_id
    ambush = _case(dataset, "tc_03_wood_drain_raider_ambush")
    spend = next(e for e in ambush.telemetry if e.payload.get("result") == "spend")
    assert spend.payload["amount"] == 25 and spend.step_id == "onb_02_forager"


# ------------------------------------------------------------- agent (stub)
def test_agent_pipeline_passes_every_case(dataset) -> None:
    for case in dataset.cases:
        result = runner.score_run(case, "agent", 0, runner.agent_diagnose(case, RATES), "stub")
        failed = [c.name for c in result.checks if not c.passed]
        assert result.passed, f"{case.case_id}: checks={failed} judge={result.judge_reasons}"


def test_clean_cases_produce_no_hallucinated_patch(dataset) -> None:
    for case_id in ("tc_01_clean_onboarding_casual", "tc_02_clean_onboarding_optimizer"):
        diagnosis = runner.agent_diagnose(_case(dataset, case_id), RATES)
        assert diagnosis.status == "HEALTHY"
        assert diagnosis.issues == [] and diagnosis.patch is None
        assert check_no_hallucination(_case(dataset, case_id), diagnosis).passed


def test_truncated_telemetry_is_inconclusive_not_a_crash(dataset) -> None:
    diagnosis = runner.agent_diagnose(_case(dataset, "tc_06_abrupt_session_drop"), RATES)
    assert diagnosis.status == "INCONCLUSIVE_DATA" and diagnosis.patch is None


def test_noisy_click_spam_is_filtered_into_a_frustration_signal(dataset) -> None:
    diagnosis = runner.agent_diagnose(_case(dataset, "tc_07_noisy_click_spam"), RATES)
    assert [i.issue_id for i in diagnosis.issues] == ["locked_ui_click_spam_frustration"]


# ---------------------------------------------------------------- baseline
def test_baseline_underperforms_agent(dataset) -> None:
    report = runner.run_benchmark(dataset, runs=1, compare_baseline=True,
                                  configs_dir=ROOT / "configs")
    by_variant = {v.variant: v for v in report.variants}
    assert by_variant["agent"].pass_rate == 1.0
    assert by_variant["baseline"].pass_rate == pytest.approx(3 / 7, abs=1e-3)
    assert by_variant["baseline"].precision < by_variant["agent"].precision
    assert by_variant["baseline"].recall < by_variant["agent"].recall
    assert report.delta_pass_rate == pytest.approx(4 / 7, abs=1e-3)


def test_flakiness_rule_needs_identical_classifications(dataset) -> None:
    report = runner.run_benchmark(dataset, runs=3, compare_baseline=True,
                                  configs_dir=ROOT / "configs")
    assert all(s.consistent and s.passed for s in report.case_summaries if s.variant == "agent")
    flaky = [s for s in report.case_summaries if s.variant == "baseline" and not s.passed]
    assert flaky  # the baseline fails cases consistently, not by luck


# --------------------------------------------------------------- assertions
def test_trajectory_rejects_loops_and_missing_tools(dataset) -> None:
    case = _case(dataset, "tc_03_wood_drain_raider_ambush")
    looping = Diagnosis(status="BOTTLENECK",
                        tool_trajectory=["query_telemetry", "analyze_dropoff", "analyze_dropoff",
                                         "synthesize_patch"])
    assert not check_tool_trajectory(case, looping).passed
    missing = Diagnosis(status="BOTTLENECK", tool_trajectory=["query_telemetry", "synthesize_patch"])
    assert not check_tool_trajectory(case, missing).passed


def test_diagnosis_schema_rejection_is_a_check_not_a_crash() -> None:
    diagnosis, checks = validate_diagnosis_schema({"status": "SIDEWAYS", "bogus": 1})
    assert diagnosis is None and not checks[0].passed
    diagnosis, checks = validate_diagnosis_schema({"status": "HEALTHY"})
    assert diagnosis is not None and checks[0].passed


def test_percentile_and_precision_recall_helpers(dataset) -> None:
    assert percentile([], 95) == 0.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.0
    assert percentile([1.0, 2.0, 3.0, 4.0], 95) == 4.0
    results = [runner.score_run(case, "agent", 0, runner.agent_diagnose(case, RATES), "stub")
               for case in dataset.cases]
    assert precision_recall(dataset.cases, results, "agent") == (1.0, 1.0)


# -------------------------------------------------------------------- judge
def test_judge_passes_agent_patch_and_fails_wrong_lever(dataset) -> None:
    case = _case(dataset, "tc_03_wood_drain_raider_ambush")
    good = runner.agent_diagnose(case, RATES)
    assert rubric_judge(case, good).verdict == "PASS"

    wrong = Diagnosis(status="BOTTLENECK",
                      issues=[Issue(issue_id="premature_combat_unlock_resource_starvation",
                                    step_id="onb_02_forager")],
                      tool_trajectory=["query_telemetry", "analyze_dropoff", "synthesize_patch"],
                      patch=PatchRecommendation(changes={"starting_food": 99},
                                                rationale="Give the player more food at the start."))
    verdict = judge_patch(case, wrong)
    assert verdict.verdict == "FAIL" and any("lever" in r for r in verdict.reasons)


def test_judge_binary_schema_and_live_fallback(dataset) -> None:
    case = _case(dataset, "tc_01_clean_onboarding_casual")
    healthy = runner.agent_diagnose(case, RATES)
    assert judge_patch(case, healthy, reason_fn=lambda s, u: {"verdict": "PASS"}).verdict == "PASS"
    # An unusable live reply falls back to the deterministic rubric, never crashes.
    assert judge_patch(case, healthy, reason_fn=lambda s, u: {"verdict": "MAYBE"}).verdict == "PASS"
    assert JudgeVerdict(verdict="FAIL").verdict == "FAIL"


# ---------------------------------------------------------------------- CLI
def test_cli_writes_summary_artifact(dataset, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    out = tmp_path / "evals_summary.json"
    code = runner.main(["--dataset", str(DATASET_PATH), "--runs", "3", "--mode", "stub",
                        "--compare-baseline", "--output", str(out),
                        "--configs-dir", str(ROOT / "configs")])
    assert code == 0
    text = capsys.readouterr().out
    assert "META GAME ONBOARDING OPTIMIZER - EVALS REPORT" in text
    assert "Baseline (Raw LLM)" in text and "Agent Pipeline" in text
    report = json.loads(out.read_text())
    assert report["total_cases"] == 7 and report["runs_per_case"] == 3
    assert report["mode"] == "stub" and report["delta_pass_rate"] > 0
    agent = next(v for v in report["variants"] if v["variant"] == "agent")
    assert agent["cases_passed"] == 7 and agent["est_cost_per_run_usd"] >= 0
    assert agent["consistency"] == 1.0 and agent["total_cost_usd"] >= agent["est_cost_per_run_usd"]


# ------------------------------------------------------------- live (meta)
class _FakeDetailedClient:
    """reason_json_detailed stand-in: canned replies, records cache behaviour."""

    def __init__(self, replies: list[dict]) -> None:
        self.replies = list(replies)
        self.calls: list[dict] = []

    def reason_json_detailed(self, system, user, *, stub_result, run_id, bucket, use_cache=True):
        self.calls.append({"system": system, "run_id": run_id, "use_cache": use_cache})
        return {"result": self.replies.pop(0), "prompt_tokens": 100, "completion_tokens": 20,
                "latency_ms": 5.0, "estimated_cost_usd": 0.001, "cache_hit": False,
                "model_id": "fake"}


def test_live_agent_pipeline_makes_two_uncached_calls_for_a_bottleneck(dataset) -> None:
    case = _case(dataset, "tc_03_wood_drain_raider_ambush")
    fake = _FakeDetailedClient([
        {"status": "BOTTLENECK", "issues": [{"issue_id": "premature_combat_unlock_resource_starvation",
                                             "step_id": "onb_02_forager", "severity": "high",
                                             "evidence": "25 wood spend then insufficient_wood"}]},
        {"changes": {"feature_plugin.unlock_at_step": "free_play"},
         "rationale": "Move the premature combat unlock at onb_02_forager to free_play."},
    ])
    diagnosis, schema_ok = runner.LivePipeline(fake).agent(case, 0)
    assert schema_ok and diagnosis.status == "BOTTLENECK"
    assert diagnosis.tool_trajectory == ["query_telemetry", "analyze_dropoff", "synthesize_patch"]
    assert diagnosis.patch is not None
    assert (diagnosis.prompt_tokens, diagnosis.completion_tokens) == (200, 40)
    assert diagnosis.est_cost_usd == pytest.approx(0.002)
    assert len(fake.calls) == 2 and all(not c["use_cache"] for c in fake.calls)
    assert "Designer agent" in fake.calls[1]["system"]  # patch is a separate call, not the analyst's


def test_live_baseline_is_one_call_and_malformed_reply_is_flagged(dataset) -> None:
    case = _case(dataset, "tc_01_clean_onboarding_casual")
    fake = _FakeDetailedClient([{"status": "HEALTHY", "issues": [], "patch": None}])
    diagnosis, schema_ok = runner.LivePipeline(fake).baseline(case, 0)
    assert schema_ok and diagnosis.status == "HEALTHY"
    assert diagnosis.tool_trajectory == ["single_turn_llm"] and len(fake.calls) == 1

    bad = _FakeDetailedClient([{"status": "SIDEWAYS", "issues": [{"issue_id": 7}]}])
    diagnosis, schema_ok = runner.LivePipeline(bad).baseline(case, 0)
    assert not schema_ok and diagnosis.status == "INCONCLUSIVE_DATA"
    result = runner.score_run(case, "baseline", 0, diagnosis, "meta", schema_valid=schema_ok)
    assert not result.passed and result.checks[0].name == "diagnosis_schema"


def test_meta_client_detailed_stub_mode_reports_zero_usage(tmp_path: Path) -> None:
    client = MetaClient(runs_dir=tmp_path / "runs", provider_mode="stub")
    detailed = client.reason_json_detailed("sys", "user", stub_result={"verdict": "PASS"},
                                           run_id="evals-test")
    assert detailed["result"] == {"verdict": "PASS"}
    assert detailed["prompt_tokens"] == detailed["estimated_cost_usd"] == 0
    assert client.reason_json("sys", "user", stub_result={"a": 1}, run_id="evals-test") == {"a": 1}
