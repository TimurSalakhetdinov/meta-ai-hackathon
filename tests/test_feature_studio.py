"""Feature studio at zero Meta API cost: free-text feature, emblem, five personas, approval gate, verdicts."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend import feature_studio as fs
from backend.app import create_app
from backend.bot_runner import BotMemory, SessionResult, SessionSpec
from backend.config_service import ApprovalRequiredError, ConfigService
from backend.meta_client import MetaClient

PROMPT = ("Add a glowing Raider Ambush button during the tutorial at step 2 "
          "that costs 20 wood and gives +10 rp and 15 stone")


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Any live Meta call would spend credits, so every test fails loudly if one is attempted."""
    def refuse(*_: Any, **__: Any) -> None:
        raise AssertionError("live Meta API call attempted during a $0 studio test")
    for name in ("_call_sam_api", "_call_muse_api", "_call_image_api", "_client"):
        monkeypatch.setattr(MetaClient, name, refuse)


@pytest.fixture
def app_client(configs_dir: Path, runs_dir: Path, tmp_path: Path) -> TestClient:
    app = create_app(configs_dir, runs_dir)
    app.state.generated_dir = tmp_path / "generated"
    return TestClient(app)


def _approve(configs_dir: Path, patch_id: str) -> None:
    ConfigService(configs_dir).decide(patch_id, "approved", actor="human", note="test")


def _ledger(runs_dir: Path) -> list[dict[str, Any]]:
    path = runs_dir / "cost_ledger.jsonl"
    return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []


def fake_session(runs_dir: Path, configs_dir: Path):
    """Stand-in playtester that reacts to the resolved config only.

    A feature unlocked inside onboarding is used early, drains starter resources and
    stalls the tutorial; a free-play feature is used after onboarding and adds score.
    """
    service = ConfigService(configs_dir)

    async def session(spec: SessionSpec) -> SessionResult:
        cfg, _ = service.resolve(spec.variant, spec.patch_id)
        f = cfg.feature_plugin
        early = f is not None and f.unlock_at_step != "free_play"
        late = f is not None and not early
        summary = {"onboarding_completed": not early, "first_achievement": not early,
                   "where_stuck": "onb_02_forager" if early else None, "stuck_events": 3 if early else 1,
                   "stuck_by_step": {"onb_02_forager": 3} if early else {"free_play": 1},
                   "final_score": 60 if early else (200 if late else 180),
                   "feature_uses": 2 if f else 0, "feature_uses_onboarding": 2 if early else 0}
        d = runs_dir / spec.run_id
        d.mkdir(parents=True, exist_ok=True)
        thought = (f"Ooo, a glowing {f.title} button with a NEW! badge. I have to try it!" if f
                   else "Harvest the berries first.")
        step = {"run_id": spec.run_id, "thought": thought, "player_mood": "curious",
                "target_id": f"btn_feature_{f.feature_id}" if f else "res_berries"}
        (d / "bot_steps.jsonl").write_text(json.dumps(step) + "\n")
        return SessionResult(spec, "done", 10, summary, 0.0, BotMemory())
    return session


# ------------------------------------------------------------ free text and emblem
def test_parser_reads_free_text() -> None:
    p = fs.stub_plugin(PROMPT)
    assert p["feature_id"] == "raider_ambush" and p["title"] == "Raider Ambush"
    assert p["unlock_at_step"] == "onb_02_forager" and p["button_salience"] == "high_pulse"
    assert p["costs"] == {"wood": 20} and p["rewards"] == {"rp": 10, "stone": 15}
    trade = fs.stub_plugin("A subtle wandering merchant after the tutorial: pay 15 food, get 25 wood, 30 second cooldown")
    assert trade["unlock_at_step"] == "free_play" and trade["button_salience"] == "low"
    assert trade["costs"] == {"food": 15} and trade["rewards"] == {"wood": 25} and trade["cooldown_sec"] == 30
    early = fs.stub_plugin("Add a Raider Ambush button at tutorial step 2 that costs wood and rewards score")
    assert early["unlock_at_step"] == "onb_02_forager" and early["costs"] == {"wood": 55}
    assert fs.stub_plugin("A raider ambush in free play that costs wood")["costs"] == {"wood": 25}
    assert fs.parse_quantities("Festival at step 3 for 30 food granting 8 rp") == {"costs": {"food": 30}, "rewards": {"rp": 8}}


