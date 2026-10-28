// Entry point: loads the config for the requested variant, wires the game,
// renderer, HUD, telemetry client, bot hooks and the right dock. The replay
// route (?replay_a=&replay_b=) is handed to replay.js instead.

import { urlParams } from './clock.js';
import {
  BUILDINGS, BUILD_ORDER, ALL_BUILD_ORDER, CAMPAIGN_STAGES, ENCOUNTERS, ERA_LABEL, Game,
  QUESTS, RESOURCES, ALL_RESOURCES, RESOURCE_LABEL,
} from './game.js';
import { Sfx, defaultMuted } from './audio.js';
import { IsoRenderer } from './iso_renderer.js';
import { loadSprites, spriteUrl } from './sprites.js';
import { TechTreeView } from './tech_tree.js';
import { initOverlay } from './overlay.js';

const PROVIDERS = ['human', 'stub', 'open_weights', 'meta'];
const SPEEDS = [1, 2, 4];
const $ = (id) => document.getElementById(id);

const params = urlParams();

if (params.replayA || params.replayB) {
  import('./replay.js').then((m) => m.startReplay(params));
} else {
  boot().catch((err) => {
    console.error(err);
    showFatal(`Could not start the game: ${err.message}`);
  });
}

// ------------------------------------------------------------- telemetry
class TelemetryClient {
  constructor(enabled) {
    this.enabled = enabled;
    this.queue = [];
    this.all = [];
    this.listeners = [];
    this.inflight = null;
    if (enabled) setInterval(() => this.flush(), 400);
  }

  push(ev) {
    this.all.push(ev);
    if (this.enabled) this.queue.push(ev);
    for (const fn of this.listeners) fn(ev);
  }

