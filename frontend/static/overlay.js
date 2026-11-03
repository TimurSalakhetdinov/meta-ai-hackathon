// #right-dock: the Architect's Council, an in-world AI playtest studio.
//
// Feature Forge turns a PM's free-text idea into a validated FeaturePlugin
// patch behind the human approval gate. Council Report shows the paired A/B
// verdict, or the analyst's onboarding diagnosis when no feature has been
// playtested. Live Chronicle streams events and bot think-aloud.
//
// Every number shown here comes from the game's own events or from the
// backend (server-derived stuck events, analyst output, A/B summaries). When a
// source does not exist yet, the dock says so instead of showing a value.

import { StubBot } from './stub_bot.js';

const PATCH_ID = 'patch_001';
const POLL_MS = 1000;
const JOB_POLL_MS = 1500;
const STREAM_MAX = 80;
const TABS = ['forge', 'report', 'live'];
const RES_ICON = { food: '\u{1F35E}', wood: '\u{1FAB5}', stone: '\u{1FAA8}', rp: '\u{1F4DC}', score: '⭐' };
const MOOD_ICON = { frustrated: '\u{1F624}', confused: '\u{1F914}', engaged: '\u{1F525}', curious: '\u{1F9D0}', bored: '\u{1F634}' };
const STEP_LABEL = { onb_01_shelter: 'Step 1 · Shelter', onb_02_forager: 'Step 2 · Forager',
  onb_03_handoff: 'Step 3 · Handoff', free_play: 'After the tutorial' };

const STEPS = [[1, 'Forge'], [2, 'Approve'], [3, 'Playtest'], [4, 'Report']];

export function initOverlay(ctx) {
  const dock = ctx.dock;
  // Humans get a slide-out panel over the map; bots keep the fixed side dock.
  const slide = document.body.classList.contains('slide-dock');
  dock.innerHTML = `
    <div class="council-head">
      <div class="council-title"><span class="crest-gem">✦</span> AI Playtest Studio</div>
      <button class="mgr-justplay" id="mgr-back" title="Back to the Main Menu">← Main Menu</button>
    </div>
    <div class="pill" id="pill">
      <div class="pill-row"><span class="step" id="pill-step">-</span>
        <span class="muted" title="Stuck events the server detected in this session">Stuck <span class="stuck-count" id="pill-stuck">0</span></span></div>
      <div class="pill-row"><span class="checklist" id="pill-check"></span><span class="muted">First click <b id="pill-ttfa">-</b> · Left <b id="pill-left">-</b></span></div>
    </div>
    <nav class="stepper" id="stepper" aria-label="Studio steps">
      ${(ctx.params.flow === 'bug' || ctx.params.bot || ctx.params.externalBot)
        ? '<button class="step-btn" data-bugstep="live"><b>1</b>Bug hunting</button><button class="step-btn" data-bugstep="report"><b>2</b>Report</button><button class="step-btn hunt-stop" id="hunt-stop"><b>■</b>Stop bot</button>'
        : STEPS.map(([n, label]) => `<button class="step-btn" data-step="${n}"><b>${n}</b>${label}</button>`).join('')}
    </nav>
    <div class="director" id="director">
      <div class="tab-body" id="tab-forge"></div>
      <div class="tab-body" id="tab-report" hidden></div>
      <div class="tab-body" id="tab-live" hidden></div>
    </div>
    <button class="live-link" id="live-link">\u{1F441}️ Live event stream</button>`;

  const ui = new Overlay(ctx);
  if (slide) {
    const toggle = document.createElement('button');
    toggle.id = 'council-toggle';
    toggle.innerHTML = '<span>✦</span> AI Studio';
    toggle.title = 'Open the AI Playtest Studio';
    document.getElementById('app').appendChild(toggle);
    const setOpen = (open) => {
      dock.classList.add('anim');
      dock.classList.toggle('open', open);
      toggle.hidden = open;
    };
    toggle.addEventListener('click', () => setOpen(true));
    // Slim arrow on the Studio's left edge: closes it to the right.
    const collapse = document.createElement('button');
    collapse.className = 'dock-collapse';
    collapse.textContent = '›';
    collapse.title = 'Close the AI Playtest Studio';
    collapse.setAttribute('aria-label', 'Close the AI Playtest Studio');
    collapse.addEventListener('click', () => setOpen(false));
    dock.appendChild(collapse);
    ui.setOpen = setOpen;
    if (ctx.params.dock || ctx.blocked) setOpen(true);
    // A plain visit opens on the Game Manager menu; links with a variant, patch or dock go straight in.
    const q = new URLSearchParams(location.search);
    if (!['variant', 'patch_id', 'dock', 'play', 'reportfull'].some((k) => q.has(k))) ui.openManager();
  } else if (ctx.params.watch || ctx.params.bot || ctx.params.externalBot) {
    // Bot screens keep the fixed dock, but it closes the same way: the
    // arrow hides it and the yellow AI Studio tab brings it back.
    const toggle = document.createElement('button');
    toggle.id = 'council-toggle';
    toggle.innerHTML = '<span>✦</span> AI Studio';
    toggle.title = 'Open the AI Playtest Studio';
    toggle.hidden = true;
    document.getElementById('app').appendChild(toggle);
    const setBotOpen = (open) => {
      document.body.classList.toggle('dock-closed', !open);
      dock.style.display = open ? '' : 'none';
      toggle.hidden = open;
      const ws = document.getElementById('watch-screen');
      if (ws) ws.style.width = open ? '' : '1280px';
    };
    toggle.addEventListener('click', () => setBotOpen(true));
    const collapse = document.createElement('button');
    collapse.className = 'dock-collapse';
    collapse.textContent = '›';
    collapse.title = 'Close the AI Playtest Studio';
    collapse.setAttribute('aria-label', 'Close the AI Playtest Studio');
    collapse.addEventListener('click', () => setBotOpen(false));
    dock.appendChild(collapse);
  }
  return { update: () => ui.update() };
}

class Overlay {
  constructor(ctx) {
    this.ctx = ctx;
    this.game = ctx.game;
    this.stuckEvents = 0;
    this.liveNext = 0;
    this.botNext = 0;
    this.seenEvents = 0;
    this.bot = null;
    this.personas = [];
    this.lastPillSig = '';
    this.feature = null;
    this.chosen = new Set();
    this.job = null;
    // Emblem source per patch_id. Only a Muse Image emblem is labelled as one.
    this.emblemSource = {};

    this.step = 1;
    this.tab = 'forge';
    this.slide = document.body.classList.contains('slide-dock');
    // The stepper is a progress indicator, not navigation: steps advance
    // only through the panel actions (forge, approve, run playtest).
    document.getElementById('live-link').addEventListener('click', () => this.showTab('live'));
    // Back to the Game Manager menu: a plain visit opens it.
    document.getElementById('mgr-back')?.addEventListener('click', () => { location.href = '/'; });
    // Bug-hunt sessions get a two-step Studio: watch the hunt, then the Report.
    this.bugMode = !!(ctx.params.flow === 'bug' || ctx.params.bot || ctx.params.externalBot);
    // A fresh bug hunt starts on step 1; Report unlocks only when it ends.
    this.huntDone = false;
    // Meta hunts run for the chosen play time (minutes x speed, in sim
    // seconds); without a choice the runner's sim window applies.
    if (ctx.params.watch) this.botBudgetSec = ctx.params.playMin
      ? ctx.params.playMin * 60 * (ctx.params.speed || 1) : 1200;
    if (this.bugMode) {
      document.getElementById('live-link').hidden = true;
      document.querySelectorAll('#stepper [data-bugstep]').forEach((b) =>
        b.addEventListener('click', () => this.showTab(b.dataset.bugstep)));
      document.getElementById('hunt-stop')?.addEventListener('click', () => this.stopHunt());
    }

    this.personasReady = fetch('/api/personas').then((r) => r.json()).catch(() => []).then((rows) => {
      // Nobody starts selected: a click always means "add this playtester".
      this.personas = rows;
      return rows;
    });
    this.presetsReady = fetch('/api/feature_studio/presets').then((r) => r.json()).catch(() => [])
      .then((rows) => { this.presets = rows; });
    this.renderLive();
    this.renderForge();
    if (ctx.telemetry) ctx.telemetry.listeners.push((ev) => this.onEvent(ev));
    if (this.game || ctx.params.watch) setInterval(() => this.poll(), POLL_MS);
    if (ctx.params.ab) {
      // A/B session watch: just the bot playing, no Forge or Bug hunting steps.
      const stepperEl = document.getElementById('stepper');
      if (stepperEl) stepperEl.hidden = true;
    }
    if (this.fromMenu) this.simplifyStepper();
    const start = { analyst: 'report', report: 'report', live: 'live' }[ctx.params.dock];
    // An explicit Report link means the hunt already finished elsewhere.
    if (start === 'report') this.huntDone = true;
    if (start) this.showTab(start);
    else if (ctx.params.bot || ctx.params.externalBot || ctx.params.flow === 'bug') this.showTab('live');
    // Open full report means the report alone on its own screen, no game.
    const rp = new URLSearchParams(location.search).get('report_patch');
    if (rp) this.reportPatch = rp;
    if (new URLSearchParams(location.search).get('reportfull') === '1') this.openReportFull();
  }

  // Steps 1-3 are sections of the Forge panel; step 4 is the Report panel.
  simplifyStepper() {
    // A/B test from the menu: no step strip, the stage and the report speak for themselves.
    const stepper = document.getElementById('stepper');
    if (stepper) stepper.hidden = true;
    const back = document.getElementById('mgr-back');
    if (back) {
      back.textContent = '← Back to comparisons';
      back.title = 'Runs continue when you leave this screen';
      back.onclick = () => { location.href = '/?mgr=compare'; };
    }
    document.querySelectorAll('#stepper .step-btn[data-step]').forEach((b) => {
      if (b.dataset.step === '1' || b.dataset.step === '2') b.hidden = true;
      if (b.dataset.step === '3') b.innerHTML = '<b>1</b>Playtest';
      if (b.dataset.step === '4') b.innerHTML = '<b>2</b>Report';
    });
  }

  showStep(n) {
    if (n === 4 && this.slide) { this.openReportFull(); return; }
    this.step = n === 4 ? this.step : n;
    this.showTab(n === 4 ? 'report' : 'forge');
  }

  showTab(name) {
    // Bug hunting: no Report until the hunt has finished.
    if (this.bugMode && name === 'report' && !this.huntDone) name = 'live';
    this.tab = name;
    for (const t of TABS) document.getElementById(`tab-${t}`).hidden = t !== name;
    document.querySelectorAll('#tab-forge [data-steps]').forEach((s) => {
      s.hidden = !s.dataset.steps.split(' ').includes(String(this.step));
    });
    this.renderStepper();
    if (name === 'report') this.renderReport();
  }

  renderStepper() {
    const f = this.feature;
    // Step 4 (Report) unlocks only once a playtest has actually run this session.
    const reachable = { 1: true, 2: !!f, 3: f?.status === 'approved', 4: !!this.reportPatch };
    const done = { 1: !!f, 2: ['approved', 'rejected'].includes(f?.status), 3: !!this.reportPatch, 4: false };
    const current = this.tab === 'report' ? 4 : this.tab === 'forge' ? this.step : 0;
    document.querySelectorAll('#stepper .step-btn').forEach((b) => {
      if (b.id === 'hunt-stop') {
        // Stop ends the hunt; the Report then generates and opens.
        b.hidden = !!this.huntDone;
        b.disabled = !!this.huntDone;
        return;
      }
      if (b.dataset.bugstep) {
        b.classList.toggle('current', this.tab === b.dataset.bugstep);
        b.classList.toggle('done', b.dataset.bugstep === 'live' && this.huntDone);
        b.classList.toggle('locked', b.dataset.bugstep === 'report' && !this.huntDone);
        b.disabled = b.dataset.bugstep === 'report' && !this.huntDone;
        return;
      }
      const n = Number(b.dataset.step);
      b.classList.toggle('current', n === current);
      b.classList.toggle('done', done[n] && n !== current);
      b.classList.toggle('locked', !reachable[n]);
      b.disabled = true;
    });
    document.getElementById('live-link').classList.toggle('current', this.tab === 'live');
  }