def test_propose_free_text_stages_validated_patch_with_emblem(app_client: TestClient, configs_dir: Path,
                                                              runs_dir: Path, tmp_path: Path) -> None:
    _approve(configs_dir, "patch_001")
    r = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT})
    assert r.status_code == 201, r.text
    data = r.json()
    patch, plugin = data["patch"], data["plugin"]
    assert patch["status"] == "validated" and patch["baseline_patch_id"] == "patch_001"
    assert plugin["icon_url"] == "/static/assets/generated/raider_ambush.png"
    assert (tmp_path / "generated" / "raider_ambush.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    # The feature stacks on the approved onboarding fix, so A and B differ only by the feature.
    body = patch["body"]
    assert body["feature_plugin"]["feature_id"] == "raider_ambush"
    assert {k: v for k, v in body.items() if k != "feature_plugin"} == ConfigService(configs_dir).load_patch("patch_001").body
    emblem = [e for e in _ledger(runs_dir) if e["model_id"] == "muse-image"]
    assert emblem and all(e["provider_mode"] == "stub" and not e.get("estimated_cost_usd") for e in emblem)
    assert app_client.post("/api/feature_studio/propose", json={"prompt": "  "}).status_code == 400


def test_studio_spends_nothing(app_client: TestClient, runs_dir: Path) -> None:
    app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT})
    assert sum(float(e.get("estimated_cost_usd") or 0) for e in _ledger(runs_dir)) == 0.0


# ------------------------------------------------------------------- personas
def test_five_grounded_personas(app_client: TestClient) -> None:
    rows = app_client.get("/api/personas").json()
    ids = [r["persona_id"] for r in rows]
    assert ids == ["first_time_casual", "optimizer", "curious_explorer", "cautious_hoarder", "impatient_newcomer"]
    assert [r["archetype"] for r in rows] == ["Story-Guided", "Strategist", "Tinkerer", "Hoarder", "Rush-Clicker"]
    assert all(r["emblem"] and r["subtitle"] and r["grounding"] for r in rows)
    cited = " ".join(g for r in rows for g in r["grounding"])
    assert "Bartle 1996" in cited and "Nacke et al. 2014" in cited and "Yee 2015" in cited
    hoarder = rows[3]["stub_policy"]
    assert hoarder["harvest"] == 0.95 and hoarder["wait_when_unsure"] == 0.7
    assert rows[2]["stub_policy"]["curiosity"] == 1.0


# -------------------------------------------------------------- approval gate
def test_playtest_requires_human_approval(app_client: TestClient, configs_dir: Path) -> None:
    pid = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    r = app_client.post("/api/feature_studio/playtest", json={"patch_id": pid})
    assert r.status_code == 403 and "approval" in r.json()["detail"].lower()
    with pytest.raises(ApprovalRequiredError):
        ConfigService(configs_dir).resolve("B", pid)
    assert app_client.post("/api/feature_studio/playtest", json={"patch_id": "patch_001"}).status_code == 400
    # Only a human decides; nothing in the studio approves on its own.
    actors = {e["actor"] for e in ConfigService(configs_dir).audit_entries(pid)}
    assert actors == {"designer_agent", "validator"}


def test_pair_time_limit_splits_between_bots(app_client: TestClient, configs_dir: Path,
                                             runs_dir: Path) -> None:
    # 20 minutes per pair means 10 minutes for Bot A and 10 for Bot B.
    _approve(configs_dir, "patch_001")
    seen: list[SessionSpec] = []
    base = fake_session(runs_dir, configs_dir)

    async def capture(spec: SessionSpec) -> SessionResult:
        seen.append(spec)
        return await base(spec)

    app_client.app.state.studio_session_fn = capture
    pid = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    _approve(configs_dir, pid)
    r = app_client.post("/api/feature_studio/playtest",
                        json={"patch_id": pid, "personas": ["impatient_newcomer"],
                              "pair_minutes": 20, "speed": 1})
    assert r.status_code == 202, r.text
    job = r.json()
    for _ in range(200):
        job = app_client.get(f"/api/feature_studio/jobs/{job['job_id']}").json()
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "done", job
    assert len(seen) == 2  # one pair: Bot A and Bot B
    assert [s.time_limit_sim_sec for s in seen] == [600.0, 600.0]


