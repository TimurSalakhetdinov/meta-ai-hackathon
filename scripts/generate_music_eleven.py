#!/usr/bin/env python3
"""Generate valley + battle music with ElevenLabs Music from the HoH audio spec.

Reads ELEVENLABS_API_KEY from .env. Prompts are the spec's instrumental-only
generation prompts. Output MP3s replace the synth/MusicGen WAV loops;
audio.js prefers *_theme.mp3 and falls back to *_theme.wav.

Usage: .venv/bin/python scripts/generate_music_eleven.py [--only valley]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs import ElevenLabs

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "frontend" / "static" / "assets" / "audio"

TRACKS = {
    "valley": (
        "Instrumental Celtic folk ambient, ancient forest sanctuary, Celtic harp arpeggios, "
        "Irish low whistle and wooden flute melodies, gentle bodhran frame drum, soft fingerpicked "
        "acoustic guitar, warm string pads, ethereal mystical atmosphere, peaceful meditation, "
        "flowing and organic, no electronic sounds, seamless loopable game soundtrack, "
        "mix leaving room for game sound effects, around 100 BPM",
        60_000,
    ),
    "valley2": (
        "Instrumental Nordic folk music for a Viking settlement-building game. Warm, rugged, and "
        "adventurous, evoking timber halls, mountain paths, and ships returning home. Bowed lyre, "
        "plucked lyre, low wooden flute, and soft, deep frame drums. Around 75 BPM, with a gently "
        "swaying pulse and an understated, memorable melody. A sense of exploration and belonging, "
        "with enough space to hear village life. No vocals, chanting, war horns, heavy percussion, "
        "modern synths, or epic orchestral crescendos. Consistent volume, subtle variation for long "
        "play sessions, and a seamless loop.",
        60_000,
    ),
    "valley3": (
        "Instrumental background music for a welcoming Celtic settlement-building game. A steady, "
        "relaxed working rhythm, like villagers gathering timber, tending crops, and building homes. "
        "Warm acoustic strings, soft frame drum, mellow fiddle phrases, and occasional low flute. "
        "Around 85 BPM, in a gentle straight rhythm rather than a jig or reel. Grounded, hopeful, "
        "and quietly industrious. No vocals, piercing bagpipes, modern instruments, battle music, or "
        "dramatic climaxes. Short melodic phrases with breathing room, subtle variation, and a "
        "seamless loop for long play sessions.",
        60_000,
    ),
    "valley4": (
        "Celtic folk background music for a gentle settlement-building game in a green alpine valley. "
        "Soft wordless humming carries a simple, memorable melody over flowing Celtic harp, warm fiddle, "
        "low wooden flute, and gentle bodhran percussion. A steady 120 BPM pulse with a relaxed half-time "
        "feel. Earthy, intimate, and quietly enchanting, like a village waking beneath forest mist. "
        "Humming blends softly into the instruments, with no lyrics or prominent solo singing. Balance a "
        "slightly wistful melody with warm, hopeful harmonies. Subtle musical variation for repeated "
        "listening, consistent volume, no dramatic climax. Entirely acoustic, no synths, heavy drums, "
        "piercing whistles, or epic choir. Seamless loop.",
        210_000,
    ),
    "battle": (
        "Instrumental intense tribal battle theme, driving primal percussion, heavy taiko and djembe drums, "
        "aggressive staccato cello rhythms, powerful low brass horn swells, raw wooden war flutes, urgent, "
        "energetic, 2.5D strategy game combat track, 126 BPM, seamless driving loop, punchy dynamics",
        45_000,
    ),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated track names")
    args = ap.parse_args()

    load_dotenv(ROOT / ".env")
    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("ELEVENLABS_API_KEY not set in .env", file=sys.stderr)
        return 1

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    names = [n.strip() for n in args.only.split(",") if n.strip()] or list(TRACKS)
    for name in names:
        prompt, length_ms = TRACKS[name]
        audio = client.music.compose(prompt=prompt, music_length_ms=length_ms, model_id="music_v2_5")
        out = OUT_DIR / f"{name}_theme.mp3"
        with open(out, "wb") as f:
            for chunk in audio:
                f.write(chunk)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
    print(f"done: {len(names)} track(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
