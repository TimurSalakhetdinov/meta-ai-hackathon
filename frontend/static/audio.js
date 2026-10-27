// Tiny Web Audio sound effects, synthesised so no audio files ship with the game.
// Muted by default for bots and headless browsers so recorded runs stay silent.

const NOTES = {
  click:   [[660, 0.05, 'triangle']],
  harvest: [[520, 0.07, 'triangle'], [780, 0.09, 'triangle']],
  build:   [[180, 0.08, 'square'], [140, 0.10, 'square']],
  unlock:  [[523, 0.08, 'sine'], [659, 0.08, 'sine'], [784, 0.16, 'sine']],
  reject:  [[220, 0.09, 'sawtooth'], [180, 0.12, 'sawtooth']],
};

export class Sfx {
  constructor({ muted = false } = {}) {
    this.muted = muted;
    this.ctx = null;
  }

  toggle() {
    this.muted = !this.muted;
    return this.muted;
  }

  play(name) {
    if (this.muted || !NOTES[name]) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    // Created lazily inside a user gesture, as browsers require.
    this.ctx = this.ctx || new Ctx();
    let t = this.ctx.currentTime;
    for (const [freq, dur, type] of NOTES[name]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  }
}

export function defaultMuted(params) {
  return !!params.bot || !!navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent);
}
