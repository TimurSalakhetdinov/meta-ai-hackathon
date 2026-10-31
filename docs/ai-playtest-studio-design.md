# AI Playtest Studio: Reports and experiment design

## Scope and decisions

Keep Bug hunting and Feature Forge separate from navigation through storage and reporting. Bug hunting produces a diagnosis for one run. Feature Forge produces a verdict for one frozen experiment.

This design reviews the supplied description, not repository code or recorded runs. The listed architectural weaknesses are credible consequences of that description, but implementation details remain unverified.

Use the existing runner and per-run folders, a small SQLite database, and one background worker. Do not introduce a warehouse, distributed scheduler, or general experimentation platform.

The following changes are deliberate disagreements with the current design:

- Replace the hardcoded patch identifier with saved experiments and immutable patch revisions.
- Replace hand-picked A/B runs with scheduled matched pairs.
- Replace raw-delta winners with a predeclared primary metric, practical improvement threshold, and fixed-sample decision rule.
- Treat segmentation as evidence of detected regions, not proof of human visual attention.
- Treat bot think-aloud as recorded commentary, not reliable evidence of motive or hidden model reasoning.
- Separate approval to test an isolated variant from approval to ship a patch.
- Replace free-form report generation with structured, source-linked fields; missing data stays missing.

## 1. Report A: Bug-hunting report

### Navigation and lifecycle

Keep two steps: **Bug hunting → Report**. While the hunt is running, Report is disabled and explains that results become available after the run ends.

**Stop bot** requests cancellation, prevents new actions, saves available artifacts, finalizes the run, and opens Report. Show **Saving run** during finalization. Use a bounded worker timeout; an unresponsive worker becomes a failed run with partial evidence rather than an endless spinner.

The run can finish before its analyst job finishes. Open the report with **Diagnosis pending** and update that section when the run-specific analysis arrives.

### Exact layout and field sources

The five content sections below are the entire report. A compact identity/status strip is provenance, not an additional analytics dashboard.

| Order | Section | Fields shown | Authoritative source |
|---|---|---|---|
| Header | Run identity | Run ID, build, persona, start time, terminal state, coverage limit | This run's manifest and lifecycle events |
| 1 | Stuck frame | Screenshot, capture time, chapter/task, triggering step, event reference | This run's stuck event and its linked frame manifest entry |
| 2 | SAM 3.1 visual note | Detected target region, relative area/contrast where measured, overlap/occlusion observations, model version | SAM artifact for the exact displayed frame hash; target bounds or hit-test evidence when available |
| 3 | Analyst diagnosis | Observed failure, expected behaviour, likely cause, alternatives, evidence links, remaining uncertainty | This run's versioned analyst output, citing its own event and step IDs |
| 4 | Proposed fixes | Testable hypothesis, smallest proposed change, expected effect, verification condition, possible regression | Analyst proposals derived from cited evidence, explicitly unapproved |
| 5 | Bot think-aloud | Timestamped recorded commentary, attempted target, actual action result, chapter/task | This run's bot steps joined to telemetry by step/action ID |

The frame selector defaults to the earliest confirmed progress-blocking incident. Other same-run incidents can be selected without changing report identity.

If no confirmed stuck event exists, show a labelled last available frame, not a fabricated stuck frame. If only a nearby capture exists, disclose the time offset. Never imply that it records the precise failed action.

A segmentation-only result must say, for example, **Small detected region; discoverability not established**. It must not assert that a human would miss the target. Analyst inferences stay visibly separate from measured geometry and confirmed click rejection.

### What Report A never contains

- Patch approval, rejection, application, or deployment controls.
- A/B tables, feature winners, experiment KPI cards, or comparative persona scores.
- Screenshots, bot quotes, diagnoses, or fallback demo content from another run.
- Invented SAM results, inferred voice playback presented as measured playback, or synthetic screenshots.
- An automatic fix, automatic issue submission, or an approved-change badge on a proposal.

A proposed fix can be copied manually into a new Forge idea. It does not create or approve a patch through this report.

### State handling

