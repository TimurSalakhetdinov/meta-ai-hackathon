# Gemini 4 Argon review log: video script and architecture (Oct 27, 2026)

Argon was run through the Antigravity CLI with `--model gemini-4-argon-medium --effort medium`, rounds 1–5 in one continued session (`-c`). Round 0 was an earlier single prompt at high effort.

| Round | Prompt | Key outcome |
|---|---|---|
| 0 (high effort) | Second opinion on script and architecture in one prompt | Useful base: config + patch variants, JSONL telemetry, SAM 3.1 set-of-mark + Muse Spark + Playwright, seeded PRNG and speed, URL variants, event-driven calls, overlay instead of dashboard. Problems: invented statistics, hook at 0:00 with a different structure, Node/TS backend, Muse Code "validating patches at runtime". |
| 1 | Draft the 180 s script on Timur's beats, no invented numbers | Timecoded table on the beats with a 5 s teaser; placeholders for all metrics. Onboarding minute had no AI on screen; pace too fast. |
| 2 | Tighten: ≤2.0 words/s, bot already playing during onboarding, one signature friction, exact metrics, remove overclaims, in-game AI Director | Final script structure, Telemetry Pill during onboarding, reveal at 1:30, concrete config keys and step ids, recording plan. |
| 3 | Architecture draft, Python backend, Pydantic validation, approval gate | Components, repo layout, config schema, patch lifecycle, telemetry schema, bot loop, cost control, day milestones, risks. |
| 4 | Fix gaps: metric bias from a patchable lever, bot seeing its own overlay, two event streams, frontend toolchain, merge semantics, budget buckets, dates and tests, recording, honest stub | Fixed analysis-side stuck rule, `bot_steps.jsonl` join, plain JS ES modules (no Node), flat patch with `exclude_unset`, budget buckets per plan, test list, replay route, variant-blind stub with banner, idle barrier, cache-only mode. |
| 5 | Consistency check script ↔ architecture; correct the overlay capture idea | Agreed: overlays move to a right column outside the 960x540 bot clip (element screenshots would capture overlapping DOM). Fixed patch values (design, not logs), paired seeds wording, artifact names, the 2:40 credit line. Top recording-day failure modes. |
| 6 | Milestone 1 review (`claude/build-game`, `581e202..c80f9cb`) + harvest progress refinement | Reviewed 2.5D isometric engine, sprites, FastAPI config/approval gate, server-derived `stuck` telemetry, `#right-dock`, and `stub_bot.js`. Added `savesTowardGoal()` in `game.js` so multi-harvest saving in `free_play` counts as `advanced` (preventing false `free_play` idle stuck events on winning Variant B runs while keeping food harvests at the `onb_03_handoff` wood dead end as `collected`). Added Muse Image workflows and `$0` judge hosting strategy (`runs_demo/` + `META_CACHE_ONLY=1`). |

## Decisions where we overrode Argon
- **Stack:** Python (FastAPI, Playwright, Pydantic) instead of Node/TS; then plain JS instead of TS + Vite.
- **Muse Code** is shown only as the coding tool used during the event; runtime validation is Pydantic.
- **No invented numbers**: removed "70% churn", before/after metrics and "early stop saves ~60%".
- **Overlay capture:** Argon's canvas-only screenshot would have missed DOM game UI and still captured overlapping overlays; replaced by a fixed clip with the dock outside it.

## Open points
- The baseline friction is planted in our own testbed. The README and video should say so plainly rather than imply the system found an unknown bug.
- Whether the live Muse Spark baseline reliably stalls needs one early live test (Oct 30).
- Exact Meta API endpoints for SAM 3.1 and Muse Spark are behind one adapter until confirmed.
