// In-browser stub playtester behind [Watch Bot Play].
//
// Variant-blind by construction: each step reads only
// window.__GAME_DEBUG__.getRenderedTargets() (what is on screen, with its
// visible/locked/affordable/salience flags) plus the bot's own memory of what
// it already tried. It never reads the config, the variant or the patch.
// Clicks are real MouseEvents at target centres, so they take the same path
// as a human click. The live Muse Spark playtester replaces this policy in
// --mode meta; this one exists so the loop can be demoed and tested offline.

import { mulberry32 } from './clock.js';

const STEP_MS = 420;
const IDLE_WAIT_MS = 1600;
const MAX_SIM_SEC = 420;

const DEFAULT_POLICY = {
  follow_tutorial: 0.5,
  salience_weight: 0.5,
  prefer_build: 0.5,
  harvest: 0.8,
  wait_when_unsure: 0.3,
  curiosity: 0.2,
  instant_finish: false,
  rush_campaign: false,
  level_heroes: false,
  target_hero_level: 1,
  culture_adjacency: false,
  explore_modals: false,
  hoard_food_threshold: 0,
};

const SALIENCE = { low: 0.05, medium: 0.45, high: 0.9, high_pulse: 1.2 };
const PRODUCERS = { card_woodcutter_hut: 'woodcutter_hut', card_stone_quarry: 'stone_quarry', card_smelter: 'smelter' };
const PRODUCES = { forager_hut: 'food', woodcutter_hut: 'wood', stone_quarry: 'stone', smelter: 'stone' };
const TECH_PRIORITY = [
  'tech_toolmaking', 'tech_stone_age', 'tech_masonry', 'tech_bronze_age', 'tech_baskets',
  'tech_woodworking', 'tech_irrigation',
];

// Persona-specific think-aloud lines
const INSTANT_FINISH_LINES = {
  impatient_newcomer: () => '⚡ Tap FREE instant-finish! Why wait for timers when it is instant?!',
  optimizer: () => 'Zero-cost instant-completion accelerates production cycles by 100%.',
  curious_explorer: () => 'Instant-finish button? Clicked! Let us see what unlocks immediately.',
  first_time_casual: () => 'Free speed up! That helps get things done faster.',
  cautious_hoarder: () => 'Free instant finish costs zero resources. A risk-free gain.',
};

const DEFEAT_LINES = {
  impatient_newcomer: () => 'Ugh, wiped out by Wave 3 Sabertooths! We need way more brute force!',
  optimizer: () => 'Defeat in Stage 6: squad power fell below 460 requirement. Must level heroes.',
  first_time_casual: () => 'Oh no, our heroes were defeated! The advisor says we should train them.',
  curious_explorer: () => 'Fascinating combat wipe! Those Sabertooths hit hard without hero ranks.',
  cautious_hoarder: () => 'Too dangerous out there! Pull back and build up safety reserves.',
};

const HERO_LEVELUP_LINES = {
  impatient_newcomer: () => 'Leveled up! Bigger stats, harder hits, let us smash things!',
  optimizer: () => 'Hero promoted: Squad power increased past the combat stat check threshold.',
  first_time_casual: () => 'Commander Vaelen grew stronger! The village is safer now.',
  curious_explorer: () => 'New ability unlocked in the Heroes Hall! Look at those glowing constellations.',
  cautious_hoarder: () => 'Spent surplus Food on hero training while keeping our stockpile intact.',
};

const CULTURE_AURA_LINES = {
  impatient_newcomer: () => 'Bright green glowing circle! Shiny boost for the neighborhood!',
  optimizer: () => 'Sacred Obelisk placed for maximum adjacency: +20% harvest yield across surrounding farms.',
  curious_explorer: () => 'A lime-green culture aura! All nearby homes and farms are celebrating with +20%!',
  first_time_casual: () => 'The sacred monument brings joy and prosperity to our settlers.',
  cautious_hoarder: () => 'Adjacency bonus permanently increases return on investment for nearby plots.',
};

