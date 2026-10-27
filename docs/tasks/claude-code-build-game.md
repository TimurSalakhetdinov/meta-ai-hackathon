# Task for Claude Code: build the 2.5D isometric strategy game, config/telemetry backend, and AI Director UI (Oct 27–29)

## Read first
1. `AGENTS.md` (rules and hard constraints), then `docs/plan.md` (work split, budget, Handoff log).
2. [`docs/architecture.md`](../architecture.md): the design to implement. Names, files and schemas there are binding.
3. [`docs/video-script.md`](../video-script.md): what the demo must be able to show. Keys, step ids, metric names and overlay names must match it exactly.
4. `docs/hackathon/rules-summary.md`: judging and anti-projects.

## Goal
By the end of Oct 29, the repo contains a **visually impressive, high-craft 2.5D isometric historical city-builder** in the browser (*Dawn Age → Stone Age*) with genuine F2P strategy depth (20-minute window compressed by simulation speed), a Pydantic-validated config & patch system with a human approval gate, raw-event telemetry with unbiased `stuck` metrics, the in-game **AI Director** side dock, and clean bot hooks (`window.__GAME_STATE__`, `window.__GAME_DEBUG__.getRenderedTargets()`) so Muse Code can wire up the Playwright + SAM 3.1 + Muse Spark agents starting Oct 29.

## Scope

### In (Oct 27–29, Claude Code)
1. **FastAPI Backend (`backend/app.py`, `backend/schemas.py`, `backend/config_service.py`, `backend/telemetry.py`):**
   - Serves the API and static frontend from one process (`uvicorn backend.app:app`).
   - Pydantic v2 schemas: `GameConfig`, `GameConfigPatch`, `AnalysisConfig`, `TelemetryEvent`, `BotStepRecord`, `BudgetConfig`, `ExperimentConfig`.
   - Config service: loads `configs/base_config.json`, merges flat patches (`exclude_unset=True`, explicit `null` preserved), enforces the human approval gate (`proposed -> validated -> approved/rejected`), writes `configs/patches/audit_log.jsonl`, and serves `GET /api/config?variant=&patch_id=` (returns `403` on unapproved patches).
   - Fixtures: `configs/base_config.json` (with the planted `onb_03_handoff` wood/salience friction), `configs/patches/patch_001.json` (status `validated` or `proposed`), `configs/analysis_config.json`, `configs/budget_config.json`, `configs/experiment_config.json`, `configs/personas.json`.
   - Telemetry sink (`POST /api/events`, `GET /api/runs/{run_id}/live`): appends raw events to `runs/<run_id>/events.jsonl`, derives `stuck` events using fixed `AnalysisConfig` thresholds, and writes `runs/<run_id>/summary.json` (`where_stuck`, `time_to_first_action_sec`, `stuck_events`, `onboarding_completed`, `first_achievement`).

2. **2.5D Isometric Engine & Visual Polish (`frontend/static/iso_renderer.js`, `sprites.js`, `scripts/cutout_sprites.py`):**
   - Fixed `1280x540` page layout (`device_scale_factor=1`): `#game-root` (`0–960 px`) and `#right-dock` (`960–1280 px`).
   - **12x12 Isometric Diamond Grid** (`tileW = 64, tileH = 32`) rendered with painter's algorithm depth sorting:
     - Animated water shoreline ripples along the south-west edge, seeded grass variations, north forest clusters, east stone outcrops, and dirt paths radiating from the central **Town Center** to **8 fixed buildable pads**.
   - **Hybrid Sprite + Procedural Isometric Renderer:**
     - `sprites.js` automatically loads transparent isometric PNG sprites from `frontend/static/assets/sprites/` (generated via Gemini Pro / Antigravity at `$0` Meta API cost and background-stripped via `scripts/cutout_sprites.py`).
     - For any sprite not yet on disk, `iso_renderer.js` draws rich multi-layered isometric buildings (stone foundations, timber framing, pitched thatched/slate roofs, soft drop shadows, era upgrades) so the game looks polished immediately.
   - **Juicy F2P Visual Feedback:**
     - **Construction animation:** Placing a building displays wooden scaffolding, rising dust particles, and an isometric progress bar for `build_time_sec`, finishing with a scale bounce.
     - **Living settlement:** Ambient villagers walking along roads between the Town Center and active production buildings; chimney smoke drifting from Shelters; gentle tree sway.
     - **Production & Harvest:** Radial/bar progress timers over production buildings, bobbing ready icons (`🍞`, `🪵`, `🪨`, `📜`), and floating `+15 Food` / `-20 Wood` text popups on click.

