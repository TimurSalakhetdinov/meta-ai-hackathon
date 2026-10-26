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

## Meta API budget ($150 credits, valid for the 10-day window)
Code is written with Claude Code and Muse Code, not with API credits. Credits go to running the product.

| Share | Use |
|---|---|
| ~10% | Development and debugging: short runs, cached responses, one persona. Prefer open-weights models (Baseten or Modal credits) for this. |
| ~50% | Playtester runs: Muse Spark computer use, with screenshots at each step. This is the biggest cost. |
| ~15% | Analysis: SAM 3.1 on key screenshots only, plus analyst and designer reasoning. |
| ~25% | Reserve: final runs for the demo video and reruns if something breaks on Nov 3 or 4. |

- On day 1, measure the cost of one playtester session and size the A/B runs from it.
- Credits may expire before the live final on Nov 9. Keep recorded or cached runs ready for a live demo.

## Handoff log
- 2026-10-26: Repo created (meta-ai-hackathon) with README, AGENTS.md, CLAUDE.md, hackathon docs and this plan. No code yet.
