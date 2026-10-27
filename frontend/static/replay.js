// Side-by-side replay: /?replay_a=<run>&replay_b=<run>&speed=4
//
// Each panel re-simulates a recorded run: a fresh Game in replay mode with the
// run's resolved config, fed the recorded click target_ids at their recorded
// sim times. The game state is a pure function of (config, clicks, times), so
// the panels show what the playtester saw, on one synchronized sim clock.
// Runs that were not played by live Muse Spark (provider_mode != meta) are
// refused unless ?dev=1 is set, so a stub run is never presented as real.

import { Game } from './game.js';
import { IsoRenderer } from './iso_renderer.js';
import { loadSprites } from './sprites.js';

const TAIL_SEC = 3;

export async function startReplay(params) {
  document.getElementById('app').hidden = true;
  const root = document.getElementById('replay-root');
  root.hidden = false;
  root.innerHTML = `<div class="rp-head">Replay · A vs B<span class="clock" id="rp-clock"></span></div><div id="rp-body"></div>`;
  const body = document.getElementById('rp-body');
  window.__REPLAY_STATE__ = { ready: false };

  if (!params.replayA || !params.replayB) {
    body.innerHTML = '<div class="rp-msg">Replay needs both <code>replay_a</code> and <code>replay_b</code> run ids.</div>';
    return;
  }
  let recA;
  let recB;
  try {
    [recA, recB] = await Promise.all([fetchRecording(params.replayA), fetchRecording(params.replayB)]);
  } catch (err) {
    body.innerHTML = `<div class="rp-msg">${esc(err.message)}</div>`;
    window.__REPLAY_STATE__ = { ready: false, error: err.message };
    return;
  }
  const nonMeta = [recA, recB].filter((r) => providerOf(r) !== 'meta');
  if (nonMeta.length && !params.dev) {
    body.innerHTML = `<div class="rp-msg"><b>Refusing to replay non-live runs.</b><br>
      ${nonMeta.map((r) => `${esc(r.meta?.run_id)}: provider_mode = ${esc(providerOf(r))}`).join('<br>')}<br><br>
      Replays in the demo show live Muse Spark runs only. Add <code>&amp;dev=1</code> to view stub runs for development.</div>`;
    window.__REPLAY_STATE__ = { ready: false, refused: true };
    return;
  }
  if (nonMeta.length) {
    const banner = document.createElement('div');
    banner.className = 'stub-banner';
    banner.style.top = '9px';
    banner.textContent = 'STUB / DEV MODE — NOT LIVE MUSE SPARK';
    root.appendChild(banner);
  }

  const sprites = await loadSprites();
  body.innerHTML = '<div class="rp-panels" id="rp-panels"></div>';
  const panels = [new Panel('A', recA, sprites), new Panel('B', recB, sprites)];
  for (const p of panels) document.getElementById('rp-panels').appendChild(p.el);
  // Name both sides when the runs are not a matched pair, so a mismatch is never hidden.
  const [ma, mb] = [recA.meta || {}, recB.meta || {}];
  const side = (k, fallback) => (ma[k] ?? fallback) === (mb[k] ?? fallback)
    ? `${ma[k] ?? fallback}` : `A ${ma[k] ?? fallback} / B ${mb[k] ?? fallback}`;
  document.querySelector('.rp-head').firstChild.textContent =
    `Replay · seed ${side('seed', '-')} · ${side('persona_id', 'human')} · ${params.speed}x `;

  const end = Math.max(...panels.map((p) => p.lastT)) + TAIL_SEC;
  let t = 0;
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t = Math.min(end, t + dt * params.speed);
    for (const p of panels) p.advance(t, dt);
    document.getElementById('rp-clock').textContent = `sim ${t.toFixed(1)}s`;
    window.__REPLAY_STATE__ = {
      ready: true, t, done: t >= end,
      A: panels[0].state(), B: panels[1].state(),
    };
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

class Panel {
  constructor(side, rec, sprites) {
    this.side = side;
    this.rec = rec;
    const meta = rec.meta || {};
    this.clicks = rec.events.filter((e) => e.event_type === 'click')
      .map((e) => ({ t: e.sim_elapsed_sec, target: e.payload?.target_id, x: e.payload?.x, y: e.payload?.y }));
    this.stuckAt = rec.events.find((e) => e.event_type === 'stuck')?.sim_elapsed_sec ?? null;
    this.achievedAt = rec.events.find((e) => e.event_type === 'achievement')?.sim_elapsed_sec ?? null;
    this.lastT = rec.events.length ? rec.events[rec.events.length - 1].sim_elapsed_sec : 0;
    this.whereStuck = rec.summary?.where_stuck || null;
    this.cursor = 0;
    this.frozen = false;
    this.game = new Game(rec.resolved_config, {
      runId: meta.run_id, variant: meta.variant_id, patchId: meta.patch_id, persona: meta.persona_id,
      seed: meta.seed, provider: meta.provider_mode, replay: true, onFx: (fx) => this.renderer?.fx(fx),
    });

    this.el = document.createElement('div');
    this.el.className = 'rp-panel';
    const label = side === 'A' ? 'A · base config' : `B · ${esc(meta.patch_id || 'patched')} (approved)`;
    this.el.innerHTML = `
      <div class="rp-label"><span>${label}</span><span class="badge">${esc(meta.run_id)}</span></div>
      <canvas width="960" height="540"></canvas>
      <div class="rp-hud"></div>
      <div class="rp-badge" hidden></div>`;
    this.canvas = this.el.querySelector('canvas');
    this.hud = this.el.querySelector('.rp-hud');
    this.badge = this.el.querySelector('.rp-badge');
    this.renderer = new IsoRenderer(this.canvas, sprites, { seed: meta.seed ?? 42 });
  }

  advance(t, dt) {
    if (this.frozen) return;
    while (this.cursor < this.clicks.length && this.clicks[this.cursor].t <= t) {
      const c = this.clicks[this.cursor++];
      this.game.advanceTo(c.t);
      this.game.click(c.target, c.x, c.y);
    }
    this.game.advanceTo(Math.min(t, this.lastT));
    this.renderer.render(this.game, dt);
    this.drawHud();

    if (this.stuckAt !== null && t >= this.stuckAt && !this.achievedAt) {
      this.showBadge('stalled', `STALLED AT ${this.whereStuck || this.game.step_id}`);
    }
    if (this.achievedAt !== null && t >= this.achievedAt) {
      this.showBadge('win', '\u{1F3C6} First achievement unlocked');
    }
    if (t >= this.lastT && this.stuckAt !== null && !this.achievedAt) {
      this.frozen = true;
      this.el.classList.add('frozen');
    }
  }

  showBadge(kind, text) {
    if (!this.badge.hidden) return;
    this.badge.className = `rp-badge ${kind}`;
    this.badge.textContent = text;
    this.badge.hidden = false;
  }

  drawHud() {
    const g = this.game;
    const r = g.roundedResources();
    const html = `<span>${esc(g.step_id)}</span><span>${g.era === 'stone_age' ? 'Stone Age' : 'Dawn Age'}</span>
      <span>\u{1F35E}${r.food}</span><span>\u{1FAB5}${r.wood}</span><span>\u{1FAA8}${r.stone}</span><span>⭐${g.score}</span>`;
    if (this.hud.innerHTML !== html) this.hud.innerHTML = html;
  }

  state() {
    return { step_id: this.game.step_id, era: this.game.era, score: this.game.score, achieved: this.game.achieved,
             stalled: !this.badge.hidden && this.badge.classList.contains('stalled'), frozen: this.frozen,
             badge: this.badge.hidden ? null : this.badge.textContent };
  }
}

async function fetchRecording(runId) {
  const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/recording`);
  if (!r.ok) throw new Error(`Run ${runId}: HTTP ${r.status}`);
  const rec = await r.json();
  if (!rec.resolved_config) throw new Error(`Run ${runId} has no resolved_config.json`);
  return rec;
}

function providerOf(rec) {
  return rec.meta?.provider_mode || rec.events[0]?.provider_mode || 'unknown';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