| State | What the user sees |
|---|---|
| Hunt still running | Stay in live Bug hunting with screenshot and commentary; Report remains unavailable. A direct report URL returns the running state, not an old report. |
| Stopped early | Report says **Stopped by tester: partial coverage**, shows the relevant same-run frame or labelled last frame, and limits conclusions to observed steps. |
| Bot failed or crashed | Report says **Runner failed** with the last saved frame and error evidence; a game blocker is not inferred solely from runner failure. |
| Game crashed | Report shows the game error and last frame as a potential game defect, separately from runner health. |
| No stuck event found | **No stuck event detected in observed coverage**; show the labelled last frame and any supported usability observations, without inventing a blocker. |
| Frame missing | **Screenshot unavailable for this run/step**; retain available telemetry and commentary. |
| SAM missing or wrong frame hash | **Visual analysis unavailable for this frame**; never reuse another frame's segmentation. |
| Analyst missing or failed | **Diagnosis pending** or **Analysis failed**, with a same-run analysis retry control. |

### Proposed-fix format

Use this example structure, with actual run evidence substituted during implementation:

> **Hypothesis, not approved:** The guide highlights Masonry while the player cannot afford it and obscures the Woodcutter collection target.
>
> **Evidence:** Link the failed research action, displayed resource cost, target bounds, and rejected collection action from this run.
>
> **Proposed change:** When Masonry is unaffordable, preserve access to resource collection and direct the hint toward the missing resource.
>
> **Expected effect:** The player can collect wood and resume the required research without leaving the chapter.
>
> **Verify:** Replay the failing setup; collection succeeds, Masonry becomes available, and the hint returns to Research.
>
> **Check for regression:** Affordable research still receives the correct hint; no overlay intercepts unrelated targets.

Do not say **Root cause fixed**, **Approved**, or **This will solve the issue** without corresponding evidence and decisions.

### Run provenance invariant

Every artifact lookup starts from an explicit run ID and a manifest allowlist. Verify frame hashes, build identity, and analysis source-run identity before rendering.

A missing file produces an explicit missing-source state. There is no fallback to latest run, demo run, or a globally cached screenshot. Cache keys include run ID, artifact hash, and analysis revision.

## 2. Report B: A/B test report

### Exact layout

| Order | Section | Content and sources |
|---|---|---|
| 1 | Experiment header | ID, title, phase, lifecycle status, baseline build hash, creation date, frozen plan, consumed/reserved budget; experiment record |
| 2 | Patch summary | Human-readable intent, exact configuration diff, revision/hash, validation result, affected features; patch record |
| 3 | Approval state | Test approval, any rejection, shipping approval, actors and timestamps; append-only decision log |
| 4 | Primary verdict | Better / Worse / Inconclusive / Incomplete, target metric, A and B counts/rates, paired difference, decision threshold, sample size, uncertainty explanation; versioned metric computation |
| 5 | Secondary metrics and guardrails | B value, “was A”, delta, unit, denominator, missing count, coverage horizon; event-derived metrics |
| 6 | Persona breakdown | A/B primary counts, paired differences, stuck incidents, and relevant diagnostics for each persona; no unexplained composite score |
| 7 | Supporting bot quotes | Short exact recorded commentary with persona, variant, run ID, timestamp, and replay link; bot-step artifact |
| 8 | Run inventory | Pair ID, persona, game seed, bot seed, phase, A/B run IDs, outcomes, exclusions, retries, cost, replay links; pair/run records |
| Footer | Human next action | Request confirmation, reject candidate, approve shipping, or explicitly apply an approved patch; eligibility depends on phase and decision state |

General onboarding diagnosis does not appear here. A stuck point can explain the feature result, but a full diagnosis belongs to a separate run inspection or Bug hunting report.

Use counts with percentages, such as **18/30**, rather than percentages alone. Use percentage points for rate differences. If A is zero, relative percentage change is **Not defined**.

Quotes illustrate observed behaviour; they are not votes and never determine the verdict. Show the selection rule and allow access to all recorded commentary to avoid cherry-picking.

### Verdict rule in plain language

For onboarding experiments, the default primary outcome is completion of Basic Toolmaking within the frozen run horizon.

**B is better** only when all of these hold:

1. The planned sample is complete, matched, and sufficiently valid.
2. B improves completion by at least the predeclared meaningful difference, initially 10 percentage points.
3. Among pairs where only one version succeeds, the advantage is unlikely to be explained by random direction alone under the paired test below.
4. No confirmed new critical progression blocker or unresolved game-crash regression appears in B.

**B is worse** when the equivalent primary decline passes the same size and statistical checks, or a reproducible critical B-only regression is confirmed.