const EXPANSION_LINES = {
  impatient_newcomer: () => 'More land, more space, blow away the trees and build!',
  optimizer: () => 'Territory expanded: Unlocked 2 new construction pads for economic scaling.',
  curious_explorer: () => 'Clearing the timber mist! What new territory lies in the western sector?',
  first_time_casual: () => 'Our borders are expanding into the beautiful valley!',
  cautious_hoarder: () => 'Unlocked territory safely with excess tokens, widening our resource base.',
};

export class StubBot {
  constructor({ runId, persona, seed, clickAt, ringAt, onThought, onDone }) {
    this.runId = runId;
    this.persona = persona;
    this.policy = { ...DEFAULT_POLICY, ...(persona?.stub_policy || {}) };
    this.rng = mulberry32(((seed ?? 42) * 2654435761 + hash(persona?.persona_id || 'bot')) >>> 0);
    this.clickAt = clickAt;
    this.ringAt = ringAt;
    this.onThought = onThought;
    this.onDone = onDone;
    this.stepIndex = 0;
    this.running = false;
    this.done = false;
    this.timer = null;
    this.idleSince = null;
    this.researchCooldown = 0;
    this.researchedThisVisit = false;
    this.savingFor = null;
    this.lastRejectedTarget = null;
    // Targets that were shown unaffordable or locked when clicked, with steps left to avoid them.
    this.avoid = new Map();
    this.seenAchievement = 0;
    this.featureUses = 0;
  }

  start() {
    if (this.done) return;
    this.running = true;
    this.schedule(300);
  }