# ------------------------------------------------------- verdict and rework loop
def _run_job(app_client: TestClient, pid: str, personas: list[str]) -> dict[str, Any]:
    r = app_client.post("/api/feature_studio/playtest", json={"patch_id": pid, "personas": personas})
    assert r.status_code == 202, r.text
    job = r.json()
    for _ in range(200):
        job = app_client.get(f"/api/feature_studio/jobs/{job['job_id']}").json()
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "done", job
    report = app_client.get(f"/api/feature_studio/report/{pid}")
    assert report.status_code == 200, report.text
    return report.json()


def test_early_feature_hurts_then_rework_is_positive(app_client: TestClient, configs_dir: Path,
                                                     runs_dir: Path) -> None:
    _approve(configs_dir, "patch_001")
    app_client.app.state.studio_session_fn = fake_session(runs_dir, configs_dir)
    personas = ["impatient_newcomer", "curious_explorer", "cautious_hoarder"]

    pid = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    _approve(configs_dir, pid)
    report = _run_job(app_client, pid, personas)
    assert report["key"] == "hurts" and report["label"].startswith("❌ HURTS ONBOARDING")
    assert report["plaques"]["onboarding"] == {"A": "100%", "B": "0%"}
    assert "100% to 0%" in report["takeaway"] and report["early_users"] == 3
    assert len(report["quotes"]) == 3 and all(q["mood"] == "frustrated" for q in report["quotes"])
    assert report["quotes"][0]["thought"].startswith("Ooo, a glowing Raider Ambush")
    assert report["baseline"] == "patch_001" and report["cost_usd"] == 0
    assert not (runs_dir / "ab_summary.json").exists()

    rework = app_client.post("/api/feature_studio/rework", json={"patch_id": pid})
    assert rework.status_code == 201, rework.text
    rp = rework.json()["patch"]
    assert rp["status"] == "validated" and rp["baseline_patch_id"] == "patch_001"
    plugin = rp["body"]["feature_plugin"]
    assert plugin["unlock_at_step"] == "free_play" and plugin["costs"] == {"food": 10}
    assert plugin["rewards"] == {"food": 25, "stone": 15, "rp": 6, "score": 25} and plugin["cooldown_sec"] == 15.0
    assert plugin["icon_url"] == "/static/assets/generated/raider_ambush.png"
    assert app_client.post("/api/feature_studio/playtest", json={"patch_id": rp["patch_id"]}).status_code == 403

    _approve(configs_dir, rp["patch_id"])
    fixed = _run_job(app_client, rp["patch_id"], personas)
    assert fixed["key"] == "positive" and fixed["label"].startswith("✅ POSITIVE IMPACT")
    assert fixed["plaques"]["onboarding"] == {"A": "100%", "B": "100%"}
    assert fixed["plaques"]["score"] == {"A": "180", "B": "200"}


def test_report_lists_both_bots_thoughts(app_client: TestClient, configs_dir: Path,
                                         runs_dir: Path) -> None:
    _approve(configs_dir, "patch_001")
    app_client.app.state.studio_session_fn = fake_session(runs_dir, configs_dir)
    pid = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    _approve(configs_dir, pid)
    report = _run_job(app_client, pid, ["impatient_newcomer"])
    assert report["thought_pair"]["persona_id"] == "impatient_newcomer"
    assert report["thoughts"]["A"][0]["thought"] == "Harvest the berries first."
    assert report["thoughts"]["B"][0]["thought"].startswith("Ooo, a glowing Raider Ambush")
    assert report["thoughts"]["A"][0]["target_id"] == "res_berries"


