# Build plan

Deadline: **Wed Nov 4, 9:00 PM ET (Thu Nov 5, 03:00 Berlin)**. Target a finished submission by the evening of Nov 4 Berlin time.

## Work split between coding tools

### Claude Code, Oct 27 to 29: the game, config/telemetry contracts, and in-game AI Director UI
Claude Code access ends on Oct 29, so these two days are dedicated to building a genuinely impressive, high-craft browser strategy game plus the exact config, telemetry, and UI contracts that the agents will plug into from Oct 29.
- [x] **Polished 2.5D isometric historical city-builder** in the browser (HTML5 Canvas + ES modules + F2P strategy UI chrome): 12x12 isometric diamond grid, terrain & shoreline animation, hybrid sprite loader (loads transparent isometric PNG sprites generated via Gemini Pro / Antigravity at $0 Meta API cost, with rich procedural isometric fallback), scaffolding-to-building animations, walking villagers, and floating resource popups.
- [x] **Real F2P strategy gameplay depth (20-minute window):**
  - 3 onboarding steps (`onb_01_shelter`, `onb_02_forager`, `onb_03_handoff`) flowing into `free_play` and an Era Upgrade (`Dawn Age` → `Stone Age`) for `first_achievement`.
  - 4 resources (Food, Wood, Stone, Research Points) + **Population & Worker assignment** (Shelters add population; production buildings require available workers).
  - 7 buildings (Town Center, Shelter, Forager Hut, Woodcutter Hut, Stone Quarry, Research Academy, Tribal Monument) and a **visual Tech Tree modal with 5 technologies** (*Basic Toolmaking*, *Woodworking*, *Foraging Baskets*, *Masonry*, *Stone Age Awakening*).
- [x] **Config & patch service (FastAPI + Pydantic):** immutable `base_config.json` with planted onboarding & early-play friction, flat `GameConfigPatch` validation, human approval gate (`proposed -> validated -> approved/rejected`), and `audit_log.jsonl`.
- [x] **Telemetry & determinism:** seeded PRNG (`mulberry32`), simulation clock (`?speed=1..4`), raw event logging (`events.jsonl`), unbiased Python-side `stuck` derivation (`AnalysisConfig`), and `summary.json`.
- [x] **In-game right dock (`#right-dock`) & replay view:** Telemetry Pill, AI Director panel (Live trace, Analyst/Designer with human Approve/Reject buttons, A/B summary), and side-by-side replay player (`/?replay_a=&replay_b=`).
- [x] **Bot-ready DOM/Canvas hooks (`window.__GAME_STATE__`, `window.__GAME_DEBUG__`)** and tests for config, approval gate, and telemetry, plus a clean handoff note for Muse Code.

### Muse Code, Oct 29 to Nov 4: bot runner, Meta API client, agents, experiments, demo
Building the computer-use loop and multi-agent pipeline in Muse Code highlights Meta tooling.
- [x] **Meta Model API client (`backend/meta_client.py`):** SAM 3.1 set-of-mark segmentation, Muse Spark (`muse-spark-1.3-contributor` default) structured decisions, disk caching, token/cost ledger, and hard budget caps.
- [x] **Playtester bot runner (`backend/bot_runner.py`):** Playwright computer-use loop (960x540 clip capture, SAM marks, Muse Spark decision, cyan click ring, video/frame recording) plus variant-blind stub mode.
- [x] **Persona playtesters and prompts:** `first_time_casual`, `impatient_newcomer` (rush-clicker) and `optimizer` (see Run protocol below).
- [x] **Analyst agent:** SAM 3.1 on key screenshots, onboarding + early-play funnel, and ranked friction points.
- [x] **Designer agent:** concrete config patches routed through the human approval gate in the AI Director dock or CLI.
- [x] **Experiment agent:** canary + parallel worker pool A/B reruns on old and new configs, paired statistical report (`ab_summary.json`), and `voiceover_sheet.txt`.
- [ ] Validation against human play sessions, README setup instructions, and the 3-minute demo video.

