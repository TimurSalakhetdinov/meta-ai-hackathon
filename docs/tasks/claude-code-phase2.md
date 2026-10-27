# Task for Claude Code (Phase 2): Deep 3-Era Gameplay, Worker Assignment, 5 FTUE Friction Levers, Playwright Bot Runner, Set-of-Mark & Experiment Engine

## Read first
1. `AGENTS.md` (rules and hard constraints), then `docs/plan.md` and `docs/architecture.md`.
2. `docs/tasks/claude-code-build-game.md` (Phase 1 handoff notes).
3. `docs/video-script.md` (all existing step ids, config keys, metric names, and overlay labels must remain 100% compatible).

## Goal
Since Phase 1 finished ahead of schedule and Claude Code access runs through Oct 29, Phase 2 deepens **both** the browser strategy game and the computer-use / experiment infrastructure so the project is as deep, polished, and technically ambitious as possible before Muse Code takes over the live agent reasoning on Oct 29.

Work on branch `claude/phase2-depth-and-infra` (branched from current `main`).

---

## Part A: Deepen the Strategy Game (`frontend/static/`, `backend/schemas.py`, `configs/`)

### 1. Three-Era Progression (*Dawn Age → Stone Age → Bronze Age*), Building Upgrades (`Lv.1 → Lv.3`), Story Quests & Scout Map
Keep all Phase 1 onboarding steps (`onb_01_shelter`, `onb_02_forager`, `onb_03_handoff`) and `first_achievement` (*Stone Age Awakening* + `first_achievement_target_score`, default `100`) intact so short `onboarding` runs (`MAX_BOT_STEPS = 25`) and the video script work unchanged. Extend `free_play` for full 20-minute runs (`full_window`, `MAX_BOT_STEPS = 100`) with the signature genre mechanics of modern historical F2P strategy games (100% original design and assets):

- **Building Level Upgrades (`Lv.1 → Lv.2 → Lv.3`):**
  - Any completed building (`shelter`, `forager_hut`, `woodcutter_hut`, `stone_quarry`, `smelter`, `granary`) can be upgraded up to `Lv.3` (once `tech_toolmaking` is unlocked for Lv.2, and `tech_stone_age` for Lv.3).
  - Each upgrade level costs resources (`upgrade_cost_multiplier`, default `1.5x`), increases output/population/score by `+50%`, and displays a crisp gold level badge (`Lv.1`, `Lv.2`, `Lv.3`) on the isometric building.
  - Exposes `upgrade_<pad_id>` as a clickable action/button in the building inspector or HUD so bots and players choose between expanding horizontally (new pads) vs. vertically (upgrading existing buildings).
- **Chapter Quest Tracker & Claimable Rewards (`quest_tracker`):**
  - Beneath the Advisor card on the left, show an active **Chapter Quest Card** (*Chapter I: Founding the Tribe* → *Chapter II: Rise of Stone* → *Chapter III: Bronze Dawn*) with a progress bar and a **`[🎁 Claim Reward]`** button (`btn_claim_quest`) when a quest objective finishes, awarding bonus resources/RP.
  - Controlled by config lever `auto_claim_quest_rewards: bool = False` (when `false`, rewards wait for the player to click `btn_claim_quest`; when `true`, rewards grant automatically upon quest completion).
- **Expedition / Scout Map Modal (`btn_expedition`, 3 Province Nodes):**
  - While city buildings are cycling in `free_play`, players can open the **Scout / Expedition Map** (`btn_expedition` in the bottom HUD) showing 3 original prehistoric province encounters (*1. Misty River Crossing*, *2. Megalithic Ruins*, *3. Sunlit Quarry Ridge*).
  - Sending a scout party costs Food (`expedition_food_cost`, default `20`) and immediately awards a burst of Research Points (`+6 RP`), Stone (`+15 Stone`), and `+15` settlement score — giving players an active tactical loop alongside city management.
- **2 New Buildings (bringing total to 9 building types across the 8 buildable pads + pre-built Town Center & Research Tent):**
  - `granary` (**Granary**, unlocked by `tech_baskets` or `tech_toolmaking`): costs Wood + Food; passively boosts Food & Wood harvest yields by `+25%` and adds `+15` score.
  - `smelter` (**Copper Smelter**, unlocked by `tech_masonry`): costs Wood + Stone; produces `stone`/metal trade value (`+20` Stone per cycle) and adds `+25` score.
- **2 New Tier-3 Technologies in `tech_tree.js` (bringing total to 7 technologies across 3 tiers):**
  - `tech_irrigation` (**Irrigation**, requires `tech_baskets`): costs Food + Stone + RP; boosts Forager yield by another `+50%` and adds `+15` score.
  - `tech_bronze_age` (**Bronze Age Dawn**, requires `tech_stone_age` + `tech_masonry`): costs Food + Wood + Stone + RP; upgrades `era` to `'bronze_age'`, adds `+60` score, and emits an `achievement` event with `achievement_id: 'bronze_age_mastery'` when `score >= bronze_achievement_target_score` (default `220`).