def test_report_summary_comes_from_muse_spark(app_client: TestClient, configs_dir: Path,
                                              runs_dir: Path) -> None:
    _approve(configs_dir, "patch_001")
    app_client.app.state.studio_session_fn = fake_session(runs_dir, configs_dir)
    pid = app_client.post("/api/feature_studio/propose", json={"prompt": PROMPT}).json()["patch"]["patch_id"]
    _approve(configs_dir, pid)
    _run_job(app_client, pid, ["impatient_newcomer"])
    calls: dict[str, Any] = {}

    class FakeSpark:
        muse_model_id = "muse-spark-1.3"

        def reason_json(self, system: str, user: str, **kw: Any) -> dict[str, Any]:
            calls.update(kw)
            return {"summary": "Spark summary of the playtest."}

    report = fs.build_report(pid, configs_dir=configs_dir, runs_dir=runs_dir,
                             read_bot_steps=lambda rid: [], client=FakeSpark())
    assert report is not None
    assert report["summary"] == "Spark summary of the playtest."
    assert report["summary_model"] == "muse-spark-1.3"
    assert calls["model_id"] == "muse-spark-1.3"


def test_unused_feature_is_mixed() -> None:
    pair = {"persona_id": "optimizer", "seed": 42,
            "A": {"run_id": "a", "onboarding_completed": True, "final_score": 100, "feature_uses": 0},
            "B": {"run_id": "b", "onboarding_completed": True, "final_score": 100, "feature_uses": 0}}
    ab = {"pairs": [pair], "mean_stuck_events": {"A": 1, "B": 1},
          "binary": {"onboarding_completed": {"a_rate": 1.0, "b_rate": 1.0},
                     "first_achievement": {"a_rate": 1.0, "b_rate": 1.0}}}
    v = fs.verdict(ab, {"title": "Merchant", "unlock_at_step": "free_play"})
    assert v["key"] == "mixed" and "no playtester used it" in v["takeaway"]
    rework = fs.stub_rework({"feature_id": "m", "unlock_at_step": "free_play", "button_salience": "low",
                             "costs": {"food": 30}, "cooldown_sec": 12}, v)
    assert rework["plugin"]["button_salience"] == "high_pulse" and rework["plugin"]["costs"] == {"food": 15}


def test_stub_emblem_depends_on_theme(tmp_path: Path) -> None:
    from backend.meta_client import _procedural_emblem
    assert _procedural_emblem("crossed swords") != _procedural_emblem("a crown above stone")


def test_replay_prefers_pair_with_different_outcome() -> None:
    same = {"A": {"run_id": "a1", "onboarding_completed": True}, "B": {"run_id": "b1", "onboarding_completed": True}}
    split = {"A": {"run_id": "a2", "onboarding_completed": True}, "B": {"run_id": "b2", "onboarding_completed": False}}
    assert fs.replay_pair({"pairs": [same, split]}) == {"A": "a2", "B": "b2"}
    assert fs.replay_pair({"pairs": [same]}) == {"A": "a1", "B": "b1"}
    assert fs.replay_pair({"pairs": []}) is None


def _council_ab() -> dict[str, Any]:
    """Two archetypes derailed by the feature, one that ignored it and finished richer."""
    def pair(pid: str, a_score: int, b_score: int, completed: bool, uses: int, onb: int) -> dict[str, Any]:
        return {"persona_id": pid, "seed": 42,
                "A": {"run_id": f"a_{pid}", "onboarding_completed": True, "final_score": a_score},
                "B": {"run_id": f"b_{pid}", "onboarding_completed": completed, "final_score": b_score,
                      "feature_uses": uses, "feature_uses_onboarding": onb,
                      "where_stuck": None if completed else "onb_02_forager"}}
    return {"pairs": [pair("impatient_newcomer", 180, 60, False, 3, 2),
                      pair("curious_explorer", 170, 70, False, 2, 2),
                      pair("optimizer", 200, 210, True, 1, 0)],
            "mean_stuck_events": {"A": 1, "B": 3},
            "binary": {"onboarding_completed": {"a_rate": 1.0, "b_rate": 1 / 3},
                       "first_achievement": {"a_rate": 0.0, "b_rate": 0.0}}}


def test_summarize_persona_outcomes_joins_archetypes(configs_dir: Path) -> None:
    rows = {r["persona_id"]: r for r in fs.summarize_persona_outcomes(_council_ab(), configs_dir)}
    rush = rows["impatient_newcomer"]
    assert rush["archetype"] == "Rush-Clicker" and any("Daredevil" in g for g in rush["grounding"])
    assert rush["feature_uses"] == 3 and rush["feature_uses_onboarding"] == 2
    assert rush["stalled"] is True and rush["final_score_delta"] == 60 - 180
    assert rows["curious_explorer"]["archetype"] == "Tinkerer"
    assert rows["curious_explorer"]["stalled"] is True
    opt = rows["optimizer"]
    assert opt["stalled"] is False and opt["final_score_delta"] == 10


