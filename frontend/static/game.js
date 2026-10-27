// Game rules and state: onboarding state machine, economy, workers, buildings,
// tech tree and the first achievement. All timers are absolute simulated times,
// so the state is a pure function of (config, actions, action times). The
// replay view relies on that to re-simulate recorded runs.

import { SimClock } from './clock.js';
import { PADS, RESEARCH_TENT_TILE, TOWN_CENTER_TILE } from './iso_renderer.js';

export const STEPS = ['onb_01_shelter', 'onb_02_forager', 'onb_03_handoff', 'free_play'];
export const RESOURCES = ['food', 'wood', 'stone', 'rp'];
export const RESOURCE_LABEL = { food: 'Food', wood: 'Wood', stone: 'Stone', rp: 'RP' };
const HEARTBEAT_SEC = 5;

export const BUILDINGS = {
  shelter: {
    label: 'Shelter', blurb: '+Workers', score: 5,
    costs: (c) => ({ wood: c.shelter_wood_cost }),
  },
  forager_hut: {
    label: 'Forager Hut', blurb: 'Gathers food', score: 10, produces: 'food',
    costs: (c) => ({ wood: c.forager_wood_cost }),
    cycle: (c) => c.forager_cycle_sec,
    yield: (c, techs) => Math.round(c.forager_food_yield * (techs.has('tech_baskets') ? 1.5 : 1)),
  },
  woodcutter_hut: {
    label: 'Woodcutter', blurb: 'Chops wood', score: 10, produces: 'wood', optional: true,
    toolTech: 'tech_toolmaking',
    costs: (c) => ({ wood: c.optional_woodcutter_cost, food: c.optional_woodcutter_food_cost }),
    cycle: (c) => c.woodcutter_cycle_sec,
    yield: (c, techs) => Math.round(c.woodcutter_wood_yield * (techs.has('tech_woodworking') ? 1.5 : 1)),
  },
  stone_quarry: {
    label: 'Stone Quarry', blurb: 'Cuts stone', score: 10, produces: 'stone', requiresTech: 'tech_masonry',
    costs: (c) => ({ wood: c.quarry_wood_cost, food: c.quarry_food_cost }),
    cycle: (c) => c.quarry_cycle_sec,
    yield: (c) => c.quarry_stone_yield,
  },
  tribal_monument: {
    label: 'Monument', blurb: '+40 score', score: 40, requiresTech: 'tech_toolmaking',
    costs: (c) => ({ wood: c.monument_wood_cost, stone: c.monument_stone_cost }),
  },
};
export const BUILD_ORDER = ['shelter', 'forager_hut', 'woodcutter_hut', 'stone_quarry', 'tribal_monument'];

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
};
export const TECH_ORDER = ['tech_toolmaking', 'tech_woodworking', 'tech_baskets', 'tech_masonry', 'tech_stone_age'];

