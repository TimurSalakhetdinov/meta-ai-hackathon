"""Feature studio: a PM types a feature idea, the architect agent turns it into a FeaturePlugin patch.

The patch stops at `validated` behind the human approval gate. After approval,
persona playtesters run a paired A/B experiment and the report gives a verdict
computed only from the measured metrics. The designer agent can then stage a
rework patch, again behind the gate.

Stub mode parses the prompt with deterministic rules and draws the emblem with
Pillow, so the studio works offline at zero Meta API cost. Meta mode asks Muse
Spark for the plugin and Muse Image for the emblem.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from pydantic import ValidationError

from .config_service import ConfigService
from .meta_client import MetaClient
from .schemas import FEATURE_RESOURCES, FeaturePlugin, PatchRecord

ROOT = Path(__file__).resolve().parents[1]
GENERATED_DIR = ROOT / "frontend" / "static" / "assets" / "generated"

VERDICTS = {
    "positive": "✅ POSITIVE IMPACT — SHIP IT",
    "mixed": "⚠️ MIXED IMPACT — REWORK RECOMMENDED",
    "hurts": "❌ HURTS ONBOARDING — DO NOT SHIP AS-IS",
}
STEP_LABEL = {"onb_01_shelter": "Step 1/3 (Shelter)", "onb_02_forager": "Step 2/3 (Forager)",
              "onb_03_handoff": "Step 3/3 (Handoff)", "free_play": "free play"}

# Theme rules: keywords, then the plugin defaults a PM would expect for that theme.
THEMES: list[tuple[tuple[str, ...], dict[str, Any]]] = [
    (("battle", "raid", "raider", "ambush", "fight", "skirmish", "attack", "war", "bandit"), {
        "theme": "battle", "title": "Raider Ambush", "icon": "⚔️", "action_type": "encounter_modal",
        "costs": {"food": 20}, "rewards": {"rp": 6, "stone": 15, "score": 15},
        "motif": "crossed bronze swords over a round shield",
        "advisor_intro": "Raiders by the river, Chief! Our hunters drove them off and took their spoils.",
    }),
    (("merchant", "trade", "trader", "caravan", "market", "barter", "peddler"), {
        "theme": "trade", "title": "Wandering Merchant", "icon": "\U0001f42a", "action_type": "instant_trade",
        "costs": {"food": 20}, "rewards": {"wood": 25},
        "motif": "a merchant's sack of goods with a camel silhouette",
        "advisor_intro": "A merchant caravan! Food for timber is a fair trade, Chief.",
    }),
    (("festival", "feast", "boost", "celebration", "party", "dance", "harvest fest"), {
        "theme": "festival", "title": "Harvest Festival", "icon": "\U0001f389", "action_type": "festival_buff",
        "costs": {"food": 30}, "rewards": {"rp": 8, "score": 10},
        "motif": "a bonfire with garlands and drums",
        "advisor_intro": "The tribe dances around the fire! Spirits are high and ideas flow, Chief.",
    }),
    (("tax", "tribute", "collector", "levy", "toll"), {
        "theme": "tax", "title": "Royal Tax Collector", "icon": "\U0001f451", "action_type": "instant_trade",
        "costs": {"food": 15}, "rewards": {"stone": 10, "score": 5},
        "motif": "a crown above a stack of carved stone tokens",
        "advisor_intro": "The tribute is collected, Chief. Spend it wisely.",
    }),
]
GENERIC_THEME: dict[str, Any] = {
    "theme": "generic", "title": "Village Boon", "icon": "✨", "action_type": "instant_trade",
    "costs": {"food": 15}, "rewards": {"rp": 5, "score": 10}, "motif": "a glowing rune stone",
    "advisor_intro": "Something new stirs in the village, Chief. Let us see what it brings.",
}

# Step words in priority order: "after the tutorial" must win over "tutorial".
STEP_RULES: list[tuple[str, str]] = [
    (r"after (the )?tutorial|free[ -]?play|stone age|late game|endgame|after onboarding", "free_play"),
    (r"step ?3|handoff|hand-off|toolmaking", "onb_03_handoff"),
    (r"step ?2|forager|tutorial|early|onboarding", "onb_02_forager"),
    (r"step ?1|shelter|first minute|very start", "onb_01_shelter"),
]
SALIENCE_RULES: list[tuple[str, str]] = [
    (r"glow|puls|bright|flash|shiny|big|huge|loud|prominent", "high_pulse"),
    (r"subtle|small|quiet|hidden|discreet|tiny|low[- ]key", "low"),
    (r"medium|normal|regular|standard", "medium"),
]
RESOURCE_WORDS = {"wood": "wood", "timber": "wood", "lumber": "wood", "food": "food", "berries": "food",
                  "stone": "stone", "stones": "stone", "rp": "rp", "research points": "rp", "research": "rp",
                  "score": "score", "points": "score", "glory": "score"}
# Word stems that mark the quantities after them as a cost or a reward.
COST_STEMS = ("cost", "spend", "pay", "pric", "consum", "drain", "take", "use", "for", "require", "need")
REWARD_STEMS = ("giv", "grant", "reward", "win", "earn", "yield", "get", "gain", "bonus", "award", "produc",
                "return", "drop", "loot")
QTY_RE = re.compile(r"([+-]?)\s*(\d{1,3})\s*(research points|wood|timber|lumber|food|berries|stones?|rp|score|points|glory)\b",
                    re.IGNORECASE)
COOLDOWN_RE = re.compile(r"(\d{1,3})\s*(?:s|sec|secs|seconds?)\s*cooldown|cooldown\s*(?:of\s*)?(\d{1,3})", re.IGNORECASE)
QUOTED_RE = re.compile(r"[\"“']([^\"”']{3,40})[\"”']")

ARCHITECT_SYSTEM = (
    "You are the feature architect of a casual historical city-builder. Turn the product manager's idea into "
    "one FeaturePlugin JSON object with these keys: feature_id (snake_case), title, icon (one emoji), "
    "description, unlock_at_step (onb_01_shelter | onb_02_forager | onb_03_handoff | free_play), "
    "button_salience (low | medium | high_pulse), action_type (encounter_modal | instant_trade | festival_buff), "
    "costs and rewards (maps from wood, food, stone, rp or score to integers), cooldown_sec, advisor_intro "
    "(one line from Elder Kaelen), visual_prompt (an icon brief for Muse Image). Respect every number and "
    "timing the manager states. Return JSON only."
)
REWORK_SYSTEM = (
    "You are the game designer. A playtest report shows how a new feature affected onboarding. Propose the "
    "smallest change to the FeaturePlugin that keeps the feature's fun but protects onboarding. Return "
    "{\"plugin\": FeaturePlugin, \"rationale\": str}."
)


# ------------------------------------------------------------------ parsing
def _theme(text: str) -> dict[str, Any]:
    for words, theme in THEMES:
        if any(re.search(rf"\b{re.escape(w)}", text) for w in words):
            return theme
    return GENERIC_THEME


def _first_match(text: str, rules: list[tuple[str, str]], default: str) -> str:
    for pattern, value in rules:
        if re.search(pattern, text):
            return value
    return default


def _cue(text: str) -> Optional[str]:
    """Side named by the last cue word in text, if any."""
    for tok in reversed(re.findall(r"[a-z]+", text.lower())):
        if tok == "for" or any(tok.startswith(c) for c in COST_STEMS if c != "for"):
            return "costs"
        if any(tok.startswith(c) for c in REWARD_STEMS):
            return "rewards"
    return None


def parse_quantities(prompt: str) -> dict[str, dict[str, int]]:
    """Each quantity takes the side of the cue word before it, else the side of the quantity before it."""
    out: dict[str, dict[str, int]] = {"costs": {}, "rewards": {}}
    prev_end, prev_side = 0, None
    for m in QTY_RE.finditer(prompt):
        word = m.group(3).lower()
        res = RESOURCE_WORDS["stone" if word == "stones" else word]
        between = re.split(r"[.;!?]", prompt[prev_end:m.start()])
        if m.group(1) == "+":
            side = "rewards"
        elif m.group(1) == "-":
            side = "costs"
        else:
            side = _cue(between[-1]) or (prev_side if len(between) == 1 else None) or _cue(prompt[:m.start()]) or "costs"
        if side == "costs" and res == "score":
            side = "rewards"
        out[side][res] = min(500, int(m.group(2)))
        prev_end, prev_side = m.end(), side
    return out


# "costs wood" with no number: an early feature priced like a starter building, a late one like a small upkeep.
NAMED_COST_RE = re.compile(r"\b(?:costs?|spends?|pays?|consumes?|drains?|takes?|requires?|needs?)\s+(?:some\s+|a\s+little\s+)?"
                           r"(wood|timber|lumber|food|berries|stones?)\b")
NAMED_COST_DEFAULT = {"wood": (55, 25), "food": (20, 20), "stone": (15, 10)}


def _named_costs(text: str, step: str) -> dict[str, int]:
    out = {}
    for m in NAMED_COST_RE.finditer(text):
        res = RESOURCE_WORDS["stone" if m.group(1) == "stones" else m.group(1)]
        early, late = NAMED_COST_DEFAULT[res]
        out[res] = early if step != "free_play" else late
    return out


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:40].strip("_")
    return slug if len(slug) >= 2 else "feature"


def stub_plugin(prompt: str) -> dict[str, Any]:
    """Deterministic NL parser: theme, step, salience, quantities and cooldown from free text."""
    text = prompt.lower()
    theme = _theme(text)
    qty = parse_quantities(prompt)
    quoted = QUOTED_RE.search(prompt)
    title = quoted.group(1).strip().title() if quoted else theme["title"]
    cooldown = COOLDOWN_RE.search(prompt)
    cooldown_sec = float(next(g for g in cooldown.groups() if g)) if cooldown else 12.0
    step = _first_match(text, STEP_RULES, "free_play")
    costs = qty["costs"] or _named_costs(text, step) or dict(theme["costs"])
    rewards = qty["rewards"] or dict(theme["rewards"])
    return {
        "feature_id": slugify(title),
        "title": title,
        "icon": theme["icon"],
        "description": prompt.strip()[:240],
        "unlock_at_step": step,
        "button_salience": _first_match(text, SALIENCE_RULES, "high_pulse"),
        "action_type": theme["action_type"],
        "costs": costs,
        "rewards": rewards,
        "cooldown_sec": max(2.0, min(120.0, cooldown_sec)),
        "advisor_intro": theme["advisor_intro"],
        "visual_prompt": (f"2.5D hand-painted strategy game icon emblem for {title}, {theme['motif']}, "
                          "warm gold and stone border, isolated on solid light background"),
    }


def _clean_plugin(raw: dict[str, Any], fallback: dict[str, Any]) -> FeaturePlugin:
    """Validate a model-made plugin; fall back field by field to the stub parse."""
    merged = {**fallback, **{k: v for k, v in raw.items() if k in FeaturePlugin.model_fields and v not in (None, "")}}
    for key in ("costs", "rewards"):
        merged[key] = {r: int(v) for r, v in (merged.get(key) or {}).items() if r in FEATURE_RESOURCES}
    merged["feature_id"] = slugify(str(merged.get("feature_id") or merged.get("title") or "feature"))
    merged.pop("icon_url", None)
    try:
        return FeaturePlugin.model_validate(merged)
    except ValidationError:
        return FeaturePlugin.model_validate(fallback)


# ------------------------------------------------------------------ proposal
def approved_baseline(service: ConfigService) -> Optional[PatchRecord]:
    """Newest approved patch without a feature: the clean game the feature is tested against."""
    rows = [p for p in service.list_patches() if p.status == "approved" and "feature_plugin" not in p.body]
    return rows[-1] if rows else None


def stage_feature(service: ConfigService, plugin: FeaturePlugin, *, title: str, rationale: str) -> PatchRecord:
    baseline = approved_baseline(service)
    body = {**(baseline.body if baseline else {}), "feature_plugin": plugin.model_dump()}
    return service.propose(body, title=title, rationale=rationale, target_step=plugin.unlock_at_step,
                           actor="designer_agent", baseline_patch_id=baseline.patch_id if baseline else None)


def propose_feature(prompt: str, *, configs_dir: Path, client: MetaClient,
                    generated_dir: Path = GENERATED_DIR) -> dict[str, Any]:
    """PM text to a validated FeaturePlugin patch with an emblem. Never approves."""
    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Describe the feature first")
    stub = stub_plugin(prompt)
    raw = client.reason_json(ARCHITECT_SYSTEM, prompt, stub_result=stub, run_id="feature_studio", bucket="analysis")
    plugin = _clean_plugin(raw if isinstance(raw, dict) else {}, stub)
    emblem = client.generate_ui_emblem(plugin.visual_prompt or stub["visual_prompt"],
                                       out_path=Path(generated_dir) / f"{plugin.feature_id}.png",
                                       bucket="analysis", run_id="feature_studio")
    plugin = plugin.model_copy(update={"icon_url": f"/static/assets/generated/{emblem.name}"})
    record = stage_feature(ConfigService(configs_dir), plugin, title=f"Feature: {plugin.title}",
                           rationale=f"PM prompt: {prompt}")
    return {"patch": record.model_dump(), "plugin": plugin.model_dump(), "provider_mode": client.provider_mode,
            "emblem_source": "muse_image" if client.provider_mode == "meta" else "procedural_stub"}


# ------------------------------------------------------------------ verdict
def _pct(rate: Optional[float]) -> str:
    return "n/a" if rate is None else f"{round(rate * 100)}%"


def _num(v: Optional[float]) -> str:
    if v is None:
        return "n/a"
    return str(int(v)) if float(v).is_integer() else f"{v:.1f}"


def _mean(vals: list[Optional[float]]) -> Optional[float]:
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def verdict(ab: dict[str, Any], plugin: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Verdict from measured metrics only.

    hurts: B completes the tutorial or reaches Stone Age (the first achievement) less often than A.
    positive: neither got worse, playtesters used the feature, and score, Stone Age or stuck improved.
    mixed: anything else (ignored, no measurable gain, or only score or stuck got worse).
    """
    onb = ab["binary"]["onboarding_completed"]
    stone = ab["binary"]["first_achievement"]
    pairs = ab["pairs"]
    score = {arm: _mean([p[arm].get("final_score") for p in pairs]) for arm in ("A", "B")}
    stuck = ab.get("mean_stuck_events") or {"A": None, "B": None}
    uses = sum(p["B"].get("feature_uses", 0) for p in pairs)
    users = sum(1 for p in pairs if p["B"].get("feature_uses", 0))
    early = [p for p in pairs if p["B"].get("feature_uses_onboarding", 0)]
    a_rate, b_rate = onb["a_rate"] or 0.0, onb["b_rate"] or 0.0
    title = (plugin or {}).get("title", "The feature")
    step = STEP_LABEL.get((plugin or {}).get("unlock_at_step", ""), "its unlock step")

    gains = []
    if (stone["b_rate"] or 0) > (stone["a_rate"] or 0):
        gains.append(f"Stone Age {_pct(stone['a_rate'])} to {_pct(stone['b_rate'])}")
    if score["A"] is not None and score["B"] is not None and score["B"] > score["A"]:
        gains.append(f"mean score {_num(score['A'])} to {_num(score['B'])}")
    if stuck.get("A") is not None and stuck.get("B") is not None and stuck["B"] < stuck["A"]:
        gains.append(f"stuck events {_num(stuck['A'])} to {_num(stuck['B'])}")

    losses = []
    if score["A"] is not None and score["B"] is not None and score["B"] < score["A"]:
        losses.append(f"mean score {_num(score['A'])} to {_num(score['B'])}")
    if stuck.get("A") is not None and stuck.get("B") is not None and stuck["B"] > stuck["A"]:
        losses.append(f"stuck events {_num(stuck['A'])} to {_num(stuck['B'])}")

    sa, sb = stone["a_rate"] or 0.0, stone["b_rate"] or 0.0
    if b_rate < a_rate or sb < sa:
        key = "hurts"
        why = (f" {len(early)} of {len(pairs)} playtesters spent resources on it before finishing the tutorial."
               if early else "")
        drop = (f"drops onboarding completion from {_pct(a_rate)} to {_pct(b_rate)}" if b_rate < a_rate
                else f"drops Stone Age from {_pct(sa)} to {_pct(sb)}")
        takeaway = f"Unlocking {title} at {step} {drop}.{why}{_evidence(onb if b_rate < a_rate else stone)}"
    elif users and gains:
        key = "positive"
        takeaway = (f"{title} at {step} keeps onboarding at {_pct(b_rate)} and lifts {', '.join(gains)}; "
                    f"{users} of {len(pairs)} playtesters used it.")
    else:
        key = "mixed"
        reason = ("no playtester used it" if not users
                  else f"it lowers {', '.join(losses)}" if losses
                  else "it shows no measurable gain in score, Stone Age or stuck events")
        takeaway = f"{title} does not hurt onboarding ({_pct(a_rate)} to {_pct(b_rate)}), but {reason}."
    return {
        "key": key, "label": VERDICTS[key], "takeaway": takeaway,
        "plaques": {
            "onboarding": {"A": _pct(onb["a_rate"]), "B": _pct(onb["b_rate"])},
            "stuck": {"A": _num(stuck.get("A")), "B": _num(stuck.get("B"))},
            "stone_age": {"A": _pct(stone["a_rate"]), "B": _pct(stone["b_rate"])},
            "score": {"A": _num(score["A"]), "B": _num(score["B"])},
        },
        "feature_uses": uses, "feature_users": users, "early_users": len(early),
    }