def test_build_report_includes_persona_breakdown(configs_dir: Path, runs_dir: Path, tmp_path: Path) -> None:
    client = MetaClient(runs_dir=runs_dir, configs_dir=configs_dir, provider_mode="stub")
    pid = fs.propose_feature(PROMPT, configs_dir=configs_dir, client=client,
                             generated_dir=tmp_path / "gen")["patch"]["patch_id"]
    (runs_dir / fs.summary_name(pid)).write_text(json.dumps(_council_ab()))
    report = fs.build_report(pid, configs_dir=configs_dir, runs_dir=runs_dir,
                             read_bot_steps=lambda run_id: [])
    assert report is not None and report["key"] == "hurts"
    archetypes = [r["archetype"] for r in report["persona_breakdown"]]
    assert archetypes == ["Rush-Clicker", "Tinkerer", "Strategist"]
    assert report["persona_breakdown"][0]["final_score_delta"] == -120


def test_stub_rework_names_affected_archetypes(configs_dir: Path) -> None:
    breakdown = fs.summarize_persona_outcomes(_council_ab(), configs_dir)
    plugin = fs.stub_plugin(PROMPT)
    rationale = fs.stub_rework(plugin, {"key": "hurts", "persona_breakdown": breakdown})["rationale"]
    assert "affected archetypes: Rush-Clicker, Tinkerer" in rationale
    assert "Strategist" not in rationale  # finished onboarding, so not affected
    plain = fs.stub_rework(plugin, {"key": "hurts"})["rationale"]
    assert "affected archetypes" not in plain


def test_propose_rework_sends_persona_breakdown(configs_dir: Path, tmp_path: Path,
                                                monkeypatch: pytest.MonkeyPatch) -> None:
    client = MetaClient(runs_dir=tmp_path / "runs", configs_dir=configs_dir, provider_mode="stub")
    seen: dict[str, Any] = {}
    orig = MetaClient.reason_json

    def capture(self: MetaClient, system: str, user: str, **kw: Any) -> dict[str, Any]:
        seen["user"] = json.loads(user)
        return orig(self, system, user, **kw)

    monkeypatch.setattr(MetaClient, "reason_json", capture)
    breakdown = fs.summarize_persona_outcomes(_council_ab(), configs_dir)
    report = {"key": "hurts", "takeaway": "drops onboarding", "plaques": {}, "persona_breakdown": breakdown}
    out = fs.propose_rework(fs.stub_plugin(PROMPT), report, configs_dir=configs_dir, client=client)
    assert seen["user"]["persona_breakdown"] == breakdown
    assert out["patch"]["status"] == "validated"  # the rework still waits for a human


def test_committed_demo_demos_endpoint_lists_hurts_then_positive(app_client: TestClient) -> None:
    """The pill switcher data: naive HURTS rollout first, council POSITIVE rework second."""
    demos = app_client.get("/api/feature_studio/demos").json()
    by_id = {d["patch_id"]: d for d in demos}
    assert [d["patch_id"] for d in demos if d["source"] == "demo"] == ["patch_005", "patch_006"]
    naive, rework = by_id["patch_005"], by_id["patch_006"]
    assert (naive["short"], naive["verdict_key"]) == ("Naive Feature", "hurts")
    assert (rework["short"], rework["verdict_key"]) == ("Council Rework", "positive")
    assert naive["verdict_label"].startswith("❌ HURTS ONBOARDING")
    assert rework["verdict_label"].startswith("✅ POSITIVE IMPACT")
    assert naive["n_pairs"] == rework["n_pairs"] == 5


