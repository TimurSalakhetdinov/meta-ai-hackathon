// Entry point: loads the config for the requested variant, wires the game,
// renderer, HUD, telemetry client, bot hooks and the right dock. The replay
// route (?replay_a=&replay_b=) is handed to replay.js instead.

import { urlParams } from './clock.js';
import {
  BUILDINGS, BUILD_ORDER, ALL_BUILD_ORDER, CAMPAIGN_STAGES, ENCOUNTERS, ERA_LABEL, Game,
  QUESTS, RESOURCES, ALL_RESOURCES, RESOURCE_LABEL, TECHS, UPGRADABLE_TYPES,
} from './game.js?v=74';
import { Sfx, defaultMuted } from './audio.js?v=23';
import { IsoRenderer } from './iso_renderer.js?v=67';
import { loadSprites, spriteUrl } from './sprites.js?v=66';
import { TechTreeView } from './tech_tree.js?v=52';
import { initOverlay } from './overlay.js';

const PROVIDERS = ['human', 'stub', 'open_weights', 'meta'];
const SPEEDS = [1, 2, 4];
const $ = (id) => document.getElementById(id);

const params = urlParams();

// Elder Kaelen's voice: an old Viking narrator (browser speech synthesis,
// deepest male voice available, slow and low) pronounces each new advisor
// message. Silent in bot runs and replays, and under the mute button.
const kaelenVoice = {
  last: '',
  unlocked: false,
  spokenAt: new Map(),
  spokenHints: new Set(),
  speak(text) {
    if (!text || text === this.last) return;
    // The Elder never talks during a battle: stop any line in flight, stay silent.
    if (window.__IN_BATTLE__) {
      this.last = text;
      if (this.current) { this.current.pause(); this.current = null; }
      if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
      return;
    }
    // Silent behind the Game Manager: the Elder starts when the game does.
    // Remember the line so the first-click replay can still say it.
    if (document.getElementById('manager')) { this.last = text; return; }
    // Chapter hint lines (Open Research / Choose Toolmaking) are spoken
    // exactly once per run; the bubble text stays, the voice does not nag.
    const CHAPTER_VOICE_PREFIXES = [
      'Our foundations hold, Chief.', 'Open Research and learn Masonry, Chief.',
      'Raise a Stone Quarry, Chief.', 'Open Research and awaken the Stone Age, Chief.',
      'Bring fire, craft, and trained heroes', 'Build a Copper Smelter, Chief.',
      'Improve a building to its next level, Chief.', 'Finish the Bronze Age research, Chief.',
      'Fill our stores, strengthen our buildings', 'Build a Granary, Chief.',
      'Improve more of our buildings', 'Open Research and learn Irrigation, Chief.',
      'Prepare Tor for the fight', 'Raise Tor\'s level through training, Chief.',
      'Conquer Sabertooth Canyon in the Campaign, Chief.', 'Build a Barracks or a Copper Smelter, Chief.',
      'Gather your best heroes for Shadowclaw, Chief.', 'Defeat Shadowclaw in the Campaign, Chief.',
      'Raise your Empire Score by building',
    ];
    const isHint = text.startsWith('Open Research') || text.startsWith('Choose Basic Toolmaking')
      || text.startsWith('Now raise a Woodcutter')
      || CHAPTER_VOICE_PREFIXES.some((p) => text.startsWith(p));
    if (isHint && this.spokenHints.has(text)) { this.last = text; return; }
    // The Chapter I story line already announces Basic Toolmaking once;
    // the research hint voice must not announce the same research a second
    // time. This guard is only for the two research hints: the Woodcutter
    // announcement must still sound after that story line.
    const isResearchHint = text.startsWith('Open Research, Chief.') || text.startsWith('Choose Basic Toolmaking');
    const storyTold = [...this.spokenAt.keys()].some((t) => t.startsWith('We have shelter and supper'));
    if (isResearchHint && storyTold) { this.last = text; return; }
    // Any other line is not spoken again within 90 seconds.
    const nowMs = performance.now();
    if (nowMs - (this.spokenAt.get(text) || -1e9) < 90000) { this.last = text; return; }
    this.last = text;
    // While audio is locked (no first click yet) do not stamp the line as
    // spoken: the unlock replay must still be able to say it.
    if (!this.unlocked) return;
    this.spokenAt.set(text, nowMs);
    if (window.__SFX_MUTED__ || params.bot || params.replayA || params.replayB) return;
    // Mark a hint as spoken only when it is actually about to play, never
    // while audio was still locked or muted.
    if (isHint) this.spokenHints.add(text);
    // Pre-rendered ElevenLabs lines (scripts/generate_kaelen_voice.py).
    // Until the full set is approved, only the welcome line has a file;
    // any other text falls back to the browser voice below.
    const FILES = [
      ['There you are, Chief. Raise a Small Home before supper', 'kaelen_welcome.mp3'],
      ['A roof overhead, but nothing in the pot.', 'kaelen_onb_02_forager.mp3'],
      ['We have shelter and supper, Chief.', 'kaelen_onb_03_handoff.mp3'],
      ['Time to look beyond our hearths, Chief.', 'kaelen_free_play.mp3'],
      ['The Stone Age is here, Chief.', 'kaelen_achieved.mp3'],
      ['The Bronze Age is ours, Chief.', 'kaelen_bronze.mp3'],
      ['Open Research, Chief.', 'kaelen_hint_research.mp3'],
      ['Choose Basic Toolmaking and learn it, Chief.', 'kaelen_hint_toolmaking.mp3'],
      ['Now raise a Woodcutter, Chief.', 'kaelen_build_woodcutter.mp3'],
      ['Well worked, Chief.', 'kaelen_claim_reward.mp3'],
      ['Our foundations hold, Chief.', 'kaelen_ch2_open.mp3'],
      ['Open Research and learn Masonry, Chief.', 'kaelen_ch2_masonry.mp3'],
      ['Raise a Stone Quarry, Chief.', 'kaelen_ch2_quarry.mp3'],
      ['Open Research and awaken the Stone Age, Chief.', 'kaelen_ch2_stone_age.mp3'],
      ['Bring fire, craft, and trained heroes', 'kaelen_ch3_open.mp3'],
      ['Build a Copper Smelter, Chief.', 'kaelen_ch3_smelter.mp3'],
      ['Improve a building to its next level, Chief.', 'kaelen_ch3_upgrade.mp3'],
      ['Finish the Bronze Age research, Chief.', 'kaelen_ch3_bronze.mp3'],
      ['Fill our stores, strengthen our buildings', 'kaelen_ch4_open.mp3'],
      ['Build a Granary, Chief.', 'kaelen_ch4_granary.mp3'],
      ['Improve more of our buildings', 'kaelen_ch4_upgrade2.mp3'],
      ['Open Research and learn Irrigation, Chief.', 'kaelen_ch4_irrigation.mp3'],
      ['Prepare Tor for the fight', 'kaelen_ch5_open.mp3'],
      ['Raise Tor\'s level through training, Chief.', 'kaelen_ch5_tor.mp3'],
      ['Conquer Sabertooth Canyon in the Campaign, Chief.', 'kaelen_ch5_stage6.mp3'],
      ['Build a Barracks or a Copper Smelter, Chief.', 'kaelen_ch5_barracks.mp3'],
      ['Gather your best heroes for Shadowclaw, Chief.', 'kaelen_ch6_open.mp3'],
      ['Defeat Shadowclaw in the Campaign, Chief.', 'kaelen_ch6_boss.mp3'],
      ['Raise your Empire Score by building', 'kaelen_ch6_score.mp3'],
    ];
    // Dynamic warnings carry numbers that cannot be pre-rendered; the
    // bubble shows them as text and the voice speaks a generic elder line.
    const GENERIC = [
      [/wood/i, 'kaelen_need_wood.mp3'],
      [/stone/i, 'kaelen_need_stone.mp3'],
      [/food/i, 'kaelen_need_food.mp3'],
      [/coin/i, 'kaelen_need_coins.mp3'],
      [/flask|research point/i, 'kaelen_need_rp.mp3'],
      [/scroll/i, 'kaelen_need_scrolls.mp3'],
      [/token/i, 'kaelen_need_tokens.mp3'],
      [/worker/i, 'kaelen_need_worker.mp3'],
      [/locked|learn .* first|research/i, 'kaelen_locked.mp3'],
    ];
    const generic = /need|not enough|no free|spent/i.test(text)
      ? GENERIC.find(([re]) => re.test(text)) : null;
    // Any other Elder text (dynamic task fallbacks, feature lines) still
    // gets a voice: the generic not-ready line, never silence.
    const hit = FILES.find(([prefix]) => text.startsWith(prefix))
      || (generic ? [null, generic[1]] : null)
      || [null, 'kaelen_not_ready.mp3'];
    if (hit) {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      // Never overlap lines: stop the previous line before starting a new one.
      if (this.current) { this.current.pause(); this.current.currentTime = 0; }
      this.current = new Audio(`/static/assets/audio/voice/${hit[1]}?v=3`);
      this.current.volume = this.voiceVolume ?? 0.9;
      this.current.play().catch(() => {});
      return;
    }
    // No pre-rendered line for this text: stay silent. The browser robot
    // voice was removed entirely; Kaelen only speaks real recorded lines.
  },
};
function unlockVoice() {
  // Clicks on the Game Manager do not unlock: audio starts with the game.
  if (document.getElementById('manager')) return;
  window.removeEventListener('pointerdown', unlockVoice);
  kaelenVoice.unlocked = true;
  // First click unlocks audio: replay the line already on screen. It was
  // stamped as spoken while still locked, so clear that stamp first.
  const cur = document.getElementById('advisor-text')?.textContent;
  if (cur && cur === kaelenVoice.last) {
    kaelenVoice.last = '';
    kaelenVoice.spokenAt.delete(cur);
    kaelenVoice.speak(cur);
  }
}
window.addEventListener('pointerdown', unlockVoice);

