# Task for Claude Code: build the game foundation and bot connection layer (Oct 27–29)

## Read first
1. `AGENTS.md` (rules and hard constraints), then `docs/plan.md` (work split, budget, Handoff log).
2. [`docs/architecture.md`](../architecture.md): the design to implement. Names, files and schemas there are binding.
3. [`docs/video-script.md`](../video-script.md): what the demo must be able to show. Keys, step ids, metric names and overlay names must match it exactly.
4. `docs/hackathon/rules-summary.md`: judging and anti-projects.

## Goal
By the end of Oct 29, the repo contains a playable, original browser city-builder with config-driven onboarding, a validated patch system with a human approval gate, raw-event telemetry with unbiased metrics, and a Python + Playwright bot that plays through SAM 3.1 marks and Muse Spark decisions. The full loop (play → diagnose → propose → approve → rerun) runs end to end on stubs, with tests, so Muse Code can take over the agent logic on Oct 29.

## Scope
**In**
- FastAPI backend serving the API and the static game (`uvicorn backend.app:app`).
- Plain JS ES modules + HTML5 Canvas + CSS game in `frontend/static/` (no Node, npm or bundler).
- Onboarding steps `onb_01_shelter`, `onb_02_forager`, `onb_03_handoff`, then `free_play` to a `first_achievement`. Buildings: Shelter, Forager Hut, optional Woodcutter Hut, Research (Basic Toolmaking).
- Pydantic schemas: `GameConfig`, `GameConfigPatch`, `AnalysisConfig`, `TelemetryEvent`, `BotStepRecord`, `BudgetConfig`.
- Config service: merge (`exclude_unset`, explicit null kept), validation, patch lifecycle, approval gate, `audit_log.jsonl`.
- `configs/base_config.json` with the planted handoff friction and `configs/patches/patch_001.json` (status `proposed`) as a fixture.
- Telemetry sink: raw events, derived `stuck` via `AnalysisConfig`, `summary.json` metrics (`where_stuck`, `time_to_first_action_sec`, `stuck_events`, `onboarding_completed`).
- Right dock (x 960–1280): Telemetry Pill and AI Director panel (Live, Analyst/Designer with Approve/Reject, A/B summary). Not a separate dashboard.
- Bot runner: 1280x540 viewport, `device_scale_factor=1`, 960x540 clip capture, idle barrier, cyan click ring, Playwright video and per-step frames, `window.__BOT_CTX__` correlation ids.
- Meta client: SAM 3.1 set-of-mark, Muse Spark structured decision, disk cache, cost ledger with budget buckets, provider switch `stub | open_weights | meta`, `META_CACHE_ONLY=1`.
- Agent stubs `backend/agents/{analyst,designer,experiment}.py` with typed interfaces and deterministic outputs.
- Replay route `/?replay_a=&replay_b=&speed=4` from artifacts.
- CLI `python -m backend.cli` with `run-session`, `run-closed-loop`, `replay`.
- Tests, README run instructions, Handoff log entry.

**Out (do not build now)**
- Real analyst, designer and experiment reasoning (Muse Code, from Oct 29).
- Persona prompt tuning beyond two starter personas.
- Units, combat, pathfinding, isometric art, sound.
- Any dashboard app or Streamlit.
- The demo video itself.

## Milestones

### Day 1 (Oct 27–28): game, config, telemetry, dock
1. Project skeleton: `pyproject.toml` (fastapi, uvicorn, pydantic>=2, playwright, pillow, python-dotenv, pytest, httpx), `backend/`, `frontend/static/`, `configs/`, `tests/`, `runs/` in `.gitignore`.
2. `backend/schemas.py` with all models from architecture section 4–5.
3. `backend/config_service.py` + endpoints: `GET /api/config?variant=&patch_id=`, `GET /api/patches`, `POST /api/patches` (creates `proposed`, validates), `POST /api/patches/{id}/approve`, `POST /api/patches/{id}/reject`. Unapproved patch on a config or experiment request → 403.
4. Game: `clock.js` (mulberry32, sim clock with `speed`), `game.js` (pads, resources, advisor steps, build bar, Research, achievement, honours all four lever groups, idle flag, click sequence, `__GAME_DEBUG__.getRenderedTargets()`), `main.js` (URL params, config load, event posting with `__BOT_CTX__` ids).
5. `backend/telemetry.py` + `POST /api/events`: append to `runs/<run_id>/events.jsonl`, derive `stuck`, write `summary.json`, stream the step log to the dock (SSE or polling).
6. `overlay.js`: Telemetry Pill and AI Director in `#right-dock`; patch diff, validation badge, Approve/Reject buttons wired to the API; yellow stub banner when `provider_mode != meta`.