### Antigravity (Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5 / Sonnet 5.5, Image Generator): whole event
Weekly limits reset around Nov 1, so there are two full windows during the event.
- **Asset generation ($0 Meta budget):** Use Antigravity's image generation (Gemini Pro subscription) + a Python background-removal script to produce consistent 2.5D isometric building sprites, terrain props, and advisor portraits for the game.
- **Gemini 4 Argon**: architecture decisions, hard debugging, and a review pass on each milestone (game foundation, play loop, analyst, A/B).
- **Claude Opus / Sonnet 5.5**: continues Claude-style work after Claude Code access ends on Oct 29, for refactors and fixes in code Claude Code wrote.
- **Gemini 3.8 Flash**: routine edits, tests, docs and README polish, to save the stronger models' limits.
- Muse Code remains the main tool for agent logic from Oct 29, so the Meta tooling story stays strong.

## Meta API budget ($150 credits, valid for the 10-day window)
Code is written with Claude Code, Muse Code and Antigravity, not with API credits. Credits go to running and testing the product. The 3-minute video is only a small slice; the goal is to spend most credits on real test runs over the full 20-minute window (10 min onboarding + 10 min early play).

### Prices (dev.meta.ai/docs/pricing-rate-limits, checked 2026-10-27)
| Model | Standard (`muse-spark-1.3`) | Contributor mode (`muse-spark-1.3-contributor`) |
|---|---|---|
| Muse Spark 1.3 | $1.25 / 1M input, $0.15 / 1M cached input, $4.25 / 1M output | $0.10 / 1M input, $0.002 / 1M cached input, $0.20 / 1M output |
| SAM 3.1 | $2.50 / 1,000 images | n/a (always standard) |
| Muse Voice Transcribe | $0.18 / hour of audio | n/a (always standard) |

Rate limits are per team: Muse Spark 3,000 RPM and 4M TPM (contributor: 150 RPM, 3M TPM), SAM 3.1 3,000 RPM. A pool of ~5 parallel workers makes roughly 60-100 Muse Spark calls per minute, inside the contributor limit; do not raise the pool much above 6 in contributor mode.

### Model mode: contributor by default (Timur's decision, 2026-10-27)
- Default Muse Spark model id is `muse-spark-1.3-contributor`. Same key, credits and endpoint; only the model id differs.
- Trade-off: Meta may train on everything sent and received in this mode (prompts, game screenshots, model outputs). Acceptable for our own original game in a public repo. Never send anything that is not ours.
- Switch to standard `muse-spark-1.3` with one config value (`muse_model_id` in `configs/budget_config.json`). Every ledger line records the model id and mode, so costs stay attributable.
- SAM 3.1 and Muse Voice Transcribe have no contributor mode.

### Per-step and per-session estimate (assumptions, replace with measured values on day 1)
- One bot step = one SAM call ($0.0025, less with the frame-hash cache) + one Muse Spark call (~2,600 input tokens incl. the image, ~800 output tokens incl. reasoning). In contributor mode the Muse Spark call is ~$0.0004, so **SAM becomes the main cost**: about **$0.0025-0.003 per step** (lower when static screens hit the SAM cache).
- Image token count is not published by Meta; it is the main uncertainty. Estimates below already carry a margin.
- Onboarding-only session (`MAX_BOT_STEPS` ~25): ~$0.06-0.08. An onboarding batch of 24 sessions (one variant) is ~$1.50.
- Full 20-minute window session (~80 steps, `MAX_BOT_STEPS` ~100): ~$0.20, up to $0.35.
- Full-window batch of 24 sessions (one variant): ~$5-8. A first A/B pair (48 sessions) ~$10-17; each later loop only reruns the new variant (see Run protocol).
- Standard mode for comparison: ~$0.01 per step, ~$0.80-1.60 per full session, ~$20-40 per 24-session full-window batch.

### Allocation (testing first)
| Share | Amount | Use | Roughly buys (contributor mode) |
|---|---|---|---|
| ~5% | $7 | Development and debugging. Most dev runs on `stub` or open-weights models (Baseten/Modal credits). Meta for the day-1 calibration and canaries. | Day-1 calibration (~$2) plus 15+ canary/debug full sessions |
| ~70% | $105 | Playtester experiment runs: onboarding loops and full-window loops on the 3 personas x 8 seeds matrix, final end-to-end validation. | ~300-500 full sessions, i.e. ~12-20 full-window variant batches of 24, or ~70 onboarding batches |
| ~10% | $15 | Analyst and designer reasoning, SAM on key screenshots, validation. | Hundreds of loops |
| ~15% | $23 | Reserve: final recorded runs for the video, reruns on Nov 3-4, standard-mode spot checks, transcription for subtitles (~$0.01), and **Muse Image** (~$1-3) for (1) logged sprite/portrait/tech-icon upgrades and (2) Designer Agent generating a high-salience Variant B Research emblem behind the Human Approval Gate. | |

