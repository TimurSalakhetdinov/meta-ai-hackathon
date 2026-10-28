// Game rules and state: onboarding state machine, economy, workers, buildings,
// upgrades, tech tree, chapter quests, expeditions and the era achievements. All timers are absolute simulated times,
// so the state is a pure function of (config, actions, action times). The
// replay view relies on that to re-simulate recorded runs.

import { SimClock } from './clock.js';
import { PADS, RESEARCH_TENT_TILE, TOWN_CENTER_TILE } from './iso_renderer.js';

export const STEPS = ['onb_01_shelter', 'onb_02_forager', 'onb_03_handoff', 'free_play'];
export const RESOURCES = ['food', 'wood', 'stone', 'rp'];
export const ALL_RESOURCES = ['food', 'wood', 'stone', 'rp', 'coins', 'scrolls', 'tokens', 'stamina'];
export const RESOURCE_LABEL = {
  food: 'Food',
  wood: 'Wood',
  stone: 'Stone',
  rp: 'RP',
  coins: 'Coins',
  scrolls: 'Scrolls',
  tokens: 'Tokens',
  stamina: 'Stamina',
};
const HEARTBEAT_SEC = 5;
const MAX_LEVEL = 3;
const REJECTION_SHOW_SEC = 6;
const FEATURE_INTRO_SHOW_SEC = 6;
export const PRODUCER_TYPES = ['forager_hut', 'woodcutter_hut', 'stone_quarry', 'smelter'];
export const UPGRADABLE_TYPES = ['shelter', 'forager_hut', 'woodcutter_hut', 'barracks', 'stone_quarry', 'smelter', 'granary'];
const UPGRADE_TECH = { 2: 'tech_toolmaking', 3: 'tech_stone_age' };

// +50% output, population and score per level above Lv.1.
export const levelFactor = (level) => 1 + 0.5 * ((level || 1) - 1);

export const BUILDINGS = {
  shelter: {
    label: 'Small Home', blurb: '+Workers & Coins', score: 5,
    costs: (c) => ({ wood: c.shelter_wood_cost }),
  },
  forager_hut: {
    label: 'Rural Farm', blurb: 'Produces Food', score: 10, produces: 'food',
    costs: (c) => ({ wood: c.forager_wood_cost }),
    cycle: (c) => c.forager_cycle_sec,
    yield: (c, techs) => c.forager_food_yield * (techs.has('tech_baskets') ? 1.5 : 1) * (techs.has('tech_irrigation') ? 1.5 : 1),
  },
  woodcutter_hut: {
    label: 'Woodcutter', blurb: 'Chops wood', score: 10, produces: 'wood', optional: true,
    toolTech: 'tech_toolmaking',
    costs: (c) => ({ wood: c.optional_woodcutter_cost, food: c.optional_woodcutter_food_cost }),
    cycle: (c) => c.woodcutter_cycle_sec,
    yield: (c, techs) => c.woodcutter_wood_yield * (techs.has('tech_woodworking') ? 1.5 : 1),
  },
  barracks: {
    label: 'Barracks', blurb: 'Trains Heroes & Scrolls', score: 20, optional: true,
    costs: () => ({ wood: 25, food: 15 }),
  },
  stone_quarry: {
    label: 'Stone Quarry', blurb: 'Cuts stone', score: 10, produces: 'stone', requiresTech: 'tech_masonry',
    costs: (c) => ({ wood: c.quarry_wood_cost, food: c.quarry_food_cost }),
    cycle: (c) => c.quarry_cycle_sec,
    yield: (c) => c.quarry_stone_yield,
  },
  granary: {
    label: 'Granary', blurb: '+25% food & wood', score: 15, requiresTech: 'tech_toolmaking',
    costs: (c) => ({ wood: c.granary_wood_cost, food: c.granary_food_cost }),
  },
  smelter: {
    label: 'Smelter', blurb: 'Copper Smelter', score: 25, produces: 'stone', requiresTech: 'tech_masonry',
    costs: (c) => ({ wood: c.smelter_wood_cost, stone: c.smelter_stone_cost }),
    cycle: (c) => c.smelter_cycle_sec,
    yield: (c) => c.smelter_stone_yield,
  },
  tribal_monument: {
    label: 'Sacred Obelisk', blurb: '+20% Aura & +40 Score', score: 40, requiresTech: 'tech_toolmaking',
    costs: (c) => ({ wood: c.monument_wood_cost, stone: c.monument_stone_cost }),
  },
};
export const BUILD_ORDER = ['shelter', 'forager_hut', 'woodcutter_hut', 'stone_quarry', 'granary', 'smelter', 'tribal_monument'];
export const ALL_BUILD_ORDER = ['shelter', 'forager_hut', 'woodcutter_hut', 'barracks', 'stone_quarry', 'granary', 'smelter', 'tribal_monument'];