3. **Rich Strategy Gameplay (`frontend/static/game.js`, `tech_tree.js`, `clock.js`):**
   - **Deterministic Clock & PRNG (`clock.js`):** `mulberry32(seed)` from `?seed=` and simulation clock advancing by `realDelta * speed` (`?speed=1..4`).
   - **Onboarding Flow → Free Play → Era Upgrade:**
     - `onb_01_shelter`: Advisor greets the player and highlights Pad 1 to build a **Shelter**.
     - `onb_02_forager`: Advisor guides building a **Forager Hut** on Pad 2 and collecting the first Food harvest.
     - `onb_03_handoff`: Handoff to free play — objective is to open **Research** and unlock **Basic Toolmaking** (`tech_toolmaking`). In Baseline A (`lock_optional_builds_until_step: null`, `research_button_salience: "low"`), the optional **Woodcutter Hut** is bright and unlocked while the Research button is small and muted; building the Woodcutter Hut first drains Wood from `40 -> 10` (below the `30` Wood needed for *Basic Toolmaking*), causing `action_rejected` (`insufficient_wood`) and stalling progression.
     - `free_play` → `first_achievement`: Full early-game strategy loop culminating in researching **Stone Age Awakening** (`tech_stone_age`) and reaching `first_achievement_target_score`.
   - **4 Resources + Population/Worker Mechanic:**
     - Resources: **Food**, **Wood**, **Stone**, **Research Points (RP)**.
     - **Workers / Population:** Starting workers = `starting_workers` (`2`). Each **Shelter** adds `+shelter_pop_gain` (`+2`) max workers. Production buildings (**Forager Hut**, **Woodcutter Hut**, **Stone Quarry**, **Research Academy**) require `1` available worker to operate; players can click a building to toggle worker assignment or build another Shelter when capped.
   - **7 Building Types:**
     1. `town_center` (pre-built central landmark; upgrades visually in *Stone Age*)
     2. `shelter` (costs Wood; adds Population + score)
     3. `forager_hut` (costs Wood; produces Food every `forager_cycle_sec`)
     4. `woodcutter_hut` (optional early build; costs `optional_woodcutter_cost` Wood; produces Wood every `woodcutter_cycle_sec`)
     5. `research_tent` (unlocks/opens Tech Tree and generates passive RP)
     6. `stone_quarry` (unlocked by *Masonry*; costs Wood + Food; produces Stone every `quarry_cycle_sec`)
     7. `tribal_monument` (unlocked by *Basic Toolmaking*; costs Wood + Stone; grants major score boost)
   - **Visual Tech Tree Modal (`tech_tree.js`):**
     - Interactive 5-node dependency graph modal:
       1. `tech_toolmaking` (**Basic Toolmaking** — costs `research_toolmaking_wood_cost` Wood; completes `onb_03_handoff`, unlocks `tribal_monument` & Tier-2 techs)
       2. `tech_woodworking` (**Woodworking** — costs Food; +50% Woodcutter yield)
       3. `tech_baskets` (**Foraging Baskets** — costs Food; +50% Forager yield)
       4. `tech_masonry` (**Masonry** — costs Wood; unlocks `stone_quarry`)
       5. `tech_stone_age` (**Stone Age Awakening** — requires *Basic Toolmaking* + *Masonry*, costs Food + Stone; triggers **Stone Age** Era banner, upgrades Town Center visual, and grants +50 settlement score)