export const ADVISOR_TEXT = {
  welcome: 'Welcome, Chief! Our tribe has landed on a fertile island. Let us build a home before the cold nights.',
  onb_01_shelter: 'Step 1/3: Build a Shelter. Pick the Shelter card, then a glowing plot.',
  onb_02_forager: 'Step 2/3: Build a Forager Hut, then tap it to collect the first food.',
  onb_03_handoff: 'Step 3/3: You lead the tribe now! Discover Basic Toolmaking to finish your training.',
  free_play: 'Free play: research Masonry, quarry stone and awaken the Stone Age.',
  achieved: 'The Stone Age has dawned! Your people will remember this day.',
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

    this.resources = { food: config.starting_food, wood: config.starting_wood, stone: config.starting_stone, rp: 0 };
    this.techs = new Set();
    this.era = 'dawn_age';
    this.step_id = STEPS[0];
    this.stepIndex = 0;
    this.selectedCard = null;
    this.modal = 'welcome';
    this.achieved = false;
    this.stats = { forager_harvests: 0, clicks: 0, first_click_t: null };
    this.lastProgressT = 0;
    this.hint = null;            // { target_id, text } once an idle hint fired
    this.nextHeartbeat = HEARTBEAT_SEC;
    this.lastTick = 0;
    this.ended = false;
    this.clickSeq = 0;
    this.lastRejection = null;

    const w = this.workersPerBuilding;
    this.buildings = [
      { key: 'town_center', type: 'town_center', tile: TOWN_CENTER_TILE, status: 'done', worker: 0, routeKey: null },
      { key: 'research_tent', type: 'research_tent', tile: RESEARCH_TENT_TILE, status: 'done', worker: w, routeKey: 'research_tent' },
    ];
  }

  get workersPerBuilding() { return this.config.worker_required_per_building; }
  get t() { return this.clock.t; }

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
    const shelters = this.buildings.filter((b) => b.type === 'shelter' && b.status === 'done').length;
    return this.config.starting_workers + shelters * this.config.shelter_pop_gain;
  }

  get workersUsed() {
    return this.buildings.reduce((n, b) => n + (b.worker || 0), 0);
  }

  get workersFree() { return Math.max(0, this.workersTotal - this.workersUsed); }

  get score() {
    let s = 10; // Town Center
    for (const b of this.buildings) if (b.status === 'done' && BUILDINGS[b.type]) s += BUILDINGS[b.type].score;
    for (const id of this.techs) s += TECHS[id].score;
    return s;
  }

  roundedResources() {
    return Object.fromEntries(RESOURCES.map((r) => [r, Math.floor(this.resources[r])]));
  }

  buildingAt(padId) {
    return this.buildings.find((b) => b.key === padId) || null;
  }

  // Optional builds stay locked until the configured step is completed.
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

  // True when harvesting `res` actively reduces a deficit toward the current step's goal.
  // At onb_03_handoff the goal is tech_toolmaking (wood only), so gathering food at the
  // wood dead end returns false and does not reset the stuck idle timer.
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
      for (const type of ['stone_quarry', 'tribal_monument']) {
        const st = this.cardStatus(type);
        if (!st.locked && (st.costs?.[res] || 0) > Math.floor(this.resources[res] + 1e-9)) return true;
      }
    }
    return false;
  }

  missing(costs) {
    for (const [res, amount] of Object.entries(costs)) {
      if (amount > 0 && Math.floor(this.resources[res] + 1e-9) < amount) {
        return { resource: res, available: Math.floor(this.resources[res]), required: amount };
      }
    }
    return null;
  }

  pay(costs, tile) {
    const parts = [];
    for (const [res, amount] of Object.entries(costs)) {
      if (amount <= 0) continue;
      this.resources[res] -= amount;
      parts.push(`-${amount} ${RESOURCE_LABEL[res]}`);
    }
    if (parts.length) this.onFx({ type: 'popup', tile, text: parts.join('  '), color: '#ffb4a2', lift: 60 });
  }

  productionProgress(b) {
    const spec = BUILDINGS[b.type];
    if (!spec || !spec.produces || b.ready || b.blockedReason) return 0;
    return Math.max(0, Math.min(1, (this.clock.t - b.cycleStart) / spec.cycle(this.config)));
  }

  // The target the tutorial or an idle hint currently points at.
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
    const pad = PADS.find((p) => !this.buildingAt(p.id));
    return pad ? pad.id : null;
  }

  advisorText() {
    if (this.modal === 'welcome') return ADVISOR_TEXT.welcome;
    if (this.achieved) return ADVISOR_TEXT.achieved;
    if (this.hint) return HINT_TEXT[this.hint.target_id] || ADVISOR_TEXT[this.step_id];
    return ADVISOR_TEXT[this.step_id];
  }

  // -------------------------------------------------------------- clock
  update(realDt) {
    this.clock.advance(realDt);
    this.tick();
  }

  // Replay: jump the simulation to an absolute time.
  advanceTo(t) {
    if (t > this.clock.t) this.clock.t = t;
    this.tick();
  }

  tick() {
    const now = this.clock.t;
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const c = this.config;
    for (const b of this.buildings) {
      if (b.status === 'building' && now >= b.completeAt) this.completeBuilding(b);
      const spec = BUILDINGS[b.type];
      if (b.status !== 'done' || !spec || !spec.produces) continue;
      b.blockedReason = spec.toolTech && !this.techs.has(spec.toolTech) ? `Needs ${TECHS[spec.toolTech].label}` : null;
      if (!b.ready && !b.blockedReason && now - b.cycleStart >= spec.cycle(c)) b.ready = true;
    }
    const tent = this.buildings.find((b) => b.type === 'research_tent');
    if (tent && (tent.worker || this.workersPerBuilding === 0)) this.resources.rp += (c.research_tent_rp_per_min * dt) / 60;

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
    if (!this.achieved && this.era === 'stone_age' && this.score >= this.config.first_achievement_target_score) {
      this.achieved = true;
      this.emit('achievement', { achievement_id: 'first_achievement', title: 'Stone Age Awakening', score: this.score });
      this.onFx({ type: 'achievement' });
    }
  }

  stepDone(step) {
    if (step === 'onb_01_shelter') return this.buildings.some((b) => b.type === 'shelter' && b.status === 'done');
    if (step === 'onb_02_forager') return this.stats.forager_harvests > 0;
    if (step === 'onb_03_handoff') return this.techs.has('tech_toolmaking');
    return false;
  }

  // ------------------------------------------------------------ actions
  // Every click inside #game-root ends up here, from a human, the stub bot
  // or the replay player. Returns the click result.
  click(target_id, x = null, y = null) {
    this.tick();
    this.clickSeq += 1;
    if (this.stats.first_click_t === null) this.stats.first_click_t = this.clock.t;
    const outcome = this.perform(target_id || 'empty');
    this.emit('click', { target_id: target_id || 'empty', x: x === null ? null : Math.round(x), y: y === null ? null : Math.round(y), result: outcome.result });
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
    if (target_id === 'btn_speed') return { result: 'ui' };
    if (target_id === 'btn_inspect') return { result: 'ui' };
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
    if (this.modal === 'research') return { result: 'noop' };
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
    if (target_id.startsWith('pad_')) {
      const pad = PADS.find((p) => p.id === target_id);
      if (!pad || this.buildingAt(pad.id) || !this.selectedCard) return { result: 'noop' };
      return this.place(this.selectedCard, pad, reject);
    }
    if (target_id.startsWith('building_')) {
      const b = this.buildings.find((x) => `building_${x.key}` === target_id);
      if (!b || !b.ready) return { result: 'noop' };
      const before = this.affordableActions();
      const saving = this.savesTowardGoal(BUILDINGS[b.type]?.produces);
      this.harvest(b);
      // Collecting counts as progress when it opens up a new build/research or
      // reduces a deficit toward the current step's goal. A player who keeps
      // gathering food at the onb_03_handoff wood dead end is still stalled.
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
      cycleStart: 0, ready: false, blockedReason: null,
    });
    this.selectedCard = null;
    this.onFx({ type: 'dust', tile: pad.tile });
    return { result: 'advanced' };
  }

  harvest(b) {
    const spec = BUILDINGS[b.type];
    const amount = spec.yield(this.config, this.techs);
    this.resources[spec.produces] += amount;
    b.ready = false;
    b.cycleStart = this.clock.t;
    if (b.type === 'forager_hut') this.stats.forager_harvests += 1;
    this.onFx({ type: 'popup', tile: b.tile, text: `+${amount} ${RESOURCE_LABEL[spec.produces]}`, color: '#b8f28a', lift: 84 });
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
    // Woodcutters that were waiting for tools start their first cycle now.
    for (const b of this.buildings) {
      const spec = BUILDINGS[b.type];
      if (spec && spec.toolTech === id && b.status === 'done') { b.cycleStart = this.clock.t; b.blockedReason = null; }
    }
    if (id === 'tech_stone_age') {
      this.era = 'stone_age';
      this.onFx({ type: 'sparkle', tile: TOWN_CENTER_TILE, key: 'town_center' });
      this.onFx({ type: 'era', era: 'stone_age' });
    }
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
      sim_elapsed_sec: round3(this.clock.t),
    };
  }
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
