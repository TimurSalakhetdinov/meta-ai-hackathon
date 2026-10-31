"""Generate the eight per-stage arena backgrounds with Muse Image.

Prompts reviewed externally (arena-background-prompts.md): one backdrop per
campaign stage, matching where the node sits on the province map, with the
center kept as flat empty dirt for the hex field and units.

Usage:
    .venv/bin/python scripts/generate_arena_backgrounds.py [--only 3] [--force]
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPRITES = ROOT / "frontend" / "static" / "assets" / "sprites"

SHARED = ("Wide 16:9, painted storybook Celtic strategy backdrop, elevated 2.5D view, "
          "soft daylight from upper left. Flat, empty, evenly lit ochre dirt fills central "
          "foreground, two-thirds of frame. Scenery confined to perimeter and background. "
          "No figures, animals, lettering, UI, hexes. ")

PROMPTS: dict[int, str] = {
    1: SHARED + "Turquoise river behind clearing, small stone bridge far left, lush meadows, pines, distant water mist.",
    2: SHARED + "Bright meadow rimmed with birches, pines and tiny flowers; turquoise river bend behind; fallen logs at outer edges.",
    3: SHARED + "A ring of tall mossy standing stones stands along the rear edge in the upper third of the frame, clearly visible; green hills and pines behind them, golden cobbled path along the far side.",
    4: SHARED + "Broken mossy stone arch behind clearing, tall pines between grey cliffs, distant waterfall; cool shaded background.",
    5: SHARED + "Honey-coloured quarry terraces behind clearing, cut stone steps, sparse grass; boulders and weathered bones at outer edges.",
    6: SHARED + "Layered sandstone cliffs behind clearing, golden path along distant ledge, large weathered animal skull at far right.",
    7: SHARED + "Black obsidian spires frame clearing; distant golden stone path, thin lava seams at outer edges, faint background smoke.",
    8: SHARED + "In the background center stands a giant skull rock formation forming a cave entrance, hollow eye sockets glowing amber, black cliff rock around it, thin lava seams at its base, shallow stream at far left.",
}


def to_wide(raw: bytes) -> Image.Image:
    """Crop to 16:9 keeping the top of the frame, where the rear scenery
    lives; the dirt foreground survives at the bottom."""
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    target = 16 / 9
    if w / h > target:
        nw = int(h * target)
        img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = int(w / target)
        img = img.crop((0, 0, w, nh))
    return img.resize((1440, 810))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    from backend.meta_client import MetaClient

    client = MetaClient(runs_dir=ROOT / "runs", configs_dir=ROOT / "configs", provider_mode="meta")
    stages = [args.only] if args.only else list(PROMPTS)
    done = skipped = failed = 0
    for n in stages:
        out = SPRITES / f"arena_bg_stage_{n}.jpg"
        if out.exists() and not args.force:
            print(f"skip stage {n} (exists)", flush=True)
            skipped += 1
            continue
        try:
            raw = client.generate_image(PROMPTS[n], size="1024x1024", run_id="arena_backgrounds")
            to_wide(raw).save(out, quality=88)
            print(f"ok   stage {n}", flush=True)
            done += 1
        except Exception as exc:
            print(f"FAIL stage {n}: {exc}", flush=True)
            failed += 1
    print(f"generated {done}, skipped {skipped}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