**Inconclusive** means the completed sample does not establish either result. It does not mean the variants are equivalent.

**Incomplete** means the planned sample or required evidence is missing. Do not compute a final winner from the remaining convenient runs.

A secondary improvement never overrides a failed primary metric. A clearly out-of-scope primary metric should be changed before approval by creating a new plan revision, not after seeing results.

### Special states

| State | Required behaviour |
|---|---|
| Not enough runs | Show **Incomplete: X/Y planned pairs available**; descriptive cards remain visible with denominators, but no winner. |
| A or B runner/API failure | Preserve both artifacts; classify as infrastructure failure, schedule a bounded replacement pair, and show the exclusion reason. |
| A or B game crash | Keep it as an adverse gameplay outcome; onboarding is unsuccessful if not completed, and the crash guardrail records it even if completion occurred earlier. |
| Failure cause unknown | Mark the pair unresolved and verdict incomplete until classified; never discard it silently. |
| Patch rejected before testing | Show the rejected patch, reason, and decision history; no synthetic KPI cards or automatically started runs. |
| Patch rejected after testing | Preserve results, mark the decision rejected, disable application, and require a new revision for further work. |
| Budget exhausted | Stop scheduling, save partial evidence, show actual spend and unresolved pairs, and mark the report incomplete. |
| Confirmation conflicts with discovery | Show both phases separately and label the feature unconfirmed; do not pool them to rescue a preferred verdict. |

## 3. A/B testing architecture

### Experiment as a first-class object

Store one immutable approved plan per experiment revision. It contains:

- Experiment ID, title, feature idea, patch ID/revision/hash, baseline build/config hash, and parent experiment when applicable.
- Selected personas and persona prompt versions, equal persona weights by default, runner type/version, model identifiers, and decision settings.
- Game seeds, bot decision seeds where supported, repetition IDs, planned pair counts per persona and phase, speed, run horizon, and viewport.
- Primary metric/version, improvement threshold, guardrails, secondary metrics, exclusions, retry limits, and stopping rule.
- Budget ceiling, call/token limits, reserved and spent amounts, lifecycle status, phase, decisions, report revision, and deployment reference.

Here a cell means one persona × variant × phase. Its run count is explicit. A matched pair contains one A and one B run for the same persona, scenario seed, and repetition.

Changing the patch, baseline, persona prompts, runner family, primary metric, or horizon creates a new experiment revision with renewed test approval.

### Lifecycle

```text
draft → approved → running → done → confirmed
   ↘ rejected                    ↘ rejected
```

Use separate fields for lifecycle status, phase, verdict, and shipping state. Do not force those meanings into one status enum.

- **Draft:** forge and validate the configuration patch; define the full test plan.
- **Approved:** a human approves the exact patch hash and plan for isolated testing.
- **Running:** execute the selected phase; pause scheduling on budget or worker faults.
- **Done:** the phase is finalized, including incomplete or inconclusive results.
- **Confirmed:** a fresh, preplanned confirmation phase independently meets the same positive criteria.
- **Rejected:** a human rejects the candidate; retain history.

A done experiment can start an explicitly approved confirmation phase. Its earlier runs and report snapshot remain immutable. A failure or inconclusive result can be investigated through a linked new experiment.

### Isolation, pairing, and randomization

Freeze baseline A and create B by applying only the approved config patch to that baseline in an isolated session. Never let “current game” drift during an experiment.

For each pair, match persona/version, game seed, bot seed where supported, save state, run length, speed, viewport, browser configuration, and runner/model settings. Both runs start from separate clean saves.

Alternate or seed-randomize A-first and B-first order within each persona. Interleave pairs over time rather than finishing all A runs before starting B.

Bots receive the same behavioural instructions and no label suggesting which variant should win. Store actual config hashes so `?variant=A` or `?variant=B` cannot accidentally resolve to the wrong configuration.

A shared random seed creates comparable starting conditions, not necessarily identical random events after the games diverge. Record the real event trace and never claim identical trajectories.

Keep StubBot and vision-bot experiments separate. A deterministic StubBot rerun with the same settings tests reproducibility, not a new independent sample.

### Practical statistics and sample plan

Use a binary primary outcome initially. This keeps the decision rule small enough to maintain without custom statistical infrastructure.

