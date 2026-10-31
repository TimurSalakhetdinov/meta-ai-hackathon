"""Meta model client: SAM 3.1 set-of-mark vision, Muse Spark playtester decisions,
Muse Image emblems, disk caches and the cost ledger with hard budget caps.

Provider modes (`META_PROVIDER` or the `provider_mode` argument):
- `stub`: no network. Marks come from the page's rendered targets and the
  decision from the in-page heuristic policy. For development and tests.
- `open_weights`: same prompt against an OpenAI-compatible open-weights endpoint.
- `meta`: SAM 3.1 and Muse Spark through the Meta API.

The API key is read from `.env` inside the app (python-dotenv) and never logged.
Endpoint URLs come from the environment (`META_API_BASE_URL`, `META_SAM_URL`,
`META_IMAGE_URL`, `OPEN_WEIGHTS_BASE_URL`), so the adapters stay swappable.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import io
import json
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

import httpx
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont

from .schemas import BudgetConfig, Persona

ROOT = Path(__file__).resolve().parents[1]
FRAME_W, FRAME_H = 960, 540
K_MARKS = 16
MIN_MARK_GAP_PX = 16
MIN_MARK_SIDE_PX = 10
# Masks covering more than this share of the frame are background (sea, island).
MAX_MARK_AREA_FRAC = 0.25
MOODS = ("engaged", "curious", "confused", "frustrated", "bored")
PROVIDER_MODES = ("stub", "open_weights", "meta")
BUCKET_ALIASES = {"playtester": "playtester_runs"}
SALIENCE_RANK = {"high_pulse": 4, "high": 3, "medium": 2, "low": 1}
MARK_COLORS = ((0, 229, 255), (255, 196, 0))


class BudgetCapExceededError(RuntimeError):
    """A live call would exceed the per-session, bucket or global cap."""


class CacheMissError(RuntimeError):
    """META_CACHE_ONLY=1 and the decision is not cached."""


def model_mode(model_id: str) -> str:
    return "contributor" if "contributor" in model_id else "standard"


def load_budget(configs_dir: Path = ROOT / "configs") -> BudgetConfig:
    return BudgetConfig.model_validate_json((Path(configs_dir) / "budget_config.json").read_text())


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def frame_phash(image_bytes: bytes) -> str:
    """64-bit average hash: 16x16 grayscale, pooled 2x2 to 8x8, one bit per cell above the mean."""
    img = Image.open(io.BytesIO(image_bytes)).convert("L").resize((16, 16), Image.Resampling.LANCZOS)
    px = list(img.getdata())
    cells = [
        sum(px[(2 * r + dr) * 16 + 2 * c + dc] for dr in (0, 1) for dc in (0, 1)) / 4
        for r in range(8) for c in range(8)
    ]
    mean = sum(cells) / len(cells)
    bits = "".join("1" if v > mean else "0" for v in cells)
    return f"{int(bits, 2):016x}"


# ------------------------------------------------------------------ results
@dataclass
class Mark:
    mark_id: int
    x: float
    y: float
    w: float
    h: float
    score: float = 1.0
    # Only set for marks derived from rendered targets (stub or assist); never sent to the model.
    target_id: Optional[str] = None
    # Player-visible label and tutorial-guide state from the rendered target.
    label: str = ""
    highlighted: bool = False
    locked: bool = False
    affordable: bool = True
    selected: bool = False
    done: bool = False

    @property
    def center(self) -> tuple[float, float]:
        return (round(self.x + self.w / 2, 1), round(self.y + self.h / 2, 1))


@dataclass
class SomResult:
    frame_phash: str
    marks: list[Mark]
    vision_mode: str
    cache_hit: bool
    latency_ms: float
    estimated_cost_usd: float = 0.0
    annotated_png: bytes = b""
    annotated_path: Optional[Path] = None
    clean_png: bytes = b""

    def mark(self, mark_id: Optional[int]) -> Optional[Mark]:
        return next((m for m in self.marks if m.mark_id == mark_id), None)


@dataclass
class MuseDecision:
    observation_summary: str
    thought: str
    action: str  # click_mark | click_xy | wait
    mark_id: Optional[int]
    xy: Optional[tuple[float, float]]
    target_id: Optional[str]
    player_mood: str
    cache_hit: bool
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int
    estimated_cost_usd: float
    model_id: str
    model_mode: str
    bucket: str
    cache_key: str
    extra: dict[str, Any] = field(default_factory=dict)


# ------------------------------------------------------------------- ledger
class CostLedger:
    """Append-only runs/cost_ledger.jsonl with caps checked under one lock.

    The lock is a thread lock plus an flock on a sidecar file, so worker
    threads and separate processes see a consistent total before charging.
    """

    _thread_locks: dict[str, threading.Lock] = {}
    _guard = threading.Lock()

    def __init__(self, path: Path, budget: BudgetConfig) -> None:
        self.path = Path(path)
        self.budget = budget
        with self._guard:
            self._tlock = self._thread_locks.setdefault(str(self.path.resolve()), threading.Lock())

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._tlock, open(self.path.with_suffix(".lock"), "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def entries(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text().splitlines() if line.strip()]

    def totals(self) -> dict[str, Any]:
        out: dict[str, Any] = {"global": 0.0, "buckets": {}, "runs": {}}
        for e in self.entries():
            cost = float(e.get("estimated_cost_usd") or 0.0)
            out["global"] += cost
            out["buckets"][e["bucket"]] = out["buckets"].get(e["bucket"], 0.0) + cost
            out["runs"][e["run_id"]] = out["runs"].get(e["run_id"], 0.0) + cost
        return out

    @staticmethod
    def bucket_name(bucket: str) -> str:
        return BUCKET_ALIASES.get(bucket, bucket)

    def _check(self, totals: dict[str, Any], run_id: str, bucket: str, cost: float, use_reserve: bool) -> None:
        if bucket not in self.budget.buckets_usd:
            raise BudgetCapExceededError(f"unknown budget bucket {bucket!r}")
        if bucket == "reserve" and not use_reserve:
            raise BudgetCapExceededError("the reserve bucket needs use_reserve=True (--use-reserve)")
        eps = 1e-9
        if totals["runs"].get(run_id, 0.0) + cost > self.budget.per_session_cap_usd + eps:
            raise BudgetCapExceededError(
                f"per-session cap ${self.budget.per_session_cap_usd:.2f} reached for run {run_id}")
        if totals["buckets"].get(bucket, 0.0) + cost > self.budget.buckets_usd[bucket] + eps:
            raise BudgetCapExceededError(f"bucket {bucket!r} cap ${self.budget.buckets_usd[bucket]:.2f} reached")
        if totals["global"] + cost > self.budget.global_stop_usd + eps:
            raise BudgetCapExceededError(f"global stop ${self.budget.global_stop_usd:.2f} reached")

    def charge(self, entry: dict[str, Any], *, use_reserve: bool = False) -> dict[str, Any]:
        """Check every cap and append the entry in one critical section."""
        line = self._normalize(entry)
        with self._locked():
            self._check(self.totals(), line["run_id"], line["bucket"], line["estimated_cost_usd"], use_reserve)
            self._append(line)
        return line

    def log(self, entry: dict[str, Any]) -> dict[str, Any]:
        """Append without a cap check: cache hits, stub calls and post-call settlements."""
        line = self._normalize(entry)
        with self._locked():
            self._append(line)
        return line

    def _normalize(self, entry: dict[str, Any]) -> dict[str, Any]:
        line = {
            "timestamp_iso": _now_iso(), "run_id": "dev", "bot_step_index": None, "provider_mode": "stub",
            "model_id": None, "model_mode": None, "bucket": "dev", "prompt_tokens": 0,
            "completion_tokens": 0, "images": 0, "cache_hit": False, "estimated_cost_usd": 0.0,
            "entry_type": "call", **entry,
        }
        line["bucket"] = self.bucket_name(line["bucket"])
        line["estimated_cost_usd"] = round(float(line["estimated_cost_usd"]), 8)
        return line

    def _append(self, line: dict[str, Any]) -> None:
        with self.path.open("a") as fh:
            fh.write(json.dumps(line) + "\n")


# ------------------------------------------------------------------- client
SYSTEM_PROMPT = """You are a playtester in a think-aloud usability study of a casual browser city-builder.
Stay in character as the persona below. You see the same 960x540 screen twice: first with
numbered regions, then clean. Interactive regions are numbered #1..#{k}.
Pick one numbered region to click, or wait if you would wait.
Think aloud in the first person: one sentence, maximum 10 words, in the persona's voice.

