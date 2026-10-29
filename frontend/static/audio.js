// Super-rich procedural Web Audio sound synthesis & background music engine for "Dawn of Empires".
//
// Features:
// 1. Dual-Engine Background Music System (`setMusicTheme('valley' | 'battle')`):
//    - Primary: Decodes `/static/assets/audio/valley_theme.wav` and `battle_theme.wav` into
//      Web Audio buffers with a crossfaded loop point and plays them gaplessly.
//    - Fallback (only when the wavs fail to load): Fully autonomous Web Audio physical modeling step sequencer
//      (plucked lyre/harp, breathy pan-flute, warm string pad, waterfall ambience for 'valley';
//       driving Taiko war drums, rim clicks, 16th-note staccato strings & brass stabs for 'battle').
//    - Smooth 0.85s crossfading between themes.
//    - Auto-starts on first user click/interaction when unmuted.
// 2. Multi-layered physical modeling SFX:
//    - Filtered noise buffers (waterfalls, foliage rustle, smoke poofs, beast roars)
//    - FM metallic synthesis (coin clinks, shield star thuds, anvil strikes)
//    - Sawtooth brass & trumpet fifths (victory fanfare, hero level-up)
//    - Sub-bass pitch drops & rock fracture crackles (Earthshatter Stomp)
//    - Shimmering major-9th harp glissando & harmonic bells (Solar Salve, Free Instant-Finish)
//    - Deep taiko war-drum doom impacts (Stage 6 Defeat)
// 3. 100% backward compatible with existing Sfx class API:
//    - click, harvest, build, unlock, reject, muted, toggle(), play(name), defaultMuted(params).

const AUDIO_BASE = '/static/assets/audio/';

export class Sfx {
  constructor({ muted = false } = {}) {
    this.muted = muted;
    this.ctx = null;
    this.musicVolume = 0.6;
    this.sfxVolume = 0.9;
    this.masterGain = null;
    this.compressor = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.valleyGain = null;
    this.battleGain = null;
    this.noiseBuffer = null;

    // Music State
    this.musicTheme = 'valley'; // 'valley' | 'battle'
    this.musicRunning = false;
    this.musicTimer = null;
    this.audioFilesAvailable = false;
    this.audioElements = { valley: null, battle: null };
    // Decoded soundtrack loops played gaplessly through Web Audio.
    // Valley has three selectable tracks (music menu); battle is fixed.
    this.valleyTrack = 'valley'; // 'valley' | 'valley2' | 'valley3' | 'valley4'
    this.valleyTrackGains = null;
    this.musicBuffers = { valley: null, valley2: null, valley3: null, valley4: null, battle: null };
    this.musicSources = { valley: null, valley2: null, valley3: null, valley4: null, battle: null };
    this.musicLoad = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'

    // Procedural Sequencer Timers
    this.nextValleyBeatTime = 0;
    this.valleyStep = 0;
    this.nextBattleStepTime = 0;
    this.battleStep = 0;
    this.ambientNodes = null;
  }

  // Lazy initialization inside user gesture to comply with browser autoplay policies.
  _init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    try {
      this.ctx = new AudioContextClass();
    } catch (e) {
      return null;
    }

