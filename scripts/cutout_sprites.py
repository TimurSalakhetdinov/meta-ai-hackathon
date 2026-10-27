"""Slice 2x2 isometric sprite sheets and strip their solid light background.

Each sheet holds four buildings on a near-white background with soft painted
drop shadows. The background is flood-filled from the quadrant border through
light, low-chroma, smooth pixels; the painted outlines of the buildings stop the
fill. Inside the filled region, shadow pixels become translucent dark pixels so
the sprites keep a soft shadow on any terrain. Everything else stays opaque.

Usage:
    python scripts/cutout_sprites.py            # default sheets -> frontend/static/assets/sprites/
    python scripts/cutout_sprites.py --size 320 # max sprite edge in px
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SPRITE_DIR = ROOT / "frontend" / "static" / "assets" / "sprites"

# Quadrant order: top-left, top-right, bottom-left, bottom-right.
SHEETS: dict[str, list[str]] = {
    "preview_settlement_style.jpg": ["town_center", "shelter", "forager_hut", "research_tent"],
    "preview_settlement_style_2.jpg": [
        "woodcutter_hut",
        "stone_quarry",
        "tribal_monument",
        "town_center_stone_age",
    ],
    "preview_settlement_style_3.jpg": ["smelter", "granary", "advisor_welcome", "advisor_hint"],
}

MIN_LUM = 125        # darker pixels are outlines or building, never background
MAX_CHROMA = 48      # max(r,g,b) - min(r,g,b); background and shadows are near-neutral
MAX_EDGE = 26        # local gradient; painted texture is busier than shadows
LIGHT_LUM = 205      # pixels this light pass even on a shadow edge
POCKET_DIST = 16     # enclosed pockets this close to the background colour are cleared
POCKET_MIN_PX = 30
SHADOW_ALPHA_MAX = 150
SHADOW_RGB = (38, 30, 46)


def _lum(px: tuple[int, int, int]) -> float:
    r, g, b = px
    return 0.299 * r + 0.587 * g + 0.114 * b


def _background_color(img: Image.Image) -> tuple[int, int, int]:
    w, h = img.size
    samples = [img.getpixel((x, y)) for x, y in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3))]
    return tuple(sorted(c)[len(c) // 2] for c in zip(*samples))  # type: ignore[return-value]


def cut_quadrant(quad: Image.Image) -> Image.Image:
    rgb = quad.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    edges = rgb.convert("L").filter(ImageFilter.FIND_EDGES).load()
    bg = _background_color(rgb)
    bg_lum = _lum(bg)

    def passable(x: int, y: int) -> bool:
        p = px[x, y]
        lum = _lum(p)
        if (max(p) - min(p)) > MAX_CHROMA or lum < MIN_LUM:
            return False
        return lum >= LIGHT_LUM or edges[x, y] <= MAX_EDGE

    filled = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    # FIND_EDGES is undefined on the outermost pixel ring, so seed 2 px inside it
    # and treat that ring as background.
    for x in range(w):
        for y in (0, 1, h - 2, h - 1):
            filled[y * w + x] = 1
        queue.extend(((x, 2), (x, h - 3)))
    for y in range(h):
        for x in (0, 1, w - 2, w - 1):
            filled[y * w + x] = 1
        queue.extend(((2, y), (w - 3, y)))
    while queue:
        x, y = queue.popleft()
        i = y * w + x
        if filled[i] or not passable(x, y):
            continue
        filled[i] = 1
        if x > 0:
            queue.append((x - 1, y))
        if x < w - 1:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y < h - 1:
            queue.append((x, y + 1))

    _clear_pockets(px, filled, w, h, bg)

    out = Image.new("RGBA", (w, h))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if filled[y * w + x]:
                darkness = max(0.0, (bg_lum - _lum(p)) / bg_lum)
                alpha = int(min(SHADOW_ALPHA_MAX, darkness * 255 * 2.2))
                opx[x, y] = (*SHADOW_RGB, alpha if alpha > 10 else 0)
            else:
                opx[x, y] = (*p, 255)

    # Soften the cut edge by one pixel so sprites blend into the terrain.
    alpha = out.getchannel("A").filter(ImageFilter.GaussianBlur(0.7))
    solid = Image.eval(alpha, lambda a: 255 if a > 250 else a)
    out.putalpha(solid)
    bbox = out.getchannel("A").point(lambda a: 255 if a > 12 else 0).getbbox()
    return out.crop(bbox) if bbox else out


def _clear_pockets(px, filled: bytearray, w: int, h: int, bg: tuple[int, int, int]) -> None:
    """Mark enclosed background pockets (e.g. between crane legs) as filled."""

    def near_bg(x: int, y: int) -> bool:
        p = px[x, y]
        return max(abs(p[0] - bg[0]), abs(p[1] - bg[1]), abs(p[2] - bg[2])) <= POCKET_DIST

    seen = bytearray(w * h)
    for sy in range(h):
        for sx in range(w):
            i0 = sy * w + sx
            if filled[i0] or seen[i0] or not near_bg(sx, sy):
                continue
            component = []
            queue = deque([(sx, sy)])
            seen[i0] = 1
            while queue:
                x, y = queue.popleft()
                component.append(y * w + x)
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and not filled[j] and near_bg(nx, ny):
                            seen[j] = 1
                            queue.append((nx, ny))
            if len(component) >= POCKET_MIN_PX:
                for j in component:
                    filled[j] = 1


def process_sheet(sheet: Path, names: list[str], out_dir: Path, max_size: int) -> list[Path]:
    img = Image.open(sheet).convert("RGB")
    w, h = img.size
    boxes = [(0, 0, w // 2, h // 2), (w // 2, 0, w, h // 2), (0, h // 2, w // 2, h), (w // 2, h // 2, w, h)]
    written = []
    for name, box in zip(names, boxes):
        sprite = cut_quadrant(img.crop(box))
        sprite.thumbnail((max_size, max_size), Image.LANCZOS)
        path = out_dir / f"{name}.png"
        sprite.save(path, optimize=True)
        written.append(path)
        print(f"{sheet.name} -> {path.relative_to(ROOT)} {sprite.size}")
    return written


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sprite-dir", type=Path, default=SPRITE_DIR)
    parser.add_argument("--size", type=int, default=320, help="max sprite edge in px")
    args = parser.parse_args()
    for sheet_name, names in SHEETS.items():
        sheet = args.sprite_dir / sheet_name
        if not sheet.exists():
            print(f"skip: {sheet} not found")
            continue
        process_sheet(sheet, names, args.sprite_dir, args.size)


if __name__ == "__main__":
    main()
