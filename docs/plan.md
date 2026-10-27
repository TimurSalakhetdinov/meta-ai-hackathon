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
- [ ] Persona playtesters (for example an impatient casual player, a careful completionist and a first-time gamer) and their prompts.
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
| Model | Standard | Contributor mode |
|---|---|---|
| Muse Spark 1.3 | $1.25 / 1M input, $0.15 / 1M cached input, $4.25 / 1M output | $0.10 / 1M input, $0.20 / 1M output |
| SAM 3.1 | $2.50 / 1,000 images | n/a |
| Muse Voice Transcribe | $0.18 / hour of audio | n/a |

Rate limits are per team: Muse Spark 3,000 RPM and 4M TPM (contributor: 150 RPM, 3M TPM), SAM 3.1 3,000 RPM. Sequential runs never get close.

### Per-session estimate (assumptions, replace with measured values on day 1)
- One bot step = one SAM call ($0.0025, less with frame-hash cache) + one Muse Spark call (~2,600 input tokens incl. the image, ~800 output tokens incl. reasoning, ~$0.007). About **$0.01 per step**.
- Image token count is not published by Meta; it is the main uncertainty. Use 2x as a safety margin.
- Onboarding-only session (`MAX_BOT_STEPS` 25): ~$0.25, up to $0.50 with margin.
- Full 20-minute window session (~80 steps; raise `MAX_BOT_STEPS` to ~100 for these runs): ~$0.80, up to $1.60 with margin.

### Allocation (testing first)
| Share | Amount | Use | Roughly buys |
|---|---|---|---|
| ~5% | $7 | Development and debugging. Most dev runs on `stub` or open-weights models (Baseten/Modal credits). Meta only for calibration. | 5-10 calibration sessions |
| ~70% | $105 | Playtester test runs over the full window: several personas x seeds x variants, multiple optimisation loops. | 65-130 full sessions, e.g. 3 personas x 10 seeds x A/B = 60 sessions per loop |
| ~10% | $15 | Analyst and designer reasoning, SAM on key screenshots, validation. | Hundreds of loops (~$0.05-0.20 each) |
| ~15% | $23 | Reserve: final recorded runs for the video, reruns on Nov 3-4, transcription for subtitles (~$0.01). | |

### Run design: many short runs, not one long one
- Every test is a batch of independent sessions (persona x seed x variant), each started from a fresh game state. Repetition is what makes A/B differences meaningful; one pair is a demo, not evidence.
- Stage-gated, like a real funnel: (1) onboarding-only sessions (`MAX_BOT_STEPS` ~25) run in large batches because they are cheap (~$0.25-0.50); (2) only sessions that finish onboarding continue into early play (up to the 20-minute mark); (3) a session stops early on churn signals (`stuck_abort`), which is the main data point and saves credits.
- Checkpoints: save the game state after onboarding so early-play tests can restart from it many times without replaying onboarding (cheaper and isolates the second 10 minutes).
- Per optimisation loop: baseline batch on A, analyst and designer propose a patch, human approves, the same personas and seeds rerun on B, paired comparison reported with N.
- Rough sizing at standard prices: one loop = 3 personas x 10 seeds x 2 variants on onboarding (~$15-30) plus early-play reruns from checkpoints for the finishers (~$20-40). The $105 bucket covers about 2-4 loops; contributor mode would cover far more.

### Rules
- On day 1, run one real full-window session and read actual tokens from `runs/cost_ledger.jsonl`; resize the numbers above.
- Hard caps in `configs/budget_config.json`: per session $2, per bucket as above, global stop at $140. The client refuses calls past a cap.
- Re-running a cached seed costs nothing; never re-run uncached sessions just to record video, use `META_CACHE_ONLY=1`.
- Option (Timur decides): contributor mode makes Muse Spark ~12x cheaper (Meta may use the data; 150 RPM). Safe content-wise for our own original game in a public repo, and it would allow ~1,000+ full sessions.
- Credits may expire before the live final on Nov 9. Keep recorded or cached runs ready for a live demo.

## Handoff log
- 2026-10-26: Repo created (meta-ai-hackathon) with README, AGENTS.md, CLAUDE.md, hackathon docs and this plan. No code yet.
- 2026-10-27: Added `docs/video-script.md` (180 s script), `docs/architecture.md` (two-day game and bot connection design) and `docs/tasks/claude-code-build-game.md` (build task for Claude Code), after five review rounds with Gemini 4 Argon (`docs/hackathon/argon-review-log.md`). Stack decision: Python backend (FastAPI, Playwright, Pydantic) plus a plain JS game, no Node. Next: Claude Code starts Day 1 of the build task.
- 2026-10-27: Budget section rewritten from Meta API prices: testing-first allocation (70% playtester runs over the full 20-minute window), per-session estimates, hard caps. Measure real tokens on day 1.
- 2026-10-27: Added run design: many short stage-gated sessions with checkpoints and early stop instead of single 20-minute runs.