Persona: {persona}

Game literacy (what any kid picking up a game like this already knows; it is
not a walkthrough and never tells you the order to do quests in):
- A yellow pointing hand or finger, a glowing outline, or a pulsing highlight
  means "tap here": the game is teaching you. Following it is normal play.
  A mark tagged [tutorial guide] is that pointing-hand target. During
  onboarding, follow it first, before your own ideas.
- The advisor speech and the quest card name what you are trying to do right
  now; a ticked line is finished. Read the game's written instructions on
  screen before wandering, and do what they say.
- When a line tells you what the Elder just said, that is his spoken
  instruction: it matches the advisor text, so follow it the same way.
- Numbers along the top are your food, wood, stone and other supplies.
  Building cards show their price with the same icons; if you cannot afford
  one, you need more of that supply first.
- Research is how your tribe learns: each study in the Research tree costs
  supplies and research points (the flask number at the top), works at
  once, and unlocks buildings, upgrades or a new Age. A locked study names
  the study to learn first; follow that chain back. The quest card names
  the study you need, so match its words to a node name in the tree. A new
  Age is a study too: awakening an Age means researching that Age node
  once its chain is learned and you can pay its cost. Stone comes from a
  Stone Quarry; research points come from quest and campaign rewards.
- A building or tree with a floating icon above it is ready: tap it to collect.
- A greyed or locked card tells you what is missing under it: a named study
  means research that first, a supply means collect more of it.
- To build: tap a building card first. Only then can you place: tap a mark
  labelled "Empty ground: tap to place ... here". A see-through ghost of
  the building appears with a green tick and a red cross beside it: tap
  the green tick to confirm and really build it, the red cross cancels.
  Tapping empty ground before picking a card does nothing. A bar or
  countdown means work is in progress
  and takes a little time; a speed button makes time pass faster.
- When a Claim Reward button appears, the chapter is done and tapping it is
  the expected next move.
- Buttons along the bottom open Buildings, Heroes, Research and Campaign; an
  X in a corner closes a menu again.
- In a battle it is your turn when your fighter is lit up: tap a lit tile to
  move, tap an enemy next to you (or in range) to hit it, End Turn passes.
- If a tap seems to do nothing, something is usually unaffordable, locked, or
  a popup is waiting to be closed first. Look around before repeating it.