| Phase | Default plan | Purpose |
|---|---|---|
| Smoke | Two new seeds per persona; ten pairs across five personas | Catch instrumentation failures and severe regressions cheaply; no statistical winner |
| Discovery | Six additional seeds per persona; thirty pairs total | One fixed-sample feature decision using the rule below |
| Confirmation | Six fresh seeds per persona; another thirty pairs | Check that a promising result survives an independent seed set |

The thirty-pair floor is an operational starting point, not a power guarantee. Small effects or near-perfect baseline completion may remain inconclusive even after confirmation.

Select seeds before the phase begins. Use distinct seed cases and equal persona counts; do not add repeated identical deterministic runs to inflate sample size.

For completed matched pairs, count:

- **Both succeed**.
- **Both fail**.
- **B-only success**, called `b`.
- **A-only success**, called `a`.

The paired completion difference is `(b - a) / N`, where `N` includes all valid pairs, including ties.

Use the exact two-sided McNemar test: conditional on `a + b` discordant pairs, test their direction against a 50/50 binomial split. Use a maintained exact-binomial library routine and a predeclared threshold of 0.05. With no discordant pairs, the test value is 1 and the result is inconclusive.

The statistical check complements the 10-point practical threshold; passing either alone is insufficient. Test only the pooled primary outcome for the declared persona mixture. Persona results are descriptive because six seeds per persona are too few for reliable subgroup claims.

Explain uncertainty with the four pair counts, persona spread, and the exact test result. For secondary time and score metrics, show medians, interquartile ranges, and paired differences where both values exist. Do not present the interquartile range as a confidence interval.

Model randomness may remain uncontrolled even when a seed is supplied. Record this limitation. Any inference concerns these bots and sampled game scenarios, not human preference or population-wide player retention.

### Stopping and additional runs

Do not stop early for a positive delta. Calculate the formal verdict once, at the planned phase endpoint.

Early stopping is allowed for a reproducible critical regression, broken instrumentation, human cancellation, or the hard budget. Preserve the reason. A safety stop may reject a candidate without claiming a completed statistical comparison.

If discovery is promising and passes, request a fresh confirmation phase before marking confirmed. If discovery is close but inconclusive, propose one larger fixed-sample follow-up with a new plan and budget before collecting its data.

Do not append runs repeatedly until a test passes. Keep smoke, discovery, confirmation, and follow-up results separate; retain all attempts in the experiment history.

### Metrics and instrumentation

Use one primary metric for an experiment. Onboarding completion is the default because a quick first click can reward confusion and a high final score can hide onboarding failure.

| Metric | Definition | Source and use |
|---|---|---|
| Primary: onboarding completion | Basic Toolmaking completion event occurs within the planned horizon | Research event plus run manifest; boolean per run; game failure before completion counts as failure |
| Guardrail: critical progression failure | Confirmed inability to continue a required task within tested coverage | Stuck evidence and adjudicated diagnosis; critical new B-only failures block shipping |
| Guardrail: game crash | Game exception or lost game state attributable to the game | Browser/game error events; kept distinct from provider or runner failures |
| Time to first useful action | Time from interactive game-ready to the first successful objective-relevant action | Ready/action-success events; diagnostic, preferable to first click |
| Time to first click | Time from interactive game-ready to the first attempted click | Input event; instrumentation and latency diagnostic only |
| Stuck incidents | Distinct intervals of no progress after bounded recovery attempts, grouped by task and cause | Progress/action events plus classification; count incidents, not every repeated click |
| Tutorial-step time | Time between task activation and completion | Quest events; unfinished steps are marked censored at run end |
| Time to onboarding completion | Elapsed time to Basic Toolmaking completion | Report completed-run times with completion denominators; never drop failures from the primary metric |
| First reward | First successful Claim Reward event | Reward event; early achievement diagnostic |
| Chapter reach | Highest chapter entered and highest chapter completed | Chapter events; separate the two |
| Final score | Score at the same fixed horizon | State snapshot and score-definition version; secondary, not comparable across altered score formulas |
| Resource recovery | Required resource shortage followed by successful recovery and quest resumption | Resource, collection, and quest events; targeted diagnostic |
| Battle completion | Wins, losses, and unresolved battles with attempts | Battle events; downstream guardrail for relevant features |
| Runner reliability and cost | Infrastructure failures, calls, tokens, reserved/actual cost | Worker/provider usage records; operational health, not game quality |