export const TECHS = {
  tech_toolmaking: {
    label: 'Basic Toolmaking', icon: '\u{1FA93}', requires: [], score: 10,
    effect: 'Stone axes. Woodcutters can chop, unlocks the Monument.',
    costs: (c) => ({ wood: c.research_toolmaking_wood_cost }),
  },
  tech_woodworking: {
    label: 'Woodworking', icon: '\u{1FAB5}', requires: ['tech_toolmaking'], score: 10,
    effect: '+50% Woodcutter yield.',
    costs: (c) => ({ food: c.research_woodworking_food_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_baskets: {
    label: 'Foraging Baskets', icon: '\u{1F9FA}', requires: ['tech_toolmaking'], score: 10,
    effect: '+50% Forager yield.',
    costs: (c) => ({ food: c.research_baskets_food_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_masonry: {
    label: 'Masonry', icon: '\u{1FAA8}', requires: ['tech_toolmaking'], score: 10,
    effect: 'Unlocks the Stone Quarry.',
    costs: (c) => ({ wood: c.research_masonry_wood_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_stone_age: {
    label: 'Stone Age Awakening', icon: '\u{1F3DB}\u{FE0F}', requires: ['tech_toolmaking', 'tech_masonry'], score: 50,
    effect: 'Enter the Stone Age. Upgrades the Town Center.',
    costs: (c) => ({ food: c.research_stone_age_food_cost, stone: c.research_stone_age_stone_cost, rp: c.research_stone_age_rp_cost }),
  },
  tech_irrigation: {
    label: 'Irrigation', icon: '\u{1F33E}', requires: ['tech_baskets'], score: 15,
    effect: 'Another +50% Forager yield.',
    costs: (c) => ({ food: c.research_irrigation_food_cost, stone: c.research_irrigation_stone_cost, rp: c.research_tier3_rp_cost }),
  },
  tech_bronze_age: {
    label: 'Bronze Age Dawn', icon: '\u{1F525}', requires: ['tech_stone_age', 'tech_masonry'], score: 60,
    effect: 'Cast bronze. Enter the Bronze Age.',
    costs: (c) => ({ food: c.research_bronze_age_food_cost, wood: c.research_bronze_age_wood_cost,
                     stone: c.research_bronze_age_stone_cost, rp: c.research_bronze_age_rp_cost }),
  },
};
export const TECH_ORDER = ['tech_toolmaking', 'tech_woodworking', 'tech_baskets', 'tech_masonry', 'tech_stone_age',
  'tech_irrigation', 'tech_bronze_age'];

export const ERA_LABEL = { dawn_age: 'Dawn Age', stone_age: 'Stone Age', bronze_age: 'Bronze Age' };

// 6-Chapter Questlines. Preserves exact predicates for chapters 1-3 so existing tests pass.
export const QUESTS = [
  {
    id: 'chapter_1', title: 'Chapter I: Foundations of the Valley',
    objectives: [
      ['Build a Small Home', (g) => g.stepIndex >= 1],
      ['Collect food from Rural Farm', (g) => g.stepIndex >= 2],
      ['Discover Basic Toolmaking', (g) => g.techs.has('tech_toolmaking')],
    ],
    reward: { food: 20, wood: 20, coins: 30, scrolls: 10 },
  },
  {
    id: 'chapter_2', title: 'Chapter II: To Battle in the Wilds',
    objectives: [
      ['Research Masonry', (g) => g.techs.has('tech_masonry')],
      ['Build a Stone Quarry', (g) => g.hasBuilt('stone_quarry')],
      ['Awaken the Stone Age', (g) => g.techs.has('tech_stone_age')],
    ],
    reward: { stone: 30, rp: 10, tokens: 1 },
  },
  {
    id: 'chapter_3', title: "Chapter III: The Hero's Journey",
    objectives: [
      ['Build a Copper Smelter', (g) => g.hasBuilt('smelter')],
      ['Upgrade a building to Lv.2', (g) => g.buildings.some((b) => (b.level || 1) >= 2)],
      ['Enter the Bronze Age', (g) => g.techs.has('tech_bronze_age')],
    ],
    reward: { food: 40, wood: 40, stone: 20, scrolls: 25 },
  },
  {
    id: 'chapter_4', title: 'Chapter IV: Rise of Culture & Prosperity',
    objectives: [
      ['Expand Valley or Build Granary', (g) => g.expansionsUnlocked.size > 0 || g.hasBuilt('granary')],
      ['Upgrade 2 Buildings to Lv.2', (g) => g.buildings.filter((b) => (b.level || 1) >= 2).length >= 2],
      ['Research Irrigation', (g) => g.techs.has('tech_irrigation')],
    ],
    reward: { coins: 60, stone: 30, rp: 15 },
  },
  {
    id: 'chapter_5', title: 'Chapter V: Breaking the Sabertooth Wall',
    objectives: [
      ['Level Commander Vaelen to Lv.3+', (g) => (g.heroes?.vaelen?.level || 1) >= 3],
      ['Conquer Stage 6: Sabertooth Canyon', (g) => g.encountersCleared.has('stage_6')],
      ['Build Barracks or Smelter', (g) => g.hasBuilt('barracks') || g.hasBuilt('smelter')],
    ],
    reward: { food: 80, stone: 50, rp: 25 },
  },
  {
    id: 'chapter_6', title: 'Chapter VI: Dawn of the Bronze Empire',
    objectives: [
      ['Enter the Bronze Age', (g) => g.era === 'bronze_age'],
      ['Conquer Stage 8 Boss: Shadowclaw', (g) => g.encountersCleared.has('stage_8')],
      ['Reach 250+ Empire Score', (g) => g.score >= 250],
    ],
    reward: { food: 100, wood: 100, stone: 50 },
  },
];

export const ENCOUNTERS = [
  { id: 'encounter_misty_river', label: 'Misty River Crossing', icon: '\u{1F30A}', stageId: 'stage_1' },
  { id: 'encounter_megalithic_ruins', label: 'Sunlit Glade Ambush', icon: '\u{1F5FF}', stageId: 'stage_2' },
  { id: 'encounter_quarry_ridge', label: 'Megalithic Ruins Skirmish', icon: '\u{26F0}\u{FE0F}', stageId: 'stage_3' },
];

export const CAMPAIGN_STAGES = [
  { id: 'stage_1', legacyId: 'encounter_misty_river', name: '1. Misty River Crossing', enemyPower: 120, waves: 1, enemies: 'Dire Wolves Lv.1', reward: { rp: 6, stone: 15, score: 15, scrolls: 10 } },
  { id: 'stage_2', legacyId: 'encounter_megalithic_ruins', name: '2. Sunlit Glade Ambush', enemyPower: 165, waves: 1, enemies: 'Razor Boars Lv.1', reward: { rp: 6, stone: 15, score: 15, tokens: 1 } },
  { id: 'stage_3', legacyId: 'encounter_quarry_ridge', name: '3. Megalithic Ruins', enemyPower: 240, waves: 2, enemies: 'Wolf & Boar Pack Lv.2', reward: { rp: 8, stone: 15, score: 20, scrolls: 15 } },
  { id: 'stage_4', legacyId: null, name: '4. Whispering Pine Gorge', enemyPower: 310, waves: 2, enemies: 'Armored Boars Lv.2', reward: { rp: 10, stone: 20, score: 20, coins: 25 } },
  { id: 'stage_5', legacyId: null, name: '5. Quarry Ridge Outpost', enemyPower: 390, waves: 2, enemies: 'Ridge Stalkers Lv.3', reward: { rp: 12, stone: 25, score: 25, tokens: 1 } },
  { id: 'stage_6', legacyId: null, name: '6. Sabertooth Canyon', enemyPower: 520, waves: 3, reqPower: 460, enemies: 'Sabertooth Pack Lv.4', reward: { rp: 15, stone: 35, score: 35, coins: 40 } },
  { id: 'stage_7', legacyId: null, name: '7. Obsidian Crag', enemyPower: 640, waves: 3, reqPower: 580, enemies: 'Elder Sabertooths Lv.5', reward: { rp: 20, stone: 40, score: 40, scrolls: 30 } },
  { id: 'stage_8', legacyId: null, name: "8. BOSS: Shadowclaw's Lair", enemyPower: 780, waves: 3, reqPower: 700, enemies: 'Alpha Shadowclaw Lv.6', reward: { rp: 30, stone: 60, score: 60, coins: 100 } },
];

const BATTLE_REWARD = { rp: 6, stone: 15, score: 15 };
const MAP_PREFIXES = ['pad_', 'building_', 'card_', 'upgrade_', 'worker_', 'free_', 'exp_'];

export const ADVISOR_TEXT = {
  welcome: 'Welcome, Chief! Our tribe has settled in this sunlit Alpine Valley. Build a Small Home to shelter our workers.',
  onb_01_shelter: 'Step 1/3: Build a Small Home. Pick the Small Home card, then a glowing building pad.',
  onb_02_forager: 'Step 2/3: Build a Rural Farm, then tap it to harvest fresh food.',
  onb_03_handoff: 'Step 3/3: You lead the valley now! Discover Basic Toolmaking to complete your training.',
  free_play: 'Free play: train Heroes in the Barracks, expand territory, conquer Campaign stages, and advance to the Stone Age.',
  achieved: 'The Stone Age has dawned! Upgrade buildings, build a Copper Smelter and lead your heroes to victory.',
  bronze: 'Bronze weapons and armor gleam throughout the valley. The Bronze Age is ours, Chief!',
};
const HINT_TEXT = {
  btn_research: 'Psst, Chief! Open Research to discover Basic Toolmaking.',
  tech_toolmaking: 'Basic Toolmaking is right there. Research it!',
};

export class Game {
  constructor(config, opts = {}) {
    this.config = config;
    this.meta = {
      run_id: opts.runId || 'run_local',
      variant_id: opts.variant || 'A',
      patch_id: opts.patchId || null,
      persona_id: opts.persona || null,
      seed: opts.seed ?? 42,
      provider_mode: opts.provider || 'human',
    };
    this.clock = new SimClock(opts.speed || 1);
    this.onEvent = opts.onEvent || (() => {});
    this.onFx = opts.onFx || (() => {});
    this.botCtx = opts.botCtx || (() => ({ bot_step_index: null, correlation_id: null }));
    this.replay = !!opts.replay;

    this.resources = {
      food: config.starting_food,
      wood: config.starting_wood,
      stone: config.starting_stone,
      rp: 0,
      coins: 100,
      scrolls: 15,
      tokens: 1,
      stamina: 100,
    };
    this.techs = new Set();
    this.era = 'dawn_age';
    this.step_id = STEPS[0];
    this.stepIndex = 0;
    this.selectedCard = null;
    this.modal = 'welcome';
    this.achieved = false;
    this.stats = { forager_harvests: 0, clicks: 0, first_click_t: null, upgrades: 0, battles: 0, hero_levelups: 0 };
    this.bronzeAchieved = false;
    this.questIndex = 0;
    this.questClaimable = false;
    this.battleScore = 0;
    this.encountersCleared = new Set();
    this.featureScore = 0;
    this.featureUses = 0;
    this.featureReadyAt = 0;
    this.featureIntro = null;
    this.lastProgressT = 0;
    this.hint = null;
    this.nextHeartbeat = HEARTBEAT_SEC;
    this.lastTick = 0;
    this.ended = false;
    this.clickSeq = 0;
    this.lastRejection = null;

    // Territory Expansions
    this.expansionsUnlocked = new Set();

    // Heroes Roster
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
      ignis: {
        id: 'ignis', name: 'Pyromancer Ignis', title: 'Flame of the Wilds',
        role: 'Ranged AoE Mage', stars: 4, unlocked: false, level: 1, maxLevel: 7,
        baseHp: 110, baseAtk: 38, baseDef: 10,
        ultName: 'Meteor Conflagration',
        ultDesc: 'Summons a blazing meteorite dealing 220% magic damage.',
        sprite: 'hero_vaelen', portrait: 'portrait_archon',
      },
      aurelius: {
        id: 'aurelius', name: 'Centurion Aurelius', title: 'Imperator Rex',
        role: 'Elite Commander', stars: 5, unlocked: false, level: 1, maxLevel: 7,
        baseHp: 220, baseAtk: 34, baseDef: 24,
        ultName: 'Phalanx Charge',
        ultDesc: 'Commands an invincible phalanx charge knocking back all foes.',
        sprite: 'hero_vaelen', portrait: 'portrait_archon',
      },
    };
    this.selectedHero = 'vaelen';

    // Live 2.5D Battle Arena
    this.battleState = null;

    const w = this.workersPerBuilding;
    this.buildings = [
      { key: 'town_center', type: 'town_center', tile: TOWN_CENTER_TILE, status: 'done', worker: 0, routeKey: null, level: 1 },
      { key: 'research_tent', type: 'research_tent', tile: RESEARCH_TENT_TILE, status: 'done', worker: w, routeKey: 'research_tent', level: 1 },
    ];
  }

  get workersPerBuilding() { return this.config.worker_required_per_building; }
  get t() { return this.clock.t; }

  activePads() {
    const pads = [...PADS];
    if (this.expansionsUnlocked.has('exp_1')) {
      pads.push({ id: 'pad_9', tile: [2, 5] }, { id: 'pad_10', tile: [2, 8] });
    }
    if (this.expansionsUnlocked.has('exp_2')) {
      pads.push({ id: 'pad_11', tile: [9, 3] }, { id: 'pad_12', tile: [9, 6] });
    }
    return pads;
  }

  // ---------------------------------------------------------- telemetry
  emit(event_type, payload = {}) {
    if (this.replay) return;
    const ctx = this.botCtx();
    this.onEvent({
      ...this.meta,
      time_scale: this.clock.speed,
      wall_ts_ms: Date.now(),
      sim_elapsed_sec: round3(this.clock.t),
      step_id: this.step_id,
      event_type,
      bot_step_index: ctx.bot_step_index ?? null,
      correlation_id: ctx.correlation_id ?? null,
      payload,
    });
  }

  start() {
    this.emit('session_start', { config_keys: Object.keys(this.config).length, map_seed: this.meta.seed });
    this.emit('step_enter', { step_index: 1 });
  }

  end(reason = 'closed') {
    if (this.ended) return;
    this.ended = true;
    this.emit('session_end', { reason, score: this.score, era: this.era, resources: this.roundedResources() });
  }

  // ------------------------------------------------------------ derived
  get workersTotal() {
    let pop = this.config.starting_workers;
    for (const b of this.buildings) {
      if (b.type === 'shelter' && b.status === 'done') pop += Math.round(this.config.shelter_pop_gain * levelFactor(b.level));
    }
    return pop;
  }

  get workersUsed() {
    return this.buildings.reduce((n, b) => n + (b.worker || 0), 0);
  }

  get workersFree() { return Math.max(0, this.workersTotal - this.workersUsed); }

  get score() {
    let s = 10; // Town Center
    for (const b of this.buildings) {
      if (b.status === 'done' && BUILDINGS[b.type]) s += Math.round(BUILDINGS[b.type].score * levelFactor(b.level));
    }
    for (const id of this.techs) s += TECHS[id].score;
    return s + this.battleScore + this.featureScore;
  }

  hasBuilt(type) {
    return this.buildings.some((b) => b.type === type && b.status === 'done');
  }

  // Harvest yield for one building: tech bonuses, granary bonus, culture aura, and level.
  yieldOf(b) {
    const spec = BUILDINGS[b.type];
    let amount = spec.yield(this.config, this.techs);
    if (['food', 'wood'].includes(spec.produces) && this.hasBuilt('granary')) amount *= 1.25;
    if (b.cultureBoost) amount *= 1.20;
    return Math.round(amount * levelFactor(b.level));
  }

  upgradeStatus(b) {
    if (!b || b.status !== 'done' || !UPGRADABLE_TYPES.includes(b.type)) return { available: false, reason: 'not_upgradable' };
    const level = b.level || 1;
    if (level >= MAX_LEVEL) return { available: false, reason: 'max_level', level };
    const tech = UPGRADE_TECH[level + 1];
    if (!this.techs.has(tech)) return { available: false, reason: 'requires_prerequisite', requires: tech, level };
    const mult = this.config.upgrade_cost_multiplier ** level;
    const costs = Object.fromEntries(Object.entries(BUILDINGS[b.type].costs(this.config))
      .map(([r, v]) => [r, Math.round(v * mult)]));
    const missing = this.missing(costs);
    if (missing) return { available: true, affordable: false, reason: `insufficient_${missing.resource}`, missing, costs, level };
    return { available: true, affordable: true, costs, level };
  }

  expeditionUnlocked() {
    const at = this.config.unlock_expedition_at_step;
    return !!at && this.stepIndex >= STEPS.indexOf(at);
  }

  heroesUnlocked() {
    return this.stepIndex >= STEPS.indexOf('free_play');
  }

  get feature() { return this.config.feature_plugin || null; }
  get featureTarget() { return this.feature ? `btn_feature_${this.feature.feature_id}` : null; }

  featureUnlocked() {
    const f = this.feature;
    return !!f && this.stepIndex >= STEPS.indexOf(f.unlock_at_step);
  }

  featureStatus() {
    const f = this.feature;
    if (!f || !this.featureUnlocked()) return { unlocked: false, affordable: false };
    const cooldown = Math.max(0, this.featureReadyAt - this.clock.t);
    const missing = this.missing(this.featureCosts());
    return { unlocked: true, cooldown, missing, affordable: !cooldown && !missing };
  }

  featureCosts() {
    return Object.fromEntries(Object.entries(this.feature?.costs || {}).filter(([r]) => r in this.resources));
  }

  expeditionCosts() {
    return { wood: this.config.expedition_wood_cost, food: this.config.expedition_food_cost };
  }

  get quest() { return QUESTS[this.questIndex] || null; }

  questProgress() {
    const q = this.quest;
    if (!q) return { done: 0, total: 0, complete: false };
    const done = q.objectives.filter(([, fn]) => fn(this)).length;
    return { done, total: q.objectives.length, complete: done === q.objectives.length };
  }

  advisorMood() {
    if (this.hint) return 'hint';
    if (this.recentRejection()) return 'hint';
    return 'welcome';
  }

  recentRejection() {
    const r = this.lastRejection;
    return r && this.clock.t - r.t <= REJECTION_SHOW_SEC ? r : null;
  }

  rejectionText(r) {
    const need = (res) => r[`${res}_required`];
    const res = ALL_RESOURCES.find((k) => need(k) !== undefined);
    switch (r.reason) {
      case 'no_free_worker':
        if (!this.config.show_worker_warnings) return null;
        return this.buildings.some((b) => PRODUCER_TYPES.includes(b.type) && b.worker)
          ? 'We need a free Worker! Build a Small Home or tap a hut to reassign one.'
          : 'Need more Workers! Build a Small Home first.';
      case 'modal_blocking_map': return 'Close the scroll first, Chief. The valley is behind it.';
      case 'card_selection_blocking_harvest': return 'Put down the build card first (tap it again), then collect.';
      case 'locked': return r.lock ? `${r.lock}, Chief.` : 'That is still locked, Chief.';
      case 'cooldown': return `${this.feature?.title || 'That'} needs a moment to recover, Chief.`;
      case 'requires_prerequisite': return `First we must learn ${TECHS[r.requires]?.label || 'the earlier tech'}.`;
      default:
        if (!res) return null;
        if (r.target_id === 'tech_toolmaking' && res === 'wood' && this.hasBuilt('woodcutter_hut')) {
          return `Chief, we spent our Wood on the Woodcutter Hut! We need ${need(res)} Wood for Basic Toolmaking!`;
        }
        return `We need ${need(res)} ${RESOURCE_LABEL[res] || res} for that, Chief. We have ${r[`${res}_available`] ?? Math.floor(this.resources[res] ?? 0)}.`;
    }
  }

  roundedResources() {
    return Object.fromEntries(
      ['food', 'wood', 'stone', 'rp', 'coins', 'scrolls', 'tokens', 'stamina']
        .map((r) => [r, Math.floor(this.resources[r] ?? 0)])
    );
  }

  buildingAt(padId) {
    return this.buildings.find((b) => b.key === padId) || null;
  }

  optionalLocked() {
    const until = this.config.lock_optional_builds_until_step;
    if (!until) return false;
    return this.stepIndex <= STEPS.indexOf(until);
  }

  cardStatus(type) {
    const spec = BUILDINGS[type];
    if (spec.requiresTech && !this.techs.has(spec.requiresTech)) {
      return { locked: true, reason: 'locked', lock: `Needs ${TECHS[spec.requiresTech].label}` };
    }
    if (spec.optional && this.optionalLocked()) {
      return { locked: true, reason: 'locked', lock: 'Finish training first' };
    }
    const costs = spec.costs(this.config);
    const missing = this.missing(costs);
    if (missing) return { locked: false, affordable: false, reason: `insufficient_${missing.resource}`, missing, costs };
    if (spec.produces && this.workersFree < this.workersPerBuilding) {
      return { locked: false, affordable: false, reason: 'no_free_worker', costs };
    }
    return { locked: false, affordable: true, costs };
  }

  techStatus(id) {
    const spec = TECHS[id];
    if (this.techs.has(id)) return { done: true };
    const missingReq = spec.requires.find((r) => !this.techs.has(r));
    const costs = spec.costs(this.config);
    if (missingReq) return { available: false, reason: 'requires_prerequisite', requires: missingReq, costs };
    const missing = this.missing(costs);
    if (missing) return { available: true, affordable: false, reason: `insufficient_${missing.resource}`, missing, costs };
    return { available: true, affordable: true, costs };
  }

  affordableActions() {
    const out = new Set();
    for (const type of BUILD_ORDER) if (this.cardStatus(type).affordable) out.add(`card_${type}`);
    for (const id of TECH_ORDER) if (this.techStatus(id).affordable) out.add(id);
    return out;
  }

  savesTowardGoal(res) {
    if (!res) return false;
    if (this.step_id === 'onb_03_handoff') {
      const need = TECHS.tech_toolmaking.costs(this.config)[res] || 0;
      return Math.floor(this.resources[res] + 1e-9) < need;
    }
    if (this.step_id === 'free_play') {
      for (const id of TECH_ORDER) {
        const st = this.techStatus(id);
        if (st.available && !st.done && (st.costs?.[res] || 0) > Math.floor(this.resources[res] + 1e-9)) return true;
      }
      for (const type of ['barracks', 'stone_quarry', 'granary', 'smelter', 'tribal_monument']) {
        const st = this.cardStatus(type);
        if (!st.locked && (st.costs?.[res] || 0) > Math.floor(this.resources[res] + 1e-9)) return true;
      }
    }
    return false;
  }

  missing(costs) {
    for (const [res, amount] of Object.entries(costs)) {
      if (amount > 0 && Math.floor((this.resources[res] ?? 0) + 1e-9) < amount) {
        return { resource: res, available: Math.floor(this.resources[res] ?? 0), required: amount };
      }
    }
    return null;
  }

  pay(costs, tile) {
    const parts = [];
    for (const [res, amount] of Object.entries(costs)) {
      if (amount <= 0) continue;
      this.resources[res] -= amount;
      parts.push(`-${amount} ${RESOURCE_LABEL[res] || res}`);
    }
    if (parts.length) this.onFx({ type: 'popup', tile, text: parts.join('  '), color: '#ffb4a2', lift: 60 });
  }

  productionProgress(b) {
    const spec = BUILDINGS[b.type];
    if (!spec || !spec.produces || b.ready || b.blockedReason) return 0;
    return Math.max(0, Math.min(1, (this.clock.t - b.cycleStart) / spec.cycle(this.config)));
  }

  guideTarget() {
    if (this.modal === 'welcome') return 'btn_advisor_ok';
    if (this.step_id === 'onb_01_shelter') return this.buildGuide('shelter');
    if (this.step_id === 'onb_02_forager') {
      const hut = this.buildings.find((b) => b.type === 'forager_hut');
      if (hut) return hut.ready ? `building_${hut.key}` : null;
      return this.buildGuide('forager_hut');
    }
    return this.hint ? this.hint.target_id : null;
  }

  buildGuide(type) {
    if (this.selectedCard !== type) return `card_${type}`;
    const pad = this.activePads().find((p) => !this.buildingAt(p.id));
    return pad ? pad.id : null;
  }

  advisorText() {
    if (this.modal === 'welcome') return ADVISOR_TEXT.welcome;
    if (this.hint) return HINT_TEXT[this.hint.target_id] || ADVISOR_TEXT[this.step_id];
    const rej = this.recentRejection();
    const rejText = rej && this.rejectionText(rej);
    if (rejText) return rejText;
    const intro = this.featureIntro;
    if (intro && this.clock.t - intro.t <= FEATURE_INTRO_SHOW_SEC) return intro.text;
    if (this.bronzeAchieved) return ADVISOR_TEXT.bronze;
    if (this.achieved) return ADVISOR_TEXT.achieved;
    return ADVISOR_TEXT[this.step_id];
  }

  // -------------------------------------------------------------- Hero Logic
  heroStats(id) {
    const h = this.heroes[id];
    if (!h) return null;
    const mult = 1 + 0.35 * (h.level - 1);
    const hp = Math.round(h.baseHp * mult);
    const atk = Math.round(h.baseAtk * mult);
    const def = Math.round(h.baseDef * mult);
    const power = Math.round(hp * 0.45 + atk * 2.2 + def * 1.8);
    return { hp, atk, def, power, level: h.level, maxLevel: h.maxLevel, unlocked: h.unlocked };
  }

  squadPower() {
    let total = 0;
    for (const h of Object.values(this.heroes)) {
      if (h.unlocked) {
        total += this.heroStats(h.id).power;
      }
    }
    return total;
  }

  levelUpHero(heroId, reject) {
    const h = this.heroes[heroId];
    if (!h || !h.unlocked) return { result: 'noop' };
    if (h.level >= h.maxLevel) return { result: 'noop' };
    const costFood = 10 * h.level;
    const costScrolls = 5 * h.level;
    if (this.resources.food < costFood) {
      return reject ? reject('insufficient_food', { food_available: Math.floor(this.resources.food), food_required: costFood }) : { result: 'rejected' };
    }
    this.resources.food -= costFood;
    if (this.resources.scrolls >= costScrolls) {
      this.resources.scrolls -= costScrolls;
    }
    h.level += 1;
    this.stats.hero_levelups = (this.stats.hero_levelups || 0) + 1;
    this.featureScore += 15;
    const stats = this.heroStats(heroId);
    this.emit('hero_leveled', { hero_id: h.id, level: h.level, squad_power: this.squadPower() });
    this.onFx({ type: 'sfx', sound: 'hero_levelup' });
    this.onFx({ type: 'sparkle', tile: TOWN_CENTER_TILE, key: 'town_center' });
    this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: `${h.name} Lv.${h.level}! ⚔️ Power ${stats.power}`, color: '#ffd75e', lift: 110 });
    return { result: 'advanced' };
  }

  // -------------------------------------------------------------- clock
  update(realDt) {
    this.clock.advance(realDt);
    this.tick();
  }

  advanceTo(t) {
    if (t > this.clock.t) this.clock.t = t;
    this.tick();
  }

  tick() {
    const now = this.clock.t;
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const c = this.config;

    // Culture aura check: any completed tribal_monument casts a +20% aura within Euclidean dist <= 3.5
    const monuments = this.buildings.filter((b) => b.type === 'tribal_monument' && b.status === 'done');
    for (const b of this.buildings) {
      if (monuments.length > 0 && b.tile) {
        b.cultureBoost = monuments.some((m) => {
          const dr = (b.tile[0] || 0) - (m.tile[0] || 0);
          const dc = (b.tile[1] || 0) - (m.tile[1] || 0);
          return Math.hypot(dr, dc) <= 3.5;
        });
      } else {
        b.cultureBoost = false;
      }
    }

    for (const b of this.buildings) {
      if (b.status === 'building' && now >= b.completeAt) this.completeBuilding(b);

      // Passive Coin economy from completed Small Homes (+4 coins/sec per level)
      if (b.type === 'shelter' && b.status === 'done') {
        const rate = 4 * (b.level || 1) * (b.cultureBoost ? 1.2 : 1);
        this.resources.coins += rate * dt;
      }

      // Passive Scroll economy from completed Barracks (+1.5 scrolls/sec per level)
      if (b.type === 'barracks' && b.status === 'done') {
        const rate = 1.5 * (b.level || 1);
        this.resources.scrolls += rate * dt;
      }

      const spec = BUILDINGS[b.type];
      if (b.status !== 'done' || !spec || !spec.produces) continue;
      b.blockedReason = spec.toolTech && !this.techs.has(spec.toolTech) ? `Needs ${TECHS[spec.toolTech].label}` : null;
      if (!b.blockedReason && !b.worker && this.workersPerBuilding > 0) {
        b.blockedReason = 'Unstaffed (tap to assign worker)';
        if (!b.ready) b.cycleStart += dt;
      }
      if (!b.ready && !b.blockedReason && now - b.cycleStart >= spec.cycle(c)) b.ready = true;
    }

    const tent = this.buildings.find((b) => b.type === 'research_tent');
    if (tent && (tent.worker || this.workersPerBuilding === 0)) this.resources.rp += (c.research_tent_rp_per_min * dt) / 60;

    // Unlock Sun-Priestess Lyra on clearing stage 2 / megalithic ruins OR researching toolmaking / stone age
    if (!this.heroes.lyra.unlocked) {
      if (this.encountersCleared.has('stage_2') || this.encountersCleared.has('encounter_megalithic_ruins')
          || this.techs.has('tech_toolmaking') || this.techs.has('tech_stone_age')) {
        this.heroes.lyra.unlocked = true;
        this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: '✨ Hero Unlocked: Sun-Priestess Lyra!', color: '#ffd75e', lift: 130 });
        this.onFx({ type: 'sfx', sound: 'unlock' });
      }
    }

    // Live 2.5D Battle Arena simulation
    if (this.battleState && this.battleState.active) {
      const bs = this.battleState;
      if (bs.cutIn && now >= bs.cutInUntil) {
        bs.cutIn = null;
      }
      const exchangeInterval = 0.6 / (bs.speed || 1);
      if (now - (bs.lastExchangeT || 0) >= exchangeInterval) {
        bs.lastExchangeT = now;
        const isStage6Wall = (bs.stageId === 'stage_6' && this.squadPower() < 460 && bs.wave === bs.totalWaves);
        if (isStage6Wall) {
          bs.playerHp = Math.max(0, bs.playerHp - Math.round(bs.playerMaxHp * 0.65));
          this.onFx({ type: 'sfx', sound: 'reject' });
        } else {
          const vStats = this.heroStats('vaelen');
          const lStats = this.heroes.lyra.unlocked ? this.heroStats('lyra') : null;
          const alliedDmg = Math.round(((vStats?.atk || 28) + (lStats?.atk || 0)) * (0.85 + Math.random() * 0.3));
          const enemyDmg = Math.round((bs.stage.enemyPower / (bs.totalWaves * 3.5)) * (0.8 + Math.random() * 0.4));
          bs.enemyHp = Math.max(0, bs.enemyHp - alliedDmg);
          bs.playerHp = Math.max(0, bs.playerHp - enemyDmg);
          bs.vaelenRage = Math.min(100, bs.vaelenRage + 15);
          bs.lyraRage = Math.min(100, bs.lyraRage + 12);
        }

        if (bs.auto) {
          if (bs.vaelenRage >= 100) this.triggerUltimate('vaelen');
          else if (bs.lyraRage >= 100 && this.heroes.lyra.unlocked) this.triggerUltimate('lyra');
        }

        if (bs.playerHp <= 0) {
          bs.active = false;
          bs.outcome = 'defeat';
          this.emit('battle_lost', {
            stage_id: bs.stageId,
            enemy: bs.stage.name,
            squad_power: this.squadPower(),
            required_power: bs.stage.reqPower || bs.stage.enemyPower,
          });
          this.onFx({ type: 'sfx', sound: 'reject' });
        } else if (bs.enemyHp <= 0) {
          if (bs.wave < bs.totalWaves) {
            bs.wave += 1;
            bs.enemyHp = bs.enemyMaxHp;
            this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: `Wave ${bs.wave}/${bs.totalWaves}!`, color: '#ffcc00', lift: 70 });
          } else {
            bs.active = false;
            bs.outcome = 'victory';
            this.encountersCleared.add(bs.stageId);
            if (bs.stage.legacyId) this.encountersCleared.add(bs.stage.legacyId);
            this.stats.battles += 1;
            for (const [res, amt] of Object.entries(bs.stage.reward)) {
              if (res === 'score') this.battleScore += amt;
              else if (res in this.resources) this.resources[res] += amt;
            }
            if (bs.stageId === 'stage_2' || bs.stage.legacyId === 'encounter_megalithic_ruins') {
              this.heroes.lyra.unlocked = true;
            }
            this.emit('battle_won', { stage_id: bs.stageId, reward: bs.stage.reward });
            this.onFx({ type: 'sfx', sound: 'unlock' });
          }
        }
      }
    }

    if (!this.replay) {
      while (now >= this.nextHeartbeat) {
        this.emit('heartbeat', { resources: this.roundedResources(), score: this.score, workers_free: this.workersFree });
        this.nextHeartbeat += HEARTBEAT_SEC;
      }
    }
    this.checkProgress();
    if (!this.hint && this.modal !== 'welcome' && ['onb_03_handoff'].includes(this.step_id)
        && now - this.lastProgressT >= c.idle_hint_delay_sec) {
      const target_id = this.modal === 'research' ? 'tech_toolmaking' : 'btn_research';
      this.hint = { target_id };
      this.emit('hint_shown', { target_id, idle_sim_sec: round3(now - this.lastProgressT) });
    }
  }

  completeBuilding(b) {
    b.status = 'done';
    b.cycleStart = b.completeAt;
    if (b.type === 'barracks') {
      this.resources.scrolls += 15;
      this.onFx({ type: 'popup', tile: b.tile, text: '+15 Hero Scrolls!', color: '#e0c0ff', lift: 110 });
    }
    this.onFx({ type: 'sfx', sound: 'build' });
    this.onFx({ type: 'built', tile: b.tile, key: b.key });
    this.onFx({ type: 'popup', tile: b.tile, text: `${BUILDINGS[b.type].label} built!`, color: '#fff2b0', lift: 92 });
  }

  progress() {
    this.lastProgressT = this.clock.t;
    this.hint = null;
  }

  checkProgress() {
    let guard = 0;
    while (guard++ < 5 && this.stepIndex < 3 && this.stepDone(this.step_id)) {
      this.emit('step_complete', { step_index: this.stepIndex + 1 });
      this.stepIndex += 1;
      this.step_id = STEPS[this.stepIndex];
      this.progress();
      this.emit('step_enter', { step_index: this.stepIndex + 1 });
      this.onFx({ type: 'step', step_id: this.step_id });
    }
    if (!this.achieved && this.techs.has('tech_stone_age') && this.score >= this.config.first_achievement_target_score) {
      this.achieved = true;
      this.emit('achievement', { achievement_id: 'first_achievement', title: 'Stone Age Awakening', score: this.score });
      this.onFx({ type: 'achievement' });
    }
    if (!this.bronzeAchieved && this.era === 'bronze_age' && this.score >= this.config.bronze_achievement_target_score) {
      this.bronzeAchieved = true;
      this.emit('achievement', { achievement_id: 'bronze_age_mastery', title: 'Bronze Age Mastery', score: this.score });
      this.onFx({ type: 'achievement', achievement_id: 'bronze_age_mastery' });
    }
    const qp = this.questProgress();
    if (this.quest && qp.complete && !this.questClaimable) {
      this.questClaimable = true;
      if (this.config.auto_claim_quest_rewards) this.claimQuest();
    }
  }

  claimQuest() {
    const q = this.quest;
    if (!q || !this.questClaimable) return false;
    const parts = [];
    for (const [res, amount] of Object.entries(q.reward)) {
      if (amount <= 0) continue;
      this.resources[res] = (this.resources[res] ?? 0) + amount;
      parts.push(`+${amount} ${RESOURCE_LABEL[res] || res}`);
    }
    this.emit('quest_claimed', { quest_id: q.id, reward: q.reward, auto: !!this.config.auto_claim_quest_rewards });
    this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: parts.join('  '), color: '#ffe08a', lift: 120 });
    this.onFx({ type: 'sfx', sound: 'unlock' });
    this.questIndex += 1;
    this.questClaimable = false;
    return true;
  }

  stepDone(step) {
    if (step === 'onb_01_shelter') return this.buildings.some((b) => b.type === 'shelter' && b.status === 'done');
    if (step === 'onb_02_forager') return this.stats.forager_harvests > 0;
    if (step === 'onb_03_handoff') return this.techs.has('tech_toolmaking');
    return false;
  }

  // ------------------------------------------------------------ Combat Arena
  startBattleArena(stageId) {
    const stage = CAMPAIGN_STAGES.find((s) => s.id === stageId || s.legacyId === stageId);
    if (!stage) return false;
    const vaelenStats = this.heroStats('vaelen');
    const lyraStats = this.heroes.lyra.unlocked ? this.heroStats('lyra') : null;
    const playerMaxHp = (vaelenStats?.hp || 180) + (lyraStats ? lyraStats.hp : 0);
    const enemyMaxHp = Math.round(stage.enemyPower * 1.5);
    this.battleState = {
      active: true,
      outcome: null,
      stageId: stage.id,
      stage,
      wave: 1,
      totalWaves: stage.waves,
      playerHp: playerMaxHp,
      playerMaxHp,
      enemyHp: enemyMaxHp,
      enemyMaxHp,
      vaelenRage: 60,
      lyraRage: 50,
      auto: true,
      speed: 1,
      cutIn: null,
      cutInUntil: 0,
      popups: [],
      lastExchangeT: this.clock.t,
    };
    return true;
  }

  triggerUltimate(heroId) {
    if (!this.battleState || !this.battleState.active) return false;
    const bs = this.battleState;
    if (heroId === 'vaelen') {
      bs.vaelenRage = 0;
      bs.cutIn = { heroId: 'vaelen', name: 'Commander Vaelen', ult: 'EARTHSHATTER STOMP!', portrait: 'portrait_vaelen' };
      bs.cutInUntil = this.clock.t + 0.9;
      const dmg = Math.round(this.heroStats('vaelen').atk * 2.8);
      bs.enemyHp = Math.max(0, bs.enemyHp - dmg);
      this.onFx({ type: 'sfx', sound: 'hero_ult' });
      return true;
    }
    if (heroId === 'lyra' && this.heroes.lyra.unlocked) {
      bs.lyraRage = 0;
      bs.cutIn = { heroId: 'lyra', name: 'Sun-Priestess Lyra', ult: 'SOLAR SALVE!', portrait: 'portrait_lyra' };
      bs.cutInUntil = this.clock.t + 0.9;
      const heal = Math.round(bs.playerMaxHp * 0.45);
      bs.playerHp = Math.min(bs.playerMaxHp, bs.playerHp + heal);
      this.onFx({ type: 'sfx', sound: 'hero_heal' });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ actions
  click(target_id, x = null, y = null) {
    this.tick();
    this.clickSeq += 1;
    if (this.stats.first_click_t === null) this.stats.first_click_t = this.clock.t;
    const outcome = this.perform(target_id || 'empty');
    this.emit('click', {
      target_id: target_id || 'empty',
      x: x === null ? null : Math.round(x),
      y: y === null ? null : Math.round(y),
      result: outcome.result,
      ...(outcome.feature_used ? { feature_used: outcome.feature_used } : {}),
    });
    if (outcome.result === 'rejected') {
      this.lastRejection = { target_id, ...outcome.rejection, t: this.clock.t };
      this.emit('action_rejected', { target_id, ...outcome.rejection });
    }
    if (outcome.result === 'advanced') this.progress();
    this.checkProgress();
    return outcome;
  }

  perform(target_id) {
    const reject = (reason, extra = {}) => ({ result: 'rejected', rejection: { reason, ...extra } });
    if (target_id === 'btn_advisor_ok') {
      if (this.modal !== 'welcome') return { result: 'noop' };
      this.modal = null;
      return { result: 'ui' };
    }
    if (this.modal === 'welcome') return { result: 'noop' };
    if (['btn_speed', 'btn_inspect', 'btn_mute'].includes(target_id)) return { result: 'ui' };

    // Research
    if (target_id === 'btn_research') {
      this.modal = 'research';
      this.selectedCard = null;
      if (this.hint && this.hint.target_id === 'btn_research') this.hint = { target_id: 'tech_toolmaking' };
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_research') {
      if (this.modal !== 'research') return { result: 'noop' };
      this.modal = null;
      if (this.hint && this.hint.target_id === 'tech_toolmaking') this.hint = { target_id: 'btn_research' };
      return { result: 'ui' };
    }
    if (target_id.startsWith('tech_')) {
      if (this.modal !== 'research' || !TECHS[target_id]) return { result: 'noop' };
      return this.research(target_id, reject);
    }

    // Expedition / Campaign
    if (target_id === 'btn_expedition') {
      if (!this.expeditionUnlocked()) return { result: 'noop' };
      this.modal = 'expedition';
      this.selectedCard = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_expedition') {
      if (this.modal !== 'expedition') return { result: 'noop' };
      this.modal = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_start_arena') {
      this.modal = null;
      this.startBattleArena('stage_1');
      return { result: 'ui' };
    }
    if (target_id.startsWith('encounter_') || target_id.startsWith('stage_')) {
      if (this.modal !== 'expedition') return { result: 'noop' };
      return this.battle(target_id, reject);
    }
    if (target_id.startsWith('btn_arena_')) {
      const stageId = target_id.slice(10);
      this.modal = null;
      this.startBattleArena(stageId);
      return { result: 'ui' };
    }

    // Combat Arena controls
    if (target_id === 'btn_battle_speed') {
      if (this.battleState) {
        this.battleState.speed = this.battleState.speed === 1 ? 2 : 1;
        return { result: 'ui' };
      }
      return { result: 'noop' };
    }
    if (target_id === 'btn_battle_auto') {
      if (this.battleState) {
        this.battleState.auto = !this.battleState.auto;
        return { result: 'ui' };
      }
      return { result: 'noop' };
    }
    if (target_id === 'btn_ult_vaelen') {
      return this.triggerUltimate('vaelen') ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_ult_lyra') {
      return this.triggerUltimate('lyra') ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_battle_continue' || target_id === 'btn_victory_continue') {
      this.battleState = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_defeat_heroes' || target_id === 'btn_campaign_heroes') {
      this.battleState = null;
      this.modal = 'heroes';
      return { result: 'ui' };
    }

    // Heroes Modal & Management
    if (target_id === 'btn_heroes') {
      if (!this.heroesUnlocked()) return { result: 'noop' };
      this.modal = 'heroes';
      this.selectedCard = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_heroes') {
      if (this.modal !== 'heroes') return { result: 'noop' };
      this.modal = null;
      return { result: 'ui' };
    }
    if (target_id.startsWith('btn_select_hero_')) {
      const hId = target_id.slice(16);
      if (this.heroes[hId]) {
        this.selectedHero = hId;
        return { result: 'ui' };
      }
      return { result: 'noop' };
    }
    if (target_id === 'btn_hero_levelup') {
      return this.levelUpHero(this.selectedHero, reject);
    }
    if (target_id.startsWith('btn_levelup_')) {
      const hId = target_id.slice(12);
      return this.levelUpHero(hId, reject);
    }

    // Quests Ledger
    if (target_id === 'btn_quest_ledger' || target_id === 'btn_open_quests') {
      this.modal = 'quests';
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_quests') {
      if (this.modal !== 'quests') return { result: 'noop' };
      this.modal = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_claim_quest') {
      return this.claimQuest() ? { result: 'advanced' } : { result: 'noop' };
    }

    // Modal blocking map
    if (this.modal && MAP_PREFIXES.some((p) => target_id.startsWith(p))) {
      return reject('modal_blocking_map', { modal: this.modal });
    }
    if (this.modal) return { result: 'noop' };

    // Feature Plugin
    if (this.featureTarget && target_id === this.featureTarget) {
      if (!this.featureUnlocked()) return { result: 'noop' };
      return this.useFeature(reject);
    }

    // Free instant finish
    if (target_id.startsWith('free_')) {
      const padId = target_id.slice(5);
      const b = this.buildingAt(padId);
      if (b && b.status === 'building') {
        b.completeAt = this.clock.t;
        this.completeBuilding(b);
        this.onFx({ type: 'sfx', sound: 'free_finish' });
        this.onFx({ type: 'sparkle', tile: b.tile, key: b.key });
        return { result: 'advanced' };
      }
      return { result: 'noop' };
    }

    // Territory Expansions
    if (target_id === 'exp_1' || target_id === 'exp_2') {
      if (this.expansionsUnlocked.has(target_id)) return { result: 'noop' };
      if (this.resources.tokens >= 1) {
        this.resources.tokens -= 1;
      } else if (this.resources.coins >= 40) {
        this.resources.coins -= 40;
      } else if (this.resources.wood >= 20) {
        this.resources.wood -= 20;
      } else {
        return reject('insufficient_tokens', { token_required: 1, tokens_available: this.resources.tokens });
      }
      this.expansionsUnlocked.add(target_id);
      this.featureScore += 20;
      this.emit('territory_expanded', { expansion_id: target_id });
      this.onFx({ type: 'sfx', sound: 'unlock' });
      this.onFx({ type: 'dust', tile: target_id === 'exp_1' ? [2, 6] : [9, 5] });
      this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: 'Territory Expanded! +20 Score', color: '#8cff66', lift: 110 });
      return { result: 'advanced' };
    }

    // Upgrades & Workers
    if (target_id.startsWith('upgrade_')) {
      const b = this.buildingAt(target_id.slice(8));
      return this.upgrade(b, reject);
    }
    if (target_id.startsWith('worker_')) {
      const b = this.buildingAt(target_id.slice(7));
      return this.toggleWorker(b, reject);
    }

    // Card Selection
    if (target_id.startsWith('card_')) {
      const type = target_id.slice(5);
      if (!BUILDINGS[type]) return { result: 'noop' };
      const st = this.cardStatus(type);
      if (st.locked) {
        this.selectedCard = null;
        return reject('locked', { building: type, lock: st.lock });
      }
      if (!st.affordable) {
        this.selectedCard = null;
        return reject(st.reason, { building: type, ...(st.missing ? { [`${st.missing.resource}_available`]: st.missing.available, [`${st.missing.resource}_required`]: st.missing.required } : {}) });
      }
      this.selectedCard = this.selectedCard === type ? null : type;
      return { result: 'ui' };
    }

    // Pad Placement
    if (target_id.startsWith('pad_')) {
      const pad = this.activePads().find((p) => p.id === target_id);
      if (!pad || this.buildingAt(pad.id) || !this.selectedCard) return { result: 'noop' };
      return this.place(this.selectedCard, pad, reject);
    }

    // Building Harvest / Click
    if (target_id.startsWith('building_')) {
      const b = this.buildings.find((x) => `building_${x.key}` === target_id);
      if (!b) return { result: 'noop' };
      if (b.status === 'building') {
        b.completeAt = this.clock.t;
        this.completeBuilding(b);
        this.onFx({ type: 'sfx', sound: 'free_finish' });
        this.onFx({ type: 'sparkle', tile: b.tile, key: b.key });
        return { result: 'advanced' };
      }
      if (!b.ready) return { result: 'noop' };
      if (this.selectedCard) {
        if (!this.config.clear_selection_on_harvest) {
          return reject('card_selection_blocking_harvest', { building: b.type, selected_card: this.selectedCard });
        }
        this.selectedCard = null;
      }
      const before = this.affordableActions();
      const saving = this.savesTowardGoal(BUILDINGS[b.type]?.produces);
      this.harvest(b);
      const opened = [...this.affordableActions()].some((a) => !before.has(a));
      return { result: (opened || saving) ? 'advanced' : 'collected' };
    }
    if (target_id === 'btn_deselect' && this.selectedCard) {
      this.selectedCard = null;
      return { result: 'ui' };
    }
    return { result: 'noop' };
  }

  place(type, pad, reject) {
    const st = this.cardStatus(type);
    if (st.locked) return reject('locked', { building: type });
    if (!st.affordable) return reject(st.reason, { building: type });
    const spec = BUILDINGS[type];
    this.pay(st.costs, pad.tile);
    this.buildings.push({
      key: pad.id, type, tile: pad.tile, status: 'building', routeKey: pad.id,
      placedAt: this.clock.t, completeAt: this.clock.t + this.config.build_time_sec,
      worker: spec.produces ? this.workersPerBuilding : 0, produces: spec.produces || null,
      cycleStart: 0, ready: false, blockedReason: null, level: 1,
    });
    this.selectedCard = null;
    this.onFx({ type: 'dust', tile: pad.tile });
    return { result: 'advanced' };
  }

  upgrade(b, reject) {
    if (!b) return { result: 'noop' };
    const st = this.upgradeStatus(b);
    if (st.reason === 'not_upgradable' || st.reason === 'max_level') return { result: 'noop' };
    if (!st.available) return reject('requires_prerequisite', { building: b.type, requires: st.requires, level: st.level });
    if (!st.affordable) {
      return reject(st.reason, { building: b.type, level: st.level,
        [`${st.missing.resource}_available`]: st.missing.available, [`${st.missing.resource}_required`]: st.missing.required });
    }
    this.pay(st.costs, b.tile);
    b.level = st.level + 1;
    this.stats.upgrades += 1;
    this.onFx({ type: 'sparkle', tile: b.tile, key: b.key });
    this.onFx({ type: 'popup', tile: b.tile, text: `Lv.${b.level}!`, color: '#ffd75e', lift: 96 });
    this.onFx({ type: 'sfx', sound: 'build' });
    return { result: 'advanced' };
  }

  toggleWorker(b, reject) {
    if (!b || b.status !== 'done' || !PRODUCER_TYPES.includes(b.type) || this.workersPerBuilding === 0) return { result: 'noop' };
    if (b.worker) {
      b.worker = 0;
      return { result: 'ui' };
    }
    if (this.workersFree < this.workersPerBuilding) {
      return reject('no_free_worker', { building: b.type, workers_free: this.workersFree, workers_required: this.workersPerBuilding });
    }
    b.worker = this.workersPerBuilding;
    return { result: 'advanced' };
  }

  battle(id, reject) {
    const stage = CAMPAIGN_STAGES.find((s) => s.id === id || s.legacyId === id)
      || ENCOUNTERS.find((e) => e.id === id);
    if (!stage || this.encountersCleared.has(id) || (stage.id && this.encountersCleared.has(stage.id))) {
      return { result: 'noop' };
    }
    const costs = this.expeditionCosts();
    const missing = this.missing(costs);
    if (missing) {
      return reject(`insufficient_${missing.resource}`, { encounter: id,
        [`${missing.resource}_available`]: missing.available, [`${missing.resource}_required`]: missing.required });
    }

    // Stage 6 Sabertooth Canyon Power Check:
    if ((id === 'stage_6' || stage.id === 'stage_6') && this.squadPower() < 460) {
      this.pay(costs, TOWN_CENTER_TILE);
      this.battleState = {
        active: false,
        outcome: 'defeat',
        stageId: 'stage_6',
        stage: CAMPAIGN_STAGES.find((s) => s.id === 'stage_6'),
      };
      this.emit('battle_lost', {
        stage_id: 'stage_6',
        enemy: 'Sabertooth Pack Lv.4',
        squad_power: this.squadPower(),
        required_power: 460,
      });
      this.onFx({ type: 'sfx', sound: 'reject' });
      this.modal = null;
      return { result: 'advanced' };
    }

    this.pay(costs, TOWN_CENTER_TILE);
    const reward = stage.reward || BATTLE_REWARD;
    for (const [res, amt] of Object.entries(reward)) {
      if (res === 'score') this.battleScore += amt;
      else if (res in this.resources) this.resources[res] += amt;
    }
    this.encountersCleared.add(id);
    if (stage.id) this.encountersCleared.add(stage.id);
    if (stage.legacyId) this.encountersCleared.add(stage.legacyId);
    if (id === 'encounter_megalithic_ruins' || stage.id === 'stage_2') {
      this.heroes.lyra.unlocked = true;
    }
    this.stats.battles += 1;
    this.modal = null;
    this.battleState = null;
    this.emit('battle_won', { encounter: id, stage_id: stage.id || id, reward });
    const rewardText = Object.entries(reward).map(([r, a]) => `+${a} ${RESOURCE_LABEL[r] || r}`).join('  ');
    this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: `${stage.name || stage.label} won! ${rewardText}`, color: '#ffe08a', lift: 120 });
    this.onFx({ type: 'sfx', sound: 'unlock' });
    return { result: 'advanced' };
  }

  useFeature(reject) {
    const f = this.feature;
    const st = this.featureStatus();
    if (st.cooldown) return reject('cooldown', { feature_id: f.feature_id, cooldown_sec: round3(st.cooldown) });
    if (st.missing) {
      return reject(`insufficient_${st.missing.resource}`, { feature_id: f.feature_id,
        [`${st.missing.resource}_available`]: st.missing.available, [`${st.missing.resource}_required`]: st.missing.required });
    }
    const before = this.affordableActions();
    const saving = Object.keys(f.rewards || {}).some((r) => this.savesTowardGoal(r));
    this.pay(this.featureCosts(), TOWN_CENTER_TILE);
    const parts = [];
    for (const [res, amount] of Object.entries(f.rewards || {})) {
      if (amount <= 0) continue;
      if (res === 'score') this.featureScore += amount;
      else if (res in this.resources) this.resources[res] += amount;
      else continue;
      parts.push(`+${amount} ${RESOURCE_LABEL[res] || 'Score'}`);
    }
    this.featureUses += 1;
    this.featureReadyAt = this.clock.t + f.cooldown_sec;
    this.selectedCard = null;
    if (f.advisor_intro) this.featureIntro = { text: f.advisor_intro, t: this.clock.t };
    this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: `${f.title}! ${parts.join('  ')}`.trim(), color: '#ffe08a', lift: 120 });
    this.onFx({ type: 'sparkle', tile: TOWN_CENTER_TILE, key: 'town_center' });
    this.onFx({ type: 'sfx', sound: 'unlock' });
    const opened = [...this.affordableActions()].some((a) => !before.has(a));
    return { result: (opened || saving) ? 'advanced' : 'collected',
             feature_used: { feature_id: f.feature_id, action_type: f.action_type, costs: this.featureCosts(), rewards: f.rewards } };
  }

  harvest(b) {
    const spec = BUILDINGS[b.type];
    const amount = this.yieldOf(b);
    this.resources[spec.produces] += amount;
    b.ready = false;
    b.cycleStart = this.clock.t;
    if (b.type === 'forager_hut') this.stats.forager_harvests += 1;
    this.onFx({ type: 'popup', tile: b.tile, text: `+${amount} ${RESOURCE_LABEL[spec.produces]}`, color: '#b8f28a', lift: 84 });
    this.onFx({ type: 'sfx', sound: 'harvest' });
  }

  research(id, reject) {
    const st = this.techStatus(id);
    if (st.done) return { result: 'noop' };
    if (!st.available) return reject('requires_prerequisite', { tech: id, requires: st.requires });
    if (!st.affordable) {
      return reject(st.reason, { tech: id, [`${st.missing.resource}_available`]: st.missing.available, [`${st.missing.resource}_required`]: st.missing.required });
    }
    this.pay(st.costs, TOWN_CENTER_TILE);
    this.techs.add(id);
    for (const b of this.buildings) {
      const spec = BUILDINGS[b.type];
      if (spec && spec.toolTech === id && b.status === 'done') { b.cycleStart = this.clock.t; b.blockedReason = null; }
    }
    if (id === 'tech_stone_age') {
      this.era = 'stone_age';
      this.onFx({ type: 'sparkle', tile: TOWN_CENTER_TILE, key: 'town_center' });
      this.onFx({ type: 'era', era: 'stone_age' });
    }
    if (id === 'tech_bronze_age') {
      this.era = 'bronze_age';
      this.onFx({ type: 'sparkle', tile: TOWN_CENTER_TILE, key: 'town_center' });
      this.onFx({ type: 'era', era: 'bronze_age' });
    }
    this.onFx({ type: 'sfx', sound: 'unlock' });
    this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: `${TECHS[id].label}!`, color: '#a8e6ff', lift: 110 });
    this.onFx({ type: 'tech', tech: id });
    if (this.config.auto_close_research_on_unlock) this.modal = null;
    return { result: 'advanced' };
  }

  snapshot() {
    return {
      step_id: this.step_id,
      era: this.era,
      resources: this.roundedResources(),
      workers_free: this.workersFree,
      workers_total: this.workersTotal,
      score: this.score,
      modal_open: this.modal,
      selected_card: this.selectedCard,
      techs: [...this.techs],
      achieved: this.achieved,
      bronze_achieved: this.bronzeAchieved,
      quest_index: this.questIndex,
      quest_claimable: this.questClaimable,
      battles: this.stats.battles,
      feature_uses: this.featureUses,
      heroes: Object.fromEntries(Object.entries(this.heroes).map(([k, v]) => [k, { level: v.level, unlocked: v.unlocked, power: this.heroStats(k).power }])),
      squad_power: this.squadPower(),
      expansions_unlocked: [...this.expansionsUnlocked],
      battle_active: !!(this.battleState && this.battleState.active),
      buildings: this.buildings.filter((b) => b.key.startsWith('pad_'))
        .map((b) => ({ key: b.key, type: b.type, level: b.level || 1, worker: b.worker, status: b.status,
                       blocked_reason: b.blockedReason || null })),
      sim_elapsed_sec: round3(this.clock.t),
    };
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
