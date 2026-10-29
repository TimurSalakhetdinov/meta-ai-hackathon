# Meta Game Onboarding Optimizer

**A closed-loop, multi-agent system that playtests a game's onboarding, finds where new players get stuck, proposes fixes, and verifies them with A/B reruns, with a human approving every change.**

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Oct 26 – Nov 4, 2026) · Problem statement: **Build for Your World**

> 🚧 Work in progress. All code in this repository is written during the hackathon.

## Why

The first minutes decide whether a player stays. Game teams find onboarding friction through playtests and funnel analysis, which is slow and expensive, and every fix needs another round of testing. This project closes that loop with agents: play → diagnose → fix → approve → verify.

## How it works

```mermaid
flowchart LR
    P[Playtester agents<br/>Muse Spark personas] -->|sessions: screenshots, actions, events| A[Analyst agent<br/>SAM 3.1 + Muse Spark]
    A -->|funnel + ranked friction points| D[Designer agent]
    D -->|proposed config change| H{Human approval gate}
    H -->|approved| E[Experiment agent]
    H -->|rejected| D
    E -->|A/B rerun: old vs new config| P
    E --> R[Report: did the fix help?]
```

1. **Playtester agents (5 literature-grounded personas).** Muse Spark computer-use agents with working-memory scratchpads and distinct player-type psychology (`Rush-Clicker` / BrainHex Daredevil, `Story-Guided` / Quantic Story, `Strategist` / Bartle Achiever, `Tinkerer` / Bartle Explorer, `Hoarder` / Quantic Completion) play the browser game by looking at the screen and clicking.
2. **Analyst agent.** It uses SAM 3.1 to segment UI elements in gameplay screenshots and Muse Spark to reason over sessions. It builds an onboarding funnel and ranks friction points with quantified evidence, including the SAM 3.1 distractor-to-goal visual salience ratio (`6.76x` on the baseline stall).
3. **Designer agent & Feature Forge.** It proposes concrete onboarding config fixes (`patch_001`) or turns a Game PM's free-text feature idea into a schema-validated `FeaturePlugin` patch with a generated UI emblem (`Muse Image` / procedural stub), plus archetype-aware reworks when a naive feature hurts onboarding.
4. **Human approval gate.** No config or feature patch is applied or playtested until a human approves it (`403` until approved).
5. **Experiment agent.** It reruns the playtesters on the baseline and patched configs as a paired A/B comparison (McNemar exact test + paired bootstrap CI) and renders a 1-page Council Report (`❌ HURTS`, `⚠️ MIXED`, `✅ POSITIVE`) with side-by-side replay.
6. **Validation.** Agent findings are compared against real human play sessions.

## Meta models used

| Model | Role |
|---|---|
| Muse Spark | Persona playtesters (computer use + working-memory scratchpads), session reasoning, fix & feature rework proposals |
| SAM 3.1 | Segmenting UI elements in gameplay screenshots & computing the `6.76x` distractor-to-goal visual salience ratio |
| Muse Image | Live in-game Variant B UI emblem generation in the Feature Forge & 2.5D sprite/portrait assets |
| Meta AudioCraft / MusicGen | Optional soundtrack pipeline in `scripts/generate_music_tracks.py` (`--mode musicgen`, `facebook/musicgen-medium`). Not yet run: the committed `valley_theme.wav` and `battle_theme.wav` loops are offline synth output from the same script (`--mode synth`) |
| Muse Code | Agentic coding tool used to build and iterate on the multi-agent backend, telemetry, and Feature Studio |

## Status

- [x] Browser game with config-driven onboarding and event logging (2.5D isometric, Dawn Age to Stone Age)
- [x] Config, patch and human approval gate backend (FastAPI, Pydantic)
- [x] Unbiased telemetry: raw events, server-derived `stuck` events and run summaries
- [x] In-game AI Director dock: Telemetry Pill, live stream, patch diff, Approve/Reject, A/B tab
- [x] Side-by-side replay of two recorded runs
- [x] Stub persona bot behind Watch Bot Play (offline placeholder, labelled STUB)
- [x] Three eras (Dawn, Stone, Bronze Age), upgrades, quests, expeditions and worker assignment
- [x] Async Playwright bot runner with Set-of-Mark frames, cost ledger, budget caps and response cache
- [ ] Playtester agents with Muse Spark (computer use): runner and adapters built, working-memory scratchpad per persona, first live run pending
- [x] Analyst agent: stuck step, stuck frame, SAM 3.1 distractor-to-goal visual salience ratio (6.76x on the demo run) and think-aloud quotes, all surfaced in the Council Report (stub diagnosis; live SAM 3.1 plus Muse Spark pending)
- [x] Designer agent staging a validated patch behind the approval gate
- [x] Experiment agent: canary, worker pool, paired A/B reruns, McNemar and bootstrap report
- [x] Closed loop from the CLI in stub mode (`python -m backend.cli run-closed-loop`)
- [x] Committed demo runs in `runs_demo/` and a Dockerfile for a single-port deploy
- [x] Feature studio in the dock: free-text feature to a validated patch with a stub emblem, five research-grounded personas, playtest behind the approval gate, verdict report and archetype-aware rework synthesis (stub mode, $0). Pre-baked HURTS → POSITIVE demo bundle (`patch_005`/`patch_006` + 20 committed runs) with a 1-click Council Report switcher and split replays
- [x] Full "Dawn of Empires" 2.5D overhaul: sunlit Alpine Valley backdrop, Checkered 4x4 Territory Expansions (exp_1/exp_2), Sacred Obelisk +20% Culture Adjacency Aura, FREE instant-finish chips, Hero Roster & Level-Up Hall (Commander Vaelen & Sun-Priestess Lyra Lv.1–7), 8-Stage Ancient Wilds Campaign with Stage 6 Sabertooth Defeat Wall, Live 2.5D Tactical Combat Arena with Ultimate Portrait Cut-Ins, 6-Chapter Quest Ledger, and continuous Valley/Battle soundtrack + physical-modeling SFX
- [x] Game Manager in the Architect's Council: 3 prebuilt feature presets (`configs/feature_presets.json`), "Approve & play" approval, custom idea box, and full-screen council report
- [x] Handover regression fixed: stub bot saves for Masonry in free play, so variant B reaches the Stone Age on seeds 42 and 44 again (full suite: 99 passed)
- [ ] Soundtrack: committed valley/battle loops are offline synth output; optional MusicGen regeneration (`scripts/generate_music_tracks.py --mode musicgen`) not yet run
- [ ] Validation against human sessions
- [ ] Demo video

