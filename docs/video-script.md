# Demo video script (180 seconds)

Final script for the 3-minute submission video. It follows Timur's beats (title and genre, three onboarding screens, gameplay with the bot as the central hook) and is consistent with [`architecture.md`](architecture.md).

Rules for this script:
- **Exactly 180 s.** Segments sum to 30 + 60 + 90.
- **No invented numbers.** Every metric is a `[from run logs]` placeholder, filled from `runs/ab_summary.json` before recording the voiceover. Config values in the patch are design values, not results.
- **Only work built during the event** is shown. Original game code and assets only, no InnoGames material.
- The closed loop lives in the in-game **AI Director** side panel, never in a separate dashboard.
- Voiceover pace is at most about 2.0 words per second, with short silences around the Approve click and the A/B result.

## Names used on screen (must match the code)

| Thing | Name |
|---|---|
| Onboarding steps | `onb_01_shelter`, `onb_02_forager`, `onb_03_handoff`, then `free_play` |
| Config levers shown | `starting_wood`, `lock_optional_builds_until_step`, `research_button_salience`, `idle_hint_delay_sec` |
| Metrics | `where_stuck`, `time_to_first_action_sec`, `stuck_events`, `onboarding_completed` |
| Overlays | **Telemetry Pill** (top of the right column), **AI Director** panel (right column, below the Pill) |
| Persona | `impatient_newcomer` |
| Patch | `patch_001.json` |

## Signature friction (planted in the baseline, fixed by config)
At the handoff from onboarding to free play (`onb_03_handoff`), the next required button (**Research**) has low visual salience, and the tutorial does not lock optional builds. The bot builds an optional Woodcutter Hut, runs short of wood and stalls before Research and the first achievement. `patch_001.json` locks optional builds until the handoff, raises Research salience, and adjusts starting wood and hint timing.

## Script

| Time | Dur. | On-screen visual | Voiceover (exact words) | Capture checklist |
|---|---|---|---|---|
| **0:00–0:05** | 5 s | **Teaser.** Flash of the recorded bot run: the city-builder canvas, a cyan click ring landing on a building, the right column dimmed. Cut to title. | "Can AI playtesters find and verify game onboarding fixes?" | 4 s clip from the baseline run (`seed 42`) with the click ring visible. Title slate at 0:04. |
| **0:05–0:18** | 13 s | **Title and genre.** Title card *Meta Game Onboarding Optimizer* dissolves into the original settlement: camp, paths, Forager Hut, Research tent, era banner. | "Meet Meta Game Onboarding Optimizer, built around an original browser city-builder where players grow a settlement from a small camp through historical eras." | 1080p capture of the game canvas and resource bar (original code and assets only). |
| **0:18–0:30** | 12 s | **The 20-minute window and the config layer.** A translucent config inspector opens over the game showing `base_config.json` with the four lever keys highlighted. | "The first twenty minutes decide whether a player stays. Every economy rule, tutorial lock and button highlight here comes from a live JSON config." | Inspector view of `base_config.json` with `starting_wood`, `lock_optional_builds_until_step`, `research_button_salience`, `idle_hint_delay_sec` highlighted. |
| **0:30–0:50** | 20 s | **Onboarding screen 1: founding** (`1x` badge). Advisor greeting, pulsing arrow on the first Shelter plot. Telemetry Pill (top of right column): `Step 1/3 onb_01_shelter`, `Time to 1st action: [from run logs] s`, checklist `[✓] Shelter`. No model panel yet. | "Here is a recorded run through our three onboarding screens. On screen one, an advisor introduces food and wood and guides the first shelter. In the corner, a small panel tracks time to first action." | Baseline run, screen 1. Pill shows step id, timer, checklist ticking. AI Director collapsed. |
| **0:50–1:10** | 20 s | **Onboarding screen 2: production** (`2x` badge). Forager Hut placed, food timer completes, harvest collected. The build bar unlocks every icon at once (no tutorial lock). Pill: `Step 2/3 onb_02_forager [✓]`. | "Screen two teaches production. A Forager Hut goes down, workers gather food, and the first harvest completes. Notice the extra build icons unlocking in the menu, with no tutorial lock." | Screen 2 at 2x. Build bar visibly unlocking optional buildings early. |
| **1:10–1:30** | 20 s | **Onboarding screen 3: handoff** (`1x` badge). `Step 3/3 onb_03_handoff`. Tutorial arrows vanish; the Research button is small and muted. The cursor builds an optional Woodcutter Hut first; the wood counter drops into red. | "Screen three is the handoff to free play. The player should open Research and unlock Basic Toolmaking. Instead, an optional hut gets built, draining wood just as the guiding arrows disappear." | Arrows disappearing at `onb_03_handoff`; click on the optional hut; wood counter turning red; muted Research button. |
| **1:30–1:50** | 20 s | **Central hook: the bot reveal.** Gameplay continues toward the first achievement. The AI Director panel expands below the Pill: persona card `impatient_newcomer`, `seed 42`, live step log, and the trace *screenshot → SAM 3.1 marks → Muse Spark decision → click(x, y)*. | "Gameplay begins: expanding the camp toward the first achievement. Except those clicks are not mine. The AI Director panel shows a Muse Spark persona, connected through the Muse API, acting with real clicks on the screen." | AI Director expands at ~1:35. Step log from `events.jsonl` joined with `bot_steps.jsonl` (thought, chosen mark, click). |
| **1:50–2:05** | 15 s | **Stuck and analyst.** Step log highlights `STUCK at onb_03_handoff` (`stuck_events: [from run logs]`). **Analyze**: SAM 3.1 outlines on the game (Research button, optional hut icon, wood counter) and the Muse Spark diagnosis: low Research salience plus a wood shortfall. | "At step onb_03_handoff, the bot logs [from run logs] stuck events. The analyst agent pairs SAM 3.1 with Muse Spark and flags low Research salience and a wood shortfall." | Stuck frame `analyst_stuck_frame.jpg` with the top 3 SAM outlines only; diagnosis text in the Analyst tab. |
| **2:05–2:23** | 18 s | **Designer patch and human approval gate.** Designer tab shows `patch_001.json`: `"lock_optional_builds_until_step": "onb_03_handoff"`, `"research_button_salience": "high_pulse"`, `"starting_wood": [design value]`, `"idle_hint_delay_sec": [design value]`. Green badge `Schema: VALID (Pydantic)`. Buttons `[Approve Patch]` / `[Reject]`. Cursor clicks Approve at ~2:21. | "The designer agent proposes a patch: lock optional builds until the handoff, raise Research salience, and add starting wood. Pydantic validates it, and nothing changes until I click Approve." *(about 2 s silence on the click)* | Diff view of the four keys, the validation badge, and a real human click on `[Approve Patch]`, held 2 s. |
| **2:23–2:40** | 17 s | **Experiment agent: A/B rerun** (`4x` badge, header `Same persona, paired seeds`). Split screen from recorded artifacts: left, base config stalls at `onb_03_handoff`; right, patched config opens Research and shows **First achievement unlocked**. A/B card across `[N from run logs]` paired seeds: `where_stuck`, `time_to_first_action_sec`, `stuck_events`, `onboarding_completed`, all `[from run logs]`. | "The experiment agent reruns the same persona on [N from run logs] paired seeds. Stuck events go from [from run logs] to [from run logs], and onboarding completion reaches [from run logs]." *(about 1.5 s silence on the achievement banner)* | Replay route `/?replay_a=…&replay_b=…&speed=4`, both panels on one timeline; A freezes with a red `STALLED AT onb_03_handoff` badge. Card values from `runs/ab_summary.json`. |
| **2:40–3:00** | 20 s | **Two-day build, Meta tooling, call to action.** Left: the game with the AI Director. Right: a terminal clip of the Muse Code CLI writing the Python agent modules (`agents/analyst.py`, `agents/designer.py`, `agents/experiment.py`). End card: repo URL, Muse Spark · SAM 3.1 · Muse Code, loop diagram (play → diagnose → propose → approve → verify). | "The playable game foundation was built in two days, and Meta's Muse Code CLI wrote the multi-agent pipeline, with Pydantic schemas keeping every change safe. Explore the repo to try closed-loop onboarding optimization." | Real Muse Code terminal recording from the event. End slate with the public repo link. |