  flush() {
    if (!this.enabled || this.inflight || !this.queue.length) return this.inflight || Promise.resolve();
    const batch = this.queue.splice(0);
    this.inflight = fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch),
    }).then((r) => {
      if (!r.ok) throw new Error(`events ${r.status}`);
    }).catch((err) => {
      console.warn('telemetry retry', err);
      this.queue.unshift(...batch);
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async drain() {
    for (let i = 0; i < 20 && (this.queue.length || this.inflight); i++) {
      await (this.inflight || this.flush());
    }
  }

  beacon() {
    if (!this.enabled || !this.queue.length) return;
    const blob = new Blob([JSON.stringify(this.queue.splice(0))], { type: 'application/json' });
    navigator.sendBeacon('/api/events', blob);
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  const provider = params.bot ? 'stub' : (PROVIDERS.includes(params.provider) ? params.provider : 'human');
  const runId = params.runId || `run_${Date.now().toString(36)}_${params.variant}_s${params.seed}`;
  const qs = new URLSearchParams({ variant: params.variant });
  if (params.patchId) qs.set('patch_id', params.patchId);
  const [cfgRes, sprites] = await Promise.all([fetch(`/api/config?${qs}`), loadSprites()]);
  if (!cfgRes.ok) {
    const detail = (await cfgRes.json().catch(() => ({}))).detail || cfgRes.statusText;
    showFatal(cfgRes.status === 403
      ? `\u{1F512} ${detail}. Review the patch in the AI Director and approve it to play this variant.`
      : `Config error (${cfgRes.status}): ${detail}`);
    initOverlay({ dock: $('right-dock'), game: null, params, runId, telemetry: null, provider, blocked: true });
    return;
  }
  const { config, meta: cfgMeta } = await cfgRes.json();

  const telemetry = new TelemetryClient(!params.noTelemetry);
  window.__BOT_CTX__ = { bot_step_index: null, correlation_id: null };
  let renderer;
  const fxHandlers = [];
  const game = new Game(config, {
    runId, variant: params.variant, patchId: params.patchId, persona: params.persona, seed: params.seed,
    provider, speed: params.speed,
    onEvent: (ev) => telemetry.push(ev),
    onFx: (fx) => { renderer?.fx(fx); for (const fn of fxHandlers) fn(fx); },
    botCtx: () => window.__BOT_CTX__ || {},
  });
  renderer = new IsoRenderer($('world'), sprites, { seed: params.seed });
  const sfx = new Sfx({ muted: defaultMuted(params) });
  fxHandlers.push((fx) => { if (fx.type === 'sfx') sfx.play(fx.sound); });
  const hud = new Hud(game, config, sfx);
  const techView = new TechTreeView($('tech-tree'), $('tech-rp'));
  fxHandlers.push((fx) => hud.onFx(fx));

  const root = $('game-root');
  const getTargets = () => renderedTargets(game, renderer, config);
  root.addEventListener('click', (e) => {
    const rect = root.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Handle Build Bar category filter tabs
    const catBtn = e.target.closest('[data-build-cat]');
    if (catBtn) {
      hud.setBuildCategory(catBtn.dataset.buildCat);
      return;
    }

    const el = e.target.closest('[data-target]');
    let target = el ? el.dataset.target : null;
    if (!target && (e.target === $('world') || e.target === root)) target = renderer.hitTest(game, x, y)?.target_id || null;
    if (!target && e.target.classList.contains('modal-backdrop')) target = targetBelow(e.target, e.clientX, e.clientY, game, renderer, x, y);

    const outcome = game.click(target || 'empty', x, y);
    if (target === 'btn_mute') sfx.toggle();
    if (outcome.result === 'rejected') sfx.play('reject');
    else if (outcome.result === 'ui' && target !== 'btn_mute') sfx.play('click');
    if (target === 'btn_speed') {
      game.clock.speed = SPEEDS[(SPEEDS.indexOf(game.clock.speed) + 1) % SPEEDS.length] || 1;
    }
    if (target === 'btn_inspect') hud.toggleInspector();
    hud.afterClick(target, outcome);
  });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (game.selectedCard) game.click('btn_deselect');
  });

  game.start();
  if (params.inspectConfig) hud.toggleInspector(true);

  const overlay = initOverlay({
    dock: $('right-dock'), game, params, runId, telemetry, provider, getTargets, cfgMeta,
    clickAt: (x, y) => clickAt(root, x, y),
  });

  window.__GAME_DEBUG__ = {
    getRenderedTargets: getTargets,
    endSession: async (reason = 'debug_end') => { game.end(reason); await telemetry.drain(); return game.snapshot(); },
    flush: () => telemetry.drain(),
    snapshot: () => game.snapshot(),
    runId,
    config,
    events: () => telemetry.all,
  };
  window.addEventListener('pagehide', () => { game.end('pagehide'); telemetry.beacon(); });

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    game.update(dt);
    renderer.render(game, dt);
    hud.update();
    if (game.modal === 'research') techView.update(game);
    overlay.update();
    publishState(game, renderer);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function publishState(game, renderer) {
  const building = game.buildings.some((b) => b.status === 'building');
  const anims = renderer.activeAnimations + (building ? 1 : 0);
  window.__GAME_STATE__ = {
    ready: true,
    idle: anims === 0,
    active_animations: anims,
    last_click_seq: game.clickSeq,
    step_id: game.step_id,
    era: game.era,
    resources: game.roundedResources(),
    workers_free: game.workersFree,
    workers_total: game.workersTotal,
    score: game.score,
    modal_open: game.modal,
    selected_card: game.selectedCard,
    achieved: game.achieved,
    bronze_achieved: game.bronzeAchieved,
    quest_index: game.questIndex,
    quest_claimable: game.questClaimable,
    expedition_unlocked: game.expeditionUnlocked(),
    heroes_unlocked: game.heroesUnlocked(),
    squad_power: game.squadPower(),
    heroes: Object.fromEntries(Object.entries(game.heroes).map(([k, v]) => [k, { level: v.level, unlocked: v.unlocked, power: game.heroStats(k).power }])),
    battle_active: !!(game.battleState && game.battleState.active),
    battles: game.stats.battles,
    upgrades: game.stats.upgrades,
    techs: [...game.techs],
    buildings: game.snapshot().buildings,
    muted: !!window.__SFX_MUTED__,
    sim_elapsed_sec: game.snapshot().sim_elapsed_sec,
    run_id: game.meta.run_id,
  };
}

function targetBelow(backdrop, cx, cy, game, renderer, x, y) {
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (backdrop.contains(el)) continue;
    const t = el.closest('[data-target]');
    if (t) return t.dataset.target;
    if (el === $('world')) return renderer.hitTest(game, x, y)?.target_id || null;
  }
  return null;
}

function clickAt(root, x, y) {
  const rect = root.getBoundingClientRect();
  const cx = rect.left + x;
  const cy = rect.top + y;
  const el = document.elementFromPoint(cx, cy) || root;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }));
}

