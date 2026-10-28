"""Analyst agent: find where a playtester got stuck and why.

Reads a run's events, bot steps and frames, picks the stuck frame, outlines the
top 3 SAM masks on it (Research button, Woodcutter card or feature button, wood
counter), measures the distractor-to-goal visual area ratio, pulls think-aloud
quotes and writes `runs/<run_id>/analysis.json`. Stub mode builds the diagnosis
from rules over the events; meta mode asks Muse Spark.
"""

from __future__ import annotations

import io
import json
from collections import Counter
from pathlib import Path
from typing import Any, Optional

from PIL import Image, ImageDraw, ImageFont

from ..meta_client import MetaClient
from ..schemas import AnalysisConfig
from ..telemetry import compute_summary, derive_stuck

QUOTE_MOODS = ("confused", "frustrated", "bored")
MAX_QUOTES = 6
# Which on-screen element each friction hypothesis points at, in priority order.
FOCUS_TARGETS = ("btn_research", "card_woodcutter_hut", "hud_wood")
FOCUS_COLORS = ((255, 77, 77), (255, 196, 0), (0, 220, 255))

ANALYST_SYSTEM = (
    "You are a game UX analyst. Given telemetry from an AI playtester session, explain in JSON why the "
    "player got stuck. Return {\"diagnosis\": str, \"hypotheses\": [{\"id\": str, \"evidence\": str, "
    "\"confidence\": 0..1}], \"suggested_levers\": [str]} using only GameConfig lever names."
)


def _jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_run(run_dir: Path, analysis_cfg: AnalysisConfig) -> dict[str, Any]:
    raw = [e for e in _jsonl(run_dir / "events.jsonl") if e["event_type"] != "stuck"]
    stuck = derive_stuck(raw, analysis_cfg)
    events = sorted(raw + stuck, key=lambda e: e.get("sim_elapsed_sec", 0.0))
    return {"events": events, "bot_steps": _jsonl(run_dir / "bot_steps.jsonl"),
            "summary": compute_summary(events, analysis_cfg)}


def stuck_bot_step(events: list[dict[str, Any]], where: Optional[str]) -> Optional[int]:
    """Bot step of the first stuck event at the stuck step, else the last bot step there."""
    at = [e for e in events if e.get("step_id") == where and e.get("bot_step_index") is not None]
    first = next((e for e in at if e["event_type"] == "stuck"), None)
    if first:
        return first["bot_step_index"]
    return at[-1]["bot_step_index"] if at else None