  // --------------------------------------------------------------- Pill
  update() {
    const g = this.game;
    if (!g) return;
    const has = (type) => g.buildings.some((b) => b.type === type && b.status === 'done');
    const sig = [g.step_id, g.stats.first_click_t, has('shelter'), g.stats.forager_harvests > 0, g.techs.has('tech_toolmaking'), this.stuckEvents].join('|');
    if (sig === this.lastPillSig) return;
    this.lastPillSig = sig;
    const step = STEP_LABEL[g.step_id] || g.step_id;
    document.getElementById('pill-step').textContent = g.achieved ? `${step} ★` : step;
    document.getElementById('pill-ttfa').textContent = g.stats.first_click_t === null ? '-' : `${g.stats.first_click_t.toFixed(1)}s`;
    const item = (done, label) => `<span class="${done ? 'ok' : 'todo'}">${done ? '✓' : '○'} ${label}</span>`;
    document.getElementById('pill-check').innerHTML = item(has('shelter'), 'Shelter') + item(g.stats.forager_harvests > 0, 'Forager')
      + item(g.techs.has('tech_toolmaking'), 'Research');
    const stuck = document.getElementById('pill-stuck');
    stuck.textContent = this.stuckEvents;
    stuck.classList.toggle('hot', this.stuckEvents > 0);
    this.setPillLeft(g.clock?.t);
  }