4. **F2P Strategy Chrome, In-Game Right Dock (`overlay.js`), Replay (`replay.js`), and Bot Hooks:**
   - **Game HUD (`#game-root`):** Ornate stone/gold/parchment top bar (Era Banner, Food, Wood, Stone, RP, Free/Total Workers, Score, Speed badge `1x/2x/4x`, Config Inspector toggle `[i]`), Advisor character card with portrait and speech bubble, and bottom Build Bar with ≥16 px spacing between interactive cards for clean SAM 3.1 segmentation.
   - **Right Dock (`#right-dock`, `320x540`, never overlaps `#game-root`):**
     - **Telemetry Pill** (top): Current `step_id`, `Time to 1st action`, onboarding checklist (`[✓] Shelter`, `[✓] Forager`, `[ ] Research`), and `stuck_events` counter.
     - **AI Director Panel** (collapsible below the Pill):
       - *Live Tab*: Persona selector (`impatient_newcomer`, `first_time_casual`, `optimizer`), **`[▶ Watch Bot Play]` / `[⏸ Pause Bot]`** button (drives the game live right in the browser with the glowing cyan click ring and step-by-step thoughts using the variant-blind persona policy on Day 1–2, and connects to live Playwright/Muse Spark in `--mode meta`), seed badge, and live joined stream of game events & bot thoughts/actions.
       - *Analyst & Designer Tab*: Stuck frame viewer with SAM outline overlay support, diagnosis summary, `patch_001.json` diff viewer, `Schema: VALID (Pydantic)` badge, and interactive **`[Approve Patch]`** / **`[Reject]`** buttons wired to `POST /api/patches/{id}/approve` and `/reject`.
       - *A/B Summary Tab*: Paired comparison card (`where_stuck`, `time_to_first_action_sec`, `stuck_events`, `onboarding_completed`).
   - **Replay Route (`replay.js`):** `/?replay_a=<run>&replay_b=<run>&speed=4` side-by-side synchronized playback from recorded run folders, freezing A with a red `STALLED AT onb_03_handoff` badge while B reaches `First achievement unlocked`.
   - **Bot Synchronisation Hooks:**
     - `window.__GAME_STATE__`: `{ ready, idle, active_animations, last_click_seq, step_id, era, resources, workers_free, workers_total, score, modal_open }` so Playwright waits for a stable frame before capturing.
     - `window.__BOT_CTX__`: `{ bot_step_index, correlation_id }` attached to every emitted telemetry event.
     - `window.__GAME_DEBUG__.getRenderedTargets()`: returns `{ target_id, kind, x, y, w, h, visible, locked, affordable, computed_salience }[]` in `#game-root` pixel coordinates for tests and variant-blind stub runs.

### Out for Oct 27–29 (Moved to Oct 29+ in Muse Code)
- `backend/meta_client.py` (live SAM 3.1 and Muse Spark API calls, caching, cost ledger).
- `backend/bot_runner.py` (full Playwright computer-use loop) and `backend/agents/{analyst,designer,experiment}.py` (multi-agent reasoning and parallel worker pools).
- The 3-minute demo video recording.

---

## Two-Day Milestones for Claude Code

### Day 1 (Oct 27–28): Backend Config/Telemetry + 2.5D Isometric Engine + F2P Strategy HUD
1. Project setup: `pyproject.toml` (`fastapi`, `uvicorn`, `pydantic>=2`, `playwright`, `pillow`, `python-dotenv`, `pytest`, `httpx`), directory layout (`backend/`, `frontend/static/`, `frontend/static/assets/sprites/`, `configs/`, `scripts/`, `tests/`), `runs/` in `.gitignore`.
2. `backend/schemas.py`, `backend/config_service.py`, `backend/telemetry.py`, and `backend/app.py` with all config/patch/approval/event endpoints and `configs/*.json` fixtures.
3. `scripts/cutout_sprites.py`: utility using Pillow (flood-fill / chroma-key corner background removal + alpha feathering) to turn solid-background isometric PNGs into clean transparent sprites in `frontend/static/assets/sprites/`.
4. `frontend/static/clock.js`, `sprites.js`, and `iso_renderer.js`: 12x12 isometric diamond map, water shoreline animation, terrain props, roads, 8 building pads, hybrid sprite + multi-layered procedural isometric building renderer, scaffolding construction animation, walking villagers, chimney smoke, and floating resource popups.
5. `frontend/static/index.html` and `styles.css`: `1280x540` layout (`960x540` `#game-root` + `320x540` `#right-dock`), stone/gold/parchment F2P strategy HUD, Advisor portrait dialog, and Build Bar with `research_button_salience` styles (`low`, `medium`, `high_pulse`).

**Day 1 acceptance check:** Starting `uvicorn backend.app:app` and opening `http://localhost:8000/?variant=A&seed=42` renders the 2.5D isometric settlement with animated water, trees, roads, Town Center, walking villagers, and F2P HUD; clicking pads places scaffolding that builds into isometric structures; `GET /api/config` and `POST /api/patches/{id}/approve` work with audit logging.