    // Safety master bus with soft-knee dynamics limiter to prevent clipping
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.setValueAtTime(-6.0, this.ctx.currentTime);
    this.compressor.knee.setValueAtTime(10.0, this.ctx.currentTime);
    this.compressor.ratio.setValueAtTime(8.0, this.ctx.currentTime);
    this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
    this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);
    this.compressor.connect(this.ctx.destination);

    // Master Gain (controls global mute / unmute)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.muted ? 0 : 0.85, this.ctx.currentTime);
    this.masterGain.connect(this.compressor);

    // SFX Sub-bus
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.setValueAtTime(this.sfxVolume, this.ctx.currentTime);
    this.sfxGain.connect(this.masterGain);

    // Music Sub-bus & Theme Crossfader Busses
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.setValueAtTime(0.70 * this.musicVolume, this.ctx.currentTime);
    this.musicGain.connect(this.masterGain);

    this.valleyGain = this.ctx.createGain();
    this.valleyGain.gain.setValueAtTime(this.musicTheme === 'valley' ? 1.0 : 0.0001, this.ctx.currentTime);
    this.valleyGain.connect(this.musicGain);

    this.battleGain = this.ctx.createGain();
    this.battleGain.gain.setValueAtTime(this.musicTheme === 'battle' ? 1.0 : 0.0001, this.ctx.currentTime);
    this.battleGain.connect(this.musicGain);

    // Per-track gains under the valley bus, for track switching crossfades.
    this.valleyTrackGains = {};
    for (const t of ['valley', 'valley2', 'valley3', 'valley4']) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(t === this.valleyTrack ? 1.0 : 0.0001, this.ctx.currentTime);
      g.connect(this.valleyGain);
      this.valleyTrackGains[t] = g;
    }

    // Build 2-second shared white noise buffer for procedural transient layers
    this._buildNoiseBuffer();

    // Decode the soundtrack wavs into gapless, crossfaded loop buffers
    this._loadMusicBuffers();

    // Auto-start background music on first user initialization if not muted
    if (!this.muted && !this.musicRunning) {
      this.startMusic();
    }

    return this.ctx;
  }

  _buildNoiseBuffer() {
    if (!this.ctx || this.noiseBuffer) return;
    const sampleRate = this.ctx.sampleRate || 44100;
    const length = sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  // ElevenLabs SFX files (scripts/generate_sfx.py). When a file is loaded it
  // replaces the synth version of that sound; anything missing falls back.
  _loadSfxFiles() {
    if (this.sfxFilesStarted || typeof fetch !== 'function') return;
    this.sfxFilesStarted = true;
    this.sfxFiles = this.sfxFiles || {};
    const NAMES = ['click', 'modal_open', 'modal_close', 'build', 'built', 'free_finish',
      'ready', 'harvest', 'coin', 'unlock', 'era_up', 'quest', 'quest_claim',
      'hero_levelup', 'hit', 'roar', 'ult_ready', 'hero_ult', 'hero_heal',
      'victory', 'defeat', 'reject',
      'build_shelter', 'build_forager_hut', 'build_woodcutter_hut', 'build_stone_quarry',
      'build_granary', 'build_smelter', 'build_tribal_monument', 'build_barracks', 'build_hero_arena',
      'harvest_food', 'harvest_wood', 'harvest_stone', 'harvest_coins', 'research_select',
      'dock_heroes', 'dock_campaign', 'dock_research', 'dock_upgrades', 'claim_reward', 'ambient_wind', 'upgrade'];
    for (const n of NAMES) {
      fetch(`/static/assets/audio/sfx/${n}.mp3?v=4`)
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((data) => new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail)))
        .then((buf) => { this.sfxFiles[n] = buf; })
        .catch(() => {});
    }
  }

  _playSfxFile(name, bus) {
    const ALIAS = {
      ui: 'click', place: 'build', food: 'harvest', harvest_food: 'harvest',
      coins: 'coin', harvest_coin: 'coin', speedup: 'free_finish', instant_finish: 'free_finish',
      research: 'unlock', levelup: 'hero_levelup', sword_clash: 'hit', slash: 'hit',
      attack: 'hit', beast_roar: 'roar', sabertooth: 'roar', ult_stomp: 'hero_ult',
      stomp: 'hero_ult', earthshatter: 'hero_ult', error: 'reject',
    };
    const file = ALIAS[name] || name;
    const buf = this.sfxFiles && this.sfxFiles[file];
    if (!buf) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(bus);
    src.start();
    return true;
  }

  _loadMusicBuffers() {
    if (this.musicLoad !== 'idle' || typeof fetch !== 'function') return;
    this.musicLoad = 'loading';
    const loadOne = (theme, ext) => fetch(AUDIO_BASE + `${theme}_theme.${ext}?v=4`)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
    // ElevenLabs MP3 first (scripts/generate_music_eleven.py), WAV fallback.
    // A missing track must not kill the others: each load settles on its own.
    const load = (theme) => loadOne(theme, 'mp3').catch(() => loadOne(theme, 'wav'))
      .then((data) => new Promise((ok, fail) => this.ctx.decodeAudioData(data, ok, fail)))
      .then((buf) => { this.musicBuffers[theme] = this._seamlessLoop(buf, 2.0); })
      .catch(() => { this.musicBuffers[theme] = null; });
    Promise.all([load('valley'), load('valley2'), load('valley3'), load('valley4'), load('battle')])
      .then(() => {
        if (!this.musicBuffers.valley && !this.musicBuffers.valley2 && !this.musicBuffers.valley3 && !this.musicBuffers.valley4 && !this.musicBuffers.battle) {
          this.musicLoad = 'failed';
          if (this.musicRunning) this._startValleyWaterfall();
          return;
        }
        this.musicLoad = 'ready';
        if (this.musicRunning) this._startMusicSources();
      });
  }

  // MusicGen clips fade in and out and do not loop cleanly. Fold the last
  // `fadeSec` of the clip over its start with an equal-power crossfade, so the
  // loop point is continuous and there is no dip or click every cycle.
  _seamlessLoop(buf, fadeSec) {
    const fade = Math.min(Math.floor(fadeSec * buf.sampleRate), Math.floor(buf.length / 4));
    const len = buf.length - fade;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = out.getChannelData(c);
      dst.set(src.subarray(0, len));
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        dst[i] = src[i] * Math.sin(k * Math.PI / 2) + src[len + i] * Math.cos(k * Math.PI / 2);
      }
    }
    return out;
  }

  _startMusicSources() {
    if (!this.ctx) return;
    for (const theme of ['valley', 'valley2', 'valley3', 'valley4', 'battle']) {
      if (this.musicSources[theme] || !this.musicBuffers[theme]) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = this.musicBuffers[theme];
      src.loop = true;
      src.connect(theme === 'battle' ? this.battleGain : (this.valleyTrackGains?.[theme] || this.valleyGain));
      src.start();
      this.musicSources[theme] = src;
    }
    this._loadSfxFiles();
    this._scheduleWind();
  }

  _stopMusicSources() {
    for (const theme of ['valley', 'valley2', 'valley3', 'valley4', 'battle']) {
      try { this.musicSources[theme]?.stop(); } catch (e) { /* already stopped */ }
      this.musicSources[theme] = null;
    }
    if (this.windTimer) { clearTimeout(this.windTimer); this.windTimer = null; }
  }

  // Occasional forest wind gusts over the valley (sfx/ambient_wind.mp3),
  // scheduled every 20 to 45 seconds while the valley theme is in front.
  _scheduleWind() {
    if (this.windTimer) clearTimeout(this.windTimer);
    const next = () => {
      this.windTimer = setTimeout(() => {
        const buf = this.sfxFiles && this.sfxFiles.ambient_wind;
        if (buf && this.musicRunning && !this.muted && this.musicTheme === 'valley' && this.ctx) {
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.playbackRate.value = 0.92 + Math.random() * 0.16;
          const g = this.ctx.createGain();
          const t = this.ctx.currentTime;
          const dur = 7 + Math.random() * 5;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.13, t + dur * 0.4);
          g.gain.linearRampToValueAtTime(0, t + dur);
          src.connect(g);
          g.connect(this.valleyGain || this.masterGain);
          src.start(t);
          src.stop(t + dur + 0.1);
        }
        next();
      }, 20000 + Math.random() * 25000);
    };
    next();
  }

  toggle() {
    this.muted = !this.muted;
    // Unmuting is a user gesture: create or resume the AudioContext here, since
    // a context made earlier outside a gesture stays suspended in Chrome/Safari.
    if (!this.muted) this._init();
    if (this.ctx && this.masterGain) {
      const t = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(t);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
      this.masterGain.gain.linearRampToValueAtTime(this.muted ? 0 : 0.85, t + 0.05);
    }

    // Toggle HTML5 Audio file volumes if playing
    if (this.audioElements.valley && this.audioElements.battle) {
      if (this.muted) {
        this.audioElements.valley.volume = 0;
        this.audioElements.battle.volume = 0;
      } else {
        this.audioElements.valley.volume = this.musicTheme === 'valley' ? 0.70 : 0.0;
        this.audioElements.battle.volume = this.musicTheme === 'battle' ? 0.70 : 0.0;
        if (this.musicRunning) {
          const activeEl = this.musicTheme === 'valley' ? this.audioElements.valley : this.audioElements.battle;
          activeEl.play().catch(() => {});
        }
      }
    }

    if (!this.muted && !this.musicRunning) {
      this.startMusic();
    }
    if (!this.muted) this.play('click');
    return this.muted;
  }

  // =================================================================
  // BACKGROUND MUSIC SEQUENCER & CROSSFADER
  // =================================================================

  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0.70 * this.musicVolume, this.ctx.currentTime, 0.03);
    }
    const active = this.musicTheme === 'valley' ? this.audioElements?.valley : this.audioElements?.battle;
    if (active && !this.muted) active.volume = 0.70 * this.musicVolume;
  }

  setSfxVolume(v) {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.ctx && this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.03);
    }
  }

  // Switch the valley track (music menu). Battle theme is unaffected.
  setValleyTrack(track) {
    if (!['valley', 'valley2', 'valley3', 'valley4'].includes(track)) return;
    this.valleyTrack = track;
    if (this.ctx && this.valleyTrackGains) {
      const t = this.ctx.currentTime;
      for (const [name, g] of Object.entries(this.valleyTrackGains)) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(name === track ? 1.0 : 0.0001, t + 0.85);
      }
    }
    if (!this.musicRunning && !this.muted) this.startMusic();
  }

  setMusicTheme(theme) {
    if (theme !== 'valley' && theme !== 'battle') return;
    this.musicTheme = theme;

    const crossfadeTime = 0.85;

    // Crossfade Web Audio busses
    if (this.ctx && this.valleyGain && this.battleGain) {
      const t = this.ctx.currentTime;
      this.valleyGain.gain.cancelScheduledValues(t);
      this.valleyGain.gain.setValueAtTime(this.valleyGain.gain.value, t);

      this.battleGain.gain.cancelScheduledValues(t);
      this.battleGain.gain.setValueAtTime(this.battleGain.gain.value, t);

      if (theme === 'valley') {
        this.valleyGain.gain.linearRampToValueAtTime(1.0, t + crossfadeTime);
        this.battleGain.gain.linearRampToValueAtTime(0.0001, t + crossfadeTime);
      } else {
        this.battleGain.gain.linearRampToValueAtTime(1.0, t + crossfadeTime);
        this.valleyGain.gain.linearRampToValueAtTime(0.0001, t + crossfadeTime);
      }
    }

    // Crossfade HTML5 Audio tracks if active
    const { valley: vEl, battle: bEl } = this.audioElements;
    if (vEl && bEl) {
      if (this.musicRunning && !this.muted) {
        if (theme === 'valley') {
          vEl.play().catch(() => {});
          this._fadeAudioElement(vEl, 0.70, crossfadeTime);
          this._fadeAudioElement(bEl, 0.00, crossfadeTime);
        } else {
          bEl.play().catch(() => {});
          this._fadeAudioElement(bEl, 0.70, crossfadeTime);
          this._fadeAudioElement(vEl, 0.00, crossfadeTime);
        }
      }
    }

    if (!this.musicRunning && !this.muted) {
      this.startMusic();
    }
  }

  _fadeAudioElement(el, targetVol, duration) {
    if (!el) return;
    const steps = 15;
    const stepTime = (duration * 1000) / steps;
    const startVol = el.volume;
    const delta = (targetVol - startVol) / steps;
    let currentStep = 0;

    const timer = setInterval(() => {
      currentStep++;
      const nextVol = Math.max(0, Math.min(1, startVol + delta * currentStep));
      el.volume = nextVol;
      if (currentStep >= steps) {
        clearInterval(timer);
        el.volume = targetVol;
        if (targetVol === 0) el.pause();
      }
    }, stepTime);
  }

  startMusic() {
    if (this.musicRunning) return;
    const ctx = this._init();
    if (!ctx) return;

    this.musicRunning = true;
    this._startMusicSources();

    // Start Audio Element playback if available
    const activeEl = this.musicTheme === 'valley' ? this.audioElements.valley : this.audioElements.battle;
    if (activeEl && !this.muted) {
      activeEl.volume = 0.70;
      activeEl.play().catch(() => {
        // Autoplay restrictions or file loading will fall back to procedural
      });
    }

    // Reset procedural clocks
    const now = ctx.currentTime + 0.05;
    this.nextValleyBeatTime = now;
    this.valleyStep = 0;
    this.nextBattleStepTime = now;
    this.battleStep = 0;

    if (this.musicLoad === 'failed') this._startValleyWaterfall();

    // Lookahead loop scheduler (runs every 60ms)
    const scheduleLoop = () => {
      if (!this.musicRunning) return;
      this._scheduleMusic();
      this.musicTimer = setTimeout(scheduleLoop, 60);
    };
    scheduleLoop();
  }

  stopMusic() {
    this.musicRunning = false;
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    this._stopMusicSources();
    if (this.audioElements.valley) this.audioElements.valley.pause();
    if (this.audioElements.battle) this.audioElements.battle.pause();
    this._stopValleyWaterfall();
  }

  _scheduleMusic() {
    if (!this.ctx) return;
    const scheduleAhead = 0.25;
    const currentTime = this.ctx.currentTime;

    // If audio file is actively playing with volume, procedural notes can remain silent or layer subtly
    // The procedural sequencer is only a fallback when the soundtrack files fail
    // to load; layering it over the recorded loops sounds like stray notes.
    const audioFileActive = this.musicLoad !== 'failed';

    // Schedule Valley Theme if active
    if (this.valleyGain && this.valleyGain.gain.value > 0.001) {
      const beatDur = 0.833;
      while (this.nextValleyBeatTime < currentTime + scheduleAhead) {
        if (!audioFileActive) {
          this._scheduleValleyBeat(this.nextValleyBeatTime, this.valleyStep);
        }
        this.nextValleyBeatTime += beatDur;
        this.valleyStep = (this.valleyStep + 1) % 32;
      }
    } else {
      if (this.nextValleyBeatTime < currentTime) {
        this.nextValleyBeatTime = currentTime + 0.1;
      }
    }

    // Schedule Battle Theme if active
    if (this.battleGain && this.battleGain.gain.value > 0.001) {
      const stepDur = 0.121;
      while (this.nextBattleStepTime < currentTime + scheduleAhead) {
        if (!audioFileActive) {
          this._scheduleBattleStep(this.nextBattleStepTime, this.battleStep);
        }
        this.nextBattleStepTime += stepDur;
        this.battleStep = (this.battleStep + 1) % 64;
      }
    } else {
      if (this.nextBattleStepTime < currentTime) {
        this.nextBattleStepTime = currentTime + 0.1;
      }
    }
  }

  // -------------------------------------------------------------
  // THEME 1: 'valley' SOUNDTRACK SEQUENCER (Pastoral Mediterranean)
  // -------------------------------------------------------------
  _scheduleValleyBeat(t, step) {
    const bar = Math.floor(step / 4);
    const beatInBar = step % 4;
    const bus = this.valleyGain;
    if (!bus) return;

    if (beatInBar === 0) {
      const padChords = [
        [73.42, 146.83, 220.00], // Bar 0: Dm
        [87.31, 174.61, 261.63], // Bar 1: Fmaj
        [98.00, 196.00, 293.66], // Bar 2: Gsus
        [110.0, 220.00, 329.63], // Bar 3: Am
        [73.42, 146.83, 220.00], // Bar 4: Dm
        [87.31, 174.61, 261.63], // Bar 5: Fmaj
        [65.41, 130.81, 196.00], // Bar 6: Cmaj
        [73.42, 146.83, 220.00], // Bar 7: Dm
      ];
      this._playValleyPad(t, bus, padChords[bar], 3.2);
    }

    const harpNotes = {
      0: 293.66, 1: 440.00, 2: 349.23, 3: 587.33,
      4: 261.63, 5: 392.00, 6: 440.00, 7: 523.25,
      8: 493.88, 9: 392.00, 10: 293.66, 11: 329.63,
      12: 349.23, 13: 329.63, 14: 261.63, 15: 293.66,
      16: 587.33, 17: 659.25, 18: 698.46, 19: 587.33,
      20: 523.25, 21: 440.00, 22: 392.00, 23: 523.25,
      24: 440.00, 25: 392.00, 26: 349.23, 27: 329.63,
      28: 293.66, 30: 440.00,
    };

    if (harpNotes[step]) {
      this._playLyrePluck(t, bus, harpNotes[step]);
    }

    const flutePhrases = {
      8:  { f: 440.00, dur: 1.6 },
      10: { f: 523.25, dur: 1.5 },
      12: { f: 587.33, dur: 2.2 },
      24: { f: 659.25, dur: 1.4 },
      26: { f: 587.33, dur: 1.4 },
      28: { f: 440.00, dur: 2.8 },
    };

    if (flutePhrases[step]) {
      this._playPanFlute(t, bus, flutePhrases[step].f, flutePhrases[step].dur);
    }
  }

  _playValleyPad(t, bus, frequencies, dur = 3.2) {
    frequencies.forEach((freq) => {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(320, t);
      filter.Q.setValueAtTime(1.0, t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.045, t + 0.8);
      gain.gain.setValueAtTime(0.045, t + dur - 0.7);
      gain.gain.linearRampToValueAtTime(0.0001, t + dur);

      osc.connect(filter).connect(gain).connect(bus);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
  }

  _playLyrePluck(t, bus, freq) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, t);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(freq * 2, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.065, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(bus);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 1.3);
    osc2.stop(t + 1.3);
  }

  _playPanFlute(t, bus, freq, dur = 1.5) {
    const osc = this.ctx.createOscillator();
    const vibrato = this.ctx.createOscillator();
    const vGain = this.ctx.createGain();
    const gain = this.ctx.createGain();

    vibrato.frequency.setValueAtTime(5.2, t);
    vGain.gain.setValueAtTime(freq * 0.015, t);
    vibrato.connect(osc.frequency);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.055, t + 0.25);
    gain.gain.setValueAtTime(0.055, t + dur - 0.3);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain).connect(bus);

    vibrato.start(t);
    osc.start(t);
    vibrato.stop(t + dur + 0.05);
    osc.stop(t + dur + 0.05);
  }

  _startValleyWaterfall() {
    if (this.ambientNodes || !this.noiseBuffer || !this.ctx) return;
    const t = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    const lowFlow = this.ctx.createBiquadFilter();
    lowFlow.type = 'bandpass';
    lowFlow.frequency.setValueAtTime(420, t);
    lowFlow.Q.setValueAtTime(1.2, t);

    const highSpray = this.ctx.createBiquadFilter();
    highSpray.type = 'bandpass';
    highSpray.frequency.setValueAtTime(1800, t);
    highSpray.Q.setValueAtTime(0.8, t);

    const ambGain = this.ctx.createGain();
    ambGain.gain.setValueAtTime(0.0001, t);
    ambGain.gain.linearRampToValueAtTime(0.035, t + 1.5);

    noise.connect(lowFlow).connect(ambGain);
    noise.connect(highSpray).connect(ambGain);
    ambGain.connect(this.valleyGain);

    noise.start(t);
    this.ambientNodes = { noise, ambGain };
  }

  _stopValleyWaterfall() {
    if (this.ambientNodes && this.ctx) {
      const { noise, ambGain } = this.ambientNodes;
      const t = this.ctx.currentTime;
      ambGain.gain.cancelScheduledValues(t);
      ambGain.gain.setValueAtTime(ambGain.gain.value, t);
      ambGain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
      setTimeout(() => {
        try { noise.stop(); noise.disconnect(); } catch (e) {}
      }, 650);
      this.ambientNodes = null;
    }
  }

  // -------------------------------------------------------------
  // THEME 2: 'battle' SOUNDTRACK SEQUENCER (Tactical Combat Arena)
  // -------------------------------------------------------------
  _scheduleBattleStep(t, step) {
    const bus = this.battleGain;
    if (!bus) return;

    const stepInBar = step % 16;
    const bar = Math.floor(step / 16);

    if (stepInBar === 0 || stepInBar === 6 || stepInBar === 8 || stepInBar === 14) {
      this._playBattleDrum(t, bus, stepInBar === 0 ? 0.32 : 0.22);
    }

    if (stepInBar === 4 || stepInBar === 12) {
      this._playBattleRimClick(t, bus);
    }

    if (stepInBar === 2 || stepInBar === 6 || stepInBar === 10 || stepInBar === 14) {
      this._playBattleShaker(t, bus);
    }

    const ostinatoPitches = [
      146.83, 146.83, 174.61, 146.83, 196.00, 146.83, 174.61, 146.83,
      220.00, 146.83, 174.61, 146.83, 164.81, 146.83, 174.61, 164.81,
      146.83, 146.83, 174.61, 146.83, 233.08, 146.83, 220.00, 146.83,
      196.00, 146.83, 174.61, 146.83, 164.81, 174.61, 164.81, 138.59,
    ];

    const pitch = ostinatoPitches[(stepInBar + (bar % 2) * 16)];
    if (pitch) {
      this._playBattleOstinato(t, bus, pitch);
    }

    if (stepInBar === 0 && (bar === 0 || bar === 2)) {
      this._playBattleBrass(t, bus, [146.83, 220.00, 293.66]);
    } else if (stepInBar === 0 && bar === 1) {
      this._playBattleBrass(t, bus, [116.54, 174.61, 233.08]);
    } else if (stepInBar === 0 && bar === 3) {
      this._playBattleBrass(t, bus, [110.00, 164.81, 220.00]);
    }
  }

  _playBattleDrum(t, bus, vol = 0.28) {
    const drum = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    drum.type = 'sine';
    drum.frequency.setValueAtTime(105, t);
    drum.frequency.exponentialRampToValueAtTime(36, t + 0.16);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    drum.connect(gain).connect(bus);
    drum.start(t);
    drum.stop(t + 0.20);
  }

  _playBattleRimClick(t, bus) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(840, t);
    osc.frequency.exponentialRampToValueAtTime(350, t + 0.035);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.045);
  }

  _playBattleShaker(t, bus) {
    if (!this.noiseBuffer) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(3200, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.04, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

    noise.connect(filter).connect(gain).connect(bus);
    noise.start(t);
    noise.stop(t + 0.06);
  }

  _playBattleOstinato(t, bus, freq) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(750, t);
    filter.frequency.exponentialRampToValueAtTime(350, t + 0.09);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.075, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    osc.connect(filter).connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.10);
  }

  _playBattleBrass(t, bus, chord) {
    chord.forEach((freq) => {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, t);
      filter.frequency.linearRampToValueAtTime(2200, t + 0.06);
      filter.frequency.exponentialRampToValueAtTime(1000, t + 0.45);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.50);

      osc.connect(filter).connect(gain).connect(bus);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  }

  // =================================================================
  // SFX PLAY METHOD (Tactile UI, Harvest, Combat, Fanfares)
  // =================================================================

  play(name, options = {}) {
    if (this.muted) return;
    const ctx = this._init();
    if (!ctx) return;

    const t = ctx.currentTime;
    const bus = this.sfxGain || this.masterGain;

    this._loadSfxFiles();
    if (this._playSfxFile(name, bus)) return;

    switch (name) {
      // -------------------------------------------------------------
      // 1. TACTILE UI & CITY SOUNDS (Existing + Enhanced)
      // -------------------------------------------------------------
      case 'click':
      case 'ui':
        this._playClick(t, bus);
        break;

      case 'reject':
      case 'error':
        this._playReject(t, bus);
        break;

      case 'build':
      case 'place':
        this._playBuild(t, bus);
        break;

      case 'harvest':
        this._playHarvest(t, bus);
        break;

      case 'food':
      case 'harvest_food':
        this._playFoodHarvest(t, bus);
        break;

      case 'coin':
      case 'coins':
      case 'harvest_coin':
        this._playCoinClink(t, bus, options.count || 1);
        break;

      case 'free_finish':
      case 'speedup':
      case 'instant_finish':
        this._playFreeFinish(t, bus);
        break;

      case 'unlock':
      case 'research':
        this._playUnlock(t, bus);
        break;

      // -------------------------------------------------------------
      // 2. HEROES & PROGRESSION FANFARES
      // -------------------------------------------------------------
      case 'hero_levelup':
      case 'levelup':
        this._playHeroLevelUp(t, bus);
        break;

      // -------------------------------------------------------------
      // 3. 2.5D BATTLE ARENA SOUNDS
      // -------------------------------------------------------------
      case 'sword_clash':
      case 'slash':
      case 'attack':
      case 'hit':
        this._playSwordClash(t, bus);
        break;

      case 'roar':
      case 'beast_roar':
      case 'sabertooth':
        this._playSabertoothRoar(t, bus);
        break;

      case 'ult_stomp':
      case 'stomp':
      case 'earthshatter':
        this._playUltStomp(t, bus);
        break;

      case 'ult_heal':
      case 'heal':
      case 'solar_salve':
        this._playUltHeal(t, bus);
        break;

      case 'star_thud':
      case 'star':
        this._playStarThud(t, bus, options.star || 1);
        break;

      case 'victory':
      case 'win':
        this._playVictoryFanfare(t, bus);
        break;

      case 'defeat':
      case 'loss':
        this._playDefeatDoomHit(t, bus);
        break;

      // -------------------------------------------------------------
      // 4. MUSIC SHORTCUTS
      // -------------------------------------------------------------
      case 'music_valley':
        this.setMusicTheme('valley');
        break;

      case 'music_battle':
        this.setMusicTheme('battle');
        break;

      default:
        // Graceful fallback for any unknown sound key
        this._playClick(t, bus);
        break;
    }
  }

  // =================================================================
  // SYNTHESIS ENGINES (Web Audio Physical Modeling)
  // =================================================================

  _playClick(t, bus) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(740, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.025);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.12, t + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);

    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.03);
  }

  _playReject(t, bus) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, t);

    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(196, t);
    osc1.frequency.linearRampToValueAtTime(146.8, t + 0.12);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(98, t);
    osc2.frequency.linearRampToValueAtTime(73.4, t + 0.12);

    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.14, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(bus);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.15);
    osc2.stop(t + 0.15);
  }

  _playBuild(t, bus) {
    const mallet = this.ctx.createOscillator();
    const mGain = this.ctx.createGain();
    mallet.type = 'triangle';
    mallet.frequency.setValueAtTime(220, t);
    mallet.frequency.exponentialRampToValueAtTime(65, t + 0.09);

    mGain.gain.setValueAtTime(0.001, t);
    mGain.gain.linearRampToValueAtTime(0.22, t + 0.004);
    mGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    mallet.connect(mGain).connect(bus);
    mallet.start(t);
    mallet.stop(t + 0.1);

    const wood = this.ctx.createOscillator();
    const wGain = this.ctx.createGain();
    wood.type = 'square';
    wood.frequency.setValueAtTime(155, t);
    wood.frequency.exponentialRampToValueAtTime(120, t + 0.11);

    wGain.gain.setValueAtTime(0.001, t);
    wGain.gain.linearRampToValueAtTime(0.08, t + 0.01);
    wGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

    wood.connect(wGain).connect(bus);
    wood.start(t);
    wood.stop(t + 0.12);

    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(700, t);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.001, t);
      nGain.gain.linearRampToValueAtTime(0.07, t + 0.01);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);

      noise.connect(nFilter).connect(nGain).connect(bus);
      noise.start(t);
      noise.stop(t + 0.09);
    }
  }

  _playHarvest(t, bus) {
    this._playRustle(t, bus, 0.10);

    const notes = [
      { f: 659.25, time: t + 0.01, dur: 0.14 },
      { f: 987.77, time: t + 0.07, dur: 0.18 },
    ];

    for (const n of notes) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, n.time);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(0.12, n.time + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, n.time + n.dur);

      osc.connect(gain).connect(bus);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.02);
    }
  }

  _playFoodHarvest(t, bus) {
    this._playRustle(t, bus, 0.15);

    const notes = [
      { f: 392.00, time: t + 0.02, dur: 0.16 },
      { f: 523.25, time: t + 0.08, dur: 0.22 },
    ];
    for (const n of notes) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.f, n.time);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(0.14, n.time + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, n.time + n.dur);

      osc.connect(gain).connect(bus);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.02);
    }
  }

  _playRustle(t, bus, dur = 0.12) {
    if (!this.noiseBuffer) return;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400, t);
    filter.Q.setValueAtTime(2.2, t);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    noise.connect(filter).connect(gain).connect(bus);
    noise.start(t);
    noise.stop(t + dur + 0.01);
  }

  _playCoinClink(t, bus, count = 1) {
    const bounces = [
      { time: t, freq: 2640, vol: 0.14 },
      { time: t + 0.065, freq: 3120, vol: 0.11 },
    ];

    if (count > 1) {
      bounces.push({ time: t + 0.13, freq: 3520, vol: 0.09 });
    }

    for (const b of bounces) {
      const mod = this.ctx.createOscillator();
      const modGain = this.ctx.createGain();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(b.freq * 1.414, b.time);
      modGain.gain.setValueAtTime(b.freq * 0.8, b.time);
      modGain.gain.exponentialRampToValueAtTime(0.01, b.time + 0.18);

      const carrier = this.ctx.createOscillator();
      const cGain = this.ctx.createGain();
      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(b.freq, b.time);

      mod.connect(carrier.frequency);

      cGain.gain.setValueAtTime(0.001, b.time);
      cGain.gain.linearRampToValueAtTime(b.vol, b.time + 0.002);
      cGain.gain.exponentialRampToValueAtTime(0.0001, b.time + 0.22);

      carrier.connect(cGain).connect(bus);

      mod.start(b.time);
      carrier.start(b.time);
      mod.stop(b.time + 0.24);
      carrier.stop(b.time + 0.24);
    }
  }

  _playFreeFinish(t, bus) {
    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(320, t);
      filter.frequency.exponentialRampToValueAtTime(3400, t + 0.22);
      filter.Q.setValueAtTime(2.5, t);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.16);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);

      noise.connect(filter).connect(gain).connect(bus);
      noise.start(t);
      noise.stop(t + 0.26);
    }

    const apex = t + 0.18;
    const sparkleNotes = [1108.73, 1244.51, 1479.98, 1661.22, 2217.46];
    sparkleNotes.forEach((f, idx) => {
      const noteTime = apex + idx * 0.022;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, noteTime);

      gain.gain.setValueAtTime(0.001, noteTime);
      gain.gain.linearRampToValueAtTime(0.08, noteTime + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 0.35);

      osc.connect(gain).connect(bus);
      osc.start(noteTime);
      osc.stop(noteTime + 0.38);
    });
  }

  _playUnlock(t, bus) {
    const notes = [
      { f: 523.25, time: t, dur: 0.12 },
      { f: 659.25, time: t + 0.08, dur: 0.12 },
      { f: 783.99, time: t + 0.16, dur: 0.14 },
      { f: 1046.50, time: t + 0.24, dur: 0.40 },
    ];

    for (const n of notes) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, n.time);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(0.14, n.time + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, n.time + n.dur);

      osc.connect(gain).connect(bus);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.03);
    }
  }

  _playHeroLevelUp(t, bus) {
    const chord = [293.66, 440.00, 587.33, 739.99];

    chord.forEach((freq) => {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(500, t);
      filter.frequency.linearRampToValueAtTime(2600, t + 0.05);
      filter.frequency.exponentialRampToValueAtTime(1200, t + 0.55);

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);

      osc.connect(filter).connect(gain).connect(bus);
      osc.start(t);
      osc.stop(t + 0.70);
    });

    const bellNotes = [1174.66, 1479.98, 1760.00, 2349.32];
    bellNotes.forEach((bf, idx) => {
      const bTime = t + 0.05 + idx * 0.04;
      const bOsc = this.ctx.createOscillator();
      const bGain = this.ctx.createGain();

      bOsc.type = 'sine';
      bOsc.frequency.setValueAtTime(bf, bTime);

      bGain.gain.setValueAtTime(0.001, bTime);
      bGain.gain.linearRampToValueAtTime(0.09, bTime + 0.005);
      bGain.gain.exponentialRampToValueAtTime(0.0001, bTime + 0.38);

      bOsc.connect(bGain).connect(bus);
      bOsc.start(bTime);
      bOsc.stop(bTime + 0.40);
    });
  }

  _playSwordClash(t, bus) {
    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const hpFilter = this.ctx.createBiquadFilter();
      hpFilter.type = 'highpass';
      hpFilter.frequency.setValueAtTime(2200, t);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.001, t);
      nGain.gain.linearRampToValueAtTime(0.15, t + 0.003);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

      noise.connect(hpFilter).connect(nGain).connect(bus);
      noise.start(t);
      noise.stop(t + 0.08);
    }

    const steelRings = [2150, 3380];
    steelRings.forEach((freq) => {
      const ringOsc = this.ctx.createOscillator();
      const ringGain = this.ctx.createGain();

      ringOsc.type = 'sine';
      ringOsc.frequency.setValueAtTime(freq, t);

      ringGain.gain.setValueAtTime(0.001, t);
      ringGain.gain.linearRampToValueAtTime(0.10, t + 0.002);
      ringGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

      ringOsc.connect(ringGain).connect(bus);
      ringOsc.start(t);
      ringOsc.stop(t + 0.30);
    });

    const punch = this.ctx.createOscillator();
    const pGain = this.ctx.createGain();
    punch.type = 'triangle';
    punch.frequency.setValueAtTime(140, t);
    punch.frequency.exponentialRampToValueAtTime(45, t + 0.07);

    pGain.gain.setValueAtTime(0.001, t);
    pGain.gain.linearRampToValueAtTime(0.18, t + 0.004);
    pGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);

    punch.connect(pGain).connect(bus);
    punch.start(t);
    punch.stop(t + 0.08);
  }

  _playSabertoothRoar(t, bus) {
    const dur = 0.55;

    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.type = 'sawtooth';
    lfo.frequency.setValueAtTime(32, t);
    lfoGain.gain.setValueAtTime(38, t);

    const roarOsc = this.ctx.createOscillator();
    roarOsc.type = 'sawtooth';
    roarOsc.frequency.setValueAtTime(140, t);
    roarOsc.frequency.linearRampToValueAtTime(65, t + dur);
    lfo.connect(roarOsc.frequency);

    const formant = this.ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(480, t);
    formant.frequency.linearRampToValueAtTime(350, t + dur);
    formant.Q.setValueAtTime(3.5, t);

    const roarGain = this.ctx.createGain();
    roarGain.gain.setValueAtTime(0.001, t);
    roarGain.gain.linearRampToValueAtTime(0.22, t + 0.06);
    roarGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    roarOsc.connect(formant).connect(roarGain).connect(bus);

    lfo.start(t);
    roarOsc.start(t);
    lfo.stop(t + dur + 0.05);
    roarOsc.stop(t + dur + 0.05);

    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(320, t);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.001, t);
      nGain.gain.linearRampToValueAtTime(0.12, t + 0.08);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      noise.connect(nFilter).connect(nGain).connect(bus);
      noise.start(t);
      noise.stop(t + dur + 0.02);
    }
  }

  _playUltStomp(t, bus) {
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(115, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.55);

    subGain.gain.setValueAtTime(0.001, t);
    subGain.gain.linearRampToValueAtTime(0.35, t + 0.008);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.58);

    sub.connect(subGain).connect(bus);
    sub.start(t);
    sub.stop(t + 0.60);

    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(160, t);
      nFilter.frequency.exponentialRampToValueAtTime(45, t + 0.45);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.001, t);
      nGain.gain.linearRampToValueAtTime(0.24, t + 0.02);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.50);

      noise.connect(nFilter).connect(nGain).connect(bus);
      noise.start(t);
      noise.stop(t + 0.52);

      const crackleDelays = [0.04, 0.09, 0.16];
      crackleDelays.forEach((cd) => {
        const cNoise = this.ctx.createBufferSource();
        cNoise.buffer = this.noiseBuffer;

        const cFilter = this.ctx.createBiquadFilter();
        cFilter.type = 'bandpass';
        cFilter.frequency.setValueAtTime(1400 + Math.random() * 800, t + cd);
        cFilter.Q.setValueAtTime(4.0, t + cd);

        const cGain = this.ctx.createGain();
        cGain.gain.setValueAtTime(0.001, t + cd);
        cGain.gain.linearRampToValueAtTime(0.12, t + cd + 0.003);
        cGain.gain.exponentialRampToValueAtTime(0.0001, t + cd + 0.05);

        cNoise.connect(cFilter).connect(cGain).connect(bus);
        cNoise.start(t + cd);
        cNoise.stop(t + cd + 0.06);
      });
    }
  }

  _playUltHeal(t, bus) {
    const harpFrequencies = [329.63, 415.30, 493.88, 622.25, 739.99, 830.61, 987.77];

    harpFrequencies.forEach((freq, idx) => {
      const noteTime = t + idx * 0.048;

      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freq, noteTime);

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freq * 2, noteTime);

      gain.gain.setValueAtTime(0.001, noteTime);
      gain.gain.linearRampToValueAtTime(0.11, noteTime + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteTime + 0.45);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(bus);

      osc1.start(noteTime);
      osc2.start(noteTime);
      osc1.stop(noteTime + 0.48);
      osc2.stop(noteTime + 0.48);
    });

    const crestTime = t + 0.34;
    const chime = this.ctx.createOscillator();
    const cGain = this.ctx.createGain();
    chime.type = 'sine';
    chime.frequency.setValueAtTime(1661.22, crestTime);

    cGain.gain.setValueAtTime(0.001, crestTime);
    cGain.gain.linearRampToValueAtTime(0.12, crestTime + 0.01);
    cGain.gain.exponentialRampToValueAtTime(0.0001, crestTime + 0.85);

    chime.connect(cGain).connect(bus);
    chime.start(crestTime);
    chime.stop(crestTime + 0.90);
  }

  _playStarThud(t, bus, star = 1) {
    const pitchScale = 1 + (Math.max(1, Math.min(3, star)) - 1) * 0.12;

    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const carrier = this.ctx.createOscillator();
    const cGain = this.ctx.createGain();

    const baseFreq = 540 * pitchScale;
    mod.type = 'sine';
    mod.frequency.setValueAtTime(890 * pitchScale, t);
    modGain.gain.setValueAtTime(450, t);
    modGain.gain.exponentialRampToValueAtTime(0.01, t + 0.16);

    carrier.type = 'triangle';
    carrier.frequency.setValueAtTime(baseFreq, t);
    carrier.frequency.exponentialRampToValueAtTime(baseFreq * 0.7, t + 0.22);

    mod.connect(carrier.frequency);

    cGain.gain.setValueAtTime(0.001, t);
    cGain.gain.linearRampToValueAtTime(0.22, t + 0.004);
    cGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

    carrier.connect(cGain).connect(bus);

    mod.start(t);
    carrier.start(t);
    mod.stop(t + 0.28);
    carrier.stop(t + 0.28);

    const punch = this.ctx.createOscillator();
    const pGain = this.ctx.createGain();
    punch.type = 'sine';
    punch.frequency.setValueAtTime(110 * pitchScale, t);
    punch.frequency.exponentialRampToValueAtTime(38, t + 0.14);

    pGain.gain.setValueAtTime(0.001, t);
    pGain.gain.linearRampToValueAtTime(0.24, t + 0.005);
    pGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    punch.connect(pGain).connect(bus);
    punch.start(t);
    punch.stop(t + 0.18);
  }

  _playVictoryFanfare(t, bus) {
    this._playStarThud(t, bus, 1);
    this._playStarThud(t + 0.22, bus, 2);
    this._playStarThud(t + 0.44, bus, 3);

    const fanfareNotes = [
      { f: 293.66, time: t + 0.68, dur: 0.14 },
      { f: 392.00, time: t + 0.82, dur: 0.14 },
      { f: 440.00, time: t + 0.96, dur: 0.16 },
      { f: 587.33, time: t + 1.12, dur: 0.75 },
    ];

    for (const n of fanfareNotes) {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.f, n.time);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(600, n.time);
      filter.frequency.linearRampToValueAtTime(2800, n.time + 0.04);
      filter.frequency.exponentialRampToValueAtTime(1400, n.time + n.dur);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(0.15, n.time + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, n.time + n.dur);

      osc.connect(filter).connect(gain).connect(bus);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.04);

      if (n.dur > 0.5) {
        const hOsc = this.ctx.createOscillator();
        const hGain = this.ctx.createGain();
        hOsc.type = 'triangle';
        hOsc.frequency.setValueAtTime(n.f * 1.5, n.time);

        hGain.gain.setValueAtTime(0.001, n.time);
        hGain.gain.linearRampToValueAtTime(0.09, n.time + 0.04);
        hGain.gain.exponentialRampToValueAtTime(0.0001, n.time + n.dur);

        hOsc.connect(hGain).connect(bus);
        hOsc.start(n.time);
        hOsc.stop(n.time + n.dur + 0.04);
      }
    }
  }

  _playDefeatDoomHit(t, bus) {
    const drum = this.ctx.createOscillator();
    const dGain = this.ctx.createGain();
    drum.type = 'sine';
    drum.frequency.setValueAtTime(95, t);
    drum.frequency.exponentialRampToValueAtTime(26, t + 0.75);

    dGain.gain.setValueAtTime(0.001, t);
    dGain.gain.linearRampToValueAtTime(0.38, t + 0.007);
    dGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.80);

    drum.connect(dGain).connect(bus);
    drum.start(t);
    drum.stop(t + 0.85);

    if (this.noiseBuffer) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'lowpass';
      nFilter.frequency.setValueAtTime(140, t);

      const nGain = this.ctx.createGain();
      nGain.gain.setValueAtTime(0.001, t);
      nGain.gain.linearRampToValueAtTime(0.20, t + 0.015);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

      noise.connect(nFilter).connect(nGain).connect(bus);
      noise.start(t);
      noise.stop(t + 0.48);
    }

    const doomChords = [
      { f: 116.54, time: t + 0.05, dur: 0.45 },
      { f: 110.00, time: t + 0.45, dur: 0.50 },
      { f: 73.42,  time: t + 0.90, dur: 0.80 },
    ];

    for (const d of doomChords) {
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(d.f, d.time);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(360, d.time);

      gain.gain.setValueAtTime(0.001, d.time);
      gain.gain.linearRampToValueAtTime(0.12, d.time + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, d.time + d.dur);

      osc.connect(filter).connect(gain).connect(bus);
      osc.start(d.time);
      osc.stop(d.time + d.dur + 0.05);
    }
  }
}

export function defaultMuted(params) {
  return !!params.bot || !!navigator.webdriver || /HeadlessChrome/.test(navigator.userAgent);
}