// --------------------------------------------------------------- targets
function renderedTargets(game, renderer, config) {
  const root = $('game-root');
  const rect = root.getBoundingClientRect();
  const guide = game.guideTarget();
  const canvas = $('world');
  const out = [];
  const onScreen = (x, y, w, h) => w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= 960 && y + h <= 540;
  for (const el of root.querySelectorAll('[data-target]')) {
    const r = el.getBoundingClientRect();
    const x = r.left - rect.left;
    const y = r.top - rect.top;
    if (!r.width || !r.height) continue;
    const id = el.dataset.target;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const visible = onScreen(x, y, r.width, r.height) && !!hit && el.contains(hit);
    const t = {
      target_id: id, kind: kindOf(id), x: round1(x), y: round1(y), w: round1(r.width), h: round1(r.height),
      visible, locked: false, affordable: true, computed_salience: 'medium', highlighted: guide === id,
      label: (el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    };
    if (id.startsWith('card_')) {
      const st = game.cardStatus(id.slice(5));
      t.locked = !!st.locked;
      t.affordable = !st.locked && !!st.affordable;
      t.computed_salience = st.locked ? 'low' : (isNewContent(game, id.slice(5)) ? 'high' : (t.affordable ? 'medium' : 'low'));
      t.selected = game.selectedCard === id.slice(5);
    } else if (id.startsWith('tech_')) {
      const st = game.techStatus(id);
      t.locked = !st.done && !st.available;
      t.affordable = !!st.affordable;
      t.done = !!st.done;
      t.computed_salience = st.affordable ? 'high' : 'low';
    } else if (id === 'btn_research') {
      t.computed_salience = config.research_button_salience;
    } else if (id === 'btn_heroes' || id === 'btn_expedition') {
      t.computed_salience = game.stepIndex >= 1 ? 'high' : 'low';
    } else if (id === 'btn_hero_levelup') {
      const h = game.heroes[game.selectedHero];
      t.affordable = h && h.unlocked && game.resources.food >= 10 * h.level;
      t.computed_salience = t.affordable ? 'high' : 'medium';
    } else if (id === game.featureTarget) {
      const st = game.featureStatus();
      t.affordable = !!st.affordable;
      t.cooldown = st.cooldown ? round1(st.cooldown) : 0;
      const sal = game.feature.button_salience;
      t.computed_salience = sal === 'high_pulse' && game.featureUses > 0 ? 'high' : sal;
      t.is_new = sal === 'high_pulse' && game.featureUses === 0;
    } else if (id.startsWith('encounter_') || id.startsWith('stage_')) {
      const s = CAMPAIGN_STAGES.find((x) => x.id === id || x.legacyId === id);
      const isCleared = game.encountersCleared.has(id) || (s && (game.encountersCleared.has(s.id) || (s.legacyId && game.encountersCleared.has(s.legacyId))));
      t.cleared = !!isCleared;
      t.affordable = !t.cleared && !game.missing(game.expeditionCosts());
      t.computed_salience = t.affordable ? 'high' : 'low';
    } else if (id.startsWith('btn_arena_')) {
      t.computed_salience = 'high';
    } else if (['btn_advisor_ok', 'btn_close_research', 'btn_claim_quest', 'btn_close_expedition', 'btn_close_heroes', 'btn_close_quests', 'btn_battle_continue', 'btn_victory_continue', 'btn_defeat_heroes', 'btn_start_arena', 'btn_campaign_heroes', 'btn_open_quests', 'btn_quest_ledger'].includes(id)) {
      t.computed_salience = 'high';
    } else {
      t.computed_salience = 'low';
    }
    out.push(t);
  }
  for (const w of renderer.worldTargets(game)) {
    const cx = rect.left + w.x + w.w / 2;
    const cy = rect.top + w.y + w.h / 2;
    const visible = onScreen(w.x, w.y, w.w, w.h) && document.elementFromPoint(cx, cy) === canvas
      && renderer.hitTest(game, w.x + w.w / 2, w.y + w.h / 2)?.target_id === w.target_id;
    out.push({
      ...w, x: round1(w.x), y: round1(w.y), visible, locked: false,
      affordable: w.kind === 'pad' ? !!game.selectedCard : (w.kind === 'upgrade' ? w.affordable : true),
      computed_salience: w.kind === 'pad' ? (game.selectedCard ? 'high' : 'low')
        : (w.ready || (w.kind === 'worker' && !w.staffed) || w.kind === 'free' ? 'high' : 'low'),
      highlighted: guide === w.target_id,
      label: worldLabel(w),
    });
  }
  return out;
}

function isNewContent(game, type) {
  return !!BUILDINGS[type].optional && game.stepIndex >= 2 && !game.cardStatus(type).locked
    && !game.buildings.some((b) => b.type === type);
}

function worldLabel(w) {
  if (w.kind === 'pad') return `Building plot ${w.target_id.slice(4)}`;
  if (w.kind === 'free') return `Instant Finish ${w.target_id.slice(5)}`;
  if (w.kind === 'expansion') return `Expand territory (${w.target_id})`;
  if (w.kind === 'upgrade') return `Upgrade ${w.building_type} to Lv.${w.level + 1}`;
  if (w.kind === 'worker') return `${w.staffed ? 'Unassign' : 'Assign'} worker (${w.building_type})`;
  return w.level > 1 ? `${w.building_type} Lv.${w.level}` : w.building_type;
}

function kindOf(id) {
  if (id.startsWith('card_')) return 'build_card';
  if (id.startsWith('tech_')) return 'tech';
  if (id.startsWith('encounter_') || id.startsWith('stage_')) return 'encounter';
  if (id.startsWith('btn_arena_')) return 'arena';
  if (id.startsWith('btn_feature_')) return 'feature';
  return 'button';
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ------------------------------------------------------------------- HUD
const CATEGORY_MAP = {
  all: null,
  homes: ['shelter'],
  production: ['forager_hut', 'woodcutter_hut', 'stone_quarry', 'smelter'],
  military: ['barracks'],
  culture: ['granary', 'tribal_monument'],
};

class Hud {
  constructor(game, config, sfx) {
    this.game = game;
    this.config = config;
    this.sfx = sfx;
    this.questSig = '';
    this.portrait = 'welcome';
    this.prev = {};
    this.sig = '';
    this.inspectorOn = false;
    this.toastTimer = null;
    this.buildCategory = 'all';

    document.documentElement.style.setProperty('--card-scale', config.build_button_scale);
    const research = $('btn_research');
    if (research) research.className = `dock-btn research-btn sal-${config.research_button_salience}`;
    $('welcome-text').textContent = game.advisorText();

    this.renderCards();
    if (game.feature) this.buildFeatureCard(game.feature);
    this.initCampaign();
    this.initQuestsLedger();
  }

  setBuildCategory(cat) {
    this.buildCategory = cat;
    for (const btn of document.querySelectorAll('[data-build-cat]')) {
      btn.classList.toggle('active', btn.dataset.buildCat === cat);
    }
    this.sig = '';
    this.updateCards();
  }

  renderCards() {
    $('cards').innerHTML = ALL_BUILD_ORDER.map((type) => `
      <button class="card" data-target="card_${type}" data-btype="${type}" title="${BUILDINGS[type].label}" ${type === 'barracks' ? 'hidden' : ''}>
        <img src="${spriteUrl(type)}" alt="">
        <span class="c-name">${BUILDINGS[type].label}</span>
        <span class="c-cost"></span>
        <span class="c-lock" hidden></span>
      </button>`).join('');
  }

  initCampaign() {
    const ex = this.game.expeditionCosts();
    const encountersEl = $('encounters');
    if (encountersEl) {
      encountersEl.innerHTML = ENCOUNTERS.map((e) => `
        <button class="encounter" data-target="${e.id}" title="${e.label}">
          <span class="e-ico">${e.icon}</span><span>${e.label}</span><small>${costText(ex) || 'Free'}</small>
        </button>`).join('');
    }

    const grid = $('campaign-stages-grid');
    if (grid) {
      grid.innerHTML = CAMPAIGN_STAGES.map((s) => `
        <button class="stage-node-card encounter ${s.reqPower ? 'level-check' : ''}" data-target="${s.legacyId || s.id}" id="stage-card-${s.id}">
          <div class="node-header">
            <span class="node-num">${s.name}</span>
            <span class="node-stars" id="stars-${s.id}">☆☆☆</span>
          </div>
          <div class="node-body">
            <div class="node-enemies">${s.enemies}</div>
            <div class="node-power">Enemy Power: <b>${s.enemyPower}</b></div>
            <div class="node-reward">Loot: ${costText(s.reward)}</div>
          </div>
          <div class="node-tap-hint">⚡ Tap to Battle</div>
        </button>`).join('');
    }
  }

  initQuestsLedger() {
    const list = $('quests-ledger-list');
    if (!list) return;
    list.innerHTML = QUESTS.map((q, idx) => `
      <div class="quest-ledger-row" id="ledger-q-${q.id}">
        <div class="ql-num">Chapter ${idx + 1}</div>
        <div class="ql-content">
          <h4>${q.title}</h4>
          <ul class="ql-objs" id="ledger-objs-${q.id}">
            ${q.objectives.map(([label]) => `<li>${label}</li>`).join('')}
          </ul>
          <div class="ql-reward">Reward: ${costText(q.reward)}</div>
        </div>
        <div class="ql-status" id="ledger-status-${q.id}">Pending</div>
      </div>`).join('');
  }

  update() {
    const g = this.game;
    const res = g.roundedResources();

    // Resources HUD
    for (const r of ALL_RESOURCES) {
      const el = $(`res-${r}`);
      if (!el) continue;
      if (this.prev[r] !== res[r]) {
        el.querySelector('b').textContent = res[r];
        if (this.prev[r] !== undefined && !['rp', 'coins', 'scrolls', 'tokens', 'stamina'].includes(r)) bump(el);
        this.prev[r] = res[r];
      }
      el.classList.toggle('low', (r === 'wood' || r === 'food') && res[r] < 20);
    }

    const workers = `${g.workersFree}/${g.workersTotal}`;
    if (this.prev.workers !== workers) {
      const wEl = $('res-workers');
      if (wEl) wEl.querySelector('b').textContent = workers;
      this.prev.workers = workers;
    }
    if (this.prev.score !== g.score) {
      const sEl = $('res-score');
      if (sEl) {
        sEl.querySelector('b').textContent = g.score;
        if (this.prev.score !== undefined) bump(sEl);
      }
      this.prev.score = g.score;
    }

    $('btn_speed').textContent = `${g.clock.speed}x`;
    $('era-name').textContent = ERA_LABEL[g.era];
    $('era-banner').classList.toggle('stone', g.era !== 'dawn_age');
    $('era-banner').classList.toggle('bronze', g.era === 'bronze_age');

    const stepLabel = { onb_01_shelter: 'Step 1/3', onb_02_forager: 'Step 2/3', onb_03_handoff: 'Step 3/3', free_play: 'Free play' };
    $('step-chip').textContent = g.achieved ? ERA_LABEL[g.era] : stepLabel[g.step_id];
    const text = g.advisorText();
    if ($('advisor-text').textContent !== text) $('advisor-text').textContent = text;
    $('advisor').querySelector('.bubble').classList.toggle('hinting', !!g.hint);

    const mood = g.advisorMood();
    if (mood !== this.portrait) {
      this.portrait = mood;
      $('advisor-portrait').src = `/static/assets/sprites/advisor_${mood}.png`;
      $('advisor').classList.toggle('hint', mood === 'hint');
    }

    $('btn_mute').textContent = this.sfx.muted ? '\u{1F507}' : '\u{1F50A}';
    $('btn_mute').classList.toggle('on', !this.sfx.muted);
    window.__SFX_MUTED__ = this.sfx.muted;

    // Modals
    $('welcome-modal').hidden = g.modal !== 'welcome';
    $('research-modal').hidden = g.modal !== 'research';
    $('expedition-modal').hidden = g.modal !== 'expedition';
    $('heroes-modal').hidden = g.modal !== 'heroes';
    $('quests-modal').hidden = g.modal !== 'quests';

    // Action Dock
    $('btn_heroes').hidden = !g.heroesUnlocked();
    $('btn_expedition').hidden = !g.expeditionUnlocked();

    if (g.feature) this.updateFeatureCard();
    this.updateQuest();
    if (g.modal === 'expedition') this.updateCampaignModal();
    if (g.modal === 'heroes') this.updateHeroesModal();
    if (g.modal === 'quests') this.updateQuestsModal();
    this.updateBattleHud();
    this.updateCards();
    this.updateArrow();
    if (this.inspectorOn) this.placeInspectTags();

    // Sfx music switcher
    this.sfx.setMusicTheme?.(g.battleState?.active ? 'battle' : 'valley');
  }

  updateCards() {
    const g = this.game;
    const res = g.roundedResources();
    const sig = JSON.stringify([res, g.selectedCard, [...g.techs], g.stepIndex, g.workersFree, this.buildCategory]);
    if (sig === this.sig) return;
    this.sig = sig;

    const allowed = CATEGORY_MAP[this.buildCategory] || null;

    for (const type of ALL_BUILD_ORDER) {
      const el = document.querySelector(`[data-target="card_${type}"]`);
      if (!el) continue;
      if (allowed && !allowed.includes(type)) {
        el.hidden = true;
        continue;
      }
      if (type === 'barracks' && this.buildCategory === 'all') {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      const st = g.cardStatus(type);
      const costs = BUILDINGS[type].costs(this.config);
      el.querySelector('.c-cost').innerHTML = Object.entries(costs).filter(([, v]) => v > 0)
        .map(([r, v]) => `<span class="${(res[r] ?? 0) < v ? 'short' : ''}">${v} ${r === 'wood' ? '\u{1FAB5}' : r === 'food' ? '\u{1F35E}' : '\u{1FAA8}'}</span>`)
        .join(' ');
      const lock = el.querySelector('.c-lock');
      lock.hidden = !st.locked;
      lock.textContent = st.locked ? st.lock : '';
      el.querySelector('.c-cost').hidden = !!st.locked;
      el.classList.toggle('locked', !!st.locked);
      el.classList.toggle('unaffordable', !st.locked && !st.affordable);
      el.classList.toggle('selected', g.selectedCard === type);
      const optionalOpen = isNewContent(g, type);
      let ribbon = el.querySelector('.ribbon');
      if (optionalOpen && !ribbon) {
        ribbon = document.createElement('span');
        ribbon.className = 'ribbon';
        ribbon.textContent = 'NEW!';
        el.appendChild(ribbon);
      } else if (!optionalOpen && ribbon) {
        ribbon.remove();
      }
    }
  }

  updateQuest() {
    const g = this.game;
    const ledgerBtn = $('btn_open_quests') || $('btn_quest_ledger');
    if (ledgerBtn) ledgerBtn.hidden = !g.heroesUnlocked();
    const q = g.quest;
    const sig = JSON.stringify([g.questIndex, g.questClaimable, q && q.objectives.map(([, fn]) => fn(g))]);
    if (sig === this.questSig) return;
    this.questSig = sig;
    const card = $('quest-card');
    if (!q) {
      $('quest-title').textContent = 'All 6 Chapters Complete 👑';
      $('quest-objectives').innerHTML = '<li class="ok">Empire Ascendant!</li>';
      $('quest-fill').style.width = '100%';
      $('btn_claim_quest').hidden = true;
      card.classList.remove('done');
      return;
    }
    const prog = g.questProgress();
    $('quest-title').textContent = q.title;
    $('quest-objectives').innerHTML = q.objectives.map(([label, fn]) => `<li class="${fn(g) ? 'ok' : ''}">${label}</li>`).join('');
    $('quest-fill').style.width = `${Math.round((100 * prog.done) / prog.total)}%`;
    $('btn_claim_quest').hidden = !g.questClaimable;
    card.classList.toggle('done', g.questClaimable);
  }

  updateCampaignModal() {
    const g = this.game;
    $('campaign-squad-power').textContent = g.squadPower();
    $('campaign-stamina').textContent = `${Math.floor(g.resources.stamina ?? 100)}/100`;

    for (const s of CAMPAIGN_STAGES) {
      const card = $(`stage-card-${s.id}`);
      if (!card) continue;
      const cleared = g.encountersCleared.has(s.id) || (s.legacyId && g.encountersCleared.has(s.legacyId));
      card.classList.toggle('cleared', !!cleared);
      const starsEl = $(`stars-${s.id}`);
      if (starsEl) starsEl.textContent = cleared ? '⭐⭐⭐' : '☆☆☆';
      const hintEl = card.querySelector('.node-tap-hint');
      if (hintEl) hintEl.textContent = cleared ? '✅ Cleared' : (s.reqPower && g.squadPower() < s.reqPower ? `⚠️ Power: ${g.squadPower()}/${s.reqPower}` : '⚡ Tap to Battle');
    }
  }

  updateHeroesModal() {
    const g = this.game;
    $('heroes-total-power').textContent = g.squadPower();

    // Roster list
    const rosterEl = $('heroes-roster');
    if (rosterEl) {
      rosterEl.innerHTML = Object.values(g.heroes).map((h) => {
        const stats = g.heroStats(h.id);
        const isSel = g.selectedHero === h.id;
        return `
          <button class="roster-card ${isSel ? 'active' : ''} ${h.unlocked ? '' : 'locked'}"
                  data-target="btn_select_hero_${h.id}" title="${h.name}">
            <img src="/static/assets/sprites/${h.portrait}.png" alt="" class="r-avatar" onerror="this.src='/static/assets/sprites/advisor_welcome.png'">
            <div class="r-meta">
              <span class="r-name">${h.name}</span>
              <span class="r-sub">${h.unlocked ? `Lv.${h.level} &middot; ⚔️ ${stats.power}` : '🔒 Locked'}</span>
            </div>
          </button>`;
      }).join('');
    }

    // Showcase hero
    const sel = g.heroes[g.selectedHero] || g.heroes.vaelen;
    const stats = g.heroStats(sel.id);
    $('showcase-name').textContent = sel.name;
    $('showcase-title').textContent = sel.title;
    $('showcase-role').textContent = sel.role;
    $('showcase-stars').textContent = '★'.repeat(sel.stars);
    $('showcase-portrait').src = `/static/assets/sprites/${sel.portrait}.png`;
    $('showcase-portrait').onerror = () => { $('showcase-portrait').src = '/static/assets/sprites/advisor_welcome.png'; };
    $('showcase-ult-name').textContent = `⚡ ${sel.ultName}`;
    $('showcase-ult-desc').textContent = sel.ultDesc;

    // Attributes matrix
    $('stat-hp').textContent = stats.hp;
    $('stat-atk').textContent = stats.atk;
    $('stat-def').textContent = stats.def;
    $('stat-power').textContent = stats.power;
    $('stat-level').textContent = `Lv.${sel.level} / ${sel.maxLevel}`;

    const costFood = 10 * sel.level;
    const costScrolls = 5 * sel.level;
    $('hero-upgrade-cost').textContent = `Cost: ${costFood} 🌾 Food ${costScrolls > 0 ? `+ ${costScrolls} 📜 Scrolls` : ''}`;

    const canUpgrade = sel.unlocked && sel.level < sel.maxLevel && g.resources.food >= costFood;
    const lvlBtn = $('btn_hero_levelup');
    if (lvlBtn) {
      lvlBtn.disabled = !canUpgrade;
      lvlBtn.textContent = sel.level >= sel.maxLevel ? 'Max Rank' : `⚔️ Train Lv.${sel.level + 1} (+15 Score)`;
    }
  }

  updateQuestsModal() {
    const g = this.game;
    for (const [idx, q] of QUESTS.entries()) {
      const row = $(`ledger-q-${q.id}`);
      if (!row) continue;
      const isComplete = q.objectives.every(([, fn]) => fn(g));
      const isPast = g.questIndex > idx;
      const statusEl = $(`ledger-status-${q.id}`);
      if (statusEl) {
        if (isPast) statusEl.textContent = '✅ Completed';
        else if (isComplete) statusEl.textContent = '🎁 Claimable';
        else if (g.questIndex === idx) statusEl.textContent = 'Active';
        else statusEl.textContent = 'Locked';
      }
      row.classList.toggle('done', isPast || isComplete);
      row.classList.toggle('active', g.questIndex === idx);
    }
  }

  updateBattleHud() {
    const g = this.game;
    const bs = g.battleState;
    const hud = $('battle-hud');
    if (!bs) {
      hud.hidden = true;
      $('battle-victory-modal').hidden = true;
      $('battle-defeat-modal').hidden = true;
      return;
    }

    hud.hidden = false;
    $('battle-stage-name').textContent = bs.stage?.name || 'Campaign Battle';
    $('battle-wave-text').textContent = `WAVE ${bs.wave || 1}/${bs.totalWaves || 1}`;

    const alliedPct = Math.max(0, Math.min(100, Math.round((bs.playerHp / (bs.playerMaxHp || 1)) * 100)));
    const enemyPct = Math.max(0, Math.min(100, Math.round((bs.enemyHp / (bs.enemyMaxHp || 1)) * 100)));
    $('battle-allied-hp-fill').style.width = `${alliedPct}%`;
    $('battle-enemy-hp-fill').style.width = `${enemyPct}%`;
    $('battle-allied-hp-text').textContent = `${Math.max(0, Math.round(bs.playerHp))}/${bs.playerMaxHp}`;
    $('battle-enemy-hp-text').textContent = `${Math.max(0, Math.round(bs.enemyHp))}/${bs.enemyMaxHp}`;

    $('btn_battle_speed').textContent = `${bs.speed || 1}x`;
    $('btn_battle_auto').classList.toggle('active', !!bs.auto);

    // Rage fills
    $('rage-fill-vaelen').style.width = `${bs.vaelenRage || 0}%`;
    $('rage-fill-lyra').style.width = `${bs.lyraRage || 0}%`;
    $('btn_ult_vaelen').classList.toggle('ready', (bs.vaelenRage || 0) >= 100);
    $('btn_ult_lyra').classList.toggle('ready', (bs.lyraRage || 0) >= 100);

    // Cut-in
    const cutin = $('battle-cutin');
    if (bs.cutIn) {
      cutin.hidden = false;
      $('cutin-hero').textContent = bs.cutIn.name.toUpperCase();
      $('cutin-ult').textContent = bs.cutIn.ult;
      $('cutin-img').src = `/static/assets/sprites/${bs.cutIn.portrait}.png`;
      $('cutin-img').onerror = () => { $('cutin-img').src = '/static/assets/sprites/advisor_welcome.png'; };
    } else {
      cutin.hidden = true;
    }

    // Overlays
    const vicModal = $('battle-victory-modal');
    const defModal = $('battle-defeat-modal');
    if (bs.outcome === 'victory') {
      vicModal.hidden = false;
      defModal.hidden = true;
      const lootEl = $('victory-loot');
      if (lootEl && bs.stage?.reward) {
        lootEl.innerHTML = Object.entries(bs.stage.reward)
          .map(([r, a]) => `<span class="loot-pill">+${a} ${RESOURCE_LABEL[r] || r}</span>`).join(' ');
      }
    } else if (bs.outcome === 'defeat') {
      vicModal.hidden = true;
      defModal.hidden = false;
    } else {
      vicModal.hidden = true;
      defModal.hidden = true;
    }
  }

  buildFeatureCard(f) {
    const el = document.createElement('button');
    el.id = 'feature-card';
    el.className = `feature-card sal-${f.button_salience}`;
    el.dataset.target = `btn_feature_${f.feature_id}`;
    el.title = f.title;
    el.hidden = true;
    const ico = f.icon_url ? document.createElement('img') : document.createElement('span');
    ico.className = 'f-ico';
    if (f.icon_url) { ico.src = f.icon_url; ico.alt = ''; ico.onerror = () => { ico.replaceWith(emojiIcon(f.icon)); }; }
    else ico.textContent = f.icon;
    const label = document.createElement('span');
    label.className = 'f-label';
    label.textContent = f.title;
    const cost = document.createElement('span');
    cost.className = 'f-cost';
    const ribbon = document.createElement('span');
    ribbon.className = 'ribbon';
    ribbon.textContent = 'NEW!';
    ribbon.hidden = f.button_salience !== 'high_pulse';
    const cool = document.createElement('span');
    cool.className = 'f-cool';
    el.append(ico, label, cost, ribbon, cool);
    $('game-root').appendChild(el);
    this.featureEl = el;
  }

  updateFeatureCard() {
    const g = this.game;
    const el = this.featureEl;
    const st = g.featureStatus();
    el.hidden = !st.unlocked;
    if (!st.unlocked) return;
    const res = g.roundedResources();
    const sig = JSON.stringify([res, Math.ceil(st.cooldown || 0), g.featureUses]);
    if (sig === this.featureSig) return;
    this.featureSig = sig;
    const costs = g.featureCosts();
    el.querySelector('.f-cost').textContent = costText(costs) || 'Free';
    el.querySelector('.f-cost').classList.toggle('short', !!st.missing);
    el.querySelector('.f-cool').textContent = st.cooldown ? `${Math.ceil(st.cooldown)}s` : '';
    el.classList.toggle('cooling', !!st.cooldown);
    el.classList.toggle('unaffordable', !!st.missing);
    if (g.featureUses > 0) {
      el.querySelector('.ribbon').hidden = true;
      el.classList.replace('sal-high_pulse', 'sal-high');
    }
  }

  updateArrow() {
    const arrow = $('hint-arrow');
    const id = this.game.modal === 'welcome' ? null : this.game.guideTarget();
    if (!id) { arrow.hidden = true; return; }
    const t = window.__GAME_DEBUG__?.getRenderedTargets().find((x) => x.target_id === id && x.visible);
    if (!t) { arrow.hidden = true; return; }
    arrow.hidden = false;
    arrow.style.left = `${t.x + t.w / 2 - 14}px`;
    arrow.style.top = `${Math.max(46, t.y - 30)}px`;
  }

  afterClick() {}

  onFx(fx) {
    if (fx.type === 'era') {
      const el = $('era-banner');
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    if (fx.type === 'achievement' && fx.achievement_id === 'bronze_age_mastery') {
      this.toast('\u{1F3C6} Bronze Age Mastery', 'Bronze weapons & tools for every hut · an Empire has risen');
    } else if (fx.type === 'achievement') {
      this.toast('\u{1F3C6} First achievement unlocked', 'Stone Age Awakening · your empire enters a new era');
    }
  }

  toast(title, sub) {
    const el = $('toast');
    el.innerHTML = `${title}<small>${sub}</small>`;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  toggleInspector(force) {
    this.inspectorOn = force ?? !this.inspectorOn;
    const panel = $('inspector');
    $('btn_inspect').classList.toggle('on', this.inspectorOn);
    document.querySelectorAll('.inspect-tag').forEach((n) => n.remove());
    document.querySelectorAll('.inspect-hl').forEach((n) => n.classList.remove('inspect-hl'));
    panel.hidden = !this.inspectorOn;
    if (!this.inspectorOn) return;
    const c = this.config;
    const g = this.game;
    const rows = [
      ['starting_wood', c.starting_wood],
      ['lock_optional_builds_until_step', c.lock_optional_builds_until_step === null ? 'null' : `"${c.lock_optional_builds_until_step}"`],
      ['research_button_salience', `"${c.research_button_salience}"`],
      ['idle_hint_delay_sec', c.idle_hint_delay_sec],
    ];
    panel.innerHTML = `<h3>Config inspector</h3>${rows.map(([k, v]) => `<div class="kv"><code>${k}</code><span class="val">${v}</span></div>`).join('')}
      <div class="meta">variant ${g.meta.variant_id}${g.meta.patch_id ? ` · ${g.meta.patch_id}` : ' · base config'} · seed ${g.meta.seed}</div>`;
    for (const [id] of INSPECT_TARGETS) document.querySelector(id)?.classList.add('inspect-hl');
    this.placeInspectTags();
  }

  placeInspectTags() {
    const rootRect = $('game-root').getBoundingClientRect();
    for (const [sel, label] of INSPECT_TARGETS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let tag = document.querySelector(`.inspect-tag[data-for="${CSS.escape(sel)}"]`);
      if (!tag) {
        tag = document.createElement('div');
        tag.className = 'inspect-tag';
        tag.dataset.for = sel;
        tag.textContent = label;
        $('game-root').appendChild(tag);
      }
      const r = el.getBoundingClientRect();
      const left = Math.min(960 - tag.offsetWidth - 4, Math.max(4, r.left - rootRect.left));
      const above = r.top - rootRect.top - 18;
      tag.style.left = `${left}px`;
      tag.style.top = `${above < 46 ? r.bottom - rootRect.top + 4 : above}px`;
    }
  }
}

const INSPECT_TARGETS = [
  ['#res-wood', 'starting_wood'],
  ['[data-target="card_woodcutter_hut"]', 'lock_optional_builds_until_step'],
  ['#btn_research', 'research_button_salience'],
  ['#advisor .bubble', 'idle_hint_delay_sec'],
];

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function showFatal(message) {
  const root = $('game-root');
  const box = document.createElement('div');
  box.className = 'modal-backdrop';
  box.innerHTML = `<div class="modal welcome" style="display:block"><h2>Variant unavailable</h2><p></p></div>`;
  box.querySelector('p').textContent = message;
  root.appendChild(box);
}

function emojiIcon(icon) {
  const span = document.createElement('span');
  span.className = 'f-ico';
  span.textContent = icon;
  return span;
}

function costText(costs) {
  const icon = { food: '\u{1F35E}', wood: '\u{1FAB5}', stone: '\u{1FAA8}', rp: '\u{1F4DC}', coins: '\u{1FA99}', scrolls: '\u{1F4DC}', tokens: '\u{1F5FA}\u{FE0F}' };
  return Object.entries(costs || {}).filter(([, v]) => v > 0).map(([r, v]) => `${v} ${icon[r] || r}`).join(' ');
}