If we switch back to standard mode, the same $105 buys roughly a quarter as many sessions (~65-130 full sessions).

### Run protocol (reviewed with Gemini 4 Argon, 2026-10-27)
Many short, independent sessions, not one long run. One pair is a demo, not evidence.

**Experiment matrix**
- 3 personas: `first_time_casual` (reads the tutorial, acts carefully, gets lost in a crowded UI), `impatient_newcomer` (rush-clicker: skips text, clicks big bright buttons, builds at random), `optimizer` (min-maxer: counts resources, looks for production bottlenecks).
- 8 fixed game seeds (`42`-`49`; `42` stays the demo seed).
- 3 x 8 = **24 sessions per variant, 48 per A/B pair**, paired by `(persona, seed)`.
- Variation comes from game seeds and personas, not from LLM temperature. Repeating the same state with `temperature > 0` mostly buys near-identical trajectories.

**Patch types and starting points**
- **Onboarding patches** (touch anything in the first 10 minutes): always run from `t=0`, ~25 steps (`MAX_BOT_STEPS` ~25).
- **Early-play patches** (touch only minutes 10-20): may start from one standardised "golden" checkpoint per `(persona, seed)`, recorded once on the current baseline. Only allowed if the patch provably does not touch the first 10 minutes. A checkpoint recorded on A is never used to start a B that changed onboarding.
- **Final validation:** an end-to-end `0 -> 20 min` run with no filtering between stages.
- Avoid survivorship bias: do not send only the sessions that finished onboarding into early play and then compare A and B on those survivors; the two groups are no longer comparable. Given contributor prices, prefer plain end-to-end full-window runs; checkpoints are an optimisation, not a requirement.
- A session still stops early on `stuck_abort`; that stop is the main churn data point and saves credits.

**Execution**
- One canary session first (pipeline does not crash, tokens look normal), then a pool of ~5 parallel Playwright workers (configurable, 4-6). Do not launch dozens at once: a broken selector or prompt would burn credits in minutes.
- Every session starts with a fresh `BrowserContext` (no `localStorage`/`IndexedDB` carry-over) and fresh bot memory (message history, scratchpad). Otherwise the bot "remembers" hints from earlier runs.
- Expected wall time: ~5-7 min per full session; a 24-session batch on 5 workers ~40 min.

**Caching**
- SAM cache by frame hash: always on (segmentation is deterministic for the same frame).
- Muse Spark response cache: **off during A/B experiment runs**, otherwise identical starts return the same cached decision and N=10 is really N=1. On only for replay/recording (`META_CACHE_ONLY=1`) and parser debugging.

**Loops and baseline reuse**
- Loop: baseline batch on A, analyst and designer propose a patch, human approves, the same 24 `(persona, seed)` pairs run on B, paired comparison reported.
- The approved B becomes the baseline of the next loop and is not rerun (same pairs, same seeds, same model id and mode). Each later loop costs one batch instead of two.
- Suggested order: day-1 calibration, then 2-3 fast onboarding loops (~$1.50-2.50 each), then several full-window loops (~$5-8 per new variant), then the final end-to-end validation and recorded takes.

**Paired reporting** (`runs/ab_summary.json`, README and video)
- Binary metrics (`onboarding_completed`, stuck yes/no): McNemar's test on the paired outcomes, plus a 95% CI for the difference in proportions (Wilson or bootstrap). Report as X/24 -> Y/24.
- Continuous metrics (`time_to_first_action_sec`, `stuck_events`, steps to a building, score at the 20-minute mark): Wilcoxon signed-rank or a paired bootstrap on the 24 deltas `B - A`. Report `N` and `median delta [95% CI]`.
- With N = 24 pairs we can only detect large effects (a broken step fixed, stuck rate halved). Do not claim small improvements; never report numbers that are not from run logs.