  // Bot voice (menu choice, off by default): speak the bot's think-aloud in
  // its persona voice. Only the first sentence, so speech stays concise and
  // lands near the click it describes (best at 1x).
  async speakThought(text, personaId, force = false) {
    if ((!force && !this.ctx.params.voice) || !text) return;
    const line = String(text).split(/(?<=[.!?])\s/)[0].slice(0, 140).trim();
    if (!line || line === this.lastSpoken) return;
    this.lastSpoken = line;
    try {
      const r = await fetch('/api/speak', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line, persona_id: personaId || this.ctx.params.persona || null }),
      });
      if (!r.ok) return;
      const { url } = await r.json();
      if (this.voiceAudio) { this.voiceAudio.pause(); this.voiceAudio.currentTime = 0; }
      this.voiceAudio = new Audio(url);
      this.voiceAudio.play().catch(() => {});
    } catch { /* voice is decoration; never break the hunt */ }
  }

  // "Left m:ss" in the pill: how much bot play time remains (sim seconds).
  setPillLeft(elapsedSec) {
    const el = document.getElementById('pill-left');
    if (!el) return;
    if (this.huntDone) { el.textContent = 'done'; return; }
    if (!this.botBudgetSec || elapsedSec == null) { el.textContent = '-'; return; }
    const left = Math.max(0, Math.round(this.botBudgetSec - elapsedSec));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  playElder(file) {
    if (!file) return;
    try {
      if (this.elderAudio) { this.elderAudio.pause(); this.elderAudio.currentTime = 0; }
      this.elderAudio = new Audio(`/static/assets/audio/voice/${encodeURIComponent(file)}?v=3`);
      this.elderAudio.volume = 0.45;
      this.elderAudio.play().catch(() => {});
    } catch { /* voice is decoration here */ }
  }

  // Music and action sounds for the watch screen, played in this tab.
  watchSound(step) {
    const sfx = window.__SFX__;
    if (!sfx || !this.ctx.params.watch) return;
    if (!this._watchMusicOn) {
      this._watchMusicOn = true;
      this._prevMusicVolume = sfx.musicVolume;
      sfx.setMusicVolume?.(0.6);
      sfx.ctx?.resume?.();
      sfx.startMusic?.();
    }
    if (!step) return;
    const t = step.target_id || '';
    const name = t === 'btn_confirm_placement' ? 'build'
      : t === 'btn_claim_quest' ? 'claim_reward'
      : t.startsWith('tech_') ? 'research_select'
      : t === 'btn_research' ? 'dock_research'
      : t === 'btn_heroes' ? 'dock_heroes'
      : t === 'btn_expedition' ? 'dock_campaign'
      : t === 'btn_upgrades' ? 'dock_upgrades'
      : t === 'btn_buildings_toggle' ? 'dock_buildings'
      : t.startsWith('building_') ? 'harvest'
      : 'click';
    try { sfx.play(name); } catch { /* sound is decoration here */ }
  }

  stopWatchSound() {
    const sfx = window.__SFX__;
    if (!sfx || !this._watchMusicOn) return;
    this._watchMusicOn = false;
    sfx.stopMusic?.();
    if (this._prevMusicVolume != null) sfx.setMusicVolume?.(this._prevMusicVolume);
  }

  async poll() {
    if (document.hidden) return;
    const runId = this.ctx.runId;
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/live?since=${this.liveNext}&bot_since=${this.botNext}`);
      if (!r.ok) return;
      const data = await r.json();
      this.liveNext = data.next;
      this.botNext = data.bot_next;
      for (const ev of data.events) {
        if (ev.event_type === 'stuck') this.addStream(streamLine(ev), 'stuck-row');
        if (ev.event_type === 'elder_voice' && this.ctx.params.watch) this.playElder(ev.payload?.file);
      }
      // When the hunt ends, the Report (diagnosis and proposed fixes) opens
      // on its own: no hunting for the right tab. Note: /live returns a
      // summary dict from the first event on, so "summary exists" must
      // never count as "ended" - only session_end / session_ended does.
      const ended = data.events.some((e) => e.event_type === 'session_end')
        || data.summary?.session_ended === true;
      if (this.ctx.params.watch && !this.reportOpened && ended) {
        this.reportOpened = true;
        this.huntDone = true;
        this.stopWatchSound();
        this.showTab('report');
      }
      for (const s of data.bot_steps || []) {
        this.addStream(`<span class="t">#${s.bot_step_index}</span> <span class="thought">💭 ${esc(s.thought || s.observation_summary || '')}</span>${s.target_id ? ` <span class="t">→ ${esc(s.target_id)}</span>` : ''}`);
        this.speakThought(s.thought || s.observation_summary, s.persona_id);
        this.watchSound(s);
      }
      if (this.ctx.params.watch && !ended && data.bot_next > 0) this.watchSound(null);
      // Show the bot's latest screenshot so the hunt is visible, not just text.
      if (data.bot_next > 0) {
        const n = String(data.bot_next - 1).padStart(3, '0');
        const src = `/api/runs/${encodeURIComponent(runId)}/artifacts/frames/step_${n}.png`;
        for (const img of document.querySelectorAll('#live-frame, #watch-img')) {
          img.onload = () => {
            img.hidden = false;
            const loading = document.getElementById('watch-loading');
            if (loading) loading.hidden = true;
          };
          img.onerror = () => { img.hidden = true; };
          if (!img.src.endsWith(src)) img.src = src;
          else if (img.complete && img.naturalWidth) img.onload();
        }
        const last = (data.bot_steps || []).slice(-1)[0];
        const status = document.getElementById('watch-status');
        if (status && last) status.textContent = `Step ${last.bot_step_index}: ${last.thought || last.observation_summary || '…'}`;
      }
      if (data.summary) this.stuckEvents = data.summary.stuck_events;
      // Watch mode has no local game for the pill, so feed it from the run.
      if (this.ctx.params.watch && data.summary) {
        const s = data.summary;
        document.getElementById('pill-step').textContent = s.where_stuck || 'playing';
        const stuck = document.getElementById('pill-stuck');
        stuck.textContent = s.stuck_events ?? 0;
        stuck.classList.toggle('hot', (s.stuck_events ?? 0) > 0);
        document.getElementById('pill-ttfa').textContent = s.time_to_first_action_sec != null
          ? `${Number(s.time_to_first_action_sec).toFixed(1)}s` : '-';
        this.setPillLeft(s.sim_elapsed_sec);
      }
    } catch { /* server restarting; retry next tick */ }
  }

  // --------------------------------------------------------------- Live
  async renderLive() {
    const el = document.getElementById('tab-live');
    const p = this.ctx.params;
    const botMode = !!p.bot;
    if (p.watch) {
      // Watching a server-run hunt: the play fills the main screen; here
      // only the thought stream, no local bot controls.
      el.innerHTML = `
        <div class="section-h">Bot thoughts, live</div>
        <div class="stream" id="stream"></div>`;
      return;
    }
    el.innerHTML = `
      <div class="row"><select class="persona" id="persona-select" aria-label="Persona"></select>
        <span class="badge" title="Map and policy seed">seed ${p.seed}</span></div>
      <button class="bot-btn" id="bot-btn">▶ Watch Bot Play</button>
      <button class="bot-btn bot-stop" id="bot-stop" hidden>■ Stop Bot</button>
      <div class="note" id="bot-note" style="margin-top:4px">${botMode
        ? 'Stub persona policy, variant-blind: it only sees rendered targets. Live Muse Spark runs come from the Playwright runner (--mode meta).'
        : 'Reloads this variant with a scripted persona bot driving real clicks.'}</div>
      <div class="section-h">Event &amp; thought stream</div>
      <img id="live-frame" class="live-frame" alt="Latest bot screenshot" hidden>
      <div class="stream" id="stream"></div>`;
    if (this.ctx.blocked) {
      el.querySelector('#bot-btn').disabled = true;
      el.querySelector('#bot-note').textContent = 'This variant needs an approved patch. Approve it in the Report step.';
      this.showTab('report');
    }
    await this.personasReady;
    const select = document.getElementById('persona-select');
    select.innerHTML = this.personas.map((x) => `<option value="${esc(x.persona_id)}">${esc(x.emblem || '')} ${esc(x.archetype || x.label)}</option>`).join('');
    select.value = p.persona && this.personas.some((x) => x.persona_id === p.persona) ? p.persona : (this.personas[0]?.persona_id || '');
    select.disabled = botMode;
    document.getElementById('bot-btn').addEventListener('click', () => this.toggleBot());

    if (p.externalBot && this.game) {
      select.disabled = true;
      document.getElementById('bot-btn').disabled = true;
      document.getElementById('bot-note').textContent = 'Driven by the Playwright playtester runner.';
      document.getElementById('stub-banner').hidden = this.ctx.provider === 'meta';
      const persona = this.personas.find((x) => x.persona_id === p.persona) || null;
      const policy = new StubBot({ runId: this.ctx.runId, persona, seed: p.seed });
      window.__BOT_HOOKS__ = {
        plan: () => {
          const { decision } = policy.plan();
          const t = decision.target;
          return { thought: decision.thought, target_id: t ? t.target_id : null, mood: decision.mood || null,
                   xy: t ? [t.x + t.w / 2, t.y + t.h / 2] : null };
        },
        ring: ringAt,
        thought: ({ index, thought, target_id, mood }) => {
          this.addStream(
            `<span class="t">#${index}</span>${mood ? ` <span class="mood mood-${esc(mood)}">${esc(mood)}</span>` : ''}`
            + ` <span class="thought">\u{1F4AD} ${esc(thought)}</span>${target_id ? ` <span class="t">→ ${esc(target_id)}</span>` : ''}`);
          this.speakThought(thought);
        },
      };
    }

    if (botMode && this.game) {
      document.getElementById('stub-banner').hidden = false;
      const persona = this.personas.find((x) => x.persona_id === select.value) || null;
      this.bot = new StubBot({
        runId: this.ctx.runId, persona, seed: p.seed,
        maxSimSec: (this.botBudgetSec = p.playMin ? p.playMin * 60 * (p.speed || 1) * (p.safety || 1) : 420),
        stuckSec: p.stuckSec,
        clickAt: this.ctx.clickAt, ringAt: ringAt,
        onThought: ({ index, thought, target_id }) => {
          this.addStream(
            `<span class="t">#${index}</span> <span class="thought">\u{1F4AD} ${esc(thought)}</span>${target_id ? ` <span class="t">→ ${esc(target_id)}</span>` : ''}`);
          this.speakThought(thought);
        },
        onDone: async (reason) => {
          this.game.end(reason);
          await this.ctx.telemetry.drain();
          await this.stopRunRecorder?.();
          if (p.extjob) {
            try {
              await fetch(`/api/feature_studio/playtest_external/${encodeURIComponent(p.extjob)}/session_done`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ run_id: this.ctx.runId }),
              });
              const job = await (await fetch(`/api/feature_studio/playtest_external/${encodeURIComponent(p.extjob)}`)).json();
              const next = (job.sessions || []).find((x) => !x.done);
              if (next) { location.href = extSessionUrl(job, next); return; }
              location.href = `/?report_patch=${encodeURIComponent(job.patch_id)}&reportfull=1`;
              return;
            } catch (err) {
              this.addStream(`<span class="thought">Could not continue the A/B test: ${esc(err.message)}</span>`);
            }
          }
          this.setBotButton('done');
          const stopBtn = document.getElementById('bot-stop');
          if (stopBtn) stopBtn.hidden = true;
          window.__BOT_DONE__ = reason;
          this.huntDone = true;
          this.addStream(`<span class="thought">🏁 Bot finished: ${esc(reason)}. Opening the Report step…</span>`);
          this.showTab('report');
        },
      });
      window.__STUB_BOT__ = this.bot;
      this.bot.start();
      this.setBotButton('running');
      const stopBtn = document.getElementById('bot-stop');
      if (stopBtn) {
        stopBtn.hidden = false;
        stopBtn.addEventListener('click', () => { if (this.bot && !this.bot.done) this.bot.finish('stopped_by_tester'); });
      }
      if (p.video) this.startRunRecorder();
    }
  }

  // Record the game canvas as video.webm for this run (Game Manager option).
  startRunRecorder() {
    try {
      const canvas = document.getElementById('world');
      if (!canvas?.captureStream || typeof MediaRecorder === 'undefined') return;
      const chunks = [];
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start(1000);
      this.stopRunRecorder = async () => {
        this.stopRunRecorder = null;
        await new Promise((resolve) => { rec.onstop = resolve; rec.stop(); });
        const blob = new Blob(chunks, { type: 'video/webm' });
        if (!blob.size) return;
        await fetch(`/api/runs/${encodeURIComponent(this.ctx.runId)}/video`, { method: 'POST', body: blob }).catch(() => {});
        this.addStream('<span class="thought">🎬 Run video saved (video.webm).</span>');
      };
    } catch { /* recording is optional; the run continues without it */ }
  }

  // Stop bot (stepper, right side): ends the hunt now. The run is saved,
  // its Report is generated and opens (in-tab bot via onDone, Meta bot via
  // the watch poll seeing the ended session).
  async stopHunt() {
    const btn = document.getElementById('hunt-stop');
    if (btn) btn.disabled = true;
    if (this.bot && !this.bot.done) { this.bot.finish('stopped_by_tester'); return; }
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(this.ctx.runId)}/stop_hunt`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.addStream('<span class="thought">■ Stop requested: the bot is ending the hunt; the Report opens when the run is saved.</span>');
    } catch (err) {
      if (btn) btn.disabled = false;
      this.addStream(`<span class="thought">Could not stop the bot (${esc(err.message)}).</span>`);
    }
  }

  toggleBot() {
    if (!this.bot) {
      const url = new URL(location.href);
      url.searchParams.set('bot', '1');
      url.searchParams.set('persona', document.getElementById('persona-select').value);
      url.searchParams.delete('run_id');
      if (!url.searchParams.has('speed')) url.searchParams.set('speed', '1');
      location.href = url.toString();
      return;
    }
    if (this.bot.done) return;
    if (this.bot.running) {
      this.bot.pause();
      this.setBotButton('paused');
    } else {
      this.bot.start();
      this.setBotButton('running');
    }
  }

  setBotButton(state) {
    const b = document.getElementById('bot-btn');
    b.classList.toggle('running', state === 'running');
    b.textContent = { running: '⏸ Pause Bot', paused: '▶ Resume Bot', done: '✓ Bot session finished' }[state];
    b.disabled = state === 'done';
  }

  onEvent(ev) {
    if (ev.event_type === 'heartbeat') return;
    this.seenEvents += 1;
    const cls = ev.event_type === 'action_rejected' ? 'rej'
      : ['step_complete', 'achievement'].includes(ev.event_type) ? 'good' : '';
    this.addStream(streamLine(ev), cls);
  }

  addStream(html, cls = '') {
    const stream = document.getElementById('stream');
    if (!stream) return;
    const row = document.createElement('div');
    row.className = `ev ${cls}`;
    row.innerHTML = html;
    stream.prepend(row);
    while (stream.children.length > STREAM_MAX) stream.lastChild.remove();
  }

  // ---------------------------------------------- Analyst & Designer
  async renderAnalyst() {
    const el = document.getElementById('report-loop');
    if (!el) return;
    let patch;
    let validation;
    let audit = [];
    let analysis = null;
    let base = null;
    if (!this.bugMode) {
      try {
        const r = await fetch(`/api/patches/${PATCH_ID}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        ({ patch, validation, audit } = await r.json());
        base = (await (await fetch('/api/config?variant=A')).json()).config;
      } catch (err) {
        el.innerHTML = `<div class="note">No patch available (${esc(err.message)}).</div>`;
        return;
      }
    }
    const analysisRun = this.bugMode ? this.ctx.runId
      : (this.ctx.params.analysisRun || (this.ctx.params.variant === 'A' ? this.ctx.runId : null));
    const fetchAnalysis = async (runId) => {
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/analysis`);
        if (r.ok) return await r.json();
      } catch { /* none yet */ }
      return null;
    };
    if (analysisRun) analysis = await fetchAnalysis(analysisRun);
    // Reports show the current run only: never fall back to a recorded
    // demo run (its frames show an old build of the game, ocean and all).
    if (this.bugMode && !analysis && this.huntDone && !this.analyzeRequested) {
      // The hunt ended but nobody wrote the diagnosis yet (in-tab bot):
      // ask the analyst (Meta model) once, then redraw with its report.
      this.analyzeRequested = true;
      el.innerHTML = '<div class="note">Muse Spark is writing the diagnosis for this run…</div>';
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(this.ctx.runId)}/analyze`, { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        this.analyzeRequested = false;
        await this.renderAnalyst();
        return;
      } catch (err) {
        el.innerHTML = `<div class="note">The analyst could not write the report (${esc(err.message)}). Reload to try again.</div>`;
        return;
      }
    }
    // No recorded frame, no frame box: an empty dark panel reads as a bug.
    const frameHtml = analysis?.stuck_frame_url
      ? `<div class="section-h">Stuck frame</div><div class="frame-box"><img src="${esc(analysis.stuck_frame_url)}" alt="Stuck frame"></div>`
      : '';
    const vs = analysis?.visual_salience;
    const samMissing = this.bugMode && analysis && !vs
      ? '<div class="note">Visual analysis unavailable for this frame.</div>' : '';
    const noStuck = this.bugMode && analysis && !analysis.where_stuck
      ? '<div class="note"><b>No stuck event detected in observed coverage.</b> The frame below is the last available frame of this run, not a stuck frame.</div>' : '';
    const vsNote = vs?.distractor_to_goal_area_ratio
      ? `<div class="note">SAM 3.1 visual salience: <code>${esc(vs.distractor_target)}</code> (${Math.round(vs.distractor_area_px)} px², ${esc(vs.distractor_salience || 'n/a')}) is <b>${esc(vs.distractor_to_goal_area_ratio)}x</b> larger than <code>${esc(vs.goal_target)}</code> (${Math.round(vs.goal_area_px)} px², ${esc(vs.goal_salience || 'n/a')}).</div>`
      : '';
    const diagnosis = analysis?.diagnosis
      ? `<div class="note ink">${esc(analysis.diagnosis)}</div>`
      : `<div class="note">No analyst diagnosis for this run yet.</div>`;
    const hyps = (analysis?.hypotheses || []).map((h) => `<div class="note">• <b>${esc(h.id)}</b> (${Math.round((h.confidence ?? 0) * 100)}%): ${esc(h.evidence)}</div>`).join('');
    const quotes = (analysis?.playtester_quotes || []).map((q) => `<div class="quote"><span class="mood mood-${esc(q.player_mood || 'engaged')}">${esc(q.player_mood || 'engaged')}</span> “${esc(q.thought)}” <span class="note">step ${esc(q.bot_step_index)} · ${esc(q.trigger)}</span></div>`).join('');
    if (this.bugMode) {
      el.innerHTML = `
        ${noStuck}
        ${frameHtml}
        ${vsNote}${samMissing}
        <div class="section-h">Diagnosis</div>
        ${diagnosis}
        ${hyps ? `<div class="section-h">Proposed fixes</div>${hyps}` : ''}
        ${quotes ? `<div class="section-h">Playtester think-aloud</div>${quotes}` : ''}`;
      return;
    }
    const rows = Object.entries(patch.body).map(([k, v]) => `<div><span class="k">${esc(k)}</span>: <span class="from">${esc(JSON.stringify(base?.[k]))}</span> → <span class="to">${esc(JSON.stringify(v))}</span></div>`).join('');
    const valid = validation?.valid;
    const decided = ['approved', 'rejected'].includes(patch.status);
    const canDecide = patch.status === 'validated';
    el.innerHTML = `
      ${frameHtml}
      ${vsNote}
      <div class="section-h">Diagnosis</div>
      ${diagnosis}
      ${hyps}
      ${quotes ? `<div class="section-h">Playtester think-aloud</div>${quotes}` : ''}
      <div class="section-h">${esc(patch.patch_id)} · ${esc(patch.title || '')}</div>
      <div class="note">${esc(patch.rationale || '')}</div>
      <div class="diff">${rows}</div>
      <span class="valid ${valid ? '' : 'bad'}">Schema: ${valid ? 'VALID' : 'INVALID'} (Pydantic)</span>
      <div class="status-line">Status: <b id="patch-status">${esc(patch.status)}</b>${audit.length ? ` <span class="note">· ${audit.length} audit entr${audit.length === 1 ? 'y' : 'ies'}</span>` : ''}</div>
      <div class="decide">
        <button class="approve" id="btn-approve" ${canDecide ? '' : 'disabled'}>✔ Approve Patch</button>
        <button class="reject" id="btn-reject" ${canDecide ? '' : 'disabled'}>✖ Reject</button>
      </div>
      <div class="note" id="decide-note">${decided
        ? (patch.status === 'approved' ? `Approved by a human. Variant B can now run with <code>?variant=B&amp;patch_id=${esc(patch.patch_id)}</code>.` : 'Rejected. Variant B stays unavailable.')
        : 'Nothing changes in the game until you approve.'}</div>`;
    el.querySelector('#btn-approve').addEventListener('click', () => this.decide('approve'));
    el.querySelector('#btn-reject').addEventListener('click', () => this.decide('reject'));
  }

  async decide(action) {
    const note = document.getElementById('decide-note');
    document.querySelectorAll('.decide button').forEach((b) => { b.disabled = true; });
    try {
      const r = await fetch(`/api/patches/${PATCH_ID}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Decided in the AI Director dock' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    } catch (err) {
      note.textContent = `Could not ${action}: ${err.message}`;
    }
    await this.renderAnalyst();
    await this.renderAb();
    if (this.ctx.blocked && action === 'approve') setTimeout(() => location.reload(), 900);
  }

  // ------------------------------------------------------- A/B Summary
  async renderAb() {
    const el = document.getElementById('report-ab');
    if (!el) return;
    let data;
    try {
      const r = await fetch('/api/ab_summary');
      if (r.status === 404) {
        el.innerHTML = '<div class="note">No A/B experiment has been run yet. The experiment agent writes <code>runs/ab_summary.json</code> after paired A/B runs. No numbers are shown until then.</div>';
        return;
      }
      data = await r.json();
    } catch (err) {
      el.innerHTML = `<div class="note">A/B summary unavailable (${esc(err.message)}).</div>`;
      return;
    }
    const A = data.A || data.variants?.A || {};
    const B = data.B || data.variants?.B || {};
    const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : esc(String(v)));
    const metrics = ['where_stuck', 'time_to_first_action_sec', 'stuck_events', 'onboarding_completed'];
    el.innerHTML = `
      <div class="ab-card">
        <div class="h">metric</div><div class="h">A</div><div class="h">B</div>
        ${metrics.map((m) => `<div>${m}</div><div>${fmt(A[m])}</div><div>${fmt(B[m])}</div>`).join('')}
      </div>
      ${data.n_pairs !== undefined ? `<div class="note">${fmt(data.n_pairs)} paired runs · ${esc(data.provider_mode || '')}</div>` : ''}
      ${data.conclusion ? `<div class="note">${esc(data.conclusion)}</div>` : ''}`;
  }

  // ------------------------------------------------------- Feature Forge
  async latestFeature() {
    try {
      const rows = await (await fetch('/api/patches')).json();
      const list = Array.isArray(rows) ? rows : rows.patches || [];
      return list.filter((p) => p.body && p.body.feature_plugin && p.status !== 'invalid').pop() || null;
    } catch { return null; }
  }

  async renderForge() {
    const el = document.getElementById('tab-forge');
    el.innerHTML = `
      <section data-steps="1">
        <div class="section-h">Pick a feature idea</div>
        <div class="presets" id="presets"></div>
        <div class="scroll-input">
          <textarea id="forge-prompt" rows="2" maxlength="600" placeholder="…or describe your own: a raider ambush at tutorial step 2 that costs 20 wood and gives 10 RP."></textarea>
          <button class="game-btn emerald" id="forge-btn">✦ Forge Feature</button>
        </div>
      </section>
      <div class="note" id="forge-note">The designer agent turns the idea into a config patch. Nothing reaches players until you approve it.</div>
      <section data-steps="2 3"><div id="decree"></div></section>
      <section data-steps="3">
        <div class="run-status" id="run-status"></div>
        <div class="pair-progress" id="pair-progress"></div>
        <details class="bot-thoughts" id="bot-thoughts" hidden>
          <summary id="bot-thoughts-title">💭 Bot thoughts</summary>
          <div class="bot-thoughts-list" id="bot-thoughts-list"></div>
        </details>
        <div class="run-stall" id="run-stall"></div>
        <button class="game-btn iron" id="stop-compare" hidden>Stop comparison</button>
        <div class="note" id="summon-note">Approve the patch first.</div>
      </section>`;
    el.querySelector('#forge-btn').addEventListener('click', () => this.forge());
    this.showTab(this.tab);
    el.querySelector('#stop-compare')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      for (const x of this.job?.sessions || []) {
        if (x.run_id) fetch(`/api/runs/${encodeURIComponent(x.run_id)}/stop_hunt`, { method: 'POST' }).catch(() => {});
      }
      const n = document.getElementById('summon-note');
      if (n) n.textContent = 'Stopping the comparison…';
    });
    this.renderPresets();
    await this.personasReady;
    this.renderGuild();
    this.feature = await this.latestFeature();
    this.renderDecree();
  }

  async renderPresets() {
    await this.presetsReady;
    const el = document.getElementById('presets');
    el.innerHTML = this.presets.map((x) => `
      <button class="preset" data-id="${esc(x.preset_id)}" title="${esc(x.prompt)}">
        <span class="pr-ico"><img src="/static/assets/generated/${esc(x.preset_id)}.png?v=e3" alt="" onerror="this.remove()"><span class="pr-emoji">${esc(x.icon)}</span></span>
        <span class="pr-text"><b>${esc(x.label)}</b><span>${esc(x.summary)}</span></span>
      </button>`).join('');
    el.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => {
      const x = this.presets.find((p) => p.preset_id === b.dataset.id);
      document.getElementById('forge-prompt').value = x.prompt;
      this.forge(x.preset_id);
    }));
  }

  renderGuild() {
    const el = document.getElementById('guild');
    if (!el) return;
    el.innerHTML = this.personas.map((x) => `
      <button class="medallion ${this.chosen.has(x.persona_id) ? 'on' : ''}" data-id="${esc(x.persona_id)}" aria-pressed="${this.chosen.has(x.persona_id)}"
        title="${esc(x.description)}&#10;${esc((x.grounding || []).join('; '))}">
        ${this.chosen.has(x.persona_id) ? '<span class="m-check">✓</span>' : ''}
        <span class="m-ico">${esc(x.emblem || '✦')}</span>
        <span class="m-name">${esc(x.archetype || x.label)}</span>
        <span class="m-sub">${esc(x.subtitle || '')}</span>
      </button>`).join('');
    el.querySelectorAll('.medallion').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.id;
      if (this.chosen.has(id)) this.chosen.delete(id); else this.chosen.add(id);
      this.renderGuild();
      this.updateSummon();
    }));
  }

  async forge(presetId = null, mode = 'stub') {
    const prompt = document.getElementById('forge-prompt').value.trim();
    const note = document.getElementById('forge-note');
    if (!prompt) { note.textContent = 'Describe the feature first.'; return; }
    const btn = document.getElementById('forge-btn');
    btn.disabled = true;
    note.textContent = 'The designer agent is drafting the patch…';
    try {
      const r = await fetch('/api/feature_studio/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode, preset_id: presetId }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`);
      this.feature = data.patch;
      this.emblemSource[data.patch.patch_id] = data.emblem_source;
      note.textContent = data.source === 'preset_muse_spark'
        ? `${data.patch.patch_id}: drafted earlier by Muse Spark, replayed from the recording. Schema valid. Review it.`
        : data.source === 'meta' ? `${data.patch.patch_id}: drafted live by Muse Spark. Schema valid. Review it before approving.`
          : `${data.patch.patch_id} passed schema validation. Review it before approving.`;
    } catch (err) {
      note.textContent = `Could not forge: ${err.message}`;
    }
    btn.disabled = false;
    this.renderDecree();
    if (this.feature) this.showStep(2);
  }

  renderDecree() {
    const el = document.getElementById('decree');
    const p = this.feature;
    if (!p) { el.innerHTML = ''; this.updateSummon(); this.renderStepper(); return; }
    const f = p.body.feature_plugin;
    const badges = (obj, sign) => Object.entries(obj || {}).map(([k, v]) => `<span class="res-badge ${sign === '-' ? 'cost' : 'gain'}">${RES_ICON[k] || ''} ${sign}${esc(v)}</span>`).join('');
    const icon = f.icon_url ? `<img src="${esc(f.icon_url)}?v=${esc(p.patch_id)}-e3" alt="">` : `<span>${esc(f.icon)}</span>`;
    const canDecide = p.status === 'validated';
    const gen = this.emblemSource[p.patch_id] === 'muse_image' ? 'Generated via Muse Image' : 'Procedural stub emblem';
    const seal = { validated: 'Awaiting approval', approved: '✔ Approved', rejected: '✖ Rejected', proposed: 'Pending' }[p.status] || esc(p.status);
    el.innerHTML = `
      <div class="decree ${esc(p.status)}">
        <div class="decree-top">
          <div class="emblem">${icon}</div>
          <div class="decree-meta">
            <div class="decree-title">${esc(f.title)}</div>
            <div class="decree-step">${esc(STEP_LABEL[f.unlock_at_step] || f.unlock_at_step)} · ${esc(f.button_salience.replace('_', ' '))}</div>
            <div class="res-row">${badges(f.costs, '-')}${badges(f.rewards, '+')}</div>
          </div>
          <span class="wax-seal ${esc(p.status)}">${seal}</span>
        </div>
        <div class="decree-ab">A: Current game · B: With ${esc(f.title)}</div>
        <details class="decree-more"><summary>View changes</summary>
          <div class="decree-why">${esc(p.rationale || '')}</div>
          <div class="note">${esc(p.patch_id)}${p.baseline_patch_id ? ` · on top of ${esc(p.baseline_patch_id)}` : ''}</div>
          ${f.icon_url ? '<div class="note">Emblem by Muse Image</div>' : '<div class="note">Placeholder artwork</div>'}
        </details>
        ${canDecide ? `<div class="decide">
          <button class="game-btn emerald" id="decree-approve">✔ Approve</button>
          <button class="game-btn iron" id="decree-dismiss">✖ Reject</button>
        </div>` : ''}
      </div>`;
    el.querySelector('#decree-approve')?.addEventListener('click', () => this.decideFeature('approve'));
    el.querySelector('#decree-dismiss')?.addEventListener('click', () => this.decideFeature('reject'));
    this.updateSummon();
    this.renderStepper();
  }

  async decideFeature(action) {
    if (this._deciding) return;
    this._deciding = true;
    document.querySelectorAll('#decree-approve, #decree-dismiss, #btn-approve, #btn-reject')
      .forEach((b) => { b.disabled = true; });
    const note = document.getElementById('forge-note');
    try {
      const r = await fetch(`/api/patches/${encodeURIComponent(this.feature.patch_id)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Decided in the Feature Forge' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      this.feature = data.patch;
      // Approval is the gate: only now does the feature reach the open game.
      if (action === 'approve') this.ctx.activateFeature?.(data.patch.body.feature_plugin);
      note.textContent = action === 'approve' ? 'Approved by you.' : 'Rejected. Nothing changes in the game.';
    } catch (err) {
      note.textContent = `Could not ${action}: ${err.message}`;
    }
    this._deciding = false;
    this.renderDecree();
    this.showStep(this.feature?.status === 'approved' ? 3 : 1);
    // Launched from the A/B menu: approval was the last human decision,
    // so the bots start playing without another Run button push.
    if (this.feature?.status === 'approved' && this.abLaunch && !this.job && this.chosen.size) {
      this.abLaunch = false;
      this.summon();
    }
  }

  updateSummon() {
    const btn = document.getElementById('summon-btn');
    const note = document.getElementById('summon-note');
    if (!btn) return;
    const ready = this.feature?.status === 'approved' && this.chosen.size > 0 && !this.job;
    btn.disabled = !ready;
    if (this.job) return;
    note.textContent = this.feature?.status !== 'approved' ? 'Approve the patch first.'
      : this.chosen.size ? `${this.chosen.size} playtester${this.chosen.size === 1 ? '' : 's'} each play the game twice: without the feature (A) and with it (B).`
        : 'Tap the playtesters you want to send.';
  }

  // Take over the stage for bot gameplay: the human's idle village and
  // its Elder modal never compete with the playtest.
  claimStage() {
    const ws = document.getElementById('watch-screen');
    const root = document.getElementById('game-root');
    if (root) root.style.visibility = 'hidden';
    if (ws) {
      ws.hidden = false;
      const loading = document.getElementById('watch-loading');
      if (loading) { loading.hidden = false; loading.firstChild.textContent = 'Your playtesters will play here…'; }
      const status = document.getElementById('watch-status');
      if (status) status.textContent = 'Waiting for the first bot…';
    }
  }

  async updateStageBot(sessions, job) {
    const ws = document.getElementById('watch-screen');
    if (!ws || ws.hidden) return;
    const focus = sessions.find((x) => x.state === 'playing' && x.run_id)
      || [...sessions].reverse().find((x) => x.run_id);
    if (!focus) return;
    try {
      const d = await (await fetch(`/api/runs/${encodeURIComponent(focus.run_id)}/live?since=0&bot_since=0`)).json();
      const steps = d.bot_steps || [];
      const last = steps[steps.length - 1];
      if (!last) return;
      const img = document.getElementById('watch-img');
      const src = `/api/runs/${encodeURIComponent(focus.run_id)}/artifacts/frames/step_${String(last.bot_step_index).padStart(3, '0')}.png`;
      if (img && !img.src.endsWith(src)) img.src = src;
      if (img) { img.hidden = false; }
      const loading = document.getElementById('watch-loading');
      if (loading) loading.hidden = true;
      const arm = focus.run_id.includes('_B_') ? 'B' : 'A';
      // Full thought history of the bot on stage, like the bug-hunt stream.
      // Re-render only when a new step lands, so an open menu never flickers.
      const menu = document.getElementById('bot-thoughts');
      if (menu && steps.length) {
        const sig = `${focus.run_id}|${steps.length}`;
        if (this.thoughtSig !== sig) {
          this.thoughtSig = sig;
          menu.hidden = false;
          const who = this.personas.find((x) => focus.run_id.includes(x.persona_id))?.archetype || '';
          document.getElementById('bot-thoughts-title').textContent =
            `💭 Bot thoughts · Bot ${arm}${who ? ` · ${who}` : ''} (${steps.length})`;
          document.getElementById('bot-thoughts-list').innerHTML = [...steps].reverse().map((st) =>
            `<div class="ev"><span class="t">#${st.bot_step_index}</span> <span class="thought">💭 ${esc(st.thought || st.observation_summary || '')}</span>${st.target_id ? ` <span class="t">→ ${esc(st.target_id)}</span>` : ''}</div>`).join('');
        }
      }
      const status = document.getElementById('watch-status');
      if (status) status.textContent = `Bot ${arm} is playing · step ${steps.length}${last.thought ? ` · ${last.thought}` : ''}`;
      const rs = document.getElementById('run-status');
      if (rs && this.runStatusBase && !rs.dataset.set) { rs.dataset.set = '1'; rs.innerHTML = `<b>Chosen:</b> ${esc(this.runStatusBase)}`; }
      const stall = document.getElementById('run-stall');
      const stuckN = (d.summary || {}).stuck_events || 0;
      if (stall) stall.textContent = stuckN > 0 ? `Possible stall: ${stuckN} attempt${stuckN === 1 ? '' : 's'} without progress` : '';
      // The dock header pill follows the bot on stage, not the idle game.
      const sum = d.summary || {};
      const setPill = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
      const personaName = this.personas.find((x) => focus.run_id.includes(x.persona_id))?.archetype || '';
      setPill('pill-step', `Bot ${arm} · ${String(sum.last_step_id || 'playing').replaceAll('_', ' ')}`);
      setPill('pill-check', arm === 'A' ? 'without the feature' : 'with the feature');
      setPill('pill-stuck', sum.stuck_events ?? 0);
      // Time left for this bot (estimate): steps remaining to the cap at the
      // pace seen so far, capped by the runner's 1200 sim-second window.
      const speed = this.abSettings?.speed || 1;
      if (this.stageClock?.run !== focus.run_id) this.stageClock = { run: focus.run_id, t: Date.now(), n: steps.length };
      const elapsedReal = (Date.now() - this.stageClock.t) / 1000;
      const doneSteps = Math.max(1, steps.length - this.stageClock.n + 1);
      const stepCap = this.abSettings?.runType === 'onboarding' ? 25 : 100;
      const bySteps = (elapsedReal / doneSteps) * Math.max(0, stepCap - steps.length);
      const limitSim = (this.abSettings?.playMin || 20) * 30 * Math.max(1, speed);
      const bySim = Math.max(0, limitSim - (sum.sim_elapsed_sec || 0)) / Math.max(1, speed);
      const realLeft = Math.round(Math.min(bySteps, bySim));
      const clock = `${Math.floor(realLeft / 60)}:${String(realLeft % 60).padStart(2, '0')}`;
      setPill('pill-ttfa', `${steps.length} steps · ⏱ ~${clock} left`);
      const ttfaEl = document.getElementById('pill-ttfa');
      if (ttfaEl?.parentElement) {
        ttfaEl.parentElement.childNodes[0].textContent = '';
        if (ttfaEl.parentElement.childNodes[2]) ttfaEl.parentElement.childNodes[2].textContent = ' · ';
      }
      if (job) {
        const doneCount = (job.sessions || []).filter((x) => x.state === 'done').length;
        setPill('pill-left', `${Math.max(0, (job.sessions_total || 0) - doneCount)} to go`);
      }
    } catch { /* next tick retries */ }
  }

  async summon() {
    const note = document.getElementById('summon-note');
    const personas = this.personas.map((x) => x.persona_id).filter((id) => this.chosen.has(id));
    {
      const ab0 = this.abSettings || {};
      const names = personas.map((pid) => this.personas.find((x) => x.persona_id === pid)?.archetype || pid).join(', ');
      const model = ab0.botModel === 'wonder' ? 'Muse Wonder' : (ab0.runner === 'meta' ? 'Muse Spark' : 'Scripted bot');
      const journey = { full_window: 'Full journey I–VI', half_game: 'Half game I–III', onboarding: 'Onboarding I' }[ab0.runType] || 'Full journey I–VI';
      const extras = [ab0.hearVoice ? 'hears Elder' : '', ab0.speakVoice ? 'speaks' : '', ab0.recordVideo ? 'video saved' : ''].filter(Boolean).join(' · ');
      this.runStatusBase = `${names} · ${ab0.runs || 3} matched pairs · ${model} · ${journey} · ×${ab0.speed || 1} · ${(ab0.playMin || 20) / 2} min per bot${extras ? ` · ${extras}` : ''}`;
      const rs = document.getElementById('run-status');
      if (rs) rs.innerHTML = `<b>Chosen:</b> ${esc(this.runStatusBase)}`;
    }
    const ab = this.abSettings || JSON.parse(localStorage.getItem('doe_ab_settings') || 'null') || {};
    this.abSpeakVoice = !!ab.speakVoice;
    this.spokenAgentThoughts = new Set();
    const base = ab.seedSet === 'varied' ? 100 : 42;
    const seeds = ab.seedSet === 'single' ? [42]
      : Array.from({ length: ab.runs || 3 }, (_, i) => base + i);
    try {
      if (this.publicPlayOnly) {
        // No server browser on a public host: this tab plays each session.
        const er = await fetch('/api/feature_studio/playtest_external', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch_id: this.feature.patch_id, personas, seeds,
            run_type: ab.runType || 'full_window', speed: ab.speed || 1,
            pair_minutes: ab.playMin || 20 }),
        });
        const job = await er.json();
        if (!er.ok) throw new Error(job.detail || `HTTP ${er.status}`);
        const first = job.sessions.find((x) => !x.done) || job.sessions[0];
        note.textContent = 'Opening Bot A in this tab…';
        location.href = extSessionUrl(job, first);
        return;
      }
      const r = await fetch('/api/feature_studio/playtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch_id: this.feature.patch_id, personas, mode: ab.runner || 'stub',
          bot_model: ab.botModel || 'spark', hear_voice: !!ab.hearVoice,
          record_video: !!ab.recordVideo,
          seeds, run_type: ab.runType || 'full_window', speed: ab.speed || 1,
          pair_minutes: ab.playMin || 20 }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      this.job = data;
    } catch (err) {
      note.textContent = `Could not summon: ${err.message}`;
      return;
    }
    this.updateSummon();
    this.renderAgents(personas, []);
    note.scrollIntoView({ block: 'nearest' });
    const forgeNote = document.getElementById('forge-note');
    if (forgeNote) forgeNote.hidden = true;
    this.claimStage();
    const tick = async () => {
      try {
        this.job = await (await fetch(`/api/feature_studio/jobs/${this.job.job_id}`)).json();
      } catch { /* retry */ }
      if (this.job.status === 'running') {
        const finished = (this.job.sessions || []).filter((x) => x.state === 'done').length;
        note.textContent = `Comparison running · ${this.job.sessions_started} of ${this.job.sessions_total} sessions started · ${finished} finished.`;
        this.renderAgents(personas, this.job.sessions || []);
        await this.updateStageBot(this.job.sessions || [], this.job);
        setTimeout(tick, JOB_POLL_MS);
        return;
      }
      const failed = this.job.status === 'failed' ? this.job.error : null;
      this.renderAgents(personas, this.job.sessions || []);
      this.job = null;
      this.updateSummon();
      if (failed) { note.textContent = `Playtest failed: ${failed}`; return; }
      this.reportPatch = this.feature.patch_id;
      note.textContent = 'Playtest finished.';
      // The result of a run opens as a full-screen report, not a side tab
      // (showStep(4) already opens it full-screen on the slide dock).
      this.showStep(4);
    };
    tick();
  }

  // One card per playtester: arm A (game without the feature) and arm B (with it).
  renderAgents(personas, sessions) {
    const el = document.getElementById('pair-progress');
    if (!el) return;
    const pairs = new Map();
    for (const x of sessions || []) {
      const m = String(x.run_id || '').match(/_([AB])_(.+)_s(\d+)$/);
      if (!m) continue;
      const key = `${m[2]}|${m[3]}`;
      if (!pairs.has(key)) pairs.set(key, { persona: m[2], seed: m[3] });
      pairs.get(key)[m[1]] = x;
    }
    const label = (x) => !x ? 'Queued' : x.state === 'done' ? 'Complete' : x.state === 'playing' ? 'Running' : esc(x.state || 'Queued');
    const rows = [...pairs.values()];
    el.innerHTML = rows.length ? `<div class="section-h">Session progress</div>` + rows.map((pr, i) => {
      const name = this.personas.find((x) => x.persona_id === pr.persona)?.archetype || pr.persona;
      return `<div class="pair-row"><span>Pair ${i + 1} · seed ${esc(pr.seed)}</span><span>A · ${label(pr.A)}</span><span>B · ${label(pr.B)}</span></div>`;
    }).join('') : '';
    const stop = document.getElementById('stop-compare');
    if (stop) stop.hidden = !(this.job && this.job.status === 'running');
  }

  // ------------------------------------------------------ Game Manager
  // First screen (Astra design): two jobs only, Find bugs and Compare a
  // feature, plus a quiet Just play. Each job opens a prefilled setup.
  wireBugReports(el, list) {
    list.querySelectorAll('[data-bug]').forEach((btn) => btn.addEventListener('click', async () => {
      const rep = await (await fetch(`/api/runs/${encodeURIComponent(btn.dataset.bug)}/bug-report`)).json();
      list.innerHTML = `<div class="mgr-summary"><b>Bug hunt report</b><br>
        Run: <code>${esc(rep.run_id)}</code> · ${esc(rep.status || '')}<br>
        Stuck at: <code>${esc(rep.where_stuck || 'none')}</code> · stuck events: ${esc(rep.stuck_events ?? 0)}<br>
        Diagnosis: ${esc(rep.diagnosis || 'pending')}</div>
        <div class="mgr-actions"><button class="game-btn amber" id="mgr-bug-open">Open full report</button>
        <button class="game-btn mgr-secondary" id="mgr-exp-back">Back to list</button></div>`;
      document.getElementById('mgr-bug-open').addEventListener('click', () => {
        location.href = `/?run_id=${encodeURIComponent(rep.run_id)}&flow=bug&dock=analyst&reportfull=1`;
      });
      document.getElementById('mgr-exp-back').addEventListener('click',
        () => el.querySelector('#mgr-to-history').click());
    }));
  }

  async openManager() {
    const app = document.getElementById('app');
    const el = document.createElement('div');
    el.id = 'manager';
    el.className = 'manager';
    el.innerHTML = `
      <div class="mgr-panel">
        <div class="mgr-screen" id="mgr-home">
          <div class="mgr-head"><div class="mgr-game">HEARTHS OF THE GLEN</div><h1>Playtest Menu</h1>
            <p>What would you like to test?</p></div>
          <div class="mgr-two">
            <div class="mgr-choice">
              <div class="mc-title">FIND BUGS</div>
              <div class="mc-text">Send a tester through the valley and review what went wrong.</div>
              <button class="game-btn amber" id="mgr-to-bug">Set up bug hunt</button>
            </div>
            <div class="mgr-choice">
              <div class="mc-title">A/B TEST A FEATURE</div>
              <div class="mc-text">Run the tester through the current game and a proposed change.</div>
              <button class="game-btn amber" id="mgr-to-compare">Set up A/B test</button>
            </div>
          </div>
          <button class="game-btn amber mgr-history-btn" id="mgr-to-history">Past experiments &amp; reports</button>
          <button class="game-btn amber mgr-play-btn" id="mgr-skip">Just play</button>
          <div class="mgr-foot">Built with Meta models: Muse Spark · Muse Wonder · SAM 3.1 · Muse Image · Muse Voice Transcribe</div>
        </div>

        <div class="mgr-screen" id="mgr-history" hidden>
          <button class="mgr-back-top" data-back>Main Menu</button>
          <div class="mgr-head"><h1>Past experiments &amp; reports</h1>
            <p>Saved A/B experiments with their frozen plans and verdicts.</p></div>
          <div id="mgr-exp-list"><div class="note">Loading…</div></div>
        </div>

        <div class="mgr-screen" id="mgr-bug" hidden>
          <div class="mgr-head"><h1>Find problems in the valley</h1></div>
          <div class="mgr-fields">
            <label class="mgr-field">Persona <select id="bug-persona"></select></label>
            <label class="mgr-field">Game version <select id="bug-version"><option value="A" selected>Current game: A</option><option value="B">Variant B (approved feature, if any)</option></select></label>
            <label class="mgr-field">Speed <select id="bug-speed"><option value="4">×4</option><option value="2">×2</option><option value="1" selected>×1</option></select></label>
            <label class="mgr-field">Play time <select id="bug-playtime"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="20" selected>20 minutes</option><option value="30">30 minutes</option></select></label>
            <label class="mgr-field">Seed <select id="bug-seed"><option value="" selected>Automatic (42)</option><option value="42">42</option><option value="43">43</option><option value="44">44</option><option value="7">7</option><option value="123">123</option></select></label>
          </div>
          <div class="mgr-fields">
            <label class="mgr-field">Runner <select id="bug-runner"><option value="meta">Meta bot · Muse Spark (paid)</option><option value="meta_wonder">Meta bot · Muse Wonder (paid, stronger)</option><option value="stub" selected>Scripted bot: no model cost</option></select></label>
            <label class="mgr-field">Safety limit <select id="bug-safety"><option value="1" selected>Play time, elapsed</option><option value="1.5">Play time + 50%</option><option value="2">Play time ×2</option></select></label>
            <label class="mgr-field">No-progress limit <select id="bug-stuck"><option value="30">30 sim seconds without progress</option><option value="60" selected>60 sim seconds without progress</option><option value="120">120 sim seconds without progress</option></select></label>
            <label class="mgr-field">Run video <span class="mgr-static"><input type="checkbox" id="bug-video"> Save session video</span></label>
            <label class="mgr-field">Bot ears <span class="mgr-static"><input type="checkbox" id="bug-hear"> Hear the Elder · Muse Voice Transcribe</span></label>
            <label class="mgr-field">Bot voice <span class="mgr-static"><input type="checkbox" id="bug-voice"> Speak bot commentary · ElevenLabs</span></label>
          </div>
          <div class="mgr-note">The scripted bot drives this tab with real clicks. The Meta bot runs on the server and saves its whole run (screenshots, thoughts, telemetry) for the report.</div>
          <div class="mgr-actions">
            <button class="mgr-justplay" data-back>Back</button>
            <button class="game-btn amber" id="bug-start">Start bug hunt</button>
          </div>
        </div>

        <div class="mgr-screen" id="mgr-compare" hidden>
          <div class="mgr-head"><h1>Compare a proposed feature</h1></div>
          <div class="mgr-section">Feature</div>
          <div class="mgr-cards" id="mgr-cards"><div class="note">Loading…</div></div>
          <div class="mgr-section">Or describe your own idea</div>
          <div class="mgr-own">
            <textarea id="mgr-prompt" rows="2" maxlength="600" placeholder="A bonfire after the tutorial that costs 15 wood and gives 30 food."></textarea>
            <button class="game-btn emerald" id="mgr-forge">✦ Ask Muse Wonder</button>
          </div>
          <div class="mgr-note" id="mgr-note"></div>
          <div id="mgr-draft"></div>
          <div class="mgr-fields">
            <label class="mgr-field">Persona <select id="cmp-persona"></select></label>
            <label class="mgr-field">Seed set <select id="cmp-seeds"><option value="baseline" selected>Saved baseline, paired (42…)</option><option value="varied">Varied seeds, paired (100…)</option><option value="single">Single seed 42, paired</option></select></label>
            <label class="mgr-field">Matched pairs <select id="cmp-runs"><option value="1">1</option><option value="3" selected>3</option><option value="5">5</option><option value="10">10</option></select></label>
            <label class="mgr-field">Runner <select id="cmp-runner"><option value="stub">Scripted bot: no model cost</option><option value="meta" selected>Meta bot · Muse Spark (paid)</option><option value="meta_wonder">Meta bot · Muse Wonder (paid, stronger)</option></select></label>
            <label class="mgr-field">Game speed <select id="cmp-speed"><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select></label>
            <label class="mgr-field">Journey to test <select id="cmp-runlength"><option value="full_window" selected>Full journey: Chapters I–VI</option><option value="onboarding">Onboarding only: Chapter I</option></select></label>
            <label class="mgr-field">Safety time limit per pair <select id="cmp-playtime"><option value="5">5 min per pair · 2.5 min per bot</option><option value="10">10 min per pair · 5 min per bot</option><option value="20" selected>20 min per pair · 10 min per bot</option><option value="30">30 min per pair · 15 min per bot</option></select></label>
            <label class="mgr-field">Run video <span class="mgr-static"><input type="checkbox" id="cmp-video"> Save session video</span></label>
            <label class="mgr-field">Bot ears <span class="mgr-static"><input type="checkbox" id="cmp-hear"> Bot hears the Elder (Muse Voice Transcribe)</span></label>
            <label class="mgr-field">Bot voice <span class="mgr-static"><input type="checkbox" id="cmp-voice"> Bot speaks its thoughts (ElevenLabs)</span></label>
          </div>
          <div class="mgr-summary" id="cmp-summary">A · Current game<br>B · Current game + (pick a feature above)<br><br>Success target: More runs complete onboarding<br>Guardrails: No new blockers or worse chapter completion</div>
          <div class="mgr-note" id="cmp-cost">Quick check: 3 matched pairs, 6 sessions. Exploratory sample; not enough to establish a winner. Reference estimate: about $0.15 per 20-minute hunt; model, audio and session length change the actual cost.</div>
          <div class="mgr-actions">
            <button class="mgr-justplay" data-back>Back</button>
            <button class="game-btn amber" id="cmp-start">Run A/B test</button>
          </div>
        </div>
      </div>`;
    app.appendChild(el);
    const show = (id) => {
      el.querySelectorAll('.mgr-screen').forEach((s) => { s.hidden = s.id !== id; });
    };
    el.querySelector('#mgr-skip').addEventListener('click', () => this.closeManager(false));
    if (new URLSearchParams(location.search).get('mgr') === 'compare') {
      history.replaceState(null, '', '/');
      setTimeout(() => show('mgr-compare'), 0);
    }
    if (new URLSearchParams(location.search).get('mgr') === 'history') {
      // One-time deep link from a report: land on the list, then clean the
      // address so reopening the game starts at the Main Menu again.
      history.replaceState(null, '', '/');
      setTimeout(() => el.querySelector('#mgr-to-history')?.click(), 0);
    }
    el.querySelector('#mgr-to-bug').addEventListener('click', () => show('mgr-bug'));
    el.querySelector('#mgr-to-compare').addEventListener('click', () => show('mgr-compare'));
    el.querySelector('#mgr-to-history').addEventListener('click', async () => {
      show('mgr-history');
      const list = document.getElementById('mgr-exp-list');
      try {
        const [bugReports, rows, studioReports] = await Promise.all([
          fetch('/api/bug_reports').then((r) => r.json()).catch(() => []),
          fetch('/api/experiments').then((r) => r.json()).catch(() => []),
          fetch('/api/feature_studio/demos').then((r) => r.json()).catch(() => []),
        ]);
        const fmtDate = (iso) => {
          const d = new Date(iso);
          return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        };
        const bugs = (bugReports || []).map((b) => `<button class="mgr-exp" data-bug="${esc(b.run_id)}">
          <b>Bug hunt: ${esc(b.persona || 'tester')}</b><span>${esc(b.status || '')} · stuck at ${esc(b.where_stuck || 'none')} · ${esc(fmtDate(b.saved_at || b.generated_at))}</span></button>`).join('');
        // A/B reports first: studio playtests (live runs, newest patch first), then saved experiments.
        const abReports = (studioReports || []).filter((d) => d.source === 'live').slice()
          .sort((a, b) => ((b.source === 'live') - (a.source === 'live'))
            || String(b.patch_id).localeCompare(String(a.patch_id), undefined, { numeric: true }))
          .map((d) => `<button class="mgr-exp" data-report="${esc(d.patch_id)}">
            <b>${esc(d.title || d.patch_id)}</b><span>${esc(d.verdict_label || '')} · ${esc(d.n_pairs ?? '?')} matched pairs · ${esc(d.patch_id)}${d.source === 'live' ? '' : ' · recorded demo'}</span></button>`).join('');
        const exps = (rows || []).map((x) => `<button class="mgr-exp" data-exp="${esc(x.experiment_id)}">
          <b>${esc(x.title || x.experiment_id)}</b><span>${esc(x.status)} · patch ${esc(x.patch_id)} rev ${esc(x.patch_revision)} · ${esc(fmtDate(x.created_at))}</span></button>`).join('');
        if (!abReports && !exps && !bugs) {
          list.innerHTML = '<div class="note">No saved reports yet. Bug hunts and A/B tests you run are saved here.</div>';
          return;
        }
        list.innerHTML = `<div class="mgr-section">A/B test reports</div>${abReports}${exps || ''}`
          + (bugs ? `<div class="mgr-section">Bug hunt reports</div>${bugs}` : '');
        list.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => {
          location.href = `/?report_patch=${encodeURIComponent(b.dataset.report)}&reportfull=1`;
        }));
        list.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', async () => {
          const rep = await (await fetch(`/api/experiments/${encodeURIComponent(b.dataset.exp)}/report`)).json();
          const v = rep.verdict || {};
          list.innerHTML = `<div class="mgr-summary"><b>${esc(rep.title || rep.experiment_id)}</b><br>
            Status: ${esc(rep.status || '')} · Patch: <code>${esc(rep.patch_id || '')}</code><br>
            Primary metric: <code>${esc(rep.primary_metric || '')}</code><br>
            Verdict: <b>${esc(v.verdict || 'incomplete')}</b> (${esc(v.reason || '')})<br>
            Pairs: ${esc(v.n ?? 0)}/${esc(v.planned_pairs ?? 0)} · A ${esc(v.a_rate ?? '-')} · B ${esc(v.b_rate ?? '-')}</div>
            <div class="mgr-actions"><button class="game-btn mgr-secondary" id="mgr-exp-back">Back to list</button></div>`;
          document.getElementById('mgr-exp-back').addEventListener('click',
            () => el.querySelector('#mgr-to-history').click());
        }));
        this.wireBugReports(el, list);
      } catch (err) {
        list.innerHTML = `<div class="note">Could not load reports (${esc(err.message)}).</div>`;
      }
    });
    el.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('mgr-home')));
    el.querySelector('#mgr-forge').addEventListener('click', () => this.managerForge());
    el.querySelector('#bug-start').addEventListener('click', () => {
      const persona = document.getElementById('bug-persona').value;
      const bugRunner = document.getElementById('bug-runner').value;
      if (bugRunner.startsWith('meta')) {
        this.startMetaBotHunt({
          persona, variant: document.getElementById('bug-version').value,
          seed: Number(document.getElementById('bug-seed').value || 42),
          speed: Number(document.getElementById('bug-speed').value),
          play_minutes: Number(document.getElementById('bug-playtime').value),
          record_video: !!document.getElementById('bug-video')?.checked,
          mode: 'meta',
          bot_model: bugRunner === 'meta_wonder' ? 'wonder' : 'spark',
          hear_voice: !!document.getElementById('bug-hear')?.checked,
          speak_voice: !!document.getElementById('bug-voice')?.checked,
        });
        return;
      }
      const url = new URL(location.href);
      url.searchParams.set('bot', '1');
      url.searchParams.set('flow', 'bug');
      url.searchParams.set('persona', persona);
      url.searchParams.set('variant', document.getElementById('bug-version').value);
      url.searchParams.set('speed', document.getElementById('bug-speed').value);
      const seed = document.getElementById('bug-seed').value;
      if (seed) url.searchParams.set('seed', seed); else url.searchParams.delete('seed');
      url.searchParams.set('safety', document.getElementById('bug-safety').value);
      url.searchParams.set('stucksec', document.getElementById('bug-stuck').value);
      if (document.getElementById('bug-video')?.checked) url.searchParams.set('video', '1');
      else url.searchParams.delete('video');
      if (document.getElementById('bug-voice')?.checked) url.searchParams.set('voice', '1');
      else url.searchParams.delete('voice');
      url.searchParams.set('playmin', document.getElementById('bug-playtime').value);
      url.searchParams.delete('run_id');
      location.href = url.toString();
    });
    this.comparePreset = null;
    el.querySelector('#cmp-start').addEventListener('click', () => {
      if (!this.comparePreset) {
        document.getElementById('mgr-note').textContent = 'Pick a feature above first, or describe your own idea.';
        return;
      }
      localStorage.setItem('doe_ab_play_min', document.getElementById('cmp-playtime').value);
      this.abSettings = {
        persona: document.getElementById('cmp-persona').value,
        seedSet: document.getElementById('cmp-seeds').value,
        runs: Number(document.getElementById('cmp-runs').value),
        runner: document.getElementById('cmp-runner').value === 'meta_wonder' ? 'meta'
          : document.getElementById('cmp-runner').value,
        botModel: document.getElementById('cmp-runner').value === 'meta_wonder' ? 'wonder' : 'spark',
        speed: Number(document.getElementById('cmp-speed').value),
        runType: document.getElementById('cmp-runlength').value,
        hearVoice: !!document.getElementById('cmp-hear')?.checked,
        speakVoice: !!document.getElementById('cmp-voice')?.checked,
        recordVideo: !!document.getElementById('cmp-video')?.checked,
        playMin: Number(document.getElementById('cmp-playtime').value),
      };
      localStorage.setItem('doe_ab_settings', JSON.stringify(this.abSettings));
      this.abLaunch = true;
      this.fromMenu = true;
      this.simplifyStepper();
      this.managerPick(this.comparePreset);
    });

    let status = { meta_ready: false, muse_model_id: '' };
    try { status = await (await fetch('/api/feature_studio/status')).json(); } catch { /* stub */ }
    this.museMode = status.meta_ready ? 'meta' : 'stub';
    this.publicPlayOnly = !!status.public_play_only;
    if (status.public_play_only) {
      for (const id of ['bug-runner', 'cmp-runner']) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        sel.value = 'stub';
        sel.querySelectorAll('option').forEach((o) => { if (o.value.startsWith('meta')) o.disabled = true; });
      }
    }
    document.getElementById('mgr-note').textContent = status.meta_ready
      ? `Your idea goes live to the designer agent (${status.designer_model_id || 'Muse Wonder'}). It takes about half a minute.`
      : 'No META_API_KEY in .env, so the offline stub designer drafts your idea.';

    await this.personasReady;
    const personaOpts = this.personas.map((x) => `<option value="${esc(x.persona_id)}">${esc(x.emblem || '')} ${esc(x.archetype || x.label)}</option>`).join('');
    for (const id of ['bug-persona', 'cmp-persona']) {
      const sel = document.getElementById(id);
      sel.innerHTML = personaOpts;
      const dflt = this.personas.find((x) => x.persona_id === 'first_time_casual');
      if (dflt) sel.value = dflt.persona_id;
    }

    await this.presetsReady;
    const badges = (obj, sign) => Object.entries(obj || {}).map(([k, v]) => `<span class="res-badge ${sign === '-' ? 'cost' : 'gain'}">${RES_ICON[k] || ''} ${sign}${esc(v)}</span>`).join('');
    const cards = document.getElementById('mgr-cards');
    cards.innerHTML = this.presets.map((x) => `
      <div class="mgr-card">
        <div class="mc-ico">${esc(x.icon)}</div>
        <div class="mc-title">${esc(x.label)}</div>
        <div class="mc-text">${esc(x.summary)}</div>
        <div class="mc-when">Unlocks: ${esc(x.unlock_at_step === 'free_play' ? 'after the tutorial' : STEP_LABEL[x.unlock_at_step] || x.unlock_at_step)}</div>
        <div class="res-row">${badges(x.costs, '-')}${badges(x.rewards, '+')}</div>
        <button class="game-btn amber" data-id="${esc(x.preset_id)}">Select feature</button>
      </div>`).join('');
    cards.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', () => {
      this.comparePreset = b.dataset.id;
      cards.querySelectorAll('.mgr-card').forEach((c) => c.classList.remove('selected'));
      b.closest('.mgr-card').classList.add('selected');
      const x = this.presets.find((p) => p.preset_id === this.comparePreset);
      document.getElementById('cmp-summary').innerHTML = `A · Current game<br>B · Current game + ${esc(x.label)}<br><br>Success target: More runs complete onboarding<br>Guardrails: No new blockers or worse chapter completion<br><br>${esc(document.getElementById('cmp-runs').value)} matched pairs · ${esc(document.getElementById('cmp-runner').selectedOptions[0].textContent)} · ×${esc(document.getElementById('cmp-speed').value)}`;
    }));
  }

  // Clicking "Approve & play" is the human approval: forge the prebuilt patch, approve it, open the game.
  async managerPick(presetId) {
    const x = this.presets.find((p) => p.preset_id === presetId);
    // The Persona picked on the A/B setup starts pre-selected in the guild.
    if (this.abSettings?.persona) { this.chosen = new Set([this.abSettings.persona]); this.renderGuild?.(); }
    document.getElementById('forge-prompt').value = x.prompt;
    document.getElementById('mgr-note').textContent = `Preparing ${x.label}…`;
    await this.forge(presetId);
    if (this.feature?.status !== 'validated') {
      document.getElementById('mgr-note').textContent = document.getElementById('forge-note').textContent;
      return;
    }
    await this.decideFeature('approve');
    this.closeManager(this.feature?.status === 'approved');
  }

  async managerForge() {
    const prompt = document.getElementById('mgr-prompt').value.trim();
    const note = document.getElementById('mgr-note');
    if (!prompt) { note.textContent = 'Describe the feature first.'; return; }
    const btn = document.getElementById('mgr-forge');
    btn.disabled = true;
    note.textContent = this.museMode === 'meta' ? 'Muse Spark is designing your feature…' : 'The stub designer is drafting your feature…';
    document.getElementById('forge-prompt').value = prompt;
    this.feature = null;
    await this.forge(null, this.museMode);
    btn.disabled = false;
    note.textContent = document.getElementById('forge-note').textContent;
    const draft = document.getElementById('mgr-draft');
    if (this.feature?.status !== 'validated') { draft.innerHTML = ''; return; }
    // Same decree card as the studio panel, moved here so the approval happens in the menu.
    draft.appendChild(document.getElementById('decree'));
    draft.querySelector('#decree-approve').textContent = '✔ Approve & play';
    draft.querySelector('#decree-approve').addEventListener('click', () => this.closeManager(true), { once: true });
  }

  // Meta bot bug hunt, started from this menu: the server runs the
  // Playwright session, saves the whole run, and we poll until it lands.
  async startMetaBotHunt(settings) {
    const note = document.querySelector('#mgr-bug .mgr-note');
    const btn = document.getElementById('bug-start');
    btn.disabled = true;
    note.textContent = 'Starting the Meta bot…';
    let job;
    try {
      const r = await fetch('/api/bot_hunt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      job = data;
    } catch (err) {
      note.textContent = `Could not start the Meta bot: ${err.message}`;
      btn.disabled = false;
      return;
    }
    note.textContent = `Meta bot is hunting (run ${job.run_id}). Opening the watch screen…`;
    // Watch it play: the Studio live view streams its screenshots and thoughts.
    setTimeout(() => { location.href = `/?run_id=${encodeURIComponent(job.run_id)}&flow=bug&dock=live&watch=1&playmin=${settings.play_minutes || 20}&speed=${settings.speed || 1}${settings.speak_voice ? '&voice=1' : ''}`; }, 1200);
    const tick = async () => {
      try { job = await (await fetch(`/api/bot_hunt/${job.job_id}`)).json(); } catch { /* retry */ }
      if (job.status === 'running') {
        note.textContent = `Meta bot is hunting (run ${job.run_id})… ${job.steps ? `${job.steps} steps so far.` : ''}`;
        setTimeout(tick, 3000);
        return;
      }
      if (job.status === 'failed') {
        note.textContent = `Meta bot hunt failed: ${job.error || 'unknown error'}. The partial run stays saved under ${job.run_id}.`;
        btn.disabled = false;
        return;
      }
      const a = job.artifacts || {};
      note.textContent = `Hunt finished: ${job.steps || 0} steps, ${a.frames || 0} screenshots, ${a.bot_steps || 0} recorded thoughts. Opening the report…`;
      setTimeout(() => { location.href = `/?run_id=${encodeURIComponent(job.run_id)}&flow=bug&dock=analyst`; }, 1200);
    };
    setTimeout(tick, 2000);
  }

  closeManager(openStudio) {
    const decree = document.getElementById('decree');
    if (decree && decree.closest('#manager')) document.querySelector('#tab-forge [data-steps="2 3"]').appendChild(decree);
    document.getElementById('manager')?.remove();
    // Just play is the game alone: no AI Studio tab on the edge.
    const toggle = document.getElementById('council-toggle');
    if (toggle && !openStudio) toggle.hidden = true;
    if (openStudio) {
      this.showStep(3);
      this.setOpen?.(true);
    }
  }

  // ------------------------------------------------------ Full-screen report
  openReportFull() {
    let modal = document.getElementById('report-full');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'report-full';
      modal.className = 'report-full';
      modal.innerHTML = `<div class="rf-head"><img class="rf-crest" src="/static/assets/generated/report_crest.jpg?v=2" alt=""><h2>Playtest report</h2>
        <button class="back-menu-btn rf-main" id="report-main">← Main Menu</button>
        <button class="council-close" id="report-close" aria-label="Close the report">✕</button></div><div class="rf-body"></div>`;
      document.getElementById('app').appendChild(modal);
      modal.querySelector('#report-main').addEventListener('click', () => { location.href = '/'; });
      modal.querySelector('#report-close').addEventListener('click', () => this.closeReportFull());
    }
    const tab = document.getElementById('tab-report');
    modal.querySelector('.rf-body').appendChild(tab);
    // Show a turning sign while the report is written, never a blank screen.
    tab.innerHTML = '<div class="rf-loading"><div class="rf-spinner"></div><div>Writing your report…</div></div>';
    tab.hidden = false;
    modal.hidden = false;
    this.setOpen?.(false);
    this.renderReport();
  }

  closeReportFull() {
    // Opened from the reports list: X returns to that screen, not the game.
    if (new URLSearchParams(location.search).get('reportfull') === '1') {
      location.href = '/?mgr=history';
      return;
    }
    const modal = document.getElementById('report-full');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.getElementById('director').appendChild(document.getElementById('tab-report'));
    this.showTab(this.bugMode ? 'report' : (this.tab === 'report' ? 'forge' : this.tab));
  }

  // Saved experiment (frozen plan) verdict, above the legacy patch report.
  async renderExperiment() {
    const el = document.getElementById('report-exp');
    if (!el) return;
    try {
      const rows = await (await fetch('/api/experiments')).json();
      if (!rows.length) { el.innerHTML = ''; return; }
      const rep = await (await fetch(`/api/experiments/${encodeURIComponent(rows[0].experiment_id)}/report`)).json();
      const v = rep.verdict || {};
      const inv = (rep.run_inventory || []).map((r) =>
        `<div class="note"><code>${esc(r.variant)}</code> ${esc(r.persona_id)} seed ${esc(r.game_seed)} · run <code>${esc(r.run_id)}</code>${r.selected ? '' : ' · excluded'}</div>`).join('');
      el.innerHTML = `<div class="section-h">Experiment: ${esc(rep.title || rep.experiment_id)}</div>
        <div class="note">Status: <b>${esc(rep.status || '')}</b> · Patch <code>${esc(rep.patch_id || '')}</code> rev ${esc(rep.patch_revision ?? '')} · Primary metric: <code>${esc(rep.primary_metric || '')}</code></div>
        <div class="verdict ${v.verdict === 'better' ? 'positive' : v.verdict === 'worse' ? 'hurts' : 'mixed'}">${esc((v.verdict || 'incomplete').toUpperCase())}</div>
        <div class="takeaway">${esc(v.reason || '')}</div>
        <div class="note">Pairs ${esc(v.n ?? 0)}/${esc(v.planned_pairs ?? 0)} · both succeed ${esc(v.both_succeed ?? 0)} · both fail ${esc(v.both_fail ?? 0)} · B-only ${esc(v.n01_b_only ?? 0)} · A-only ${esc(v.n10_a_only ?? 0)} · McNemar p ${esc(v.mcnemar_exact_p ?? '-')}</div>
        ${inv ? `<div class="section-h">Run inventory</div>${inv}` : ''}`;
    } catch { el.innerHTML = ''; }
  }

  // ------------------------------------------------------ Council Report
  async fetchStudioReport(pid) {
    try {
      const r = await fetch(`/api/feature_studio/report/${encodeURIComponent(pid)}`);
      if (r.ok) return await r.json();
    } catch { /* none yet */ }
    return null;
  }

  async renderReport() {
    const el = document.getElementById('tab-report');
    if (this.bugMode) {
      // Bug hunting report: the run's diagnosis only. No feature patches,
      // no approval gate, no A/B tables.
      el.innerHTML = `<div id="report-loop"></div>
        <button class="back-menu-btn" id="report-back">← Back to Main Menu</button>`;
      el.querySelector('#report-back').addEventListener('click', () => { location.href = '/'; });
      await this.renderAnalyst();
      return;
    }
    const token = ++this.reportToken || (this.reportToken = 1);
    let report = this.reportPatch ? await this.fetchStudioReport(this.reportPatch) : null;
    if (!report) {
      // The page may have reloaded since the playtest finished: fall back
      // to the newest feature patch that has a finished report on the server.
      try {
        const rows = await (await fetch('/api/patches')).json();
        const list = (Array.isArray(rows) ? rows : rows.patches || [])
          .filter((x) => x.body?.feature_plugin).reverse();
        for (const cand of list.slice(0, 8)) {
          report = await this.fetchStudioReport(cand.patch_id);
          if (report) { this.reportPatch = cand.patch_id; break; }
        }
      } catch { /* no fallback */ }
    }
    if (token !== this.reportToken) return;
    if (!report) {
      // No playtest has run yet: no report to show, and no recorded demo
      // report as a placeholder. The Report step unlocks after step 3.
      el.innerHTML = `<div class="note">No playtest has run yet. Run a playtest at step 3 first; its report opens here. Below: the analyst's diagnosis of the onboarding.</div>
        <div id="report-exp"></div>
        <div id="report-loop"></div><div class="section-h">Onboarding fix A/B</div><div id="report-ab"></div>`;
      await this.renderExperiment();
      await this.renderAnalyst();
      await this.renderAb();
      return;
    }
    const byId = Object.fromEntries(this.personas.map((x) => [x.persona_id, x]));
    // KPI card: B big, A as "was", delta coloured by whether higher is better for that metric.
    const plaque = (label, v, higherBetter = true) => {
      const a = parseFloat(v.A); const b = parseFloat(v.B);
      const d = Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) * 10) / 10 : null;
      const tone = d === null || d === 0 ? 'flat' : (d > 0) === higherBetter ? 'good' : 'bad';
      const unit = String(v.B).endsWith('%') ? ' pts' : '';
      return `<div class="plaque kpi ${tone}"><div class="pl-h">${label}</div><div class="pl-v"><b>${esc(v.B)}</b></div>
        <div class="kpi-d">${d === null ? '' : `${d > 0 ? '▲' : d < 0 ? '▼' : '='} ${Math.abs(d)}${unit}`} <span>was ${esc(v.A)}</span></div></div>`;
    };
    const bars = (label, v) => {
      const w = (x) => Math.max(0, Math.min(100, parseFloat(x) || 0));
      return `<div class="ab-row"><div class="ab-l">${label}</div><div class="ab-bars">
        <div class="ab-bar a" style="width:${w(v.A)}%"><span>A ${esc(v.A)}</span></div>
        <div class="ab-bar b" style="width:${w(v.B)}%"><span>B ${esc(v.B)}</span></div></div></div>`;
    };
    const rows = report.persona_breakdown || [];
    const maxD = Math.max(1, ...rows.map((r) => Math.abs(r.final_score_delta || 0)));
    const deltas = rows.map((r) => {
      const x = byId[r.persona_id] || {};
      const d = r.final_score_delta || 0;
      const w = (Math.abs(d) / maxD) * 50;
      return `<div class="pd-row"><div class="pd-l">${esc(x.emblem || '')} ${esc(r.archetype || r.persona_id)}${r.stalled ? ' <i title="Did not finish the tutorial with the feature">stuck</i>' : ''}</div>
        <div class="pd-track"><div class="pd-bar ${d < 0 ? 'neg' : 'pos'}" style="${d < 0 ? `right:50%` : `left:50%`};width:${w}%"></div></div>
        <div class="pd-v">${d > 0 ? '+' : ''}${esc(d)}</div></div>`;
    }).join('');
    const thoughtList = (arm) => (report.thoughts?.[arm] || []).map((t) =>
      `<div class="ev"><span class="t">#${esc(t.step)}</span> <span class="thought">💭 ${esc(t.thought)}</span>${t.target_id ? ` <span class="t">→ ${esc(t.target_id)}</span>` : ''}</div>`).join('')
      || '<div class="note">No thoughts recorded.</div>';
    const thoughtsHtml = report.thoughts ? `
      <div class="section-h">Bot thoughts · ${esc(byId[report.thought_pair?.persona_id]?.archetype || report.thought_pair?.persona_id || '')} · seed ${esc(report.thought_pair?.seed ?? '')}</div>
      <div class="thought-cols">
        <div class="thought-col"><div class="tc-h">Bot A · without the feature</div>${thoughtList('A')}</div>
        <div class="thought-col"><div class="tc-h">Bot B · with ${esc(report.plugin?.title || 'the feature')}</div>${thoughtList('B')}</div>
      </div>` : '';
    const frameFor = (arm) => {
      const steps = report.thoughts?.[arm] || [];
      const runId = report.replay?.[arm];
      if (!runId || !steps.length) return '';
      const n = String(steps[steps.length - 1].step).padStart(3, '0');
      return `/api/runs/${encodeURIComponent(runId)}/artifacts/frames/step_${n}.png`;
    };
    const framesHtml = (frameFor('A') || frameFor('B')) ? `
      <div class="section-h">From the playtest · last frame of each bot</div>
      <div class="thought-cols frames-row">
        <figure class="frame-fig"><figcaption>Bot A · without the feature</figcaption><img src="${esc(frameFor('A'))}" alt="Bot A's last frame" onerror="this.closest('figure').remove()"></figure>
        <figure class="frame-fig"><figcaption>Bot B · with ${esc(report.plugin?.title || 'the feature')}</figcaption><img src="${esc(frameFor('B'))}" alt="Bot B's last frame" onerror="this.closest('figure').remove()"></figure>
      </div>` : '';
    const p = report.plaques;
    el.innerHTML = `
      <div id="report-exp"></div>
      <div class="verdict ${esc(report.key)}">${esc(report.label)}</div>
      <div class="takeaway">${esc(report.takeaway)}</div>
      <div class="plaques">${plaque('Tutorial finished', p.onboarding)}${plaque('Stuck events', p.stuck, false)}${plaque('Reached Stone Age', p.stone_age)}${plaque('Mean score', p.score)}</div>
      <div class="charts">
        <div class="chart"><div class="chart-h">Players who got there · A without the feature, B with it</div>
          ${bars('Tutorial', p.onboarding)}${bars('Stone Age', p.stone_age)}</div>
        ${rows.length ? `<div class="chart"><div class="chart-h">Score change per playtester (B − A)</div>${deltas}</div>` : ''}
      </div>
      ${report.summary && report.summary !== report.takeaway ? `<div class="summary-box"><div class="section-h">Summary · Muse Spark</div><p>${esc(report.summary)}</p></div>` : ''}
      ${framesHtml}
      ${thoughtsHtml}
      <div class="note">${esc(report.patch_id)} vs ${esc(report.baseline)} · ${esc(report.n_pairs)} paired runs · ${esc(report.provider_mode)} · $${esc(report.cost_usd)}</div>
      <div class="decide">
        <button class="game-btn bronze" id="rework-btn" disabled title="Fixes start from the Playtest step, not from a finished report">⚒️ Ask AI for a Fix</button>
        <button class="game-btn iron" id="replay-btn" ${report.replay ? '' : 'disabled'}>\u{1F3AC} Watch A/B Replay</button>
      </div>
      <div class="note" id="rework-note"></div>`;
    el.querySelector('#rework-btn').addEventListener('click', () => this.rework(report.patch_id));
    await this.renderExperiment();
    el.querySelector('#replay-btn').addEventListener('click', () => {
      // Stub runs need dev=1, and the replay then labels them STUB / DEV MODE.
      const dev = report.provider_mode === 'meta' ? '' : '&dev=1';
      location.href = `/?replay_a=${encodeURIComponent(report.replay.A)}&replay_b=${encodeURIComponent(report.replay.B)}${dev}`;
    });
  }

  async rework(patchId) {
    const note = document.getElementById('rework-note');
    try {
      const r = await fetch('/api/feature_studio/rework', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch_id: patchId, mode: 'stub' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      this.emblemSource[data.patch.patch_id] = this.emblemSource[patchId];
      this.feature = data.patch;
      this.reportPatch = null;
      this.renderDecree();
      document.getElementById('forge-note').textContent = `${data.patch.patch_id}: ${data.rationale}`;
      this.closeReportFull();
      this.showStep(2);
      this.setOpen?.(true);
    } catch (err) {
      note.textContent = `Could not rework: ${err.message}`;
    }
  }
}

