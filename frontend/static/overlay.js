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

export function initOverlay(ctx) {
  const dock = ctx.dock;
  dock.innerHTML = `
    <div class="council-crest"><span class="crest-gem">✦</span>ARCHITECT'S COUNCIL · AI PLAYTEST STUDIO</div>
    <div class="pill" id="pill">
      <div class="pill-row"><span class="step" id="pill-step">-</span>
        <span class="badge variant-${ctx.params.variant}" id="pill-variant">${ctx.params.variant}${ctx.params.patchId ? ` · ${esc(ctx.params.patchId)}` : ''}</span>
        <span class="muted" title="Server-derived stuck events">stuck <span class="stuck-count" id="pill-stuck">0</span></span></div>
      <div class="pill-row"><span class="checklist" id="pill-check"></span><span class="muted">1st action <b id="pill-ttfa">-</b></span></div>
    </div>
    <div class="director" id="director">
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="forge" role="tab">\u{1F4DC} Feature Forge</button>
        <button class="tab" data-tab="report" role="tab">\u{1F3DB}️ Council Report</button>
        <button class="tab" data-tab="live" role="tab">\u{1F441}️ Live Chronicle</button>
      </div>
      <div class="tab-body" id="tab-forge"></div>
      <div class="tab-body" id="tab-report" hidden></div>
      <div class="tab-body" id="tab-live" hidden></div>
    </div>`;

  const ui = new Overlay(ctx);
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

    document.querySelectorAll('#director .tab').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));

    this.personasReady = fetch('/api/personas').then((r) => r.json()).catch(() => []).then((rows) => {
      this.personas = rows;
      rows.forEach((x) => this.chosen.add(x.persona_id));
      return rows;
    });
    this.renderLive();
    this.renderForge();
    if (ctx.telemetry) ctx.telemetry.listeners.push((ev) => this.onEvent(ev));
    if (this.game) setInterval(() => this.poll(), POLL_MS);
    const start = { analyst: 'report', report: 'report', live: 'live' }[ctx.params.dock];
    if (start) this.showTab(start);
    else if (ctx.params.bot || ctx.params.externalBot) this.showTab('live');
  }

  showTab(name) {
    document.querySelectorAll('#director .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const t of TABS) document.getElementById(`tab-${t}`).hidden = t !== name;
    if (name === 'report') this.renderReport();
  }

  // --------------------------------------------------------------- Pill
  update() {
    const g = this.game;
    if (!g) return;
    const has = (type) => g.buildings.some((b) => b.type === type && b.status === 'done');
    const sig = [g.step_id, g.stats.first_click_t, has('shelter'), g.stats.forager_harvests > 0, g.techs.has('tech_toolmaking'), this.stuckEvents].join('|');
    if (sig === this.lastPillSig) return;
    this.lastPillSig = sig;
    document.getElementById('pill-step').textContent = g.achieved ? `${g.step_id} ★` : g.step_id;
    document.getElementById('pill-ttfa').textContent = g.stats.first_click_t === null ? 'waiting…' : `${g.stats.first_click_t.toFixed(1)}s sim`;
    const item = (done, label) => `<span class="${done ? 'ok' : 'todo'}">[${done ? '✓' : ' '}] ${label}</span>`;
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
      if (data.summary) this.stuckEvents = data.summary.stuck_events;
    } catch { /* server restarting; retry next tick */ }
  }

  // --------------------------------------------------------------- Live
  async renderLive() {
    const el = document.getElementById('tab-live');
    const p = this.ctx.params;
    const botMode = !!p.bot;
    el.innerHTML = `
      <div class="row"><select class="persona" id="persona-select" aria-label="Persona"></select>
        <span class="badge" title="Map and policy seed">seed ${p.seed}</span></div>
      <button class="bot-btn" id="bot-btn">▶ Watch Bot Play</button>
      <div class="note" id="bot-note" style="margin-top:4px">${botMode
        ? 'Stub persona policy, variant-blind: it only sees rendered targets. Live Muse Spark runs come from the Playwright runner (--mode meta).'
        : 'Reloads this variant with a scripted persona bot driving real clicks.'}</div>
      <div class="section-h">Event &amp; thought stream</div>
      <div class="stream" id="stream"></div>`;
    if (this.ctx.blocked) {
      el.querySelector('#bot-btn').disabled = true;
      el.querySelector('#bot-note').textContent = 'This variant needs an approved patch. Open the Council Report tab.';
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
        clickAt: this.ctx.clickAt, ringAt: ringAt,
        onThought: ({ index, thought, target_id }) => this.addStream(
          `<span class="t">#${index}</span> <span class="thought">\u{1F4AD} ${esc(thought)}</span>${target_id ? ` <span class="t">→ ${esc(target_id)}</span>` : ''}`),
        onDone: async (reason) => {
          this.game.end(reason);
          await this.ctx.telemetry.drain();
          this.setBotButton('done');
          window.__BOT_DONE__ = reason;
        },
      });
      window.__STUB_BOT__ = this.bot;
      this.bot.start();
      this.setBotButton('running');
    }
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
    try {
      const r = await fetch(`/api/patches/${PATCH_ID}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ({ patch, validation, audit } = await r.json());
      base = (await (await fetch('/api/config?variant=A')).json()).config;
    } catch (err) {
      el.innerHTML = `<div class="note">No patch available (${esc(err.message)}).</div>`;
      return;
    }
    const analysisRun = this.ctx.params.analysisRun || (this.ctx.params.variant === 'A' ? this.ctx.runId : null);
    if (analysisRun) {
      try {
        const r = await fetch(`/api/runs/${encodeURIComponent(analysisRun)}/analysis`);
        if (r.ok) analysis = await r.json();
      } catch { /* none yet */ }
    }
    const frame = analysis?.stuck_frame_url
      ? `<img src="${esc(analysis.stuck_frame_url)}" alt="Stuck frame">`
      : 'No stuck frame yet.<br>The analyst agent (SAM 3.1 + Muse Spark) writes one per stalled run.';
    const diagnosis = analysis?.diagnosis
      ? `<div class="note ink">${esc(analysis.diagnosis)}</div>`
      : `<div class="note">No analyst diagnosis for this run yet.</div>`;
    const quotes = (analysis?.playtester_quotes || []).map((q) => `<div class="quote"><span class="mood mood-${esc(q.player_mood || 'engaged')}">${esc(q.player_mood || 'engaged')}</span> “${esc(q.thought)}” <span class="note">step ${esc(q.bot_step_index)} · ${esc(q.trigger)}</span></div>`).join('');
    const rows = Object.entries(patch.body).map(([k, v]) => `<div><span class="k">${esc(k)}</span>: <span class="from">${esc(JSON.stringify(base?.[k]))}</span> → <span class="to">${esc(JSON.stringify(v))}</span></div>`).join('');
    const valid = validation?.valid;
    const decided = ['approved', 'rejected'].includes(patch.status);
    const canDecide = patch.status === 'validated';
    el.innerHTML = `
      <div class="section-h">Stuck frame</div>
      <div class="frame-box">${frame}</div>
      <div class="section-h">Diagnosis</div>
      ${diagnosis}
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
        : 'Human approval gate: nothing is applied until you approve.'}</div>`;
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
      <div class="scroll-input">
        <textarea id="forge-prompt" rows="3" maxlength="600" placeholder="Describe a new feature in your own words. Example: a glowing raider ambush in the tutorial that costs 20 wood and gives 10 RP."></textarea>
        <button class="game-btn emerald" id="forge-btn">✦ Forge Feature Variant</button>
      </div>
      <div class="note" id="forge-note">The architect agent drafts a config patch. Nothing reaches players until you approve it.</div>
      <div id="decree"></div>
      <div class="section-h">Summon the playtester guild</div>
      <div class="guild" id="guild"></div>
      <button class="game-btn amber" id="summon-btn" disabled>▶ Summon Playtesters</button>
      <div class="note" id="summon-note">Approve a decree first.</div>`;
    el.querySelector('#forge-btn').addEventListener('click', () => this.forge());
    el.querySelector('#summon-btn').addEventListener('click', () => this.summon());
    await this.personasReady;
    this.renderGuild();
    this.feature = await this.latestFeature();
    this.renderDecree();
  }

  renderGuild() {
    const el = document.getElementById('guild');
    el.innerHTML = this.personas.map((x) => `
      <button class="medallion ${this.chosen.has(x.persona_id) ? 'on' : ''}" data-id="${esc(x.persona_id)}" aria-pressed="${this.chosen.has(x.persona_id)}"
        title="${esc(x.description)}&#10;${esc((x.grounding || []).join('; '))}">
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

  async forge() {
    const prompt = document.getElementById('forge-prompt').value.trim();
    const note = document.getElementById('forge-note');
    if (!prompt) { note.textContent = 'Describe the feature first.'; return; }
    const btn = document.getElementById('forge-btn');
    btn.disabled = true;
    note.textContent = 'The architect agent is drafting the decree…';
    try {
      const r = await fetch('/api/feature_studio/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, mode: 'stub' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `HTTP ${r.status}`);
      this.feature = data.patch;
      this.emblemSource[data.patch.patch_id] = data.emblem_source;
      note.textContent = `${data.patch.patch_id} staged as ${data.patch.status}. Review the decree below.`;
    } catch (err) {
      note.textContent = `Could not forge: ${err.message}`;
    }
    btn.disabled = false;
    this.renderDecree();
  }

  renderDecree() {
    const el = document.getElementById('decree');
    const p = this.feature;
    if (!p) { el.innerHTML = ''; this.updateSummon(); return; }
    const f = p.body.feature_plugin;
    const badges = (obj, sign) => Object.entries(obj || {}).map(([k, v]) => `<span class="res-badge ${sign === '-' ? 'cost' : 'gain'}">${RES_ICON[k] || ''} ${sign}${esc(v)}</span>`).join('');
    const icon = f.icon_url ? `<img src="${esc(f.icon_url)}?v=${esc(p.patch_id)}" alt="">` : `<span>${esc(f.icon)}</span>`;
    const canDecide = p.status === 'validated';
    const gen = this.emblemSource[p.patch_id] === 'muse_image' ? 'Generated via Muse Image' : 'Procedural stub emblem';
    const seal = { validated: '✔ Validated', approved: '✔ Approved', rejected: '✖ Dismissed', proposed: 'Pending' }[p.status] || esc(p.status);
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
        <div class="note">${esc(p.patch_id)}${p.baseline_patch_id ? ` · stacked on ${esc(p.baseline_patch_id)}` : ''}${p.status === 'approved' ? ` · <a href="/?variant=B&amp;patch_id=${esc(p.patch_id)}">play it</a>` : ''}</div>
        <div class="decide">
          <button class="game-btn emerald" id="decree-approve" ${canDecide ? '' : 'disabled'}>✔ Approve Decree</button>
          <button class="game-btn iron" id="decree-dismiss" ${canDecide ? '' : 'disabled'}>✖ Dismiss</button>
        </div>
      </div>`;
    el.querySelector('#decree-approve').addEventListener('click', () => this.decideFeature('approve'));
    el.querySelector('#decree-dismiss').addEventListener('click', () => this.decideFeature('reject'));
    this.updateSummon();
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
      note.textContent = action === 'approve' ? 'Decree approved by a human. Summon the playtesters.' : 'Decree dismissed. Nothing changes.';
    } catch (err) {
      note.textContent = `Could not ${action}: ${err.message}`;
    }
    this.renderDecree();
    document.getElementById('summon-note').scrollIntoView({ block: 'nearest' });
  }

  updateSummon() {
    const btn = document.getElementById('summon-btn');
    const note = document.getElementById('summon-note');
    if (!btn) return;
    const ready = this.feature?.status === 'approved' && this.chosen.size > 0 && !this.job;
    btn.disabled = !ready;
    if (this.job) return;
    note.textContent = this.feature?.status !== 'approved' ? 'Approve a decree first.'
      : this.chosen.size ? `${this.chosen.size} persona${this.chosen.size === 1 ? '' : 's'} × arms A and B, stub policy, no Meta API cost.`
        : 'Pick at least one persona.';
  }

  async summon() {
    const note = document.getElementById('summon-note');
    const personas = this.personas.map((x) => x.persona_id).filter((id) => this.chosen.has(id));
    try {
      const r = await fetch('/api/feature_studio/playtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch_id: this.feature.patch_id, personas, mode: 'stub' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      this.job = data;
    } catch (err) {
      note.textContent = `Could not summon: ${err.message}`;
      return;
    }
    this.updateSummon();
    note.scrollIntoView({ block: 'nearest' });
    const tick = async () => {
      try {
        this.job = await (await fetch(`/api/feature_studio/jobs/${this.job.job_id}`)).json();
      } catch { /* retry */ }
      if (this.job.status === 'running') {
        note.textContent = `Playtesting: ${this.job.sessions_started} of ${this.job.sessions_total} sessions started…`;
        setTimeout(tick, JOB_POLL_MS);
        return;
      }
      const failed = this.job.status === 'failed' ? this.job.error : null;
      this.job = null;
      this.updateSummon();
      if (failed) { note.textContent = `Playtest failed: ${failed}`; return; }
      this.reportPatch = this.feature.patch_id;
      this.showTab('report');
    };
    tick();
  }

  // ------------------------------------------------------ Council Report
  async renderReport() {
    const el = document.getElementById('tab-report');
    const pid = this.reportPatch || this.feature?.patch_id;
    let report = null;
    if (pid) {
      try {
        const r = await fetch(`/api/feature_studio/report/${encodeURIComponent(pid)}`);
        if (r.ok) report = await r.json();
      } catch { /* none yet */ }
    }
    if (!report) {
      el.innerHTML = `<div class="note">No feature playtest yet: forge a decree, approve it and summon playtesters. Below is the analyst's onboarding diagnosis.</div>
        <div id="report-loop"></div><div class="section-h">Onboarding fix A/B</div><div id="report-ab"></div>`;
      await this.renderAnalyst();
      await this.renderAb();
      return;
    }
    const byId = Object.fromEntries(this.personas.map((x) => [x.persona_id, x]));
    const plaque = (label, v) => `<div class="plaque"><div class="pl-h">${label}</div><div class="pl-v">${esc(v.A)} <span>→</span> <b>${esc(v.B)}</b></div></div>`;
    const quotes = report.quotes.map((q) => {
      const x = byId[q.persona_id] || {};
      return `<div class="speech"><div class="sp-h">${esc(x.emblem || '')} ${esc(x.archetype || q.persona_id)}
          <span class="mood mood-${esc(q.mood)}">${MOOD_ICON[q.mood] || ''} ${esc(q.mood)}</span></div>
        <div class="sp-t">“${esc(q.thought)}”</div><div class="sp-o">${esc(q.outcome)}</div></div>`;
    }).join('');
    const p = report.plaques;
    el.innerHTML = `
      <div class="verdict ${esc(report.key)}">${esc(report.label)}</div>
      <div class="takeaway">${esc(report.takeaway)}</div>
      <div class="plaques">${plaque('Onboarding', p.onboarding)}${plaque('Stuck events', p.stuck)}${plaque('Stone Age', p.stone_age)}${plaque('Score', p.score)}</div>
      <div class="quotes">${quotes}</div>
      <div class="note">${esc(report.patch_id)} vs ${esc(report.baseline)} · ${esc(report.n_pairs)} paired runs · ${esc(report.provider_mode)} · $${esc(report.cost_usd)}</div>
      <div class="decide">
        <button class="game-btn bronze" id="rework-btn" ${report.key === 'positive' ? 'disabled' : ''}>⚒️ Forge Feature Rework</button>
        <button class="game-btn iron" id="replay-btn" ${report.replay ? '' : 'disabled'}>\u{1F3AC} Watch Split Replay</button>
      </div>
      <div class="note" id="rework-note"></div>`;
    el.querySelector('#rework-btn').addEventListener('click', () => this.rework(report.patch_id));
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
      this.showTab('forge');
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