  pause() {
    this.running = false;
    clearTimeout(this.timer);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.step(), ms);
  }

  async step() {
    if (!this.running || this.done) return;
    const state = window.__GAME_STATE__ || {};
    if (!state.ready) return this.schedule(STEP_MS);
    // Wait for a stable frame, like the Playwright runner does before capturing.
    if (!state.idle) {
      const now = performance.now();
      this.idleSince = this.idleSince ?? now;
      if (now - this.idleSince < IDLE_WAIT_MS) return this.schedule(120);
    }
    this.idleSince = null;

    if (state.achieved && ++this.seenAchievement > 2) return this.finish('first_achievement');
    if (state.sim_elapsed_sec > MAX_SIM_SEC) return this.finish('bot_time_limit');

    const { decision, targets } = this.plan();
    const index = this.stepIndex++;
    const correlation_id = `${this.runId}_b${String(index).padStart(3, '0')}`;
    const record = {
      run_id: this.runId, bot_step_index: index, correlation_id,
      sim_elapsed_sec: state.sim_elapsed_sec || 0, provider_mode: 'stub', vision_mode: 'stub_targets',
      persona_id: this.persona?.persona_id || null,
      observation_summary: summarize(targets), thought: decision.thought,
      target_id: decision.target?.target_id || null,
      target_xy: decision.target ? center(decision.target) : null,
      player_mood: decision.mood || moodOf(decision, this),
    };
    this.onThought({ index, thought: decision.thought, target_id: record.target_id });

    if (decision.target) {
      const [x, y] = center(decision.target);
      this.ringAt(x, y, 'aim');
      await sleep(220);
      if (!this.running) { this.stepIndex = index; return; }
      window.__BOT_CTX__ = { bot_step_index: index, correlation_id };
      this.clickAt(x, y);
      this.ringAt(x, y, 'hit');
      window.__BOT_CTX__ = { bot_step_index: null, correlation_id: null };
    }
    fetch(`/api/runs/${encodeURIComponent(this.runId)}/bot_steps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record),
    }).catch(() => {});
    this.schedule(STEP_MS);
  }

  // One decision from what is on screen. The Playwright runner calls this
  // through window.__BOT_HOOKS__.plan() and does the clicking itself.
  plan() {
    const rendered = window.__GAME_DEBUG__.getRenderedTargets();
    const targets = rendered.filter((t) => t.visible);
    // Buildings partly hidden behind others still count as seen, not as clickable.
    const owned = new Set(rendered.filter((t) => t.kind === 'building').map((t) => t.building_type));
    const decision = this.decide(targets, owned);
    // A target that was shown as unaffordable or locked was a wasted click.
    const t = decision.target;
    this.lastRejectedTarget = t && (!t.affordable || t.locked) ? t.target_id : null;
    for (const [id, n] of this.avoid) if (n <= 1) this.avoid.delete(id); else this.avoid.set(id, n - 1);
    if (this.lastRejectedTarget) this.avoid.set(this.lastRejectedTarget, 6);
    return { decision, targets };
  }

  decide(targets, owned = new Set()) {
    const p = this.policy;
    const by = (id) => targets.find((t) => t.target_id === id);
    const r = () => this.rng();
    const state = window.__GAME_STATE__ || {};

    const ok = by('btn_advisor_ok');
    if (ok) return { target: ok, thought: 'A welcome message from the elder. Accept it and start playing.' };

    const claim = by('btn_claim_quest');
    if (claim && r() < 0.5 + p.follow_tutorial * 0.5) return { target: claim, thought: 'The quest card glows. Claim the chapter reward.' };

    // Defeat recovery screen
    const defeatBtn = by('btn_defeat_heroes');
    if (defeatBtn) {
      const lineFn = DEFEAT_LINES[this.persona?.persona_id] || (() => 'Defeated! Head to Heroes Hall to level up.');
      return { target: defeatBtn, thought: lineFn(), mood: 'frustrated' };
    }

    // Battle victory / return button
    const continueBtn = by('btn_battle_continue');
    if (continueBtn) {
      return { target: continueBtn, thought: 'Battle concluded. Return to the valley.', mood: 'engaged' };
    }

    // Battle arena active ultimates
    const ultVaelen = by('btn_ult_vaelen');
    if (ultVaelen && !ultVaelen.locked && !ultVaelen.cooldown) {
      return { target: ultVaelen, thought: '⚡ Commander Vaelen Rage 100%! Unleash Earthshatter Stomp!', mood: 'engaged' };
    }
    const ultLyra = by('btn_ult_lyra');
    if (ultLyra && !ultLyra.locked && !ultLyra.cooldown) {
      return { target: ultLyra, thought: '✨ Sun-Priestess Lyra Rage 100%! Cast Solar Salve to heal allies!', mood: 'engaged' };
    }

    // Heroes Hall modal open
    if (by('btn_close_heroes')) {
      const lvlBtn = by('btn_hero_levelup') || by('btn_levelup_vaelen') || by('btn_levelup_lyra')
        || targets.find((t) => t.target_id.includes('levelup'));
      const food = state.resources?.food ?? 100;
      const foodOk = p.hoard_food_threshold ? food > p.hoard_food_threshold : true;
      if (p.level_heroes && lvlBtn && lvlBtn.affordable && !lvlBtn.locked && foodOk) {
        const lineFn = HERO_LEVELUP_LINES[this.persona?.persona_id] || (() => 'Hero leveled up! Squad power boosted.');
        return { target: lvlBtn, thought: lineFn(), mood: 'engaged' };
      }
      return { target: by('btn_close_heroes'), thought: 'Heroes inspected. Return to the valley.' };
    }

    // Expedition / Campaign modal open: fight one battle or leave.
    const enc = targets.filter((t) => (t.kind === 'encounter' || t.target_id.startsWith('stage_') || t.target_id.startsWith('encounter_')) && !t.cleared);
    if (by('btn_close_expedition')) {
      const affordable = enc.filter((t) => t.affordable && !t.cleared);
      if (affordable.length) {
        if (p.rush_campaign && state.achieved) {
          const stage6 = affordable.find((t) => t.target_id === 'stage_6' || t.target_id === 'btn_arena_stage_6');
          if (stage6) return { target: stage6, thought: 'Charge straight into Stage 6 Sabertooth Canyon! No time to grind levels!', mood: 'engaged' };
        }
        if (p.plan) {
          const stage6 = affordable.find((t) => t.target_id === 'stage_6' || t.target_id === 'btn_arena_stage_6');
          const squadPower = state.squad_power ?? (state.stats?.squad_power ?? 307);
          if (stage6 && squadPower < 460) {
            return { target: by('btn_close_expedition'), thought: 'Squad power is below 460 for Sabertooth Canyon. Close campaign and level heroes first.', mood: 'engaged' };
          }
        }
        return { target: affordable[0], thought: `${shortLabel(affordable[0])} looks winnable. Attack!` };
      }
      return { target: by('btn_close_expedition'), thought: 'Nothing out there is affordable. Return to the valley.' };
    }

    // Research modal open: the tech nodes are the only actionable things.
    const techs = targets.filter((t) => t.kind === 'tech' && !t.done);
    if (by('btn_close_research')) {
      if (this.researchedThisVisit) {
        this.researchedThisVisit = false;
        this.researchCooldown = 4;
        return { target: by('btn_close_research'), thought: 'Research done. Close the tree and put it to use.' };
      }
      const affordable = techs.filter((t) => t.affordable && !t.locked);
      affordable.sort((a, b) => TECH_PRIORITY.indexOf(a.target_id) - TECH_PRIORITY.indexOf(b.target_id));
      // A goal-minded player saves for the tech that matters most instead of
      // buying whatever is cheap. Only techs it can see are considered.
      const open = techs.filter((t) => !t.locked)
        .sort((a, b) => TECH_PRIORITY.indexOf(a.target_id) - TECH_PRIORITY.indexOf(b.target_id));
      const saving = open.length && affordable.length && open[0] !== affordable[0] && r() < (p.plan ? 0.9 : 0.6);
      if (saving) {
        this.researchCooldown = 6;
        this.savingFor = open[0].target_id;
        return { target: by('btn_close_research'), thought: `Save up for ${shortLabel(open[0])} first.`, closedEmpty: true };
      }
      if (affordable.length) {
        this.researchedThisVisit = true;
        this.savingFor = null;
        return { target: affordable[0], thought: `"${affordable[0].label.split(/\s{2,}| \d/)[0]}" is affordable. Research it.` };
      }
      const tempting = techs.filter((t) => !t.locked && t.target_id !== this.lastRejectedTarget);
      if (tempting.length && r() < 0.5 * (1 - p.wait_when_unsure) + 0.15) {
        const pick = tempting[0];
        return { target: pick, thought: `Try ${shortLabel(pick)} even though the cost looks high.` };
      }
      this.researchCooldown = 4;
      if (open.length) this.savingFor = open[0].target_id;
      return { target: by('btn_close_research'), thought: 'Nothing in the tech tree is affordable yet. Close it and keep building.', closedEmpty: true };
    }

    const ready = targets.filter((t) => t.kind === 'building' && t.ready);

    // In free_play: Instant-finish chips (free_*)
    if (state.step_id === 'free_play' && state.achieved && p.instant_finish) {
      const freeChip = targets.find((t) => t.target_id.startsWith('free_'));
      if (freeChip) {
        const lineFn = INSTANT_FINISH_LINES[this.persona?.persona_id] || (() => '⚡ Tap FREE instant-finish! Why wait for timers?');
        return { target: freeChip, thought: lineFn(), mood: 'engaged' };
      }
    }

    // In free_play: Territory Expansion (exp_1, exp_2)
    if (state.step_id === 'free_play' && state.achieved) {
      const expTarget = targets.find((t) => (t.target_id === 'exp_1' || t.target_id === 'exp_2') && t.affordable && !t.locked);
      if (expTarget && (p.curiosity > 0.5 || p.plan || r() < 0.45)) {
        const food = state.resources?.food ?? 100;
        if (!p.hoard_food_threshold || food > p.hoard_food_threshold) {
          const lineFn = EXPANSION_LINES[this.persona?.persona_id] || (() => 'Expand village territory into the valley clearing.');
          return { target: expTarget, thought: lineFn(), mood: 'engaged' };
        }
      }
    }

    // A build card is selected: place it on a plot.
    const pads = targets.filter((t) => t.kind === 'pad');
    const selected = targets.find((t) => t.selected);
    if (selected && pads.length) {
      if (selected.target_id === 'card_tribal_monument' && p.culture_adjacency && state.achieved) {
        const lineFn = CULTURE_AURA_LINES[this.persona?.persona_id] || (() => 'Place the Sacred Obelisk to project a +20% culture adjacency aura.');
        const pad = pads.find((t) => t.highlighted) || pads[0];
        return { target: pad, thought: lineFn() };
      }
      const pad = pads.find((t) => t.highlighted) || pads[Math.floor(r() * Math.min(3, pads.length))];
      return { target: pad, thought: `Place the ${shortLabel(selected)} on an empty plot.` };
    }

    // Tutorial guidance (arrow / highlighted target).
    // A highlighted card for a building already placed means "wait for it", not "build another".
    const guided = targets.find((t) => t.highlighted && t.kind !== 'pad'
      && !(t.kind === 'build_card' && owned.has(t.target_id.slice(5))));
    // A pulsing NEW! button mid-tutorial tempts distractible players before they read the arrow.
    // Planners hold back. The pulse clears after the first use, so this fires once at most.
    const feature = targets.find((t) => t.kind === 'feature' && t.affordable && !t.locked && !t.cooldown);
    const inTutorial = state.step_id === 'onb_02_forager' || state.step_id === 'onb_03_handoff';
    const distractible = p.distractibility ?? Math.max(p.salience_weight * (1 - p.follow_tutorial), p.curiosity);
    if (inTutorial && feature?.computed_salience === 'high_pulse' && !p.plan && r() < distractible) {
      this.featureUses += 1;
      return { target: feature, thought: optionThought({ t: feature, why: 'feature' }, { persona: this.persona, featureUses: 0 }), mood: 'curious' };
    }
    // In free play, before Stone Age, an affordable feature is a known way to gather resources.
    if (state.step_id === 'free_play' && feature && !state.achieved && this.featureUses < 2 && r() < 0.6) {
      const thought = optionThought({ t: feature, why: 'feature' }, this);
      this.featureUses += 1;
      return { target: feature, thought, mood: 'curious' };
    }
    if (guided && r() < p.follow_tutorial) {
      return { target: guided, thought: `The advisor's arrow points at ${shortLabel(guided)}. Follow it.` };
    }

    // Otherwise weigh what catches the eye. Common sense from the card names:
    // the first Woodcutter or Quarry is the only way to get more wood or stone,
    // so an unbuilt one pulls harder and other spending waits for it.
    // Only once the advisor stops pointing at things (free play).
    const tutorialActive = targets.some((t) => t.highlighted);
    const missingProducer = (t) => !tutorialActive && PRODUCERS[t.target_id] && !owned.has(PRODUCERS[t.target_id]);
    const producerOpen = targets.some((t) => t.kind === 'build_card' && !t.locked && missingProducer(t));
    // Saving for a tech: gather the scarcest basic resource first.
    const res = state.resources || {};
    const scarce = this.savingFor ? ['food', 'wood', 'stone'].sort((x, y) => (res[x] ?? 0) - (res[y] ?? 0))[0] : null;
    const options = ready.map((t) => ({ t, w: (0.3 + p.harvest * 0.9) * (PRODUCES[t.building_type] === scarce ? 3 : 1), why: 'harvest' }));
    for (const t of targets) {
      const sal = SALIENCE[t.computed_salience] ?? 0.2;
      if (t.kind === 'build_card' && !t.locked) {
        let w = 0.2 + p.prefer_build * 0.6 + p.salience_weight * sal + (t.highlighted ? 0.6 : 0);
        if (t.target_id === 'card_tribal_monument' && p.culture_adjacency && state.achieved) w *= 2.5;
        if (missingProducer(t)) w *= 4;
        else if (producerOpen) w *= 0.05;
        if (!t.affordable) w *= this.avoid.has(t.target_id) ? 0.1 : 0.35 * (1 - p.wait_when_unsure * 0.6);
        if (p.plan && !t.affordable) w *= 0.3;
        // Saving for a tech: only a missing producer is still worth the spend.
        if (this.savingFor && !t.highlighted && !missingProducer(t)) w *= p.plan ? 0.05 : 0.1;
        options.push({ t, w, why: t.affordable ? 'build' : 'try' });
      } else if (t.kind === 'worker' && !t.staffed) {
        options.push({ t, w: 0.6 + p.harvest * 0.6, why: 'staff' });
      } else if (t.kind === 'upgrade' && t.affordable && !producerOpen && !this.savingFor) {
        options.push({ t, w: 0.15 + p.prefer_build * 0.4 + (this.savingFor ? -0.1 : 0), why: 'upgrade' });
      } else if (t.kind === 'feature' && !t.cooldown) {
        // Shiny new buttons pull on salience; explorers try anything new once; planners and hoarders hold back.
        // After the first try the novelty is gone, so the button competes like any other action.
        let w = this.featureUses === 0 ? 0.05 + p.salience_weight * sal * 1.4 + p.curiosity * 1.5
          : 0.05 + p.salience_weight * sal * 0.4;
        if (!t.affordable) w *= this.avoid.has(t.target_id) ? 0.1 : 0.35 * (1 - p.wait_when_unsure * 0.6);
        if (p.plan && tutorialActive) w *= 0.1;
        if (!t.highlighted) w *= 1 - p.wait_when_unsure * 0.8;
        options.push({ t, w, why: 'feature' });
      } else if (t.target_id === 'btn_expedition') {
        options.push({ t, w: 0.08 + p.salience_weight * 0.25, why: 'expedition' });
      } else if (t.target_id === 'btn_heroes' && state.achieved) {
        const w = (p.level_heroes ? 0.35 : 0.05) + (p.explore_modals ? 0.35 : 0);
        options.push({ t, w, why: 'heroes' });
      } else if (t.target_id === 'btn_quest_ledger' && p.explore_modals && state.achieved) {
        options.push({ t, w: 0.25, why: 'quest_ledger' });
      } else if (t.target_id === 'btn_research' && this.researchCooldown <= 0) {
        const w = (0.05 + p.salience_weight * sal * 1.6 + (t.highlighted ? 0.8 * p.follow_tutorial : 0) + (p.plan ? 0.35 : 0))
          * (producerOpen ? 0.4 : 1)
          // Saving for a tech: check back once the cooldown is over.
          * (this.savingFor ? 3 : 1);
        options.push({ t, w, why: 'research' });
      }
    }
    if (this.researchCooldown > 0) this.researchCooldown -= 1;
    const waitW = 0.15 + p.wait_when_unsure * 0.6;
    const total = options.reduce((s, o) => s + o.w, 0) + waitW;
    let roll = r() * total;
    for (const o of options) {
      roll -= o.w;
      if (roll <= 0) {
        const thought = optionThought(o, this);
        if (o.why === 'feature' && o.t.affordable) this.featureUses += 1;
        return { target: o.t, thought, mood: o.why === 'feature' ? (o.t.affordable ? 'curious' : 'frustrated') : undefined };
      }
    }
    return { target: null, thought: ready.length ? 'Let the workers gather a bit longer.' : 'Not sure what to do next. Watch the settlement for a moment.' };
  }

  finish(reason) {
    if (this.done) return;
    this.done = true;
    this.running = false;
    clearTimeout(this.timer);
    const why = { first_achievement: 'Stone Age reached. Session complete.', bronze_age_mastery: 'Bronze Age mastered. Session complete.' };
    this.onThought({ index: this.stepIndex, thought: why[reason] || 'Time limit reached. Ending the session.', target_id: null });
    this.onDone(reason);
  }
}