// The layout is a fixed 1280x540 stage (bots and screenshots rely on it).
// Scale it to fit the window; all game coordinates stay in stage pixels.
// Humans get the map alone (960 wide) with the studio as a slide-out panel;
// bots and replays keep the side dock.
const slideDock = !(params.bot || params.externalBot || params.replayA || params.replayB);
if (slideDock) document.body.classList.add('slide-dock');
const STAGE_W = slideDock ? 960 : 1280;
let uiScale = 1;
function fitToWindow() {
  uiScale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / 540) || 1;
  const left = (window.innerWidth - STAGE_W * uiScale) / 2;
  const top = (window.innerHeight - 540 * uiScale) / 2;
  document.body.style.transform = uiScale === 1 ? '' : `translate(${left}px, ${top}px) scale(${uiScale})`;
}
fitToWindow();
window.addEventListener('resize', fitToWindow);

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

  // Volume menu (sound button): Music / Sounds / Voice sliders, persisted.
  const volumes = (() => {
    try { return { music: 60, sfx: 90, voice: 90, ...JSON.parse(localStorage.getItem('doe_volumes') || '{}') }; }
    catch { return { music: 60, sfx: 90, voice: 90 }; }
  })();
  // Optional calls: a stale cached audio module must never crash the start.
  sfx.setMusicVolume?.(volumes.music / 100);
  sfx.setSfxVolume?.(volumes.sfx / 100);
  kaelenVoice.voiceVolume = volumes.voice / 100;
  const applyVolumes = () => {
    localStorage.setItem('doe_volumes', JSON.stringify(volumes));
    sfx.setMusicVolume?.(volumes.music / 100);
    sfx.setSfxVolume?.(volumes.sfx / 100);
    kaelenVoice.voiceVolume = volumes.voice / 100;
    if (kaelenVoice.current) kaelenVoice.current.volume = kaelenVoice.voiceVolume;
    for (const k of ['music', 'sfx', 'voice']) {
      const el = $(`vol-${k}`);
      if (el) el.value = volumes[k];
      const lab = $(`vol-${k}-val`);
      if (lab) lab.textContent = `${volumes[k]}%`;
    }
  };
  for (const k of ['music', 'sfx', 'voice']) {
    $(`vol-${k}`)?.addEventListener('input', (e) => { volumes[k] = Number(e.target.value); applyVolumes(); });
  }
  applyVolumes();
  // Valley music track choice (volume menu), persisted.
  const trackSel = $('music-track');
  if (trackSel) {
    const saved = localStorage.getItem('doe_music_track');
    // Default (no saved choice): Celtic Humming, first in the list.
    trackSel.value = ['valley', 'valley2', 'valley3', 'valley4'].includes(saved) ? saved : 'valley4';
    sfx.setValleyTrack?.(trackSel.value);
    trackSel.addEventListener('change', () => {
      sfx.setValleyTrack?.(trackSel.value);
      localStorage.setItem('doe_music_track', trackSel.value);
    });
  }
  if (sfx.muted && $('btn_vol_mute')) $('btn_vol_mute').textContent = 'Unmute all';
  // Buildings menu collapse: one button hides the cards, click again expands.
  const buildBar = $('build-bar');
  const buildToggle = $('btn_buildings_toggle');
  if (buildBar && buildToggle) {
    const setCollapsed = (collapsed) => {
      buildBar.classList.toggle('collapsed', collapsed);
      buildToggle.innerHTML = collapsed
        ? '<img class="d-ico-img" src="/static/assets/sprites/icon_hammer.png" alt=""><span class="d-label">Buildings</span><span class="d-chev" aria-hidden="true">&#x25B8;</span>'
        : '<img class="d-ico-img" src="/static/assets/sprites/icon_hammer.png" alt=""><span class="d-label">Buildings</span><span class="d-chev" aria-hidden="true">&#x25BE;</span>';
      localStorage.setItem('doe_build_bar_collapsed', collapsed ? '1' : '0');
    };
    setCollapsed(localStorage.getItem('doe_build_bar_collapsed') === '1');
    // The expanded menu closes itself after 10 idle seconds; any use of the
    // menu (opening it, tapping a filter or card) restarts the timer.
    let buildBarTimer = null;
    const armBuildBarTimer = () => {
      if (buildBarTimer) clearTimeout(buildBarTimer);
      buildBarTimer = null;
      if (buildBar.classList.contains('collapsed')) return;
      buildBarTimer = setTimeout(() => setCollapsed(true), 10000);
    };
    buildBar.addEventListener('pointerdown', armBuildBarTimer);
    buildToggle.addEventListener('click', () => {
      setCollapsed(!buildBar.classList.contains('collapsed'));
      sfx.play('click');
      armBuildBarTimer();
    });
    armBuildBarTimer();
  }
  const hud = new Hud(game, config, sfx);
  const techView = new TechTreeView($('tech-tree'), $('tech-rp'));
  fxHandlers.push((fx) => hud.onFx(fx));

  const root = $('game-root');
  const getTargets = () => renderedTargets(game, renderer, config);
  // HUD panels rebuild their HTML as resources tick. If the button under the pointer is replaced
  // between press and release, the click lands on its parent; fall back to the pressed target.
  let pressed = null;
  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-target]');
    pressed = el ? { target: el.dataset.target, gone: () => !el.isConnected } : null;
  }, true);
  root.addEventListener('click', (e) => {
    // The Buildings toggle has its own listener; never a game click.
    if (e.target.closest('#btn_buildings_toggle')) return;
    const rect = root.getBoundingClientRect();
    const x = (e.clientX - rect.left) / uiScale;
    const y = (e.clientY - rect.top) / uiScale;

    // Handle Build Bar category filter tabs
    const catBtn = e.target.closest('[data-build-cat]');
    if (catBtn) {
      hud.setBuildCategory(catBtn.dataset.buildCat);
      return;
    }

    const el = e.target.closest('[data-target]');
    let target = el ? el.dataset.target : null;
    if (!target && pressed?.gone()) target = pressed.target;
    pressed = null;
    if (!target && (e.target === $('world') || e.target === root)) target = renderer.hitTest(game, x, y)?.target_id || null;
    if (!target && e.target.classList.contains('modal-backdrop')) target = targetBelow(e.target, e.clientX, e.clientY, game, renderer, x, y);

    // Slider drags inside the volume menu must not click through to the game.
    if (e.target.closest('#volume-menu') && target !== 'btn_vol_mute') return;
    if (target !== 'btn_mute' && !e.target.closest('#volume-menu')) {
      const menu = $('volume-menu');
      if (menu) menu.hidden = true;
    }

    const outcome = game.click(target || 'empty', x, y);
    if (target === 'btn_mute') {
      const menu = $('volume-menu');
      if (menu) menu.hidden = !menu.hidden;
    }
    if (target === 'btn_vol_mute') {
      sfx.toggle();
      const b = $('btn_vol_mute');
      if (b) b.textContent = sfx.muted ? 'Unmute all' : 'Mute all';
      if (kaelenVoice.current) { kaelenVoice.current.pause(); kaelenVoice.current = null; }
    }
    // The four dock buttons and research nodes have their own sounds.
    const MENU_SOUNDS = {
      btn_heroes: 'dock_heroes', btn_expedition: 'dock_campaign',
      btn_research: 'dock_research', btn_upgrades: 'dock_upgrades',
    };
    if (outcome.result === 'rejected') sfx.play('reject');
    if (outcome.result === 'rejected' && target?.startsWith('tech_')) techView.flashRejected(target, game);
    else if (outcome.result === 'rejected' && target?.startsWith('btn_feature_')) hud.featureRejected();
    else if (MENU_SOUNDS[target]) sfx.play(MENU_SOUNDS[target]);
    else if (target?.startsWith('btn_close_')) sfx.play('modal_close');
    else if (target?.startsWith('tech_') && outcome.result !== 'rejected') sfx.play('research_select');
    else if (outcome.result === 'ui' && target !== 'btn_mute' && target !== 'btn_vol_mute') sfx.play('click');
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
    activateFeature: (plugin) => hud.activateFeature(plugin),
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
    pending_placement: game.pendingPlacement
      ? { type: game.pendingPlacement.type, pad_id: game.pendingPlacement.padId } : null,
    selected_building: game.selectedBuilding,
    achieved: game.achieved,
    bronze_achieved: game.bronzeAchieved,
    quest_index: game.questIndex,
    quest_claimable: game.questClaimable,
    expedition_unlocked: game.expeditionUnlocked(),
    heroes_unlocked: game.heroesUnlocked(),
    squad_power: game.squadPower(),
    heroes: Object.fromEntries(Object.entries(game.heroes).map(([k, v]) => [k, { level: v.level, unlocked: v.unlocked, power: game.heroStats(k).power }])),
    battle_active: !!(game.battleState && game.battleState.active),
    battle_selected: game.battleState?.selectedUnit || null,
    battle_turn: game.battleState?.turn || null,
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
  const cx = rect.left + x * uiScale;
  const cy = rect.top + y * uiScale;
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
    const x = (r.left - rect.left) / uiScale;
    const y = (r.top - rect.top) / uiScale;
    const w = r.width / uiScale;
    const h = r.height / uiScale;
    if (!w || !h) continue;
    const id = el.dataset.target;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const visible = onScreen(x, y, w, h) && !!hit && el.contains(hit);
    const t = {
      target_id: id, kind: kindOf(id), x: round1(x), y: round1(y), w: round1(w), h: round1(h),
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
    const cx = rect.left + (w.x + w.w / 2) * uiScale;
    const cy = rect.top + (w.y + w.h / 2) * uiScale;
    const visible = onScreen(w.x, w.y, w.w, w.h) && document.elementFromPoint(cx, cy) === canvas
      && renderer.hitTest(game, w.x + w.w / 2, w.y + w.h / 2)?.target_id === w.target_id;
    out.push({
      ...w, x: round1(w.x), y: round1(w.y), visible, locked: false,
      affordable: w.kind === 'pad' ? !!game.selectedCard : ((w.kind === 'upgrade' || w.kind === 'battle_hero') ? w.affordable : true),
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
  military: ['barracks', 'hero_arena'],
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
      <button class="card" data-target="card_${type}" data-btype="${type}" title="${BUILDINGS[type].label}">
        <img src="${spriteUrl(type)}" alt="">
        <span class="c-name">${BUILDINGS[type].label}</span>
        <span class="c-cost"></span>
        <span class="c-lock" hidden></span>
      </button>`).join('');
    requestAnimationFrame(() => this.fitCardNames());
    if (!this.fitBound) { this.fitBound = true; addEventListener('resize', () => this.fitCardNames(true)); }
  }

  // Long names ("Sacred Obelisk") overflow the card; shrink each one until it fits on a single line.
  // Hidden cards have no width, so they are fitted later, the first time they show.
  fitCardNames(refit = false) {
    for (const n of document.querySelectorAll('#cards .c-name')) {
      if (n.dataset.fit && !refit) continue;
      const room = n.parentElement.clientWidth - 6;
      if (room <= 0) continue;
      n.dataset.fit = '1';
      n.style.fontSize = '';
      let size = parseFloat(getComputedStyle(n).fontSize);
      while (n.scrollWidth > room && size > 6) n.style.fontSize = `${(size -= 0.5)}px`;
    }
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
      // A proper campaign map: stage medallions on a winding trail over the
      // painted province backdrop, not a grid of cards.
      const POS = [[9, 70], [21, 30], [34, 68], [47, 28], [60, 66], [72, 27], [84, 62], [92, 22]];
      const trail = POS.map(([x, y]) => `${x},${y}`).join(' ');
      grid.innerHTML = `<svg class="map-trail" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points="${trail}" fill="none" stroke="rgba(90,55,20,0.55)" stroke-width="3" stroke-dasharray="1 7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
          <polyline points="${trail}" fill="none" stroke="rgba(255,240,200,0.8)" stroke-width="3" stroke-dasharray="1 7" stroke-linecap="round" vector-effect="non-scaling-stroke" transform="translate(0.35,0.5)"/>
        </svg>`
        + CAMPAIGN_STAGES.map((s, i) => `
        <button class="map-node ${s.reqPower ? 'level-check' : ''} ${i === CAMPAIGN_STAGES.length - 1 ? 'boss' : ''} ${POS[i][0] <= 12 ? 'edge-l' : ''} ${POS[i][0] >= 85 ? 'edge-r' : ''}" data-target="${s.legacyId || s.id}" id="stage-card-${s.id}"
                style="left:${POS[i][0]}%;top:${POS[i][1]}%" title="${s.name} — ${s.enemies}, Power ${s.enemyPower}, Loot: ${costText(s.reward)}">
          <span class="node-stars" id="stars-${s.id}">☆☆☆</span>
          <span class="node-medal">${i + 1}</span>
          <span class="node-label"><b>${s.name.replace(/^\d+\.\s*/, '').replace(/^BOSS:\s*/, '')}</b><small>${s.enemies} · ⚔️ ${s.enemyPower}</small></span>
          <span class="node-tap-hint">⚡ Tap to Battle</span>
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
    // Show a resource only once it matters: coins only paid for map expansions,
    // stone arrives with Masonry, hero scrolls with the Hero Roster.
    $('res-coins').hidden = true;
    $('res-stone').hidden = !(res.stone > 0 || g.techs.has('tech_masonry'));
    $('res-scrolls').hidden = !g.heroesUnlocked();

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

    if ($('btn_speed').textContent !== `${g.clock.speed}x`) $('btn_speed').textContent = `${g.clock.speed}x`;
    $('era-name').textContent = ERA_LABEL[g.era];
    $('era-banner').classList.toggle('stone', g.era !== 'dawn_age');
    $('era-banner').classList.toggle('bronze', g.era === 'bronze_age');

    window.__IN_BATTLE__ = !!(g.battleState && (g.battleState.active || g.battleState.outcome));
    const text = g.advisorText();
    if ($('advisor-text').textContent !== text) {
      $('advisor-text').textContent = text;
      kaelenVoice.speak(text);
      // A new Elder message shows the bubble again and restarts its timer.
      this.advisorShownAt = performance.now();
      $('advisor').classList.remove('elder-gone');
    }
    // The Elder's last message leaves the screen after 15 seconds; the next
    // new message brings the bubble back. The timer holds while a menu is
    // open, so a message announced behind a menu is still there at close.
    if (g.modal) this.advisorShownAt = performance.now();
    if (this.advisorShownAt && performance.now() - this.advisorShownAt > 15000) {
      $('advisor').classList.add('elder-gone');
    }
    if (window.__SFX_MUTED__) {
      if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
      if (kaelenVoice.current) { kaelenVoice.current.pause(); kaelenVoice.current = null; }
    }
    $('advisor').querySelector('.bubble').classList.toggle('hinting', !!g.hint);

    const mood = g.advisorMood();
    if (mood !== this.portrait) {
      this.portrait = mood;
      $('advisor-portrait').src = `/static/assets/sprites/advisor_${mood}.png`;
      $('advisor').classList.toggle('hint', mood === 'hint');
    }

    // Rewrite the icon only when it changes: replacing it every frame swallows real clicks.
    const muteIcon = this.sfx.muted ? '\u{1F507}' : '\u{1F50A}';
    if ($('btn_mute').textContent !== muteIcon) $('btn_mute').textContent = muteIcon;
    $('btn_mute').classList.toggle('on', !this.sfx.muted);
    window.__SFX_MUTED__ = this.sfx.muted;

    // Modals
    $('welcome-modal').hidden = g.modal !== 'welcome';
    $('research-modal').hidden = g.modal !== 'research';
    $('expedition-modal').hidden = g.modal !== 'expedition';
    $('heroes-modal').hidden = g.modal !== 'heroes';
    $('quests-modal').hidden = g.modal !== 'quests';
    $('upgrades-modal').hidden = g.modal !== 'upgrades';
    $('prebattle-modal').hidden = g.modal !== 'prebattle';

    // Action Dock
    $('btn_heroes').hidden = !g.heroesUnlocked();
    $('btn_expedition').hidden = !g.expeditionUnlocked();

    if (g.feature) this.updateFeatureCard();
    this.updateQuest();
    if (g.modal === 'expedition') this.updateCampaignModal();
    if (g.modal === 'heroes') this.updateHeroesModal();
    if (g.modal === 'quests') this.updateQuestsModal();
    if (g.modal === 'upgrades') this.updateUpgradesModal();
    if (g.modal === 'prebattle') this.updatePreBattleModal();
    this.updateBuildingDrawer();
    this.updateBattleHud();
    // In battle the city UI (build bar, dock, advisor, quests) leaves the screen.
    const inBattle = !!(g.battleState && (g.battleState.active || g.battleState.outcome));
    for (const id of ['hud', 'build-bar', 'action-dock', 'advisor', 'quest-card']) {
      const el = $(id);
      if (el) el.hidden = inBattle;
    }
    this.updateCards();
    this.updateArrow();
    if (this.inspectorOn) this.placeInspectTags();

    // Era-up fanfare and battle outcome stings, once per transition.
    if (this.lastEra && g.era !== this.lastEra) this.sfx.play('era_up');
    this.lastEra = g.era;
    const outcome = g.battleState?.outcome || null;
    if (outcome && this.battleOutcomeSeen !== outcome) this.sfx.play(outcome);
    this.battleOutcomeSeen = outcome;

    // Sfx music switcher
    this.sfx.setMusicTheme?.(g.battleState?.active ? 'battle' : 'valley');
  }

  // Separate upgrade menu: every standing building that can grow, its next
  // level and cost. The on-building chip stays for one-tap upgrades.
  updateUpgradesModal() {
    const g = this.game;
    const rows = g.buildings.filter((b) => b.status === 'done' && UPGRADABLE_TYPES.includes(b.type));
    const sig = JSON.stringify(rows.map((b) => [b.key, b.level, g.upgradeStatus(b).affordable, g.upgradeStatus(b).available])
      .concat([g.roundedResources(), [...g.techs]]));
    if (sig === this.upgradeSig) return;
    this.upgradeSig = sig;
    const costText = (costs) => Object.entries(costs || {}).filter(([, v]) => v > 0)
      .map(([r, v]) => `${v} ${RESOURCE_LABEL[r]}`).join(' · ');
    $('upgrade-list').innerHTML = rows.length ? rows.map((b) => {
      const st = g.upgradeStatus(b);
      const name = BUILDINGS[b.type].label;
      if (st.reason === 'max_level') {
        return `<div class="upgrade-row"><span class="u-name">${name} <small>Lv.${b.level}</small></span><span class="u-state">Max level</span></div>`;
      }
      if (!st.available) {
        return `<div class="upgrade-row"><span class="u-name">${name} <small>Lv.${b.level}</small></span><span class="u-state">🔒 Learn ${TECHS[st.requires].label} first</span></div>`;
      }
      const btn = st.affordable
        ? `<button class="gold-btn" data-target="upgrade_${b.key}">Upgrade · ${costText(st.costs)}</button>`
        : `<span class="u-state">Need ${costText(st.costs)}</span>`;
      return `<div class="upgrade-row"><span class="u-name">${name} <small>Lv.${b.level} → Lv.${(b.level || 1) + 1}</small></span>${btn}</div>`;
    }).join('') : '<p class="u-empty">No buildings yet. Build something first.</p>';
  }

  // Building drawer (HoH production inspector): tap a building to see what
  // it makes, toggle its worker, or upgrade it. Reuses worker_/upgrade_ taps.
  updateBuildingDrawer() {
    const g = this.game;
    const el = $('building-drawer');
    if (!el) return;
    const b = g.buildings.find((x) => x.key === g.selectedBuilding);
    if (!b || g.modal || (g.battleState && g.battleState.active)) { el.hidden = true; this.drawerSig = null; return; }
    el.hidden = false;
    const spec = BUILDINGS[b.type];
    const SPECIALS = {
      town_center: { label: 'Great Hall', blurb: 'Heart of the tribe. Grows with every era.' },
      research_tent: { label: 'Research Tent', blurb: 'Where the tribe learns new knowledge.' },
    };
    const name = spec?.label || SPECIALS[b.type]?.label || b.type;
    const blurb = spec?.blurb || SPECIALS[b.type]?.blurb || '';
    const spriteKey = b.type === 'town_center'
      ? (g.era === 'bronze_age' ? 'town_center_bronze_age' : g.era === 'stone_age' ? 'town_center_stone_age' : 'town_center')
      : b.type;
    let status;
    if (b.status === 'building') status = '🔨 Under construction…';
    else if (b.ready) status = `✅ Ready: tap the building to collect ${spec?.produces || ''}`;
    else if (b.blockedReason) status = `⚠️ ${b.blockedReason}`;
    else if (spec?.produces) status = `⚙️ Producing ${RESOURCE_LABEL[spec.produces] || spec.produces} · ${Math.round(g.productionProgress(b) * 100)}%`;
    else if (b.type === 'research_tent') status = `${g.techs.size} of ${Object.keys(TECHS).length} discoveries learned`;
    else if (b.type === 'town_center') status = `${ERA_LABEL[g.era]} · Score ${g.score}`;
    else status = 'Standing ready';
    const costText = (costs) => Object.entries(costs || {}).filter(([, v]) => v > 0)
      .map(([r, v]) => `${v} ${RESOURCE_LABEL[r]}`).join(' · ');
    let actions = '';
    if (b.status === 'done' && spec?.produces && g.workersPerBuilding > 0) {
      actions += b.worker
        ? `<button class="gold-btn" data-target="worker_${b.key}">👷 Worker assigned (tap to unassign)</button>`
        : `<button class="gold-btn" data-target="worker_${b.key}">👷 Assign worker (${g.workersFree} free)</button>`;
    }
    if (b.status === 'done' && UPGRADABLE_TYPES.includes(b.type)) {
      const st = g.upgradeStatus(b);
      if (st.available && st.affordable) actions += `<button class="gold-btn" data-target="upgrade_${b.key}">⬆ Upgrade to Lv.${st.level + 1} · ${costText(st.costs)}</button>`;
      else if (st.available) actions += `<span class="u-state">Upgrade needs ${costText(st.costs)}</span>`;
      else if (st.requires) actions += `<span class="u-state">🔒 Upgrade: learn ${TECHS[st.requires]?.label || st.requires} first</span>`;
    }
    if (b.type === 'research_tent' && b.status === 'done') {
      actions += `<button class="gold-btn" data-target="btn_research">🔬 Open Research</button>`;
    }
    const sig = JSON.stringify([b.key, b.level, b.status, b.ready, b.worker, b.blockedReason,
      Math.floor(g.productionProgress(b) * 20), g.workersFree, g.upgradeStatus(b).affordable, g.techs.size, g.score]);
    if (sig === this.drawerSig) return;
    this.drawerSig = sig;
    el.innerHTML = `<div class="bd-thumb"><img src="${spriteUrl(spriteKey)}" alt="" onerror="this.parentNode.style.display='none'"></div>`
      + `<div class="bd-main"><div class="bd-head"><b>${name} <small class="bd-lv">Lv.${b.level || 1}</small></b>`
      + `<button class="close-btn" data-target="btn_close_drawer" title="Close">&times;</button></div>`
      + (blurb ? `<div class="bd-blurb">${blurb}</div>` : '')
      + `<div class="bd-status">${status}</div><div class="bd-actions">${actions}</div></div>`;
  }

  // Pre-battle screen: enemy, power check, rewards, cost, and deployment.
  updatePreBattleModal() {
    const g = this.game;
    const pb = g.preBattle;
    if (!pb) return;
    const stage = CAMPAIGN_STAGES.find((s) => s.id === pb.stageId);
    if (!stage) return;
    const costText = (costs) => Object.entries(costs || {}).filter(([, v]) => v > 0)
      .map(([r, v]) => `${v} ${RESOURCE_LABEL[r]}`).join(' · ');
    $('prebattle-title').textContent = stage.name;
    $('prebattle-enemies').textContent = `${stage.enemies} · ${stage.waves} wave${stage.waves > 1 ? 's' : ''}`;
    $('prebattle-enemy-power').textContent = stage.enemyPower;
    const deployedPower = pb.deployed.reduce((n, id) => n + g.heroStats(id).power, 0);
    $('prebattle-squad-power').textContent = deployedPower;
    const verdict = $('prebattle-verdict');
    const enough = deployedPower >= (stage.reqPower || stage.enemyPower);
    verdict.textContent = enough ? '✓ Your squad is ready' : `⚠️ Recommended power ${stage.reqPower || stage.enemyPower}`;
    verdict.style.color = enough ? '#2f6a1a' : '#b03a1e';
    $('prebattle-rewards').textContent = costText(stage.reward);
    $('prebattle-cost').textContent = costText(g.expeditionCosts());
    const slotsEl = $('prebattle-slots');
    if (slotsEl) slotsEl.textContent = `Deployment: ${pb.deployed.length}/${stage.slots || 1} heroes`;
    const sig = JSON.stringify([pb.stageId, pb.deployed, Object.values(g.heroes).map((h) => h.unlocked)]);
    if (sig !== this.pbSig) {
      this.pbSig = sig;
      $('prebattle-deploy').innerHTML = ['aurelius', 'vaelen', 'lyra', 'ignis'].filter((id) => g.heroes[id]).map((id) => {
        const h = g.heroes[id];
        const on = pb.deployed.includes(id);
        return `<button class="pb-hero ${on ? 'on' : ''}" data-target="btn_deploy_${id}" ${h.unlocked ? '' : 'disabled'}>
          <img src="/static/assets/sprites/${h.portrait}.png" alt="" onerror="this.src='/static/assets/sprites/advisor_welcome.png'">
          <span>${h.name.split(' ')[0]} <small>Lv.${h.level} · ⚔️ ${g.heroStats(id).power}</small></span>
          <em>${h.unlocked ? (on ? '⚔️ Deployed' : 'Tap to deploy') : '🔒 Locked'}</em>
        </button>`;
      }).join('');
    }
    $('btn_fight').disabled = !pb.deployed.length;
  }

  updateCards() {
    const g = this.game;
    const res = g.roundedResources();
    const sig = JSON.stringify([res, g.selectedCard, [...g.techs], g.stepIndex, g.workersFree, this.buildCategory]);
    if (sig === this.sig) return;
    this.sig = sig;
    requestAnimationFrame(() => this.fitCardNames());

    const allowed = CATEGORY_MAP[this.buildCategory] || null;

    for (const type of ALL_BUILD_ORDER) {
      const el = document.querySelector(`[data-target="card_${type}"]`);
      if (!el) continue;
      if (allowed && !allowed.includes(type)) {
        el.hidden = true;
        continue;
      }
      // Only the Barracks joins the All view; the Arena stays Military-only.
      if (type === 'hero_arena' && this.buildCategory === 'all') {
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
      // No NEW! ribbon on build cards.
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
    // The Elder announces a finished chapter once, when Claim appears.
    if (g.questClaimable && !this.wasClaimable) {
      kaelenVoice.speak('Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it.');
    }
    this.wasClaimable = g.questClaimable;
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
      const earned = (g.stageStars && (g.stageStars[s.id] || (s.legacyId && g.stageStars[s.legacyId]))) || 0;
      if (starsEl) starsEl.textContent = cleared ? '⭐'.repeat(earned || 3) + '☆'.repeat(3 - (earned || 3)) : '☆☆☆';
      const hintEl = card.querySelector('.node-tap-hint');
      if (hintEl) hintEl.textContent = cleared ? '✅ Cleared' : (s.reqPower && g.squadPower() < s.reqPower ? `⚠️ Power: ${g.squadPower()}/${s.reqPower}` : '⚡ Tap to Battle');
      // Declutter: only the next uncleared stage shows its hint pill; the
      // rest keep just medal and label.
      const nextStage = CAMPAIGN_STAGES.find((x) => !(g.encountersCleared.has(x.id) || (x.legacyId && g.encountersCleared.has(x.legacyId))));
      card.classList.toggle('is-next', !!nextStage && s.id === nextStage.id);
      card.classList.toggle('power-warn', !cleared && !!s.reqPower && g.squadPower() < s.reqPower);
    }
  }

  updateHeroesModal() {
    const g = this.game;
    $('heroes-total-power').textContent = g.squadPower();

    // Roster list. Rebuild only when it actually changes: rebuilding every
    // frame replaces the buttons under the pointer and swallows their clicks.
    const rosterEl = $('heroes-roster');
    const rosterSig = JSON.stringify(Object.values(g.heroes)
      .map((h) => [h.id, h.level, h.unlocked, g.selectedHero === h.id, g.heroStats(h.id).power]));
    if (rosterEl && rosterSig !== this.rosterSig) {
      this.rosterSig = rosterSig;
      // Tor the Stone-Breaker leads the roster list.
      const rosterOrder = [...Object.values(g.heroes)].sort((a, b) => (b.id === 'aurelius') - (a.id === 'aurelius'));
      rosterEl.innerHTML = rosterOrder.map((h) => {
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

    const training = g.heroTraining;
    // Training needs the Heroes' Arena standing. Say so on the button
    // itself: a ready-looking button whose refusal hides behind this
    // modal reads as a dead button.
    const arena = g.buildings.find((b) => b.type === 'hero_arena' && b.status === 'done');
    const canUpgrade = sel.unlocked && sel.level < sel.maxLevel && g.resources.food >= costFood && !training && !!arena;
    const lvlBtn = $('btn_hero_levelup');
    if (lvlBtn) {
      lvlBtn.disabled = !canUpgrade;
      lvlBtn.textContent = training
        ? `⚔️ Training at the Arena… ${Math.max(0, Math.ceil(training.completeAt - g.clock.t))}s`
        : sel.level >= sel.maxLevel ? 'Max Rank'
        : !arena ? '⚔️ Train at Arena · Build the Heroes\' Arena first (needs Barracks)'
        : `⚔️ Train at Arena · Lv.${sel.level + 1} (+15 Score)`;
    }
    if (!arena && !training) {
      $('hero-upgrade-cost').textContent += ' · Heroes\' Arena not built yet';
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

    const turnEl = $('battle-turn-text');
    if (turnEl) {
      const activeUnit = bs.units?.find((u) => u.id === bs.selectedUnit);
      turnEl.textContent = bs.outcome ? 'Battle over'
        : bs.selectedUnit ? `${(g.heroes[bs.selectedUnit]?.name || 'Hero').split(' ')[0]}'s turn — move ${activeUnit?.moveLeft ?? 0}, then attack`
        : `Round ${bs.round || 1}`;
    }
    const logEl = $('battle-log');
    // Only the latest battle line: the full log stacked pills over the bars.
    if (logEl) logEl.textContent = (bs.log || []).slice(-1)[0] || '';

    // Initiative strip: who acts next this round, fastest first.
    const initEl = $('battle-initiative');
    if (initEl) {
      const nameOf = (ref) => ref.kind === 'hero'
        ? (bs.units.find((u) => u.id === ref.id)?.name || ref.id).split(' ')[0]
        : (bs.enemies[ref.idx]?.name || 'Enemy');
      initEl.innerHTML = (bs.queue || []).map((ref, i) =>
        `<span class="init-chip ${i === 0 ? 'now' : ''} ${ref.kind}">${i + 1}. ${nameOf(ref)}</span>`).join('');
    }
    const waveBtn = $('btn_battle_wave_continue');
    if (waveBtn) waveBtn.hidden = !bs.awaitingWave;

    // No hero cards on the battle screen: charge shows on the canvas bar
    // under the active hero, and tapping that hero at full charge fires it.

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
      const starsEl = $('victory-stars');
      if (starsEl) starsEl.textContent = '⭐'.repeat(bs.stars || 3) + '☆'.repeat(3 - (bs.stars || 3));
      const lootEl = $('victory-loot');
      if (lootEl && bs.stage?.reward) {
        lootEl.innerHTML = Object.entries(bs.stage.reward)
          .map(([r, a]) => `<span class="loot-pill">+${a} ${RESOURCE_LABEL[r] || r}</span>`).join(' ');
      }
    } else if (bs.outcome === 'defeat') {
      vicModal.hidden = true;
      defModal.hidden = false;
      const desc = $('defeat-desc');
      if (desc && bs.stage) {
        desc.innerHTML = `${bs.stage.enemies} broke through on wave ${bs.wave || 1}/${bs.totalWaves || 1}! `
          + `Recommended Combat Power: <b>${bs.stage.reqPower || bs.stage.enemyPower}</b>. Your squad: <b>${g.squadPower()}</b>.`;
      }
    } else {
      vicModal.hidden = true;
      defModal.hidden = true;
    }
  }

  // A human-approved feature switches on in the open game; it shows once its unlock step is reached.
  activateFeature(f) {
    const g = this.game;
    g.config.feature_plugin = f;
    g.featureUses = 0;
    g.featureReadyAt = 0;
    this.featureEl?.remove();
    this.featureSig = '';
    this.buildFeatureCard(f);
    this.toast(`${f.title} is live`, g.featureUnlocked() ? 'Find its button in your village.'
      : `It unlocks ${f.unlock_at_step === 'free_play' ? 'after the tutorial' : 'at its tutorial step'}.`);
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

  // A refused feature click shakes the card and says why, so it never feels dead.
  featureRejected() {
    const g = this.game;
    const st = g.featureStatus();
    const el = this.featureEl;
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    // The shake replaces the pulse animation, so drop it again once it ends.
    el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
    if (st.cooldown) this.toast(`${g.feature.title} is recharging`, `Ready in ${Math.ceil(st.cooldown)}s.`);
    else if (st.missing) {
      const m = st.missing;
      this.toast(`Not enough ${RESOURCE_LABEL[m.resource] || m.resource}`,
        `${g.feature.title} needs ${m.required} · you have ${Math.floor(m.available)}.`);
    }
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
    if (!t) {
      // A building card hidden inside the collapsed Buildings menu cannot be
      // pointed at: point at the Buildings toggle instead, so the player
      // opens the menu first.
      const toggle = $('btn_buildings_toggle');
      if (id.startsWith('card_') && toggle && $('build-bar')?.classList.contains('collapsed')) {
        const root = $('game-root').getBoundingClientRect();
        const r = toggle.getBoundingClientRect();
        arrow.hidden = false;
        arrow.style.left = `${(r.left - root.left) / uiScale + r.width / uiScale / 2 - 8}px`;
        arrow.style.top = `${Math.max(46, (r.top - root.top) / uiScale - 30)}px`;
        return;
      }
      arrow.hidden = true; return;
    }
    arrow.hidden = false;
    // On a building the hand points at the collect bubble from its upper
    // left, so the finger never covers the resource icon inside it.
    const onBuilding = t.kind === 'building';
    arrow.style.left = `${t.x + t.w / 2 - (onBuilding ? 30 : 8)}px`;
    arrow.style.top = `${Math.max(46, t.y - (onBuilding ? 52 : 30))}px`;
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
      const left = Math.min(960 - tag.offsetWidth - 4, Math.max(4, (r.left - rootRect.left) / uiScale));
      const above = (r.top - rootRect.top) / uiScale - 18;
      tag.style.left = `${left}px`;
      tag.style.top = `${above < 46 ? (r.bottom - rootRect.top) / uiScale + 4 : above}px`;
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