### Rules
- Day-1 calibration: 3 full-window sessions, one per persona (~$2). Read actual tokens and the SAM cache hit rate from `runs/cost_ledger.jsonl`, then resize the numbers above.
- Hard caps in `configs/budget_config.json`: per session $2, per bucket as above, global stop at $140. The client refuses calls past a cap.
- Never re-run uncached sessions just to record video; use `META_CACHE_ONLY=1`.
- Credits may expire before the live final on Nov 9. Keep recorded or cached runs ready for a live demo.
- **Public judge hosting ($0 cost & $0 Meta API drain):** Run the heavy 24-session A/B Playwright + Meta API batches locally on Mac, commit the winning cached run artifacts into `runs_demo/`, and deploy the FastAPI app in `META_CACHE_ONLY=1` mode to Hugging Face Spaces (Docker, 2 vCPU / 16 GB RAM free) or Modal / Cloud Run. Judges can play Variant A and B, click `[▶ Watch Bot Play]`, inspect SAM 3.1 masks & Muse Spark thoughts, click `[Approve Patch]`, and watch the side-by-side A/B replay at zero runtime API cost.

## Handoff log
- 2026-10-26: Repo created (meta-ai-hackathon) with README, AGENTS.md, CLAUDE.md, hackathon docs and this plan. No code yet.
- 2026-10-27: Added `docs/video-script.md` (180 s script), `docs/architecture.md` (two-day game and bot connection design) and `docs/tasks/claude-code-build-game.md` (build task for Claude Code), after five review rounds with Gemini 4 Argon (`docs/hackathon/argon-review-log.md`). Stack decision: Python backend (FastAPI, Playwright, Pydantic) plus a plain JS game, no Node. Next: Claude Code starts Day 1 of the build task.
- 2026-10-27: Budget section rewritten from Meta API prices: testing-first allocation (70% playtester runs over the full 20-minute window), per-session estimates, hard caps. Measure real tokens on day 1.
- 2026-10-27: Added run design: many short stage-gated sessions with checkpoints and early stop instead of single 20-minute runs.
- 2026-10-27: Run protocol updated after a Gemini 4 Argon review: contributor mode as default (`muse-spark-1.3-contributor`, switchable), 3 personas x 8 seeds paired matrix, onboarding vs early-play patch types with golden checkpoints only for early-play, canary plus ~5 parallel workers, Muse Spark cache off in experiments, McNemar and paired bootstrap reporting, costs re-estimated (~$0.20 per full session).
- 2026-10-27: Re-scoped the Oct 27–29 Claude Code sprint to focus on building a high-craft 2.5D isometric historical city-builder (12x12 isometric grid, hybrid PNG sprite + procedural isometric renderer, 7 buildings, 4 resources + population/worker assignment, 5-node visual Tech Tree, Era upgrade Dawn Age → Stone Age) plus the FastAPI config/patch service, telemetry sink, and `#right-dock` AI Director UI. Isometric sprites generated via Gemini Pro / Antigravity (`$0` Meta API credits). Playwright bot runner, Meta API client, and agents move to Oct 29+ (Muse Code).
- 2026-10-27 (Claude Code, `claude/build-game`): Day 1 and Day 2 of `docs/tasks/claude-code-build-game.md` are built. Done: isometric game client (`frontend/static/`), FastAPI config, patch and approval backend, telemetry sink with server-derived `stuck`, `#right-dock` (Telemetry Pill, AI Director with Live, Analyst & Designer and A/B tabs, Approve/Reject gate), config inspector, side-by-side replay, stub persona bot behind Watch Bot Play, 36 passing tests (unit plus headless Playwright). Stub bot check (3 personas x seeds 42 and 7): A stalls at `onb_03_handoff` in 5 of 6 runs, B completes onboarding in 6 of 6 and reaches the Stone Age in 2 of 6. Notes for the next tool:
  - The game emits a `heartbeat` event (resources, score, free workers) every few sim seconds.
  - Config fields added beyond the spec: `research_toolmaking_wood_cost`, `research_masonry_wood_cost`, `research_stone_age_*_cost`, `lock_optional_builds_until_step` (locks optional builds while `stepIndex <= ` that step).
  - The Woodcutter Hut produces only after Basic Toolmaking. This makes the A stall a true deadlock.
  - Optional builds get the NEW! ribbon and high salience only from `onb_03_handoff` on.
  - Click results are `advanced`, `collected`, `rejected`, `noop` and `ui`. A harvest is `advanced` when it makes a new build/tech affordable or saves up a resource needed for the current step's goal (`savesTowardGoal`), otherwise `collected` (so gathering food at the `onb_03_handoff` wood dead end still does not reset the stuck timer).
  - No worker assignment toggle yet: each producer takes a fixed number of workers.
  - Expected console 404s: `/analysis` and `/api/ab_summary` until the analyst and experiment agents write them.
  - `stub_bot.js` is a placeholder for the Muse Spark playtester. It reads only `getRenderedTargets()` and logs `provider_mode: stub`. Replay refuses stub runs without `&dev=1`.
  - Next: Playwright runner with Muse Spark (`--mode meta`), analyst writing `runs/<id>/analysis.json`, experiment agent writing `runs/ab_summary.json`.
