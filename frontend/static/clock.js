// Deterministic randomness and the simulation clock.
// All gameplay randomness comes from mulberry32(seed); all gameplay time is
// simulated time, advanced by realDelta * speed, so metrics do not depend on
// playback speed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small helpers on top of a PRNG function.
export function rngTools(rand) {
  return {
    rand,
    range: (lo, hi) => lo + (hi - lo) * rand(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * rand()),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    chance: (p) => rand() < p,
  };
}

export const ALLOWED_SPEEDS = [1, 2, 3, 4];

export class SimClock {
  constructor(speed = 1) {
    this.speed = clampSpeed(speed);
    this.t = 0;          // simulated seconds since session start
    this.paused = false;
  }
  advance(realDeltaSec) {
    if (this.paused) return 0;
    // Clamp long frames (tab switch) so the sim never jumps by minutes.
    const dt = Math.min(realDeltaSec, 0.25) * this.speed;
    this.t += dt;
    return dt;
  }
}

export function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.round(n)));
}

export function urlParams() {
  const p = new URLSearchParams(window.location.search);
  const seed = parseInt(p.get('seed') ?? '42', 10);
  return {
    variant: p.get('variant') === 'B' ? 'B' : 'A',
    patchId: p.get('patch_id') || null,
    seed: Number.isFinite(seed) ? seed : 42,
    speed: clampSpeed(p.get('speed') ?? 1),
    persona: p.get('persona') || null,
    runId: p.get('run_id') || null,
    provider: p.get('provider') || null,
    inspectConfig: p.get('inspect_config') === '1',
    compareA: p.get('compare_a'),
    compareB: p.get('compare_b'),
    replayA: p.get('replay_a'),
    replayB: p.get('replay_b'),
    dev: p.get('dev') === '1',
    bot: p.get('bot') === '1',
    video: p.get('video') === '1',
    // The Playwright runner drives the clicks itself and only borrows the page hooks.
    externalBot: p.get('bot') === 'external',
    playMin: Number(p.get('playmin')) || null,
    flow: p.get('flow') || null,
    extjob: p.get('extjob') || null,
    watch: p.get('watch') === '1',
    ab: p.get('ab') === '1',
    voice: p.get('voice') === '1',
    safety: Number(p.get('safety')) || 1,
    stuckSec: Number(p.get('stucksec')) || null,
    noTelemetry: p.get('telemetry') === '0',
    dock: p.get('dock'),
    analysisRun: p.get('analysis_run'),
  };
}