### Day 2 (Oct 28–29): Full Gameplay Loop, Tech Tree, AI Director Dock, Replay & Tests
6. `frontend/static/game.js` and `tech_tree.js`:
   - Full state machine for `onb_01_shelter` → `onb_02_forager` → `onb_03_handoff` → `free_play` → `first_achievement`.
   - All 4 resources (Food, Wood, Stone, RP), Population/Worker assignment (`shelter` adds workers; production huts require a free worker), all 7 buildings, and the 5-node visual Tech Tree modal (`tech_toolmaking`, `tech_woodworking`, `tech_baskets`, `tech_masonry`, `tech_stone_age`).
   - Config Inspector overlay (`[i]` button or `?inspect_config=1`) highlighting `starting_wood`, `lock_optional_builds_until_step`, `research_button_salience`, `idle_hint_delay_sec` over the live game (for 0:18–0:30 of the video script).
   - `window.__GAME_STATE__`, `window.__BOT_CTX__`, and `window.__GAME_DEBUG__.getRenderedTargets()`.
7. `frontend/static/overlay.js` and `replay.js`:
   - Telemetry Pill and AI Director tabs in `#right-dock`, live event log polling/SSE, interactive `[Approve Patch]` / `[Reject]` buttons for `patch_001`, and side-by-side `/?replay_a=&replay_b=&speed=4` view.
8. Tests (`tests/`) and documentation (`README.md` setup instructions, Handoff log in `docs/plan.md` and at the bottom of this file).

**Day 2 acceptance check:**
- Playing `?variant=A&seed=42` and clicking the unlocked Woodcutter Hut at `onb_03_handoff` drains wood, logs `action_rejected` (`insufficient_wood`) when attempting Research, and triggers a derived `stuck` event in `runs/<run_id>/events.jsonl`.
- Clicking `[Approve Patch]` on `patch_001` in the AI Director transitions it `validated -> approved` in `audit_log.jsonl`.
- Playing `?variant=B&patch_id=patch_001&seed=42` locks optional builds until `onb_03_handoff`, pulses the Research button (`high_pulse`), opens the 5-node Tech Tree, researches *Basic Toolmaking* → *Masonry* → *Stone Age Awakening*, upgrades the Era banner to **Stone Age**, and unlocks `first_achievement`.
- All `pytest` tests pass.

---

## Acceptance tests (`tests/`)
- `test_config_merge_and_validation.py`: omitted keys unchanged, explicit `null` kept, unknown keys rejected, field ranges enforced.
- `test_human_approval_gate.py`: requesting `GET /api/config?variant=B&patch_id=patch_001` before approval returns `403`; approving via `POST /api/patches/patch_001/approve` succeeds and records the transition in `audit_log.jsonl`.
- `test_unbiased_metrics.py`: changing `idle_hint_delay_sec` does not change `stuck_events` for the same raw event trace.
- `test_metrics.py`: `time_to_first_action_sec`, `where_stuck`, `onboarding_completed`, `first_achievement` on fixture traces.
- `test_bot_clip_isolation.py`: Playwright test asserting `#right-dock` bounding box has `x >= 960` (zero intersection with `{x:0, y:0, width:960, height:540}`) and `window.__GAME_DEBUG__.getRenderedTargets()` returns valid coordinates inside `0..960 x 0..540` with ≥16 px separation between HUD buttons.
- `test_game_variants_playwright.py`: headless Playwright test running the baseline failure path on Variant A (`action_rejected` + `stuck` at `onb_03_handoff`) and the full progression path on approved Variant B (`onb_01_shelter` → `onb_02_forager` → `onb_03_handoff` → Tech Tree → *Stone Age* `first_achievement`).

## Constraints (from AGENTS.md, non-negotiable)
- **No secrets in code, logs or commits.** Never export `META_API_KEY` in the shell, never print it.
- **No InnoGames material** (data, code, configs, screenshots, art, or game titles). Original code and assets only.
- **Human approval gate:** nothing applies a patch without `approved` status set by a human action.
- **No standalone dashboard or Streamlit;** all loop UI lives in `#right-dock`.
- **No invented numbers** in docs or UI; metrics come strictly from `runs/` logs.
- Work on a `claude/<task>` branch, make clean commits, and update the Handoff log below at the end of each session.

## Handoff log
- 2026-10-27: Task re-scoped with Gemini 4 Argon to focus Claude Code's two days (Oct 27–29) on building a high-craft 2.5D isometric strategy game (*Dawn Age → Stone Age*) with 7 buildings, 4 resources + population/workers, a 5-node visual Tech Tree, F2P UI chrome, FastAPI config/patch/approval backend, unbiased telemetry, and `#right-dock` AI Director UI. Ready for Claude Code to start Day 1.