- 2026-10-27 (Gemini 4 Argon review & merge): Reviewed `claude/build-game` milestone diff (`581e202..c80f9cb`). Added `savesTowardGoal()` in `frontend/static/game.js` so saving up resources across multiple harvests in `free_play` counts as `advanced` (preventing false `free_play` idle stuck events on winning Variant B runs while keeping food harvests at the `onb_03_handoff` wood dead end as `collected`). Documented the two **Muse Image** workflows (logged asset/portrait polish + closed-loop Variant B high-salience UI emblem generation) and the `$0` judge hosting strategy (`runs_demo/` + `META_CACHE_ONLY=1` on Hugging Face Spaces / Modal). Merged `claude/build-game` to `main`.
- 2026-10-27 (Claude Code, `claude/phase2-depth-and-infra`): Phase 2 of `docs/tasks/claude-code-phase2.md` is built. 65 tests pass, all offline at $0 Meta spend. Done: three eras, upgrades, quests, expeditions, worker assignment; `backend/meta_client.py` (Set-of-Mark, SAM and Muse adapters behind `provider_mode == "meta"`, cache, cost ledger with per-session, bucket and global caps); async `backend/bot_runner.py`; `backend/agents/` (analyst, designer, experiment); `backend/cli.py`; `runs_demo/` fallback; Dockerfile. Notes for the next tool:
  - The closed loop uses `run_type=full_window`, because stub B cannot reach the first achievement within 25 onboarding steps.
  - Stub results (impatient_newcomer, full window): A stalls at `onb_03_handoff` on seeds 42 to 45. B completes onboarding on all four and reaches the Stone Age on 42 and 44 only. The e2e test pins seeds 42 and 44.
  - The voiceover sheet counts onboarding stuck events only (`onboarding_stuck_events`); free-play stalls after the handoff are reported separately.
  - The analyst diagnosis is a deterministic stub in stub mode. `reason_json` calls Muse Spark only in meta mode.
  - Telemetry JSON files are now written atomically: parallel sessions raced `/live` reads against flushes.
  - `runs_demo/` holds one stub loop without frames (1.7 MB). Its `patch_005` exists only in the demo config copy, not in `configs/patches/`.
  - Not verified: the Docker build (the daemon was not running) and any live Meta call.
  - Next: the PM feature studio (`docs/tasks/claude-code-pm-feature-studio.md`), then a first small live run in meta mode.
- 2026-10-28 (Claude Code, `claude/pm-feature-studio`): The PM feature studio from `docs/tasks/claude-code-pm-feature-studio.md` is built. 75 tests pass, all at $0 Meta spend.
  - Done: `feature_plugin` in config and game, five personas with archetype, emblem and citations, `/api/feature_studio/{propose,playtest,jobs,report,rework}`, and the Architect's Council dock (Feature Forge, Council Report, Live Chronicle).
  - The stub parser reads free text into a plugin. The emblem is a procedural PNG in stub mode; Muse Image runs only in meta mode.
  - A feature patch stacks on the latest approved non-feature patch, so arm A plays that baseline and the arms differ only by the feature.
  - The verdict uses measured data only. A drop in tutorial completion or Stone Age is HURTS; the takeaway reports the McNemar p-value.
  - The NEW! pulse clears after the first use, so stub bots no longer spam the feature button.
  - Real stub playtest (5 personas, seed 42, full window): Raider Ambush at step 2 and its free-play rework both read HURTS. Each time one of five personas lost Stone Age (40% to 20%, McNemar p = 1.00). That is noise at n = 5; the clean HURTS then POSITIVE story is shown only by the unit test with a deterministic fake session.
  - Next: run more seeds before trusting a studio verdict, then a first small live run in meta mode.
