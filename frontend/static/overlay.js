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
      <div class="council-title"><span class="crest-gem">✦</span> AI Playtest Studio
        <small>Test a feature idea on AI playtesters before real players see it</small></div>
      ${slide ? '<button class="council-close" id="council-close" aria-label="Close the studio">✕</button>' : ''}
      <button class="mgr-justplay" id="mgr-back" title="Back to the Game Manager menu">← Game Manager</button>
    </div>
    <div class="pill" id="pill">
      <div class="pill-row"><span class="step" id="pill-step">-</span>
        <span class="badge variant-${ctx.params.variant}" id="pill-variant" title="Game variant">${ctx.params.variant}${ctx.params.patchId ? ` · ${esc(ctx.params.patchId)}` : ''}</span>
        <span class="muted" title="Stuck events the server detected in this session">Stuck <span class="stuck-count" id="pill-stuck">0</span></span></div>
      <div class="pill-row"><span class="checklist" id="pill-check"></span><span class="muted">First click <b id="pill-ttfa">-</b></span></div>
    </div>
    <nav class="stepper" id="stepper" aria-label="Studio steps">
      ${(ctx.params.flow === 'bug' || ctx.params.bot || ctx.params.externalBot)
        ? '<button class="step-btn" data-bugstep="live"><b>1</b>Bug hunting</button><button class="step-btn" data-bugstep="report"><b>2</b>Report</button>'
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
    document.getElementById('council-close').addEventListener('click', () => setOpen(false));
    ui.setOpen = setOpen;
    if (ctx.params.dock || ctx.blocked) setOpen(true);
    // A plain visit opens on the Game Manager menu; links with a variant, patch or dock go straight in.
    const q = new URLSearchParams(location.search);
    if (!['variant', 'patch_id', 'dock', 'play'].some((k) => q.has(k))) ui.openManager();
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
    if (this.bugMode) {
      const title = document.querySelector('.council-title small');
      if (title) title.textContent = 'Bug hunting: watch the tester, then read the report';
      document.getElementById('live-link').hidden = true;
      document.querySelectorAll('#stepper [data-bugstep]').forEach((b) =>
        b.addEventListener('click', () => this.showTab(b.dataset.bugstep)));
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
    const start = { analyst: 'report', report: 'report', live: 'live' }[ctx.params.dock];
    if (start) this.showTab(start);
    else if (ctx.params.bot || ctx.params.externalBot || ctx.params.flow === 'bug') this.showTab('live');
  }

  // Steps 1-3 are sections of the Forge panel; step 4 is the Report panel.
  showStep(n) {
    if (n === 4 && this.slide) { this.openReportFull(); return; }
    this.step = n === 4 ? this.step : n;
    this.showTab(n === 4 ? 'report' : 'forge');
  }

  showTab(name) {
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
      if (b.dataset.bugstep) {
        b.classList.toggle('current', this.tab === b.dataset.bugstep);
        b.classList.toggle('done', b.dataset.bugstep === 'live' && this.tab === 'report');
        b.classList.remove('locked');
        b.disabled = false;
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
      for (const ev of data.events) if (ev.event_type === 'stuck') this.addStream(streamLine(ev), 'stuck-row');
      // When the hunt ends, the Report (diagnosis and proposed fixes) opens
      // on its own: no hunting for the right tab.
      if (this.ctx.params.watch && !this.reportOpened
          && (data.summary || data.events.some((e) => e.event_type === 'session_end'))) {
        this.reportOpened = true;
        this.showTab('report');
      }
      for (const s of data.bot_steps || []) {
        this.addStream(`<span class="t">#${s.bot_step_index}</span> <span class="thought">💭 ${esc(s.thought || s.observation_summary || '')}</span>${s.target_id ? ` <span class="t">→ ${esc(s.target_id)}</span>` : ''}`);
      }
      // Show the bot's latest screenshot so the hunt is visible, not just text.
      if (data.bot_next > 0) {
        const n = String(data.bot_next - 1).padStart(3, '0');
        const src = `/api/runs/${encodeURIComponent(runId)}/artifacts/frames/step_${n}.png`;
        for (const img of document.querySelectorAll('#live-frame, #watch-img')) {
          if (!img.src.endsWith(src)) img.src = src;
          img.hidden = false;
        }
        const last = (data.bot_steps || []).slice(-1)[0];
        const status = document.getElementById('watch-status');
        if (status && last) status.textContent = `Step ${last.bot_step_index}: ${last.thought || last.observation_summary || '…'}`;
      }
      if (data.summary) this.stuckEvents = data.summary.stuck_events;
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
        thought: ({ index, thought, target_id, mood }) => this.addStream(
          `<span class="t">#${index}</span>${mood ? ` <span class="mood mood-${esc(mood)}">${esc(mood)}</span>` : ''}`
          + ` <span class="thought">\u{1F4AD} ${esc(thought)}</span>${target_id ? ` <span class="t">→ ${esc(target_id)}</span>` : ''}`),
      };
    }

    if (botMode && this.game) {
      document.getElementById('stub-banner').hidden = false;
      const persona = this.personas.find((x) => x.persona_id === select.value) || null;
      this.bot = new StubBot({
        runId: this.ctx.runId, persona, seed: p.seed,
        maxSimSec: p.playMin ? p.playMin * 60 * (p.speed || 1) * (p.safety || 1) : null,
        stuckSec: p.stuckSec,
        clickAt: this.ctx.clickAt, ringAt: ringAt,
        onThought: ({ index, thought, target_id }) => this.addStream(
          `<span class="t">#${index}</span> <span class="thought">\u{1F4AD} ${esc(thought)}</span>${target_id ? ` <span class="t">→ ${esc(target_id)}</span>` : ''}`),
        onDone: async (reason) => {
          this.game.end(reason);
          await this.ctx.telemetry.drain();
          await this.stopRunRecorder?.();
          this.setBotButton('done');
          const stopBtn = document.getElementById('bot-stop');
          if (stopBtn) stopBtn.hidden = true;
          window.__BOT_DONE__ = reason;
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

  toggleBot() {
    if (!this.bot) {
      const url = new URL(location.href);
      url.searchParams.set('bot', '1');
      url.searchParams.set('persona', document.getElementById('persona-select').value);
      url.searchParams.delete('run_id');
      if (!url.searchParams.has('speed')) url.searchParams.set('speed', '4');
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
    const analysisRun = this.ctx.params.analysisRun || (this.ctx.params.variant === 'A' ? this.ctx.runId : null);
    const fetchAnalysis = async (runId) => {
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/analysis`);
        if (r.ok) return await r.json();
      } catch { /* none yet */ }
      return null;
    };
    if (analysisRun) analysis = await fetchAnalysis(analysisRun);
    if (!analysis && analysisRun !== 'demo_play_A') analysis = await fetchAnalysis('demo_play_A');
    const frame = analysis?.stuck_frame_url
      ? `<img src="${esc(analysis.stuck_frame_url)}" alt="Stuck frame">`
      : 'No stuck frame yet.<br>The analyst agent (SAM 3.1 + Muse Spark) writes one per stalled run.';
    const vs = analysis?.visual_salience;
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
        <div class="section-h">Stuck frame</div>
        <div class="frame-box">${frame}</div>
        ${vsNote}
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
      <div class="section-h">Stuck frame</div>
      <div class="frame-box">${frame}</div>
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
        <div class="section-h">Choose the playtesters</div>
        <div class="guild" id="guild"></div>
        <button class="game-btn amber" id="summon-btn" disabled>▶ Run A/B Playtest</button>
        <div class="note" id="summon-note">Approve the patch first.</div>
        <div class="agents-live" id="agents-live"></div>
      </section>`;
    el.querySelector('#forge-btn').addEventListener('click', () => this.forge());
    el.querySelector('#summon-btn').addEventListener('click', () => this.summon());
    this.showTab(this.tab);
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
        <span class="pr-ico">${esc(x.icon)}</span>
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
    const icon = f.icon_url ? `<img src="${esc(f.icon_url)}?v=${esc(p.patch_id)}" alt="">` : `<span>${esc(f.icon)}</span>`;
    const canDecide = p.status === 'validated';
    const gen = this.emblemSource[p.patch_id] === 'muse_image' ? 'Generated via Muse Image' : 'Procedural stub emblem';
    const seal = { validated: 'Awaiting approval', approved: '✔ Approved', rejected: '✖ Rejected', proposed: 'Pending' }[p.status] || esc(p.status);
    el.innerHTML = `
      <div class="decree ${esc(p.status)}">
        <div class="decree-top">
          <div class="emblem">${icon}${f.icon_url ? `<span class="gen-badge">${gen}</span>` : ''}</div>
          <div class="decree-meta">
            <div class="decree-title">${esc(f.title)}</div>
            <div class="decree-step">${esc(STEP_LABEL[f.unlock_at_step] || f.unlock_at_step)} · ${esc(f.button_salience.replace('_', ' '))}</div>
            <div class="res-row">${badges(f.costs, '-')}${badges(f.rewards, '+')}</div>
          </div>
          <span class="wax-seal ${esc(p.status)}">${seal}</span>
        </div>
        <div class="decree-why">${esc(p.rationale || '')}</div>
        <div class="note">${esc(p.patch_id)}${p.baseline_patch_id ? ` · on top of ${esc(p.baseline_patch_id)}` : ''}${p.status === 'approved' ? ` · <a href="/?variant=B&amp;patch_id=${esc(p.patch_id)}">play it yourself</a>` : ''}</div>
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
      note.textContent = action === 'approve' ? 'Approved by you. Now pick playtesters and run the A/B test.' : 'Rejected. Nothing changes in the game.';
    } catch (err) {
      note.textContent = `Could not ${action}: ${err.message}`;
    }
    this.renderDecree();
    this.showStep(this.feature?.status === 'approved' ? 3 : 1);
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

  async summon() {
    const note = document.getElementById('summon-note');
    const personas = this.personas.map((x) => x.persona_id).filter((id) => this.chosen.has(id));
    const ab = this.abSettings || JSON.parse(localStorage.getItem('doe_ab_settings') || 'null') || {};
    const base = ab.seedSet === 'varied' ? 100 : 42;
    const seeds = ab.seedSet === 'single' ? [42]
      : Array.from({ length: ab.runs || 5 }, (_, i) => base + i);
    try {
      const r = await fetch('/api/feature_studio/playtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch_id: this.feature.patch_id, personas, mode: ab.runner || 'stub',
          seeds, run_type: ab.runType || 'full_window', speed: ab.speed || 4 }),
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
    const tick = async () => {
      try {
        this.job = await (await fetch(`/api/feature_studio/jobs/${this.job.job_id}`)).json();
      } catch { /* retry */ }
      if (this.job.status === 'running') {
        note.textContent = `Playtesting… ${this.job.sessions_started} of ${this.job.sessions_total} sessions started.`;
        this.renderAgents(personas, this.job.sessions || []);
        setTimeout(tick, JOB_POLL_MS);
        return;
      }
      const failed = this.job.status === 'failed' ? this.job.error : null;
      this.job = null;
      this.updateSummon();
      if (failed) { note.textContent = `Playtest failed: ${failed}`; return; }
      this.reportPatch = this.feature.patch_id;
      note.textContent = 'Playtest finished.';
      this.showStep(4);
    };
    tick();
  }

  // One card per playtester: arm A (game without the feature) and arm B (with it).
  renderAgents(personas, sessions) {
    const el = document.getElementById('agents-live');
    const byId = Object.fromEntries(this.personas.map((x) => [x.persona_id, x]));
    const arm = (pid, a) => sessions.find((x) => x.run_id.includes(`_${a}_${pid}_s`));
    el.innerHTML = personas.map((pid) => {
      const x = byId[pid] || {};
      const runs = ['A', 'B'].map((a) => [a, arm(pid, a)]);
      const said = runs.map(([, r]) => r).reverse().find((r) => r?.thought);
      const chip = ([a, r]) => {
        const st = r ? r.state : 'waiting';
        const mark = { done: '✓', playing: '…', waiting: '·' }[st];
        return `<span class="arm st-${st}" title="${a === 'A' ? 'Without' : 'With'} the feature: ${st}">${a} ${mark}</span>`;
      };
      return `<div class="agent-card">
        <span class="ag-ico">${esc(x.emblem || '✦')}</span>
        <div class="ag-body"><div class="ag-h"><b>${esc(x.archetype || pid)}</b>${runs.map(chip).join('')}
          ${said?.mood ? `<span class="mood mood-${esc(said.mood)}">${MOOD_ICON[said.mood] || ''}</span>` : ''}</div>
          ${said ? `<div class="ag-thought">“${esc(said.thought)}”</div>` : ''}</div>
      </div>`;
    }).join('');
  }

  // ------------------------------------------------------ Game Manager
  // First screen (Astra design): two jobs only, Find bugs and Compare a
  // feature, plus a quiet Just play. Each job opens a prefilled setup.
  async openManager() {
    const app = document.getElementById('app');
    const el = document.createElement('div');
    el.id = 'manager';
    el.className = 'manager';
    el.innerHTML = `
      <div class="mgr-panel">
        <div class="mgr-screen" id="mgr-home">
          <div class="mgr-head"><div class="mgr-game">DAWN OF EMPIRES</div><h1>Game Manager</h1>
            <p>What would you like to test?</p></div>
          <div class="mgr-two">
            <div class="mgr-choice">
              <div class="mc-title">FIND BUGS</div>
              <div class="mc-text">Send a tester through the valley and review what went wrong.</div>
              <button class="game-btn amber" id="mgr-to-bug">Set up bug hunt</button>
            </div>
            <div class="mgr-choice">
              <div class="mc-title">A/B TEST A FEATURE</div>
              <div class="mc-text">Run the same tester through the current game and a proposed change.</div>
              <button class="game-btn amber" id="mgr-to-compare">Set up A/B test</button>
            </div>
          </div>
          <button class="game-btn amber mgr-play-btn" id="mgr-skip">Just play</button>
          <div class="mgr-foot">Testing never changes the live game automatically.</div>
        </div>

        <div class="mgr-screen" id="mgr-bug" hidden>
          <div class="mgr-head"><h1>Find problems in the valley</h1></div>
          <div class="mgr-fields">
            <label class="mgr-field">Persona <select id="bug-persona"></select></label>
            <label class="mgr-field">Game version <select id="bug-version"><option value="A" selected>Current game: A</option><option value="B">Variant B (approved feature, if any)</option></select></label>
            <label class="mgr-field">Speed <select id="bug-speed"><option value="4" selected>×4</option><option value="2">×2</option><option value="1">×1</option></select></label>
            <label class="mgr-field">Play time <select id="bug-playtime"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="20" selected>20 minutes</option><option value="30">30 minutes</option></select></label>
            <label class="mgr-field">Seed <select id="bug-seed"><option value="" selected>Automatic (42)</option><option value="42">42</option><option value="43">43</option><option value="44">44</option><option value="7">7</option><option value="123">123</option></select></label>
          </div>
          <details class="mgr-adv"><summary>Advanced settings</summary>
            <div class="mgr-fields">
              <label class="mgr-field">Runner <select id="bug-runner"><option value="meta" selected>Meta bot (paid, via Playwright runner)</option><option value="stub">Scripted bot: no model cost</option></select></label>
              <label class="mgr-field">Safety limit <select id="bug-safety"><option value="1" selected>Play time, elapsed</option><option value="1.5">Play time + 50%</option><option value="2">Play time ×2</option></select></label>
              <label class="mgr-field">No-progress limit <select id="bug-stuck"><option value="30">30 sim seconds without progress</option><option value="60" selected>60 sim seconds without progress</option><option value="120">120 sim seconds without progress</option></select></label>
              <label class="mgr-field">Run video <span class="mgr-static"><input type="checkbox" id="bug-video"> Record video.webm</span></label>
            </div>
          </details>
          <div class="mgr-note">The scripted bot drives this tab with real clicks. The Meta bot runs on the server and saves its whole run (screenshots, thoughts, telemetry) for the report.</div>
          <div class="mgr-actions">
            <button class="game-btn amber" id="bug-start">Start bug hunt</button>
            <button class="mgr-justplay" data-back>Back</button>
          </div>
        </div>

        <div class="mgr-screen" id="mgr-compare" hidden>
          <div class="mgr-head"><h1>A/B test a proposed feature</h1></div>
          <div class="mgr-section">Feature</div>
          <div class="mgr-cards" id="mgr-cards"><div class="note">Loading…</div></div>
          <div class="mgr-section">Or describe your own idea</div>
          <div class="mgr-own">
            <textarea id="mgr-prompt" rows="2" maxlength="600" placeholder="A bonfire after the tutorial that costs 15 wood and gives 30 food."></textarea>
            <button class="game-btn emerald" id="mgr-forge">✦ Ask Muse Spark</button>
          </div>
          <div class="mgr-note" id="mgr-note"></div>
          <div id="mgr-draft"></div>
          <div class="mgr-fields">
            <label class="mgr-field">Persona <select id="cmp-persona"></select></label>
            <label class="mgr-field">Seed set <select id="cmp-seeds"><option value="baseline" selected>Saved baseline, paired (42…)</option><option value="varied">Varied seeds, paired (100…)</option><option value="single">Single seed 42, paired</option></select></label>
            <label class="mgr-field">Runs per variant <select id="cmp-runs"><option value="1">1</option><option value="3">3</option><option value="5" selected>5</option><option value="10">10</option></select></label>
            <label class="mgr-field">Runner <select id="cmp-runner"><option value="stub" selected>Scripted bot: no model cost</option><option value="meta">Meta bot (paid, Muse Spark)</option></select></label>
            <label class="mgr-field">Speed <select id="cmp-speed"><option value="1">×1</option><option value="2">×2</option><option value="4" selected>×4</option></select></label>
            <label class="mgr-field">Run length <select id="cmp-runlength"><option value="full_window" selected>Full journey: Chapters I–VI</option><option value="onboarding">Onboarding only: Chapter I</option></select></label>
            <label class="mgr-field">Play time per run <select id="cmp-playtime"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="20" selected>20 minutes</option><option value="30">30 minutes</option></select></label>
          </div>
          <div class="mgr-summary" id="cmp-summary">A · Current game<br>B · Current game + (pick a feature above)<br><br>Success target: More runs complete onboarding<br>Guardrails: No new blockers or worse chapter completion</div>
          <div class="mgr-actions">
            <button class="game-btn amber" id="cmp-start">Run comparison</button>
            <button class="mgr-justplay" data-back>Back</button>
          </div>
        </div>
      </div>`;
    app.appendChild(el);
    const show = (id) => {
      el.querySelectorAll('.mgr-screen').forEach((s) => { s.hidden = s.id !== id; });
    };
    el.querySelector('#mgr-skip').addEventListener('click', () => this.closeManager(false));
    el.querySelector('#mgr-to-bug').addEventListener('click', () => show('mgr-bug'));
    el.querySelector('#mgr-to-compare').addEventListener('click', () => show('mgr-compare'));
    el.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('mgr-home')));
    el.querySelector('#mgr-forge').addEventListener('click', () => this.managerForge());
    el.querySelector('#bug-start').addEventListener('click', () => {
      const persona = document.getElementById('bug-persona').value;
      if (document.getElementById('bug-runner').value === 'meta') {
        this.startMetaBotHunt({
          persona, variant: document.getElementById('bug-version').value,
          seed: Number(document.getElementById('bug-seed').value || 42),
          speed: Number(document.getElementById('bug-speed').value),
          play_minutes: Number(document.getElementById('bug-playtime').value),
          record_video: !!document.getElementById('bug-video')?.checked,
          mode: 'meta',
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
        runner: document.getElementById('cmp-runner').value,
        speed: Number(document.getElementById('cmp-speed').value),
        runType: document.getElementById('cmp-runlength').value,
      };
      localStorage.setItem('doe_ab_settings', JSON.stringify(this.abSettings));
      this.managerPick(this.comparePreset);
    });

    let status = { meta_ready: false, muse_model_id: '' };
    try { status = await (await fetch('/api/feature_studio/status')).json(); } catch { /* stub */ }
    this.museMode = status.meta_ready ? 'meta' : 'stub';
    document.getElementById('mgr-note').textContent = status.meta_ready
      ? `Your idea goes live to the designer agent (${status.muse_model_id}). It takes about half a minute.`
      : 'No META_API_KEY in .env, so the offline stub designer drafts your idea.';

    await this.personasReady;
    const personaOpts = this.personas.map((x) => `<option value="${esc(x.persona_id)}">${esc(x.emblem || '')} ${esc(x.archetype || x.label)}</option>`).join('');
    for (const id of ['bug-persona', 'cmp-persona']) {
      const sel = document.getElementById(id);
      sel.innerHTML = personaOpts;
      const imp = this.personas.find((x) => x.persona_id === 'impatient_newcomer');
      if (imp) sel.value = imp.persona_id;
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
    setTimeout(() => { location.href = `/?run_id=${encodeURIComponent(job.run_id)}&flow=bug&dock=live&watch=1`; }, 1200);
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
      modal.innerHTML = `<div class="rf-head"><h2>Playtest report</h2>
        <button class="council-close" id="report-close" aria-label="Close the report">✕</button></div><div class="rf-body"></div>`;
      document.getElementById('app').appendChild(modal);
      modal.querySelector('#report-close').addEventListener('click', () => this.closeReportFull());
    }
    const tab = document.getElementById('tab-report');
    modal.querySelector('.rf-body').appendChild(tab);
    // Drop the previous report so nothing stale shows while the new one loads.
    tab.innerHTML = '';
    tab.hidden = false;
    modal.hidden = false;
    this.setOpen?.(false);
    this.renderReport();
  }

  closeReportFull() {
    const modal = document.getElementById('report-full');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.getElementById('director').appendChild(document.getElementById('tab-report'));
    this.showTab(this.tab === 'report' ? 'forge' : this.tab);
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
      el.innerHTML = `<button class="back-menu-btn" id="report-back">← Back to Main Menu</button>
        <div id="report-loop"></div>`;
      el.querySelector('#report-back').addEventListener('click', () => { location.href = '/'; });
      await this.renderAnalyst();
      return;
    }
    let report = this.reportPatch ? await this.fetchStudioReport(this.reportPatch) : null;
    let demos = [];
    try {
      const r = await fetch('/api/feature_studio/demos');
      if (r.ok) demos = await r.json();
    } catch { /* no switcher */ }
    if (!report) {
      // No playtest has run yet: no report to show, and no recorded demo
      // report as a placeholder. The Report step unlocks after step 3.
      el.innerHTML = `<div class="note">No playtest has run yet. Run a playtest at step 3 first; its report opens here. Below: the analyst's diagnosis of the onboarding.</div>
        <div id="report-loop"></div><div class="section-h">Onboarding fix A/B</div><div id="report-ab"></div>`;
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
    const quotes = report.quotes.map((q) => {
      const x = byId[q.persona_id] || {};
      return `<div class="speech"><div class="sp-h">${esc(x.emblem || '')} ${esc(x.archetype || q.persona_id)}
          <span class="mood mood-${esc(q.mood)}">${MOOD_ICON[q.mood] || ''} ${esc(q.mood)}</span></div>
        <div class="sp-t">“${esc(q.thought)}”</div><div class="sp-o">${esc(q.outcome)}</div></div>`;
    }).join('');
    const p = report.plaques;
    const demoIds = new Set(demos.filter((d) => d.source === 'demo').map((d) => d.patch_id));
    const pillIcon = { positive: '✅', hurts: '❌', mixed: '⚠️' };
    const pills = demos.length ? `
      <div class="demo-pills"><span class="demo-pills-label">Reports:</span>${demos.map((d) => `
        <button class="demo-pill${d.patch_id === report.patch_id ? ' active' : ''}${d.source === 'live' ? ' live' : ''}" data-pid="${esc(d.patch_id)}"
          title="${esc(d.verdict_label)} · ${esc(d.title)} (${esc(d.patch_id)}${d.source === 'live' ? ', this session' : ', recorded demo'})">${esc(d.short)} ${pillIcon[d.verdict_key] || ''}${d.source === 'live' ? ' ●' : ''}</button>`).join('')}</div>
      ${demoIds.has(report.patch_id) ? '<div class="note">Recorded demo report. Pick a feature in the Game Manager or step 1 to playtest it live.</div>' : ''}` : '';
    el.innerHTML = `
      ${pills}
      <div class="verdict ${esc(report.key)}">${esc(report.label)}</div>
      <div class="takeaway">${esc(report.takeaway)}</div>
      <div class="plaques">${plaque('Tutorial finished', p.onboarding)}${plaque('Stuck events', p.stuck, false)}${plaque('Reached Stone Age', p.stone_age)}${plaque('Mean score', p.score)}</div>
      <div class="charts">
        <div class="chart"><div class="chart-h">Players who got there · A without the feature, B with it</div>
          ${bars('Tutorial', p.onboarding)}${bars('Stone Age', p.stone_age)}</div>
        ${rows.length ? `<div class="chart"><div class="chart-h">Score change per playtester (B − A)</div>${deltas}</div>` : ''}
      </div>
      <div class="quotes">${quotes}</div>
      <div class="note">${esc(report.patch_id)} vs ${esc(report.baseline)} · ${esc(report.n_pairs)} paired runs · ${esc(report.provider_mode)} · $${esc(report.cost_usd)}</div>
      <div class="decide">
        <button class="game-btn bronze" id="rework-btn" ${report.key === 'positive' ? 'disabled' : ''}>⚒️ Ask AI for a Fix</button>
        <button class="game-btn iron" id="replay-btn" ${report.replay ? '' : 'disabled'}>\u{1F3AC} Watch A/B Replay</button>
      </div>
      <div class="note" id="rework-note"></div>
      <details class="onboarding-details"><summary class="section-h">Onboarding fix patch_001: diagnosis and A/B</summary>
        <div id="report-loop"></div><div class="section-h">Onboarding fix A/B</div><div id="report-ab"></div></details>`;
    el.querySelector('#rework-btn').addEventListener('click', () => this.rework(report.patch_id));
    el.querySelectorAll('.demo-pill').forEach((b) => b.addEventListener('click', () => {
      this.reportPatch = b.dataset.pid;
      this.renderReport();
    }));
    el.querySelector('#replay-btn').addEventListener('click', () => {
      // Stub runs need dev=1, and the replay then labels them STUB / DEV MODE.
      const dev = report.provider_mode === 'meta' ? '' : '&dev=1';
      location.href = `/?replay_a=${encodeURIComponent(report.replay.A)}&replay_b=${encodeURIComponent(report.replay.B)}${dev}`;
    });
    await this.renderAnalyst();
    await this.renderAb();
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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
