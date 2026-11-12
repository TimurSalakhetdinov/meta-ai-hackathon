"""Deterministic assertions: schema, status, trajectory, hallucination checks.

These are the 80% of the suite that never calls a model. Every check returns a
``CheckResult`` so a failing case explains itself in the JSON artifact.
"""
from __future__ import annotations

import math

from .schemas import CaseRunResult, CheckResult, Diagnosis, EvalCase


def validate_diagnosis_schema(raw: object) -> tuple[Diagnosis | None, list[CheckResult]]:
    """Parse an untrusted diagnosis payload; a schema failure is a check, not a crash."""
    try:
        diagnosis = Diagnosis.model_validate(raw)
    except Exception as exc:  # pydantic.ValidationError and friends
        return None, [CheckResult(name="diagnosis_schema", passed=False, detail=str(exc)[:300])]
    return diagnosis, [CheckResult(name="diagnosis_schema", passed=True)]


def check_status(case: EvalCase, diagnosis: Diagnosis) -> CheckResult:
    ok = diagnosis.status == case.expected.status
    return CheckResult(name="status", passed=ok,
                       detail=f"expected {case.expected.status}, got {diagnosis.status}")


def check_primary_issue(case: EvalCase, diagnosis: Diagnosis) -> CheckResult:
    expected = case.expected.primary_issue_id
    found = [i.issue_id for i in diagnosis.issues]
    if expected is None:
        return CheckResult(name="primary_issue", passed=True, detail="no seeded bottleneck in this case")
    ok = expected in found
    return CheckResult(name="primary_issue", passed=ok,
                       detail=f"expected {expected!r} in reported issues {found}")


def check_no_hallucination(case: EvalCase, diagnosis: Diagnosis) -> CheckResult:
    """Clean cases must report zero issues and propose zero patches."""
    if case.expected.primary_issue_id is not None or case.expected.status != "HEALTHY":
        return CheckResult(name="no_hallucination", passed=True, detail="not a clean case")
    ok = not diagnosis.issues and diagnosis.patch is None
    detail = "no bogus issues or patches" if ok else (
        f"hallucinated issues={[i.issue_id for i in diagnosis.issues]} patch={diagnosis.patch is not None}")
    return CheckResult(name="no_hallucination", passed=ok, detail=detail)


def check_tool_trajectory(case: EvalCase, diagnosis: Diagnosis) -> CheckResult:
    """Expected tools as an ordered subsequence, with no loops or redundant calls."""
    actual = diagnosis.tool_trajectory
    loops = [t for a, b in zip(actual, actual[1:]) if a == b for t in [a]]
    repeated = sorted({t for t in actual if actual.count(t) > 1})
    if loops or repeated:
        return CheckResult(name="tool_trajectory", passed=False,
                           detail=f"redundant/looping calls in {actual} (repeated: {repeated})")
    pos = 0
    for tool in case.expected.expected_tools:
        if tool not in actual[pos:]:
            return CheckResult(name="tool_trajectory", passed=False,
                               detail=f"expected tool {tool!r} missing or out of order in {actual}")
        pos = actual.index(tool, pos) + 1
    return CheckResult(name="tool_trajectory", passed=True, detail=f"trajectory {actual}")


def check_patch_presence(case: EvalCase, diagnosis: Diagnosis) -> CheckResult:
    if case.expected.patch_required:
        ok = diagnosis.patch is not None
        detail = "patch proposed" if ok else "bottleneck found but no patch proposed"
    else:
        ok = diagnosis.patch is None
        detail = "no patch (none required)" if ok else "patch proposed where none was required"
    return CheckResult(name="patch_presence", passed=ok, detail=detail)


_DETERMINISTIC_CHECKS = (check_status, check_primary_issue, check_no_hallucination,
                         check_tool_trajectory, check_patch_presence)


def run_deterministic_checks(case: EvalCase, diagnosis: Diagnosis) -> list[CheckResult]:
    return [check(case, diagnosis) for check in _DETERMINISTIC_CHECKS]


def precision_recall(cases: list[EvalCase], results: list[CaseRunResult],
                     variant: str) -> tuple[float, float]:
    """Seeded-bottleneck precision/recall for one variant, over first runs only.

    True positive: the seeded issue is named. False positive: any reported
    issue that is not the seeded one (every issue on a clean case counts).
    """
    first_runs = {r.case_id: r for r in results if r.variant == variant and r.run_index == 0}
    tp = fp = fn = 0
    for case in cases:
        result = first_runs.get(case.case_id)
        reported = [i.issue_id for i in result.diagnosis.issues] if result else []
        seeded = case.expected.primary_issue_id
        if seeded and seeded in reported:
            tp += 1
        elif seeded:
            fn += 1
        fp += sum(1 for issue_id in reported if issue_id != seeded)
    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    return round(precision, 4), round(recall, 4)


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile; 0.0 for an empty sample."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]