- 2026-10-28 (Claude Code, `claude/pm-feature-studio`): Visual and functional audit of the game and the dock at 1400x800, in stub mode at $0 Meta spend. Screenshots stayed outside the repo.
  - Real stub playtest of "Add a Raider Ambush button at tutorial step 2 that costs wood and rewards score", run with `patch_001` approved: HURTS (onboarding 100% to 60%), then the rework reads POSITIVE. Each playtest took about 4 minutes. Without an approved `patch_001` the baseline is variant A, which already stalls, so the first verdict reads POSITIVE instead.
  - Fixed: the tech tree nodes clipped their last line, and the dashed edges showed through the text of locked nodes. The crest and the pill wrapped onto a second line. The decree emblem said "Generated via Muse Image" in stub mode; it now says "Procedural stub emblem". The rework rationale was cut off. Live Chronicle STUCK rows were dark red text on red. The replay labelled arm A "base config" when it ran `patch_001`. The split replay button left out `&dev=1` for stub runs and got refused. Approve and Summon now scroll the next step into view.
  - New test: `tests/test_feature_studio_ui.py` clicks the Feature Studio flow in the dock (forge, approve, playtest, HURTS, rework, approve, playtest, POSITIVE) with the fake playtester. It fails on page or console errors and on horizontal overflow in `#right-dock`.
  - Known: the app is a fixed 1280x540 layout, so a 1400x800 window shows empty space. Left as is, because the bot click coordinates and the clip tests depend on it.
- 2026-10-28 (Claude Code, `main`): Final polish of the feature studio, merged `claude/pm-feature-studio` into `main`. 76 tests pass on both branches at $0 Meta spend.
  - Each persona now voices its own first-use and repeat-use line for a feature. Personas without a match keep the generic line.
  - The rework tones a `high_pulse` button down to `medium` when it moves the feature to free play. The schema has no `high` level.
  - The Council Report keeps the onboarding loop (`patch_001`) and its A/B below the feature report in a collapsible section. The Forge hints to approve `patch_001` first when a feature has no baseline.
  - The dock UI test allows the 404s for a missing run analysis and A/B summary, which render as notes. Any other failed response still fails the test.
  - Argon review round 7 is in `docs/hackathon/argon-review-log.md`.
- 2026-10-28 (Muse Code, `muse/agent-intelligence`): Multi-agent intelligence upgrade, all at $0 Meta spend (`META_PROVIDER=stub`, no live calls in tests).
  - Analyst: `compute_visual_salience` measures the SAM distractor-to-goal pixel-area ratio (Woodcutter card, or the `btn_feature_*` button under test); the ratio lands in the `low_research_salience` evidence, the Muse Spark evidence payload and `analysis.json`. The stuck-frame focus masks highlight the feature button when one is on screen.
  - Playtester: stateful `update_scratchpad` (current step, steps in stage, repeat-click streak, last mood) feeds a compact "Working memory" line into the Muse Spark prompt; `cache_key` is unchanged so cached decisions stay compatible.
  - Feature studio: `summarize_persona_outcomes` joins A/B pairs with `personas.json` archetypes; the breakdown is in the council report and the rework prompt, and `stub_rework` names stalled archetypes that used the feature in onboarding.
  - Tests: new `tests/test_agents.py` (7 tests) plus 4 council tests in `tests/test_feature_studio.py`; `test_fresh_session_state.py` now pins scratchpad freshness instead of emptiness. Full suite: 87 passed.
  - Next: review and merge to `main`, then a first small live run in meta mode.
- 2026-10-28 (Muse Code, `muse/agent-intelligence`): Surfaced agent intelligence in the dock and merged to `main`, all at $0 Meta spend (stub mode, no live calls in tests).
  - The Council Report now shows the SAM 3.1 visual salience note (distractor vs Research goal, 6.76x on the demo run) under the stuck frame plus the quantified hypothesis list below the diagnosis. A fresh page falls back to `demo_play_A` analysis, so the tab renders out of the box.
  - Fixed `analyze_run` wiping committed visual evidence: runs without `frames/` (like `runs_demo/`) keep their saved SAM masks and stuck frame, and the salience ratio rebuilds from masks plus the run's resolved config. New regression test in `tests/test_agents.py`.
  - Refreshed `runs_demo/demo_play_A/analysis.json` via the stub CLI (`visual_salience` 6.76, updated evidence string). README status and architecture notes plus the plan checklist now cover the salience ratio, the per-persona working-memory scratchpad and archetype-aware rework synthesis.
  - Full suite green on the branch and on `main` after the merge. Next: a first small live run in meta mode.
