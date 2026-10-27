# Build plan

Deadline: **Wed Nov 4, 9:00 PM ET (Thu Nov 5, 03:00 Berlin)**. Target a finished submission by the evening of Nov 4 Berlin time.

## Work split between coding tools

### Claude Code, Oct 26 to 29: foundations
Claude Code access ends on Oct 29, so this phase covers the hard, structural parts.
- [ ] Browser game with config-driven onboarding (tutorial steps, hints, pacing, difficulty) and structured event logging.
- [ ] Meta Model API client with response caching, token and cost logging, and a hard budget cap.
- [ ] Playtester agent skeleton: a computer-use loop (screenshot, decide, act) driving the game through Playwright.
- [ ] Data schema for sessions, events and screenshots.
- [ ] One end-to-end run of the loop on stubs (play, diagnose, propose, approve, rerun).
- [ ] Tests, a clean structure, and this plan updated with a handoff note, so Muse Code can continue.

### Muse Code, Oct 29 to Nov 4: agents, demo, polish
Building the agent logic in Muse Code also shows our use of Meta tooling.
- [ ] Persona playtesters and their prompts: the three experiment personas `first_time_casual`, `impatient_newcomer` (rush-clicker) and `optimizer` (see Run protocol below).
- [ ] Analyst agent: SAM 3.1 on key screenshots, an onboarding funnel, and ranked friction points.
- [ ] Designer agent: concrete config patches, plus the human approval gate (CLI or a simple web UI, not Streamlit).
- [ ] Experiment agent: A/B reruns on the old and new configs, and a report on whether the fix helped.
- [ ] Validation against our own human play sessions.
- [ ] README with setup and run instructions, the "Status" checklist, and the 3-minute demo video.

### Antigravity (Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5 / Sonnet 5.5): whole event
Weekly limits reset around Nov 1, so there are two full windows during the event.
- **Gemini 4 Argon**: architecture decisions, hard debugging, and a review pass on each milestone (play loop, analyst, A/B). Also a second opinion on prompts and on the demo storyline.
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
| ~15% | $23 | Reserve: final recorded runs for the video, reruns on Nov 3-4, standard-mode spot checks, transcription for subtitles (~$0.01). | |

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

## Handoff log
- 2026-10-26: Repo created (meta-ai-hackathon) with README, AGENTS.md, CLAUDE.md, hackathon docs and this plan. No code yet.
- 2026-10-27: Added `docs/video-script.md` (180 s script), `docs/architecture.md` (two-day game and bot connection design) and `docs/tasks/claude-code-build-game.md` (build task for Claude Code), after five review rounds with Gemini 4 Argon (`docs/hackathon/argon-review-log.md`). Stack decision: Python backend (FastAPI, Playwright, Pydantic) plus a plain JS game, no Node. Next: Claude Code starts Day 1 of the build task.
- 2026-10-27: Budget section rewritten from Meta API prices: testing-first allocation (70% playtester runs over the full 20-minute window), per-session estimates, hard caps. Measure real tokens on day 1.
- 2026-10-27: Added run design: many short stage-gated sessions with checkpoints and early stop instead of single 20-minute runs.
- 2026-10-27: Run protocol updated after a Gemini 4 Argon review: contributor mode as default (`muse-spark-1.3-contributor`, switchable), 3 personas x 8 seeds paired matrix, onboarding vs early-play patch types with golden checkpoints only for early-play, canary plus ~5 parallel workers, Muse Spark cache off in experiments, McNemar and paired bootstrap reporting, costs re-estimated (~$0.20 per full session).