function moodOf(decision, bot) {
  if (!decision.target) return /Not sure/.test(decision.thought) ? 'confused' : 'bored';
  if (bot.lastRejectedTarget) return 'frustrated';
  return 'engaged';
}

// First-use and repeat-use think-aloud lines per persona, grounded in each player type.
const FEATURE_LINES = {
  impatient_newcomer: [
    (t) => `Ooo, a glowing ${t} button with a NEW! badge. I have to try it!`,
    (t) => `${t} is back off cooldown. Mash it again for fast loot!`,
  ],
  curious_explorer: [
    (t) => `Wait, what does ${t} do? Let me test this mechanic right now.`,
    (t) => `Let's trigger ${t} one more time to see how the rewards scale.`,
  ],
  optimizer: [
    (t) => `${t} converts surplus Food into Stone and RP for the Stone Age push. Optimal trade.`,
    (t) => `Running ${t} again shaves a full cycle off the Stone Age tech requirement.`,
  ],
  first_time_casual: [
    (t) => `The tutorial is finished, so it should be safe to try ${t} for the village.`,
    (t) => `${t} helped the settlement grow. Let's send another party.`,
  ],
  cautious_hoarder: [
    (t) => `I have a safe food buffer now, and ${t} refunds more than it costs.`,
    (t) => `Stockpiles are healthy. One more safe ${t} run to top up Stone.`,
  ],
};

