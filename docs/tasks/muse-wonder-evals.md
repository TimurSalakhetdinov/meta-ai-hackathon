# Task for Muse Wonder: Automated Evaluation Suite (Evals) for Game Onboarding Optimizer

## Context & Objectives
This task defines the implementation of a reproducible, production-grade **Evaluation Suite (`evals/`)** for the **Meta Game Onboarding Optimizer** (*Hearths of the Glen*). 

The goal is to prove system reliability, determinism, and business impact by benchmarking how effectively our multi-agent architecture diagnoses player drop-offs and synthesizes onboarding interventions compared to a naive raw LLM baseline.

### Key Principles
1. **Domain Grounding:** Evals are grounded specifically in *Hearths of the Glen* gameplay telemetry, persona behaviors (`impatient_newcomer`, `first_time_casual`, `optimizer`), and onboarding stages (`onb_01_shelter`, `onb_02_forager`, `onb_03_handoff`, `free_play`).
2. **Deterministic-First (80/20 Rule):** 80% of checks are deterministic Python code/JSON Schema assertions (schema validation, tool trajectories, status codes, exception handling). Only 20% rely on LLM-as-a-judge (strict binary `PASS`/`FAIL` with clear rubrics).
3. **Baseline vs. Agent Uplift:** The suite must execute a side-by-side comparison between **Baseline** (raw single-turn LLM) and **Agent Pipeline** (structured tools + memory + validation) to demonstrate measurable accuracy gains (e.g., ~40% vs ~85%+).
4. **Zero-Spend Local Execution:** All test suites must run seamlessly in `mode="stub"` ($0.00 cost) with full deterministic fixtures, while supporting live `mode="meta"` runs via environment configuration.

---

## 1. Directory Structure to Implement

Create the following module layout under the repository root:

```text
evals/
├── __init__.py
├── eval_dataset.json       # 7 canonical gameplay scenarios (fixtures)
├── evals.py               # Main CLI benchmark runner and reporter
├── assertions.py          # Deterministic code-based assertions & validators
├── judge.py               # Binary LLM-as-a-judge scoring with rubrics
└── schemas.py             # Pydantic models for eval runs, metrics, and results
tests/
└── test_evals.py          # Pytest unit tests for the eval framework itself
```

---

## 2. Dataset Specification (`evals/eval_dataset.json`)

Construct a dataset containing **7 structured test cases** across three difficulty tiers:

### Tier 1: Clean Baseline Flows (2 cases - False Positive / Hallucination Checks)
* **`tc_01_clean_onboarding_casual`**: Telemetry of a `first_time_casual` persona completing tutorial steps without obstruction.
  * *Expected Outcome:* Agent identifies `status="HEALTHY"`, verdict `✅ POSITIVE IMPACT`, produces zero bogus bug alerts, recommends no unnecessary config patches.
* **`tc_02_clean_onboarding_optimizer`**: Telemetry of an `optimizer` persona fast-tracking resource builds.
  * *Expected Outcome:* Agent detects smooth progression into `free_play` with expected high retention.

### Tier 2: Seeded Bottlenecks & Disruptive Features (3 cases - Ground-Truth Recall)
* **`tc_03_wood_drain_raider_ambush`**: Player clicks flashy Raider Ambush during `onb_02_forager`, spending 25 Wood; cannot afford *Basic Toolmaking*; onboarding completion collapses from 100% to 17%.
  * *Expected Outcome:* Agent detects root cause: resource starvation from premature combat unlock; proposes moving `unlock_at_step` to `free_play` or reducing wood cost.
* **`tc_04_resource_stall_shelter`**: Sub-optimal worker allocation during `onb_01_shelter` causes timer dead-air and player dropout.
  * *Expected Outcome:* Agent pinpoints missing food/worker guidance in Elder Kaelen's dialogue hints.