def _evidence(stat: dict[str, Any]) -> str:
    """Small paired samples swing on one persona, so the takeaway says how strong the evidence is."""
    p = stat.get("mcnemar_exact_p")
    if p is None:
        return ""
    lost = stat.get("n10_a_only", 0)
    note = "significant" if p < 0.05 else "not significant, run more seeds"
    return f" Evidence: {lost} of {stat.get('n', 0)} pairs lost it (McNemar p = {p:.2f}, {note})."


def persona_quotes(ab: dict[str, Any], read_bot_steps: Any, feature_target: Optional[str]) -> list[dict[str, Any]]:
    """One think-aloud line per tested persona, from its B session; prefers the step where it met the feature."""
    out = []
    for pair in ab["pairs"]:
        b = pair["B"]
        steps = read_bot_steps(b["run_id"]) or []
        hit = next((s for s in steps if feature_target and s.get("target_id") == feature_target), None)
        pick = hit or next((s for s in reversed(steps) if s.get("thought")), None)
        stalled = not b.get("onboarding_completed") and pair["A"].get("onboarding_completed")
        mood = "frustrated" if stalled else ((pick or {}).get("player_mood") or ("bored" if not hit else "engaged"))
        outcome = []
        if b.get("feature_uses"):
            outcome.append(f"used it {b['feature_uses']}x" + (f" ({b['feature_uses_onboarding']} in onboarding)"
                                                               if b.get("feature_uses_onboarding") else ""))
        else:
            outcome.append("never used it")
        outcome.append("finished onboarding" if b.get("onboarding_completed")
                       else f"stalled at {b.get('where_stuck') or 'onboarding'}")
        out.append({"persona_id": pair["persona_id"], "seed": pair["seed"], "run_id": b["run_id"],
                    "thought": (pick or {}).get("thought") or "No think-aloud recorded.", "mood": mood,
                    "outcome": ", ".join(outcome)})
    return out


