// #right-dock: Telemetry Pill + AI Director (Live, Analyst & Designer, A/B Summary).
//
// Every number shown here comes from the game's own events or from the
// backend (server-derived stuck events, analyst output, A/B summary). When a
// source does not exist yet, the dock says so instead of showing a value.

import { StubBot } from './stub_bot.js';

const PATCH_ID = 'patch_001';
const POLL_MS = 1000;
const STREAM_MAX = 80;

export function initOverlay(ctx) {
  const dock = ctx.dock;
  dock.innerHTML = `
    <div class="pill" id="pill">
      <div class="pill-row"><span class="muted">step</span><span class="step" id="pill-step">-</span>
        <span class="badge variant-${ctx.params.variant}" id="pill-variant">${ctx.params.variant}${ctx.params.patchId ? ` · ${esc(ctx.params.patchId)}` : ''}</span></div>
      <div class="pill-row" style="margin-top:4px"><span class="muted">Time to 1st action</span><b id="pill-ttfa">-</b></div>
      <div class="checklist" id="pill-check"></div>
      <div class="pill-row" style="margin-top:6px"><span class="muted">stuck_events <span class="note">(server-derived)</span></span>
        <span class="stuck-count" id="pill-stuck">0</span></div>
    </div>
    <div class="director" id="director">
      <div class="director-title" id="director-title"><span>AI DIRECTOR</span><span id="director-caret">▾</span></div>
      <div class="tabs">
        <button class="tab active" data-tab="live">Live</button>
        <button class="tab" data-tab="analyst">Analyst &amp; Designer</button>
        <button class="tab" data-tab="ab">A/B Summary</button>
      </div>
      <div class="tab-body" id="tab-live"></div>
      <div class="tab-body" id="tab-analyst" hidden></div>
      <div class="tab-body" id="tab-ab" hidden></div>
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

    document.querySelectorAll('#director .tab').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.tab)));
    document.getElementById('director-title').addEventListener('click', () => {
      const body = document.querySelector('#director .tabs');
      const hidden = !body.hidden;
      body.hidden = hidden;
      document.querySelectorAll('#director .tab-body').forEach((el) => { el.style.display = hidden ? 'none' : ''; });
      document.getElementById('director-caret').textContent = hidden ? '▸' : '▾';
    });

    this.renderLive();
    this.renderAnalyst();
    this.renderAb();
    if (ctx.telemetry) ctx.telemetry.listeners.push((ev) => this.onEvent(ev));
    if (this.game) setInterval(() => this.poll(), POLL_MS);
    if (ctx.params.dock === 'analyst') this.showTab('analyst');
  }

  showTab(name) {
    document.querySelectorAll('#director .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    for (const t of ['live', 'analyst', 'ab']) document.getElementById(`tab-${t}`).hidden = t !== name;
    if (name === 'analyst') this.renderAnalyst();
    if (name === 'ab') this.renderAb();
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
      for (const ev of data.events) if (ev.event_type === 'stuck') this.addStream(streamLine(ev), 'stuck');
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
      el.querySelector('#bot-note').textContent = 'This variant needs an approved patch. Open the Analyst & Designer tab.';
      this.showTab('analyst');
    }
    try {
      this.personas = await (await fetch('/api/personas')).json();
    } catch { this.personas = []; }
    const select = document.getElementById('persona-select');
    select.innerHTML = this.personas.map((x) => `<option value="${esc(x.persona_id)}">${esc(x.label)}</option>`).join('');
    select.value = p.persona && this.personas.some((x) => x.persona_id === p.persona) ? p.persona : (this.personas[0]?.persona_id || '');
    select.disabled = botMode;
    document.getElementById('bot-btn').addEventListener('click', () => this.toggleBot());

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
    const el = document.getElementById('tab-analyst');
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
      ? `<div class="note" style="color:#e9e2d4">${esc(analysis.diagnosis)}</div>`
      : `<div class="note">No analyst diagnosis for this run yet.</div>`;
    const rows = Object.entries(patch.body).map(([k, v]) => `<div><span class="k">${esc(k)}</span>: <span class="from">${esc(JSON.stringify(base?.[k]))}</span> → <span class="to">${esc(JSON.stringify(v))}</span></div>`).join('');
    const valid = validation?.valid;
    const decided = ['approved', 'rejected'].includes(patch.status);
    const canDecide = patch.status === 'validated';
    el.innerHTML = `
      <div class="section-h">Stuck frame</div>
      <div class="frame-box">${frame}</div>
      <div class="section-h">Diagnosis</div>
      ${diagnosis}
      <div class="section-h">${esc(patch.patch_id)} · ${esc(patch.title || '')}</div>
      <div class="note">${esc(patch.rationale || '')}</div>
      <div class="diff">${rows}</div>
      <span class="valid ${valid ? '' : 'bad'}">Schema: ${valid ? 'VALID' : 'INVALID'} (Pydantic)</span>
      <div class="status-line">Status: <b id="patch-status">${esc(patch.status)}</b>${audit.length ? ` <span class="note">· ${audit.length} audit entr${audit.length === 1 ? 'y' : 'ies'}</span>` : ''}</div>
      <div class="decide">
        <button class="approve" id="btn-approve" ${canDecide ? '' : 'disabled'}>✔ Approve Patch</button>
        <button class="reject" id="btn-reject" ${canDecide ? '' : 'disabled'}>Reject</button>
      </div>
      <div class="note" id="decide-note" style="margin-top:6px">${decided
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
    if (this.ctx.blocked && action === 'approve') setTimeout(() => location.reload(), 900);
  }

  // ------------------------------------------------------- A/B Summary
  async renderAb() {
    const el = document.getElementById('tab-ab');
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
      ${data.n_pairs !== undefined ? `<div class="note" style="margin-top:6px">${fmt(data.n_pairs)} paired runs · ${esc(data.provider_mode || '')}</div>` : ''}
      ${data.conclusion ? `<div class="note" style="margin-top:6px;color:#e9e2d4">${esc(data.conclusion)}</div>` : ''}`;
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