Freeze the run horizon at approval. A practical onboarding default is 120 action attempts or ten elapsed minutes from game-ready, whichever comes first, with ×4 game speed. These are provisional limits to validate in smoke runs.

Run both variants to the same horizon even after onboarding succeeds so downstream guardrails have comparable exposure. An early genuine game blocker is a gameplay failure, not an exclusion. A manual stop is incomplete evidence.

Use monotonic elapsed timestamps and also record game simulation time. Never mix the two. Vision response latency affects elapsed time; keep runner family and settings matched and show API-wait time separately.

Store raw events as the authoritative source. Materialize summaries from a versioned metric reducer; compare to legacy summaries during migration. Missing completion telemetry is unknown, not automatically failure, unless the event stream is known complete and no completion occurred.

If a feature targets late-game battles, choose a suitable predeclared primary outcome in a separate experiment rather than using onboarding completion mechanically.

### Cost control

Default to StubBot smoke runs. Use paid vision runs only when visual perception is central or an inexpensive run cannot test the hypothesis.

Require an explicit currency budget for any paid phase. Do not guess a dollar amount or assume a free trial. Estimate from recent measured call costs and the approved provider rate snapshot.

Before each provider request, reserve its maximum expected charge within the experiment budget. Bound tokens, images, calls, and retries; reconcile reservations when actual usage arrives. Include segmentation, decisions, and analyst calls in the same ledger.

If a request has no enforceable charge bound, do not schedule it under a hard budget. Keep a safety reserve for final artifact writing and reporting; local storage must not depend on another paid model call.

Generate metric reports locally. Run expensive analyst diagnosis only on relevant failures, once per artifact hash and analysis version. Save frames on state changes and failures; do not pay to reanalyse identical images.

Never mix cheap StubBot samples and paid vision samples into one primary verdict. Create a linked vision validation experiment with its own approved sample and budget.

Spend more only for a predeclared confirmation or a justified follow-up near the decision boundary. If the budget cannot support it, report inconclusive instead of lowering the evidence standard.

### Shipping a winning patch

Test approval authorizes applying the candidate only inside isolated variant B sessions. It never authorizes production application.

After confirmation, a human reviews the exact diff, baseline, regressions, evidence limits, and rollback target, then records **Approve shipping** or **Reject**.

An explicit **Apply approved patch** action validates the approval hash and current production baseline before updating production configuration. If either differs, block application and require a new review or experiment.

A failed or partial apply must leave the old configuration active or restore it atomically. Record deployment status, resulting hash, operator, timestamp, and rollback reference.

The experiment record remains immutable evidence after shipping. Display **Shipped**, **Rolled back**, or **Not shipped** separately from **Confirmed**. A model, scheduled worker, or positive verdict cannot approve or apply a production patch.

### Concrete storage model

Add `studio.sqlite` beside existing run storage. Keep large artifacts in the existing per-run directories rather than storing video or frames in the database.

| Table | Minimum fields |
|---|---|
| `patches` | ID, revision, idea, config diff JSON, base hash, patch hash, validator version, validation result, created time |
| `experiments` | ID, parent ID, patch revision, frozen plan JSON/hash, lifecycle status, active phase, budget cap, created time |
| `phases` | ID, experiment ID, type, sample-plan JSON/hash, planned pair count, status, finalized report revision |
| `pairs` | ID, phase ID, persona/version, game seed, bot seed, repetition, run order, pair status |
| `run_links` | Run ID, pair ID, variant, attempt number, selected-attempt flag, exclusion reason |
| `decisions` | ID, experiment/phase ID, decision kind, actor, timestamp, patch/plan hash, reason |
| `cost_ledger` | ID, experiment ID, run ID, request ID, provider, reserved cost, actual cost, settlement status |
| `reports` | ID, experiment/phase ID, metric version, included-run manifest hash, result JSON path, created time |
| `deployments` | ID, experiment ID, shipping decision ID, before/after config hashes, state, actor, timestamp, rollback reference |

Use foreign keys, unique constraints, and transactional job claiming. Allow only one selected A attempt and one selected B attempt for a logical pair. Keep failed attempts for auditing.