# ------------------------------------------------------------------ rework
def stub_rework(plugin: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    """Designer rules: move a tutorial-time feature to free play and make it feed the Stone Age
    bottleneck at a net gain, or make an ignored one visible."""
    new = dict(plugin)
    notes = []
    key = report.get("key")
    if key == "hurts" or plugin.get("unlock_at_step") != "free_play":
        if plugin.get("unlock_at_step") != "free_play":
            notes.append(f"move unlock_at_step from {plugin.get('unlock_at_step')} to free_play")
            new["unlock_at_step"] = "free_play"
        # Stone Age needs Masonry (35 Wood), then 50 Food, 20 Stone and 10 RP. Wood is the Masonry
        # bottleneck, so pay a little food, which the Forager refills fastest and the reward refunds.
        old_costs = plugin.get("costs") or {}
        new["costs"] = {"food": 10}
        if old_costs != new["costs"]:
            was = ", ".join(f"{v} {r.title()}" for r, v in old_costs.items()) or "nothing"
            notes.append(f"pay 10 Food instead of {was}")
        new["rewards"] = {"food": 25, "stone": 15, "rp": 6, "score": 25}
        notes.append("reward 25 Food, 15 Stone, 6 RP and 25 score, the Stone Age bottleneck")
        new["cooldown_sec"] = 15.0
        notes.append("set the cooldown to 15 s")
    if key == "mixed" and not report.get("feature_users"):
        if plugin.get("button_salience") != "high_pulse":
            new["button_salience"] = "high_pulse"
            notes.append("raise button_salience to high_pulse")
        costs = plugin.get("costs") or {}
        if costs:
            new["costs"] = {r: max(1, v // 2) for r, v in costs.items()}
            notes.append("halve the cost")
    if not notes:
        new["cooldown_sec"] = min(120.0, float(plugin.get("cooldown_sec", 12.0)) + 8.0)
        notes.append("lengthen the cooldown by 8 s so the feature paces free play")
    return {"plugin": new, "rationale": "Designer rework: " + "; ".join(notes) + "."}


def propose_rework(plugin: dict[str, Any], report: dict[str, Any], *, configs_dir: Path,
                   client: MetaClient) -> dict[str, Any]:
    stub = stub_rework(plugin, report)
    user = json.dumps({"plugin": plugin, "verdict": report.get("key"), "takeaway": report.get("takeaway"),
                       "plaques": report.get("plaques")})
    out = client.reason_json(REWORK_SYSTEM, user, stub_result=stub, run_id="feature_studio", bucket="analysis")
    raw = out.get("plugin") if isinstance(out, dict) and isinstance(out.get("plugin"), dict) else {}
    reworked = _clean_plugin({**raw, "feature_id": plugin["feature_id"]}, stub["plugin"])
    # Same feature, same emblem: the rework changes rules, not art.
    reworked = reworked.model_copy(update={"icon_url": plugin.get("icon_url")})
    rationale = (out.get("rationale") if isinstance(out, dict) else None) or stub["rationale"]
    record = stage_feature(ConfigService(configs_dir), reworked, title=f"Rework: {reworked.title}",
                           rationale=rationale)
    return {"patch": record.model_dump(), "plugin": reworked.model_dump(), "rationale": rationale}


# ------------------------------------------------------------------ playtest and report
def summary_name(patch_id: str) -> str:
    return f"studio_{patch_id}_ab.json"


def run_playtest(patch_id: str, *, configs_dir: Path, runs_dir: Path, client: MetaClient,
                 personas: Optional[list[str]] = None, seeds: Optional[list[int]] = None,
                 run_type: str = "full_window", session_fn: Any = None,
                 on_log: Any = None) -> dict[str, Any]:
    """Paired A/B playtest of an approved feature patch against its baseline patch."""
    import asyncio

    from .agents.experiment import Experiment, Pair
    from .bot_runner import load_personas

    service = ConfigService(configs_dir)
    record = service.load_patch(patch_id)
    if "feature_plugin" not in record.body:
        raise ValueError(f"{patch_id} carries no feature_plugin")
    baseline = record.baseline_patch_id
    if baseline and service.load_patch(baseline).status != "approved":
        baseline = None
    personas = personas or list(load_personas(configs_dir))
    exp = Experiment(configs_dir=configs_dir, runs_dir=runs_dir, clients={"A": client, "B": client},
                     run_type=run_type, session_fn=session_fn, experiment_id=f"studio_{patch_id}",
                     summary_name=summary_name(patch_id))
    if on_log is not None:
        exp.log = on_log
    return asyncio.run(exp.run([Pair(p, s) for p in personas for s in (seeds or [42])],
                               patch_id=patch_id, baseline_patch_id=baseline))


def build_report(patch_id: str, *, configs_dir: Path, runs_dir: Path, read_bot_steps: Any) -> Optional[dict[str, Any]]:
    path = Path(runs_dir) / summary_name(patch_id)
    if not path.exists():
        return None
    ab = json.loads(path.read_text())
    record = ConfigService(configs_dir).load_patch(patch_id)
    plugin = record.body.get("feature_plugin") or {}
    report = verdict(ab, plugin)
    target = f"btn_feature_{plugin['feature_id']}" if plugin.get("feature_id") else None
    report.update(patch_id=patch_id, plugin=plugin, experiment_id=ab.get("experiment_id"),
                  baseline=ab.get("baseline"), run_type=ab.get("run_type"), n_pairs=ab.get("n_pairs"),
                  provider_mode=ab.get("provider_mode"), cost_usd=ab.get("cost_usd"),
                  quotes=persona_quotes(ab, read_bot_steps, target),
                  replay=replay_pair(ab))
    return report


def replay_pair(ab: dict[str, Any]) -> Optional[dict[str, str]]:
    """The split replay shows the pair whose onboarding outcome differs, since that pair tells the story."""
    pairs = [p for p in ab.get("pairs", []) if p.get("A", {}).get("run_id") and p.get("B", {}).get("run_id")]
    if not pairs:
        return None
    pick = next((p for p in pairs if p["A"].get("onboarding_completed") != p["B"].get("onboarding_completed")), pairs[0])
    return {"A": pick["A"]["run_id"], "B": pick["B"]["run_id"]}