- **Sprite Sheet 3 (`frontend/static/assets/sprites/preview_settlement_style_3.jpg`):**
  - Update `scripts/cutout_sprites.py` to also slice `preview_settlement_style_3.jpg` (if present) into:
    - top-left: `smelter.png`
    - top-right: `granary.png`
    - bottom-left: `advisor_welcome.png`
    - bottom-right: `advisor_hint.png`
  - Add procedural isometric fallbacks for `smelter` and `granary` in `iso_renderer.js` so they render cleanly even without PNGs.

### 2. Interactive Worker Assignment Mechanic
In Phase 1, producers took a fixed worker count with no way to reassign workers when hitting the population cap. Add interactive worker management:
- When a production building (`forager_hut`, `woodcutter_hut`, `stone_quarry`, `smelter`) is `done` on a pad:
  - If it is `ready` to harvest, clicking `building_<pad_id>` harvests it (existing behavior).
  - Add a rendered clickable sub-target or HUD/building action `worker_<pad_id>` (or allow clicking a building that is not `ready` when no build card is selected) to **toggle worker assignment** (`0 <-> workersPerBuilding`).
  - When a producer has `worker === 0`, `iso_renderer.js` draws a clear amber `⚠️ No Worker` badge over it and its production timer pauses (`blockedReason = 'Unstaffed (tap to assign worker)'`).
  - Expose worker status on rendered targets in `window.__GAME_DEBUG__.getRenderedTargets()` (`staffed: true/false`).

### 3. All 5 Public FTUE Friction Archetypes Wired to `GameConfig`
Ensure all 5 classic city-builder first-20-minute friction bugs are controlled by `GameConfig` (`backend/schemas.py` and `configs/base_config.json`):
1. **Premature Spend Deadlock (`onb_03_handoff`):** `lock_optional_builds_until_step` (`null` in A vs `"onb_03_handoff"` in B) + `starting_wood`.
2. **Handoff Salience Cliff (`onb_03_handoff`):** `research_button_salience` (`"low"` in A vs `"high_pulse"` in B).
3. **Modal & Selection Trap (`onb_03_handoff` & `free_play`):**
   - `auto_close_research_on_unlock: bool = False`: when `false`, the Research modal stays open after unlocking a tech; if a player clicks a map target (`pad_*`, `building_*`, `card_*`) while `this.modal === 'research'`, emit `action_rejected` with `reason: "modal_blocking_map"` (instead of silent `noop`) so the Analyst Agent can diagnose modal-trap friction! When `true`, unlocking a tech automatically closes the modal.
   - `clear_selection_on_harvest: bool = True`: when `false`, clicking a ready `building_*` while a `selectedCard` is active emits `action_rejected` with `reason: "card_selection_blocking_harvest"`.
4. **Worker Cap Trap (`free_play`, minutes 8–15):**
   - `show_worker_warnings: bool = True`, `starting_workers: int = 2`, `shelter_pop_gain: int = 2`. When a player tries to build a producer with `workersFree < worker_required_per_building`, `cardStatus` rejects with `no_free_worker` and the Advisor shows a clear hint (`"Need more Workers! Build a Shelter first."`) when `show_worker_warnings` is `true`.
5. **Post-Tutorial Pacing / Timer Wall (`free_play`, minutes 10–20):**
   - `woodcutter_cycle_sec: float = 10.0` (in `base_config.json`), `quarry_cycle_sec: float = 6.0`, `research_tent_rp_per_min: float = 20.0`. Add a second fixture patch `configs/patches/patch_002.json` (status `proposed`, targeting `free_play` pacing and `auto_close_research_on_unlock: true`) for testing multi-loop optimization.

### 4. Visual & Audio Polish (`frontend/static/`)
- **Advisor Portraits:** Render `advisor_welcome.png` (or `advisor_hint.png` when `game.hint` or `game.lastRejection` is active) inside the Advisor HUD card, with an SVG fallback if the PNG is absent.
- **Resource-Carrying Villagers:** In `iso_renderer.js`, villagers walking from an active producer back toward the Town Center draw a tiny floating resource icon (`🍞`, `🪵`, `🪨`) above their shoulder.
- **Procedural Web Audio SFX (`frontend/static/audio.js`):** Zero-dependency Web Audio API synthesizer (subtle wood tap on UI click, construction thud on building placement, pleasant marimba chime on harvest, warm chord fanfare on tech/era unlock, soft low tone on `action_rejected`) with a `[🔊 / 🔇]` mute toggle button in the top HUD (`btn_mute`, default muted when `?bot=1` or headless).