// Cyan click ring at #game-root coordinates.
function ringAt(x, y, kind) {
  const layer = document.getElementById('click-layer');
  const ring = document.createElement('div');
  ring.className = `click-ring${kind === 'aim' ? ' aim' : ''}`;
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  layer.appendChild(ring);
  setTimeout(() => ring.remove(), kind === 'aim' ? 320 : 900);
}

function streamLine(ev) {
  const t = `<span class="t">${Number(ev.sim_elapsed_sec || 0).toFixed(1)}s</span>`;
  const p = ev.payload || {};
  switch (ev.event_type) {
    case 'click': return `${t} click ${esc(p.target_id)} <span class="t">${esc(p.result)}</span>`;
    case 'action_rejected': {
      const extra = Object.entries(p).filter(([k]) => k.endsWith('_available') || k.endsWith('_required')).map(([k, v]) => `${k}=${v}`).join(' ');
      return `${t} action_rejected ${esc(p.target_id)} <b>${esc(p.reason)}</b> ${esc(extra)}`;
    }
    case 'stuck': return `${t} <span class="stuck">STUCK</span> ${esc(ev.step_id)} <span class="t">${esc(p.reason || '')}</span>`;
    case 'step_enter': return `${t} step_enter ${esc(ev.step_id)}`;
    case 'step_complete': return `${t} ✓ step_complete ${esc(ev.step_id)}`;
    case 'hint_shown': return `${t} hint_shown → ${esc(p.target_id)}`;
    case 'achievement': return `${t} \u{1F3C6} ${esc(p.title || p.achievement_id)}`;
    default: return `${t} ${esc(ev.event_type)}`;
  }
}

// One browser-driven A/B session (public hosts): the scripted bot plays it in this tab.
function extSessionUrl(job, s) {
  const q = new URLSearchParams({ bot: '1', flow: 'ab', persona: s.persona_id, seed: String(s.seed),
    variant: s.variant, run_id: s.run_id, speed: String(job.speed || 1),
    playmin: String((job.pair_minutes || 20) / 2), extjob: job.job_id });
  if (s.patch_id) q.set('patch_id', s.patch_id);
  return `/?${q.toString()}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
