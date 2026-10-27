"""Offline fakes for the Meta adapters. Tests never reach the network or spend credits."""

from __future__ import annotations

import io
import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from backend.meta_client import MetaClient
from backend.schemas import Persona

ROOT = Path(__file__).resolve().parents[1]

SAM_BOXES = [
    {"bbox": [900, 490, 50, 40], "score": 0.97},
    {"bbox": [200, 450, 80, 76], "score": 0.91},
    {"bbox": [300, 450, 80, 76], "score": 0.88},
    {"bbox": [230, 5, 70, 28], "score": 0.8},
]


def frame_png(shade: int = 90) -> bytes:
    img = Image.new("RGB", (960, 540), (shade, 120, 70))
    d = ImageDraw.Draw(img)
    d.rectangle([900, 490, 950, 530], fill=(220, 200, 80))
    d.rectangle([200, 450, 280, 526], fill=(40, 40, 160))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


def persona(persona_id: str = "impatient_newcomer") -> Persona:
    rows = json.loads((ROOT / "configs" / "personas.json").read_text())
    return Persona.model_validate(next(r for r in rows if r["persona_id"] == persona_id))


def copy_configs(tmp: Path) -> Path:
    dst = tmp / "configs"
    shutil.copytree(ROOT / "configs", dst, ignore=shutil.ignore_patterns("audit_log.jsonl"))
    return dst


class FakeMeta:
    """Patches the HTTP adapters of one MetaClient and counts calls."""

    def __init__(self, monkeypatch: Any, client: MetaClient) -> None:
        self.sam_calls = 0
        self.muse_calls = 0
        self.client = client

        def sam(image_bytes: bytes) -> list[dict[str, Any]]:
            self.sam_calls += 1
            return [dict(b) for b in SAM_BOXES]

        def muse(messages: list[dict[str, Any]]) -> tuple[str, dict[str, int]]:
            self.muse_calls += 1
            body = {"observation_summary": "Research glows bottom right", "thought": "I will try the glowing button.",
                    "player_mood": "curious", "action": "click_mark", "mark_id": 1, "fallback_xy": [925, 510]}
            return json.dumps(body), {"prompt_tokens": 2000, "completion_tokens": 300}

        monkeypatch.setattr(client, "_call_sam_api", sam)
        monkeypatch.setattr(client, "_call_muse_api", muse)


def meta_client(tmp: Path, monkeypatch: Any, *, configs_dir: Path | None = None, **kw: Any) -> tuple[MetaClient, FakeMeta]:
    monkeypatch.delenv("META_CACHE_ONLY", raising=False)
    kw.setdefault("provider_mode", "meta")
    client = MetaClient(runs_dir=tmp / "runs", configs_dir=configs_dir or ROOT / "configs", **kw)
    return client, FakeMeta(monkeypatch, client)
