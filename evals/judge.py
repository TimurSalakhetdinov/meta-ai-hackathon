"""Binary LLM-as-a-judge for patch recommendation quality (the 20%).

Verdicts are strictly ``PASS``/``FAIL`` against a written rubric. In stub mode
the rubric is applied deterministically over the patch's levers and rationale
($0, no network); in meta mode a caller may pass a ``reason_fn`` (backed by
``MetaClient.reason_json``) whose JSON verdict is then validated through the
same binary schema, falling back to the rubric when the reply is unusable.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .schemas import Diagnosis, EvalCase


RUBRIC = """\
Judge one proposed onboarding patch. Answer PASS only if ALL hold:
1. A bottleneck case gets a patch; a healthy or inconclusive case gets none.
2. The patch touches at least one lever that addresses the seeded bottleneck.
3. The rationale names the stuck step or the bottleneck mechanism (no generic advice).
4. The patch does not gate, remove or reprice unrelated onboarding content.
Otherwise answer FAIL. Reply with JSON {"verdict": "PASS"|"FAIL", "reasons": [str]}.
"""


class JudgeVerdict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: str = Field(pattern=r"^(PASS|FAIL)$")
    reasons: list[str] = Field(default_factory=list)


def rubric_judge(case: EvalCase, diagnosis: Diagnosis) -> JudgeVerdict:
    """The rubric as deterministic code: the stub-mode judge."""
    expected = case.expected
    reasons: list[str] = []
    failed = False

    if expected.patch_required and diagnosis.patch is None:
        return JudgeVerdict(verdict="FAIL", reasons=["patch required but none proposed"])
    if not expected.patch_required and diagnosis.patch is not None:
        return JudgeVerdict(verdict="FAIL", reasons=["patch proposed where none was required"])
    if diagnosis.patch is None:
        return JudgeVerdict(verdict="PASS", reasons=["correctly proposed no patch"])

    changes = diagnosis.patch.changes
    if any(lever in changes for lever in expected.expected_levers):
        reasons.append(f"patch touches an expected lever ({sorted(set(changes) & set(expected.expected_levers))})")
    else:
        failed = True
        reasons.append(f"patch levers {sorted(changes)} miss expected {expected.expected_levers}")

    rationale = diagnosis.patch.rationale.lower()
    step_token = (expected.step_id or "").replace("_", " ")
    issue_token = (expected.primary_issue_id or "").split("_")[0]
    if (expected.step_id and expected.step_id in rationale) or (step_token and step_token in rationale) \
            or (issue_token and issue_token in rationale):
        reasons.append("rationale names the stuck step or mechanism")
    else:
        failed = True
        reasons.append("rationale does not name the stuck step or bottleneck mechanism")

    forbidden = {"lock_optional_builds_until_step"} if expected.primary_issue_id != \
        "premature_combat_unlock_resource_starvation" else set()
    bad = sorted(set(changes) & forbidden - set(expected.expected_levers))
    if bad:
        failed = True
        reasons.append(f"patch touches unrelated gating levers: {bad}")

    return JudgeVerdict(verdict="FAIL" if failed else "PASS", reasons=reasons)


def judge_patch(case: EvalCase, diagnosis: Diagnosis,
                reason_fn: Optional[Callable[[str, str], dict[str, Any]]] = None) -> JudgeVerdict:
    """Binary judge. With ``reason_fn`` (meta mode), the model's verdict is
    schema-validated; an unusable reply falls back to the deterministic rubric."""
    if reason_fn is None:
        return rubric_judge(case, diagnosis)
    payload = json.dumps({
        "case": case.model_dump(mode="json"),
        "diagnosis": diagnosis.model_dump(mode="json"),
    })
    try:
        return JudgeVerdict.model_validate(reason_fn(RUBRIC, payload))
    except (ValidationError, RuntimeError, ValueError):
        return rubric_judge(case, diagnosis)
