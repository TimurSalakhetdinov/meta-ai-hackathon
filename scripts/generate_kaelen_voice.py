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
    "kaelen_build_woodcutter": "Now raise a Woodcutter, Chief. Axes in the greenwood will fill our woodpile, and a full woodpile builds a village.",
    "kaelen_claim_reward": "Well worked, Chief. The chapter is complete. Claim your reward; the tribe has earned every bit of it.",
    # Chapter II to VI openings and task lines (Astra-edited final set).
    # kaelen_ch6_bronze dropped on Astra's advice: researching the Bronze
    # Age enters the era at once, so the line would only repeat ch3_bronze.
    "kaelen_ch2_open": "Our foundations hold, Chief. Learn to work stone and strengthen the village; winter seldom knocks before coming in.",
    "kaelen_ch2_masonry": "Open Research and learn Masonry, Chief. A well-laid stone wall keeps the wind outside, where it can grumble without me.",
    "kaelen_ch2_quarry": "Raise a Stone Quarry, Chief. The mountain can spare us some stone; it has stood there doing precious little all winter.",
    "kaelen_ch2_stone_age": "Open Research and awaken the Stone Age, Chief. Let us give this village something sturdier than my knees to stand on.",
    "kaelen_ch3_open": "Bring fire, craft, and trained heroes to the village, Chief. Stone walls are a fine start, but they cannot do all the work.",
    "kaelen_ch3_smelter": "Build a Copper Smelter, Chief. A steady furnace turns copper into useful tools; my hearth mostly turns supper into smoke.",
    "kaelen_ch3_upgrade": "Improve a building to its next level, Chief. These old walls deserve some care; they shelter more useful things than my opinions.",
    "kaelen_ch3_bronze": "Finish the Bronze Age research, Chief. Learn the craft before we promise bronze tools; promises make poor axe heads.",
    "kaelen_ch4_open": "Fill our stores, strengthen our buildings, and bring water to the fields, Chief. Let winter find us ready for a change.",
    "kaelen_ch4_granary": "Build a Granary, Chief. Keep our grain dry and safely stored; winter is a poor season to discover the mice have eaten better than us.",
    "kaelen_ch4_upgrade2": "Improve more of our buildings to their next level, Chief. A village needs sound roofs all round, especially with our rain.",
    "kaelen_ch4_irrigation": "Open Research and learn Irrigation, Chief. Bring water to our fields; waiting on the clouds is work best left to old men.",
    "kaelen_ch5_open": "Prepare Tor for the fight at Sabertooth Canyon, Chief. Those beasts have blocked our road long enough to start charging rent.",
    "kaelen_ch5_tor": "Raise Tor's level through training, Chief. Let him sharpen his skills here before the canyon beasts offer their own lessons.",
    "kaelen_ch5_stage6": "Conquer Sabertooth Canyon in the Campaign, Chief. Clear those beasts from the road; I prefer my walks without teeth at the end.",
    "kaelen_ch5_barracks": "Build a Barracks or a Copper Smelter, Chief. Our warriors need somewhere to train or better tools; songs can wait until supper.",
    "kaelen_ch6_open": "Gather your best heroes for Shadowclaw, Chief. We have a fine valley growing here, and he has been a thoroughly poor neighbour.",
    "kaelen_ch6_boss": "Defeat Shadowclaw in the Campaign, Chief. Send your best heroes to settle the matter; these hills could use a quieter neighbour.",
    "kaelen_ch6_score": "Raise your Empire Score by building, researching, and winning Campaign battles, Chief. Give this old man a village worth boasting about.",
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
    "kaelen_not_ready": "Chief, we are not ready for that yet. Gather and grow first, then we try again.",
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
