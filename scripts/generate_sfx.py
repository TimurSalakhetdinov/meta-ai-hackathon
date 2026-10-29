#!/usr/bin/env python3
"""Generate the game's sound effects with ElevenLabs from the HoH audio spec.

Prompts rewritten by Astra (Oct 29): concrete physical sound sources in
sequence, explicit negatives, no synth/casino sounds. Reads
ELEVENLABS_API_KEY from .env. Output files are named after the sound names
audio.js already plays, in assets/audio/sfx/.

Usage: .venv/bin/python scripts/generate_sfx.py [--only click,harvest]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs import ElevenLabs

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "frontend" / "static" / "assets" / "audio" / "sfx"

# name -> (generative prompt, duration seconds)
SOUNDS = {
    "click": ("A fingertip taps a smooth wooden token, making one crisp, rounded knock with a short natural decay. Warm, dry, close-miked, clearly audible, 0.5 seconds. No metallic click, no synth, no music.", 0.5),
    "modal_open": ("A parchment scroll rolls open across a wooden table, followed by its wooden spindle settling with a soft knock. Dry, close-miked, clearly audible, 0.5 seconds. No exaggerated whoosh, no synth, no music.", 0.5),
    "modal_close": ("A soft leather cover folds over parchment and rests gently against wood, ending in a tiny padded tap. Warm, dry, close-miked, softly audible, 0.5 seconds. No slam, no sharp latch, no hiss, no synth, no music.", 0.5),
    "build": ("A timber beam settles onto packed earth, a wooden mallet drives two pegs home, then loose gravel crunches beneath the frame. Warm, dry, close-miked, full 2 second construction sequence. No chimes, no synth, no music.", 2.0),
    "built": ("A wooden mallet seats the final peg with two firm knocks, followed by a brief timber creak as the joint holds. Warm, dry, close-miked, clearly audible, 0.8 seconds. No melody, no bells, no synth.", 0.8),
    "free_finish": ("A taut rope slips free with a short fiber rasp and a timber joint snaps neatly into place with a rounded wooden clack. Dry, close-miked, 0.5 seconds. No magical sparkle, no bells, no synth, no music.", 0.5),
    "ready": ("A small hollow wooden vessel is struck once with a soft wooden beater, producing a clear, rounded tok with a brief natural resonance. Close-miked, 0.5 seconds. No bells, no electronic ping, no synth, no music.", 0.5),
    "harvest": ("A woven basket scrapes across a wooden bench, dry grain pours into it, then a full cloth sack lands beside it with a soft weighty thump. Close-miked, full 2 second collection sequence. No coins, no bells, no chimes, no music.", 2.0),
    "coin": ("Several small metal coins slide across wood, are gathered in two short scoops, then tumble into a leather purse with irregular muted clinks. Warm, dry, close-miked, full 2 second collection sequence. No sparkling cascade, no bells, no synth, no music.", 2.0),
    "unlock": ("A wooden locking bar slides free, a heavy oak lid opens with a short creak, then one bronze bowl strike gives a warm restrained resonance. Close-miked, 2 seconds including decay. No glittering effects, no synth, no voices.", 2.0),
    "era_up": ("Two deep hide-drum strokes introduce a brief triumphant animal-horn call, ending with one warm bronze gong strike and its natural decay. Full-bodied and intimate, 3.5 second acoustic milestone sting. No orchestra, no synth, no voices, no explosive impacts.", 3.5),
    "quest": ("A parchment sheet folds crisply, then a carved wooden seal presses down with a firm, satisfying knock. Warm, dry, close-miked, clearly audible, 0.8 seconds. No arpeggio, no bells, no synth, no music.", 0.8),
    "quest_claim": ("A wooden chest latch lifts, the lid creaks open, then a leather-wrapped bundle is taken out and set on a timber table with a warm thump. Close-miked, full 2 second sequence. No coins, no bells, no sparkle, no synth, no music.", 2.0),
    "hero_levelup": ("A leather shield strap pulls taut, followed by two confident strikes of a wooden spear shaft against a hide-covered shield, the second heavier. Warm, dry, close-miked, 1.5 seconds. No fanfare, no magical chimes, no synth, no music.", 1.5),
    "hit": ("A spear shaft swishes briefly through air and strikes a hide-covered wooden shield with a firm padded crack and short leather creak. Dry, close-miked, 0.5 seconds. No gore, no voices, no exaggerated bass, no synth.", 0.5),
    "roar": ("A wolf gives one short, low chest growl ending in a sharp jaw snap and brief breath through its nose. Natural, close and clearly audible, 0.5 seconds. No human voice, no monster processing, no music.", 0.5),
    "ult_ready": ("A leather grip tightens with a clear creak, then a bronze spear butt strikes a flat stone once with a firm clank and short natural ring. Close-miked, 0.8 seconds. No energy hum, no bells, no synth, no music.", 0.8),
    "hero_ult": ("A heavy stone-headed hammer swings with a short air rush, strikes rocky earth with a deep solid crack, then broken stones tumble and gravel settles. Dry, close-miked, full 2 second sequence. No explosion, no thunder, no magical shockwave, no synth.", 2.0),
    "hero_heal": ("Water pours briefly from a small clay vessel into a wooden bowl, healing herbs are crushed with a soft wet press, then a linen dressing pulls snug with a gentle rustle. Warm, close-miked, 1.5 seconds. No vocals, no harp, no sparkle, no synth, no music.", 1.5),
    "victory": ("Three confident hide-drum beats lead into a short, warm animal-horn fanfare, with one final drum stroke beneath the horn's natural fading breath. Joyful but restrained, intimate acoustic sound, 4 seconds. No cheering, no metallic star impacts, no orchestra, no synth.", 4.0),
    "defeat": ("A bowed lyre plays a brief low descending phrase, followed by one soft hide-drum stroke and a short natural decay. Gentle disappointment rather than dread, intimate acoustic sound, 3 seconds. No voices, no harsh dissonance, no cinematic boom, no synth.", 3.0),
    "reject": ("A wooden peg meets a padded wooden stop twice in quick succession, making two low, rounded knocks, the second softer. Dry, close-miked, clearly audible, 0.5 seconds. No buzz, no harsh crack, no synth, no music.", 0.5),
    "ambient_wind": ("Seamless 12 second alpine valley ambience: a gentle breeze moves through pine needles and nearby meadow grass, with soft overlapping swells and steady natural air. Matching texture and level at both loop boundaries, no fade-in or fade-out. No sudden gusts, no birds, no voices, no music.", 12.0),
    "harvest_food": ("Bread baking in a clay oven: gentle fire crackles, bread crust crackles and ticks as it bakes and expands, a soft hiss of steam escapes, then the oven mouth opens with a warm rush of air and the baked loaves slide out. Warm, close-miked, full 2 second baking sequence. No wood thumps, no chopping, no coins, no bells, no chimes, no music.", 2.0),
    "harvest_wood": ("Cutting wood for collection: an axe chops a log with two sharp splitting cracks, a hand saw finishes the cut with rhythmic strokes, then the split pieces are gathered with wooden clunks. Warm, dry, close-miked, full 2 second woodcutting sequence. No metallic clinks, no chimes, no synth, no music.", 2.0),
    "harvest_stone": ("Mining stone in a quarry: a pickaxe strikes rock three times with sharp cracks, stone splits and chunks break free, then rough blocks are gathered with gritty scrapes. Dry, close-miked, full 2 second stone-mining sequence. No glass tinkling, no coins, no chimes, no music.", 2.0),
    "harvest_coins": ("A small handful of metal coins is scooped from a wooden tray, poured into a leather pouch with uneven close clinks, then settled as the drawstring pulls shut. Warm, dry, full 2 second collection sequence. No bells, no sparkling pitch rise, no synth, no music.", 2.0),
    "research_select": ("A stiff parchment page turns with a clear dry rustle, then a wooden stylus taps firmly onto its surface. Warm, close-miked, clearly audible, 0.5 seconds. No whisper-quiet detail, no bells, no synth, no music.", 0.5),
    "dock_heroes": ("A deep Viking warrior male voice gives one short powerful war cry, shouting 'For glory!', then knocks his wooden shield once with a deep resonant thud. Raw, bold, close and clearly audible, full 1.2 second sequence. One voice only, no crowd, no chanting, no horn, no synth, no music.", 1.2),
    "dock_campaign": ("Two bronze swords clash three times with distinct spacing, each impact producing a solid metallic clack and brief bronze ring; the final clash rings out naturally. Dry, close-miked, full 1.4 second sequence. No steel shriek, no voices, no synth, no music.", 1.4),
    "dock_research": ("A glass flask gives three clearly audible liquid bubbles, a parchment scroll briskly unrolls, then a small bronze cup is tapped once for a warm discovery chime with a short decay. Dry, close-miked, full 1 second sequence. No sparkling flourish, no synth, no music.", 1.0),
    "dock_upgrades": ("A hand hammer strikes a bronze fitting on a stone anvil three times, then the fitted timber brace settles with a firm wooden knock and a short creak. Warm, close-miked, full 1.6 second sequence. No rising-pitch effect, no chimes, no synth, no music.", 1.6),
    "claim_reward": ("A wooden chest opens with a rounded latch knock and gentle hinge creak, a cloth bundle slides over its rim, then lands softly on a wooden table. Warm, dry, close-miked, full 2 second sequence. No coins, no bells, no sparkle, no melody, no synth.", 2.0),
    "upgrade": ("A timber brace slides into position, a wooden mallet drives it home with two firm blows, then the strengthened frame creaks and loose grit settles. Warm, dry, close-miked, full 2 second construction sequence. No magical transformation, no chimes, no synth, no music.", 2.0),
    "tech_toolmaking": ("A hammerstone strikes flint twice with crisp dry ticks, releasing tiny flakes that scatter onto a hide work mat. Close-miked, clearly audible, 0.5 seconds. No metallic ringing, no synth, no music.", 0.5),
    "tech_woodworking": ("A sharp hand adze pares a timber edge with one crunchy cut, then the shaved piece drops onto a wooden bench with a light clack. Warm, dry, close-miked, 0.6 seconds. No powered tools, no synth, no music.", 0.6),
    "tech_baskets": ("A stiff wicker strand pulls through a basket weave with a clear fibrous rasp, then the basket flexes with a short dry creak. Warm, close-miked, clearly audible, 0.5 seconds. No coins, no bells, no synth, no music.", 0.5),
    "tech_masonry": ("A stone hammer drives a chisel against granite twice, producing firm sharp knocks followed by small stone chips falling onto rock. Dry, close-miked, 0.6 seconds. No glass chimes, no exaggerated ringing, no synth, no music.", 0.6),
    "tech_construction": ("A timber joint slides snugly together, then two quick wooden mallet taps seat its peg with a brief structural creak. Warm, dry, close-miked, full 1.8 second construction sequence. No bells, no synth, no music.", 1.8),
    "tech_stone_age": ("A heavy dressed stone is lowered onto a rock base with a deep grounded knock, then a hammerstone strikes its edge twice and grit falls away. Dry, close-miked, clearly audible, 1.2 seconds. No ceremonial music, no magical hum, no synth.", 1.2),
    "tech_bronze_age": ("A clay crucible tips with a gritty scrape, molten metal pours in a short dense stream into a dry stone mold, and nearby charcoal crackles as the crucible is set down. Warm, close-miked, 1.2 seconds. No water splash, no explosion, no fanfare, no synth, no music.", 1.2),
    "tech_irrigation": ("A small wooden sluice lifts with a wet scrape, releasing a brief clear rush of water through a shallow earthen channel with soft splashes over pebbles. Close-miked, clearly audible, 0.8 seconds. No magical shimmer, no synth, no music.", 0.8),
}


# Per-building placement sounds: game emits build_<type> on placement.
BUILDING_SOUNDS = {
    "build_shelter": ("Two timber posts thud into packed earth, a rope lashing pulls tight with a coarse creak, then a bundle of dry thatch settles across the roof with a broad rustle. Warm, dry, close-miked, full 2 second construction sequence. No metal, no chimes, no music.", 2.0),
    "build_forager_hut": ("Rustic village kitchen cooking: a clay stew pot bubbles steadily, a wooden spoon stirs and taps the pot rim, vegetables sizzle softly in a pan, then a crusty bread loaf is set on a wooden board. Warm, dry, close-miked, full 2 second cooking sequence. No wood chopping, no axe, no timber, no coins, no bells, no music.", 2.0),
    "build_woodcutter_hut": ("Cutting wood: an axe chops a log twice with sharp splitting cracks, a hand saw cuts through timber with rhythmic strokes, then split logs drop and stack with low wooden clunks. Dry, close-miked, full 2 second woodcutting sequence. No powered saw, no motor, no chimes, no music.", 2.0),
    "build_stone_quarry": ("Cutting stone: a chisel cuts a groove into granite with repeated sharp hammer strikes, gritty stone scraping as the cut deepens, then the stone block splits along the cut with a deep crack and small chips fall away. Dry, close-miked, full 2 second stone-cutting sequence. No glass sounds, no metal ringing, no explosive impact, no music.", 2.0),
    "build_granary": ("Raised timber floorboards knock into position, a wooden storage-bin lid slides open with a coarse scrape, then dry grain pours into the hollow bin and settles. Warm, dry, close-miked, full 2 second construction sequence. No coins, no bells, no chimes, no music.", 2.0),
    "build_smelter": ("Rough furnace stones scrape and knock into place, charcoal tumbles into the chamber, then a leather bellows compresses and a small fire catches with a short breathy rush and crisp crackle. Close-miked, full 2 second construction sequence. No explosion, no industrial machinery, no music.", 2.0),
    "build_tribal_monument": ("A heavy stone monolith drags across gritty earth, its supporting ropes strain, then its base settles into a stone socket with a deep solid knock and a brief trickle of gravel. Dry, close-miked, full 2 second construction sequence. No magical rumble, no chanting, no drums, no music.", 2.0),
    "build_barracks": ("Thick timber supports knock together, a wooden weapon rack drops into place, then spear shafts and hide-covered shields settle against it with woody clatter and leather creaks. Warm, dry, close-miked, full 2 second construction sequence. No battle cries, no fanfare, no synth, no music.", 2.0),
    "build_hero_arena": ("A heavy stone gate slab grinds along its track and settles with a solid low knock, a wooden locking beam slides home, then coarse sand pours and spreads across the arena floor. Dry, close-miked, full 2 second construction sequence. No distant horn, no crowd, no explosive slam, no music.", 2.0),
}
SOUNDS.update(BUILDING_SOUNDS)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated sound names")
    args = ap.parse_args()

    load_dotenv(ROOT / ".env")
    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("ELEVENLABS_API_KEY not set in .env", file=sys.stderr)
        return 1

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    names = [n.strip() for n in args.only.split(",") if n.strip()] or list(SOUNDS)
    for name in names:
        prompt, dur = SOUNDS[name]
        audio = client.text_to_sound_effects.convert(
            text=prompt, duration_seconds=dur, prompt_influence=0.6,
            loop=(name == "ambient_wind"))
        out = OUT_DIR / f"{name}.mp3"
        with open(out, "wb") as f:
            for chunk in audio:
                f.write(chunk)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
    print(f"done: {len(names)} sound(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
