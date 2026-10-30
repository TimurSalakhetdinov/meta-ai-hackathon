"""Generate the 27 rival-clan enemy sprites with Muse Image and cut them out.

Prompts are the visual descriptions from the Astra enemy roster. Each image
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
    "enemy_ash_clubman": BASE + "stocky, shaved head, clean-shaven, wearing an ochre tunic and charcoal trousers, holding a short oak club low, no shield.",
    "enemy_reed_slinger": BASE + "slender, short auburn curls, wearing a sage shirt and beige knee wraps, holding an extended leather sling, large pebble pouch at hip.",
    "enemy_birch_knifer": BASE + "wiry, cropped chestnut hair, wearing a cream sleeveless tunic and rust sash, holding a short seax beside the thigh, leaning forward, no cloak.",
    "enemy_flint_axeman": BASE + "broad shoulders, bald crown and thick sideburns, wearing a brick-red coat and tan leggings, holding an iron hand axe, empty off hand.",
    "enemy_moss_bowhand": BASE + "compact figure, hair hidden by an olive hood, wearing a mustard tunic, holding a short wooden bow at half draw, small quiver, no cloak.",
    "enemy_oak_doorward": BASE + "heavyset, square clean-shaven jaw, wearing an umber padded vest over cream sleeves, holding a tall rectangular plank shield and low seax, bare head.",
    "enemy_thorn_runner": BASE + "long-legged, short black hair swept back, wearing a teal short tunic and brown leg wraps, holding a light javelin overhead, no shield or fur.",
    "enemy_reed_herbkeeper": BASE + "older, grey hair in a compact bun, wearing a dusty rose apron over an oatmeal robe, holding a wooden salve bowl and linen bandage, sheathed belt knife, no staff.",
    "enemy_flint_hookman": BASE + "tall and lean, narrow moustache, close-fitting leather cap, wearing slate and ochre, holding a long hooked axe diagonally with both hands, no shield.",
    "enemy_ash_drumhand": BASE + "sturdy, short sandy hair, wearing terracotta and charcoal, holding a wooden beater over a waist-slung hide drum, sheathed seax, no helmet.",
    "enemy_frost_guard": BASE + "broad, clean-shaven, wearing a rounded iron cap and pale blue quilted coat, holding a plain oval iron-grey shield and short sword, no fur or braids.",
    "enemy_cinder_dartman": BASE + "narrow shoulders, short greying hair, wearing a saffron vest over burgundy sleeves, holding a heavy throwing dart with more in a leather hip case, no fire effects.",
    "enemy_boar_cleaver": BASE + "muscular, cropped fair hair and short unbraided beard, wearing plum and brown, holding a broad iron axe across the body, brass boar clasp, no animal headgear.",
    "enemy_gale_scout": BASE + "athletic, short dark curls beneath a cream headband, wearing sea-green and cream, holding paired short seaxes in a low running stance, no cloak.",
    "enemy_thorn_longbow": BASE + "very tall and thin, hood up, wearing chestnut and muted yellow, holding a long wooden bow upright with an arrow nocked, back quiver, narrow silhouette.",
    "enemy_tusk_shieldwall": BASE + "squat and powerful, wearing a plain dull bronze helmet and deep red coat, holding a broad cream oval shield marked with a red tusk and a short iron axe.",
    "enemy_tusk_spearcast": BASE + "lean, shaved head and small moustache, wearing sand and crimson, holding a heavy throwing spear at shoulder height with spares in the other hand, no shield.",
    "enemy_raven_standard": BASE + "upright, straight chin-length silver hair, wearing an indigo long coat and cream scarf, holding a tall forked cream banner with an indigo raven emblem, sword sheathed.",
    "enemy_iron_swordsman": BASE + "medium build, cropped brown hair beneath a low nasal helmet, wearing rust-red and charcoal, holding an iron sword forward and a small unpainted metal buckler.",
    "enemy_gale_harrier": BASE + "wiry, red hair tied in a small unbraided knot, wearing pale grey and turquoise, holding a hand axe forward and a seax low, wide mobile stance.",
    "enemy_frost_bonewright": BASE + "stout older healer, bald and clean-shaven, wearing muted blue and cream, holding rolled bandages and wooden splints, leather medicine satchel and sheathed knife, no staff or magic.",
    "enemy_night_gateward": BASE + "tall and broad, wearing a plain nasal helmet and navy coat, holding a rectangular navy shield with copper edging and a short iron mace, no fur.",
    "enemy_night_bowguard": BASE + "lean, black hair in a neat low bun, wearing violet and charcoal, holding a recurved bow across the chest, hip quiver, bare head, no supernatural effects.",
    "enemy_iron_breaker": BASE + "imposing, shaved head and short copper moustache, wearing ochre and dark teal, holding a long narrow-bladed iron war axe with both hands, no maul, fur, or shield.",
    "enemy_tusk_chief": BASE + "broad older rival, bald with a short grey moustache, wearing ivory and crimson, holding a broad iron axe and dark red oval shield with a cream tusk emblem, bronze collar, no horns.",
    "enemy_raven_marshal": BASE + "tall, angular, cropped silver hair, wearing a deep green coat and short cream cloth mantle, holding a longbow with a nocked arrow, sword at hip, small raven clasp, no staff.",
    "enemy_shadowclaw": BASE + "lean veteran, slicked-back grey hair, clean-shaven, wearing midnight blue and muted gold with leather forearm guards, holding an iron sword and hooked seax, no shield, mask, claws, or monster features.",
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