The onboarding friction in the base config is planted on purpose, so the loop has a known problem to find. At `onb_03_handoff` the Woodcutter Hut is unlocked and marked NEW!, while the Research button is small. A player who builds the hut drops below the 30 wood that Basic Toolmaking needs, and the hut produces nothing without that tech. `configs/patches/patch_001.json` is the baseline onboarding fix behind the approval gate; `patch_005.json` (naive Step-2 Raider Ambush, `❌ HURTS ONBOARDING`) and `patch_006.json` (free-play Designer rework, `✅ POSITIVE IMPACT`) are pre-baked Feature Studio patches stacked on `patch_001`.

## Getting started

You need Python 3.11 and [uv](https://docs.astral.sh/uv/).

```bash
uv venv && uv pip install -e .
.venv/bin/playwright install chromium
.venv/bin/uvicorn backend.app:app --port 8000
```

Open these URLs on `http://localhost:8000`:

| URL | What it shows |
|---|---|
| `/?variant=A&seed=42` | Base config (planted friction) + Architect's Council dock (`📜 Feature Forge`, `🏛️ Council Report`, `👁️ Live Chronicle`) |
| `/?variant=A&seed=42&dock=report` | Opens directly to the **🏛️ Council Report** (1-click switcher between Naive Feature `❌ HURTS` and Council Rework `✅ POSITIVE`, plus the SAM 3.1 `6.76x` onboarding diagnosis below) |
| `/?variant=B&patch_id=patch_001&seed=42` | Patched onboarding config (`patch_001` approved) |
| `/?variant=B&patch_id=patch_005&seed=42` | Naive Step-2 Raider Ambush feature on the canvas (`55 Wood` cost, `NEW!` pulse) |
| `/?variant=B&patch_id=patch_006&seed=42` | Reworked Free-Play Raider Ambush feature (`10 Food` cost, rewards `+25 Food, +15 Stone, +6 RP, +25 Score`) |
| `/?variant=A&bot=1&persona=impatient_newcomer&speed=4` | Watch Bot Play with the stub persona policy |
| `/?replay_a=<run_id>&replay_b=<run_id>&speed=4&dev=1` | Side-by-side synchronized replay |
| `/?variant=A&inspect_config=1` | Config inspector: which lever drives which UI element |

Other URL parameters: `seed`, `speed` (1 to 4), `run_id`, `telemetry=0`. Runs are written to `runs/<run_id>/` (`events.jsonl`, `bot_steps.jsonl`, `summary.json`, `resolved_config.json`).

The Meta API key is read only inside the app from `.env` (`META_API_KEY=...`). Do not export it in your shell.

Run the closed loop offline. Stub mode spends no Meta credits, and the prompt waits for your approval:

```bash
.venv/bin/python -m backend.cli run-closed-loop --mode stub --seeds 42,44
.venv/bin/python -m backend.cli run-session --variant A --persona impatient_newcomer --seed 42 --mode stub
.venv/bin/python -m backend.cli analyze --run-id <run_id>
```

The loop writes `runs/<run_id>/analysis.json`, `stuck_frame.png`, `runs/ab_summary.json` and `runs/voiceover_sheet.txt`. When `runs/` is empty, the server falls back to the read-only demo runs in `runs_demo/`, including the Feature Studio HURTS (naive Raider Ambush at step 2, onboarding 100% → 60%) and POSITIVE (free-play rework, onboarding 100% → 100%, score 145 → 208) reports, switchable in the Council Report and replayable side by side.

Run the tests (unit tests plus headless Playwright end-to-end and layout tests):

```bash
.venv/bin/python -m pytest -q
```

## Author

**Timur Salakhetdinov** · [Portfolio](https://timursalakhetdinov.com) · [LinkedIn](https://www.linkedin.com/in/timursalakhetdinov) · [GitHub](https://github.com/TimurSalakhetdinov)