```text
runs/<run_id>/
  manifest.json
  events.jsonl
  bot_steps.jsonl
  frames/manifest.json
  frames/<frame_id>.png
  video/<recording_file>
  analysis/sam/<frame_hash>.json
  analysis/diagnosis.<revision>.json
  metrics.<version>.json

experiments/<experiment_id>/
  plan.<revision>.json
  patch.<revision>.json
  reports/<phase_id>/<revision>.json
```

These filenames are proposed adapters to the current folder structure, not a requirement to rename existing evidence. The manifest maps actual artifact paths.

A run manifest records run ID, mode, experiment/pair/variant when present, build/config hashes, persona/model versions, seeds, limits, timestamps, status, terminal reason, and artifact availability.

Keep bug-hunt runs labelled `mode=bug_hunt`; experiment runs use `mode=experiment`. Never infer ownership from a filename or the most recent run.

Legacy reports remain available by explicit run ID. Do not assign old runs to a matched experiment automatically; expose them as historical, unmatched evidence only.

### API changes

All mutation endpoints require authenticated human intent where specified, validate state transitions, and use idempotency keys for retryable requests.

| Endpoint | Purpose |
|---|---|
| `POST /api/bug-hunts` | Start a diagnosis-only run |
| `POST /api/runs/{id}/stop` | Stop and finalize this run; repeated calls do not create new reports |
| `GET /api/runs/{id}/bug-report` | Return the run-specific report or explicit running/missing states |
| `POST /api/runs/{id}/analysis-retries` | Retry missing same-run analysis within its budget |
| `GET /api/runs/{id}/artifacts/{artifact_id}` | Serve only a manifest-listed artifact owned by this run |
| `POST /api/experiments` | Save a draft feature and plan |
| `GET /api/experiments` | List/filter saved experiments, patches, dates, and states |
| `GET /api/experiments/{id}` | Return plan, patch, phases, decisions, and provenance |
| `POST /api/experiments/{id}/validate` | Validate the config patch without applying it |
| `POST /api/experiments/{id}/decisions` | Record human test approval, rejection, or shipping approval against exact hashes |
| `POST /api/experiments/{id}/phases` | Create a planned smoke, discovery, or confirmation phase |
| `POST /api/experiments/{id}/phases/{phase_id}/start` | Schedule approved matched pairs within the budget |
| `POST /api/experiments/{id}/stop` | Stop scheduling, finalize available evidence, preserve incomplete state |
| `GET /api/experiments/{id}/report` | Return a specified phase/report revision; never substitute another experiment |
| `GET /api/experiments/{id}/runs` | Return the complete paired inventory, including failures and retries |
| `POST /api/experiments/{id}/apply` | Explicit human production application; require valid shipping approval and matching baseline |

The worker, model service, and browser bot must not possess permission to call approval or production-apply endpoints. Server-side authorization enforces this, not a disabled button alone.

On infrastructure failure, allow one replacement pair by default. Preserve the original pair attempts, rerun both sides with the same setup, and never select the better outcome. Unclassified or repeated failures require human review.

### Build order and acceptance checks

1. Add run manifests and strict artifact ownership checks; verify that missing frames never display another run or a demo image.
2. Separate Bug hunting and Feature Forge routes and report schemas; verify Report A has no patch controls or A/B content.
3. Implement stop/finalize states and partial reports; verify worker crashes, missing SAM data, and unfinished analysis render honestly.
4. Add SQLite patch and experiment records with immutable revisions; retain the current runner and expose historical experiments by ID.
5. Add hash-bound test approval and isolated A/B configuration resolution; verify neither path can mutate production.
6. Add pair scheduling with frozen seeds, settings, alternating order, and clean saves; inspect paired manifests before enabling comparisons.
7. Add the versioned metric reducer and run inventory; verify unknown telemetry, crashes, retries, and censored times retain correct denominators.
8. Add the budget ledger and bounded provider requests before enabling paid experiment phases; test cancellation and reservation recovery.
9. Add the fixed-sample primary verdict, guardrails, and descriptive persona breakdown; test ties, no discordant pairs, missing pairs, and opposing outcomes.
10. Add confirmation phases and immutable report snapshots; verify extra runs cannot silently rewrite a completed verdict.
11. Add shipping approval and explicit atomic application with rollback records; verify stale baselines and changed patch hashes block application.

The first release needs no custom charts, composite persona score, automatic sample-size optimization, or model-written feature verdict. Structured tables and a deterministic verdict function are sufficient.