## Timing check

| Segment | Time | Duration | Spoken words (placeholder ≈ 3 words) |
|---|---|---|---|
| Teaser | 0:00–0:05 | 5 s | 9 |
| Title and genre | 0:05–0:18 | 13 s | 23 |
| Config layer | 0:18–0:30 | 12 s | 24 |
| Onboarding 1 | 0:30–0:50 | 20 s | 35 |
| Onboarding 2 | 0:50–1:10 | 20 s | 30 |
| Onboarding 3 | 1:10–1:30 | 20 s | 31 |
| Bot reveal | 1:30–1:50 | 20 s | 36 |
| Stuck and analyst | 1:50–2:05 | 15 s | 29 |
| Patch and approval | 2:05–2:23 | 18 s | 29 |
| A/B rerun | 2:23–2:40 | 17 s | 31 |
| Build and CTA | 2:40–3:00 | 20 s | 33 |
| **Total** | | **180 s** | **≈ 310** (about 1.7 words/s; no segment above 2.0) |

`experiment.py` should write `runs/voiceover_sheet.txt` with the 1:50 and 2:23 lines filled with rounded numbers and a words-per-second check, so the narration does not overrun.

## Recording plan
1. **Populate artifacts first.** Run the paired A/B seeds live once (`provider_mode=meta`) to fill `runs/<run_id>/` and `runs/.cache/`. Never record the first, uncached run.
2. **Take 1, baseline run** (`variant=A`, `seed=42`, `impatient_newcomer`), recorded with `META_CACHE_ONLY=1` so the real browser replays cached decisions at a steady pace. Powers 0:00–0:05, 0:30–1:50 and the left half of the A/B. Pill visible, AI Director collapsed until ~1:35.
3. **Take 2, AI Director loop.** Analyst tab with the stuck frame and SAM outlines, Designer tab with `patch_001.json`, and the real human Approve click. Powers 1:50–2:23.
4. **Take 3, patched run and A/B card.** Same persona and seeds with `patch_001.json` approved; split screen built by the replay route from recorded frames, card from `runs/ab_summary.json`. Powers 2:23–2:40, no extra API calls.
5. **Take 4, static captures.** Settlement pan, config inspector (0:05–0:30) and a short Muse Code CLI terminal clip (2:40–3:00).
- Every speed-up carries an on-screen speed badge. Stub-mode runs are never used in the video; the replay route refuses runs whose `provider_mode` is not `meta`.

## Remaining risks
- **Baseline does not stall with the live model.** Muse Spark may read "Research" and click it. Make the baseline Research control a small, low-contrast icon and the optional hut a bright build tile, and test once live early (Oct 30). This is a planted flaw in our own testbed; the README should say so plainly.
- **SAM merges adjacent icons.** Space HUD buttons at least 16 px apart with clear borders; click the mask centroid.
- **AI Director crowding.** It lives in the 320 px right column, outside the game area, so it never covers game buttons.
- **Numbers overrun the narration.** Round spoken numbers; show exact values on screen.
- **Credits expire before the Nov 9 live final.** Keep cached runs and `META_CACHE_ONLY=1` replay ready.