def playtester_quotes(events: list[dict[str, Any]], bot_steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Think-aloud lines worth quoting: negative moods, or the step right before a rejection or stuck."""
    triggers: dict[int, str] = {}
    for e in events:
        i = e.get("bot_step_index")
        if i is None:
            continue
        if e["event_type"] == "action_rejected":
            triggers.setdefault(i, f"before action_rejected ({e['payload'].get('reason')})")
        elif e["event_type"] == "stuck":
            triggers.setdefault(i, f"before stuck ({e['payload'].get('reason')})")
    step_of = {e.get("bot_step_index"): e.get("step_id") for e in events if e.get("bot_step_index") is not None}
    out = []
    for s in bot_steps:
        i = s["bot_step_index"]
        mood = s.get("player_mood")
        why = f"mood {mood}" if mood in QUOTE_MOODS else triggers.get(i)
        if not why or not s.get("thought"):
            continue
        out.append({"bot_step_index": i, "step_id": step_of.get(i), "sim_elapsed_sec": s.get("sim_elapsed_sec"),
                    "thought": s["thought"], "player_mood": mood, "observation_summary": s.get("observation_summary", ""),
                    "trigger": why})
    # Quotes near the stall carry the story; keep the latest ones.
    return out[-MAX_QUOTES:]


def _element_area(el: dict[str, Any]) -> Optional[float]:
    """Pixel area of a rendered target (`w`/`h`) or a drawn mask (`bbox`)."""
    if isinstance(el.get("w"), (int, float)) and isinstance(el.get("h"), (int, float)):
        return float(el["w"]) * float(el["h"])
    bbox = el.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4 \
            and all(isinstance(v, (int, float)) for v in bbox):
        return float(bbox[2]) * float(bbox[3])
    return None


def compute_visual_salience(targets: list[dict[str, Any]], masks: list[dict[str, Any]]) -> dict[str, Any]:
    """SAM-backed size comparison: the Research goal button vs the primary distractor.

    The distractor is the Woodcutter Hut card, or the feature button under test
    (`btn_feature_*`) when a feature studio run put one on screen. Rendered
    targets win over drawn masks for the same element, since only they carry
    `computed_salience`.
    """
    by_id: dict[str, dict[str, Any]] = {}
    for el in list(masks or []) + list(targets or []):
        if el.get("target_id"):
            by_id[el["target_id"]] = el
    goal_area = _element_area(by_id["btn_research"]) if "btn_research" in by_id else None
    goal_sal = by_id.get("btn_research", {}).get("computed_salience")
    distractor: Optional[str] = None
    if "card_woodcutter_hut" in by_id:
        distractor = "card_woodcutter_hut"
    else:
        features = sorted(t for t in by_id if t.startswith("btn_feature_"))
        distractor = features[0] if features else None
    dist_area = _element_area(by_id[distractor]) if distractor else None
    dist_sal = by_id.get(distractor, {}).get("computed_salience") if distractor else None
    ratio = round(dist_area / max(1.0, goal_area), 2) \
        if dist_area is not None and goal_area is not None else None
    return {"goal_target": "btn_research", "goal_area_px": goal_area, "goal_salience": goal_sal,
            "distractor_target": distractor, "distractor_area_px": dist_area,
            "distractor_salience": dist_sal, "distractor_to_goal_area_ratio": ratio}


def stub_diagnosis(summary: dict[str, Any], events: list[dict[str, Any]],
                   frame_targets: list[dict[str, Any]]) -> dict[str, Any]:
    where = summary.get("where_stuck")
    at = [e for e in events if e.get("step_id") == where]
    reasons = Counter(e["payload"].get("reason") for e in at if e["event_type"] == "action_rejected")
    clicks = Counter(e["payload"].get("target_id") for e in at if e["event_type"] == "click")
    research = next((t for t in frame_targets if t["target_id"] == "btn_research"), None)
    hypotheses = []
    if research and research.get("computed_salience") in ("low", "medium"):
        ratio = compute_visual_salience(frame_targets, []).get("distractor_to_goal_area_ratio")
        visual = f"; SAM visual area ratio (distractor/Research) is {ratio}x" if ratio is not None else ""
        hypotheses.append({"id": "low_research_salience", "confidence": 0.7, "evidence": (
            f"Research button salience is {research['computed_salience']}; the playtester opened research "
            f"{clicks.get('btn_research', 0)} times at {where}{visual}.")})
    wood_short = reasons.get("insufficient_wood", 0)
    built_woodcutter = any(e["event_type"] == "click" and e["payload"].get("target_id") == "card_woodcutter_hut"
                           and e["payload"].get("result") == "ui" for e in at)
    if wood_short or built_woodcutter:
        hypotheses.append({"id": "wood_shortfall", "confidence": 0.8, "evidence": (
            f"{wood_short} insufficient_wood rejections at {where}; optional Woodcutter Hut "
            f"{'was' if built_woodcutter else 'was not'} selected before the required tech.")})
    battles_lost = [e for e in events if e.get("event_type") == "battle_lost"]
    free_play_battles_lost = [e for e in battles_lost if e.get("step_id") == "free_play" or where == "free_play"]
    if free_play_battles_lost:
        stages = [e.get("payload", {}).get("stage_id") for e in free_play_battles_lost if e.get("payload", {}).get("stage_id")]
        stage_str = f" at {', '.join(sorted(set(stages)))}" if stages else ""
        hypotheses.append({"id": "combat_wall_underleveled_heroes", "confidence": 0.85, "evidence": (
            f"{len(free_play_battles_lost)} battle_lost event(s){stage_str} in free_play; squad power was "
            f"insufficient for combat encounters. Heroes need level-ups in Heroes Hall.")})
    if not hypotheses:
        hypotheses.append({"id": "unclear_next_step", "confidence": 0.4, "evidence": (
            f"{summary.get('stuck_events', 0)} stuck events at {where} without a dominant rejection reason.")})
    levers = []
    ids = {h["id"] for h in hypotheses}
    if "wood_shortfall" in ids:
        levers += ["lock_optional_builds_until_step", "starting_wood"]
    if "low_research_salience" in ids:
        levers += ["research_button_salience", "idle_hint_delay_sec"]
    if "combat_wall_underleveled_heroes" in ids:
        levers += ["starting_food", "forager_food_yield"]
    if not levers:
        levers = ["idle_hint_delay_sec"]
    names = {"low_research_salience": "low Research salience", "wood_shortfall": "a wood shortfall",
             "combat_wall_underleveled_heroes": "an under-leveled hero combat wall",
             "unclear_next_step": "an unclear next step"}
    text = " plus ".join(names[h["id"]] for h in hypotheses)
    return {"diagnosis": f"Players stall at {where}: {text}.", "hypotheses": hypotheses, "suggested_levers": levers}


def draw_stuck_frame(png: bytes, targets: list[dict[str, Any]]) -> tuple[bytes, list[dict[str, Any]]]:
    """Outline only the top 3 masks that explain the stall."""
    img = Image.open(io.BytesIO(png)).convert("RGB")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    by_id = {t["target_id"]: t for t in targets}
    focus = list(FOCUS_TARGETS)
    combat_recovery = [tid for tid in ("btn_defeat_heroes", "btn_hero_levelup", "btn_heroes", "btn_battle_continue") if tid in by_id]
    if "btn_defeat_heroes" in by_id or "btn_hero_levelup" in by_id:
        focus = combat_recovery[:3]
    else:
        features = sorted(t for t in by_id if t.startswith("btn_feature_"))
        if features:
            # The feature button under test displaces the Woodcutter card as the distractor to watch.
            focus = [features[0] if t == "card_woodcutter_hut" else t for t in focus]
    masks = []
    for rank, (tid, color) in enumerate(zip(focus, FOCUS_COLORS), start=1):
        t = by_id.get(tid)
        if not t:
            continue
        x, y, w, h = t["x"], t["y"], t["w"], t["h"]
        draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=(0, 0, 0), width=5)
        draw.rectangle([x - 3, y - 3, x + w + 3, y + h + 3], outline=color, width=3)
        label = f"{rank} {t.get('label') or tid}"[:28]
        tw = draw.textlength(label, font=font)
        ly = y - 18 if y >= 18 else y + h + 4
        draw.rectangle([x - 3, ly, x + tw + 5, ly + 14], fill=color)
        draw.text((x + 1, ly + 1), label, fill=(0, 0, 0), font=font)
        masks.append({"rank": rank, "target_id": tid, "bbox": [x, y, w, h], "label": t.get("label")})
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue(), masks


def analyze_run(run_id: str, *, runs_dir: Path, configs_dir: Path,
                client: Optional[MetaClient] = None) -> dict[str, Any]:
    run_dir = Path(runs_dir) / run_id
    cfg = AnalysisConfig.model_validate_json((Path(configs_dir) / "analysis_config.json").read_text())
    run = load_run(run_dir, cfg)
    summary, events = run["summary"], run["events"]
    where = summary.get("where_stuck")
    idx = stuck_bot_step(events, where)
    frame = run_dir / "frames" / f"step_{idx:03d}.png" if idx is not None else None
    meta = run_dir / "frames" / f"step_{idx:03d}.json" if idx is not None else None
    targets = json.loads(meta.read_text())["targets"] if meta and meta.exists() else []

    masks: list[dict[str, Any]] = []
    stuck_png = None
    if frame and frame.exists():
        png, masks = draw_stuck_frame(frame.read_bytes(), targets)
        stuck_png = run_dir / "stuck_frame.png"
        stuck_png.write_bytes(png)

    # Committed demo runs ship without frames/ to keep the repo small: re-analysis
    # must not wipe their visual evidence. Reuse the saved SAM masks and stuck frame.
    prior: dict[str, Any] = {}
    prior_path = run_dir / "analysis.json"
    if prior_path.exists():
        try:
            prior = json.loads(prior_path.read_text())
        except json.JSONDecodeError:
            prior = {}
    if not masks and isinstance(prior.get("sam_masks"), list) and prior["sam_masks"]:
        masks = prior["sam_masks"]
    stuck_frame_name = "stuck_frame.png" if (stuck_png or (run_dir / "stuck_frame.png").exists()) else None

    frame_targets = targets
    if not frame_targets and masks:
        # No fresh frame: rebuild the salience inputs from the preserved SAM masks.
        # Research salience comes from the run's own resolved config (the game sets
        # btn_research.computed_salience from that lever directly).
        resolved: dict[str, Any] = {}
        resolved_path = run_dir / "resolved_config.json"
        if resolved_path.exists():
            try:
                resolved = json.loads(resolved_path.read_text())
            except json.JSONDecodeError:
                resolved = {}
        frame_targets = []
        for m in masks:
            bbox = m.get("bbox") or []
            pseudo: dict[str, Any] = {"target_id": m.get("target_id")}
            if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                pseudo.update({"x": bbox[0], "y": bbox[1], "w": bbox[2], "h": bbox[3]})
            if m.get("target_id") == "btn_research" and resolved.get("research_button_salience"):
                pseudo["computed_salience"] = resolved["research_button_salience"]
            frame_targets.append(pseudo)

    stub = stub_diagnosis(summary, events, frame_targets)
    client = client or MetaClient(runs_dir=runs_dir, configs_dir=configs_dir)
    visual_salience = compute_visual_salience(frame_targets, masks)
    evidence = {"where_stuck": where, "stuck_events": summary.get("stuck_events"),
                "stuck_by_step": summary.get("stuck_by_step"), "action_rejected": summary.get("action_rejected"),
                "step_log": summary.get("step_log", [])[-25:], "stub_hypotheses": stub["hypotheses"],
                "visual_salience": visual_salience}
    reasoning = client.reason_json(ANALYST_SYSTEM, json.dumps(evidence), stub_result=stub, run_id=run_id)

    analysis = {
        "run_id": run_id,
        "analysis_version": cfg.analysis_version,
        "provider_mode": client.provider_mode,
        "where_stuck": where,
        "stuck_events": summary.get("stuck_events"),
        "stuck_by_step": summary.get("stuck_by_step"),
        "onboarding_completed": summary.get("onboarding_completed"),
        "first_achievement": summary.get("first_achievement"),
        "stuck_bot_step_index": idx,
        "stuck_frame": stuck_frame_name,
        "sam_masks": masks,
        "visual_salience": visual_salience,
        "diagnosis": reasoning.get("diagnosis", stub["diagnosis"]),
        "hypotheses": reasoning.get("hypotheses", stub["hypotheses"]),
        "suggested_levers": reasoning.get("suggested_levers", stub["suggested_levers"]),
        "playtester_quotes": playtester_quotes(events, run["bot_steps"]),
    }
    (run_dir / "analysis.json").write_text(json.dumps(analysis, indent=2) + "\n")
    return analysis