def _assert_demo_bundle(app_client: TestClient, patch_id: str, key: str) -> dict[str, Any]:
    """A committed demo report loads at $0 with distinct persona quotes and replayable runs."""
    report = app_client.get(f"/api/feature_studio/report/{patch_id}")
    assert report.status_code == 200, report.text
    report = report.json()
    assert report["key"] == key
    assert report["provider_mode"] == "stub" and report["cost_usd"] == 0
    assert report["n_pairs"] == 5 and report["baseline"] == "patch_001"
    personas = [q["persona_id"] for q in report["quotes"]]
    assert personas == ["impatient_newcomer", "first_time_casual", "optimizer", "curious_explorer",
                        "cautious_hoarder"]
    thoughts = [q["thought"] for q in report["quotes"]]
    assert all(t and t != "No think-aloud recorded." for t in thoughts)
    assert len(set(thoughts)) == 5, thoughts
    root = Path(__file__).resolve().parents[1]
    run_ids = [q["run_id"] for q in report["quotes"]] + [report["replay"]["A"], report["replay"]["B"]]
    for run_id in run_ids:
        d = root / "runs_demo" / run_id
        for name in ("events.jsonl", "bot_steps.jsonl", "summary.json", "resolved_config.json"):
            assert (d / name).exists(), (run_id, name)
        rec = app_client.get(f"/api/runs/{run_id}/recording")
        assert rec.status_code == 200, run_id
        assert rec.json()["events"] and rec.json()["resolved_config"], run_id
    return report


def test_committed_demo_naive_report_is_hurts(app_client: TestClient) -> None:
    report = _assert_demo_bundle(app_client, "patch_005", "hurts")
    assert report["plaques"]["onboarding"] == {"A": "100%", "B": "60%"}
    assert report["plaques"]["stone_age"] == {"A": "40%", "B": "0%"}
    assert report["plaques"]["score"] == {"A": "145", "B": "73.6"}
    assert "100% to 60%" in report["takeaway"]


def test_committed_demo_rework_report_is_positive(app_client: TestClient) -> None:
    report = _assert_demo_bundle(app_client, "patch_006", "positive")
    assert report["plaques"]["onboarding"] == {"A": "100%", "B": "100%"}
    assert report["plaques"]["stone_age"] == {"A": "40%", "B": "60%"}
    assert report["plaques"]["score"] == {"A": "145", "B": "208"}
    assert "keeps onboarding at 100%" in report["takeaway"]


def test_live_studio_report_shadows_the_demo_bundle(app_client: TestClient, runs_dir: Path) -> None:
    """A fresh live playtest of patch_005 wins over the committed demo until it is deleted."""
    root = Path(__file__).resolve().parents[1]
    ab = json.loads((root / "runs_demo" / fs.summary_name("patch_005")).read_text())
    ab["binary"]["onboarding_completed"]["b_rate"] = 1.0
    ab["binary"]["first_achievement"]["b_rate"] = ab["binary"]["first_achievement"]["a_rate"]
    runs_dir.mkdir(parents=True, exist_ok=True)
    (runs_dir / fs.summary_name("patch_005")).write_text(json.dumps(ab))
    report = app_client.get("/api/feature_studio/report/patch_005").json()
    assert report["key"] == "mixed", report["takeaway"]  # no longer the committed HURTS
    demos = {d["patch_id"]: d for d in app_client.get("/api/feature_studio/demos").json()}
    assert demos["patch_005"]["source"] == "live"


def test_stone_age_drop_hurts_even_when_tutorial_completes() -> None:
    pair = {"persona_id": "optimizer", "seed": 42,
            "A": {"run_id": "a", "onboarding_completed": True, "final_score": 145},
            "B": {"run_id": "b", "onboarding_completed": True, "final_score": 97,
                  "feature_uses": 3, "feature_uses_onboarding": 3}}
    ab = {"pairs": [pair], "mean_stuck_events": {"A": 3, "B": 3},
          "binary": {"onboarding_completed": {"a_rate": 1.0, "b_rate": 1.0},
                     "first_achievement": {"n": 5, "a_rate": 0.4, "b_rate": 0.0, "n10_a_only": 2,
                                           "mcnemar_exact_p": 0.5}}}
    v = fs.verdict(ab, {"title": "Raider Ambush", "unlock_at_step": "onb_02_forager"})
    assert v["key"] == "hurts" and "drops Stone Age from 40% to 0%" in v["takeaway"]
    assert "2 of 5 pairs lost it (McNemar p = 0.50, not significant, run more seeds)" in v["takeaway"]