---

## Part B: Playwright Computer-Use Runner, Meta Client, Set-of-Mark & Experiment Engine (`backend/`)

### 5. `backend/meta_client.py`
Implement the complete client layer from `docs/architecture.md` Sections 6 & 8:
- **Environment & Keys:** Load `.env` via `python-dotenv` inside the app only (never export `META_API_KEY` in shell, never log the key).
- **Set-of-Mark (SoM) Pipeline:**
  - `segment_and_mark(image_bytes: bytes, rendered_targets: list[dict] | None, mode: str) -> SomResult`:
  - Computes a 64-bit perceptual hash (`frame_phash` using Pillow `16x16` grayscale average/dct hash).
  - Checks disk cache `runs/.cache/sam/<frame_phash>.json` (SAM cache is **always on**).
  - In `meta` mode: calls the SAM 3.1 endpoint (behind a clean adapter `_call_sam_api(image_bytes)` with configurable URL/model from `BudgetConfig`; if `?assist=true` or in `stub` mode, derives bounding boxes from `rendered_targets`), filters out tiny/background masks, spaces marks ≥16 px apart, keeps top `K=8` interactive targets, and draws numbered high-contrast cyan/gold bounding boxes + label pills (`#1`..`#K`) onto the `960x540` image using Pillow, saving to `runs/<run_id>/som_masks/step_NNN.png`.
- **Muse Spark Decision Pipeline:**
  - `decide_action(...) -> MuseDecision`:
  - Uses `muse_model_id` from `configs/budget_config.json` (default `"muse-spark-1.3-contributor"`, switchable to `"muse-spark-1.3"`). Derives `model_mode = "contributor" if "contributor" in model_id else "standard"`.
  - Cache key: `sha256(model_id, persona_id, prompt_version, frame_phash, last_actions_json)`.
  - **Experiment Cache Isolation:** When `experiment_mode=True` (and `META_CACHE_ONLY != "1"`), the Muse Spark cache is **not read** so repeated sessions do not share cached LLM outputs (though responses are still written to `runs/.cache/muse/` so `META_CACHE_ONLY=1` replays work later).
  - In `META_CACHE_ONLY=1`: reads strictly from disk cache; raises `CacheMissError` if not cached (zero network calls).
- **Muse Image Adapter:**
  - `generate_ui_emblem(prompt: str, out_path: Path, bucket: str = "reserve")`: adapter for generating a high-salience Variant B Research button emblem via Muse Image, logged to `cost_ledger.jsonl`.
- **Cost Ledger & Hard Budget Caps (`runs/cost_ledger.jsonl`):**
  - Thread-safe and process-safe lock around `runs/cost_ledger.jsonl`.
  - Every API call records `{timestamp_iso, run_id, bot_step_index, provider_mode, model_id, model_mode, bucket, prompt_tokens, completion_tokens, images, cache_hit, estimated_cost_usd}`.
  - Checks per-session cap (`$2.00`), bucket cap (`dev`, `playtester`, `analysis`, `reserve`), and global stop (`$140.00`) **before** making a live call. Reserve bucket requires `use_reserve=True`. Raises `BudgetCapExceededError` when a cap would be exceeded.

### 6. `backend/bot_runner.py`
Implement the async Playwright computer-use runner:
- Opens a **fresh `BrowserContext`** per session (`viewport={"width": 1280, "height": 540}`, `device_scale_factor=1`, fresh `localStorage`/`IndexedDB`) and fresh bot memory (`last_actions = []`, `scratchpad = {}`).
- Asserts `#right-dock` bounding box has `x >= 960` (never intersects `{x: 0, y: 0, width: 960, height: 540}`).
- At each step:
  1. Waits for `window.__GAME_STATE__.ready && window.__GAME_STATE__.idle` (with timeout fallback).
  2. Captures `page.screenshot(clip={"x": 0, "y": 0, "width": 960, "height": 540})` and saves `runs/<run_id>/frames/step_NNN.png`.
  3. Runs `meta_client.segment_and_mark(...)` and `meta_client.decide_action(...)`.
  4. Sets `window.__BOT_CTX__ = {bot_step_index, correlation_id}`, triggers the cyan click ring in the page, calls `await page.mouse.click(x, y)`, and posts `BotStepRecord` to `TelemetryStore`.
  5. Checks stop conditions:
     - `onboarding` run type (`MAX_BOT_STEPS = 25`): stops early on `first_achievement` or `stuck_abort` (3 derived `stuck` events in the same step).
     - `full_window` run type (`MAX_BOT_STEPS = 100`): continues past `first_achievement` up to `bronze_age_mastery`, `sim_elapsed_sec >= 1200`, `MAX_BOT_STEPS`, or `stuck_abort`.

