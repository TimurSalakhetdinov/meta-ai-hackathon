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

const DEFAULT_POLICY = { follow_tutorial: 0.5, salience_weight: 0.5, prefer_build: 0.5, harvest: 0.8, wait_when_unsure: 0.3,
  curiosity: 0.2 };
const SALIENCE = { low: 0.05, medium: 0.45, high: 0.9, high_pulse: 1.2 };
const PRODUCERS = { card_woodcutter_hut: 'woodcutter_hut', card_stone_quarry: 'stone_quarry', card_smelter: 'smelter' };
const TECH_PRIORITY = ['tech_toolmaking', 'tech_stone_age', 'tech_masonry', 'tech_bronze_age', 'tech_baskets',
  'tech_woodworking', 'tech_irrigation'];

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

    const ok = by('btn_advisor_ok');
    if (ok) return { target: ok, thought: 'A welcome message from the elder. Accept it and start playing.' };

    const claim = by('btn_claim_quest');
    if (claim && r() < 0.5 + p.follow_tutorial * 0.5) return { target: claim, thought: 'The quest card glows. Claim the chapter reward.' };

    // Expedition map open: fight one affordable battle, otherwise leave.
    if (by('btn_close_expedition')) {
      const fight = targets.find((t) => t.kind === 'encounter' && t.affordable);
      if (fight && r() < 0.7) return { target: fight, thought: `${shortLabel(fight)} looks winnable. Attack!` };
      return { target: by('btn_close_expedition'), thought: 'No battle worth it right now. Back to the village.' };
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

    // A build card is selected: place it on a plot.
    const pads = targets.filter((t) => t.kind === 'pad');
    const selected = targets.find((t) => t.selected);
    if (selected && pads.length) {
      const pad = pads.find((t) => t.highlighted) || pads[Math.floor(r() * Math.min(3, pads.length))];
      return { target: pad, thought: `Place the ${shortLabel(selected)} on an empty plot.` };
    }

    // Tutorial guidance (arrow / highlighted target).
    // A highlighted card for a building already placed means "wait for it", not "build another".
    const guided = targets.find((t) => t.highlighted && t.kind !== 'pad'
      && !(t.kind === 'build_card' && owned.has(t.target_id.slice(5))));
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
    const options = ready.map((t) => ({ t, w: 0.3 + p.harvest * 0.9, why: 'harvest' }));
    for (const t of targets) {
      const sal = SALIENCE[t.computed_salience] ?? 0.2;
      if (t.kind === 'build_card' && !t.locked) {
        let w = 0.2 + p.prefer_build * 0.6 + p.salience_weight * sal + (t.highlighted ? 0.6 : 0);
        if (missingProducer(t)) w *= 4;
        else if (producerOpen) w *= 0.05;
        if (!t.affordable) w *= this.avoid.has(t.target_id) ? 0.1 : 0.35 * (1 - p.wait_when_unsure * 0.6);
        if (p.plan && !t.affordable) w *= 0.3;
        // Saving for a tech: only a missing producer is still worth the spend.
        if (this.savingFor && !t.highlighted && !missingProducer(t)) w *= p.plan ? 0.1 : 0.3;
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
      } else if (t.target_id === 'btn_research' && this.researchCooldown <= 0) {
        const w = (0.05 + p.salience_weight * sal * 1.6 + (t.highlighted ? 0.8 * p.follow_tutorial : 0) + (p.plan ? 0.35 : 0))
          * (producerOpen ? 0.4 : 1);
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

function optionThought(o, bot) {
  const name = shortLabel(o.t);
  if (o.why === 'feature') {
    const title = o.t.label || name;
    if (!o.t.affordable) return `${title} looks great, but I am not sure I can afford it. Try anyway.`;
    if (bot.featureUses === 0) {
      return o.t.computed_salience === 'high_pulse'
        ? `Ooo, a glowing ${title} button with a NEW! badge. I have to try it!`
        : `A new ${title} button. Let me see what it does.`;
    }
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
