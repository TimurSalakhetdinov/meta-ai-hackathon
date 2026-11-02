---
title: Hearths of the Glen
emoji: 🏰
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# Hearths of the Glen: AI Playtest Studio

A closed-loop, multi-agent system that playtests a game's onboarding, finds where
new players get stuck, proposes fixes, and verifies them with A/B reruns, with a
human approving every change. Built for the Meta Global AI Developer Hackathon
(Oct 26 to Nov 4, 2026), indie track, theme "Build for Your World".

The game under test is Hearths of the Glen, a Celtic dawn-age village builder
(three eras, heroes, a campaign arena) written for this project.

## What you can do here

- Play the game: build, research, fight the campaign.
- Open the Playtest Menu: read saved bug hunt and A/B test reports, watch
  side-by-side replays of both bots, and read each bot's thoughts.
- This public build is play-only. Paid Meta bot runs are off
  (`PUBLIC_PLAY_ONLY=1`), so no API key can be spent from this page. The full
  loop, with live Muse Spark playtesters, SAM 3.1 screenshot segmentation and
  Muse Wonder feature design, runs from the source repo.

## Source

Full code, docs and the 3-minute demo script:
https://github.com/TimurSalakhetdinov/meta-ai-hackathon

## Deploy notes (for the Space owner)

Copy `Dockerfile`, `.dockerignore`, `backend/`, `frontend/`, `configs/`,
`runs_demo/` and `pyproject.toml` from the source repo into the Space root, keep
this README, and set the Space variable `PUBLIC_PLAY_ONLY=1`. Set no API keys.
