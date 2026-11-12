"""Automated evaluation suite for the Meta Game Onboarding Optimizer.

Reproducible, deterministic-first benchmarks for *Hearths of the Glen*:
``python -m evals.evals --compare-baseline`` (stub mode, $0).
"""
from .schemas import EvalCase, EvalDataset, EvalReport

__all__ = ["EvalCase", "EvalDataset", "EvalReport"]
