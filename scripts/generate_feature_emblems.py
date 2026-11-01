"""Generate the three preset feature emblems with Muse Image.

Each preset in `configs/feature_presets.json` carries a `visual_prompt`;
this writes `frontend/static/assets/generated/<feature_id>.png`, the file
the Feature Forge card shows. Without it, stub mode draws a placeholder.

Usage:
    .venv/bin/python scripts/generate_feature_emblems.py [--only supply_cache] [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
GENERATED = ROOT / "frontend" / "static" / "assets" / "generated"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="one feature_id, e.g. supply_cache")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    from backend.meta_client import MetaClient

    presets = json.loads((ROOT / "configs" / "feature_presets.json").read_text())
    client = MetaClient(runs_dir=ROOT / "runs", configs_dir=ROOT / "configs", provider_mode="meta")
    done = skipped = failed = 0
    for preset in presets:
        plugin = preset["plugin"]
        fid = plugin["feature_id"]
        if args.only and fid != args.only:
            continue
        out = GENERATED / f"{fid}.png"
        if out.exists() and not args.force and fid != "supply_cache":
            print(f"skip {fid} (exists)", flush=True)
            skipped += 1
            continue
        try:
            client.generate_ui_emblem(plugin["visual_prompt"], out_path=out,
                                      bucket="analysis", run_id="feature_emblems")
            print(f"ok   {fid} -> {out.name} ({out.stat().st_size} bytes)", flush=True)
            done += 1
        except Exception as exc:
            print(f"FAIL {fid}: {exc}", flush=True)
            failed += 1
    print(f"generated {done}, skipped {skipped}, failed {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
