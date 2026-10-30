// Game rules and state: onboarding state machine, economy, workers, buildings,
// upgrades, tech tree, chapter quests, expeditions and the era achievements. All timers are absolute simulated times,
// so the state is a pure function of (config, actions, action times). The
// replay view relies on that to re-simulate recorded runs.

import { SimClock } from './clock.js';
import { PADS, RESEARCH_TENT_TILE, TOWN_CENTER_TILE, BATTLE_COLS, BATTLE_ROWS, BATTLE_BLOCKED } from './iso_renderer.js';

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
const UPGRADE_TECH = { 2: 'tech_construction', 3: 'tech_stone_age' };

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
  hero_arena: {
    label: "Heroes' Arena", blurb: 'Heroes train here over time', score: 20, optional: true,
    requiresBuilding: 'barracks',
    costs: () => ({ wood: 40, stone: 25 }),
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
export const ALL_BUILD_ORDER = ['shelter', 'forager_hut', 'woodcutter_hut', 'barracks', 'hero_arena', 'stone_quarry', 'granary', 'smelter', 'tribal_monument'];

export const TECHS = {
  tech_toolmaking: {
    label: 'Basic Toolmaking', icon: '\u{1FA93}', requires: [], score: 10,
    effect: 'Stone axes. Woodcutters can chop, unlocks the Monument.',
    costs: (c) => ({ wood: c.research_toolmaking_wood_cost }),
  },
  tech_woodworking: {
    label: 'Woodworking', icon: '\u{1FAB5}', requires: ['tech_toolmaking', 'tech_baskets'], score: 10,
    effect: '+50% Woodcutter yield.',
    costs: (c) => ({ food: c.research_woodworking_food_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_baskets: {
    label: 'Foraging Baskets', icon: '\u{1F9FA}', requires: ['tech_toolmaking'], score: 10,
    effect: '+50% Forager yield.',
    costs: (c) => ({ food: c.research_baskets_food_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_masonry: {
    label: 'Masonry', icon: '\u{1FAA8}', requires: ['tech_toolmaking', 'tech_baskets'], score: 10,
    effect: 'Unlocks the Stone Quarry.',
    costs: (c) => ({ wood: c.research_masonry_wood_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_stone_age: {
    label: 'Stone Age Awakening', icon: '\u{1F3DB}\u{FE0F}', requires: ['tech_toolmaking', 'tech_masonry'], score: 50,
    effect: 'Enter the Stone Age. Upgrades the Town Center.',
    costs: (c) => ({ food: c.research_stone_age_food_cost, stone: c.research_stone_age_stone_cost, rp: c.research_stone_age_rp_cost }),
  },
  tech_construction: {
    label: 'Sturdy Construction', icon: '🏗️', requires: ['tech_toolmaking', 'tech_woodworking'], score: 10,
    effect: 'Unlocks building upgrades to Lv.2.',
    costs: (c) => ({ wood: c.research_masonry_wood_cost, rp: c.research_tier2_rp_cost }),
  },
  tech_irrigation: {
    label: 'Irrigation', icon: '\u{1F33E}', requires: ['tech_bronze_age'], score: 15,
    effect: 'Another +50% Forager yield.',
    costs: (c) => ({ food: c.research_irrigation_food_cost, stone: c.research_irrigation_stone_cost, rp: c.research_tier3_rp_cost }),
  },
  tech_bronze_age: {
    // The Bronze Age opens only once every earlier research is done.
    label: 'Bronze Age Dawn', icon: '\u{1F525}', requires: ['tech_toolmaking', 'tech_woodworking', 'tech_baskets', 'tech_masonry', 'tech_construction', 'tech_stone_age'], score: 60,
    effect: 'Cast bronze. Enter the Bronze Age.',
    costs: (c) => ({ food: c.research_bronze_age_food_cost, wood: c.research_bronze_age_wood_cost,
                     stone: c.research_bronze_age_stone_cost, rp: c.research_bronze_age_rp_cost }),
  },
};
export const TECH_ORDER = ['tech_toolmaking', 'tech_woodworking', 'tech_baskets', 'tech_masonry', 'tech_stone_age',
  'tech_construction', 'tech_bronze_age', 'tech_irrigation'];

export const ERA_LABEL = { dawn_age: 'Dawn Age', stone_age: 'Stone Age', bronze_age: 'Bronze Age' };

// 6-Chapter Questlines. Preserves exact predicates for chapters 1-3 so existing tests pass.
export const QUESTS = [
  {
    id: 'chapter_1', title: 'Chapter I: Foundations',
    objectives: [
      ['Build a Small Home', (g) => g.stepIndex >= 1],
      ['Build a Rural Farm and harvest food', (g) => g.stepIndex >= 2],
      ['Discover Basic Toolmaking', (g) => g.techs.has('tech_toolmaking')],
      ['Build a Woodcutter', (g) => g.hasBuilt('woodcutter_hut')],
    ],
    reward: { food: 20, wood: 20, coins: 30, scrolls: 10 },
  },
  {
    id: 'chapter_2', title: 'Chapter II: Into the Stone Age',
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
      ['Build a Granary', (g) => g.hasBuilt('granary')],
      ['Upgrade 2 Buildings to Lv.2', (g) => g.buildings.filter((b) => (b.level || 1) >= 2).length >= 2],
      ['Research Irrigation', (g) => g.techs.has('tech_irrigation')],
    ],
    reward: { coins: 60, stone: 30, rp: 15 },
  },
  {
    id: 'chapter_5', title: 'Chapter V: Breaking the Sabertooth Wall',
    objectives: [
      ['Level Tor to Lv.3+', (g) => (g.heroes?.aurelius?.level || 1) >= 3],
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
  { id: 'stage_1', legacyId: 'encounter_misty_river', name: '1. Misty River Crossing', enemyPower: 120, slots: 1, waves: 1, enemies: 'Ash Clan Patrol Lv.1', reward: { rp: 6, stone: 15, score: 15, scrolls: 10 } },
  { id: 'stage_2', legacyId: 'encounter_megalithic_ruins', name: '2. Sunlit Glade Ambush', enemyPower: 165, slots: 1, waves: 1, enemies: 'Boar Clan Raiders Lv.1', reward: { rp: 6, stone: 15, score: 15, tokens: 1 } },
  { id: 'stage_3', legacyId: 'encounter_quarry_ridge', name: '3. Megalithic Ruins', enemyPower: 240, slots: 2, waves: 2, enemies: 'Flint Clan Warband Lv.2', reward: { rp: 8, stone: 15, score: 20, scrolls: 15 } },
  { id: 'stage_4', legacyId: null, name: '4. Whispering Pine Gorge', enemyPower: 310, slots: 2, waves: 2, enemies: 'Frost Clan Raiders Lv.2', reward: { rp: 10, stone: 20, score: 20, coins: 25 } },
  { id: 'stage_5', legacyId: null, name: '5. Quarry Ridge Outpost', enemyPower: 390, slots: 3, waves: 2, enemies: 'Gale Clan Stalkers Lv.3', reward: { rp: 12, stone: 25, score: 25, tokens: 1 } },
  { id: 'stage_6', legacyId: null, name: '6. Sabertooth Canyon', enemyPower: 520, slots: 3, waves: 3, reqPower: 460, enemies: 'Tusk Clan Warband Lv.4', reward: { rp: 15, stone: 35, score: 35, coins: 40 } },
  { id: 'stage_7', legacyId: null, name: '7. Obsidian Crag', enemyPower: 640, slots: 4, waves: 3, reqPower: 580, enemies: 'Raven Clan Warband Lv.5', reward: { rp: 20, stone: 40, score: 40, scrolls: 30 } },
  { id: 'stage_8', legacyId: null, name: "8. BOSS: Shadowclaw's Lair", enemyPower: 780, slots: 4, waves: 3, reqPower: 700, enemies: 'Shadowclaw Lv.6', reward: { rp: 30, stone: 60, score: 60, coins: 100 } },
];

// Rival clan roster (Astra design, docs in Downloads/enemy-roster.md):
// every battle draws its enemies randomly from the stage's tier band.
export const ENEMY_ROSTER = [
  { name: 'Ash Clan Clubman', tier: 1, role: 'melee', speed: 4, sprite: 'enemy_ash_clubman' },
  { name: 'Reed Clan Slinger', tier: 1, role: 'ranged', speed: 5, sprite: 'enemy_reed_slinger' },
  { name: 'Birch Clan Knifer', tier: 1, role: 'skirmisher', speed: 6, sprite: 'enemy_birch_knifer' },
  { name: 'Flint Clan Axeman', tier: 2, role: 'melee', speed: 4, sprite: 'enemy_flint_axeman' },
  { name: 'Moss Clan Bowhand', tier: 2, role: 'ranged', speed: 5, sprite: 'enemy_moss_bowhand' },
  { name: 'Oak Clan Doorward', tier: 2, role: 'tank', speed: 3, sprite: 'enemy_oak_doorward' },
  { name: 'Thorn Clan Runner', tier: 3, role: 'skirmisher', speed: 7, sprite: 'enemy_thorn_runner' },
  { name: 'Reed Clan Herbkeeper', tier: 3, role: 'healer', speed: 4, sprite: 'enemy_reed_herbkeeper' },
  { name: 'Flint Clan Hookman', tier: 3, role: 'melee', speed: 4, sprite: 'enemy_flint_hookman' },
  { name: 'Ash Clan Drumhand', tier: 4, role: 'support', speed: 4, sprite: 'enemy_ash_drumhand' },
  { name: 'Frost Clan Guard', tier: 4, role: 'tank', speed: 3, sprite: 'enemy_frost_guard' },
  { name: 'Cinder Clan Dartman', tier: 4, role: 'ranged', speed: 6, sprite: 'enemy_cinder_dartman' },
  { name: 'Boar Clan Cleaver', tier: 5, role: 'melee', speed: 4, sprite: 'enemy_boar_cleaver' },
  { name: 'Gale Clan Scout', tier: 5, role: 'skirmisher', speed: 7, sprite: 'enemy_gale_scout' },
  { name: 'Thorn Clan Longbow', tier: 5, role: 'ranged', speed: 4, sprite: 'enemy_thorn_longbow' },
  { name: 'Tusk Clan Shieldwall', tier: 6, role: 'tank', speed: 3, sprite: 'enemy_tusk_shieldwall' },
  { name: 'Tusk Clan Spearcast', tier: 6, role: 'ranged', speed: 5, sprite: 'enemy_tusk_spearcast' },
  { name: 'Raven Clan Standard', tier: 6, role: 'support', speed: 4, sprite: 'enemy_raven_standard' },
  { name: 'Iron Clan Swordsman', tier: 7, role: 'melee', speed: 5, sprite: 'enemy_iron_swordsman' },
  { name: 'Gale Clan Harrier', tier: 7, role: 'skirmisher', speed: 7, sprite: 'enemy_gale_harrier' },
  { name: 'Frost Clan Bonewright', tier: 7, role: 'healer', speed: 4, sprite: 'enemy_frost_bonewright' },
  { name: 'Night Clan Gateward', tier: 8, role: 'tank', speed: 3, sprite: 'enemy_night_gateward' },
  { name: 'Night Clan Bowguard', tier: 8, role: 'ranged', speed: 5, sprite: 'enemy_night_bowguard' },
  { name: 'Iron Clan Breaker', tier: 8, role: 'melee', speed: 4, sprite: 'enemy_iron_breaker' },
];
export const ENEMY_BOSSES = {
  stage_6: { name: 'Tusk Chief', role: 'melee', speed: 4, sprite: 'enemy_tusk_chief' },
  stage_7: { name: 'Raven Marshal', role: 'ranged', speed: 5, sprite: 'enemy_raven_marshal' },
  stage_8: { name: 'Shadowclaw', role: 'melee', speed: 6, sprite: 'enemy_shadowclaw' },
};

const BATTLE_REWARD = { rp: 6, stone: 15, score: 15 };
const MAP_PREFIXES = ['pad_', 'building_', 'card_', 'upgrade_', 'worker_', 'free_', 'exp_'];

export const ADVISOR_TEXT = {
  welcome: 'There you are, Chief. Raise a Small Home before supper; wet grass makes a poor bed, especially at my age.',
  onb_01_shelter: 'There you are, Chief. Raise a Small Home before supper; wet grass makes a poor bed, especially at my age.',
  onb_02_forager: 'A roof overhead, but nothing in the pot. Plant a Rural Farm, let the crop ripen, then harvest it to feed the tribe.',
  onb_03_handoff: 'We have shelter and supper, Chief. Now open Research and learn Basic Toolmaking; after that, you can spare yourself an old man\'s lessons.',
  free_play: 'Time to look beyond our hearths, Chief. Train your heroes, win battles in the Campaign, and lead us into the Stone Age.',
  achieved: 'The Stone Age is here, Chief. Strengthen our buildings, raise a Copper Smelter, and send your heroes to win battles; boasting alone won\'t do.',
  bronze: 'The Bronze Age is ours, Chief. Look at those gleaming spears and shields; I thought these old eyes had seen their last marvel.',
};
const HINT_TEXT = {
  btn_research: 'Open Research, Chief. There\'s learning waiting, and I\'ve only so much wisdom left to repeat.',
  tech_toolmaking: 'Choose Basic Toolmaking and learn it, Chief. A good edge saves hard work, and these old shoulders approve.',
  card_woodcutter_hut: 'Now raise a Woodcutter, Chief. Axes in the greenwood will fill our woodpile, and a full woodpile builds a village.',
};

// Chapter openings and per-task Elder lines, Chapters II to VI (Astra-edited).
// tasks align with the chapter's objective order; Chapter VI has no Bronze
// line because researching Bronze enters the era at once (index 0 is null).
const CHAPTER_ANNOUNCE = {
  chapter_2: {
    open: 'Our foundations hold, Chief. Learn to work stone and strengthen the village; winter seldom knocks before coming in.',
    tasks: [
      'Open Research and learn Masonry, Chief. A well-laid stone wall keeps the wind outside, where it can grumble without me.',
      'Raise a Stone Quarry, Chief. The mountain can spare us some stone; it has stood there doing precious little all winter.',
      'Open Research and awaken the Stone Age, Chief. Let us give this village something sturdier than my knees to stand on.',
    ],
  },
  chapter_3: {
    open: 'Bring fire, craft, and trained heroes to the village, Chief. Stone walls are a fine start, but they cannot do all the work.',
    tasks: [
      'Build a Copper Smelter, Chief. A steady furnace turns copper into useful tools; my hearth mostly turns supper into smoke.',
      'Improve a building to its next level, Chief. These old walls deserve some care; they shelter more useful things than my opinions.',
      'Finish the Bronze Age research, Chief. Learn the craft before we promise bronze tools; promises make poor axe heads.',
    ],
  },
  chapter_4: {
    open: 'Fill our stores, strengthen our buildings, and bring water to the fields, Chief. Let winter find us ready for a change.',
    tasks: [
      'Build a Granary, Chief. Keep our grain dry and safely stored; winter is a poor season to discover the mice have eaten better than us.',
      'Improve more of our buildings to their next level, Chief. A village needs sound roofs all round, especially with our rain.',
      'Open Research and learn Irrigation, Chief. Bring water to our fields; waiting on the clouds is work best left to old men.',
    ],
  },
  chapter_5: {
    open: 'Prepare Tor for the fight at Sabertooth Canyon, Chief. Those beasts have blocked our road long enough to start charging rent.',
    tasks: [
      'Raise Tor\'s level through training, Chief. Let him sharpen his skills here before the canyon beasts offer their own lessons.',
      'Conquer Sabertooth Canyon in the Campaign, Chief. Clear those beasts from the road; I prefer my walks without teeth at the end.',
      'Build a Barracks or a Copper Smelter, Chief. Our warriors need somewhere to train or better tools; songs can wait until supper.',
    ],
  },
  chapter_6: {
    open: 'Gather your best heroes for Shadowclaw, Chief. We have a fine valley growing here, and he has been a thoroughly poor neighbour.',
    tasks: [
      null,
      'Defeat Shadowclaw in the Campaign, Chief. Send your best heroes to settle the matter; these hills could use a quieter neighbour.',
      'Raise your Empire Score by building, researching, and winning Campaign battles, Chief. Give this old man a village worth boasting about.',
    ],
  },
};

// HoMM3 hex field (odd-r offset, cube math for distance and neighbours).
function hexCube(gx, gy) { const q = gx - (gy - (gy & 1)) / 2; return [q, -q - gy, gy]; }
function cubeHex(q, s, r) { return [q + (r - (r & 1)) / 2, r]; }
const HEX_DIRS = [[1, 0, -1], [1, -1, 0], [0, -1, 1], [-1, 0, 1], [-1, 1, 0], [0, 1, -1]];
function hexNeighbors(gx, gy) {
  const [q, s, r] = hexCube(gx, gy);
  return HEX_DIRS.map(([dq, ds, dr]) => cubeHex(q + dq, s + ds, r + dr));
}
function hexDistance(a, b) {
  const [aq, as, ar] = hexCube(a.gx, a.gy);
  const [bq, bs, br] = hexCube(b.gx, b.gy);
  return Math.max(Math.abs(aq - bq), Math.abs(as - bs), Math.abs(ar - br));
}
// True when the centre-to-centre shot line crosses a rock hex interior:
// that rock grants the target cover (25% less ranged damage).
function shotHasCover(a, b) {
  const [aq, as, ar] = hexCube(a.gx, a.gy);
  const [bq, bs2, br] = hexCube(b.gx, b.gy);
  const steps = Math.max(Math.abs(aq - bq), Math.abs(as - bs2), Math.abs(ar - br));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    let q = aq + (bq - aq) * t, s = as + (bs2 - as) * t, r = ar + (br - ar) * t;
    let rq = Math.round(q), rs = Math.round(s), rr = Math.round(r);
    const dq = Math.abs(rq - q), ds = Math.abs(rs - s), dr = Math.abs(rr - r);
    if (dq > ds && dq > dr) rq = -rs - rr; else if (ds > dr) rs = -rq - rr; else rr = -rq - rs;
    const [gx, gy] = cubeHex(rq, rs, rr);
    if (BATTLE_BLOCKED.some(([x, y]) => x === gx && y === gy)) return true;
  }
  return false;
}

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
    this.pendingPlacement = null;
    this.selectedBuilding = null;
    this.modal = 'welcome';
    this.achieved = false;
    this.stats = { forager_harvests: 0, clicks: 0, first_click_t: null, upgrades: 0, battles: 0, hero_levelups: 0 };
    this.bronzeAchieved = false;
    this.questIndex = 0;
    this.questClaimable = false;
    this.battleScore = 0;
    this.encountersCleared = new Set();
    this.stageStars = {};
    this.featureScore = 0;
    this.featureUses = 0;
    this.featureReadyAt = 0;
    this.featureIntro = null;
    this.lastProgressT = 0;
    this.hint = null;
    this.woodcutterAnnounced = false;
    this.chapterOpenFor = null;
    this.chapterOpenPending = false;
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
        id: 'vaelen', name: 'Bera the Shield-Hunter', title: 'Shield of the Tribe',
        role: 'Hide Shield & Bone Spear', stars: 3, unlocked: true, level: 1, maxLevel: 7,
        baseHp: 180, baseAtk: 28, baseDef: 18, speed: 4,
        ultName: 'Earthshatter Stomp',
        ultDesc: 'Deals 160% AoE shockwave damage to all enemies and stuns for 1.5s.',
        sprite: 'hero_vaelen', portrait: 'portrait_vaelen',
      },
      lyra: {
        id: 'lyra', name: 'Sunweaver Lyra', title: 'Voice of the Dawn',
        role: 'Reed Sun-Disc Healer', stars: 2, unlocked: false, level: 1, maxLevel: 7,
        baseHp: 130, baseAtk: 24, baseDef: 12, speed: 6,
        ultName: 'Solar Salve',
        ultDesc: 'Restores +45% max HP to all allied Heroes and grants a Golden Sun Shield.',
        sprite: 'hero_lyra', portrait: 'portrait_lyra',
      },
      ignis: {
        id: 'ignis', name: 'Ember-Keeper Ignis', title: 'Keeper of the First Fire',
        role: 'Clay Fire Pot Caster', stars: 4, unlocked: false, level: 1, maxLevel: 7,
        baseHp: 110, baseAtk: 38, baseDef: 10, speed: 7,
        ultName: 'Ember Storm',
        ultDesc: 'Hurls the sacred fire pot, raining embers for 220% damage.',
        sprite: 'hero_ignis', portrait: 'portrait_ignis',
      },
      aurelius: {
        id: 'aurelius', name: 'Tor the Stone-Breaker', title: 'Breaker of Stone',
        role: 'Stone Maul Brute', stars: 5, unlocked: true, level: 1, maxLevel: 7,
        baseHp: 220, baseAtk: 34, baseDef: 24, speed: 3,
        ultName: 'Mountain Smash',
        ultDesc: 'Slams his stone maul down, knocking back all foes.',
        sprite: 'hero_aurelius', portrait: 'portrait_aurelius',
      },
    };
    this.selectedHero = 'vaelen';

    // Live 2.5D Battle Arena
    this.battleState = null;
    this.heroTraining = null;
    this.preBattle = null;

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
    // Free placement: every open meadow tile can be built on, not just the
    // fixed plots. Fixed pads come first so guided builds keep their layout.
    // Blocked: the forest corner (north), the river-bank corner (south-east
    // tip), and the two town tiles. Everything else, including the old
    // cliff strip and two extra rows toward the river, is buildable.
    const covered = new Set(pads.map((p) => p.tile.join(',')));
    covered.add(TOWN_CENTER_TILE.join(','));
    covered.add(RESEARCH_TENT_TILE.join(','));
    for (let i = 0; i < 14; i++) {
      for (let j = 0; j < 14; j++) {
        if (covered.has(`${i},${j}`)) continue;
        if (i + j <= 3) continue;    // forest corner
        if (j === 0) continue;       // top-right forest row: not buildable
        if (i + j >= 25) continue;   // river-bank corner
        pads.push({ id: `tile_${i}_${j}`, tile: [i, j] });
      }
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
      case 'requires_arena': return "Heroes train at the Heroes' Arena, Chief. Build one first (it needs a Barracks).";
      case 'training_busy': return 'Training is already under way at the Arena, Chief.';
      case 'modal_blocking_map': return 'Close the scroll first, Chief. The valley is behind it.';
      case 'card_selection_blocking_harvest': return 'Put down the build card first (tap it again), then collect.';
      case 'locked': return r.lock ? `${r.lock}, Chief.` : 'That is still locked, Chief.';
      case 'outside_building_field': return 'No building there, Chief. Forest, cliffs and the river bank stay wild. Build inside the glowing field.';
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
    if (spec.requiresBuilding && !this.hasBuilt(spec.requiresBuilding)) {
      return { locked: true, reason: 'locked', lock: `Needs ${BUILDINGS[spec.requiresBuilding].label}` };
    }
    if (spec.optional && this.optionalLocked()) {
      return { locked: true, reason: 'locked', lock: 'Finish training first' };
    }
    const costs = spec.costs(this.config);
    const missing = this.missing(costs);
    if (missing) return { locked: false, affordable: false, reason: `insufficient_${missing.resource}`, missing, costs };
    // Producers may be built with no free worker: they start unstaffed and
    // their worker sign prompts the assignment once a worker is free.
    return { locked: false, affordable: true, costs };
  }

  techStatus(id) {
    const spec = TECHS[id];
    if (this.techs.has(id)) return { done: true };
    const missingReq = spec.requires.find((r) => !this.techs.has(r));
    const costs = spec.costs(this.config);
    if (missingReq) return { available: false, reason: 'requires_prerequisite', requires: missingReq, costs };
    // The Bronze Age is gated by research prerequisites and its resource
    // costs, not by time: when the tribe can pay, it can enter the era.
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
    if (this.pendingPlacement) return 'btn_confirm_placement';
    if (this.step_id === 'onb_01_shelter') return this.buildGuide('shelter');
    if (this.step_id === 'onb_02_forager') {
      const hut = this.buildings.find((b) => b.type === 'forager_hut');
      if (hut) return hut.ready ? `building_${hut.key}` : null;
      return this.buildGuide('forager_hut');
    }
    if (this.step_id === 'onb_03_handoff') {
      // Point at Research only once Basic Toolmaking is actually affordable;
      // until then the player should be gathering wood, not staring at a lock.
      if (this.modal === 'research') return this.techStatus('tech_toolmaking').affordable ? 'tech_toolmaking' : null;
      return this.techStatus('tech_toolmaking').affordable ? 'btn_research' : null;
    }
    // The helping arrow guides Chapter I (and Claim at its end), then it
    // stops for good: from Chapter II on, the player finds their own way.
    if (this.step_id === 'free_play' && this.quest?.id === 'chapter_1') {
      if (this.questClaimable) return 'btn_claim_quest';
      const nextIdx = this.quest.objectives.findIndex(([, fn]) => !fn(this));
      if (nextIdx >= 0) return this.questGuide(this.quest.id, nextIdx);
    }
    // No helping arrow after Chapter I, not even from a leftover hint.
    if (this.step_id === 'free_play') return null;
    return this.hint ? this.hint.target_id : null;
  }

  // Guide target for one chapter task, aligned with the task gates.
  questGuide(chapterId, idx) {
    const buildArrow = (type) => (this.selectedCard === type || this.cardStatus(type).affordable)
      ? this.buildGuide(type) : null;
    const researchArrow = (tech) => this.modal === 'research' ? tech
      : (this.techStatus(tech).affordable ? 'btn_research' : null);
    const ready = () => this.taskActionable(chapterId, idx);
    const guides = {
      chapter_1: [null, null, () => researchArrow('tech_toolmaking'), () => buildArrow('woodcutter_hut')],
      chapter_2: [() => researchArrow('tech_masonry'), () => buildArrow('stone_quarry'), () => researchArrow('tech_stone_age')],
      chapter_3: [() => buildArrow('smelter'), () => (ready() ? 'btn_upgrades' : null), () => researchArrow('tech_bronze_age')],
      chapter_4: [() => buildArrow('granary'), () => (ready() ? 'btn_upgrades' : null), () => researchArrow('tech_irrigation')],
      chapter_5: [() => (ready() ? 'btn_heroes' : null), () => (ready() ? 'btn_expedition' : 'btn_heroes'), () => buildArrow('barracks') || buildArrow('smelter')],
      chapter_6: [() => researchArrow('tech_bronze_age'), () => (ready() ? 'btn_expedition' : 'btn_heroes'), () => 'btn_expedition'],
    };
    return guides[chapterId]?.[idx]?.() ?? null;
  }

  // The Granary stands by the river: only the lowest riverside band of tiles.
  isRiverside(tile) { return tile[0] + tile[1] >= 22; }

  padsFor(type) {
    const pads = this.activePads();
    return type === 'granary' ? pads.filter((p) => this.isRiverside(p.tile)) : pads;
  }

  // Can the player act on this chapter task right now (card or tech
  // unlocked and affordable, hero trainable, stage within squad power)?
  taskGate(chapterId, idx) {
    const build = (type) => {
      const st = this.cardStatus(type);
      return { ready: !st.locked && !!st.affordable, missing: st.missing?.resource };
    };
    const tech = (id) => {
      const st = this.techStatus(id);
      return { ready: !!st.affordable, missing: st.missing?.resource };
    };
    const upgrade = () => ({
      ready: this.buildings.some((b) => { const st = this.upgradeStatus(b); return st.available && st.affordable; }),
    });
    const stage = (id) => {
      const s = CAMPAIGN_STAGES.find((x) => x.id === id);
      return { ready: !s || this.squadPower() >= (s.reqPower || s.enemyPower || 0) };
    };
    const gates = {
      chapter_2: [() => tech('tech_masonry'), () => build('stone_quarry'), () => tech('tech_stone_age')],
      chapter_3: [() => build('smelter'), upgrade, () => tech('tech_bronze_age')],
      chapter_4: [() => build('granary'), upgrade, () => tech('tech_irrigation')],
      chapter_5: [
        () => { const h = this.heroes.aurelius; const arena = this.buildings.some((b) => b.type === 'hero_arena' && b.status === 'done'); return { ready: !!h?.unlocked && arena && this.resources.food >= 10 * (h.level || 1) }; },
        () => stage('stage_6'),
        () => { const a = build('barracks'); const b = build('smelter'); return { ready: a.ready || b.ready, missing: a.missing }; },
      ],
      chapter_6: [() => tech('tech_bronze_age'), () => stage('stage_8'), () => ({ ready: true })],
    };
    return gates[chapterId]?.[idx]?.() || { ready: true };
  }

  taskActionable(chapterId, idx) { return this.taskGate(chapterId, idx).ready; }

  taskMissing(chapterId, idx) { return this.taskGate(chapterId, idx).missing; }

  buildGuide(type) {
    if (this.selectedCard !== type) return `card_${type}`;
    const pad = this.padsFor(type).find((p) => !this.buildingAt(p.id));
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
    // Chapter announcements come before the era achievement lines below:
    // once the Stone Age is reached, `achieved` stays true forever and
    // would otherwise shadow every chapter line from Chapter III on.
    // "Your valley now" (free_play) is the Chapter II send-off: it must not
    // sound while Chapter I is still open. Until the Woodcutter stands, the
    // Elder keeps naming that job; once the chapter is done, he points at Claim.
    // While any chapter is still running, the Elder names the next task on
    // the road; the "Your valley now" send-off waits until all chapters end.
    if (this.step_id === 'free_play' && this.quest && this.quest.id !== 'chapter_1') {
      const announce = CHAPTER_ANNOUNCE[this.quest.id];
      if (this.chapterOpenPending && announce) return announce.open;
      if (this.questClaimable) return 'Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it.';
      const nextIdx = this.quest.objectives.findIndex(([, fn]) => !fn(this));
      if (nextIdx >= 0 && announce?.tasks[nextIdx]) {
        // Like the Woodcutter: the announcement (bubble, voice and arrow)
        // arrives only when the task can actually be acted on. Before
        // that, the Elder sends the player gathering instead.
        if (!this.taskActionable(this.quest.id, nextIdx)) {
          const missing = this.taskMissing(this.quest.id, nextIdx);
          return missing
            ? `We need more ${RESOURCE_LABEL[missing]} before that, Chief. Gather first, then we build.`
            : 'Chief, we are not ready for that yet. Gather and grow first.';
        }
        return announce.tasks[nextIdx];
      }
      if (nextIdx >= 0) {
        const next = this.quest.objectives[nextIdx];
        return `Chief, ${next[0].charAt(0).toLowerCase()}${next[0].slice(1)}; that is the road ahead of us.`;
      }
    }
    if (this.step_id === 'free_play' && this.quest?.id === 'chapter_1') {
      if (!this.hasBuilt('woodcutter_hut')) {
        // The Woodcutter message, its voice and the guide arrow all arrive
        // together: only once the hut is unlocked and affordable. Before
        // that, the Elder sends the player gathering instead.
        const cs = this.cardStatus('woodcutter_hut');
        if (cs.locked) return 'That is still beyond us, Chief. Research will open the way, as it always has.';
        if (!cs.affordable) return `We need more ${RESOURCE_LABEL[cs.missing.resource]} before the Woodcutter, Chief. Gather first, then raise it.`;
        return HINT_TEXT.card_woodcutter_hut;
      }
      if (this.questClaimable) return 'Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it.';
    }
    // All chapters done: the valley send-off.
    if (this.step_id === 'free_play' && !this.quest) return ADVISOR_TEXT.free_play;
    // The era achievement lines (achieved/bronze) are not in the rotation:
    // they name fixed tasks (a Copper Smelter, heroes) forever, even after
    // those tasks are done. Chapter announcements own all guidance now.
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

  // Level-ups are training, not a button click: the hero walks to the Heroes'
  // Arena and trains for a while; the level lands when training completes.
  levelUpHero(heroId, reject) {
    const h = this.heroes[heroId];
    if (!h || !h.unlocked) return { result: 'noop' };
    if (h.level >= h.maxLevel) return { result: 'noop' };
    const arena = this.buildings.find((b) => b.type === 'hero_arena' && b.status === 'done');
    if (!arena) {
      return reject ? reject('requires_arena', { hero_id: h.id }) : { result: 'rejected' };
    }
    if (this.heroTraining) {
      return reject ? reject('training_busy', { hero_id: this.heroTraining.heroId }) : { result: 'rejected' };
    }
    const costFood = 10 * h.level;
    const costScrolls = 5 * h.level;
    if (this.resources.food < costFood) {
      return reject ? reject('insufficient_food', { food_available: Math.floor(this.resources.food), food_required: costFood }) : { result: 'rejected' };
    }
    this.resources.food -= costFood;
    if (this.resources.scrolls >= costScrolls) {
      this.resources.scrolls -= costScrolls;
    }
    const duration = this.config.hero_training_sec * (h.level + 1);
    this.heroTraining = { heroId: h.id, arenaKey: arena.key, completeAt: this.clock.t + duration, duration };
    this.emit('hero_training_started', { hero_id: h.id, duration_sec: Math.round(duration) });
    this.onFx({ type: 'sfx', sound: 'build' });
    this.onFx({ type: 'popup', tile: arena.tile, text: `${h.name} is training…`, color: '#ffe08a', lift: 96 });
    return { result: 'advanced' };
  }

  completeHeroTraining() {
    const tr = this.heroTraining;
    if (!tr) return;
    this.heroTraining = null;
    const h = this.heroes[tr.heroId];
    if (!h) return;
    h.level += 1;
    this.stats.hero_levelups = (this.stats.hero_levelups || 0) + 1;
    this.featureScore += 15;
    const stats = this.heroStats(tr.heroId);
    const arena = this.buildingAt(tr.arenaKey);
    this.emit('hero_leveled', { hero_id: h.id, level: h.level, squad_power: this.squadPower() });
    this.onFx({ type: 'sfx', sound: 'hero_levelup' });
    if (arena) this.onFx({ type: 'sparkle', tile: arena.tile, key: arena.key });
    this.onFx({ type: 'popup', tile: arena ? arena.tile : TOWN_CENTER_TILE,
      text: `${h.name} Lv.${h.level}! ⚔️ Power ${stats.power}`, color: '#ffd75e', lift: 110 });
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

    // Safety net: villagers gather fallen branches (1 wood / 2 s, up to 30) so the valley never
    // soft-locks on wood. Bots get it only after the tutorial, so the planted handoff friction
    // (Woodcutter built before Toolmaking) still shows up in playtests; humans get it from the start.
    const noWoodcutter = !this.buildings.some((b) => b.type === 'woodcutter_hut');
    const woodTrap = !this.techs.has('tech_toolmaking') && this.resources.wood < c.research_toolmaking_wood_cost;
    const human = this.meta.provider_mode === 'human';
    if (this.resources.wood < c.optional_woodcutter_cost
        && ((this.stepIndex >= STEPS.indexOf('free_play') && noWoodcutter) || (human && woodTrap))) {
      this.resources.wood = Math.min(c.optional_woodcutter_cost, this.resources.wood + dt / 2);
    }

    const tent = this.buildings.find((b) => b.type === 'research_tent');
    if (tent && (tent.worker || this.workersPerBuilding === 0)) this.resources.rp += (c.research_tent_rp_per_min * dt) / 60;

    // Unlock Sunweaver Lyra on clearing stage 2 / megalithic ruins OR researching toolmaking / stone age
    if (!this.heroes.lyra.unlocked) {
      if (this.encountersCleared.has('stage_2') || this.encountersCleared.has('encounter_megalithic_ruins')
          || this.techs.has('tech_toolmaking') || this.techs.has('tech_stone_age')) {
        this.heroes.lyra.unlocked = true;
        this.onFx({ type: 'popup', tile: TOWN_CENTER_TILE, text: '✨ Hero Unlocked: Sunweaver Lyra!', color: '#ffd75e', lift: 130 });
        this.onFx({ type: 'sfx', sound: 'unlock' });
      }
    }

    // Hero training at the Arena completes over time, not on the click.
    if (this.heroTraining && now >= this.heroTraining.completeAt) this.completeHeroTraining();

    // Turn-based battle (HoMM style): nothing moves on the clock. Units act
    // only on player clicks; the tick just expires the ult cut-in banner.
    if (this.battleState && this.battleState.active) {
      const bs = this.battleState;
      if (bs.cutIn && now >= bs.cutInUntil) {
        bs.cutIn = null;
      }
    }

    if (!this.replay) {
      while (now >= this.nextHeartbeat) {
        this.emit('heartbeat', { resources: this.roundedResources(), score: this.score, workers_free: this.workersFree });
        this.nextHeartbeat += HEARTBEAT_SEC;
      }
    }
    this.checkProgress();
    // Leftover onboarding hints die with Chapter I.
    if (this.step_id === 'free_play' && this.quest?.id !== 'chapter_1') this.hint = null;
    // A new chapter (II to VI) opens with its own Elder announcement, once.
    if (this.step_id === 'free_play' && this.quest && CHAPTER_ANNOUNCE[this.quest.id]
        && this.chapterOpenFor !== this.quest.id) {
      this.chapterOpenFor = this.quest.id;
      this.chapterOpenPending = true;
      this.chapterOpenAt = this.clock.t;
    }
    // The opening line hands over to the first task line after 15 seconds,
    // even if the player only waits: no advancing click is required.
    if (this.chapterOpenPending && this.clock.t - (this.chapterOpenAt || 0) >= 15) {
      this.chapterOpenPending = false;
    }
    // The Elder names the next job himself once the Woodcutter is actually
    // available to build (card unlocked and affordable): raise a Woodcutter.
    // Said once; the bubble stays until real progress.
    const woodcutterStatus = this.cardStatus('woodcutter_hut');
    if (!this.hint && this.step_id === 'free_play' && this.quest?.id === 'chapter_1'
        && !woodcutterStatus.locked && woodcutterStatus.affordable
        && !this.hasBuilt('woodcutter_hut')
        && !this.woodcutterAnnounced) {
      this.woodcutterAnnounced = true;
      this.hint = { target_id: 'card_woodcutter_hut' };
      this.emit('hint_shown', { target_id: 'card_woodcutter_hut' });
    }
    if (!this.hint && this.modal !== 'welcome' && ['onb_03_handoff'].includes(this.step_id)
        && this.techStatus('tech_toolmaking').affordable
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
    this.onFx({ type: 'sfx', sound: 'built' });
    this.onFx({ type: 'built', tile: b.tile, key: b.key });
    this.onFx({ type: 'popup', tile: b.tile, text: `${BUILDINGS[b.type].label} built!`, color: '#fff2b0', lift: 92 });
  }

  progress() {
    this.lastProgressT = this.clock.t;
    this.hint = null;
    this.chapterOpenPending = false;
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
      this.onFx({ type: 'sfx', sound: 'quest' });
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
    this.onFx({ type: 'sfx', sound: 'claim_reward' });
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
  startBattleArena(stageId, deployed = null) {
    const stage = CAMPAIGN_STAGES.find((s) => s.id === stageId || s.legacyId === stageId);
    if (!stage) return false;
    const squad = (deployed && deployed.length ? deployed : ['vaelen', ...(this.heroes.lyra.unlocked ? ['lyra'] : [])])
      .filter((id) => this.heroes[id]?.unlocked);
    if (!squad.length) return false;
    // Turn-based (HoMM style): stationary units, one action per hero per
    // round, then the enemy round. Nothing fights on its own.
    const units = squad.map((id, i) => {
      const st = this.heroStats(id);
      return { kind: 'hero', id, name: this.heroes[id].name, hp: st.hp, maxHp: st.hp, atk: st.atk,
               speed: this.heroes[id].speed || 5, ranged: ['lyra', 'ignis'].includes(id),
               defending: false, retaliated: false, activeTurn: false,
               gx: 1, gy: [2, 3, 5, 6][i] ?? 4, moveLeft: this.heroes[id].speed || 5,
               rage: id === 'vaelen' ? 40 : 25, acted: false, alive: true };
    });
    this.battleState = {
      active: true,
      outcome: null,
      stageId: stage.id,
      stage,
      deployed: squad,
      wave: 1,
      totalWaves: stage.waves,
      round: 1,
      turn: 'player',
      selectedUnit: null,
      units,
      enemies: [],
      log: [`${stage.name}: tap a glowing hex to move, then tap an enemy to attack.`],
      cutIn: null,
      cutInUntil: 0,
      popups: [],
      queue: [],
      activeRef: null,
    };
    this.spawnWave();
    this.syncBattleTotals(this.battleState);
    this.beginRound(this.battleState);
    return true;
  }

  // HoMM3 initiative: every living unit acts once per round, fastest first.
  buildInitiative(bs) {
    const refs = [
      ...bs.units.filter((u) => u.alive).map((u) => ({ kind: 'hero', id: u.id, speed: u.speed || 5 })),
      ...bs.enemies.filter((e) => e.alive).map((e) => ({ kind: 'enemy', idx: e.idx, speed: e.speed || 5 })),
    ];
    refs.sort((a, b) => b.speed - a.speed || (a.kind === 'hero' ? -1 : 1));
    return refs;
  }

  beginRound(bs) {
    // Defend lasts until the start of that unit's next activation, so it is
    // cleared in advanceBattle, not here. Drummer buffs add movement once.
    for (const u of [...bs.units, ...bs.enemies]) {
      u.acted = false; u.retaliated = false; u.waited = false;
      u.moveLeft = (u.speed || 5) + (u.buffMove || 0); u.buffMove = 0;
    }
    bs.queue = this.buildInitiative(bs);
    bs.turn = 'player';
    this.advanceBattle();
  }

  // Run the queue until a hero must act (player input) or the battle ends.
  advanceBattle() {
    const bs = this.battleState;
    if (!bs || !bs.active) return;
    for (;;) {
      if (this.checkBattleEnd()) return;
      while (bs.queue.length) {
        const ref = bs.queue[0];
        const unit = ref.kind === 'hero' ? bs.units.find((u) => u.id === ref.id) : bs.enemies[ref.idx];
        if (unit && unit.alive && !unit.acted) break;
        bs.queue.shift();
      }
      if (!bs.queue.length) {
        bs.round += 1;
        this.battleLog(bs, `Round ${bs.round}.`);
        this.beginRound(bs);
        return;
      }
      const ref = bs.queue[0];
      bs.activeRef = ref;
      for (const u of bs.units) u.activeTurn = ref.kind === 'hero' && u.id === ref.id;
      // A hero's Defend ends as their next activation begins; buffed attack
      // from a standard-bearer is spent on this activation either way.
      if (ref.kind === 'hero') {
        const hu = bs.units.find((u) => u.id === ref.id);
        if (hu) hu.defending = false;
      }
      if (ref.kind === 'enemy') {
        this.enemyAct(bs.enemies[ref.idx]);
        bs.queue.shift();
        continue;
      }
      bs.selectedUnit = ref.id;
      this.syncBattleTotals(bs);
      return;
    }
  }

  // ------------------------------------------------------------ hex movement
  battleBlocked(gx, gy, except = null) {
    const bs = this.battleState;
    if (gx < 0 || gy < 0 || gx >= BATTLE_COLS || gy >= BATTLE_ROWS) return true;
    if (BATTLE_BLOCKED.some(([x, y]) => x === gx && y === gy)) return true;
    return [...bs.units, ...bs.enemies].some((u) => u !== except && u.alive && u.gx === gx && u.gy === gy);
  }

  // Shortest hex path from a unit to any tile matching isGoal, as a list of
  // steps (excluding the start tile). Null when unreachable.
  battlePath(unit, isGoal) {
    const seen = new Map([[`${unit.gx},${unit.gy}`, null]]);
    const queue = [[unit.gx, unit.gy]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if ((x !== unit.gx || y !== unit.gy) && isGoal(x, y)) {
        const path = [];
        let cur = [x, y];
        while (cur) { path.unshift(cur); cur = seen.get(cur.join(',')); }
        return path.slice(1).map(([gx, gy]) => ({ gx, gy }));
      }
      for (const [nx, ny] of hexNeighbors(x, y)) {
        const k = `${nx},${ny}`;
        if (seen.has(k) || this.battleBlocked(nx, ny, unit)) continue;
        seen.set(k, [x, y]);
        queue.push([nx, ny]);
      }
    }
    return null;
  }

  battleReachableTiles() {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero') return [];
    const hero = bs.units.find((u) => u.id === bs.activeRef.id && u.alive && !u.acted);
    if (!hero || !hero.moveLeft) return [];
    const out = [];
    for (let gx = 0; gx < BATTLE_COLS; gx++) {
      for (let gy = 0; gy < BATTLE_ROWS; gy++) {
        if (gx === hero.gx && gy === hero.gy) continue;
        const path = this.battlePath(hero, (x, y) => x === gx && y === gy);
        if (path && path.length <= hero.moveLeft) out.push({ gx, gy, cost: path.length });
      }
    }
    return out;
  }

  heroMove(gx, gy) {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero') return false;
    const hero = bs.units.find((u) => u.id === bs.activeRef.id && u.alive && !u.acted);
    if (!hero) return false;
    const tile = this.battleReachableTiles().find((t) => t.gx === gx && t.gy === gy);
    if (!tile) return false;
    bs.preview = null;
    hero.gx = gx; hero.gy = gy;
    hero.moveLeft -= tile.cost;
    this.syncBattleTotals(bs);
    return true;
  }

  // Move a unit along the shortest path toward a goal, up to its movement.
  moveToward(unit, isGoal) {
    const path = this.battlePath(unit, isGoal);
    if (!path) return 0;
    const steps = Math.min(unit.moveLeft || 0, path.length);
    if (steps > 0) { unit.gx = path[steps - 1].gx; unit.gy = path[steps - 1].gy; unit.moveLeft -= steps; }
    return steps;
  }

  enemyAct(e) {
    const bs = this.battleState;
    if (!e || !e.alive) return;
    e.acted = true;
    const heroes = bs.units.filter((u) => u.alive);
    if (!heroes.length) return;
    const allies = bs.enemies.filter((x) => x.alive && x !== e);
    const strike = (target, mult = 1) => {
      let dmg = Math.round(e.atk * mult * (0.85 + Math.random() * 0.3));
      if (e.buffAtk) { dmg = Math.round(dmg * 1.15); e.buffAtk = 0; }
      if (target.defending) dmg = Math.max(1, Math.round(dmg * 0.7));
      target.hp = Math.max(0, target.hp - dmg);
      target.alive = target.hp > 0;
      target.rage = Math.min(100, (target.rage || 0) + 15);
      this.battleLog(bs, `${e.name} hits ${target.name.split(' ')[0]} for ${dmg}${target.defending ? ' (defended)' : ''}.`);
      this.onFx({ type: 'sfx', sound: 'roar' });
      // A hero retaliates once per round, only against an adjacent melee hit.
      if (target.alive && hexDistance(e, target) <= 1 && !target.retaliated) {
        target.retaliated = true;
        const rd = Math.max(1, Math.round(target.atk * 0.5));
        e.hp = Math.max(0, e.hp - rd);
        e.alive = e.hp > 0;
        this.battleLog(bs, `${target.name.split(' ')[0]} retaliates for ${rd}.`);
      }
    };
    // Healer: bounded heals (2 per battle, 20% max HP, no revival), then a
    // weak strike. Cooldown counts its own completed activations.
    if (e.role === 'healer') {
      if (e.supportCd > 0) e.supportCd -= 1;
      const hurt = allies.filter((a) => a.hp < a.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
      if (hurt && e.healsLeft > 0 && e.supportCd <= 0) {
        if (hexDistance(e, hurt) > 3) this.moveToward(e, (x, y) => hexDistance({ gx: x, gy: y }, hurt) <= 3);
        if (hexDistance(e, hurt) <= 3) {
          const heal = Math.round(hurt.maxHp * 0.2);
          hurt.hp = Math.min(hurt.maxHp, hurt.hp + heal);
          e.healsLeft -= 1; e.supportCd = 2;
          this.battleLog(bs, `${e.name} heals ${hurt.name} for ${heal}.`);
          return;
        }
      }
    }
    // Support: drummer grants +1 movement, standard +15% damage, to allies
    // within 2 hexes on their next activation. Never stacks, 2-activation gap.
    if (e.role === 'support') {
      if (e.supportCd > 0) e.supportCd -= 1;
      if (e.supportCd <= 0 && allies.length) {
        const anchor = allies[0];
        if (hexDistance(e, anchor) > 2) this.moveToward(e, (x, y) => hexDistance({ gx: x, gy: y }, anchor) <= 2);
        const near = bs.enemies.filter((x) => x.alive && hexDistance(e, x) <= 2);
        if (near.length > 1) {
          for (const a of near) {
            if (a === e) continue;
            if (e.name.includes('Drum')) a.buffMove = 1; else a.buffAtk = 1;
          }
          e.supportCd = 2;
          this.battleLog(bs, e.name.includes('Drum') ? `${e.name} beats the rally drum: allies move faster.` : `${e.name} raises the standard: allies strike harder.`);
          return;
        }
      }
    }
    // Ranged: shoot from anywhere while unengaged (rock cover applies);
    // engaged shooters step clear first, else strike weakly.
    if (e.ranged) {
      const engaged = heroes.some((u) => hexDistance(e, u) === 1);
      if (engaged) {
        this.moveToward(e, (x, y) => heroes.every((u) => hexDistance({ gx: x, gy: y }, u) >= 2));
      }
      if (!heroes.some((u) => hexDistance(e, u) === 1)) {
        const target = heroes.reduce((best, u) => (u.hp < best.hp ? u : best), heroes[0]);
        if (shotHasCover(e, target)) {
          let dmg = Math.max(1, Math.round(e.atk * 0.75 * (0.85 + Math.random() * 0.3)));
          if (target.defending) dmg = Math.max(1, Math.round(dmg * 0.7));
          target.hp = Math.max(0, target.hp - dmg);
          target.alive = target.hp > 0;
          target.rage = Math.min(100, (target.rage || 0) + 15);
          this.battleLog(bs, `${e.name} shoots ${target.name.split(' ')[0]} for ${dmg} (through cover).`);
          this.onFx({ type: 'sfx', sound: 'roar' });
        } else strike(target);
        return;
      }
      const adj = heroes.find((u) => hexDistance(e, u) === 1);
      if (adj) { strike(adj, 0.5); return; }
    }
    // Melee roles: skirmishers hunt ranged or wounded heroes, tanks and
    // others take the nearest. Same movement and action rules as heroes.
    const target = e.role === 'skirmisher'
      ? (heroes.filter((u) => u.ranged).sort((a, b) => a.hp - b.hp)[0]
        || heroes.reduce((best, u) => (u.hp < best.hp ? u : best), heroes[0]))
      : heroes.reduce((best, u) => (hexDistance(e, u) < hexDistance(e, best) ? u : best), heroes[0]);
    if (hexDistance(e, target) > 1) {
      this.moveToward(e, (x, y) => hexDistance({ gx: x, gy: y }, target) === 1);
      if (hexDistance(e, target) > 1) {
        this.battleLog(bs, `${e.name} advances.`);
        return;
      }
    }
    strike(target);
  }

  spawnWave() {
    const bs = this.battleState;
    const total = Math.round(bs.stage.enemyPower * 1.2);
    const finalWave = bs.wave === bs.totalWaves && bs.totalWaves > 1;
    const count = finalWave ? 3 : 2;
    const hp = Math.max(20, Math.round(total / count));
    const baseAtk = Math.max(6, Math.round(bs.stage.enemyPower * 0.045));
    // Draw without replacement from the stage's tier band (stage N sees
    // tiers N-1..N+1): at most one support and one healer per wave.
    const stageN = Number((bs.stageId || 'stage_1').split('_')[1]) || 1;
    const band = ENEMY_ROSTER.filter((e) => e.tier >= Math.max(1, stageN - 1) && e.tier <= Math.min(8, stageN + 1));
    const pool = [...band].sort(() => Math.random() - 0.5);
    const picked = [];
    for (const e of pool) {
      if (picked.length >= (finalWave && ENEMY_BOSSES[bs.stageId] ? count - 1 : count)) break;
      if ((e.role === 'support' || e.role === 'healer')
          && picked.some((p) => p.role === 'support' || p.role === 'healer')) continue;
      picked.push(e);
    }
    while (picked.length < (finalWave && ENEMY_BOSSES[bs.stageId] ? count - 1 : count)) picked.push(band[picked.length % band.length]);
    const roleAtk = { tank: 0.8, healer: 0.6, support: 0.6, ranged: 0.9, skirmisher: 0.95, melee: 1 };
    const mk = (entry, i, boss = false) => ({
      kind: 'enemy', idx: i, name: entry.name, role: entry.role, sprite: entry.sprite,
      ranged: entry.role === 'ranged',
      hp: boss ? Math.round(hp * 1.8) : hp, maxHp: boss ? Math.round(hp * 1.8) : hp,
      atk: Math.max(4, Math.round(baseAtk * (roleAtk[entry.role] ?? 1) * (boss ? 1.3 : 1))),
      gx: BATTLE_COLS - 2, gy: [2, 4, 6][i] ?? 4,
      moveLeft: entry.speed, speed: entry.speed,
      acted: false, retaliated: false, alive: true,
      healsLeft: entry.role === 'healer' ? 2 : 0, supportCd: 0, buffMove: 0, buffAtk: 0,
    });
    bs.enemies = picked.map((e, i) => mk(e, i));
    if (finalWave && ENEMY_BOSSES[bs.stageId]) bs.enemies.unshift(mk(ENEMY_BOSSES[bs.stageId], 0, true));
    bs.enemies.forEach((e, i) => { e.idx = i; e.gy = [2, 4, 6][i] ?? 4; });
  }

  syncBattleTotals(bs) {
    bs.playerHp = bs.units.reduce((n, u) => n + Math.max(0, u.hp), 0);
    bs.playerMaxHp = bs.units.reduce((n, u) => n + u.maxHp, 0);
    bs.enemyHp = bs.enemies.reduce((n, u) => n + Math.max(0, u.hp), 0);
    bs.enemyMaxHp = bs.enemies.reduce((n, u) => n + u.maxHp, 0);
    const v = bs.units.find((u) => u.id === 'vaelen');
    const l = bs.units.find((u) => u.id === 'lyra');
    bs.vaelenRage = v ? v.rage : 0;
    bs.lyraRage = l ? l.rage : 0;
  }

  battleLog(bs, text) {
    bs.log.push(text);
    if (bs.log.length > 6) bs.log.shift();
  }

  // What an attack would do, before it is committed: the inspection strip
  // shows this on the first tap; the second tap confirms the same numbers.
  battlePreview(heroId, enemyIdx) {
    const bs = this.battleState;
    if (!bs || !bs.active) return null;
    const hero = bs.units.find((u) => u.id === heroId && u.alive && !u.acted);
    const enemy = bs.enemies[enemyIdx];
    if (!hero || !enemy || !enemy.alive) return null;
    const first = hero.name.split(' ')[0];
    const engaged = bs.enemies.some((e) => e.alive && hexDistance(hero, e) === 1);
    if (hero.ranged && engaged && hexDistance(hero, enemy) > 1) {
      return { ok: false, text: `${first} is engaged and cannot shoot. Move clear, or strike the adjacent foe at half damage.` };
    }
    let moveCost = 0;
    if (!hero.ranged || (hero.ranged && engaged)) {
      if (hexDistance(hero, enemy) > 1) {
        const path = this.battlePath(hero, (x, y) => hexDistance({ gx: x, gy: y }, enemy) === 1);
        if (!path || path.length > hero.moveLeft) {
          return { ok: false, text: `Cannot reach ${enemy.name} this turn. Move first; no movement was spent.` };
        }
        moveCost = path.length;
      }
    }
    const weakMelee = hero.ranged && engaged;
    const cover = hero.ranged && !weakMelee && shotHasCover(hero, enemy);
    let dmg = Math.round(hero.atk * (weakMelee ? 0.5 : 1) * (cover ? 0.75 : 1));
    const luckOn = bs.stageId !== 'stage_1';
    const kills = dmg >= enemy.hp;
    const retal = !kills && !enemy.retaliated && (!hero.ranged || weakMelee)
      ? Math.max(1, Math.round(enemy.atk * 0.5)) : 0;
    return {
      ok: true, moveCost, dmg, cover, weakMelee,
      text: `${first} → ${enemy.name}: ${dmg} damage${cover ? ' (rock cover)' : ''}${weakMelee ? ' (weak strike)' : ''}`
        + `, ${enemy.name} at ${Math.max(0, enemy.hp - dmg)}/${enemy.maxHp} HP`
        + (retal ? `; retaliation ${retal}` : '; no retaliation')
        + (luckOn ? '; 12% chance of double damage' : '')
        + (moveCost ? `; move ${moveCost} then attack` : '')
        + '. Tap the enemy again to confirm.',
    };
  }

  heroAttack(heroId, enemyIdx) {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero' || bs.activeRef.id !== heroId) return false;
    const hero = bs.units.find((u) => u.id === heroId && u.alive && !u.acted);
    const enemy = bs.enemies[enemyIdx];
    if (!hero || !enemy || !enemy.alive) return false;
    const preview = this.battlePreview(heroId, enemyIdx);
    if (!preview?.ok) {
      // Never commit a partial approach from an attack tap: explain instead.
      if (preview) this.battleLog(bs, preview.text);
      return false;
    }
    if (preview.moveCost) {
      this.moveToward(hero, (x, y) => hexDistance({ gx: x, gy: y }, enemy) === 1);
    }
    const engaged = bs.enemies.some((e) => e.alive && hexDistance(hero, e) === 1);
    const weakMelee = hero.ranged && engaged && hexDistance(hero, enemy) <= 1;
    const cover = hero.ranged && !weakMelee && shotHasCover(hero, enemy);
    // Luck: 12% double damage, but never in the introductory fight.
    const lucky = bs.stageId !== 'stage_1' && Math.random() < 0.12;
    let dmg = Math.round(hero.atk * (0.9 + Math.random() * 0.2) * (weakMelee ? 0.5 : 1) * (cover ? 0.75 : 1));
    if (lucky) dmg *= 2;
    dmg = Math.max(1, dmg);
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.alive = enemy.hp > 0;
    hero.acted = true;
    hero.rage = Math.min(100, hero.rage + 25);
    bs.selectedUnit = null;
    bs.preview = null;
    this.battleLog(bs, `${hero.name.split(' ')[0]} hits ${enemy.name} for ${dmg}${lucky ? ' (Luck!)' : ''}${cover ? ' (through cover)' : ''}.`);
    this.onFx({ type: 'sfx', sound: 'hit' });
    if (hero.rage >= 100) this.onFx({ type: 'sfx', sound: 'ult_ready' });
    // Melee targets retaliate once per round; shots never provoke it.
    if (enemy.alive && (!hero.ranged || weakMelee) && !enemy.retaliated) {
      enemy.retaliated = true;
      let rd = Math.max(1, Math.round(enemy.atk * 0.5));
      if (hero.defending) rd = Math.max(1, Math.round(rd * 0.7));
      hero.hp = Math.max(0, hero.hp - rd);
      hero.alive = hero.hp > 0;
      this.battleLog(bs, `${enemy.name} retaliates for ${rd}.`);
    }
    bs.queue.shift();
    this.afterBattleAction();
    return true;
  }

  // HoMM3 Wait: act after everyone else this round. Defend: skip the
  // action, take 30% less damage until the next round.
  battleWait() {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero') return false;
    const active = bs.units.find((u) => u.id === bs.activeRef.id);
    // Wait is once per activation, and only before any movement.
    if (!active || active.waited) { this.battleLog(bs, 'Already waited this round.'); return false; }
    if (active.moveLeft < (active.speed || 5)) { this.battleLog(bs, 'Cannot wait after moving.'); return false; }
    active.waited = true;
    const ref = bs.queue.shift();
    bs.queue.push(ref);
    const hero = bs.units.find((u) => u.id === ref.id);
    this.battleLog(bs, `${hero?.name.split(' ')[0]} waits.`);
    this.advanceBattle();
    return true;
  }

  battleDefend() {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero') return false;
    const hero = bs.units.find((u) => u.id === bs.activeRef.id && u.alive && !u.acted);
    if (!hero) return false;
    hero.defending = true;
    hero.acted = true;
    bs.selectedUnit = null;
    this.battleLog(bs, `${hero.name.split(' ')[0]} defends.`);
    bs.queue.shift();
    this.afterBattleAction();
    return true;
  }

  // End Turn: the hero's activation simply ends, no Defend bonus, and the
  // initiative queue moves on to the next unit (often an enemy).
  endPlayerTurn() {
    const bs = this.battleState;
    if (!bs || !bs.active || bs.activeRef?.kind !== 'hero') return false;
    const hero = bs.units.find((u) => u.id === bs.activeRef.id && u.alive && !u.acted);
    if (!hero) return false;
    hero.acted = true;
    bs.selectedUnit = null;
    bs.preview = null;
    this.battleLog(bs, `${hero.name.split(' ')[0]} ends the turn.`);
    bs.queue.shift();
    this.afterBattleAction();
    return true;
  }

  // Between waves the battle pauses on a Continue tap: heroes keep their
  // health and charge, Defend and buffs end, formation resets.
  battleContinueWave() {
    const bs = this.battleState;
    if (!bs || !bs.active || !bs.awaitingWave) return false;
    bs.awaitingWave = false;
    bs.wave += 1;
    for (const [i, u] of bs.units.entries()) {
      u.defending = false; u.buffAtk = 0;
      if (u.alive) { u.gx = 1; u.gy = [2, 3, 5, 6][i] ?? 4; }
    }
    this.spawnWave();
    this.syncBattleTotals(bs);
    this.battleLog(bs, `Wave ${bs.wave}/${bs.totalWaves} arrives!`);
    this.beginRound(bs);
    return true;
  }

  // True when the battle just ended or a new wave arrived.
  checkBattleEnd() {
    const bs = this.battleState;
    if (!bs) return true;
    if (bs.awaitingWave) return true;
    this.syncBattleTotals(bs);
    if (bs.units.every((u) => !u.alive)) {
      bs.active = false;
      bs.outcome = 'defeat';
      this.emit('battle_lost', {
        stage_id: bs.stageId, enemy: bs.stage.name,
        squad_power: this.squadPower(), required_power: bs.stage.reqPower || bs.stage.enemyPower,
      });
      this.onFx({ type: 'sfx', sound: 'reject' });
      return true;
    }
    if (bs.enemies.every((e) => !e.alive)) {
      if (bs.wave < bs.totalWaves) {
        bs.awaitingWave = true;
        bs.queue = [];
        this.syncBattleTotals(bs);
        this.battleLog(bs, `Wave ${bs.wave} cleared. The next wave approaches: tap Continue.`);
        return true;
      }
      bs.active = false;
      bs.outcome = 'victory';
      // HoH stars: 3 for a clean win, fewer when the squad limps home.
      const hpPct = bs.playerHp / (bs.playerMaxHp || 1);
      bs.stars = hpPct >= 0.7 ? 3 : hpPct >= 0.35 ? 2 : 1;
      this.stageStars[bs.stageId] = Math.max(this.stageStars[bs.stageId] || 0, bs.stars);
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
      // Later stages award the rest of the tribe, HoH style.
      if (bs.stageId === 'stage_4') this.heroes.ignis.unlocked = true;
      if (bs.stageId === 'stage_6') this.heroes.aurelius.unlocked = true;
      this.emit('battle_won', { stage_id: bs.stageId, reward: bs.stage.reward });
      this.onFx({ type: 'sfx', sound: 'unlock' });
      return true;
    }
    return false;
  }

  afterBattleAction() {
    if (!this.checkBattleEnd()) this.advanceBattle();
  }

  triggerUltimate(heroId) {
    if (!this.battleState || !this.battleState.active) return false;
    const bs = this.battleState;
    const hero = bs.units.find((u) => u.id === heroId && u.alive);
    // The card only fires at full rage, on that hero's own turn; early taps
    // do nothing. Using the ultimate is the hero's action for this round.
    if (!hero || hero.rage < 100 || hero.acted) return false;
    if (bs.activeRef?.kind !== 'hero' || bs.activeRef.id !== heroId) return false;
    // Melee ultimates need an adjacent foe; never spend charge on thin air.
    if ((heroId === 'vaelen' || heroId === 'aurelius')
        && !bs.enemies.some((e) => e.alive && hexDistance(hero, e) <= 1)) {
      this.battleLog(bs, `${hero.name.split(' ')[0]}'s ultimate needs an adjacent foe.`);
      return false;
    }
    hero.rage = 0;
    hero.acted = true;
    bs.queue.shift();
    bs.selectedUnit = null;
    if (heroId === 'lyra') {
      bs.cutIn = { heroId: 'lyra', name: 'Sunweaver Lyra', ult: 'SOLAR SALVE!', portrait: 'portrait_lyra' };
      bs.cutInUntil = this.clock.t + 0.9;
      for (const u of bs.units) if (u.alive) u.hp = Math.min(u.maxHp, u.hp + Math.round(u.maxHp * 0.45));
      this.battleLog(bs, 'Lyra heals the squad.');
      this.onFx({ type: 'sfx', sound: 'hero_heal' });
    } else {
      const names = { vaelen: ['Bera the Shield-Hunter', 'EARTHSHATTER STOMP!'], ignis: ['Ember-Keeper Ignis', 'EMBER STORM!'], aurelius: ['Tor the Stone-Breaker', 'MOUNTAIN SMASH!'] };
      const [name, ult] = names[heroId] || ['Hero', 'ULTIMATE!'];
      bs.cutIn = { heroId, name, ult, portrait: `portrait_${heroId}` };
      bs.cutInUntil = this.clock.t + 0.9;
      // Ultimates are local, never global: Bera stomps adjacent foes, Tor
      // smashes one adjacent foe hard, Ignis burns a foe and its neighbours.
      const dmg = Math.round(hero.atk * 2.2);
      let targets = bs.enemies.filter((e) => e.alive && hexDistance(hero, e) <= 1);
      if (heroId === 'ignis') {
        const first = bs.enemies.filter((e) => e.alive)
          .sort((a, b) => hexDistance(hero, a) - hexDistance(hero, b))[0];
        targets = first ? bs.enemies.filter((e) => e.alive && hexDistance(first, e) <= 1) : [];
      } else if (heroId === 'aurelius') {
        targets = targets.sort((a, b) => b.hp - a.hp).slice(0, 1);
      }
      if (!targets.length && heroId !== 'vaelen' && heroId !== 'aurelius') {
        targets = bs.enemies.filter((e) => e.alive).slice(0, 1);
      }
      for (const e of targets) {
        e.hp = Math.max(0, e.hp - dmg);
        e.alive = e.hp > 0;
      }
      this.battleLog(bs, `${name.split(' ')[0]} unleashes ${ult}`);
      this.onFx({ type: 'sfx', sound: 'hero_ult' });
    }
    this.afterBattleAction();
    return true;
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
    // The building drawer is transient: any tap that is not on a building
    // (including its own worker/upgrade buttons) closes it.
    if (this.selectedBuilding && !target_id.startsWith('building_')) this.selectedBuilding = null;

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
      // A stage tap opens the pre-battle screen (deployment + rewards);
      // the fight itself is the live arena, never an instant resolve.
      const stage = CAMPAIGN_STAGES.find((s) => s.id === target_id || s.legacyId === target_id);
      if (!stage || this.encountersCleared.has(stage.id)) return { result: 'noop' };
      this.preBattle = {
        stageId: stage.id,
        // Tor leads every deployment: first in the list, deployed by default.
        deployed: ['aurelius', 'vaelen', ...(this.heroes.lyra.unlocked ? ['lyra'] : [])]
          .filter((id) => this.heroes[id]?.unlocked).slice(0, stage.slots || 1),
      };
      this.modal = 'prebattle';
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_prebattle') {
      if (this.modal !== 'prebattle') return { result: 'noop' };
      this.preBattle = null;
      this.modal = 'expedition';
      return { result: 'ui' };
    }
    if (target_id.startsWith('btn_deploy_')) {
      const heroId = target_id.slice('btn_deploy_'.length);
      if (this.modal !== 'prebattle' || !this.preBattle || !this.heroes[heroId]?.unlocked) return { result: 'noop' };
      const stage = CAMPAIGN_STAGES.find((s) => s.id === this.preBattle.stageId);
      const i = this.preBattle.deployed.indexOf(heroId);
      if (i >= 0) this.preBattle.deployed.splice(i, 1);
      else if (this.preBattle.deployed.length < (stage?.slots || 1)) this.preBattle.deployed.push(heroId);
      else return reject('deployment_full', { stage: stage?.id, slots: stage?.slots || 1 });
      return { result: 'ui' };
    }
    if (target_id === 'btn_fight') {
      if (this.modal !== 'prebattle' || !this.preBattle) return { result: 'noop' };
      const stage = CAMPAIGN_STAGES.find((s) => s.id === this.preBattle.stageId);
      if (!stage || !this.preBattle.deployed.length) return { result: 'noop' };
      const costs = this.expeditionCosts();
      const missing = this.missing(costs);
      if (missing) {
        return reject(`insufficient_${missing.resource}`, { encounter: stage.id,
          [`${missing.resource}_available`]: missing.available, [`${missing.resource}_required`]: missing.required });
      }
      this.pay(costs, TOWN_CENTER_TILE);
      const deployed = [...this.preBattle.deployed];
      this.preBattle = null;
      this.modal = null;
      this.startBattleArena(stage.id, deployed);
      return { result: 'advanced' };
    }
    if (target_id.startsWith('btn_arena_')) {
      const stageId = target_id.slice(10);
      this.modal = null;
      this.startBattleArena(stageId);
      return { result: 'ui' };
    }

    // Turn-based battle controls: select a hero, tap an enemy to attack.
    if (target_id.startsWith('unit_hero_')) {
      const bs = this.battleState;
      const id = target_id.slice('unit_hero_'.length);
      if (!bs || !bs.active) return { result: 'noop' };
      // Only the unit whose initiative turn it is can act, but the player
      // may switch to any other ready hero: the first hero keeps whatever
      // movement it had left and can be picked again later this round.
      if (bs.activeRef?.kind !== 'hero') return { result: 'noop' };
      if (bs.activeRef.id !== id) {
        const hero = bs.units.find((u) => u.id === id);
        const qi = bs.queue.findIndex((r) => r.kind === 'hero' && r.id === id);
        if (!hero?.alive || hero.acted || hero.waited || qi <= 0) return { result: 'noop' };
        const [ref] = bs.queue.splice(qi, 1);
        bs.queue.unshift(ref);
        bs.activeRef = ref;
        bs.preview = null;
        for (const u of bs.units) u.activeTurn = u.id === id;
      }
      bs.selectedUnit = id;
      // No ult cards on screen: tapping the active hero at full charge fires it.
      const hero = bs.units.find((u) => u.id === id);
      if (hero && (hero.rage || 0) >= 100 && this.triggerUltimate(id)) return { result: 'advanced' };
      return { result: 'ui' };
    }
    if (target_id === 'btn_battle_wait') {
      return this.battleWait() ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_battle_defend') {
      return this.battleDefend() ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id.startsWith('unit_enemy_')) {
      const bs = this.battleState;
      if (!bs || !bs.active || !bs.selectedUnit) return { result: 'noop' };
      const idx = Number(target_id.slice('unit_enemy_'.length));
      // First tap previews the complete legal attack; second tap confirms.
      if (!bs.preview || bs.preview.enemyIdx !== idx || bs.preview.heroId !== bs.selectedUnit) {
        bs.preview = { enemyIdx: idx, heroId: bs.selectedUnit, ...(this.battlePreview(bs.selectedUnit, idx) || { ok: false, text: 'No attack possible.' }) };
        this.battleLog(bs, bs.preview.text);
        return { result: 'ui' };
      }
      bs.preview = null;
      return this.heroAttack(bs.selectedUnit, idx) ? { result: 'advanced' } : { result: 'noop' };
    }
    if (target_id.startsWith('battle_hex_')) {
      const [, , gx, gy] = target_id.split('_');
      return this.heroMove(Number(gx), Number(gy)) ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_end_turn') {
      return this.endPlayerTurn() ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_ult_vaelen') {
      return this.triggerUltimate('vaelen') ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_ult_lyra') {
      return this.triggerUltimate('lyra') ? { result: 'ui' } : { result: 'noop' };
    }
    if (target_id === 'btn_close_battle') {
      // Retreat needs a confirming second tap: no reward, back to Campaign.
      if (!this.battleState) return { result: 'noop' };
      if (!this.battleState.retreatConfirm) {
        this.battleState.retreatConfirm = true;
        this.battleLog(this.battleState, 'Retreat? Tap the close button again to leave with no reward.');
        return { result: 'ui' };
      }
      this.battleState = null;
      this.modal = 'expedition';
      return { result: 'ui' };
    }
    if (target_id === 'btn_battle_wave_continue') {
      return this.battleContinueWave() ? { result: 'advanced' } : { result: 'noop' };
    }
    if (target_id === 'btn_battle_continue' || target_id === 'btn_victory_continue') {
      this.battleState = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_defeat_formation') {
      // Back to the pre-battle screen for the same stage, squad kept.
      const bs = this.battleState;
      if (!bs) return { result: 'noop' };
      const stage = bs.stage;
      this.preBattle = { stageId: stage.id, deployed: [...(bs.deployed || ['vaelen'])].slice(0, stage.slots || 1) };
      this.battleState = null;
      this.modal = 'prebattle';
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
      // First open shows Tor the Stone-Breaker.
      if (!this.heroesOpened) { this.heroesOpened = true; this.selectedHero = 'aurelius'; }
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

    // Building upgrades menu
    if (target_id === 'btn_upgrades') {
      this.modal = 'upgrades';
      this.selectedCard = null;
      return { result: 'ui' };
    }
    if (target_id === 'btn_close_upgrades') {
      if (this.modal !== 'upgrades') return { result: 'noop' };
      this.modal = null;
      return { result: 'ui' };
    }

    // Modal blocking map (the upgrades menu may use its own upgrade buttons)
    if (this.modal && !(this.modal === 'upgrades' && target_id.startsWith('upgrade_'))
        && MAP_PREFIXES.some((p) => target_id.startsWith(p))) {
      return reject('modal_blocking_map', { modal: this.modal });
    }
    if (this.modal && !(this.modal === 'upgrades' && target_id.startsWith('upgrade_'))) return { result: 'noop' };

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
      this.pendingPlacement = null;
      return { result: 'ui' };
    }

    // Placement widget (HoH style): the tile tap only previews a ghost.
    // Nothing is paid or built until the green check is tapped.
    if (target_id === 'btn_confirm_placement') {
      if (!this.pendingPlacement) return { result: 'noop' };
      const pad = this.padsFor(this.pendingPlacement.type).find((p) => p.id === this.pendingPlacement.padId);
      if (!pad || this.buildingAt(pad.id)) { this.pendingPlacement = null; return { result: 'noop' }; }
      return this.place(this.pendingPlacement.type, pad, reject);
    }
    if (target_id === 'btn_cancel_placement') {
      this.pendingPlacement = null;
      return { result: 'ui' };
    }
    if (target_id.startsWith('pad_') || target_id.startsWith('tile_')) {
      const pad = this.padsFor(this.selectedCard).find((p) => p.id === target_id);
      if (!pad || this.buildingAt(pad.id) || !this.selectedCard) return { result: 'noop' };
      this.pendingPlacement = { type: this.selectedCard, padId: pad.id, tile: pad.tile };
      return { result: 'ui' };
    }

    // Building Harvest / Click
    if (target_id.startsWith('building_')) {
      const b = this.buildings.find((x) => `building_${x.key}` === target_id);
      if (!b) return { result: 'noop' };
      // Still under construction: no harvest and no instant finish from clicking
      // the building itself (the ⚡ FREE chip is the only instant finish). It
      // starts producing only after construction completes, plus a full cycle.
      // Any other tap opens the building drawer (HoH production inspector).
      if (b.status === 'building') { this.selectedBuilding = b.key; return { result: 'ui' }; }
      if (!b.ready) { this.selectedBuilding = b.key; return { result: 'ui' }; }
      // Ready: the tap only collects. No drawer, nothing stays on screen.
      this.selectedBuilding = null;
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
    if (target_id === 'btn_close_drawer') {
      this.selectedBuilding = null;
      return { result: 'ui' };
    }
    if (target_id === 'empty' && this.selectedCard) {
      return reject('outside_building_field', {});
    }
    if (target_id === 'btn_deselect' && this.selectedCard) {
      this.selectedCard = null;
      this.pendingPlacement = null;
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
      // A producer starts staffed only when a worker is actually free; otherwise
      // it waits unstaffed until the player taps its worker sign.
      worker: spec.produces && this.workersFree >= this.workersPerBuilding ? this.workersPerBuilding : 0,
      produces: spec.produces || null,
      cycleStart: 0, ready: false, blockedReason: null, level: 1,
    });
    this.selectedCard = null;
    this.pendingPlacement = null;
    this.onFx({ type: 'dust', tile: pad.tile });
    // Every building type has its own placement sound (build_<type>).
    this.onFx({ type: 'sfx', sound: `build_${type}` });
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
    this.onFx({ type: 'sfx', sound: 'upgrade' });
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
    // Each resource has its own collect sound (harvest_food/wood/stone/coins).
    this.onFx({ type: 'sfx', sound: `harvest_${spec.produces}` });
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
      pending_placement: this.pendingPlacement
        ? { type: this.pendingPlacement.type, pad_id: this.pendingPlacement.padId } : null,
      selected_building: this.selectedBuilding,
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
      hero_training: this.heroTraining
        ? { hero_id: this.heroTraining.heroId, remaining_sec: Math.max(0, Math.round(this.heroTraining.completeAt - this.clock.t)) }
        : null,
      buildings: this.buildings.filter((b) => b.key.startsWith('pad_') || b.key.startsWith('tile_'))
        .map((b) => ({ key: b.key, type: b.type, level: b.level || 1, worker: b.worker, status: b.status,
                       blocked_reason: b.blockedReason || null })),
      sim_elapsed_sec: round3(this.clock.t),
    };
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