function optionThought(o, bot) {
  const name = shortLabel(o.t);
  if (o.why === 'feature') {
    const title = o.t.label || name;
    if (!o.t.affordable) return `${title} looks great, but I am not sure I can afford it. Try anyway.`;
    // Each player type voices its own reaction; unknown personas keep the generic lines.
    const lines = FEATURE_LINES[bot.persona?.persona_id];
    if (bot.featureUses === 0) {
      if (lines) return lines[0](title);
      return o.t.computed_salience === 'high_pulse'
        ? `Ooo, a glowing ${title} button with a NEW! badge. I have to try it!`
        : `A new ${title} button. Let me see what it does.`;
    }
    if (lines) return lines[1](title);
    return `${title} paid off last time. Use it again.`;
  }
  if (o.why === 'harvest') return `A harvest icon is bobbing over the ${pretty(o.t.label)}. Collect it.`;
  if (o.why === 'research') {
    return o.t.computed_salience === 'high_pulse' ? 'The big glowing Research button looks important. Open it.' : 'There is a small scroll icon in the corner. Maybe research?';
  }
  if (o.why === 'try') return `${name} looks good. Try to build it.`;
  if (o.why === 'staff') return `The ${pretty(o.t.building_type)} has no worker. Send someone back to it.`;
  if (o.why === 'upgrade') return `${o.t.label} is affordable. Upgrade it.`;
  if (o.why === 'expedition') return 'Crossed swords on the map. What is out there?';
  if (o.why === 'heroes') return 'The Heroes Hall has training options. Inspect Commander Vaelen and Priestess Lyra.';
  if (o.why === 'quest_ledger') return 'Open the 6-Chapter Questlines Ledger to read the realm lore.';
  return o.t.computed_salience === 'high' ? `${name} has a shiny NEW! ribbon. Build it.` : `Build a ${name}.`;
}

function shortLabel(t) {
  return pretty((t.label || t.target_id).split(/\s{2,}|\d/)[0].trim() || t.target_id);
}

function pretty(s) {
  return String(s || '').replace(/^(card_|tech_|btn_|building_)/, '').replace(/_/g, ' ').trim();
}

function summarize(targets) {
  const counts = {};
  for (const t of targets) counts[t.kind] = (counts[t.kind] || 0) + 1;
  const flags = targets.filter((t) => t.highlighted).map((t) => t.target_id);
  return `${targets.length} visible targets (${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')})`
    + (flags.length ? `; highlighted: ${flags.join(', ')}` : '');
}

function center(t) {
  return [Math.round(t.x + t.w / 2), Math.round(t.y + t.h / 2)];
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