**Day 1 done when:** manual play of `?variant=A&seed=42` with the optional hut at the handoff produces `action_rejected` and a derived `stuck`; Approve in the AI Director moves `patch_001` to `approved`; `?variant=B&patch_id=patch_001` locks optional builds and pulses Research; an unapproved patch gets 403.

### Day 2 (Oct 28–29): bot, Meta client, stubs, loop, tests
7. `backend/meta_client.py`: provider switch, SAM 3.1 call + mark filtering (area filter, top K) + set-of-mark rendering + centroid click targets, Muse Spark call with JSON output, caches keyed as in architecture section 8, `cost_ledger.jsonl`, buckets from `configs/budget_config.json`, `BudgetCapExceededError`, `META_CACHE_ONLY`. Key loaded from `.env` inside the app only. If the exact Meta API endpoints or SDK are unclear, put them behind one adapter function with a clear TODO and keep stub mode working; do not guess at billing-heavy calls in loops.
8. `backend/bot_runner.py`: loop and stop conditions (`MAX_BOT_STEPS`, `stuck_abort`, success), dock-intersection assertion, `bot_steps.jsonl`, frames, `som_masks/`, Playwright video.
9. Stub policy: variant-blind, reads `getRenderedTargets()`, salience score with seeded tie-breaks.
10. Agent stubs and `experiment.py` paired-seed runner writing `runs/ab_summary.json` and `runs/voiceover_sheet.txt`; refuses mixed provider modes.
11. `replay.js` split-screen on one timeline; refuses non-`meta` runs unless `?dev=1`.
12. `backend/cli.py` `run-closed-loop`: play A → analyst stub → designer stub creates `patch_001` (`proposed` → `validated`) → **asks a person to approve in the terminal or the AI Director** (never auto-approves; tests use an explicit test-only approval helper) → paired A/B → summary.
13. README "Getting started", README Status checklist, Handoff log entry in `docs/plan.md`.

**Day 2 done when:** `python -m backend.cli run-closed-loop --mode stub --seeds 42,43` completes and writes `ab_summary.json` (A stalls at `onb_03_handoff`, B reaches `first_achievement`); one live smoke run `--mode meta --seed 42` (only if Timur has set up `.env`) writes real `som_masks/`, logs cost, and costs nothing on a cached rerun; `pytest` passes.

## Acceptance tests (`tests/`)
- `test_config_merge_and_validation.py`: omitted keys unchanged, explicit null kept, unknown keys rejected, ranges enforced.
- `test_human_approval_gate.py`: config/experiment with an unapproved patch → 403 / `ApprovalRequiredError`; audit log records every transition with the actor.
- `test_unbiased_metrics.py`: changing `idle_hint_delay_sec` does not change `stuck_events` for the same event trace.
- `test_metrics.py`: `time_to_first_action_sec`, `where_stuck`, `onboarding_completed` on fixture traces.
- `test_stub_bot_divergence.py`: the variant-blind stub stalls on A and completes B on the same seed (Playwright, headless).
- `test_cache_and_budget.py`: cache hit logs zero cost; bucket overflow raises `BudgetCapExceededError`; reserve needs the flag.
- `test_bot_clip_isolation.py`: no `#right-dock` element intersects the 960x540 clip.
- `test_e2e_closed_loop_stub.py`: full loop on stubs produces `ab_summary.json`.

## Constraints (from AGENTS.md, non-negotiable)
- **No secrets in code, logs or commits.** Read the key from `.env` inside the app. Never export `META_API_KEY` in the shell, never print it.
- **No InnoGames material** (data, code, configs, screenshots, art). Original code and assets only.
- **Budget:** default to `stub`; no live Meta calls in tests or loops without the budget guard; at most one live smoke run in this phase.
- **Human approval gate:** nothing applies or runs a patch without `approved` status set by a person.
- **No dashboard or Streamlit** as a feature; all loop UI lives in the in-game right dock.
- **No invented numbers** in docs or UI; metrics only from run logs.
- Work on a `claude/<task>` branch, small commits, keep the demo path runnable, merge to `main` only when the loop runs end to end. Update the Handoff log at the end of each session.
- The repo will be public: clean commits and docs.
