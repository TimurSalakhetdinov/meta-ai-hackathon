# Task Spec: Full "Dawn of Empires" Visual & Gameplay Overhaul (First-20-Minute Experience)

## 1. Goal & Philosophy
Transform the browser game in `frontend/` from a basic 12x12 floating island into a **lush, full-bleed 2.5D Historical Empire & Hero-Tactics Strategy Game ("Dawn of Empires")** capturing the full depth of a modern 20-minute mobile/web 4X + Hero Battler onboarding experience:
1. **Full-Bleed Sunlit Alpine Valley Environment (`iso_renderer.js`)** — NO flat blue ocean box (`drawSea`). The city sits in a lush **Alpine Valley** framed by northern limestone cliffs & cascading waterfalls, dense swaying pine/oak forest flanks, a rushing southern mountain river with an arched stone bridge, drifting parallax cloud shadows, grazing sheep, flying birds, multi-tile building footprints, **Checkered 4x4 Expansion Sectors (`exp_1`, `exp_2`)**, a **Sacred Culture Site lime-green radial adjacency aura (`+20%` yield boost)**, **`⚡ FREE` Instant-Finish construction buttons**, and **curved Bezier resource fly-to-HUD collection arcs**.
2. **Categorized Build Bar + Coins/Scrolls/Stamina/Expansion Economy (`game.js`, `main.js`, `index.html`, `styles.css`)** — Small Homes (`shelter`) provide Workers AND generate **Coins (`🪙`)**; Rural Farms (`forager_hut`) produce **Food (`🌾`)**; Woodcutters (`woodcutter_hut`) chop **Wood (`🪵`)**; Quarries (`stone_quarry`) cut **Stone (`🪨`)**; Infantry Barracks (`barracks`) train Heroes & generate **Hero Scrolls (`📜`)**; Sacred Obelisks (`tribal_monument`) project a **lime-green Culture Adjacency Aura (`+20%` yield to adjacent Homes & Farms)**.
3. **Hero Roster & Level-Up Hall (`🛡️ Heroes` Modal)** — 2 playable Champions (**Commander Vaelen**, Infantry Vanguard Tank, and **Sun-Priestess Lyra**, Mystic Healer unlocked at Campaign Stage 2 or Toolmaking) + 2 locked Legendary silhouettes, with interactive **Level Up (Lv.1–7)** spending Food + Scrolls/Coins, **Ability** tab, and **Awaken** star constellation tab.
4. **8-Stage World Campaign Map ("Province 1: Ancient Wilds") + Pre-Battle Squad Deployment + Real-Time 2.5D Tactical Battle Arena (`⚔️ Campaign`)** —
   - 8 progressive Campaign Nodes (Stages 1–5, **Stage 6 Lv.4 3-Wave Sabertooth Wall**, Stage 7, and **Stage 8 Boss: Shadowclaw's Lair**).
   - **Pre-Battle Squad Deployment Bar** (Frontline/Backline slots, Squad Power vs. Enemy Power badge, Wave preview).
   - **Live 2.5D Tactical Combat Arena on Canvas** (`battle_arena_bg.jpg` backdrop, auto-marching Heroes vs. multi-wave Dire Wolves, Razor Boars & Sabertooth Boss, split Green/Red team HP bar, `1x/2x` battle speed + `AUTO` toggle, bottom Hero Cards with filling **Rage meters**, **Full-Screen Comic-Book Diagonal Portrait Slash Cut-In** on Ultimate activation, **3-Star Victory Chest Modal**, and **Stage 6 DEFEAT Wall Modal** with `[🛡️ Level Up Your Team]` recovery button).
5. **6-Chapter Questlines Ledger + Interactive Left Quest Card** — Left-edge Quest Tracker with Advisor portrait, live progress bar, `🎁 Collect` flying-token burst, and a `📖 6 Chapters` modal ledger.
6. **100% Backward Compatibility with Existing Closed-Loop Optimizer & Tests** — Every existing config key in `GameConfig`, every existing `data-target` ID (`card_shelter`, `card_forager_hut`, `card_woodcutter_hut`, `card_stone_quarry`, `card_granary`, `card_smelter`, `card_tribal_monument`, `pad_1`..`pad_8`, `btn_research`, `tech_*`, `btn_expedition`, `encounter_misty_river`, `encounter_megalithic_ruins`, `encounter_quarry_ridge`, `btn_claim_quest`, `btn_feature_*`), `window.__GAME_STATE__`, `window.__GAME_DEBUG__.getRenderedTargets()`, `patch_001`, `patch_005`, `patch_006`, and all 92 `pytest` tests MUST pass without regression.

---

## 2. Hard Rules (`AGENTS.md`)
- **100% Original Names & Lore:** Use our original names: **Dawn of Empires**, Advisor **Elder Kaelen / Archon Solon**, **Commander Vaelen** (Infantry Vanguard), **Sun-Priestess Lyra** (Mystic Healer), **Alpha Shadowclaw** (Stage 8 Sabertooth Boss), and **Province 1: Ancient Wilds**. Never reference any external game title or company in code, comments, or UI.
- **Zero Meta API Spend:** All tests and audits run in `stub` mode (`$0.00`). Never export `META_API_KEY`.

---

## 3. Detailed Component Specifications

### A. Full-Bleed Sunlit Alpine Valley & Isometric City (`frontend/static/iso_renderer.js` & `frontend/static/sprites.js`)
1. **New Sprites in `SPRITE_MANIFEST` (`frontend/static/sprites.js`):**
   - Load all existing sprites PLUS:
     - `barracks`: `barracks.png` (`width: 122, anchor: [0.50, 0.80]`)
     - `rural_farm`: `rural_farm.png` (`width: 118, anchor: [0.50, 0.80]`)
     - `culture_site`: `culture_site.png` (`width: 114, anchor: [0.50, 0.78]`)
     - `small_home_lv2`: `small_home_lv2.png` (`width: 112, anchor: [0.52, 0.80], chimney: [0.64, 0.12]`)
     - `hero_vaelen`: `hero_vaelen.png` (`width: 96, anchor: [0.50, 0.85]`)
     - `hero_lyra`: `hero_lyra.png` (`width: 92, anchor: [0.50, 0.85]`)
     - `enemy_beast_pack`: `enemy_beast_pack.png` (`width: 96, anchor: [0.50, 0.85]`)
     - `boss_shadowclaw`: `boss_shadowclaw.png` (`width: 128, anchor: [0.50, 0.85]`)
     - `portrait_vaelen`: `portrait_vaelen.png` (`width: 160, anchor: [0.5, 0.5]`)
     - `portrait_lyra`: `portrait_lyra.png` (`width: 160, anchor: [0.5, 0.5]`)
     - `portrait_archon`: `portrait_archon.png` (`width: 160, anchor: [0.5, 0.5]`)
     - `victory_chest`: `victory_chest.png` (`width: 140, anchor: [0.5, 0.5]`)
     - `valley_backdrop`: `valley_backdrop.jpg` (`width: 960, anchor: [0, 0]`)
     - `battle_arena_bg`: `battle_arena_bg.jpg` (`width: 960, anchor: [0, 0]`)
   - Update `shelter` at `level >= 2` to render `small_home_lv2` sprite (if loaded), `forager_hut` to use `rural_farm` at `level >= 2` (or blend both), and `tribal_monument` to use `culture_site` at `level >= 2` (or as its primary sacred obelisk look).

2. **Eliminate `drawSea` — Render the Full-Bleed Alpine Valley (`drawValleyBackdrop`):**
   - Instead of filling `960x540` with dark blue ocean water (`#0e3b57`), draw `sprites.valley_backdrop.img` stretched cleanly across `0, 0, 960, 540` (with a rich multi-layered procedural Alpine Valley fallback if the image is still loading: lush emerald gradient meadow `#5c9c42 -> #3d742b`, sculpted northern limestone cliffs `#7f7b72` with animated cascading turquoise waterfall ribbons & mist particles at `(x: 480, y: 38..115)`, eastern/western pine & oak forest flanks, and a rushing southern mountain river `(y: 465..540)` with animated whitewater ripples and an isometric stone arch bridge).
   - **Drifting Parallax Cloud Shadows & Ambient Wildlife:**
     - Render 3 soft, large translucent cloud shadows (`rgba(15, 35, 18, 0.11)`) drifting slowly across the valley floor.
     - Render 4–5 grazing white/cream sheep near the meadow edges and 2–3 small V-shaped birds gliding across the upper valley sky.
   - **Seamless Valley Floor Grid (`GRID = 12`, `ORIGIN_X = 480`, `ORIGIN_Y = 104`):**
     - Do NOT draw a harsh floating island cliff drop-off into water! Instead, blend the isometric city tiles seamlessly into the sunlit Alpine meadow with cobblestone main avenues (`ROAD`), wildflowers, stone plaza borders around the `town_center` and `research_tent`, and lush perimeter pine/oak trees.

3. **Checkered 4x4 Expansion Sectors (`exp_1`, `exp_2`):**
   - Render 2 unlockable **Territory Expansion Sectors** on the flanks of the clearing:
     - `exp_1` (Western Timber Clearing — centered around screen `x: 155, y: 275`): unlocks build pads `pad_9` and `pad_10`.
     - `exp_2` (Eastern Foothills Clearing — centered around screen `x: 805, y: 275`): unlocks build pads `pad_11` and `pad_12`.
   - While locked (`!game.expansionsUnlocked.has('exp_1')`), render a **4x4 checkered dark/light emerald isometric grid overlay** (`rgba(35, 80, 30, 0.38)` alternating with `rgba(120, 210, 95, 0.25)`), dense trees/boulders inside the sector, and a floating **Expansion Banner chip** (`target_id: "exp_1"`, `"exp_2"`, label: `🗺️ Expand (1 Token)` or `🗺️ Expand (40 🪙)`).
   - When clicked and unlocked, trigger a **large white smoke poof + flying log/rock particles**, clear the trees in that sector, and reveal the new build pads (`pad_9`, `pad_10` / `pad_11`, `pad_12`)!

4. **Culture Site Lime-Green Adjacency Aura (`tribal_monument` / Sacred Obelisk):**
   - Whenever `game.selectedCard === 'tribal_monument'` OR a `tribal_monument` building is built on the map, draw a **pulsing lime-green radial diamond aura** (`rgba(110, 245, 85, 0.24)` fill with `2.5px` dashed `#8cff66` border) extending 3 tiles around the Culture Site.
   - Any `shelter` (Small Home) or `forager_hut` (Rural Farm) within 3 tiles of a completed `tribal_monument` gets `b.cultureBoost = true` (`+20%` harvest yield & coin generation!) and displays a floating green **`😊 +20%`** euphoria badge above its roof!

5. **`⚡ FREE` Instant-Finish Construction Chip & Curved Bezier Fly-to-HUD Collect Arcs:**
   - While a building has `b.status === 'building'`, in addition to the timber scaffolding and countdown bar, render a bright green **`⚡ FREE`** pill (`target_id: "free_${b.key}"`) right above the building. Clicking `free_${b.key}` (or clicking the building under construction) finishes construction immediately (`b.completeAt = game.clock.t`) with a **white smoke ring + golden sparkler burst**!
   - When a building is harvested (or Coins/Quest rewards are collected), spawn **6 flying resource particles (`this.flyingIcons`)** in `iso_renderer.js` that travel along a **quadratic/cubic Bezier arc** from the building's `(x, y)` to the exact top-HUD counter coordinates (`coins: [220, 22]`, `food: [300, 22]`, `wood: [380, 22]`, `stone: [460, 22]`, `rp: [540, 22]`) over `0.65s` with a trailing gold sparkle!

---

### B. Expanded Economy, Buildings & 6-Chapter Quest Ledger (`frontend/static/game.js`)
1. **Resources & Backward Compatibility:**
   - Keep `RESOURCES = ['food', 'wood', 'stone', 'rp']` as the primary config-validated resource keys AND add `coins`, `scrolls`, `tokens`, and `stamina` to `game.resources` (`coins: 100`, `scrolls: 15`, `tokens: 1`, `stamina: 100` initialized by default so every existing `GameConfig` schema validation and patch works without needing schema changes!).
   - **Small Home (`shelter`):**
     - Label: `'Small Home'`, blurb: `'+Workers & Coins'`, costs `shelter_wood_cost` Wood.
     - Provides `+shelter_pop_gain` Workers AND generates `+15 Coins` every `5s` (`producesCoin: true`)! Clicking a ready Small Home (or harvesting any producer) collects its bobbing Gold Coin (`🪙`) bubble!
     - Note: To ensure existing tests (`stepDone('onb_01_shelter')` and `stub_bot.js`) are never confused by Small Homes having `ready: true` during Step 2 (`onb_02_forager`), Small Homes auto-drip Coins (`+3 Coins/sec`) into `this.resources.coins` AND show an optional clickable Coin bonus bubble only in `free_play` (or collect automatically when clicked), so during `onb_02_forager` the only `ready` building target is `forager_hut`!
   - **Rural Farm (`forager_hut`):**
     - Label: `'Rural Farm'`, blurb: `'Produces Food'`, produces `'food'`.
   - **Infantry Barracks (`barracks`):**
     - Add `barracks` to `BUILDINGS` and `BUILD_ORDER` (`optional: true`, unlocked in `free_play`, costs `{ wood: 25, food: 15 }`, score: `20`, blurb: `'Trains Heroes & Scrolls'`). Building a Barracks grants `+15 Hero Scrolls` immediately and drips `+4 Scrolls` every `10s`, plus unlocks Hero Ability upgrades!
   - **Sacred Obelisk (`tribal_monument`):**
     - Label: `'Sacred Obelisk'`, blurb: `'+20% Aura & +40 Score'`, casts the Culture Adjacency Aura (`+20%` yield to nearby farms/homes).

2. **6-Chapter Questlines (`QUESTS` in `game.js` + Quest Ledger Modal):**
   - Expand `QUESTS` to 6 rich chapters while keeping Chapters 1–3 objectives compatible with fast progression:
     1. **Chapter I: Foundations of the Valley** (`Build a Small Home`, `Harvest Food from a Rural Farm`, `Discover Basic Toolmaking` -> Reward: `+20 Food, +20 Wood, +30 Coins, +10 Scrolls`)
     2. **Chapter II: To Battle in the Wilds** (`Win Campaign Stage 1 or Research Masonry`, `Build a Stone Quarry or Woodcutter`, `Awaken the Stone Age` -> Reward: `+30 Stone, +10 RP, +1 Expansion Token 🗺️`)
     3. **Chapter III: The Hero's Journey** (`Level up a Hero or Build a Barracks`, `Place a Sacred Obelisk or Upgrade a Building to Lv.2`, `Clear 2 Campaign Stages or Enter Bronze Age` -> Reward: `+40 Food, +40 Wood, +20 Stone, +25 Scrolls`)
     4. **Chapter IV: Rise of Culture & Prosperity** (`Expand Valley Territory or Build a Granary`, `Upgrade 2 Buildings to Lv.2`, `Research Irrigation` -> Reward: `+60 Coins, +30 Stone, +15 RP`)
     5. **Chapter V: Breaking the Sabertooth Wall** (`Level Commander Vaelen to Lv.3+`, `Conquer Campaign Stage 6: Sabertooth Canyon`, `Build a Copper Smelter` -> Reward: `+80 Food, +50 Stone, +25 RP`)
     6. **Chapter VI: Dawn of the Bronze Empire** (`Enter the Bronze Age`, `Conquer Stage 8 Boss: Shadowclaw's Lair`, `Reach 250+ Empire Score` -> Reward: `+100 Food, +100 Wood, +50 Stone`)
   - Add a **`📖 Chapters`** button on `#quest-card` (`data-target="btn_quest_ledger"`) that opens the **6-Chapter Questlines Ledger Modal** showing all 6 chapters, completed checkmarks, active progress bars, and story lore from Archon Solon / Elder Kaelen.

---

### C. Hero Roster & Level-Up System (`🛡️ Heroes` Modal — `game.js`, `main.js`, `index.html`, `styles.css`)
1. **Hero State in `Game` (`this.heroes`):**
   - Initialize `this.heroes` in `Game`:
     ```js
     this.heroes = {
       vaelen: {
         id: 'vaelen', name: 'Commander Vaelen', title: 'Spartan Vanguard',
         role: 'Infantry Melee Tank', stars: 3, unlocked: true, level: 1, maxLevel: 7,
         baseHp: 180, baseAtk: 28, baseDef: 18,
         ultName: 'Earthshatter Stomp',
         ultDesc: 'Deals 160% AoE shockwave damage to all enemies and stuns for 1.5s.',
         sprite: 'hero_vaelen', portrait: 'portrait_vaelen',
       },
       lyra: {
         id: 'lyra', name: 'Sun-Priestess Lyra', title: 'Oracle of the Dawn',
         role: 'Mystic Cavalry Healer', stars: 2, unlocked: false, level: 1, maxLevel: 7,
         baseHp: 130, baseAtk: 24, baseDef: 12,
         ultName: 'Solar Salve',
         ultDesc: 'Restores +45% max HP to all allied Heroes and grants a Golden Sun Shield.',
         sprite: 'hero_lyra', portrait: 'portrait_lyra',
       },
     };
     this.selectedHero = 'vaelen';
     ```
   - **Unlocking Lyra:** `this.heroes.lyra.unlocked` becomes `true` as soon as the player clears `stage_2` (`encounter_megalithic_ruins`) OR researches `tech_stone_age` (so players who progress via either Campaign or Tech unlock their 2nd Hero!).
   - **Hero Stats & Power Formula:**
     - `heroStats(id)`: At `level L`, multiplier is `1 + 0.32 * (L - 1)`.
     - `hp = Math.round(baseHp * mult)`, `atk = Math.round(baseAtk * mult)`, `def = Math.round(baseDef * mult)`.
     - `power = Math.round(hp * 0.45 + atk * 2.2 + def * 1.8) + (abilityLevel - 1) * 35`.
     - `squadPower()`: Sum of `power` of all unlocked Heroes (`Lv.1 Vaelen = 175`; `Lv.1 Vaelen + Lv.1 Lyra = 307`; `Lv.3 Vaelen + Lv.3 Lyra = 530+`; `Lv.5 Vaelen + Lv.5 Lyra = 780+`).
   - **Leveling Up a Hero (`btn_hero_levelup` / `btn_levelup_vaelen` / `btn_levelup_lyra`):**
     - Cost for `L -> L + 1`: `{ food: 10 * L, scrolls: 5 * L }` (or if `scrolls` is short, falls back to `{ food: 12 * L }` so the player can always level up using Food from their Rural Farms!).
     - Clicking `btn_hero_levelup` increments `hero.level` (up to `7`), increments `this.stats.hero_levelups`, adds `+15` to Empire Score per level, emits `this.emit('hero_leveled', { hero_id: id, level: hero.level, squad_power: this.squadPower() })`, and triggers golden stat-flare FX!

---

### D. 8-Stage World Campaign Map + Pre-Battle Deployment + Live 2.5D Tactical Battle Arena (`⚔️ Campaign`)
1. **8 Campaign Stages (`CAMPAIGN_STAGES` in `game.js`):**
   - Map the first 3 stages to also accept the legacy `encounter_*` IDs (`encounter_misty_river` === `stage_1`, `encounter_megalithic_ruins` === `stage_2`, `encounter_quarry_ridge` === `stage_3`) so every existing test or bot clicking `encounter_misty_river` works seamlessly!
   - Full 8-Stage table:
     | Stage ID | Legacy Alias | Name | Enemy Power | Waves | Level-Check / Notes | Rewards |
     |---|---|---|---|---|---|---|
     | `stage_1` | `encounter_misty_river` | **1. Misty River Crossing** | `120` | 1 Wave (`Dire Wolves Lv.1`) | Starter victory (`Vaelen Lv.1` wins easily) | `+6 RP, +15 Stone, +15 Score, +10 Scrolls` |
     | `stage_2` | `encounter_megalithic_ruins` | **2. Sunlit Glade Ambush** | `165` | 1 Wave (`Razor Boars Lv.1`) | **Unlocks Hero: Sun-Priestess Lyra ✨** + `+1 Expansion Token 🗺️` | `+6 RP, +15 Stone, +15 Score, +Lyra` |
     | `stage_3` | `encounter_quarry_ridge` | **3. Megalithic Ruins** | `240` | 2 Waves (`Wolf & Boar Pack Lv.2`) | 2-Hero synergy stage | `+8 RP, +15 Stone, +20 Score, +15 Scrolls` |
     | `stage_4` | — | **4. Whispering Pine Gorge** | `310` | 2 Waves (`Armored Boars Lv.2`) | Requires Lv.2 Heroes | `+10 RP, +20 Stone, +20 Score, +25 Coins` |
     | `stage_5` | — | **5. Quarry Ridge Outpost** | `390` | 2 Waves (`Ridge Stalkers Lv.3`) | Grants **2nd Expansion Token 🗺️** | `+12 RP, +25 Stone, +25 Score, +1 Token` |
     | `stage_6` | — | **6. Sabertooth Canyon ⚠️** | `520` | **3 Waves (`Sabertooth Pack Lv.4`)** | **THE LEVEL-CHECK WALL:** If `squadPower() < 460` (Heroes under Lv.3), Wave 3 wipes the squad -> **DEFEAT Modal** prompting Hero Level-Up! | `+15 RP, +35 Stone, +35 Score, +40 Coins` |
     | `stage_7` | — | **7. Obsidian Crag** | `640` | 3 Waves (`Elder Sabertooths Lv.5`) | Requires Lv.4+ Heroes | `+20 RP, +40 Stone, +40 Score, +30 Scrolls` |
     | `stage_8` | — | **8. BOSS: Shadowclaw's Lair 👑** | `780` | **Boss Wave (`Alpha Shadowclaw Lv.6`)** | Final Province Boss (`boss_shadowclaw.png`) | `+30 RP, +60 Stone, +60 Score, 🏆 Conqueror` |

2. **Interactive 2.5D Tactical Combat Arena (`battle_arena.js` or integrated in `iso_renderer.js` + `game.js`):**
   - When the player opens the Campaign Modal (`btn_expedition`), they see:
     - **Top:** Province banner (`Province 1: Ancient Wilds · Squad Power: ⚔️ 307 · Stamina: ⚡ 100/100`), **Squad Formation Bar** showing Vaelen & Lyra with a quick **`[🛡️ Level Up Heroes]`** button right inside the Campaign header!
     - **Map Trail:** Winding parchment/terrain path with Stages 1–8 showing 3 Gold Stars (`⭐⭐⭐`) on cleared stages, a pulsing sword emblem on the next stage, and skull/boss badges on Stage 6 & Stage 8.
     - **Two ways to fight a stage:**
       1. Clicking **`⚔️ Enter 2.5D Battle Arena`** (`data-target="btn_arena_${stage.id}"` or clicking the stage node in human play and pressing `⚔️ Fight in 2.5D Arena`) switches the main `960x540` canvas into **Live 2.5D Tactical Combat Mode (`game.battleState`)**!
       2. For deterministic unit tests (`tests/test_game_config.py`) or headless fast resolution when `encounter_misty_river` is clicked directly in `game.click('encounter_misty_river')`, it immediately resolves the stage (or starts the arena while already recording the battle outcome if winnable) so existing synchronous assertions on `game.stats.battles` and `game.resources.rp` pass 100%!
   - **Live 2.5D Tactical Combat Mode (`game.battleState` rendered on `#world` canvas):**
     - While `game.battleState` is active (`status: 'fighting' | 'cutin' | 'victory' | 'defeat'`):
       - **Background:** Full-bleed `battle_arena_bg.jpg` with dramatic lighting and dust particles.
       - **Top Combat HUD Bar:** Allied Green HP Bar vs. Enemy Red HP Bar, Wave Counter (`Wave 2/3`), `1x / 2x` speed button (`data-target="btn_battle_speed"`), `AUTO` skill toggle (`data-target="btn_battle_auto"`), and `Retreat` button (`data-target="btn_battle_continue"`).
       - **Units on the Lane:**
         - Allied Heroes (`hero_vaelen.png`, `hero_lyra.png`) on the left, marching and attacking with spear thrusts, shield bashes, and golden solar projectiles.
         - Enemy Beast Waves (`enemy_beast_pack.png` for Dire Wolves/Boars, `boss_shadowclaw.png` for Sabertooths/Shadowclaw) on the right, lunging left.
         - Each attack spawns floating damage numbers (`-34`, `CRIT -72!`, `+90 HEAL`) and hit sparks!
       - **Bottom Hero Command Tray & Ultimate Cut-In:**
         - Hero portrait cards (`data-target="btn_ult_vaelen"`, `data-target="btn_ult_lyra"`) with live HP bar and golden **Rage Bar (`0% -> 100%`)**.
         - Clicking a ready Hero card (or automatically when `AUTO` is on) triggers a **0.9s Full-Screen Diagonal Comic-Book Portrait Cut-In** (`portrait_vaelen.png` with *"⚡ EARTHSHATTER STOMP!"* or `portrait_lyra.png` with *"✨ SOLAR SALVE!"*), followed by a screen-shaking golden shockwave across all enemies or a radiant green-gold party heal!
       - **End of Battle (8–14 seconds at 1x, 4–7s at 2x):**
         - If Allied Squad defeats all waves -> **VICTORY Overlay** with **3 Gold Stars (`⭐ ⭐ ⭐`)**, `victory_chest.png`, loot pills, and `[Continue]` (`data-target="btn_battle_continue"`).
         - If Allied Squad HP hits `0` (e.g., rushing **Stage 6: Sabertooth Canyon** with Lv.1–2 Heroes!) -> **DEFEAT Overlay** with crimson vignette shake, Advisor tip (*"Wave 3's Lv.4 Sabertooths broke through! Level up Commander Vaelen & Priestess Lyra in the Heroes Hall."*), **`[🛡️ Level Up Your Team]`** button (`data-target="btn_defeat_heroes"`, which closes battle and opens the `🛡️ Heroes` modal directly!), and **`[Return to Valley]`** (`data-target="btn_battle_continue"`).

---

## 4. Verification & Visual Audit Checklist
1. Run `pytest -q` — all 92 existing tests + new tests for Heroes, 8-Stage Campaign, Expansion Sectors, Culture Aura, and `⚡ FREE` Instant-Finish must pass (`100%`).
2. Start `uvicorn` and use Playwright (`1400x800`) to capture and visually inspect (`Read` tool) screenshots of:
   - `01_alpine_valley_city.png`: Full-bleed Alpine Valley (NO blue ocean box!), northern waterfall cliffs, southern river + stone bridge, checkered 4x4 Expansion Sectors (`exp_1`, `exp_2`), Sacred Obelisk lime-green adjacency aura, `⚡ FREE` construction badge, and categorized build bar.
   - `02_heroes_hall.png`: `🛡️ Heroes` modal showing Commander Vaelen & Sun-Priestess Lyra, Stat Matrix (`HP/ATK/DEF/Power`), and `Level Up` golden flare.
   - `03_campaign_map_8stages.png`: `⚔️ Campaign` modal showing Province 1: Ancient Wilds (Stages 1–8, Stage 6 Sabertooth Wall warning, Stage 8 Shadowclaw Boss, Squad Formation bar).
   - `04_tactical_battle_arena_cutin.png`: Live 2.5D Tactical Combat Arena on `#world` canvas with Vaelen & Lyra vs. Beast Horde, split HP bar, bottom Rage cards, and Ultimate Portrait Slash Cut-In.
   - `05_stage6_defeat_and_victory.png`: Both the Stage 6 DEFEAT recovery screen (`[🛡️ Level Up Your Team]`) and the 3-Star Victory Chest screen.
   - `06_quest_ledger_6chapters.png`: The 6-Chapter Questlines Ledger modal.