Answer with JSON only:
{{"observation_summary": "what stands out on screen",
  "thought": "first-person action note, maximum 10 words",
  "player_mood": "engaged|curious|confused|frustrated|bored",
  "action": "click_mark|wait",
  "mark_id": 3,
  "fallback_xy": [x, y]}}"""


class MetaClient:
    def __init__(
        self,
        *,
        runs_dir: Path = ROOT / "runs",
        configs_dir: Path = ROOT / "configs",
        provider_mode: Optional[str] = None,
        budget: Optional[BudgetConfig] = None,
        cache_only: Optional[bool] = None,
        use_reserve: bool = False,
        assist: bool = False,
        http: Optional[httpx.Client] = None,
    ) -> None:
        load_dotenv(ROOT / ".env", override=False)
        self.runs_dir = Path(runs_dir)
        self.budget = budget or load_budget(configs_dir)
        self.provider_mode = provider_mode or os.environ.get("META_PROVIDER", "stub")
        if self.provider_mode not in PROVIDER_MODES:
            raise ValueError(f"provider_mode must be one of {PROVIDER_MODES}")
        self.cache_only = os.environ.get("META_CACHE_ONLY") == "1" if cache_only is None else cache_only
        self.use_reserve = use_reserve
        self.assist = assist
        self.ledger = CostLedger(self.runs_dir / "cost_ledger.jsonl", self.budget)
        self._http = http
        self.sam_cache_dir = self.runs_dir / ".cache" / "sam"
        self.muse_cache_dir = self.runs_dir / ".cache" / "muse"

    @property
    def muse_model_id(self) -> str:
        return getattr(self, "_muse_model_override", None) or self.budget.muse_model_id

    @property
    def designer_model_id(self) -> str:
        return self.budget.designer_model_id

    def use_model(self, model_id: str) -> "MetaClient":
        """Run this client's bot decisions on another Muse model (menu choice:
        Muse Wonder instead of the default playtester model)."""
        self._muse_model_override = model_id
        return self

    @property
    def model_mode(self) -> str:
        return model_mode(self.muse_model_id)

    # ------------------------------------------------------------ pricing
    def _price(self, model_id: str, key: str) -> Optional[float]:
        if self.provider_mode != "meta":
            return 0.0  # stub and open-weights calls do not touch the Meta credits
        return (self.budget.pricing_usd.get(model_id) or {}).get(key)

    def muse_cost(self, prompt_tokens: int, completion_tokens: int, model_id: Optional[str] = None) -> float:
        model_id = model_id or self.muse_model_id
        pin = self._price(model_id, "input_per_1m") or 0.0
        pout = self._price(model_id, "output_per_1m") or 0.0
        return prompt_tokens * pin / 1e6 + completion_tokens * pout / 1e6

    def sam_cost(self) -> float:
        # SAM 3.1 always runs on the Meta API, also when Muse Spark is swapped for open weights.
        return (self.budget.pricing_usd.get(self.budget.sam_model_id) or {}).get("per_image") or 0.0

    # ------------------------------------------------------------ SAM + SoM
    def segment_and_mark(
        self,
        image_bytes: bytes,
        rendered_targets: Optional[list[dict[str, Any]]] = None,
        mode: Optional[str] = None,
        *,
        run_id: str = "dev",
        step_index: int = 0,
        bucket: str = "playtester",
        save: bool = True,
    ) -> SomResult:
        mode = mode or self.provider_mode
        t0 = time.perf_counter()
        phash = frame_phash(image_bytes)
        cost, cache_hit = 0.0, False
        if mode == "stub":
            # Stub boxes follow the live game state, so they are never cached by frame hash.
            boxes, vision_mode = self._boxes_from_targets(rendered_targets or []), "stub_targets"
        else:
            # v2: boxes carry the rendered target_id each SAM object maps to.
            cache = self.sam_cache_dir / f"{phash}_v4.json"
            if cache.exists():
                boxes, vision_mode, cache_hit = json.loads(cache.read_text()), "sam_3_1", True
                self.ledger.log({"run_id": run_id, "bot_step_index": step_index, "provider_mode": mode,
                                 "model_id": self.budget.sam_model_id, "model_mode": "standard",
                                 "bucket": bucket, "images": 0, "cache_hit": True})
            elif self.cache_only:
                raise CacheMissError(f"SAM frame {phash} not cached (META_CACHE_ONLY=1)")
            else:
                cost = self.sam_cost()
                self.ledger.charge({"run_id": run_id, "bot_step_index": step_index, "provider_mode": mode,
                                    "model_id": self.budget.sam_model_id, "model_mode": "standard",
                                    "bucket": bucket, "images": 1, "estimated_cost_usd": cost},
                                   use_reserve=self.use_reserve)
                try:
                    boxes, vision_mode = self._call_sam_api(image_bytes, rendered_targets), "sam_3_1"
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    cache.write_text(json.dumps(boxes))
                except Exception:
                    if not (self.assist and rendered_targets is not None):
                        raise
                    boxes, vision_mode = self._boxes_from_targets(rendered_targets), "debug_fallback"
        # Attach only player-visible semantics to SAM boxes. The model still
        # chooses from the screenshot; it is not given a quest solution.
        by_target = {t.get("target_id"): t for t in (rendered_targets or []) if t.get("target_id")}
        for b in boxes:
            target = by_target.get(b.get("target_id")) or {}
            b["label"] = str(target.get("label") or "")
            b["highlighted"] = bool(target.get("highlighted"))
            b["locked"] = bool(target.get("locked"))
            b["affordable"] = bool(target.get("affordable", True))
            b["selected"] = bool(target.get("selected"))
            b["done"] = bool(target.get("done"))
            if b["highlighted"]:
                b["score"] = max(float(b.get("score", 1.0)), 10.0)
        marks = select_marks(boxes)
        annotated = draw_marks(image_bytes, marks)
        path = None
        if save:
            path = self.runs_dir / run_id / "som_masks" / f"step_{step_index:03d}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(annotated)
        return SomResult(phash, marks, vision_mode, cache_hit, round((time.perf_counter() - t0) * 1000, 1),
                         cost, annotated, path, clean_png=image_bytes)

    @staticmethod
    def _boxes_from_targets(targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for t in targets:
            if not t.get("visible", True):
                continue
            score = SALIENCE_RANK.get(t.get("computed_salience"), 1) + (3 if t.get("highlighted") else 0) \
                + (1 if t.get("affordable", True) and not t.get("locked") else 0)
            out.append({"bbox": [t["x"], t["y"], t["w"], t["h"]], "score": float(score),
                        "target_id": t.get("target_id"), "label": str(t.get("label") or ""),
                        "highlighted": bool(t.get("highlighted")), "locked": bool(t.get("locked")),
                        "affordable": bool(t.get("affordable", True)), "selected": bool(t.get("selected")),
                        "done": bool(t.get("done"))})
        return out

    @staticmethod
    def _boxes_from_sam_text(text: str, target_ids: Optional[list[str]] = None) -> list[dict[str, Any]]:
        """Boxes out of SAM 3 output grammar: id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|>.

        The protocol reports each object under the id the request gave it, so
        record N maps back to prompt N (our rendered target N). Source x2/y2
        are inclusive, so width/height gain the final pixel."""
        out = []
        for m in re.finditer(r"(\d+)\s*<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)(?:;c=([\d.eE+-]+))?\|>", text or ""):
            oid = int(m.group(1))
            x1, y1, x2, y2 = (int(m.group(i)) for i in range(2, 6))
            box: dict[str, Any] = {"bbox": [x1, y1, x2 - x1 + 1, y2 - y1 + 1],
                                   "score": float(m.group(8)) if m.group(8) else 1.0}
            if target_ids and 1 <= oid <= len(target_ids):
                box["target_id"] = target_ids[oid - 1]
            out.append(box)
        return out

    @staticmethod
    def _sam_prompt_targets(targets: list[dict[str, Any]], limit: int = 16) -> list[dict[str, Any]]:
        """Targets SAM gets object prompts for, best first.

        SAM accepts a limited set of prompts. Interactive targets come
        first: a largest-first cut drowned them under 171 building pads,
        so the model never saw the buttons. The Buildings toggle always
        makes the cut, guided or not: it is the only way into the build
        menu, and a bot that cannot see it cannot build at all.
        """
        interactive = {"button", "build_card", "tech", "hud", "upgrade", "free_finish",
                       "worker", "placement", "battle_enemy", "battle_hero", "battle_hex"}
        visible = [t for t in targets if t.get("visible", True) and t.get("w") and t.get("h")]
        visible.sort(key=lambda t: (0 if t.get("highlighted") else 1,
                                    0 if t.get("target_id") == "btn_buildings_toggle" else 1,
                                    0 if t.get("kind") in interactive
                                    or (t.get("kind") == "pad" and t.get("affordable")) else 1,
                                    -SALIENCE_RANK.get(t.get("computed_salience"), 1),
                                    -(t["w"] * t["h"])))
        return visible[:limit]

    def _call_sam_api(self, image_bytes: bytes, targets: Optional[list[dict[str, Any]]] = None) -> list[dict[str, Any]]:
        """SAM 3.1 over the Responses API (streamed output_text grammar).

        With rendered targets we send one object prompt per target box, so SAM
        refines known UI elements; without them a generic phrase segments the
        whole frame. Returns [{bbox: [x, y, w, h], score}]."""
        base = os.environ.get("META_API_BASE_URL") or "https://api.meta.ai/v1"
        url = os.environ.get("META_SAM_URL") or (base.rstrip("/") + "/responses")
        with Image.open(io.BytesIO(image_bytes)) as im:
            w, h = im.size
        visible = self._sam_prompt_targets(targets or [])
        if visible:
            def box(t):
                x1 = max(0, min(w - 1, int(t['x'])))
                y1 = max(0, min(h - 1, int(t['y'])))
                x2 = max(x1, min(w - 1, int(t['x'] + t['w'] - 1)))
                y2 = max(y1, min(h - 1, int(t['y'] + t['h'] - 1)))
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                return (f"<|box;x1={x1};y1={y1};x2={x2};y2={y2};w={w};h={h}|>"
                        f"<|point;x={cx};y={cy};w={w};h={h}|>")
            prompt = "<0f>" + ",".join(f"{i + 1}{box(t)}" for i, t in enumerate(visible))
        else:
            prompt = "game interface element"
        payload = {
            "model": self.budget.sam_model_id, "stream": True,
            "metadata": {"include_confidence": "true"},
            "input": [{"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image",
                 "image_url": "data:image/png;base64," + base64.b64encode(image_bytes).decode()},
            ]}],
        }
        text_parts: list[str] = []
        with self._client().stream("POST", url, headers=self._auth(), json=payload) as resp:
            if resp.status_code >= 400:
                body = resp.read().decode(errors="replace")[:300]
                raise RuntimeError(f"SAM API {resp.status_code}: {body}")
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    ev = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if ev.get("type") == "response.output_text.delta" and ev.get("delta"):
                    text_parts.append(ev["delta"])
                elif ev.get("type") == "response.output_text.done" and ev.get("text"):
                    text_parts.append(ev["text"])
        return self._boxes_from_sam_text("".join(text_parts),
                                         [t.get("target_id") for t in visible])

    # ------------------------------------------------------- Muse Spark
    def cache_key(self, persona_id: str, phash: str, last_actions: list[Any]) -> str:
        blob = json.dumps([self.muse_model_id, persona_id, self.budget.prompt_version, phash, last_actions],
                          sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode()).hexdigest()

    def decide_action(
        self,
        *,
        som: SomResult,
        persona: Persona,
        last_actions: list[dict[str, Any]],
        run_id: str = "dev",
        step_index: int = 0,
        experiment_mode: bool = False,
        stub_decision: Optional[dict[str, Any]] = None,
        bucket: str = "playtester",
        sec_in_step: float = 0.0,
        scratchpad: Optional[dict[str, Any]] = None,
        heard: Optional[str] = None,
        visible_text: Optional[dict[str, str]] = None,
    ) -> MuseDecision:
        model_id, mode = self.muse_model_id, self.model_mode
        key = self.cache_key(persona.persona_id, som.frame_phash, last_actions)
        if heard:
            key = f"{key}_h{hashlib.sha256(heard.encode()).hexdigest()[:8]}"
        if visible_text:
            blob = json.dumps(visible_text, sort_keys=True)
            key = f"{key}_t{hashlib.sha256(blob.encode()).hexdigest()[:8]}"
        cache = self.muse_cache_dir / f"{key}.json"
        base = {"run_id": run_id, "bot_step_index": step_index, "provider_mode": self.provider_mode,
                "model_id": model_id, "model_mode": mode, "bucket": bucket}
        # Experiments never read the Muse cache: identical starts would share one decision.
        read_cache = self.cache_only or not experiment_mode or self.budget.muse_cache_in_experiments
        t0 = time.perf_counter()

        if read_cache and cache.exists():
            raw = json.loads(cache.read_text())
            self.ledger.log({**base, "cache_hit": True})
            return self._decision(raw, som, key, cache_hit=True, latency=_ms(t0), cost=0.0, bucket=bucket)
        if self.cache_only:
            raise CacheMissError(f"Muse decision {key[:12]} not cached (META_CACHE_ONLY=1)")

        if self.provider_mode == "stub":
            raw = stub_to_raw(stub_decision or {}, som)
            raw["usage"] = {"prompt_tokens": 0, "completion_tokens": 0}
            cost = 0.0
        else:
            est = self.muse_cost(self.budget.muse_est_input_tokens, self.budget.muse_max_output_tokens)
            self.ledger.charge({**base, "images": 1, "prompt_tokens": self.budget.muse_est_input_tokens,
                                "completion_tokens": self.budget.muse_max_output_tokens,
                                "estimated_cost_usd": est, "entry_type": "reservation"},
                               use_reserve=self.use_reserve)
            text, usage = self._call_muse_api(self._messages(som, persona, last_actions, sec_in_step,
                                                              scratchpad, heard, visible_text), structured=True)
            raw = parse_decision_json(text)
            raw["usage"] = usage
            cost = self.muse_cost(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0))
            # Settle the reservation to the real token count.
            self.ledger.log({**base, "prompt_tokens": usage.get("prompt_tokens", 0),
                             "completion_tokens": usage.get("completion_tokens", 0),
                             "estimated_cost_usd": cost - est, "entry_type": "settlement"})
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(raw))
        return self._decision(raw, som, key, cache_hit=False, latency=_ms(t0), cost=cost, bucket=bucket)

    def _decision(self, raw: dict[str, Any], som: SomResult, key: str, *, cache_hit: bool, latency: float,
                  cost: float, bucket: str) -> MuseDecision:
        mark = som.mark(raw.get("mark_id")) if raw.get("action") == "click_mark" else None
        xy: Optional[tuple[float, float]] = mark.center if mark else None
        action = "click_mark" if mark else raw.get("action", "wait")
        if not mark and raw.get("action") != "wait" and _valid_xy(raw.get("fallback_xy")):
            xy, action = (float(raw["fallback_xy"][0]), float(raw["fallback_xy"][1])), "click_xy"
        elif not mark:
            action = "wait"
        usage = raw.get("usage") or {}
        mood = raw.get("player_mood") if raw.get("player_mood") in MOODS else "engaged"
        return MuseDecision(
            observation_summary=str(raw.get("observation_summary", ""))[:400],
            thought=short_thought(raw.get("thought", "")),
            action=action, mark_id=mark.mark_id if mark else None, xy=xy,
            target_id=(mark.target_id if mark else raw.get("target_id")),
            player_mood=mood, cache_hit=cache_hit, latency_ms=latency,
            prompt_tokens=0 if cache_hit else int(usage.get("prompt_tokens", 0)),
            completion_tokens=0 if cache_hit else int(usage.get("completion_tokens", 0)),
            estimated_cost_usd=round(cost, 8), model_id=self.muse_model_id, model_mode=self.model_mode,
            bucket=CostLedger.bucket_name(bucket), cache_key=key,
        )

    def _messages(self, som: SomResult, persona: Persona, last_actions: list[dict[str, Any]],
                  sec_in_step: float, scratchpad: Optional[dict[str, Any]] = None,
                  heard: Optional[str] = None,
                  visible_text: Optional[dict[str, str]] = None) -> list[dict[str, Any]]:
        def tags(m: Mark) -> str:
            out = ""
            if m.highlighted:
                out += " [tutorial guide]"
            if m.locked:
                out += " [locked]"
            elif not m.affordable:
                out += " [not affordable yet]"
            if m.selected:
                out += " [selected]"
            if m.done:
                out += " [already researched]"
            return out
        marks = "; ".join(
            f"#{m.mark_id} {m.label or 'unlabeled'} at ({m.center[0]:.0f},{m.center[1]:.0f}) "
            f"size {m.w:.0f}x{m.h:.0f}" + tags(m)
            for m in som.marks)
        recent = "; ".join(a.get("summary", "") for a in last_actions[-3:]) or "none yet"
        text = (f"Marks: {marks or 'none'}.\nYour last actions: {recent}.\n"
                f"Seconds since the tutorial step changed: {sec_in_step:.0f}.")
        if visible_text:
            words = [f"{k}: {v}" for k, v in visible_text.items() if v]
            if words:
                text += "\nWords written on screen (read them like a player): " + " | ".join(words)
        if heard:
            text += f'\nYou just heard the Elder say: "{heard}"'
        if scratchpad:
            text += (f"\nWorking memory: step={scratchpad.get('current_step')}, "
                     f"steps_here={scratchpad.get('steps_in_current_stage', 0)}, "
                     f"last_mood={scratchpad.get('last_mood', 'engaged')}.")
        img = "data:image/png;base64," + base64.b64encode(som.annotated_png).decode()
        content: list[dict[str, Any]] = [{"type": "text", "text": text},
                                         {"type": "image_url", "image_url": {"url": img}}]
        if som.clean_png:
            clean = "data:image/png;base64," + base64.b64encode(som.clean_png).decode()
            content.append({"type": "image_url", "image_url": {"url": clean}})
        return [
            {"role": "system", "content": SYSTEM_PROMPT.format(k=K_MARKS, persona=persona.prompt)},
            {"role": "user", "content": content},
        ]

    # ------------------------------------------------------- voice (ASR)
    def transcribe_audio(self, audio_path: Path, *, run_id: str = "voice") -> str:
        """Muse Voice Transcribe on one Elder line; cached by file content.

        The endpoint wants WAV, so mp3 lines are converted once with the
        macOS `afconvert` (the dev machine has no ffmpeg). Returns the
        transcript text; stub mode and failures return "" so the bot simply
        hears nothing instead of the run crashing.
        """
        if self.provider_mode != "meta":
            return ""
        import subprocess
        data = Path(audio_path).read_bytes()
        key = hashlib.sha256(data).hexdigest()
        cache_dir = self.muse_cache_dir / "transcripts"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache = cache_dir / f"{key}.json"
        if cache.exists():
            return json.loads(cache.read_text()).get("transcript", "")
        wav = cache_dir / f"{key}.wav"
        if not wav.exists():
            conv = subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1",
                 str(audio_path), str(wav)], capture_output=True, text=True)
            if conv.returncode != 0:
                raise RuntimeError(f"afconvert failed for {audio_path.name}: {conv.stderr[:200]}")
        base = os.environ.get("META_API_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
        with wav.open("rb") as fh:
            resp = self._client().post(
                base + "/asr/transcribe", headers=self._auth(meta=True),
                files={"request": (None, json.dumps(
                    {"mode": "PUSH_TO_TALK", "model": "muse-voice-transcribe-1.0",
                     "audioEncoding": "WAV"}), "application/json"),
                    "audio": (wav.name, fh, "audio/wav")}, timeout=120)
        resp.raise_for_status()
        body = resp.json()
        text = (body.get("transcript") or "").strip()
        if not text and body.get("turns"):
            text = " ".join((t.get("transcript") or "").strip() for t in body["turns"]).strip()
        dur_ms = body.get("audioDurationMs") or 0
        self.ledger.log({"run_id": run_id, "provider_mode": "meta",
                         "model_id": "muse-voice-transcribe-1.0", "model_mode": "standard",
                         "bucket": "analysis", "entry_type": "call",
                         "estimated_cost_usd": round(dur_ms / 3600000 * 0.18, 8)})
        cache.write_text(json.dumps({"transcript": text, "audio": Path(audio_path).name,
                                     "duration_ms": dur_ms}))
        return text

    # Structured Outputs schema for one playtester decision (the API docs
    # prefer json_schema over the older json_object mode).
    DECISION_FORMAT = {
        "type": "json_schema",
        "json_schema": {
            "name": "playtester_decision", "strict": True,
            "schema": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "observation_summary": {"type": "string"},
                    "thought": {"type": "string"},
                    "player_mood": {"type": "string",
                                    "enum": ["engaged", "curious", "confused", "frustrated", "bored"]},
                    "action": {"type": "string", "enum": ["click_mark", "wait"]},
                    "mark_id": {"type": ["integer", "null"]},
                },
                "required": ["observation_summary", "thought", "player_mood", "action", "mark_id"],
            },
        },
    }

    def _call_muse_api(self, messages: list[dict[str, Any]], *, structured: bool = False,
                       model_id: Optional[str] = None) -> tuple[str, dict[str, int]]:
        """Chat completion per the Meta API reference. Returns (content, usage)."""
        if self.provider_mode == "open_weights":
            base, model = os.environ.get("OPEN_WEIGHTS_BASE_URL"), os.environ.get("OPEN_WEIGHTS_MODEL")
        else:
            base, model = os.environ.get("META_API_BASE_URL"), model_id or self.muse_model_id
        if not base:
            raise RuntimeError("API base URL is not set; use --mode stub or configure the endpoint in .env")
        resp = self._client().post(base.rstrip("/") + "/chat/completions",
                                   headers=self._auth(meta=self.provider_mode == "meta"), json={
            "model": model, "messages": messages,
            # max_completion_tokens counts reasoning too (max_tokens is deprecated).
            "max_completion_tokens": self.budget.muse_max_output_tokens,
            "response_format": self.DECISION_FORMAT if structured else {"type": "json_object"},
            # Without this the reasoning model can spend the whole output
            # budget thinking and return empty content (observed in hunts).
            "reasoning_effort": "low",
        })
        resp.raise_for_status()
        body = resp.json()
        usage = body.get("usage") or {}
        choice = (body.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        # Reasoning models sometimes leave content empty and put the answer
        # in reasoning_content; either way the caller gets text or "".
        content = msg.get("content") or msg.get("reasoning_content") or choice.get("text") or ""
        return content, {
            "prompt_tokens": int(usage.get("prompt_tokens", 0)),
            "completion_tokens": int(usage.get("completion_tokens", 0)),
        }

    def reason_json(self, system: str, user: str, *, stub_result: dict[str, Any], run_id: str = "agents",
                    bucket: str = "analysis", model_id: Optional[str] = None) -> dict[str, Any]:
        """Text-only Muse JSON reasoning for the analyst, designer and feature studio.

        Stub mode returns `stub_result` unchanged. Live results are cached by prompt.
        The designer passes `model_id=client.designer_model_id` (Muse Wonder);
        analyst and playtester reasoning stay on the playtester model.
        """
        model_id = model_id or self.muse_model_id
        mode = model_mode(model_id)
        if self.provider_mode == "stub":
            self.ledger.log({"run_id": run_id, "provider_mode": "stub", "model_id": model_id,
                             "model_mode": mode, "bucket": bucket})
            return stub_result
        key = hashlib.sha256(json.dumps([model_id, system, user]).encode()).hexdigest()
        cache = self.muse_cache_dir / f"reason_{key}.json"
        base = {"run_id": run_id, "provider_mode": self.provider_mode, "model_id": model_id,
                "model_mode": mode, "bucket": bucket}
        if cache.exists():
            self.ledger.log({**base, "cache_hit": True})
            return json.loads(cache.read_text())
        if self.cache_only:
            raise CacheMissError(f"Muse reasoning {key[:12]} not cached (META_CACHE_ONLY=1)")
        est = self.muse_cost(self.budget.muse_est_input_tokens, self.budget.muse_max_output_tokens, model_id)
        self.ledger.charge({**base, "estimated_cost_usd": est, "entry_type": "reservation"},
                           use_reserve=self.use_reserve)
        text, usage = self._call_muse_api([{"role": "system", "content": system},
                                           {"role": "user", "content": user}], model_id=model_id)
        self.ledger.log({**base, **usage, "estimated_cost_usd": self.muse_cost(
            usage["prompt_tokens"], usage["completion_tokens"], model_id) - est, "entry_type": "settlement"})
        result = parse_decision_json(text)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result))
        return result

    # ------------------------------------------------------- Muse Image
    def generate_ui_emblem(self, prompt: str, out_path: Path, bucket: str = "reserve",
                           run_id: str = "designer") -> Path:
        """High-salience Research emblem for a Variant B proposal. Stub mode draws one locally."""
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        base = {"run_id": run_id, "provider_mode": self.provider_mode, "model_id": "muse-image-1.0",
                "model_mode": "standard", "bucket": bucket, "images": 1}
        if self.provider_mode != "meta":
            out_path.write_bytes(_procedural_emblem(prompt))
            self.ledger.log(base)
            return out_path
        price = self._price("muse-image", "per_image")
        if price is None:
            raise RuntimeError("muse-image price is not set in budget_config.json pricing_usd")
        self.ledger.charge({**base, "estimated_cost_usd": price}, use_reserve=self.use_reserve)
        out_path.write_bytes(self._call_image_api(prompt))
        return out_path

    def generate_image(self, prompt: str, *, size: str = "1024x1024", bucket: str = "dev",
                       run_id: str = "sprites") -> bytes:
        """Muse Image call for game art, cached by prompt and size. Needs provider_mode 'meta'."""
        if self.provider_mode != "meta":
            raise RuntimeError("Muse Image needs META_PROVIDER=meta and META_API_KEY in .env")
        key = hashlib.sha256(json.dumps(["muse-image-1.0", prompt, size]).encode()).hexdigest()
        cache = self.runs_dir / ".cache" / "muse_image" / f"{key}.png"
        base = {"run_id": run_id, "provider_mode": self.provider_mode, "model_id": "muse-image-1.0",
                "model_mode": "standard", "bucket": bucket}
        if cache.exists():
            self.ledger.log({**base, "images": 0, "cache_hit": True})
            return cache.read_bytes()
        if self.cache_only:
            raise CacheMissError(f"Muse Image {key[:12]} not cached (META_CACHE_ONLY=1)")
        price = self._price("muse-image", "per_image")
        if price is None:
            raise RuntimeError("muse-image price is not set in budget_config.json pricing_usd")
        self.ledger.charge({**base, "images": 1, "estimated_cost_usd": price}, use_reserve=self.use_reserve)
        data = self._call_image_api(prompt, size)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(data)
        return data

    def sam_boxes(self, image_bytes: bytes, *, bucket: str = "dev", run_id: str = "sprites") -> list[dict[str, Any]]:
        """SAM 3.1 boxes for one image, cached by frame hash. Needs provider_mode 'meta'."""
        if self.provider_mode != "meta":
            raise RuntimeError("SAM 3.1 needs META_PROVIDER=meta and META_API_KEY in .env")
        # Exact content hash: similar sprites would collide under the perceptual frame hash.
        cache = self.sam_cache_dir / f"img_{hashlib.sha256(image_bytes).hexdigest()}.json"
        base = {"run_id": run_id, "provider_mode": self.provider_mode, "model_id": self.budget.sam_model_id,
                "model_mode": "standard", "bucket": bucket}
        if cache.exists():
            self.ledger.log({**base, "images": 0, "cache_hit": True})
            return json.loads(cache.read_text())
        if self.cache_only:
            raise CacheMissError(f"SAM frame {cache.stem} not cached (META_CACHE_ONLY=1)")
        self.ledger.charge({**base, "images": 1, "estimated_cost_usd": self.sam_cost()}, use_reserve=self.use_reserve)
        boxes = self._call_sam_api(image_bytes)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(boxes))
        return boxes

    def _call_image_api(self, prompt: str, size: str = "256x256") -> bytes:
        url = os.environ.get("META_IMAGE_URL") or "https://api.meta.ai/v1/images/generations"
        resp = self._client().post(url, headers=self._auth(), json={"model": "muse-image-1.0", "prompt": prompt,
                                                                    "size": size})
        resp.raise_for_status()
        return base64.b64decode(resp.json()["data"][0]["b64_json"])

    # ------------------------------------------------------------ http
    def _client(self) -> httpx.Client:
        self._http = self._http or httpx.Client(timeout=60)
        return self._http

    def _auth(self, meta: bool = True) -> dict[str, str]:
        # The Meta key never goes to the open-weights host.
        key = os.environ.get("META_API_KEY" if meta else "OPEN_WEIGHTS_API_KEY")
        if not key:
            raise RuntimeError("API key missing: put it in .env (never export it in the shell)")
        return {"Authorization": f"Bearer {key}"}


# ------------------------------------------------------------ helpers
def short_thought(text: Any, max_words: int = 10) -> str:
    """Keep spoken/displayed think-aloud to one short action note."""
    words = str(text or "").split()
    if len(words) <= max_words:
        return " ".join(words)[:200]
    return " ".join(words[:max_words]).rstrip(".,;:") + "…"


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def _valid_xy(xy: Any) -> bool:
    return (isinstance(xy, (list, tuple)) and len(xy) == 2 and all(isinstance(v, (int, float)) for v in xy)
            and 0 <= xy[0] < FRAME_W and 0 <= xy[1] < FRAME_H)


def select_marks(boxes: list[dict[str, Any]], k: int = K_MARKS) -> list[Mark]:
    """Drop tiny and background masks, keep centres >= 16 px apart, keep the top k by score."""
    frame_area = FRAME_W * FRAME_H
    kept: list[Mark] = []
    for b in sorted(boxes, key=lambda b: -float(b.get("score", 1.0))):
        x, y, w, h = (float(v) for v in b["bbox"])
        x, y = max(0.0, x), max(0.0, y)
        w, h = min(w, FRAME_W - x), min(h, FRAME_H - y)
        if w < MIN_MARK_SIDE_PX or h < MIN_MARK_SIDE_PX or w * h > MAX_MARK_AREA_FRAC * frame_area:
            continue
        cx, cy = x + w / 2, y + h / 2
        if any(math.dist((cx, cy), m.center) < MIN_MARK_GAP_PX for m in kept):
            continue
        # SAM can report one object twice; the first (best score) wins.
        if b.get("target_id") and any(m.target_id == b["target_id"] for m in kept):
            continue
        kept.append(Mark(len(kept) + 1, round(x, 1), round(y, 1), round(w, 1), round(h, 1),
                         float(b.get("score", 1.0)), b.get("target_id"),
                         str(b.get("label") or ""), bool(b.get("highlighted")),
                         bool(b.get("locked")), bool(b.get("affordable", True)),
                         bool(b.get("selected")), bool(b.get("done"))))
        if len(kept) == k:
            break
    return kept


def draw_marks(image_bytes: bytes, marks: list[Mark]) -> bytes:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    draw = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    for m in marks:
        color = MARK_COLORS[(m.mark_id - 1) % 2]
        draw.rectangle([m.x, m.y, m.x + m.w, m.y + m.h], outline=(0, 0, 0), width=4)
        draw.rectangle([m.x, m.y, m.x + m.w, m.y + m.h], outline=color, width=2)
        label = f"#{m.mark_id}"
        tw = draw.textlength(label, font=font)
        px, py = max(0, m.x), max(0, m.y - 14)
        draw.rounded_rectangle([px, py, px + tw + 8, py + 14], radius=5, fill=color, outline=(0, 0, 0))
        draw.text((px + 4, py + 1), label, fill=(0, 0, 0), font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def parse_decision_json(text: Optional[str]) -> dict[str, Any]:
    """Tolerates code fences or prose around the JSON object. A model reply
    with no content at all becomes a wait, never a crash."""
    text = text or ""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return {"action": "wait", "thought": text.strip()[:200], "observation_summary": ""}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"action": "wait", "thought": text.strip()[:200], "observation_summary": ""}


_STUB_MOODS = (
    ("not sure", "confused"), ("even though", "frustrated"), ("nothing in the tech tree", "frustrated"),
    ("longer", "bored"), ("save up", "engaged"), ("winnable", "curious"), ("new", "curious"),
)


def stub_to_raw(stub: dict[str, Any], som: SomResult) -> dict[str, Any]:
    """Map the in-page heuristic choice to the same raw shape Muse Spark returns."""
    thought = stub.get("thought") or "Not sure what to do next."
    mood = stub.get("mood") if stub.get("mood") in MOODS else next(
        (m for k, m in _STUB_MOODS if k in thought.lower()), "engaged")
    target_id = stub.get("target_id")
    mark = next((m for m in som.marks if target_id and m.target_id == target_id), None)
    raw: dict[str, Any] = {
        "observation_summary": f"{len(som.marks)} marked regions on screen",
        "thought": thought, "player_mood": mood, "target_id": target_id,
    }
    if mark:
        raw.update(action="click_mark", mark_id=mark.mark_id)
    elif target_id and stub.get("xy"):
        raw.update(action="click_xy", fallback_xy=list(stub["xy"]))
    else:
        raw.update(action="wait")
    return raw


_EMBLEM_MOTIFS = (("sword", "swords"), ("shield", "swords"), ("camel", "coin"), ("merchant", "coin"),
                  ("bonfire", "flame"), ("fire", "flame"), ("crown", "crown"), ("tax", "crown"))


def _procedural_emblem(prompt: str = "") -> bytes:
    """Gold medallion with a motif picked from the prompt; the rim hue is seeded by the prompt text."""
    text = prompt.lower()
    motif = next((m for k, m in _EMBLEM_MOTIFS if k in text), "rune")
    hue = int(hashlib.sha256(text.encode()).hexdigest()[:2], 16)
    ink, cream = (90, 50, 10, 255), (255, 250, 230, 255)
    img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([4, 4, 124, 124], fill=(255, 196, 0, 255), outline=ink, width=6)
    d.ellipse([16, 16, 112, 112], fill=(120 + hue // 4, 70 + hue // 8, 40, 255), outline=ink, width=3)
    if motif == "swords":
        d.line([(36, 36), (92, 92)], fill=cream, width=9)
        d.line([(92, 36), (36, 92)], fill=cream, width=9)
        d.line([(28, 80), (48, 100)], fill=ink, width=6)
        d.line([(100, 80), (80, 100)], fill=ink, width=6)
    elif motif == "coin":
        d.ellipse([36, 36, 92, 92], fill=(255, 220, 90, 255), outline=ink, width=4)
        d.rectangle([58, 46, 70, 82], fill=ink)
    elif motif == "flame":
        d.polygon([(64, 26), (90, 76), (78, 98), (50, 98), (38, 76)], fill=(255, 120, 30, 255), outline=ink)
        d.polygon([(64, 52), (76, 82), (52, 82)], fill=(255, 230, 120, 255))
    elif motif == "crown":
        d.polygon([(32, 88), (32, 46), (48, 66), (64, 38), (80, 66), (96, 46), (96, 88)], fill=(255, 220, 90, 255),
                  outline=ink)
    else:
        d.polygon([(64, 22), (98, 98), (30, 98)], fill=cream, outline=ink)
        d.ellipse([54, 60, 74, 80], fill=(0, 229, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def decision_record(d: MuseDecision, som: SomResult) -> dict[str, Any]:
    """BotStepRecord fields from one SoM + decision pair."""
    return {
        "model_id": d.model_id, "model_mode": d.model_mode, "vision_mode": som.vision_mode,
        "frame_phash": som.frame_phash, "sam_cache_hit": som.cache_hit if som.vision_mode == "sam_3_1" else None,
        "sam_marks_count": len(som.marks), "sam_latency_ms": som.latency_ms,
        "muse_cache_hit": d.cache_hit, "muse_latency_ms": d.latency_ms,
        "prompt_tokens": d.prompt_tokens, "completion_tokens": d.completion_tokens,
        "estimated_cost_usd": round(d.estimated_cost_usd + som.estimated_cost_usd, 8), "bucket": d.bucket,
        "observation_summary": d.observation_summary, "thought": d.thought, "chosen_mark_id": d.mark_id,
        "target_id": d.target_id, "target_xy": d.xy, "player_mood": d.player_mood,
    }


__all__ = [
    "BudgetCapExceededError", "CacheMissError", "CostLedger", "Mark", "MetaClient", "MuseDecision",
    "SomResult", "decision_record", "frame_phash", "load_budget", "model_mode", "select_marks",
]