### 7. `backend/agents/{analyst,designer,experiment}.py` & `backend/cli.py`
- **`backend/agents/analyst.py`:**
  - Inspects a run's `events.jsonl`, `bot_steps.jsonl`, `summary.json`, and `frames/`, renders an annotated `stuck_frame.png` (highlighting the top 3 SAM masks: Research button, Woodcutter card, Wood counter), and writes `runs/<run_id>/analysis.json` (which `GET /api/runs/{run_id}/analysis` serves to the AI Director tab so there are zero 404s!).
- **`backend/agents/designer.py`:**
  - Reads `analysis.json` and proposes a validated patch via `ConfigService.propose(...)` (always stopping at `validated` status behind the Human Approval Gate — never auto-approves).
- **`backend/agents/experiment.py`:**
  - Runs paired `(persona_id, seed)` sessions from `configs/experiment_config.json`.
  - Runs **1 canary session** first; aborts the batch if the canary fails or exceeds budget.
  - Runs remaining sessions via an `asyncio.Semaphore(worker_pool_size)` worker pool (default 5; 1 = sequential).
  - Refuses mixed `provider_mode` or `muse_model_id`; supports baseline reuse when an approved B becomes the next baseline.
  - Computes paired statistics in pure Python / stdlib:
    - Binary metrics (`onboarding_completed`, `first_achievement`, `stalled_at_handoff`): **exact McNemar test** ($p$-value) + 95% CI for difference in proportions.
    - Continuous metrics (`time_to_first_action_sec`, `stuck_events`, `final_score`): `N`, `median_delta`, and **paired bootstrap 95% CI** (2,000 resamples, seeded).
  - Writes `runs/ab_summary.json` (served by `GET /api/ab_summary` to the AI Director A/B tab) and `runs/voiceover_sheet.txt` (with the 1:50 and 2:23 narration lines filled from `ab_summary.json` and a `<= 2.0 words/sec` check).
- **`backend/cli.py`:**
  - `python -m backend.cli run-session --variant A --persona impatient_newcomer --seed 42 --mode stub [--headed]`
  - `python -m backend.cli run-closed-loop --mode stub --seeds 42,43` (prompts a human `[Approve patch_001? y/N]` in CLI or waits for UI approval; tests pass an explicit `human_approver` callback).
  - `python -m backend.cli analyze --run-id <run_id>`
- **Zero-Cost Hosting Readiness (`Dockerfile` & `runs_demo/` fallback):**
  - Add a clean `Dockerfile` (Python 3.11 + FastAPI on port `7860` / `8000`).
  - If `runs/ab_summary.json` or a requested run is not in `runs/`, check `runs_demo/` as a read-only fallback so committed demo runs work immediately on Hugging Face Spaces / Modal.

---

## Acceptance Tests to Add (`tests/`)
Keep all 36 Phase 1 tests passing and add:
- `test_worker_assignment_and_3_eras.py`: toggling workers on a producer pauses/resumes production; researching through `tech_bronze_age` reaches `era == "bronze_age"`; clicking a map tile while Research modal is open with `auto_close_research_on_unlock=False` emits `action_rejected` (`modal_blocking_map`).
- `test_cache_and_budget.py`: SAM cache hit logs zero cost; bucket overflow or per-session cap (`$2`) raises `BudgetCapExceededError`; reserve bucket requires `use_reserve=True`; ledger lock holds under concurrent workers.
- `test_experiment_cache_isolation.py`: two `experiment_mode=True` sessions with identical start (`persona`, `seed`, `frame_phash`) do not share a Muse Spark cache hit (`muse_cache_hit=False`), while SAM cache hits (`sam_cache_hit=True`), and `META_CACHE_ONLY=1` replays from cache at zero cost.
- `test_model_config.py`: default `muse_model_id` is `"muse-spark-1.3-contributor"` (`model_mode="contributor"`); switching to `"muse-spark-1.3"` logs `model_mode="standard"`; `experiment.py` refuses mixed model ids or provider modes.
- `test_fresh_session_state.py`: each `bot_runner` session gets a fresh `BrowserContext` (no `localStorage` bleed) and empty bot memory.
- `test_worker_pool_and_canary.py`: canary runs first and a failing canary aborts the batch before spawning pool workers; `MAX_BOT_STEPS` is 25 for `onboarding` and 100 for `full_window`.
- `test_paired_stats.py`: exact McNemar test and paired bootstrap 95% CI on fixture pairs match expected values; `ab_summary.json` and `voiceover_sheet.txt` are generated.
- `test_e2e_closed_loop_stub.py`: `run-closed-loop --mode stub --seeds 42,43` runs Play A → Analyst (`analysis.json` + `stuck_frame.png`) → Designer proposes patch → Human approval callback → Paired A/B rerun → `ab_summary.json` (where A stalls at `onb_03_handoff` and B completes onboarding & reaches Stone Age).
