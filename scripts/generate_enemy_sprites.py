"""Generate the ten Otherworld guardian sprites with Muse Image and cut them out.

Prompts are the approved guardian descriptions (inspired by Irish and
Scottish folklore). Each image
comes back on a plain cream background; a border flood-fill turns that
background transparent and the result is cropped to the figure. Existing
sprites are skipped, so a rerun only pays for what is missing.

Usage:
    .venv/bin/python scripts/generate_enemy_sprites.py [--only enemy_ash_clubman] [--force]
"""

from __future__ import annotations

import argparse
import io
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPRITES = ROOT / "frontend" / "static" / "assets" / "sprites"

BASE = "One human, full-body side view facing left, plain cream background, cozy painted style; "

PROMPTS: dict[str, str] = {
    "enemy_marshlight": "One magical marsh spirit, full-body side view facing left, plain cream background, cozy painted storybook style; a drifting lantern-like wisp of cold green light with a soft trailing glow, no face, no fireball, no text.",
    "enemy_mound_sentinel": "One elegant fairy mound guardian, full-body side view facing left, plain cream background, cozy painted storybook style; tall uncanny sentinel in bronze leaf-shaped armour with a moss-green mantle, holding a long slender blade low, calm and still, no helmet horns.",
    "enemy_hawthorn": "One walking hawthorn tree guardian, full-body side view facing left, plain cream background, cozy painted storybook style; twisted pale trunk body, crown of white blossoms, red berries, root legs and branch arms, gentle guardian face in the bark.",
    "enemy_selkie": "One selkie mistweaver, full-body side view facing left, plain cream background, cozy painted storybook style; graceful figure in a sleek dark sealskin mantle, wet silver hair, dark kind eyes, holding a small mist orb, calm healer, no staff.",
    "enemy_cu_sith": "One huge fairy hound, full-body side view facing left, plain cream background, cozy painted storybook style; shaggy dark green dog the size of a calf, sweeping plumed tail, kind dark eyes, alert stance, no collar, no glowing monster parts.",
    "enemy_bean_si": "One elegant bean si omen-bearer, full-body side view facing left, plain cream background, cozy painted storybook style; tall pale spirit woman with long silver hair and a soft grey-green mantle, mournful gentle expression, hands folded, no weapon, no screaming.",
    "enemy_ogham_warden": "One ogham stone warden, full-body side view facing left, plain cream background, cozy painted storybook style; a single tall leaning standing stone with carved ogham rune strokes along one edge, moss at its base, two simple stone arms, ancient and still, no face.",
    "enemy_omen_crow": "One oversized omen crow, full-body side view facing left, plain cream background, cozy painted storybook style; large glossy black crow with wings half spread, bright intelligent eye, a few grey feathers, perched stance ready to fly, no rider.",
    "enemy_kelpie": "One majestic kelpie water horse, full-body side view facing left, plain cream background, cozy painted storybook style; glossy dark horse with riverweed in its wet mane, droplets on its coat, uncanny gentle eyes, standing proudly, no rider, no ghost transparency.",
    "enemy_puca": "One puca shapeshifter spirit, full-body side view facing left, plain cream background, cozy painted storybook style; sturdy goat-like creature with long hare ears and dark shaggy fur, mischievous golden eyes, playful stance, no horns like a demon, no human parts.",
}


def cutout(raw: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_bg(x: int, y: int) -> bool:
        r, g, b, _ = px[x, y]
        return (0.299 * r + 0.587 * g + 0.114 * b) > 175 and (max(r, g, b) - min(r, g, b)) < 70

    seen = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        queue.append((x, 0)); queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y)); queue.append((w - 1, y))
    while queue:
        x, y = queue.popleft()
        i = y * w + x
        if seen[i] or not is_bg(x, y):
            continue
        seen[i] = 1
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        if x: queue.append((x - 1, y))
        if x < w - 1: queue.append((x + 1, y))
        if y: queue.append((x, y - 1))
        if y < h - 1: queue.append((x, y + 1))
    bbox = img.getchannel("A").getbbox()
    if bbox:
        pad = 8
        box = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
               min(w, bbox[2] + pad), min(h, bbox[3] + pad))
        img = img.crop(box)
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    from backend.meta_client import MetaClient

    client = MetaClient(runs_dir=ROOT / "runs", configs_dir=ROOT / "configs", provider_mode="meta")
    names = [args.only] if args.only else list(PROMPTS)
    done = skipped = failed = 0
    for name in names:
        out = SPRITES / f"{name}.png"
        if out.exists() and not args.force:
            print(f"skip {name} (exists)", flush=True)
            skipped += 1
            continue
        try:
            raw = client.generate_image(PROMPTS[name], size="1024x1024", run_id="enemy_sprites")
            img = cutout(raw)
            img.save(out)
            print(f"ok   {name} {img.size[0]}x{img.size[1]}", flush=True)
            done += 1
        except Exception as exc:  # keep going: one bad prompt must not lose the batch
            print(f"FAIL {name}: {exc}", flush=True)
            failed += 1
    print(f"generated {done}, skipped {skipped}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