* **`tc_05_dialog_deadlock_elder`**: Unfulfilled quest state flag prevents the Elder from advancing to `onb_03_handoff`.
  * *Expected Outcome:* Agent flags trigger failure and missing fallback event transition.

### Tier 3: Edge & Corrupted Telemetry (2 cases - Resilience & Error Handling)
* **`tc_06_abrupt_session_drop`**: Telemetry log truncates mid-action without a clean session-end event.
  * *Expected Outcome:* Graceful parsing without unhandled exception; returns `status="INCONCLUSIVE_DATA"`.
* **`tc_07_noisy_click_spam`**: Out-of-order event timestamps and repeated rapid clicks on locked UI buttons.
  * *Expected Outcome:* Filters noise, detects UI frustration signal without crashing tool execution.

---

## 3. Metrics & Scoring Logic (`evals/evals.py` & `evals/assertions.py`)

Compute and report the following 4 core metrics:

1. **Task Accuracy (Precision & Recall):**
   * $\text{Recall} = \frac{\text{Seeded Bottlenecks Correctly Identified}}{\text{Total Seeded Bottlenecks}}$
   * $\text{Precision} = \frac{\text{True Bottlenecks Identified}}{\text{Total Issues Reported (Penalizing Hallucinations)}}$
2. **Tool Trajectory Adherence:**
   * Validates that the agent called the expected sequence of diagnostic tools (e.g. `query_telemetry` -> `analyze_dropoff` -> `synthesize_patch`) without redundant calls or loops.
3. **Flakiness & Consistency:**
   * Each test case is executed across $N=3$ runs at standard temperature ($T=0.2$). A case passes only if $3/3$ runs yield identical diagnostic classifications.
4. **Latency & Token Cost:**
   * Track wall-clock runtime (p50 and p95 latency in seconds) and token expenditure using `configs/budget_config.json` rates.

---

## 4. Benchmark Runner Interface (`evals/evals.py`)

Provide a single-command CLI interface:

```bash
# Run local offline benchmark (default stub mode)
python -m evals.evals --dataset evals/eval_dataset.json --runs 3 --mode stub

# Run comparison against raw baseline
python -m evals.evals --compare-baseline --output runs/evals_summary.json
```

### Terminal Output Requirement
The runner must format and print a clean terminal summary table:

```text
================================================================================
                    META GAME ONBOARDING OPTIMIZER - EVALS REPORT
================================================================================
Mode: STUB | Runs per Case: 3 | Total Test Cases: 7
--------------------------------------------------------------------------------
System Variant       | Pass Rate | Precision | Recall | Latency (p50) | Est. Cost/Run
---------------------+-----------+-----------+--------+---------------+--------------
Baseline (Raw LLM)   |   42.8%   |   0.50    |  0.40  |     1.2s      |    $0.002
Agent Pipeline       |   85.7%   |   0.88    |  0.86  |     3.4s      |    $0.008
--------------------------------------------------------------------------------
Delta / Uplift       |  +42.9%   |  +0.38    | +0.46  |    +2.2s      |   +$0.006
================================================================================
Artifact generated: runs/evals_summary.json
```

---

## 5. README.md Benchmark Table Spec

Add a dedicated `## Benchmark & Reliability (Evals)` section to `README.md` containing:

1. The comparison matrix (Baseline vs. Agent).
2. Reproduction instructions (`python -m evals.evals`).
3. Portfolio talking points highlighting automated error-seeding, deterministic verification, and token budget governance.

---

## 6. Definition of Done
1. [x] `evals/eval_dataset.json` created with 7 valid scenario payloads.
2. [x] `evals/assertions.py` implements schema and trajectory validation functions.
3. [x] `evals/judge.py` implements binary evaluator for patch recommendation quality.
4. [x] `evals/evals.py` CLI executes end-to-end and outputs formatted summary table and JSON artifact.
5. [x] `pytest tests/test_evals.py` passes 100% in local environment without network dependency.
