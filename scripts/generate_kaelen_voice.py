#!/usr/bin/env python3
"""Render Elder Kaelen's lines with ElevenLabs into the game's audio assets.

Reads ELEVENLABS_API_KEY from .env (python-dotenv). The key never appears in
code or output. Lines match ADVISOR_TEXT / HINT_TEXT in frontend/static/game.js;
welcome and onb_01_shelter share one line and one file.

Usage:
    .venv/bin/python scripts/generate_kaelen_voice.py --test   # welcome line only
    .venv/bin/python scripts/generate_kaelen_voice.py          # all lines
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from elevenlabs import ElevenLabs, VoiceSettings

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "frontend" / "static" / "assets" / "audio" / "voice"
VOICE_ID = "B52raBK48m23qWYbwchQ"
MODEL_ID = "eleven_v4"

LINES = {
    "kaelen_welcome": "There you are, Chief. Raise a Small Home before supper; wet grass makes a poor bed, especially at my age.",
    "kaelen_onb_02_forager": "A roof overhead, but nothing in the pot. Plant a Rural Farm, let the crop ripen, then harvest it to feed the tribe.",
    "kaelen_onb_03_handoff": "We have shelter and supper, Chief. Now open Research and learn Basic Toolmaking; after that, you can spare yourself an old man's lessons.",
    "kaelen_free_play": "Time to look beyond our hearths, Chief. Train your heroes, win battles in the Campaign, and lead us into the Stone Age.",
    "kaelen_achieved": "The Stone Age is here, Chief. Strengthen our buildings, raise a Copper Smelter, and send your heroes to win battles; boasting alone won't do.",
    "kaelen_bronze": "The Bronze Age is ours, Chief. Look at those gleaming spears and shields; I thought these old eyes had seen their last marvel.",
    "kaelen_hint_research": "Open Research, Chief. There's learning waiting, and I've only so much wisdom left to repeat.",
    "kaelen_hint_toolmaking": "Choose Basic Toolmaking and learn it, Chief. A good edge saves hard work, and these old shoulders approve.",
    # Generic warnings: the advisor bubble shows the exact numbers as text,
    # the voice speaks these number-free elder versions instead.
    "kaelen_need_wood": "Not enough wood, Chief. The forest provides; send the axes singing.",
    "kaelen_need_stone": "Not enough stone, Chief. The ridge will give, if we ask with hammers.",
    "kaelen_need_food": "Not enough food, Chief. Empty bellies make slow hands. Harvest first.",
    "kaelen_need_coins": "Not enough coins, Chief. Full houses and busy hands fill the coin pouch.",
    "kaelen_need_rp": "We need more learning, Chief. Knowledge is gathered like berries, one basket at a time.",
    "kaelen_need_scrolls": "Not enough hero scrolls, Chief. Victories in the Campaign bring more.",
    "kaelen_need_tokens": "We need an expansion token, Chief. Win ground in the Campaign and the land is ours.",
    "kaelen_need_worker": "No free hands, Chief. Raise another Small Home, or pull a worker from a quieter post.",
    "kaelen_locked": "That is still beyond us, Chief. Research will open the way, as it always has.",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true", help="generate only the welcome line")
    ap.add_argument("--only", default="", help="comma-separated line names")
    args = ap.parse_args()

    load_dotenv(ROOT / ".env")
    if not os.environ.get("ELEVENLABS_API_KEY"):
        print("ELEVENLABS_API_KEY not set in .env", file=sys.stderr)
        return 1

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if args.only:
        items = {n.strip(): LINES[n.strip()] for n in args.only.split(",") if n.strip()}
    else:
        items = {"kaelen_welcome": LINES["kaelen_welcome"]} if args.test else LINES
    total_chars = 0
    for name, text in items.items():
        audio = client.text_to_speech.convert(
            text=text,
            voice_id=VOICE_ID,
            model_id=MODEL_ID,
            voice_settings=VoiceSettings(stability=0.5, similarity_boost=0.75),
        )
        out = OUT_DIR / f"{name}.mp3"
        with open(out, "wb") as f:
            for chunk in audio:
                f.write(chunk)
        total_chars += len(text)
        print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes, {len(text)} chars)")
    print(f"done: {len(items)} line(s), {total_chars} characters")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
