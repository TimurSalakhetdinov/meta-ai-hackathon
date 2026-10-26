# AGENTS.md

Shared instructions for any coding agent in this repo (Claude Code, Muse Code and others). `CLAUDE.md` points here.

## Project
Meta Game Onboarding Optimizer: a closed-loop multi-agent system for the Meta Global AI Developer Hackathon (indie track, theme "Build for your world"). Persona playtester agents (Muse Spark, computer use) play a browser game. An analyst agent (SAM 3.1 plus Muse Spark) finds onboarding friction. A designer agent proposes config fixes behind a human approval gate. An experiment agent reruns A/B comparisons and reports whether the fix helped. See `README.md` for the architecture.

## Hackathon rules that shape the work
Read `docs/hackathon/rules-summary.md` first. The full page text is in `docs/hackathon/details-page-full.md`, and the kickoff slides are in `docs/hackathon/kickoff-slides/`.

- **Deadline: Wed Nov 4, 9:00 PM ET (Thu Nov 5, 03:00 Berlin).** Target a finished submission by the evening of Nov 4 Berlin time.
- Deliverables: a 3-minute demo video, a public repo (check it logged out), and a submission on the CV platform.
- Judging weights: Impact 30%, use of Meta AI tooling 25%, technical depth 20%, demo 25%.
- **Do not make the funnel or dashboard the main feature, and don't build the UI in Streamlit.** Both are listed anti-projects. The star of the project is the closed loop: play, diagnose, fix, approve, verify.
- Use Meta models non-trivially: Muse Spark for playtester agents, reasoning and fix proposals, and SAM 3.1 for screenshot and UI segmentation. Use open-weights models (Baseten or Modal credits) for high-volume runs when it saves Meta API budget.
- All code must be written during the event (from Oct 26, 2026).

## Hard constraints
- **Never use internal InnoGames data, code, configs or screenshots.** Use our own browser game and synthetic or self-recorded sessions only.
- **Never commit secrets.** The Meta API key comes from the `META_API_KEY` env var. Keep `.env` in `.gitignore`.
- The Meta API budget is $150 total. Cache responses, keep runs small while developing, and log token usage.
- Each config change must pass through the human approval gate. Never auto-apply.
- The repo will become public, so keep commits and docs clean and professional.

## Work split and plan
See `docs/plan.md` for who builds what, the timeline and the Meta API budget. Update its "Handoff log" section at the end of each working session.

## Working with several coding tools
Claude Code, Antigravity (Gemini / Claude models) and Muse Code all work in this repo. Git is the only shared memory between them.
- Start every session with `git pull`, then read `docs/plan.md` (plan and Handoff log).
- One tool works on one task at a time, on its own branch: `claude/<task>`, `agy/<task>`, `muse/<task>`. Never let two tools edit the same files at once.
- Finish every session with small commits, an updated Handoff log entry (what was done, what is next, known issues), and a push. Merge to `main` only when the loop still runs end to end.
- Agent logic is built mainly in Muse Code (Meta tooling counts in judging). Gemini 4 Argon reviews milestone diffs before merge.

## Working style
- Python for agents and analysis. The browser game stays simple and config-driven, with event logging.
- Keep the demo path runnable end to end at every milestone, and update the README Status checklist as items land.
