"""Pydantic models for the eval suite: dataset, diagnoses, runs and reports.

Field names are stable: ``runs/evals_summary.json`` is a public artifact and
the README benchmark table is generated from these models.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

DiagnosisStatus = Literal["HEALTHY", "BOTTLENECK", "INCONCLUSIVE_DATA"]
VariantName = Literal["baseline", "agent"]
StepId = Literal["onb_01_shelter", "onb_02_forager", "onb_03_handoff", "free_play"]
PersonaId = Literal["impatient_newcomer", "first_time_casual", "optimizer"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EvalEvent(_Strict):
    """One telemetry event, mirroring ``backend.schemas.TelemetryEvent``'s shape."""

    event_type: str = Field(min_length=1)
    step_id: Optional[StepId] = None
    sim_elapsed_sec: float = Field(0.0, ge=0)
    bot_step_index: Optional[int] = Field(None, ge=0)
    payload: dict[str, Any] = Field(default_factory=dict)


class ExpectedOutcome(_Strict):
    status: DiagnosisStatus
    # The one seeded bottleneck the case is built around; None for clean cases.
    primary_issue_id: Optional[str] = None
    step_id: Optional[StepId] = None
    patch_required: bool = False
    # Any one of these lever names in the patch counts as hitting the lever.
    expected_levers: list[str] = Field(default_factory=list)
    expected_tools: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistent(self) -> "ExpectedOutcome":
        if self.status == "BOTTLENECK" and not self.primary_issue_id:
            raise ValueError("a BOTTLENECK case must name its seeded primary_issue_id")
        if self.patch_required and not self.expected_levers:
            raise ValueError("a case requiring a patch must list expected_levers")
        return self


class EvalCase(_Strict):
    case_id: str = Field(pattern=r"^tc_[0-9]{2}_[a-z0-9_]+$")
    tier: Literal[1, 2, 3]
    title: str = Field(min_length=1)
    persona_id: PersonaId
    description: str = ""
    telemetry: list[EvalEvent] = Field(min_length=1)
    expected: ExpectedOutcome


class EvalDataset(_Strict):
    dataset_version: str = "v1"
    game: str = "Hearths of the Glen"
    cases: list[EvalCase] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_ids(self) -> "EvalDataset":
        ids = [c.case_id for c in self.cases]
        if len(ids) != len(set(ids)):
            raise ValueError("case_id values must be unique")
        return self

    def seeded_cases(self) -> list[EvalCase]:
        return [c for c in self.cases if c.expected.primary_issue_id]


class Issue(_Strict):
    issue_id: str = Field(min_length=1)
    step_id: Optional[StepId] = None
    severity: Literal["low", "medium", "high"] = "medium"
    evidence: str = ""


class PatchRecommendation(_Strict):
    changes: dict[str, Any] = Field(min_length=1)
    rationale: str = Field(min_length=1)


class Diagnosis(_Strict):
    """What one system variant (baseline or agent pipeline) says about a case."""

    status: DiagnosisStatus
    issues: list[Issue] = Field(default_factory=list)
    tool_trajectory: list[str] = Field(default_factory=list)
    patch: Optional[PatchRecommendation] = None
    latency_sec: float = Field(0.0, ge=0)
    prompt_tokens: int = Field(0, ge=0)
    completion_tokens: int = Field(0, ge=0)
    est_cost_usd: float = Field(0.0, ge=0)

    @property
    def classification(self) -> str:
        """The flakiness key: two runs agree iff their classifications match."""
        return self.status + "|" + ",".join(sorted(i.issue_id for i in self.issues))


class CheckResult(_Strict):
    name: str
    passed: bool
    detail: str = ""


class CaseRunResult(_Strict):
    case_id: str
    variant: VariantName
    run_index: int = Field(ge=0)
    passed: bool
    checks: list[CheckResult] = Field(default_factory=list)
    diagnosis: Diagnosis
    judge_verdict: Literal["PASS", "FAIL"]
    judge_reasons: list[str] = Field(default_factory=list)


class CaseSummary(_Strict):
    case_id: str
    variant: VariantName
    runs: int
    runs_passed: int
    consistent: bool
    passed: bool  # all runs passed AND classifications identical


class VariantSummary(_Strict):
    variant: VariantName
    label: str
    cases_passed: int
    total_cases: int
    pass_rate: float = Field(ge=0, le=1)
    precision: float = Field(ge=0, le=1)
    recall: float = Field(ge=0, le=1)
    latency_p50_sec: float = Field(ge=0)
    latency_p95_sec: float = Field(ge=0)
    est_cost_per_run_usd: float = Field(ge=0)
    tokens_per_run: float = Field(ge=0)
    # Fraction of cases whose runs all share one classification (flakiness).
    consistency: float = Field(0.0, ge=0, le=1)
    # Sum over every run of this variant (diagnosis + judge in meta mode).
    total_cost_usd: float = Field(0.0, ge=0)


class EvalReport(_Strict):
    dataset_version: str
    mode: Literal["stub", "meta"]
    runs_per_case: int
    total_cases: int
    variants: list[VariantSummary]
    case_summaries: list[CaseSummary]
    run_results: list[CaseRunResult]
    delta_pass_rate: Optional[float] = None  # agent minus baseline, when compared
