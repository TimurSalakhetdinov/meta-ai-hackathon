"""Generate attack-pose sprites for the 4 heroes and 10 Otherworld guardians.

Same painted style and cream background as the standing figures
(scripts/generate_enemy_sprites.py); the flood-fill cutout is reused.
The arena swaps to the attack pose for a moment when a unit strikes.

Usage:
    .venv/bin/python scripts/generate_attack_sprites.py [--only attack_hero_vaelen] [--force]
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPRITES = ROOT / "frontend" / "static" / "assets" / "sprites"

_spec = importlib.util.spec_from_file_location("enemy_sprites", ROOT / "scripts" / "generate_enemy_sprites.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
cutout = _mod.cutout

STYLE = "plain cream background, cozy painted storybook style, full body, no text; "

PROMPTS: dict[str, str] = {
    # Heroes face right, toward the enemy line.
    "attack_hero_vaelen": STYLE + "Bera the Shield-Hunter, Viking shieldmaiden with dark braid, round painted shield and short spear, lunging forward to the right in a spear thrust, dynamic attack pose, facing right.",
    "attack_hero_lyra": STYLE + "Sunweaver Lyra, young Viking seeress with pale blond hair and a sun-topped staff, striking forward to the right with a burst of golden light from the staff, dynamic casting attack pose, facing right.",
    "attack_hero_ignis": STYLE + "Ember-Keeper Ignis, Viking fire keeper with copper hair and ember cloak, hurling a ball of fire forward to the right, dynamic attack pose, facing right.",
    "attack_hero_aurelius": STYLE + "Tor the Stone-Breaker, huge bearded Viking with a stone maul, swinging the maul down in a mighty overhead smash to the right, dynamic attack pose, facing right.",
    # Guardians face left, toward the heroes.
    "attack_enemy_marshlight": STYLE + "a drifting marshlight wisp spirit darting forward to the left, its cold green glow flaring into a sharp flare attack, facing left.",
    "attack_enemy_mound_sentinel": STYLE + "an elegant fairy mound guardian in bronze leaf armour and moss-green mantle, slashing forward to the left with a long slender blade, dynamic sword attack pose, facing left.",
    "attack_enemy_hawthorn": STYLE + "a walking hawthorn tree guardian with white blossoms and red berries, swinging a heavy branch arm down to the left in a smashing attack, facing left.",
    "attack_enemy_selkie": STYLE + "a selkie mistweaver in a dark sealskin mantle with wet silver hair, sending a swirling mist orb forward to the left, dynamic casting pose, facing left.",
    "attack_enemy_cu_sith": STYLE + "a huge shaggy dark green fairy hound the size of a calf, lunging forward to the left with jaws open in a bite attack, plumed tail streaming, facing left.",
    "attack_enemy_bean_si": STYLE + "an elegant bean si spirit woman with long silver hair and grey-green mantle, reaching forward to the left with a chilling spectral wail attack, wisps streaming from her hands, facing left.",
    "attack_enemy_ogham_warden": STYLE + "a tall ogham standing-stone warden with carved rune strokes and moss, swinging a heavy stone arm forward to the left in a crushing attack, facing left.",
    "attack_enemy_omen_crow": STYLE + "an oversized glossy black omen crow diving forward to the left with wings spread and beak open in a swooping attack, facing left.",
    "attack_enemy_kelpie": STYLE + "a majestic dark kelpie water horse with riverweed in its wet mane, rearing and striking forward to the left with its front hooves, droplets flying, facing left.",
    "attack_enemy_puca": STYLE + "a sturdy puca goat-like spirit with long hare ears and dark shaggy fur, headbutting forward to the left in a playful but fierce attack, golden eyes, facing left.",
}


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
            raw = client.generate_image(PROMPTS[name], size="1024x1024", run_id="attack_sprites")
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
